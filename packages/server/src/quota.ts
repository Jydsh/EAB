/**
 * 月度额度判定（公司 / 部门 / 成员三级）。
 *
 * 设计口径：
 * 1. 额度与用量分开存：额度在 `usage_quotas`，用量统一从 `usage_daily` 聚合，避免两份数据打架；
 * 2. 部门用量按成员的 `dept_path` 前缀聚合（含下级部门），与组织树「N 人」同一口径；
 * 3. 判定顺序「成员 → 部门 → 公司」，任一硬额度用尽即拒绝，报错里说清是哪一级、用掉多少、上限多少；
 * 4. `soft` 模式只记录不拦截，留给后续告警与运营观察。
 */
import { EC, EabError } from '@eab/domain'
import type { Db } from '@eab/storage'

export type QuotaScopeType = 'company' | 'dept' | 'user'

export interface QuotaLimits {
  readonly requests: number | null
  readonly tokens: number | null
  readonly mode: 'hard' | 'soft'
  readonly enabled: boolean
}

export interface UsageTotals {
  readonly requests: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
}

export interface UserUsageRow {
  readonly userId: string
  readonly deptPath: string | null
  readonly requests: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
}

const ZERO: UsageTotals = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }

/** 当前月份（UTC，YYYY-MM），与 usage_daily.day 的口径一致 */
export function monthNow(now = new Date()): string {
  return now.toISOString().slice(0, 7)
}

export function isMonth(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value)
}

export function isQuotaScopeType(value: string): value is QuotaScopeType {
  return value === 'company' || value === 'dept' || value === 'user'
}

function rawUserUsageRows(db: Db, companyId: string, month: string): UserUsageRow[] {
  const rows = db
    .prepare(
      `SELECT u.user_id, us.dept_path, SUM(u.requests) AS requests,
              SUM(u.prompt_tokens) AS prompt_tokens, SUM(u.completion_tokens) AS completion_tokens
         FROM usage_daily u
         LEFT JOIN users us ON us.id = u.user_id
        WHERE u.company_id = ? AND u.day LIKE ?
        GROUP BY u.user_id`,
    )
    .all(companyId, `${month}%`) as unknown as Array<{
    user_id: string
    dept_path: string | null
    requests: number
    prompt_tokens: number
    completion_tokens: number
  }>
  return rows.map((row) => {
    const promptTokens = Number(row.prompt_tokens ?? 0)
    const completionTokens = Number(row.completion_tokens ?? 0)
    return {
      userId: row.user_id,
      deptPath: row.dept_path,
      requests: Number(row.requests ?? 0),
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    }
  })
}

/** 按月按成员聚合的用量，控制台的额度页要一次性拿到整张表 */
export function usageRowsForMonth(db: Db, companyId: string, month: string): UserUsageRow[] {
  return rawUserUsageRows(db, companyId, month)
}

function sumRows(rows: UserUsageRow[]): UsageTotals {
  const acc = rows.reduce(
    (state, row) => ({
      requests: state.requests + row.requests,
      promptTokens: state.promptTokens + row.promptTokens,
      completionTokens: state.completionTokens + row.completionTokens,
    }),
    { requests: 0, promptTokens: 0, completionTokens: 0 },
  )
  return { ...acc, totalTokens: acc.promptTokens + acc.completionTokens }
}

function deptPrefix(deptPath: string): string {
  return deptPath.endsWith('/') ? deptPath : `${deptPath}/`
}

/**
 * 某 scope 在某月的用量。
 * - company：全公司；
 * - dept：按 deptPath 前缀（含下级）；
 * - user：本人。
 */
export function scopeUsage(
  db: Db,
  input: {
    companyId: string
    month: string
    scopeType: QuotaScopeType
    scopeId: string
    deptPath?: string | null
  },
): UsageTotals {
  const rows = rawUserUsageRows(db, input.companyId, input.month)
  if (input.scopeType === 'company') return sumRows(rows)
  if (input.scopeType === 'user') {
    return sumRows(rows.filter((row) => row.userId === input.scopeId))
  }
  const prefix = deptPrefix(input.deptPath || '')
  if (!prefix.startsWith('/')) return ZERO
  return sumRows(rows.filter((row) => (row.deptPath || '').startsWith(prefix)))
}

export function loadQuota(
  db: Db,
  companyId: string,
  scopeType: QuotaScopeType,
  scopeId: string,
): QuotaLimits | null {
  const row = db
    .prepare(
      `SELECT monthly_requests, monthly_tokens, mode, enabled
         FROM usage_quotas
        WHERE company_id = ? AND scope_type = ? AND scope_id = ?`,
    )
    .get(companyId, scopeType, scopeId) as
    | { monthly_requests: number | null; monthly_tokens: number | null; mode: string; enabled: number }
    | undefined
  if (!row) return null
  return {
    requests: row.monthly_requests === null ? null : Number(row.monthly_requests),
    tokens: row.monthly_tokens === null ? null : Number(row.monthly_tokens),
    mode: row.mode === 'soft' ? 'soft' : 'hard',
    enabled: Number(row.enabled) === 1,
  }
}

