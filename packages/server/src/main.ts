/**
 * 启动入口（`pnpm dev`）。
 *
 * 顺序：读配置 → 开库 → 迁移 → （开发模式）造数据 → 起服务。
 * 任何一步失败都直接退出并打印人话原因，不留半启动状态。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { migrate } from '@eab/storage'
import { EC, EabError } from '@eab/domain'
import { buildApp } from './app.js'
import { recoverInterruptedDingTalkTurns, refreshDingTalkStream, releaseDingTalkStreamLeadership, startDingTalkStreamMonitor, stopDingTalkStream } from './dingtalk-bot.js'
import { startPermissionApprovalCardRetry } from './permission-approval-dingtalk.js'
import { refreshFeishuStream, startFeishuStreamMonitor, stopFeishuStream } from './feishu-bot.js'
import { cleanupTemp } from './routes/workspace.js'
import { loadConfig } from './config.js'
import { hardenRuntimeDir } from './runtime-permissions.js'
import { COMPANY_ID, COMPANY_NAME, ensureDemoData, ensureDemoPasswords, ensureModelCatalog } from './dev-seed.js'
import {
  applyPendingStorageMigrations,
  readConsoleSettings,
  resolveStorage,
  writeConsoleSettings,
  copyDatabaseCompanionFiles,
  migrateStorageJobs,
  type StorageApplyPlan,
  SETTINGS_PATH,
} from './settings.js'
import { LiveDatabase } from './live-db.js'
import { startRetention } from './retention.js'
import { pruneWorkspaceRecycle, workspaceRootFor } from './workspace-recycle.js'
import { sweepOrphanAgentRuns, sweepSuspendedRuns } from './agent-runtime.js'
import { recoverInterruptedAgentTasks } from './agent-team.js'
import { startRestartTaskWakeRecovery } from './routes/chat.js'
import { startScheduleWorker } from './schedule.js'
import { startOrgSyncScheduler } from './org-sync-scheduler.js'
import { startMemoryMaintenance } from './memory-maintenance.js'
import { startModelHealthMonitor, isModelHealthy, probeUnverifiedPluginModels, forgetModelHealth, probePluginChannelModels } from './model-health.js'
import { JOB_KINDS, recoverStaleJobs, startJobWorker } from './job-queue.js'
import { refreshPluginChannel } from './plugin-models.js'
import { reloadPluginHosts } from './plugin-host.js'
import { setPluginModelVisibilityResolver, setPluginModelsChangedListener, startPluginModelCatalogSync } from './plugin-models.js'
import { setPluginRoot } from './plugins.js'
import { startPluginToolSpecsCacheInvalidation } from './plugin-tools.js'
import { checkForUpdate } from './update.js'
import { acquireProcessLock, type ProcessLock } from './process-lock.js'
import { applyNetworkToConfig, type NetworkTarget } from './network-settings.js'
import { initBackends, closeBackends } from './backends/runtime.js'
import { useDatabaseCoordination } from './backends/coordination.js'

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
  processLock = acquireProcessLock(lockDir, config.dbPath, { allowMultiple: config.multiInstance })
} catch (error) {
  console.error(`[eab] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
if (config.multiInstance) {
  console.log(
    `[eab] 多实例模式：role=${config.serverRole}，已跳过单写进程锁；单例后台任务改由数据库租约选主`,
  )
}
// 正常退出、异常退出和 Ctrl+C 都要回收锁；release 自身是幂等的。
process.on('exit', () => processLock.release())
if (storage.migratedFrom) {
  console.log(`数据目录已迁移：${storage.migratedFrom} → ${storage.dataDir}（配置见 ${SETTINGS_PATH}）`)
}
if (storage.pluginsSeededFrom) {
  console.log(`插件目录已初始化：${storage.pluginsSeededFrom} → ${storage.pluginsDir}`)
}

const liveDb = new LiveDatabase(config.dbPath)
const db = liveDb.db
const migration = migrate(db)
if (migration.applied.length > 0) {
  console.log(`迁移已执行: ${migration.applied.join(', ')}`)
}

/**
 * 多实例但没接 Redis 时，把协调层换成 SQLite TTL 租约。
 * 必须在迁移之后调用，`runtime_coordination` 表才存在；单实例不启用，保持旧行为。
 */
