/**
 * 网络技能来源：GitHub 仓库 / 直接压缩包 URL。
 *
 * 只负责“下载 → 解包 → 找到技能根目录”，随后交给 skills.ts 的
 * previewSkillInstall / installSkillPackage 做静态扫描、审批与落盘。
 * 不执行包内任何脚本，也不把下载内容直接放进 skills/。
 */
import { spawnSync } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { EC, EabError } from '@eab/domain'

/** 压缩包本体上限；解压后还会再限制一次，避免把临时目录塞满。 */
const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 1000
const MAX_EXTRACTED_BYTES = 16 * 1024 * 1024
const MAX_EXTRACTED_ENTRIES = 1000
const DOWNLOAD_TIMEOUT_MS = 60_000
const EXTRACT_TIMEOUT_MS = 60_000
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__'])

export interface StagedSkillSource {
  readonly dir: string
  readonly source: 'git' | 'http'
  readonly sourceRef: string
  readonly label: string
  readonly cleanup: () => void
}

interface GithubSkillOptions {
  readonly repo: string
  readonly ref?: string
  readonly subdir?: string
}

interface ArchiveSkillOptions {
  readonly url: string
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function privateNetworkAllowed(): boolean {
  return process.env.EAB_SKILL_ALLOW_PRIVATE_NETWORK === '1'
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized === '::1' || normalized === '::') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true
  }
  if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice('::ffff:'.length))
  const ipv4 = normalized.split('.')
  if (ipv4.length !== 4 || ipv4.some((part) => !/^\d{1,3}$/.test(part))) return false
  const [a, b] = ipv4.map((part) => Number(part))
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

/**
 * 网络来源边界：
 * - 默认只允许公网 https；本机 http 仅为本地开发和测试保留。
 * - 内网地址（含解析到内网的域名）默认拒绝，防止安装入口被用作内网探测。
 * - 需要安装内网制品库时，显式设置 EAB_SKILL_ALLOW_PRIVATE_NETWORK=1。
 */
async function assertSafeRemoteUrl(raw: string, label: '下载地址' | '重定向地址'): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new EabError(EC.VALIDATION, `${label}不是合法 URL`)
  }
  if (url.username || url.password) throw new EabError(EC.VALIDATION, `${label}不能包含账号密码`)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    throw new EabError(EC.VALIDATION, `${label}只支持 https（本机开发可用 http://127.0.0.1）`)
  }
  if (privateNetworkAllowed()) return url

  if (isLocalHost(url.hostname)) {
    throw new EabError(
      EC.VALIDATION,
      `${label}指向本机地址，已拒绝。内网或本机来源请由服务端设置 EAB_SKILL_ALLOW_PRIVATE_NETWORK=1`,
    )
  }
  const literalIp = /^[0-9.]+$/.test(url.hostname) || url.hostname.includes(':')
  if (literalIp && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
    throw new EabError(
      EC.VALIDATION,
      `${label}指向内网地址，已拒绝。内网来源请由服务端设置 EAB_SKILL_ALLOW_PRIVATE_NETWORK=1`,
    )
  }
  try {
    const addresses = await lookup(url.hostname, { all: true })
    if (addresses.some((item) => isPrivateAddress(item.address))) {
      throw new EabError(
        EC.VALIDATION,
        `${label}解析到内网地址，已拒绝。内网来源请由服务端设置 EAB_SKILL_ALLOW_PRIVATE_NETWORK=1`,
      )
    }
  } catch (error) {
    if (error instanceof EabError) throw error
    throw new EabError(EC.VALIDATION, `${label}域名解析失败：${(error as Error).message}`)
  }
  return url
}

