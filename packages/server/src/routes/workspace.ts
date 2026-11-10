/**
 * 工作区（WS-01 ~ WS-07）。
 *
 * 文件真身落在配置的云空间根目录：`<workspacesDir>/<companyId>/<scopeType>-<scopeId>/<相对路径>`
 * 未单独配置时 workspacesDir 跟随总存储位置，再退回 `<db 同级>/workspaces`。
 * 元数据落 `workspace_files`；共享落 `workspace_shares`；配额落 `storage_quotas`。
 *
 * 所有用户提供的路径先过 `normalizeRelativePath` / `safeJoin`，再落盘。
 * 删除是软删：文件移到 `_recycle/` 并写 deleted_at，元数据保留可审计。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  renameSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { EC, EabError, ulid, SC } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import { normalizeRelativePath, safeJoin, toSlug } from '@eab/workspace'
import type { ServerDeps } from '../deps.js'
import { ok, requireScope } from '../http.js'
import { resolveActor, type RequestActor } from '../session.js'
import { sendDingTalkFileToUser } from '../dingtalk-outbound.js'
import {
  DEFAULT_COMPANY_QUOTA,
  resolveUserWorkspaceQuota,
  workspaceCapacity,
  workspaceUsedBytes,
} from '../workspace-quota.js'

const MAX_TEXT_BYTES = 5 * 1024 * 1024

function formatQuotaBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

interface FileRow {
  id: string
  company_id: string
  scope_type: string
  scope_id: string
  owner_user_id: string
  rel_path: string
  name: string
  size: number
  mime: string | null
  storage_path: string | null
  deleted_at: number | null
  archived_at: number | null
  created_at: number
  updated_at: number
}

export function workspaceRootOf(deps: ServerDeps): string {
  return deps.config.workspacesDir ?? join(dirname(deps.config.dbPath), 'workspaces')
}

function rootOf(deps: ServerDeps): string {
  return workspaceRootOf(deps)
}

function scopeDir(deps: ServerDeps, companyId: string, scopeType: string, scopeId: string): string {
  return join(rootOf(deps), toSlug(companyId, 'c'), `${toSlug(scopeType, 's')}-${toSlug(scopeId, 'x')}`)
}

/** 个人云空间目录；网页上传、agent 的 workspace.read/write 共用同一套解析。 */
export function userScopeDir(deps: ServerDeps, companyId: string, userId: string): string {
  return scopeDir(deps, companyId, 'user', userId)
}

