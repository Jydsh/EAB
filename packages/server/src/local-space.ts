/**
 * 本地空间（Local Space）核心：路径边界、目录读取、文本写入、移动。
 *
 * 设计前提：EAB 服务端与用户本地目录在同一台电脑上。当前版本不经过本地连接器，
 * 所有操作由服务端 Node 进程直接执行。
 *
 * 安全边界：
 * - 所有相对路径先过 `normalizeRelativePath`，再用 `safeJoin` 限定在绑定根目录内；
 * - 对已存在目标/最近存在父目录做 `realpath`，拒绝 symlink/junction 逃逸；
 * - 默认拒绝敏感文件；默认拒绝盘符根目录、系统目录、UNC；
 * - 只读空间不允许写入/移动/建目录。
 */
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EC, EabError, type Scope } from '@eab/domain'
import type { Db } from '@eab/storage'
import { isWithinRoot, normalizeRelativePath, safeJoin } from '@eab/workspace'

export const LOCAL_TEXT_MAX_BYTES = 5 * 1024 * 1024
export const LOCAL_BINARY_MAX_BYTES = 50 * 1024 * 1024
export const LOCAL_ENTRY_LIMIT = 200
export const LOCAL_RECURSIVE_LIMIT = 500

const HEAVY_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
])

const SENSITIVE_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.config'])
const SENSITIVE_FILES = new Set(['.npmrc', '.pypirc', '.netrc', 'credentials'])
const SENSITIVE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx']
const ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template'])

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini',
  '.csv', '.tsv', '.log', '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte',
  '.py', '.java', '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.kts',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.sql', '.graphql', '.gql', '.dockerfile', '.gitignore', '.editorconfig',
])

export type LocalSpaceMode = 'read_only' | 'read_write'

export interface LocalSpaceRow {
  id: string
  company_id: string
  user_id: string
  name: string
  root_path: string
  root_realpath: string
  mode: LocalSpaceMode
  allow_sensitive: number
  created_at: number
  updated_at: number
  last_used_at: number | null
  deleted_at: number | null
}

