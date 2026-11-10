/**
 * 版本更新：从公开 GitHub Release 读取最新版本，比较后返回状态。
 *
 * 设计边界：
 * - 只读 GitHub API，不执行远程脚本；
 * - 确认更新后，交给 scripts/eab-update.mjs 下载源码包、备份、替换、重启；
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readVersion } from './http.js'

const DEFAULT_REPO = 'Jydsh/EAB'
const CACHE_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 8000

export interface ReleaseAsset {
  name: string
  url: string
  size: number
}

export interface UpdateStatus {
  current: string
  latest: string | null
  hasUpdate: boolean
  checkedAt: string
  releaseUrl: string | null
  publishedAt: string | null
  notes: string
  sourceUrl: string | null
  installerUrl: string | null
  assets: ReleaseAsset[]
  error: string | null
}

let cached: UpdateStatus | null = null
let cachedAt = 0
let inflight: Promise<UpdateStatus> | null = null

export function normalizeVersion(value: string): string {
  return String(value ?? '').trim().replace(/^v/i, '')
}

/** 年月日版本号按数字段比较；非数字段按字符串兜底，避免抛错。 */
export function isNewerVersion(current: string, latest: string): boolean {
  const a = normalizeVersion(current)
  const b = normalizeVersion(latest)
  if (!a || !b) return false
  const av = a.split('.')
  const bv = b.split('.')
  const length = Math.max(av.length, bv.length)
  for (let i = 0; i < length; i += 1) {
    const x = Number(av[i] ?? 0)
    const y = Number(bv[i] ?? 0)
    if (Number.isNaN(x) || Number.isNaN(y)) {
      if (av[i] === bv[i]) continue
      return String(bv[i] ?? '').localeCompare(String(av[i] ?? '')) > 0
    }
    if (x !== y) return y > x
  }
  return false
}

function repoSlug(): string {
  return (process.env.EAB_UPDATE_REPO ?? DEFAULT_REPO).trim() || DEFAULT_REPO
}

function repoRoot(): string {
  if (process.env.EAB_ROOT) return process.env.EAB_ROOT
  return fileURLToPath(new URL('../../../', import.meta.url))
}

function emptyStatus(error: string | null = null): UpdateStatus {
  return {
    current: readVersion(),
    latest: null,
    hasUpdate: false,
    checkedAt: new Date().toISOString(),
    releaseUrl: null,
    publishedAt: null,
    notes: '',
    sourceUrl: null,
    installerUrl: null,
    assets: [],
    error,
  }
}

async function requestRelease(): Promise<UpdateStatus> {
  const repo = repoSlug()
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'EAB-Update-Checker',
  }
  const token = (process.env.EAB_GITHUB_TOKEN ?? '').trim()
  if (token) headers.authorization = `Bearer ${token}`

  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GitHub Release 读取失败：HTTP ${res.status}${text ? ` · ${text.slice(0, 80)}` : ''}`)
  }
  const body = (await res.json()) as {
    tag_name?: string
    name?: string
    html_url?: string
    published_at?: string
    body?: string
    zipball_url?: string
    assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>
  }
  const tag = String(body.tag_name ?? '').trim()
  const latest = normalizeVersion(tag)
  if (!latest) throw new Error('GitHub Release 没有 tag_name，无法判断版本')

  const assets: ReleaseAsset[] = (body.assets ?? [])
    .filter((item) => item.name && item.browser_download_url)
    .map((item) => ({
      name: String(item.name),
      url: String(item.browser_download_url),
      size: Number(item.size ?? 0),
    }))

  // 优先用 Release 附带的源码 zip；GitHub 自动生成的 zipball 作为兜底。
  const sourceAsset = assets.find((item) => /\.zip$/i.test(item.name) && !/blockmap/i.test(item.name))
  const sourceUrl = sourceAsset?.url ?? body.zipball_url ?? null
  const installerAsset = assets.find((item) => /\.(exe|msi|dmg|appimage)$/i.test(item.name))
  const current = readVersion()

  return {
    current,
    latest,
    hasUpdate: isNewerVersion(current, latest),
    checkedAt: new Date().toISOString(),
    releaseUrl: body.html_url ?? null,
    publishedAt: body.published_at ?? null,
    notes: String(body.body ?? '').slice(0, 4000),
    sourceUrl,
    installerUrl: installerAsset?.url ?? null,
    assets,
    error: null,
  }
}

export async function checkForUpdate(force = false): Promise<UpdateStatus> {
  if (!force && cached && Date.now() - cachedAt < CACHE_MS) return cached
  if (inflight) return inflight
  inflight = requestRelease()
    .then((status) => {
      cached = status
      cachedAt = Date.now()
      return status
    })
    .catch((error: Error) => {
      const status = emptyStatus(error.message)
      cached = status
      cachedAt = Date.now()
      return status
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function getCachedUpdateStatus(): UpdateStatus {
  return cached ?? emptyStatus()
}

/**
 * 启动更新器。更新器独立于当前服务进程运行，等服务退出后再替换文件。
 * 返回后调用方应在几百毫秒内关闭服务，避免 Windows 上文件被占用。
 */
export function startUpdate(version: string, sourceUrl: string): { started: boolean; command: string } {
  if (process.env.EAB_DESKTOP === '1') {
    throw new Error('桌面版请使用菜单「EAB → 检查桌面更新」安装新版本，不要在控制台替换内嵌服务')
  }
  const root = repoRoot()
  const script = join(root, 'scripts', 'eab-update.mjs')
  if (!existsSync(script)) throw new Error('缺少 scripts/eab-update.mjs，当前部署不能执行一键更新')
  const args = [script, '--apply', `--url=${sourceUrl}`, `--version=${version}`, `--root=${root}`, '--restart=1']
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return { started: true, command: `node scripts/eab-update.mjs --apply --version=${version} --restart` }
}
