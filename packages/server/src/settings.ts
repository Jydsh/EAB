/**
 * 控制台运行设置（可在线修改、落盘、重启后生效）。
 *
 * 为什么单独放文件而不是数据库：
 * - 存储路径决定数据库文件放哪，必须在开库之前就知道，所以不能存在库里。
 * - `logRetentionDays` 属于运维策略，跟库放在同一个文件里，跟着数据目录一起走。
 *
 * 文件位置固定在部署根目录 `.eab-dev/console-settings.json`（引导文件），
 * 即使业务数据搬到别的盘，这个指针文件仍留在部署目录，用来找到真正的数据目录。
 *
 * 存储位置分两层：
 * - `dataDir`：总存储位置，所有分类的默认根；
 * - `paths`：每类存储的独立绝对路径；配了就优先用独立路径，没配才跟随 `dataDir`。
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 部署目录：桌面端可通过 EAB_HOME 指到 %APPDATA%\\EAB\\data，源码部署默认仓库 .eab-dev。 */
export function defaultHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const custom = (env.EAB_HOME ?? '').trim()
  if (custom) return resolve(custom)
  return fileURLToPath(new URL('../../../.eab-dev', import.meta.url))
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultHomeDir(env), 'console-settings.json')
}

/** 兼容旧调用；EAB_HOME 在进程启动前设置时才会生效。 */
export const SETTINGS_PATH = settingsPath()
const DB_FILE = 'eab.db'

/** 可独立配置的存储分类。`dataDir` 是总位置，不在这里。 */
export type StoragePathKey = 'database' | 'workspaces' | 'tmp' | 'backups' | 'plugins' | 'dshHome'
export type StorageSettingKey = 'dataDir' | StoragePathKey

export interface StoragePathOverrides {
  /** 数据库目录（eab.db、secrets.json、管理员凭据都在这里） */
  database: string | null
  /** 个人 / 部门 / 公司云空间根目录 */
  workspaces: string | null
  /** 临时文件目录 */
  tmp: string | null
  /** 数据库备份目录 */
  backups: string | null
  /** 插件安装目录 */
  plugins: string | null
  /** 插件运行数据目录（DSH_HOME 隔离树） */
  dshHome: string | null
}

export interface StorageMigration {
  key: StoragePathKey
  /** 数据库分类只搬库文件与凭据，不搬整个目录 */
  kind: 'database' | 'directory'
  from: string
  to: string
  createdAt: string
}

/** 保存存储位置时交给运行时执行的目标路径集合。 */
export interface StorageApplyPaths {
  dataDir: string
  dbDir: string
  dbPath: string
  workspacesDir: string
  tmpDir: string
  backupsDir: string
  pluginsDir: string
  dshHomeDir: string
}

/** 控制台保存某一类存储位置时的完整执行计划。 */
export interface StorageApplyPlan {
  key: StorageSettingKey
  target: string
  /** 成功后才写入的设置补丁 */
  settingsPatch: Partial<ConsoleSettings>
  paths: StorageApplyPaths
  /** 需要复制的目录；database 分类由运行时用 SQLite 快照单独处理 */
  jobs: readonly StorageMigration[]
}

export interface StorageApplyResult {
  moved: string[]
  skipped: string[]
}


export interface NetworkSettings {
  /** 监听地址；null 表示用默认 127.0.0.1 */
  host: string | null
  /** 员工对话端口；null 表示默认 8787 */
  chatPort: number | null
  /** 管理控制台端口；null 表示默认 8788 */
  adminPort: number | null
  /** 是否允许非本机地址登录控制台 */
  allowRemoteConsole: boolean
}

/**
 * 控制台 / 员工对话的品牌外观。
 *
 * 图标以 data URL 存在 console-settings.json 里，避免为了一个 favicon
 * 再引入单独的上传目录；数据只由控制台写入，读取端只用来渲染 img/favicon。
 */
export interface BrandSurfaceSettings {
  /** 没有上传图标时，Logo 方块里显示的字；上传图标后以图标为准 */
  logoText: string
  /** 图标旁的应用内品牌名称 */
  brandName: string
  /** 浏览器标签页标题 */
  tabTitle: string
  /** 自定义 favicon / 品牌图标；null 表示沿用默认标记 */
  iconDataUrl: string | null
}

export interface BrandingSettings {
  console: BrandSurfaceSettings
  chat: BrandSurfaceSettings
}

