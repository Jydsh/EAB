/**
 * Agent 产物登记。
 *
 * 产物只登记引用，不复制文件本体：
 * - 工作区文件写 `agent_artifacts` 元数据，并把引用追加到 `agent_tasks.artifacts_json`；
 * - 内联链接 / 外部协议产物只存 uri 和摘要，不在这里下载内容；
 * - 同一个任务里按 uri 去重，重复发布会更新 size / checksum / preview。
 *
 * 边界：
 * - 文件必须位于当前员工自己的云空间根目录内，符号链接也按真实路径校验；
 * - fileId 必须属于当前员工，不能借产物登记读取别人的文件；
 * - 登记失败不吞错：子 Agent 需要知道产物到底有没有交出去。
 */
import type { Db } from '@eab/storage'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, createReadStream, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, relative } from 'node:path'
import { EC, EabError } from '@eab/domain'
import { isWithinRoot, safeJoin } from '@eab/workspace'
import type { AgentTeamStore } from './agent-team.js'
import type { AgentArtifactRef, ArtifactSource } from './agent-protocol.js'

interface WorkspaceFileRow {
  id: string
  name: string
  rel_path: string
  size: number
  mime: string | null
}

interface ArtifactRow {
  id: string
  name: string
  mime_type: string | null
  size: number
  checksum: string
  source: string
  uri: string
  preview: string | null
}

export interface PublishAgentArtifactInput {
  db: Db
  team: AgentTeamStore
  taskId: string
  companyId: string
  userId: string
  /** 当前员工的个人云空间根目录；路径类产物必须落在它下面 */
  workspaceRoot: string
  path?: string
  fileId?: string
  uri?: string
  name?: string
  /** 外部 URI 的媒体类型；不传时按扩展名推断，仍无法识别则用 text/uri-list */
  mimeType?: string
  preview?: string
  now?: number
}

const MIME_BY_EXT: Record<string, string> = {
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function mimeOf(name: string, fallback: string | null | undefined): string {
  // 扩展名比 workspace_files 里可能过期的 mime 更可靠，先按扩展名推断。
  return MIME_BY_EXT[extname(name).toLowerCase()] || cleanText(fallback, 128) || 'application/octet-stream'
}

/** 预览是一条单行摘要，避免换行把父 Agent 的产物清单撑成多行。 */
function cleanPreview(value: unknown, max = 500): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, max)
    : ''
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '大小未知'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function isTextMime(mimeType: string): boolean {
  return /^text\//i.test(mimeType) ||
    /(?:json|xml|javascript|csv|markdown|yaml|sql|x-sh|x-python)/i.test(mimeType)
}

/**
 * 只读文件开头一小段，生成可核对的文本预览；二进制文件退化为元数据摘要。
 * 这里不能整文件读取，产物再大也只占固定内存。
 */
function readTextPreview(path: string, mimeType: string, size: number): string {
  if (!isTextMime(mimeType) || size <= 0) return ''
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(Math.min(1024, size))
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, read).toString('utf8')
      .replace(/^\uFEFF/, '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    return cleanPreview(text, 240)
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function metadataPreview(name: string, mimeType: string, size: number, external = false): string {
  const kind = external ? '外部产物' : '文件'
  const sizeText = size > 0 ? `，${formatBytes(size)}` : ''
  return `${kind}：${name}（${mimeType}${sizeText}）`
}

/**
 * 外部 URI 没有本地内容可算内容校验和，只能对“引用本身”做稳定指纹。
 * 前缀 ref-sha256 明确表示这是引用指纹，不是文件内容 sha256。
 */
function digestReference(uri: string, name: string, mimeType: string): string {
  return `ref-sha256:${createHash('sha256').update(`${uri}\n${name}\n${mimeType}`).digest('hex')}`
}

function sourceOfUri(uri: string): ArtifactSource {
  if (/^mcp:/i.test(uri)) return 'mcp'
  if (/^a2a:/i.test(uri)) return 'a2a'
  return 'inline'
}

function digestFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(`sha256:${hash.digest('hex')}`))
  })
}

