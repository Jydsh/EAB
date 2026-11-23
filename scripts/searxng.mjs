#!/usr/bin/env node
/**
 * SearXNG 自动部署与进程管理。
 *
 * EAB 发布包只带客户端适配，不带 SearXNG 服务本体。这个模块负责在部署时
 * 把本机缺失的 SearXNG 补上：
 *
 * 1. 已有可用的 SearXNG（本机或远程）→ 直接复用；
 * 2. 有 Docker + Compose → 用官方镜像启动，数据目录挂到 .eab-dev/searxng-runtime；
 * 3. 没有 Docker → 用本机 Python 建虚拟环境、下载固定提交的源码并启动；
 * 4. 两种方式都不可用 → 抛出明确错误，EAB 本身仍可启动，只是搜索返回未配置。
 *
 * 所有自动安装都只监听 127.0.0.1，不把搜索服务暴露到公网。配置写入
 * console-settings.json 的 webSearch，部署人员不需要手工改文件。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 固定提交，避免 master 漂移导致每次部署的 SearXNG 版本不同。 */
export const DEFAULT_SEARXNG_COMMIT = 'c6ee3e9fd0235004a694e63720efc869bb1e3594'
export const DEFAULT_SEARXNG_URL = 'http://127.0.0.1:8080/'
export const DEFAULT_SEARXNG_PORT = 8080

const DEFAULT_SOURCE_URL = `https://codeload.github.com/searxng/searxng/tar.gz/${DEFAULT_SEARXNG_COMMIT}`
const DEFAULT_IMAGE = 'searxng/searxng:latest'

/** 显式端口：空值或 auto 表示交给系统自动选择；其余必须是 1–65535 的整数。 */
export function normalizeSearxngPort(value) {
  if (value === undefined || value === null) return null
  const raw = String(value).trim()
  if (!raw || /^(auto|自动)$/i.test(raw)) return null
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SearXNG 端口必须是 1–65535 的整数，或留空让系统自动选择：${raw}`)
  }
  return port
}


/** 把用户填的地址归一成 `http://host:port/`，不带查询参数。 */
export function normalizeBaseUrl(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`SearXNG 地址只支持 http/https：${raw}`)
  if (!parsed.hostname) throw new Error(`SearXNG 地址缺少主机名：${raw}`)
  parsed.search = ''
  parsed.hash = ''
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}/`
}

export function isLoopbackUrl(value) {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

export function urlPort(value, fallback = DEFAULT_SEARXNG_PORT) {
  try {
    const parsed = new URL(value)
    if (parsed.port) return Number(parsed.port)
    return parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return fallback
  }
}

function localUrlForPort(port) {
  return `http://127.0.0.1:${port}/`
}

function readJson(file, fallback = null) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value, mode) {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode })
  renameSync(tmp, file)
}

/** 读取控制台已保存的搜索配置；文件不存在或损坏时返回空对象。 */
export function readWebSearchSettings(settingsFile) {
  const raw = readJson(settingsFile, {})
  const webSearch = raw && typeof raw.webSearch === 'object' && raw.webSearch ? raw.webSearch : {}
  return {
    provider: typeof webSearch.provider === 'string' ? webSearch.provider : '',
    searxngUrl: typeof webSearch.searxngUrl === 'string' ? webSearch.searxngUrl : '',
  }
}

/**
 * 只补 webSearch 字段，不把整个设置文件重写成默认值。
 * 这样不会丢掉用户已有的品牌、OnlyOffice、存储路径等配置。
 */
export function persistWebSearch(settingsFile, searxngUrl) {
  const raw = existsSync(settingsFile) ? readJson(settingsFile, null) : {}
  if (!raw || typeof raw !== 'object') throw new Error(`控制台设置文件不是有效 JSON：${settingsFile}`)
  raw.webSearch = { ...(raw.webSearch && typeof raw.webSearch === 'object' ? raw.webSearch : {}), provider: 'searxng', searxngUrl }
  writeJson(settingsFile, raw)
  return raw.webSearch
}

