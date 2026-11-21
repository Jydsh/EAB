#!/usr/bin/env node
/**
 * EAB 源码更新器。
 *
 * 由 `eab update`、`eab update <版本>` 或控制台「一键更新」启动：
 * 1. 下载 Release 源码 zip；
 * 2. 校验 package.json 版本；
 * 3. 备份当前代码目录（不碰 .eab-dev 数据）；
 * 4. 替换代码并安装依赖；
 * 5. 失败自动回滚；
 * 6. 可选重启服务。
 */
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))
const DEV_DIR = process.env.EAB_HOME ? resolve(process.env.EAB_HOME) : join(ROOT_DIR, '.eab-dev')
const DB_PATH = process.env.EAB_DB ? resolve(process.env.EAB_DB) : join(DEV_DIR, 'eab.db')
const LOG_DIR = join(DEV_DIR, 'updates')
const LOG_FILE = join(LOG_DIR, 'last-update.log')
const STATUS_FILE = join(LOG_DIR, 'last-update.json')
const CODE_PATHS = [
  // 整包替换，避免新增 packages/* 目录后更新器漏拷代码。
  'packages',
  'scripts',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
  'README.md',
  'LICENSE',
  '.gitignore',
]
const REQUIRED_SOURCE_PATHS = [
  'packages/server/src/main.ts',
  'packages/server/public/chat.html',
  'packages/server/package.json',
  'packages/domain/package.json',
  'packages/storage/package.json',
  'packages/workspace/package.json',
  'scripts/eab.mjs',
  'pnpm-lock.yaml',
]
const DATA_BACKUP_FILES = [
  { source: DB_PATH, name: 'eab.db' },
  { source: `${DB_PATH}-wal`, name: 'eab.db-wal' },
  { source: `${DB_PATH}-shm`, name: 'eab.db-shm' },
  { source: join(DEV_DIR, 'secrets.json'), name: 'secrets.json' },
  { source: join(DEV_DIR, 'console-settings.json'), name: 'console-settings.json' },
  { source: join(DEV_DIR, 'admin-credentials.txt'), name: 'admin-credentials.txt' },
]
// EAB_DB 可以单独放到其他目录，凭据和设置通常跟着数据库目录走；两份都备份，避免漏掉。
for (const name of ['secrets.json', 'console-settings.json', 'admin-credentials.txt']) {
  const source = join(dirname(DB_PATH), name)
  if (source !== join(DEV_DIR, name)) DATA_BACKUP_FILES.push({ source, name: `dbdir-${name}` })
}

function log(message) {
  mkdirSync(LOG_DIR, { recursive: true })
  const line = `[${new Date().toISOString()}] ${message}`
  console.log(line)
  try {
    writeFileSync(LOG_FILE, `${line}\n`, { flag: 'a' })
  } catch {
    /* 日志失败不影响更新 */
  }
}