function resolveWorkspacePath(root: string, rawPath: string): { absolute: string; relPath: string; name: string } {
  if (!existsSync(root)) {
    throw new EabError(EC.NOT_FOUND, '个人云空间目录还不存在，无法登记产物')
  }
  const rootReal = realpathSync(root)
  const normalized = rawPath.replace(/\\/g, '/')
  const relPath = isAbsolute(normalized)
    ? relative(rootReal, normalized).replace(/\\/g, '/')
    : normalized.replace(/^\.?\//, '')
  if (!relPath || relPath.startsWith('..') || isAbsolute(relPath)) {
    throw new EabError(EC.FORBIDDEN, '产物必须位于当前员工的个人云空间内')
  }
  const candidate = safeJoin(rootReal, relPath)
  if (!existsSync(candidate)) throw new EabError(EC.NOT_FOUND, `云空间里没有找到文件: ${rawPath}`)
  const real = realpathSync(candidate)
  if (!isWithinRoot(rootReal, real)) {
    throw new EabError(EC.FORBIDDEN, '产物必须位于当前员工的个人云空间内')
  }
  const stat = statSync(real)
  if (!stat.isFile()) throw new EabError(EC.VALIDATION, `不是文件: ${rawPath}`)
  return { absolute: real, relPath, name: basename(real) }
}

function findFileById(db: Db, companyId: string, userId: string, fileId: string): WorkspaceFileRow | null {
  const row = db.prepare(
    `SELECT id, name, rel_path, size, mime FROM workspace_files
      WHERE id = ? AND company_id = ? AND owner_user_id = ? AND deleted_at IS NULL`,
  ).get(fileId, companyId, userId) as unknown as WorkspaceFileRow | undefined
  return row ?? null
}

function findFileByRelPath(db: Db, companyId: string, userId: string, relPath: string): WorkspaceFileRow | null {
  const row = db.prepare(
    `SELECT id, name, rel_path, size, mime FROM workspace_files
      WHERE company_id = ? AND owner_user_id = ? AND rel_path = ? AND deleted_at IS NULL`,
  ).get(companyId, userId, relPath) as unknown as WorkspaceFileRow | undefined
  return row ?? null
}

function findArtifact(db: Db, teamId: string, taskId: string, uri: string): ArtifactRow | null {
  const row = db.prepare(
    `SELECT id, name, mime_type, size, checksum, source, uri, preview FROM agent_artifacts
      WHERE team_id = ? AND task_id = ? AND uri = ?`,
  ).get(teamId, taskId, uri) as unknown as ArtifactRow | undefined
  return row ?? null
}

function persistArtifact(
  db: Db,
  team: AgentTeamStore,
  taskId: string,
  input: {
    companyId: string
    userId: string
    name: string
    mimeType: string
    size: number
    checksum: string
    source: ArtifactSource
    uri: string
    preview?: string
    fileId?: string
  },
  now: number,
): AgentArtifactRef {
  const existing = findArtifact(db, team.teamId, taskId, input.uri)
  const id = existing?.id ?? `art_${randomUUID()}`
  if (existing) {
    db.prepare(
      `UPDATE agent_artifacts
          SET name = ?, mime_type = ?, size = ?, checksum = ?, source = ?, preview = ?
        WHERE id = ?`,
    ).run(
      input.name,
      input.mimeType,
      input.size,
      input.checksum,
      input.source,
      input.preview ?? '',
      id,
    )
  } else {
    db.prepare(
      `INSERT INTO agent_artifacts
         (id, company_id, user_id, team_id, task_id, name, mime_type, size, checksum, source, uri, preview, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.companyId,
      input.userId,
      team.teamId,
      taskId,
      input.name,
      input.mimeType,
      input.size,
      input.checksum,
      input.source,
      input.uri,
      input.preview ?? '',
      now,
    )
  }
  const ref: AgentArtifactRef = {
    id,
    name: input.name,
    mimeType: input.mimeType,
    size: input.size,
    checksum: input.checksum,
    source: input.source,
    uri: input.uri,
    ...(input.fileId ? { fileId: input.fileId } : {}),
    ...(input.preview ? { preview: input.preview } : {}),
  }
  team.appendTaskArtifact(taskId, ref, now)
  return ref
}

/**
 * 给一个运行中的任务登记产物。返回登记后的引用（可能是更新后的旧引用）。
 */
export async function publishAgentArtifact(input: PublishAgentArtifactInput): Promise<AgentArtifactRef> {
  const task = input.team.getTask(input.taskId)
  if (!task) throw new EabError(EC.NOT_FOUND, `任务不存在：${input.taskId}`)
  if (task.status !== 'queued' && task.status !== 'running') {
    throw new EabError(EC.VALIDATION, `任务已结束（${task.status}），不能再登记产物`)
  }

  const now = input.now ?? Date.now()
  const name = cleanText(input.name, 256)
  const preview = cleanPreview(input.preview, 500)
  const rawPath = cleanText(input.path, 1000)
  const fileId = cleanText(input.fileId, 128)
  const uriText = cleanText(input.uri, 2000)
  const requestedMime = cleanText(input.mimeType, 128)

  const modes = [rawPath, fileId, uriText].filter(Boolean).length
  if (modes !== 1) {
    throw new EabError(EC.VALIDATION, 'path、fileId、uri 必须且只能提供一个')
  }

  if (rawPath) {
    const resolved = resolveWorkspacePath(input.workspaceRoot, rawPath)
    const row = findFileByRelPath(input.db, input.companyId, input.userId, resolved.relPath)
    const stat = statSync(resolved.absolute)
    const artifactName = name || row?.name || resolved.name
    const mimeType = mimeOf(resolved.name, row?.mime)
    const artifactUri = row ? `eab://workspace/file/${row.id}` : `eab://workspace/path/${encodeURIComponent(resolved.relPath)}`
    return persistArtifact(input.db, input.team, input.taskId, {
      companyId: input.companyId,
      userId: input.userId,
      name: artifactName,
      mimeType,
      size: stat.size,
      checksum: await digestFile(resolved.absolute),
      source: 'workspace',
      uri: artifactUri,
      preview: preview || readTextPreview(resolved.absolute, mimeType, stat.size) || metadataPreview(artifactName, mimeType, stat.size),
      ...(row ? { fileId: row.id } : {}),
    }, now)
  }

  if (fileId) {
    const row = findFileById(input.db, input.companyId, input.userId, fileId)
    if (!row) throw new EabError(EC.NOT_FOUND, `云空间里没有找到文件: ${fileId}`)
    const resolved = resolveWorkspacePath(input.workspaceRoot, row.rel_path)
    const stat = statSync(resolved.absolute)
    const artifactName = name || row.name
    const mimeType = mimeOf(row.name, row.mime)
    return persistArtifact(input.db, input.team, input.taskId, {
      companyId: input.companyId,
      userId: input.userId,
      name: artifactName,
      mimeType,
      size: stat.size,
      checksum: await digestFile(resolved.absolute),
      source: 'cloud',
      uri: `eab://workspace/file/${row.id}`,
      preview: preview || readTextPreview(resolved.absolute, mimeType, stat.size) || metadataPreview(artifactName, mimeType, stat.size),
      fileId: row.id,
    }, now)
  }

  if (!/^(mcp|a2a|https?|eab):/i.test(uriText)) {
    throw new EabError(EC.VALIDATION, 'uri 只支持 mcp: / a2a: / https: / http: / eab: 协议')
  }
  if (!name) throw new EabError(EC.VALIDATION, '登记外部 uri 产物时必须提供 name')
  const mimeType = requestedMime || MIME_BY_EXT[extname(name).toLowerCase()] || 'text/uri-list'
  return persistArtifact(input.db, input.team, input.taskId, {
    companyId: input.companyId,
    userId: input.userId,
    name,
    mimeType,
    size: 0,
    checksum: digestReference(uriText, name, mimeType),
    source: sourceOfUri(uriText),
    uri: uriText,
    preview: preview || metadataPreview(name, mimeType, 0, true),
  }, now)
}
