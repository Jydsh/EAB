/**
 * Subject 构造：把"已验证的用户 + 角色 + 部门"翻译成鉴权用的主体。
 *
 * 安全不变量（必须遵守）：
 * 1. 入参只来自「已验证会话」或「渠道签名事件 + 绑定表」，禁止从请求体拼装。
 * 2. 部门物化路径必须属于该用户所在公司，否则直接报错（防跨公司串号）。
 * 3. 未知角色码被忽略而不是报错：脏数据不应该把人锁死在门外。
 */
import {
  EC,
  EabError,
  deptChainOf,
  normalizeDeptPath,
  type ChannelType,
  type DataScope,
  type Scope,
  type Subject,
  type UserStatus,
} from '@eab/domain'
import { dataScopeOfRoles, scopesOfRoles, type RoleLookup, DEFAULT_ROLE_LOOKUP } from './roles.js'
import { expandScopes } from '@eab/domain'

export interface BuildSubjectInput {
  readonly userId: string
  readonly companyId: string
  readonly deptId: string
  /** 物化路径，形如 `/c1/d10/d23/` */
  readonly deptPath: string
  readonly roles: readonly string[]
  readonly channelType?: ChannelType
  readonly status?: UserStatus
  readonly projectIds?: readonly string[]
  /** 临时授权/例外（如 AUTHZ 的 allow override） */
  readonly extraScopes?: readonly Scope[]
  /** 显式拒绝（deny override 优先于角色授权） */
  readonly deniedScopes?: readonly Scope[]
  readonly dataScopeOverride?: DataScope
  readonly roleLookup?: RoleLookup
}

function assertId(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EabError(EC.VALIDATION, `缺少必要身份字段: ${name}`, { details: { field: name } })
  }
}

export function buildSubject(input: BuildSubjectInput): Subject {
  assertId(input.userId, 'userId')
  assertId(input.companyId, 'companyId')
  assertId(input.deptId, 'deptId')

  const deptPath = normalizeDeptPath(input.deptPath)
  if (!deptPath.startsWith(`/${input.companyId}/`)) {
    throw new EabError(EC.VALIDATION, '部门路径与公司不匹配', {
      details: { companyId: input.companyId, deptPath },
    })
  }

  const lookup = input.roleLookup ?? DEFAULT_ROLE_LOOKUP
  const denied = new Set<Scope>(input.deniedScopes ?? [])
  const roleScopes = [...scopesOfRoles(input.roles, lookup)].filter((scope) => !denied.has(scope))
  const granted: Scope[] = [...roleScopes, ...(input.extraScopes ?? []).filter((scope) => !denied.has(scope))]
  const scopes = new Set([...expandScopes(granted)].filter((scope) => !denied.has(scope)))

  const dataScope = input.dataScopeOverride ?? dataScopeOfRoles(input.roles, lookup)

  return Object.freeze({
    userId: input.userId,
    companyId: input.companyId,
    deptId: input.deptId,
    deptPath,
    deptChain: Object.freeze(deptChainOf(deptPath)),
    roles: Object.freeze([...input.roles]),
    scopes,
    dataScope,
    channelType: input.channelType ?? 'web',
    status: input.status ?? 'active',
    projectIds: Object.freeze([...(input.projectIds ?? [])]),
  }) satisfies Subject
}
