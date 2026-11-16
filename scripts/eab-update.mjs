#!/usr/bin/env node
/**
 * EAB 源码更新器。
 *
 * 由 `eab update --apply` 或控制台「一键更新」启动：
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
        resolvePromise(Date.now() > end ? false : true)
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

async function waitForHealth(port, version, timeoutMs = 45000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
      const body = await res.json().catch(() => null)
      if (res.ok && String(body?.data?.version ?? '') === version) return true
    } catch {
      /* 新进程还没起来 */
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000))
  }
  return false
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

function startServer(root) {
  const script = join(root, 'scripts', 'eab.mjs')
  const child = spawn(process.execPath, [script, 'server', '--background'], {
    cwd: root,
    env: { ...process.env },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

function stopServer(root) {
  const script = join(root, 'scripts', 'eab.mjs')
  const result = spawnSync(process.execPath, [script, 'stop'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
  })
  if (result.status !== 0) log(`停止新进程失败：${result.stderr || result.status}`)
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
  const restart = flags.restart === '1' || flags.restart === true
  if (!/^https:\/\/(github\.com|api\.github\.com|codeload\.github\.com)\//i.test(url)) {
    throw new Error('只允许从 GitHub 下载更新包')
  }
  if (!version) throw new Error('缺少 --version')
  if (!existsSync(join(root, 'package.json'))) throw new Error(`项目根目录不存在：${root}`)

  const previousVersion = readRootVersion(root)
  const chatPort = readChatPort()
  mkdirSync(LOG_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const workDir = join(LOG_DIR, `download-${stamp}`)
  const zipPath = join(workDir, 'release.zip')
  const extracted = join(workDir, 'extracted')
  const backupDir = join(LOG_DIR, `backup-${stamp}`)
  mkdirSync(workDir, { recursive: true })
  let backupReady = false
  let serviceStopped = false
  let dataBackupDir = null
  let rollbackOk = null

  log(`开始更新：v${version}（当前 v${previousVersion}），项目根 ${root}`)
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
    const free = await waitPortFree(chatPort)
    if (!free) throw new Error(`旧服务在 30 秒内没有释放端口 ${chatPort}，为避免文件占用已中止更新`)
    serviceStopped = true
    backupCode(root, backupDir)
    backupReady = true
    log(`旧代码已备份：${backupDir}`)
    dataBackupDir = backupRuntimeData(backupDir)
    replaceCode(root, source, backupDir)
    log('代码已替换，开始安装依赖')
    await runPnpm(root)
    log('依赖安装完成')
    let healthOk = restart ? false : null
    if (restart) {
      startServer(root)
      log('已发出重启命令：eab start --background')
      healthOk = await waitForHealth(chatPort, version)
      if (!healthOk) {
        log(`v${version} 未在 45 秒内恢复健康，开始回滚到 v${previousVersion}`)
        stopServer(root)
        const rollbackPortFree = await waitPortFree(chatPort)
        if (!rollbackPortFree) {
          log(`服务仍占用端口 ${chatPort}，跳过自动回滚，避免覆盖运行中的数据库`)
          rollbackOk = false
        } else {
          if (backupReady) restoreCode(root, backupDir)
          restoreRuntimeData(dataBackupDir)
          await runPnpm(root)
          startServer(root)
          rollbackOk = await waitForHealth(chatPort, previousVersion)
          log(rollbackOk ? `已回滚并恢复 v${previousVersion}` : '回滚后旧版本仍未恢复健康')
        }
      }
    }
    const ok = restart ? Boolean(healthOk) : true
    log(ok ? `更新完成：v${version}` : `更新失败：v${version} 未恢复健康`)
    writeFileSync(
      join(LOG_DIR, 'last-update.json'),
      `${JSON.stringify({
        version,
        previousVersion,
        at: new Date().toISOString(),
        ok,
        health: healthOk,
        rolledBack: rollbackOk === true,
        rollbackHealth: rollbackOk,
        root,
        backupDir: backupReady ? backupDir : null,
        dataBackupDir,
      }, null, 2)}\n`,
      'utf8',
    )
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
      if (serviceStopped && restart) {
        startServer(root)
        log('旧服务已重新启动')
      }
    } catch (rollbackError) {
      log(`回滚失败：${rollbackError.message}`)
    }
    writeFileSync(
      join(LOG_DIR, 'last-update.json'),
      `${JSON.stringify({
        version,
        previousVersion,
        at: new Date().toISOString(),
        ok: false,
        health: null,
        rolledBack: rollbackOk === true,
        rollbackHealth: rollbackOk,
        error: error.message,
        root,
        backupDir: backupReady ? backupDir : null,
        dataBackupDir,
      }, null, 2)}\n`,
      'utf8',
    )
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