if (config.multiInstance) {
  useDatabaseCoordination(db)
}
const backgroundWorker = config.serverRole !== 'api'

/**
 * 可选后端插件：不配 PostgreSQL/Redis 时这里只启用内存缓存；
 * 配了但连不上默认降级，不阻塞启动；strict 模式才直接失败。
 */
let backends: Awaited<ReturnType<typeof initBackends>>
try {
  backends = await initBackends(config, db)
} catch (error) {
  console.error(`[eab] 可选后端启动失败：${error instanceof Error ? error.message : String(error)}`)
  console.error('[eab] 这是 EAB_BACKENDS_STRICT=1 的预期行为；修复外部服务或去掉 strict 后重启。')
  process.exit(1)
}

/** 插件工具 schema 的跨实例失效订阅；没接 Redis 时是空操作。 */
try {
  await startPluginToolSpecsCacheInvalidation()
  console.log('[eab:boot] 插件工具缓存失效订阅完成')
} catch (error) {
  console.warn(`[eab] 插件工具缓存失效订阅失败：${(error as Error).message}`)
}

/**
 * 僵尸 Agent 运行记录：
 * 单实例时，进程锁保证库里 running 但没有心跳的 run 只能来自上次异常退出；
 * 多实例下不能做全局扫描——另一个实例的活跃 run 会被误判为僵尸。
 */
if (!config.multiInstance) {
  try {
    const sweptRuns = await sweepOrphanAgentRuns(db)
    if (sweptRuns > 0) console.log(`[eab] 已回收 ${sweptRuns} 条僵尸 Agent 运行记录`)
  } catch (error) {
    console.warn(`[eab] 僵尸 run 清理失败：${(error as Error).message}`)
  }

  /**
   * 上次进程崩溃时还挂在 running 的团队后台任务：单实例启动时统一收尾，唤醒父 Agent 继续。
   * 多实例下跳过，避免把另一个实例正在跑的任务误判为中断。
   */
  try {
    const recoveredTasks = recoverInterruptedAgentTasks(db)
    if (recoveredTasks > 0) console.log(`[eab] 已收尾 ${recoveredTasks} 个中断的团队后台任务（检查点保留）`)
  } catch (error) {
    console.warn(`[eab] 团队后台任务收尾失败：${(error as Error).message}`)
  }

  /** 挂起等后台工具的 run：作业失败/丢失的判 failed，作业还在跑或已成功的留给恢复流程。 */
  try {
    const sweptSuspended = sweepSuspendedRuns(db)
    if (sweptSuspended > 0) console.log(`[eab] 已收尾 ${sweptSuspended} 个挂起后无法恢复的 Agent 运行`)
  } catch (error) {
    console.warn(`[eab] 挂起 run 收尾失败：${(error as Error).message}`)
  }
} else {
  console.log('[eab] 多实例模式：跳过启动期全局 Agent/团队任务清理，避免误伤其他实例的活跃运行')
}

/** 异步作业的租约过期回收是幂等的：每个实例启动都可以执行，只动租约确实过期的行。 */
if (backgroundWorker) {
  try {
    const recoveredJobs = recoverStaleJobs(db)
    if (recoveredJobs > 0) console.log(`[eab] 已回收 ${recoveredJobs} 个中断的异步作业`)
  } catch (error) {
    console.warn(`[eab] 异步作业回收失败：${(error as Error).message}`)
  }
}

/**
 * 日志保留：同步记录 / 渠道事件 / 登录失败 / 插件事件按天清理；
 * 审计日志按独立保留天数只删最老的一段，并保留哈希链锚点。
 * 策略存在控制台设置文件里，改完立即生效，不用重启。
 *
 * 内部已经用 runAsLeader 选主；api 角色干脆不起定时器，减少多副本空转。
 */
