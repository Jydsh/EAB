/**
 * 云空间文本文件的按行读取与代码检索。
 *
 * 大文件不整块塞进模型上下文：readTextFileRange 只返回请求的行段，并给出
 * startLine/endLine/totalLines；searchWorkspaceText 先返回 path:line 命中，
 * 让模型再用行段读取上下文。两者都只接受纯文本类文件，二进制和 Office 文件
 * 继续走各自的预览/编辑工具。
 */
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'
import { EC, EabError } from '@eab/domain'

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.xml',
  '.yaml', '.yml', '.ini', '.conf', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.sass', '.less', '.html', '.htm', '.sql', '.py', '.sh', '.ps1', '.bat',
  '.go', '.rs', '.java', '.kt', '.kts', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp',
  '.cs', '.rb', '.php', '.swift', '.scala', '.dart', '.lua', '.r', '.pl', '.ex', '.exs',
  '.clj', '.fs', '.fsx', '.vue', '.svelte', '.astro', '.graphql', '.gql', '.proto',
  '.gradle', '.groovy', '.properties', '.toml', '.cmake', '.tex', '.bib', '.hcl', '.tf',
  '.tfvars', '.nix', '.zig', '.nim', '.sol', '.asm', '.s', '.m', '.mm',
])
const TEXT_FILE_NAMES = new Set([
  'dockerfile', 'makefile', 'cmakelists.txt', '.gitignore', '.dockerignore', '.env',
  '.npmrc', '.editorconfig', '.prettierrc', '.eslintrc', '.babelrc', '.gitattributes',
  'readme', 'license',
])
// 与 DSH 的 read 对齐：默认/单次最多 2000 行，单次输出 50 KB，单行 2000 字符。
// 超过任一上限都截断并返回 nextOffset，由模型用 offset 继续读，而不是整文件塞进上下文。
const DEFAULT_READ_LINES = 2_000
const MAX_READ_LINES = 2_000
const MAX_READ_OUTPUT_BYTES = 50 * 1024
const MAX_READ_LINE_CHARS = 2_000
const MAX_READ_SCAN_BYTES = 50 * 1024 * 1024
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024
const MAX_SEARCH_FILES = 2_000
const MAX_SEARCH_SCAN_MATCHES = 1_000
const DEFAULT_SEARCH_RESULTS = 30
const MAX_SEARCH_RESULTS = 100
// DSH 的 grep 有 30 秒进程超时；这里同步遍历也要有预算，避免无命中时长时间占住事件循环。
const DEFAULT_SEARCH_TIME_MS = 30_000
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.cache', '.eab-dev'])

export { TEXT_EXTENSIONS }

export function countTextLines(text: string): number {
  if (!text) return 0
  const lines = text.split(/\r\n|\r|\n/)
  if (text.endsWith('\n') || text.endsWith('\r')) lines.pop()
  return lines.length
}

export function isTextEditableFile(nameOrPath: string): boolean {
  const name = basename(String(nameOrPath || '')).toLowerCase()
  if (TEXT_FILE_NAMES.has(name)) return true
  if (name.startsWith('.env')) return true
  return TEXT_EXTENSIONS.has(extname(name))
}

export interface TextRangeResult {
  text: string
  startLine: number
  endLine: number
  totalLines: number
  truncated: boolean
  /** 输出字节达到单次上限时提前截止；与“后面还有行”分开，界面可说明原因。 */
  truncatedByBytes: boolean
  /** 被单行字符上限截断的行数；正文里会带截断标记，原文不受影响。 */
  longLines: number
  /** 下一次读取建议使用的 offset；没有更多内容时为 null。 */
  nextOffset: number | null
  size: number
}

/**
 * 按 1-based 行号读取一段文本。默认/最多 2000 行，单次输出 50 KB，单行最多 2000 字符。
 * offset 超过总行数时明确报错，而不是返回空段让模型猜；空文件 offset=1 仍返回空段。
 * 只扫描到文件尾来得到 totalLines；大文件上限 50 MB，超过时要求下载或分文件。
 */
