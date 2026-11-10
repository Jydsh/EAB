#!/usr/bin/env node
/**
 * EAB 运维 CLI（CLI-01 ~ CLI-05 的可执行部分）。
 *
 * 只做两件事：读本地部署文件 + 调运行中服务的控制台接口。
 * 不直接改数据库，避免绕过审计与校验；恢复数据库必须停服务并显式 --yes。
 *
 * 用法：node scripts/eab.mjs <command> [...]
 *   init                 检查目录与凭据，打印下一步
 *   doctor               健康 / 库 / 密钥 / 备份 / 端口 一键诊断
 *   backup               生成 SQLite 快照
 *   restore <file> --yes 停服务后替换数据库（危险）
 *   audit verify         校验审计哈希链
 *   audit export         导出 audit.csv 到 .eab-dev/exports
 *   user create          新建成员（参数见 --help）
 *   plugin list          列出插件
 *   serve                在前台启动服务（pnpm dev）
 */
import { existsSync, readFileSync, mkdirSync, copyFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DEV_DIR = process.env.EAB_HOME ? resolve(process.env.EAB_HOME) : join(ROOT, '.eab-dev')
const SETTINGS_FILE = join(DEV_DIR, 'console-settings.json')

function readNetworkSettings() {
  const defaults = { host: '127.0.0.1', chatPort: 8787, adminPort: 8788 }
  try {
    if (!existsSync(SETTINGS_FILE)) return defaults
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    const port = (value, fallback) => (Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 65535 ? Number(value) : fallback)
    return {
      host: typeof raw.host === 'string' && raw.host.trim() ? raw.host.trim() : defaults.host,
      chatPort: port(raw.chatPort, defaults.chatPort),
      adminPort: port(raw.adminPort, defaults.adminPort),
    }
  } catch {
    return defaults
  }
}

function chatBaseUrl() {
  return process.env.EAB_BASE_URL || `http://127.0.0.1:${readNetworkSettings().chatPort}`
}

function consoleBaseUrl() {
  return process.env.EAB_CONSOLE_BASE_URL || `http://127.0.0.1:${readNetworkSettings().adminPort}`
}

function readCredentials() {
  const file = join(DEV_DIR, 'admin-credentials.txt')
  if (!existsSync(file)) throw new Error('缺少 .eab-dev/admin-credentials.txt，先执行 pnpm dev 让服务初始化')
  const out = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^(username|password)=(.+)$/)
    if (match) out[match[1]] = match[2]
  }
  return out
}

async function login() {
  const cred = readCredentials()
  const res = await fetch(`${consoleBaseUrl()}/api/console/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cred),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.ok) throw new Error(`控制台登录失败：${body?.message ?? res.status}`)
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0]
  return { cookie, 'x-eab-console': '1' }
}

async function api(path, headers, options = {}) {
  const res = await fetch(`${consoleBaseUrl()}${path}`, { ...options, headers: { ...headers, 'content-type': 'application/json' } })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: res.ok, text }
  }
  if (!res.ok || body?.ok === false) throw new Error(`${path} 失败：${body?.message ?? res.status}`)
  return body.data
}

function argsOf(argv, start) {
  const flags = {}
  const positional = []
  for (const item of argv.slice(start)) {
    if (item.startsWith('--')) {
      const [key, value] = item.slice(2).split('=')
      flags[key] = value ?? true
    } else positional.push(item)
  }
  return { flags, positional }
}

async function doctor() {
  const checks = []
  const add = (name, ok, detail, fix = '') => checks.push({ name, ok, detail, fix })
  try {
    const res = await fetch(`${chatBaseUrl()}/api/health`)
    const body = await res.json()
    add('服务', res.ok, `${chatBaseUrl()} · v${body?.data?.version}`, '启动：eab server')
  } catch {
    add('服务', false, '连不上', '在另一个终端执行 pnpm dev')
  }
  for (const [name, path, optional] of [
    ['数据库', join(DEV_DIR, 'eab.db'), false],
    ['控制台凭据', join(DEV_DIR, 'admin-credentials.txt'), false],
    ['密钥文件', join(DEV_DIR, 'secrets.json'), true],
    ['插件目录', join(ROOT, 'plugins', 'catalog.json'), false],
  ]) {
    add(name, existsSync(path) || optional, existsSync(path) ? path : `${path}（可选，配置模型密钥后生成）`, '让服务初始化/检查部署目录')
  }
  try {
    const headers = await login()
    const verify = await api('/api/console/audit/verify', headers)
    add('审计链', verify.ok, `${verify.checked} 条`, '运行 node scripts/eab.mjs audit verify')
    const backups = await api('/api/console/backups', headers)
    add('备份', backups.items.length > 0, `${backups.items.length} 个快照`, 'node scripts/eab.mjs backup')
  } catch (error) {
    add('控制台接口', false, error.message, '确认服务已启动且本机可访问')
  }
  console.log('\nEAB doctor\n')
  for (const item of checks) console.log(`${item.ok ? 'OK  ' : 'FAIL'} ${item.name.padEnd(8)} ${item.detail}`)
  const failed = checks.filter((item) => !item.ok)
  if (failed.length) {
    console.log('\n修复建议：')
    for (const item of failed) console.log(`- ${item.name}: ${item.fix}`)
  } else {
    console.log('\n全部通过。')
  }
  process.exitCode = failed.length ? 1 : 0
}

async function backup() {
  const headers = await login()
  const result = await api('/api/console/backups', headers, { method: 'POST', body: '{}' })
  console.log(`备份完成：${result.file}（${(result.size / 1024 / 1024).toFixed(2)} MB）`)
}

function stopService() {
  const { chatPort, adminPort } = readNetworkSettings()
  const ports = [chatPort, adminPort]
  if (process.platform === 'win32') {
    return new Promise((resolvePromise, reject) => {
      const script = [
        `$ErrorActionPreference='SilentlyContinue'`,
        `$stopped=@()`,
        ...ports.map(
          (port) =>
            `$conns=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; foreach ($c in $conns) { if ($c.OwningProcess) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue; $stopped += ${port} } }`,
        ),
        `if ($stopped.Count -gt 0) { 'STOPPED:' + ($stopped -join ',') } else { 'NOT_RUNNING' }`,
        `exit 0`,
      ].join('; ')
      const ps = spawn('powershell', ['-NoProfile', '-Command', script])
      let out = ''
      ps.stdout.on('data', (chunk) => (out += chunk))
      ps.on('close', (code) => (code === 0 ? resolvePromise(out.trim()) : reject(new Error(`停止服务失败 ${code}`))))
    })
  }
  for (const port of ports) {
    const pids = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' })
    for (const pid of String(pids.stdout ?? '').split(/\s+/).filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGTERM')
      } catch {
        /* 进程可能已退出 */
      }
    }
  }
  return Promise.resolve('STOPPED')
}

function parsePort(value, label) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label}必须是 1–65535 的整数`)
  return port
}

