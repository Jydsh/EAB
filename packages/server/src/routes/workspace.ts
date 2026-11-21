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
  copyFileSync,
  statSync,
  renameSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { EC, EabError, ulid, SC } from '@eab/domain'
import { appendAudit, type Db, withTransaction } from '@eab/storage'
import { normalizeRelativePath, safeJoin, toSlug } from '@eab/workspace'
import type { ServerDeps } from '../deps.js'
import { ok, requireScope } from '../http.js'
import { resolveActor, type RequestActor } from '../session.js'
import { TEXT_EXTENSIONS, isTextEditableFile } from '../workspace-text.js'
export { isTextEditableFile }
import { inspectChatAttachment, isChatAttachmentRelPath } from '../attachment-security.js'
import {
  createAttachmentObjectStore,
  type AttachmentObjectStore,
} from '../object-storage.js'
import { publishChatEvent, type WorkspaceChangeReason } from '../chat-events.js'
import { sendDingTalkFileToUser } from '../dingtalk-outbound.js'
import {
  buildOfficeEditorConfig,
  buildOfficePluginConfig,
  convertOfficeDocumentToPdf,
  forceSaveOfficeDocument,
  officeDocumentKey,
  officeDocumentType,
  officeFileType,
  officeScriptUrl,
  signOfficeJwt,
  verifyOfficeJwt,
  type OfficeMode,
  type OfficeTokenPayload,
} from '../onlyoffice.js'
import { resolveOnlyOffice } from '../onlyoffice-runtime.js'
import {
  DEFAULT_COMPANY_QUOTA,
  resolveUserWorkspaceQuota,
  workspaceCapacity,
  workspaceUsedBytes,
} from '../workspace-quota.js'

const MAX_TEXT_BYTES = 5 * 1024 * 1024

/**
 * 编辑态“刷新到云端版本”的版本水位。
 * 刷新时旧编辑器关闭会触发 OnlyOffice 保存回调；若回调携带的版本早于刷新水位，
 * 说明它是被放弃的旧会话，必须丢弃，不能让旧内容覆盖刚刷新的云端版本。
 * 水位落 `workspace_office_refresh_guards`，服务重启后仍然有效。
 */
export function setOfficeRefreshCutoff(
  db: Db,
  companyId: string,
  fileId: string,
  cutoff: number,
): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO workspace_office_refresh_guards (company_id, file_id, cutoff, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(company_id, file_id)
     DO UPDATE SET cutoff = excluded.cutoff, updated_at = excluded.updated_at`,
  ).run(companyId, fileId, cutoff, now)
}

export function readOfficeRefreshCutoff(
  db: Db,
  companyId: string,
  fileId: string,
): number | undefined {
  const row = db
    .prepare('SELECT cutoff FROM workspace_office_refresh_guards WHERE company_id = ? AND file_id = ?')
    .get(companyId, fileId) as { cutoff?: number } | undefined
  return row?.cutoff === undefined ? undefined : Number(row.cutoff)
}

/** 记录每个文件最近一次成功回写的编辑会话，允许同一编辑器连续 status=2/6 保存。 */
const officeAcceptedCallbackSessions = new Map<string, string>()

function officeRefreshKey(companyId: string, fileId: string): string {
  return `${companyId}:${fileId}`
}

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

const objectStoreCache = new WeakMap<object, AttachmentObjectStore | null>()

/**
 * 对话附件的对象存储只在配置 EAB_S3_* 或测试显式注入时存在。
 * 返回 null 表示纯本地磁盘部署，上传/读取都不增加网络等待。
 */
export function attachmentObjectStoreOf(deps: ServerDeps): AttachmentObjectStore | null {
  if (Object.prototype.hasOwnProperty.call(deps, 'attachmentObjectStore')) {
    return deps.attachmentObjectStore ?? null
  }
  const config = deps.config
  if (!config.objectStorage) return null
  if (objectStoreCache.has(config)) return objectStoreCache.get(config) ?? null
  const store = createAttachmentObjectStore(config.objectStorage)
  objectStoreCache.set(config, store)
  return store
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
  publishWorkspaceFilesChanged(row.company_id, row.owner_user_id, 'renamed', [row.id])
  return { file: publicFile(updated), row: updated, from: row.rel_path, to: next }
}

/**
 * 软删时顺带清理对象副本。删除接口不能因为 S3 暂时不可用而失败，
 * 所以这里异步发出删除；失败只留下孤儿对象，不影响本地回收站与元数据。
 */
function dropChatAttachmentObject(deps: ServerDeps, row: Pick<FileRow, 'id' | 'company_id' | 'owner_user_id' | 'rel_path'>): void {
  if (!isChatAttachmentRelPath(row.rel_path)) return
  const store = attachmentObjectStoreOf(deps)
  if (!store) return
  const key = store.attachmentKey(row.company_id, row.owner_user_id, row.id)
  void store.delete(key).catch((error) => {
    console.warn('[workspace] chat attachment object delete failed', { fileId: row.id, error })
  })
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
  dropChatAttachmentObject(deps, row)
  publishWorkspaceFilesChanged(row.company_id, row.owner_user_id, 'deleted', [row.id])
  return { file: publicFile(updated), row: updated, recycled }
}

export interface WorkspaceFolderSummary {
  path: string
  name: string
  parentPath: string
  fileCount: number
}

/**
 * 从扁平的 `workspace_files.rel_path` 推导文件夹树。
 * `.gitkeep` 只负责保留空文件夹，不计入文件数；所有后代文件都计入祖先文件夹。
 */
export function workspaceFolderSummaries(
  rows: ReadonlyArray<{ rel_path: string }>,
): WorkspaceFolderSummary[] {
  const folders = new Map<string, WorkspaceFolderSummary>()
  for (const row of rows) {
    const relPath = String(row?.rel_path || '')
      .replace(/\\/g, '/')
      .split('/')
      .filter((segment) => segment && segment !== '.')
    if (relPath.length <= 1) continue
    const placeholder = relPath[relPath.length - 1] === '.gitkeep'
    for (let index = 1; index < relPath.length; index += 1) {
      const path = relPath.slice(0, index).join('/')
      const folder = folders.get(path) || {
        path,
        name: relPath[index - 1],
        parentPath: relPath.slice(0, Math.max(0, index - 1)).join('/'),
        fileCount: 0,
      }
      if (!placeholder) folder.fileCount += 1
      folders.set(path, folder)
    }
  }
  return [...folders.values()].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true }))
}

const FOLDER_ROOT_INTERNAL_PREFIXES = ['_', '.']

/** 文件夹路径只允许普通业务目录，内部目录（_recycle/_versions/.eab-*）不参与用户操作。 */
export function normalizeWorkspaceFolderPath(input: string): string {
  const path = normalizeRelativePath(String(input ?? '').trim())
  const segments = path.split('/')
  const bad = segments.find((segment) =>
    FOLDER_ROOT_INTERNAL_PREFIXES.some((prefix) => segment.startsWith(prefix)),
  )
  if (bad) {
    throw new EabError(EC.VALIDATION, `文件夹路径不能使用内部目录「${bad}」`, {
      hint: '请换一个不以 . 或 _ 开头的文件夹名称。',
    })
  }
  return path
}

/** 文件夹改名只接受最后一级名称，避免把“重命名”误当成跨目录移动。 */
function normalizeFolderLeafName(input: string): string {
  const name = String(input ?? '').trim()
  if (!name) throw new EabError(EC.VALIDATION, '文件夹名称不能为空')
  if (name.includes('/') || name.includes('\\')) {
    throw new EabError(EC.VALIDATION, '文件夹名称不能包含斜杠')
  }
  const normalized = normalizeRelativePath(name)
  if (normalized.includes('/')) throw new EabError(EC.VALIDATION, '文件夹名称不能包含多级路径')
  if (normalized.startsWith('.') || normalized.startsWith('_')) {
    throw new EabError(EC.VALIDATION, '文件夹名称不能以 . 或 _ 开头')
  }
  return normalized
}

/** 把 LIKE 前缀里的通配符转义，避免 `my_docs` 把 `myXdocs` 也当成自己的子目录。 */
function folderLikePrefix(path: string): string {
  return `${path.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}/%`
}

function userFolderRows(deps: ServerDeps, actor: RequestActor, folderPath: string): FileRow[] {
  return deps.db
    .prepare(
      `SELECT * FROM workspace_files
        WHERE company_id = ? AND scope_type = 'user' AND scope_id = ? AND owner_user_id = ?
          AND deleted_at IS NULL AND (rel_path = ? OR rel_path LIKE ? ESCAPE '\\')
        ORDER BY rel_path`,
    )
    .all(
      actor.subject.companyId,
      actor.subject.userId,
      actor.subject.userId,
      folderPath,
      folderLikePrefix(folderPath),
    ) as unknown as FileRow[]
}

/**
 * 文件夹可能被多个人的共享文件合并展示；整体重命名/删除只能处理本人文件，
 * 若目录里还有别人共享来的文件，直接拒绝，避免出现“旧目录仍在、只动了一半”的状态。
 */
function folderHasForeignSharedFiles(
  deps: ServerDeps,
  actor: RequestActor,
  folderPath: string,
): boolean {
  const deptIds = deptIdsOf(actor)
  const row = deps.db
    .prepare(
      `SELECT 1
         FROM workspace_shares s
         JOIN workspace_files f ON f.id = s.file_id
        WHERE s.company_id = ? AND s.revoked_at IS NULL AND f.deleted_at IS NULL
          AND f.owner_user_id <> ?
          AND f.rel_path LIKE ? ESCAPE '\\'
          AND ((s.scope_type = 'user' AND s.scope_id = ?)
            OR (s.scope_type = 'dept' AND s.scope_id IN (${deptIds.map(() => '?').join(',') || 'NULL'}))
            OR s.scope_type = 'company')
        LIMIT 1`,
    )
    .get(
      actor.subject.companyId,
      actor.subject.userId,
      folderLikePrefix(folderPath),
      actor.subject.userId,
      ...deptIds,
    )
  return Boolean(row)
}

function assertFolderAncestorsFree(
  deps: ServerDeps,
  actor: RequestActor,
  folderPath: string,
): void {
  const segments = folderPath.split('/')
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = segments.slice(0, index).join('/')
    const row = deps.db
      .prepare(
        `SELECT id FROM workspace_files
          WHERE company_id = ? AND scope_type = 'user' AND scope_id = ? AND owner_user_id = ?
            AND deleted_at IS NULL AND rel_path = ?`,
      )
      .get(actor.subject.companyId, actor.subject.userId, actor.subject.userId, ancestor)
    if (row) {
      throw new EabError(EC.VALIDATION, `上级路径「${ancestor}」已被同名文件占用`, {
        hint: '请先重命名或删除那个文件。',
      })
    }
  }
}

function folderDiskPath(deps: ServerDeps, actor: RequestActor, folderPath: string): string {
  const root = userScopeDir(deps, actor.subject.companyId, actor.subject.userId)
  return safeJoin(root, folderPath)
}

function removeEmptyDirectories(dir: string): void {
  if (!existsSync(dir)) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    try {
      if (statSync(full).isDirectory()) removeEmptyDirectories(full)
    } catch {
      // 已被并发删除的条目不再处理
    }
  }
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
  } catch {
    // 目录非空或正被占用时保留，不影响已经提交的删除
  }
}

export interface CreatedWorkspaceFolder {
  folderPath: string
  row: FileRow
}

/** 新建个人云空间文件夹；用 `.gitkeep` 占位，让空文件夹在列表和 Agent 视角里都可见。 */
export function createUserWorkspaceFolder(
  deps: ServerDeps,
  actor: RequestActor,
  input: string,
): CreatedWorkspaceFolder {
  const folderPath = normalizeWorkspaceFolderPath(input)
  assertFolderAncestorsFree(deps, actor, folderPath)
  const existing = userFolderRows(deps, actor, folderPath)
  if (existing.some((row) => row.rel_path === folderPath)) {
    throw new EabError(EC.VALIDATION, '同名文件已占用该路径', { hint: '请换一个文件夹名称。' })
  }
  if (existing.length > 0) {
    throw new EabError(EC.VALIDATION, '文件夹已存在', { hint: '直接点文件夹进入，或换一个名称。' })
  }
  const folderDir = folderDiskPath(deps, actor, folderPath)
  if (existsSync(folderDir)) {
    if (!statSync(folderDir).isDirectory() || readdirSync(folderDir).length > 0) {
      throw new EabError(EC.VALIDATION, '磁盘上已有同名目录或文件', {
        hint: '请换一个文件夹名称，或先清理该目录。',
      })
    }
  }
  mkdirSync(folderDir, { recursive: true })
  const placeholderPath = join(folderDir, '.gitkeep')
  const placeholderRel = `${folderPath}/.gitkeep`
  writeFileSync(placeholderPath, '')
  const now = Date.now()
  const id = ulid()
  deps.db
    .prepare(
      `INSERT INTO workspace_files
         (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, mime, storage_path, created_at, updated_at)
       VALUES (?, ?, 'user', ?, ?, ?, '.gitkeep', 0, 'text/plain', ?, ?, ?)`,
    )
    .run(
      id,
      actor.subject.companyId,
      actor.subject.userId,
      actor.subject.userId,
      placeholderRel,
      placeholderPath,
      now,
      now,
    )
  const row = deps.db.prepare('SELECT * FROM workspace_files WHERE id = ?').get(id) as unknown as FileRow
  publishWorkspaceFilesChanged(actor.subject.companyId, actor.subject.userId, 'created', [id])
  return { folderPath, row }
}

export interface RenamedWorkspaceFolder {
  from: string
  to: string
  fileCount: number
  fileIds: string[]
}

/** 重命名个人云空间文件夹：整棵目录搬移，并同步所有后代文件的 rel_path / storage_path。 */
export function renameUserWorkspaceFolder(
  deps: ServerDeps,
  actor: RequestActor,
  input: string,
  nextNameInput: string,
): RenamedWorkspaceFolder {
  const from = normalizeWorkspaceFolderPath(input)
  const leaf = normalizeFolderLeafName(nextNameInput)
  const slash = from.lastIndexOf('/')
  const parent = slash < 0 ? '' : from.slice(0, slash)
  const to = normalizeWorkspaceFolderPath(parent ? `${parent}/${leaf}` : leaf)
  if (from === to) {
    const rows = userFolderRows(deps, actor, from).filter((row) => row.rel_path !== from)
    return { from, to, fileCount: rows.filter((row) => row.name !== '.gitkeep').length, fileIds: rows.map((row) => row.id) }
  }

  const rows = userFolderRows(deps, actor, from)
  if (rows.length === 0) throw new EabError(EC.NOT_FOUND, `文件夹不存在: ${from}`)
  if (rows.some((row) => row.rel_path === from)) {
    throw new EabError(EC.VALIDATION, `「${from}」是一个文件，不是文件夹`)
  }
  if (folderHasForeignSharedFiles(deps, actor, from)) {
    throw new EabError(EC.VALIDATION, '文件夹里有其他成员共享的文件，暂不支持整体重命名', {
      hint: '请先处理这些共享文件，或逐个重命名自己的文件。',
    })
  }

  const root = userScopeDir(deps, actor.subject.companyId, actor.subject.userId)
  const sourceDir = folderDiskPath(deps, actor, from)
  const targetDir = folderDiskPath(deps, actor, to)
  assertFolderAncestorsFree(deps, actor, to)

  const targetConflict = deps.db
    .prepare(
      `SELECT id, rel_path FROM workspace_files
        WHERE company_id = ? AND scope_type = 'user' AND scope_id = ? AND owner_user_id = ?
          AND deleted_at IS NULL
          AND (rel_path = ? OR rel_path LIKE ? ESCAPE '\\')
          AND rel_path <> ?
          AND NOT (rel_path LIKE ? ESCAPE '\\')
        LIMIT 1`,
    )
    .get(
      actor.subject.companyId,
      actor.subject.userId,
      actor.subject.userId,
      to,
      folderLikePrefix(to),
      from,
      folderLikePrefix(from),
    ) as { id: string; rel_path: string } | undefined
  if (targetConflict) {
    throw new EabError(EC.VALIDATION, `目标路径已被「${targetConflict.rel_path}」占用`, {
      hint: '请换一个文件夹名称。',
    })
  }
  const caseOnly = sourceDir.toLowerCase() === targetDir.toLowerCase()
  if (existsSync(targetDir) && !caseOnly) {
    throw new EabError(EC.VALIDATION, '磁盘上已有同名目录或文件', { hint: '请换一个文件夹名称。' })
  }

  const moved: Array<{ from: string; to: string }> = []
  let movedTree = false
  try {
    if (existsSync(sourceDir)) {
      mkdirSync(dirname(targetDir), { recursive: true })
      if (caseOnly) {
        const tempDir = `${sourceDir}.rename-${ulid()}`
        renameSync(sourceDir, tempDir)
        renameSync(tempDir, targetDir)
      } else {
        renameSync(sourceDir, targetDir)
      }
      movedTree = true
    } else {
      for (const row of rows) {
        const current = diskPathOf(deps, row)
        if (!existsSync(current)) continue
        const suffix = row.rel_path === from ? '' : row.rel_path.slice(from.length + 1)
        const nextRel = suffix ? `${to}/${suffix}` : to
        const next = safeJoin(root, nextRel)
        mkdirSync(dirname(next), { recursive: true })
        renameSync(current, next)
        moved.push({ from: current, to: next })
      }
    }

    const now = Date.now()
    withTransaction(deps.db, () => {
      for (const row of rows) {
        const suffix = row.rel_path === from ? '' : row.rel_path.slice(from.length + 1)
        const nextRel = suffix ? `${to}/${suffix}` : to
        const nextDisk = safeJoin(root, nextRel)
        deps.db
          .prepare('UPDATE workspace_files SET rel_path = ?, storage_path = ?, updated_at = ? WHERE id = ?')
          .run(nextRel, nextDisk, now, row.id)
      }
    })
  } catch (error) {
    try {
      for (const item of moved.reverse()) {
        if (existsSync(item.to)) {
          mkdirSync(dirname(item.from), { recursive: true })
          renameSync(item.to, item.from)
        }
      }
      if (movedTree && existsSync(targetDir) && !existsSync(sourceDir)) {
        renameSync(targetDir, sourceDir)
      }
    } catch {
      // 回滚失败时保留原始错误，交给上层暴露部分完成状态
    }
    throw error
  }

  publishWorkspaceFilesChanged(actor.subject.companyId, actor.subject.userId, 'renamed', rows.map((row) => row.id))
  return {
    from,
    to,
    fileCount: rows.filter((row) => row.name !== '.gitkeep').length,
    fileIds: rows.map((row) => row.id),
  }
}

export interface DeletedWorkspaceFolder {
  folderPath: string
  fileCount: number
  fileIds: string[]
}

/** 删除个人云空间文件夹：所有后代文件逐个软删到回收区，最后清理空目录。 */
export function deleteUserWorkspaceFolder(
  deps: ServerDeps,
  actor: RequestActor,
  input: string,
): DeletedWorkspaceFolder {
  const folderPath = normalizeWorkspaceFolderPath(input)
  const rows = userFolderRows(deps, actor, folderPath)
  if (rows.length === 0) throw new EabError(EC.NOT_FOUND, `文件夹不存在: ${folderPath}`)
  if (rows.some((row) => row.rel_path === folderPath)) {
    throw new EabError(EC.VALIDATION, `「${folderPath}」是一个文件，不是文件夹`)
  }
  if (folderHasForeignSharedFiles(deps, actor, folderPath)) {
    throw new EabError(EC.VALIDATION, '文件夹里有其他成员共享的文件，暂不支持整体删除', {
      hint: '请先处理这些共享文件，或逐个删除自己的文件。',
    })
  }

  const scopeDirPath = userScopeDir(deps, actor.subject.companyId, actor.subject.userId)
  const folderDir = folderDiskPath(deps, actor, folderPath)
  const recycleDir = join(scopeDirPath, '_recycle')
  mkdirSync(recycleDir, { recursive: true })
  const moves: Array<{ from: string; to: string }> = []
  try {
    for (const row of rows) {
      const current = diskPathOf(deps, row)
      if (!existsSync(current)) continue
      const recycled = join(recycleDir, `${row.id}-${row.name}`)
      if (existsSync(recycled)) rmSync(recycled, { force: true })
      renameSync(current, recycled)
      moves.push({ from: current, to: recycled })
    }

    const now = Date.now()
    const totalSize = rows.reduce((sum, row) => sum + Math.max(0, Number(row.size) || 0), 0)
    withTransaction(deps.db, () => {
      for (const row of rows) {
        const recycled = join(recycleDir, `${row.id}-${row.name}`)
        deps.db
          .prepare('UPDATE workspace_files SET deleted_at = ?, recycled_path = ? WHERE id = ?')
          .run(now, recycled, row.id)
      }
      if (totalSize > 0) {
        addUsage(deps, actor.subject.companyId, 'user', actor.subject.userId, -totalSize)
        addUsage(deps, actor.subject.companyId, 'company', actor.subject.companyId, -totalSize)
      }
    })
  } catch (error) {
    try {
      for (const item of moves.reverse()) {
        if (existsSync(item.to)) {
          mkdirSync(dirname(item.from), { recursive: true })
          renameSync(item.to, item.from)
        }
      }
    } catch {
      // 回滚失败时保留原始错误
    }
    throw error
  }

  for (const row of rows) dropChatAttachmentObject(deps, row)
  publishWorkspaceFilesChanged(actor.subject.companyId, actor.subject.userId, 'deleted', rows.map((row) => row.id))
  removeEmptyDirectories(folderDir)
  return {
    folderPath,
    fileCount: rows.filter((row) => row.name !== '.gitkeep').length,
    fileIds: rows.map((row) => row.id),
  }
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

/** 每个文件最多保留最近 20 个保存前快照；旧快照按创建时间清理，避免磁盘无限增长。 */
const WORKSPACE_VERSION_RETENTION = 20

interface WorkspaceVersionRow {
  id: string
  company_id: string
  file_id: string
  version: number
  size: number
  storage_path: string
  operation_id: string | null
  source: string
  summary: string | null
  created_by: string
  created_at: number
}

interface WorkspaceVersionInput {
  readonly source: string
  readonly operationId: string
  readonly summary?: string
  readonly createdBy: string
}

function versionExtOf(name: string): string {
  const ext = extname(name).toLowerCase()
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.bin'
}

function versionDirOf(deps: ServerDeps, row: FileRow): string {
  return join(scopeDir(deps, row.company_id, row.scope_type, row.scope_id), '_versions', toSlug(row.id, 'f'))
}

/**
 * 在覆盖文件前把当前磁盘内容复制到 `_versions/<fileId>/`，并写一条版本记录。
 * 同一 `updated_at` 已存在快照时直接复用，避免回调重试产生重复副本。
 * 快照失败必须中断写入，否则会留下“已改但无法回退”的文件。
 */
function snapshotWorkspaceVersion(
  deps: ServerDeps,
  row: FileRow,
  input: WorkspaceVersionInput,
): WorkspaceVersionRow {
  const existing = deps.db
    .prepare(
      `SELECT * FROM workspace_file_versions
        WHERE file_id = ? AND version = ? LIMIT 1`,
    )
    .get(row.id, row.updated_at) as unknown as WorkspaceVersionRow | undefined
  if (existing) return existing

  const sourcePath = diskPathOf(deps, row)
  if (!existsSync(sourcePath)) throw new EabError(EC.NOT_FOUND, '原文件不在磁盘，无法创建版本快照')
  const id = `ver_${ulid()}`
  const dir = versionDirOf(deps, row)
  mkdirSync(dir, { recursive: true })
  const storagePath = join(dir, `${row.updated_at}-${id}${versionExtOf(row.name)}`)
  copyFileSync(sourcePath, storagePath)
  const now = Date.now()
  try {
    deps.db
      .prepare(
        `INSERT INTO workspace_file_versions
          (id, company_id, file_id, version, size, storage_path, operation_id, source, summary, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.company_id,
        row.id,
        row.updated_at,
        row.size,
        storagePath,
        input.operationId,
        input.source,
        input.summary ?? null,
        input.createdBy,
        now,
      )
  } catch (error) {
    rmSync(storagePath, { force: true })
    throw error
  }

  // 只保留最近 N 条；先删记录再删文件，避免清理中断留下无主文件。
  const expired = deps.db
    .prepare(
      `SELECT id, storage_path FROM workspace_file_versions
        WHERE file_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT -1 OFFSET ?`,
    )
    .all(row.id, WORKSPACE_VERSION_RETENTION) as unknown as Array<{ id: string; storage_path: string }>
  for (const item of expired) {
    deps.db.prepare('DELETE FROM workspace_file_versions WHERE id = ?').run(item.id)
    rmSync(item.storage_path, { force: true })
  }

  return deps.db
    .prepare('SELECT * FROM workspace_file_versions WHERE id = ?')
    .get(id) as unknown as WorkspaceVersionRow
}