const stopRetention = backgroundWorker
  ? startRetention(
  db,
  () => readConsoleSettings().logRetentionDays,
  (result) => {
    const settings = readConsoleSettings()
    const recycle = pruneWorkspaceRecycle(
      db,
      workspaceRootFor(config.dbPath, config.workspacesDir),
      settings.workspaceRecycleDays,
    )
    const stats = { ...result.deleted }
    if (recycle.files > 0) stats.workspaceRecycleFiles = recycle.files
    if (recycle.bytes > 0) stats.workspaceRecycleBytes = recycle.bytes
    if (recycle.rows > 0) stats.workspaceRecycleRows = recycle.rows
    writeConsoleSettings({ lastCleanupAt: new Date().toISOString(), lastCleanupStats: stats })
    if (result.total > 0 || recycle.files > 0 || recycle.rows > 0) {
      const recycleText = recycle.skipped
        ? ''
        : ` / 回收区 ${recycle.files} 个文件（${(recycle.bytes / 1024 / 1024).toFixed(1)} MB）`
      console.log(
        `[eab] 保留清理完成：删除 ${result.total} 条（日志 ${result.days} 天 / 审计 ${result.audit.days} 天 / Agent 轨迹 ${result.agentDays > 0 ? `${result.agentDays} 天` : '永久'} / 项目记录 ${result.recordDays > 0 ? `${result.recordDays} 天` : '永久'}${recycleText}）`,
      )
    }
  },
  () => readConsoleSettings().auditRetentionDays,
  () => readConsoleSettings().agentRetentionDays,
  () => readConsoleSettings().recordRetentionDays,
  workspaceRootFor(config.dbPath, config.workspacesDir),
)
  : () => {}
if (backgroundWorker) console.log('[eab:boot] 保留清理已启动')

/**
 * 单公司本地部署：整个实例只认一个公司 ID。
 * 配置的 ID 不存在但库里恰好只有一家时（例如用扫码新建过），以库里那家为准，
 * 避免启动后控制台指向一个空公司。
 */
console.log('[eab:boot] 查询单公司配置')
const configuredCompany = db.prepare('SELECT id FROM companies WHERE id = ?').get(config.companyId) as
  | { id: string }
  | undefined
console.log('[eab:boot] 单公司配置查询完成')
if (!configuredCompany) {
  const companies = db.prepare('SELECT id FROM companies ORDER BY created_at ASC').all() as unknown as Array<{ id: string }>
  if (companies.length === 1 && companies[0]) {
    const correction = companies[0].id
    console.log(`单公司模式：配置公司 ${config.companyId} 不存在，改用库里唯一公司 ${correction}`)
    config = { ...config, companyId: correction }
  }
}
console.log('[eab:boot] 公司配置检查完成')
cleanupTemp(config.tmpDir ?? join(config.dataDir ?? dirname(config.dbPath), 'tmp'))
console.log('[eab:boot] 临时目录清理完成')

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
console.log('[eab:boot] 演示配置检查完成')

/**
 * 控制台超级管理员：开发/运维用的账号，不属于任何公司的组织成员。
 * 未显式配置密码时自动生成一份，写到 .eab-dev/admin-credentials.txt，
 * 避免"默认 admin/admin"这种弱口令被带到服务器上。
 */
let adminPassword = config.adminPassword
let adminPasswordSource: 'env' | 'auto' = adminPassword ? 'env' : 'auto'
const runtimeDir = config.dbDir ?? dirname(config.dbPath)
const credentialsPath = join(runtimeDir, 'admin-credentials.txt')
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
    { encoding: 'utf8', mode: 0o600 },
  )
}
/**
 * 运行目录里有数据库、密钥、控制台口令和历史日志。Windows 继承 ACL 默认
 * 允许本机 Users 读取，必须在这里统一收紧；失败不阻断启动，但明确告警。
 */
