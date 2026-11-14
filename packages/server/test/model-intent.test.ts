import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { classifyChatIntent, intentHintOf, keywordIntent } from '../src/intent.js'

function seededDb(options: { route?: boolean } = {}) {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.prepare("INSERT INTO companies (id, name, slug, created_at) VALUES ('c1', '甲公司', 'acme', 1)").run()
  db.prepare(
    `INSERT INTO model_providers (id, company_id, kind, name, base_url, created_at, updated_at)
     VALUES ('p1', 'c1', 'custom', '本地推理', 'http://127.0.0.1:11434/v1', 1, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO models
       (id, company_id, provider_id, name, model_key, tags, capabilities, endpoint_kind, priority, enabled, created_at, updated_at)
     VALUES ('m_judge', 'c1', 'p1', '判定模型', 'qwen-judge', '["chat","decision"]', '["chat","decision"]', 'chat', 10, 1, 1, 1)`,
  ).run()
  if (options.route) {
    db.prepare(
      `INSERT INTO model_routes (id, company_id, purpose, model_id, priority, enabled, created_at, updated_at)
       VALUES ('r1', 'c1', 'router.intent', 'm_judge', 10, 1, 1, 1)`,
    ).run()
  }
  return db
}

describe('router.intent 意图判定', () => {
  it('未显式绑定时不判定，避免每轮多一次模型调用', async () => {
    const db = seededDb({ route: false })
    let called = false
    const result = await classifyChatIntent(db, ':memory:', 'c1', '我们组长是谁', {
      call: async () => {
        called = true
        return { text: '{"intent":"org","confidence":0.9}', promptTokens: 0, completionTokens: 0 }
      },
    })
    expect(result).toBeNull()
    expect(called).toBe(false)
  })

  it('显式绑定后按模型输出判定', async () => {
    const db = seededDb({ route: true })
    const result = await classifyChatIntent(db, ':memory:', 'c1', '年假怎么算', {
      call: async () => ({ text: '{"intent":"kb","confidence":0.82}', promptTokens: 0, completionTokens: 0 }),
    })
    expect(result?.intent).toBe('kb')
    expect(result?.basis).toBe('model')
    expect(result?.confidence).toBeCloseTo(0.82, 2)
    expect(result?.modelId).toBe('m_judge')
  })

  it('模型输出带杂字时仍能解析出 JSON', async () => {
    const db = seededDb({ route: true })
    const result = await classifyChatIntent(db, ':memory:', 'c1', '研发部有哪些人', {
      call: async () => ({ text: '好的，判定结果如下：{"intent":"org","confidence":0.7} 以上。', promptTokens: 0, completionTokens: 0 }),
    })
    expect(result?.intent).toBe('org')
  })

  it('调用失败时降级为不判定，不抛错', async () => {
    const db = seededDb({ route: true })
    const result = await classifyChatIntent(db, ':memory:', 'c1', '随便聊两句', {
      call: async () => {
        throw new Error('upstream 502')
      },
    })
    expect(result).toBeNull()
  })

  it('输出不可解析时用关键词兜底', async () => {
    const db = seededDb({ route: true })
    const result = await classifyChatIntent(db, ':memory:', 'c1', '报销流程要走哪些审批', {
      call: async () => ({ text: '我不太确定', promptTokens: 0, completionTokens: 0 }),
    })
    expect(result?.intent).toBe('kb')
    expect(result?.basis).toBe('keyword')
    expect(result?.confidence).toBeLessThan(0.6)
  })

  it('空消息不判定', async () => {
    const db = seededDb({ route: true })
    expect(await classifyChatIntent(db, ':memory:', 'c1', '   ')).toBeNull()
  })

  it('判定结果转成提示，普通问答不注入', () => {
    expect(
      intentHintOf({ intent: 'org', confidence: 0.9, modelId: 'm', basis: 'model' }),
    ).toContain('org_directory')
    expect(intentHintOf({ intent: 'chat', confidence: 0.5, modelId: 'm', basis: 'model' })).toBe('')
    expect(intentHintOf(null)).toBe('')
  })

  it('关键词兜底覆盖组织、制度与普通三类', () => {
    expect(keywordIntent('我们部门负责人是谁')).toBe('org')
    expect(keywordIntent('请假需要什么审批')).toBe('kb')
    expect(keywordIntent('帮我写一段自我介绍')).toBe('chat')
  })
})
