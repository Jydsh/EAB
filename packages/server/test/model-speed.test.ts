import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import {
  aggregateModelSpeed,
  estimateTokensFromText,
  invalidateModelSpeedStats,
  pickFastestModel,
  rankModelsBySpeed,
  readModelSpeedStats,
  type ModelSpeedStat,
} from '../src/model-speed.js'

const models = [
  { id: 'slow_priority', name: '高优先级但慢', priority: 100, endpointKind: 'chat' as const },
  { id: 'fast_low_priority', name: '低优先级但快', priority: 1, endpointKind: 'chat' as const },
  { id: 'unknown', name: '没有样本', priority: 50, endpointKind: 'chat' as const },
]

function stat(partial: Partial<ModelSpeedStat> & { modelId: string }): ModelSpeedStat {
  return {
    modelName: partial.modelId,
    samples: 1,
    ttftMs: 1000,
    tokensPerSecond: 10,
    estimatedReplyMs: 1000 + (256 / 10) * 1000,
    measuredAt: Date.now(),
    ...partial,
  }
}

describe('模型实测速度', () => {
  it('估算 token 时中文按字、英文按 4 字符', () => {
    expect(estimateTokensFromText('你好世界')).toBe(4)
    expect(estimateTokensFromText('hello world')).toBe(3)
    expect(estimateTokensFromText('你好hello')).toBe(4)
  })

  it('上游没有 usage 时用正文与推理文本估算 completion', () => {
    const stats = aggregateModelSpeed([
      {
        modelId: 'qwen',
        modelName: 'Qwen3.8',
        text: '答案是四。',
        reasoning: '先看题目，再做加法。',
        ttftMs: 2000,
        genMs: 4000,
        completionTokens: 0,
      },
    ])
    const qwen = stats.get('qwen')
    expect(qwen?.samples).toBe(1)
    expect(qwen?.tokensPerSecond).toBeGreaterThan(0)
  })

  it('取中位数，避免单次抖动主导', () => {
    const stats = aggregateModelSpeed([
      { modelId: 'a', ttftMs: 1000, genMs: 1000, completionTokens: 10 },
      { modelId: 'a', ttftMs: 3000, genMs: 1000, completionTokens: 10 },
      { modelId: 'a', ttftMs: 2000, genMs: 1000, completionTokens: 10 },
    ])
    expect(stats.get('a')?.ttftMs).toBe(2000)
    expect(stats.get('a')?.tokensPerSecond).toBe(10)
  })

  it('按预计回复耗时排序，不受优先级影响', () => {
    const stats = new Map([
      ['slow_priority', stat({ modelId: 'slow_priority', ttftMs: 8000, tokensPerSecond: 8 })],
      ['fast_low_priority', stat({ modelId: 'fast_low_priority', ttftMs: 2000, tokensPerSecond: 50 })],
    ])
    expect(rankModelsBySpeed(models, stats).map((model) => model.id)).toEqual([
      'fast_low_priority',
      'slow_priority',
      'unknown',
    ])
    expect(pickFastestModel(models, stats)?.id).toBe('fast_low_priority')
  })

  it('没有速度样本时保持调用方原顺序', () => {
    expect(rankModelsBySpeed(models, new Map()).map((model) => model.id)).toEqual([
      'slow_priority',
      'fast_low_priority',
      'unknown',
    ])
  })

  it('从真实 chat_messages 读取最近样本，并忽略窗口外的旧消息', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    const now = Date.now()
    db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('c1', '测试公司', 'model-speed-test', 'active', now)
    db.prepare('INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('d1', 'c1', '测试部门', '/d1', 1, 0, now)
    db.prepare('INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('u1', 'c1', 'd1', '/d1', '测试员工', 'active', now, now)
    db.prepare('INSERT INTO chat_sessions (id, company_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('s1', 'c1', 'u1', '速度测试', now, now)

    const insert = (id: string, modelId: string, createdAt: number, completion: number, ttft: number, gen: number) => {
      db.prepare(`INSERT INTO chat_messages
        (id, company_id, session_id, user_id, role, text, model_id, model_name, meta_json, created_at)
        VALUES (?, ?, ?, ?, 'assistant', ?, ?, ?, ?, ?)`)
        .run(
          id,
          'c1',
          's1',
          'u1',
          '回答',
          modelId,
          modelId,
          JSON.stringify({ tokens: { prompt: 1, completion }, timing: { ttftMs: ttft, genMs: gen, wallMs: ttft + gen } }),
          createdAt,
        )
    }

    insert('m1', 'fast', now - 60_000, 200, 1000, 2000)
    insert('m2', 'fast', now - 30_000, 300, 2000, 3000)
    insert('m3', 'old', now - 31 * 24 * 60 * 60 * 1000, 100, 100, 1000)

    invalidateModelSpeedStats()
    const stats = readModelSpeedStats(db, 'c1', now)
    expect(stats.get('fast')?.samples).toBe(2)
    expect(stats.get('fast')?.ttftMs).toBe(1500)
    expect(stats.get('old')).toBeUndefined()
    expect(stats.get('fast')?.estimatedReplyMs).toBeGreaterThan(0)

    // 第二次读取走缓存，再失效后能拿到新样本。
    insert('m4', 'fast', now - 10_000, 400, 500, 1000)
    invalidateModelSpeedStats('c1')
    expect(readModelSpeedStats(db, 'c1', now).get('fast')?.samples).toBe(3)
    db.close()
  })
})