async function urlHealthy(baseUrl, timeoutMs = 1500) {
  try {
    const res = await fetch(new URL('/healthz', baseUrl), { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return false
    // 不能只看 HTTP 200：8080 可能被别的服务占用，SearXNG 的 /healthz 明确返回纯文本 OK。
    const text = (await res.text()).trim()
    return text.length <= 32 && /^ok$/i.test(text)
  } catch {
    return false
  }
}

async function waitHealthy(baseUrl, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await urlHealthy(baseUrl, 2000)) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000))
  }
  return false
}

function portOpen(port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(1000)
    socket.once('connect', () => {
      socket.destroy()
      resolvePromise(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolvePromise(true)
    })
    socket.once('error', () => resolvePromise(false))
  })
}

/** 首选端口可用就返回；被非 SearXNG 进程占用时顺延找 50 个端口。 */
export async function chooseLocalPort(preferred) {
  for (let offset = 0; offset <= 50; offset += 1) {
    const port = preferred + offset
    if (port > 65535) break
    if (!(await portOpen(port))) return port
  }
  throw new Error(`从 ${preferred} 开始连续 50 个端口都被占用，无法启动 SearXNG`)
}

function lastLines(text, count = 30) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-count)
    .join('\n')
}

function runCapture(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? 120000,
    maxBuffer: 20 * 1024 * 1024,
  })
  if (result.error) throw new Error(`${cmd} 执行失败：${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(
      `${options.label ?? `${cmd} ${args.join(' ')}`} 失败（退出码 ${result.status ?? 'unknown'}）\n` +
        `${lastLines(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)}`,
    )
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
}

async function runStreaming(cmd, args, options = {}) {
  const logFile = options.logFile
  if (logFile) {
    mkdirSync(join(logFile, '..'), { recursive: true })
    writeFileSync(logFile, '', 'utf8')
  }
  const child = spawn(cmd, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    windowsHide: true,
    shell: false,
  })
  const forward = (stream, isErr) => {
    stream.on('data', (chunk) => {
      const text = chunk.toString()
      if (logFile) writeFileSync(logFile, text, { encoding: 'utf8', flag: 'a' })
      if (isErr) process.stderr.write(text)
      else process.stdout.write(text)
    })
  }
  forward(child.stdout, false)
  forward(child.stderr, true)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
  }, options.timeout ?? 600000)
  await new Promise((resolvePromise, reject) => {
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else {
        const tail = logFile && existsSync(logFile) ? lastLines(readFileSync(logFile, 'utf8')) : ''
        reject(new Error(`${options.label ?? `${cmd} ${args.join(' ')}`} ${timedOut ? '超时被终止' : `失败（退出码 ${code}）`}\n${tail}`))
      }
    })
  })
}

function findPython() {
  const configured = String(process.env.EAB_PYTHON ?? '').trim()
  const candidates = configured ? [configured] : process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']
  for (const cmd of candidates) {
    if (configured && !existsSync(cmd)) continue
    const result = spawnSync(cmd, ['-c', 'import sys; print(".".join(map(str, sys.version_info[:3])))'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    })
    if (result.error || result.status !== 0) continue
    const version = String(result.stdout ?? '').trim()
    const major = Number(version.split('.')[0])
    const minor = Number(version.split('.')[1])
    if (major > 3 || (major === 3 && minor >= 10)) return { cmd, version }
  }
  return null
}

function dockerAvailable() {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  })
  return !result.error && result.status === 0
}

function composeAvailable() {
  const modern = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  if (!modern.error && modern.status === 0) return { cmd: 'docker', args: ['compose'] }
  const legacy = spawnSync('docker-compose', ['version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  if (!legacy.error && legacy.status === 0) return { cmd: 'docker-compose', args: [] }
  return null
}

function readPid(runDir) {
  const data = readJson(join(runDir, 'searx.pid.json'), null)
  if (!data || !Number.isInteger(data.pid) || data.pid <= 0) return null
  return data
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function processIsSearxng(pid) {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    )
    if (result.error || result.status !== 0) return false
    return /searx\.webapp|searxng/i.test(result.stdout ?? '')
  }
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 10000 })
  return !result.error && result.status === 0 && /searx\.webapp|searxng/i.test(result.stdout ?? '')
}

function settingsTemplate(port, secret, bindAddress) {
  return `use_default_settings:
  engines:
    keep_only:
      - bing
      - baidu

general:
  instance_name: "EAB Search"

server:
  secret_key: "${secret}"
  bind_address: "${bindAddress}"
  port: ${port}
  limiter: false
  public_instance: false
  image_proxy: false

search:
  safe_search: 1
  formats:
    - html
    - json

engines:
  - name: bing
    disabled: false
    base_url: https://cn.bing.com
  - name: baidu
    disabled: false
`
}

function readOrCreateSecret(settingsFile) {
  try {
    const text = readFileSync(settingsFile, 'utf8')
    const match = /secret_key:\s*"([^"]+)"/.exec(text)
    if (match?.[1]) return match[1]
  } catch {
    /* 首次部署还没有设置文件 */
  }
  return randomBytes(32).toString('hex')
}

function writeSettings(settingsFile, port, secret, bindAddress = '127.0.0.1', mode = 0o600) {
  mkdirSync(join(settingsFile, '..'), { recursive: true })
  const tmp = `${settingsFile}.tmp`
  writeFileSync(tmp, settingsTemplate(port, secret, bindAddress), { encoding: 'utf8', mode })
  renameSync(tmp, settingsFile)
}

function syncThemeAssets(source) {
  const staticRoot = join(source, 'searx', 'static')
  const themeRoot = join(staticRoot, 'themes', 'simple')
  const templateRoot = join(source, 'searx', 'templates')
  if (!existsSync(themeRoot)) throw new Error(`SearXNG 源码缺少 simple 主题：${themeRoot}`)

  let copied = 0
  for (const name of readdirSync(themeRoot)) {
    if (!name.startsWith('sxng-') && name !== 'manifest.json') continue
    cpSync(join(themeRoot, name), join(staticRoot, name), { force: true })
    copied += 1
  }
  if (!existsSync(join(staticRoot, 'sxng-ltr.min.css'))) {
    throw new Error('SearXNG 源码包缺少预构建样式 sxng-ltr.min.css，无法保证搜索页正常显示')
  }
  for (const asset of ['chunk', 'img']) {
    const from = join(themeRoot, asset)
    if (!existsSync(from)) continue
    cpSync(from, join(staticRoot, asset), { recursive: true, force: true })
    copied += 1
  }
  const resultSource = join(templateRoot, 'simple', 'result_templates')
  if (existsSync(resultSource)) {
    cpSync(resultSource, join(templateRoot, 'result_templates'), { recursive: true, force: true })
    copied += 1
  }
  if (copied === 0) throw new Error('SearXNG 源码包没有可同步的主题资源')
}

async function downloadArchive(url, archive) {
  mkdirSync(join(archive, '..'), { recursive: true })
  const part = `${archive}.part`
  if (existsSync(part)) rmSync(part, { force: true })
  let res
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) })
  } catch (error) {
    throw new Error(`下载 SearXNG 源码失败：${error.message}\n可设置 EAB_SEARXNG_SOURCE_URL 指向内网镜像或离线包`)
  }
  if (!res.ok || !res.body) throw new Error(`下载 SearXNG 源码失败：HTTP ${res.status} ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part))
  renameSync(part, archive)
}

