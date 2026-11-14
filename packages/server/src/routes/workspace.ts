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
  buildOfficeEditorConfig,
  buildOfficePluginConfig,
  forceSaveOfficeDocument,
  officeDocumentKey,
  officeDocumentType,
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
 * 进程内保存即可：回调在编辑器关闭后几秒内到达，不跨重启。
 */
const officeRefreshCutoffs = new Map<string, number>()

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

const OFFICE_TOKEN_TTL_SEC = 12 * 60 * 60
const OFFICE_PLUGIN_TOKEN_TTL_SEC = 10 * 60

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

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.xml',
  '.yaml', '.yml', '.ini', '.conf', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.html', '.htm', '.sql', '.py', '.sh', '.ps1', '.bat', '.toml',
])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif'])

/** 局部编辑只允许纯文本类文件；Office 二进制仍走 OnlyOffice。 */
export function isTextEditableFile(nameOrPath: string): boolean {
  const ext = extname(String(nameOrPath || '')).toLowerCase()
  return TEXT_EXTENSIONS.has(ext)
}

export interface WorkspaceTextEdit {
  find: string
  replace: string
  occurrence?: number
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
    if (find === replace) throw new EabError(EC.VALIDATION, 'replace 与 find 相同，没有实际修改')
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
  const token = issueOfficeToken(deps, row, userId, mode, 'callback')
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
    detail: { relPath: row.rel_path, size: buffer.length, source: 'onlyoffice' },
    traceId: String(req.id),
    ip: req.ip,
    channel: 'web',
  })
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
    detail: { relPath: row.rel_path, size: buffer.length, ...detail },
    traceId: null,
    ip: null,
    channel: 'agent',
  })
  return {
    id: row.id,
    name: row.name,
    relPath: row.rel_path,
    size: buffer.length,
    updatedAt: now,
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
      officeRefreshCutoffs.set(officeRefreshKey(row.company_id, row.id), row.updated_at)
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
      const cutoff = officeRefreshCutoffs.get(officeRefreshKey(row.company_id, row.id))
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
