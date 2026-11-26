/**
 * 本地项目空间。
 *
 * 与云空间不同，本地项目直接落在用户电脑上的真实目录，不经过 workspace_files 元数据。
 * 这里集中处理三件事：
 * 1. 目录登记与归属：每个员工只能看到自己创建的本地项目；
 * 2. 路径安全：所有相对路径都限制在项目根目录内，拒绝盘符根和系统目录；
 * 3. 敏感文件闸：`.env`、私钥、云厂商凭据默认不读不写，避免模型把密钥带进上下文。
 */
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { EabError, EC, ulid } from '@eab/domain'
import { isWithinRoot, safeJoin } from '@eab/workspace'
import type { Db } from '@eab/storage'

export const MAX_LOCAL_PROJECTS = 20
const MAX_NAME_LENGTH = 60
const MAX_PATH_LENGTH = 500
const DEFAULT_LIST_LIMIT = 300

/** 这些目录不允许被登记为项目根：误选会把整个系统盘暴露给 Agent。 */
const BLOCKED_ROOTS = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\Recovery',
  'C:\\Boot',
  'C:\\System Volume Information',
  'C:\\Users',
  'C:\\',
  'D:\\',
  'E:\\',
  'F:\\',
]
const BLOCKED_ROOTS_LC = BLOCKED_ROOTS.map((item) => item.toLowerCase())

/** 列表里跳过的大目录；Agent 需要时可以直接指定子路径。 */
const HEAVY_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'target',
  '.gradle',
  '.idea',
  '.vs',
  'coverage',
  'logs',
])

const SENSITIVE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials.json',
])
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore'])

export interface LocalProjectRow {
  id: string
  company_id: string
  user_id: string
  name: string
  root_path: string
  root_realpath: string
  mode: string
  allow_sensitive: number
  device_id: string | null
  instructions: string | null
  cloud_refs_json: string | null
  created_at: number
  updated_at: number
  last_used_at: number | null
  deleted_at: number | null
}

export interface LocalProject {
  id: string
  name: string
  rootPath: string
  rootRealPath: string
  mode: 'read_write' | 'read_only'
  allowSensitive: boolean
  /** 项目绑定的桌面设备；旧数据为空时仍按服务端本机目录兼容。 */
  deviceId: string | null
  /** 项目指令，项目内所有对话与工作任务共用。 */
  instructions: string
  /** 云端资源路径（来自 EAB 云空间）。 */
  cloudRefs: string[]
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

export interface LocalProjectEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  size: number
  updatedAt: number
}

function parseCloudRefs(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, 100)
      : []
  } catch {
    return []
  }
}

function toProject(row: LocalProjectRow): LocalProject {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    rootRealPath: row.root_realpath,
    mode: row.mode === 'read_only' ? 'read_only' : 'read_write',
    allowSensitive: Boolean(row.allow_sensitive),
    deviceId: row.device_id ? String(row.device_id) : null,
    instructions: String(row.instructions ?? ''),
    cloudRefs: parseCloudRefs(row.cloud_refs_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
  }
}

export function listLocalProjects(db: Db, companyId: string, userId: string): LocalProject[] {
  const rows = db
    .prepare(
      `SELECT * FROM user_local_spaces
        WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL
        ORDER BY COALESCE(last_used_at, updated_at) DESC`,
    )
    .all(companyId, userId) as unknown as LocalProjectRow[]
  return rows.map(toProject)
}

