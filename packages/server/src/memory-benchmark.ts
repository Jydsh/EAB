/**
 * 记忆抽取基准评测（F 阶段）。
 *
 * 这里评估的是“规则抽取”的可重复基线：固定 100 条合成用例，覆盖该记住的事实/偏好，
 * 以及不该记住的一次性任务、第三方转述和敏感凭证。它不读写真实记忆库，也不会污染用户画像；
 * 每次运行只把通过率、漏写率、误写率和敏感泄漏计数写进 memory_benchmark_runs。
 */
import { randomUUID } from 'node:crypto'
import type { Db } from '@eab/storage'
import type { MemoryType } from './memory-os.js'
import { memoryLooksSensitive } from './memory-os.js'
import { extractMemoryCandidatesByRules } from './memory-extractor.js'
import { selectRelevantLongTermMemoriesDetailed, type LongTermMemoryLike } from './context-policy.js'

export const MEMORY_BENCHMARK_VERSION = '2026-11-24.1'
export const MEMORY_RETENTION_ROUNDS = 100

export type MemoryBenchmarkAction = 'extract' | 'ignore' | 'sensitive'
export type MemoryBenchmarkCategory =
  | 'identity'
  | 'fear'
  | 'like'
  | 'habit'
  | 'possession'
  | 'future-preference'
  | 'non-memory'
  | 'quote-trap'
  | 'sensitive'

export interface MemoryBenchmarkCase {
  readonly id: string
  readonly category: MemoryBenchmarkCategory
  readonly text: string
  readonly expected: { action: 'extract'; memoryType: MemoryType } | { action: 'ignore' } | { action: 'sensitive' }
}

export type MemoryBenchmarkFailureKind = 'missed' | 'unexpected' | 'sensitive_leak'

export interface MemoryBenchmarkFailure {
  readonly caseId: string
  readonly category: MemoryBenchmarkCategory
  readonly kind: MemoryBenchmarkFailureKind
  readonly expectedType?: MemoryType
  readonly actualTypes: readonly MemoryType[]
}

export interface MemoryBenchmarkReport {
  readonly version: string
  readonly total: number
  readonly passed: number
  readonly expectedExtract: number
  readonly extractedHits: number
  readonly missed: number
  readonly expectedIgnore: number
  readonly unexpected: number
  readonly sensitiveCases: number
  readonly sensitiveLeaks: number
  readonly hitRate: number
  readonly missRate: number
  readonly miswriteRate: number
  readonly passRate: number
  readonly failures: readonly MemoryBenchmarkFailure[]
}

export interface MemoryRetentionResult {
  readonly rounds: number
  readonly query: string
  readonly limit: number
  readonly recalled: boolean
  readonly rank: number | null
}

const fact = (id: string, category: MemoryBenchmarkCategory, text: string): MemoryBenchmarkCase => ({
  id,
  category,
  text,
  expected: { action: 'extract', memoryType: 'fact' },
})

const preference = (id: string, category: MemoryBenchmarkCategory, text: string): MemoryBenchmarkCase => ({
  id,
  category,
  text,
  expected: { action: 'extract', memoryType: 'preference' },
})

const ignore = (id: string, category: MemoryBenchmarkCategory, text: string): MemoryBenchmarkCase => ({
  id,
  category,
  text,
  expected: { action: 'ignore' },
})

const sensitive = (id: string, category: MemoryBenchmarkCategory, text: string): MemoryBenchmarkCase => ({
  id,
  category,
  text,
  expected: { action: 'sensitive' },
})

const identityCases: MemoryBenchmarkCase[] = [
  fact('identity-01', 'identity', '我叫何伟'),
  fact('identity-02', 'identity', '我的名字是李娜'),
  fact('identity-03', 'identity', '我叫王强，在信息部工作'),
  fact('identity-04', 'identity', '我的名字叫赵敏'),
  fact('identity-05', 'identity', '我叫陈晨，来自重庆'),
  fact('identity-06', 'identity', '我叫刘洋，做项目实施'),
  fact('identity-07', 'identity', '我的名字是周杰'),
  fact('identity-08', 'identity', '我叫孙悦，主要负责测试'),
]

