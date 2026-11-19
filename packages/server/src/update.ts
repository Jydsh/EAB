/**
 * 版本更新：从公开 GitHub Release 读取最新版本，比较后返回状态。
 *
 * 设计边界：
 * - 只读 GitHub API，不执行远程脚本；
 * - 确认更新后，交给 scripts/eab-update.mjs 下载源码包、备份、替换、重启；
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readVersion } from './http.js'

const DEFAULT_REPO = 'Jydsh/EAB'
const CACHE_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 8000

export interface ReleaseAsset {
  name: string
  url: string
  size: number
  digest: string | null
}

export type UpdateResultStatus = 'starting' | 'running' | 'succeeded' | 'rolled_back' | 'failed'

export interface UpdateResult {
  status: UpdateResultStatus
  ok: boolean | null
  version: string | null
  previousVersion: string | null
  startedAt: string | null
  finishedAt: string | null
  at: string | null
  error: string | null
  healthDetail: string | null
  rolledBack: boolean | null
  root: string | null
  backupDir: string | null
  dataBackupDir: string | null
  pid: number | null
  updaterPid: number | null
  sourceUrl: string | null
  sourceDigest: string | null
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
  sourceDigest: string | null
  installerUrl: string | null
  assets: ReleaseAsset[]
  error: string | null
  lastResult: UpdateResult | null
}

let cached: UpdateStatus | null = null
let cachedAt = 0
let inflight: Promise<UpdateStatus> | null = null

export function normalizeVersion(value: string): string {
  return String(value ?? '').trim().replace(/^v/i, '')
}

function isInstallerAsset(name: string): boolean {
  return /(installer|setup|portable|desktop|windows|win32|win64|mac|darwin|linux|appimage|msi|exe)/i.test(name)
}

function sourceAssetScore(name: string): number {
  const lower = String(name ?? '').toLowerCase()
  let score = /\.zip$/i.test(lower) ? 1 : 0
  if (/source|src/.test(lower)) score += 50
  if (/eab/.test(lower)) score += 20
  if (/blockmap|checksum|sha256|digest/.test(lower)) score -= 100
  if (isInstallerAsset(lower)) score -= 100
  return score
}

/** 从 Release 资产中选源码包，避免把桌面安装包/校验文件误当成源码。 */
export function chooseSourceAsset(assets: ReleaseAsset[]): ReleaseAsset | null {
  return [...assets]
    .filter((item) => /\.zip$/i.test(item.name)
      && !/blockmap|checksum|sha256|digest/i.test(item.name)
      && !isInstallerAsset(item.name))
    .sort((a, b) => sourceAssetScore(b.name) - sourceAssetScore(a.name))[0] ?? null
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

function updatesDir(): string {
  const home = (process.env.EAB_HOME ?? '').trim()
  return home ? join(resolve(home), 'updates') : join(repoRoot(), '.eab-dev', 'updates')
}

export function lastUpdatePath(): string {
  return join(updatesDir(), 'last-update.json')
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? '').trim()
  return text || null
}

function nullableNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

