/**
 * 成员后台接口守卫（Fastify onRequest hook）。
 *
 * 只对“成员后台会话”生效；平台超管和服务令牌直接放行，保持原有的最高权限。
 */
import type { FastifyRequest } from 'fastify'
import { EC, EabError } from '@eab/domain'
import type { ServerDeps } from './deps.js'
import { memberSessionFromRequest, sessionFromRequest } from './console-auth.js'
import { readConsoleMemberSession } from './console-member-session.js'
import { consoleActionsByPage, readConsolePagePermissions, type ConsolePagePermission } from './console-permissions.js'
import { consoleApiActionLabel, consoleApiRuleFor, ruleAllowsPage, type ConsoleApiAction } from './console-api-access.js'
import {
  consolePermissionLabel,
  type ConsolePageKey,
} from './console-pages.js'

function pageLabel(page: ConsolePageKey, section?: string): string {
  return consolePermissionLabel(page, section)
}

function forbidden(message: string, details?: Record<string, unknown>): EabError {
  return new EabError(EC.FORBIDDEN, message, {
    hint: '让平台管理员或有权限的成员在「成员管理 → 后台访问」里给对应页面勾选所需的可见、新增、编辑或删除。',
    details,
  })
}

export function enforceConsoleMemberAccess(req: FastifyRequest, deps: ServerDeps): void {
  if (req.headers['x-eab-console'] !== '1') return
  const path = String(req.url ?? '').split('?')[0] ?? ''
  if (!path.startsWith('/api/console/')) return

  // 平台超管会话 / 服务令牌：不受页面权限限制。
  if (sessionFromRequest(req)) return
  if (!memberSessionFromRequest(req)) {
    // 纯服务令牌不是成员会话，直接放行；没有会话的请求交给路由返回 401。
    return
  }
  const member = readConsoleMemberSession(deps.db, req)
  if (!member) {
    throw new EabError(EC.AUTH_REQUIRED, '成员后台会话已失效，请重新登录管理后台', {
      hint: '成员被停用、离职或会话被吊销后，下一条请求就会失效。',
    })
  }

  const rule = consoleApiRuleFor(req.method, path)
  if (!rule) return
  if (rule.platformOnly) {
    throw forbidden('该操作只允许服务器平台管理员执行', {
      path,
      required: 'platform_admin',
    })
  }
  if (rule.pages.length === 0) {
    throw forbidden('该接口还没有配置成员页面权限，已按最小权限原则拒绝', { path })
  }

  const permissions = readConsolePagePermissions(deps.db, member.companyId, member.userId)
  const sectionConfigured = new Set(
    [...permissions.values()].filter((item) => item.section).map((item) => item.parentPage),
  )
  const allows = (permission: ConsolePagePermission, action: ConsoleApiAction): boolean => {
    switch (action) {
      case 'view':
        return permission.canView
      case 'create':
        return permission.canCreate
      case 'edit':
        return permission.canEdit
      case 'delete':
        return permission.canDelete
    }
  }
  const allowed = (page: ConsolePageKey, action: ConsoleApiAction, section?: string): boolean => {
    if (section) {
      const permission = permissions.get(`${page}:${section}`)
      if (permission) return allows(permission, action)
      // 旧数据只有整页权限，没有分区记录时按整页权限兼容；一旦配置了任一分区，
      // 未配置的分区不再继承整页写权限，避免父页面动作重新放大。
      if (!sectionConfigured.has(page)) {
        const parent = permissions.get(page)
        return parent ? allows(parent, action) : false
      }
      return false
    }
    const permission = permissions.get(page)
    if (permission) return allows(permission, action)
    // 只有分区记录、没有父页面记录时，按该页任一分区聚合。
    return [...permissions.values()].some((item) => item.parentPage === page && allows(item, action))
  }
  if (!ruleAllowsPage(rule, allowed)) {
    const required = rule.actions.map((action) => consoleApiActionLabel(action)).join('、')
    const requiredSections = rule.section
      ? [rule.section]
      : rule.sections
        ? [...rule.sections]
        : rule.sectionPages
          ? Object.entries(rule.sectionPages).flatMap(([page, sections]) =>
              (sections ?? []).map((section) => `${page}:${section}`))
          : []
    throw forbidden(`当前后台账号没有该页面的${required}权限：${rule.pages.map((page) => pageLabel(page, rule.section)).join('、')}`, {
      path,
      requiredActions: rule.actions,
      requiredPages: rule.pages,
      requiredSections,
      allowedPages: [...permissions.values()].filter((item) => item.canView).map((item) => item.page),
      actionsByPage: consoleActionsByPage(permissions),
    })
  }
}