export function readTextFileRange(
  target: string,
  options: {
    offset?: number
    limit?: number
    maxScanBytes?: number
    maxOutputBytes?: number
    maxLineChars?: number
  } = {},
): TextRangeResult {
  const stat = statSync(target)
  const maxScanBytes = options.maxScanBytes ?? MAX_READ_SCAN_BYTES
  if (stat.size > maxScanBytes) {
    throw new EabError(EC.VALIDATION, `文件超过 ${Math.floor(maxScanBytes / 1024 / 1024)} MB，请下载后查看`)
  }
  const requestedOffset = Math.max(1, Math.trunc(Number(options.offset) || 1))
  const requestedLimit = Math.min(
    MAX_READ_LINES,
    Math.max(1, Math.trunc(Number(options.limit) || DEFAULT_READ_LINES)),
  )
  const endRequested = requestedOffset + requestedLimit - 1
  const maxOutputBytes = Math.max(1, Math.trunc(Number(options.maxOutputBytes) || MAX_READ_OUTPUT_BYTES))
  const maxLineChars = Math.max(1, Math.trunc(Number(options.maxLineChars) || MAX_READ_LINE_CHARS))
  const fd = openSync(target, 'r')
  const buffer = Buffer.alloc(64 * 1024)
  let position = 0
  let lineNo = 1
  let current: Buffer[] = []
  const collected: string[] = []
  let totalLines = 0
  let outputBytes = 0
  let truncatedByBytes = false
  let longLines = 0

  const flushLine = () => {
    totalLines = lineNo
    if (!truncatedByBytes && lineNo >= requestedOffset && lineNo <= endRequested) {
      const raw = current.length === 1 ? current[0].toString('utf8') : Buffer.concat(current).toString('utf8')
      const eolMatch = /(\r\n|\r|\n)$/.exec(raw)
      const eol = eolMatch?.[0] ?? ''
      const body = eol ? raw.slice(0, raw.length - eol.length) : raw
      let shown = body
      if (body.length > maxLineChars) {
        shown = `${body.slice(0, maxLineChars)}…（本行已截断，单行最多 ${maxLineChars} 字符）`
        longLines += 1
      }
      const lineText = shown + eol
      const bytes = Buffer.byteLength(lineText, 'utf8')
      if (outputBytes + bytes > maxOutputBytes && collected.length > 0) {
        truncatedByBytes = true
      } else {
        collected.push(lineText)
        outputBytes += bytes
      }
    }
    current = []
    lineNo += 1
  }

  try {
    while (true) {
      const bytes = readSync(fd, buffer, 0, buffer.length, position)
      if (bytes <= 0) break
      position += bytes
      let start = 0
      for (let index = 0; index < bytes; index += 1) {
        if (buffer[index] !== 0x0a) continue
        const segment = buffer.subarray(start, index + 1)
        current.push(Buffer.from(segment))
        flushLine()
        start = index + 1
      }
      if (start < bytes) current.push(Buffer.from(buffer.subarray(start, bytes)))
    }
    if (current.length > 0) flushLine()
  } finally {
    closeSync(fd)
  }

  if (totalLines === 0) {
    if (requestedOffset > 1) {
      throw new EabError(EC.VALIDATION, `文件为空，offset ${requestedOffset} 超出范围（总行数 0）`)
    }
  } else if (requestedOffset > totalLines) {
    throw new EabError(EC.VALIDATION, `offset ${requestedOffset} 超出文件总行数 ${totalLines}`)
  }

  const text = collected.join('')
  const startLine = requestedOffset
  const endLine = collected.length > 0 ? requestedOffset + collected.length - 1 : requestedOffset - 1
  const truncated = endLine < totalLines
  return {
    text,
    startLine,
    endLine,
    totalLines,
    truncated,
    truncatedByBytes,
    longLines,
    nextOffset: truncated && endLine >= 1 ? endLine + 1 : null,
    size: stat.size,
  }
}

export interface TextSearchMatch {
  path: string
  line: number
  column: number
  text: string
}

export interface TextSearchNameMatch {
  /** 相对 root 的路径，可直接交给 workspace.read。 */
  path: string
  name: string
}

export interface TextSearchResult {
  matches: TextSearchMatch[]
  /** 实际命中的总条数（最多统计到扫描上限）；matches 只按 maxResults 返回前几条。 */
  total: number
  filesScanned: number
  truncated: boolean
  /** 达到 30 秒搜索预算被截止；和“结果太多被截断”分开，便于界面说明。 */
  timeLimitHit: boolean
  /**
   * 文件名/路径命中。工具名是“搜索工作区文件”，模型经常直接把文件名当 query；
   * 只搜正文会返回 0 命中，模型随后误以为文件不存在并反复猜路径。
   */
  nameMatches: TextSearchNameMatch[]
}

function toRelativePath(root: string, target: string): string {
  return relative(root, target).split(sep).join('/')
}

/** 文件名匹配忽略空格差异，避免“343 条.csv”和“343条.csv”被当成两个文件。 */
function normalizeNameForMatch(value: string): string {
  return String(value || '').replace(/[\s\u3000]+/g, '').toLowerCase()
}

