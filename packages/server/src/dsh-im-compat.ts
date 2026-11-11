/**
 * EAB → dsh-im 兼容层。
 *
 * `dsh-ding-card` 并不通过服务接口读取 dsh-im，而是直接读 DSH 的落盘协议：
 *   - profile 里是否装了 `@xmanrui/dsh-im`（POST /profiles/<name>/package.json + node_modules 标记）
 *   - `~/.dsh/integrations/dsh-dingtalk/config.json` 里的机器人（clientId / secretRef / approvedSenders）
 *   - `~/.dsh/integrations/dsh-dingtalk/bots/<botId>/state.json` 里的 p2p/group → session 路由
 *   - `~/.dsh/integrations/dsh-ding-card/profiles/<name>/user_names.json` 里的用户昵称
 *
 * 所以这里的做法是：把 EAB 的钉钉渠道配置、会话、成员映射写成同一套文件协议，
 * 并把 DSH_HOME 指到 EAB 数据目录下的隔离副本，让插件以为自己在 dsh-im 的 web profile 中运行。
 * 机器人密钥仍留在 EAB 的 secrets.json，由宿主 ctx.credentials.resolve(secretRef) 暴露。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Db } from '@eab/storage'
import { applyOrgSync, fetchChannelOrg, mapRemoteOrg } from '@eab/channel'
import { deleteSecret, resolveSecret, storeSecret } from './secrets.js'
export const EAB_DSH_PROFILE = 'web'
export const DSH_IM_PACKAGE = '@xmanrui/dsh-im'
/** 兼容层版本：让插件日志/界面能看出这是 EAB 提供的 dsh-im 兼容实现 */
export const DSH_IM_COMPAT_VERSION = '5.10.0-eab.1'

export interface DshImOptions {
  readonly dbPath: string
  /** 已解析的插件运行数据目录；配置后会直接使用，不再拼接 dsh-home */
  readonly dshHomeDir?: string
  /** 兼容旧调用：没给 dshHomeDir 时在它下面拼 dsh-home */
  readonly dataDir?: string
  readonly companyId: string
}

let currentOptions: DshImOptions | null = null
let currentRoot: string | null = null
let currentDb: Db | null = null

/** dsh-im 兼容根目录：优先用控制台配置的独立路径，没配则跟随数据目录。 */
export function dshCompatRoot(options: DshImOptions): string {
  if (options.dshHomeDir) return options.dshHomeDir
  return join(options.dataDir || dirname(options.dbPath), 'dsh-home')
}

export function currentDshCompatRoot(): string | null {
  return currentRoot
}

