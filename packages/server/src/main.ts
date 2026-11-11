/**
 * 启动入口（`pnpm dev`）。
 *
 * 顺序：读配置 → 开库 → 迁移 → （开发模式）造数据 → 起服务。
 * 任何一步失败都直接退出并打印人话原因，不留半启动状态。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { migrate, openDatabase } from '@eab/storage'
import { buildApp } from './app.js'
import { refreshDingTalkStream, stopDingTalkStream } from './dingtalk-bot.js'
import { cleanupTemp } from './routes/workspace.js'
import { loadConfig } from './config.js'
import { COMPANY_ID, COMPANY_NAME, ensureDemoData, ensureDemoPasswords, ensureModelCatalog } from './dev-seed.js'
import {
  applyPendingStorageMigrations,
  readConsoleSettings,
  resolveStorage,
  writeConsoleSettings,
  SETTINGS_PATH,
} from './settings.js'
import { startRetention } from './retention.js'
import { startScheduleWorker } from './schedule.js'
import { startModelHealthMonitor } from './model-health.js'
import { reloadPluginHosts } from './plugin-host.js'
import { setPluginRoot } from './plugins.js'
import { checkForUpdate } from './update.js'
import { acquireProcessLock, type ProcessLock } from './process-lock.js'
import { applyNetworkToConfig, type NetworkTarget } from './network-settings.js'

// 搬迁必须在开库之前完成：旧的库、云空间、插件目录先复制并校验，成功后才切换指针。
try {
  const migrated = applyPendingStorageMigrations()
  if (migrated.moved.length > 0) console.log(`存储位置已迁移：${migrated.moved.join('、')}`)
} catch (error) {
  console.error(`[eab] 存储位置迁移失败：${error instanceof Error ? error.message : String(error)}`)
  console.error('[eab] 旧目录仍保留；修正 pendingMigrations 或目标目录后重启。')
  process.exit(1)
}

let config = loadConfig()
const storage = resolveStorage(config.dbPath, process.env.EAB_DB, process.env.EAB_PLUGINS_DIR)
config = {
  ...config,
  dbPath: storage.dbPath,
  dataDir: storage.dataDir,
  dataDirEnvLocked: storage.envLocked,
  dbDir: storage.dbDir,
  workspacesDir: storage.workspacesDir,
  tmpDir: storage.tmpDir,
  backupsDir: storage.backupsDir,
  pluginsDir: storage.pluginsDir,
  dshHomeDir: storage.dshHomeDir,
  pluginsEnvLocked: storage.pluginsEnvLocked,
}
setPluginRoot(storage.pluginsDir)
mkdirSync(dirname(config.dbPath), { recursive: true })
const lockDir = config.dataDir ?? dirname(config.dbPath)
let processLock: ProcessLock
try {
  processLock = acquireProcessLock(lockDir, config.dbPath)
} catch (error) {
  console.error(`[eab] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
// 正常退出、异常退出和 Ctrl+C 都要回收锁；release 自身是幂等的。
process.on('exit', () => processLock.release())
if (storage.migratedFrom) {
  console.log(`数据目录已迁移：${storage.migratedFrom} → ${storage.dataDir}（配置见 ${SETTINGS_PATH}）`)
}
if (storage.pluginsSeededFrom) {
  console.log(`插件目录已初始化：${storage.pluginsSeededFrom} → ${storage.pluginsDir}`)
}

const db = openDatabase({ path: config.dbPath })
const migration = migrate(db)
if (migration.applied.length > 0) {
  console.log(`迁移已执行: ${migration.applied.join(', ')}`)
}

/**
 * 日志保留：同步记录 / 渠道事件 / 登录失败 / 插件事件按天清理；
 * 审计日志按独立保留天数只删最老的一段，并保留哈希链锚点。
 * 策略存在控制台设置文件里，改完立即生效，不用重启。
 */
startRetention(
  db,
  () => readConsoleSettings().logRetentionDays,
  (result) => {
    writeConsoleSettings({ lastCleanupAt: new Date().toISOString(), lastCleanupStats: result.deleted })
    console.log(
      `[eab] 保留清理完成：删除 ${result.total} 条（日志 ${result.days} 天 / 审计 ${result.audit.days} 天）`,
    )
  },
  () => readConsoleSettings().auditRetentionDays,
)

/**
 * 单公司本地部署：整个实例只认一个公司 ID。
 * 配置的 ID 不存在但库里恰好只有一家时（例如用扫码新建过），以库里那家为准，
 * 避免启动后控制台指向一个空公司。
 */
const configuredCompany = db.prepare('SELECT id FROM companies WHERE id = ?').get(config.companyId) as
  | { id: string }
  | undefined
if (!configuredCompany) {
  const companies = db.prepare('SELECT id FROM companies ORDER BY created_at ASC').all() as unknown as Array<{ id: string }>
  if (companies.length === 1 && companies[0]) {
    const correction = companies[0].id
    console.log(`单公司模式：配置公司 ${config.companyId} 不存在，改用库里唯一公司 ${correction}`)
    config = { ...config, companyId: correction }
  }
}
cleanupTemp(config.tmpDir ?? join(config.dataDir ?? dirname(config.dbPath), 'tmp'))

