import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { buildSubject } from '@eab/authz'
import { SC } from '@eab/domain'
import { migrate, openDatabase, tableExists } from '@eab/storage'
import {
  capabilitiesOf,
  explainModelRoute,
  inferModelProfile,
  listModelCapabilities,
  resolveModelForPurpose,
} from '../src/model-registry.js'
import {
  collectionVectorStats,
  cosineSimilarity,
  decodeVector,
  encodeVector,
  indexKbCollection,
  latestKbIndexJob,
  startKbIndexJob,
} from '../src/kb-vector.js'
import { retrieveKb } from '../src/routes/chat.js'
import { callRerank } from '../src/llm.js'
import type { RequestActor } from '../src/session.js'

function seededDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)

  db.prepare("INSERT INTO companies (id, name, slug, created_at) VALUES ('c1', '甲公司', 'acme', 1)").run()
  db.prepare(
    "INSERT INTO departments (id, company_id, parent_id, name, path, created_at) VALUES ('d1', 'c1', NULL, '研发部', '/c1/d1/', 1)",
  ).run()

  db.prepare(
    `INSERT INTO model_providers (id, company_id, kind, name, base_url, created_at, updated_at)
     VALUES ('p1', 'c1', 'custom', '本地向量', 'http://127.0.0.1:11434/v1', 1, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO models
       (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, priority, enabled, created_at, updated_at)
     VALUES ('m_embed', 'c1', 'p1', 'BGE-M3', 'bge-m3', '["embedding"]', '["embedding"]', 'embeddings', 10, 1, 1, 1)`,
  ).run()

  db.prepare(
    `INSERT INTO kb_collections (id, company_id, name, acl_mode, created_at, updated_at)
     VALUES ('col1', 'c1', '制度库', 'all', 1, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO kb_docs (id, company_id, collection_id, title, classification, status, content, chunk_count, created_at, updated_at)
     VALUES ('doc1', 'c1', 'col1', '年假制度', 'internal', 'indexed', '年假制度正文', 1, 1, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO kb_docs (id, company_id, collection_id, title, classification, status, content, chunk_count, created_at, updated_at)
     VALUES ('doc2', 'c1', 'col1', '报销制度', 'internal', 'indexed', '报销制度正文', 1, 1, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO kb_chunks (id, company_id, doc_id, collection_id, ordinal, text, classification, created_at)
     VALUES ('chunk_a', 'c1', 'doc1', 'col1', 0, '员工年假按工龄计算，满一年五天。', 'internal', 1)`,
  ).run()
  db.prepare(
    `INSERT INTO kb_chunks (id, company_id, doc_id, collection_id, ordinal, text, classification, created_at)
     VALUES ('chunk_b', 'c1', 'doc2', 'col1', 0, '差旅报销需要提交发票和行程单。', 'internal', 1)`,
  ).run()

  return db
}

const actor: RequestActor = {  subject: buildSubject({
    userId: 'u1',
    companyId: 'c1',
    deptId: 'd1',
    deptPath: '/c1/d1/',
    roles: ['member'],
    extraScopes: [SC.KB_READ],
  }),
  person: {
    id: 'u1',
    name: '张三',
    title: null,
    avatar: null,
    deptId: 'd1',
    deptPath: '/c1/d1/',
    deptName: '研发部',
    companyId: 'c1',
    companyName: '甲公司',
  },
}

