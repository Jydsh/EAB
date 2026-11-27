import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { ServerDeps } from '../deps.js'
import { ok, readVersion } from '../http.js'
import { defaultHomeDir } from '../settings.js'
import { desktopDownloadPage, type DownloadPageRelease } from './desktop-download-page.js'

const SETUP_RE = /^EAB-Setup-([\w.-]+)-x64\.exe$/i
const PORTABLE_RE = /^EAB-Desktop-Windows-x64(?:-([\w.-]+))?\.zip$/i
const MANIFEST_NAME = 'desktop-release.json'
const DEFAULT_REMOTE_BASE = 'https://github.com/Jydsh/EAB/releases/latest/download'
const REMOTE_MANIFEST_TTL_MS = 5 * 60 * 1000
const REMOTE_MANIFEST_TIMEOUT_MS = 8_000
const REMOTE_ARTIFACT_TIMEOUT_MS = 15 * 60 * 1000

interface DesktopArtifact {
  file: string
  name: string
  size: number
  contentType: string
}

interface DesktopRelease {
  artifact: DesktopArtifact | null
  fileName: string
  version: string
  sha256: string
  size: number
  publishedAt: string
  notes: string
  remoteUrl: string
  platform: string
  arch: string
}

interface PortableRelease {
  artifact: DesktopArtifact
  fileName: string
  version: string
  sha256: string
  size: number
  publishedAt: string
}

const digestCache = new Map<string, { mtimeMs: number; size: number; sha256: string }>()
const remoteCache = new Map<string, { at: number; release: DesktopRelease | null }>()

function sha256File(file: string): string {
  const stat = statSync(file)
  const cached = digestCache.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.sha256
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
  digestCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, sha256: digest })
  return digest
}