export const BRANDING_DEFAULTS: BrandingSettings = {
  console: {
    logoText: 'EAB',
    brandName: '企业智能体基座',
    tabTitle: 'EAB 管理控制台',
    iconDataUrl: null,
  },
  chat: {
    logoText: 'EAB',
    brandName: '企业AI智能体基座',
    tabTitle: 'EAB 工作台',
    iconDataUrl: null,
  },
}

/**
 * OnlyOffice 控制台绑定。
 *
 * URL 属于普通配置，直接落在 console-settings.json；JWT 密钥只保存 secret_ref，
 * 真实值在 secrets.json（或环境变量）里，页面永远不回显。
 */
export interface OnlyOfficeSettings {
  /** DocumentServer 的浏览器访问地址；null 表示未绑定 */
  url: string | null
  /** DocumentServer 回访 EAB 的内部地址；null 表示用部署默认值 */
  internalUrl: string | null
  /** JWT 密钥在 secrets.json 的引用名；null 表示未配置 */
  jwtSecretRef: string | null
}

export type BootAnimationMode = 'off' | 'code' | 'film'
export type BootPlayOn = 'login' | 'new-session' | 'always'

export interface BootSurfaceSettings {
  mode: BootAnimationMode
  /** 媒体库 ID；null 表示没有片源，film 会自动回退 code */
  assetId: string | null
  /** 片长上限（秒），也是电影片头的硬上限 */
  durationMax: number
  /** 是否允许用户点开声音；默认仍然静音起播 */
  allowSound: boolean
  /** 是否显示跳过 */
  allowSkip: boolean
  playOn: BootPlayOn
  title: string
  subtitle: string
}

export interface BootAnimationSettings {
  enabled: boolean
  /** 每次保存自增，用于客户端缓存失效 */
  revision: number
  admin: BootSurfaceSettings
  chat: BootSurfaceSettings
}

/** 公司级只允许覆盖员工端；管理端始终用全局配置。 */
export interface CompanyBootSettings {
  useGlobal: boolean
  chat: Partial<BootSurfaceSettings>
}

const DEFAULT_BOOT_SURFACE: BootSurfaceSettings = {
  mode: 'code',
  assetId: null,
  durationMax: 2.6,
  allowSound: false,
  allowSkip: true,
  playOn: 'login',
  title: 'EAB',
  subtitle: '企业智能体基座',
}

export const DEFAULT_BOOT_ANIMATION: BootAnimationSettings = {
  enabled: true,
  revision: 0,
  admin: { ...DEFAULT_BOOT_SURFACE, subtitle: '管理控制台', durationMax: 2.6 },
  chat: { ...DEFAULT_BOOT_SURFACE, durationMax: 6.5, allowSound: true },
}

export const DEFAULT_COMPANY_BOOT: CompanyBootSettings = {
  useGlobal: true,
  chat: {},
}

function normalizeBootText(raw: unknown, fallback: string, max = 60): string {
  const text = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : ''
  return text ? text.slice(0, max) : fallback
}

function readBootMode(raw: unknown, fallback: BootAnimationMode): BootAnimationMode {
  return raw === 'off' || raw === 'code' || raw === 'film' ? raw : fallback
}

function readBootPlayOn(raw: unknown, fallback: BootPlayOn): BootPlayOn {
  return raw === 'login' || raw === 'new-session' || raw === 'always' ? raw : fallback
}

function readBootSurface(raw: unknown, fallback: BootSurfaceSettings): BootSurfaceSettings {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const duration = Number(value.durationMax ?? fallback.durationMax)
  return {
    mode: readBootMode(value.mode, fallback.mode),
    assetId:
      typeof value.assetId === 'string' && /^boot-[a-f0-9]{24}$/.test(value.assetId)
        ? value.assetId
        : value.assetId === null
          ? null
          : fallback.assetId,
    durationMax:
      Number.isFinite(duration) && duration >= 0.8 && duration <= 8
        ? Math.round(duration * 10) / 10
        : fallback.durationMax,
    allowSound: value.allowSound === undefined ? fallback.allowSound : value.allowSound === true,
    allowSkip: value.allowSkip === undefined ? fallback.allowSkip : value.allowSkip === true,
    playOn: readBootPlayOn(value.playOn, fallback.playOn),
    title: normalizeBootText(value.title, fallback.title),
    subtitle: normalizeBootText(value.subtitle, fallback.subtitle),
  }
}

