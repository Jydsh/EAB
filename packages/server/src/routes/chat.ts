/**
 * 员工工作台 · 对话与会话历史。
 *
 * 本轮补齐三件事（文档 CHAT-01/03/06/07/08 的核心）：
 * - 会话和消息落库，刷新/重启不丢，可重命名、软删、导出；
 * - 真正调用已配置的模型供应商；只有 kind=demo 才走本地回声；
 * - 每次回答前按当前身份从可见知识库检索片段，把引用一起返回。
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { EC, EabError, SC, scopeAllows, resolveVisibleCollections } from '@eab/domain'
import { appendAudit, loadKbCollectionAcls, type Db } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok } from '../http.js'
import { resolveActor, type RequestActor } from '../session.js'
import { callModelStream, callEmbeddings, callRerank, type ChatMessage as LlmMessage, type LlmContent, type LlmContentPart, type LlmToolCall } from '../llm.js'
import { resolveModelForPurpose, findModelById, capabilitiesOf, normalizeCapability } from '../model-registry.js'
import { compressMessagesForContext, estimateTokens } from '../context-window.js'
import { getCollectionEmbeddingModel, searchChunkVectors, type EmbedFn } from '../kb-vector.js'
import { executeTool, resolveToolByFunctionName, toolSpecsForActor, toolSpecsForAgent, type ChatToolSpec } from './tools.js'
import { executePluginTool, pluginPromptTexts, resolvePluginToolForActor } from '../plugin-tools.js'
import { subscribeChatEvents } from '../chat-events.js'
import { assertChatQuota } from '../quota.js'
import { findLocalSpaceRow, type ActiveSpace } from '../local-space.js'

/** CHAT-05：会话级串行锁（同一会话同一时刻只有一个 turn 在跑） */
interface TurnLock {
  token: string
  heldAt: number
  waiters: Array<() => void>
}
const activeTurns = new Map<string, TurnLock>()
const TURN_STALE_MS = 120_000
const TURN_WAIT_MS = 120_000

/**
 * 同一会话后来的消息不再报冲突，而是排队等前一轮结束。
 * 返回本次持有的 token；释放时只认自己的 token，避免超时接管后旧 turn 误释放新锁。
 */
export async function acquireTurn(sessionId: string): Promise<string> {
  const existing = activeTurns.get(sessionId)
  if (!existing) {
    const token = randomUUID()
    activeTurns.set(sessionId, { token, heldAt: Date.now(), waiters: [] })
    return token
  }
  // 超过 2 分钟的残留锁视为异常中断，允许接管；旧 turn 的 release 会因 token 不匹配被忽略。
  if (Date.now() - existing.heldAt >= TURN_STALE_MS) {
    const token = randomUUID()
    existing.token = token
    existing.heldAt = Date.now()
    return token
  }

  const token = await new Promise<string>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const waiter = () => {
      clearTimeout(timer)
      resolve(randomUUID())
    }
    timer = setTimeout(() => {
      const entry = activeTurns.get(sessionId)
      if (entry) entry.waiters = entry.waiters.filter((item) => item !== waiter)
      reject(
        new EabError(EC.CONFLICT, '前一轮回答还在进行，排队等待超时，请稍后再发', {
          hint: '同一会话同一时刻只处理一条消息',
        }),
      )
    }, TURN_WAIT_MS)
    existing.waiters.push(waiter)
  })

  const current = activeTurns.get(sessionId)
  if (current) {
    current.token = token
    current.heldAt = Date.now()
  } else {
    activeTurns.set(sessionId, { token, heldAt: Date.now(), waiters: [] })
  }
  return token
}

export function releaseTurn(sessionId: string, token: string): void {
  const entry = activeTurns.get(sessionId)
  if (!entry || entry.token !== token) return
  const next = entry.waiters.shift()
  if (next) {
    entry.token = ''
    entry.heldAt = Date.now()
    next()
    return
  }
  activeTurns.delete(sessionId)
}

export interface ModelDefinition {
  readonly id: string
  readonly name: string
  readonly desc: string
  readonly tags: readonly string[]
  readonly capabilities?: readonly string[]
  readonly endpointKind?: string
  readonly roles: readonly string[]
  readonly priority: number
  readonly provider: string
  readonly providerName: string
  readonly modelKey: string
  /** 模型上下文窗口；为空表示未配置，不做 token 预算压缩 */
  readonly maxContext?: number | null
  /** 单次回答最大 token；为空时由调用层用 4096 兜底 */
  readonly maxOutputTokens?: number | null
  /** 上下文超限时是否压缩较早历史，默认 true */
  readonly contextCompression?: boolean
}

const VISION_TAGS = new Set([
  'vision',
  'image',
  'images',
  'visual',
  'multimodal',
  'multi_modal',
  'multimodal_input',
  '图片',
  '图片识别',
  '视觉',
  '多模态',
])

/** 模型是否声明了图片 / 多模态输入能力；用于自动选模与图片消息前置校验。 */
export function modelSupportsVision(tags: readonly string[], capabilities: readonly string[] = []): boolean {
  return [...(tags || []), ...(capabilities || [])].some((tag) =>
    VISION_TAGS.has(normalizeCapability(String(tag || '')).replace(/[-\s]+/g, '_')),
  )
}

const DEMO_CATALOG: readonly ModelDefinition[] = [
  {
    id: 'model_general',
    name: '通用问答',
    desc: '日常问答、资料整理、写草稿',
    tags: ['chat', 'writing'],
    roles: ['auditor', 'company_admin', 'company_sub_admin', 'dept_admin', 'guest', 'kb_admin', 'member', 'super_admin'],
    priority: 10,
    provider: 'demo',
    providerName: '演示回声',
    modelKey: 'demo-chat',
  },
  {
    id: 'model_reason',
    name: '深度推理',
    desc: '长文档分析、多步推理（部门管理员及以上）',
    tags: ['reasoning', 'analysis'],
    roles: ['super_admin', 'company_admin', 'dept_admin'],
    priority: 20,
    provider: 'demo',
    providerName: '演示回声',
    modelKey: 'demo-reason',
  },
  {
    id: 'model_code',
    name: '代码助手',
    desc: '读代码、改脚本（知识库管理员与公司管理员）',
    tags: ['code'],
    roles: ['super_admin', 'company_admin', 'kb_admin'],
    priority: 15,
    provider: 'demo',
    providerName: '演示回声',
    modelKey: 'demo-code',
  },
]