export function botIdFor(clientId: string): string {
  return `dt_${createHash('sha256').update(clientId).digest('hex').slice(0, 24)}`
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>
  } catch {
    return null
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** 把真实 DSH home 里已有的插件数据拷进隔离副本，避免第一次启用后配置归零 */
function seedExistingData(root: string): void {
  const realHome = process.env.EAB_DSH_REAL_HOME || join(homedir(), '.dsh')
  const copies: Array<[string, string]> = [
    [
      join(realHome, 'integrations', 'dsh-mrrp', 'profiles', 'desktop', 'config.json'),
      join(root, 'integrations', 'dsh-mrrp', 'profiles', EAB_DSH_PROFILE, 'config.json'),
    ],
    [
      join(realHome, 'integrations', 'dsh-ding-card', 'profiles', 'desktop', 'config.json'),
      join(root, 'integrations', 'dsh-ding-card', 'profiles', EAB_DSH_PROFILE, 'config.json'),
    ],
  ]
  for (const [source, target] of copies) {
    if (existsSync(source) && !existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
    }
  }
}

function writeProfile(root: string): void {
  const profileDir = join(root, 'profiles', EAB_DSH_PROFILE)
  writeJson(join(profileDir, 'package.json'), {
    name: `eab-dsh-profile-${EAB_DSH_PROFILE}`,
    private: true,
    dependencies: {
      [DSH_IM_PACKAGE]: '^5.10.0',
    },
    dsh: {
      profile: {
        bundles: [DSH_IM_PACKAGE],
      },
    },
  })
  // dsh-ding-card 用 node_modules 标记判断“本 profile 是否装了 dsh-im”
  writeJson(join(profileDir, 'node_modules', DSH_IM_PACKAGE, 'package.json'), {
    name: DSH_IM_PACKAGE,
    version: DSH_IM_COMPAT_VERSION,
    description: 'EAB dsh-im compatibility facade (bot config / session routes / credentials)',
    license: 'MIT',
  })
}

interface DingTalkRow {
  app_id: string | null
  secret_ref: string | null
  robot_code: string | null
}

function dingTalkRow(db: Db, companyId: string): DingTalkRow | null {
  const row = db
    .prepare(
      `SELECT app_id, secret_ref, robot_code
         FROM channel_configs
        WHERE company_id = ? AND provider = 'dingtalk'
        LIMIT 1`,
    )
    .get(companyId) as DingTalkRow | undefined
  return row ?? null
}

function approvedSenders(db: Db, companyId: string): Array<{
  senderKey: string
  staffId: string
  displayName: string
  approvedAt: string
}> {
  const rows = db
    .prepare(
      `SELECT ci.external_id AS external_id, u.name AS name
         FROM channel_identities ci
         JOIN users u ON u.id = ci.user_id
        WHERE ci.company_id = ? AND ci.provider = 'dingtalk' AND ci.revoked_at IS NULL
          AND u.deleted_at IS NULL
        ORDER BY u.name ASC`,
    )
    .all(companyId) as unknown as Array<{ external_id: string; name: string }>
  return rows
    .filter((row) => typeof row.external_id === 'string' && row.external_id.trim() && row.name)
    .map((row) => {
      const staffId = row.external_id.trim()
      return {
        // dsh-dingtalk 的发送者白名单要求 32 位十六进制 senderKey；用 staffId 派生，
        // 保证每次重扫写出的 config.json 稳定，不会让插件认为配置被改坏。
        senderKey: `dt_sender_${createHash('sha256').update(staffId).digest('hex').slice(0, 32)}`,
        staffId,
        displayName: row.name,
        approvedAt: new Date().toISOString(),
      }
    })
}

interface SessionRow {
  id: string
  external_id: string | null
  updated_at: number
  last_message_at: number | null
}

function dingTalkSessions(db: Db, companyId: string): SessionRow[] {
  return db
    .prepare(
      `SELECT id, external_id, updated_at, last_message_at
         FROM chat_sessions
        WHERE company_id = ? AND source = 'dingtalk' AND deleted_at IS NULL
          AND external_id IS NOT NULL
        ORDER BY updated_at DESC`,
    )
    .all(companyId) as unknown as SessionRow[]
}

function writeDingTalkConfig(
  db: Db,
  options: DshImOptions,
  root: string,
): { clientId: string | null; botId: string | null } {
  const row = dingTalkRow(db, options.companyId)
  const clientId = row?.app_id?.trim() || null
  // dsh-dingtalk 只接受由 clientId 派生的 secretRef（DSH_DINGTALK_BOT_SECRET_<digest>）。
  // EAB 的真实密钥仍存在自己的 secrets.json，由 resolveDshImSecret 在解析时映射过去。
  const dshSecretRef = clientId
    ? `DSH_DINGTALK_BOT_SECRET_${createHash('sha256').update(clientId).digest('hex').slice(0, 24).toUpperCase()}`
    : null
  const bots = clientId && dshSecretRef
    ? [
        {
          clientId,
          secretRef: dshSecretRef,
          approvedSenders: approvedSenders(db, options.companyId),
        },
      ]
    : []
  writeJson(join(root, 'integrations', 'dsh-dingtalk', 'config.json'), { version: 1, bots })
  return { clientId, botId: clientId ? botIdFor(clientId) : null }
}

function writeSessionRoutes(db: Db, options: DshImOptions, root: string, botId: string): void {
  const sessions: Record<string, string> = {}
  const recentOutboundMessages: Array<{ conversationKey: string; sentAt: number }> = []
  for (const row of dingTalkSessions(db, options.companyId)) {
    if (!row.external_id) continue
    const key = `p2p:${row.external_id}`
    sessions[key] = row.id
    if (recentOutboundMessages.length < 20) {
      recentOutboundMessages.push({ conversationKey: key, sentAt: Number(row.last_message_at ?? row.updated_at) || 0 })
    }
  }
  writeJson(join(root, 'integrations', 'dsh-dingtalk', 'bots', botId, 'state.json'), {
    version: 1,
    sessions,
    recentOutboundMessages,
    seenMessageIds: [],
  })
}

function writeUserNames(db: Db, options: DshImOptions, root: string): void {
  const names: Record<string, string> = {}
  for (const sender of approvedSenders(db, options.companyId)) names[sender.staffId] = sender.displayName
  writeJson(join(root, 'integrations', 'dsh-ding-card', 'profiles', EAB_DSH_PROFILE, 'user_names.json'), names)
}

/**
 * 准备 dsh-im 兼容环境。会设置 DSH_HOME / DSH_PROFILE，让随后加载的 DSH 插件读这份隔离副本。
 * 幂等：每次插件宿主重扫、每条钉钉消息都可以调用。
 */
export function prepareDshImCompat(db: Db, options: DshImOptions): void {
  currentOptions = options
  currentDb = db
  const root = dshCompatRoot(options)
  currentRoot = root
  // 桌面 DSH 的 ~/.dsh 不能被 EAB 插件改写：整棵兼容树放在 EAB 数据目录下
  process.env.DSH_HOME = root
  process.env.DSH_PROFILE = EAB_DSH_PROFILE
  // 插件通过 profile 名判断环境；web 与 EAB 的网页控制台语义一致
  mkdirSync(root, { recursive: true })
  seedExistingData(root)
  writeProfile(root)
  writeUserNames(db, options, root)
  const { botId } = writeDingTalkConfig(db, options, root)
  if (botId) writeSessionRoutes(db, options, root, botId)
}

/** 新的钉钉会话建立后更新 state.json；插件最多 1.5s 后就能按 sessionId 找到会话目标 */
export function syncDshImSession(db: Db, externalId: string, sessionId: string): void {
  if (!currentOptions || !currentRoot) return
  const row = dingTalkRow(db, currentOptions.companyId)
  const clientId = row?.app_id?.trim()
  if (!clientId) return
  const botId = botIdFor(clientId)
  const statePath = join(currentRoot, 'integrations', 'dsh-dingtalk', 'bots', botId, 'state.json')
  const state = readJsonFile(statePath) ?? { version: 1, sessions: {}, seenMessageIds: [] }
  const sessions = {
    ...((state.sessions as Record<string, string> | undefined) ?? {}),
    [`p2p:${externalId}`]: sessionId,
  }
  writeJson(statePath, {
    version: 1,
    sessions,
    recentOutboundMessages: [
      { conversationKey: `p2p:${externalId}`, sentAt: Date.now() },
      ...((state.recentOutboundMessages as Array<{ conversationKey?: string; sentAt?: number }> | undefined) ?? []).filter(
        (item) => item?.conversationKey !== `p2p:${externalId}`,
      ),
    ].slice(0, 20),
    seenMessageIds: Array.isArray(state.seenMessageIds) ? state.seenMessageIds : [],
  })
}

/** 解析插件传进来的 secretRef：密钥始终从 EAB 的 secrets.json / 环境变量取，不写进 DSH 文件 */
export function resolveDshImSecret(secretRef: unknown): string {
  const ref = typeof secretRef === 'string' ? secretRef.trim() : ''
  if (!ref || !currentOptions) return ''
  const direct = resolveSecret(currentOptions.dbPath, ref)
  if (direct) return direct
  // 插件只认自己派生的 DSH_DINGTALK_BOT_SECRET_<digest>；EAB 原来保存的
  // EAB_DINGTALK_APP_SECRET_* 通过当前渠道配置映射过来，避免扫码后被要求重新填密钥。
  if (ref.startsWith('DSH_DINGTALK_BOT_SECRET_') && currentDb) {
    const row = dingTalkRow(currentDb, currentOptions.companyId)
    return resolveSecret(currentOptions.dbPath, row?.secret_ref)
  }
  return ''
}

function readPluginDingTalkBot(root: string): { clientId: string; secretRef: string } | null {
  const file = join(root, 'integrations', 'dsh-dingtalk', 'config.json')
  if (!existsSync(file)) return null
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      bots?: Array<{ clientId?: unknown; secretRef?: unknown }>
    }
    const clientId = typeof doc?.bots?.[0]?.clientId === 'string' ? doc.bots[0].clientId.trim() : ''
    const secretRef = typeof doc?.bots?.[0]?.secretRef === 'string' ? doc.bots[0].secretRef.trim() : ''
    if (!clientId || !/^DSH_DINGTALK_BOT_SECRET_[A-F0-9]{24}$/.test(secretRef)) return null
    return { clientId, secretRef }
  } catch {
    return null
  }
}