if (config.devAuth) {
  const seeded = ensureDemoData(db)
  if (seeded) {
    console.log(`已生成演示数据：${COMPANY_NAME}（${COMPANY_ID}）· 7 个成员 · 6 个知识库`)
  }
  if (ensureModelCatalog(db)) {
    console.log('已补模型目录：演示供应商 + 3 个示例模型（可在控制台替换为真实厂商/本地模型）')
  }
  const demoAccounts = ensureDemoPasswords(db)
  if (demoAccounts.length > 0) {
    const accountPath = join(config.dbDir ?? dirname(config.dbPath), 'demo-accounts.txt')
    writeFileSync(
      accountPath,
      `# EAB 员工工作台演示账号（仅在 EAB_DEV_AUTH=1 时生成）\n` +
        demoAccounts
          .map(
            (item) =>
              `${item.companyName} ${item.companyId} · ${item.name} · 工号 ${item.employeeNo} · 密码 ${item.password}`,
          )
          .join('\n') +
        `\n# 登录入口 http://127.0.0.1:${config.port}/chat\n`,
      'utf8',
    )
    console.log(`已为 ${demoAccounts.length} 名演示成员补登录密码（见 .eab-dev/demo-accounts.txt）`)
  }
}

/**
 * 控制台超级管理员：开发/运维用的账号，不属于任何公司的组织成员。
 * 未显式配置密码时自动生成一份，写到 .eab-dev/admin-credentials.txt，
 * 避免"默认 admin/admin"这种弱口令被带到服务器上。
 */
let adminPassword = config.adminPassword
let adminPasswordSource: 'env' | 'auto' = adminPassword ? 'env' : 'auto'
const credentialsPath = join(config.dbDir ?? dirname(config.dbPath), 'admin-credentials.txt')
if (!adminPassword && existsSync(credentialsPath)) {
  // 自动生成的密码要跨重启保持不变，否则每次重启运维都得重新找密码
  const text = readFileSync(credentialsPath, 'utf8')
  const match = text.match(/^password=(.+)$/m)
  if (match) adminPassword = match[1].trim()
}
if (!adminPassword) {
  adminPassword = randomBytes(9).toString('base64url')
  writeFileSync(
    credentialsPath,
    `# EAB 控制台超级管理员（仅本机/服务器使用）\n` +
      `username=${config.adminUser}\n` +
      `password=${adminPassword}\n` +
      `# 改密码：设置环境变量 EAB_ADMIN_PASSWORD 后重启；不要让这个文件进版本库\n`,
    'utf8',
  )
}

/** 解析后的口令要进入 config：身份解析（session.ts）靠它识别控制台操作员 */
config = { ...config, consoleToken: config.consoleToken, adminPassword, adminPasswordSource }

const apps: { chat?: FastifyInstance; console?: FastifyInstance } = {}
const deps = {
  db,
  config,
  companyId: config.companyId,
  migrations: migration.applied,
  consoleToken: config.consoleToken,
  /** 控制台「一键更新」需要由服务自己退出，更新器才能安全替换文件 */
  shutdown: () => {
    void shutdown()
  },
  /** 网络设置保存后在本进程内重建两个监听，不重启服务 */
  applyNetwork: (next: NetworkTarget) => rebindNetwork(next, apps),
}

/** 两个入口分端口：员工对话 / 管理控制台。共用同一个库与同一套身份/审计。 */
apps.chat = buildApp(deps, 'chat')
apps.console = buildApp(deps, 'console')

/** 用户自建定时任务：到点执行并回推钉钉；停止函数在 shutdown 里调用 */
const stopScheduleWorker = startScheduleWorker(deps)

await Promise.all([
  apps.chat.listen({ host: config.host, port: config.port }),
  apps.console.listen({ host: config.host, port: config.adminPort }),
])

/** DSH 插件 host：已安装且启用的插件在这里跑 apply()，把它们的 RPC 通道挂起来 */
await reloadPluginHosts(db, {
  dbPath: config.dbPath,
  dshHomeDir: config.dshHomeDir,
  companyId: config.companyId,
}).catch((error) => {
  console.warn('[eab] DSH 插件宿主启动失败：', (error as Error).message)
})

/** 插件模型定时健康探测：失败模型从对话候选过滤，恢复后自动回来。 */
const stopModelHealthMonitor = startModelHealthMonitor(config.companyId)

/** 0.0.0.0 时给运维一个可直接复制的局域网地址；只做展示，不参与监听。 */
function localIpv4(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) return item.address
    }
  }
  return null
}

/** 启动后异步检查 GitHub Release；失败只记录日志，不阻塞服务。 */
void checkForUpdate(false).then((status) => {
  if (status.error) console.warn(`[eab] 版本检查失败：${status.error}`)
  else if (status.hasUpdate) console.log(`[eab] 发现新版本 v${status.latest}（当前 v${status.current}），可在控制台「系统 → 版本更新」查看`)
})

