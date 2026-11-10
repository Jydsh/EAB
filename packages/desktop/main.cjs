const { app, BrowserWindow, Menu, dialog, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const { spawn } = require('node:child_process')

app.setName('EAB')
const EAB_HOME = path.join(app.getPath('userData'), 'data')
const SETTINGS_FILE = path.join(EAB_HOME, 'console-settings.json')
const LOG_DIR = path.join(app.getPath('userData'), 'logs')
const SERVER_LOG = path.join(LOG_DIR, 'server.log')
const SERVER_ENTRY = path.join(__dirname, 'build', 'server.mjs')

let mainWindow = null
let serverProcess = null
let serverLogStream = null
let quitting = false
let autoUpdater = null

function readNetwork() {
  const defaults = { host: '127.0.0.1', chatPort: 8787, adminPort: 8788 }
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return defaults
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    return {
      host: typeof raw.host === 'string' && raw.host.trim() ? raw.host.trim() : defaults.host,
      chatPort: Number(raw.chatPort) > 0 ? Number(raw.chatPort) : defaults.chatPort,
      adminPort: Number(raw.adminPort) > 0 ? Number(raw.adminPort) : defaults.adminPort,
    }
  } catch {
    return defaults
  }
}

function displayHost(host) {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
}

function health(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: 2000 },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve(res.statusCode === 200 && body.includes('"ok":true')))
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
  })
}

async function waitHealth(port, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await health(port)) return true
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  return false
}

function openLog() {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  serverLogStream = fs.createWriteStream(SERVER_LOG, { flags: 'a' })
}

function startLocalServer() {
  const network = readNetwork()
  fs.mkdirSync(EAB_HOME, { recursive: true })
  openLog()
  serverLogStream.write(`\n[${new Date().toISOString()}] 启动本地 EAB 服务\n`)
  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: path.dirname(SERVER_ENTRY),
    env: {
      ...process.env,
      EAB_HOME,
      EAB_VERSION: app.getVersion(),
      EAB_PUBLIC_DIR: path.join(__dirname, 'build', 'public'),
      EAB_MIGRATIONS_DIR: path.join(__dirname, 'build', 'migrations'),
      EAB_PLUGINS_DIR: path.join(__dirname, 'build', 'plugins'),
      EAB_DESKTOP: '1',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  serverProcess.stdout.on('data', (chunk) => serverLogStream?.write(chunk))
  serverProcess.stderr.on('data', (chunk) => serverLogStream?.write(chunk))
  serverProcess.on('error', (error) => {
    if (!quitting) dialog.showErrorBox('EAB 本地服务启动失败', `${error.message}\n\n日志：${SERVER_LOG}`)
  })
  serverProcess.on('exit', (code) => {
    if (!quitting) {
      dialog.showErrorBox('EAB 本地服务已退出', `退出码 ${code ?? '—'}\n\n日志：${SERVER_LOG}`)
    }
  })
  return { network, ready: waitHealth(network.chatPort) }
}

function stopLocalServer() {
  if (!serverProcess) return
  try {
    serverProcess.kill()
  } catch {
    /* 已退出 */
  }
  serverProcess = null
}

async function ensureServer() {
  const network = readNetwork()
  if (await health(network.chatPort)) return network
  const started = startLocalServer()
  const ok = await started.ready
  if (!ok) throw new Error(`本地服务 30 秒内没有就绪，请查看日志：${SERVER_LOG}`)
  return readNetwork()
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: 'EAB',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.loadURL(url)
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })
  return win
}

function openConsole() {
  const network = readNetwork()
  createWindow(`http://${displayHost(network.host)}:${network.adminPort}/admin`)
}

function buildMenu(network) {
  const template = [
    {
      label: 'EAB',
      submenu: [
        { label: '员工工作台', click: () => mainWindow?.loadURL(`http://${displayHost(network.host)}:${network.chatPort}/chat`) },
        { label: '管理控制台', click: openConsole },
        { type: 'separator' },
        {
          label: '重启本地服务',
          click: async () => {
            stopLocalServer()
            await new Promise((resolve) => setTimeout(resolve, 1200))
            try {
              const next = await ensureServer()
              buildMenu(next)
              mainWindow?.loadURL(`http://${displayHost(next.host)}:${next.chatPort}/chat`)
            } catch (error) {
              dialog.showErrorBox('重启失败', error.message)
            }
          },
        },
        { label: '打开数据目录', click: () => shell.openPath(EAB_HOME) },
        { label: '打开服务日志', click: () => shell.openPath(SERVER_LOG) },
        { type: 'separator' },
        {
          label: '检查桌面更新',
          click: async () => {
            if (!app.isPackaged || !autoUpdater) {
              dialog.showMessageBox({ type: 'info', message: '开发模式不检查桌面更新。' })
              return
            }
            try {
              const result = await autoUpdater.checkForUpdates()
              if (!result?.updateInfo || result.updateInfo.version === app.getVersion()) {
                dialog.showMessageBox({ type: 'info', message: `当前已是最新版本 v${app.getVersion()}。` })
              }
            } catch (error) {
              dialog.showErrorBox('检查更新失败', error.message)
            }
          },
        },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ],
    },
    {
      label: '视图',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function setupDesktopUpdater() {
  if (!app.isPackaged) return
  try {
    autoUpdater = require('electron-updater').autoUpdater
  } catch {
    return
  }
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `EAB 有新版本 v${info.version}（当前 v${app.getVersion()}）`,
      detail: '下载完成后会提示重启安装。',
      buttons: ['下载并安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) autoUpdater.downloadUpdate().catch((error) => dialog.showErrorBox('下载更新失败', error.message))
  })
  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: '更新已下载',
      message: `v${info.version} 已下载完成`,
      detail: '现在重启并安装？',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) {
      quitting = true
      stopLocalServer()
      autoUpdater.quitAndInstall()
    }
  })
  autoUpdater.on('error', (error) => {
    console.warn('[eab] 桌面自动更新检查失败：', error.message)
  })
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    try {
      const network = await ensureServer()
      buildMenu(network)
      mainWindow = createWindow(`http://${displayHost(network.host)}:${network.chatPort}/chat`)
      setupDesktopUpdater()
    } catch (error) {
      dialog.showErrorBox('EAB 启动失败', String(error.message || error))
      app.quit()
    }
  })

  app.on('before-quit', () => {
    quitting = true
    stopLocalServer()
  })
  app.on('window-all-closed', () => app.quit())
}
