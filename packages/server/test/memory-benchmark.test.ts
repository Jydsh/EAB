import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase, type Db } from '@eab/storage'
import {
  MEMORY_BENCHMARK_CASES,
  MEMORY_BENCHMARK_VERSION,
  evaluateMemoryBenchmarkCases,
  evaluateMemoryRetentionProbe,
  lastMemoryBenchmarkRun,
  memoryBenchmarkDataset,
  runMemoryBenchmark,
  type MemoryBenchmarkCase,
} from '../src/memory-benchmark.js'

const handles: Db[] = []

afterEach(() => {
  for (const db of handles.splice(0)) db.close()
})

describe('memory benchmark', () => {
  it('固定基准包含 100 条用例，覆盖应记、应忽略与敏感三类', () => {
    const dataset = memoryBenchmarkDataset()
    expect(dataset).toEqual({
      version: MEMORY_BENCHMARK_VERSION,
      total: 100,
      expectedExtract: 60,
      expectedIgnore: 30,
      sensitive: 10,
      retentionRounds: 100,
    })
    expect(new Set(MEMORY_BENCHMARK_CASES.map((item) => item.id)).size).toBe(100)
  })

  it('第 100 轮仍能在 4 条上下文里召回第 1 轮的针事实', () => {
    const retention = evaluateMemoryRetentionProbe()
    expect(retention).toMatchObject({
      rounds: 100,
      query: '我的工号是多少？',
      limit: 4,
      recalled: true,
      rank: 1,
    })
  })

  it('评估器分别统计命中、漏写、误写和敏感泄漏', () => {
    const cases: MemoryBenchmarkCase[] = [
      { id: 'hit', category: 'identity', text: '我叫小张', expected: { action: 'extract', memoryType: 'fact' } },
      { id: 'missed', category: 'non-memory', text: '今天星期二', expected: { action: 'extract', memoryType: 'preference' } },
      { id: 'unexpected', category: 'quote-trap', text: '我叫小张', expected: { action: 'ignore' } },
      { id: 'leak', category: 'sensitive', text: '你好', expected: { action: 'sensitive' } },
    ]
    const report = evaluateMemoryBenchmarkCases(cases)
    expect(report).toMatchObject({
      total: 4,
      passed: 1,
      expectedExtract: 2,
      extractedHits: 1,
      missed: 1,
      expectedIgnore: 1,
      unexpected: 1,
      sensitiveCases: 1,
      sensitiveLeaks: 1,
      hitRate: 50,
      missRate: 50,
      miswriteRate: 100,
      passRate: 25,
    })
    expect(report.failures.map((item) => item.kind).sort()).toEqual(['missed', 'sensitive_leak', 'unexpected'])
  })

  it('运行记录持久化计数，失败明细只保存用例编号与类型，不保存原句', () => {
    const db = openDatabase({ path: ':memory:' })
    handles.push(db)
    migrate(db)
    const run = runMemoryBenchmark(db, { companyId: 'c1', userId: 'u1' })
    expect(run.total).toBe(100)
    expect(run.passed + run.missed + run.unexpected + run.sensitiveLeaks).toBe(100)
    expect(run.retention).toMatchObject({ rounds: 100, recalled: true, rank: 1 })
    const stored = lastMemoryBenchmarkRun(db, 'c1')
    expect(stored).not.toBeNull()
    expect(stored).toMatchObject({
      id: run.id,
      datasetVersion: MEMORY_BENCHMARK_VERSION,
      total: run.total,
      passed: run.passed,
      missed: run.missed,
      unexpected: run.unexpected,
      sensitiveLeaks: run.sensitiveLeaks,
      retention: { rounds: 100, recalled: true, rank: 1 },
      stale: false,
    })
    const raw = db.prepare('SELECT failure_json FROM memory_benchmark_runs WHERE id = ?')
      .get(run.id) as { failure_json: string }
    expect(raw.failure_json).not.toContain('我不喜欢加班')
    expect(raw.failure_json).not.toContain('我同事说我怕狗')
  })
})