/** 容错读取更新器写入的结果；旧文件只有 ok/at 时也能识别成功或失败。 */
export function parseUpdateResult(raw: string): UpdateResult | null {
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    parsed = value as Record<string, unknown>
  } catch {
    return null
  }
  const rawStatus = String(parsed.status ?? '').trim()
  const status: UpdateResultStatus | null =
    rawStatus === 'starting'
      || rawStatus === 'running'
      || rawStatus === 'succeeded'
      || rawStatus === 'rolled_back'
      || rawStatus === 'failed'
      ? rawStatus
      : parsed.ok === true
        ? 'succeeded'
        : parsed.ok === false
          ? 'failed'
          : null
  if (!status) return null
  return {
    status,
    ok: typeof parsed.ok === 'boolean' ? parsed.ok : null,
    version: nullableString(parsed.version),
    previousVersion: nullableString(parsed.previousVersion),
    startedAt: nullableString(parsed.startedAt),
    finishedAt: nullableString(parsed.finishedAt),
    at: nullableString(parsed.at ?? parsed.finishedAt ?? parsed.startedAt),
    error: nullableString(parsed.error),
    healthDetail: nullableString(parsed.healthDetail),
    rolledBack: typeof parsed.rolledBack === 'boolean' ? parsed.rolledBack : null,
    root: nullableString(parsed.root),
    backupDir: nullableString(parsed.backupDir),
    dataBackupDir: nullableString(parsed.dataBackupDir),
    pid: nullableNumber(parsed.pid),
    updaterPid: nullableNumber(parsed.updaterPid),
    sourceUrl: nullableString(parsed.sourceUrl),
    sourceDigest: nullableString(parsed.sourceDigest),
  }
}

export function readLastUpdateResult(path = lastUpdatePath()): UpdateResult | null {
  try {
    if (!existsSync(path)) return null
    return parseUpdateResult(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** starting/running 且未超过 30 分钟才视为进行中，避免崩溃后永久锁死。 */
export function isActiveUpdate(result: UpdateResult | null, now = Date.now()): boolean {
  if (!result || (result.status !== 'starting' && result.status !== 'running')) return false
  const started = Date.parse(result.startedAt ?? result.at ?? '')
  return Number.isFinite(started) && now - started < 30 * 60 * 1000
}

/** 等待更新器把状态从 starting 改成 running，确认子进程真的接管后再停服务。 */
export async function waitForUpdaterStarted(timeoutMs = 3000, since?: string | null): Promise<boolean> {
  const sinceMs = Date.parse(since ?? '')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = readLastUpdateResult()
    const startedMs = Date.parse(result?.startedAt ?? '')
    if (
      result?.status === 'running'
      && result.updaterPid
      && (!Number.isFinite(sinceMs) || (Number.isFinite(startedMs) && startedMs >= sinceMs - 1000))
    ) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  return false
}

/** 握手超时后终止未确认接管的更新器，避免页面已报失败、后台仍在替换代码。 */
export function cancelUpdateStart(pid: number | null | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid)
    return true
  } catch {
    return false
  }
}

/** 更新器没有确认启动时释放锁；只在仍处于 starting 时改写，避免覆盖已完成的终态。 */
export function markUpdateStartFailed(error: string, cancelledPid?: number | null): void {
  const current = readLastUpdateResult()
  if (!current) return
  const ownRunning =
    cancelledPid != null
    && current.status === 'running'
    && current.updaterPid === cancelledPid
  if (current.status !== 'starting' && !ownRunning) return
  const finishedAt = new Date().toISOString()
  writeUpdateResult({
    ...current,
    status: 'failed',
    ok: false,
    finishedAt,
    at: finishedAt,
    error,
  })
}

function writeUpdateResult(result: UpdateResult): void {
  const path = lastUpdatePath()
  mkdirSync(updatesDir(), { recursive: true })
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

function writeUpdateStart(input: {
  version: string
  previousVersion: string
  sourceUrl: string
  sourceDigest?: string | null
  pid: number | null
  root: string
  startedAt: string
}): UpdateResult {
  const result: UpdateResult = {
    status: 'starting',
    ok: null,
    version: input.version,
    previousVersion: input.previousVersion,
    startedAt: input.startedAt,
    finishedAt: null,
    at: input.startedAt,
    error: null,
    healthDetail: null,
    rolledBack: null,
    root: input.root,
    backupDir: null,
    dataBackupDir: null,
    pid: null,
    updaterPid: input.pid,
    sourceUrl: input.sourceUrl,
    sourceDigest: input.sourceDigest ?? null,
  }
  writeUpdateResult(result)
  return result
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
    sourceDigest: null,
    installerUrl: null,
    assets: [],
    error,
    lastResult: readLastUpdateResult(),
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
    assets?: Array<{ name?: string; browser_download_url?: string; size?: number; digest?: string }>
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
      digest: item.digest ? String(item.digest) : null,
    }))

  // 优先用 Release 附带的源码 zip；GitHub 自动生成的 zipball 作为兜底。
  const sourceAsset = chooseSourceAsset(assets)
  const sourceUrl = sourceAsset?.url ?? body.zipball_url ?? null
  const sourceDigest = sourceAsset?.digest ?? null
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
    sourceDigest,
    installerUrl: installerAsset?.url ?? null,
    assets,
    error: null,
    lastResult: readLastUpdateResult(),
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
  return cached ? { ...cached, lastResult: readLastUpdateResult() } : emptyStatus()
}