export function getLocalProject(
  db: Db,
  companyId: string,
  userId: string,
  id: string,
): LocalProject | null {
  const row = db
    .prepare(
      `SELECT * FROM user_local_spaces
        WHERE id = ? AND company_id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .get(id, companyId, userId) as LocalProjectRow | undefined
  return row ? toProject(row) : null
}

/** 会话恢复时按 space_id 取项目，归属不符按“项目已删除”处理，绝不跨员工读取。 */
export function getLocalProjectForSession(
  db: Db,
  companyId: string,
  userId: string,
  id: string | null | undefined,
): LocalProject | null {
  const clean = String(id ?? '').trim()
  if (!clean) return null
  return getLocalProject(db, companyId, userId, clean)
}

export function touchLocalProject(db: Db, id: string, companyId: string, userId: string): void {
  db.prepare(
    `UPDATE user_local_spaces SET last_used_at = ?, updated_at = updated_at
      WHERE id = ? AND company_id = ? AND user_id = ? AND deleted_at IS NULL`,
  ).run(Date.now(), id, companyId, userId)
}

function normalizeProjectName(raw: unknown, fallback: string): string {
  const text = String(raw ?? '').trim().replace(/\s+/g, ' ')
  return (text || fallback).slice(0, MAX_NAME_LENGTH)
}

function assertUsableRoot(rawPath: string): { rootPath: string; rootRealPath: string; name: string } {
  const trimmed = String(rawPath ?? '').trim()
  if (!trimmed) throw new EabError(EC.VALIDATION, '请选择项目文件夹')
  if (trimmed.length > MAX_PATH_LENGTH) throw new EabError(EC.VALIDATION, '项目路径过长')
  if (!isAbsolute(trimmed)) throw new EabError(EC.VALIDATION, '项目路径必须是绝对路径')

  const rootPath = resolve(trimmed)
  let stat
  try {
    stat = statSync(rootPath)
  } catch {
    throw new EabError(EC.NOT_FOUND, `文件夹不存在或无法访问：${rootPath}`)
  }
  if (!stat.isDirectory()) throw new EabError(EC.VALIDATION, '项目路径必须是文件夹，不能是文件')

  const rootRealPath = realpathSync(rootPath)
  const lower = rootRealPath.toLowerCase().replace(/[\\/]+$/, '')
  // 盘符根（C:\）和系统目录直接拒绝；C:\Users 只拒绝本身，允许其下具体项目目录。
  const isDriveRoot = /^[a-z]:$/i.test(lower)
  if (isDriveRoot || BLOCKED_ROOTS_LC.includes(lower)) {
    throw new EabError(EC.VALIDATION, '不能把磁盘根目录或系统目录登记为项目；请选择具体的项目文件夹')
  }
  if (lower === 'c:\\users') {
    throw new EabError(EC.VALIDATION, '不能把整个用户目录登记为项目；请选择其中的具体项目文件夹')
  }

  try {
    accessSync(rootRealPath, constants.W_OK)
  } catch {
    throw new EabError(EC.VALIDATION, '这个文件夹当前不可写，无法作为项目目录')
  }

  return { rootPath, rootRealPath, name: basename(rootRealPath) }
}

export interface CreateLocalProjectInput {
  path: string
  name?: string
  mode?: 'read_write' | 'read_only'
  allowSensitive?: boolean
  /** 桌面端创建时传入；服务端不直接访问 root_path。 */
  deviceId?: string | null
  /** 客户端校验后的真实路径。 */
  rootRealPath?: string
  instructions?: string
  cloudRefs?: string[]
}

export function createLocalProject(
  db: Db,
  companyId: string,
  userId: string,
  input: CreateLocalProjectInput,
): { project: LocalProject; created: boolean } {
  let rootPath: string
  let rootRealPath: string
  let detectedName: string
  if (input.deviceId) {
    const trimmed = String(input.path ?? '').trim()
    if (!trimmed || trimmed.length > MAX_PATH_LENGTH || !isAbsolute(trimmed)) {
      throw new EabError(EC.VALIDATION, '请选择桌面电脑上的项目文件夹')
    }
    rootPath = resolve(trimmed)
    rootRealPath = String(input.rootRealPath ?? '').trim()
    if (!rootRealPath || !isAbsolute(rootRealPath)) {
      throw new EabError(EC.VALIDATION, '桌面端没有返回有效的项目目录')
    }
    detectedName = basename(rootRealPath)
  } else {
    const verified = assertUsableRoot(input.path)
    rootPath = verified.rootPath
    rootRealPath = verified.rootRealPath
    detectedName = verified.name
  }
  const existing = db
    .prepare(
      `SELECT * FROM user_local_spaces
        WHERE company_id = ? AND user_id = ? AND root_realpath = ?
          AND COALESCE(device_id, '') = ? AND deleted_at IS NULL`,
    )
    .get(companyId, userId, rootRealPath, input.deviceId ?? '') as LocalProjectRow | undefined
  if (existing) {
    touchLocalProject(db, existing.id, companyId, userId)
    const project = getLocalProject(db, companyId, userId, existing.id) ?? toProject(existing)
    return { project: { ...project, name: existing.name }, created: false }
  }

  const count = db
    .prepare(
      'SELECT COUNT(*) AS n FROM user_local_spaces WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL',
    )
    .get(companyId, userId) as { n: number }
  if (Number(count.n) >= MAX_LOCAL_PROJECTS) {
    throw new EabError(
      EC.VALIDATION,
      `本地项目最多 ${MAX_LOCAL_PROJECTS} 个，请先删除不再使用的项目`,
    )
  }

  const now = Date.now()
  const id = `lp_${ulid()}`
  const projectName = normalizeProjectName(input.name, detectedName)
  const instructions = String(input.instructions ?? '').trim().slice(0, 8000)
  const cloudRefs = (input.cloudRefs ?? [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 100)
  db.prepare(
    `INSERT INTO user_local_spaces
      (id, company_id, user_id, name, root_path, root_realpath, mode, allow_sensitive,
       device_id, instructions, cloud_refs_json, created_at, updated_at, last_used_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    companyId,
    userId,
    projectName,
    rootPath,
    rootRealPath,
    input.mode === 'read_only' ? 'read_only' : 'read_write',
    input.allowSensitive ? 1 : 0,
    input.deviceId ?? null,
    instructions,
    JSON.stringify(cloudRefs),
    now,
    now,
    now,
  )

  return {
    project: {
      id,
      name: projectName,
      rootPath,
      rootRealPath,
      mode: input.mode === 'read_only' ? 'read_only' : 'read_write',
      allowSensitive: Boolean(input.allowSensitive),
      deviceId: input.deviceId ?? null,
      instructions,
      cloudRefs,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    },
    created: true,
  }
}

export function updateLocalProject(
  db: Db,
  companyId: string,
  userId: string,
  id: string,
  patch: { name?: string; mode?: 'read_write' | 'read_only'; allowSensitive?: boolean; instructions?: string; cloudRefs?: string[] },
): LocalProject {
  const project = getLocalProject(db, companyId, userId, id)
  if (!project) throw new EabError(EC.NOT_FOUND, '项目不存在或已删除')
  const now = Date.now()
  const nextInstructions = patch.instructions === undefined
    ? project.instructions
    : String(patch.instructions ?? '').trim().slice(0, 8000)
  const nextCloudRefs = patch.cloudRefs === undefined
    ? project.cloudRefs
    : patch.cloudRefs.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, 100)
  db.prepare(
    `UPDATE user_local_spaces
        SET name = ?, mode = ?, allow_sensitive = ?, instructions = ?, cloud_refs_json = ?, updated_at = ?
      WHERE id = ? AND company_id = ? AND user_id = ?`,
  ).run(
    patch.name === undefined ? project.name : normalizeProjectName(patch.name, project.name),
    patch.mode ?? project.mode,
    (patch.allowSensitive ?? project.allowSensitive) ? 1 : 0,
    nextInstructions,
    JSON.stringify(nextCloudRefs),
    now,
    id,
    companyId,
    userId,
  )
  return getLocalProject(db, companyId, userId, id) as LocalProject
}