export interface LocalSpacePublic {
  id: string
  name: string
  rootPath: string
  mode: LocalSpaceMode
  allowSensitive: boolean
  available: boolean
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

export type ActiveSpace =
  /** channel 只用于区分同一云空间在不同入口的交付方式，不改变工具可见性。 */
  | { kind: 'cloud'; channel?: 'dingtalk-a2ui' | 'dingtalk-file' }
  | { kind: 'none' }
  | { kind: 'local'; spaceId: string }

export interface LocalEntry {
  name: string
  relPath: string
  type: 'dir' | 'file'
  size: number
  mtime: number
}

interface ResolvedTarget {
  abs: string
  rel: string
}

function fail(message: string, details?: Record<string, unknown>): never {
  throw new EabError(EC.VALIDATION, message, { details })
}

function cleanName(input: string): string {
  const name = input.replace(/\s+/g, ' ').trim()
  if (!name) fail('空间名称不能为空')
  if (name.length > 40) fail('空间名称不能超过 40 个字符')
  return name
}

/** 空字符串代表根目录；其余必须过路径安全规范化。 */
export function normalizeLocalPath(input: string | null | undefined): string {
  const raw = String(input ?? '').trim()
  if (raw === '' || raw === '.') return ''
  return normalizeRelativePath(raw)
}

function joinRel(base: string, name: string): string {
  return base ? `${base}/${name}` : name
}

function isSensitiveRel(rel: string): boolean {
  const segments = rel.split('/').filter(Boolean).map((segment) => segment.toLowerCase())
  for (const segment of segments) {
    if (SENSITIVE_DIRS.has(segment)) return true
    if (SENSITIVE_FILES.has(segment)) return true
    if (segment === '.env') return true
    if (segment.startsWith('.env.') && !ENV_EXAMPLES.has(segment)) return true
    if (
      (segment.startsWith('id_rsa') ||
        segment.startsWith('id_dsa') ||
        segment.startsWith('id_ecdsa') ||
        segment.startsWith('id_ed25519')) &&
      !segment.endsWith('.pub')
    ) {
      return true
    }
    if (SENSITIVE_EXTENSIONS.some((ext) => segment.endsWith(ext))) return true
  }
  return false
}

function assertSensitiveAllowed(row: LocalSpaceRow, rel: string): void {
  if (row.allow_sensitive) return
  if (isSensitiveRel(rel)) {
    throw new EabError(EC.FORBIDDEN, '该路径属于敏感文件，当前本地空间未允许读取', {
      details: { path: rel },
    })
  }
}

function assertModeWrite(row: LocalSpaceRow): void {
  if (row.mode !== 'read_write') {
    throw new EabError(EC.FORBIDDEN, '当前本地空间是只读模式，不能写入或修改')
  }
}

function isHeavyDir(name: string): boolean {
  return HEAVY_DIRS.has(name.toLowerCase())
}

function realpathOfExistingOrParent(abs: string): string {
  let current = abs
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(current)) return realpathSync(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  fail('无法解析目标路径')
}

function assertNoSymlinkTarget(abs: string): void {
  if (!existsSync(abs)) return
  const stat = lstatSync(abs)
  if (stat.isSymbolicLink()) fail('不允许访问符号链接')
}

/**
 * 把相对路径解析成绑定根目录内的绝对路径。
 * 对已存在的目标和最近存在的父目录都做 realpath 校验，防止 symlink 越界。
 */
export function resolveLocalTarget(row: LocalSpaceRow, relInput: string): ResolvedTarget {
  const rel = normalizeLocalPath(relInput)
  if (rel) assertSensitiveAllowed(row, rel)
  const root = resolve(row.root_realpath)
  const abs = rel ? safeJoin(root, rel) : root
  assertNoSymlinkTarget(abs)
  const real = realpathOfExistingOrParent(abs)
  if (!isWithinRoot(root, real)) {
    throw new EabError(EC.FORBIDDEN, '目标路径超出本地空间根目录', {
      details: { path: rel },
    })
  }
  return { abs, rel }
}

export function validateLocalRoot(input: string): { rootPath: string; rootRealpath: string } {
  const rootPath = String(input ?? '').trim()
  if (!rootPath) fail('请填写本地目录绝对路径')
  if (!isAbsolute(rootPath)) fail('本地目录必须是绝对路径')
  if (rootPath.startsWith('\\\\') || rootPath.startsWith('//')) {
    fail('一期不支持 UNC 网络路径，请选择本机目录')
  }
  if (!existsSync(rootPath)) fail('目录不存在，请检查路径')
  const stat = statSync(rootPath)
  if (!stat.isDirectory()) fail('指定的路径不是目录')

  let rootRealpath: string
  try {
    rootRealpath = realpathSync(rootPath)
  } catch {
    fail('无法解析目录，请检查权限')
  }

  const rootAbs = resolve(rootRealpath)
  if (rootAbs === parse(rootAbs).root) fail('不能把整个磁盘根目录绑定为本地空间')

  const blocked: string[] = []
  for (const envName of ['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    const value = process.env[envName]
    if (value) blocked.push(value)
  }

  for (const block of blocked) {
    if (!existsSync(block)) continue
    if (isWithinRoot(realpathSync(block), rootAbs)) {
      fail('不能绑定 Windows 系统目录，请选择具体项目目录')
    }
  }

  const home = homedir()
  if (home && existsSync(home) && rootAbs.toLowerCase() === resolve(home).toLowerCase()) {
    fail('不能绑定用户主目录根路径，请选择具体项目目录')
  }

  return { rootPath, rootRealpath: rootAbs }
}

/** read_write 绑定前做一次真实写入探针，避免“看起来能写、实际只读”。 */
export function probeLocalWritable(rootRealpath: string): void {
  let probeDir = ''
  try {
    probeDir = mkdtempSync(join(rootRealpath, '.eab-write-probe-'))
    const probeFile = join(probeDir, 'probe.txt')
    writeFileSync(probeFile, 'ok', 'utf8')
    const readBack = readFileSync(probeFile, 'utf8')
    if (readBack !== 'ok') fail('目录写入校验失败')
  } catch (error) {
    if (error instanceof EabError) throw error
    fail('目录不可写，请检查权限或换一个目录')
  } finally {
    if (probeDir) {
      try {
        rmSync(probeDir, { recursive: true, force: true })
      } catch {
        // 探针清理失败不影响绑定；目录名带 .eab-write-probe-，列表会忽略。
      }
    }
  }
}

export function publicLocalSpace(row: LocalSpaceRow): LocalSpacePublic {
  let available = false
  try {
    available = statSync(row.root_realpath).isDirectory()
  } catch {
    available = false
  }
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    mode: row.mode,
    allowSensitive: Boolean(row.allow_sensitive),
    available,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(Number(row.last_used_at)).toISOString() : null,
  }
}

export function listLocalSpaceRows(db: Db, companyId: string, userId: string): LocalSpaceRow[] {
  return db
    .prepare(
      `SELECT * FROM user_local_spaces
        WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL
        ORDER BY last_used_at DESC, updated_at DESC`,
    )
    .all(companyId, userId) as unknown as LocalSpaceRow[]
}

export function findLocalSpaceRow(
  db: Db,
  companyId: string,
  userId: string,
  id: string,
): LocalSpaceRow | undefined {
  return db
    .prepare(
      `SELECT * FROM user_local_spaces
        WHERE id = ? AND company_id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .get(id, companyId, userId) as LocalSpaceRow | undefined
}

export function insertLocalSpaceRow(
  db: Db,
  input: {
    companyId: string
    userId: string
    name: string
    rootPath: string
    rootRealpath: string
    mode: LocalSpaceMode
    allowSensitive: boolean
  },
): LocalSpaceRow {
  const now = Date.now()
  const id = `lsp_${randomUUID()}`
  const duplicate = db
    .prepare(
      `SELECT id FROM user_local_spaces
        WHERE company_id = ? AND user_id = ? AND root_realpath = ? AND deleted_at IS NULL`,
    )
    .get(input.companyId, input.userId, input.rootRealpath)
  if (duplicate) {
    throw new EabError(EC.CONFLICT, '这个目录已经绑定过了，请直接使用已有空间')
  }
  db.prepare(
    `INSERT INTO user_local_spaces
      (id, company_id, user_id, name, root_path, root_realpath, mode, allow_sensitive, created_at, updated_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.companyId,
    input.userId,
    cleanName(input.name),
    input.rootPath,
    input.rootRealpath,
    input.mode,
    input.allowSensitive ? 1 : 0,
    now,
    now,
    now,
  )
  const row = findLocalSpaceRow(db, input.companyId, input.userId, id)
  if (!row) throw new EabError(EC.INTERNAL, '本地空间创建后读取失败')
  return row
}

export function touchLocalSpace(db: Db, id: string): void {
  db.prepare('UPDATE user_local_spaces SET last_used_at = ? WHERE id = ?').run(Date.now(), id)
}

export function listLocalEntries(
  row: LocalSpaceRow,
  relInput: string,
  options: { limit?: number; showAll?: boolean } = {},
): { entries: LocalEntry[]; truncated: boolean } {
  const { abs, rel } = resolveLocalTarget(row, relInput)
  const stat = statSync(abs)
  if (!stat.isDirectory()) fail('该路径不是目录')

  const limit = Math.max(1, Math.min(options.limit ?? LOCAL_ENTRY_LIMIT, LOCAL_ENTRY_LIMIT))
  const raw = readdirSync(abs, { withFileTypes: true })
  const entries: LocalEntry[] = []
  let skipped = 0

  for (const dirent of raw) {
    if (entries.length > limit) break
    const name = dirent.name
    if (name.startsWith('.eab-write-probe-') || name.startsWith('.eab-tmp-')) continue
    if (dirent.isSymbolicLink()) continue
    if (!options.showAll && isHeavyDir(name)) continue
    const childRel = joinRel(rel, name)
    if (!row.allow_sensitive && isSensitiveRel(childRel)) continue
    try {
      const childAbs = join(abs, name)
      const childStat = lstatSync(childAbs)
      if (childStat.isSymbolicLink()) continue
      if (childStat.isDirectory()) {
        entries.push({ name, relPath: childRel, type: 'dir', size: 0, mtime: childStat.mtimeMs })
      } else if (childStat.isFile()) {
        entries.push({
          name,
          relPath: childRel,
          type: 'file',
          size: childStat.size,
          mtime: childStat.mtimeMs,
        })
      } else {
        skipped += 1
      }
    } catch {
      skipped += 1
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
  const truncated = entries.length > limit || skipped > 0
  return { entries: entries.slice(0, limit), truncated }
}

function isProbablyText(abs: string, buffer: Buffer): boolean {
  const base = basename(abs).toLowerCase()
  if (TEXT_EXTENSIONS.has(base) || base.startsWith('.')) return true
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : ''
  if (TEXT_EXTENSIONS.has(ext)) return true
  if (buffer.includes(0)) return false
  return true
}

interface TextRead {
  text: string
  encoding: 'utf8' | 'utf16le'
  bom: boolean
  binary: boolean
  truncated: boolean
  size: number
  mtime: number
}

export function readLocalText(row: LocalSpaceRow, relInput: string): TextRead & { relPath: string } {
  const { abs, rel } = resolveLocalTarget(row, relInput)
  const stat = statSync(abs)
  if (!stat.isFile()) fail('该路径不是文件')
  if (stat.size > LOCAL_BINARY_MAX_BYTES) fail('文件超过 50 MB，请下载后查看')

  const readBytes = Math.min(stat.size, LOCAL_TEXT_MAX_BYTES)
  let buffer: Buffer
  if (readBytes <= 0) {
    buffer = Buffer.alloc(0)
  } else {
    const fd = openSync(abs, 'r')
    try {
      buffer = Buffer.alloc(readBytes)
      readSync(fd, buffer, 0, readBytes, 0)
    } finally {
      closeSync(fd)
    }
  }

  let encoding: 'utf8' | 'utf16le' = 'utf8'
  let bom = false
  let text = ''
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    bom = true
    text = buffer.subarray(3).toString('utf8')
  } else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    bom = true
    encoding = 'utf16le'
    text = buffer.subarray(2).toString('utf16le')
  } else {
    text = buffer.toString('utf8')
  }

  return {
    relPath: rel,
    text,
    encoding,
    bom,
    binary: !isProbablyText(abs, buffer),
    truncated: stat.size > LOCAL_TEXT_MAX_BYTES,
    size: stat.size,
    mtime: stat.mtimeMs,
  }
}

function encodeForWrite(text: string, encoding: 'utf8' | 'utf16le', bom: boolean): Buffer {
  if (encoding === 'utf16le') {
    const body = Buffer.from(text, 'utf16le')
    return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body
  }
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]) : Buffer.from(text, 'utf8')
}