function extractArchive(archive, target, sourceMarker) {
  if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  const temp = `${target}.extract`
  if (existsSync(temp)) rmSync(temp, { recursive: true, force: true })
  mkdirSync(temp, { recursive: true })
  // `utils/templates/etc/apache2` 在源码包里是符号链接，Windows tar 无法创建；
  // 运行 SearXNG 不需要 utils 目录，直接排除，避免自动部署在 Windows 上中断。
  const result = spawnSync('tar', ['-xzf', archive, '-C', temp, '--exclude', '*/utils'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 20 * 1024 * 1024,
  })
  if (result.error) throw new Error(`解压 SearXNG 源码失败，需要系统 tar 命令：${result.error.message}`)
  if (result.status !== 0) throw new Error(`解压 SearXNG 源码失败\n${lastLines(result.stderr)}`)
  const entries = readdirSync(temp)
  const root = entries.length === 1 ? join(temp, entries[0]) : temp
  mkdirSync(target, { recursive: true })
  cpSync(root, target, { recursive: true, force: true })
  writeJson(join(target, '.eab-source.json'), sourceMarker)
  rmSync(temp, { recursive: true, force: true })
}

async function ensureNativeSource(runtime, log) {
  const source = join(runtime, 'source')
  const archive = join(runtime, 'download', 'searxng.tar.gz')
  const sourceUrl = String(process.env.EAB_SEARXNG_SOURCE_URL ?? '').trim() || DEFAULT_SOURCE_URL
  const markerFile = join(source, '.eab-source.json')
  const marker = readJson(markerFile, null)
  if (existsSync(join(source, 'searx', 'webapp.py')) && marker?.sourceUrl === sourceUrl) {
    log(`复用已下载的 SearXNG 源码：${source}`)
  } else {
    log(`下载 SearXNG 源码：${sourceUrl}`)
    await downloadArchive(sourceUrl, archive)
    log(`解压 SearXNG 源码到：${source}`)
    extractArchive(archive, source, { sourceUrl, commit: DEFAULT_SEARXNG_COMMIT, downloadedAt: new Date().toISOString() })
  }
  syncThemeAssets(source)
  return source
}

