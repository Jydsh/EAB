/**
 * 控制台「运行设置」接口：日志保留天数 + 数据目录。
 *
 * 两个设置都写在部署目录的 `.eab-dev/console-settings.json`：
 * - 保留天数立即生效（后台定时清理读同一份文件）；
 * - 存储位置保存后由运行时立即复制/切换，不重启；启动迁移只保留给旧版本遗留的 pending。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { EC, EabError } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok } from '../http.js'
import { isConsoleRequest } from '../console-auth.js'
import { effectiveNetwork } from '../network-settings.js'
import { runRetention } from '../retention.js'
import { pruneWorkspaceRecycle, workspaceRootFor } from '../workspace-recycle.js'
import { pickSystemDirectory } from '../directory-picker.js'
import { listServerDirectories } from '../directory-browser.js'
import { hasInteractiveWindowsDesktop, requestIsLocal } from '../console-locality.js'
import {
  defaultHomeDir,
  readConsoleSettings,
  storageDefaults,
  writeConsoleSettings,
  type BrandSurfaceSettings,
  type BrandingSettings,
  type StorageApplyPaths,
  type StorageMigration,
  type StoragePathKey,
  type StorageSettingKey,
  type ConsoleSettings,
} from '../settings.js'
import {
  agentTeamSettingsView,
  effectiveAgentTeamSettings,
  normalizeAgentMaxWorkers,
} from '../agent-team-settings.js'

function requireConsole(req: FastifyRequest, deps: ServerDeps): void {
  if (!isConsoleRequest(req, deps.config)) {
    throw new EabError(EC.AUTH_REQUIRED, '需要控制台会话（请先在 /admin 登录）')
  }
}

function count(db: ServerDeps['db'], sql: string): number {
  return Number((db.prepare(sql).get() as { n: number }).n)
}

function sum(db: ServerDeps['db'], sql: string): number {
  return Number((db.prepare(sql).get() as { n: number | null }).n ?? 0)
}

function localAddresses(): string[] {
  const found = new Set<string>()
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (!item.address || item.internal || item.family !== 'IPv4') continue
      found.add(item.address)
    }
  }
  return [...found].sort()
}

function validHost(value: string): boolean {
  if (!value || value.length > 253 || /\s/.test(value)) return false
  if (value === 'localhost' || value === '0.0.0.0' || value === '::' || value === '::1') return true
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255)
  }
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)
}

function readPort(value: unknown, label: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new EabError(EC.VALIDATION, `${label}必须是 1–65535 的整数`)
  }
  return port
}

function audit(deps: ServerDeps, req: FastifyRequest, action: string, detail: Record<string, unknown>): void {
  appendAudit(deps.db, {
    companyId: deps.companyId,
    actorUserId: 'console-operator',
    action,
    resourceType: 'console_settings',
    resourceId: 'runtime',
    result: 'success',
    ip: req.ip,
    channel: 'console',
    detail: detail as never,
  })
}

const STORAGE_LABELS: Record<StorageSettingKey, string> = {
  dataDir: '总存储位置',
  database: '数据库目录',
  workspaces: '个人 / 共享云空间',
  tmp: '临时文件',
  backups: '数据库备份',
  plugins: '插件安装',
  dshHome: '插件运行数据',
}

const STORAGE_KEYS: readonly StoragePathKey[] = ['database', 'workspaces', 'tmp', 'backups', 'plugins', 'dshHome']

function currentStoragePath(deps: ServerDeps, key: StorageSettingKey): string {
  const base = deps.config.dataDir ?? defaultHomeDir()
  const defaults = storageDefaults(base)
  switch (key) {
    case 'dataDir':
      return base
    case 'database':
      return deps.config.dbDir ?? dirname(deps.config.dbPath)
    case 'workspaces':
      return deps.config.workspacesDir ?? defaults.workspaces
    case 'tmp':
      return deps.config.tmpDir ?? defaults.tmp
    case 'backups':
      return deps.config.backupsDir ?? defaults.backups
    case 'plugins':
      return deps.config.pluginsDir ?? defaults.plugins
    case 'dshHome':
      return deps.config.dshHomeDir ?? defaults.dshHome
  }
}

function isLocked(deps: ServerDeps, key: StorageSettingKey): boolean {
  if (key === 'plugins') return Boolean(deps.config.pluginsEnvLocked)
  if (key === 'database') return Boolean(deps.config.dataDirEnvLocked)
  return false
}

function probeWritable(path: string): void {
  try {
    mkdirSync(path, { recursive: true })
    const probe = join(path, '.eab-write-probe')
    writeFileSync(probe, 'ok', 'utf8')
    rmSync(probe, { force: true })
  } catch (err) {
    throw new EabError(EC.VALIDATION, `目录不可写：${(err as Error).message}`)
  }
}

function isRootPath(path: string): boolean {
  const resolved = resolve(path)
  return dirname(resolved) === resolved
}

function isNested(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

function ensureNonEmptyTarget(path: string): void {
  if (!existsSync(path)) return
  if (!statSync(path).isDirectory()) throw new EabError(EC.VALIDATION, `目标路径不是目录：${path}`)
  if (readdirSync(path).length > 0) {
    throw new EabError(EC.VALIDATION, `目标目录已有数据，不能自动覆盖：${path}`, {
      hint: '换一个空目录，或先把目标目录里的数据移走后再切换',
    })
  }
}

function typeLabel(key: StorageSettingKey): string {
  return STORAGE_LABELS[key]
}

interface StorageRowView {
  key: StorageSettingKey
  label: string
  path: string
  configured: string | null
  defaultPath: string
  source: '独立配置' | '跟随总位置' | '部署默认'
  locked: boolean
}

function baseMigrationJobs(
  deps: ServerDeps,
  settings: ConsoleSettings,
  target: string,
): StorageMigration[] {
  const nextDefaults = storageDefaults(target)
  const jobs: StorageMigration[] = []
  for (const category of STORAGE_KEYS) {
    if (settings.paths[category]) continue
    if (category === 'database' && deps.config.dataDirEnvLocked) continue
    if (category === 'plugins' && deps.config.pluginsEnvLocked) continue
    const from = currentStoragePath(deps, category)
    const to = nextDefaults[category]
    if (resolve(from) !== resolve(to)) {
      jobs.push({
        key: category,
        kind: category === 'database' ? 'database' : 'directory',
        from,
        to,
        createdAt: new Date().toISOString(),
      })
    }
  }
  return jobs
}

/**
 * 保存成功后各分类应落到的绝对路径。
 * 用于迁移计划和热切换后的 config 更新；环境变量锁定的分类保持原路径。
 */
