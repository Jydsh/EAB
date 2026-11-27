#!/usr/bin/env node
/**
 * 构建 Windows EXE 安装包：
 * 1. 生成品牌 ico / 向导位图（缺失时）；
 * 2. 复用 build-win-portable.mjs 生成完整 Electron 应用目录；
 * 3. 写 NSIS 构建配置；
 * 4. 调用本机缓存的 NSIS 编译安装包。
 *
 * 安装器默认装到 Program Files\EAB，安装向导允许用户改路径；
 * 同时生成 Uninstall.exe，并写入 Windows「应用与功能」卸载项。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')
const installerDir = path.join(packageRoot, 'installer')
const generatedDir = path.join(installerDir, 'generated')
const appDir = path.join(packageRoot, 'release', 'EAB-Desktop-Windows-x64')
const releaseDir = path.join(packageRoot, 'release')

function commandPath(name) {
  try {
    const out = execFileSync('where.exe', [name], { encoding: 'utf8', windowsHide: true }).trim()
    return out.split(/\r?\n/)[0] || ''
  } catch {
    return ''
  }
}

function findMakensis() {
  const candidates = [
    process.env.EAB_NSIS_MAKENSIS,
    commandPath('makensis.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'nsis-3.0.4.1', 'nsis-3.0.4.1-w8az6', 'Bin', 'makensis.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'nsis-3.0.4.1', 'nsis-3.0.4.1-w8az6', 'makensis.exe'),
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
  ].filter(Boolean)
  return candidates.find((file) => existsSync(file)) || ''
}

function ensureAssets() {
  const icon = path.join(installerDir, 'assets', 'eab.ico')
  const wizard = path.join(installerDir, 'assets', 'wizard.bmp')
  if (existsSync(icon) && existsSync(wizard)) return
  const script = path.join(installerDir, 'scripts', 'make-installer-assets.ps1')
  execFileSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'inherit' })
}

function assertAppNotRunning() {
  // 中文系统下 tasklist 的空结果和错误信息都是本地化文本，不能靠“EAB.exe”字样判断。
  // CSV 输出里真正运行的一行固定以 "EAB.exe" 开头，避免把“信息: 没有运行的任务”误判成进程。
  const result = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq EAB.exe', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (!result.stdout) return
  if (/^"EAB\.exe"/im.test(result.stdout)) {
    throw new Error('检测到 EAB.exe 正在运行，请先退出客户端再构建安装包')
  }
}

function versionParts(version) {
  const digits = String(version).match(/\d+/g) || ['0']
  while (digits.length < 4) digits.push('0')
  return digits.slice(0, 4).join('.')
}

function configuredServerUrl() {
  const raw = String(process.env.EAB_DESKTOP_SERVER_URL || process.env.EAB_DESKTOP_URL || '').trim()
  if (!raw) return ''
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('EAB_DESKTOP_SERVER_URL 不是合法 URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('EAB_DESKTOP_SERVER_URL 只支持 http/https')
  }
  if (parsed.username || parsed.password) throw new Error('EAB_DESKTOP_SERVER_URL 不能包含账号密码')
  if (parsed.pathname === '/' || parsed.pathname === '') {
    parsed.pathname = '/chat'
    if (!parsed.searchParams.get('company')) parsed.searchParams.set('company', 'c1')
  }
  return parsed.href
}

function findOutput() {
  const files = readdirSync(releaseDir)
    .filter((name) => /^EAB-Setup-.*-x64\.exe$/i.test(name))
    .map((name) => path.join(releaseDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return files[0] || ''
}

/**
 * 发布产物不能只留在 packages/desktop/release：
 * eab update 会整包替换 packages，安装包会被一起删掉。
 * 这里同步一份到数据目录，服务端优先从那里读，升级后仍能下载。
 */