try {
  hardenRuntimeDir(runtimeDir)
} catch (error) {
  console.warn('[eab] 运行目录权限收紧失败：', (error as Error).message)
}

/** 解析后的口令要进入 config：身份解析（session.ts）靠它识别控制台操作员 */
config = { ...config, consoleToken: config.consoleToken, adminPassword, adminPasswordSource }

/** 把新解析出的存储路径原地写进 config；deps 和各路由持有的是同一个对象。 */
function applyStoragePathsToConfig(paths: StorageApplyPlan['paths']): void {
  const mutable = config as unknown as Record<string, unknown>
  mutable.dataDir = paths.dataDir
  mutable.dbDir = paths.dbDir
  mutable.dbPath = paths.dbPath
  mutable.workspacesDir = paths.workspacesDir
  mutable.tmpDir = paths.tmpDir
  mutable.backupsDir = paths.backupsDir
  mutable.pluginsDir = paths.pluginsDir
  mutable.dshHomeDir = paths.dshHomeDir
}

/**
 * 立即应用存储位置：目录复制校验 + 数据库快照校验 + 写设置 + 切连接。
 * 全部在同步段内完成，迁移过程中不会插入其它数据库写操作。
 * 任意一步失败：删除本次新建的目标、保留旧路径与旧连接。
 */
function applyStoragePlanNow(plan: StorageApplyPlan): { moved: string[]; skipped: string[] } {
  const old = {
    dataDir: config.dataDir ?? dirname(config.dbPath),
    dbPath: config.dbPath,
    pluginsDir: config.pluginsDir,
    dshHomeDir: config.dshHomeDir,
  }
  let nextLock: ProcessLock | null = null
  if (plan.paths.dataDir !== old.dataDir) {
    mkdirSync(plan.paths.dataDir, { recursive: true })
    // 先拿新目录的进程锁，成功前不释放旧锁；失败只释放新锁。
    nextLock = acquireProcessLock(plan.paths.dataDir, plan.paths.dbPath)
  }

  let directories: { moved: string[]; skipped: string[] } | null = null
  let prepared: ReturnType<LiveDatabase['prepareAt']> | null = null
  let dbTarget: string | null = null
  try {
    directories = migrateStorageJobs(plan.jobs.filter((job) => job.kind === 'directory'))

    if (plan.paths.dbPath !== old.dbPath) {
      dbTarget = plan.paths.dbPath
      mkdirSync(dirname(dbTarget), { recursive: true })
      if (existsSync(dbTarget)) {
        throw new EabError(EC.VALIDATION, `目标数据库文件已存在，不能自动覆盖：${dbTarget}`)
      }
      liveDb.snapshotTo(dbTarget)
      copyDatabaseCompanionFiles(dirname(old.dbPath), plan.paths.dbDir)
      prepared = liveDb.prepareAt(dbTarget)
    }

    // 设置写入成功之前绝不切换连接；写失败时旧库仍是当前库。
    writeConsoleSettings(plan.settingsPatch)
    if (prepared) prepared.activate()

    applyStoragePathsToConfig(plan.paths)
    setPluginRoot(plan.paths.pluginsDir)
    if (nextLock) {
      const previous = processLock
      processLock = nextLock
      nextLock = null
      try {
        previous.release()
      } catch {
        // 旧锁释放失败不影响新锁；进程退出时还会再尝试一次。
      }
    }

    const pluginRuntimeChanged =
      plan.paths.dbPath !== old.dbPath ||
      plan.paths.pluginsDir !== old.pluginsDir ||
      plan.paths.dshHomeDir !== old.dshHomeDir
    if (pluginRuntimeChanged) {
      void reloadPluginHosts(db, {
        dbPath: plan.paths.dbPath,
        dshHomeDir: plan.paths.dshHomeDir,
        companyId: config.companyId,
      }).catch((error) => {
        console.warn('[eab] 存储切换后重载插件宿主失败：', (error as Error).message)
      })
    }

    return {
      moved: [...(directories?.moved ?? []), ...(dbTarget ? [dbTarget] : [])],
      skipped: directories?.skipped ?? [],
    }
  } catch (error) {
    if (prepared) {
      prepared.discard()
      prepared = null
    }
    if (dbTarget) {
      for (const name of ['eab.db', 'eab.db-wal', 'eab.db-shm', 'secrets.json', 'admin-credentials.txt', 'demo-accounts.txt']) {
        try {
          rmSync(join(plan.paths.dbDir, name), { force: true })
        } catch {
          // 清理失败不覆盖原始错误
        }
      }
      try {
        rmSync(plan.paths.dbDir, { recursive: false, force: true })
      } catch {
        // 目录非空时保留，说明里面不是本次迁移独占的文件
      }
    }
    for (const target of directories?.moved ?? []) {
      try {
        rmSync(target, { recursive: true, force: true })
      } catch {
        // 回滚失败时保留现场
      }
    }
    nextLock?.release()
    throw error
  }
}