function storagePathsAfter(
  deps: ServerDeps,
  settings: ConsoleSettings,
  key: StorageSettingKey,
  target: string,
): StorageApplyPaths {
  const base = key === 'dataDir' ? target : deps.config.dataDir ?? defaultHomeDir()
  const defaults = storageDefaults(base)
  const currentDbDir = deps.config.dbDir ?? dirname(deps.config.dbPath)
  const paths: StorageApplyPaths = {
    dataDir: base,
    dbDir: currentDbDir,
    dbPath: deps.config.dbPath,
    workspacesDir: deps.config.workspacesDir ?? defaults.workspaces,
    tmpDir: deps.config.tmpDir ?? defaults.tmp,
    backupsDir: deps.config.backupsDir ?? defaults.backups,
    pluginsDir: deps.config.pluginsDir ?? defaults.plugins,
    dshHomeDir: deps.config.dshHomeDir ?? defaults.dshHome,
  }

  if (key === 'dataDir') {
    paths.dbDir = deps.config.dataDirEnvLocked
      ? currentDbDir
      : settings.paths.database ?? defaults.database
    paths.dbPath = deps.config.dataDirEnvLocked ? deps.config.dbPath : join(paths.dbDir, 'eab.db')
    paths.workspacesDir = settings.paths.workspaces ?? defaults.workspaces
    paths.tmpDir = settings.paths.tmp ?? defaults.tmp
    paths.backupsDir = settings.paths.backups ?? defaults.backups
    paths.pluginsDir = deps.config.pluginsEnvLocked
      ? deps.config.pluginsDir ?? defaults.plugins
      : settings.paths.plugins ?? defaults.plugins
    paths.dshHomeDir = settings.paths.dshHome ?? defaults.dshHome
    return paths
  }

  switch (key) {
    case 'database':
      paths.dbDir = target
      paths.dbPath = join(target, 'eab.db')
      break
    case 'workspaces':
      paths.workspacesDir = target
      break
    case 'tmp':
      paths.tmpDir = target
      break
    case 'backups':
      paths.backupsDir = target
      break
    case 'plugins':
      paths.pluginsDir = target
      break
    case 'dshHome':
      paths.dshHomeDir = target
      break
  }
  return paths
}

function applyResultView(deps: ServerDeps, moved: string[], skipped: string[]): {
  applied: true
  restartRequired: false
  moved: string[]
  skipped: string[]
  storage: ReturnType<typeof storageView>
  hint: string
} {
  return {
    applied: true,
    restartRequired: false,
    moved,
    skipped,
    storage: storageView(deps, readConsoleSettings()),
    hint: moved.length
      ? `已立即迁移并切换；旧目录保留。新位置：${moved.join('；')}`
      : '已立即切换；没有需要搬迁的旧数据，旧目录保留。',
  }
}