async function downloadArchive(rawUrl: string, dest: string): Promise<{ finalUrl: string }> {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  let current = await assertSafeRemoteUrl(rawUrl, '下载地址')
  let response: Response | null = null
  for (let hop = 0; hop <= 5; hop += 1) {
    try {
      response = await fetch(current, {
        headers: { accept: 'application/gzip,application/zip,application/octet-stream,*/*', 'user-agent': 'EAB-skill-installer' },
        // 手动跟随重定向：每一跳都重新做协议、凭证和私网校验，不能让 fetch 先连到内网再检查。
        redirect: 'manual',
        signal,
      })
    } catch (err) {
      throw new EabError(EC.VALIDATION, `下载失败：${(err as Error).message}`)
    }
    if (response.status >= 300 && response.status <= 399) {
      const location = response.headers.get('location')
      if (!location) throw new EabError(EC.VALIDATION, `下载遇到 ${response.status} 重定向但没有 Location`)
      await response.body?.cancel().catch(() => {})
      const next = new URL(location, current)
      current = await assertSafeRemoteUrl(next.href, '重定向地址')
      continue
    }
    break
  }
  if (!response) throw new EabError(EC.VALIDATION, '下载没有响应')
  if (response.status >= 300 && response.status <= 399) throw new EabError(EC.VALIDATION, '下载重定向次数过多')
  if (!response.ok) throw new EabError(EC.VALIDATION, `下载 ${current.host}${current.pathname} 返回 ${response.status}`)
  const final = current

  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > MAX_ARCHIVE_BYTES) {
    throw new EabError(EC.VALIDATION, `压缩包超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB 上限`)
  }
  if (!response.body) throw new EabError(EC.VALIDATION, '下载响应没有内容')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_ARCHIVE_BYTES) {
        throw new EabError(EC.VALIDATION, `压缩包超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB 上限`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) throw new EabError(EC.VALIDATION, '下载的压缩包是空文件')
  writeFileSync(dest, Buffer.concat(chunks))
  return { finalUrl: final.href }
}