export function loadCompanyQuotas(db: Db, companyId: string): Map<string, QuotaLimits> {
  const rows = db
    .prepare(
      `SELECT scope_type, scope_id, monthly_requests, monthly_tokens, mode, enabled
         FROM usage_quotas WHERE company_id = ?`,
    )
    .all(companyId) as unknown as Array<{
    scope_type: string
    scope_id: string
    monthly_requests: number | null
    monthly_tokens: number | null
    mode: string
    enabled: number
  }>
  const map = new Map<string, QuotaLimits>()
  for (const row of rows) {
    map.set(`${row.scope_type}:${row.scope_id}`, {
      requests: row.monthly_requests === null ? null : Number(row.monthly_requests),
      tokens: row.monthly_tokens === null ? null : Number(row.monthly_tokens),
      mode: row.mode === 'soft' ? 'soft' : 'hard',
      enabled: Number(row.enabled) === 1,
    })
  }
  return map
}

const SCOPE_LABEL: Record<QuotaScopeType, string> = {
  company: '公司',
  dept: '部门',
  user: '成员',
}

/**
 * 对话前的额度闸：
 * 成员 / 部门 / 公司逐级检查，硬额度用尽抛 EAB_QUOTA_EXCEEDED（429）。
 * 只统计已落库的用量，所以「本次请求」不会提前计入，边界是「用满后下一次被拒」。
 */
export function assertChatQuota(
  db: Db,
  input: {
    companyId: string
    userId: string
    deptId: string
    deptPath: string
    month?: string
  },
): void {
  const month = input.month ?? monthNow()
  /**
   * 部门额度按「含下级」的口径生效，所以要沿 dept_path 把每一级部门都查一遍：
   * 只查本人所在部门，上级部门的额度就永远拦不住下级部门的人。
   */
  const segments = input.deptPath.split('/').filter(Boolean)
  const deptChecks: Array<{ scopeId: string; deptPath: string; name: string }> = []
  for (let index = 1; index < segments.length; index += 1) {
    const deptId = segments[index] as string
    const deptPath = `/${segments.slice(0, index + 1).join('/')}/`
    const row = db
      .prepare('SELECT name FROM departments WHERE id = ? AND company_id = ?')
      .get(deptId, input.companyId) as { name: string } | undefined
    deptChecks.push({ scopeId: deptId, deptPath, name: row?.name ?? deptId })
  }

  const checks: Array<{
    scopeType: QuotaScopeType
    scopeId: string
    deptPath: string | null
    label?: string
  }> = [
    { scopeType: 'user', scopeId: input.userId, deptPath: input.deptPath },
    // 先查最近的一级部门，报错更贴近用户（"研发部额度用完"比"公司额度用完"更有用）
    ...deptChecks.reverse().map((item) => ({
      scopeType: 'dept' as const,
      scopeId: item.scopeId,
      deptPath: item.deptPath,
      label: item.name,
    })),
    { scopeType: 'company', scopeId: input.companyId, deptPath: null },
  ]

  for (const check of checks) {
    const quota = loadQuota(db, input.companyId, check.scopeType, check.scopeId)
    if (!quota || !quota.enabled || quota.mode !== 'hard') continue
    if (quota.requests === null && quota.tokens === null) continue
    const used = scopeUsage(db, {
      companyId: input.companyId,
      month,
      scopeType: check.scopeType,
      scopeId: check.scopeId,
      deptPath: check.deptPath,
    })
    const label = check.label ? `部门「${check.label}」` : SCOPE_LABEL[check.scopeType]
    if (quota.requests !== null && used.requests >= quota.requests) {
      throw new EabError(
        EC.QUOTA_EXCEEDED,
        `${label}本月对话额度已用完（${used.requests}/${quota.requests} 次）`,
        {
          hint: '联系管理员在控制台「运营与审计 → 额度」里调整上限，或下个月再试',
          details: {
            scopeType: check.scopeType,
            scopeId: check.scopeId,
            month,
            metric: 'requests',
            used: used.requests,
            limit: quota.requests,
          },
        },
      )
    }
    if (quota.tokens !== null && used.totalTokens >= quota.tokens) {
      throw new EabError(
        EC.QUOTA_EXCEEDED,
        `${label}本月 token 额度已用完（${used.totalTokens}/${quota.tokens}）`,
        {
          hint: '联系管理员在控制台「运营与审计 → 额度」里调整上限，或下个月再试',
          details: {
            scopeType: check.scopeType,
            scopeId: check.scopeId,
            month,
            metric: 'tokens',
            used: used.totalTokens,
            limit: quota.tokens,
          },
        },
      )
    }
  }
}