async function syncDingTalkOrg(db: Db, options: DshImOptions): Promise<void> {
  const row = dingTalkRow(db, options.companyId)
  const appId = row?.app_id?.trim() || ''
  const appSecret = resolveSecret(options.dbPath, row?.secret_ref)
  if (!appId || !appSecret) throw new Error('钉钉渠道缺少 App ID 或密钥，无法同步通讯录')
  let corpId = ''
  try {
    const extra = db
      .prepare(
        `SELECT corp_id FROM channel_configs WHERE company_id = ? AND provider = 'dingtalk' LIMIT 1`,
      )
      .get(options.companyId) as { corp_id?: string | null } | undefined
    corpId = extra?.corp_id?.trim() || ''
  } catch {
    // 兼容早期测试库或旧迁移：没有 corp_id 时钉钉通讯录仍可用 App 凭证拉取。
  }
  const remote = await fetchChannelOrg('dingtalk', {
    provider: 'dingtalk',
    appId,
    corpId,
    appSecret,
  })
  const root = db
    .prepare(
      `SELECT id, path, depth FROM departments
        WHERE company_id = ? AND parent_id IS NULL AND deleted_at IS NULL
        ORDER BY path LIMIT 1`,
    )
    .get(options.companyId) as { id: string; path: string; depth: number } | undefined
  if (!root) throw new Error('库里没有公司根部门，无法同步组织')
  const plan = mapRemoteOrg(remote, {
    companyId: options.companyId,
    provider: 'dingtalk',
    root,
    rootChannelDeptIds: ['1'],
  })
  const outcome = applyOrgSync(db, { plan, now: Date.now(), recycleAfter: 2 })
  db.prepare(
    `UPDATE channel_configs
        SET last_synced_at = ?, last_sync_run_id = ?, updated_at = ?
      WHERE company_id = ? AND provider = 'dingtalk'`,
  ).run(Date.now(), outcome.runId, Date.now(), options.companyId)
  console.info(
    `[dsh-im] 插件绑定的钉钉机器人已触发通讯录同步：部门 ${remote.depts.length} / 成员 ${remote.users.length} / 运行 ${outcome.runId}`,
  )
}