console.log('')
const accessHost = config.host === '0.0.0.0' || config.host === '::' ? localIpv4() ?? config.host : config.host
console.log(`  员工工作台      →  http://${accessHost}:${config.port}/chat`)
console.log(`  管理控制台      →  http://${accessHost}:${config.adminPort}/admin   （超级管理员账号登录，不登录组织成员）`)
console.log(`  健康检查        →  http://${accessHost}:${config.port}/api/health`)
if (accessHost !== config.host) {
  console.log(`  监听地址        →  ${config.host}（局域网内可用本机 IPv4 访问以上地址）`)
}
console.log(`  控制台账号      →  ${config.adminUser}`)
if (adminPasswordSource === 'auto') {
  console.log(`  控制台密码(自动) →  ${adminPassword}  （写在 .eab-dev/admin-credentials.txt）`)
} else {
  console.log('  控制台密码      →  来自 EAB_ADMIN_PASSWORD')
}
if (!config.allowRemoteConsole) {
  console.log('  控制台网络      →  只允许本机登录（需要远程请设 EAB_CONSOLE_ALLOW_REMOTE=1）')
}
if (config.devAuth) {
  console.log('')
  console.warn('  ⚠ 开发预览模式已开启：允许 ?as=<userId> 冒充员工，仅限本机自动化测试；默认关闭')
}
console.log('')

/**
 * 钉钉机器人入站：本地部署没有公网域名时，钉钉回调打不进来，
 * 所以默认走 Stream 长连接由 EAB 主动连钉钉网关；配了公网回调也能同时走 HTTP。
 */
void refreshDingTalkStream(deps).catch((error) => {
  console.warn('[eab] 钉钉 Stream 启动失败：', (error as Error).message)
})

async function shutdown(): Promise<void> {
  stopScheduleWorker()
  stopModelHealthMonitor()
  stopDingTalkStream()
  await closeApps(apps)
  processLock.release()
  db.close()
  process.exit(0)
}

/** 关掉监听时同时断掉空闲/长连接，否则员工页的 SSE 会让 close 一直等。 */
function closeServer(app?: FastifyInstance): Promise<void> {
  return new Promise((resolve) => {
    const server = app?.server
    if (!server || !server.listening) {
      resolve()
      return
    }
    let timer: NodeJS.Timeout | undefined
    const done = () => {
      if (timer) clearTimeout(timer)
      resolve()
    }
    server.close(done)
    timer = setTimeout(() => server.closeAllConnections?.(), 50)
  })
}

async function closeApps(target: { chat?: FastifyInstance; console?: FastifyInstance }): Promise<void> {
  await Promise.all([closeServer(target.chat), closeServer(target.console)])
}

function listenServer(app: FastifyInstance | undefined, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = app?.server
    if (!server) {
      reject(new Error('监听未初始化'))
      return
    }
    const onError = (error: Error) => {
      server.off('error', onError)
      reject(error)
    }
    server.once('error', onError)
    server.listen({ host, port }, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

let networkApplyQueue: Promise<{ rebound: boolean; error?: string }> = Promise.resolve({ rebound: false })

/** 控制台保存监听地址/端口后，在本进程内重建两个监听；失败回滚设置并恢复旧监听。 */
function rebindNetwork(
  next: NetworkTarget,
  target: { chat?: FastifyInstance; console?: FastifyInstance },
): Promise<{ rebound: boolean; error?: string }> {
  const run = async (): Promise<{ rebound: boolean; error?: string }> => {
    const previous = {
      host: config.host,
      chatPort: config.port,
      adminPort: config.adminPort,
      allowRemoteConsole: config.allowRemoteConsole,
    }
    if (next.host === previous.host && next.chatPort === previous.chatPort && next.adminPort === previous.adminPort) {
      applyNetworkToConfig(config, next)
      return { rebound: false }
    }

    await closeApps(target)
    try {
      await Promise.all([
        listenServer(target.chat, next.host, next.chatPort),
        listenServer(target.console, next.host, next.adminPort),
      ])
      applyNetworkToConfig(config, next)
      console.log(`[eab] 监听已切换：${next.host}:${next.chatPort} / ${next.adminPort}`)
      return { rebound: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[eab] 监听切换失败，恢复旧监听：${message}`)
      await closeApps(target)
      try {
        await Promise.all([
          listenServer(target.chat, previous.host, previous.chatPort),
          listenServer(target.console, previous.host, previous.adminPort),
        ])
      } catch (rollbackError) {
        console.error(
          `[eab] 旧监听恢复失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        )
      }
      writeConsoleSettings({
        host: previous.host,
        chatPort: previous.chatPort,
        adminPort: previous.adminPort,
        allowRemoteConsole: previous.allowRemoteConsole,
      })
      return { rebound: false, error: message }
    }
  }
  networkApplyQueue = networkApplyQueue.then(run, run)
  return networkApplyQueue
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