export function readBootAnimation(raw: unknown): BootAnimationSettings {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const revision = Number(value.revision)
  return {
    enabled: value.enabled === undefined ? DEFAULT_BOOT_ANIMATION.enabled : value.enabled === true,
    revision: Number.isFinite(revision) && revision >= 0 ? Math.trunc(revision) : 0,
    admin: readBootSurface(value.admin, DEFAULT_BOOT_ANIMATION.admin),
    chat: readBootSurface(value.chat, DEFAULT_BOOT_ANIMATION.chat),
  }
}

export function readCompanyBoot(raw: unknown): CompanyBootSettings {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const chat = value.chat && typeof value.chat === 'object' && !Array.isArray(value.chat)
    ? (value.chat as Record<string, unknown>)
    : {}
  const partial: Partial<BootSurfaceSettings> = {}
  if (value.chat && typeof value.chat === 'object') {
    if (chat.mode !== undefined) partial.mode = readBootMode(chat.mode, 'code')
    if (chat.assetId !== undefined) {
      partial.assetId =
        typeof chat.assetId === 'string' && /^boot-[a-f0-9]{24}$/.test(chat.assetId)
          ? chat.assetId
          : null
    }
    if (chat.durationMax !== undefined) {
      const duration = Number(chat.durationMax)
      if (Number.isFinite(duration) && duration >= 0.8 && duration <= 8) {
        partial.durationMax = Math.round(duration * 10) / 10
      }
    }
    if (chat.allowSound !== undefined) partial.allowSound = chat.allowSound === true
    if (chat.allowSkip !== undefined) partial.allowSkip = chat.allowSkip === true
    if (chat.playOn !== undefined) partial.playOn = readBootPlayOn(chat.playOn, 'login')
    if (chat.title !== undefined) partial.title = normalizeBootText(chat.title, 'EAB')
    if (chat.subtitle !== undefined) partial.subtitle = normalizeBootText(chat.subtitle, '企业智能体基座')
  }
  return {
    useGlobal: value.useGlobal === undefined ? DEFAULT_COMPANY_BOOT.useGlobal : value.useGlobal === true,
    chat: partial,
  }
}

/** Agent 团队运行策略；目前只开放每会话活跃岗位上限。 */
export interface AgentTeamSettings {
  /** 每会话活跃岗位上限；null 表示跟随环境变量/默认值。 */
  maxWorkers: number | null
}

/**
 * 控制台配置的联网搜索端点。
 *
 * provider 为 null 表示没有控制台覆盖，继续读环境变量；searxngUrl 只存普通地址，
 * 博查 / Tavily / Serper 的密钥按固定引用名写 secrets.json，页面只显示是否已配置。
 */
export interface WebSearchSettings {
  provider: 'searxng' | 'bocha' | 'tavily' | 'serper' | 'none' | null
  searxngUrl: string | null
}

/**
 * 浏览器内网访问策略。
 *
 * 默认关闭；只有管理员打开开关并显式列出域名/IP 后，内置浏览器才允许访问这些内网目标。
 * 公共域名不受 allowedHosts 限制，仍走正常公网校验。
 */
export interface BrowserNetworkSettings {
  allowPrivateNetwork: boolean
  allowedHosts: string[]
}

export interface ConsoleSettings extends NetworkSettings {
  /** 总存储位置；null 表示就用部署目录下的 .eab-dev */
  dataDir: string | null
  /** 每类存储的独立覆盖；null 表示跟随 dataDir */
  paths: StoragePathOverrides
  /** 下次启动前要执行的搬迁任务；成功后再清空 */
  pendingMigrations: StorageMigration[]
  /** 日志保留天数；0 = 永久保留 */
  logRetentionDays: number
  /** 审计保留天数；0 = 永久保留 */
  auditRetentionDays: number
  /** Agent 运行轨迹保留天数；0 = 永久保留（默认不清理） */
  agentRetentionDays: number
  /** 项目记录保留天数：会话、历史版本、工具/技能/团队/计划/异步任务记录；0 = 永久保留 */
  recordRetentionDays: number
  /** 云空间回收区保留天数；超过后物理删除 `_recycle` 文件并清理元数据 */
  workspaceRecycleDays: number
  /** 知识库召回测试记录保留天数；作用于所有知识库，1–365 天 */
  kbTestRetentionDays: number
  /** OnlyOffice 在线文档绑定 */
  onlyOffice: OnlyOfficeSettings
  /** 管理控制台 / 员工对话的品牌图标与标签文字 */
  branding: BrandingSettings
  /** 登录后启动动画：全局默认 + 公司覆盖 */
  bootAnimation: BootAnimationSettings
  /** Agent 团队运行策略；控制台显式值优先于环境变量 */
  agentTeam: AgentTeamSettings
  /** 联网搜索服务；控制台显式值优先于环境变量 */
  webSearch: WebSearchSettings
  /** 内置浏览器内网访问；默认关闭 */
  browserNetwork: BrowserNetworkSettings
  lastCleanupAt: string | null
  lastCleanupStats: Record<string, number> | null
}