/**
 * 插件绑定机器人后，把插件落盘的 clientId/secretRef 回写到 EAB 自己的
 * `channel_configs`，再用 EAB 的渠道同步链路拉钉钉通讯录。
 *
 * 插件侧只负责机器人连接与会话，没有组织架构同步实现；这里是唯一的桥。
 * 任何失败都只记录日志，不影响插件自己的绑定结果。
 */
export async function syncDshImDingTalkBinding(): Promise<void> {
  const db = currentDb
  const options = currentOptions
  const root = currentRoot
  if (!db || !options || !root) return
  const bot = readPluginDingTalkBot(root)
  if (!bot) return
  const row = dingTalkRow(db, options.companyId)
  if (row?.app_id === bot.clientId && row?.secret_ref === bot.secretRef) return

  // 插件把新密钥写在它自己的 secretRef 下；老绑定则把 EAB 原有密钥搬过去，
  // 这样后续 EAB 的通讯录同步用同一个 ref 就能解析到明文。
  if (!resolveSecret(options.dbPath, bot.secretRef) && row?.secret_ref) {
    const legacy = resolveSecret(options.dbPath, row.secret_ref)
    if (legacy) storeSecret(options.dbPath, bot.secretRef, legacy, 'DSH_DINGTALK_BOT_SECRET')
  }

  const now = Date.now()
  const existing = db
    .prepare(
      `SELECT id FROM channel_configs WHERE company_id = ? AND provider = 'dingtalk'`,
    )
    .get(options.companyId) as { id: string } | undefined
  if (existing) {
    db.prepare(
      `UPDATE channel_configs
          SET app_id = ?, robot_code = ?, secret_ref = ?, enabled = 1, status = 'bound',
              robot_mode = 'STREAM', agent_id = NULL, unified_app_id = NULL,
              bot_bound_at = ?, bot_bound_by_user_id = 'plugin:dsh-im', updated_at = ?
        WHERE company_id = ? AND provider = 'dingtalk'`,
    ).run(bot.clientId, bot.clientId, bot.secretRef, now, now, options.companyId)
  } else {
    db.prepare(
      `INSERT INTO channel_configs
        (id, company_id, provider, enabled, status, app_id, robot_code, secret_ref,
         robot_mode, bot_bound_at, bot_bound_by_user_id, created_at, updated_at)
       VALUES (?, ?, 'dingtalk', 1, 'bound', ?, ?, ?, 'STREAM', ?, 'plugin:dsh-im', ?, ?)`,
    ).run(
      `ch_plugin_dingtalk_${createHash('sha256').update(bot.clientId).digest('hex').slice(0, 12)}`,
      options.companyId,
      bot.clientId,
      bot.clientId,
      bot.secretRef,
      now,
      now,
      now,
    )
  }
  try {
    await syncDingTalkOrg(db, options)
  } catch (error) {
    console.warn(`[dsh-im] 插件绑定后同步钉钉通讯录失败：${(error as Error)?.message ?? error}`)
  }
}

