/**
 * 桌面端本地项目文件服务。
 *
 * 这段代码运行在安装 EAB 桌面端的电脑上，是项目目录的唯一真实访问点。
 * 服务端只发相对路径任务，根目录由桌面端自己的绑定表解析，避免被服务端或网页
 * 诱导读取任意绝对路径。所有操作都会再做一次 realpath 边界校验和敏感文件拦截。
 */
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

const MAX_PATH_LENGTH = 500
const MAX_LIST_LIMIT = 1000
const MAX_WRITE_BYTES = 5 * 1024 * 1024
const MAX_EDIT_ITEMS = 50
const MAX_READ_LINES = 2000
const MAX_READ_BYTES = 50 * 1024
const MAX_READ_LINE_CHARS = 2000
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024
const MAX_SEARCH_FILES = 2000
const MAX_SEARCH_RESULTS = 100

const BLOCKED_ROOT_NAMES = new Set([
  'c:\\windows',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\programdata',
  'c:\\recovery',
  'c:\\boot',
  'c:\\system volume information',
  'c:\\users',
  'c:\\',
])
const HEAVY_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.nuxt',
  'dist', 'build', 'target', '.gradle', '.idea', '.vs', 'coverage', 'logs',
])
const SENSITIVE_NAMES = new Set([
  '.env', '.env.local', '.env.production', '.env.development', '.npmrc', '.pypirc', '.netrc',
  '.git-credentials', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials.json',
])
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore'])
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.xml', '.yaml', '.yml',
  '.ini', '.conf', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.sass', '.less',
  '.html', '.htm', '.sql', '.py', '.sh', '.ps1', '.bat', '.go', '.rs', '.java', '.kt', '.kts',
  '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.cs', '.rb', '.php', '.swift', '.scala', '.dart',
  '.lua', '.r', '.pl', '.ex', '.exs', '.clj', '.fs', '.fsx', '.vue', '.svelte', '.astro',
  '.graphql', '.gql', '.proto', '.gradle', '.groovy', '.properties', '.toml', '.cmake', '.tex',
  '.bib', '.hcl', '.tf', '.tfvars', '.nix', '.zig', '.nim', '.sol', '.asm', '.s', '.m', '.mm',
])
const TEXT_FILE_NAMES = new Set([
  'dockerfile', 'makefile', 'cmakelists.txt', '.gitignore', '.dockerignore', '.editorconfig',
  'readme', 'license', '.prettierrc', '.eslintrc', '.babelrc', '.gitattributes',
])
const OFFICE_BINARY_EXTENSIONS = new Set([
  '.doc', '.docx', '.docm', '.xls', '.xlsx', '.xlsm', '.ppt', '.pptx', '.pptm',
])

export class LocalProjectFsError extends Error {
  constructor(status, message, hint = '') {
    super(message)
    this.name = 'LocalProjectFsError'
    this.status = status
    this.hint = hint
  }
}

function fail(status, message, hint = '') {
  throw new LocalProjectFsError(status, message, hint)
}

function normalizeRel(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
}

function isSensitivePath(value) {
  const clean = normalizeRel(value).toLowerCase()
  const parts = clean.split('/').filter(Boolean)
  if (parts.some((part) => part === '.ssh' || part === '.aws')) return true
  const name = parts.at(-1) ?? ''
  if (SENSITIVE_NAMES.has(name)) return true
  if (name.startsWith('.env.')) return true
  if (name.startsWith('service-account') && name.endsWith('.json')) return true
  return SENSITIVE_EXTENSIONS.has(extname(name))
}

function isTextEditablePath(value) {
  const name = basename(String(value ?? '')).toLowerCase()
  return TEXT_FILE_NAMES.has(name) || name.startsWith('.env') || TEXT_EXTENSIONS.has(extname(name))
}

