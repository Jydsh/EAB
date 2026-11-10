/**
 * 部门物化路径（ABAC 的范围判断基础）。
 *
 * 格式：`/c1/d10/d23/`，第一段是公司，其后是部门层级，首尾都有斜杠。
 * 为什么用物化路径：范围判断变成一次前缀比较 / 一次 IN 查询，
 * 不需要递归 CTE；移动部门时批量更新子树 path 即可。
 */
import { EC, EabError } from './errors.js'

function assertSegment(segment: string, what: string): void {
  if (segment.length === 0) {
    throw new EabError(EC.VALIDATION, `${what}不能为空段`, { details: { segment } })
  }
  if (segment.includes('/') || segment.includes('\\')) {
    throw new EabError(EC.VALIDATION, `${what}不能包含路径分隔符`, { details: { segment } })
  }
}

export function buildDeptPath(companyId: string, deptIds: readonly string[]): string {
  assertSegment(companyId, 'companyId')
  for (const id of deptIds) assertSegment(id, 'deptId')
  return `/${[companyId, ...deptIds].join('/')}/`
}

/** `/c1/d10/d23/` → `['/c1/', '/c1/d10/', '/c1/d10/d23/']`（含自身） */
export function deptChainOf(path: string): string[] {
  const normalized = normalizeDeptPath(path)
  const segments = normalized.split('/').filter((s) => s.length > 0)
  const chain: string[] = []
  let acc = ''
  for (const segment of segments) {
    acc += `/${segment}`
    chain.push(`${acc}/`)
  }
  return chain
}

export function normalizeDeptPath(path: string): string {
  const trimmed = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (trimmed.length === 0) {
    throw new EabError(EC.VALIDATION, '部门路径不能为空')
  }
  if (trimmed.split('/').some((s) => s.length === 0)) {
    throw new EabError(EC.VALIDATION, '部门路径包含空段', { details: { path } })
  }
  return `/${trimmed}/`
}

/** candidate 是否在 ancestor 之下（含相等） */
export function isPathWithin(candidate: string, ancestor: string): boolean {
  const c = normalizeDeptPath(candidate)
  const a = normalizeDeptPath(ancestor)
  return c === a || c.startsWith(a)
}