function parseList(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

interface CatalogRow {
  id: string
  name: string
  model_key: string
  tags: string | null
  capabilities: string | null
  endpoint_kind: string | null
  roles: string | null
  priority: number
  provider_kind: string
  provider_name: string
  max_context: number | null
  max_output_tokens: number | null
  context_compression: number | null
}

export function loadModelCatalog(db: Db, companyId: string, allowDemoFallback: boolean): ModelDefinition[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.name, m.model_key, m.tags, m.capabilities, m.endpoint_kind, m.roles, m.priority,
              m.max_context, m.max_output_tokens, m.context_compression,
              p.kind AS provider_kind, p.name AS provider_name
         FROM models m
         JOIN model_providers p ON p.id = m.provider_id
        WHERE m.company_id = ? AND m.enabled = 1 AND m.deleted_at IS NULL
          AND p.deleted_at IS NULL AND p.status = 'active'
        ORDER BY m.priority DESC, m.name ASC`,
    )
    .all(companyId) as unknown as CatalogRow[]
  if (rows.length === 0) return allowDemoFallback ? [...DEMO_CATALOG] : []
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    desc: `${row.provider_name} · ${row.model_key}`,
    tags: parseList(row.tags),
    capabilities: capabilitiesOf(row.capabilities, row.tags),
    endpointKind: row.endpoint_kind ?? 'chat',
    roles: parseList(row.roles),
    priority: Number(row.priority),
    provider: row.provider_kind,
    providerName: row.provider_name,
    modelKey: row.model_key,
    maxContext: row.max_context === null ? null : Number(row.max_context),
    maxOutputTokens: row.max_output_tokens === null ? null : Number(row.max_output_tokens),
    contextCompression: row.context_compression === null || Number(row.context_compression) !== 0,
  }))
}

export function visibleModelsFor(catalog: readonly ModelDefinition[], roleCodes: readonly string[]): ModelDefinition[] {
  return catalog
    .filter((model) => model.roles.length > 0 && model.roles.some((role) => roleCodes.includes(role)))
    .sort((a, b) => b.priority - a.priority)
}

export interface ChunkHit {
  readonly collectionName: string
  readonly docTitle: string
  readonly text: string
  readonly docId?: string
  readonly chunkId?: string
  readonly collectionId?: string
  readonly score?: number
  readonly source?: string
  /** 是否经过 kb.rerank 重排（只用于排查与前端展示，不影响权限） */
  readonly reranked?: boolean
}

interface KbCandidateRow {
  chunk_id: string
  doc_id: string
  collection_id: string
  text: string
  classification: string
  collection_name: string
  doc_title: string
}

/** 把问题拆成短词/二元组；关键词路径用，向量路径直接用整句。 */
function keywordTerms(question: string): string[] {
  const blocks = question
    .replace(/[，。！？、,.!?;:（）()【】“”"'《》\s]+/g, ' ')
    .split(' ')
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
  const terms: string[] = []
  for (const block of blocks) {
    if (block.length <= 4) {
      terms.push(block)
      continue
    }
    // 中文没有空格：用二元组保证「年假」「制度」这类词能被命中
    for (let index = 0; index < block.length - 1; index += 1) {
      const gram = block.slice(index, index + 2)
      if (!/^(的|了|是|在|和|与|及|有|吗|呢|么|什|怎|哪|这|那|我|你|他)$/.test(gram)) terms.push(gram)
    }
  }
  return [...new Set(terms)].slice(0, 10)
}

/**
 * 混合检索：关键词召回 + 向量召回，用 RRF 合并。
 * 关键顺序不能反：先按身份裁可见知识库与密级，再取候选；向量表里没有权限字段，
 * 所以任何向量相似度计算都只能在已经裁过的 collectionId 集合内进行。
 * 未配置 embedding 模型或调用失败时，自动退回纯关键词，不阻断对话。
 */
export async function retrieveKb(
  db: Db,
  dbPath: string,
  actor: RequestActor,
  question: string,
  options: {
    readonly embed?: EmbedFn
    readonly rerank?: (query: string, documents: readonly string[]) => Promise<readonly { index: number; score: number }[]>
  } = {},
): Promise<ChunkHit[]> {
  if (!scopeAllows(actor.subject.scopes, SC.KB_READ)) return []
  const acls = loadKbCollectionAcls(db, actor.subject.companyId)
  const visible = resolveVisibleCollections(actor.subject, acls)
  if (visible.size === 0) return []

  const canConfidential = scopeAllows(actor.subject.scopes, SC.KB_ADMIN)
  const ids = [...visible]
  const terms = keywordTerms(question)
  const placeholders = ids.map(() => '?').join(',')

  const keywordRows =
    terms.length === 0
      ? []
      : (db
          .prepare(
            `SELECT c.id AS chunk_id, c.doc_id, c.collection_id, c.text, c.classification,
                    k.name AS collection_name, d.title AS doc_title
               FROM kb_chunks c
               JOIN kb_collections k ON k.id = c.collection_id
               JOIN kb_docs d ON d.id = c.doc_id
              WHERE c.collection_id IN (${placeholders})
                AND d.deleted_at IS NULL
              LIMIT 300`,
          )
          .all(...ids) as unknown as KbCandidateRow[])

  const keywordRanked = keywordRows
    .filter((row) => row.classification !== 'confidential' || canConfidential)
    .map((row) => {
      const score = terms.reduce((sum, term) => sum + (row.text.includes(term) ? 1 : 0), 0)
      return { row, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)

  let vectorRanked: Array<{ row: KbCandidateRow; score: number }> = []
  // 一个库可以单独绑定向量模型；按 modelId 分组，各自用同模型算问题向量，
  // 再合并候选。不同模型的向量绝不互相比较。
  const modelGroups = new Map<
    string,
    { model: NonNullable<ReturnType<typeof getCollectionEmbeddingModel>>; collectionIds: string[] }
  >()
  for (const collectionId of ids) {
    let model: ReturnType<typeof getCollectionEmbeddingModel>
    try {
      model = getCollectionEmbeddingModel(db, actor.subject.companyId, collectionId)
    } catch (err) {
      // 某个库显式绑定的模型失效时只跳过该库，不能让整次检索失败。
      console.warn('[kb] 向量模型不可用，跳过该库：', err instanceof Error ? err.message : String(err))
      continue
    }
    if (!model) continue
    const group = modelGroups.get(model.id) ?? { model, collectionIds: [] }
    group.collectionIds.push(collectionId)
    modelGroups.set(model.id, group)
  }

  const vectorHitsById = new Map<string, { chunkId: string; docId: string; score: number }>()
  for (const group of modelGroups.values()) {
    try {
      const questionText = question.trim().slice(0, 2000)
      const embedded = options.embed
        ? await options.embed([questionText])
        : await callEmbeddings(db, dbPath, actor.subject.companyId, group.model.id, [questionText])
      const queryVector = embedded.vectors[0] ?? []
      const vectorHits = searchChunkVectors(
        db,
        actor.subject.companyId,
        group.collectionIds,
        group.model.id,
        queryVector,
        20,
      )
      for (const hit of vectorHits) {
        const current = vectorHitsById.get(hit.chunkId)
        if (!current || hit.score > current.score) {
          vectorHitsById.set(hit.chunkId, { chunkId: hit.chunkId, docId: hit.docId, score: hit.score })
        }
      }
    } catch (err) {
      // 向量失败不影响回答：保留关键词路径，并把原因留在服务端日志里方便排查。
      console.warn('[kb] 向量检索失败，已回退关键词：', err instanceof Error ? err.message : String(err))
    }
  }

  if (vectorHitsById.size > 0) {
    const vectorHits = [...vectorHitsById.values()].sort((a, b) => b.score - a.score).slice(0, 20)
    const hitRows = db
      .prepare(
        `SELECT c.id AS chunk_id, c.doc_id, c.collection_id, c.text, c.classification,
                k.name AS collection_name, d.title AS doc_title
           FROM kb_chunks c
           JOIN kb_collections k ON k.id = c.collection_id
           JOIN kb_docs d ON d.id = c.doc_id
          WHERE c.id IN (${vectorHits.map(() => '?').join(',')})
            AND d.deleted_at IS NULL`,
      )
      .all(...vectorHits.map((hit) => hit.chunkId)) as unknown as KbCandidateRow[]
    const rowById = new Map(hitRows.map((row) => [row.chunk_id, row]))
    vectorRanked = vectorHits
      .map((hit) => {
        const row = rowById.get(hit.chunkId)
        return row ? { row, score: hit.score } : null
      })
      .filter((item): item is { row: KbCandidateRow; score: number } => Boolean(item))
      .filter((item) => item.row.classification !== 'confidential' || canConfidential)
      .slice(0, 20)
  }

  // Reciprocal Rank Fusion：两路各自排名越靠前，合并分越高；同一片段被两路同时命中会加分。
  const merged = new Map<string, { row: KbCandidateRow; score: number; keywordRank: number; vectorRank: number }>()
  keywordRanked.forEach((item, index) => {
    merged.set(item.row.chunk_id, {
      row: item.row,
      score: 1 / (60 + index + 1),
      keywordRank: index + 1,
      vectorRank: 0,
    })
  })
  vectorRanked.forEach((item, index) => {
    const existing = merged.get(item.row.chunk_id)
    if (existing) {
      existing.score += 1 / (60 + index + 1)
      existing.vectorRank = index + 1
    } else {
      merged.set(item.row.chunk_id, {
        row: item.row,
        score: 1 / (60 + index + 1),
        keywordRank: 0,
        vectorRank: index + 1,
      })
    }
  })

  const ranked = [...merged.values()].sort((a, b) => b.score - a.score)
  const rerankModel = resolveModelForPurpose(db, actor.subject.companyId, 'kb.rerank')
  let rerankUsed = false
  if (rerankModel && ranked.length > 1) {
    const candidates = ranked.slice(0, 20)
    try {
      const results = options.rerank
        ? await options.rerank(question, candidates.map((item) => item.row.text))
        : (
            await callRerank(
              db,
              dbPath,
              actor.subject.companyId,
              rerankModel.id,
              question,
              candidates.map((item) => item.row.text),
              4,
            )
          ).results
      const seen = new Set<string>()
      const reranked: typeof ranked = []
      for (const hit of results) {
        const item = candidates[hit.index]
        if (!item || seen.has(item.row.chunk_id)) continue
        seen.add(item.row.chunk_id)
        reranked.push({ ...item, score: hit.score })
      }
      // 重排序返回不足 4 条时，用 RRF 原顺序补齐，避免答不出来。
      for (const item of ranked) {
        if (reranked.length >= 4) break
        if (!seen.has(item.row.chunk_id)) reranked.push(item)
      }
      if (reranked.length > 0) {
        ranked.splice(0, ranked.length, ...reranked)
        rerankUsed = true
      }
    } catch (err) {
      // 重排是可选增强：失败只告警，继续用 RRF 结果回答。
      console.warn('[kb] 重排序失败，保留 RRF 顺序：', err instanceof Error ? err.message : String(err))
    }
  }

  const top = ranked.slice(0, 4)
  return top.map((item) => ({
    collectionName: item.row.collection_name,
    docTitle: item.row.doc_title,
    text: item.row.text.slice(0, 420),
    docId: item.row.doc_id,
    chunkId: item.row.chunk_id,
    collectionId: item.row.collection_id,
    score: Number(item.score.toFixed(4)),
    source: item.keywordRank && item.vectorRank ? 'hybrid' : item.vectorRank ? 'vector' : 'local',
    reranked: rerankUsed,
  }))
}

interface SessionRow {
  id: string
  title: string
  source: string | null
  space_kind: string | null
  space_id: string | null
  created_at: number
  updated_at: number
  last_message_at: number | null
}

interface MessageRow {
  id: string
  role: string
  text: string
  model_id: string | null
  model_name: string | null
  meta_json: string | null
  created_at: number
}

/** 网页与钉钉共用同一段系统提示，避免两边回答口径漂移。 */
export function buildSystemPrompt(opts: {
  actor: RequestActor
  chatTools: readonly ChatToolSpec[]
  memories: readonly { content: string }[]
  hits: readonly ChunkHit[]
  hasAttachments: boolean
  pluginPrompts?: readonly string[]
  /** 当前文件空间说明；用于告诉模型该用哪套文件工具，且不要输出绝对路径 */
  spaceLabel?: string
}): string {
  const { actor, chatTools, memories, hits, hasAttachments, pluginPrompts = [], spaceLabel } = opts
  const nowLabel = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date())
  return [
    `你是「${actor.person.companyName}」的企业智能助手 EAB（Enterprise Agent Base），当前用户是 ${actor.person.name}（${actor.person.deptName}）。`,
    `当前时间：${nowLabel}（Asia/Shanghai）。用户说“今天/现在/本周”时以此为准；需要精确到秒、换算日程或时区时再调用 time_now，不要靠心算日期和星期。`,
    '回答要简洁、可执行。涉及公司制度、流程、资料时，只能依据下面提供的知识库片段；片段不足以回答就直说“现有资料里没有”，不要编造。',
    spaceLabel
      ? `当前文件空间：${spaceLabel}。所有文件路径都相对于该空间根目录；不要输出、猜测或编造本地绝对路径。`
      : '',
    chatTools.length > 0
      ? `你可以调用工具获取实时信息或本企业数据（当前已加载：${chatTools.map((tool) => tool.function.name).join('、')}）。需要精确时间、通讯录或知识库检索时优先调用这些工具，拿到结果再回答；计算等未直接列出的能力先按下面的工具搜索规则加载。不要编造工具结果。`
      : '',
    chatTools.some((tool) => tool.function.name === 'tool_search')
      ? '当前工具列表只是常用工具，不是全部。需要文件发送/重命名/删除、云空间容量、定时任务列表、计算、插件等未直接列出的能力时，先调用 tool_search，query 写用户原话或中文/英文能力词；工具结果返回后，命中的工具会自动加载为可调用工具，直接继续调用即可，不要向用户解释工具加载机制，也不要因为当前列表里没有就直接说做不到。'
      : '',
    chatTools.some((tool) => tool.function.name === 'org_directory')
      ? '遇到“我的组长是谁 / 我在哪个部门 / 公司有哪些部门 / 某部门有谁 / 找某个人”这类组织问题时，直接调用 org_directory 工具，从当前对话推断 intent，不要先让用户输入姓名。工具返回 denied 或没有负责人时，如实说明权限或数据缺失，不要猜。'
      : '',
    chatTools.some((tool) => tool.function.name === 'schedule_create')
      ? '用户要“几点提醒我 / 每天/每周/每隔多久执行一次任务”时，直接调用 schedule_create，不要自己心算时间，也不要说“我做不到定时”。把用户的完整任务写进 prompt；短时提醒可用 after_seconds，重复任务可用 every_seconds（最少 300 秒）。创建后把下次执行时间用中文回给用户。查看/删除任务前先用 tool_search 搜 schedule_list / schedule_delete，加载后再调用，只能操作当前员工自己的任务。'
      : '',
    pluginPrompts.length > 0 ? `插件工具约定：\n${pluginPrompts.join('\n\n')}` : '',
    hasAttachments
      ? '用户本条消息带了附件：文本附件的正文已经附在用户消息里，图片以视觉输入一并提供。请直接基于附件内容回答，不要声称无法读取附件。'
      : '',
    memories.length > 0 ? `用户已确认的长期记忆：\n${memories.map((item) => `- ${item.content}`).join('\n')}` : '',
    hits.length > 0
      ? `知识库片段：\n${hits.map((hit, index) => `[${index + 1}] ${hit.collectionName} / ${hit.docTitle}\n${hit.text}`).join('\n\n')}\n\n回答里用到知识库片段时，在对应句末标注片段编号，例如 [1]；不要编造没有给出的编号。`
      : '本次没有检索到可用知识库片段。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function sessionTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return (clean ? clean.slice(0, 24) : '新对话') || '新对话'
}

function ensureSession(
  db: Db,
  actor: RequestActor,
  sessionId: string | null | undefined,
  firstText: string,
): string {
  if (sessionId) {
    const row = db
      .prepare(
        'SELECT id FROM chat_sessions WHERE id = ? AND user_id = ? AND company_id = ? AND deleted_at IS NULL',
      )
      .get(sessionId, actor.person.id, actor.subject.companyId)
    if (!row) throw new EabError(EC.NOT_FOUND, '会话不存在或已删除')
    return sessionId
  }
  const now = Date.now()
  const id = `chat_${randomUUID()}`
  db.prepare(
    `INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at, last_message_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, actor.subject.companyId, actor.person.id, sessionTitle(firstText), now, now, now)
  return id
}