const fearCases: MemoryBenchmarkCase[] = [
  fact('fear-01', 'fear', '我怕狗'),
  fact('fear-02', 'fear', '我特别害怕打雷'),
  fact('fear-03', 'fear', '我有点怕黑'),
  fact('fear-04', 'fear', '我很怕坐飞机'),
  fact('fear-05', 'fear', '我害怕在很多人面前演讲'),
  fact('fear-06', 'fear', '我比较怕冷'),
  fact('fear-07', 'fear', '我有点害怕蟑螂'),
  fact('fear-08', 'fear', '我特别怕迟到'),
]

const likeCases: MemoryBenchmarkCase[] = [
  preference('like-01', 'like', '我喜欢喝美式咖啡'),
  preference('like-02', 'like', '我很喜欢用深色主题'),
  preference('like-03', 'like', '我比较喜欢早上处理邮件'),
  preference('like-04', 'like', '我最喜欢重庆小面'),
  preference('like-05', 'like', '我爱看科幻电影'),
  preference('like-06', 'like', '我偏好简洁的界面'),
  preference('like-07', 'like', '我更偏好先看数据再下结论'),
  preference('like-08', 'like', '我喜欢把周报写成一页纸'),
  preference('like-09', 'like', '我很喜欢在安静环境里工作'),
  preference('like-10', 'like', '我喜欢用表格整理需求'),
  // 否定偏好同样是长期偏好，当前规则会让这两条漏写。
  preference('like-11', 'like', '我不喜欢加班'),
  preference('like-12', 'like', '我不太喜欢在周末处理工作'),
]

const habitCases: MemoryBenchmarkCase[] = [
  fact('habit-01', 'habit', '我通常早上七点起床'),
  fact('habit-02', 'habit', '我一般先看邮件再开始工作'),
  fact('habit-03', 'habit', '我习惯把会议纪要当天发出'),
  fact('habit-04', 'habit', '我平时用 VS Code 写前端'),
  fact('habit-05', 'habit', '我通常周五下午整理周报'),
  fact('habit-06', 'habit', '我一般提前十分钟到会议室'),
  fact('habit-07', 'habit', '我习惯在文档里先写结论'),
  fact('habit-08', 'habit', '我平时把任务拆成三步'),
  fact('habit-09', 'habit', '我通常先复现问题再改代码'),
  fact('habit-10', 'habit', '我一般每周一同步项目进度'),
  // “更习惯”是稳定习惯，但当前规则只认“通常/一般/习惯/平时”，会漏写。
  fact('habit-11', 'habit', '我更习惯先写测试再改代码'),
  fact('habit-12', 'habit', '我习惯用中文写内部文档'),
]

const possessionCases: MemoryBenchmarkCase[] = [
  fact('possession-01', 'possession', '我的工位是A12'),
  fact('possession-02', 'possession', '我的常用项目叫EAB'),
  fact('possession-03', 'possession', '我的部门是产品部'),
  fact('possession-04', 'possession', '我的电脑是ThinkPad'),
  fact('possession-05', 'possession', '我的开发环境是Windows'),
  fact('possession-06', 'possession', '我的汇报模板叫一页纸'),
  fact('possession-07', 'possession', '我的主要职责是接口开发'),
  fact('possession-08', 'possession', '我的工作语言是中文'),
  fact('possession-09', 'possession', '我的座位是12楼08号'),
  fact('possession-10', 'possession', '我的团队叫智能体组'),
]