function emptyPaths(): StoragePathOverrides {
  return { database: null, workspaces: null, tmp: null, backups: null, plugins: null, dshHome: null }
}

const DEFAULTS: ConsoleSettings = {
  dataDir: null,
  paths: emptyPaths(),
  pendingMigrations: [],
  logRetentionDays: 90,
  auditRetentionDays: 180,
  agentRetentionDays: 0,
  recordRetentionDays: 0,
  workspaceRecycleDays: 30,
  kbTestRetentionDays: 30,
  onlyOffice: { url: null, internalUrl: null, jwtSecretRef: null },
  branding: BRANDING_DEFAULTS,
  bootAnimation: DEFAULT_BOOT_ANIMATION,
  agentTeam: { maxWorkers: null },
  webSearch: { provider: null, searxngUrl: null },
  browserNetwork: { allowPrivateNetwork: false, allowedHosts: [] },
  lastCleanupAt: null,
  lastCleanupStats: null,
  host: null,
  chatPort: null,
  adminPort: null,
  allowRemoteConsole: false,
}

function defaultSettings(): ConsoleSettings {
  return {
    ...DEFAULTS,
    paths: emptyPaths(),
    pendingMigrations: [],
    branding: cloneBranding(BRANDING_DEFAULTS),
    bootAnimation: cloneBootAnimation(DEFAULT_BOOT_ANIMATION),
    agentTeam: { ...DEFAULTS.agentTeam },
    webSearch: { ...DEFAULTS.webSearch },
    browserNetwork: { ...DEFAULTS.browserNetwork, allowedHosts: [] },
  }
}

function readAgentTeam(raw: unknown): AgentTeamSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const maxWorkers = Number(source.maxWorkers)
  return {
    // 监听端口等配置用 0 表示“未配置”，这里也一样：范围外的值一律回落，
    // 真正的范围校验在保存接口里做，避免坏文件把服务卡死。
    maxWorkers:
      source.maxWorkers === null || source.maxWorkers === undefined
        ? null
        : Number.isInteger(maxWorkers) && maxWorkers >= 1 && maxWorkers <= 32
          ? maxWorkers
          : null,
  }
}

function readWebSearch(raw: unknown): WebSearchSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const provider = source.provider
  const url = readText(source.searxngUrl)
  let safeUrl: string | null = null
  if (url) {
    try {
      const parsed = new URL(url)
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password) {
        parsed.hash = ''
        safeUrl = parsed.href
      }
    } catch {
      safeUrl = null
    }
  }
  return {
    provider:
      provider === 'searxng' || provider === 'bocha' || provider === 'tavily' || provider === 'serper' || provider === 'none'
        ? provider
        : null,
    searxngUrl: safeUrl,
  }
}

function readBrowserNetwork(raw: unknown): BrowserNetworkSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const rawHosts = Array.isArray(source.allowedHosts) ? source.allowedHosts : []
  const allowedHosts = rawHosts
    .map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''))
    .filter(
      (item, index, list) =>
        item.length > 0 &&
        item.length <= 253 &&
        !/[\/@?#\s]/.test(item) &&
        list.indexOf(item) === index,
    )
    .slice(0, 200)
  return {
    // 开关只有在白名单非空时才真正生效；空名单等同于全部关闭，避免“一开全通”。
    allowPrivateNetwork: source.allowPrivateNetwork === true && allowedHosts.length > 0,
    allowedHosts,
  }
}

function cloneBootAnimation(value: BootAnimationSettings): BootAnimationSettings {
  return {
    enabled: value.enabled,
    revision: value.revision,
    admin: { ...value.admin },
    chat: { ...value.chat },
  }
}

