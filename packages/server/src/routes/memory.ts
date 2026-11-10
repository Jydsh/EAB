/**
 * 记忆分层（CHAT-09）：session / user / dept / company 四层，写入先落"待确认"。
 *
 * 规则：
 * - 只有用户本人确认过的记忆才会进入对话上下文，模型不能静默写长期记忆；
 * - dept / company 层需要 memory:admin，普通成员只能写自己的 user 层；
 * - 查询永远按当前身份过滤，不返回别人私有的记忆。
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { EC, EabError, SC, scopeAllows } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok } from '../http.js'
import { resolveActor } from '../session.js'

type ScopeType = 'user' | 'dept' | 'company'

export function registerMemoryRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/memories', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    if (!scopeAllows(actor.subject.scopes, SC.MEMORY_READ)) {
      throw new EabError(EC.FORBIDDEN, '当前身份缺少权限：读取记忆（memory:read）', {
        details: { requiredScope: SC.MEMORY_READ },
      })
    }
    const rows = deps.db
      .prepare(
        `SELECT id, scope_type, scope_id, content, confirmed, created_at
           FROM memories
          WHERE company_id = ? AND deleted_at IS NULL
            AND ((scope_type = 'user' AND scope_id = ?)
              OR (scope_type = 'dept' AND scope_id = ?)
              OR (scope_type = 'company' AND scope_id = ?))
          ORDER BY created_at DESC LIMIT 100`,
      )
      .all(actor.subject.companyId, actor.person.id, actor.subject.deptId, actor.subject.companyId) as unknown as Array<{
      id: string
      scope_type: string
      scope_id: string
      content: string
      confirmed: number
      created_at: number
    }>
    return ok({
      memories: rows.map((row) => ({
        id: row.id,
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        content: row.content,
        confirmed: row.confirmed === 1,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    })
  })

  app.post<{ Body: { content?: string; scopeType?: string } }>('/api/memories', async (req, reply) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    if (!scopeAllows(actor.subject.scopes, SC.MEMORY_WRITE)) {
      throw new EabError(EC.FORBIDDEN, '当前身份缺少权限：写入记忆（memory:write）', {
        details: { requiredScope: SC.MEMORY_WRITE },
      })
    }
    const content = String(req.body?.content ?? '').trim()
    if (!content) throw new EabError(EC.VALIDATION, '记忆内容不能为空')
    if (content.length > 1000) throw new EabError(EC.VALIDATION, '单条记忆最多 1000 字')
    const scopeType = String(req.body?.scopeType ?? 'user') as ScopeType
    if (!['user', 'dept', 'company'].includes(scopeType)) {
      throw new EabError(EC.VALIDATION, 'scopeType 只能是 user / dept / company')
    }
    if (scopeType !== 'user' && !scopeAllows(actor.subject.scopes, SC.MEMORY_ADMIN)) {
      throw new EabError(EC.FORBIDDEN, '部门/公司级记忆需要 memory:admin')
    }
    const scopeId =
      scopeType === 'user' ? actor.person.id : scopeType === 'dept' ? actor.subject.deptId : actor.subject.companyId
    const now = Date.now()
    const id = `mem_${randomUUID()}`
    deps.db
      .prepare(
        `INSERT INTO memories (id, company_id, scope_type, scope_id, user_id, content, confirmed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, actor.subject.companyId, scopeType, scopeId, actor.person.id, content, 0, now)
    appendAudit(deps.db, {
      companyId: actor.subject.companyId,
      actorUserId: actor.person.id,
      action: 'memory.create',
      resourceType: 'memory',
      resourceId: id,
      result: 'success',
      detail: { scopeType },
      ip: req.ip ?? null,
      channel: 'web',
    })
    reply.code(201)
    return ok({ id, scopeType, content, confirmed: false, note: '待你确认后才会进入对话上下文' })
  })

  app.post<{ Params: { id: string } }>('/api/memories/:id/confirm', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    if (!scopeAllows(actor.subject.scopes, SC.MEMORY_WRITE)) {
      throw new EabError(EC.FORBIDDEN, '当前身份缺少权限：写入记忆（memory:write）')
    }
    const row = deps.db
      .prepare('SELECT id, user_id FROM memories WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(req.params.id, actor.subject.companyId) as { id: string; user_id: string | null } | undefined
    if (!row) throw new EabError(EC.NOT_FOUND, '记忆不存在')
    if (row.user_id !== null && row.user_id !== actor.person.id && !scopeAllows(actor.subject.scopes, SC.MEMORY_ADMIN)) {
      throw new EabError(EC.FORBIDDEN, '只能确认自己的记忆')
    }
    deps.db.prepare('UPDATE memories SET confirmed = 1 WHERE id = ?').run(req.params.id)
    return ok({ id: req.params.id, confirmed: true })
  })

  app.delete<{ Params: { id: string } }>('/api/memories/:id', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    if (!scopeAllows(actor.subject.scopes, SC.MEMORY_WRITE)) {
      throw new EabError(EC.FORBIDDEN, '当前身份缺少权限：写入记忆（memory:write）')
    }
    const row = deps.db
      .prepare('SELECT id, user_id FROM memories WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(req.params.id, actor.subject.companyId) as { id: string; user_id: string | null } | undefined
    if (!row) throw new EabError(EC.NOT_FOUND, '记忆不存在')
    if (row.user_id !== null && row.user_id !== actor.person.id && !scopeAllows(actor.subject.scopes, SC.MEMORY_ADMIN)) {
      throw new EabError(EC.FORBIDDEN, '只能删除自己的记忆')
    }
    deps.db.prepare('UPDATE memories SET deleted_at = ? WHERE id = ?').run(Date.now(), req.params.id)
    return ok({ id: req.params.id, deleted: true })
  })
}
