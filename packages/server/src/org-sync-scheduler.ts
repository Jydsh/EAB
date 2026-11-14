/**
 * 渠道通讯录自动同步。
 *
 * 只同步“已绑定且启用”的渠道；未绑定渠道不建按钮、也不进后台任务。
 * 同步本身沿用 applyOrgSync：上游缺失只先计数，连续两次缺失才把成员置为
 * disabled；置为 disabled/departed 后，员工会话校验会立即拒绝继续访问。
 */
import { applyOrgSync, fetchChannelOrg, mapRemoteOrg, type ChannelConfig, type RemoteOrg } from '@eab/channel'
import { EC, EabError } from '@eab/domain'
import type { Db } from '@eab/storage'
import type { ServerConfig } from './config.js'
import { resolveSecret } from './secrets.js'
import { runAsLeader } from './backends/coordination.js'

export type ChannelProvider = 'feishu' | 'dingtalk' | 'wecom'

export const CHANNEL_PROVIDER_LABEL: Record<ChannelProvider, string> = {
  feishu: '飞书',
  dingtalk: '钉钉',
  wecom: '企业微信',
}

export const DEFAULT_ORG_SYNC_INTERVAL_MS = 2 * 60 * 60 * 1000
const MIN_ORG_SYNC_INTERVAL_MS = 5 * 60 * 1000

/** 环境变量可调整周期；非法值回退到 2 小时，最小 5 分钟。 */
export function resolveOrgSyncIntervalMs(): number {
  const raw = Number(process.env.EAB_ORG_SYNC_INTERVAL_MS)
  if (!Number.isFinite(raw) || raw < MIN_ORG_SYNC_INTERVAL_MS) return DEFAULT_ORG_SYNC_INTERVAL_MS
  return Math.trunc(raw)
}

export interface ChannelSyncResult {
  readonly provider: ChannelProvider
  readonly runId: string
  readonly mode: 'full'
  readonly departments: number
  readonly members: number
  readonly mobileCount: number
  readonly stats: ReturnType<typeof applyOrgSync>['stats']
  readonly diffCount: number
  readonly diffs: ReturnType<typeof applyOrgSync>['diffs']
}

interface SyncOptions {
  readonly now?: number
  readonly recycleAfter?: number
  /** 测试注入；生产默认走真实渠道 API。 */
  readonly fetchOrg?: (provider: string, cfg: ChannelConfig) => Promise<RemoteOrg>
}

function markSyncError(db: Db, companyId: string, provider: string, message: string): void {
  db.prepare(
    `UPDATE channel_configs
        SET last_sync_status = 'error', last_sync_error = ?, updated_at = ?
      WHERE company_id = ? AND provider = ?`,
  ).run(message.slice(0, 1000), Date.now(), companyId, provider)
}

/**
 * 同步单个渠道。
 * 手动同步和自动同步共用同一条落库路径，避免两边对缺失成员的处理不一致。
 */