function serverEnv(flags = {}) {
  const network = readNetworkSettings()
  const env = { ...process.env }
  if (flags.host !== undefined) env.EAB_HOST = String(flags.host)
  if (flags['chat-port'] !== undefined) env.EAB_PORT = String(parsePort(flags['chat-port'], '员工对话端口'))
  if (flags['admin-port'] !== undefined) env.EAB_ADMIN_PORT = String(parsePort(flags['admin-port'], '管理控制台端口'))
  if (flags['allow-remote'] === true || flags['allow-remote'] === '1') env.EAB_CONSOLE_ALLOW_REMOTE = '1'
  if (flags['allow-remote'] === false || flags['allow-remote'] === '0') env.EAB_CONSOLE_ALLOW_REMOTE = '0'
  // 没有显式传参时不要写 EAB_HOST/PORT：让服务读控制台保存的网络设置。
  return { env, network }
}

async function waitForHealth(port, timeoutMs = 25000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }
  return false
}

async function server(flags) {
  const { env, network } = serverEnv(flags)
  const effective = {
    host: flags.host !== undefined ? String(flags.host) : network.host,
    chatPort: flags['chat-port'] !== undefined ? parsePort(flags['chat-port'], '员工对话端口') : network.chatPort,
    adminPort: flags['admin-port'] !== undefined ? parsePort(flags['admin-port'], '管理控制台端口') : network.adminPort,
  }
  const script = fileURLToPath(import.meta.url)
  const background = flags.background === true || flags.background === '1'
  if (background) {
    if (process.platform === 'win32') {
      // `start /b` 让进程脱离当前终端；直接 detached spawn 会被任务/终端退出连带回收。
      const child = spawn('cmd.exe', ['/c', 'start', '', '/b', process.execPath, script, 'server'], {
        cwd: ROOT,
        env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
    } else {
      const child = spawn(process.execPath, [script, 'server'], {
        cwd: ROOT,
        env,
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
    }
    const ok = await waitForHealth(effective.chatPort)
    console.log(ok ? `EAB 服务已在后台启动：http://127.0.0.1:${effective.chatPort}/chat` : '后台启动已发出，但 25 秒内没有等到健康检查；查看日志确认。')
    if (!ok) process.exitCode = 1
    return
  }
  console.log(`启动 EAB 服务：员工端 ${effective.chatPort} · 控制台 ${effective.adminPort}（地址 ${effective.host}）`)
  const child = spawn('pnpm', ['--filter', '@eab/server', 'dev'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    env,
  })
  child.on('exit', (code) => process.exit(code ?? 0))
}

async function latestRelease() {
  const repo = (process.env.EAB_UPDATE_REPO ?? 'Jydsh/EAB').trim() || 'Jydsh/EAB'
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'EAB-CLI' }
  if (process.env.EAB_GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.EAB_GITHUB_TOKEN}`
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers,
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`读取 GitHub Release 失败：HTTP ${res.status}`)
  const body = await res.json()
  const latest = String(body.tag_name ?? '').replace(/^v/i, '')
  if (!latest) throw new Error('Release 没有版本号')
  const sourceAsset = (body.assets ?? []).find((item) => /\.zip$/i.test(item.name ?? '') && !/blockmap/i.test(item.name ?? ''))
  return { latest, sourceUrl: sourceAsset?.browser_download_url ?? body.zipball_url, htmlUrl: body.html_url }
}

function isNewer(current, latest) {
  const a = current.split('.').map(Number)
  const b = latest.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((b[i] ?? 0) > (a[i] ?? 0)) return true
    if ((b[i] ?? 0) < (a[i] ?? 0)) return false
  }
  return false
}

async function update(flags) {
  const current = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const release = await latestRelease()
  const hasUpdate = isNewer(current, release.latest)
  console.log(`当前版本：v${current}`)
  console.log(`最新版本：v${release.latest}${hasUpdate ? '（有新版本）' : '（已是最新）'}`)
  if (release.htmlUrl) console.log(`Release：${release.htmlUrl}`)
  if (!flags.apply || flags.apply !== true) {
    console.log(hasUpdate ? '\n确认更新：eab update --apply' : '\n无需更新。')
    return
  }
  if (!hasUpdate) return
  if (!release.sourceUrl) throw new Error('该 Release 没有源码压缩包，无法更新')
  console.log('正在停止服务并执行更新…')
  await stopService()
  const code = await new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [
        join(ROOT, 'scripts', 'eab-update.mjs'),
        '--apply',
        `--url=${release.sourceUrl}`,
        `--version=${release.latest}`,
        `--root=${ROOT}`,
        '--restart=1',
      ],
      { cwd: ROOT, stdio: 'inherit', env: { ...process.env } },
    )
    child.on('exit', (value) => resolvePromise(value ?? 1))
  })
  process.exitCode = code
}

function installCli() {
  const script = fileURLToPath(import.meta.url)
  if (process.platform === 'win32') {
    const binDir = join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || ROOT, 'AppData', 'Local'), 'EAB', 'bin')
    mkdirSync(binDir, { recursive: true })
    const cmd = join(binDir, 'eab.cmd')
    writeFileSync(cmd, `@echo off\r\nnode "${script}" %*\r\n`, 'ascii')
    const ps = [
      `$bin = '${binDir.replace(/'/g, "''")}'`,
      `$p = [Environment]::GetEnvironmentVariable('Path','User')`,
      `if (($p -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + $bin), 'User') }`,
    ].join('; ')
    const result = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || '写入用户 PATH 失败')
    console.log(`已安装 eab 命令：${cmd}`)
    console.log(`已把 ${binDir} 加入用户 PATH；新开终端后执行：eab server`)
    return
  }
  const home = process.env.HOME || '~'
  const binDir = join(home, '.local', 'bin')
  mkdirSync(binDir, { recursive: true })
  const target = join(binDir, 'eab')
  try {
    if (existsSync(target)) spawnSync('rm', ['-f', target])
    spawnSync('ln', ['-s', script, target])
    spawnSync('chmod', ['+x', script])
  } catch (error) {
    throw new Error(`创建 ${target} 失败：${error.message}`)
  }
  console.log(`已创建：${target} → ${script}`)
  console.log(`确认 ${binDir} 在 PATH 中后，执行：eab server`)
}

