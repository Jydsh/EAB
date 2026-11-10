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
import { resolveSecret } from './secrets.js'

export const EAB_DSH_PROFILE = 'web'
export const DSH_IM_PACKAGE = '@xmanrui/dsh-im'
/** 兼容层版本：让插件日志/界面能看出这是 EAB 提供的 dsh-im 兼容实现 */
export const DSH_IM_COMPAT_VERSION = '5.10.0-eab.1'

export interface DshImOptions {
  readonly dbPath: string
  readonly dataDir?: string
  readonly companyId: string
}

let currentOptions: DshImOptions | null = null
let currentRoot: string | null = null

/** dsh-im 兼容根目录（与 EAB 数据目录同盘，切数据盘会一起搬走） */
export function dshCompatRoot(options: DshImOptions): string {
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

function approvedSenders(db: Db, companyId: string): Array<{ staffId: string; displayName: string }> {
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
    .map((row) => ({ staffId: row.external_id.trim(), displayName: row.name }))
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
  const secretRef = row?.secret_ref?.trim() || ''
  const bots = clientId
    ? [
        {
          clientId,
          secretRef,
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
  return resolveSecret(currentOptions.dbPath, ref)
}

export function dshImCredentials(): { resolve: (ref: unknown) => Promise<{ value: string } | null> } {
  return {
    async resolve(ref: unknown) {
      const value = resolveDshImSecret(ref)
      return value ? { value } : null
    },
  }
}