function runCommand(command: string, args: readonly string[], timeoutMs = EXTRACT_TIMEOUT_MS): string {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 24 * 1024 * 1024,
  })
  if (result.error) throw new EabError(EC.VALIDATION, `${command} 执行失败：${result.error.message}`)
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}\n${result.stdout || ''}`.trim().slice(0, 400)
    throw new EabError(EC.VALIDATION, `${command} 执行失败${detail ? `：${detail}` : ''}`)
  }
  return result.stdout || ''
}

type ArchiveKind = 'tar.gz' | 'zip'

function detectArchiveKind(archive: string): ArchiveKind {
  const head = readFileSync(archive).subarray(0, 4)
  if (head[0] === 0x1f && head[1] === 0x8b) return 'tar.gz'
  if (head[0] === 0x50 && head[1] === 0x4b) return 'zip'
  throw new EabError(EC.VALIDATION, '只支持 .tar.gz / .tgz / .zip 压缩包')
}

function listArchive(kind: ArchiveKind, archive: string): string {
  if (kind === 'tar.gz') return runCommand('tar', ['-tzf', archive])
  try {
    return runCommand('tar', ['-tf', archive])
  } catch (error) {
    try {
      return runCommand('unzip', ['-Z1', archive])
    } catch {
      throw error
    }
  }
}

function assertArchiveEntries(kind: ArchiveKind, archive: string): void {
  const entries = listArchive(kind, archive)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!entries.length) throw new EabError(EC.VALIDATION, '压缩包是空的')
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new EabError(EC.VALIDATION, `压缩包文件超过 ${MAX_ARCHIVE_ENTRIES} 个`)
  }
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/')
    if (entry.includes('\\')) throw new EabError(EC.VALIDATION, `压缩包里有反斜杠路径，已拒绝：${entry}`)
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || isAbsolute(normalized)) {
      throw new EabError(EC.VALIDATION, `压缩包里有绝对路径，已拒绝：${entry}`)
    }
    if (normalized.split('/').some((part) => part === '..')) {
      throw new EabError(EC.VALIDATION, `压缩包里有越界路径，已拒绝：${entry}`)
    }
  }
}

/** 解包前检查条目类型：只允许普通文件和目录，符号链接/硬链接/设备文件一律拒绝。 */
function assertNoLinkEntries(kind: ArchiveKind, archive: string): void {
  let listing = ''
  try {
    listing = kind === 'tar.gz' ? runCommand('tar', ['-tvzf', archive]) : runCommand('tar', ['-tvf', archive])
  } catch {
    // zip 在没有 tar 支持时交给解压后的 assertExtractedTree 兜底。
    return
  }
  for (const line of listing.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const type = trimmed.charAt(0)
    if (type === '-' || type === 'd') continue
    throw new EabError(EC.VALIDATION, `压缩包里有非普通文件条目，已拒绝：${trimmed.slice(0, 120)}`)
  }
}

/** 解压后拒绝符号链接，并限制文件数、总体积，防止解压炸弹落满临时目录。 */
function assertExtractedTree(dir: string): void {
  let files = 0
  let total = 0
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) throw new EabError(EC.VALIDATION, `压缩包里有符号链接，已拒绝：${entry.name}`)
      files += 1
      if (files > MAX_EXTRACTED_ENTRIES) {
        throw new EabError(EC.VALIDATION, `压缩包解压后文件超过 ${MAX_EXTRACTED_ENTRIES} 个`)
      }
      if (stat.isDirectory()) {
        visit(full)
      } else if (stat.isFile()) {
        total += stat.size
        if (total > MAX_EXTRACTED_BYTES) {
          throw new EabError(EC.VALIDATION, `压缩包解压后超过 ${MAX_EXTRACTED_BYTES / 1024 / 1024}MB 上限`)
        }
      }
    }
  }
  visit(dir)
}

function extractArchive(kind: ArchiveKind, archive: string, dest: string): void {
  assertArchiveEntries(kind, archive)
  assertNoLinkEntries(kind, archive)
  mkdirSync(dest, { recursive: true })
  try {
    if (kind === 'tar.gz') runCommand('tar', ['-xzf', archive, '-C', dest])
    else runCommand('tar', ['-xf', archive, '-C', dest])
  } catch (error) {
    if (kind !== 'zip') throw error
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    try {
      runCommand('unzip', ['-q', archive, '-d', dest])
    } catch {
      throw error
    }
  }
  assertExtractedTree(dest)
}

function isSkillRoot(dir: string): boolean {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return false
  const manifest = join(dir, 'skill.json')
  const skill = join(dir, 'SKILL.md')
  if (!existsSync(manifest) || !statSync(manifest).isFile()) return false
  if (!existsSync(skill) || !statSync(skill).isFile()) return false
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { entry?: unknown }
    const entry = typeof parsed.entry === 'string' && parsed.entry.trim() ? parsed.entry.trim() : 'SKILL.md'
    const target = resolve(dir, entry)
    return target.startsWith(dir + sep) && existsSync(target) && statSync(target).isFile()
  } catch {
    return false
  }
}

/** 在解压结果里找唯一的技能根（skill.json + 入口 Markdown）；根目录优先，最多下钻四层。 */
function findSkillRoot(root: string, maxDepth = 4): string {
  const found: string[] = []
  let visited = 0
  const visit = (dir: string, depth: number): void => {
    visited += 1
    if (visited > 2500) return
    if (isSkillRoot(dir)) found.push(dir)
    if (depth >= maxDepth) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (SKIP_DIRS.has(entry.name)) continue
      visit(join(dir, entry.name), depth + 1)
    }
  }
  visit(root, 0)
  if (!found.length) throw new EabError(EC.VALIDATION, '压缩包里没有包含 skill.json 和 SKILL.md 的技能目录')
  if (found.includes(root)) return root
  if (found.length === 1) return found[0]
  throw new EabError(EC.VALIDATION, '压缩包里发现多个技能清单，请用「仓库内子目录」指定其中一个')
}

function assertGithubRepo(value: string): { owner: string; repo: string; full: string } {
  const raw = value.trim().replace(/\/+$/, '')
  if (!raw) throw new EabError(EC.VALIDATION, '请填 GitHub 仓库（owner/repo）')
  if (raw.length > 200 || raw.includes('..') || raw.includes('\\') || raw.startsWith('/')) {
    throw new EabError(EC.VALIDATION, 'GitHub 仓库格式不合法')
  }
  const repo = raw.replace(/\.git$/, '')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repo)) {
    throw new EabError(EC.VALIDATION, 'GitHub 仓库格式应为 owner/repo')
  }
  const [owner, name] = repo.split('/')
  return { owner, repo: name, full: `${owner}/${name}` }
}

function assertGithubRef(value: string): string {
  const ref = value.trim()
  if (!ref) return ''
  if (ref.length > 120 || ref.startsWith('-') || ref.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new EabError(EC.VALIDATION, 'GitHub 分支 / 标签不合法')
  }
  return ref
}

function encodeGithubRef(ref: string): string {
  return ref
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function assertSubdir(value: string): string {
  const subdir = value.trim().replace(/^\.\//, '')
  if (!subdir || subdir === '.') return ''
  if (subdir.includes('\\') || subdir.startsWith('/') || /^[A-Za-z]:/.test(subdir)) {
    throw new EabError(EC.VALIDATION, '仓库内子目录必须是相对路径')
  }
  if (subdir.split('/').some((part) => part === '..' || part === '')) {
    throw new EabError(EC.VALIDATION, '仓库内子目录不能包含 .. 或空段')
  }
  return subdir
}

function githubApiBase(): string {
  const raw = (process.env.EAB_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '')
  const url = new URL(raw)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    throw new EabError(EC.VALIDATION, 'EAB_GITHUB_API 只支持 https 或本机 http')
  }
  return raw
}

function githubCodeloadBase(): string {
  const raw = (process.env.EAB_GITHUB_CODELOAD || 'https://codeload.github.com').replace(/\/+$/, '')
  const url = new URL(raw)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    throw new EabError(EC.VALIDATION, 'EAB_GITHUB_CODELOAD 只支持 https 或本机 http')
  }
  return raw
}

async function githubDefaultRef(repoFull: string, apiBase: string): Promise<string> {
  try {
    const response = await fetch(`${apiBase}/repos/${repoFull}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'EAB-skill-installer' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) return 'main'
    const meta = (await response.json()) as { default_branch?: unknown }
    return typeof meta.default_branch === 'string' && meta.default_branch.trim() ? meta.default_branch.trim() : 'main'
  } catch {
    return 'main'
  }
}