function pathInside(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function safeRealpath(target) {
  try {
    return realpathSync(target)
  } catch {
    return null
  }
}

/** 注册/选择项目时校验根目录；盘符根与系统目录直接拒绝。 */
export function describeRoot(rawPath) {
  const trimmed = String(rawPath ?? '').trim()
  if (!trimmed) fail('validation', '请选择项目文件夹')
  if (trimmed.length > MAX_PATH_LENGTH) fail('validation', '项目路径过长')
  if (!isAbsolute(trimmed)) fail('validation', '项目路径必须是绝对路径')
  const rootPath = resolve(trimmed)
  let info
  try {
    info = statSync(rootPath)
  } catch {
    fail('not_found', `文件夹不存在或无法访问：${rootPath}`)
  }
  if (!info.isDirectory()) fail('validation', '项目路径必须是文件夹，不能是文件')
  const rootRealPath = realpathSync(rootPath)
  const normalized = rootRealPath.toLowerCase().replace(/[\\/]+$/, '')
  const driveRoot = /^[a-z]:$/i.test(normalized)
  if (driveRoot || BLOCKED_ROOT_NAMES.has(normalized)) {
    fail('validation', '不能把磁盘根目录或系统目录登记为项目；请选择具体的项目文件夹')
  }
  if (normalized === 'c:\\users') {
    fail('validation', '不能把整个用户目录登记为项目；请选择其中的具体项目文件夹')
  }
  try {
    accessSync(rootRealPath, constants.W_OK)
  } catch {
    fail('validation', '这个文件夹当前不可写，无法作为项目目录')
  }
  return { rootPath, rootRealPath, name: basename(rootRealPath) }
}

function resolveInRoot(rootRealPath, rawPath, allowSensitive) {
  const value = String(rawPath ?? '').trim() || '.'
  if (value.length > MAX_PATH_LENGTH) fail('validation', '路径过长')
  if (!allowSensitive && isSensitivePath(value)) fail('forbidden', `敏感文件默认不可访问：${value}`)
  const root = safeRealpath(rootRealPath) ?? rootRealPath
  let candidate
  if (value === '.' || value === './') {
    candidate = root
  } else if (isAbsolute(value)) {
    candidate = resolve(value)
    if (!pathInside(root, candidate)) fail('forbidden', '路径必须位于当前项目目录内')
  } else {
    candidate = resolve(root, normalizeRel(value))
  }
  if (!pathInside(root, candidate)) fail('forbidden', '路径必须位于当前项目目录内')
  if (existsSync(candidate)) {
    const real = safeRealpath(candidate)
    if (!real || !pathInside(root, real)) fail('forbidden', '路径必须位于当前项目目录内')
  } else {
    let parent = dirname(candidate)
    for (let index = 0; index < 32; index += 1) {
      if (existsSync(parent)) {
        const real = safeRealpath(parent)
        if (!real || !pathInside(root, real)) fail('forbidden', '路径必须位于当前项目目录内')
        break
      }
      const next = dirname(parent)
      if (next === parent) break
      parent = next
    }
  }
  return { target: candidate, root }
}

function toRel(root, target) {
  const rel = relative(root, target).replace(/\\/g, '/')
  return rel === '' ? '' : rel
}

export function listEntries(rootRealPath, rawPath, options = {}) {
  const allowSensitive = Boolean(options.allowSensitive)
  const { target, root } = resolveInRoot(rootRealPath, rawPath, allowSensitive)
  if (!existsSync(target)) fail('not_found', `项目路径不存在：${String(rawPath ?? '')}`)
  if (!statSync(target).isDirectory()) fail('validation', '只能列出文件夹')
  const depth = Math.min(3, Math.max(0, Math.trunc(Number(options.depth ?? 1))))
  const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(Number(options.limit ?? 300))))
  const entries = []
  let total = 0
  let truncated = false
  const walk = (dir, level) => {
    let list
    try {
      list = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const sorted = [...list].sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1
      return left.name.localeCompare(right.name, 'zh-CN')
    })
    for (const item of sorted) {
      if (entries.length >= limit) {
        truncated = true
        return
      }
      if (item.isSymbolicLink()) continue
      if (!allowSensitive && isSensitivePath(item.name)) continue
      const abs = join(dir, item.name)
      const rel = toRel(root, abs)
      const isDir = item.isDirectory()
      total += 1
      if (isDir) {
        entries.push({ name: item.name, path: rel, type: 'dir', size: 0, updatedAt: 0 })
        if (level < depth && !HEAVY_DIRS.has(item.name.toLowerCase())) walk(abs, level + 1)
      } else if (item.isFile()) {
        let size = 0
        let updatedAt = 0
        try {
          const info = statSync(abs)
          size = info.size
          updatedAt = info.mtimeMs
        } catch {
          // 单文件元信息失败不影响列表
        }
        entries.push({ name: item.name, path: rel, type: 'file', size, updatedAt })
      }
      if (truncated) return
    }
  }
  walk(target, 0)
  return { path: target === root ? '' : toRel(root, target), entries, truncated, total }
}