export function writeLocalText(
  row: LocalSpaceRow,
  relInput: string,
  text: string,
  expectedMtime?: number,
  createOnly = false,
): { relPath: string; size: number; mtime: number } {
  assertModeWrite(row)
  const { abs, rel } = resolveLocalTarget(row, relInput)
  if (!rel) fail('不能写入根目录')

  if (existsSync(abs)) {
    if (createOnly) fail('同名文件或目录已存在')
    const stat = lstatSync(abs)
    if (stat.isDirectory()) fail('目标路径是目录，不能写入文件')
    if (stat.isSymbolicLink()) fail('不允许写入符号链接')
    if (expectedMtime && Math.abs(stat.mtimeMs - expectedMtime) > 1000) {
      throw new EabError(EC.CONFLICT, '文件已被其他程序修改，请重新读取后再保存', {
        details: { path: rel },
      })
    }
    if (isSensitiveRel(rel) && !row.allow_sensitive) {
      throw new EabError(EC.FORBIDDEN, '该路径属于敏感文件，当前本地空间未允许写入')
    }
  }

  const parent = dirname(abs)
  resolveLocalTarget(row, rel.split('/').slice(0, -1).join('/'))
  mkdirSync(parent, { recursive: true })
  const realParent = realpathSync(parent)
  if (!isWithinRoot(row.root_realpath, realParent)) fail('目标父目录超出本地空间根目录')

  let encoding: 'utf8' | 'utf16le' = 'utf8'
  let bom = false
  if (existsSync(abs)) {
    const read = readLocalText(row, rel)
    encoding = read.encoding
    bom = read.bom
    if (read.binary) fail('目标是二进制文件，不能按文本写入')
    if (read.encoding === 'utf16le') fail('暂不支持写入 UTF-16 文件，请先另存为 UTF-8')
  }

  const buffer = encodeForWrite(text, encoding, bom)
  if (buffer.byteLength > LOCAL_TEXT_MAX_BYTES) fail('文本超过 5 MB，不能一次写入')

  const temp = `${abs}.eab-tmp-${randomUUID()}`
  try {
    writeFileSync(temp, buffer, { encoding: 'utf8' })
    renameSync(temp, abs)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // 忽略临时文件清理失败
    }
    if (error instanceof EabError) throw error
    // Windows 上目标已存在时 rename 可能失败，退化为直接覆盖。
    writeFileSync(abs, buffer)
  }

  const stat = statSync(abs)
  return { relPath: rel, size: stat.size, mtime: stat.mtimeMs }
}