/**
 * 启动更新器。更新器独立于当前服务进程运行，等服务退出后再替换文件。
 * 返回后调用方应在几百毫秒内关闭服务，避免 Windows 上文件被占用。
 * 更新器参数固定带 --restart=1；oldPid 用来让更新器确认健康响应来自新进程。
 */
export function buildUpdateArgs(
  version: string,
  sourceUrl: string,
  root: string,
  sourceDigest?: string | null,
  oldPid = 0,
): string[] {
  return [
    join(root, 'scripts', 'eab-update.mjs'),
    '--apply',
    `--url=${sourceUrl}`,
    `--version=${version}`,
    `--root=${root}`,
    '--restart=1',
    ...(oldPid > 0 ? [`--old-pid=${oldPid}`] : []),
    ...(sourceDigest ? [`--sha256=${sourceDigest}`] : []),
  ]
}

export function startUpdate(
  version: string,
  sourceUrl: string,
  sourceDigest?: string | null,
): { started: boolean; command: string; pid: number | null; startedAt: string } {
  if (process.env.EAB_DESKTOP === '1') {
    throw new Error('桌面版请使用菜单「EAB → 检查桌面更新」安装新版本，不要在控制台替换内嵌服务')
  }
  const active = readLastUpdateResult()
  if (isActiveUpdate(active)) {
    throw new Error('已有更新正在执行，请等待当前更新结束或查看 .eab-dev/updates/last-update.log')
  }
  const root = repoRoot()
  const script = join(root, 'scripts', 'eab-update.mjs')
  if (!existsSync(script)) throw new Error('缺少 scripts/eab-update.mjs，当前部署不能执行一键更新')
  const digestArg = sourceDigest ? ` --sha256=${sourceDigest}` : ''
  const args = buildUpdateArgs(version, sourceUrl, root, sourceDigest, process.pid)
  // 先写 starting 再 spawn：更新器可能比服务端回写更快，
  // 反过来会在它写 running 之后被 starting 覆盖，握手永远等不到 running。
  const startedAt = new Date().toISOString()
  writeUpdateStart({
    version,
    previousVersion: readVersion(),
    sourceUrl,
    sourceDigest: sourceDigest ?? null,
    pid: null,
    root,
    startedAt,
  })
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch (error) {
    markUpdateStartFailed(`更新器启动失败：${(error as Error).message}`)
    throw error
  }
  // spawn 的失败是异步事件；不挂监听会变成未处理异常，接口却已经返回 accepted。
  child.on('error', (error) => {
    markUpdateStartFailed(`更新器启动失败：${error.message}`)
    console.error('[eab] 更新器启动失败：', error.message)
  })
  if (!child.pid) {
    markUpdateStartFailed('更新器进程没有启动，无法执行一键更新')
    throw new Error('更新器进程没有启动，无法执行一键更新')
  }
  child.unref()
  return {
    started: true,
    pid: child.pid,
    startedAt,
    command: `node scripts/eab-update.mjs --apply --url=${sourceUrl} --version=${version} --root=${root} --restart=1 --old-pid=${process.pid}${digestArg}`,
  }
}