function readPort(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : null
}

function readText(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

const ICON_DATA_URL_MAX = 360_000
const ICON_MIME_TYPES = ['png', 'jpeg', 'webp', 'svg+xml', 'x-icon', 'vnd.microsoft.icon']

function isIconDataUrl(value: string): boolean {
  if (value.length > ICON_DATA_URL_MAX) return false
  const comma = value.indexOf(',')
  if (comma < 0) return false
  const header = value.slice(0, comma)
  if (!header.startsWith('data:image/') || !header.includes(';base64')) return false
  const mime = header.slice('data:image/'.length).split(';')[0]?.toLowerCase() ?? ''
  return ICON_MIME_TYPES.includes(mime)
}

function cloneBranding(source: BrandingSettings): BrandingSettings {
  return {
    console: { ...source.console },
    chat: { ...source.chat },
  }
}

function readBrandSurface(raw: unknown, fallback: BrandSurfaceSettings): BrandSurfaceSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const icon = typeof source.iconDataUrl === 'string' && source.iconDataUrl.trim()
    ? source.iconDataUrl.trim()
    : null
  return {
    logoText: readText(source.logoText) ?? fallback.logoText,
    brandName: readText(source.brandName) ?? fallback.brandName,
    tabTitle: readText(source.tabTitle) ?? fallback.tabTitle,
    iconDataUrl: icon && isIconDataUrl(icon) ? icon : null,
  }
}

function readBranding(raw: unknown): BrandingSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    console: readBrandSurface(source.console, BRANDING_DEFAULTS.console),
    chat: readBrandSurface(source.chat, BRANDING_DEFAULTS.chat),
  }
}

const STORAGE_KEYS: readonly StoragePathKey[] = ['database', 'workspaces', 'tmp', 'backups', 'plugins', 'dshHome']

function readPaths(raw: unknown): StoragePathOverrides {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    database: readText(source.database),
    workspaces: readText(source.workspaces),
    tmp: readText(source.tmp),
    backups: readText(source.backups),
    plugins: readText(source.plugins),
    dshHome: readText(source.dshHome),
  }
}

function readMigrations(raw: unknown): StorageMigration[] {
  if (!Array.isArray(raw)) return []
  const jobs: StorageMigration[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const key = row.key
    const kind = row.kind
    const from = readText(row.from)
    const to = readText(row.to)
    if (!STORAGE_KEYS.includes(key as StoragePathKey)) continue
    if (kind !== 'database' && kind !== 'directory') continue
    if (!from || !to) continue
    jobs.push({
      key: key as StoragePathKey,
      kind,
      from,
      to,
      createdAt: readText(row.createdAt) ?? new Date().toISOString(),
    })
  }
  return jobs
}

function readOnlyOffice(raw: unknown): OnlyOfficeSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    url: readText(source.url),
    internalUrl: readText(source.internalUrl),
    jwtSecretRef: readText(source.jwtSecretRef),
  }
}

