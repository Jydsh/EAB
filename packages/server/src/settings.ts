/**
 * 控制台运行设置（可在线修改、落盘、重启后生效）。
 *
 * 为什么单独放文件而不是数据库：
 * - `dataDir` 决定数据库文件放哪，必须在开库之前就知道，所以不能存在库里。
 * - `logRetentionDays` 属于运维策略，跟库放在同一个文件里，跟着数据目录一起走。
 *
 * 文件位置固定在部署根目录 `.eab-dev/console-settings.json`（引导文件），
 * 即使业务数据搬到别的盘，这个指针文件仍留在部署目录，用来找到真正的数据目录。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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

export interface ConsoleSettings extends NetworkSettings {
  /** 业务数据目录；null 表示就用部署目录下的 .eab-dev */
  dataDir: string | null
  /** 日志保留天数；0 = 永久保留 */
  logRetentionDays: number
  lastCleanupAt: string | null
  lastCleanupStats: Record<string, number> | null
}

const DEFAULTS: ConsoleSettings = {
  dataDir: null,
  logRetentionDays: 90,
  lastCleanupAt: null,
  lastCleanupStats: null,
  host: null,
  chatPort: null,
  adminPort: null,
  allowRemoteConsole: false,
}

function readPort(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : null
}

export function readConsoleSettings(): ConsoleSettings {
  const file = settingsPath()
  if (!existsSync(file)) return { ...DEFAULTS }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ConsoleSettings>
    const days = Number(raw.logRetentionDays ?? DEFAULTS.logRetentionDays)
    return {
      dataDir: typeof raw.dataDir === 'string' && raw.dataDir.trim() ? raw.dataDir.trim() : null,
      logRetentionDays: Number.isFinite(days) && days >= 0 ? Math.trunc(days) : DEFAULTS.logRetentionDays,
      lastCleanupAt: typeof raw.lastCleanupAt === 'string' ? raw.lastCleanupAt : null,
      lastCleanupStats: raw.lastCleanupStats && typeof raw.lastCleanupStats === 'object' ? raw.lastCleanupStats : null,
      host: typeof raw.host === 'string' && raw.host.trim() ? raw.host.trim() : null,
      chatPort: readPort(raw.chatPort),
      adminPort: readPort(raw.adminPort),
      allowRemoteConsole: raw.allowRemoteConsole === true,
    }
  } catch {
    // 配置文件损坏时退回默认值，但绝不静默删掉它——留给人工检查
    return { ...DEFAULTS }
  }
}

export function writeConsoleSettings(patch: Partial<ConsoleSettings>): ConsoleSettings {
  const next = { ...readConsoleSettings(), ...patch }
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
  /** 业务数据目录（库、密钥、凭据、备份都在这里） */
  dataDir: string
  /** 由设置文件指定并刚刚完成搬迁的来源目录，没有则为 null */
  migratedFrom: string | null
  /** 数据库路径由 EAB_DB 环境变量锁定（控制台不能再改目录） */
  envLocked: boolean
  settings: ConsoleSettings
}

function normaliseDir(input: string): string {
  const full = resolve(input)
  if (!isAbsolute(full)) throw new Error(`数据目录必须是绝对路径：${input}`)
  return full
}

/**
 * 启动时解析数据目录。
 * 规则：EAB_DB（显式指定库文件） > 控制台设置 dataDir > 部署目录 .eab-dev。
 * 首次切到新目录且新目录没有库时，把旧目录里的库与配套文件搬过去，避免"切目录等于丢数据"。
 */
export function resolveStorage(defaultDbPath: string, envDb?: string): ResolvedStorage {
  const settings = readConsoleSettings()
  if (envDb) {
    return { dbPath: envDb, dataDir: dirname(envDb), migratedFrom: null, envLocked: true, settings }
  }
  const deployDir = dirname(defaultDbPath)
  if (!settings.dataDir) {
    return { dbPath: defaultDbPath, dataDir: deployDir, migratedFrom: null, envLocked: false, settings }
  }

  const dataDir = normaliseDir(settings.dataDir)
  mkdirSync(dataDir, { recursive: true })
  const targetDb = join(dataDir, DB_FILE)
  let migratedFrom: string | null = null

  if (!existsSync(targetDb) && existsSync(defaultDbPath)) {
    const portable = [
      DB_FILE,
      `${DB_FILE}-wal`,
      `${DB_FILE}-shm`,
      'secrets.json',
      'admin-credentials.txt',
      'demo-accounts.txt',
    ]
    for (const name of portable) {
      const from = join(deployDir, name)
      if (!existsSync(from)) continue
      try {
        cpSync(from, join(dataDir, name))
      } catch (err) {
        throw new Error(`搬迁数据文件 ${name} 到 ${dataDir} 失败：${(err as Error).message}`)
      }
    }
    const backupsFrom = join(deployDir, 'backups')
    if (existsSync(backupsFrom)) {
      try {
        cpSync(backupsFrom, join(dataDir, 'backups'), { recursive: true })
      } catch {
        // 备份目录搬迁失败不影响启动，备份可以再生成
      }
    }
    migratedFrom = deployDir
  }

  return { dbPath: targetDb, dataDir, migratedFrom, envLocked: false, settings }
}