let storageApplyChain: Promise<unknown> = Promise.resolve()

/** 同一时间只允许一个存储迁移；第二次保存排在第一次之后。 */
function applyStorage(plan: StorageApplyPlan): Promise<{ moved: string[]; skipped: string[] }> {
  const run = () => applyStoragePlanNow(plan)
  const next = storageApplyChain.then(run, run)
  storageApplyChain = next.catch(() => undefined)
  return next
}

const apps: { chat?: FastifyInstance; console?: FastifyInstance } = {}
const deps = {
  db,
  config,
  companyId: config.companyId,
  migrations: migration.applied,
  consoleToken: config.consoleToken,
  backends,
  /** 控制台「一键更新」需要由服务自己退出，更新器才能安全替换文件 */
  shutdown: () => {
    void shutdown()
  },
  /** 网络设置保存后在本进程内重建两个监听，不重启服务 */
  applyNetwork: (next: NetworkTarget) => rebindNetwork(next, apps),
  /** 存储位置保存后立即复制/切换，不重启服务 */
  applyStorage,
}

/** 两个入口分端口：员工对话 / 管理控制台。共用同一个库与同一套身份/审计。 */
console.log('[eab:boot] 构建应用')
apps.chat = buildApp(deps, 'chat')
apps.console = buildApp(deps, 'console')
console.log('[eab:boot] 应用已构建，启动后台工作器')

/** 用户自建定时任务：到点执行并回推钉钉；停止函数在 shutdown 里调用 */
const stopScheduleWorker = backgroundWorker ? startScheduleWorker(deps) : () => {}

/**
 * 异步作业队列（Phase 4）：控制台触发的慢操作（插件通道刷新、模型批量探测等）
 * 提交后立刻返回 jobId，由 worker 在后台跑完。没配 Redis 时 worker 按 pollMs 轮询，
 * 配了 Redis 则提交作业会通过 Pub/Sub 即时唤醒所有实例。
 *
 * api 角色不消费队列：HTTP 进程只负责请求与 SSE，慢作业统一交给 worker，
 * 这样扩容 API 不会把同一批作业在每个副本上再抢一遍。
 */
const stopJobWorker = backgroundWorker
  ? startJobWorker({
      db,
      // 90 秒租约：容器被 kill 后最多 90 秒自动回到队列；正常长任务靠 30 秒心跳续租。
      leaseMs: 90_000,
      instanceId: `${config.serverRole}:${process.pid}`,
      handlers: {
        [JOB_KINDS.pluginChannelRefresh]: async (job) => {
          const payload = (job.payload ?? {}) as { channelId?: unknown }
          const channelId = String(payload.channelId ?? '')
          if (!channelId) throw new Error('作业缺少 channelId')
          await refreshPluginChannel(job.companyId, channelId)
          const probe = await probePluginChannelModels(job.companyId, channelId)
          return {
            channelId,
            checked: probe.checked,
            models: probe.healthy,
            failed: probe.failed.map((model) => model.name),
          }
        },
      },
    })
  : () => {}