function versionParts(value: string): number[] {
  const parts = String(value || '').match(/\d+/g)
  return parts ? parts.map((part) => Number(part)) : []
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

function desktopReleaseDir(): string {
  const explicit = (process.env.EAB_DESKTOP_RELEASE_DIR || '').trim()
  if (explicit) return path.resolve(explicit)
  return path.join(defaultHomeDir(), 'desktop-release')
}

function releaseDirs(): string[] {
  const explicit = (process.env.EAB_DESKTOP_RELEASE_DIR || '').trim()
  // 显式指定发布目录时只读这一处，避免又读到代码目录里的旧包。
  if (explicit) return [path.resolve(explicit)]
  const dirs = [
    desktopReleaseDir(),
    path.resolve(process.cwd(), 'packages/desktop/release'),
    path.resolve(process.cwd(), '../../packages/desktop/release'),
    path.resolve(process.cwd(), '../packages/desktop/release'),
  ].filter(Boolean)
  return [...new Set(dirs)]
}

function remoteBaseUrl(): string {
  return (process.env.EAB_DESKTOP_RELEASE_URL || DEFAULT_REMOTE_BASE).trim().replace(/\/+$/, '')
}

function remoteManifestUrl(): string {
  return (process.env.EAB_DESKTOP_RELEASE_MANIFEST_URL || `${remoteBaseUrl()}/${MANIFEST_NAME}`).trim()
}

function remoteAssetUrl(fileName: string): string {
  const safeName = path.basename(String(fileName || '').trim())
  return `${remoteBaseUrl()}/${encodeURIComponent(safeName)}`
}

function isoFromMtime(file: string): string {
  try {
    return new Date(statSync(file).mtimeMs).toISOString()
  } catch {
    return ''
  }
}

function releaseFromSetupFile(file: string, manifest: DesktopRelease | null): DesktopRelease | null {
  const name = path.basename(file)
  const match = SETUP_RE.exec(name)
  if (!match) return null
  const version = match[1]
  const size = statSync(file).size
  const declared = manifest?.version === version ? manifest : null
  return {
    artifact: {
      file,
      name,
      size,
      contentType: 'application/vnd.microsoft.portable-executable',
    },
    fileName: name,
    version,
    sha256: declared?.sha256 || sha256File(file),
    size,
    publishedAt: declared?.publishedAt || isoFromMtime(file),
    notes: declared?.notes || '',
    remoteUrl: remoteAssetUrl(name),
    platform: 'win32',
    arch: 'x64',
  }
}

/**
 * 扫描发布目录里的全部安装包，而不是只挑 mtime 最新的一个。
 * 这样下载页可以列出历史版本，并为每个版本提供独立下载入口。
 */
function listSetupReleases(): DesktopRelease[] {
  const byVersion = new Map<string, DesktopRelease>()
  for (const dir of releaseDirs()) {
    if (!existsSync(dir)) continue
    const manifest = readReleaseManifest(dir)
    try {
      for (const name of readdirSync(dir)) {
        if (!SETUP_RE.test(name)) continue
        const file = path.join(dir, name)
        if (!existsSync(file)) continue
        const release = releaseFromSetupFile(file, manifest)
        if (!release) continue
        if (!byVersion.has(release.version)) byVersion.set(release.version, release)
      }
    } catch {
      // 目录不可读时继续尝试下一个候选目录。
    }
  }
  return [...byVersion.values()].sort((left, right) => compareVersions(right.version, left.version))
}

function normalizeRelease(parsed: Record<string, unknown>, dir: string): DesktopRelease | null {
  const version = String(parsed.version || '').trim()
  const fileName = path.basename(String(parsed.file || parsed.fileName || '').trim())
  if (!version || !SETUP_RE.test(fileName)) return null
  const file = dir ? path.join(dir, fileName) : ''
  const exists = Boolean(file && existsSync(file))
  const artifact = exists
    ? {
        file,
        name: fileName,
        size: statSync(file).size,
        contentType: 'application/vnd.microsoft.portable-executable',
      }
    : null
  const declaredSha = String(parsed.sha256 || '').trim().toLowerCase()
  const sha256 = /^[a-f0-9]{64}$/.test(declaredSha)
    ? declaredSha
    : artifact
      ? sha256File(artifact.file)
      : ''
  // 远程回源必须带校验值，否则宁可显示未构建，也不让服务端拉一个无法验签的 EXE。
  if (!dir && !sha256) return null
  const size = Number(parsed.size) || artifact?.size || 0
  if (!artifact && !size) return null
  return {
    artifact,
    fileName,
    version,
    sha256,
    size,
    publishedAt: String(parsed.publishedAt || ''),
    notes: String(parsed.notes || ''),
    remoteUrl: remoteAssetUrl(fileName),
    platform: String(parsed.platform || 'win32'),
    arch: String(parsed.arch || 'x64'),
  }
}

function readReleaseManifest(dir: string): DesktopRelease | null {
  const manifestFile = path.join(dir, MANIFEST_NAME)
  if (!existsSync(manifestFile)) return null
  try {
    return normalizeRelease(JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>, dir)
  } catch {
    return null
  }
}

function localRelease(): DesktopRelease | null {
  return listSetupReleases()[0] || null
}

function localReleaseByVersion(version: string): DesktopRelease | null {
  const target = String(version || '').trim().replace(/^v/i, '')
  if (!target) return null
  return listSetupReleases().find((release) => release.version === target) || null
}

async function remoteRelease(): Promise<DesktopRelease | null> {
  const url = remoteManifestUrl()
  const cached = remoteCache.get(url)
  if (cached && Date.now() - cached.at < REMOTE_MANIFEST_TTL_MS) return cached.release
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'EAB-server', 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(REMOTE_MANIFEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const parsed = (await response.json()) as Record<string, unknown>
    const release = normalizeRelease(parsed, '')
    if (!release || !release.sha256) throw new Error('清单缺少版本或 SHA256')
    remoteCache.set(url, { at: Date.now(), release })
    return release
  } catch {
    remoteCache.set(url, { at: Date.now(), release: null })
    return null
  }
}

async function desktopRelease(): Promise<DesktopRelease | null> {
  const local = localRelease()
  if (local) return local
  return remoteRelease()
}

/**
 * 首次下载时把 GitHub Release 的安装包拉回数据目录，校验 SHA256 后再给浏览器。
 * 下载成功后后续请求直接读本地文件，服务器不再依赖外网。
 */
async function materializeRelease(release: DesktopRelease): Promise<DesktopArtifact> {
  if (release.artifact) return release.artifact
  const dir = desktopReleaseDir()
  mkdirSync(dir, { recursive: true })
  const target = path.join(dir, release.fileName)
  if (existsSync(target)) {
    const cached: DesktopArtifact = {
      file: target,
      name: release.fileName,
      size: statSync(target).size,
      contentType: 'application/vnd.microsoft.portable-executable',
    }
    if (!release.sha256 || sha256File(target) === release.sha256) return cached
    rmSync(target, { force: true })
  }
  const part = `${target}.part`
  rmSync(part, { force: true })
  const response = await fetch(release.remoteUrl, {
    headers: { accept: 'application/octet-stream', 'user-agent': 'EAB-server' },
    signal: AbortSignal.timeout(REMOTE_ARTIFACT_TIMEOUT_MS),
    redirect: 'follow',
  })
  if (!response.ok || !response.body) throw new Error(`下载远端安装包失败（HTTP ${response.status}）`)
  const hasher = createHash('sha256')
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hasher.update(chunk)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body as never), tap, createWriteStream(part))
    const digest = hasher.digest('hex')
    if (release.sha256 && digest !== release.sha256) throw new Error('远端安装包 SHA256 不匹配')
    renameSync(part, target)
  } catch (error) {
    rmSync(part, { force: true })
    throw error
  }
  return {
    file: target,
    name: release.fileName,
    size: statSync(target).size,
    contentType: 'application/vnd.microsoft.portable-executable',
  }
}

