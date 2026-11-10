/**
 * 路径安全（WorkspaceResolver 的第一道闸）。
 *
 * 这里只做"纯字符串"层面的校验，不碰磁盘；磁盘层的符号链接/硬链接检查留给 resolver。
 * 覆盖的真实攻击面（Windows 上尤其多）：
 * - `..` 穿越、绝对路径、盘符、UNC、`file:` 之类 scheme
 * - URL 编码后的穿越（`%2e%2e`）
 * - Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含带扩展名形式）
 * - 目录流（ADS）：`a.txt:stream`
 * - 结尾点/空格（Windows 会自动裁剪，导致同名覆盖）
 * - 控制字符与空段
 */
import { isAbsolute, relative as pathRelative, resolve } from 'node:path'
import { EC, EabError } from '@eab/domain'

const RESERVED_NAMES = new Set<string>([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

const MAX_SEGMENT_LENGTH = 120
const MAX_RELATIVE_LENGTH = 240
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const DRIVE_OR_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

function fail(input: string, reason: string): never {
  throw new EabError(EC.VALIDATION, `非法路径：${reason}`, { details: { input, reason } })
}

function assertSegment(segment: string, input: string): void {
  if (segment.length === 0) fail(input, '包含空段')
  if (segment.length > MAX_SEGMENT_LENGTH) fail(input, '单段过长')
  if (CONTROL_CHARS.test(segment)) fail(input, '包含控制字符')
  if (segment !== segment.trim()) fail(input, '段首尾含空白')
  if (segment.endsWith('.')) fail(input, '段以点结尾')
  if (segment.includes(':')) fail(input, '包含冒号（目录流/盘符）')
  const baseName = segment.split('.')[0]?.toLowerCase() ?? ''
  if (RESERVED_NAMES.has(baseName)) fail(input, `使用 Windows 保留名: ${baseName}`)
}

function scan(input: string): string {
  if (typeof input !== 'string' || input.length === 0) fail(String(input), '路径为空')
  if (input.length > MAX_RELATIVE_LENGTH) fail(input, '路径过长')
  if (CONTROL_CHARS.test(input)) fail(input, '包含控制字符')

  const unified = input.replace(/\\/g, '/')

  // 绝对路径 / UNC / 盘符 / scheme，一律拒绝
  if (unified.startsWith('/')) fail(input, '不允许绝对路径')
  if (DRIVE_OR_SCHEME.test(unified)) fail(input, '不允许盘符或协议前缀')

  const segments = unified.split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') fail(input, '不允许上级目录引用')
    assertSegment(segment, input)
    out.push(segment)
  }
  if (out.length === 0) fail(input, '没有有效路径段')
  return out.join('/')
}

function tryDecode(input: string): string | undefined {
  try {
    const decoded = decodeURIComponent(input)
    return decoded === input ? undefined : decoded
  } catch {
    return undefined
  }
}

/**
 * 规范化用户提交的相对路径（统一为正斜杠、去掉 `.` 与空段）。
 * 不安全则抛 `EabError(EAB_VALIDATION)`，绝不返回一个"看起来能用"的结果。
 */
export function normalizeRelativePath(input: string): string {
  const normalized = scan(input)
  // 再扫一遍解码后的形态，拦住 %2e%2e 这类编码穿越
  const decoded = tryDecode(input)
  if (decoded !== undefined) scan(decoded)
  return normalized
}

/** 把相对路径拼到根目录下，并断言结果没有逃出根目录 */
export function safeJoin(root: string, relativePath: string): string {
  const rel = normalizeRelativePath(relativePath)
  const rootAbs = resolve(root)
  const target = resolve(rootAbs, rel.split('/').join('/'))
  if (!isWithinRoot(rootAbs, target)) fail(relativePath, '逃出根目录')
  return target
}

/** 判断 candidate 是否仍在 root 之内（Windows 大小写不敏感，统一小写比较） */
export function isWithinRoot(root: string, candidate: string): boolean {
  const rootAbs = resolve(root)
  const candidateAbs = resolve(candidate)
  const rel = pathRelative(rootAbs, candidateAbs)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  const first = rel.split(/[\\/]/)[0] ?? ''
  if (first === '..') return false
  const lowerRoot = rootAbs.toLowerCase()
  const lowerCandidate = candidateAbs.toLowerCase()
  return lowerCandidate === lowerRoot || lowerCandidate.startsWith(`${lowerRoot}\\`) || lowerCandidate.startsWith(`${lowerRoot}/`)
}

/** 目录名用 `{id}-{slug}`：slug 只做人眼可读，必须清洗成安全字符 */
export function toSlug(input: string, fallback = 'x'): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-]+|[-]+$/g, '')
    .slice(0, 40)
  return cleaned.length > 0 ? cleaned : fallback
}