console.log(`[eab:boot] 开始监听 chat=${config.port} console=${config.adminPort}`)
await Promise.all([
  apps.chat.listen({ host: config.host, port: config.port }),
  apps.console.listen({ host: config.host, port: config.adminPort }),
])
console.log('[eab:boot] 监听完成')

/**
 * 渠道长连接必须在插件宿主加载之前启动。
 * DSH 插件缺少依赖时会在 reloadPluginHosts 里做在线安装，可能卡住几十秒甚至几分钟；
 * 如果 Stream 排在其后，这段时间钉钉/飞书完全收不到消息，用户看到的就是“发消息没反应”。
 * 消息处理用到的插件工具可以随后由 plugin watcher 补上，断线巡检也会自动重建连接。
 */
/**
 * 渠道长连接必须在插件宿主加载之前启动。
 * 只有 worker/all 角色持有 Stream 长连接；api 角色不建连，避免多副本重复收同一条消息。
 */
if (backgroundWorker) {
  void refreshDingTalkStream(deps).catch((error) => {
    console.warn('[eab] 钉钉 Stream 启动失败：', (error as Error).message)
  })
}
const stopDingTalkStreamMonitor = backgroundWorker ? startDingTalkStreamMonitor(deps, 10_000) : () => {}
if (backgroundWorker) {
  void refreshFeishuStream(deps).catch((error) => {
    console.warn('[eab] 飞书长连接启动失败：', (error as Error).message)
  })
}
const stopFeishuStreamMonitor = backgroundWorker ? startFeishuStreamMonitor(deps) : () => {}
/** 本次重启打断的后台任务：等服务稳定后唤醒父 Agent，由它决定是否从检查点继续。 */
const stopRestartWakeRecovery = backgroundWorker ? startRestartTaskWakeRecovery(deps, 15_000) : () => {}

/** 插件模型只有在真实回复探测通过后才进入模型目录。 */
setPluginModelVisibilityResolver((companyId, modelId) => isModelHealthy(companyId, modelId))
const pluginProbeTimers = new Map<string, ReturnType<typeof setTimeout>>()
setPluginModelsChangedListener((companyId, change) => {
  // 插件移除的模型要清掉旧健康结论；否则同一个模型 ID 重新出现时会绕过真实探测。
  const removed = change?.removed ?? []
  const reset = [...(change?.added ?? []), ...(change?.updated ?? [])]
  if (removed.length) forgetModelHealth(companyId, removed)
  if (reset.length) forgetModelHealth(companyId, reset)
  if (reset.length === 0) return
  // adapter 注册发生在插件 apply() 期间，等初始化落定再探测，避免 prepareCall 撞上半初始化状态。
  const previous = pluginProbeTimers.get(companyId)
  if (previous) clearTimeout(previous)
  const timer = setTimeout(() => {
    pluginProbeTimers.delete(companyId)
    void probeUnverifiedPluginModels(companyId)
  }, 800)
  timer.unref?.()
  pluginProbeTimers.set(companyId, timer)
})

/** DSH 插件 host：已安装且启用的插件在这里跑 apply()，把它们的 RPC 通道挂起来 */
await reloadPluginHosts(db, {
  dbPath: config.dbPath,
  dshHomeDir: config.dshHomeDir,
  companyId: config.companyId,
}).catch((error) => {
  console.warn('[eab] DSH 插件宿主启动失败：', (error as Error).stack ?? (error as Error).message)
})

/** 插件模型定时健康探测：失败模型从对话候选过滤，恢复后自动回来。 */
const stopModelHealthMonitor = startModelHealthMonitor(config.companyId)

/** 插件模型目录定时重读：插件把不再免费的模型摘掉后，EAB 目录跟随清理。 */
const stopPluginModelCatalogSync = backgroundWorker ? startPluginModelCatalogSync(config.companyId) : () => {}