const BRAND_ICON_MAX_CHARS = 360_000
const BRAND_ICON_MIMES = ['png', 'jpeg', 'webp', 'svg+xml', 'x-icon', 'vnd.microsoft.icon']

function brandText(raw: unknown, label: string, max: number, fallback: string): string {
  if (raw === undefined) return fallback
  if (typeof raw !== 'string') throw new EabError(EC.VALIDATION, `${label}必须是文本`)
  const value = raw.trim()
  if (!value) throw new EabError(EC.VALIDATION, `${label}不能为空`)
  if ([...value].length > max) throw new EabError(EC.VALIDATION, `${label}最多 ${max} 个字符`)
  return value
}

function brandIcon(raw: unknown, fallback: string | null): string | null {
  if (raw === undefined) return fallback
  if (raw === null || raw === '') return null
  if (typeof raw !== 'string') throw new EabError(EC.VALIDATION, '图标必须是图片 Data URL')
  const value = raw.trim()
  if (value.length > BRAND_ICON_MAX_CHARS) {
    throw new EabError(EC.VALIDATION, '图标文件不能超过 256KB')
  }
  const comma = value.indexOf(',')
  const header = comma >= 0 ? value.slice(0, comma) : ''
  if (!header.startsWith('data:image/') || !header.includes(';base64')) {
    throw new EabError(EC.VALIDATION, '图标必须是 base64 编码的图片')
  }
  const mime = header.slice('data:image/'.length).split(';')[0]?.toLowerCase() ?? ''
  if (!BRAND_ICON_MIMES.includes(mime)) {
    throw new EabError(EC.VALIDATION, '图标只支持 PNG、JPEG、WebP、SVG 或 ICO')
  }
  return value
}

function parseBrandSurface(raw: unknown, fallback: BrandSurfaceSettings, label: string): BrandSurfaceSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    logoText: brandText(source.logoText, `${label}图标文字`, 8, fallback.logoText),
    brandName: brandText(source.brandName, `${label}品牌名称`, 40, fallback.brandName),
    tabTitle: brandText(source.tabTitle, `${label}标签页标题`, 80, fallback.tabTitle),
    iconDataUrl: brandIcon(source.iconDataUrl, fallback.iconDataUrl),
  }
}

function parseBranding(raw: unknown, current: BrandingSettings): BrandingSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    console: parseBrandSurface(source.console, current.console, '管理控制台'),
    chat: parseBrandSurface(source.chat, current.chat, '员工对话'),
  }
}

function storageView(deps: ServerDeps, settings: ConsoleSettings): {  baseDir: string
  dbPath: string
  dbSizeBytes: number
  rows: StorageRowView[]
  pendingMigrations: StorageMigration[]
  envLocked: boolean
  pluginsEnvLocked: boolean
} {
  const base = deps.config.dataDir ?? defaultHomeDir()
  const defaults = storageDefaults(base)
  let dbSizeBytes = 0
  try {
    dbSizeBytes = statSync(deps.config.dbPath).size
  } catch {
    dbSizeBytes = 0
  }
  const rows: StorageRowView[] = [
    {
      key: 'dataDir',
      label: STORAGE_LABELS.dataDir,
      path: base,
      configured: settings.dataDir,
      defaultPath: defaultHomeDir(),
      source: settings.dataDir ? '独立配置' : '部署默认',
      locked: false,
    },
  ]
  for (const key of STORAGE_KEYS) {
    const configured = settings.paths[key]
    rows.push({
      key,
      label: STORAGE_LABELS[key],
      path: currentStoragePath(deps, key),
      configured,
      defaultPath: defaults[key],
      source: configured ? '独立配置' : '跟随总位置',
      locked: isLocked(deps, key),
    })
  }
  return {
    baseDir: base,
    dbPath: deps.config.dbPath,
    dbSizeBytes,
    rows,
    pendingMigrations: settings.pendingMigrations,
    envLocked: Boolean(deps.config.dataDirEnvLocked),
    pluginsEnvLocked: Boolean(deps.config.pluginsEnvLocked),
  }
}