/** 更新状态必须在服务重启/回滚后仍可读；页面靠它区分成功、失败和已回滚。 */
function writeStatus(payload) {
  mkdirSync(LOG_DIR, { recursive: true })
  writeFileSync(STATUS_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

function argsOf(argv) {
  const flags = {}
  for (const item of argv.slice(2)) {
    if (!item.startsWith('--')) continue
    const [key, value] = item.slice(2).split('=')
    flags[key] = value ?? true
  }
  return flags
}

function readRootVersion(root) {
  const raw = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  return String(raw.version ?? '')
}

/** 拒绝只带 package.json 的不完整压缩包，避免把旧代码和旧包清单拼成混合版本。 */
function assertSourceTree(source) {
  for (const relative of REQUIRED_SOURCE_PATHS) {
    if (!existsSync(join(source, relative))) throw new Error(`源码包缺少必需文件：${relative}`)
  }
}

function normalizeDigest(value) {
  return String(value ?? '').trim().replace(/^sha256:/i, '').toLowerCase()
}

function verifyDigest(zipPath, expected) {
  const want = normalizeDigest(expected)
  if (!want) return
  if (!/^[a-f0-9]{64}$/.test(want)) throw new Error('Release 提供的 sha256 格式不正确')
  const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
  if (actual !== want) throw new Error(`源码包 sha256 不匹配：期望 ${want}，实际 ${actual}`)
  log(`源码包 sha256 校验通过：${actual}`)
}

function readChatPort() {
  const envPort = Number(process.env.EAB_PORT)
  if (Number.isInteger(envPort) && envPort > 0 && envPort <= 65535) return envPort
  try {
    const raw = JSON.parse(readFileSync(join(DEV_DIR, 'console-settings.json'), 'utf8'))
    const port = Number(raw.chatPort)
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port
  } catch {
    /* 没配置时用默认端口 */
  }
  return 8787
}

/** 服务器真正退出后再备份和替换；运行中替换会导致文件占用、半更新和数据不一致。 */
function waitPortFree(port, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs
  return new Promise((resolvePromise) => {
    const tryOnce = () => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.setTimeout(1500)
      socket.once('connect', () => {
        socket.destroy()
        if (Date.now() > end) resolvePromise(false)
        else setTimeout(tryOnce, 1000)
      })
      socket.once('timeout', () => {
        socket.destroy()
        // 超时说明无法确认端口已释放，不能当成空闲继续替换文件。
        resolvePromise(false)
      })
      socket.once('error', () => {
        socket.destroy()
        resolvePromise(true)
      })
    }
    tryOnce()
  })
}

function backupRuntimeData(backupDir) {
  const dataDir = join(backupDir, 'data')
  let copied = 0
  for (const item of DATA_BACKUP_FILES) {
    if (!existsSync(item.source)) continue
    mkdirSync(dataDir, { recursive: true })
    copyFileSync(item.source, join(dataDir, item.name))
    copied += 1
  }
  if (copied > 0) log(`运行数据已备份：${dataDir}（${copied} 个文件）`)
  return copied > 0 ? dataDir : null
}

/** 代码回滚时把数据库/配置也回到更新前快照，避免新版本迁移后的库被旧代码直接打开。 */
function restoreRuntimeData(dataDir) {
  if (!dataDir || !existsSync(dataDir)) return false
  let copied = 0
  for (const item of DATA_BACKUP_FILES) {
    const backup = join(dataDir, item.name)
    if (!existsSync(backup)) continue
    mkdirSync(dirname(item.source), { recursive: true })
    copyFileSync(backup, item.source)
    copied += 1
  }
  if (copied > 0) log(`运行数据已恢复到更新前：${dataDir}（${copied} 个文件）`)
  return copied > 0
}

/**
 * 等待新版本健康。
 * 仅比较 version 不够：旧进程如果还在运行（或热重载后已读新代码），也会返回目标版本，
 * 更新器会误以为重启成功。这里同时要求 pid 变化；老版本 health 没有 pid 时用 uptime 兜底。
 */
async function waitForHealth(port, version, timeoutMs = 45000, oldPid = 0) {
  const end = Date.now() + timeoutMs
  let last = '无响应'
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
      const body = await res.json().catch(() => null)
      const data = body?.data ?? {}
      const running = String(data.version ?? '').replace(/^v/i, '')
      const pid = Number(data.pid)
      const uptime = Number(data.uptimeSec)
      last = `v${running || '?'} pid=${Number.isInteger(pid) ? pid : '?'} uptime=${Number.isFinite(uptime) ? `${uptime}s` : '?'}`
      if (res.ok && running === version) {
        if (oldPid > 0 && Number.isInteger(pid) && pid === oldPid) {
          last = `${last}（仍是旧进程）`
        } else if (oldPid > 0 && !Number.isInteger(pid) && Number.isFinite(uptime) && uptime > 150) {
          last = `${last}（没有 pid，且进程已运行超过 150 秒）`
        } else {
          return { ok: true, pid: Number.isInteger(pid) ? pid : null, uptime: Number.isFinite(uptime) ? uptime : null, detail: last }
        }
      }
    } catch {
      /* 新进程还没起来 */
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000))
  }
  log(`健康检查超时：期望 v${version}，最后状态 ${last}`)
  return { ok: false, pid: null, uptime: null, detail: last }
}