function countLines(text) {
  if (!text) return 0
  const lines = text.split(/\r\n|\r|\n/)
  if (text.endsWith('\n') || text.endsWith('\r')) lines.pop()
  return lines.length
}

export function readText(rootRealPath, rawPath, options = {}) {
  const allowSensitive = Boolean(options.allowSensitive)
  const { target, root } = resolveInRoot(rootRealPath, rawPath, allowSensitive)
  if (!existsSync(target)) fail('not_found', `项目文件不存在：${String(rawPath ?? '')}`)
  if (!statSync(target).isFile()) fail('validation', 'project.read 只能读取文件')
  const info = statSync(target)
  if (info.size > 50 * 1024 * 1024) fail('validation', '文件超过 50 MB，请改用下载或分段工具')
  const source = readFileSync(target, 'utf8')
  const totalLines = countLines(source)
  const offset = Math.max(1, Math.trunc(Number(options.offset ?? 1)))
  if (offset > Math.max(1, totalLines)) fail('validation', `offset 超过总行数 ${totalLines}`)
  const limit = Math.min(MAX_READ_LINES, Math.max(1, Math.trunc(Number(options.limit ?? MAX_READ_LINES))))
  const lines = source.split(/\r\n|\r|\n/)
  const endLine = Math.min(totalLines, offset + limit - 1)
  const picked = lines.slice(offset - 1, endLine)
  let text = ''
  let truncatedByBytes = false
  let longLines = 0
  for (const [index, line] of picked.entries()) {
    const clipped = line.length > MAX_READ_LINE_CHARS
    if (clipped) longLines += 1
    const current = clipped ? `${line.slice(0, MAX_READ_LINE_CHARS)}…` : line
    const next = `${current}${index < picked.length - 1 ? '\n' : ''}`
    if (Buffer.byteLength(text + next, 'utf8') > MAX_READ_BYTES) {
      truncatedByBytes = true
      break
    }
    text += next
  }
  const nextOffset = endLine >= totalLines ? null : endLine + 1
  return {
    path: toRel(root, target),
    size: info.size,
    text,
    startLine: offset,
    endLine: Math.min(totalLines, offset + Math.max(1, text.split('\n').length) - 1),
    totalLines,
    truncated: Boolean(nextOffset),
    truncatedByBytes,
    longLines,
    nextOffset,
    mode: 'lines',
  }
}

export function searchText(rootRealPath, rawPath, options = {}) {
  const allowSensitive = Boolean(options.allowSensitive)
  const query = String(options.query ?? '')
  if (!query) fail('validation', 'query 不能为空')
  const { target, root } = resolveInRoot(rootRealPath, rawPath, allowSensitive)
  if (!existsSync(target)) fail('not_found', `项目路径不存在：${String(rawPath ?? '')}`)
  const regex = Boolean(options.regex)
  const caseSensitive = Boolean(options.caseSensitive)
  const maxResults = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.trunc(Number(options.maxResults ?? 30))))
  let pattern
  if (regex) {
    try {
      pattern = new RegExp(query, caseSensitive ? '' : 'i')
    } catch (error) {
      fail('validation', `正则表达式无效：${String(error?.message || error)}`)
    }
  }
  const matches = []
  const nameMatches = []
  let filesScanned = 0
  let total = 0
  let truncated = false
  const deadline = Date.now() + 30_000
  const visit = (targetDir) => {
    if (matches.length >= maxResults || Date.now() > deadline) {
      truncated = true
      return
    }
    let list
    try {
      list = readdirSync(targetDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of list) {
      if (matches.length >= maxResults || filesScanned >= MAX_SEARCH_FILES || Date.now() > deadline) {
        truncated = true
        return
      }
      if (item.isSymbolicLink()) continue
      if (!allowSensitive && isSensitivePath(item.name)) continue
      const abs = join(targetDir, item.name)
      if (item.isDirectory()) {
        if (!HEAVY_DIRS.has(item.name.toLowerCase())) visit(abs)
        continue
      }
      if (!item.isFile()) continue
      const rel = toRel(root, abs)
      try {
        const haystack = caseSensitive ? item.name : item.name.toLowerCase()
        const needle = caseSensitive ? query : query.toLowerCase()
        if (regex ? pattern.test(item.name) : haystack.includes(needle)) {
          nameMatches.push({ path: rel, name: item.name })
          total += 1
        }
      } catch {
        lowered = ''
      }
      if (matches.length >= maxResults) {
        truncated = true
        return
      }
      let info
      try {
        info = statSync(abs)
      } catch {
        continue
      }
      if (info.size > MAX_SEARCH_FILE_BYTES) continue
      const ext = extname(item.name).toLowerCase()
      if (!TEXT_EXTENSIONS.has(ext) && !TEXT_FILE_NAMES.has(item.name.toLowerCase())) continue
      filesScanned += 1
      let content
      try {
        content = readFileSync(abs, 'utf8')
      } catch {
        continue
      }
      const lines = content.split(/\r\n|\r|\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        let hit = false
        let column = 0
        if (regex) {
          const result = pattern.exec(line)
          hit = Boolean(result)
          column = result ? (result.index ?? 0) + 1 : 0
        } else {
          const haystack = caseSensitive ? line : line.toLowerCase()
          const needle = caseSensitive ? query : query.toLowerCase()
          const at = haystack.indexOf(needle)
          hit = at >= 0
          column = at + 1
        }
        if (!hit) continue
        matches.push({ path: rel, line: index + 1, column, text: line.slice(0, 240) })
        total += 1
        if (matches.length >= maxResults) {
          truncated = true
          return
        }
      }
    }
  }
  visit(target)
  return {
    query,
    path: target === root ? '' : toRel(root, target),
    regex,
    caseSensitive,
    count: matches.length,
    total,
    filesScanned,
    truncated,
    timeLimitHit: Date.now() > deadline,
    matches,
    nameMatches,
  }
}