export function registerSettingsRoutes(app: FastifyInstance, deps: ServerDeps): void {
  type PendingNativePick = {
    done: boolean
    path: string
    canceled: boolean
    error?: string
    cleanup: ReturnType<typeof setTimeout>
  }
  const pendingNativePicks = new Map<string, PendingNativePick>()

  // 品牌设置要在登录页也能读到，所以单独提供一个公开只读接口；
  // 写入仍必须走控制台会话。
  app.get('/api/branding', async () => {
    return ok({ branding: readConsoleSettings().branding })
  })

  app.get('/api/console/settings', async (req) => {
    requireConsole(req, deps)
    const settings = readConsoleSettings()
    const network = effectiveNetwork(deps.config)
    let dbSizeBytes = 0
    try {
      dbSizeBytes = statSync(deps.config.dbPath).size
    } catch {
      dbSizeBytes = 0
    }
    return ok({
      dataDir: deps.config.dataDir ?? '',
      dbPath: deps.config.dbPath,
      dbSizeBytes,
      envLocked: Boolean(deps.config.dataDirEnvLocked),
      storage: storageView(deps, settings),
      branding: settings.branding,
      retentionDays: settings.logRetentionDays,
      auditRetentionDays: settings.auditRetentionDays,
      agentRetentionDays: settings.agentRetentionDays,
      agentTeam: agentTeamSettingsView(deps.config),
      recordRetentionDays: settings.recordRetentionDays,
      workspaceRecycleDays: settings.workspaceRecycleDays,
      lastCleanupAt: settings.lastCleanupAt,
      lastCleanupStats: settings.lastCleanupStats,
      network: {
        host: network.host,
        chatPort: network.chatPort,
        adminPort: network.adminPort,
        allowRemoteConsole: network.allowRemoteConsole,
        envLocked: deps.config.networkEnvLocked ?? {
          host: false,
          chatPort: false,
          adminPort: false,
          allowRemoteConsole: false,
        },
        localAddresses: localAddresses(),
      },
      logs: {
        syncRuns: count(deps.db, 'SELECT COUNT(*) AS n FROM org_sync_runs'),
        syncDiffs: count(deps.db, 'SELECT COUNT(*) AS n FROM org_sync_diffs'),
        channelEvents: count(deps.db, 'SELECT COUNT(*) AS n FROM channel_events'),
        loginAttempts: count(deps.db, 'SELECT COUNT(*) AS n FROM login_attempts'),
        pluginEvents: count(deps.db, 'SELECT COUNT(*) AS n FROM plugin_events'),
        onboardAttempts: count(deps.db, 'SELECT COUNT(*) AS n FROM dingtalk_onboard_attempts'),
        auditLogs: count(deps.db, 'SELECT COUNT(*) AS n FROM audit_logs'),
        databaseQueries: count(
          deps.db,
          "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'database.query'",
        ),
        agentRuns: count(deps.db, 'SELECT COUNT(*) AS n FROM agent_runs'),
        agentSteps: count(deps.db, 'SELECT COUNT(*) AS n FROM agent_steps'),
        chatSessions: count(deps.db, 'SELECT COUNT(*) AS n FROM chat_sessions'),
        chatMessages: count(deps.db, 'SELECT COUNT(*) AS n FROM chat_messages'),
        workspaceVersions: count(deps.db, 'SELECT COUNT(*) AS n FROM workspace_file_versions'),
        toolOperations: count(deps.db, 'SELECT COUNT(*) AS n FROM tool_operations'),
        skillEvents: count(deps.db, 'SELECT COUNT(*) AS n FROM skill_events'),
        agentTeamMessages: count(deps.db, 'SELECT COUNT(*) AS n FROM agent_team_messages'),
        scheduleRuns: count(deps.db, 'SELECT COUNT(*) AS n FROM schedule_runs'),
        asyncJobs: count(deps.db, 'SELECT COUNT(*) AS n FROM async_jobs'),
        workspaceDeletedRows: count(
          deps.db,
          'SELECT COUNT(*) AS n FROM workspace_files WHERE deleted_at IS NOT NULL',
        ),
        workspaceRecycleFiles: count(
          deps.db,
          'SELECT COUNT(*) AS n FROM workspace_files WHERE deleted_at IS NOT NULL AND recycled_path IS NOT NULL',
        ),
        workspaceRecycleBytes: sum(
          deps.db,
          'SELECT SUM(size) AS n FROM workspace_files WHERE deleted_at IS NOT NULL AND recycled_path IS NOT NULL',
        ),
      },
    })
  })

  app.put<{
    Body: Record<string, unknown>
  }>('/api/console/settings/branding', async (req) => {
    requireConsole(req, deps)
    const current = readConsoleSettings()
    const branding = parseBranding(req.body, current.branding)
    const settings = writeConsoleSettings({ branding })
    audit(deps, req, 'ops.settings.branding', {
      console: { ...branding.console, iconDataUrl: branding.console.iconDataUrl ? '[uploaded]' : null },
      chat: { ...branding.chat, iconDataUrl: branding.chat.iconDataUrl ? '[uploaded]' : null },
    })
    return ok({ branding: settings.branding, applied: true })
  })

  app.put<{
    Body: { days?: number; auditDays?: number; agentDays?: number; recordDays?: number; workspaceDays?: number }
  }>('/api/console/settings/retention', async (req) => {
    requireConsole(req, deps)
    const current = readConsoleSettings()
    const days = req.body?.days === undefined ? current.logRetentionDays : Number(req.body?.days)
    const auditDays =
      req.body?.auditDays === undefined ? current.auditRetentionDays : Number(req.body?.auditDays)
    const agentDays =
      req.body?.agentDays === undefined ? current.agentRetentionDays : Number(req.body?.agentDays)
    const recordDays =
      req.body?.recordDays === undefined ? current.recordRetentionDays : Number(req.body?.recordDays)
    const workspaceDays =
      req.body?.workspaceDays === undefined ? current.workspaceRecycleDays : Number(req.body?.workspaceDays)
    for (const [label, value] of [
      ['日志保留天数', days],
      ['审计保留天数', auditDays],
      ['Agent 轨迹保留天数', agentDays],
      ['项目记录保留天数', recordDays],
      ['回收区保留天数', workspaceDays],
    ] as const) {
      if (!Number.isInteger(value) || value < 0 || (value > 0 && value < 7) || value > 3650) {
        throw new EabError(EC.VALIDATION, `${label}只能是 0（永久保留）或 7–3650 天`)
      }
    }
    const settings = writeConsoleSettings({
      logRetentionDays: days,
      auditRetentionDays: auditDays,
      agentRetentionDays: agentDays,
      recordRetentionDays: recordDays,
      workspaceRecycleDays: workspaceDays,
    })
    audit(deps, req, 'ops.settings.retention', { days, auditDays, agentDays, recordDays, workspaceDays })
    return ok({
      retentionDays: settings.logRetentionDays,
      auditRetentionDays: settings.auditRetentionDays,
      agentRetentionDays: settings.agentRetentionDays,
      recordRetentionDays: settings.recordRetentionDays,
      workspaceRecycleDays: settings.workspaceRecycleDays,
      applied: true,
    })
  })

  app.put<{
    Body: { maxWorkers?: unknown }
  }>('/api/console/settings/agent-team', async (req) => {
    requireConsole(req, deps)
    const before = effectiveAgentTeamSettings(deps.config)
    const raw = req.body?.maxWorkers
    if (raw === undefined) throw new EabError(EC.VALIDATION, '缺少 maxWorkers')
    const next = raw === null || raw === '' ? null : normalizeAgentMaxWorkers(raw)
    if (raw !== null && raw !== '' && next === null) {
      throw new EabError(EC.VALIDATION, '每会话活跃岗位上限只能是 1–32 的整数')
    }
    const settings = writeConsoleSettings({
      agentTeam: { maxWorkers: next },
    })
    const after = effectiveAgentTeamSettings(deps.config)
    audit(deps, req, 'ops.settings.agent-team', {
      before: { maxWorkers: before.maxWorkers, source: before.source },
      after: { maxWorkers: after.maxWorkers, source: after.source },
      configured: settings.agentTeam.maxWorkers,
    })
    return ok({
      agentTeam: agentTeamSettingsView(deps.config),
      applied: true,
      scope: 'global',
    })
  })

  app.post('/api/console/settings/retention/run', async (req) => {
    requireConsole(req, deps)
    const settings = readConsoleSettings()
    const workspaceRoot = workspaceRootFor(deps.config.dbPath, deps.config.workspacesDir)
    const result = runRetention(
      deps.db,
      settings.logRetentionDays,
      settings.auditRetentionDays,
      settings.agentRetentionDays,
      settings.recordRetentionDays,
      workspaceRoot,
    )
    const workspaceRecycle = pruneWorkspaceRecycle(
      deps.db,
      workspaceRoot,
      settings.workspaceRecycleDays,
    )
    const stats = { ...result.deleted }
    if (workspaceRecycle.files > 0) stats.workspaceRecycleFiles = workspaceRecycle.files
    if (workspaceRecycle.bytes > 0) stats.workspaceRecycleBytes = workspaceRecycle.bytes
    if (workspaceRecycle.rows > 0) stats.workspaceRecycleRows = workspaceRecycle.rows
    writeConsoleSettings({ lastCleanupAt: new Date().toISOString(), lastCleanupStats: stats })
    audit(deps, req, 'ops.settings.retention.run', {
      days: result.days,
      auditDays: result.audit.days,
      agentDays: result.agentDays,
      recordDays: result.recordDays,
      deleted: result.deleted,
      project: result.project,
      workspaceRecycle,
    })
    return ok({ ...result, deleted: stats, workspaceRecycle })
  })

  app.put<{
    Body: { host?: string; chatPort?: number; adminPort?: number; allowRemoteConsole?: boolean }
  }>('/api/console/settings/network', async (req, reply) => {
    requireConsole(req, deps)
    const locked = deps.config.networkEnvLocked ?? {
      host: false,
      chatPort: false,
      adminPort: false,
      allowRemoteConsole: false,
    }
    const body = req.body ?? {}
    const current = effectiveNetwork(deps.config)
    const next = {
      host: body.host === undefined ? current.host : String(body.host).trim(),
      chatPort: body.chatPort === undefined ? current.chatPort : readPort(body.chatPort, '员工对话端口'),
      adminPort: body.adminPort === undefined ? current.adminPort : readPort(body.adminPort, '管理控制台端口'),
      allowRemoteConsole:
        body.allowRemoteConsole === undefined ? current.allowRemoteConsole : Boolean(body.allowRemoteConsole),
    }
    if (!validHost(next.host)) {
      throw new EabError(EC.VALIDATION, `监听地址不合法：${next.host}`, { hint: '本机用 127.0.0.1，局域网用 0.0.0.0' })
    }
    if (next.chatPort === next.adminPort) {
      throw new EabError(EC.VALIDATION, '员工对话端口和管理控制台端口不能相同')
    }
    for (const key of ['host', 'chatPort', 'adminPort', 'allowRemoteConsole'] as const) {
      if (locked[key] && next[key] !== current[key]) {
        throw new EabError(EC.FORBIDDEN, `${key} 已由 EAB_* 环境变量固定，控制台不能修改`, {
          hint: '去掉对应环境变量后重启，才能在这里调整网络设置',
        })
      }
    }
    const settings = writeConsoleSettings({
      host: next.host,
      chatPort: next.chatPort,
      adminPort: next.adminPort,
      allowRemoteConsole: next.allowRemoteConsole,
    })
    audit(deps, req, 'ops.settings.network', next)

    const hostChanged = next.host !== current.host
    const chatChanged = next.chatPort !== current.chatPort
    const adminChanged = next.adminPort !== current.adminPort
    const listenerChanged = hostChanged || chatChanged || adminChanged
    const remoteChanged = next.allowRemoteConsole !== current.allowRemoteConsole
    const changed = listenerChanged || remoteChanged
    const switching = listenerChanged && Boolean(deps.applyNetwork)
    const restartRequired = listenerChanged && !deps.applyNetwork

    if (switching && deps.applyNetwork) {
      const apply = deps.applyNetwork
      // 响应先把新地址和状态交给页面，再在连接空闲后重建监听，避免响应被自己关掉。
      reply.raw.once('finish', () => {
        void Promise.resolve(apply(next)).then((result) => {
          if (!result.rebound && result.error) console.error(`[eab] 网络监听切换失败：${result.error}`)
        })
      })
    }

    return ok({
      ...settings,
      network: next,
      changed,
      applied: changed && !switching,
      switching,
      restartRequired,
      hint: switching
        ? '正在切换监听，页面会自动跳到新地址'
        : changed
          ? restartRequired
            ? '已保存；重启服务后生效'
            : next.allowRemoteConsole
              ? '已立即生效；局域网访问还需要放行防火墙端口'
              : '已立即生效；控制台现在只允许本机登录'
          : '网络设置没有变化',
    })
  })

  app.get<{ Querystring: { path?: string } }>('/api/console/system/directories', async (req) => {
    requireConsole(req, deps)
    return ok(listServerDirectories(String(req.query?.path ?? '')))
  })

  app.post<{ Body: { initial?: string } }>('/api/console/system/pick-directory', async (req) => {
    requireConsole(req, deps)
    const initial = String(req.body?.initial ?? '').trim()
    if (initial.includes('\0')) {
      throw new EabError(EC.VALIDATION, '初始目录包含非法字符')
    }
    if (initial && !isAbsolute(initial)) {
      throw new EabError(EC.VALIDATION, '初始目录必须是绝对路径')
    }

    // 远程管理后台不弹服务器桌面上的原生框，改为在前端浏览服务器目录。
    const forwarded = req.headers['x-forwarded-for']
    if (!requestIsLocal(req.socket.remoteAddress, forwarded) || !hasInteractiveWindowsDesktop()) {
      return ok({
        path: '',
        canceled: false,
        mode: 'browse',
        hint: hasInteractiveWindowsDesktop()
          ? '检测到远程访问，已打开服务器目录浏览'
          : '当前服务没有可交互的 Windows 桌面，已打开服务器目录浏览',
      })
    }

    try {
      const ticket = randomUUID()
      const entry: PendingNativePick = {
        done: false,
        path: '',
        canceled: false,
        cleanup: setTimeout(() => pendingNativePicks.delete(ticket), 10 * 60_000),
      }
      entry.cleanup.unref?.()
      pendingNativePicks.set(ticket, entry)
      void pickSystemDirectory(initial)
        .then((path) => {
          entry.done = true
          entry.path = path ?? ''
          entry.canceled = path === null
        })
        .catch((error: unknown) => {
          entry.done = true
          entry.error = error instanceof Error ? error.message : String(error)
        })
      // 先返回 native + ticket，原生框在后台启动并保持；前端轮询结果，
      // 不再让一个 HTTP 请求一直挂到用户关掉系统框。
      return ok({ path: '', canceled: false, mode: 'native', pending: true, ticket })
    } catch (error) {
      if (!(error instanceof EabError)) throw error
      // 原生框不可用时不要让用户卡在超时错误，直接回退到服务器目录浏览。
      return ok({
        path: '',
        canceled: false,
        mode: 'browse',
        hint: error.message,
      })
    }
  })

  app.get<{ Querystring: { ticket?: string } }>(
    '/api/console/system/pick-directory/result',
    async (req) => {
      requireConsole(req, deps)
      const ticket = String(req.query?.ticket ?? '').trim()
      const entry = pendingNativePicks.get(ticket)
      if (!entry) {
        throw new EabError(EC.VALIDATION, '目录选择已失效，请重新点击「选择目录…」')
      }
      const body = {
        done: entry.done,
        path: entry.path,
        canceled: entry.canceled,
        ...(entry.error ? { error: entry.error } : {}),
      }
      if (entry.done) {
        clearTimeout(entry.cleanup)
        pendingNativePicks.delete(ticket)
      }
      return ok(body)
    },
  )

  app.put<{ Body: { key?: StorageSettingKey; path?: string | null; reset?: boolean } }>(
    '/api/console/settings/storage',
    async (req) => {
      requireConsole(req, deps)
      const key = req.body?.key
      if (!key || !['dataDir', ...STORAGE_KEYS].includes(key)) {
        throw new EabError(EC.VALIDATION, '存储分类不合法')
      }
      if (isLocked(deps, key)) {
        throw new EabError(EC.FORBIDDEN, `${typeLabel(key)}由环境变量固定，控制台不能改`, {
          hint: key === 'plugins' ? '去掉 EAB_PLUGINS_DIR 后重启' : '去掉 EAB_DB 后重启',
        })
      }
      const settings = readConsoleSettings()
      if (settings.pendingMigrations.length > 0) {
        throw new EabError(EC.CONFLICT, '已有待执行的存储迁移，请先重启服务完成后再改下一项', {
          hint: '待迁移目标：' + settings.pendingMigrations.map((job) => job.to).join('；'),
        })
      }

      const reset = Boolean(req.body?.reset) || req.body?.path === null
      const input = String(req.body?.path ?? '').trim()
      if (!reset && !input) throw new EabError(EC.VALIDATION, `${typeLabel(key)}路径不能为空`)
      if (!reset && !isAbsolute(input)) throw new EabError(EC.VALIDATION, '请填写绝对路径，例如 D:\\EABData')

      const base = deps.config.dataDir ?? defaultHomeDir()
      const defaults = storageDefaults(base)
      const nextBase = key === 'dataDir' ? (reset ? defaultHomeDir() : resolve(input)) : null
      const target =
        key === 'dataDir'
          ? nextBase!
          : reset
            ? defaults[key]
            : resolve(input)
      if (isRootPath(target)) {
        throw new EabError(EC.VALIDATION, '不能把存储位置直接设到盘符根目录，请选择一个具体目录')
      }

      const current = currentStoragePath(deps, key)
      if (resolve(current) === resolve(target)) {
        return ok({ key, path: target, changed: false, restartRequired: false })
      }
      if (isNested(current, target) || isNested(target, current)) {
        throw new EabError(EC.VALIDATION, '新路径不能放在当前路径内部，也不能把当前路径包含进去')
      }
      for (const other of STORAGE_KEYS) {
        if (other === key) continue
        if (resolve(currentStoragePath(deps, other)) === resolve(target)) {
          throw new EabError(EC.CONFLICT, `这个路径已经被「${typeLabel(other)}」占用`)
        }
      }
      ensureNonEmptyTarget(target)
      probeWritable(target)

      const jobs: StorageMigration[] = []
      let settingsPatch: Partial<ConsoleSettings>
      if (key === 'dataDir') {
        jobs.push(...baseMigrationJobs(deps, settings, target))
        settingsPatch = { dataDir: reset ? null : target }
      } else {
        const from = current
        jobs.push({
          key,
          kind: key === 'database' ? 'database' : 'directory',
          from,
          to: target,
          createdAt: new Date().toISOString(),
        })
        settingsPatch = {
          paths: { ...settings.paths, [key]: reset ? null : target },
        }
      }

      if (deps.applyStorage) {
        const paths = storagePathsAfter(deps, settings, key, target)
        const result = await deps.applyStorage({
          key,
          target,
          settingsPatch,
          paths,
          jobs,
        })
        audit(deps, req, 'ops.settings.storage', {
          key,
          from: current,
          to: target,
          reset,
          jobs: jobs.length,
          applied: true,
        })
        return ok({
          key,
          path: target,
          changed: true,
          ...applyResultView(deps, result.moved, result.skipped),
        })
      }

      const next = writeConsoleSettings({ ...settingsPatch, pendingMigrations: jobs })
      audit(deps, req, 'ops.settings.storage', { key, from: current, to: target, reset, jobs: jobs.length })
      return ok({
        key,
        path: target,
        changed: true,
        restartRequired: true,
        pendingMigrations: next.pendingMigrations,
        hint:
          jobs.length > 0
            ? `已保存；重启后先把旧目录复制到 ${target}，校验通过才切换。旧目录会保留。`
            : '已保存；重启后生效。旧目录没有可搬迁的数据。',
      })
    },
  )

  app.put<{ Body: { path?: string | null; reset?: boolean } }>('/api/console/settings/data-dir', async (req) => {
    requireConsole(req, deps)
    if (deps.config.dataDirEnvLocked) {
      throw new EabError(EC.FORBIDDEN, '数据目录由环境变量 EAB_DB 固定，控制台不能改', {
        hint: '去掉 EAB_DB 后重启，才能在这里切换数据目录',
      })
    }
    const reset = Boolean(req.body?.reset)
    const input = String(req.body?.path ?? '').trim()
    if (!reset && !input) throw new EabError(EC.VALIDATION, '数据目录不能为空')
    if (!reset && !isAbsolute(input)) throw new EabError(EC.VALIDATION, '请填写绝对路径，例如 D:\\EABData')

    let dataDir: string | null = null
    if (!reset) {
      dataDir = resolve(input)
    }
    const target = dataDir ?? defaultHomeDir()
    if (isRootPath(target)) throw new EabError(EC.VALIDATION, '不能把存储位置直接设到盘符根目录')
    const current = deps.config.dataDir ?? ''
    if (dataDir && current && resolve(current) === dataDir) {
      return ok({ dataDir: current, changed: false, restartRequired: false })
    }
    if (isNested(current, target) || isNested(target, current)) {
      throw new EabError(EC.VALIDATION, '新路径不能放在当前路径内部，也不能把当前路径包含进去')
    }
    for (const other of STORAGE_KEYS) {
      if (resolve(currentStoragePath(deps, other)) === resolve(target)) {
        throw new EabError(EC.CONFLICT, `这个路径已经被「${typeLabel(other)}」占用`)
      }
    }
    const settingsBefore = readConsoleSettings()
    if (settingsBefore.pendingMigrations.length > 0) {
      throw new EabError(EC.CONFLICT, '已有待执行的存储迁移，请先重启服务完成后再改下一项')
    }
    ensureNonEmptyTarget(target)
    probeWritable(target)
    const jobs = baseMigrationJobs(deps, settingsBefore, target)
    const settingsPatch: Partial<ConsoleSettings> = { dataDir }
    if (deps.applyStorage) {
      const paths = storagePathsAfter(deps, settingsBefore, 'dataDir', target)
      const result = await deps.applyStorage({ key: 'dataDir', target, settingsPatch, paths, jobs })
      audit(deps, req, 'ops.settings.data_dir', { dataDir, reset, jobs: jobs.length, applied: true })
      return ok({
        dataDir: deps.config.dataDir ?? '',
        changed: true,
        savedAt: deps.config.dataDir,
        ...applyResultView(deps, result.moved, result.skipped),
        hint: reset
          ? '已立即回到部署目录并切换；旧目录保留'
          : '已按新的总存储位置立即迁移并切换；旧目录保留',
      })
    }
    const settings = writeConsoleSettings({ dataDir, pendingMigrations: jobs })
    audit(deps, req, 'ops.settings.data_dir', { dataDir, reset, jobs: jobs.length })
    return ok({
      dataDir: dataDir ?? '',
      changed: true,
      restartRequired: true,
      savedAt: settings.dataDir,
      pendingMigrations: settings.pendingMigrations,
      hint: reset ? '重启后回到部署目录 .eab-dev；旧目录会保留' : '重启后按新的总存储位置搬迁未单独配置的分类；旧目录会保留',
    })
  })
}