/** 删除只解除绑定，不删除用户磁盘上的文件；项目内的对话随项目一起逻辑删除。 */
export function deleteLocalProject(db: Db, companyId: string, userId: string, id: string): void {
  const project = getLocalProject(db, companyId, userId, id)
  if (!project) throw new EabError(EC.NOT_FOUND, '项目不存在或已删除')
  const now = Date.now()
  db.prepare(
    `UPDATE user_local_spaces SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND company_id = ? AND user_id = ?`,
  ).run(now, now, id, companyId, userId)
  db.prepare(
    `UPDATE chat_sessions SET deleted_at = ?, updated_at = ?
      WHERE company_id = ? AND user_id = ? AND space_kind = 'local' AND space_id = ? AND deleted_at IS NULL`,
  ).run(now, now, companyId, userId, id)
}

export function isSensitiveLocalPath(relPath: string): boolean {
  const clean = String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = clean.split('/').filter(Boolean)
  if (parts.some((part) => part.toLowerCase() === '.ssh' || part.toLowerCase() === '.aws')) return true
  const name = (parts.at(-1) ?? '').toLowerCase()
  if (SENSITIVE_NAMES.has(name)) return true
  if (name.startsWith('service-account') && name.endsWith('.json')) return true
  return SENSITIVE_EXTENSIONS.has(extname(name))
}

/**
 * 把相对路径落到项目根下。绝对路径只允许本身就在项目根内；
 * 存在的目标会再做一次 realpath 校验，防止通过符号链接跳出项目。
 */