function publishToReleaseCache(finalFile, manifestFile, version) {
  const dir = process.env.EAB_DESKTOP_RELEASE_DIR?.trim()
    ? path.resolve(process.env.EAB_DESKTOP_RELEASE_DIR.trim())
    : process.env.EAB_HOME?.trim()
      ? path.join(path.resolve(process.env.EAB_HOME.trim()), 'desktop-release')
      : path.join(path.resolve(packageRoot, '..', '..'), '.eab-dev', 'desktop-release')
  mkdirSync(dir, { recursive: true })
  copyFileSync(finalFile, path.join(dir, path.basename(finalFile)))
  copyFileSync(manifestFile, path.join(dir, 'desktop-release.json'))
  const portableZip = path.join(releaseDir, 'EAB-Desktop-Windows-x64.zip')
  if (existsSync(portableZip)) copyFileSync(portableZip, path.join(dir, 'EAB-Desktop-Windows-x64.zip'))
  const versionedPortableZip = path.join(releaseDir, `EAB-Desktop-Windows-x64-${version}.zip`)
  if (existsSync(versionedPortableZip)) copyFileSync(versionedPortableZip, path.join(dir, path.basename(versionedPortableZip)))
  return dir
}

function main() {
  if (!existsSync(path.join(installerDir, 'eab-installer.nsi'))) {
    throw new Error('缺少 installer/eab-installer.nsi')
  }
  ensureAssets()
  assertAppNotRunning()

  // 先构建应用目录；这一步同时产出便携 zip，保留旧下载方式。
  execFileSync(process.execPath, [path.join(packageRoot, 'scripts', 'build-win-portable.mjs')], {
    stdio: 'inherit',
    cwd: packageRoot,
  })

  const makensis = findMakensis()
  if (!makensis) {
    throw new Error('未找到 makensis.exe。请安装 NSIS 3，或设置 EAB_NSIS_MAKENSIS 指向 makensis.exe')
  }

  // 和网页共用项目根版本：/api/health 与本安装包必须显示同一个版本号。
  const pkg = JSON.parse(readFileSync(path.resolve(packageRoot, '..', '..', 'package.json'), 'utf8'))
  const version = String(pkg.version || '0.0.0')
  const serverUrl = configuredServerUrl()
  const output = path.join(releaseDir, `EAB-Setup-${version}-x64.exe`)
  mkdirSync(generatedDir, { recursive: true })
  rmSync(output, { force: true })

  const buildNsh = `!define APP_DIR "${appDir}"
!define OUT_FILE "${output}"
!define PRODUCT_VERSION "${version}"
!define PRODUCT_VERSION_4 "${versionParts(version)}"
!define SERVER_URL "${serverUrl}"
`
  // NSIS 读取 UTF-8 需要 BOM；这里显式加 BOM，避免中文路径或后续中文定义乱码。
  writeFileSync(path.join(generatedDir, 'build.nsh'), `\ufeff${buildNsh}`, 'utf8')

  console.log(`NSIS: ${makensis}`)
  const result = spawnSync(makensis, ['/V3', path.join(installerDir, 'eab-installer.nsi')], {
    stdio: 'inherit',
    cwd: installerDir,
    windowsHide: false,
  })
  if (result.status !== 0) throw new Error(`NSIS 编译失败，退出码 ${result.status ?? 'unknown'}`)

  const finalFile = findOutput()
  if (!finalFile) throw new Error('NSIS 编译结束但没有找到 EAB-Setup-*.exe')
  const size = statSync(finalFile).size
  const sha256 = createHash('sha256').update(readFileSync(finalFile)).digest('hex')
  const manifest = {
    version,
    platform: 'win32',
    arch: 'x64',
    file: path.basename(finalFile),
    size,
    sha256,
    publishedAt: new Date().toISOString(),
    notes: 'EAB Windows 桌面版安装包；支持内网 HTTP 语音、品牌图标、服务器驱动更新和本地项目工作区（原生目录选择、项目文件面板）。',
  }
  writeFileSync(path.join(releaseDir, 'desktop-release.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const cacheDir = publishToReleaseCache(finalFile, path.join(releaseDir, 'desktop-release.json'), version)
  console.log(`Installer: ${finalFile}`)
  console.log(`Size: ${(size / 1024 / 1024).toFixed(1)} MB`)
  console.log(`SHA256: ${sha256}`)
  console.log(`Manifest: ${path.join(releaseDir, 'desktop-release.json')}`)
  console.log(`Server cache: ${cacheDir}`)
}

try {
  main()
} catch (err) {
  console.error(`[eab-installer] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
