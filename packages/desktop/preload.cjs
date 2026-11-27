const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('eabDesktop', {
  isDesktop: true,
  getServerInfo: () => ipcRenderer.invoke('eab:server-info'),
  saveServer: (url) => ipcRenderer.invoke('eab:save-server', String(url || '')),
  getServer: () => ipcRenderer.invoke('eab:get-server'),
  getDesktopInfo: () => ipcRenderer.invoke('eab:desktop-info'),
  bindProject: (projectId, rootPath) =>
    ipcRenderer.invoke('eab:bind-project', {
      projectId: String(projectId || ''),
      rootPath: String(rootPath || ''),
    }),
  unbindProject: (projectId) => ipcRenderer.invoke('eab:unbind-project', String(projectId || '')),
  syncProjects: (projects) =>
    ipcRenderer.invoke('eab:sync-projects', Array.isArray(projects) ? projects : []),
  openServerSettings: () => ipcRenderer.invoke('eab:open-server-settings'),
  pickDirectory: (options) =>
    ipcRenderer.invoke('eab:pick-directory', {
      title: String(options?.title || '选择本地项目文件夹'),
      defaultPath: String(options?.defaultPath || ''),
    }),
  openPath: (targetPath) => ipcRenderer.invoke('eab:open-path', String(targetPath || '')),
  revealPath: (targetPath) => ipcRenderer.invoke('eab:reveal-path', String(targetPath || '')),
  open: (url) => ipcRenderer.invoke('eab:open', String(url || '')),
  navigate: (pageId, action, url) => ipcRenderer.invoke('eab:navigate', String(pageId || ''), String(action || ''), url),
  close: (pageId) => ipcRenderer.invoke('eab:close', String(pageId || '')),
  setBounds: (pageId, rect) =>
    ipcRenderer.send('eab:bounds', {
      pageId: String(pageId || ''),
      rect: {
        x: Number(rect?.x) || 0,
        y: Number(rect?.y) || 0,
        width: Number(rect?.width) || 0,
        height: Number(rect?.height) || 0,
      },
    }),
  show: (pageId) => ipcRenderer.send('eab:show', String(pageId || '')),
  listTabs: (userId, sessionId) =>
    ipcRenderer.invoke('eab:browser-tabs', String(userId || ''), String(sessionId || '')),
  setBrowserSession: (sessionId) =>
    ipcRenderer.invoke('eab:set-browser-session', String(sessionId || '')),
  adoptBrowserSession: (sessionId, pageIds) =>
    ipcRenderer.invoke(
      'eab:adopt-browser-session',
      String(sessionId || ''),
      Array.isArray(pageIds) ? pageIds.map((id) => String(id || '')) : [],
    ),
  activateTab: (pageId) => ipcRenderer.invoke('eab:activate-tab', String(pageId || '')),
  focusShell: () => ipcRenderer.send('eab:focus-shell'),
  focusPage: (pageId) => ipcRenderer.send('eab:focus-page', String(pageId || '')),
  hideAll: () => ipcRenderer.send('eab:hide-all'),
  diagnostics: () => ipcRenderer.invoke('eab:diagnostics'),
  terminalCreate: (options) =>
    ipcRenderer.invoke('eab:terminal-create', {
      cwd: String(options?.cwd || ''),
      cols: Number(options?.cols) || 100,
      rows: Number(options?.rows) || 30,
    }),
  terminalInput: (id, data) =>
    ipcRenderer.send('eab:terminal-input', String(id || ''), String(data || '')),
  terminalClose: (id) => ipcRenderer.invoke('eab:terminal-close', String(id || '')),
  terminalRestart: (id) => ipcRenderer.invoke('eab:terminal-restart', String(id || '')),
  terminalCopy: (text) => ipcRenderer.invoke('eab:terminal-copy', String(text || '')),
  onTerminalData: (callback) => {
    if (typeof callback !== 'function') return () => undefined
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('eab:terminal-data', handler)
    return () => ipcRenderer.removeListener('eab:terminal-data', handler)
  },
  onTerminalExit: (callback) => {
    if (typeof callback !== 'function') return () => undefined
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('eab:terminal-exit', handler)
    return () => ipcRenderer.removeListener('eab:terminal-exit', handler)
  },
  checkUpdates: () => ipcRenderer.invoke('eab:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('eab:update-download'),
  applyUpdate: () => ipcRenderer.invoke('eab:update-apply'),
  onState: (callback) => {
    if (typeof callback !== 'function') return () => undefined
    const handler = (_event, state) => callback(state)
    ipcRenderer.on('eab:browser-state', handler)
    return () => ipcRenderer.removeListener('eab:browser-state', handler)
  },
  onClosed: (callback) => {
    if (typeof callback !== 'function') return () => undefined
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('eab:browser-closed', handler)
    return () => ipcRenderer.removeListener('eab:browser-closed', handler)
  },
  onTabOpen: (callback) => {
    if (typeof callback !== 'function') return () => undefined
    const handler = (_event, state) => callback(state)
    ipcRenderer.on('eab:browser-tab-open', handler)
    return () => ipcRenderer.removeListener('eab:browser-tab-open', handler)
  },
  onActivate: (callback) => {
    if (typeof callback !== 'function') return () => undefined
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('eab:browser-activate', handler)
    return () => ipcRenderer.removeListener('eab:browser-activate', handler)
  },
  onCommand: (callback) => {
    if (typeof callback !== 'function') return () => undefined
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('eab:browser-command', handler)
    return () => ipcRenderer.removeListener('eab:browser-command', handler)
  },
  onUpdate: (callback) => {
    if (typeof callback !== 'function') return () => undefined
    const handler = (_event, state) => callback(state)
    ipcRenderer.on('eab:update-state', handler)
    return () => ipcRenderer.removeListener('eab:update-state', handler)
  },
})
