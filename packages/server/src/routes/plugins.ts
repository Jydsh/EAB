/**
 * 插件接口。
 *
 * 两种入口：
 * - `/api/plugins`：员工/企业侧只读清单 + 启停 + 页面资源（按当前身份的公司域）。
 * - `/api/console/plugins/*`：服务器侧控制台的插件管理器，负责安装 / 更新 / 卸载 / 审计。
 *   安装来源：浏览器上传的插件文件夹、npm（可换国内镜像）、GitHub 仓库；只取包内容，不执行安装脚本。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { EC, EabError, SC } from '@eab/domain'
import { hasConsoleSession, isConsoleRequest } from '../console-auth.js'
import type { ServerDeps } from '../deps.js'
import { ok, requireScope } from '../http.js'
import { dispatchPluginRpc, dispatchPluginWeb, listPluginHostStatuses, pluginHostStatus, refreshPluginHosts } from '../plugin-host.js'
import { pluginToolCatalogFor } from '../plugin-tools.js'
import {
  installPluginFromGithub,
  installPluginFromNpm,
  installPluginPackage,
  listPluginEvents,
  loadPlugins,
  loadPluginsForUser,
  loadPersonalPluginsForUser,
  PLUGIN_REGISTRIES,
  pluginRoot,
  resolvePluginAsset,
  setPluginEnabled,
  setUserPluginEnabled,
  uninstallPluginPackage,
  uninstallUserPlugin,
  type PluginRecord,
} from '../plugins.js'
import { consoleActor, resolveActor } from '../session.js'

const ASSET_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
}

/**
 * 浏览器只能给出所选文件夹里的文件副本（含相对路径），拿不到真实绝对路径。
 * 这里把文件清单落到服务端临时目录，交给既有的 installPluginPackage 校验和落库；
 * 安装结束后临时目录会被删除，服务端不再长期持有客户端目录。
 */