const futurePreferenceCases: MemoryBenchmarkCase[] = [
  preference('future-01', 'future-preference', '以后都用一页纸格式回复'),
  preference('future-02', 'future-preference', '以后都按先结论后细节的结构写周报'),
  preference('future-03', 'future-preference', '今后请用中文回复'),
  preference('future-04', 'future-preference', '以后都按表格输出需求清单'),
  preference('future-05', 'future-preference', '今后统一用飞书文档汇报'),
  preference('future-06', 'future-preference', '以后都照一页纸模板排版'),
  preference('future-07', 'future-preference', '以后都用要点列表写会议纪要'),
  preference('future-08', 'future-preference', '今后请按三段式结构写方案'),
  preference('future-09', 'future-preference', '以后统一用中文写邮件'),
  preference('future-10', 'future-preference', '今后都用简洁格式输出'),
]

const nonMemoryCases: MemoryBenchmarkCase[] = [
  ignore('non-01', 'non-memory', '今天重庆天气怎么样'),
  ignore('non-02', 'non-memory', '帮我订明天下午三点的会议室'),
  ignore('non-03', 'non-memory', '把周报改成三页'),
  ignore('non-04', 'non-memory', '现在几点了'),
  ignore('non-05', 'non-memory', '你好'),
  ignore('non-06', 'non-memory', '谢谢'),
  ignore('non-07', 'non-memory', '我下周去重庆出差'),
  ignore('non-08', 'non-memory', '我今天很累'),
  ignore('non-09', 'non-memory', '我现在在开会'),
  ignore('non-10', 'non-memory', '这个报错怎么解决'),
  ignore('non-11', 'non-memory', '帮我总结一下这份文档'),
  ignore('non-12', 'non-memory', '明天提醒我交周报'),
  ignore('non-13', 'non-memory', '这台打印机驱动装不上'),
  ignore('non-14', 'non-memory', '把附件发给我'),
  ignore('non-15', 'non-memory', '下周项目评审谁来参加'),
  ignore('non-16', 'non-memory', '他喜欢喝咖啡'),
  ignore('non-17', 'non-memory', '同事说他怕狗'),
  ignore('non-18', 'non-memory', '我朋友叫小李'),
  ignore('non-19', 'non-memory', '我们公司叫EAB'),
  ignore('non-20', 'non-memory', '团队通常周一开例会'),
  ignore('non-21', 'non-memory', '我的文件放在哪里'),
  ignore('non-22', 'non-memory', '我昨天加班到十点'),
  ignore('non-23', 'non-memory', '我现在有点困'),
  // 以下四条是转述陷阱：不是用户自己的稳定事实，规则抽取目前会误命中。
  ignore('quote-01', 'quote-trap', '我同事说我怕狗'),
  ignore('quote-02', 'quote-trap', '客户说我习惯每周复盘'),
  ignore('quote-03', 'quote-trap', '老板说我喜欢加班'),
  ignore('quote-04', 'quote-trap', '我在会上说我平时先看数据'),
  ignore('non-25', 'non-memory', '把会议纪要发到群里'),
  ignore('non-26', 'non-memory', '这份合同金额是多少'),
  ignore('non-27', 'non-memory', '我明天请假一天'),
]

const sensitiveCases: MemoryBenchmarkCase[] = [
  sensitive('sensitive-01', 'sensitive', '我的手机号是13800138000'),
  sensitive('sensitive-02', 'sensitive', '我的邮箱是hewei@example.com'),
  sensitive('sensitive-03', 'sensitive', '密码是abc12345'),
  sensitive('sensitive-04', 'sensitive', '我的身份证号是500101199001011234'),
  sensitive('sensitive-05', 'sensitive', '银行卡号是6222020200000000000'),
  sensitive('sensitive-06', 'sensitive', 'token 是 sk-test-123456'),
  sensitive('sensitive-07', 'sensitive', 'api key 是 abcd1234'),
  sensitive('sensitive-08', 'sensitive', '私钥放在这个文件里'),
  sensitive('sensitive-09', 'sensitive', '验证码是 482913'),
  sensitive('sensitive-10', 'sensitive', '客户手机号是13900001111'),
]