export function writeText(rootRealPath, rawPath, text, options = {}) {
  const allowSensitive = Boolean(options.allowSensitive)
  if (options.mode === 'read_only') fail('forbidden', '当前项目是只读模式')
  const value = String(rawPath ?? '').trim()
  if (!value) fail('validation', 'path 不能为空')
  const ext = extname(value).toLowerCase()
  if (OFFICE_BINARY_EXTENSIONS.has(ext)) {
    fail('validation', `project.write 不支持直接生成二进制 ${ext} 文件`, '请使用文本格式或在项目里运行生成脚本。')
  }
  const source = String(text ?? '')
  if (Buffer.byteLength(source, 'utf8') > MAX_WRITE_BYTES) fail('validation', '单文件最大 5 MB，超过时请拆分')
  const { target, root } = resolveInRoot(rootRealPath, value, allowSensitive)
  if (existsSync(target) && !statSync(target).isFile()) fail('validation', '目标路径已经是目录')
  const existed = existsSync(target)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, source, 'utf8')
  return {
    path: toRel(root, target),
    size: Buffer.byteLength(source, 'utf8'),
    created: !existed,
    overwritten: existed,
  }
}

export function deleteText(rootRealPath, rawPath, options = {}) {
  const allowSensitive = Boolean(options.allowSensitive)
  if (options.mode === 'read_only') fail('forbidden', '当前项目是只读模式')
  const value = String(rawPath ?? '').trim()
  if (!value) fail('validation', 'path 不能为空')
  const { target, root } = resolveInRoot(rootRealPath, value, allowSensitive)
  if (!existsSync(target)) fail('not_found', `项目文件不存在：${value}`)
  const info = statSync(target)
  if (!info.isFile()) fail('validation', 'project.delete 只能删除文件，目录请手动处理')
  unlinkSync(target)
  return { path: toRel(root, target), deleted: true, size: info.size }
}