/**
 * 渠道私聊固定会话：同一位员工、同一个钉钉账号始终落在同一个 chat_session。
 * 网页列表与钉钉私聊读的是同一张表，所以两端天然同源；网页删除后这里会重新建。
 */
export function ensureChannelSession(
  db: Db,
  actor: RequestActor,
  source: string,
  externalId: string,
  firstText: string,
): string {
  const row = db
    .prepare(
      `SELECT id FROM chat_sessions
        WHERE company_id = ? AND user_id = ? AND source = ? AND external_id = ?
          AND deleted_at IS NULL
        LIMIT 1`,
    )
    .get(actor.subject.companyId, actor.person.id, source, externalId) as { id: string } | undefined
  if (row) return row.id
  const now = Date.now()
  const id = `chat_${randomUUID()}`
  db.prepare(
    `INSERT OR IGNORE INTO chat_sessions
       (id, company_id, user_id, title, created_at, updated_at, last_message_at, source, external_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    actor.subject.companyId,
    actor.person.id,
    `${source === 'dingtalk' ? '钉钉' : source} · ${sessionTitle(firstText)}`,
    now,
    now,
    now,
    source,
    externalId,
  )
  const created = db
    .prepare(
      `SELECT id FROM chat_sessions
        WHERE company_id = ? AND user_id = ? AND source = ? AND external_id = ? AND deleted_at IS NULL
        LIMIT 1`,
    )
    .get(actor.subject.companyId, actor.person.id, source, externalId) as { id: string } | undefined
  return created?.id ?? id
}

export function setChannelOpenConversationId(db: Db, sessionId: string, openConversationId: string): void {
  const id = openConversationId.trim()
  if (!id) return
  db.prepare(
    `UPDATE chat_sessions SET open_conversation_id = ?
      WHERE id = ? AND (open_conversation_id IS NULL OR open_conversation_id <> ?)`,
  ).run(id, sessionId, id)
}

export function openConversationIdOf(db: Db, sessionId: string | null | undefined): string | null {
  if (!sessionId) return null
  const row = db
    .prepare('SELECT open_conversation_id FROM chat_sessions WHERE id = ?')
    .get(sessionId) as { open_conversation_id: string | null } | undefined
  return row?.open_conversation_id ?? null
}

export function historyOf(
  db: Db,
  sessionId: string,
  limit = 16,
  onlyChannel?: 'web' | 'dingtalk',
): Array<{ role: 'user' | 'assistant'; content: string }> {
  // 钉钉侧只回放钉钉来源消息，避免网页里补问的内容被当成钉钉上下文；
  // 网页侧不传 onlyChannel，仍能看到完整会话（含钉钉消息）。
  const channelClause = onlyChannel ? `AND json_extract(meta_json, '$.channel') = ?` : ''
  const rows = db
    .prepare(
      `SELECT role, text FROM chat_messages
        WHERE session_id = ? AND role IN ('user', 'assistant') ${channelClause}
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...(onlyChannel ? [sessionId, onlyChannel, limit] : [sessionId, limit])) as unknown as Array<{
    role: 'user' | 'assistant'
    text: string
  }>
  return rows.reverse().map((row) => ({ role: row.role, content: row.text }))
}