function nativePython(runtime) {
  return join(runtime, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
}

function ensurePythonVenv(runtime, python, log) {
  const venv = join(runtime, 'venv')
  const venvPython = nativePython(runtime)
  if (!existsSync(venvPython)) {
    log(`创建 SearXNG Python 虚拟环境：${venv}`)
    runCapture(python.cmd, ['-m', 'venv', venv], { label: '创建 Python 虚拟环境' })
  }
  return venvPython
}

async function ensurePythonDeps(runtime, venvPython, source, log) {
  const requirements = join(source, 'requirements.txt')
  const markerFile = join(runtime, 'venv', '.eab-requirements.sha256')
  const hash = createHash('sha256').update(readFileSync(requirements)).digest('hex')
  if (existsSync(markerFile) && readFileSync(markerFile, 'utf8').trim() === hash) return
  log('安装 SearXNG Python 依赖（首次部署约 1–3 分钟）')
  await runStreaming(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements], {
    cwd: source,
    logFile: join(runtime, 'logs', 'pip-install.log'),
    label: '安装 SearXNG Python 依赖',
  })
  writeFileSync(markerFile, `${hash}\n`, 'utf8')
  log('SearXNG Python 依赖安装完成')
}

function patchWindowsCompatibility(source) {
  if (process.platform !== 'win32') return
  const file = join(source, 'searx', 'valkeydb.py')
  if (!existsSync(file)) return
  const text = readFileSync(file, 'utf8')
  if (text.includes('except ImportError')) return
  const patched = text.replace('import pwd\n', 'try:\n    import pwd\nexcept ImportError:  # Windows 没有 pwd，仅用于连接失败日志\n    pwd = None\n')
  if (patched !== text) writeFileSync(file, patched, 'utf8')
}

async function startNative(runtime, port, log) {
  const source = join(runtime, 'source')
  const settingsFile = join(runtime, 'config', 'settings.yml')
  const venvPython = nativePython(runtime)
  if (!existsSync(source) || !existsSync(venvPython)) throw new Error('SearXNG 本机运行时尚未安装')
  const existing = readPid(join(runtime, 'run'))
  if (existing && processExists(existing.pid) && processIsSearxng(existing.pid)) stopNative(runtime, log)
  mkdirSync(join(runtime, 'logs'), { recursive: true })
  mkdirSync(join(runtime, 'run'), { recursive: true })
  const outLog = join(runtime, 'logs', 'searxng.out.log')
  const errLog = join(runtime, 'logs', 'searxng.err.log')

  writeSettings(settingsFile, port, readOrCreateSecret(settingsFile))
  const env = {
    ...process.env,
    SEARXNG_SETTINGS_PATH: settingsFile,
    SEARXNG_PORT: String(port),
    SEARXNG_BIND_ADDRESS: '127.0.0.1',
    PYTHONUTF8: '1',
  }
  const outFd = openSync(outLog, 'a')
  const errFd = openSync(errLog, 'a')
  const child = spawn(venvPython, ['-m', 'searx.webapp'], {
    cwd: source,
    env,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', outFd, errFd],
  })
  child.unref()
  closeSync(outFd)
  closeSync(errFd)
  const pidFile = join(runtime, 'run', 'searx.pid.json')
  writeJson(pidFile, { pid: child.pid, port, startedAt: new Date().toISOString(), mode: 'native', source })
  writeJson(join(runtime, 'state.json'), {
    mode: 'native',
    port,
    url: localUrlForPort(port),
    source,
    installedAt: new Date().toISOString(),
  })
  log(`SearXNG 本机进程已启动：PID ${child.pid}，端口 ${port}`)
}