async function startRerankServer(handler: (body: Record<string, unknown>) => { status: number; payload: unknown }) {
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += String(chunk)
    })
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        body = {}
      }
      const result = handler(body)
      res.writeHead(result.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result.payload))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock server 没有端口')
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` }
}

describe('0030 迁移：模型能力 + 向量表', () => {
  it('新表与模型新列都存在', () => {
    const db = seededDb()
    for (const table of ['model_routes', 'kb_chunk_embeddings', 'kb_index_jobs']) {
      expect(tableExists(db, table), `缺表: ${table}`).toBe(true)
    }
    const columns = db
      .prepare('PRAGMA table_info(models)')
      .all() as unknown as Array<{ name: string }>
    expect(columns.map((row) => row.name)).toContain('capabilities')
    expect(columns.map((row) => row.name)).toContain('endpoint_kind')
    db.close()
  })
})

describe('模型能力与用途路由', () => {
  it('capabilities 为空时从 tags 回填，并归一别名', () => {
    expect(capabilitiesOf(null, '["图片识别","多模态","vector"]')).toEqual(['vision', 'multimodal', 'embedding'])
    expect(capabilitiesOf('["embedding"]', '["vision"]')).toEqual(['embedding', 'vision'])
  })

  it('未显式绑定时按能力自动挑 embedding 模型', () => {
    const db = seededDb()
    const models = listModelCapabilities(db, 'c1')
    expect(models).toHaveLength(1)
    expect(models[0].endpointKind).toBe('embeddings')
    const found = resolveModelForPurpose(db, 'c1', 'kb.embed')
    expect(found?.id).toBe('m_embed')
    const explained = explainModelRoute(db, 'c1', 'kb.embed')
    expect(explained.source).toBe('fallback')
    db.close()
  })

  it('导入时按模型名推断用途与接口，重排/向量/语音能区分', () => {
    const rerank = inferModelProfile('BAAI/bge-reranker-v2-m3')
    expect(rerank.modelType).toBe('rerank')
    expect(rerank.endpointKind).toBe('rerank')
    expect(rerank.capabilities).toEqual(['rerank'])
    expect(rerank.api.path).toBe('/rerank')

    const embed = inferModelProfile('Qwen3-Embedding-0.6B')
    expect(embed.endpointKind).toBe('embeddings')
    expect(embed.api.path).toBe('/embeddings')

    const asr = inferModelProfile('Systran/faster-whisper-large-v3')
    expect(asr.endpointKind).toBe('asr')

    const chat = inferModelProfile('Qwen3.8-27B-FP8')
    expect(chat.endpointKind).toBe('chat')
    expect(chat.confidence).toBe('low')
  })
})

describe('向量编码与索引', () => {
  it('float32 编解码与余弦相似度可用', () => {
    const buffer = encodeVector([1, 0.5, -0.25])
    expect(decodeVector(buffer)).toEqual([1, 0.5, -0.25])
    expect(cosineSimilarity([1, 0], 1, [0, 1], 1)).toBe(0)
    expect(cosineSimilarity([1, 0], 1, [1, 0], 1)).toBe(1)
  })

  it('索引后写入旁表，文本切片不变', async () => {
    const db = seededDb()
    const summary = await indexKbCollection(db, ':memory:', 'c1', 'col1', {
      embed: async (texts) => ({
        vectors: texts.map((text) => (text.includes('年假') ? [1, 0] : [0, 1])),
        dim: 2,
        promptTokens: 0,
      }),
    })
    expect(summary.totalDocs).toBe(2)
    expect(summary.indexedDocs).toBe(2)
    const stats = collectionVectorStats(db, 'c1', 'col1')
    expect(stats.vectors).toBe(2)
    expect(stats.dim).toBe(2)
    const chunks = db
      .prepare('SELECT text FROM kb_chunks WHERE collection_id = ? ORDER BY id')
      .all('col1') as unknown as Array<{ text: string }>
    expect(chunks.map((row) => row.text)).toEqual(['员工年假按工龄计算，满一年五天。', '差旅报销需要提交发票和行程单。'])
    db.close()
  })

  it('后台索引任务跑完后状态为 done，并能查到向量统计', async () => {
    const db = seededDb()
    const started = startKbIndexJob(db, ':memory:', 'c1', 'col1', {
      embed: async (texts) => ({
        vectors: texts.map((text) => (text.includes('年假') ? [1, 0] : [0, 1])),
        dim: 2,
        promptTokens: 0,
      }),
    })
    let job = latestKbIndexJob(db, 'c1', 'col1')
    for (let attempt = 0; attempt < 50 && job?.status !== 'done' && job?.status !== 'failed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      job = latestKbIndexJob(db, 'c1', 'col1')
    }
    expect(started.jobId).toBeTruthy()
    expect(job?.status).toBe('done')
    expect(job?.done).toBe(2)
    expect(collectionVectorStats(db, 'c1', 'col1').vectors).toBe(2)
    db.close()
  })
})

describe('混合检索', () => {
  it('问题与关键词不重合时，向量召回仍能命中', async () => {
    const db = seededDb()
    await indexKbCollection(db, ':memory:', 'c1', 'col1', {
      embed: async (texts) => ({
        vectors: texts.map((text) => (text.includes('年假') ? [1, 0] : [0, 1])),
        dim: 2,
        promptTokens: 0,
      }),
    })
    const hits = await retrieveKb(db, ':memory:', actor, '假期怎么算', {
      embed: async () => ({ vectors: [[1, 0]], dim: 2, promptTokens: 0 }),
    })
    expect(hits[0]?.chunkId).toBe('chunk_a')
    expect(hits[0]?.source).toMatch(/vector|hybrid/)
    db.close()
  })

  it('没有向量模型时退回关键词，不报错', async () => {
    const db = seededDb()
    db.prepare('UPDATE models SET enabled = 0').run()
    const hits = await retrieveKb(db, ':memory:', actor, '年假怎么算')
    expect(hits.length).toBe(1)
    expect(hits[0].chunkId).toBe('chunk_a')
    expect(hits[0].source).toBe('local')
    db.close()
  })

  it('知识库单独绑定向量模型时，按该库的模型召回', async () => {
    const db = seededDb()
    db.prepare(
      `INSERT INTO models
         (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, priority, enabled, created_at, updated_at)
       VALUES ('m_embed2', 'c1', 'p1', 'Qwen3-Embedding', 'qwen3-embedding', '["embedding"]', '["embedding"]', 'embeddings', 200, 1, 1, 1)`,
    ).run()
    db.prepare(
      `INSERT INTO kb_collections (id, company_id, name, acl_mode, embedding_model_id, created_at, updated_at)
       VALUES ('col2', 'c1', '市场库', 'all', 'm_embed2', 1, 1)`,
    ).run()
    db.prepare(
      `INSERT INTO kb_docs (id, company_id, collection_id, title, classification, status, content, chunk_count, created_at, updated_at)
       VALUES ('doc3', 'c1', 'col2', '发票说明', 'internal', 'indexed', '发票说明正文', 1, 1, 1)`,
    ).run()
    db.prepare(
      `INSERT INTO kb_chunks (id, company_id, doc_id, collection_id, ordinal, text, classification, created_at)
       VALUES ('chunk_c', 'c1', 'doc3', 'col2', 0, '增值税专用发票需要税号。', 'internal', 1)`,
    ).run()
    await indexKbCollection(db, ':memory:', 'c1', 'col2', {
      embed: async (texts) => ({ vectors: texts.map(() => [0, 1]), dim: 2, promptTokens: 0 }),
    })
    const hits = await retrieveKb(db, ':memory:', actor, '发票怎么报', {
      embed: async () => ({ vectors: [[0, 1]], dim: 2, promptTokens: 0 }),
    })
    expect(hits.some((hit) => hit.chunkId === 'chunk_c')).toBe(true)
    expect(hits.find((hit) => hit.chunkId === 'chunk_c')?.source).toMatch(/vector|hybrid/)
    db.close()
  })

  it('配置 kb.rerank 模型后按重排分数取前 4 条', async () => {
    const db = seededDb()
    db.prepare(
      `INSERT INTO models
         (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, priority, enabled, created_at, updated_at)
       VALUES ('m_rr', 'c1', 'p1', 'BGE Reranker', 'bge-reranker-v2-m3', '["rerank"]', '["rerank"]', 'rerank', 50, 1, 1, 1)`,
    ).run()
    const hits = await retrieveKb(db, ':memory:', actor, '年假 报销', {
      embed: async () => ({ vectors: [[1, 0]], dim: 2, promptTokens: 0 }),
      rerank: async (_query, documents) => [
        { index: documents.findIndex((text) => text.includes('报销')), score: 0.98 },
        { index: documents.findIndex((text) => text.includes('年假')), score: 0.42 },
      ],
    })
    expect(hits).toHaveLength(2)
    expect(hits[0].chunkId).toBe('chunk_b')
    expect(hits[0].reranked).toBe(true)
    db.close()
  })
})

describe('重排序适配器', () => {
  it('兼容 rerank 标准形态 results[{index, relevance_score}]', async () => {
    const mock = await startRerankServer((body) =>
      body.documents
        ? {
            status: 200,
            payload: {
              results: [
                { index: 1, relevance_score: 0.91 },
                { index: 0, relevance_score: 0.12 },
              ],
            },
          }
        : { status: 400, payload: { error: 'expect documents' } },
    )
    const db = seededDb()
    try {
      db.prepare('UPDATE model_providers SET base_url = ? WHERE id = ?').run(mock.baseUrl, 'p1')
      db.prepare(
        `INSERT INTO models
           (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, priority, enabled, created_at, updated_at)
         VALUES ('m_rr', 'c1', 'p1', 'BGE Reranker', 'bge-reranker-v2-m3', '["rerank"]', '["rerank"]', 'rerank', 10, 1, 1, 1)`,
      ).run()
      const result = await callRerank(db, ':memory:', 'c1', 'm_rr', '年假怎么算', ['年假正文', '报销正文'], 2)
      expect(result.results[0]).toEqual({ index: 1, score: 0.91 })
      expect(result.results[1]).toEqual({ index: 0, score: 0.12 })
      expect(result.modelKey).toBe('bge-reranker-v2-m3')
    } finally {
      db.close()
      mock.server.close()
    }
  })

  it('标准形态 4xx 时自动回退 TEI 的 {query, texts} 并识别 score', async () => {
    const mock = await startRerankServer((body) =>
      body.documents
        ? { status: 422, payload: { error: 'unsupported documents' } }
        : {
            status: 200,
            payload: [
              { index: 0, score: 0.2 },
              { index: 1, score: 0.8 },
            ],
          },
    )
    const db = seededDb()
    try {
      db.prepare('UPDATE model_providers SET base_url = ? WHERE id = ?').run(mock.baseUrl, 'p1')
      db.prepare(
        `INSERT INTO models
           (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, priority, enabled, created_at, updated_at)
         VALUES ('m_rr', 'c1', 'p1', 'TEI Reranker', 'bge-reranker-v2-m3', '["rerank"]', '["rerank"]', 'rerank', 10, 1, 1, 1)`,
      ).run()
      const result = await callRerank(db, ':memory:', 'c1', 'm_rr', '年假怎么算', ['年假正文', '报销正文'], 2)
      expect(result.results[0]).toEqual({ index: 1, score: 0.8 })
      expect(result.results[1]).toEqual({ index: 0, score: 0.2 })
    } finally {
      db.close()
      mock.server.close()
    }
  })
})