function listPortableReleases(): PortableRelease[] {
  const fallbackVersion = listSetupReleases()[0]?.version || readVersion()
  const byVersion = new Map<string, PortableRelease>()
  const mtimes = new Map<string, number>()
  for (const dir of releaseDirs()) {
    if (!existsSync(dir)) continue
    try {
      for (const name of readdirSync(dir)) {
        const match = PORTABLE_RE.exec(name)
        if (!match) continue
        const file = path.join(dir, name)
        if (!existsSync(file)) continue
        // 旧便携包文件名没有版本号，沿用当前最新桌面版本的归档位；
        // 新构建会同时产出带版本号的副本，后续历史版本可按版本号精确下载。
        const version = String(match[1] || fallbackVersion || '').replace(/^v/i, '')
        if (!version) continue
        const stat = statSync(file)
        const existing = byVersion.get(version)
        if (existing && (mtimes.get(version) || 0) >= stat.mtimeMs) continue
        byVersion.set(version, {
          artifact: {
            file,
            name,
            size: stat.size,
            contentType: 'application/zip',
          },
          fileName: name,
          version,
          sha256: sha256File(file),
          size: stat.size,
          publishedAt: new Date(stat.mtimeMs).toISOString(),
        })
        mtimes.set(version, stat.mtimeMs)
      }
    } catch {
      // 目录不可读时继续尝试下一个候选目录。
    }
  }
  return [...byVersion.values()].sort((left, right) => compareVersions(right.version, left.version))
}

function findPortable(): DesktopArtifact | null {
  return listPortableReleases()[0]?.artifact || null
}

function findPortableByVersion(version: string): PortableRelease | null {
  const target = String(version || '').trim().replace(/^v/i, '')
  if (!target) return null
  return listPortableReleases().find((release) => release.version === target) || null
}

function toPageRelease(release: DesktopRelease): DownloadPageRelease {
  return {
    version: release.version,
    fileName: release.fileName,
    size: release.size,
    sha256: release.sha256,
    publishedAt: release.publishedAt,
    notes: release.notes,
  }
}

function pageHtml(release: DesktopRelease | null, releases: DesktopRelease[], portables: PortableRelease[], serverVersion: string): string {
  return desktopDownloadPage({
    latest: release ? toPageRelease(release) : null,
    releases: releases.map(toPageRelease),
    portables: portables.map((portable) => ({
      name: portable.fileName,
      size: portable.size,
      sha256: portable.sha256,
      publishedAt: portable.publishedAt,
      version: portable.version,
    })),
    serverVersion,
  })
}
function sendMissing(
  reply: FastifyReply,
  heading = '桌面版安装包尚未构建',
  detail = '请先在开发机执行 <code>pnpm desktop:installer</code>，生成 <code>packages/desktop/release/EAB-Setup-*.exe</code> 后再下载。',
): FastifyReply {
  return reply
    .code(404)
    .type('text/html; charset=utf-8')
    .send(
      `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;color:#333"><h2>${heading}</h2><p>${detail}</p></body>`,
    )
}

function sendArtifact(reply: FastifyReply, artifact: DesktopArtifact): FastifyReply {
  reply.header('cache-control', 'no-store')
  reply.header('content-type', artifact.contentType)
  reply.header('content-length', String(artifact.size))
  reply.header('content-disposition', `attachment; filename="${artifact.name}"`)
  return reply.send(createReadStream(artifact.file))
}

