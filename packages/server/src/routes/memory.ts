/**
 * 记忆分层（CHAT-09）：session / user / dept / company 四层，写入先落"待确认"。
 *
 * AGT-13 起再补 Memory OS 的三条硬规则：
 * - 每条记忆必须归到 preference / fact / decision / episode 四类之一；
 * - 相同范围内高度相近的新记忆不覆盖旧记忆，先落成“冲突待确认”；
 * - 用户确认冲突记忆后，旧记忆才软删除，并留下审计记录。
 *
 * 其他既有规则不变：
 * - 只有确认过的记忆才会进入对话上下文，模型不能静默写长期记忆；
 * - 成员可通过 memory.propose 提交公司级团队学习候选，但必须管理员确认后才会生效；
 * - dept / company 层直接写入需要 memory:admin，普通成员只能写自己的 user 层；
 * - 查询永远按当前身份过滤，不返回别人私有的记忆。
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { EC, EabError, SC, scopeAllows } from '@eab/domain'
import { appendAudit, withTransaction } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok } from '../http.js'
import { resolveActor } from '../session.js'
import {
  MEMORY_TYPES,
  MEMORY_TYPE_LABELS,
  embedMemoryRow,
  findMemoryDuplicateOrConflict,
  findStructuredFactConflict,
  memoryLooksSensitive,
  memoryStatus,
  normalizeMemoryType,
  type MemoryType,
} from '../memory-os.js'
import { memoryAutoConfirmEnabled, memoryAutoExtractMode, personalMemoryAutoActivates, structuredFactFromContent } from '../memory-extractor.js'
import { lastMemoryMaintenanceRun, runMemoryMaintenance } from '../memory-maintenance.js'
import { lastMemoryBenchmarkRun, memoryBenchmarkDataset, runMemoryBenchmark } from '../memory-benchmark.js'

type ScopeType = 'user' | 'dept' | 'company'

function parseMemoryType(value: unknown, fallback: MemoryType = 'preference'): MemoryType {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  const raw = String(value).trim().toLowerCase()
  if (!(MEMORY_TYPES as readonly string[]).includes(raw)) {
    throw new EabError(EC.VALIDATION, 'memoryType 只能是 preference / fact / decision / episode')
  }
  return normalizeMemoryType(raw, fallback)
}

export function registerMemoryRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get<{ Querystring: { status?: string } }>('/api/memories', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    if (!scopeAllows(actor.subject.scopes, SC.MEMORY_READ)) {
      throw new EabError(EC.FORBIDDEN, '当前身份缺少权限：读取记忆（memory:read）', {
        details: { requiredScope: SC.MEMORY_READ },
      })
    }
    const canAdmin = scopeAllows(actor.subject.scopes, SC.MEMORY_ADMIN)
    const now = Date.now()
    const status = String(req.query?.status ?? 'active').trim().toLowerCase()
    const statusCondition =
      status === 'all'
        ? ''
        : status === 'archived'
          ? 'AND m.archived_at IS NOT NULL'
          : status === 'expired'
            ? 'AND (m.valid_to IS NOT NULL AND m.valid_to <= ?)'
            : status === 'pending'
              ? 'AND m.confirmed = 0'
              : status === 'conflict'
                ? 'AND m.confirmed = 0 AND m.conflict_with IS NOT NULL'
                : 'AND m.archived_at IS NULL AND (m.valid_to IS NULL OR m.valid_to > ?)'
    // 普通成员只能看到“自己的待确认记忆 + 已确认的团队记忆”；管理员额外看到待审核的团队候选。
    const visibility = canAdmin ? '' : `AND (m.confirmed = 1 OR (m.scope_type = 'user' AND m.scope_id = ?))`
    const params: Array<string | number> = [
      actor.subject.companyId,
      ...(statusCondition.includes('?') ? [now] : []),
      actor.person.id,
      actor.subject.deptId,
      actor.subject.companyId,
      ...(canAdmin ? [] : [actor.person.id]),
    ]
    const rows = deps.db
      .prepare(
        `SELECT m.id, m.scope_type, m.scope_id, m.content, m.confirmed, m.created_at,
                m.memory_type, m.conflict_with, m.fact_key, m.subject, m.predicate,
                m.object_text, m.confidence, m.valid_from, m.valid_to, m.extraction_source,
                m.archived_at, m.cluster_key, m.merged_from, m.recall_count, m.last_recalled_at,
                c.content AS conflict_content
           FROM memories m
           LEFT JOIN memories c ON c.id = m.conflict_with AND c.deleted_at IS NULL
          WHERE m.company_id = ? AND m.deleted_at IS NULL
            ${statusCondition}
            AND ((m.scope_type = 'user' AND m.scope_id = ?)
              OR (m.scope_type = 'dept' AND m.scope_id = ?)
              OR (m.scope_type = 'company' AND m.scope_id = ?))
            ${visibility}
          ORDER BY m.created_at DESC LIMIT ${status === 'all' ? 200 : 100}`,
      )
      .all(...params) as unknown as Array<{
      id: string
      scope_type: string
      scope_id: string
      content: string
      confirmed: number
      created_at: number
      memory_type: string
      conflict_with: string | null
      fact_key: string | null
      subject: string | null
      predicate: string | null
      object_text: string | null
      confidence: number | null
      valid_from: number | null
      valid_to: number | null
      extraction_source: string | null
      archived_at: number | null
      cluster_key: string | null
      merged_from: string | null
      recall_count: number | null
      last_recalled_at: number | null
      conflict_content: string | null
    }>
    return ok({
      memories: rows.map((row) => {
        const memoryType = normalizeMemoryType(row.memory_type, 'fact')
        return {
          id: row.id,
          scopeType: row.scope_type,
          scopeId: row.scope_id,
          content: row.content,
          memoryType,
          memoryTypeLabel: MEMORY_TYPE_LABELS[memoryType],
          confirmed: row.confirmed === 1,
          status: memoryStatus(row),
          factKey: row.fact_key,
          subject: row.subject,
          predicate: row.predicate,
          object: row.object_text,
          confidence: row.confidence,
          validFrom: row.valid_from ? new Date(row.valid_from).toISOString() : null,
          validTo: row.valid_to ? new Date(row.valid_to).toISOString() : null,
          source: row.extraction_source || 'manual',
          conflictWith: row.conflict_with,
          conflictContent: row.conflict_content,
          archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
          clusterKey: row.cluster_key,
          mergedFrom: row.merged_from ? JSON.parse(row.merged_from) as string[] : [],
          recallCount: row.recall_count ?? 0,
          lastRecalledAt: row.last_recalled_at ? new Date(row.last_recalled_at).toISOString() : null,
          createdAt: new Date(row.created_at).toISOString(),
        }
      }),
      autoExtract: {
        mode: memoryAutoExtractMode(),
        autoConfirm: memoryAutoConfirmEnabled(),
        note: memoryAutoConfirmEnabled()
          ? '个人事实与偏好自动生效，随时可以删除；团队记忆仍需管理员确认。'
          : '自动候选只写影子区，确认后生效。',
      },
    })
  })

  app.get('/api/memories/stats', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    if (!scopeAllows(actor.subject.scopes, SC.MEMORY_READ)) {
      throw new EabError(EC.FORBIDDEN, '当前身份缺少权限：读取记忆（memory:read）')
    }
    const canAdmin = scopeAllows(actor.subject.scopes, SC.MEMORY_ADMIN)
    const now = Date.now()
    const visibility = canAdmin ? '' : `AND (confirmed = 1 OR (scope_type = 'user' AND scope_id = ?))`
    const scopeFilter = `AND ((scope_type = 'user' AND scope_id = ?)
              OR (scope_type = 'dept' AND scope_id = ?)
              OR (scope_type = 'company' AND scope_id = ?))`
    const params: Array<string | number> = [
      actor.subject.companyId,
      actor.person.id,
      actor.subject.deptId,
      actor.subject.companyId,
      ...(canAdmin ? [] : [actor.person.id]),
    ]
    const row = deps.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN confirmed = 1 AND archived_at IS NULL AND (valid_to IS NULL OR valid_to > ?) THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN confirmed = 0 AND conflict_with IS NULL THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN confirmed = 0 AND conflict_with IS NOT NULL THEN 1 ELSE 0 END) AS conflict,
                SUM(CASE WHEN valid_to IS NOT NULL AND valid_to <= ? THEN 1 ELSE 0 END) AS expired,
                SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived,
                SUM(CASE WHEN extraction_source = 'auto' THEN 1 ELSE 0 END) AS auto_total,
                SUM(CASE WHEN extraction_source = 'auto' AND confirmed = 1 THEN 1 ELSE 0 END) AS auto_active,
                SUM(CASE WHEN extraction_source = 'auto' AND confirmed = 0 THEN 1 ELSE 0 END) AS auto_pending,
                SUM(COALESCE(recall_count, 0)) AS recalls
           FROM memories
          WHERE company_id = ? AND deleted_at IS NULL
            ${scopeFilter}
            ${visibility}`,
      )
      .get(now, now, ...params) as unknown as Record<string, number | null>
    const lastRun = lastMemoryMaintenanceRun(deps.db, actor.subject.companyId)
    const extractionSince = now - 7 * 24 * 60 * 60 * 1000
    const extractionRow = deps.db
      .prepare(
        `SELECT COUNT(*) AS runs,
                COALESCE(SUM(extracted), 0) AS extracted,
                COALESCE(SUM(inserted), 0) AS inserted,
                COALESCE(SUM(activated), 0) AS activated,
                COALESCE(SUM(duplicates), 0) AS duplicates,
                COALESCE(SUM(conflicts), 0) AS conflicts,
                COALESCE(SUM(skipped_sensitive), 0) AS skipped_sensitive,
                COALESCE(SUM(CASE WHEN extracted = 0 THEN 1 ELSE 0 END), 0) AS empty_runs,
                COALESCE(SUM(CASE WHEN activated > 0 THEN 1 ELSE 0 END), 0) AS hit_runs
           FROM memory_extraction_runs
          WHERE company_id = ? AND user_id = ? AND created_at >= ?`,
      )
      .get(actor.subject.companyId, actor.person.id, extractionSince) as unknown as Record<string, number | null>
    const extractionChannels = deps.db
      .prepare(
        `SELECT channel,
                COUNT(*) AS runs,
                COALESCE(SUM(inserted), 0) AS inserted,
                COALESCE(SUM(activated), 0) AS activated,
                COALESCE(SUM(conflicts), 0) AS conflicts
           FROM memory_extraction_runs
          WHERE company_id = ? AND user_id = ? AND created_at >= ?
          GROUP BY channel
          ORDER BY runs DESC`,
      )
      .all(actor.subject.companyId, actor.person.id, extractionSince) as unknown as Array<{
        channel: string
        runs: number
        inserted: number
        activated: number
        conflicts: number
      }>
    const rate = (part: number, total: number) => total > 0 ? Math.round((part / total) * 1000) / 10 : 0
    const extractionRuns = extractionRow.runs ?? 0
    const extractedCount = extractionRow.extracted ?? 0
    const insertedCount = extractionRow.inserted ?? 0
    const activatedCount = extractionRow.activated ?? 0
    return ok({
      counts: {
        total: row.total ?? 0,
        active: row.active ?? 0,
        pending: row.pending ?? 0,
        conflict: row.conflict ?? 0,
        expired: row.expired ?? 0,
        archived: row.archived ?? 0,
        autoTotal: row.auto_total ?? 0,
        autoActive: row.auto_active ?? 0,
        autoPending: row.auto_pending ?? 0,
        recalls: row.recalls ?? 0,
      },
      autoExtract: {
        mode: memoryAutoExtractMode(),
        autoConfirm: memoryAutoConfirmEnabled(),
      },
      extraction: {
        windowDays: 7,
        runs: extractionRuns,
        extracted: extractedCount,
        inserted: insertedCount,
        activated: activatedCount,
        pending: Math.max(0, insertedCount - activatedCount),
        duplicates: extractionRow.duplicates ?? 0,
        conflicts: extractionRow.conflicts ?? 0,
        skippedSensitive: extractionRow.skipped_sensitive ?? 0,
        emptyRuns: extractionRow.empty_runs ?? 0,
        hitRuns: extractionRow.hit_runs ?? 0,
        activationRate: rate(activatedCount, insertedCount),
        duplicateRate: rate(extractionRow.duplicates ?? 0, extractedCount),
        conflictRate: rate(extractionRow.conflicts ?? 0, extractedCount),
        channels: extractionChannels.map((item) => ({
          channel: item.channel,
          runs: item.runs,
          inserted: item.inserted,
          activated: item.activated,
          conflicts: item.conflicts,
        })),
      },
      maintenance: lastRun
        ? {
            startedAt: new Date(lastRun.startedAt).toISOString(),
            finishedAt: lastRun.finishedAt ? new Date(lastRun.finishedAt).toISOString() : null,
            result: lastRun.result,
          }
        : null,
      benchmark: {
        dataset: memoryBenchmarkDataset(),
        lastRun: lastMemoryBenchmarkRun(deps.db, actor.subject.companyId),
      },
    })
  })

  app.post('/api/memories/benchmark/run', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    if (!scopeAllows(actor.subject.scopes, SC.MEMORY_WRITE)) {
      throw new EabError(EC.FORBIDDEN, '运行记忆评测需要 memory:write')
    }
    const result = runMemoryBenchmark(deps.db, {
      companyId: actor.subject.companyId,
      userId: actor.person.id,
    })
    appendAudit(deps.db, {
      companyId: actor.subject.companyId,
      actorUserId: actor.person.id,
      action: 'memory.benchmark',
      resourceType: 'memory_benchmark',
      resourceId: result.id,
      result: 'success',
      detail: {
        datasetVersion: result.version,
        total: result.total,
        passed: result.passed,
        missed: result.missed,
        unexpected: result.unexpected,
        sensitiveLeaks: result.sensitiveLeaks,
        passRate: result.passRate,
      },
      ip: req.ip ?? null,
      channel: 'web',
    })
    return ok(result)
  })

  app.post('/api/memories/maintenance/run', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    if (!scopeAllows(actor.subject.scopes, SC.MEMORY_ADMIN)) {
      throw new EabError(EC.FORBIDDEN, '整理记忆需要 memory:admin')
    }
    const result = runMemoryMaintenance(deps.db, {
      companyId: actor.subject.companyId,
      force: true,
    })
    appendAudit(deps.db, {
      companyId: actor.subject.companyId,
      actorUserId: actor.person.id,
      action: 'memory.maintenance',
      resourceType: 'memory',
      resourceId: result.runId,
      result: 'success',
      detail: {
        clusters: result.clusters,
        consolidated: result.consolidated,
        archived: result.archived,
      },
      ip: req.ip ?? null,
      channel: 'web',
    })
    return ok(result)
  })

  app.post<{ Body: { content?: string; scopeType?: string; memoryType?: string } }>(
    '/api/memories',
    async (req, reply) => {
      const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
      if (!scopeAllows(actor.subject.scopes, SC.MEMORY_WRITE)) {
        throw new EabError(EC.FORBIDDEN, '当前身份缺少权限：写入记忆（memory:write）', {
          details: { requiredScope: SC.MEMORY_WRITE },
        })
      }
      const content = String(req.body?.content ?? '').trim()
      if (!content) throw new EabError(EC.VALIDATION, '记忆内容不能为空')
      if (content.length > 1000) throw new EabError(EC.VALIDATION, '单条记忆最多 1000 字')
      if (memoryLooksSensitive(content)) {
        throw new EabError(EC.VALIDATION, '这条内容包含敏感凭证或隐私信息，不能写入长期记忆')
      }
      const scopeType = String(req.body?.scopeType ?? 'user') as ScopeType
      if (!['user', 'dept', 'company'].includes(scopeType)) {
        throw new EabError(EC.VALIDATION, 'scopeType 只能是 user / dept / company')
      }
      if (scopeType !== 'user' && !scopeAllows(actor.subject.scopes, SC.MEMORY_ADMIN)) {
        throw new EabError(EC.FORBIDDEN, '部门/公司级记忆需要 memory:admin')
      }
      const memoryType = parseMemoryType(req.body?.memoryType, 'preference')
      const scopeId =
        scopeType === 'user' ? actor.person.id : scopeType === 'dept' ? actor.subject.deptId : actor.subject.companyId
      // 手工新增“事实”时，如果内容是“我叫小张/我习惯…”这类高置信句式，顺手补结构化槽位。
      const derived = memoryType === 'fact' ? structuredFactFromContent(content) : null
      const factKey = derived?.factKey ?? null
      const duplicateOrConflict = factKey
        ? findStructuredFactConflict(deps.db, {
            companyId: actor.subject.companyId,
            scopeType,
            scopeId,
            factKey,
            objectText: derived?.objectText ?? content,
          })
        : findMemoryDuplicateOrConflict(deps.db, {
            companyId: actor.subject.companyId,
            scopeType,
            scopeId,
            memoryType,
            content,
          })
      if (duplicateOrConflict?.kind === 'duplicate') {
        return ok({
          id: duplicateOrConflict.memory.id,
          scopeType,
          content: duplicateOrConflict.memory.content,
          memoryType,
          memoryTypeLabel: MEMORY_TYPE_LABELS[memoryType],
          factKey,
          confirmed: duplicateOrConflict.memory.confirmed === 1,
          status: memoryStatus({
            confirmed: duplicateOrConflict.memory.confirmed,
            conflict_with: duplicateOrConflict.memory.conflict_with ?? null,
          }),
          duplicate: true,
          note: '这条记忆已经存在，没有重复写入',
        })
      }
      const now = Date.now()
      const id = `mem_${randomUUID()}`
      const conflictWith = duplicateOrConflict?.kind === 'conflict' ? duplicateOrConflict.memory.id : null
      const confidence = derived?.confidence ?? 1
      // 用户明确新增的个人事实/偏好/决策，高置信且不冲突就直接生效；冲突仍停下来由本人处理。
      const autoActivate =
        memoryAutoConfirmEnabled() &&
        scopeType === 'user' &&
        !conflictWith &&
        personalMemoryAutoActivates(memoryType, confidence)
      deps.db
        .prepare(
          `INSERT INTO memories
             (id, company_id, scope_type, scope_id, user_id, content, memory_type, confirmed,
              conflict_with, subject, predicate, object_text, fact_key, confidence,
              valid_from, importance, sensitivity, extraction_source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', 'manual', ?)`,
        )
        .run(
          id,
          actor.subject.companyId,
          scopeType,
          scopeId,
          actor.person.id,
          content,
          memoryType,
          autoActivate ? 1 : 0,
          conflictWith,
          derived?.subject ?? null,
          derived?.predicate ?? null,
          derived?.objectText ?? null,
          factKey,
          confidence,
          now,
          derived?.importance ?? (memoryType === 'fact' ? 0.7 : 0.6),
          now,
        )
      await embedMemoryRow(deps.db, deps.config.dbPath, actor.subject.companyId, {
        id,
        content,
        memory_type: memoryType,
        confirmed: autoActivate ? 1 : 0,
        conflict_with: conflictWith,
        created_at: now,
      })
      appendAudit(deps.db, {
        companyId: actor.subject.companyId,
        actorUserId: actor.person.id,
        action: 'memory.create',
        resourceType: 'memory',
        resourceId: id,
        result: 'success',
        detail: {
          scopeType,
          memoryType,
          autoActivated: autoActivate,
          ...(conflictWith ? { conflictWith } : {}),
        },
        ip: req.ip ?? null,
        channel: 'web',
      })
      reply.code(201)
      return ok({
        id,
        scopeType,
        content,
        memoryType,
        memoryTypeLabel: MEMORY_TYPE_LABELS[memoryType],
        factKey,
        confirmed: autoActivate,
        status: conflictWith ? 'conflict' : autoActivate ? 'active' : 'pending',
        conflictWith,
        conflictContent: duplicateOrConflict?.kind === 'conflict' ? duplicateOrConflict.memory.content : null,
        note: conflictWith
          ? '这条记忆与已确认的旧记忆高度相近，已标为冲突待确认；确认后才会替换旧记忆'
          : autoActivate
            ? '已自动生效，和团队共享无关；可随时在“我的记忆”里删除'
            : '待你确认后才会进入对话上下文',
      })
    },
  )

  app.post<{ Params: { id: string } }>('/api/memories/:id/confirm', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    if (!scopeAllows(actor.subject.scopes, SC.MEMORY_WRITE)) {
      throw new EabError(EC.FORBIDDEN, '当前身份缺少权限：写入记忆（memory:write）')
    }
    const row = deps.db
      .prepare(
        `SELECT id, scope_type, scope_id, user_id, content, memory_type, conflict_with, fact_key
           FROM memories
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      )
      .get(req.params.id, actor.subject.companyId) as {
      id: string
      scope_type: string
      scope_id: string
      user_id: string | null
      content: string
      memory_type: string
      conflict_with: string | null
      fact_key: string | null
    } | undefined
    if (!row) throw new EabError(EC.NOT_FOUND, '记忆不存在')
    if (row.scope_type !== 'user' && !scopeAllows(actor.subject.scopes, SC.MEMORY_ADMIN)) {
      throw new EabError(EC.FORBIDDEN, '团队记忆需要管理员确认')
    }
    if (
      row.scope_type === 'user' &&
      row.user_id !== null &&
      row.user_id !== actor.person.id &&
      !scopeAllows(actor.subject.scopes, SC.MEMORY_ADMIN)
    ) {
      throw new EabError(EC.FORBIDDEN, '只能确认自己的记忆')
    }
    const now = Date.now()
    const replacedConflictId = row.conflict_with
    let expiredFactIds: string[] = []
    withTransaction(deps.db, () => {
      if (row.fact_key) {
        const sameKeyRows = deps.db
          .prepare(
            `SELECT id FROM memories
              WHERE company_id = ? AND scope_type = ? AND scope_id = ? AND fact_key = ?
                AND confirmed = 1 AND id <> ? AND deleted_at IS NULL
                AND (valid_to IS NULL OR valid_to > ?)`,
          )
          .all(actor.subject.companyId, row.scope_type, row.scope_id, row.fact_key, row.id, now) as unknown as Array<{ id: string }>
        expiredFactIds = sameKeyRows.map((item) => item.id)
        if (expiredFactIds.length > 0) {
          deps.db
            .prepare(
              `UPDATE memories SET valid_to = ?
                WHERE company_id = ? AND scope_type = ? AND scope_id = ? AND fact_key = ?
                  AND confirmed = 1 AND id <> ? AND deleted_at IS NULL
                  AND (valid_to IS NULL OR valid_to > ?)`,
            )
            .run(now, actor.subject.companyId, row.scope_type, row.scope_id, row.fact_key, row.id, now)
        }
      }
      // 非结构化冲突仍按旧语义软删除；结构化事实只失效，不删除历史。
      if (replacedConflictId && (!row.fact_key || !expiredFactIds.includes(replacedConflictId))) {
        deps.db.prepare(
          `UPDATE memories SET deleted_at = ?, valid_to = COALESCE(valid_to, ?), embedding = NULL, embedding_model = NULL
            WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
        ).run(now, now, replacedConflictId, actor.subject.companyId)
      }
      deps.db.prepare(
        `UPDATE memories
            SET confirmed = 1, conflict_with = NULL, valid_from = COALESCE(valid_from, ?), valid_to = NULL
          WHERE id = ?`,
      ).run(now, req.params.id)
    })
    await embedMemoryRow(deps.db, deps.config.dbPath, actor.subject.companyId, {
      id: row.id,
      content: row.content,
      memory_type: row.memory_type,
      confirmed: 1,
      conflict_with: null,
      created_at: now,
    })
    appendAudit(deps.db, {
      companyId: actor.subject.companyId,
      actorUserId: actor.person.id,
      action: 'memory.confirm',
      resourceType: 'memory',
      resourceId: row.id,
      result: 'success',
      detail: {
        memoryType: normalizeMemoryType(row.memory_type, 'fact'),
        ...(replacedConflictId ? { replacedConflictId } : {}),
        ...(expiredFactIds.length > 0 ? { expiredFactIds } : {}),
      },
      ip: req.ip ?? null,
      channel: 'web',
    })
    return ok({
      id: req.params.id,
      confirmed: true,
      status: 'active',
      ...(replacedConflictId ? { replacedConflictId } : {}),
      ...(expiredFactIds.length > 0 ? { expiredFactIds } : {}),
    })
  })

  app.delete<{ Params: { id: string } }>('/api/memories/:id', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req, deps.companyId)
    if (!scopeAllows(actor.subject.scopes, SC.MEMORY_WRITE)) {
      throw new EabError(EC.FORBIDDEN, '当前身份缺少权限：写入记忆（memory:write）')
    }
    const row = deps.db
      .prepare('SELECT id, scope_type, user_id FROM memories WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
      .get(req.params.id, actor.subject.companyId) as { id: string; scope_type: string; user_id: string | null } | undefined
    if (!row) throw new EabError(EC.NOT_FOUND, '记忆不存在')
    if (row.scope_type !== 'user' && !scopeAllows(actor.subject.scopes, SC.MEMORY_ADMIN)) {
      throw new EabError(EC.FORBIDDEN, '团队记忆需要管理员删除')
    }
    if (
      row.scope_type === 'user' &&
      row.user_id !== null &&
      row.user_id !== actor.person.id &&
      !scopeAllows(actor.subject.scopes, SC.MEMORY_ADMIN)
    ) {
      throw new EabError(EC.FORBIDDEN, '只能删除自己的记忆')
    }
    deps.db
      .prepare(
        `UPDATE memories
            SET deleted_at = ?, valid_to = COALESCE(valid_to, ?), embedding = NULL, embedding_model = NULL
          WHERE id = ?`,
      )
      .run(Date.now(), Date.now(), req.params.id)
    return ok({ id: req.params.id, deleted: true })
  })
}