function scheduleDingTalkBindingSync(): void {
  const timer = setTimeout(() => {
    void syncDshImDingTalkBinding().catch((error) => {
      console.warn(`[dsh-im] 回写钉钉绑定失败：${(error as Error)?.message ?? error}`)
    })
  }, 1500)
  timer.unref?.()
}

export function dshImCredentials(): {
  resolve: (ref: unknown) => Promise<{ value: string } | null>
  set: (ref: unknown, value: unknown) => Promise<void>
  unset: (ref: unknown) => Promise<void>
} {
  return {
    async resolve(ref: unknown) {
      const value = resolveDshImSecret(ref)
      return value ? { value } : null
    },
    async set(ref: unknown, value: unknown) {
      const name = typeof ref === 'string' ? ref.trim() : ''
      if (!name || !currentOptions) throw new Error('dsh-im credential store is not ready')
      const secret = typeof value === 'string' ? value : String(value ?? '')
      if (!secret) throw new Error('dsh-im credential value is empty')
      storeSecret(currentOptions.dbPath, name, secret, 'DSH_DINGTALK_BOT_SECRET')
      // 落盘后立刻回读：写失败或被并发覆盖时直接报错，避免渠道引用指向空密钥。
      if (resolveDshImSecret(name) !== secret) {
        throw new Error(`dsh-im credential 写入后无法回读：${name}`)
      }
      // configStore.save 紧跟在这之后；等它落盘再回写 EAB 渠道配置并同步通讯录。
      scheduleDingTalkBindingSync()
    },
    async unset(ref: unknown) {
      const name = typeof ref === 'string' ? ref.trim() : ''
      if (!name || !currentOptions) return
      deleteSecret(currentOptions.dbPath, name)
    },
  }
}