export function bumpUsage(db: Db, companyId: string, userId: string, prompt: number, completion: number): void {
  const day = new Date().toISOString().slice(0, 10)
  db.prepare(
    `INSERT INTO usage_daily (company_id, user_id, day, requests, prompt_tokens, completion_tokens)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(company_id, user_id, day) DO UPDATE SET
       requests = requests + 1,
       prompt_tokens = prompt_tokens + excluded.prompt_tokens,
       completion_tokens = completion_tokens + excluded.completion_tokens`,
  ).run(companyId, userId, day, prompt, completion)
}

export interface ChatAttachmentInput {
  name: string
  size: number
  type: string
  text?: string
  dataUrl?: string
}

const MAX_ATTACHMENT_TEXT = 12_000
const MAX_ATTACHMENT_DATA_URL = 14_000_000

function attachmentMeta(list: ChatAttachmentInput[]): Array<Record<string, unknown>> {
  return list.map((item) => {
    const { dataUrl, text, ...base } = item
    return {
      ...base,
      chars: text?.length ?? 0,
      hasImage: Boolean(dataUrl),
      readable: Boolean(text || dataUrl),
    }
  })
}

function buildAttachmentText(text: string, list: ChatAttachmentInput[]): string {
  const chunks: string[] = []
  if (text.trim()) chunks.push(text.trim())
  for (const item of list) {
    if (item.text) {
      chunks.push(`【附件：${item.name}】\n${item.text}`)
    } else if (item.dataUrl) {
      chunks.push(`【图片附件：${item.name}】图片已随消息附带，请直接查看图片内容后回答。`)
    } else {
      chunks.push(`【附件：${item.name}】这个附件暂时无法读取正文，请明确告诉用户需要转成文本或截图。`)
    }
  }
  return chunks.join('\n\n') || '（只发了附件）'
}

function buildUserContent(text: string, list: ChatAttachmentInput[]): LlmContent {
  const prompt = buildAttachmentText(text, list)
  const images = list.filter((item) => item.dataUrl)
  if (images.length === 0) return prompt
  const parts: LlmContentPart[] = [{ type: 'text', text: prompt }]
  for (const item of images) {
    parts.push({ type: 'image_url', image_url: { url: item.dataUrl as string } })
  }
  return parts
}

export interface AgentToolTrace {
  id: string
  name: string
  toolId: string
  args: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  summary: string
  durationMs: number
}

export type AgentEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'content'; text: string }
  | { type: 'tool'; id: string; name: string; toolId: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; status: 'done' | 'error'; summary: string; durationMs: number }

export interface AgentTurnResult {
  text: string
  reasoning: string
  toolCalls: AgentToolTrace[]
  rounds: number
  promptTokens: number
  completionTokens: number
}

function summarizeToolResult(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 从 tool_search 的返回里取出 function 名，供下一轮动态加载完整 Schema。 */
function toolSearchLoadedNames(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const tools = (payload as { tools?: unknown }).tools
  if (!Array.isArray(tools)) return []
  return tools.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const name = (item as { functionName?: unknown }).functionName
    return typeof name === 'string' && name.trim() ? [name.trim()] : []
  })
}

/**
 * 对话 Agent 循环：模型可以多轮「思考 → 调工具 → 看结果 → 继续回答」，最多 4 轮工具调用。
 * 事件通过 emit 实时下发；最终文本、思考内容和工具轨迹一起落库，刷新后还能回看。
 * 返回 null 表示演示供应商，由调用方走本地回声。
 */
