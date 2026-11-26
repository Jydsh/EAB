#!/usr/bin/env node
/**
 * 构建 Windows 便携版：复制 Electron 运行时 + EAB 桌面应用，压成可直接下载解压运行的 zip。
 *
 * 不依赖 electron-builder，先保证 Windows 上有一条可验证、可下载的分发链路。
 * 后续安装包、签名、自动更新再替换这一层。
 */
import { cp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rcedit } from 'rcedit'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')
const electronDist = path.join(packageRoot, 'node_modules', 'electron', 'dist')
const releaseRoot = path.join(packageRoot, 'release')
const appDir = path.join(releaseRoot, 'EAB-Desktop-Windows-x64')
const appResources = path.join(appDir, 'resources', 'app')
const zipPath = path.join(releaseRoot, 'EAB-Desktop-Windows-x64.zip')

async function main() {
  if (!(await stat(path.join(electronDist, 'electron.exe')).catch(() => null))) {
    throw new Error('未找到 Electron 运行时，请先在 packages/desktop 执行 pnpm install')
  }

  // 桌面安装包版本跟网页共用项目根 package.json：网页 /api/health 读同一个值，
  // 不再单独维护 packages/desktop/package.json 的版本，避免桌面和网页漂移。
  const pkg = JSON.parse(await readFile(path.resolve(packageRoot, '..', '..', 'package.json'), 'utf8'))
  await rm(appDir, { recursive: true, force: true })
  await rm(zipPath, { force: true })
  await mkdir(appResources, { recursive: true })

  // 1. Electron 运行时（去掉默认 app，避免和我们的 resources/app 混在一起）
  await cp(electronDist, appDir, { recursive: true })
  await rm(path.join(appDir, 'resources', 'default_app.asar'), { force: true })
  await rm(path.join(appDir, 'electron.exe'), { force: true })
  // electronDist 在开发机被运行过时会留下 Chromium debug.log，属于本机日志，不能进分发包。
  await rm(path.join(appDir, 'debug.log'), { force: true })
  const electronExe = path.join(appDir, 'EAB.exe')
  await cp(path.join(electronDist, 'electron.exe'), electronExe)

  // Electron 运行时自带 Electron 图标。只在快捷方式里换图标不够：
  // Windows 的标题栏小图标、资源管理器和 exe 文件本身都读 PE 里的图标。
  // 构建时把品牌 ICO 写入 EAB.exe，保证从安装包到任务栏、标题栏、快捷方式一致。
  const iconSource = path.join(packageRoot, 'installer', 'assets', 'eab.ico')
  await rcedit(electronExe, {
    icon: iconSource,
    'version-string': {
      ProductName: 'EAB',
      FileDescription: 'EAB 企业智能体基座',
      CompanyName: 'EAB',
      LegalCopyright: 'Copyright EAB',
    },
    'file-version': pkg.version,
    'product-version': pkg.version,
  })

  // 2. 应用代码（只复制运行所需文件，不带 devDependencies）
  for (const file of ['main.mjs', 'preload.cjs', 'local-files.mjs', 'setup.html']) {
    await cp(path.join(packageRoot, file), path.join(appResources, file))
  }
  const assetSource = path.join(packageRoot, 'installer', 'assets')
  const assetTarget = path.join(appResources, 'assets')
  await mkdir(assetTarget, { recursive: true })
  for (const file of ['eab.ico', 'eab.png']) {
    await cp(path.join(assetSource, file), path.join(assetTarget, file))
  }
  const appPackage = {
    name: 'eab-desktop',
    productName: 'EAB',
    version: pkg.version || '0.0.0',
    private: true,
    type: 'module',
    main: 'main.mjs',
    description: 'EAB 桌面宿主：原生 Chromium 网页标签',
  }
  await writeFile(path.join(appResources, 'package.json'), JSON.stringify(appPackage, null, 2), 'utf8')

  // 3. 压缩成单文件；解压后双击 EAB.exe 即可运行
  const compress = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path '${appDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -CompressionLevel Optimal -Force`,
    ],
    { stdio: 'inherit' },
  )
  if (compress.status !== 0) throw new Error('压缩便携包失败')

  const zipStat = await stat(zipPath)
  console.log(`EAB Desktop Windows: ${appDir}`)
  console.log(`Download zip: ${zipPath} (${(zipStat.size / 1024 / 1024).toFixed(1)} MB)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