export function editText(rootRealPath, rawPath, edits, options = {}) {
  const allowSensitive = Boolean(options.allowSensitive)
  if (options.mode === 'read_only') fail('forbidden', '当前项目是只读模式')
  if (!isTextEditablePath(rawPath)) fail('validation', '该文件类型暂不支持局部文本编辑')
  if (!Array.isArray(edits) || edits.length === 0) fail('validation', 'edits 不能为空')
  if (edits.length > MAX_EDIT_ITEMS) fail('validation', '一次最多修改 50 处')
  const { target, root } = resolveInRoot(rootRealPath, rawPath, allowSensitive)
  if (!existsSync(target)) fail('not_found', '要修改的文件不存在', '新文件请先用 project.write 创建')
  const info = statSync(target)
  if (!info.isFile()) fail('validation', 'project.edit 只能修改文件')
  if (info.size > MAX_WRITE_BYTES) fail('validation', '文件超过 5 MB，暂不支持局部编辑')
  let text = readFileSync(target, 'utf8')
  let changes = 0
  for (const [index, raw] of edits.entries()) {
    const find = String(raw?.find ?? '')
    const replace = String(raw?.replace ?? '')
    if (!find) fail('validation', `第 ${index + 1} 项 find 不能为空`)
    if (find === replace) fail('validation', 'replace 与 find 相同，没有实际修改')
    const occurrence = Number(raw?.occurrence ?? 0)
    if (!Number.isInteger(occurrence) || occurrence < 0) fail('validation', 'occurrence 必须是正整数或省略')
    if (occurrence > 0) {
      let at = -1
      let from = 0
      for (let count = 0; count < occurrence; count += 1) {
        at = text.indexOf(find, from)
        if (at < 0) break
        from = at + find.length
      }
      if (at < 0) fail('validation', `第 ${occurrence} 个匹配不存在`)
      text = `${text.slice(0, at)}${replace}${text.slice(at + find.length)}`
      changes += 1
      continue
    }
    let at = text.indexOf(find)
    if (at < 0) fail('validation', '没有找到要替换的原文', 'find 必须与文件内容完全一致')
    let count = 0
    while (at >= 0) {
      text = `${text.slice(0, at)}${replace}${text.slice(at + find.length)}`
      count += 1
      at = text.indexOf(find, at + replace.length)
    }
    changes += count
  }
  writeFileSync(target, text, 'utf8')
  return {
    path: toRel(root, target),
    size: Buffer.byteLength(text, 'utf8'),
    changes,
    matchedEdits: edits.length,
    edited: true,
  }
}

/**
 * 桌面桥执行入口。bindings 以 projectId 为键，值必须是本机真实目录；
 * 服务端任务不带根路径，因此无法借任务越权读取项目外的文件。
 */
export class DesktopLocalProjects {
  constructor(options = {}) {
    this.bindings = { ...(options.bindings ?? {}) }
    this.onChange = typeof options.onChange === 'function' ? options.onChange : null
  }

  bind(projectId, rawPath) {
    const id = String(projectId ?? '').trim()
    if (!/^lp_[A-Za-z0-9]+$/.test(id)) fail('validation', '项目标识无效')
    const descriptor = describeRoot(rawPath)
    this.bindings[id] = descriptor.rootRealPath
    this.onChange?.({ ...this.bindings })
    return { projectId: id, ...descriptor }
  }

  unbind(projectId) {
    const id = String(projectId ?? '').trim()
    if (!id) return { removed: false }
    const removed = Boolean(this.bindings[id])
    delete this.bindings[id]
    this.onChange?.({ ...this.bindings })
    return { removed }
  }

  execute(job) {
    try {
      const projectId = String(job?.projectId ?? '')
      if (job?.op === 'describeRoot') return { ok: true, result: describeRoot(job?.args?.path) }
      const root = this.bindings[projectId]
      if (!root) {
        fail('conflict', '这个项目还没有在这台电脑上绑定工作目录，请重新创建项目并选择文件夹')
      }
      if (!existsSync(root)) fail('not_found', '项目目录不存在或已被移动，请重新创建项目并选择文件夹')
      const args = job?.args && typeof job.args === 'object' ? job.args : {}
      const common = { mode: String(args.mode ?? 'read_write'), allowSensitive: Boolean(args.allowSensitive) }
      let result
      switch (job?.op) {
        case 'list':
          result = listEntries(root, args.path, { depth: args.depth, limit: args.limit, allowSensitive: common.allowSensitive })
          break
        case 'read':
          result = readText(root, args.path, { ...args, allowSensitive: common.allowSensitive })
          break
        case 'search':
          result = searchText(root, args.path, { ...args, allowSensitive: common.allowSensitive })
          break
        case 'write':
          result = writeText(root, args.path, args.text, common)
          break
        case 'edit':
          result = editText(root, args.path, args.edits, common)
          break
        case 'delete':
          result = deleteText(root, args.path, common)
          break
        default:
          fail('validation', `不支持的文件操作：${String(job?.op ?? '')}`)
      }
      return { ok: true, result }
    } catch (error) {
      if (error instanceof LocalProjectFsError) {
        return { ok: false, error: { status: error.status, message: error.message, hint: error.hint } }
      }
      return { ok: false, error: { status: 'internal', message: String(error?.message || error) } }
    }
  }
}