export async function runAgentTurn(opts: {
  deps: ServerDeps
  actor: RequestActor
  modelId: string
  messages: LlmMessage[]
  emit: (event: AgentEvent) => void
  maxTokens?: number
  /** 插件工具需要当前会话 id（例如钉卡片按 sessionId 找发卡对象） */
  sessionId?: string
  /** 当前文件空间：决定只暴露云空间工具还是本地空间工具 */
  space?: ActiveSpace
  /** 用户停止生成时用它中止在途模型调用 */
  signal?: AbortSignal
}): Promise<AgentTurnResult | null> {
  const { deps, actor, modelId, emit } = opts
  const space = opts.space ?? { kind: 'cloud' }
  // 全量工具只用于“可加载目录”和权限校验；真正发给模型的是核心工具 + tool_search。
  const allTools = toolSpecsForActor(deps.db, actor, space)
  let tools = toolSpecsForAgent(deps.db, actor, space)
  const allowedToolNames = new Set(allTools.map((tool) => tool.function.name))
  const activeToolNames = new Set(tools.map((tool) => tool.function.name))
  const modelProfile = findModelById(deps.db, actor.subject.companyId, modelId)
  const maxOutputTokens = opts.maxTokens ?? modelProfile?.maxOutputTokens ?? 4096
  let messages: LlmMessage[] = [...opts.messages]
  if (modelProfile?.maxContext && modelProfile.contextCompression !== false) {
    const compressed = compressMessagesForContext(messages, {
      maxContext: modelProfile.maxContext,
      maxOutputTokens,
      toolTokens: estimateTokens(JSON.stringify(tools)),
    })
    messages = compressed.messages
  }
  const traces: AgentToolTrace[] = []
  let text = ''
  let reasoning = ''
  let promptTokens = 0
  let completionTokens = 0
  let rounds = 0
  let sawModel = false

  for (let round = 0; round < 4; round += 1) {
    if (opts.signal?.aborted) {
      const abortError = new Error('用户停止了本轮回复')
      abortError.name = 'AbortError'
      throw abortError
    }
    if (round > 0 && text.trim()) {
      text += '\n\n'
      emit({ type: 'content', text: '\n\n' })
    }
    rounds = round + 1
    let roundReasoningStarted = false
    const result = await callModelStream(
      deps.db,
      deps.config.dbPath,
      actor.subject.companyId,
      modelId,
      messages,
      {
        tools,
        signal: opts.signal,
        onEvent: (event) => {
          if (event.type === 'reasoning') {
            if (round > 0 && !roundReasoningStarted && reasoning.trim()) {
              reasoning += '\n\n'
              emit({ type: 'reasoning', text: '\n\n' })
            }
            roundReasoningStarted = true
            reasoning += event.text
            emit({ type: 'reasoning', text: event.text })
          } else {
            text += event.text
            emit({ type: 'content', text: event.text })
          }
        },
      },
      opts.maxTokens ?? maxOutputTokens,
    )
    if (!result) return null
    sawModel = true
    promptTokens += result.promptTokens
    completionTokens += result.completionTokens
    const calls: LlmToolCall[] = result.toolCalls ?? []
    if (calls.length === 0) break

    messages.push({ role: 'assistant', content: result.text ?? '', tool_calls: calls })
    for (const call of calls) {
      const functionName = call.function.name
      const def = resolveToolByFunctionName(functionName)
      const pluginTool = def ? null : resolvePluginToolForActor(deps.db, actor, functionName)
      const toolId = def?.id ?? (pluginTool ? `plugin:${pluginTool.pluginId}:${pluginTool.name}` : functionName)
      const toolName = def?.name ?? pluginTool?.name ?? functionName
      const args = parseToolArgs(call.function.arguments)
      const traceId = `${round + 1}-${call.id}`
      const trace: AgentToolTrace = {
        id: traceId,
        name: toolName,
        toolId,
        args,
        status: 'running',
        summary: '执行中…',
        durationMs: 0,
      }
      traces.push(trace)
      emit({ type: 'tool', id: traceId, name: toolName, toolId, args })
      const started = Date.now()
      let payload: unknown
      try {
        // 只允许当前员工、当前空间、非高危的工具；隐藏工具不能靠猜 function 名绕过。
        if (!allowedToolNames.has(functionName)) {
          throw new EabError(EC.FORBIDDEN, `工具未对当前员工或空间开放: ${functionName}`)
        }
        // 完整 Schema 尚未加载时先要求搜索，避免模型直接调用一个它没见过的工具。
        if (!activeToolNames.has(functionName)) {
          throw new EabError(EC.VALIDATION, `工具尚未加载: ${functionName}。请先调用 tool_search 搜索能力，再调用返回的工具。`)
        }
        if (!def && !pluginTool) throw new EabError(EC.NOT_FOUND, `模型调用了未注册的工具: ${functionName}`)
        if (def) {
          payload = await executeTool(deps, actor, def.id, args, space, {
            sessionId: opts.sessionId,
            channel: space.kind === 'cloud' && space.channel?.startsWith('dingtalk') ? 'dingtalk' : 'web',
          })
        } else if (pluginTool) {
          payload = await executePluginTool(pluginTool, args, {
            agent: { session: { id: opts.sessionId ?? '' } },
            session: { id: opts.sessionId ?? '' },
          })
          if (payload === undefined || payload === null) payload = { ok: true }
        }
        if (functionName === 'tool_search') {
          for (const loaded of toolSearchLoadedNames(payload)) {
            if (allowedToolNames.has(loaded)) activeToolNames.add(loaded)
          }
          // 下一轮把命中的工具完整 Schema 一起发给模型；核心工具始终保留。
          tools = allTools.filter((tool) => activeToolNames.has(tool.function.name))
        }
        trace.status = 'done'
        trace.summary = summarizeToolResult(payload)
      } catch (error) {
        trace.status = 'error'
        trace.summary = error instanceof EabError ? error.message : (error as Error)?.message ?? '工具执行失败'
        payload = { error: trace.summary }
      }
      trace.durationMs = Date.now() - started
      emit({
        type: 'tool_result',
        id: traceId,
        status: trace.status === 'done' ? 'done' : 'error',
        summary: trace.summary,
        durationMs: trace.durationMs,
      })
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(
          trace.status === 'done' ? { ok: true, tool: toolId, result: payload } : { ok: false, tool: toolId, error: trace.summary },
        ),
      })
    }
  }

  if (!sawModel) return null
  return { text, reasoning, toolCalls: traces, rounds, promptTokens, completionTokens }
}