export const MEMORY_BENCHMARK_CASES: readonly MemoryBenchmarkCase[] = [
  ...identityCases,
  ...fearCases,
  ...likeCases,
  ...habitCases,
  ...possessionCases,
  ...futurePreferenceCases,
  ...nonMemoryCases,
  ...sensitiveCases,
]

function rate(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0
}

/** 纯函数评估；测试可传入自己的小数据集，不接触数据库。 */
export function evaluateMemoryBenchmarkCases(cases: readonly MemoryBenchmarkCase[]): MemoryBenchmarkReport {
  let expectedExtract = 0
  let expectedIgnore = 0
  let sensitiveCases = 0
  let extractedHits = 0
  let missed = 0
  let unexpected = 0
  let sensitiveLeaks = 0
  const failures: MemoryBenchmarkFailure[] = []

  for (const testCase of cases) {
    const candidates = testCase.expected.action === 'sensitive'
      ? []
      : extractMemoryCandidatesByRules(testCase.text)
    const actualTypes = candidates.map((candidate) => candidate.memoryType)

    if (testCase.expected.action === 'extract') {
      expectedExtract += 1
      if (actualTypes.includes(testCase.expected.memoryType)) {
        extractedHits += 1
      } else {
        missed += 1
        failures.push({
          caseId: testCase.id,
          category: testCase.category,
          kind: 'missed',
          expectedType: testCase.expected.memoryType,
          actualTypes,
        })
      }
      continue
    }

    if (testCase.expected.action === 'ignore') {
      expectedIgnore += 1
      if (candidates.length > 0) {
        unexpected += 1
        failures.push({
          caseId: testCase.id,
          category: testCase.category,
          kind: 'unexpected',
          actualTypes,
        })
      }
      continue
    }

    sensitiveCases += 1
    if (!memoryLooksSensitive(testCase.text)) {
      sensitiveLeaks += 1
      failures.push({
        caseId: testCase.id,
        category: testCase.category,
        kind: 'sensitive_leak',
        actualTypes,
      })
    }
  }

  const total = cases.length
  const failed = missed + unexpected + sensitiveLeaks
  return {
    version: MEMORY_BENCHMARK_VERSION,
    total,
    passed: Math.max(0, total - failed),
    expectedExtract,
    extractedHits,
    missed,
    expectedIgnore,
    unexpected,
    sensitiveCases,
    sensitiveLeaks,
    hitRate: rate(extractedHits, expectedExtract),
    missRate: rate(missed, expectedExtract),
    miswriteRate: rate(unexpected, expectedIgnore),
    passRate: rate(Math.max(0, total - failed), total),
    failures,
  }
}

/**
 * 100 轮针事实召回探针：第 1 轮写入一条高置信事实，之后累积 99 条项目噪声，
 * 在第 100 轮问“我的工号是多少？”时检查它是否仍进入最多 4 条的上下文窗口。
 * 这里只验证存储与选择策略，不调用模型，也不写真实记忆库。
 */