export function moveLocalEntry(
  row: LocalSpaceRow,
  fromInput: string,
  toInput: string,
  overwrite = false,
): { from: string; to: string } {
  assertModeWrite(row)
  const from = resolveLocalTarget(row, fromInput)
  const to = resolveLocalTarget(row, toInput)
  if (!from.rel || !to.rel) fail('不能移动根目录')
  if (!existsSync(from.abs)) fail('源路径不存在')
  const fromStat = lstatSync(from.abs)
  if (fromStat.isSymbolicLink()) fail('不允许移动符号链接')

  if (existsSync(to.abs)) {
    if (!overwrite) throw new EabError(EC.CONFLICT, '目标已存在，请勾选覆盖或换一个路径')
    const targetStat = lstatSync(to.abs)
    if (targetStat.isDirectory()) fail('目标路径是目录，不能覆盖')
    if (targetStat.isSymbolicLink()) fail('不允许覆盖符号链接')
    rmSync(to.abs, { force: true })
  }

  const parent = dirname(to.abs)
  mkdirSync(parent, { recursive: true })
  const realParent = realpathSync(parent)
  if (!isWithinRoot(row.root_realpath, realParent)) fail('目标父目录超出本地空间根目录')
  renameSync(from.abs, to.abs)
  return { from: from.rel, to: to.rel }
}