/**
 * 已绑定渠道的通讯录定时同步：默认每 2 小时一次，启动后延迟 1 分钟首跑。
 * 成员被上游标记离职或连续两次缺失后会停用，员工会话随即失效。
 */
const stopOrgSyncScheduler = backgroundWorker ? startOrgSyncScheduler(db, config, config.companyId) : () => {}

/** 记忆维护：情景聚类 + 归档；worker 角色启动，20 小时内不重复跑。 */
const stopMemoryMaintenance = backgroundWorker ? startMemoryMaintenance(db, config.companyId) : () => {}

/** 0.0.0.0 时给运维一个可直接复制的局域网地址；只做展示，不参与监听。 */
function localIpv4(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) return item.address
    }
  }
  return null
}

/**
 * 启动后异步检查 GitHub Release，并定时复查；失败只记录日志，不阻塞服务。
 * 定时检查让服务运行期间新发布的 Release 也能进入控制台版本提醒。
 */
let announcedUpdateVersion: string | null = null
function reportUpdateStatus(status: Awaited<ReturnType<typeof checkForUpdate>>, source: string): void {
  if (status.error) {
    if (source === '启动') console.warn(`[eab] 版本检查失败：${status.error}`)
    return
  }
  if (status.hasUpdate && status.latest) {
    if (announcedUpdateVersion !== status.latest) {
      announcedUpdateVersion = status.latest
      console.log(`[eab] 发现新版本 v${status.latest}（当前 v${status.current}），可在控制台「系统 → 数据与运维 → 版本更新」查看`)
    }
  } else {
    announcedUpdateVersion = null
  }
}
void checkForUpdate(false).then((status) => reportUpdateStatus(status, '启动'))
// 每 10 分钟强制刷新一次，服务运行期间新发布的 Release 也能被发现；定时器不阻止进程退出。
setInterval(() => {
  void checkForUpdate(true).then((status) => reportUpdateStatus(status, '定时'))
}, 10 * 60 * 1000).unref()

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
  console.log('  控制台密码(自动) →  已写入运行目录的 admin-credentials.txt（不再打印明文）')
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
 * 审批卡失败/半发送状态低频补偿；只补当前 active 步骤，不重复打扰已处理节点。
 */
const stopPermissionApprovalCardRetry = backgroundWorker ? startPermissionApprovalCardRetry(deps) : () => {}

/**
 * 上次进程被重启/崩溃时没跑完的钉钉回合：Stream 重连不会替我们重推已 ACK 的消息，
 * 所以启动后必须自己从 channel_turns 里捞出来，复用原卡、原消息 id 和原工具幂等键继续跑。
 * 延迟 10 秒等插件模型和工具注册完成，避免恢复时模型目录还没就绪就直接判失败；
 * 异步执行，不阻塞健康检查；单个回合失败只收口，不影响其它回合。
 */
const recoverTimer = backgroundWorker
  ? setTimeout(() => {
      void recoverInterruptedDingTalkTurns(deps).catch((error) => {
        console.warn('[eab] 中断的钉钉回合恢复失败：', (error as Error).message)
      })
    }, 10_000)
  : null
recoverTimer?.unref?.()

async function shutdown(): Promise<void> {
  stopRetention()
  stopScheduleWorker()
  stopJobWorker()
  stopModelHealthMonitor()
  stopPluginModelCatalogSync()
  stopOrgSyncScheduler()
  stopMemoryMaintenance()
  stopDingTalkStreamMonitor()
  stopPermissionApprovalCardRetry()
  stopDingTalkStream()
  // 只断连接不释放租约会让下一次启动等 90 秒；必须在退出时显式释放。
  releaseDingTalkStreamLeadership()
  stopFeishuStreamMonitor()
  stopFeishuStream()
  stopRestartWakeRecovery()
  await closeApps(apps)
  await closeBackends()
  processLock.release()
  liveDb.close()
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