async function sendRelease(reply: FastifyReply, release: DesktopRelease): Promise<FastifyReply> {
  try {
    const artifact = await materializeRelease(release)
    return sendArtifact(reply, artifact)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return reply
      .code(502)
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;color:#333"><h2>桌面安装包下载失败</h2><p>${escapeHtml(message)}</p><p>请稍后重试，或从 GitHub Release 下载 ${escapeHtml(release.fileName)}。</p></body>`,
      )
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char)
}

export function registerDesktopDownloadRoutes(app: FastifyInstance, _deps: ServerDeps): void {
  app.get('/download/desktop', async (_req, reply) => {
    reply.header('cache-control', 'no-store')
    const release = await desktopRelease()
    const local = listSetupReleases()
    const catalog = local.length ? local : release ? [release] : []
    return reply
      .type('text/html; charset=utf-8')
      .send(pageHtml(release, catalog, listPortableReleases(), readVersion()))
  })

  // 桌面端版本清单：更新源固定在当前 EAB 服务器，远端清单只用于服务器没有本地包时回源。
  app.get('/api/desktop/update', async (req, reply) => {
    reply.header('cache-control', 'no-store')
    const release = await desktopRelease()
    if (!release) {
      return reply.code(404).send({
        ok: false,
        error: { code: 'DESKTOP_RELEASE_MISSING', message: '桌面安装包尚未构建，无法提供更新清单' },
      })
    }
    const query = (req.query || {}) as Record<string, unknown>
    const platform = String(query.platform || 'win32').trim()
    const arch = String(query.arch || 'x64').trim()
    const currentVersion = String(query.currentVersion || '').trim()
    const hasUpdate = !currentVersion || compareVersions(release.version, currentVersion) > 0
    return ok({
      platform: 'win32',
      arch: 'x64',
      supported: platform === 'win32' && arch === 'x64',
      version: release.version,
      currentVersion,
      hasUpdate: platform === 'win32' && arch === 'x64' && hasUpdate,
      downloadUrl: '/download/desktop/setup',
      fileName: release.fileName,
      size: release.size,
      sha256: release.sha256,
      publishedAt: release.publishedAt,
      notes: release.notes,
      channel: 'stable',
      source: 'eab-server',
    })
  })

  app.get('/api/desktop/version', async (_req, reply) => {
    reply.header('cache-control', 'no-store')
    const release = await desktopRelease()
    return ok({
      version: release?.version || '',
      fileName: release?.fileName || '',
      size: release?.size || 0,
      sha256: release?.sha256 || '',
      available: Boolean(release),
    })
  })

  // 主下载入口：版本清单和实际下载必须指向同一个安装包，避免更新 SHA256 与实际文件不一致。
  app.get('/download/desktop/windows', async (_req, reply) => {
    const release = await desktopRelease()
    if (release) return sendRelease(reply, release)
    const portable = findPortable()
    if (portable) return sendArtifact(reply, portable)
    return sendMissing(reply)
  })

  app.get('/download/desktop/setup', async (req, reply) => {
    const query = (req.query || {}) as Record<string, unknown>
    const requested = String(query.version || '').trim().replace(/^v/i, '')
    if (requested) {
      const local = localReleaseByVersion(requested)
      if (local) return sendRelease(reply, local)
      const latest = await desktopRelease()
      if (latest && latest.version === requested) return sendRelease(reply, latest)
      return sendMissing(
        reply,
        '未找到该版本的安装包',
        `发布目录中没有 <code>EAB-Setup-${escapeHtml(requested)}-x64.exe</code>，该版本可能已被移除，请从版本档案选择其他版本。`,
      )
    }
    const release = await desktopRelease()
    if (!release) return sendMissing(reply)
    return sendRelease(reply, release)
  })

  app.get('/download/desktop/portable', async (req, reply) => {
    const query = (req.query || {}) as Record<string, unknown>
    const requested = String(query.version || '').trim().replace(/^v/i, '')
    if (requested) {
      const release = findPortableByVersion(requested)
      if (!release) {
        return sendMissing(
          reply,
          '未找到该版本的便携包',
          `发布目录中没有 <code>EAB-Desktop-Windows-x64-${escapeHtml(requested)}.zip</code> 或对应的当前构建，请从版本档案选择其他版本。`,
        )
      }
      return sendArtifact(reply, release.artifact)
    }
    const artifact = findPortable()
    if (!artifact) return sendMissing(reply)
    return sendArtifact(reply, artifact)
  })
}