export function evaluateMemoryRetentionProbe(now = Date.now()): MemoryRetentionResult {
  const needle: LongTermMemoryLike = {
    id: 'retention-needle',
    content: '我的工号是 EAB-9527。',
    memoryType: 'fact',
    scopeType: 'user',
    importance: 0.9,
    createdAt: now - MEMORY_RETENTION_ROUNDS * 86_400_000,
  }
  const topics = [
    '需求评审', '接口联调', '周报模板', '测试用例', '发布窗口', '客户培训', '采购比价',
    '合同归档', '权限申请', '会议纪要', '供应商对账', '数据清洗', '告警规则', '网络巡检',
    '设备盘点', '值班安排', '版本回滚', '知识库目录', '培训材料', '报销流程',
    '项目排期', '接口文档', '监控看板', '安全扫描', '日志归档', '备份校验',
    '账号开通', '会议室预约', '差旅申请', '质量复盘', '上线检查', '工单分派', '验收清单',
  ]
  const suffixes = ['，会上确认由项目组跟进。', '，会后更新到项目文档。', '，结论是沿用现有流程。']
  const noise: LongTermMemoryLike[] = []
  for (const [topicIndex, topic] of topics.entries()) {
    for (const [suffixIndex, suffix] of suffixes.entries()) {
      const round = noise.length + 2
      noise.push({
        id: `retention-noise-${noise.length + 1}`,
        content: `第 ${round} 轮讨论了${topic}${suffix}`,
        memoryType: 'episode',
        scopeType: 'user',
        importance: 0.35 + ((topicIndex + suffixIndex) % 3) * 0.05,
        createdAt: now - (MEMORY_RETENTION_ROUNDS - round) * 86_400_000,
      })
    }
  }
  const query = '我的工号是多少？'
  const selected = selectRelevantLongTermMemoriesDetailed([needle, ...noise], query, {
    limit: 4,
    now,
  })
  const needleIndex = selected.findIndex((item) => item.memory.id === needle.id)
  return {
    rounds: MEMORY_RETENTION_ROUNDS,
    query,
    limit: 4,
    recalled: needleIndex >= 0,
    rank: needleIndex >= 0 ? needleIndex + 1 : null,
  }
}

export function memoryBenchmarkDataset(): {
  version: string
  total: number
  expectedExtract: number
  expectedIgnore: number
  sensitive: number
  retentionRounds: number
} {
  return {
    version: MEMORY_BENCHMARK_VERSION,
    total: MEMORY_BENCHMARK_CASES.length,
    expectedExtract: MEMORY_BENCHMARK_CASES.filter((item) => item.expected.action === 'extract').length,
    expectedIgnore: MEMORY_BENCHMARK_CASES.filter((item) => item.expected.action === 'ignore').length,
    sensitive: MEMORY_BENCHMARK_CASES.filter((item) => item.expected.action === 'sensitive').length,
    retentionRounds: MEMORY_RETENTION_ROUNDS,
  }
}

export interface MemoryBenchmarkRun extends MemoryBenchmarkReport {
  readonly id: string
  readonly userId: string
  readonly retention: MemoryRetentionResult
  readonly durationMs: number
  readonly createdAt: number
}