function extractZip(zipPath, dest) {
  mkdirSync(dest, { recursive: true })
  if (process.platform === 'win32') {
    const ps = [
      `$ErrorActionPreference='Stop'`,
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
    ].join('; ')
    const result = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || 'Expand-Archive 失败')
    return
  }
  const result = spawnSync('unzip', ['-q', zipPath, '-d', dest], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || 'unzip 失败')
}

function sourceRoot(extracted) {
  const entries = readdirSync(extracted, { withFileTypes: true }).filter((item) => item.isDirectory())
  for (const entry of entries) {
    const candidate = join(extracted, entry.name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  if (existsSync(join(extracted, 'package.json'))) return extracted
  throw new Error('源码压缩包里没有 package.json')
}

function backupCode(root, backupDir) {
  for (const relative of CODE_PATHS) {
    const source = join(root, relative)
    if (!existsSync(source)) continue
    const target = join(backupDir, relative)
    mkdirSync(resolve(target, '..'), { recursive: true })
    cpSync(source, target, { recursive: true })
  }
}

function replaceCode(root, source, backupDir) {
  for (const relative of CODE_PATHS) {
    const from = join(source, relative)
    if (!existsSync(from)) continue
    const to = join(root, relative)
    if (existsSync(to)) rmSync(to, { recursive: true, force: true })
    mkdirSync(resolve(to, '..'), { recursive: true })
    cpSync(from, to, { recursive: true })
  }
}

function restoreCode(root, backupDir) {
  for (const relative of CODE_PATHS) {
    const from = join(backupDir, relative)
    if (!existsSync(from)) continue
    const to = join(root, relative)
    if (existsSync(to)) rmSync(to, { recursive: true, force: true })
    cpSync(from, to, { recursive: true })
  }
}

function runPnpm(root) {
  return new Promise((resolvePromise, reject) => {
    const result = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
      cwd: root,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env },
    })
    if (result.error) reject(result.error)
    else if (result.status !== 0) reject(new Error(`pnpm install 退出码 ${result.status}`))
    else resolvePromise()
  })
}

/**
 * 启动新版本服务。
 *
 * 这里不用 `eab server --background`，而用 `eab restart --background`：
 * - restart 会先按端口强制停掉可能还残留的旧进程，再启动；
 * - 只有端口真正释放后才继续，避免新进程绑定失败却因为旧服务健康而被误判成功。
 */