function stageBrowserPluginUpload(filesRaw: unknown): { dir: string; label: string; fileCount: number; bytes: number } {
  if (!Array.isArray(filesRaw) || filesRaw.length === 0) {
    throw new EabError(EC.VALIDATION, '请选择插件文件夹后再安装')
  }
  const entries: Array<{ segments: string[]; buf: Buffer }> = []
  let total = 0
  for (const item of filesRaw as Array<{ path?: unknown; data?: unknown }>) {
    const rawPath = String(item?.path ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
    const segments = rawPath.split('/').filter(Boolean)
    if (segments.length === 0 || segments.some((part) => part === '.' || part === '..')) {
      throw new EabError(EC.VALIDATION, '插件包里有非法文件路径')
    }
    const data = String(item?.data ?? '')
    if (!data) throw new EabError(EC.VALIDATION, `文件 ${rawPath} 没有内容`)
    const buf = Buffer.from(data, 'base64')
    if (buf.length === 0) throw new EabError(EC.VALIDATION, `文件 ${rawPath} 是空文件，不能作为插件包`)
    total += buf.length
    entries.push({ segments, buf })
  }

  // 浏览器会把用户选中的文件夹本身作为第一段路径；若根目录没有 manifest，则剥掉这层壳。
  const firsts = new Set(entries.map((entry) => entry.segments[0]))
  const hasRootManifest = entries.some(
    (entry) => entry.segments.length === 1 && (entry.segments[0] === 'plugin.json' || entry.segments[0] === 'package.json'),
  )
  const stripRoot = !hasRootManifest && firsts.size === 1
  const label = stripRoot ? [...firsts][0] : '浏览器上传'

  const dir = mkdtempSync(join(tmpdir(), 'eab-plugin-upload-'))
  try {
    for (const entry of entries) {
      const segments = stripRoot ? entry.segments.slice(1) : entry.segments
      if (segments.length === 0) continue
      const abs = resolve(dir, ...segments)
      if (!abs.startsWith(`${dir}${sep}`)) {
        throw new EabError(EC.VALIDATION, '插件包里有越界路径')
      }
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, entry.buf)
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
  return { dir, label, fileCount: entries.length, bytes: total }
}

function serializePlugin(plugin: PluginRecord, withInstall: boolean) {
  const base = {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    author: plugin.author,
    homepage: plugin.homepage,
    license: plugin.license,
    keywords: plugin.keywords,
    scopes: plugin.scopes,
    pages: plugin.pages,
    format: plugin.format,
    dsh: plugin.dsh,
    enabled: plugin.enabled,
    valid: plugin.valid,
    error: plugin.error,
    checksum: plugin.checksum,
  }
  const scope = plugin.userInstall && !plugin.userInstall.removedAt
    ? 'user'
    : plugin.companyInstall && !plugin.companyInstall.removedAt
      ? 'company'
      : null
  const baseWithScope = {
    ...base,
    installScope: scope,
    personal: scope === 'user',
  }
  if (!withInstall) return baseWithScope
  return {
    ...baseWithScope,
    install: plugin.install,
    /** 生命周期状态：磁盘上有、是否登记过安装、当前公司是否启用 */
    lifecycle: !plugin.valid
      ? 'invalid'
      : plugin.install
        ? plugin.install.removedAt
          ? 'removed'
          : plugin.enabled
            ? 'enabled'
            : 'disabled'
        : 'discovered',
  }
}

/**
 * 个人工作台详情。
 *
 * 员工侧不能看到 `install.sourceRef` 这类服务器路径（`/api/plugins` 的既有边界），
 * 所以这里只暴露来源类型、版本、校验和与本人安装时间；工具与宿主状态也只取本人可见范围。
 */
function serializePersonalPlugin(
  plugin: PluginRecord,
  tools: Array<{
    id: string
    pluginId: string
    name: string
    description: string
    available: boolean
    input: Record<string, unknown>
  }>,
  host: Pick<NonNullable<ReturnType<typeof pluginHostStatus>>, 'loaded' | 'error' | 'routes' | 'startedAt'> | null,
) {
  const base = serializePlugin(plugin, false)
  const userInstall = plugin.userInstall
  return {
    ...base,
    installScope: 'user',
    personal: true,
    lifecycle: !plugin.valid ? 'invalid' : plugin.enabled ? 'enabled' : 'disabled',
    install: userInstall
      ? {
          version: plugin.version,
          source: plugin.install?.source ?? 'catalog',
          checksum: plugin.checksum ?? null,
          installedAt: userInstall.installedAt,
          updatedAt: userInstall.updatedAt,
        }
      : null,
    tools,
    host: host ? { loaded: host.loaded, error: host.error, routes: host.routes, startedAt: host.startedAt } : null,
  }
}

function ensureConsole(req: FastifyRequest, deps: ServerDeps): void {
  if (!isConsoleRequest(req, deps.config)) {
    throw new EabError(EC.AUTH_REQUIRED, '需要控制台会话（请先在 /admin 登录）')
  }
}

function dshOptions(deps: ServerDeps): { dbPath: string; dshHomeDir?: string; companyId: string } {
  return { dbPath: deps.config.dbPath, dshHomeDir: deps.config.dshHomeDir, companyId: deps.companyId }
}

export function registerPluginRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/plugins', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.PLUGIN_LIST)

    const plugins = loadPlugins(deps.db, subject.companyId)
    return ok({
      plugins: plugins.map((plugin) => serializePlugin(plugin, false)),
      /** 员工侧永远看不到安装来源/服务器路径；这里只告诉运维"插件从哪来" */
      installHint: '插件由服务器侧控制台的「插件」页安装、更新、卸载；企业侧只负责按公司启用/停用与打开页面。',
    })
  })

  /* ---------------- 员工个人插件：个人安装 / 个人启停 / 个人卸载 ---------------- */

  app.get('/api/my/plugins', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.PLUGIN_LIST)
    const plugins = loadPersonalPluginsForUser(deps.db, subject.companyId, subject.userId)
    const pluginIds = new Set(plugins.map((plugin) => plugin.id))
    const tools = pluginToolCatalogFor(deps.db, { subject }).filter((tool) => pluginIds.has(tool.pluginId))
    const toolsByPlugin = new Map<string, typeof tools>()
    for (const tool of tools) {
      const rows = toolsByPlugin.get(tool.pluginId) ?? []
      rows.push(tool)
      toolsByPlugin.set(tool.pluginId, rows)
    }
    const hosts = new Map(
      listPluginHostStatuses([...pluginIds]).map((host) => [
        host.id,
        { loaded: host.loaded, error: host.error, routes: host.routes, startedAt: host.startedAt },
      ]),
    )
    return ok({
      companyId: subject.companyId,
      plugins: plugins.map((plugin) =>
        serializePersonalPlugin(plugin, toolsByPlugin.get(plugin.id) ?? [], hosts.get(plugin.id) ?? null),
      ),
      stats: {
        installed: plugins.length,
        enabled: plugins.filter((plugin) => plugin.enabled).length,
        tools: tools.length,
      },
      hint: '这里只显示你本人安装的插件；公司级插件不会出现在个人工作台。插件工具在启用后自动注册给对话模型。',
    })
  })

  /** 个人插件的宿主状态：只允许查看本人已安装的插件，不暴露控制台日志。 */
  app.get<{ Params: { id: string } }>('/api/my/plugins/:id/host', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.PLUGIN_LIST)
    const plugin = loadPersonalPluginsForUser(deps.db, subject.companyId, subject.userId).find(
      (item) => item.id === req.params.id,
    )
    if (!plugin) throw new EabError(EC.NOT_FOUND, `你还没有安装插件：${req.params.id}`)
    const status = pluginHostStatus(plugin.id, subject.companyId)
    return ok({
      status: status
        ? { loaded: status.loaded, error: status.error, routes: status.routes, startedAt: status.startedAt }
        : {
            loaded: false,
            error: plugin.format === 'dsh' ? 'host 还没加载（插件可能未启用，或没有 host 入口）' : null,
            routes: [],
            startedAt: null,
          },
    })
  })

  /**
   * 个人插件的 DSH client RPC。
   *
   * `/plugin-host.html` 在个人工作台里会带 `scope=user` 打这里，不再要求控制台会话；
   * 仍然要求插件是本人安装且处于启用状态，避免拿公司插件或停用插件绕过。
   */
  app.post<{ Params: { id: string }; Body: { channel?: string; call?: unknown } }>(
    '/api/my/plugins/:id/rpc',
    async (req) => {
      const { subject } = resolveActor(deps.db, deps.config, req)
      requireScope(subject, SC.PLUGIN_LIST)
      const plugin = loadPersonalPluginsForUser(deps.db, subject.companyId, subject.userId).find(
        (item) => item.id === req.params.id,
      )
      if (!plugin) throw new EabError(EC.NOT_FOUND, `你还没有安装插件：${req.params.id}`)
      if (plugin.format !== 'dsh') throw new EabError(EC.VALIDATION, '只有 DSH 插件支持 client RPC')
      if (!plugin.valid) throw new EabError(EC.VALIDATION, plugin.error || '插件清单无效')
      if (!plugin.enabled) throw new EabError(EC.FORBIDDEN, '插件已停用，启用后才能调用页面数据')
      const channel = String(req.body?.channel ?? '').trim()
      if (!channel) throw new EabError(EC.VALIDATION, '缺少 channel')
      return ok(await dispatchPluginRpc(plugin.id, channel, req.body?.call ?? {}, subject.companyId))
    },
  )

  /**
   * 个人插件的 Web 网关：插件 client 里的 fetch/XHR/EventSource 统一走这里。
   * 鉴权按员工会话，不要求控制台自定义头。
   */
  app.all<{ Params: { id: string; '*': string }; Body: unknown }>(
    '/api/my/plugins/:id/gateway/*',
    async (req, reply) => {
      const { subject } = resolveActor(deps.db, deps.config, req)
      requireScope(subject, SC.PLUGIN_LIST)
      const plugin = loadPersonalPluginsForUser(deps.db, subject.companyId, subject.userId).find(
        (item) => item.id === req.params.id,
      )
      if (!plugin) throw new EabError(EC.NOT_FOUND, `你还没有安装插件：${req.params.id}`)
      if (plugin.format !== 'dsh') throw new EabError(EC.VALIDATION, '只有 DSH 插件支持页面网关')
      if (!plugin.enabled) throw new EabError(EC.FORBIDDEN, '插件已停用，启用后才能调用页面数据')
      const suffix = String((req.params as Record<string, string>)['*'] ?? '')
      const targetPath = suffix.startsWith('/') ? suffix : `/${suffix}`
      const rawUrl = req.raw.url ?? ''
      const queryAt = rawUrl.indexOf('?')
      const query = queryAt >= 0 ? rawUrl.slice(queryAt) : undefined
      const body =
        req.method === 'GET' || req.method === 'HEAD'
          ? undefined
          : JSON.stringify(req.body ?? {})
      const response = await dispatchPluginWeb(plugin.id, targetPath, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
        body,
        query,
      }, subject.companyId)
      reply.status(response.status)
      response.headers.forEach((value, key) => {
        if (key !== 'content-length') reply.header(key, value)
      })
      if (req.method === 'HEAD' || !response.body) return reply.send()
      return reply.send(Readable.fromWeb(response.body as any))
    },
  )

  app.post<{
    Body: {
      source?: string
      sourcePath?: string
      files?: Array<{ path?: string; data?: string }>
      packageName?: string
      version?: string
      registry?: string
      repo?: string
      ref?: string
      subdir?: string
      overwrite?: boolean
      pluginId?: string
    }
  }>('/api/my/plugins/install', { bodyLimit: 256 * 1024 * 1024 }, async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.PLUGIN_LIST)

    const source = typeof req.body?.source === 'string' ? req.body.source : 'browser-dir'
    const overwrite = req.body?.overwrite === true
    const options = {
      companyId: subject.companyId,
      installedBy: subject.userId,
      scope: 'user' as const,
      userId: subject.userId,
      overwrite,
    }

    let result
    if (source === 'npm') {
      const packageName = typeof req.body?.packageName === 'string' ? req.body.packageName.trim() : ''
      if (!packageName) throw new EabError(EC.VALIDATION, '请填 npm 包名')
      result = await installPluginFromNpm(deps.db, {
        ...options,
        packageName,
        version: typeof req.body?.version === 'string' ? req.body.version : '',
        registry: typeof req.body?.registry === 'string' ? req.body.registry : '',
      })
    } else if (source === 'github') {
      const repo = typeof req.body?.repo === 'string' ? req.body.repo.trim() : ''
      if (!repo) throw new EabError(EC.VALIDATION, '请填 GitHub 仓库（owner/repo）')
      result = await installPluginFromGithub(deps.db, {
        ...options,
        repo,
        ref: typeof req.body?.ref === 'string' ? req.body.ref : '',
        subdir: typeof req.body?.subdir === 'string' ? req.body.subdir : '',
      })
    } else if (source === 'catalog') {
      const pluginId = typeof req.body?.pluginId === 'string' ? req.body.pluginId.trim() : ''
      if (!pluginId) throw new EabError(EC.VALIDATION, '请选择要安装的插件')
      const sourcePath = join(pluginRoot(), pluginId)
      result = installPluginPackage(deps.db, sourcePath, {
        ...options,
        source: 'catalog',
      })
    } else if (source === 'browser-dir') {
      const staged = stageBrowserPluginUpload(req.body?.files)
      try {
        result = installPluginPackage(deps.db, staged.dir, {
          ...options,
          source: 'browser-dir',
          sourceRef: staged.label,
        })
      } finally {
        rmSync(staged.dir, { recursive: true, force: true })
      }
    } else {
      throw new EabError(EC.VALIDATION, `不支持的插件安装来源: ${source}`)
    }

    const plugins = loadPluginsForUser(deps.db, subject.companyId, subject.userId)
    const plugin = plugins.find((item) => item.id === result.plugin.id)
    // 个人安装也可能让这个插件的 host 第一次启动；工具要立即可用
    await refreshPluginHosts(deps.db, dshOptions(deps))
    return ok({
      plugin: plugin ? serializePlugin(plugin, false) : serializePlugin(result.plugin, false),
      replaced: result.replaced,
      sourcePath: result.sourcePath,
    })
  })

  app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    '/api/my/plugins/:id/state',
    async (req) => {
      const { subject } = resolveActor(deps.db, deps.config, req)
      requireScope(subject, SC.PLUGIN_LIST)
      const enabled = req.body?.enabled !== false
      setUserPluginEnabled(deps.db, subject.companyId, subject.userId, req.params.id, enabled)
      await refreshPluginHosts(deps.db, dshOptions(deps))
      return ok({ id: req.params.id, enabled })
    },
  )

  app.post<{ Params: { id: string } }>('/api/my/plugins/:id/uninstall', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.PLUGIN_LIST)
    const result = uninstallUserPlugin(deps.db, subject.companyId, subject.userId, req.params.id)
    await refreshPluginHosts(deps.db, dshOptions(deps))
    return ok(result)
  })

  app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    '/api/plugins/:id/state',
    async (req) => {
      const { subject } = resolveActor(deps.db, deps.config, req)
      requireScope(subject, SC.PLUGIN_CONFIGURE)

      const plugins = loadPlugins(deps.db, subject.companyId)
      const plugin = plugins.find((item) => item.id === req.params.id)
      if (!plugin) throw new EabError(EC.NOT_FOUND, `插件不存在：${req.params.id}`)
      if (!plugin.valid) throw new EabError(EC.VALIDATION, `插件清单不合法，不能启用：${plugin.error ?? ''}`)

      const enabled = req.body?.enabled !== false
      setPluginEnabled(deps.db, subject.companyId, plugin.id, enabled, subject.userId)
      await refreshPluginHosts(deps.db, dshOptions(deps))
      return ok({ id: plugin.id, enabled })
    },
  )

  /* ---------------- 服务器侧：插件管理器（安装 / 更新 / 卸载 / 审计） ---------------- */

  app.get('/api/console/plugins', async (req) => {
    ensureConsole(req, deps)
    const { subject } = resolveActor(deps.db, deps.config, req)
    const discovered = loadPlugins(deps.db, subject.companyId)
    const plugins = discovered.filter((plugin) => plugin.install && !plugin.install.removedAt)
    const visibleIds = new Set(discovered.map((plugin) => plugin.id))
    const events = listPluginEvents(deps.db, 30, subject.companyId).filter(
      (event) => event.companyId === subject.companyId || visibleIds.has(event.pluginId),
    )
    return ok({
      companyId: subject.companyId,
      plugins: plugins.map((plugin) => serializePlugin(plugin, true)),
      events,
      stats: {
        discovered: discovered.length,
        installed: plugins.length,
        enabled: plugins.filter((plugin) => plugin.enabled).length,
        invalid: plugins.filter((plugin) => !plugin.valid).length,
        dsh: plugins.filter((plugin) => plugin.format === 'dsh').length,
      },
      /** DSH 插件 host 运行状态（RPC 通道是否已挂载、启动报错、日志尾巴） */
      hosts: listPluginHostStatuses(plugins.map((plugin) => plugin.id)),
      installer: {
        root: pluginRoot(),
        // 插件安装只做健康检查，不再按文件数/体积做限制。
        sources: [
          { id: 'browser-dir', label: '本机文件夹', hint: '在浏览器里选择插件文件夹上传；服务端只接收文件副本，安装后即删除临时目录' },
          { id: 'local-dir', label: '服务器目录', hint: '服务器上已有的插件包目录，管理员本机安装时可用' },
          { id: 'npm', label: 'npm / 镜像', hint: '从 registry 拉 tarball，可切国内镜像' },
          { id: 'github', label: 'GitHub', hint: '按仓库 + 分支/标签下载 codeload tarball' },
        ],
        registries: PLUGIN_REGISTRIES,
        note: '安装登记按公司隔离：哪家公司安装、启停、卸载都各自记账；插件代码目录在服务器上共享，最后一家公司卸载时才移入 plugins/.trash。支持两种清单：EAB 原生 plugin.json，以及 DSH 插件（package.json 的 dsh 段：bundle.patch / client.inject / compatibility）。DSH 包会按 files 白名单复制，避开 test / .tmp / tgz 残留；host 入口（main）由 EAB 的 DSH 兼容宿主执行，client 入口（exports["./client"]）由控制台的 DSH 运行时渲染。npm 与 GitHub 只取包内容，不执行 npm install、生命周期脚本或仓库脚本。',
      },
    })
  })

  app.post<{
    Body: {
      source?: string
      sourcePath?: string
      files?: Array<{ path?: string; data?: string }>
      packageName?: string
      version?: string
      registry?: string
      repo?: string
      ref?: string
      subdir?: string
      overwrite?: boolean
      enable?: boolean
    }
  }>('/api/console/plugins/install', { bodyLimit: 256 * 1024 * 1024 }, async (req) => {
    ensureConsole(req, deps)
    const { subject } = resolveActor(deps.db, deps.config, req)
    const source = typeof req.body?.source === 'string' ? req.body.source : 'browser-dir'
    const overwrite = req.body?.overwrite === true
    const installedBy = subject.userId

    let result
    if (source === 'npm') {
      const packageName = typeof req.body?.packageName === 'string' ? req.body.packageName.trim() : ''
      if (!packageName) throw new EabError(EC.VALIDATION, '请填 npm 包名')
      result = await installPluginFromNpm(deps.db, {
        companyId: subject.companyId,
        packageName,
        version: typeof req.body?.version === 'string' ? req.body.version : '',
        registry: typeof req.body?.registry === 'string' ? req.body.registry : '',
        overwrite,
        installedBy,
      })
    } else if (source === 'github') {
      const repo = typeof req.body?.repo === 'string' ? req.body.repo.trim() : ''
      if (!repo) throw new EabError(EC.VALIDATION, '请填 GitHub 仓库（owner/repo）')
      result = await installPluginFromGithub(deps.db, {
        companyId: subject.companyId,
        repo,
        ref: typeof req.body?.ref === 'string' ? req.body.ref : '',
        subdir: typeof req.body?.subdir === 'string' ? req.body.subdir : '',
        overwrite,
        installedBy,
      })
    } else if (source === 'local-dir') {
      const sourcePath = typeof req.body?.sourcePath === 'string' ? req.body.sourcePath.trim() : ''
      if (!sourcePath) throw new EabError(EC.VALIDATION, '请填插件包在服务器上的目录（含 plugin.json 或 DSH 插件的 package.json）')
      result = installPluginPackage(deps.db, sourcePath, {
        companyId: subject.companyId,
        installedBy,
        overwrite,
        source: 'local-dir',
      })
    } else if (source === 'browser-dir') {
      const staged = stageBrowserPluginUpload(req.body?.files)
      try {
        result = installPluginPackage(deps.db, staged.dir, {
          companyId: subject.companyId,
          installedBy,
          overwrite,
          source: 'browser-dir',
          sourceRef: staged.label,
        })
      } finally {
        rmSync(staged.dir, { recursive: true, force: true })
      }
    } else {
      throw new EabError(EC.VALIDATION, `不支持的插件安装来源: ${source}`)
    }

    if (req.body?.enable === true && result.plugin.valid) {
      setPluginEnabled(deps.db, subject.companyId, result.plugin.id, true, subject.userId)
    }
    // DSH 插件的 host 侧要跟着安装结果重新加载，插件页立刻能打开自己的 RPC 通道
    await refreshPluginHosts(deps.db, dshOptions(deps))
    return ok({
      plugin: serializePlugin(result.plugin, false),
      replaced: result.replaced,
      sourcePath: result.sourcePath,
      trashPath: result.trashPath,
    })
  })

  app.post<{ Params: { id: string } }>('/api/console/plugins/:id/uninstall', async (req) => {
    ensureConsole(req, deps)
    const { subject } = resolveActor(deps.db, deps.config, req)
    const result = uninstallPluginPackage(deps.db, req.params.id, subject.userId, subject.companyId)
    await refreshPluginHosts(deps.db, dshOptions(deps))
    return ok(result)
  })

  app.get<{ Querystring: { limit?: string } }>('/api/console/plugins/events', async (req) => {
    ensureConsole(req, deps)
    const { subject } = resolveActor(deps.db, deps.config, req)
    const limit = Number(req.query.limit ?? 30) || 30
    const visibleIds = new Set(loadPlugins(deps.db, subject.companyId).map((plugin) => plugin.id))
    const events = listPluginEvents(deps.db, limit, subject.companyId).filter(
      (event) => event.companyId === subject.companyId || visibleIds.has(event.pluginId),
    )
    return ok({ events })
  })

  /** DSH host 运行状态：RPC 通道、启动报错、日志尾巴 */
  app.get<{ Params: { id: string } }>('/api/console/plugins/:id/host', async (req) => {
    ensureConsole(req, deps)
    const { subject } = resolveActor(deps.db, deps.config, req)
    const status = pluginHostStatus(req.params.id, subject.companyId)
    return ok({
      status: status ?? {
        id: req.params.id,
        companyId: subject.companyId,
        loaded: false,
        state: 'pending',
        pendingServices: [],
        hostEntry: null,
        startedAt: null,
        error: 'host 未加载（插件未安装 / 未启用 / 没有 host 入口）',
        routes: [],
        logs: [],
        llmProviders: 0,
        llmModels: 0,
      },
    })
  })

  /**
   * DSH client ↔ host 的 RPC 桥。
   * 请求体二选一：
   * - `{ channel, call }`：由控制台的 DSH 运行时发来；
   * - `{ type:'client-request', rpcId, method, payload }`：直接转发 DSH 原始报文。
   * 返回插件 host 自己的 `result`（`{ok, value|error}`），保持与 DSH `connection.rpc.call` 一致。
   */
  app.post<{
    Params: { id: string }
    Body: { channel?: string; call?: unknown; type?: string; method?: string; payload?: unknown; rpcId?: string }
  }>('/api/console/plugins/:id/rpc', async (req) => {
    ensureConsole(req, deps)
    const { subject } = resolveActor(deps.db, deps.config, req)
    const plugin = loadPlugins(deps.db, subject.companyId).find((item) => item.id === req.params.id)
    if (!plugin || plugin.format !== 'dsh') {
      throw new EabError(EC.NOT_FOUND, `不是已安装的 DSH 插件：${req.params.id}`)
    }
    if (!plugin.enabled) throw new EabError(EC.VALIDATION, `插件 ${plugin.id} 当前公司未启用`)
    const channel = String(req.body?.channel ?? req.body?.method ?? '').trim()
    const call = req.body?.call ?? req.body?.payload
    if (!channel || typeof call !== 'object' || call === null) {
      throw new EabError(EC.VALIDATION, 'RPC 请求缺少 channel / call')
    }
    return ok(await dispatchPluginRpc(plugin.id, channel, call, subject.companyId))
  })

  /**
   * 插件 Web 网关桥：把控制台请求按插件 host 注册的 webServer 路由转发过去。
   * 只对控制台会话开放；目标必须是插件自己注册的路径，不会访问任意主机。
   */
  app.all<{ Params: { id: string; '*': string }; Body: unknown }>(
    '/api/console/plugins/:id/gateway/*',
    async (req, reply) => {
      ensureConsole(req, deps)
      const { subject } = resolveActor(deps.db, deps.config, req)
      const plugin = loadPlugins(deps.db, subject.companyId).find((item) => item.id === req.params.id)
      if (!plugin || plugin.format !== 'dsh') {
        throw new EabError(EC.NOT_FOUND, `不是已安装的 DSH 插件：${req.params.id}`)
      }
      if (!plugin.enabled) throw new EabError(EC.VALIDATION, `插件 ${plugin.id} 当前公司未启用`)
      const suffix = String((req.params as Record<string, string>)['*'] ?? '')
      const targetPath = suffix.startsWith('/') ? suffix : `/${suffix}`
      const rawUrl = req.raw.url ?? ''
      const queryAt = rawUrl.indexOf('?')
      const query = queryAt >= 0 ? rawUrl.slice(queryAt) : undefined
      const body =
        req.method === 'GET' || req.method === 'HEAD'
          ? undefined
          : JSON.stringify(req.body ?? {})
      const response = await dispatchPluginWeb(plugin.id, targetPath, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
        body,
        query,
      }, subject.companyId)
      reply.status(response.status)
      response.headers.forEach((value, key) => {
        // content-length 由 Fastify 自己按流式响应处理；其余头原样保留。
        if (key !== 'content-length') reply.header(key, value)
      })
      if (req.method === 'HEAD' || !response.body) return reply.send()
      // SSE、长轮询、下载都必须是流式；await response.text() 会把它们缓冲成一次性响应。
      return reply.send(Readable.fromWeb(response.body as any))
    },
  )
  app.get<{ Params: { id: string; '*': string }; Querystring: { scope?: string } }>(
    '/plugins/assets/:id/*',
    async (req, reply) => {
      /**
       * `<script src>` / iframe 资源请求带不了 `x-eab-console: 1`，只能带 cookie。
       * 所以这里单独处理：控制台页面用控制台会话 cookie 认操作员；
       * 个人工作台显式带 scope=user，优先按员工会话认人，避免同浏览器同时登录控制台时串身份。
       */
      const scope = req.query.scope === 'user' ? 'user' : 'console'
      const subject =
        scope === 'user'
          ? resolveActor(deps.db, deps.config, req).subject
          : hasConsoleSession(req)
            ? consoleActor(deps.db, deps.config.companyId).subject
            : resolveActor(deps.db, deps.config, req).subject
      requireScope(subject, SC.PLUGIN_LIST)

      const plugins = loadPluginsForUser(deps.db, subject.companyId, subject.userId)
      const asset = resolvePluginAsset(plugins, req.params.id, req.params['*'])
      if (!asset) throw new EabError(EC.NOT_FOUND, '插件资源不存在或插件未启用')

      const type = ASSET_TYPES[extname(asset)] ?? 'application/octet-stream'
      reply.type(type).header('cache-control', 'no-store')
      return reply.send(readFileSync(asset))
    },
  )
}