function publicFile(row: FileRow) {
  return {
    id: row.id,
    name: row.name,
    relPath: row.rel_path,
    size: row.size,
    mime: row.mime,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    ownerUserId: row.owner_user_id,
    archived: Boolean(row.archived_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 重命名单个个人云空间文件。网页 PATCH 和 agent 的 workspace.rename 共用。
 * 先校验文件归属，再改磁盘路径，最后更新元数据；同名冲突直接拒绝。
 */
export function renameUserWorkspaceFile(
  deps: ServerDeps,
  actor: RequestActor,
  fileId: string,
  nextInput: string,
): { file: ReturnType<typeof publicFile>; row: FileRow; from: string; to: string } {
  const row = deps.db
    .prepare('SELECT * FROM workspace_files WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
    .get(fileId, actor.subject.companyId) as unknown as FileRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在')
  if (row.owner_user_id !== actor.subject.userId) throw new EabError(EC.FORBIDDEN, '只能改自己的文件')
  if (!String(nextInput ?? '').trim()) throw new EabError(EC.VALIDATION, '新文件名不能为空')

  const next = normalizeRelativePath(nextInput)
  const from = diskPathOf(deps, row)
  const to = safeJoin(scopeDir(deps, row.company_id, row.scope_type, row.scope_id), next)
  if (from !== to) {
    if (!existsSync(from)) throw new EabError(EC.NOT_FOUND, '原文件不在磁盘')
    const duplicate = deps.db
      .prepare(
        `SELECT id FROM workspace_files
          WHERE company_id = ? AND scope_type = ? AND scope_id = ? AND rel_path = ? AND deleted_at IS NULL AND id <> ?`,
      )
      .get(row.company_id, row.scope_type, row.scope_id, next, row.id)
    if (duplicate || existsSync(to)) throw new EabError(EC.VALIDATION, '同名文件已存在')
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
  }
  deps.db
    .prepare('UPDATE workspace_files SET rel_path = ?, name = ?, storage_path = ?, updated_at = ? WHERE id = ?')
    .run(next, basename(next), to, Date.now(), row.id)
  const updated = deps.db.prepare('SELECT * FROM workspace_files WHERE id = ?').get(row.id) as unknown as FileRow
  return { file: publicFile(updated), row: updated, from: row.rel_path, to: next }
}

/**
 * 软删单个个人云空间文件：移入 `_recycle/`、写 `deleted_at`、扣减配额。
 * 网页 DELETE 和 agent 的 workspace.delete 共用，避免两套删除语义。
 */
export function deleteUserWorkspaceFile(
  deps: ServerDeps,
  actor: RequestActor,
  fileId: string,
): { file: ReturnType<typeof publicFile>; row: FileRow; recycled: string } {
  const row = deps.db
    .prepare('SELECT * FROM workspace_files WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
    .get(fileId, actor.subject.companyId) as unknown as FileRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在')
  if (row.owner_user_id !== actor.subject.userId) throw new EabError(EC.FORBIDDEN, '只能删自己的文件')

  const from = diskPathOf(deps, row)
  const recycleDir = join(scopeDir(deps, row.company_id, row.scope_type, row.scope_id), '_recycle')
  if (!existsSync(recycleDir)) mkdirSync(recycleDir, { recursive: true })
  const recycled = join(recycleDir, `${row.id}-${row.name}`)
  if (existsSync(from)) {
    if (existsSync(recycled)) rmSync(recycled, { force: true })
    renameSync(from, recycled)
  }
  deps.db
    .prepare('UPDATE workspace_files SET deleted_at = ?, recycled_path = ? WHERE id = ?')
    .run(Date.now(), recycled, row.id)
  addUsage(deps, row.company_id, 'user', row.owner_user_id, -row.size)
  addUsage(deps, row.company_id, 'company', row.company_id, -row.size)
  const updated = deps.db.prepare('SELECT * FROM workspace_files WHERE id = ?').get(row.id) as unknown as FileRow
  return { file: publicFile(updated), row: updated, recycled }
}

function ensureQuota(
  deps: ServerDeps,
  companyId: string,
  scopeType: 'company' | 'user',
  scopeId: string,
  limit: number,
): { limit: number; used: number } {
  // storage_quotas 里的 used_bytes 可能落后于 workspace_files（历史上传/工具写入），
  // 每次读配额都以文件表实际占用为准，同时在存储行里回写一份。
  const used = workspaceUsedBytes(deps.db, companyId, scopeType, scopeId)
  const row = deps.db
    .prepare('SELECT limit_bytes, used_bytes FROM storage_quotas WHERE company_id = ? AND scope_type = ? AND scope_id = ?')
    .get(companyId, scopeType, scopeId) as { limit_bytes: number; used_bytes: number } | undefined
  if (row) {
    if (row.limit_bytes !== limit || row.used_bytes !== used) {
      deps.db
        .prepare('UPDATE storage_quotas SET limit_bytes = ?, used_bytes = ?, updated_at = ? WHERE company_id = ? AND scope_type = ? AND scope_id = ?')
        .run(limit, used, Date.now(), companyId, scopeType, scopeId)
    }
    return { limit, used }
  }
  deps.db
    .prepare('INSERT INTO storage_quotas (company_id, scope_type, scope_id, limit_bytes, used_bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(companyId, scopeType, scopeId, limit, used, Date.now())
  return { limit, used }
}

function addUsage(deps: ServerDeps, companyId: string, scopeType: string, scopeId: string, delta: number): void {
  deps.db
    .prepare(
      `UPDATE storage_quotas SET used_bytes = MAX(0, used_bytes + ?), updated_at = ?
        WHERE company_id = ? AND scope_type = ? AND scope_id = ?`,
    )
    .run(delta, Date.now(), companyId, scopeType, scopeId)
}

function diskPathOf(deps: ServerDeps, row: FileRow): string {
  const current = safeJoin(scopeDir(deps, row.company_id, row.scope_type, row.scope_id), row.rel_path)
  // 旧记录里可能存着切换存储位置前的绝对路径；以当前配置解析出的路径为准，
  // 只有当前位置没有文件时才回退到旧路径，避免迁移后仍读旧盘。
  if (existsSync(current)) return current
  if (row.storage_path && existsSync(row.storage_path)) return row.storage_path
  return current
}

function deptIdsOf(actor: ReturnType<typeof resolveActor>): string[] {
  return actor.subject.deptChain
    .flatMap((item) => item.split('/').filter(Boolean))
    .filter((item) => item.startsWith('d_') || /^d\d+$/.test(item) || item.length > 1)
    .filter((item) => item !== actor.subject.companyId)
}

function audit(deps: ServerDeps, req: FastifyRequest, action: string, row: FileRow | null, detail: Record<string, unknown>): void {
  const actor = resolveActor(deps.db, deps.config, req)
  appendAudit(deps.db, {
    companyId: actor.subject.companyId,
    actorUserId: actor.subject.userId,
    action,
    resourceType: 'file',
    resourceId: row?.id ?? null,
    resourceScope: row ? `${row.scope_type}:${row.scope_id}` : null,
    result: 'success',
    detail,
    traceId: String(req.id),
    ip: req.ip,
    channel: 'web',
  })
}

function requireEnabled(actor: ReturnType<typeof resolveActor>): void {
  if (actor.subject.status !== 'active') throw new EabError(EC.FORBIDDEN, '账号已被停用')
}

export interface SavedWorkspaceFile {
  readonly id: string
  readonly name: string
  readonly relPath: string
  readonly size: number
  readonly mime: string | null
  readonly root: string
}

export interface WorkspaceFileContent {
  readonly id: string
  readonly name: string
  readonly relPath: string
  readonly size: number
  readonly mime: string | null
  readonly ownerUserId: string
  readonly buffer: Buffer
}

/**
 * 读取当前员工可访问的云空间文件内容。
 * 用于把文件发送到钉钉等外部渠道；路径从 workspace_files 元数据取，不接受调用方拼绝对路径。
 */
export function readUserWorkspaceFile(
  deps: ServerDeps,
  actor: RequestActor,
  fileId: string,
): WorkspaceFileContent {
  requireEnabled(actor)
  const row = deps.db
    .prepare('SELECT * FROM workspace_files WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
    .get(fileId, actor.subject.companyId) as unknown as FileRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在')
  if (row.owner_user_id !== actor.subject.userId && !isShared(deps, row, actor)) {
    throw new EabError(EC.FORBIDDEN, '没有该文件的访问权限')
  }
  const path = diskPathOf(deps, row)
  if (!existsSync(path)) throw new EabError(EC.NOT_FOUND, '文件内容已不在磁盘（可能被清理）')
  return {
    id: row.id,
    name: row.name,
    relPath: row.rel_path,
    size: row.size,
    mime: row.mime,
    ownerUserId: row.owner_user_id,
    buffer: readFileSync(path),
  }
}

/**
 * 把渠道（钉钉等）收到的文件落进当前用户的个人云空间。
 * 与网页上传共用同一套目录、配额与 workspace_files 元数据，不另开一套存储。
 * 默认不覆盖同名文件，自动追加「 (1)」「 (2)」。
 */
export function saveUserWorkspaceFile(
  deps: ServerDeps,
  actor: RequestActor,
  input: { relPath: string; buffer: Buffer; mime?: string | null; channel?: string; traceId?: string | null },
): SavedWorkspaceFile {
  requireEnabled(actor)
  const wanted = basename(String(input.relPath || '').trim())
  if (!wanted) throw new EabError(EC.VALIDATION, '文件名不能为空')
  const relPath = normalizeRelativePath(wanted)
  const policy = resolveUserWorkspaceQuota(deps.db, actor.subject.companyId, actor.subject.userId)
  const fileLimitBytes = policy.fileLimitBytes
  const buffer = input.buffer
  if (buffer.length > fileLimitBytes) {
    throw new EabError(EC.VALIDATION, `文件超过单文件上限（${formatQuotaBytes(fileLimitBytes)}）`)
  }

  const dir = scopeDir(deps, actor.subject.companyId, 'user', actor.subject.userId)
  const companyQuota = ensureQuota(deps, actor.subject.companyId, 'company', actor.subject.companyId, DEFAULT_COMPANY_QUOTA)
  if (companyQuota.used + buffer.length > companyQuota.limit) {
    throw new EabError(
      EC.VALIDATION,
      `公司空间不足：已用 ${(companyQuota.used / 1024 / 1024).toFixed(1)} MB / ${(companyQuota.limit / 1024 / 1024).toFixed(0)} MB`,
    )
  }
  const userQuota = ensureQuota(deps, actor.subject.companyId, 'user', actor.subject.userId, policy.limitBytes)
  if (userQuota.used + buffer.length > userQuota.limit) {
    throw new EabError(
      EC.VALIDATION,
      `个人空间不足：已用 ${(userQuota.used / 1024 / 1024).toFixed(1)} MB / ${(userQuota.limit / 1024 / 1024).toFixed(0)} MB`,
    )
  }

  let finalRelPath = relPath
  for (let index = 1; ; index += 1) {
    const duplicate = deps.db
      .prepare(
        `SELECT id FROM workspace_files
          WHERE company_id = ? AND scope_type = 'user' AND scope_id = ? AND rel_path = ? AND deleted_at IS NULL`,
      )
      .get(actor.subject.companyId, actor.subject.userId, finalRelPath) as { id: string } | undefined
    if (!duplicate && !existsSync(safeJoin(dir, finalRelPath))) break
    const ext = extname(relPath)
    const stem = ext ? relPath.slice(0, -ext.length) : relPath
    finalRelPath = `${stem} (${index})${ext}`
  }

  const target = safeJoin(dir, finalRelPath)
  if (!existsSync(dirname(target))) mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, buffer)
  const now = Date.now()
  const id = ulid()
  deps.db
    .prepare(
      `INSERT INTO workspace_files
         (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, mime, storage_path, created_at, updated_at)
       VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      actor.subject.companyId,
      actor.subject.userId,
      actor.subject.userId,
      finalRelPath,
      basename(finalRelPath),
      buffer.length,
      input.mime ?? null,
      target,
      now,
      now,
    )
  addUsage(deps, actor.subject.companyId, 'user', actor.subject.userId, buffer.length)
  addUsage(deps, actor.subject.companyId, 'company', actor.subject.companyId, buffer.length)
  appendAudit(deps.db, {
    companyId: actor.subject.companyId,
    actorUserId: actor.subject.userId,
    action: 'workspace.file.upload',
    resourceType: 'file',
    resourceId: id,
    resourceScope: `user:${actor.subject.userId}`,
    result: 'success',
    detail: { relPath: finalRelPath, size: buffer.length, channel: input.channel ?? 'web' },
    traceId: input.traceId ?? null,
    ip: null,
    channel: input.channel ?? 'web',
  })
  return {
    id,
    name: basename(finalRelPath),
    relPath: finalRelPath,
    size: buffer.length,
    mime: input.mime ?? null,
    root: dir,
  }
}

export function registerWorkspaceRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/workspace/files', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.WORKSPACE_READ)
    const own = deps.db
      .prepare('SELECT * FROM workspace_files WHERE company_id = ? AND owner_user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')
      .all(actor.subject.companyId, actor.subject.userId) as unknown as FileRow[]
    const deptIds = deptIdsOf(actor)
    const sharedRows = deps.db
      .prepare(
        `SELECT f.* FROM workspace_shares s
           JOIN workspace_files f ON f.id = s.file_id
          WHERE s.company_id = ? AND s.revoked_at IS NULL AND f.deleted_at IS NULL
            AND ((s.scope_type = 'user' AND s.scope_id = ?)
              OR (s.scope_type = 'dept' AND s.scope_id IN (${deptIds.map(() => '?').join(',') || 'NULL'}))
              OR s.scope_type = 'company')`,
      )
      .all(actor.subject.companyId, actor.subject.userId, ...deptIds) as unknown as FileRow[]
    const seen = new Set<string>()
    const items = []
    for (const row of [...own, ...sharedRows]) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      items.push({ ...publicFile(row), shared: row.owner_user_id !== actor.subject.userId })
    }
    return ok({ items, root: scopeDir(deps, actor.subject.companyId, 'user', actor.subject.userId) })
  })

  app.get('/api/workspace/quota', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.WORKSPACE_READ)
    const policy = resolveUserWorkspaceQuota(deps.db, actor.subject.companyId, actor.subject.userId)
    const user = ensureQuota(deps, actor.subject.companyId, 'user', actor.subject.userId, policy.limitBytes)
    const company = ensureQuota(deps, actor.subject.companyId, 'company', actor.subject.companyId, DEFAULT_COMPANY_QUOTA)
    const capacity = workspaceCapacity(user.limit, user.used)
    return ok({
      user: {
        ...user,
        limitBytes: user.limit,
        remainingBytes: capacity.remainingBytes,
        percent: Number(capacity.percent.toFixed(1)),
        fileLimitBytes: policy.fileLimitBytes,
      },
      company,
      fileLimitBytes: policy.fileLimitBytes,
      remainingBytes: capacity.remainingBytes,
      percent: Number(capacity.percent.toFixed(1)),
      warning: { level: capacity.level, message: capacity.message },
      quotaSource: policy.source,
      roleCodes: policy.roleCodes,
    })
  })

  app.post<{
    Body: { name?: string; path?: string; text?: string; contentBase64?: string; mime?: string }
  }>('/api/workspace/files', { bodyLimit: 80 * 1024 * 1024 }, async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.WORKSPACE_WRITE)
    const body = req.body ?? {}
    const wanted = (body.path || body.name || '').trim()
    if (!wanted) throw new EabError(EC.VALIDATION, '文件名不能为空')
    const relPath = normalizeRelativePath(wanted)
    const userPolicy = resolveUserWorkspaceQuota(deps.db, actor.subject.companyId, actor.subject.userId)
    const fileLimitBytes = userPolicy.fileLimitBytes
    let buffer: Buffer
    if (body.contentBase64) {
      buffer = Buffer.from(body.contentBase64, 'base64')
    } else {
      buffer = Buffer.from(body.text ?? '', 'utf8')
      const textLimit = Math.min(MAX_TEXT_BYTES, fileLimitBytes)
      if (buffer.length > textLimit) {
        throw new EabError(EC.VALIDATION, `文本文件不能超过 ${formatQuotaBytes(textLimit)}`)
      }
    }
    if (buffer.length > fileLimitBytes) {
      throw new EabError(
        EC.VALIDATION,
        `文件超过单文件上限（${formatQuotaBytes(fileLimitBytes)}）`,
      )
    }
    const companyQuota = ensureQuota(deps, actor.subject.companyId, 'company', actor.subject.companyId, DEFAULT_COMPANY_QUOTA)
    if (companyQuota.used + buffer.length > companyQuota.limit) {
      throw new EabError(EC.VALIDATION, `公司空间不足：已用 ${(companyQuota.used / 1024 / 1024).toFixed(1)} MB / ${(companyQuota.limit / 1024 / 1024).toFixed(0)} MB`)
    }
    const userQuota = ensureQuota(deps, actor.subject.companyId, 'user', actor.subject.userId, userPolicy.limitBytes)
    if (userQuota.used + buffer.length > userQuota.limit) {
      throw new EabError(EC.VALIDATION, `个人空间不足：已用 ${(userQuota.used / 1024 / 1024).toFixed(1)} MB / ${(userQuota.limit / 1024 / 1024).toFixed(0)} MB`)
    }

    const existing = deps.db
      .prepare('SELECT * FROM workspace_files WHERE company_id = ? AND scope_type = ? AND scope_id = ? AND rel_path = ? AND deleted_at IS NULL')
      .get(actor.subject.companyId, 'user', actor.subject.userId, relPath) as unknown as FileRow | undefined
    const dir = scopeDir(deps, actor.subject.companyId, 'user', actor.subject.userId)
    const target = safeJoin(dir, relPath)
    if (!existsSync(dirname(target))) mkdirSync(dirname(target), { recursive: true })
    const oldSize = existing?.size ?? 0
    if (existing && existsSync(target) && oldSize !== buffer.length) {
      if (buffer.length > oldSize) {
        if (userQuota.used + (buffer.length - oldSize) > userQuota.limit) throw new EabError(EC.VALIDATION, '覆盖后超出个人配额')
      }
    }
    writeFileSync(target, buffer)
    const now = Date.now()
    const id = existing?.id ?? ulid()
    if (existing) {
      deps.db
        .prepare('UPDATE workspace_files SET name = ?, size = ?, mime = ?, storage_path = ?, updated_at = ? WHERE id = ?')
        .run(basename(relPath), buffer.length, body.mime ?? null, target, now, id)
      addUsage(deps, actor.subject.companyId, 'user', actor.subject.userId, buffer.length - oldSize)
      addUsage(deps, actor.subject.companyId, 'company', actor.subject.companyId, buffer.length - oldSize)
    } else {
      deps.db
        .prepare(
          `INSERT INTO workspace_files
             (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, mime, storage_path, created_at, updated_at)
           VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, actor.subject.companyId, actor.subject.userId, actor.subject.userId, relPath, basename(relPath), buffer.length, body.mime ?? null, target, now, now)
      addUsage(deps, actor.subject.companyId, 'user', actor.subject.userId, buffer.length)
      addUsage(deps, actor.subject.companyId, 'company', actor.subject.companyId, buffer.length)
    }
    const row = deps.db.prepare('SELECT * FROM workspace_files WHERE id = ?').get(id) as unknown as FileRow
    audit(deps, req, existing ? 'workspace.file.update' : 'workspace.file.upload', row, { relPath, size: buffer.length })
    return ok(publicFile(row))
  })

  app.get<{ Params: { id: string } }>('/api/workspace/files/:id', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.WORKSPACE_READ)
    const row = deps.db
      .prepare('SELECT * FROM workspace_files WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(req.params.id, actor.subject.companyId) as unknown as FileRow | undefined
    if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在')
    if (row.owner_user_id !== actor.subject.userId && !isShared(deps, row, actor)) {
      throw new EabError(EC.FORBIDDEN, '没有该文件的访问权限')
    }
    return ok(publicFile(row))
  })

  app.get<{ Params: { id: string } }>('/api/workspace/files/:id/download', async (req, reply) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.WORKSPACE_READ)
    const row = deps.db
      .prepare('SELECT * FROM workspace_files WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(req.params.id, actor.subject.companyId) as unknown as FileRow | undefined
    if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在')
    if (row.owner_user_id !== actor.subject.userId && !isShared(deps, row, actor)) throw new EabError(EC.FORBIDDEN, '没有该文件的访问权限')
    const path = diskPathOf(deps, row)
    if (!existsSync(path)) throw new EabError(EC.NOT_FOUND, '文件内容已不在磁盘（可能被清理）')
    audit(deps, req, 'workspace.file.download', row, { relPath: row.rel_path })
    const mime = row.mime || 'application/octet-stream'
    const encoded = encodeURIComponent(row.name)
    reply.header('content-type', mime).header('content-disposition', `attachment; filename*=UTF-8''${encoded}`)
    return reply.send(readFileSync(path))
  })

  app.post<{ Params: { id: string } }>('/api/workspace/files/:id/send-dingtalk', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.WORKSPACE_READ)
    const content = readUserWorkspaceFile(deps, actor, req.params.id)
    const sent = await sendDingTalkFileToUser(deps, {
      companyId: actor.subject.companyId,
      userId: actor.subject.userId,
      fileName: content.name,
      mime: content.mime,
      buffer: content.buffer,
    })
    appendAudit(deps.db, {
      companyId: actor.subject.companyId,
      actorUserId: actor.subject.userId,
      action: 'workspace.file.send_dingtalk',
      resourceType: 'file',
      resourceId: content.id,
      resourceScope: `user:${content.ownerUserId}`,
      result: 'success',
      detail: {
        fileName: content.name,
        size: content.size,
        mediaId: sent.mediaId,
        mediaType: sent.mediaType,
        toUserId: sent.externalUserId,
      },
      traceId: String(req.id),
      ip: req.ip,
      channel: 'web',
    })
    return ok({
      fileId: content.id,
      fileName: content.name,
      toUserId: sent.externalUserId,
      mediaType: sent.mediaType,
    })
  })

  app.patch<{ Params: { id: string }; Body: { relPath?: string; name?: string } }>('/api/workspace/files/:id', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.WORKSPACE_WRITE)
    const renamed = renameUserWorkspaceFile(
      deps,
      actor,
      req.params.id,
      req.body?.relPath || req.body?.name || '',
    )
    audit(deps, req, 'workspace.file.rename', renamed.row, { from: renamed.from, to: renamed.to })
    return ok(renamed.file)
  })

  app.delete<{ Params: { id: string } }>('/api/workspace/files/:id', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.WORKSPACE_WRITE)
    const deleted = deleteUserWorkspaceFile(deps, actor, req.params.id)
    audit(deps, req, 'workspace.file.delete', deleted.row, { recycled: deleted.recycled })
    return ok({ deleted: true, recycled: deleted.recycled })
  })

  app.post<{ Params: { id: string }; Body: { scopeType?: string; scopeId?: string } }>(
    '/api/workspace/files/:id/share',
    async (req) => {
      const actor = resolveActor(deps.db, deps.config, req)
      requireEnabled(actor)
      requireScope(actor.subject, SC.WORKSPACE_SHARE)
      const row = deps.db
        .prepare('SELECT * FROM workspace_files WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
        .get(req.params.id, actor.subject.companyId) as unknown as FileRow | undefined
      if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在')
      if (row.owner_user_id !== actor.subject.userId) throw new EabError(EC.FORBIDDEN, '只能共享自己的文件')
      const scopeType = req.body?.scopeType === 'company' ? 'company' : 'dept'
      const scopeId = scopeType === 'company' ? actor.subject.companyId : req.body?.scopeId || actor.subject.deptId
      if (!scopeId) throw new EabError(EC.VALIDATION, '缺少共享目标')
      const id = ulid()
      deps.db
        .prepare('INSERT INTO workspace_shares (id, company_id, file_id, scope_type, scope_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, actor.subject.companyId, row.id, scopeType, scopeId, actor.subject.userId, Date.now())
      audit(deps, req, 'workspace.file.share', row, { shareId: id, scopeType, scopeId })
      return ok({ id, scopeType, scopeId })
    },
  )

  app.delete<{ Params: { id: string } }>('/api/workspace/shares/:id', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.WORKSPACE_SHARE)
    const share = deps.db
      .prepare('SELECT * FROM workspace_shares WHERE id = ? AND company_id = ? AND revoked_at IS NULL')
      .get(req.params.id, actor.subject.companyId) as { id: string; file_id: string; created_by: string } | undefined
    if (!share) throw new EabError(EC.NOT_FOUND, '共享不存在或已撤销')
    if (share.created_by !== actor.subject.userId && !actor.subject.scopes.has(SC.WORKSPACE_SHARE)) throw new EabError(EC.FORBIDDEN, '无权撤销')
    deps.db.prepare('UPDATE workspace_shares SET revoked_at = ? WHERE id = ?').run(Date.now(), share.id)
    const row = deps.db.prepare('SELECT * FROM workspace_files WHERE id = ?').get(share.file_id) as unknown as FileRow
    audit(deps, req, 'workspace.file.unshare', row, { shareId: share.id })
    return ok({ revoked: true })
  })

  /** 自己的工作区归档（离职交接 / 备份用），返回 JSON 包：元数据 + 文本内容（二进制给 base64） */
  app.get('/api/workspace/archive', async (req, reply) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.WORKSPACE_READ)
    const rows = deps.db
      .prepare('SELECT * FROM workspace_files WHERE company_id = ? AND owner_user_id = ? AND deleted_at IS NULL')
      .all(actor.subject.companyId, actor.subject.userId) as unknown as FileRow[]
    const files = rows.map((row) => {
      const path = diskPathOf(deps, row)
      const content = existsSync(path) ? readFileSync(path) : null
      return {
        relPath: row.rel_path,
        name: row.name,
        mime: row.mime,
        size: row.size,
        sha256: content ? createHash('sha256').update(content).digest('hex') : null,
        contentBase64: content ? content.toString('base64') : null,
        missing: !content,
      }
    })
    audit(deps, req, 'workspace.archive.export', null, { files: files.length })
    reply.header('content-type', 'application/json; charset=utf-8').header(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(`workspace-${actor.subject.userId}.json`)}`,
    )
    return reply.send(JSON.stringify({ userId: actor.subject.userId, exportedAt: new Date().toISOString(), files }, null, 2))
  })
}

function isShared(deps: ServerDeps, row: FileRow, actor: ReturnType<typeof resolveActor>): boolean {
  const deptIds = deptIdsOf(actor)
  const share = deps.db
    .prepare(
      `SELECT id FROM workspace_shares
        WHERE company_id = ? AND file_id = ? AND revoked_at IS NULL
          AND ((scope_type = 'user' AND scope_id = ?)
            OR (scope_type = 'dept' AND scope_id IN (${deptIds.map(() => '?').join(',') || 'NULL'}))
            OR scope_type = 'company')`,
    )
    .get(row.company_id, row.id, actor.subject.userId, ...deptIds)
  return Boolean(share)
}

/** 启动时清理 tmp 下超过 1 天的临时文件；tmp 与工作区完全分开（WS-07） */
export function cleanupTemp(tmpDir: string): void {
  const tmp = tmpDir
  if (!existsSync(tmp)) {
    mkdirSync(tmp, { recursive: true })
    return
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  for (const name of readdirSync(tmp)) {
    const path = join(tmp, name)
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true })
    } catch {
      /* tmp 清理失败不影响启动 */
    }
  }
}
