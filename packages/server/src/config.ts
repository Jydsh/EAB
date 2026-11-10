/**
 * 服务端配置（T-05）。
 *
 * 规则：
 * 1. 只从环境变量读，不从请求读——租户/路径/端口这类东西绝不允许客户端决定。
 * 2. 非法值直接启动失败（带人话原因），不做"猜一个默认值"。
 * 3. 开发预览开关（devAuth）默认关；只有本机自动化测试显式设 EAB_DEV_AUTH=1 才允许 ?as= 冒充。
 */
import { join } from 'node:path'
import { EC, EabError } from '@eab/domain'
import { defaultHomeDir, readConsoleSettings } from './settings.js'

/** 默认部署目录；桌面端用 EAB_HOME 指到用户数据目录。 */
export const DEFAULT_DATA_DIR = defaultHomeDir()
/** 默认库位置锚定部署目录，而不是进程 cwd——`pnpm --filter` 会把 cwd 切到包目录 */
export const DEFAULT_DB_PATH = join(DEFAULT_DATA_DIR, 'eab.db')

export interface ServerConfig {
  readonly host: string
  /** 员工对话端口（默认 8787） */
  readonly port: number
  /** 管理控制台端口（默认 8788）；必须与员工端口不同 */
  readonly adminPort: number
  readonly dbPath: string
  /** 单公司模式：整个实例只服务这一家公司、一个组织架构（默认 c1） */
  readonly companyId: string
  /** 开发预览：允许用 ?as=<userId> 冒充身份。生产必须关。 */
  readonly devAuth: boolean
  /**
   * 控制台服务令牌（可选，给脚本/自动化用）。
   * 浏览器不用它，浏览器走"超级管理员账号 + 密码"登录。
   */
  readonly consoleToken: string
  /** 控制台超级管理员账号：默认 admin，可用 EAB_ADMIN_USER 覆盖 */
  readonly adminUser: string
  /** 控制台超级管理员密码：未配置时启动自动生成并写 .eab-dev/admin-credentials.txt */
  readonly adminPassword: string
  /** 密码来源：环境变量（改了要重启）还是自动生成并落盘（可在账号中心直接改） */
  readonly adminPasswordSource?: 'env' | 'auto'
  /** 业务数据目录（库、密钥、凭据、备份所在目录）；启动时由 settings 解析后填入 */
  readonly dataDir?: string
  /** 数据目录是否由 EAB_DB 环境变量锁定（锁定时控制台不能改） */
  readonly dataDirEnvLocked?: boolean
  /** 是否允许非本机地址登录控制台。默认否——控制台只在服务器本机/内网跳板用。 */
  readonly allowRemoteConsole: boolean
  /** 网络项由环境变量固定时，控制台不能改；未固定的项可在控制台保存。 */
  readonly networkEnvLocked?: {
    readonly host: boolean
    readonly chatPort: boolean
    readonly adminPort: boolean
    readonly allowRemoteConsole: boolean
  }
  readonly logLevel: string
}

function readInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new EabError(EC.VALIDATION, `环境变量 ${name} 必须是正整数，当前是 ${raw}`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const settings = readConsoleSettings()
  const port = readInt(
    env.EAB_PORT ?? (settings.chatPort === null ? undefined : String(settings.chatPort)),
    8787,
    'EAB_PORT',
  )
  if (port > 65535) {
    throw new EabError(EC.VALIDATION, `环境变量 EAB_PORT 超出范围：${port}`)
  }
  const adminPort = readInt(
    env.EAB_ADMIN_PORT ?? (settings.adminPort === null ? undefined : String(settings.adminPort)),
    8788,
    'EAB_ADMIN_PORT',
  )
  if (adminPort > 65535) {
    throw new EabError(EC.VALIDATION, `环境变量 EAB_ADMIN_PORT 超出范围：${adminPort}`)
  }
  if (adminPort === port) {
    throw new EabError(EC.VALIDATION, 'EAB_ADMIN_PORT 不能与 EAB_PORT 相同：两个入口必须分端口', {
      hint: '例如员工 8787、管理 8788',
    })
  }

  const host = (env.EAB_HOST ?? settings.host ?? '127.0.0.1').trim()
  if (!host || /\s/.test(host)) {
    throw new EabError(EC.VALIDATION, `监听地址不合法：${host}`, { hint: '本机用 127.0.0.1，局域网用 0.0.0.0' })
  }

  return {
    host,
    port,
    adminPort,
    dbPath: env.EAB_DB ?? DEFAULT_DB_PATH,
    companyId: env.EAB_COMPANY_ID ?? 'c1',
    devAuth: (env.EAB_DEV_AUTH ?? '0') === '1',
    /** 新名字优先；`EAB_PLATFORM_TOKEN` 只为兼容旧部署保留 */
    consoleToken: env.EAB_CONSOLE_TOKEN ?? env.EAB_PLATFORM_TOKEN ?? '',
    adminUser: env.EAB_ADMIN_USER ?? 'admin',
    adminPassword: env.EAB_ADMIN_PASSWORD ?? '',
    allowRemoteConsole:
      env.EAB_CONSOLE_ALLOW_REMOTE === undefined
        ? settings.allowRemoteConsole
        : env.EAB_CONSOLE_ALLOW_REMOTE === '1',
    networkEnvLocked: {
      host: env.EAB_HOST !== undefined,
      chatPort: env.EAB_PORT !== undefined,
      adminPort: env.EAB_ADMIN_PORT !== undefined,
      allowRemoteConsole: env.EAB_CONSOLE_ALLOW_REMOTE !== undefined,
    },
    logLevel: env.EAB_LOG_LEVEL ?? 'info',
  }
}