export async function syncChannelOrg(
  db: Db,
  config: ServerConfig,
  companyId: string,
  provider: ChannelProvider,
  options: SyncOptions = {},
): Promise<ChannelSyncResult> {
  const row = db
    .prepare(
      `SELECT app_id, corp_id, secret_ref, tenant_name
         FROM channel_configs
        WHERE company_id = ? AND provider = ?`,
    )
    .get(companyId, provider) as
    | {
        app_id: string | null
        corp_id: string | null
        secret_ref: string | null
        tenant_name: string | null
      }
    | undefined
  const appSecret = resolveSecret(config.dbPath, row?.secret_ref)
  if (!appSecret) {
    throw new EabError(EC.VALIDATION, '还没有保存应用密钥，无法拉取通讯录', {
      hint: '先在渠道接入里填 App ID / 企业 ID 与密钥，保存后再同步',
    })
  }
  const appId = row?.app_id ?? ''
  const corpId = row?.corp_id ?? ''
  if (provider === 'wecom' ? !corpId : !appId) {
    throw new EabError(
      EC.VALIDATION,
      `缺少 ${provider === 'wecom' ? '企业 ID' : 'App ID'}，无法拉取通讯录`,
    )
  }

  db.prepare(
    `UPDATE channel_configs
        SET last_sync_status = 'pending', last_sync_error = NULL, updated_at = ?
      WHERE company_id = ? AND provider = ?`,
  ).run(Date.now(), companyId, provider)

  let remote: RemoteOrg
  try {
    remote = await (options.fetchOrg ?? fetchChannelOrg)(provider, {
      provider,
      appId,
      corpId,
      appSecret,
    })
  } catch (error) {
    const message = `拉取${CHANNEL_PROVIDER_LABEL[provider]}通讯录失败：${(error as Error).message}`
    markSyncError(db, companyId, provider, message)
    throw new EabError(EC.UPSTREAM, message, {
      hint: '检查应用凭证、通讯录权限范围（部门/成员是否授权给该应用）以及服务器出网',
    })
  }

  /**
   * 上游返回 0 个成员但本地还有该渠道成员时，先按异常处理，不进入缺失计数。
   * 否则一次权限配置错误/接口空结果，连续两轮就会把整家公司的人停用。
   */
  if (remote.users.length === 0) {
    const localMembers = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM user_identities ui
           JOIN users u ON u.id = ui.user_id
          WHERE ui.provider = ? AND ui.status <> 'revoked' AND u.deleted_at IS NULL`,
      )
      .get(provider) as { n: number }
    if (Number(localMembers.n) > 0) {
      const message = `${CHANNEL_PROVIDER_LABEL[provider]}返回 0 个成员，已跳过本次同步，避免误停用现有成员`
      markSyncError(db, companyId, provider, message)
      throw new EabError(EC.UPSTREAM, message, {
        hint: '检查应用的通讯录权限范围是否包含成员；确认上游确实为空后，再手动同步一次',
      })
    }
  }

  const root = db
    .prepare(
      `SELECT id, path, depth FROM departments
        WHERE company_id = ? AND parent_id IS NULL AND deleted_at IS NULL
        ORDER BY path LIMIT 1`,
    )
    .get(companyId) as { id: string; path: string; depth: number } | undefined
  if (!root) throw new EabError(EC.VALIDATION, '库里没有公司根部门，无法同步组织')

  const tenantName = String(row?.tenant_name ?? '').trim()
  const providerLabel = CHANNEL_PROVIDER_LABEL[provider]
  const channelRootName =
    tenantName && tenantName !== providerLabel ? `${providerLabel} · ${tenantName}` : providerLabel
  const plan = mapRemoteOrg(remote, {
    companyId,
    provider,
    root,
    rootChannelDeptIds: provider === 'feishu' ? ['0'] : ['1'],
    groupChannelRoot: provider === 'feishu' || provider === 'wecom',
    channelRootName,
  })
  const outcome = applyOrgSync(db, {
    plan,
    now: options.now ?? Date.now(),
    recycleAfter: options.recycleAfter ?? 2,
  })

  db.prepare(
    `UPDATE channel_configs
        SET last_sync_status = 'ok', last_sync_error = NULL, updated_at = ?
      WHERE company_id = ? AND provider = ?`,
  ).run(Date.now(), companyId, provider)

  return {
    provider,
    runId: outcome.runId,
    mode: 'full',
    departments: remote.depts.length,
    members: remote.users.length,
    mobileCount: plan.users.filter((user) => Boolean(user.mobile)).length,
    stats: outcome.stats,
    diffCount: outcome.diffs.length,
    diffs: outcome.diffs.slice(0, 60),
  }
}

export interface BoundChannelSyncOutcome {
  readonly provider: ChannelProvider
  readonly ok: boolean
  readonly result?: ChannelSyncResult
  readonly error?: string
}

/** 同步所有已绑定渠道；单个渠道失败不阻断其他渠道。 */
export async function syncBoundChannels(
  db: Db,
  config: ServerConfig,
  companyId: string,
  options: SyncOptions = {},
): Promise<BoundChannelSyncOutcome[]> {
  const rows = db
    .prepare(
      `SELECT provider FROM channel_configs
        WHERE company_id = ? AND enabled = 1 AND status = 'bound'
        ORDER BY CASE provider WHEN 'dingtalk' THEN 0 WHEN 'feishu' THEN 1 WHEN 'wecom' THEN 2 ELSE 3 END`,
    )
    .all(companyId) as unknown as Array<{ provider: string }>
  const results: BoundChannelSyncOutcome[] = []
  for (const row of rows) {
    if (row.provider !== 'feishu' && row.provider !== 'dingtalk' && row.provider !== 'wecom') continue
    try {
      const result = await syncChannelOrg(db, config, companyId, row.provider, options)
      results.push({ provider: row.provider, ok: true, result })
    } catch (error) {
      const message = (error as Error).message
      markSyncError(db, companyId, row.provider, message)
      results.push({ provider: row.provider, ok: false, error: message })
    }
  }
  return results
}

export interface StartOrgSyncOptions extends SyncOptions {
  readonly intervalMs?: number
  /** 启动后先等一会再跑，避开启动阶段的迁移/插件初始化。 */
  readonly initialDelayMs?: number
}

/**
 * 启动后台定时同步。首轮在 initialDelayMs 后执行，之后每 intervalMs 一次。
 * 返回停止函数，shutdown 时必须调用。
 */
export function startOrgSyncScheduler(
  db: Db,
  config: ServerConfig,
  companyId: string,
  options: StartOrgSyncOptions = {},
): () => void {
  const intervalMs = Math.max(MIN_ORG_SYNC_INTERVAL_MS, options.intervalMs ?? resolveOrgSyncIntervalMs())
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 60_000)
  let stopped = false
  let running = false
  let timer: NodeJS.Timeout | undefined

  const schedule = (delayMs: number) => {
    if (stopped) return
    timer = setTimeout(() => void run(), delayMs)
    timer.unref?.()
  }

  const run = async (): Promise<void> => {
    if (stopped || running) return
    running = true
    try {
      await runAsLeader('org-sync', 10 * 60_000, async () => {
        const outcomes = await syncBoundChannels(db, config, companyId, options)
        for (const outcome of outcomes) {
          if (!outcome.ok) console.warn(`[eab] 自动同步${CHANNEL_PROVIDER_LABEL[outcome.provider]}失败：${outcome.error}`)
        }
      })
    } catch (error) {
      console.warn('[eab] 自动同步任务失败：', (error as Error).message)
    } finally {
      running = false
      if (!stopped) schedule(intervalMs)
    }
  }

  schedule(initialDelayMs)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
