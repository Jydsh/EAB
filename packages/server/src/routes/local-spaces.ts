/**
 * 本地空间接口。
 *
 * 前提：服务端与本地目录在同一台电脑，服务端直接读写用户绑定目录。
 * 所有路径参数都是相对空间根目录的路径；绝对路径只在“绑定”时出现。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { EC, EabError, SC } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import type { Db } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok, requireScope } from '../http.js'
import { resolveActor } from '../session.js'
import {
  deleteLocalFile,
  insertLocalSpaceRow,
  listLocalEntries,
  listLocalSpaceRows,
  findLocalSpaceRow,
  moveLocalEntry,
  mkdirLocal,
  probeLocalWritable,
  publicLocalSpace,
  readLocalText,
  resolveLocalDownload,
  touchLocalSpace,
  validateLocalRoot,
  writeLocalText,
  type LocalSpaceMode,
  type LocalSpaceRow,
} from '../local-space.js'

type Actor = ReturnType<typeof resolveActor>

function requireEnabled(actor: Actor): void {
  if (actor.subject.status !== 'active') throw new EabError(EC.FORBIDDEN, '账号已被停用')
}

function audit(
  deps: ServerDeps,
  req: FastifyRequest,
  actor: Actor,
  action: string,
  spaceId: string,
  detail: Record<string, unknown>,
): void {
  appendAudit(deps.db, {
    companyId: actor.subject.companyId,
    actorUserId: actor.subject.userId,
    action,
    resourceType: 'local_space',
    resourceId: spaceId,
    resourceScope: `local:${spaceId}`,
    result: 'success',
    detail,
    traceId: String(req.id),
    ip: req.ip,
    channel: 'web',
  })
}

function getSpaceOrThrow(
  db: Db,
  actor: Actor,
  id: string,
): LocalSpaceRow {
  const row = findLocalSpaceRow(db, actor.subject.companyId, actor.person.id, id)
  if (!row) throw new EabError(EC.NOT_FOUND, '本地空间不存在或已删除')
  return row
}

function ensureAvailable(row: LocalSpaceRow): void {
  if (!existsSync(row.root_realpath)) {
    throw new EabError(EC.CONFLICT, '本地目录不存在或已离线，请重新绑定或检查磁盘', {
      details: { spaceId: row.id, rootPath: row.root_path },
    })
  }
}

function parseMode(value: unknown): LocalSpaceMode {
  return value === 'read_only' ? 'read_only' : 'read_write'
}

function requireBodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') throw new EabError(EC.VALIDATION, '请求体必须是 JSON 对象')
  return body as Record<string, unknown>
}

/**
 * 目录浏览只允许在本机发起。浏览器与服务端同机时，直接在网页里浏览本机目录，
 * 不依赖服务端进程所在桌面的系统对话框。
 */
function requireLocalPickerAccess(req: FastifyRequest): void {
  const remote = String(req.ip || '').replace(/^::ffff:/, '')
  if (!['127.0.0.1', '::1'].includes(remote) && process.env.EAB_ALLOW_REMOTE_DIR_PICKER !== '1') {
    throw new EabError(EC.CONFLICT, '目录选择器只支持在本机浏览器中使用，请手动填写路径')
  }
}

function listLocalRoots(): Array<{ name: string; path: string }> {
  const roots: Array<{ name: string; path: string }> = []
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code)
    const root = `${letter}:\\`
    if (existsSync(root)) roots.push({ name: root, path: root })
  }
  return roots
}