export function resolveLocalProjectPath(project: LocalProject, rawPath: unknown): string {
  const value = String(rawPath ?? '').trim() || '.'
  if (value.length > MAX_PATH_LENGTH) throw new EabError(EC.VALIDATION, '路径过长')
  if (isSensitiveLocalPath(value) && !project.allowSensitive) {
    throw new EabError(EC.FORBIDDEN, `敏感文件默认不可访问：${value}`)
  }

  const root = project.rootRealPath
  let candidate: string
  if (!value || value === '.' || value === './') {
    // 空路径代表项目根目录本身；safeJoin 会把它当成非法空段拒绝。
    candidate = root
  } else if (isAbsolute(value)) {
    if (!isWithinRoot(root, value)) {
      throw new EabError(EC.FORBIDDEN, '路径必须位于当前项目目录内')
    }
    candidate = resolve(value)
  } else {
    candidate = safeJoin(root, value)
  }
  if (!candidate) throw new EabError(EC.VALIDATION, '非法路径')
  if (!isWithinRoot(root, candidate)) throw new EabError(EC.FORBIDDEN, '路径必须位于当前项目目录内')

  // 目标存在时 realpath 可能是另一个位置（符号链接）；必须仍落在项目内。
  if (existsSync(candidate)) {
    const real = realpathSync(candidate)
    if (!isWithinRoot(root, real)) throw new EabError(EC.FORBIDDEN, '路径必须位于当前项目目录内')
  } else {
    // 新文件/新目录：逐级向上找到已存在的父目录，确认父目录真实路径在项目内。
    let parent = dirname(candidate)
    for (let i = 0; i < 32; i += 1) {
      if (existsSync(parent)) {
        const realParent = realpathSync(parent)
        if (!isWithinRoot(root, realParent)) throw new EabError(EC.FORBIDDEN, '路径必须位于当前项目目录内')
        break
      }
      const next = dirname(parent)
      if (next === parent) break
      parent = next
    }
  }
  return candidate
}

export function localProjectRelPath(project: LocalProject, absPath: string): string {
  return relative(project.rootRealPath, absPath).replace(/\\/g, '/')
}

/**
 * 列出项目目录。默认只列一层；Agent 需要树状结构时 depth 可到 3。
 * `limit` 是全局条数上限，超过时 truncated=true，由前端提示用户缩小范围。
 */
export function listLocalProjectEntries(
  project: LocalProject,
  rawPath: unknown,
  options: { depth?: number; limit?: number } = {},
): { path: string; entries: LocalProjectEntry[]; truncated: boolean; total: number } {
  const target = resolveLocalProjectPath(project, rawPath)
  if (!existsSync(target)) throw new EabError(EC.NOT_FOUND, `项目路径不存在：${String(rawPath ?? '')}`)
  if (!statSync(target).isDirectory()) throw new EabError(EC.VALIDATION, '只能列出文件夹')

  const depth = Math.min(3, Math.max(0, Math.trunc(options.depth ?? 1)))
  const limit = Math.min(1000, Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIST_LIMIT)))
  const entries: LocalProjectEntry[] = []
  let total = 0
  let truncated = false

  const walk = (dir: string, level: number) => {
    let list
    try {
      list = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const sorted = [...list].sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
    for (const item of sorted) {
      if (entries.length >= limit) {
        truncated = true
        return
      }
      if (item.isSymbolicLink()) continue
      const abs = join(dir, item.name)
      const rel = localProjectRelPath(project, abs)
      const isDir = item.isDirectory()
      if (isDir && HEAVY_DIRS.has(item.name.toLowerCase())) {
        total += 1
        entries.push({ name: item.name, path: rel, type: 'dir', size: 0, updatedAt: 0 })
        continue
      }
      total += 1
      if (isDir) {
        entries.push({ name: item.name, path: rel, type: 'dir', size: 0, updatedAt: 0 })
        if (level < depth) walk(abs, level + 1)
      } else if (item.isFile()) {
        let size = 0
        let updatedAt = 0
        try {
          const info = statSync(abs)
          size = info.size
          updatedAt = info.mtimeMs
        } catch {
          // 单个文件读元信息失败不影响目录列表
        }
        entries.push({ name: item.name, path: rel, type: 'file', size, updatedAt })
      }
      if (truncated) return
    }
  }

  walk(target, 0)
  return {
    path: target === project.rootRealPath ? '' : localProjectRelPath(project, target),
    entries,
    truncated,
    total,
  }
}