function stopNative(runtime, log) {
  const pidFile = join(runtime, 'run', 'searx.pid.json')
  const data = readPid(join(runtime, 'run'))
  if (!data) {
    return false
  }
  if (!processExists(data.pid)) {
    rmSync(pidFile, { force: true })
    return false
  }
  if (!processIsSearxng(data.pid)) {
    log(`PID ${data.pid} 已不是 SearXNG，跳过停止`)
    rmSync(pidFile, { force: true })
    return false
  }
  try {
    process.kill(data.pid)
    log(`已停止 SearXNG 本机进程：PID ${data.pid}`)
  } catch (error) {
    log(`停止 SearXNG 进程失败：${error.message}`)
    return false
  }
  rmSync(pidFile, { force: true })
  return true
}

function composeYaml(port, image) {
  return `services:
  searxng:
    image: "${image}"
    restart: unless-stopped
    ports:
      - "127.0.0.1:${port}:8080"
    volumes:
      - "./config:/etc/searxng"
    environment:
      - "SEARXNG_BASE_URL=http://127.0.0.1:${port}/"
`
}

function dockerComposeArgs(compose, args) {
  return [...compose.args, '-p', 'eab-searxng', ...args]
}

async function startDocker(runtime, port, log) {
  const compose = composeAvailable()
  if (!compose) throw new Error('已检测到 Docker，但没有 Docker Compose（docker compose / docker-compose）')
  mkdirSync(join(runtime, 'config'), { recursive: true })
  const settingsFile = join(runtime, 'config', 'settings.yml')
  // Docker 内部必须监听 0.0.0.0，否则宿主机映射不到容器里的 127.0.0.1；
  // 对外安全由 compose 的 127.0.0.1:port 端口映射保证。容器用户与宿主机用户
  // 不一定同 UID，配置用 644，否则容器可能读不到挂载的 settings.yml。
  writeSettings(settingsFile, 8080, readOrCreateSecret(settingsFile), '0.0.0.0', 0o644)
  const composeFile = join(runtime, 'docker-compose.yml')
  writeFileSync(composeFile, composeYaml(port, String(process.env.EAB_SEARXNG_IMAGE ?? DEFAULT_IMAGE).trim() || DEFAULT_IMAGE), 'utf8')
  log(`使用 Docker 启动 SearXNG（端口 ${port}）`)
  await runStreaming(compose.cmd, dockerComposeArgs(compose, ['up', '-d', '--remove-orphans']), {
    cwd: runtime,
    logFile: join(runtime, 'logs', 'docker.log'),
    label: '启动 SearXNG Docker 容器',
  })
  writeJson(join(runtime, 'state.json'), {
    mode: 'docker',
    port,
    url: localUrlForPort(port),
    composeFile,
    installedAt: new Date().toISOString(),
  })
}

function stopDocker(runtime, log) {
  const composeFile = join(runtime, 'docker-compose.yml')
  if (!existsSync(composeFile)) return false
  const compose = composeAvailable()
  if (!compose) {
    log('Docker Compose 不可用，无法停止由 EAB 启动的 SearXNG 容器')
    return false
  }
  const result = spawnSync(compose.cmd, dockerComposeArgs(compose, ['down']), {
    cwd: runtime,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  })
  if (result.status !== 0) {
    log(`停止 SearXNG 容器失败：${lastLines(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)}`)
    return false
  }
  log('已停止 SearXNG Docker 容器')
  return true
}

function readRuntime(runtime) {
  return readJson(join(runtime, 'state.json'), null)
}

function runtimePath(dataDir) {
  return join(dataDir, 'searxng-runtime')
}

/**
 * 确保本机 SearXNG 可用。返回结构：
 * { ok, url, mode, installed, running, message }
 * 远程地址只检测、不在本机安装；`provider=none` 直接跳过。
 */
