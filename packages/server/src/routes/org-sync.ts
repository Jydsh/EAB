/**
 * 组织架构同步接口（M1 CHN-10~12 的第一版：模拟渠道 + 同步报告）。
 *
 * 现在只开放给开发预览（mock provider 不需要凭证）。
 * 接真飞书时只换 provider：路由里的映射、落库、报告三段完全不动。
 */
import type { FastifyInstance } from 'fastify'
import { applyOrgSync, mapRemoteOrg, mockFeishuOrg } from '@eab/channel'
import { EC, EabError, SC } from '@eab/domain'
import type { ServerDeps } from '../deps.js'
import { ok, requireScope } from '../http.js'
import { resolveActor } from '../session.js'

interface RunRow {
  id: string
  provider: string
  mode: string
  status: string
  started_at: number
  ended_at: number | null
  stats_json: string | null
  error_json: string | null
  diff_count: number
}

function forCompany(deps: ServerDeps, companyId: string): ServerDeps {
  return { ...deps, companyId }
}

function companyRootDept(deps: ServerDeps): { id: string; path: string; depth: number } {
  const row = deps.db
    .prepare(
      `SELECT id, path, depth FROM departments
        WHERE company_id = ? AND parent_id IS NULL AND deleted_at IS NULL
        ORDER BY path LIMIT 1`,
    )
    .get(deps.companyId) as { id?: string; path?: string; depth?: number } | undefined
  if (!row?.id || !row.path) {
    throw new EabError(EC.VALIDATION, '库里没有公司根部门，无法同步组织', {
      hint: '先造组织数据（pnpm dev 首次启动会自动生成演示数据）',
    })
  }
  return { id: row.id, path: row.path, depth: Number(row.depth ?? 1) }
}

export function registerOrgSyncRoutes(app: FastifyInstance, deps: ServerDeps): void {
  /** 同步历史（读：查看部门权限即可） */
  app.get('/api/org/sync-runs', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.ORG_DEPT_READ)
    const scope = forCompany(deps, subject.companyId)

    const query = (req.query ?? {}) as Record<string, string | undefined>
    const rawLimit = Number(query.limit ?? '20')
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 20
    const rawOffset = Number(query.offset ?? '0')
    const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0

    const total = Number(
      (
        deps.db
          .prepare('SELECT COUNT(*) AS n FROM org_sync_runs WHERE company_id = ?')
          .get(scope.companyId) as { n: number }
      ).n,
    )

    const rows = deps.db
      .prepare(
        `SELECT r.id, r.provider, r.mode, r.status, r.started_at, r.ended_at, r.stats_json, r.error_json,
                (SELECT COUNT(*) FROM org_sync_diffs d WHERE d.run_id = r.id) AS diff_count
           FROM org_sync_runs r
          WHERE r.company_id = ?
          ORDER BY r.started_at DESC, r.id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(scope.companyId, limit, offset) as unknown as RunRow[]

    return ok({
      total,
      limit,
      offset,
      runs: rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        mode: row.mode,
        status: row.status,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        stats: row.stats_json ? (JSON.parse(row.stats_json) as Record<string, number>) : null,
        error: row.error_json ? (JSON.parse(row.error_json) as unknown) : null,
        diffCount: Number(row.diff_count),
      })),
    })
  })

  /** 同步明细（为什么这次变了这么多） */
  app.get('/api/org/sync-runs/:runId', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.ORG_DEPT_READ)
    const scope = forCompany(deps, subject.companyId)

    const params = (req.params ?? {}) as { runId?: string }
    const runId = params.runId ?? ''
    const run = deps.db
      .prepare(
        `SELECT id, provider, mode, status, started_at, ended_at, stats_json, error_json
           FROM org_sync_runs WHERE id = ? AND company_id = ?`,
      )
      .get(runId, scope.companyId) as
      | {
          id: string
          provider: string
          mode: string
          status: string
          started_at: number
          ended_at: number | null
          stats_json: string | null
          error_json: string | null
        }
      | undefined
    if (!run) throw new EabError(EC.NOT_FOUND, `找不到同步记录: ${runId}`)

    const diffs = deps.db
      .prepare(
        `SELECT item_type, action, entity_id, before_json, after_json, created_at
           FROM org_sync_diffs WHERE run_id = ? ORDER BY created_at, id`,
      )
      .all(runId) as unknown as Array<{
      item_type: string
      action: string
      entity_id: string | null
      before_json: string | null
      after_json: string | null
      created_at: number
    }>

    return ok({
      run: {
        ...run,
        stats: run.stats_json ? JSON.parse(run.stats_json) : null,
        error: run.error_json ? JSON.parse(run.error_json) : null,
      },
      diffs: diffs.map((diff) => ({
        itemType: diff.item_type,
        action: diff.action,
        entityId: diff.entity_id,
        before: diff.before_json ? JSON.parse(diff.before_json) : null,
        after: diff.after_json ? JSON.parse(diff.after_json) : null,
      })),
    })
  })

  /**
   * 跑一次模拟同步（写库，需要 org:sync:run）。
   * step 1/2/3 对应"初始通讯录 / 变更后 / 有人消失"三份快照。
   */
  app.post('/api/dev/org-sync', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.ORG_SYNC_RUN)
    const scope = forCompany(deps, subject.companyId)

    if (!deps.config.devAuth) {
      throw new EabError(EC.NOT_FOUND, '未开放', { hint: '正式环境请通过渠道配置触发同步' })
    }

    const body = (req.body ?? {}) as { step?: unknown }
    const raw = Number(body.step ?? 1)
    const step: 1 | 2 | 3 = raw === 2 ? 2 : raw === 3 ? 3 : 1

    // 同步的前提是"这家公司已经扫码绑定了自己的渠道租户"，否则拉谁的组织都说不清
    const binding = deps.db
      .prepare('SELECT tenant_id, tenant_name FROM channel_configs WHERE company_id = ? AND provider = ?')
      .get(scope.companyId, 'feishu') as { tenant_id?: string | null; tenant_name?: string | null } | undefined
    if (!binding?.tenant_id) {
      throw new EabError(EC.CONFLICT, '还没有绑定飞书企业', {
        hint: '先在「渠道绑定」里扫码绑定飞书企业，再跑组织同步。',
      })
    }

    const plan = mapRemoteOrg(mockFeishuOrg(step), {
      companyId: scope.companyId,
      provider: 'feishu',
      root: companyRootDept(scope),
      rootChannelDeptIds: ['0'],
    })

    const outcome = applyOrgSync(deps.db, { plan, now: Date.now(), recycleAfter: 2 })

    return ok({
      runId: outcome.runId,
      provider: plan.provider,
      step,
      tenant: binding.tenant_name ?? binding.tenant_id,
      mode: 'full',
      stats: outcome.stats,
      diffCount: outcome.diffs.length,
      diffs: outcome.diffs.slice(0, 60),
    })
  })
}