export function readConsoleSettings(): ConsoleSettings {
  const file = settingsPath()
  if (!existsSync(file)) return defaultSettings()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ConsoleSettings>
    const days = Number(raw.logRetentionDays ?? DEFAULTS.logRetentionDays)
    const auditDays = Number(raw.auditRetentionDays ?? DEFAULTS.auditRetentionDays)
    const agentDays = Number(raw.agentRetentionDays ?? DEFAULTS.agentRetentionDays)
    const recordDays = Number(raw.recordRetentionDays ?? DEFAULTS.recordRetentionDays)
    const workspaceRecycleDays = Number(raw.workspaceRecycleDays ?? DEFAULTS.workspaceRecycleDays)
    const kbTestRetentionDays = Number(raw.kbTestRetentionDays ?? DEFAULTS.kbTestRetentionDays)
    return {
      dataDir: readText(raw.dataDir),
      paths: readPaths(raw.paths),
      pendingMigrations: readMigrations(raw.pendingMigrations),
      logRetentionDays: Number.isFinite(days) && days >= 0 ? Math.trunc(days) : DEFAULTS.logRetentionDays,
      auditRetentionDays:
        Number.isFinite(auditDays) && auditDays >= 0 ? Math.trunc(auditDays) : DEFAULTS.auditRetentionDays,
      agentRetentionDays:
        Number.isFinite(agentDays) && agentDays >= 0 ? Math.trunc(agentDays) : DEFAULTS.agentRetentionDays,
      recordRetentionDays:
        Number.isFinite(recordDays) && recordDays >= 0 ? Math.trunc(recordDays) : DEFAULTS.recordRetentionDays,
      workspaceRecycleDays:
        Number.isFinite(workspaceRecycleDays) && workspaceRecycleDays >= 0
          ? Math.trunc(workspaceRecycleDays)
          : DEFAULTS.workspaceRecycleDays,
      kbTestRetentionDays:
        Number.isFinite(kbTestRetentionDays) && kbTestRetentionDays >= 1
          ? Math.min(365, Math.trunc(kbTestRetentionDays))
          : DEFAULTS.kbTestRetentionDays,
      onlyOffice: readOnlyOffice(raw.onlyOffice),
      branding: readBranding(raw.branding),
      bootAnimation: readBootAnimation(raw.bootAnimation),
      agentTeam: readAgentTeam(raw.agentTeam),
      webSearch: readWebSearch(raw.webSearch),
      browserNetwork: readBrowserNetwork(raw.browserNetwork),
      lastCleanupAt: typeof raw.lastCleanupAt === 'string' ? raw.lastCleanupAt : null,
      lastCleanupStats: raw.lastCleanupStats && typeof raw.lastCleanupStats === 'object' ? raw.lastCleanupStats : null,
      host: readText(raw.host),
      chatPort: readPort(raw.chatPort),
      adminPort: readPort(raw.adminPort),
      allowRemoteConsole: raw.allowRemoteConsole === true,
    }
  } catch {
    // 配置文件损坏时退回默认值，但绝不静默删掉它——留给人工检查
    return defaultSettings()
  }
}

export function writeConsoleSettings(patch: Partial<ConsoleSettings>): ConsoleSettings {
  const current = readConsoleSettings()
  const next: ConsoleSettings = { ...current, ...patch }
  if (patch.paths) next.paths = { ...current.paths, ...patch.paths }
  if (patch.onlyOffice) next.onlyOffice = { ...current.onlyOffice, ...patch.onlyOffice }
  if (patch.branding) next.branding = cloneBranding(patch.branding)
  if (patch.bootAnimation) {
    next.bootAnimation = cloneBootAnimation({
      ...current.bootAnimation,
      ...patch.bootAnimation,
      admin: { ...current.bootAnimation.admin, ...patch.bootAnimation.admin },
      chat: { ...current.bootAnimation.chat, ...patch.bootAnimation.chat },
    })
  }
  if (patch.pendingMigrations) next.pendingMigrations = patch.pendingMigrations
  if (patch.agentTeam) next.agentTeam = { ...current.agentTeam, ...patch.agentTeam }
  if (patch.webSearch) next.webSearch = { ...current.webSearch, ...patch.webSearch }
  if (patch.browserNetwork) {
    next.browserNetwork = {
      allowPrivateNetwork: patch.browserNetwork.allowPrivateNetwork,
      allowedHosts: [...patch.browserNetwork.allowedHosts],
    }
  }
  const file = settingsPath()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return next
}

export interface ResolvedStorage {
  /** 实际使用的数据库文件 */
  dbPath: string
  /** 数据库目录（eab.db、secrets.json、管理员凭据所在目录） */
  dbDir: string
  /** 总存储位置（所有未独立配置的分类都以它为根） */
  dataDir: string
  workspacesDir: string
  tmpDir: string
  backupsDir: string
  pluginsDir: string
  dshHomeDir: string
  /** 由设置文件指定并刚刚完成搬迁的来源目录，没有则为 null */
  migratedFrom: string | null
  /** 首次把仓库内置插件复制到数据目录时，记录来源 */
  pluginsSeededFrom: string | null
  /** 数据库路径由 EAB_DB 环境变量锁定（控制台不能再改目录） */
  envLocked: boolean
  /** 插件目录由 EAB_PLUGINS_DIR 环境变量锁定 */
  pluginsEnvLocked: boolean
  settings: ConsoleSettings
}

function normaliseDir(input: string): string {
  if (!isAbsolute(input)) throw new Error(`存储路径必须是绝对路径：${input}`)
  return resolve(input)
}