export function registerChatRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/chat/models', async (req) => {
    const { subject, person } = resolveActor(deps.db, deps.config, req, deps.companyId)
    const roles = [...subject.roles]
    const canChat = scopeAllows(subject.scopes, SC.CHAT_USE)
    const canUseModel = scopeAllows(subject.scopes, SC.MODEL_USE)
    const catalog = loadModelCatalog(deps.db, subject.companyId, deps.config.devAuth)
    const models = canChat && canUseModel ? visibleModelsFor(catalog, roles) : []
    const defaultRoute = resolveModelForPurpose(deps.db, subject.companyId, 'chat.default')
    const autoModel = defaultRoute ? models.find((model) => model.id === defaultRoute.id) : undefined

    return ok({
      person,
      roles,
      canChat,
      canUseModel,
      autoModelId: autoModel?.id ?? (models.length > 0 ? models[0].id : null),
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        desc: model.desc,
        tags: model.tags,
        capabilities: model.capabilities ?? [],
        endpointKind: model.endpointKind ?? 'chat',
        supportsVision: modelSupportsVision(model.tags, model.capabilities),
        provider: model.provider,
        providerName: model.providerName,
        modelKey: model.modelKey,
      })),
    })
  })

  app.get('/api/chat/sessions', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    if (!scopeAllows(actor.subject.scopes, SC.CHAT_USE)) {
      throw new EabError(EC.SCOPE_DENIED, '当前身份没有对话权限（chat:use）')
    }
    const rows = deps.db
      .prepare(
        `SELECT id, title, source, created_at, updated_at, last_message_at
           FROM chat_sessions
          WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL
          ORDER BY COALESCE(last_message_at, updated_at) DESC LIMIT 50`,
      )
      .all(actor.subject.companyId, actor.person.id) as unknown as SessionRow[]
    return ok({
      sessions: rows.map((row) => ({
        id: row.id,
        title: row.title,
        source: row.source ?? 'web',
        createdAt: new Date(Number(row.created_at)).toISOString(),
        updatedAt: new Date(Number(row.last_message_at ?? row.updated_at)).toISOString(),
      })),
    })
  })

  /**
   * 网页工作台的消息推送：钉钉私聊写入 chat_messages 后，服务端把消息广播给
   * 同一公司、同一员工的已打开页面，前端无需刷新就能看到新消息。
   *
   * EventSource 自带 cookie，`?as=` 开发预览身份也沿用 qs() 透传。
   */
  app.get('/api/chat/events', async (req, reply) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    if (!scopeAllows(actor.subject.scopes, SC.CHAT_USE)) {
      throw new EabError(EC.SCOPE_DENIED, '当前身份没有对话权限（chat:use）')
    }

    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ userId: actor.person.id })}\n\n`)

    let closed = false
    let unsubscribe = () => {}
    let cleanup = () => {}
    const write = (chunk: string) => {
      if (closed) return
      try {
        reply.raw.write(chunk)
      } catch {
        cleanup()
      }
    }
    unsubscribe = subscribeChatEvents((event) => {
      if (event.companyId !== actor.subject.companyId || event.userId !== actor.person.id) return
      write(`event: chat\ndata: ${JSON.stringify(event)}\n\n`)
    })
    const heartbeat = setInterval(() => write(': ping\n\n'), 15_000)
    cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      unsubscribe()
      try {
        reply.raw.end()
      } catch {
        // 客户端已断开
      }
    }
    req.raw.once('close', cleanup)
    reply.raw.once('close', cleanup)
    // 返回空值，响应生命周期由上面 hijack 的原始流接管。
    return reply
  })

  app.post<{ Body: { title?: string } }>('/api/chat/sessions', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    if (!scopeAllows(actor.subject.scopes, SC.CHAT_USE)) {
      throw new EabError(EC.SCOPE_DENIED, '当前身份没有对话权限（chat:use）')
    }
    const now = Date.now()
    const id = `chat_${randomUUID()}`
    const title = String(req.body?.title ?? '').trim().slice(0, 60) || '新对话'
    deps.db
      .prepare(
        `INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at, last_message_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, actor.subject.companyId, actor.person.id, title, now, now, now)
    return ok({ session: { id, title, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() } })
  })

  app.get<{
    Params: { id: string }
    Querystring: { limit?: string; before?: string }
  }>('/api/chat/sessions/:id/messages', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    const session = deps.db
      .prepare(
        'SELECT id, title, source, space_kind, space_id FROM chat_sessions WHERE id = ? AND company_id = ? AND user_id = ? AND deleted_at IS NULL',
      )
      .get(req.params.id, actor.subject.companyId, actor.person.id) as
      | { id: string; title: string; source: string | null; space_kind: string | null; space_id: string | null }
      | undefined
    if (!session) throw new EabError(EC.NOT_FOUND, '会话不存在或已删除')

    /**
     * 历史消息分页：默认只返回最近一页，前端滚到顶部时再用 before（当前最旧一条的 id）
     * 取上一页。长会话不再一次性把所有消息渲染出来。
     */
    const rawLimit = Number.parseInt(String(req.query?.limit ?? ''), 10)
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 50
    const before = String(req.query?.before ?? '').trim()

    let cursor: { id: string; created_at: number } | undefined
    if (before) {
      cursor = deps.db
        .prepare('SELECT id, created_at FROM chat_messages WHERE id = ? AND session_id = ?')
        .get(before, session.id) as { id: string; created_at: number } | undefined
      if (!cursor) throw new EabError(EC.VALIDATION, 'before 消息不存在或不属于当前会话')
    }

    const rows = cursor
      ? (deps.db
          .prepare(
            `SELECT id, role, text, model_id, model_name, meta_json, created_at
               FROM chat_messages
              WHERE session_id = ?
                AND (created_at < ? OR (created_at = ? AND id < ?))
              ORDER BY created_at DESC, id DESC
              LIMIT ?`,
          )
          .all(session.id, cursor.created_at, cursor.created_at, cursor.id, limit + 1) as unknown as MessageRow[])
      : (deps.db
          .prepare(
            `SELECT id, role, text, model_id, model_name, meta_json, created_at
               FROM chat_messages
              WHERE session_id = ?
              ORDER BY created_at DESC, id DESC
              LIMIT ?`,
          )
          .all(session.id, limit + 1) as unknown as MessageRow[])

    const hasMore = rows.length > limit
    const page = (hasMore ? rows.slice(0, limit) : rows).slice().reverse()
    return ok({
      session,
      messages: page.map((row) => ({
        id: row.id,
        role: row.role,
        text: row.text,
        modelId: row.model_id,
        modelName: row.model_name,
        meta: row.meta_json ? JSON.parse(row.meta_json) : null,
        createdAt: new Date(Number(row.created_at)).toISOString(),
      })),
      hasMore,
      nextBefore: page[0]?.id ?? null,
      pageSize: limit,
    })
  })

  app.patch<{ Params: { id: string }; Body: { title?: string } }>(
    '/api/chat/sessions/:id',
    async (req) => {
      const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
      const title = String(req.body?.title ?? '').trim().slice(0, 60)
      if (!title) throw new EabError(EC.VALIDATION, '标题不能为空')
      const result = deps.db
        .prepare(
          'UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ? AND company_id = ? AND user_id = ? AND deleted_at IS NULL',
        )
        .run(title, Date.now(), req.params.id, actor.subject.companyId, actor.person.id)
      if (Number(result.changes) === 0) throw new EabError(EC.NOT_FOUND, '会话不存在或已删除')
      return ok({ renamed: true })
    },
  )

  app.delete<{ Params: { id: string } }>('/api/chat/sessions/:id', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    if (!scopeAllows(actor.subject.scopes, SC.CHAT_HISTORY_DELETE)) {
      throw new EabError(EC.SCOPE_DENIED, '当前身份没有删除会话的权限（chat:history:delete）')
    }
    const now = Date.now()
    let purgedCount = 0
    deps.db.exec('BEGIN IMMEDIATE')
    try {
      const result = deps.db
        .prepare(
          'UPDATE chat_sessions SET deleted_at = ?, updated_at = ? WHERE id = ? AND company_id = ? AND user_id = ? AND deleted_at IS NULL',
        )
        .run(now, now, req.params.id, actor.subject.companyId, actor.person.id)
      if (Number(result.changes) === 0) throw new EabError(EC.NOT_FOUND, '会话不存在或已删除')
      /**
       * 网页与钉钉共用同一份会话：删除必须是“两边都读不到”，
       * 因此消息正文从库里物理删除，不只是给会话打 deleted_at。
       */
      const purged = deps.db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(req.params.id)
      purgedCount = Number(purged.changes)
      deps.db.exec('COMMIT')
    } catch (error) {
      deps.db.exec('ROLLBACK')
      throw error
    }
    appendAudit(deps.db, {
      companyId: actor.subject.companyId,
      actorUserId: actor.person.id,
      action: 'chat.session.delete',
      resourceType: 'chat_session',
      resourceId: req.params.id,
      result: 'success',
      ip: req.ip,
      channel: 'web',
    })
    return ok({ deleted: true, messagesPurged: purgedCount })
  })

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/api/chat/sessions/:id/export',
    async (req, reply) => {
      const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
      if (!scopeAllows(actor.subject.scopes, SC.CHAT_EXPORT)) {
        throw new EabError(EC.SCOPE_DENIED, '当前身份没有导出会话的权限（chat:export）')
      }
      const session = deps.db
        .prepare(
          'SELECT id, title FROM chat_sessions WHERE id = ? AND company_id = ? AND user_id = ? AND deleted_at IS NULL',
        )
        .get(req.params.id, actor.subject.companyId, actor.person.id) as { id: string; title: string } | undefined
      if (!session) throw new EabError(EC.NOT_FOUND, '会话不存在或已删除')
      const rows = deps.db
        .prepare('SELECT role, text, created_at AS createdAt FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC')
        .all(session.id) as unknown as Array<{ role: string; text: string; createdAt: number }>
      appendAudit(deps.db, {
        companyId: actor.subject.companyId,
        actorUserId: actor.person.id,
        action: 'chat.session.export',
        resourceType: 'chat_session',
        resourceId: session.id,
        result: 'success',
        ip: req.ip,
        channel: 'web',
      })
      if (req.query.format === 'json') {
        reply.type('application/json; charset=utf-8')
        reply.header('content-disposition', `attachment; filename="${session.id}.json"`)
        return reply.send(JSON.stringify({ title: session.title, messages: rows }, null, 2))
      }
      const markdown = [`# ${session.title}`, '', ...rows.map((row) => `## ${row.role}\n\n${row.text}\n`)].join('\n')
      reply.type('text/markdown; charset=utf-8')
      reply.header('content-disposition', `attachment; filename="${session.id}.md"`)
      return reply.send(markdown)
    },
  )

  app.post<{
    Body: {
      sessionId?: string | null
      modelId?: string | null
      text?: string
      attachments?: Array<{
        name?: string
        size?: number
        type?: string
        text?: string
        dataUrl?: string
      }>
      /** true 时以 SSE 返回同样的回答（CHAT-02 流式） */
      stream?: boolean
      /** 本轮使用的文件空间：cloud（默认）/ local / none */
      spaceKind?: 'cloud' | 'local' | 'none'
      /** spaceKind=local 时必填 */
      spaceId?: string | null
    }
  }>('/api/chat/messages', { bodyLimit: 60 * 1024 * 1024 }, async (req, reply) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    if (!scopeAllows(actor.subject.scopes, SC.CHAT_USE)) {
      throw new EabError(EC.FORBIDDEN, '当前身份没有对话权限（chat:use）', {
        details: { requiredScope: SC.CHAT_USE },
      })
    }
    if (!scopeAllows(actor.subject.scopes, SC.MODEL_USE)) {
      throw new EabError(EC.FORBIDDEN, '当前身份没有使用模型的权限（model:use）', {
        details: { requiredScope: SC.MODEL_USE },
      })
    }

    // 月度额度闸：成员 / 部门 / 公司逐级检查，硬额度用尽直接 429（控制台「额度」页可调）
    assertChatQuota(deps.db, {
      companyId: actor.subject.companyId,
      userId: actor.person.id,
      deptId: actor.subject.deptId,
      deptPath: actor.subject.deptPath,
    })

    const text = String(req.body?.text ?? '').trim()
    if (text.length > 4000) throw new EabError(EC.VALIDATION, '单条消息最多 4000 字')
    const rawAttachments = req.body?.attachments
    if (rawAttachments !== undefined && !Array.isArray(rawAttachments)) {
      throw new EabError(EC.VALIDATION, 'attachments 必须是数组')
    }
    const attachments: ChatAttachmentInput[] = (rawAttachments ?? []).slice(0, 4).map((item) => {
      const name = String(item?.name ?? '').trim().slice(0, 200)
      const size = Number(item?.size ?? 0)
      const type = String(item?.type ?? '').slice(0, 100)
      const attachmentText = String(item?.text ?? '').slice(0, MAX_ATTACHMENT_TEXT)
      const dataUrl = String(item?.dataUrl ?? '')
      if (!name) throw new EabError(EC.VALIDATION, '附件缺少文件名')
      if (!Number.isFinite(size) || size < 0) throw new EabError(EC.VALIDATION, '附件大小不合法')
      if (dataUrl) {
        if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(dataUrl)) {
          throw new EabError(EC.VALIDATION, `附件「${name}」不是支持的图片格式`)
        }
        if (dataUrl.length > MAX_ATTACHMENT_DATA_URL) {
          throw new EabError(EC.VALIDATION, `附件「${name}」图片太大，请压缩到 10MB 以内`)
        }
      }
      return { name, size: Math.trunc(size), type, text: attachmentText, dataUrl }
    })
    if ((rawAttachments ?? []).length > 4) throw new EabError(EC.VALIDATION, '单条消息最多 4 个附件')
    if (!text && attachments.length === 0) throw new EabError(EC.VALIDATION, '消息不能为空')

    /**
     * 空间选择只决定这一轮 Agent 拿哪套文件工具：
     * - cloud： workspace.*
     * - local：  local.*（必须已绑定且目录仍存在）
     * - none：  不暴露文件工具
     */
    const rawSpaceKind = req.body?.spaceKind
    if (rawSpaceKind !== undefined && !['cloud', 'local', 'none'].includes(rawSpaceKind)) {
      throw new EabError(EC.VALIDATION, 'spaceKind 只能是 cloud / local / none')
    }
    let space: ActiveSpace = { kind: rawSpaceKind === 'none' ? 'none' : 'cloud' }
    let spaceLabel = rawSpaceKind === 'none' ? '未选择文件空间' : '云空间'
    if (rawSpaceKind === 'local') {
      const spaceId = String(req.body?.spaceId ?? '').trim()
      if (!spaceId) throw new EabError(EC.VALIDATION, '选择本地空间时 spaceId 不能为空')
      const row = findLocalSpaceRow(deps.db, actor.subject.companyId, actor.person.id, spaceId)
      if (!row) throw new EabError(EC.NOT_FOUND, '本地空间不存在或已删除，请重新选择')
      if (!existsSync(row.root_realpath)) {
        throw new EabError(EC.CONFLICT, '本地目录不存在或已离线，请重新绑定或检查磁盘', {
          details: { spaceId: row.id, rootPath: row.root_path },
        })
      }
      space = { kind: 'local', spaceId: row.id }
      spaceLabel = `本地空间「${row.name}」`
    }

    const roles = [...actor.subject.roles]
    const catalog = loadModelCatalog(deps.db, actor.subject.companyId, deps.config.devAuth)
    const available = visibleModelsFor(catalog, roles)
    if (available.length === 0) {
      throw new EabError(EC.FORBIDDEN, '当前身份没有任何可用模型，请联系管理员授权', {
        details: { requiredScope: SC.MODEL_USE },
      })
    }

    const requested = req.body?.modelId ?? null
    const hasImageAttachments = attachments.some((item) => Boolean(item.dataUrl))
    const imageModels = available.filter((item) => modelSupportsVision(item.tags, item.capabilities))
    const model = requested
      ? available.find((item) => item.id === requested)
      : hasImageAttachments && imageModels.length
        ? imageModels[0]
        : available[0]
    if (!model) {
      const exists = catalog.some((item) => item.id === requested)
      throw new EabError(EC.FORBIDDEN, exists ? '当前身份无权使用这个模型' : '模型不存在', {
        details: { modelId: requested },
      })
    }
    if (hasImageAttachments && !modelSupportsVision(model.tags, model.capabilities)) {
      throw new EabError(EC.VALIDATION, `模型「${model.name}」没有开启图片识别能力`, {
        hint: '请切换到带「图片识别 / 多模态」能力的模型，或在控制台的模型接入页给它勾选图片能力。',
        details: { modelId: model.id, requiredCapability: 'vision' },
      })
    }

    const sessionId = ensureSession(deps.db, actor, req.body?.sessionId, text || attachments[0]?.name || '新对话')
    deps.db
      .prepare('UPDATE chat_sessions SET space_kind = ?, space_id = ?, updated_at = ?, last_message_at = ? WHERE id = ?')
      .run(
        space.kind,
        space.kind === 'local' ? space.spaceId : null,
        Date.now(),
        Date.now(),
        sessionId,
      )
    const turnToken = await acquireTurn(sessionId)
    const abortController = new AbortController()
    const hits = await retrieveKb(deps.db, deps.config.dbPath, actor, text)
    const memories = deps.db
      .prepare(
        `SELECT content FROM memories
          WHERE company_id = ? AND deleted_at IS NULL AND confirmed = 1
            AND ((scope_type = 'user' AND scope_id = ?)
              OR (scope_type = 'dept' AND scope_id = ?)
              OR (scope_type = 'company' AND scope_id = ?))
          ORDER BY created_at DESC LIMIT 8`,
      )
      .all(actor.subject.companyId, actor.person.id, actor.subject.deptId, actor.subject.companyId) as unknown as Array<{
      content: string
    }>
    const history = historyOf(deps.db, sessionId)
    const chatTools = toolSpecsForAgent(deps.db, actor, space)
    const pluginPrompts = pluginPromptTexts(deps.db, actor)
    const system = buildSystemPrompt({
      actor,
      chatTools,
      memories,
      hits,
      hasAttachments: attachments.length > 0,
      pluginPrompts,
      spaceLabel,
    })

    const messages: LlmMessage[] = [
      { role: 'system', content: system },
      ...history,
      { role: 'user', content: buildUserContent(text, attachments) },
    ]

    const now = Date.now()
    const userMessageId = `msg_${randomUUID()}`
    deps.db
      .prepare(
        `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, model_id, model_name, meta_json, created_at)
         VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?)`,
      )
      .run(
        userMessageId,
        actor.subject.companyId,
        sessionId,
        actor.person.id,
        text || `（附件：${attachments.map((item) => item.name).join('、')}）`,
        model.id,
        model.name,
        JSON.stringify({
          channel: 'web',
          attachments: attachmentMeta(attachments),
          space: {
            kind: space.kind,
            id: space.kind === 'local' ? space.spaceId : null,
            label: spaceLabel,
          },
        }),
        now,
      )

    const autoSelected = requested === null
    const assistantMessageId = `msg_${randomUUID()}`
    const streaming = req.body?.stream === true
    let seq = 0
    const emitSse = (event: string, data: Record<string, unknown>) => {
      if (!streaming) return
      seq += 1
      try {
        reply.raw.write(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify({ seq, ...data })}\n\n`)
      } catch {
        // 客户端断开时忽略写入失败；答案仍会落库
      }
    }

    if (streaming) {
      reply.hijack()
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      reply.raw.write(
        `event: meta\ndata: ${JSON.stringify({
          sessionId,
          messageId: assistantMessageId,
          modelId: model.id,
          modelName: model.name,
          autoSelected,
        })}\n\n`,
      )
      // 浏览器点「停止当前回复并发送」会断开 SSE；断开后中止模型流，
      // 避免旧 turn 继续跑、继续写库，下一轮才能干净地接上。
      reply.raw.on('close', () => abortController.abort())
    }

    let agent: AgentTurnResult | null = null
    try {
      agent = await runAgentTurn({
        deps,
        actor,
        modelId: model.id,
        messages,
        sessionId,
        space,
        signal: streaming ? abortController.signal : undefined,
        emit: (event) => {
          if (event.type === 'reasoning') emitSse('reasoning', { text: event.text })
          else if (event.type === 'content') emitSse('delta', { text: event.text })
          else if (event.type === 'tool') {
            emitSse('tool', { id: event.id, name: event.name, toolId: event.toolId, args: event.args })
          } else {
            emitSse('tool_result', {
              id: event.id,
              status: event.status,
              summary: event.summary,
              durationMs: event.durationMs,
            })
          }
        },
      })
    } catch (error) {
      releaseTurn(sessionId, turnToken)
      // 用户主动停止（SSE 断开）不是失败：不写失败审计、不再往断开的连接写事件。
      if (abortController.signal.aborted) {
        if (streaming) {
          try {
            reply.raw.end()
          } catch {
            // 连接已经关闭
          }
          return reply
        }
      }
      appendAudit(deps.db, {
        companyId: actor.subject.companyId,
        actorUserId: actor.person.id,
        action: 'chat.model.call',
        resourceType: 'model',
        resourceId: model.id,
        result: 'failure',
        detail: { error: error instanceof EabError ? error.message : 'unknown' },
        ip: req.ip,
        channel: 'web',
      })
      if (streaming) {
        emitSse('error', {
          code: error instanceof EabError ? error.code : EC.UPSTREAM,
          message: error instanceof EabError ? error.message : '模型调用失败',
        })
        reply.raw.end()
        return reply
      }
      throw error
    }

    const attachmentNames = attachments.map((item) => item.name).join('、')
    const demoEcho = [
      '（演示应答 · 这个模型来自演示供应商，还没有接真实 API）',
      `${actor.person.name}，你问的是：「${text || '（只发了附件）'}」`,
      ...(attachmentNames
        ? [`你发的附件：${attachmentNames}（演示供应商不处理附件内容，真实模型会读取）`]
        : []),
      `本次使用的模型：${model.name}（${autoSelected ? '自动选择' : '手动选择'}）`,
      `你能用的模型共 ${available.length} 个：${available.map((item) => item.name).join('、')}`,
    ].join('\n')

    let answerText = agent?.text?.trim() ?? ''
    if (!agent) {
      answerText = demoEcho
      if (streaming) {
        for (let i = 0; i < answerText.length; i += 60) {
          emitSse('delta', { text: answerText.slice(i, i + 60) })
        }
      }
    } else if (!answerText) {
      answerText = '工具调用已完成，但模型没有返回最终答案。请换个问法或稍后重试。'
      if (streaming) emitSse('delta', { text: answerText })
    }

    // channel 用于区分消息来源：钉钉侧只回放 channel=dingtalk 的消息，
    // 网页里发出的消息标记为 web，不回写钉钉，也不进入钉钉的上下文。
    const meta = {
      channel: 'web',
      autoSelected,
      attachments: attachmentMeta(attachments),
      citations: hits.map((hit, index) => ({
        index: index + 1,
        collection: hit.collectionName,
        title: hit.docTitle,
        excerpt: hit.text.slice(0, 120),
        docId: hit.docId ?? null,
        chunkId: hit.chunkId ?? null,
        score: hit.score ?? null,
        source: hit.source ?? 'local',
      })),
      tokens: agent ? { prompt: agent.promptTokens, completion: agent.completionTokens } : null,
      reasoning: agent?.reasoning ?? '',
      toolCalls: agent?.toolCalls ?? [],
      rounds: agent?.rounds ?? 0,
    }
    deps.db
      .prepare(
        `INSERT INTO chat_messages (id, company_id, session_id, user_id, role, text, model_id, model_name, meta_json, created_at)
         VALUES (?, ?, ?, ?, 'assistant', ?, ?, ?, ?, ?)`,
      )
      .run(
        assistantMessageId,
        actor.subject.companyId,
        sessionId,
        actor.person.id,
        answerText,
        model.id,
        model.name,
        JSON.stringify(meta),
        Date.now(),
      )
    releaseTurn(sessionId, turnToken)
    deps.db
      .prepare('UPDATE chat_sessions SET updated_at = ?, last_message_at = ? WHERE id = ?')
      .run(Date.now(), Date.now(), sessionId)
    bumpUsage(
      deps.db,
      actor.subject.companyId,
      actor.person.id,
      agent?.promptTokens ?? 0,
      agent?.completionTokens ?? 0,
    )
    appendAudit(deps.db, {
      companyId: actor.subject.companyId,
      actorUserId: actor.person.id,
      action: 'chat.message',
      resourceType: 'chat_session',
      resourceId: sessionId,
      result: 'success',
      detail: {
        modelId: model.id,
        citations: hits.length,
        attachments: attachments.length,
        tools: agent?.toolCalls.length ?? 0,
        rounds: agent?.rounds ?? 0,
      },
      ip: req.ip,
      channel: 'web',
    })

    /**
     * 单向同步：只把钉钉侧写入的消息推送到网页工作台。
     * 网页里的对话不回写钉钉，避免把工作台里的操作同步成钉钉消息。
     */

    if (streaming) {
      emitSse('done', {
        sessionId,
        messageId: assistantMessageId,
        text: answerText,
        modelId: model.id,
        modelName: model.name,
        citations: meta.citations,
        reasoning: meta.reasoning,
        toolCalls: meta.toolCalls,
      })
      reply.raw.end()
      return reply
    }

    return ok({
      sessionId,
      message: {
        id: assistantMessageId,
        role: 'assistant',
        text: answerText,
        modelId: model.id,
        modelName: model.name,
        autoSelected,
        attachments: meta.attachments,
        citations: meta.citations,
        reasoning: meta.reasoning,
        toolCalls: meta.toolCalls,
        createdAt: new Date().toISOString(),
      },
    })
  })
}