function stageResult(tempDir: string, root: string, source: 'git' | 'http', sourceRef: string, label: string): StagedSkillSource {
  return {
    dir: root,
    source,
    sourceRef,
    label,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  }
}

/**
 * GitHub：下载 codeload tarball 后解包，找到技能根目录。
 * 只读公开仓库，不执行 npm install、仓库脚本或 Git hooks。
 */
export async function stageSkillFromGithub(options: GithubSkillOptions): Promise<StagedSkillSource> {
  const repo = assertGithubRepo(options.repo)
  const requestedRef = assertGithubRef(options.ref ?? '')
  const subdir = assertSubdir(options.subdir ?? '')
  const apiBase = githubApiBase()
  const codeloadBase = githubCodeloadBase()
  const defaultRef = requestedRef || (await githubDefaultRef(repo.full, apiBase))
  const candidates = requestedRef ? [requestedRef] : Array.from(new Set([defaultRef, 'main', 'master']))

  const tempDir = mkdtempSync(join(tmpdir(), 'eab-skill-github-'))
  try {
    const archive = join(tempDir, 'repo.tar.gz')
    const extractDir = join(tempDir, 'extract')
    let usedRef = defaultRef
    let lastError: unknown = null
    for (const candidate of candidates) {
      try {
        await downloadArchive(`${codeloadBase}/${repo.owner}/${repo.repo}/tar.gz/${encodeGithubRef(candidate)}`, archive)
        usedRef = candidate
        lastError = null
        break
      } catch (error) {
        lastError = error
      }
    }
    if (lastError) throw lastError
    const kind: ArchiveKind = 'tar.gz'
    extractArchive(kind, archive, extractDir)
    const root = subdir ? resolveGithubSubdir(extractDir, subdir) : findSkillRoot(extractDir)
    const sourceRef = `github:${repo.full}#${usedRef}${subdir ? `?dir=${encodeURIComponent(subdir)}` : ''}`
    return stageResult(tempDir, root, 'git', sourceRef, `${repo.full}@${usedRef}${subdir ? ` / ${subdir}` : ''}`)
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true })
    throw error
  }
}

function resolveGithubSubdir(extractDir: string, subdir: string): string {
  const direct = resolve(extractDir, subdir)
  if (direct.startsWith(extractDir) && isSkillRoot(direct)) return direct
  for (const entry of readdirSync(extractDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const nested = resolve(extractDir, entry.name, subdir)
    if (nested.startsWith(extractDir) && isSkillRoot(nested)) return nested
  }
  throw new EabError(EC.VALIDATION, `仓库子目录里没有技能包（skill.json + SKILL.md）：${subdir}`)
}

/**
 * 直接压缩包 URL：支持 .tar.gz / .tgz / .zip，下载后找技能根。
 * sourceRef 只保留协议、主机和路径，不把查询串（可能含签名 token）写进数据库与审计。
 */
export async function stageSkillFromArchive(options: ArchiveSkillOptions): Promise<StagedSkillSource> {
  const safeUrl = await assertSafeRemoteUrl(options.url, '下载地址')
  const tempDir = mkdtempSync(join(tmpdir(), 'eab-skill-url-'))
  try {
    const archive = join(tempDir, 'package.bin')
    const extractDir = join(tempDir, 'extract')
    const downloaded = await downloadArchive(safeUrl.href, archive)
    const kind = detectArchiveKind(archive)
    const finalUrl = new URL(downloaded.finalUrl)
    extractArchive(kind, archive, extractDir)
    const root = findSkillRoot(extractDir)
    const sourceRef = `url:${finalUrl.protocol}//${finalUrl.host}${finalUrl.pathname}`
    return stageResult(tempDir, root, 'http', sourceRef, `${finalUrl.host}${finalUrl.pathname}`)
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true })
    throw error
  }
}