function startServer(root, version) {
  const script = join(root, 'scripts', 'eab.mjs')
  const env = { ...process.env }
  // 新版本以刚替换的 package.json 为准；继承旧进程的 EAB_VERSION 会让 /api/health
  // 永远报旧版本，更新器健康检查失败后又回滚，看起来就像“升级成功但没有重启”。
  if (env.EAB_VERSION) {
    log(`忽略旧进程注入的 EAB_VERSION=${env.EAB_VERSION}，重启后按 package.json 读取版本`)
    delete env.EAB_VERSION
  }
  env.EAB_UPDATE_RESTART = new Date().toISOString()
  const child = spawn(process.execPath, [script, 'restart', '--background'], {
    cwd: root,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.once('error', (error) => log(`启动新服务失败：${error.message}`))
  child.unref()
  return child.pid ?? null
}

function stopServer(root) {
  const script = join(root, 'scripts', 'eab.mjs')
  const result = spawnSync(process.execPath, [script, 'stop'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
  })
  if (result.status !== 0) log(`停止新进程失败：${result.stderr || result.status}`)
  return result.status === 0
}

async function main() {
  const flags = argsOf(process.argv)
  const apply = flags.apply === true || flags.apply === '1'
  if (!apply) {
    console.log('用法：node scripts/eab-update.mjs --apply --url=<源码zip> --version=<版本> --root=<项目根> [--sha256=<摘要>] [--restart=1]')
    return
  }
  const root = resolve(String(flags.root ?? process.cwd()))
  const version = String(flags.version ?? '').replace(/^v/i, '')
  const url = String(flags.url ?? '')
  const expectedDigest = String(flags.sha256 ?? '')
  const oldPid = Number(flags['old-pid'] ?? 0)
  const restart = flags.restart === '1' || flags.restart === true
  if (!/^https:\/\/(github\.com|api\.github\.com|codeload\.github\.com)\//i.test(url)) {
    throw new Error('只允许从 GitHub 下载更新包')
  }
  if (!version) throw new Error('缺少 --version')
  if (!existsSync(join(root, 'package.json'))) throw new Error(`项目根目录不存在：${root}`)

  const previousVersion = readRootVersion(root)
  const startedAt = new Date().toISOString()
  const chatPort = readChatPort()
  mkdirSync(LOG_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const workDir = join(LOG_DIR, `download-${stamp}`)
  const zipPath = join(workDir, 'release.zip')
  const extracted = join(workDir, 'extracted')
  const backupDir = join(LOG_DIR, `backup-${stamp}`)
  mkdirSync(workDir, { recursive: true })
  let backupReady = false
  let dataBackupDir = null
  let rollbackOk = null

  log(`开始更新：v${version}（当前 v${previousVersion}），项目根 ${root}`)
  writeStatus({
    status: 'running',
    ok: null,
    version,
    previousVersion,
    startedAt,
    finishedAt: null,
    at: startedAt,
    error: null,
    healthDetail: null,
    rolledBack: null,
    root,
    backupDir: null,
    dataBackupDir: null,
    pid: null,
    updaterPid: process.pid,
    sourceUrl: url,
    sourceDigest: expectedDigest || null,
  })
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) })
    if (!res.ok) throw new Error(`下载源码包失败：HTTP ${res.status}`)
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()))
    log(`源码包已下载：${zipPath}`)
    verifyDigest(zipPath, expectedDigest)
    extractZip(zipPath, extracted)
    const source = sourceRoot(extracted)
    assertSourceTree(source)
    const found = readRootVersion(source)
    if (found !== version) throw new Error(`源码包版本是 ${found}，不是 ${version}`)
    log(`源码包校验通过：v${found}`)
    log(`等待旧服务退出（端口 ${chatPort}）`)
    let free = await waitPortFree(chatPort)
    if (!free) {
      log(`旧服务在 30 秒内没有释放端口 ${chatPort}，尝试强制停止旧进程`)
      stopServer(root)
      free = await waitPortFree(chatPort, 10000)
      if (!free) throw new Error(`旧服务仍未释放端口 ${chatPort}，为避免文件占用已中止更新`)
      log('旧服务已强制停止')
    }
    backupCode(root, backupDir)
    backupReady = true
    log(`旧代码已备份：${backupDir}`)
    dataBackupDir = backupRuntimeData(backupDir)
    replaceCode(root, source, backupDir)
    log('代码已替换，开始安装依赖')
    await runPnpm(root)
    log('依赖安装完成')
    let health = restart ? { ok: false, pid: null, uptime: null, detail: '尚未启动' } : { ok: true, pid: null, uptime: null, detail: '未要求重启' }
    if (restart) {
      const firstPid = startServer(root, version)
      log(`已发出重启命令：eab restart --background${firstPid ? `（重启命令 pid ${firstPid}）` : ''}`)
      health = await waitForHealth(chatPort, version, 45000, oldPid)
      if (!health.ok) {
        // 第一次可能是端口/后台进程的瞬时失败；再做一次真正的 restart，避免直接回滚。
        log(`v${version} 首次重启未恢复健康（${health.detail}），再执行一次重启兜底`)
        stopServer(root)
        await waitPortFree(chatPort, 10000)
        const retryPid = startServer(root, version)
        log(`已发出重启兜底命令：eab restart --background${retryPid ? `（重启命令 pid ${retryPid}）` : ''}`)
        health = await waitForHealth(chatPort, version, 20000, oldPid)
      }
      if (!health.ok) {
        log(`v${version} 未恢复健康（${health.detail}），开始回滚到 v${previousVersion}`)
        stopServer(root)
        const rollbackPortFree = await waitPortFree(chatPort)
        if (!rollbackPortFree) {
          log(`服务仍占用端口 ${chatPort}，跳过自动回滚，避免覆盖运行中的数据库`)
          rollbackOk = false
        } else {
          if (backupReady) restoreCode(root, backupDir)
          restoreRuntimeData(dataBackupDir)
          await runPnpm(root)
          startServer(root, previousVersion)
          const rollbackHealth = await waitForHealth(chatPort, previousVersion, 30000, oldPid)
          rollbackOk = rollbackHealth.ok
          log(
            rollbackOk
              ? `已回滚并恢复 v${previousVersion}（${rollbackHealth.detail}）`
              : `回滚后旧版本仍未恢复健康（${rollbackHealth.detail}）`,
          )
        }
      }
    }
    const ok = restart ? health.ok : true
    const finishedAt = new Date().toISOString()
    const status = ok ? 'succeeded' : rollbackOk === true ? 'rolled_back' : 'failed'
    log(ok ? `更新完成：v${version}（${health.detail}）` : `更新失败：v${version} 未恢复健康（${health.detail}）`)
    writeStatus({
      status,
      ok,
      version,
      previousVersion,
      startedAt,
      finishedAt,
      at: finishedAt,
      error: ok ? null : `新版本 v${version} 未恢复健康：${health.detail}`,
      health: health.ok,
      healthDetail: health.detail,
      pid: health.pid,
      uptimeSec: health.uptime,
      rolledBack: rollbackOk === true,
      rollbackHealth: rollbackOk,
      root,
      backupDir: backupReady ? backupDir : null,
      dataBackupDir,
    })
    if (!ok) process.exitCode = 1
  } catch (error) {
    log(`更新失败：${error.message}；开始回滚`)
    try {
      if (backupReady) {
        restoreCode(root, backupDir)
        restoreRuntimeData(dataBackupDir)
        await runPnpm(root)
        rollbackOk = true
        log('已回滚代码并恢复依赖')
      }
      // 控制台点击更新后旧服务会被先关掉；即使失败发生在下载/校验阶段，
      // 也必须把上一版本重新拉起来，不能把用户留在“服务已停”的状态。
      if (restart) {
        startServer(root, previousVersion)
        const restartHealth = await waitForHealth(chatPort, previousVersion, 30000, oldPid)
        rollbackOk = restartHealth.ok
        log(
          restartHealth.ok
            ? `旧服务已重新启动并恢复健康（${restartHealth.detail}）`
            : `旧服务重新启动后未恢复健康（${restartHealth.detail}）`,
        )
      }
    } catch (rollbackError) {
      log(`回滚失败：${rollbackError.message}`)
    }
    const finishedAt = new Date().toISOString()
    writeStatus({
      status: backupReady && rollbackOk === true ? 'rolled_back' : 'failed',
      ok: false,
      version,
      previousVersion,
      startedAt,
      finishedAt,
      at: finishedAt,
      error: error.message,
      health: null,
      healthDetail: null,
      pid: null,
      uptimeSec: null,
      rolledBack: backupReady && rollbackOk === true,
      restarted: restart ? rollbackOk === true : null,
      rollbackHealth: rollbackOk,
      root,
      backupDir: backupReady ? backupDir : null,
      dataBackupDir,
    })
    process.exitCode = 1
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* 临时目录清理失败不影响结果 */
    }
  }
}

main().catch((error) => {
  log(`更新器异常：${error.message}`)
  process.exitCode = 1
})
