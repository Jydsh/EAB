/**
 * 项目 REST 接口（本地文件夹工作空间）。
 * 新项目只允许桌面端创建：服务端不接收网页手填路径，而是校验桌面设备在线后，
 * 让桌面端在它自己的电脑上校验目录，再把真实路径登记回来。
 */
import type { FastifyInstance } from 'fastify'
import { EC, EabError, SC } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok, requireScope } from '../http.js'
import { resolveActor } from '../session.js'
import { assertDesktopOrigin } from '../desktop-bridge.js'
import { describeDesktopRoot, listProjectEntries } from '../project-files.js'
import {
  createLocalProject,
  deleteLocalProject,
  getLocalProject,
  listLocalProjects,
  updateLocalProject,
} from '../local-project.js'

function projectPublicView(project: ReturnType<typeof listLocalProjects>[number], online: boolean) {
  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    rootRealPath: project.rootRealPath,
    mode: project.mode,
    allowSensitive: project.allowSensitive,
    deviceId: project.deviceId,
    deviceOnline: online,
    instructions: project.instructions,
    cloudRefs: project.cloudRefs,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    lastUsedAt: project.lastUsedAt,
  }
}

export function registerLocalProjectRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const ownerOf = (req: Parameters<typeof resolveActor>[2]) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    return { actor, companyId: actor.subject.companyId, userId: actor.person.id }
  }

  app.get('/api/local-projects', async (req) => {
    const { actor, companyId, userId } = ownerOf(req)
    requireScope(actor.subject, SC.LOCAL_SPACE_READ)
    return ok({
      projects: listLocalProjects(deps.db, companyId, userId).map((project) =>
        projectPublicView(
          project,
          Boolean(project.deviceId && deps.desktopBridge?.isOnline(companyId, userId, project.deviceId)),
        ),
      ),
    })
  })

  app.post<{
    Body: {
      path?: string
      name?: string
      mode?: 'read_write' | 'read_only'
      allowSensitive?: boolean
      deviceId?: string
      instructions?: string
      cloudRefs?: string[]
    }
  }>('/api/local-projects', async (req) => {
    const { actor, companyId, userId } = ownerOf(req)
    requireScope(actor.subject, SC.LOCAL_SPACE_WRITE)
    assertDesktopOrigin(req.headers as Record<string, unknown>)
    const rawPath = String(req.body?.path ?? '').trim()
    if (!rawPath) throw new EabError(EC.VALIDATION, '需要项目文件夹路径')
    const deviceId = String(req.body?.deviceId ?? '').trim()
    if (!deviceId) throw new EabError(EC.VALIDATION, '缺少桌面设备标识')
    if (!deps.desktopBridge?.isOnline(companyId, userId, deviceId)) {
      throw new EabError(EC.CONFLICT, '桌面端文件服务未连接，请保持 EAB 桌面端打开后重试', {
        hint: '本地项目目录在桌面客户端电脑上，服务端无法直接选择或访问。',
      })
    }
    // 目录是否存在、是否可写，由桌面端在自己的电脑上校验；服务端只信任回传的真实路径。
    const descriptor = await describeDesktopRoot(deps, companyId, userId, deviceId, rawPath)
    const { project, created } = createLocalProject(deps.db, companyId, userId, {
      path: descriptor.rootPath,
      rootRealPath: descriptor.rootRealPath,
      name: req.body?.name,
      mode: req.body?.mode,
      allowSensitive: req.body?.allowSensitive,
      deviceId,
      instructions: req.body?.instructions,
      cloudRefs: req.body?.cloudRefs,
    })
    appendAudit(deps.db, {
      companyId,
      actorUserId: userId,
      action: created ? 'local_project.create' : 'local_project.reuse',
      resourceType: 'local_project',
      resourceId: project.id,
      result: 'success',
      detail: { rootPath: project.rootPath, name: project.name, mode: project.mode, deviceId },
      ip: req.ip,
    })
    return ok({ project: projectPublicView(project, true), created })
  })

  app.patch<{
    Params: { id: string }
    Body: {
      name?: string
      mode?: 'read_write' | 'read_only'
      allowSensitive?: boolean
      instructions?: string
      cloudRefs?: string[]
    }
  }>('/api/local-projects/:id', async (req) => {
    const { actor, companyId, userId } = ownerOf(req)
    requireScope(actor.subject, SC.LOCAL_SPACE_WRITE)
    const project = updateLocalProject(deps.db, companyId, userId, req.params.id, {
      name: req.body?.name,
      mode: req.body?.mode,
      allowSensitive: req.body?.allowSensitive,
      instructions: req.body?.instructions,
      cloudRefs: req.body?.cloudRefs,
    })
    appendAudit(deps.db, {
      companyId,
      actorUserId: userId,
      action: 'local_project.update',
      resourceType: 'local_project',
      resourceId: project.id,
      result: 'success',
      detail: { name: project.name, mode: project.mode, allowSensitive: project.allowSensitive },
      ip: req.ip,
    })
    return ok({
      project: projectPublicView(
        project,
        Boolean(project.deviceId && deps.desktopBridge?.isOnline(companyId, userId, project.deviceId)),
      ),
    })
  })

  app.delete<{ Params: { id: string } }>('/api/local-projects/:id', async (req) => {
    const { actor, companyId, userId } = ownerOf(req)
    requireScope(actor.subject, SC.LOCAL_SPACE_WRITE)
    const project = getLocalProject(deps.db, companyId, userId, req.params.id)
    if (!project) throw new EabError(EC.NOT_FOUND, '项目不存在或已删除')
    deleteLocalProject(deps.db, companyId, userId, req.params.id)
    appendAudit(deps.db, {
      companyId,
      actorUserId: userId,
      action: 'local_project.delete',
      resourceType: 'local_project',
      resourceId: req.params.id,
      result: 'success',
      detail: { rootPath: project.rootPath, note: '只解除绑定，不删除磁盘文件' },
      ip: req.ip,
    })
    return ok({ deleted: true })
  })

  app.get<{
    Params: { id: string }
    Querystring: { path?: string; depth?: string; limit?: string }
  }>('/api/local-projects/:id/files', async (req) => {
    const { actor, companyId, userId } = ownerOf(req)
    requireScope(actor.subject, SC.LOCAL_SPACE_READ)
    const project = getLocalProject(deps.db, companyId, userId, req.params.id)
    if (!project) throw new EabError(EC.NOT_FOUND, '项目不存在或已删除')
    const listing = await listProjectEntries(deps, project, companyId, userId, req.query.path ?? '', {
      depth: req.query.depth === undefined ? 1 : Number(req.query.depth),
      limit: req.query.limit === undefined ? 200 : Number(req.query.limit),
    })
    return ok({
      project: {
        id: project.id,
        name: project.name,
        rootPath: project.rootPath,
        mode: project.mode,
      },
      ...listing,
    })
  })
}
