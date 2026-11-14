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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))
const DEV_DIR = process.env.EAB_HOME ? resolve(process.env.EAB_HOME) : join(ROOT_DIR, '.eab-dev')
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
  if (entries.length === 1) {
    const candidate = join(extracted, entries[0].name)
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
    const result = spawnSync('pnpm', ['install'], {
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
        resolvePromise(true)
      })
      socket.once('error', () => {
        socket.destroy()
        resolvePromise(true)
      })
    }
    tryOnce()
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

async function main() {
  const flags = argsOf(process.argv)
  const apply = flags.apply === true || flags.apply === '1'
  if (!apply) {
    console.log('用法：node scripts/eab-update.mjs --apply --url=<源码zip> --version=<版本> --root=<项目根> [--restart=1]')
    return
  }
  const root = resolve(String(flags.root ?? process.cwd()))
  const version = String(flags.version ?? '').replace(/^v/i, '')
  const url = String(flags.url ?? '')
  const restart = flags.restart === '1' || flags.restart === true
  if (!/^https:\/\/(github\.com|api\.github\.com|codeload\.github\.com)\//i.test(url)) {
    throw new Error('只允许从 GitHub 下载更新包')
  }
  if (!version) throw new Error('缺少 --version')
  if (!existsSync(join(root, 'package.json'))) throw new Error(`项目根目录不存在：${root}`)

  mkdirSync(LOG_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const workDir = join(LOG_DIR, `download-${stamp}`)
  const zipPath = join(workDir, 'release.zip')
  const extracted = join(workDir, 'extracted')
  const backupDir = join(LOG_DIR, `backup-${stamp}`)
  mkdirSync(workDir, { recursive: true })

  log(`开始更新：v${version}，项目根 ${root}`)
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) })
    if (!res.ok) throw new Error(`下载源码包失败：HTTP ${res.status}`)
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()))
    log(`源码包已下载：${zipPath}`)
    extractZip(zipPath, extracted)
    const source = sourceRoot(extracted)
    const found = readRootVersion(source)
    if (found !== version) throw new Error(`源码包版本是 ${found}，不是 ${version}`)
    log(`源码包校验通过：v${found}`)
    backupCode(root, backupDir)
    log(`旧代码已备份：${backupDir}`)
    replaceCode(root, source, backupDir)
    log('代码已替换，开始安装依赖')
    await runPnpm(root)
    log('依赖安装完成')
    if (restart) {
      log('等待旧服务退出')
      const free = await waitPortFree(8787)
      if (!free) log('端口 8787 仍被占用，跳过自动重启；请手动执行 eab start')
      else {
        startServer(root)
        log('已发出重启命令：eab start --background')
      }
    }
    log(`更新完成：v${version}`)
    writeFileSync(
      join(LOG_DIR, 'last-update.json'),
      `${JSON.stringify({ version, at: new Date().toISOString(), ok: true, root }, null, 2)}\n`,
      'utf8',
    )
  } catch (error) {
    log(`更新失败：${error.message}；开始回滚`)
    try {
      restoreCode(root, backupDir)
      await runPnpm(root)
      log('已回滚代码并恢复依赖')
    } catch (rollbackError) {
      log(`回滚失败：${rollbackError.message}`)
    }
    writeFileSync(
      join(LOG_DIR, 'last-update.json'),
      `${JSON.stringify({ version, at: new Date().toISOString(), ok: false, error: error.message, root }, null, 2)}\n`,
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