/** 每类存储的默认路径：数据库就是总位置，其余是总位置下的固定子目录。 */
export function storageDefaults(baseDir: string): Record<StoragePathKey, string> {
  return {
    database: baseDir,
    workspaces: join(baseDir, 'workspaces'),
    tmp: join(baseDir, 'tmp'),
    backups: join(baseDir, 'backups'),
    plugins: join(baseDir, 'plugins'),
    dshHome: join(baseDir, 'dsh-home'),
  }
}

/** 仓库自带的插件种子目录；首次启动时复制到可配置的插件目录。 */
export function legacyPluginsDir(): string {
  return fileURLToPath(new URL('../../../plugins', import.meta.url))
}

function portableStats(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  for (const name of [
    DB_FILE,
    `${DB_FILE}-wal`,
    `${DB_FILE}-shm`,
    'secrets.json',
    'admin-credentials.txt',
    'demo-accounts.txt',
  ]) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    files += 1
    try {
      bytes += lstatSync(file).size
    } catch {
      // 读不到大小时只校验数量
    }
  }
  return { files, bytes }
}

export function copyPortableDatabaseFiles(fromDir: string, toDir: string): void {
  const portable = [
    DB_FILE,
    `${DB_FILE}-wal`,
    `${DB_FILE}-shm`,
    'secrets.json',
    'admin-credentials.txt',
    'demo-accounts.txt',
  ]
  for (const name of portable) {
    const from = join(fromDir, name)
    if (!existsSync(from)) continue
    const to = join(toDir, name)
    if (existsSync(to)) continue
    cpSync(from, to)
  }
}

/**
 * 运行时切库只需要凭据类伴随文件。
 * 数据库本身由 `VACUUM INTO` 生成，绝不能把旧库的 -wal/-shm 复制到快照旁边。
 */
export function copyDatabaseCompanionFiles(fromDir: string, toDir: string): void {
  for (const name of ['secrets.json', 'admin-credentials.txt', 'demo-accounts.txt']) {
    const from = join(fromDir, name)
    if (!existsSync(from)) continue
    const to = join(toDir, name)
    if (existsSync(to)) continue
    cpSync(from, to)
  }
}

/**
 * 启动时解析存储位置。
 * 规则：EAB_DB（显式指定库文件） > 控制台设置独立路径 > 控制台设置 dataDir > 部署目录 .eab-dev。
 */
export function resolveStorage(
  defaultDbPath: string,
  envDb?: string,
  envPluginsDir?: string,
): ResolvedStorage {
  const settings = readConsoleSettings()
  const deployDir = dirname(defaultDbPath)
  const baseDir = settings.dataDir ? normaliseDir(settings.dataDir) : deployDir
  const envDbPath = envDb ? resolve(envDb) : null
  const dbDir = envDbPath
    ? dirname(envDbPath)
    : settings.paths.database
      ? normaliseDir(settings.paths.database)
      : baseDir
  const dbPath = envDbPath ?? join(dbDir, DB_FILE)
  const defaults = storageDefaults(baseDir)
  const workspacesDir = settings.paths.workspaces
    ? normaliseDir(settings.paths.workspaces)
    : defaults.workspaces
  const tmpDir = settings.paths.tmp ? normaliseDir(settings.paths.tmp) : defaults.tmp
  const backupsDir = settings.paths.backups ? normaliseDir(settings.paths.backups) : defaults.backups
  const pluginsDir = envPluginsDir
    ? normaliseDir(envPluginsDir)
    : settings.paths.plugins
      ? normaliseDir(settings.paths.plugins)
      : defaults.plugins
  const dshHomeDir = settings.paths.dshHome ? normaliseDir(settings.paths.dshHome) : defaults.dshHome

  let migratedFrom: string | null = null
  // 兼容旧路径：手工改过 dataDir、但没有 pending 任务时，首次仍把部署目录的库与配套文件带过去。
  if (!envDbPath && !settings.pendingMigrations.length && baseDir !== deployDir && !existsSync(dbPath) && existsSync(defaultDbPath)) {
    mkdirSync(dbDir, { recursive: true })
    copyPortableDatabaseFiles(deployDir, dbDir)
    if (!settings.paths.backups && !existsSync(backupsDir)) copyIfExists(join(deployDir, 'backups'), backupsDir)
    if (!settings.paths.workspaces && !existsSync(workspacesDir)) copyIfExists(join(deployDir, 'workspaces'), workspacesDir)
    if (!settings.paths.dshHome && !existsSync(dshHomeDir)) copyIfExists(join(deployDir, 'dsh-home'), dshHomeDir)
    migratedFrom = deployDir
  }

  let pluginsSeededFrom: string | null = null
  const legacyPlugins = legacyPluginsDir()
  if (!envPluginsDir && !settings.paths.plugins && !existsSync(pluginsDir) && existsSync(legacyPlugins)) {
    try {
      mkdirSync(dirname(pluginsDir), { recursive: true })
      cpSync(legacyPlugins, pluginsDir, { recursive: true, force: false, errorOnExist: false })
      pluginsSeededFrom = legacyPlugins
    } catch {
      // 插件目录复制失败不阻止启动：插件可以重新安装
    }
  }

  return {
    dbPath,
    dbDir,
    dataDir: baseDir,
    workspacesDir,
    tmpDir,
    backupsDir,
    pluginsDir,
    dshHomeDir,
    migratedFrom,
    pluginsSeededFrom,
    envLocked: Boolean(envDbPath),
    pluginsEnvLocked: Boolean(envPluginsDir),
    settings,
  }
}

