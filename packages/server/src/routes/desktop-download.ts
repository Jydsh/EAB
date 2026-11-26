import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { ServerDeps } from '../deps.js'
import { ok, readVersion } from '../http.js'
import { defaultHomeDir } from '../settings.js'

const SETUP_RE = /^EAB-Setup-([\w.-]+)-x64\.exe$/i
const PORTABLE_RE = /^EAB-Desktop-Windows-x64\.zip$/i
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

function newestMatch(dir: string, pattern: RegExp): string {
  if (!existsSync(dir)) return ''
  try {
    return readdirSync(dir)
      .filter((name) => pattern.test(name))
      .map((name) => path.join(dir, name))
      .filter((file) => existsSync(file))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] || ''
  } catch {
    return ''
  }
}

function findInstaller(): DesktopArtifact | null {
  for (const dir of releaseDirs()) {
    const file = newestMatch(dir, SETUP_RE)
    if (!file) continue
    return {
      file,
      name: path.basename(file),
      size: statSync(file).size,
      contentType: 'application/vnd.microsoft.portable-executable',
    }
  }
  return null
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
  for (const dir of releaseDirs()) {
    const release = readReleaseManifest(dir)
    if (release?.artifact) return release
  }
  const artifact = findInstaller()
  if (!artifact) return null
  const match = SETUP_RE.exec(artifact.name)
  return {
    artifact,
    fileName: artifact.name,
    version: String(match?.[1] || readVersion()),
    sha256: sha256File(artifact.file),
    size: artifact.size,
    publishedAt: '',
    notes: '',
    remoteUrl: remoteAssetUrl(artifact.name),
  }
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

function findPortable(): DesktopArtifact | null {
  for (const dir of releaseDirs()) {
    const file = newestMatch(dir, PORTABLE_RE)
    if (!file) continue
    return {
      file,
      name: path.basename(file),
      size: statSync(file).size,
      contentType: 'application/zip',
    }
  }
  return null
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

function pageHtml(release: DesktopRelease | null, serverVersion: string, portable: DesktopArtifact | null): string {
  const version = release?.version ? `v${release.version.replace(/^v/i, '')}` : '未构建'
  const setupHref = release ? '/download/desktop/windows' : ''
  const portableHref = portable ? '/download/desktop/portable' : ''
  const setupSize = release?.size || release?.artifact?.size || 0
  const setupLabel = release ? `下载 Windows 安装包 · ${mb(setupSize)} MB` : '安装包尚未构建'
  const portableLabel = portable ? `下载便携版 zip · ${mb(portable.size)} MB` : '便携版尚未构建'
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>下载 EAB 桌面版</title>
  <style>
    :root { --brand:#0f7a5a; --ink:#182320; --muted:#66756f; --line:#dbe5e0; }
    * { box-sizing: border-box; }
    body {
      margin:0; min-height:100vh; display:grid; place-items:center; padding:32px;
      background: radial-gradient(1100px 560px at 12% -8%, rgba(15,122,90,.13), transparent 60%), #f4f7f5;
      color:var(--ink); font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
    }
    .card {
      width:min(720px,100%); background:#fff; border:1px solid var(--line); border-radius:24px;
      padding:38px; box-shadow:0 24px 70px rgba(23,42,34,.10);
    }
    .brand { display:flex; align-items:center; gap:12px; margin-bottom:24px; }
    .mark { width:44px; height:44px; border-radius:13px; display:grid; place-items:center; background:var(--brand); color:#fff; font-weight:800; }
    h1 { margin:0; font-size:28px; letter-spacing:-.5px; }
    .sub { margin:10px 0 26px; color:var(--muted); line-height:1.75; font-size:14px; }
    .actions { display:flex; flex-wrap:wrap; gap:10px; }
    .download {
      display:inline-flex; align-items:center; gap:10px; height:48px; padding:0 22px;
      border-radius:12px; background:var(--brand); color:#fff; text-decoration:none;
      font-weight:700; box-shadow:0 12px 26px rgba(15,122,90,.20);
    }
    .download.secondary { background:#fff; color:var(--brand); border:1px solid var(--line); box-shadow:none; }
    .download[aria-disabled="true"] { background:#8aa99e; pointer-events:none; box-shadow:none; color:#fff; }
    .meta { margin-top:14px; color:var(--muted); font-size:12px; line-height:1.7; }
    .steps { margin-top:26px; padding-top:22px; border-top:1px solid var(--line); display:grid; gap:12px; }
    .step { display:flex; gap:12px; align-items:flex-start; font-size:13px; line-height:1.65; }
    .step b { flex:0 0 22px; height:22px; border-radius:50%; display:grid; place-items:center; background:#eaf4ef; color:var(--brand); font-size:12px; }
    .note { margin-top:20px; padding:12px 14px; border-radius:11px; background:#f6f9f7; color:var(--muted); font-size:12px; line-height:1.7; }
    code { padding:1px 5px; border-radius:5px; background:#eef4f1; }
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">
      <div class="mark">EAB</div>
      <div><strong>EAB 企业智能体基座</strong><div class="meta">Windows 桌面版</div></div>
    </div>
    <h1>把网页工作台变成原生浏览器</h1>
    <p class="sub">桌面版和网页版共用同一套聊天、Agent、审批与云空间；右侧网页工作台换成原生 Chromium 标签，支持真实键鼠、音视频、下载和内网系统。</p>
    <div class="actions">
      <a class="download" href="${setupHref}" aria-disabled="${release ? 'false' : 'true'}">${setupLabel}</a>
      <a class="download secondary" href="${portableHref}" aria-disabled="${portable ? 'false' : 'true'}">${portableLabel}</a>
    </div>
    <div class="meta">桌面端 <code>${version}</code> · 当前服务 <code>${serverVersion}</code> · Windows 10/11 x64 · 安装包默认安装到 <code>C:\\Program Files\\EAB</code></div>
    <div class="steps">
      <div class="step"><b>1</b><span>运行 <code>EAB-Setup</code> 安装包，在安装向导里确认或更改安装位置。</span></div>
      <div class="step"><b>2</b><span>安装包会记住当前下载来源服务器，首次启动自动连接，不再要求手动填写 EAB 地址。</span></div>
      <div class="step"><b>3</b><span>在桌面窗口里登录；后续打开直接进入。开始菜单和桌面会生成 EAB 快捷方式。</span></div>
      <div class="step"><b>4</b><span>桌面端启动后会自动向当前 EAB 服务器检查新版本，发现更新后可下载、校验并静默安装。</span></div>
      <div class="step"><b>5</b><span>需要移除时，在 Windows“设置 > 应用 > 已安装的应用”里卸载 EAB，可选保留或清除本机登录状态。</span></div>
    </div>
    <div class="note">安装包尚未做代码签名，Windows 可能提示“未知发布者”，请确认来源后再运行。更新包同样通过当前 EAB 服务器分发并做 SHA256 校验；Web 版仍然可用，桌面版是可选的高性能形态。</div>
  </main>
</body>
</html>`
}

function sendMissing(reply: FastifyReply): FastifyReply {
  return reply
    .code(404)
    .type('text/html; charset=utf-8')
    .send(
      `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;color:#333"><h2>桌面版安装包尚未构建</h2><p>请先在开发机执行 <code>pnpm desktop:installer</code>，生成 <code>packages/desktop/release/EAB-Setup-*.exe</code> 后再下载。</p></body>`,
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
    return reply
      .type('text/html; charset=utf-8')
      .send(pageHtml(release, readVersion(), findPortable()))
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

  app.get('/download/desktop/setup', async (_req, reply) => {
    const release = await desktopRelease()
    if (!release) return sendMissing(reply)
    return sendRelease(reply, release)
  })

  app.get('/download/desktop/portable', async (_req, reply) => {
    const artifact = findPortable()
    if (!artifact) return sendMissing(reply)
    return sendArtifact(reply, artifact)
  })
}