export function registerLocalSpaceRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/local-spaces', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.LOCAL_SPACE_READ)
    const rows = listLocalSpaceRows(deps.db, actor.subject.companyId, actor.person.id)
    return ok({ items: rows.map(publicLocalSpace) })
  })

  app.get('/api/local-spaces/browse', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.LOCAL_SPACE_READ)
    if (process.platform !== 'win32') {
      throw new EabError(EC.CONFLICT, '目录浏览目前只支持 Windows 本机，请手动填写路径')
    }
    requireLocalPickerAccess(req)
    const raw = String((req.query as { path?: unknown })?.path ?? '').trim()
    if (!raw) {
      return ok({ path: null, name: null, parent: null, isRoot: false, entries: listLocalRoots() })
    }
    if (!isAbsolute(raw)) throw new EabError(EC.VALIDATION, '目录路径必须是绝对路径')
    if (raw.startsWith('\\\\')) throw new EabError(EC.CONFLICT, '一期不支持 UNC 网络路径，请选择本机目录')
    const target = resolve(raw)
    if (!existsSync(target)) throw new EabError(EC.NOT_FOUND, '目录不存在')
    if (!statSync(target).isDirectory()) throw new EabError(EC.VALIDATION, '指定的路径不是目录')
    let entries: Array<{ name: string; path: string }>
    try {
      entries = readdirSync(target, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, path: join(target, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    } catch {
      throw new EabError(EC.FORBIDDEN, '没有权限读取该目录，请选择其他文件夹')
    }
    const truncated = entries.length > 500
    const parent = dirname(target) === target ? null : dirname(target)
    return ok({
      path: target,
      name: basename(target),
      parent,
      isRoot: parent === null,
      entries: entries.slice(0, 500),
      truncated,
    })
  })

  app.post('/api/local-spaces', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.LOCAL_SPACE_WRITE)
    const body = requireBodyObject(req.body)
    const rootPath = String(body.path ?? '').trim()
    const { rootPath: savedPath, rootRealpath } = validateLocalRoot(rootPath)
    const mode = parseMode(body.mode)
    if (mode === 'read_write') probeLocalWritable(rootRealpath)
    const name = body.name ? String(body.name) : basename(rootRealpath)
    const row = insertLocalSpaceRow(deps.db, {
      companyId: actor.subject.companyId,
      userId: actor.person.id,
      name,
      rootPath: savedPath,
      rootRealpath,
      mode,
      allowSensitive: body.allowSensitive === true,
    })
    audit(deps, req, actor, 'local_space.bind', row.id, {
      rootPath: row.root_path,
      mode: row.mode,
      allowSensitive: Boolean(row.allow_sensitive),
    })
    return ok({ space: publicLocalSpace(row) })
  })

  app.patch<{
    Params: { id: string }
  }>('/api/local-spaces/:id', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.LOCAL_SPACE_WRITE)
    const body = requireBodyObject(req.body)
    const row = getSpaceOrThrow(deps.db, actor, req.params.id)
    ensureAvailable(row)
    const mode = body.mode === undefined ? row.mode : parseMode(body.mode)
    if (mode === 'read_write' && row.mode !== 'read_write') probeLocalWritable(row.root_realpath)
    const name = body.name === undefined ? row.name : String(body.name)
    const allowSensitive =
      body.allowSensitive === undefined ? Boolean(row.allow_sensitive) : body.allowSensitive === true
    const nextName = name.replace(/\s+/g, ' ').trim()
    if (!nextName) throw new EabError(EC.VALIDATION, '空间名称不能为空')
    if (nextName.length > 40) throw new EabError(EC.VALIDATION, '空间名称不能超过 40 个字符')
    deps.db
      .prepare(
        `UPDATE user_local_spaces
            SET name = ?, mode = ?, allow_sensitive = ?, updated_at = ?
          WHERE id = ? AND company_id = ? AND user_id = ? AND deleted_at IS NULL`,
      )
      .run(
        nextName,
        mode,
        allowSensitive ? 1 : 0,
        Date.now(),
        row.id,
        actor.subject.companyId,
        actor.person.id,
      )
    const updated = getSpaceOrThrow(deps.db, actor, row.id)
    audit(deps, req, actor, 'local_space.update', row.id, {
      mode: updated.mode,
      allowSensitive: Boolean(updated.allow_sensitive),
      name: updated.name,
    })
    return ok({ space: publicLocalSpace(updated) })
  })

  app.delete<{
    Params: { id: string }
  }>('/api/local-spaces/:id', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.LOCAL_SPACE_WRITE)
    const row = getSpaceOrThrow(deps.db, actor, req.params.id)
    deps.db
      .prepare('UPDATE user_local_spaces SET deleted_at = ?, updated_at = ? WHERE id = ?')
      .run(Date.now(), Date.now(), row.id)
    audit(deps, req, actor, 'local_space.unbind', row.id, { rootPath: row.root_path })
    return ok({ deleted: true })
  })

  app.get<{
    Params: { id: string }
    Querystring: { path?: string; all?: string; limit?: string }
  }>('/api/local-spaces/:id/entries', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.LOCAL_SPACE_READ)
    const row = getSpaceOrThrow(deps.db, actor, req.params.id)
    ensureAvailable(row)
    touchLocalSpace(deps.db, row.id)
    const rawLimit = Number.parseInt(String(req.query?.limit ?? ''), 10)
    const limit = Number.isFinite(rawLimit) ? rawLimit : undefined
    const showAll = String(req.query?.all ?? '') === '1'
    const path = String(req.query?.path ?? '')
    const result = listLocalEntries(row, path, { limit, showAll })
    return ok({
      space: publicLocalSpace(row),
      path: path,
      entries: result.entries,
      truncated: result.truncated,
    })
  })

  app.get<{
    Params: { id: string }
    Querystring: { path?: string }
  }>('/api/local-spaces/:id/file', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.LOCAL_SPACE_READ)
    const row = getSpaceOrThrow(deps.db, actor, req.params.id)
    ensureAvailable(row)
    const read = readLocalText(row, String(req.query?.path ?? ''))
    return ok({
      path: read.relPath,
      name: basename(read.relPath),
      size: read.size,
      mtime: read.mtime,
      text: read.text,
      encoding: read.encoding,
      bom: read.bom,
      binary: read.binary,
      truncated: read.truncated,
    })
  })

  app.get<{
    Params: { id: string }
    Querystring: { path?: string }
  }>('/api/local-spaces/:id/download', async (req, reply) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.LOCAL_SPACE_READ)
    const row = getSpaceOrThrow(deps.db, actor, req.params.id)
    ensureAvailable(row)
    const file = resolveLocalDownload(row, String(req.query?.path ?? ''))
    const name = basename(file.rel).replace(/["\\\r\n]/g, '_')
    reply
      .type('application/octet-stream')
      .header('content-disposition', `attachment; filename="${encodeURIComponent(name)}"`)
    audit(deps, req, actor, 'local_file.download', row.id, { path: file.rel, bytes: file.size })
    return reply.send(readFileSync(file.abs))
  })

  app.put<{
    Params: { id: string }
  }>(
    '/api/local-spaces/:id/file',
    { bodyLimit: 6 * 1024 * 1024 },
    async (req) => {
      const actor = resolveActor(deps.db, deps.config, req)
      requireEnabled(actor)
      requireScope(actor.subject, SC.LOCAL_SPACE_WRITE)
      const row = getSpaceOrThrow(deps.db, actor, req.params.id)
      ensureAvailable(row)
      const body = requireBodyObject(req.body)
      const path = String(body.path ?? '')
      const text = String(body.text ?? '')
      const expectedMtime =
        typeof body.expectedMtime === 'number' && Number.isFinite(body.expectedMtime)
          ? body.expectedMtime
          : undefined
      const createOnly = body.createOnly === true
      const result = writeLocalText(row, path, text, expectedMtime, createOnly)
      audit(deps, req, actor, 'local_file.write', row.id, {
        path: result.relPath,
        bytes: result.size,
      })
      return ok(result)
    },
  )

  app.delete<{
    Params: { id: string }
    Querystring: { path?: string }
  }>('/api/local-spaces/:id/file', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.LOCAL_SPACE_WRITE)
    const row = getSpaceOrThrow(deps.db, actor, req.params.id)
    ensureAvailable(row)
    const result = deleteLocalFile(row, String(req.query?.path ?? ''))
    audit(deps, req, actor, 'local_file.delete', row.id, {
      path: result.relPath,
      bytes: result.size,
    })
    return ok({ deleted: true, ...result })
  })

  app.post<{
    Params: { id: string }
  }>('/api/local-spaces/:id/move', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.LOCAL_SPACE_WRITE)
    const row = getSpaceOrThrow(deps.db, actor, req.params.id)
    ensureAvailable(row)
    const body = requireBodyObject(req.body)
    const result = moveLocalEntry(
      row,
      String(body.from ?? ''),
      String(body.to ?? ''),
      body.overwrite === true,
    )
    audit(deps, req, actor, 'local_file.move', row.id, {
      from: result.from,
      to: result.to,
    })
    return ok(result)
  })

  app.post<{
    Params: { id: string }
  }>('/api/local-spaces/:id/mkdir', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.LOCAL_SPACE_WRITE)
    const row = getSpaceOrThrow(deps.db, actor, req.params.id)
    ensureAvailable(row)
    const body = requireBodyObject(req.body)
    const result = mkdirLocal(row, String(body.path ?? ''))
    audit(deps, req, actor, 'local_file.mkdir', row.id, { path: result.relPath })
    return ok(result)
  })
}