function collectTextFiles(
  target: string,
  limit: number,
  deadline: number,
): { files: string[]; truncated: boolean; timeLimitHit: boolean } {
  const files: string[] = []
  let truncated = false
  let timeLimitHit = false
  const visit = (path: string) => {
    if (truncated || timeLimitHit) return
    if (Date.now() > deadline) {
      timeLimitHit = true
      truncated = true
      return
    }
    let stat
    try {
      stat = lstatSync(path)
    } catch {
      return
    }
    if (stat.isSymbolicLink()) return
    if (stat.isFile()) {
      if (isTextEditableFile(path)) files.push(path)
      if (files.length >= limit) truncated = true
      return
    }
    if (!stat.isDirectory()) return
    let entries
    try {
      entries = readdirSync(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name.toLowerCase())) continue
      visit(join(path, entry.name))
      if (truncated || timeLimitHit) return
    }
  }
  visit(target)
  return { files, truncated, timeLimitHit }
}

/**
 * 在某个文件或目录下搜索文本命中。regex=true 时 query 按正则解释，否则按普通字符串。
 * 返回的 path 相对 root，line 为 1-based 行号，text 为命中行去掉首尾空白后的片段。
 * 与 DSH 的 grep 一样保留总命中数（最多统计 1000 条），默认 30 秒预算；命中过多时只返回前 maxResults 条。
 */
export function searchWorkspaceText(
  root: string,
  target: string,
  options: {
    query: string
    maxResults?: number
    regex?: boolean
    caseSensitive?: boolean
    timeLimitMs?: number
    maxScanMatches?: number
  },
): TextSearchResult {
  const query = String(options.query ?? '')
  if (!query) throw new EabError(EC.VALIDATION, 'search query 不能为空')
  const maxResults = Math.min(
    MAX_SEARCH_RESULTS,
    Math.max(1, Math.trunc(Number(options.maxResults) || DEFAULT_SEARCH_RESULTS)),
  )
  const maxScanMatches = Math.max(
    maxResults,
    Math.min(
      MAX_SEARCH_SCAN_MATCHES,
      Math.max(1, Math.trunc(Number(options.maxScanMatches) || MAX_SEARCH_SCAN_MATCHES)),
    ),
  )
  const timeLimitMs = Math.max(1, Math.trunc(Number(options.timeLimitMs) || DEFAULT_SEARCH_TIME_MS))
  const deadline = Date.now() + timeLimitMs
  let pattern: RegExp | null = null
  if (options.regex) {
    try {
      pattern = new RegExp(query, options.caseSensitive ? '' : 'i')
    } catch (error) {
      throw new EabError(EC.VALIDATION, `正则表达式无效：${(error as Error).message}`)
    }
  }
  const needle = options.caseSensitive ? query : query.toLowerCase()
  const targetStat = lstatSync(target)
  if (targetStat.isSymbolicLink()) throw new EabError(EC.VALIDATION, '不支持搜索符号链接')
  const scan = collectTextFiles(target, MAX_SEARCH_FILES, deadline)
  const matches: TextSearchMatch[] = []
  const nameMatches: TextSearchNameMatch[] = []
  const nameNeedle = normalizeNameForMatch(query)
  if (nameNeedle) {
    for (const file of scan.files) {
      if (nameMatches.length >= maxResults) break
      const path = toRelativePath(root, file)
      if (!normalizeNameForMatch(path).includes(nameNeedle)) continue
      nameMatches.push({ path, name: basename(file) })
    }
  }
  let total = 0
  let filesScanned = 0
  let truncated = scan.truncated
  let timeLimitHit = scan.timeLimitHit
  let stop = false

  for (const file of scan.files) {
    if (stop) break
    if (Date.now() > deadline) {
      timeLimitHit = true
      truncated = true
      break
    }
    let fileStat
    try {
      fileStat = statSync(file)
    } catch {
      continue
    }
    if (!fileStat.isFile() || fileStat.size > MAX_SEARCH_FILE_BYTES) continue
    filesScanned += 1
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r\n|\r|\n/)
    for (let index = 0; index < lines.length; index += 1) {
      // 大文件逐行扫描时也要看预算：每 200 行检查一次，避免 Date.now 本身成为热路径开销。
      if ((index & 0xff) === 0 && Date.now() > deadline) {
        timeLimitHit = true
        truncated = true
        stop = true
        break
      }
      const line = lines[index]
      let column = -1
      if (pattern) {
        const hit = pattern.exec(line)
        column = hit ? hit.index + 1 : -1
      } else {
        const lower = options.caseSensitive ? line : line.toLowerCase()
        column = lower.indexOf(needle) + 1
      }
      if (column <= 0) continue
      total += 1
      if (matches.length < maxResults) {
        matches.push({
          path: toRelativePath(root, file),
          line: index + 1,
          column,
          text: line.trim().slice(0, 300),
        })
      }
      if (total >= maxScanMatches) {
        truncated = true
        stop = true
        break
      }
    }
  }
  if (total > matches.length) truncated = true

  return { matches, total, filesScanned, truncated, timeLimitHit, nameMatches }
}