async function restore(file) {
  if (!file) throw new Error('用法：node scripts/eab.mjs restore <备份文件> --yes')
  const target = resolve(file)
  if (!existsSync(target)) throw new Error(`备份文件不存在：${target}`)
  const db = join(DEV_DIR, 'eab.db')
  if (!existsSync(db)) throw new Error(`当前数据库不存在：${db}`)
  const stopped = await stopService()
  const safety = `${db}.before-restore-${Date.now()}`
  copyFileSync(db, safety)
  copyFileSync(target, db)
  console.log(`服务：${stopped}`)
  console.log(`当前库已先备份到：${safety}`)
  console.log(`已恢复：${target} → ${db}`)
  console.log('现在重新启动：pnpm dev')
}

async function audit(sub) {
  const headers = await login()
  if (sub === 'verify') {
    const result = await api('/api/console/audit/verify', headers)
    console.log(result.ok ? `审计链完整，共 ${result.checked} 条。` : `审计链断裂于 #${result.brokenAt}`)
    if (!result.ok) {
      for (const reason of result.reasons) console.log(`- ${reason}`)
      process.exitCode = 1
    }
    return
  }
  if (sub === 'export') {
    const res = await fetch(`${consoleBaseUrl()}/api/console/audit/export?format=csv`, { headers })
    if (!res.ok) throw new Error(`导出失败 ${res.status}`)
    const dir = join(DEV_DIR, 'exports')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = join(dir, `audit-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    console.log(`已导出：${file}`)
    return
  }
  throw new Error('用法：audit verify | audit export')
}

async function userCreate(args) {
  const headers = await login()
  const name = args.name
  const deptId = args.dept || args['dept-id']
  const password = args.password
  if (!name || !deptId || !password) {
    throw new Error('用法：user create --name=张三 --dept=d10 --password=至少8位 [--no=U_ZS] [--roles=member]')
  }
  const roles = args.roles ? String(args.roles).split(',') : ['member']
  const result = await api('/api/console/members', headers, {
    method: 'POST',
    body: JSON.stringify({ name, deptId, employeeNo: args.no, password, roles }),
  })
  console.log(`成员已创建：${result.id} · ${result.name} · 工号 ${result.employeeNo}`)
  console.log('让他到 /chat 用工号 + 密码登录。')
}

async function pluginList() {
  const headers = await login()
  const data = await api('/api/console/plugins', headers)
  for (const plugin of data.plugins) {
    console.log(`${plugin.enabled ? '启用' : '停用'}  ${plugin.id}  v${plugin.version ?? '—'}  ${plugin.name}`)
  }
  if (data.plugins.length === 0) console.log('没有安装插件。到控制台「插件」页安装。')
}

function init() {
  if (!existsSync(DEV_DIR)) mkdirSync(DEV_DIR, { recursive: true })
  const hasCred = existsSync(join(DEV_DIR, 'admin-credentials.txt'))
  console.log(`EAB 目录：${ROOT}`)
  console.log(`部署目录：${DEV_DIR}`)
  console.log(hasCred ? '控制台凭据已存在（重复执行不会覆盖）。' : '还没有控制台凭据；执行 eab server 首次生成。')
  console.log('\n下一步：')
  console.log('1. pnpm install')
  console.log('2. pnpm typecheck && pnpm test')
  console.log('3. eab server（或 node scripts/eab.mjs server）')
  console.log('4. 浏览器打开 http://127.0.0.1:8788/admin 用 admin 登录')
  console.log('5. 员工打开 http://127.0.0.1:8787/chat 用工号+密码登录')
  const accounts = join(DEV_DIR, 'demo-accounts.txt')
  if (existsSync(accounts)) console.log(`\n演示员工账号：${accounts}`)
  const backups = join(DEV_DIR, 'backups')
  if (existsSync(backups)) console.log(`备份目录：${backups}（${readdirSync(backups).length} 个）`)
}

function version() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  console.log(`EAB CLI v${pkg.version}`)
}

function help() {
  console.log(`EAB CLI
  eab -v, --version    显示当前版本
  eab -h, --help       显示帮助
  eab server [--background] [--host=0.0.0.0] [--chat-port=8787] [--admin-port=8788]
  eab stop
  eab update [--apply]
  eab install-cli
  eab init
  eab doctor
  eab backup
  eab restore <file> --yes
  eab audit verify
  eab audit export
  eab user create --name=张三 --dept=d10 --password=Eab@2026demo --no=U_ZS --roles=member
  eab plugin list

也可以直接执行：node scripts/eab.mjs <command>
`)
}

const [command, sub, ...rest] = process.argv.slice(2)
const { flags } = argsOf(process.argv, 3)
try {
  if (!command || command === 'help' || command === '--help' || command === '-h') help()
  else if (command === 'version' || command === '-v' || command === '--version') version()
  else if (command === 'init') init()
  else if (command === 'doctor') await doctor()
  else if (command === 'backup') await backup()
  else if (command === 'restore') {
    if (!flags.yes) throw new Error('恢复会覆盖当前数据库，确认后加 --yes')
    await restore(sub)
  } else if (command === 'audit') await audit(sub)
  else if (command === 'user') {
    if (sub !== 'create') throw new Error('用法：user create ...')
    await userCreate(flags)
  } else if (command === 'plugin') {
    if (sub !== 'list') throw new Error('用法：plugin list')
    await pluginList()
  } else if (command === 'server' || command === 'serve') {
    await server(flags)
  } else if (command === 'stop') {
    console.log(`服务：${await stopService()}`)
  } else if (command === 'update') {
    await update(flags)
  } else if (command === 'install-cli') {
    installCli()
  } else {
    help()
    process.exitCode = 2
  }
} catch (error) {
  console.error(`错误：${error.message}`)
  process.exitCode = 1
}