function copyIfExists(from: string, to: string): void {
  if (!existsSync(from) || existsSync(to)) return
  cpSync(from, to, { recursive: true, force: false, errorOnExist: false })
}

function isNonEmptyDir(path: string): boolean {
  try {
    return statSync(path).isDirectory() && readdirSync(path).length > 0
  } catch {
    return false
  }
}

function dirStats(root: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else {
        files += 1
        try {
          bytes += lstatSync(full).size
        } catch {
          // 读不到大小的文件仍计入数量；大小校验只作为辅助
        }
      }
    }
  }
  walk(root)
  return { files, bytes }
}

function copyDirContents(from: string, to: string): void {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (existsSync(target)) throw new Error(`目标目录里已经有 ${entry.name}，不能自动合并`)
    cpSync(source, target, { recursive: true, force: false, errorOnExist: true })
  }
}

function applyOneMigration(job: StorageMigration): string | null {
  const from = resolve(job.from)
  const to = resolve(job.to)
  if (from === to) return null
  if (!existsSync(from)) return null

  if (existsSync(to)) {
    if (!statSync(to).isDirectory()) throw new Error(`目标路径不是目录：${to}`)
    if (isNonEmptyDir(to)) throw new Error(`目标目录已有数据，不能自动覆盖：${to}`)
  } else {
    mkdirSync(to, { recursive: true })
  }

  if (job.kind === 'database') {
    copyPortableDatabaseFiles(from, to)
    const sourceStats = portableStats(from)
    const targetStats = portableStats(to)
    if (targetStats.files !== sourceStats.files || targetStats.bytes !== sourceStats.bytes) {
      throw new Error(`数据库文件搬迁后校验不通过：${from} → ${to}`)
    }
  } else {
    copyDirContents(from, to)
    const sourceStats = dirStats(from)
    const targetStats = dirStats(to)
    if (targetStats.files !== sourceStats.files || targetStats.bytes !== sourceStats.bytes) {
      throw new Error(`目录搬迁后校验不通过：${from} → ${to}`)
    }
  }
  return to
}

/**
 * 立即执行一批目录迁移（只复制、校验，不改设置文件）。
 * 失败时删除本次已经复制出来的目标目录，旧目录始终保留。
 */
export function migrateStorageJobs(jobs: readonly StorageMigration[]): { moved: string[]; skipped: string[] } {
  const moved: string[] = []
  const skipped: string[] = []
  try {
    for (const job of jobs) {
      const target = applyOneMigration(job)
      if (target) moved.push(target)
      else skipped.push(job.to)
    }
  } catch (error) {
    for (const target of moved) {
      try {
        rmSync(target, { recursive: true, force: true })
      } catch {
        // 回滚失败时保留现场，错误信息里已经带目标路径
      }
    }
    throw error
  }
  return { moved, skipped }
}

/**
 * 启动前执行控制台保存的搬迁任务。
 * 先复制、再校验，成功后才清空 pending；失败会删除已复制的新目录并中止启动，
 * 旧目录始终保留，不会出现“配置改了但数据找不到”。
 */
export function applyPendingStorageMigrations(): { moved: string[]; skipped: string[] } {
  const settings = readConsoleSettings()
  if (settings.pendingMigrations.length === 0) return { moved: [], skipped: [] }
  const result = migrateStorageJobs(settings.pendingMigrations)
  writeConsoleSettings({ pendingMigrations: [] })
  return result
}
