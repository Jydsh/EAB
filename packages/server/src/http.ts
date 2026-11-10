/** 路由层共用的小工具：成功信封、scope 前置校验、读版本号。 */
import { readFileSync } from 'node:fs'
import { EC, EabError, scopeAllows, SCOPE_REGISTRY, type Scope, type Subject } from '@eab/domain'

export interface OkEnvelope<T> {
  readonly ok: true
  readonly data: T
}

export function ok<T>(data: T): OkEnvelope<T> {
  return { ok: true, data }
}

/** 功能权限前置校验：没有就直接 403，别让业务代码带着无权的主体往下跑 */
export function requireScope(subject: Subject, action: Scope): void {
  if (!scopeAllows(subject.scopes, action)) {
    throw new EabError(EC.FORBIDDEN, `当前身份缺少权限：${SCOPE_REGISTRY[action].label}（${action}）`, {
      hint: '换一个具备该权限的身份，或让管理员在「角色」里授权',
      details: { requiredScope: action },
    })
  }
}

export function capabilityList(subject: Subject): Array<{ scope: string; label: string; group: string }> {
  return [...subject.scopes]
    .sort()
    .map((scope) => ({
      scope,
      label: SCOPE_REGISTRY[scope].label,
      group: SCOPE_REGISTRY[scope].group,
    }))
}

let cachedVersion: string | undefined

/** 版本号从根 package.json 读，避免两处手写不一致；桌面端用 EAB_VERSION 注入。 */
export function readVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion
  const injected = (process.env.EAB_VERSION ?? '').trim()
  if (injected) {
    cachedVersion = injected
    return cachedVersion
  }
  try {
    const raw = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
    cachedVersion = (JSON.parse(raw) as { version: string }).version
  } catch {
    cachedVersion = '0.0.0'
  }
  return cachedVersion
}