export function mkdirLocal(row: LocalSpaceRow, relInput: string): { relPath: string } {
  assertModeWrite(row)
  const { abs, rel } = resolveLocalTarget(row, relInput)
  if (!rel) fail('目录名不能为空')
  if (existsSync(abs)) fail('目录已存在')
  const parent = dirname(abs)
  resolveLocalTarget(row, rel.split('/').slice(0, -1).join('/'))
  mkdirSync(parent, { recursive: true })
  const realParent = realpathSync(parent)
  if (!isWithinRoot(row.root_realpath, realParent)) fail('目标父目录超出本地空间根目录')
  mkdirSync(abs)
  return { relPath: rel }
}

/**
 * 删除本地空间内的一个文件。
 *
 * 本地目录不是 EAB 托管的存储，删除即真实删除（不进入 EAB 回收区）；
 * 因此只允许删文件、不允许删目录，且必须在 read_write 空间内执行。
 * 路径已经过 `resolveLocalTarget` 的根目录、敏感文件和 symlink 校验。
 */
export function deleteLocalFile(row: LocalSpaceRow, relInput: string): { relPath: string; size: number } {
  assertModeWrite(row)
  const { abs, rel } = resolveLocalTarget(row, relInput)
  if (!rel) fail('不能删除本地空间根目录')
  if (!existsSync(abs)) fail('文件不存在或已被移动')
  const stat = lstatSync(abs)
  if (stat.isSymbolicLink()) fail('不允许删除符号链接')
  if (!stat.isFile()) fail('该路径不是文件，不能按文件删除')
  rmSync(abs, { force: false })
  return { relPath: rel, size: stat.size }
}

/** 下载文件前的边界与大小校验。 */
export function resolveLocalDownload(row: LocalSpaceRow, relInput: string): { abs: string; rel: string; size: number } {
  const { abs, rel } = resolveLocalTarget(row, relInput)
  const stat = statSync(abs)
  if (!stat.isFile()) fail('该路径不是文件')
  if (stat.size > LOCAL_BINARY_MAX_BYTES) fail('文件超过 50 MB，暂不支持在线下载')
  return { abs, rel, size: stat.size }
}

export const LOCAL_SPACE_SCOPES = {
  read: 'local-space:read' as Scope,
  write: 'local-space:write' as Scope,
}