/** 运行固定基准并持久化。只写评测计数，不把合成用例原文写进库。 */
export function runMemoryBenchmark(
  db: Db,
  input: { companyId: string; userId: string },
): MemoryBenchmarkRun {
  const startedAt = Date.now()
  const report = evaluateMemoryBenchmarkCases(MEMORY_BENCHMARK_CASES)
  const retention = evaluateMemoryRetentionProbe()
  const id = `mbr_${randomUUID()}`
  const durationMs = Math.max(0, Date.now() - startedAt)
  const createdAt = Date.now()
  const failureJson = JSON.stringify(report.failures.map((failure) => ({
    caseId: failure.caseId,
    category: failure.category,
    kind: failure.kind,
    expectedType: failure.expectedType ?? null,
    actualTypes: failure.actualTypes,
  })))
  db.prepare(
    `INSERT INTO memory_benchmark_runs (
       id, company_id, user_id, dataset_version, total_cases, passed, expected_extract,
       extracted_hits, missed, expected_ignore, unexpected, sensitive_cases, sensitive_leaks,
       hit_rate, miss_rate, miswrite_rate, pass_rate, retention_rounds, retention_hit,
       retention_rank, duration_ms, failure_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.companyId,
    input.userId,
    report.version,
    report.total,
    report.passed,
    report.expectedExtract,
    report.extractedHits,
    report.missed,
    report.expectedIgnore,
    report.unexpected,
    report.sensitiveCases,
    report.sensitiveLeaks,
    report.hitRate,
    report.missRate,
    report.miswriteRate,
    report.passRate,
    retention.rounds,
    retention.recalled ? 1 : 0,
    retention.rank,
    durationMs,
    failureJson,
    createdAt,
  )
  return { ...report, retention, id, userId: input.userId, durationMs, createdAt }
}

export interface StoredMemoryBenchmarkRun {
  readonly id: string
  readonly datasetVersion: string
  readonly total: number
  readonly passed: number
  readonly expectedExtract: number
  readonly extractedHits: number
  readonly missed: number
  readonly expectedIgnore: number
  readonly unexpected: number
  readonly sensitiveCases: number
  readonly sensitiveLeaks: number
  readonly hitRate: number
  readonly missRate: number
  readonly miswriteRate: number
  readonly passRate: number
  readonly retention: MemoryRetentionResult
  readonly durationMs: number
  readonly failures: readonly MemoryBenchmarkFailure[]
  readonly createdAt: string
  readonly stale: boolean
}

export function lastMemoryBenchmarkRun(db: Db, companyId: string): StoredMemoryBenchmarkRun | null {
  const row = db
    .prepare(
      `SELECT id, dataset_version, total_cases, passed, expected_extract, extracted_hits,
              missed, expected_ignore, unexpected, sensitive_cases, sensitive_leaks,
              hit_rate, miss_rate, miswrite_rate, pass_rate, retention_rounds, retention_hit,
              retention_rank, duration_ms, failure_json, created_at
         FROM memory_benchmark_runs
        WHERE company_id = ?
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(companyId) as unknown as {
    id: string
    dataset_version: string
    total_cases: number
    passed: number
    expected_extract: number
    extracted_hits: number
    missed: number
    expected_ignore: number
    unexpected: number
    sensitive_cases: number
    sensitive_leaks: number
    hit_rate: number
    miss_rate: number
    miswrite_rate: number
    pass_rate: number
    retention_rounds: number
    retention_hit: number
    retention_rank: number | null
    duration_ms: number
    failure_json: string | null
    created_at: number
  } | undefined
  if (!row) return null
  let failures: MemoryBenchmarkFailure[] = []
  try {
    const parsed = JSON.parse(row.failure_json || '[]') as unknown
    if (Array.isArray(parsed)) {
      failures = parsed
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          caseId: String(item.caseId ?? ''),
          category: String(item.category ?? 'non-memory') as MemoryBenchmarkCategory,
          kind: String(item.kind ?? 'missed') as MemoryBenchmarkFailureKind,
          expectedType: item.expectedType ? String(item.expectedType) as MemoryType : undefined,
          actualTypes: Array.isArray(item.actualTypes)
            ? item.actualTypes.map((value) => String(value) as MemoryType)
            : [],
        }))
        .filter((item) => item.caseId)
    }
  } catch {
    failures = []
  }
  return {
    id: row.id,
    datasetVersion: row.dataset_version,
    total: row.total_cases,
    passed: row.passed,
    expectedExtract: row.expected_extract,
    extractedHits: row.extracted_hits,
    missed: row.missed,
    expectedIgnore: row.expected_ignore,
    unexpected: row.unexpected,
    sensitiveCases: row.sensitive_cases,
    sensitiveLeaks: row.sensitive_leaks,
    hitRate: row.hit_rate,
    missRate: row.miss_rate,
    miswriteRate: row.miswrite_rate,
    passRate: row.pass_rate,
    retention: {
      rounds: row.retention_rounds,
      query: '我的工号是多少？',
      limit: 4,
      recalled: row.retention_hit === 1,
      rank: row.retention_rank,
    },
    durationMs: row.duration_ms,
    failures,
    createdAt: new Date(row.created_at).toISOString(),
    stale: row.dataset_version !== MEMORY_BENCHMARK_VERSION,
  }
}