export async function ensureSearxng(options) {
  const log = options.log ?? ((line) => console.log(line))
  const warn = options.warn ?? ((line) => console.warn(line))
  const settingsFile = options.settingsFile
  const dataDir = options.dataDir
  const explicitPort = normalizeSearxngPort(options.port)
  const runtime = runtimePath(dataDir)
  const current = readWebSearchSettings(settingsFile)
  const envProvider = String(process.env.EAB_WEB_SEARCH_PROVIDER ?? '').trim()
  const envUrl = String(process.env.EAB_SEARXNG_URL ?? '').trim()
  const provider = envProvider || current.provider || 'auto'
  if (provider === 'none') return { ok: true, skipped: true, mode: 'none', message: '搜索已关闭，跳过 SearXNG 部署' }
  if (provider !== 'auto' && provider !== 'searxng') {
    return { ok: true, skipped: true, mode: provider, message: `已配置 ${provider}，不需要本机 SearXNG` }
  }

  let configuredUrl = ''
  try {
    configuredUrl = normalizeBaseUrl(envUrl || current.searxngUrl)
  } catch (error) {
    throw new Error(`控制台保存的 SearXNG 地址无效：${error.message}`)
  }

  if (explicitPort && configuredUrl && !isLoopbackUrl(configuredUrl)) {
    throw new Error(`当前配置的是远程 SearXNG（${configuredUrl}），不能再指定本机端口 ${explicitPort}。请先清空远程地址，或移除 --port 直接复用远程实例。`)
  }

  if (configuredUrl && !isLoopbackUrl(configuredUrl)) {
    if (await urlHealthy(configuredUrl)) {
      return { ok: true, url: configuredUrl, mode: 'external', installed: false, running: true, message: `复用远程 SearXNG：${configuredUrl}` }
    }
    return {
      ok: false,
      url: configuredUrl,
      mode: 'external',
      installed: false,
      running: false,
      message: `配置的是远程 SearXNG，但当前不可访问：${configuredUrl}。自动部署只处理 127.0.0.1/localhost。`,
    }
  }

  let explicitUrl = ''
  if (explicitPort) {
    explicitUrl = localUrlForPort(explicitPort)
    if (await urlHealthy(explicitUrl)) {
      persistWebSearch(settingsFile, explicitUrl)
      return { ok: true, url: explicitUrl, mode: 'existing', installed: false, running: true, message: `复用指定端口上已有的 SearXNG：${explicitUrl}` }
    }
    if (await portOpen(explicitPort)) {
      throw new Error(`端口 ${explicitPort} 已被其它程序占用，无法启动 SearXNG。请换一个端口，或去掉 --port 让系统自动选择空闲端口。`)
    }
  }

  if (!explicitPort && configuredUrl && (await urlHealthy(configuredUrl))) {
    if (provider === 'auto') persistWebSearch(settingsFile, configuredUrl)
    return { ok: true, url: configuredUrl, mode: 'existing', installed: false, running: true, message: `复用已有 SearXNG：${configuredUrl}` }
  }

  if (!explicitPort && !configuredUrl) {
    const fallbackUrl = localUrlForPort(DEFAULT_SEARXNG_PORT)
    if (await urlHealthy(fallbackUrl)) {
      if (provider === 'auto') persistWebSearch(settingsFile, fallbackUrl)
      return { ok: true, url: fallbackUrl, mode: 'existing', installed: false, running: true, message: `复用已有 SearXNG：${fallbackUrl}` }
    }
  }

  if (options.allowInstall === false) {
    // start 只接管已经装好的运行时，不重新下载或 pip 安装。
    const state = readRuntime(runtime)
    const nativeReady = existsSync(join(runtime, 'source', 'searx', 'webapp.py')) && existsSync(nativePython(runtime))
    const dockerReady = existsSync(join(runtime, 'docker-compose.yml'))
    if (nativeReady || dockerReady) {
      const preferred = explicitPort ?? (configuredUrl ? urlPort(configuredUrl) : state?.port ?? DEFAULT_SEARXNG_PORT)
      const port = explicitPort ?? (await chooseLocalPort(preferred))
      const url = localUrlForPort(port)
      const mode = dockerReady && (!nativeReady || state?.mode === 'docker') ? 'docker' : 'native'
      log(`启动已有 SearXNG 运行时（${mode === 'docker' ? 'Docker' : '本机 Python'}，端口 ${port}）`)
      if (mode === 'docker') await startDocker(runtime, port, log)
      else await startNative(runtime, port, log)
      if (!(await waitHealthy(url, mode === 'docker' ? 180000 : 90000))) {
        throw new Error(`已有 SearXNG 运行时启动后健康检查未通过：${url}`)
      }
      persistWebSearch(settingsFile, url)
      return { ok: true, url, mode, installed: false, running: true, message: `SearXNG 已启动：${url}` }
    }
    return { ok: false, url: configuredUrl || '', mode: 'missing', installed: false, running: false, message: '本机 SearXNG 未运行，且当前命令不允许自动安装' }
  }

  const preferredPort = explicitPort ?? (configuredUrl ? urlPort(configuredUrl) : DEFAULT_SEARXNG_PORT)
  const port = explicitPort ?? (await chooseLocalPort(preferredPort))
  const url = explicitUrl || localUrlForPort(port)
  let installed = false
  let mode = ''

  // Docker 优先：官方镜像自带主题构建产物，升级和隔离都更省心。
  if (dockerAvailable() && composeAvailable()) {
    try {
      await startDocker(runtime, port, log)
      installed = true
      mode = 'docker'
      if (!(await waitHealthy(url, 180000))) {
        warn('SearXNG Docker 容器启动超时，改用本机 Python 重试')
        stopDocker(runtime, log)
        mode = ''
      }
    } catch (error) {
      warn(`Docker 方式失败，改用本机 Python：${error.message}`)
      stopDocker(runtime, log)
    }
  }

  if (!mode) {
    const python = findPython()
    if (!python) {
      throw new Error(
        '本机没有可用的 Docker Compose，也没有 Python 3.10+，无法自动安装 SearXNG。\n' +
          '请安装 Docker Desktop / Docker Engine + Compose，或安装 Python 3.10+ 后重试；\n' +
          '也可以配置远程 EAB_SEARXNG_URL，或改用博查/Tavily/Serper 的 API Key。',
      )
    }
    log(`未使用 Docker，使用本机 Python ${python.version} 安装 SearXNG`)
    const source = await ensureNativeSource(runtime, log)
    const venvPython = ensurePythonVenv(runtime, python, log)
    await ensurePythonDeps(runtime, venvPython, source, log)
    patchWindowsCompatibility(source)
    await startNative(runtime, port, log)
    installed = true
    mode = 'native'
  }

  const healthy = await waitHealthy(url, mode === 'docker' ? 180000 : 90000)
  if (!healthy) {
    const tail = mode === 'native' ? lastLines(readFileSync(join(runtime, 'logs', 'searxng.err.log'), 'utf8')) : ''
    throw new Error(`SearXNG 已安装但健康检查未通过：${url}${tail ? `\n${tail}` : ''}`)
  }
  persistWebSearch(settingsFile, url)
  log(`SearXNG 已就绪：${url}（方式：${mode === 'docker' ? 'Docker' : '本机 Python'}）`)
  return { ok: true, url, mode, installed, running: true, message: `SearXNG 已就绪：${url}` }
}

/** 只启动已有运行时，缺运行时返回失败，不触发下载/安装。 */
export async function startSearxng(options) {
  return ensureSearxng({ ...options, allowInstall: false })
}

export async function stopSearxng(options) {
  const runtime = runtimePath(options.dataDir)
  const state = readRuntime(runtime)
  let stopped = false
  if (state?.mode === 'native' || existsSync(join(runtime, 'run', 'searx.pid.json'))) stopped = stopNative(runtime, options.log ?? console.log)
  if (state?.mode === 'docker' || existsSync(join(runtime, 'docker-compose.yml'))) stopped = stopDocker(runtime, options.log ?? console.log) || stopped
  return { stopped, runtime }
}

export async function statusSearxng(options) {
  const runtime = runtimePath(options.dataDir)
  const current = readWebSearchSettings(options.settingsFile)
  const envUrl = String(process.env.EAB_SEARXNG_URL ?? '').trim()
  const url = normalizeBaseUrl(envUrl || current.searxngUrl || DEFAULT_SEARXNG_URL)
  const healthy = await urlHealthy(url)
  const state = readRuntime(runtime)
  return { url, healthy, state, runtime, configuredProvider: current.provider || 'auto' }
}