function versionListRow(row: WorkspaceVersionRow) {
  return {
    id: row.id,
    version: row.version,
    size: row.size,
    source: row.source,
    operationId: row.operation_id,
    summary: row.summary,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

/** 版本历史只给文件本人看；共享文件不暴露旧内容。 */
export function listWorkspaceFileVersions(
  deps: ServerDeps,
  actor: RequestActor,
  fileId: string,
): ReturnType<typeof versionListRow>[] {
  requireEnabled(actor)
  const row = deps.db
    .prepare('SELECT * FROM workspace_files WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
    .get(fileId, actor.subject.companyId) as unknown as FileRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在')
  if (row.owner_user_id !== actor.subject.userId) throw new EabError(EC.FORBIDDEN, '只能查看自己的文件版本')
  const versions = deps.db
    .prepare(
      `SELECT * FROM workspace_file_versions
        WHERE company_id = ? AND file_id = ?
        ORDER BY created_at DESC, id DESC`,
    )
    .all(actor.subject.companyId, fileId) as unknown as WorkspaceVersionRow[]
  return versions.map(versionListRow)
}

/** 手动把当前版本存为快照；没有变化时复用已有快照，返回 created=false。 */
export function createWorkspaceFileSnapshot(
  deps: ServerDeps,
  actor: RequestActor,
  fileId: string,
): ReturnType<typeof versionListRow> & { created: boolean } {
  requireEnabled(actor)
  const row = deps.db
    .prepare('SELECT * FROM workspace_files WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
    .get(fileId, actor.subject.companyId) as unknown as FileRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在')
  if (row.owner_user_id !== actor.subject.userId) throw new EabError(EC.FORBIDDEN, '只能给自己的文件创建版本快照')
  const existed = deps.db
    .prepare('SELECT id FROM workspace_file_versions WHERE file_id = ? AND version = ? LIMIT 1')
    .get(fileId, row.updated_at) as { id?: string } | undefined
  const version = snapshotWorkspaceVersion(deps, row, {
    source: 'workspace.snapshot',
    operationId: `op_${ulid()}`,
    summary: '手动版本快照',
    createdBy: actor.subject.userId,
  })
  return { ...versionListRow(version), created: !existed }
}

export function readWorkspaceFileVersion(
  deps: ServerDeps,
  actor: RequestActor,
  fileId: string,
  versionId: string,
): { row: FileRow; version: WorkspaceVersionRow; buffer: Buffer } {
  requireEnabled(actor)
  const row = deps.db
    .prepare('SELECT * FROM workspace_files WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
    .get(fileId, actor.subject.companyId) as unknown as FileRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在')
  if (row.owner_user_id !== actor.subject.userId) throw new EabError(EC.FORBIDDEN, '只能读取自己的文件版本')
  const version = deps.db
    .prepare(
      `SELECT * FROM workspace_file_versions
        WHERE id = ? AND company_id = ? AND file_id = ? LIMIT 1`,
    )
    .get(versionId, actor.subject.companyId, fileId) as unknown as WorkspaceVersionRow | undefined
  if (!version) throw new EabError(EC.NOT_FOUND, '版本不存在或已被清理')
  if (!existsSync(version.storage_path)) throw new EabError(EC.NOT_FOUND, '版本快照已不在磁盘')
  return { row, version, buffer: readFileSync(version.storage_path) }
}

/** 恢复到指定历史版本：先把当前版本再存一份，保证恢复本身也可回退。 */
export function restoreWorkspaceFileVersion(
  deps: ServerDeps,
  actor: RequestActor,
  fileId: string,
  versionId: string,
): { file: WorkspaceFileEditResult; restoredVersion: ReturnType<typeof versionListRow> } {
  const { row, version, buffer } = readWorkspaceFileVersion(deps, actor, fileId, versionId)
  const file = editUserWorkspaceFile(deps, actor, fileId, buffer, {
    source: 'workspace.restore',
    operationId: `op_${ulid()}`,
    baseVersion: row.updated_at,
    restoredFromVersion: version.version,
    summary: `恢复到 ${new Date(version.created_at).toLocaleString('zh-CN')} 的历史版本`,
  })
  return { file, restoredVersion: versionListRow(version) }
}


function deptIdsOf(actor: ReturnType<typeof resolveActor>): string[] {
  return actor.subject.deptChain
    .flatMap((item) => item.split('/').filter(Boolean))
    .filter((item) => item.startsWith('d_') || /^d\d+$/.test(item) || item.length > 1)
    .filter((item) => item !== actor.subject.companyId)
}

/**
 * GUI 兜底：只允许少量 L1/L2 没有 API 的原生入口。
 * 服务器不执行任意宏、不按坐标点击、不读写用户桌面；这里只负责白名单、
 * 用户确认与结果审计，具体点击由用户在 OnlyOffice 界面完成。
 */
export type WorkspaceGuiActionId = 'print' | 'macro' | 'export' | 'dialog'
export type WorkspaceGuiFallbackStatus = 'prepared' | 'confirmed' | 'succeeded' | 'failed' | 'expired'

interface WorkspaceGuiDialogDef {
  readonly label: string
  readonly description: string
  readonly steps: readonly string[]
}

const WORKSPACE_GUI_DIALOGS: Record<string, WorkspaceGuiDialogDef> = {
  page_setup: {
    label: '页面设置',
    description: '设置纸张、方向、页边距和版式；仅在 docx 预览中开放。',
    steps: [
      '在 OnlyOffice 顶部工具栏打开“布局”选项卡，点击“页面设置”。',
      '在原生对话框中调整纸张、方向、页边距或版式。',
      '确认后点击“确定”；如果只是查看设置，可以直接取消，不会改动云空间文件。',
    ],
  },
  header_footer: {
    label: '页眉页脚',
    description: '编辑页眉、页脚、页码和首页不同；仅在 docx 预览中开放。',
    steps: [
      '在 OnlyOffice 顶部工具栏打开“插入”选项卡，选择“页眉/页脚”。',
      '在原生面板里编辑页眉页脚内容，或设置首页不同、奇偶页不同。',
      '完成后关闭面板并按需保存；EAB 不会代替你提交这些原生设置。',
    ],
  },
}

const WORKSPACE_GUI_ACTIONS: Record<WorkspaceGuiActionId, {
  readonly label: string
  readonly description: string
  readonly mode: OfficeMode
}> = {
  print: {
    label: '打印 / 打印设置',
    description: '打开 OnlyOffice 原生打印对话框，确认打印机、纸张、方向和页码范围。',
    mode: 'view',
  },
  macro: {
    label: '宏管理器',
    description: '打开 OnlyOffice 宏管理器；EAB 不读取、不保存、不自动执行宏代码。',
    mode: 'edit',
  },
  export: {
    label: '导出选项',
    description: '打开 OnlyOffice 原生导出/另存为入口，选择格式和本地保存位置。',
    mode: 'view',
  },
  dialog: {
    label: 'OnlyOffice 原生对话框',
    description: '打开页面设置、页眉页脚等没有 API 的原生对话框。',
    mode: 'edit',
  },
}

const WORKSPACE_GUI_EXPORT_FORMATS = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'csv'])

export interface WorkspaceGuiFallbackResult {
  readonly fallbackId: string
  readonly fileId: string
  readonly fileName: string
  readonly fileVersion: number
  readonly guiAction: string
  readonly guiLabel: string
  readonly guiDescription: string
  readonly mode: OfficeMode
  readonly status: WorkspaceGuiFallbackStatus
  readonly steps: string[]
  readonly params: Record<string, string>
  readonly note: string | null
  readonly attempts: number
  readonly requiresUserConfirmation: boolean
  readonly canReport: boolean
  readonly createdAt: number
  readonly expiresAt: number
  readonly confirmedAt: number | null
  readonly finishedAt: number | null
}

interface WorkspaceGuiFallbackRow {
  id: string
  company_id: string
  file_id: string
  user_id: string
  gui_action: string
  gui_label: string
  mode: string
  params_json: string
  steps_json: string
  status: WorkspaceGuiFallbackStatus
  attempts: number
  note: string | null
  detail_json: string | null
  created_at: number
  expires_at: number
  confirmed_at: number | null
  finished_at: number | null
}

interface WorkspaceGuiAuditContext {
  readonly actor: RequestActor
  readonly traceId?: string
  readonly ip?: string
  readonly channel?: 'web' | 'agent'
}

const WORKSPACE_GUI_FALLBACK_TTL_MS = 10 * 60 * 1000

function guiFallbackSteps(action: WorkspaceGuiActionId, params: Record<string, string>): string[] {
  if (action === 'print') {
    return [
      '在 OnlyOffice 顶部工具栏打开“文件”菜单，选择“打印”。',
      '在打印对话框里确认打印机、纸张、方向、页边距和页码范围。',
      '确认无误后点击“打印”；只调整设置时可以直接取消，不会改动云空间文件。',
    ]
  }
  if (action === 'macro') {
    return [
      '切换到“视图”选项卡，点击“宏”打开宏管理器。',
      '选择已有宏或粘贴宏代码；EAB 不会读取、保存或自动执行宏内容。',
      '确认宏来源可信后手动运行；运行后按需保存文档，并检查结果。',
    ]
  }
  if (action === 'export') {
    const format = params.format || 'PDF 或原格式'
    return [
      '打开“文件”菜单，选择“导出为”或“另存为”。',
      `选择目标格式（${format}）和导出选项，确认保存位置。`,
      '导出只生成本地副本，不会覆盖云空间文件；需要云端 PDF 时再使用“导出 PDF”。',
    ]
  }
  const dialog = WORKSPACE_GUI_DIALOGS[params.dialog || '']
  return dialog ? [...dialog.steps] : ['在 OnlyOffice 原生界面中完成所选操作。']
}

function guiFallbackView(row: WorkspaceGuiFallbackRow, file: FileRow): WorkspaceGuiFallbackResult {
  const action = row.gui_action as WorkspaceGuiActionId
  const def = WORKSPACE_GUI_ACTIONS[action] ?? WORKSPACE_GUI_ACTIONS.print
  let params: Record<string, string> = {}
  try {
    const parsed = JSON.parse(row.params_json) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') params[key] = value
      }
    }
  } catch {
    params = {}
  }
  let steps: string[] = []
  try {
    const parsed = JSON.parse(row.steps_json) as unknown
    if (Array.isArray(parsed)) steps = parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    steps = []
  }
  const status = row.status === 'prepared' && row.expires_at <= Date.now() ? 'expired' : row.status
  return {
    fallbackId: row.id,
    fileId: row.file_id,
    fileName: file.name,
    fileVersion: Number(file.updated_at),
    guiAction: row.gui_action,
    guiLabel: row.gui_label,
    guiDescription: def.description,
    mode: (row.mode === 'edit' ? 'edit' : 'view') as OfficeMode,
    status,
    steps,
    params,
    note: row.note,
    attempts: row.attempts,
    requiresUserConfirmation: status === 'prepared',
    canReport: status === 'confirmed',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
    finishedAt: row.finished_at,
  }
}

function auditGuiFallback(
  deps: ServerDeps,
  ctx: WorkspaceGuiAuditContext,
  file: FileRow,
  row: WorkspaceGuiFallbackRow | null,
  phase: string,
  result: 'success' | 'failure',
  detail: Record<string, unknown> = {},
): void {
  appendAudit(deps.db, {
    companyId: ctx.actor.subject.companyId,
    actorUserId: ctx.actor.subject.userId,
    action: 'workspace.file.agent_gui',
    resourceType: 'file',
    resourceId: file.id,
    resourceScope: `${file.scope_type}:${file.scope_id}`,
    result,
    detail: {
      phase,
      guiAction: row?.gui_action ?? detail.guiAction ?? null,
      guiLabel: row?.gui_label ?? null,
      mode: row?.mode ?? null,
      ...(row ? { fallbackId: row.id, attempts: row.attempts, status: row.status } : {}),
      ...detail,
    },
    traceId: ctx.traceId ?? null,
    ip: ctx.ip ?? null,
    channel: ctx.channel ?? 'web',
  })
}

function resolveGuiFallbackFile(deps: ServerDeps, actor: RequestActor, fileId: string): FileRow {
  const row = deps.db
    .prepare(
      `SELECT * FROM workspace_files
        WHERE id = ? AND company_id = ? AND owner_user_id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .get(fileId, actor.subject.companyId, actor.subject.userId) as unknown as FileRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, '云空间里没有找到该文件，或你不是文件本人')
  return row
}

function resolveGuiFallbackInputFile(
  deps: ServerDeps,
  actor: RequestActor,
  input: { fileId?: string; path?: string },
): FileRow {
  const fileId = String(input.fileId ?? '').trim()
  const relPath = String(input.path ?? '').trim()
  let row: FileRow | undefined
  if (fileId) {
    row = deps.db
      .prepare(
        `SELECT * FROM workspace_files
          WHERE id = ? AND company_id = ? AND owner_user_id = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(fileId, actor.subject.companyId, actor.subject.userId) as unknown as FileRow | undefined
  } else if (relPath) {
    row = deps.db
      .prepare(
        `SELECT * FROM workspace_files
          WHERE company_id = ? AND owner_user_id = ? AND deleted_at IS NULL
            AND (rel_path = ? OR name = ?)
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(actor.subject.companyId, actor.subject.userId, relPath, relPath) as unknown as FileRow | undefined
  } else {
    throw new EabError(EC.VALIDATION, 'fileId 和 path 至少提供一个')
  }
  if (!row) throw new EabError(EC.NOT_FOUND, '云空间里没有找到该文件')
  return row
}

function normalizeGuiAction(value: unknown): WorkspaceGuiActionId {
  const action = String(value ?? 'print').trim().toLowerCase()
  if (!Object.prototype.hasOwnProperty.call(WORKSPACE_GUI_ACTIONS, action)) {
    throw new EabError(EC.VALIDATION, `GUI 兜底动作不在白名单内: ${action || '空'}`, {
      details: { allowedActions: Object.keys(WORKSPACE_GUI_ACTIONS) },
      hint: '只支持 print、macro、export、dialog；不要尝试任意宏、坐标点击或未列出的原生按钮',
    })
  }
  return action as WorkspaceGuiActionId
}

function normalizeGuiParams(file: FileRow, action: WorkspaceGuiActionId, input: {
  dialog?: string
  format?: string
  note?: string
}): { params: Record<string, string>; note: string | null } {
  const params: Record<string, string> = {}
  if (action === 'dialog') {
    const dialog = String(input.dialog ?? '').trim().toLowerCase()
    if (!dialog || !Object.prototype.hasOwnProperty.call(WORKSPACE_GUI_DIALOGS, dialog)) {
      throw new EabError(EC.VALIDATION, `原生对话框不在白名单内: ${dialog || '空'}`, {
        details: { allowedDialogs: Object.keys(WORKSPACE_GUI_DIALOGS) },
        hint: 'dialog 只能是 page_setup 或 header_footer，且仅支持 docx',
      })
    }
    if (!/\.docx$/i.test(file.name)) {
      throw new EabError(EC.VALIDATION, `${file.name} 不支持这个 docx 原生对话框`)
    }
    params.dialog = dialog
  }
  if (typeof input.format === 'string' && input.format.trim()) {
    const format = input.format.trim().toLowerCase()
    if (!WORKSPACE_GUI_EXPORT_FORMATS.has(format)) {
      throw new EabError(EC.VALIDATION, `导出格式不在白名单内: ${format}`, {
        details: { allowedFormats: [...WORKSPACE_GUI_EXPORT_FORMATS] },
      })
    }
    params.format = format
  }
  const note = typeof input.note === 'string' ? input.note.replace(/[\u0000-\u001f]/g, ' ').trim() : ''
  if (note.length > 200) throw new EabError(EC.VALIDATION, 'note 最多 200 字')
  return { params, note: note || null }
}

export interface PrepareWorkspaceGuiFallbackInput {
  readonly fileId?: string
  readonly path?: string
  readonly action?: string
  readonly dialog?: string
  readonly format?: string
  readonly note?: string
}

/** 准备一次 GUI 兜底：只落状态和审计，不执行任何桌面操作。 */
export function prepareWorkspaceGuiFallback(
  deps: ServerDeps,
  ctx: WorkspaceGuiAuditContext,
  input: PrepareWorkspaceGuiFallbackInput,
): WorkspaceGuiFallbackResult {
  const actor = ctx.actor
  requireEnabled(actor)
  const file = resolveGuiFallbackInputFile(deps, actor, input)
  if (!officeDocumentType(file.name, file.mime)) {
    throw new EabError(EC.VALIDATION, `${file.name} 不是 docx/xlsx/pptx，不能使用 Office GUI 兜底`)
  }
  const action = normalizeGuiAction(input.action)
  const { params, note } = normalizeGuiParams(file, action, input)
  const dialogDef = action === 'dialog' ? WORKSPACE_GUI_DIALOGS[params.dialog] : null
  const def = WORKSPACE_GUI_ACTIONS[action]
  const guiLabel = dialogDef ? `OnlyOffice 原生对话框 · ${dialogDef.label}` : def.label
  const steps = guiFallbackSteps(action, params)
  const now = Date.now()
  const expiresAt = now + WORKSPACE_GUI_FALLBACK_TTL_MS
  const id = `gui_${ulid()}`
  const mode = action === 'dialog' ? 'edit' : def.mode
  deps.db
    .prepare(
      `INSERT INTO workspace_gui_fallbacks
        (id, company_id, file_id, user_id, gui_action, gui_label, mode, params_json, steps_json,
         status, attempts, note, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 0, ?, ?, ?)`,
    )
    .run(
      id,
      file.company_id,
      file.id,
      actor.subject.userId,
      action,
      guiLabel,
      mode,
      JSON.stringify(params),
      JSON.stringify(steps),
      note,
      now,
      expiresAt,
    )
  const row = deps.db
    .prepare('SELECT * FROM workspace_gui_fallbacks WHERE id = ?')
    .get(id) as unknown as WorkspaceGuiFallbackRow
  auditGuiFallback(deps, ctx, file, row, 'prepared', 'success', {
    guiAction: action,
    guiLabel,
    mode,
    stepCount: steps.length,
    expiresAt,
    note,
  })
  return guiFallbackView(row, file)
}

function readGuiFallbackRow(
  deps: ServerDeps,
  actor: RequestActor,
  file: FileRow,
  fallbackId: string,
): WorkspaceGuiFallbackRow {
  const id = String(fallbackId ?? '').trim()
  if (!id) throw new EabError(EC.VALIDATION, 'fallbackId 必填')
  const row = deps.db
    .prepare(
      `SELECT * FROM workspace_gui_fallbacks
        WHERE id = ? AND company_id = ? AND file_id = ? AND user_id = ? LIMIT 1`,
    )
    .get(id, actor.subject.companyId, file.id, actor.subject.userId) as unknown as WorkspaceGuiFallbackRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, 'GUI 兜底记录不存在')
  return row
}

function expireGuiFallback(
  deps: ServerDeps,
  ctx: WorkspaceGuiAuditContext,
  file: FileRow,
  row: WorkspaceGuiFallbackRow,
): WorkspaceGuiFallbackRow {
  if (row.status !== 'prepared' && row.status !== 'confirmed') return row
  deps.db
    .prepare("UPDATE workspace_gui_fallbacks SET status = 'expired', finished_at = ? WHERE id = ? AND status IN ('prepared','confirmed')")
    .run(Date.now(), row.id)
  const expired = deps.db
    .prepare('SELECT * FROM workspace_gui_fallbacks WHERE id = ?')
    .get(row.id) as unknown as WorkspaceGuiFallbackRow
  auditGuiFallback(deps, ctx, file, expired, 'expired', 'failure', { reason: 'confirmation_expired' })
  return expired
}

/** 用户确认后才允许执行/上报；Agent 不能自行确认。 */
export function confirmWorkspaceGuiFallback(
  deps: ServerDeps,
  ctx: WorkspaceGuiAuditContext,
  fileId: string,
  fallbackId: string,
): WorkspaceGuiFallbackResult {
  const actor = ctx.actor
  requireEnabled(actor)
  const file = resolveGuiFallbackFile(deps, actor, fileId)
  let row = readGuiFallbackRow(deps, actor, file, fallbackId)
  if (row.status === 'prepared' && row.expires_at <= Date.now()) row = expireGuiFallback(deps, ctx, file, row)
  if (row.status === 'expired') throw new EabError(EC.CONFLICT, 'GUI 兜底确认已过期，请重新发起')
  if (row.status !== 'prepared') {
    throw new EabError(EC.CONFLICT, `当前状态是 ${row.status}，不能重复确认`, {
      details: { status: row.status, fallbackId: row.id },
    })
  }
  const now = Date.now()
  const changed = deps.db
    .prepare("UPDATE workspace_gui_fallbacks SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND status = 'prepared'")
    .run(now, row.id)
  if (!Number(changed.changes)) throw new EabError(EC.CONFLICT, 'GUI 兜底已被其他请求确认，请刷新状态')
  row = deps.db
    .prepare('SELECT * FROM workspace_gui_fallbacks WHERE id = ?')
    .get(row.id) as unknown as WorkspaceGuiFallbackRow
  auditGuiFallback(deps, ctx, file, row, 'confirmed', 'success', { confirmedAt: now })
  return guiFallbackView(row, file)
}

/** 上报人工结果；失败后同一条记录不得再次确认或上报。 */
export function reportWorkspaceGuiFallback(
  deps: ServerDeps,
  ctx: WorkspaceGuiAuditContext,
  fileId: string,
  fallbackId: string,
  status: 'success' | 'failure',
  detail?: string,
): WorkspaceGuiFallbackResult {
  const actor = ctx.actor
  requireEnabled(actor)
  const file = resolveGuiFallbackFile(deps, actor, fileId)
  let row = readGuiFallbackRow(deps, actor, file, fallbackId)
  if (row.status === 'prepared') throw new EabError(EC.CONFLICT, '还没有经过用户确认，不能上报结果')
  if (row.status === 'expired') throw new EabError(EC.CONFLICT, 'GUI 兜底已过期，请重新发起')
  if (row.status !== 'confirmed') {
    throw new EabError(EC.CONFLICT, `当前状态是 ${row.status}，结果已结束；失败后不会自动重试，请重新发起`, {
      details: { status: row.status, attempts: row.attempts, fallbackId: row.id },
    })
  }
  if (status !== 'success' && status !== 'failure') {
    throw new EabError(EC.VALIDATION, "result 只能是 success 或 failure")
  }
  const reason = typeof detail === 'string' ? detail.replace(/[\u0000-\u001f]/g, ' ').trim() : ''
  if (status === 'failure' && !reason) throw new EabError(EC.VALIDATION, '失败时必须填写原因，失败后不会自动重试')
  if (reason.length > 500) throw new EabError(EC.VALIDATION, 'detail 最多 500 字')
  const now = Date.now()
  const nextStatus: WorkspaceGuiFallbackStatus = status === 'success' ? 'succeeded' : 'failed'
  const changed = deps.db
    .prepare(
      `UPDATE workspace_gui_fallbacks
          SET status = ?, attempts = attempts + 1, finished_at = ?, detail_json = ?
        WHERE id = ? AND status = 'confirmed'`,
    )
    .run(nextStatus, now, JSON.stringify({ result: status, reason: reason || null }), row.id)
  if (!Number(changed.changes)) throw new EabError(EC.CONFLICT, '偏底状态已变化，请刷新后重试')
  row = deps.db
    .prepare('SELECT * FROM workspace_gui_fallbacks WHERE id = ?')
    .get(row.id) as unknown as WorkspaceGuiFallbackRow
  auditGuiFallback(
    deps,
    ctx,
    file,
    row,
    status === 'success' ? 'succeeded' : 'failed',
    status === 'success' ? 'success' : 'failure',
    { reason: reason || null, attempts: row.attempts },
  )
  return guiFallbackView(row, file)
}

/** 查询状态；过期的准备状态会顺手落为 expired，并写审计。 */
export function getWorkspaceGuiFallback(
  deps: ServerDeps,
  ctx: WorkspaceGuiAuditContext,
  fileId: string,
  fallbackId: string,
): WorkspaceGuiFallbackResult {
  const actor = ctx.actor
  requireEnabled(actor)
  const file = resolveGuiFallbackFile(deps, actor, fileId)
  let row = readGuiFallbackRow(deps, actor, file, fallbackId)
  if ((row.status === 'prepared' || row.status === 'confirmed') && row.expires_at <= Date.now()) {
    row = expireGuiFallback(deps, ctx, file, row)
  }
  return guiFallbackView(row, file)
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
  /** 文件版本时间，供附件解析缓存判断内容是否变化。 */
  readonly updatedAt?: number
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

const OFFICE_TOKEN_TTL_SEC = 12 * 60 * 60
const OFFICE_PLUGIN_TOKEN_TTL_SEC = 10 * 60

/* ---------------- 对话附件：个人云空间文件读取与状态 ---------------- */

export type ChatAttachmentKind = 'text' | 'image' | 'binary'

const CHAT_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const CHAT_IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 对话附件可内联预览的栅格图片类型；不含 SVG，避免把可执行 XML 当图片返回。 */
function normalizeChatImageMime(mime: string | null | undefined): string | null {
  const value = String(mime || '').trim().toLowerCase()
  if (value === 'image/jpg') return 'image/jpeg'
  return CHAT_IMAGE_MIMES.has(value) ? value : null
}

export function chatImageMimeOf(name: string, mime?: string | null): string | null {
  return normalizeChatImageMime(mime) ?? CHAT_IMAGE_EXTENSIONS[extname(String(name || '')).toLowerCase()] ?? null
}

export function chatAttachmentKindOf(name: string, mime?: string | null): ChatAttachmentKind {
  if (chatImageMimeOf(name, mime)) return 'image'
  if (
    isTextEditableFile(name) ||
    /^text\/|application\/(json|xml|x-yaml|yaml|x-ndjson|csv)/i.test(String(mime || ''))
  ) {
    return 'text'
  }
  return 'binary'
}

export interface ChatAttachmentFile extends WorkspaceFileContent {
  kind: ChatAttachmentKind
}

/**
 * 读取消息附件对应的个人云空间文件。
 * 与 readUserWorkspaceFile 的共享语义不同：消息附件只接受本人 user scope，避免共享文件被当成本人附件。
 */
export async function readChatAttachmentFile(
  deps: ServerDeps,
  actor: RequestActor,
  fileId: string,
): Promise<ChatAttachmentFile> {
  requireEnabled(actor)
  const row = deps.db
    .prepare('SELECT * FROM workspace_files WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
    .get(fileId, actor.subject.companyId) as unknown as FileRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, '附件已从云空间删除')
  if (
    row.scope_type !== 'user' ||
    row.scope_id !== actor.subject.userId ||
    row.owner_user_id !== actor.subject.userId
  ) {
    throw new EabError(EC.FORBIDDEN, '只能引用本人云空间里的附件')
  }
  const path = diskPathOf(deps, row)
  let buffer: Buffer | null = null
  if (existsSync(path)) {
    buffer = readFileSync(path)
  } else {
    // 本地工作副本被清理时，按 fileId 从对象存储回源并重建本地缓存。
    const store = attachmentObjectStoreOf(deps)
    if (store) {
      let remote: Buffer | null = null
      try {
        remote = await store.get(store.attachmentKey(row.company_id, row.owner_user_id, row.id))
      } catch (error) {
        throw new EabError(EC.UPSTREAM, '附件对象存储读取失败，请稍后重试', {
          hint: '本地副本也已丢失；如果持续失败，请联系管理员检查 S3/MinIO 连接。',
          cause: error,
        })
      }
      if (remote) {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, remote)
        buffer = remote
      }
    }
  }
  if (!buffer) throw new EabError(EC.NOT_FOUND, '附件内容已不在磁盘（可能被清理）')
  inspectChatAttachment({ filename: row.name, mime: row.mime, buffer })
  return {
    id: row.id,
    name: row.name,
    relPath: row.rel_path,
    size: row.size,
    mime: row.mime,
    ownerUserId: row.owner_user_id,
    buffer,
    updatedAt: Number(row.updated_at) || 0,
    kind: chatAttachmentKindOf(row.name, row.mime),
  }
}

export interface WorkspaceFileState {
  id: string
  status: 'active' | 'deleted' | 'forbidden'
  name?: string
  mime?: string | null
  size?: number
  updatedAt?: number
}

/**
 * 批量解析文件状态，供历史消息卡片与状态接口共用。
 * 记录不存在按删除处理（回收站清理后只剩消息里的 ID）；非本人文件只返回 forbidden，不泄露名称。
 */
export function resolveWorkspaceFileStates(
  deps: ServerDeps,
  companyId: string,
  userId: string,
  fileIds: readonly string[],
  maxIds = 500,
): Map<string, WorkspaceFileState> {
  const ids = [...new Set(fileIds.map((id) => String(id || '').trim()).filter(Boolean))].slice(0, maxIds)
  const result = new Map<string, WorkspaceFileState>()
  if (ids.length === 0) return result
  const rows = deps.db
    .prepare(
      `SELECT id, name, size, mime, updated_at, deleted_at, owner_user_id, scope_type, scope_id
         FROM workspace_files
        WHERE company_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
    )
    .all(companyId, ...ids) as unknown as Array<{
    id: string
    name: string
    size: number
    mime: string | null
    updated_at: number
    deleted_at: number | null
    owner_user_id: string
    scope_type: string
    scope_id: string
  }>
  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const id of ids) {
    const row = byId.get(id)
    if (!row) {
      result.set(id, { id, status: 'deleted' })
      continue
    }
    if (row.scope_type !== 'user' || row.scope_id !== userId || row.owner_user_id !== userId) {
      result.set(id, { id, status: 'forbidden' })
      continue
    }
    if (row.deleted_at) {
      result.set(id, { id, status: 'deleted' })
      continue
    }
    result.set(id, {
      id,
      status: 'active',
      name: row.name,
      mime: row.mime,
      size: row.size,
      updatedAt: row.updated_at,
    })
  }
  return result
}

/** 发布到 SSE：只带文件 ID 和变化原因；发布失败不影响主操作。 */
export function publishWorkspaceFilesChanged(
  companyId: string,
  userId: string,
  reason: WorkspaceChangeReason,
  fileIds: readonly string[],
): void {
  const ids = [...new Set(fileIds.map((id) => String(id || '').trim()).filter(Boolean))]
  if (!companyId || !userId || ids.length === 0) return
  try {
    publishChatEvent({ type: 'workspace', companyId, userId, reason, fileIds: ids })
  } catch {
    // 实时性失败只影响列表推送，主操作已提交，保持静默。
  }
}

function officeRuntime(deps: ServerDeps) {
  return resolveOnlyOffice(deps.config, deps.config.dbPath)
}

function onlyOfficeReady(deps: ServerDeps): boolean {
  return officeRuntime(deps).enabled
}

type PreviewKind = 'office' | 'text' | 'image' | 'pdf' | 'none'

interface PreviewCapability {
  kind: PreviewKind
  mode: 'view' | 'edit'
  agentOps: string[]
  reason?: string
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif'])

export interface WorkspaceTextEdit {
  find: string
  replace: string
  occurrence?: number
}

export interface WorkspaceEditDiffLine {
  type: 'add' | 'del'
  text: string
}

export interface WorkspaceEditDiff {
  lines: WorkspaceEditDiffLine[]
  added: number
  removed: number
  truncated: boolean
}

const EDIT_DIFF_MAX_LINES = 80
const EDIT_DIFF_MAX_LINE_CHARS = 240

function splitEditLines(value: string): string[] {
  const text = String(value ?? '')
  if (!text) return []
  const lines = text.split(/\r?\n/)
  // find/replace 常以换行结尾；最后一个空行不是内容，避免 diff 多出一条空行。
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 工具卡里的文件修改差异：只展示真正变化的行，不把整段 find/replace 原样贴出来。
 * 不是完整行号 diff，但足以让用户看到“删了什么、加了什么”；前后未变行会被折叠。
 */
export function buildWorkspaceEditDiff(edits: readonly WorkspaceTextEdit[]): WorkspaceEditDiff {
  const lines: WorkspaceEditDiffLine[] = []
  let added = 0
  let removed = 0
  let truncated = false
  for (const edit of edits) {
    const oldLines = splitEditLines(edit.find)
    const newLines = splitEditLines(edit.replace)
    let prefix = 0
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
      prefix += 1
    }
    let oldEnd = oldLines.length
    let newEnd = newLines.length
    while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
      oldEnd -= 1
      newEnd -= 1
    }
    const removedLines = oldLines.slice(prefix, oldEnd)
    const addedLines = newLines.slice(prefix, newEnd)
    removed += removedLines.length
    added += addedLines.length
    for (const text of removedLines) {
      if (lines.length >= EDIT_DIFF_MAX_LINES) {
        truncated = true
        break
      }
      const display = text.length > EDIT_DIFF_MAX_LINE_CHARS
        ? `${text.slice(0, EDIT_DIFF_MAX_LINE_CHARS)}…`
        : text
      if (display !== text) truncated = true
      lines.push({ type: 'del', text: display })
    }
    for (const text of addedLines) {
      if (lines.length >= EDIT_DIFF_MAX_LINES) {
        truncated = true
        break
      }
      const display = text.length > EDIT_DIFF_MAX_LINE_CHARS
        ? `${text.slice(0, EDIT_DIFF_MAX_LINE_CHARS)}…`
        : text
      if (display !== text) truncated = true
      lines.push({ type: 'add', text: display })
    }
  }
  return { lines, added, removed, truncated }
}

/**
 * 对文本做精确片段替换，全部在内存中完成后再由调用方一次落盘。
 * 任何一条 find 找不到都会抛错，避免改了一半留下半成品。
 */
export function applyWorkspaceTextEdits(
  source: string,
  edits: readonly WorkspaceTextEdit[],
): { text: string; changes: number; matchedEdits: number } {
  if (!edits.length) throw new EabError(EC.VALIDATION, '至少提供一个局部修改片段')
  let text = String(source ?? '')
  let changes = 0
  for (const edit of edits) {
    const find = String(edit?.find ?? '')
    const replace = String(edit?.replace ?? '')
    if (!find) throw new EabError(EC.VALIDATION, 'find 不能为空', { hint: 'find 必须是要替换的原文片段' })
    if (find === replace) throw new EabError(EC.VALIDATION, 'replace 与 find 相同，没有实际修改', {
      hint: '不要重复同一替换。需要整体重写请用 workspace.write {path,text}；局部修改则把 replace 改成新的完整片段。',
    })
    const occurrence = Number(edit?.occurrence ?? 0)
    if (!Number.isInteger(occurrence) || occurrence < 0) {
      throw new EabError(EC.VALIDATION, 'occurrence 必须是正整数，或省略表示全部替换')
    }
    if (occurrence > 0) {
      let index = -1
      let from = 0
      for (let i = 0; i < occurrence; i += 1) {
        index = text.indexOf(find, from)
        if (index < 0) break
        from = index + find.length
      }
      if (index < 0) {
        throw new EabError(EC.VALIDATION, `第 ${occurrence} 个匹配不存在`, {
          hint: `没有找到要替换的原文：${find.slice(0, 80)}${find.length > 80 ? '…' : ''}。请先用 workspace.read 确认原文，find 必须包含完整空格和换行`,
        })
      }
      text = `${text.slice(0, index)}${replace}${text.slice(index + find.length)}`
      changes += 1
      continue
    }
    let index = text.indexOf(find)
    if (index < 0) {
      throw new EabError(EC.VALIDATION, '没有找到要替换的原文', {
        hint: `find 必须与文件内容完全一致（含空格、换行、标点）：${find.slice(0, 80)}${find.length > 80 ? '…' : ''}。请先用 workspace.read 读取原文`,
      })
    }
    let count = 0
    let cursor = 0
    while (index >= 0) {
      text = `${text.slice(0, index)}${replace}${text.slice(index + find.length)}`
      count += 1
      cursor = index + replace.length
      index = text.indexOf(find, cursor)
    }
    changes += count
  }
  return { text, changes, matchedEdits: edits.length }
}

/** 服务端统一的预览能力判断；前端不再只靠扩展名猜测，避免打开空面板。 */
export function previewCapabilityOf(row: FileRow, canEdit: boolean, officeReady: boolean): PreviewCapability {
  const ext = extname(row.name).toLowerCase()
  const mime = String(row.mime || '').toLowerCase()
  const mode: 'view' | 'edit' = canEdit ? 'edit' : 'view'
  // 文本优先走降级预览：.txt/.csv/.html 在 OnlyOffice 里也能打开，但纯文本预览更快、选区/diff 更可控。
  if (TEXT_EXTENSIONS.has(ext) || mime.startsWith('text/')) {
    return {
      kind: 'text',
      mode,
      agentOps: ['read', 'select', 'edit', 'diff', 'save'],
    }
  }
  if (officeDocumentType(row.name, row.mime)) {
    if (!officeReady) {
      return { kind: 'none', mode: 'view', agentOps: [], reason: 'OnlyOffice 文档服务未配置，暂不能在线预览' }
    }
    return {
      kind: 'office',
      mode,
      agentOps: ['read', 'select', 'edit', 'format', 'comment', 'track_changes', 'save', 'render'],
    }
  }
  if (ext === '.pdf' || mime === 'application/pdf') {
    return {
      kind: 'pdf',
      mode,
      agentOps: ['read', 'select', 'extract_text', 'highlight', 'annotate'],
    }
  }
  if (IMAGE_EXTENSIONS.has(ext) || mime.startsWith('image/')) {
    return {
      kind: 'image',
      mode,
      agentOps: ['read', 'select_region', 'ocr', 'annotate'],
    }
  }
  return { kind: 'none', mode: 'view', agentOps: [], reason: '该文件类型暂不支持在线预览' }
}

function officeRowOf(deps: ServerDeps, companyId: string, fileId: string): FileRow | undefined {
  return deps.db
    .prepare('SELECT * FROM workspace_files WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
    .get(fileId, companyId) as unknown as FileRow | undefined
}

function issueOfficeToken(
  deps: ServerDeps,
  row: FileRow,
  userId: string,
  mode: OfficeMode,
  kind: OfficeTokenPayload['kind'],
  ttlSec = OFFICE_TOKEN_TTL_SEC,
  sessionId?: string,
): string {
  const now = Math.floor(Date.now() / 1000)
  return signOfficeJwt(
    {
      kind,
      fileId: row.id,
      companyId: row.company_id,
      userId,
      mode,
      version: row.updated_at,
      ...(sessionId ? { sid: sessionId } : {}),
      iat: now,
      exp: now + ttlSec,
    },
    officeRuntime(deps).jwtSecret,
  )
}

function officeInternalUrl(deps: ServerDeps, suffix: string): string {
  return `${officeRuntime(deps).internalUrl.replace(/\/+$/, '')}${suffix}`
}

function officeContentUrl(deps: ServerDeps, row: FileRow, userId: string, mode: OfficeMode): string {
  const token = issueOfficeToken(deps, row, userId, mode, 'content')
  return officeInternalUrl(deps, `/api/workspace/office/${encodeURIComponent(row.id)}/content/${token}`)
}

function officeCallbackUrl(deps: ServerDeps, row: FileRow, userId: string, mode: OfficeMode): string {
  // 每次打开编辑器生成新的会话标识；同一编辑器 status=2 后紧跟 status=6 时仍可保存，
  // 但另一个停留在旧版本的编辑器会被版本冲突拦截。
  const token = issueOfficeToken(deps, row, userId, mode, 'callback', OFFICE_TOKEN_TTL_SEC, `os_${ulid()}`)
  return officeInternalUrl(deps, `/api/workspace/office/${encodeURIComponent(row.id)}/callback/${token}`)
}

/** 插件由员工浏览器加载，配置地址必须使用浏览器实际访问 EAB 的 origin。 */
function browserBaseUrl(req: FastifyRequest): string {
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
  const forwardedHost = String(req.headers['x-forwarded-host'] ?? '')
    .split(',')[0]
    .trim()
  const proto = forwardedProto || req.protocol || 'http'
  const host = forwardedHost || String(req.headers.host || '127.0.0.1')
  return `${proto}://${host}`
}

function officePluginBaseUrl(req: FastifyRequest, deps: ServerDeps): string {
  return (officeRuntime(deps).internalUrl || browserBaseUrl(req)).replace(/\/+$/, '')
}

/** 插件 config.json 由 OnlyOffice 编辑器跨域拉取，必须显式允许文档服务 origin。 */
function setOnlyOfficeCors(deps: ServerDeps, reply: { header: (name: string, value: string) => unknown }): void {
  const raw = officeRuntime(deps).url
  if (!raw) return
  try {
    reply.header('access-control-allow-origin', new URL(raw).origin)
    reply.header('vary', 'Origin')
  } catch {
    // 配置里不是合法 URL 时不设置 CORS，保持默认拒绝。
  }
}

function officePluginConfigUrl(
  req: FastifyRequest,
  deps: ServerDeps,
  row: FileRow,
  userId: string,
  mode: OfficeMode,
): string {
  const token = issueOfficeToken(deps, row, userId, mode, 'plugin', OFFICE_PLUGIN_TOKEN_TTL_SEC)
  return `${officePluginBaseUrl(req, deps)}/onlyoffice-plugin/config.json?token=${encodeURIComponent(token)}`
}

/** 只允许回源到配置里的 OnlyOffice 地址，避免把回调 URL 当成任意下载器。 */
function assertOnlyOfficeDownloadUrl(deps: ServerDeps, raw: string): URL {
  let url: URL
  try {
    url = new URL(String(raw || ''))
  } catch {
    throw new EabError(EC.VALIDATION, 'OnlyOffice 回调缺少合法的文件地址')
  }
  const base = new URL(officeRuntime(deps).url)
  const samePort = url.protocol === base.protocol && (url.port || (url.protocol === 'https:' ? '443' : '80')) ===
    (base.port || (base.protocol === 'https:' ? '443' : '80'))
  const allowedHosts = new Set([base.hostname, 'localhost', '127.0.0.1', 'host.docker.internal'])
  if (!samePort || !allowedHosts.has(url.hostname)) {
    throw new EabError(EC.VALIDATION, 'OnlyOffice 回调文件地址不在文档服务地址内')
  }
  return url
}

async function downloadOnlyOfficeFile(deps: ServerDeps, rawUrl: string): Promise<Buffer> {
  const url = assertOnlyOfficeDownloadUrl(deps, rawUrl)
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new EabError(EC.INTERNAL, `从 OnlyOffice 读取保存文件失败（HTTP ${response.status}）`)
  const length = Number(response.headers.get('content-length') || 0)
  if (length > 80 * 1024 * 1024) throw new EabError(EC.VALIDATION, 'OnlyOffice 保存文件超过 80 MB')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > 80 * 1024 * 1024) throw new EabError(EC.VALIDATION, 'OnlyOffice 保存文件超过 80 MB')
  return buffer
}

/**
 * OnlyOffice 保存回调写回当前文件。
 * 仍走用户配额和公司配额；共享文件只读，不进入这里。
 */
function saveOfficeFileContent(
  deps: ServerDeps,
  req: FastifyRequest,
  payload: OfficeTokenPayload,
  row: FileRow,
  buffer: Buffer,
): void {
  if (row.owner_user_id !== payload.userId) {
    throw new EabError(EC.FORBIDDEN, '只有文件本人可以保存编辑内容')
  }
  if (row.updated_at > payload.version) {
    const lastSession = officeAcceptedCallbackSessions.get(officeRefreshKey(row.company_id, row.id))
    // 同一个编辑会话在 status=2 保存后可能继续发 status=6；这是它自己的后续保存，
    // 不是另一个旧编辑器。没有会话标识的旧 token 一律按冲突拒绝。
    if (!payload.sid || lastSession !== payload.sid) {
      appendAudit(deps.db, {
        companyId: row.company_id,
        actorUserId: row.owner_user_id,
        action: 'workspace.file.office_conflict',
        resourceType: 'file',
        resourceId: row.id,
        resourceScope: `${row.scope_type}:${row.scope_id}`,
        result: 'failure',
        detail: {
          relPath: row.rel_path,
          payloadVersion: payload.version,
          currentVersion: row.updated_at,
          sessionId: payload.sid ?? null,
          reason: 'stale editor callback',
        },
        traceId: String(req.id),
        ip: req.ip,
        channel: 'web',
      })
      throw new EabError(EC.CONFLICT, '云端文件已更新，旧编辑会话的回写被拒绝')
    }
  }
  const policy = resolveUserWorkspaceQuota(deps.db, row.company_id, row.owner_user_id)
  if (buffer.length > policy.fileLimitBytes) {
    throw new EabError(EC.VALIDATION, `文件超过单文件上限（${formatQuotaBytes(policy.fileLimitBytes)}）`)
  }
  const delta = buffer.length - row.size
  const userQuota = ensureQuota(deps, row.company_id, 'user', row.owner_user_id, policy.limitBytes)
  const companyQuota = ensureQuota(deps, row.company_id, 'company', row.company_id, DEFAULT_COMPANY_QUOTA)
  if (delta > 0 && userQuota.used + delta > userQuota.limit) {
    throw new EabError(EC.VALIDATION, `保存后超出个人配额（剩余 ${formatQuotaBytes(userQuota.limit - userQuota.used)}）`)
  }
  if (delta > 0 && companyQuota.used + delta > companyQuota.limit) {
    throw new EabError(EC.VALIDATION, '保存后超出公司空间配额')
  }
  const path = diskPathOf(deps, row)
  if (!existsSync(path)) throw new EabError(EC.NOT_FOUND, '原文件不在磁盘，无法保存')
  const operationId = `op_${ulid()}`
  const snapshot = snapshotWorkspaceVersion(deps, row, {
    source: 'onlyoffice.save',
    operationId,
    summary: 'OnlyOffice 保存前版本',
    createdBy: row.owner_user_id,
  })
  writeFileSync(path, buffer)
  const now = Date.now()
  deps.db
    .prepare('UPDATE workspace_files SET size = ?, storage_path = ?, updated_at = ? WHERE id = ?')
    .run(buffer.length, path, now, row.id)
  if (delta) {
    addUsage(deps, row.company_id, 'user', row.owner_user_id, delta)
    addUsage(deps, row.company_id, 'company', row.company_id, delta)
  }
  appendAudit(deps.db, {
    companyId: row.company_id,
    actorUserId: row.owner_user_id,
    action: 'workspace.file.edit',
    resourceType: 'file',
    resourceId: row.id,
    resourceScope: `${row.scope_type}:${row.scope_id}`,
    result: 'success',
    detail: {
      relPath: row.rel_path,
      size: buffer.length,
      beforeSize: row.size,
      afterSize: buffer.length,
      source: 'onlyoffice',
      operationId,
      snapshotId: snapshot.id,
      snapshotVersion: snapshot.version,
    },
    traceId: String(req.id),
    ip: req.ip,
    channel: 'web',
  })
  if (payload.sid) {
    officeAcceptedCallbackSessions.set(officeRefreshKey(row.company_id, row.id), payload.sid)
  }
  publishWorkspaceFilesChanged(row.company_id, row.owner_user_id, 'updated', [row.id])
}

/** 强制保存是异步命令；回调写回后 updated_at 才会前进，轮询给插件一个可确认的结果。 */
async function waitForOfficeSave(
  deps: ServerDeps,
  row: FileRow,
  timeoutMs: number,
): Promise<{ updatedAt: number; size: number } | null> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const current = deps.db
      .prepare('SELECT updated_at, size FROM workspace_files WHERE id = ? AND deleted_at IS NULL')
      .get(row.id) as { updated_at?: number; size?: number } | undefined
    if (current && Number(current.updated_at) > row.updated_at) {
      return { updatedAt: Number(current.updated_at), size: Number(current.size) }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return null
}

/**
 * Agent 内容工具保存 docx 等二进制文件时使用。
 * 与 OnlyOffice 保存共用配额和 workspace_files 元数据，但审计动作单独记为
 * `workspace.file.agent_edit`，便于区分人工编辑器保存与 Agent 局部改写。
 */
export interface WorkspaceFileEditResult {
  id: string
  name: string
  relPath: string
  size: number
  updatedAt: number
  snapshot?: { id: string; version: number }
}

export function editUserWorkspaceFile(
  deps: ServerDeps,
  actor: RequestActor,
  fileId: string,
  buffer: Buffer,
  detail: Record<string, unknown> = {},
): WorkspaceFileEditResult {
  requireEnabled(actor)
  const row = deps.db
    .prepare('SELECT * FROM workspace_files WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
    .get(fileId, actor.subject.companyId) as unknown as FileRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在')
  if (row.owner_user_id !== actor.subject.userId) throw new EabError(EC.FORBIDDEN, '只能修改自己的文件')
  const expectedVersion = detail.baseVersion === undefined ? undefined : Number(detail.baseVersion)
  if (expectedVersion !== undefined && Number.isFinite(expectedVersion) && row.updated_at !== expectedVersion) {
    throw new EabError(EC.CONFLICT, '文件已被其它操作更新，请重新读取后再写入', {
      details: { expectedVersion, currentVersion: row.updated_at },
      hint: '重新拉取文件内容并确认目标片段后再重试；本次没有写入磁盘。',
    })
  }

  const policy = resolveUserWorkspaceQuota(deps.db, row.company_id, row.owner_user_id)
  if (buffer.length > policy.fileLimitBytes) {
    throw new EabError(EC.VALIDATION, `文件超过单文件上限（${formatQuotaBytes(policy.fileLimitBytes)}）`)
  }
  const delta = buffer.length - row.size
  const userQuota = ensureQuota(deps, row.company_id, 'user', row.owner_user_id, policy.limitBytes)
  const companyQuota = ensureQuota(deps, row.company_id, 'company', row.company_id, DEFAULT_COMPANY_QUOTA)
  if (delta > 0 && userQuota.used + delta > userQuota.limit) {
    throw new EabError(EC.VALIDATION, `保存后超出个人配额（剩余 ${formatQuotaBytes(userQuota.limit - userQuota.used)}）`)
  }
  if (delta > 0 && companyQuota.used + delta > companyQuota.limit) {
    throw new EabError(EC.VALIDATION, '保存后超出公司空间配额')
  }
  const path = diskPathOf(deps, row)
  if (!existsSync(path)) throw new EabError(EC.NOT_FOUND, '原文件不在磁盘，无法保存')
  const operationId = typeof detail.operationId === 'string' && detail.operationId
    ? detail.operationId
    : `op_${ulid()}`
  const source = typeof detail.source === 'string' && detail.source ? detail.source : 'workspace.edit'
  const snapshot = snapshotWorkspaceVersion(deps, row, {
    source,
    operationId,
    summary: typeof detail.summary === 'string' ? detail.summary : undefined,
    createdBy: actor.subject.userId,
  })
  writeFileSync(path, buffer)
  const now = Date.now()
  deps.db
    .prepare('UPDATE workspace_files SET size = ?, storage_path = ?, updated_at = ? WHERE id = ?')
    .run(buffer.length, path, now, row.id)
  if (delta) {
    addUsage(deps, row.company_id, 'user', row.owner_user_id, delta)
    addUsage(deps, row.company_id, 'company', row.company_id, delta)
  }
  appendAudit(deps.db, {
    companyId: row.company_id,
    actorUserId: actor.subject.userId,
    action: 'workspace.file.agent_edit',
    resourceType: 'file',
    resourceId: row.id,
    resourceScope: `${row.scope_type}:${row.scope_id}`,
    result: 'success',
    detail: {
      ...detail,
      relPath: row.rel_path,
      size: buffer.length,
      beforeSize: row.size,
      afterSize: buffer.length,
      operationId,
      snapshotId: snapshot.id,
      snapshotVersion: snapshot.version,
    },
    traceId: null,
    ip: null,
    channel: 'agent',
  })
  publishWorkspaceFilesChanged(row.company_id, row.owner_user_id, 'updated', [row.id])
  return {
    id: row.id,
    name: row.name,
    relPath: row.rel_path,
    size: buffer.length,
    updatedAt: now,
    snapshot: { id: snapshot.id, version: snapshot.version },
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
  if (isChatAttachmentRelPath(relPath)) {
    inspectChatAttachment({ filename: basename(relPath), mime: input.mime, buffer: input.buffer })
  }
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
  publishWorkspaceFilesChanged(actor.subject.companyId, actor.subject.userId, 'created', [id])
  return {
    id,
    name: basename(finalRelPath),
    relPath: finalRelPath,
    size: buffer.length,
    mime: input.mime ?? null,
    root: dir,
  }
}

/** 通过 OnlyOffice 把云空间 Office 文件转成 PDF；只读取，不改文件、不写版本。 */
export async function exportWorkspaceFileToPdf(
  deps: ServerDeps,
  actor: RequestActor,
  fileId: string,
): Promise<{ row: FileRow; buffer: Buffer }> {
  requireEnabled(actor)
  requireScope(actor.subject, SC.WORKSPACE_READ)
  if (!onlyOfficeReady(deps)) throw new EabError(EC.VALIDATION, 'OnlyOffice 文档服务未配置')
  const row = officeRowOf(deps, actor.subject.companyId, fileId)
  if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在')
  if (row.owner_user_id !== actor.subject.userId && !isShared(deps, row, actor)) {
    throw new EabError(EC.FORBIDDEN, '没有该文件的访问权限')
  }
  if (!officeDocumentType(row.name, row.mime)) throw new EabError(EC.VALIDATION, '这个文件不是可导出的 Office 文档')
  const buffer = await convertOfficeDocumentToPdf({
    url: officeRuntime(deps).url,
    secret: officeRuntime(deps).jwtSecret,
    fileUrl: officeContentUrl(deps, row, actor.subject.userId, 'view'),
    fileType: officeFileType(row.name),
    title: row.name,
    key: officeDocumentKey(row.id, row.updated_at),
  })
  return { row, buffer }
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

  /** 批量查询文件状态：消息卡片与云空间列表用于判断“已删除/无权访问/仍在”。 */
  app.post<{ Body: { ids?: unknown } }>('/api/workspace/files/status', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.WORKSPACE_READ)
    if (!Array.isArray(req.body?.ids)) throw new EabError(EC.VALIDATION, 'ids 必须是数组')
    const ids = req.body.ids.map((id) => String(id ?? '').trim()).filter(Boolean)
    if (ids.length > 200) throw new EabError(EC.VALIDATION, '一次最多查询 200 个文件')
    const states = resolveWorkspaceFileStates(deps, actor.subject.companyId, actor.subject.userId, ids, 200)
    return ok({ items: [...states.values()] })
  })

  /**
   * 消息卡片图片缩略图：只内联栅格图片，SVG/HTML/PDF/Office 一律不返回。
   * 与下载接口分开，避免每次缩略图都写下载审计、强制 attachment。
   */
  app.get<{ Params: { id: string } }>('/api/workspace/files/:id/preview', async (req, reply) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.WORKSPACE_READ)
    const row = deps.db
      .prepare('SELECT * FROM workspace_files WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(req.params.id, actor.subject.companyId) as unknown as FileRow | undefined
    if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在或已被删除')
    if (row.owner_user_id !== actor.subject.userId && !isShared(deps, row, actor)) {
      throw new EabError(EC.FORBIDDEN, '没有该文件的访问权限')
    }
    const mime = chatImageMimeOf(row.name, row.mime)
    if (!mime) {
      return reply.code(415).send({
        ok: false,
        error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '该文件类型不支持缩略图内联预览' },
      })
    }
    const path = diskPathOf(deps, row)
    if (!existsSync(path)) throw new EabError(EC.NOT_FOUND, '文件内容已不在磁盘（可能被清理）')
    const etag = `"${row.updated_at}-${row.size}"`
    reply
      .header('content-type', mime)
      .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.name)}`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, max-age=300')
      .header('etag', etag)
    if (String(req.headers['if-none-match'] || '') === etag) return reply.code(304).send()
    return reply.send(await readFile(path))
  })

  /** 预览能力矩阵：前端据此决定是否创建右栏，不再只凭扩展名猜。 */
  app.get<{ Params: { id: string } }>(
    '/api/workspace/files/:id/preview-capability',
    async (req) => {
      const actor = resolveActor(deps.db, deps.config, req)
      requireEnabled(actor)
      requireScope(actor.subject, SC.WORKSPACE_READ)
      const row = officeRowOf(deps, actor.subject.companyId, req.params.id)
      if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在')
      if (row.owner_user_id !== actor.subject.userId && !isShared(deps, row, actor)) {
        throw new EabError(EC.FORBIDDEN, '没有该文件的访问权限')
      }
      const owner = row.owner_user_id === actor.subject.userId
      return ok({
        fileId: row.id,
        name: row.name,
        size: row.size,
        ...previewCapabilityOf(row, owner, onlyOfficeReady(deps)),
      })
    },
  )

  /** 返回 DocsAPI.DocEditor 的配置；共享文件固定只读，本人可切换到编辑。 */
  app.get<{ Params: { id: string }; Querystring: { mode?: string } }>(
    '/api/workspace/files/:id/office-config',
    async (req) => {
      const actor = resolveActor(deps.db, deps.config, req)
      requireEnabled(actor)
      requireScope(actor.subject, SC.WORKSPACE_READ)
      if (!onlyOfficeReady(deps)) {
        return ok({ configured: false, reason: 'OnlyOffice 文档服务未配置' })
      }
      const row = officeRowOf(deps, actor.subject.companyId, req.params.id)
      if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在')
      if (row.owner_user_id !== actor.subject.userId && !isShared(deps, row, actor)) {
        throw new EabError(EC.FORBIDDEN, '没有该文件的访问权限')
      }
      if (!officeDocumentType(row.name, row.mime)) {
        throw new EabError(EC.VALIDATION, '这个文件不是可在线编辑的 Office 文档')
      }
      const documentType = officeDocumentType(row.name, row.mime)
      const owner = row.owner_user_id === actor.subject.userId
      const requestedEdit = req.query?.mode === 'edit'
      if (requestedEdit && !owner) throw new EabError(EC.FORBIDDEN, '共享文件只能只读打开')
      const mode: OfficeMode = requestedEdit ? 'edit' : 'view'
      const pluginConfigUrl =
        documentType === 'word' || documentType === 'cell' || documentType === 'slide'
          ? officePluginConfigUrl(req, deps, row, actor.subject.userId, mode)
          : undefined
      const config = buildOfficeEditorConfig({
        fileId: row.id,
        fileName: row.name,
        mime: row.mime,
        updatedAt: row.updated_at,
        userId: actor.subject.userId,
        userName: actor.person?.name || actor.subject.userId,
        mode,
        contentUrl: officeContentUrl(deps, row, actor.subject.userId, mode),
        callbackUrl: officeCallbackUrl(deps, row, actor.subject.userId, mode),
        pluginConfigUrl,
        secret: officeRuntime(deps).jwtSecret,
      })
      audit(deps, req, 'workspace.file.office_open', row, { mode })
      return ok({
        configured: true,
        scriptUrl: officeScriptUrl(officeRuntime(deps).url),
        config,
        mode,
      })
    },
  )

  /**
   * EAB OnlyOffice 插件配置。
   * OnlyOffice 只接受裸 config.json，不能套 `{ok:true,data}` 信封；token 绑定文件、
   * 用户和版本，10 分钟过期，配置里的插件页地址再带同一个 token。
   */
  app.get<{ Querystring: { token?: string } }>(
    '/onlyoffice-plugin/config.json',
    async (req, reply) => {
      const token = typeof req.query?.token === 'string' ? req.query.token : ''
      reply.header('cache-control', 'no-store')
      setOnlyOfficeCors(deps, reply)
      // plugins.js 启动时会固定请求 ./config.json（不带 token）；返回不含令牌的
      // 插件元数据，让 SDK 发出 initialize 并触发插件 init。文档令牌仍只走
      // pluginsData 注入的带 token 配置。
      if (!token) {
        return reply.type('application/json; charset=utf-8').send(buildOfficePluginConfig(''))
      }
      const payload = verifyOfficeJwt(token, officeRuntime(deps).jwtSecret)
      if (!payload || payload.kind !== 'plugin') {
        throw new EabError(EC.FORBIDDEN, 'OnlyOffice 插件令牌无效或已过期')
      }
      const row = officeRowOf(deps, payload.companyId, payload.fileId)
      if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在')
      if (payload.version !== row.updated_at) {
        throw new EabError(EC.CONFLICT, '文件已更新，请重新打开预览')
      }
      const documentType = officeDocumentType(row.name, row.mime)
      const editorType = documentType || 'word'
      return reply
        .type('application/json; charset=utf-8')
        .send(buildOfficePluginConfig(token, editorType))
    },
  )

  /** 插件页用它确认自己绑定的是哪个文件、哪种模式，不返回文件内容。 */
  app.get<{ Querystring: { token?: string } }>(
    '/api/workspace/office/plugin/context',
    async (req, reply) => {
      const token = typeof req.query?.token === 'string' ? req.query.token : ''
      const payload = verifyOfficeJwt(token, officeRuntime(deps).jwtSecret)
      if (!payload || payload.kind !== 'plugin') {
        throw new EabError(EC.FORBIDDEN, 'OnlyOffice 插件令牌无效或已过期')
      }
      const row = officeRowOf(deps, payload.companyId, payload.fileId)
      if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在')
      if (payload.version !== row.updated_at) {
        throw new EabError(EC.CONFLICT, '文件已更新，请重新打开预览')
      }
      reply.header('cache-control', 'no-store')
      setOnlyOfficeCors(deps, reply)
      const capability = previewCapabilityOf(row, row.owner_user_id === payload.userId, onlyOfficeReady(deps))
      return ok({
        fileId: row.id,
        name: row.name,
        mode: payload.mode,
        canEdit: payload.mode === 'edit',
        documentType: officeDocumentType(row.name, row.mime),
        previewKind: capability.kind,
        agentOps: capability.agentOps,
        onlyOfficeVersionHint: '10.0.0-169',
      })
    },
  )

  /**
   * 插件页主动保存当前编辑内容。
   * 编辑器 key 必须使用插件 token 里的 version：编辑器打开后即使云端文件被 Agent
   * 工具改过，当前协同会话仍挂在旧 key 上；用当前 DB 版本会找不到该会话。
   */
  app.post<{ Body: { token?: string } }>(
    '/api/workspace/office/plugin/force-save',
    async (req, reply) => {
      const token = typeof req.body?.token === 'string' ? req.body.token : ''
      const payload = verifyOfficeJwt(token, officeRuntime(deps).jwtSecret)
      if (!payload || payload.kind !== 'plugin') {
        throw new EabError(EC.FORBIDDEN, 'OnlyOffice 插件令牌无效或已过期')
      }
      if (payload.mode !== 'edit') throw new EabError(EC.FORBIDDEN, '只读模式不能保存')
      const row = officeRowOf(deps, payload.companyId, payload.fileId)
      if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在')
      if (row.owner_user_id !== payload.userId) throw new EabError(EC.FORBIDDEN, '只有文件本人可以保存编辑内容')
      if (payload.version !== row.updated_at) {
        throw new EabError(EC.CONFLICT, '文件已更新，请重新打开预览后再保存')
      }
      if (!onlyOfficeReady(deps)) throw new EabError(EC.VALIDATION, 'OnlyOffice 文档服务未配置')
      reply.header('cache-control', 'no-store')
      const key = officeDocumentKey(payload.fileId, payload.version)
      let result: Awaited<ReturnType<typeof forceSaveOfficeDocument>>
      try {
        result = await forceSaveOfficeDocument({
          url: officeRuntime(deps).url,
          secret: officeRuntime(deps).jwtSecret,
          key,
        })
      } catch (error) {
        appendAudit(deps.db, {
          companyId: row.company_id,
          actorUserId: row.owner_user_id,
          action: 'workspace.file.force_save',
          resourceType: 'file',
          resourceId: row.id,
          resourceScope: `${row.scope_type}:${row.scope_id}`,
          result: 'failure',
          detail: { relPath: row.rel_path, key, reason: error instanceof Error ? error.message : String(error) },
          traceId: String(req.id),
          ip: req.ip,
          channel: 'web',
        })
        throw new EabError(EC.INTERNAL, `OnlyOffice 强制保存失败：${error instanceof Error ? error.message : String(error)}`)
      }
      if (result.error === 4) {
        appendAudit(deps.db, {
          companyId: row.company_id,
          actorUserId: row.owner_user_id,
          action: 'workspace.file.force_save',
          resourceType: 'file',
          resourceId: row.id,
          resourceScope: `${row.scope_type}:${row.scope_id}`,
          result: 'success',
          detail: { relPath: row.rel_path, key, state: 'no_changes' },
          traceId: String(req.id),
          ip: req.ip,
          channel: 'web',
        })
        return ok({ state: 'no_changes', persisted: false, key, error: 4, message: result.message })
      }
      if (result.error !== 0) {
        appendAudit(deps.db, {
          companyId: row.company_id,
          actorUserId: row.owner_user_id,
          action: 'workspace.file.force_save',
          resourceType: 'file',
          resourceId: row.id,
          resourceScope: `${row.scope_type}:${row.scope_id}`,
          result: 'failure',
          detail: { relPath: row.rel_path, key, error: result.error, message: result.message },
          traceId: String(req.id),
          ip: req.ip,
          channel: 'web',
        })
        throw new EabError(result.error === 1 ? EC.CONFLICT : EC.INTERNAL, result.message)
      }
      const saved = await waitForOfficeSave(deps, row, 4000)
      appendAudit(deps.db, {
        companyId: row.company_id,
        actorUserId: row.owner_user_id,
        action: 'workspace.file.force_save',
        resourceType: 'file',
        resourceId: row.id,
        resourceScope: `${row.scope_type}:${row.scope_id}`,
        result: 'success',
        detail: {
          relPath: row.rel_path,
          key,
          state: saved ? 'saved' : 'pending',
          updatedAt: saved?.updatedAt ?? row.updated_at,
          size: saved?.size ?? row.size,
        },
        traceId: String(req.id),
        ip: req.ip,
        channel: 'web',
      })
      return ok({
        state: saved ? 'saved' : 'pending',
        persisted: Boolean(saved),
        key,
        error: 0,
        updatedAt: saved?.updatedAt ?? row.updated_at,
        size: saved?.size ?? row.size,
        message: saved ? '已保存到云空间' : '保存请求已发送，等待 OnlyOffice 回调',
      })
    },
  )

  /**
   * 编辑态刷新到云端版本前调用：记录当前云端版本作为水位。
   * 之后关闭旧编辑器产生的保存回调，只要版本低于该水位就丢弃。
   */
  app.post<{ Params: { id: string } }>(
    '/api/workspace/office/:id/refresh-guard',
    async (req, reply) => {
      const actor = resolveActor(deps.db, deps.config, req)
      requireEnabled(actor)
      requireScope(actor.subject, SC.WORKSPACE_READ)
      const row = officeRowOf(deps, actor.subject.companyId, req.params.id)
      if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在')
      if (row.owner_user_id !== actor.subject.userId) {
        throw new EabError(EC.FORBIDDEN, '只有文件本人可以刷新编辑版本')
      }
      setOfficeRefreshCutoff(deps.db, row.company_id, row.id, row.updated_at)
      reply.header('cache-control', 'no-store')
      return ok({ fileId: row.id, cutoff: row.updated_at })
    },
  )

  /** OnlyOffice 容器从这里取原文件；不用登录态，靠短期签名令牌授权。 */
  app.get<{ Params: { id: string; token: string } }>(
    '/api/workspace/office/:id/content/:token',
    async (req, reply) => {
      const payload = verifyOfficeJwt(req.params.token, officeRuntime(deps).jwtSecret)
      if (!payload || payload.kind !== 'content' || payload.fileId !== req.params.id) {
        throw new EabError(EC.FORBIDDEN, '文档访问令牌无效或已过期')
      }
      const row = officeRowOf(deps, payload.companyId, payload.fileId)
      if (!row) throw new EabError(EC.NOT_FOUND, '文件不存在')
      const path = diskPathOf(deps, row)
      if (!existsSync(path)) throw new EabError(EC.NOT_FOUND, '文件内容已不在磁盘（可能被清理）')
      const encoded = encodeURIComponent(row.name)
      reply
        .header('content-type', row.mime || 'application/octet-stream')
        .header('content-disposition', `inline; filename*=UTF-8''${encoded}`)
        .header('cache-control', 'no-store')
      return reply.send(readFileSync(path))
    },
  )

  /** OnlyOffice 保存回调；只有本人编辑会话能回写。 */
  app.post<{
    Params: { id: string; token: string }
    Body: { status?: number | string; url?: string; key?: string }
  }>('/api/workspace/office/:id/callback/:token', async (req, reply) => {
    try {
      const payload = verifyOfficeJwt(req.params.token, officeRuntime(deps).jwtSecret)
      if (!payload || payload.kind !== 'callback' || payload.fileId !== req.params.id) {
        return reply.send({ error: 1 })
      }
      const status = Number(req.body?.status ?? 0)
      if (status !== 2 && status !== 6) return reply.send({ error: 0 })
      if (payload.mode !== 'edit') return reply.send({ error: 1 })
      const row = officeRowOf(deps, payload.companyId, payload.fileId)
      if (!row) return reply.send({ error: 1 })
      if (row.owner_user_id !== payload.userId) return reply.send({ error: 1 })
      const cutoff = readOfficeRefreshCutoff(deps.db, row.company_id, row.id)
      if (cutoff !== undefined && Number(payload.version) < cutoff) {
        req.log.info(
          { fileId: row.id, payloadVersion: payload.version, cutoff },
          'onlyoffice stale callback discarded after cloud refresh',
        )
        appendAudit(deps.db, {
          companyId: row.company_id,
          actorUserId: payload.userId,
          action: 'workspace.file.office_stale_callback',
          resourceType: 'file',
          resourceId: row.id,
          resourceScope: `${row.scope_type}:${row.scope_id}`,
          result: 'success',
          detail: { relPath: row.rel_path, payloadVersion: payload.version, cutoff },
          traceId: String(req.id),
          ip: req.ip,
          channel: 'web',
        })
        // 对 OnlyOffice 返回成功，避免它反复重试旧会话的保存。
        return reply.send({ error: 0 })
      }
      if (!req.body?.url) return reply.send({ error: 1 })
      const buffer = await downloadOnlyOfficeFile(deps, req.body.url)
      saveOfficeFileContent(deps, req, payload, row, buffer)
      return reply.send({ error: 0 })
    } catch (error) {
      req.log.error({ err: error }, 'onlyoffice callback failed')
      return reply.send({ error: 1 })
    }
  })

  app.post<{
    Body: { name?: string; path?: string; text?: string; contentBase64?: string; mime?: string; baseVersion?: number }
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
    if (isChatAttachmentRelPath(relPath)) {
      inspectChatAttachment({ filename: basename(relPath), mime: body.mime, buffer })
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
    const expectedVersion = body.baseVersion === undefined ? undefined : Number(body.baseVersion)
    if (existing && expectedVersion !== undefined && Number.isFinite(expectedVersion) && existing.updated_at !== expectedVersion) {
      throw new EabError(EC.CONFLICT, '文件已被其它操作更新，请重新读取后再保存', {
        details: { expectedVersion, currentVersion: existing.updated_at },
        hint: '刷新预览确认最新内容后再保存；本次没有写入磁盘。',
      })
    }
    const dir = scopeDir(deps, actor.subject.companyId, 'user', actor.subject.userId)
    const target = safeJoin(dir, relPath)
    if (!existsSync(dirname(target))) mkdirSync(dirname(target), { recursive: true })
    const oldSize = existing?.size ?? 0
    if (existing && existsSync(target) && oldSize !== buffer.length) {
      if (buffer.length > oldSize) {
        if (userQuota.used + (buffer.length - oldSize) > userQuota.limit) throw new EabError(EC.VALIDATION, '覆盖后超出个人配额')
      }
    }
    const operationId = existing ? `op_${ulid()}` : null
    const snapshot = existing
      ? snapshotWorkspaceVersion(deps, existing, {
          source: 'workspace.edit',
          operationId: operationId!,
          summary: '网页文本保存前版本',
          createdBy: actor.subject.userId,
        })
      : null
    const previousBuffer = existing && existsSync(target) ? readFileSync(target) : null
    writeFileSync(target, buffer)
    const now = Date.now()
    const id = existing?.id ?? ulid()
    let objectStorage: { driver: 's3'; bucket: string; key: string; status: 'stored' | 'failed' } | undefined
    if (isChatAttachmentRelPath(relPath)) {
      const store = attachmentObjectStoreOf(deps)
      if (store) {
        const objectKey = store.attachmentKey(actor.subject.companyId, actor.subject.userId, id)
        try {
          await store.put(
            objectKey,
            buffer,
            body.mime || 'application/octet-stream',
          )
          objectStorage = { driver: 's3', bucket: store.bucket, key: objectKey, status: 'stored' }
        } catch (error) {
          if (deps.config.objectStorage?.required) {
            // 强一致模式：本次元数据不推进，并恢复本地旧内容，避免“本地新、对象旧”。
            if (previousBuffer) writeFileSync(target, previousBuffer)
            else rmSync(target, { force: true })
            throw new EabError(EC.UPSTREAM, '附件对象存储写入失败，本次上传已回滚', {
              hint: '请检查 S3/MinIO 地址、桶名和密钥；也可以暂时删除 EAB_S3_ENDPOINT 只用本地磁盘。',
              cause: error,
            })
          }
          req.log.warn({ err: error, fileId: id }, 'chat attachment object storage mirror failed')
          objectStorage = { driver: 's3', bucket: store.bucket, key: objectKey, status: 'failed' }
        }
      }
    }
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
    audit(deps, req, existing ? 'workspace.file.update' : 'workspace.file.upload', row, {
      relPath,
      size: buffer.length,
      ...(existing
        ? {
          beforeSize: oldSize,
          afterSize: buffer.length,
          operationId,
          snapshotId: snapshot?.id ?? null,
          snapshotVersion: snapshot?.version ?? null,
        }
        : {}),
      ...(objectStorage ? { objectStorage } : {}),
    })
    publishWorkspaceFilesChanged(actor.subject.companyId, actor.subject.userId, existing ? 'updated' : 'created', [id])
    return ok({ ...publicFile(row), ...(objectStorage ? { objectStorage } : {}) })
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

  app.get<{ Params: { id: string } }>('/api/workspace/files/:id/versions', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.WORKSPACE_READ)
    return ok({ items: listWorkspaceFileVersions(deps, actor, req.params.id) })
  })

  /** 手动保存当前版本快照；插件/Agent 写入前也会自动写快照。 */
  app.post<{ Params: { id: string } }>('/api/workspace/files/:id/versions', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.WORKSPACE_WRITE)
    const snapshot = createWorkspaceFileSnapshot(deps, actor, req.params.id)
    appendAudit(deps.db, {
      companyId: actor.subject.companyId,
      actorUserId: actor.subject.userId,
      action: 'workspace.file.snapshot',
      resourceType: 'file',
      resourceId: req.params.id,
      resourceScope: `user:${actor.subject.userId}`,
      result: 'success',
      detail: { versionId: snapshot.id, version: snapshot.version, created: snapshot.created },
      traceId: String(req.id),
      ip: req.ip,
      channel: 'web',
    })
    return ok(snapshot)
  })

  app.get<{ Params: { id: string; versionId: string } }>(
    '/api/workspace/files/:id/versions/:versionId/download',
    async (req, reply) => {
      const actor = resolveActor(deps.db, deps.config, req)
      requireScope(actor.subject, SC.WORKSPACE_READ)
      const { row, version, buffer } = readWorkspaceFileVersion(deps, actor, req.params.id, req.params.versionId)
      appendAudit(deps.db, {
        companyId: actor.subject.companyId,
        actorUserId: actor.subject.userId,
        action: 'workspace.file.version_download',
        resourceType: 'file',
        resourceId: row.id,
        resourceScope: `${row.scope_type}:${row.scope_id}`,
        result: 'success',
        detail: { versionId: version.id, version: version.version, size: buffer.length },
        traceId: String(req.id),
        ip: req.ip,
        channel: 'web',
      })
      const name = `v${version.version}-${row.name}`
      reply
        .header('content-type', row.mime || 'application/octet-stream')
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
        .header('cache-control', 'no-store')
      return reply.send(buffer)
    },
  )

  app.post<{ Params: { id: string; versionId: string } }>(
    '/api/workspace/files/:id/versions/:versionId/restore',
    async (req) => {
      const actor = resolveActor(deps.db, deps.config, req)
      requireScope(actor.subject, SC.WORKSPACE_WRITE)
      const result = restoreWorkspaceFileVersion(deps, actor, req.params.id, req.params.versionId)
      appendAudit(deps.db, {
        companyId: actor.subject.companyId,
        actorUserId: actor.subject.userId,
        action: 'workspace.file.restore',
        resourceType: 'file',
        resourceId: req.params.id,
        resourceScope: `user:${actor.subject.userId}`,
        result: 'success',
        detail: {
          versionId: result.restoredVersion.id,
          version: result.restoredVersion.version,
          restoredAt: result.file.updatedAt,
          size: result.file.size,
        },
        traceId: String(req.id),
        ip: req.ip,
        channel: 'web',
      })
      return ok(result)
    },
  )

  /** 通过 OnlyOffice 转 PDF 后直接下载；不写回文件，不改变版本。 */
  app.post<{ Params: { id: string }; Body: { format?: string } }>(
    '/api/workspace/files/:id/export',
    async (req, reply) => {
      const actor = resolveActor(deps.db, deps.config, req)
      requireScope(actor.subject, SC.WORKSPACE_READ)
      const format = String(req.body?.format || 'pdf').toLowerCase()
      if (format !== 'pdf') throw new EabError(EC.VALIDATION, '当前只支持导出 PDF')
      let exported: Awaited<ReturnType<typeof exportWorkspaceFileToPdf>>
      try {
        exported = await exportWorkspaceFileToPdf(deps, actor, req.params.id)
      } catch (error) {
        appendAudit(deps.db, {
          companyId: actor.subject.companyId,
          actorUserId: actor.subject.userId,
          action: 'workspace.file.export',
          resourceType: 'file',
          resourceId: req.params.id,
          resourceScope: `user:${actor.subject.userId}`,
          result: 'failure',
          detail: { format, reason: error instanceof Error ? error.message : String(error) },
          traceId: String(req.id),
          ip: req.ip,
          channel: 'web',
        })
        throw error instanceof EabError
          ? error
          : new EabError(EC.INTERNAL, `导出 PDF 失败：${error instanceof Error ? error.message : String(error)}`)
      }
      const row = exported.row
      const buffer = exported.buffer
      appendAudit(deps.db, {
        companyId: actor.subject.companyId,
        actorUserId: actor.subject.userId,
        action: 'workspace.file.export',
        resourceType: 'file',
        resourceId: row.id,
        resourceScope: `${row.scope_type}:${row.scope_id}`,
        result: 'success',
        detail: { relPath: row.rel_path, format, size: buffer.length },
        traceId: String(req.id),
        ip: req.ip,
        channel: 'web',
      })
      const stem = row.name.replace(/\.[^.]+$/, '')
      reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${stem}.pdf`)}`)
        .header('cache-control', 'no-store')
      return reply.send(buffer)
    },
  )

  /**
   * GUI 兜底：只登记白名单动作和步骤，等待前端用户确认。
   * 这里绝不执行桌面点击、宏或打印；真正按钮由用户在 OnlyOffice 中点击。
   */
  app.post<{
    Params: { id: string }
    Body: { action?: string; dialog?: string; format?: string; note?: string }
  }>('/api/workspace/files/:id/gui-fallback', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.WORKSPACE_WRITE)
    const body = req.body ?? {}
    const result = prepareWorkspaceGuiFallback(deps, {
      actor,
      traceId: String(req.id),
      ip: req.ip,
      channel: 'web',
    }, {
      fileId: req.params.id,
      action: body.action,
      dialog: body.dialog,
      format: body.format,
      note: body.note,
    })
    return ok(result)
  })

  /** 只能由前端用户点击确认；Agent 工具没有这个动作。 */
  app.post<{ Params: { id: string; fallbackId: string } }>(
    '/api/workspace/files/:id/gui-fallback/:fallbackId/confirm',
    async (req) => {
      const actor = resolveActor(deps.db, deps.config, req)
      requireEnabled(actor)
      requireScope(actor.subject, SC.WORKSPACE_WRITE)
      const result = confirmWorkspaceGuiFallback(deps, {
        actor,
        traceId: String(req.id),
        ip: req.ip,
        channel: 'web',
      }, req.params.id, req.params.fallbackId)
      return ok(result)
    },
  )

  /** 上报人工结果；失败后同一条记录不得再次确认或上报。 */
  app.post<{
    Params: { id: string; fallbackId: string }
    Body: { result?: string; detail?: string }
  }>('/api/workspace/files/:id/gui-fallback/:fallbackId/report', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.WORKSPACE_WRITE)
    const body = req.body ?? {}
    const status = String(body.result ?? '').trim().toLowerCase()
    if (status !== 'success' && status !== 'failure') {
      throw new EabError(EC.VALIDATION, 'result 只能是 success 或 failure')
    }
    const result = reportWorkspaceGuiFallback(deps, {
      actor,
      traceId: String(req.id),
      ip: req.ip,
      channel: 'web',
    }, req.params.id, req.params.fallbackId, status, body.detail)
    return ok(result)
  })

  app.get<{ Params: { id: string; fallbackId: string } }>(
    '/api/workspace/files/:id/gui-fallback/:fallbackId',
    async (req) => {
      const actor = resolveActor(deps.db, deps.config, req)
      requireEnabled(actor)
      requireScope(actor.subject, SC.WORKSPACE_READ)
      const result = getWorkspaceGuiFallback(deps, {
        actor,
        traceId: String(req.id),
        ip: req.ip,
        channel: 'web',
      }, req.params.id, req.params.fallbackId)
      return ok(result)
    },
  )

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

  app.post<{ Body: { path?: string; name?: string } }>('/api/workspace/folders', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.WORKSPACE_WRITE)
    const folderPath = String(req.body?.path ?? req.body?.name ?? '').trim()
    if (!folderPath) throw new EabError(EC.VALIDATION, '文件夹路径不能为空')
    const created = createUserWorkspaceFolder(deps, actor, folderPath)
    audit(deps, req, 'workspace.folder.create', null, { folderPath: created.folderPath })
    return ok({ folderPath: created.folderPath, fileId: created.row.id })
  })

  app.patch<{ Body: { path?: string; newName?: string; name?: string } }>(
    '/api/workspace/folders',
    async (req) => {
      const actor = resolveActor(deps.db, deps.config, req)
      requireEnabled(actor)
      requireScope(actor.subject, SC.WORKSPACE_WRITE)
      const folderPath = String(req.body?.path ?? '').trim()
      if (!folderPath) throw new EabError(EC.VALIDATION, '文件夹路径不能为空')
      const renamed = renameUserWorkspaceFolder(
        deps,
        actor,
        folderPath,
        String(req.body?.newName ?? req.body?.name ?? ''),
      )
      audit(deps, req, 'workspace.folder.rename', null, {
        from: renamed.from,
        to: renamed.to,
        fileCount: renamed.fileCount,
      })
      return ok({
        folderPath: renamed.to,
        from: renamed.from,
        to: renamed.to,
        fileCount: renamed.fileCount,
      })
    },
  )

  app.delete<{ Body: { path?: string } }>('/api/workspace/folders', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.WORKSPACE_WRITE)
    const folderPath = String(req.body?.path ?? '').trim()
    if (!folderPath) throw new EabError(EC.VALIDATION, '文件夹路径不能为空')
    const deleted = deleteUserWorkspaceFolder(deps, actor, folderPath)
    audit(deps, req, 'workspace.folder.delete', null, {
      folderPath: deleted.folderPath,
      fileCount: deleted.fileCount,
      fileIds: deleted.fileIds,
    })
    return ok({
      deleted: true,
      folderPath: deleted.folderPath,
      fileCount: deleted.fileCount,
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
