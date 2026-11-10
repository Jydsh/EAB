import type { FastifyInstance } from 'fastify'
import { buildScopeFilter, predicateToSql } from '@eab/authz'
import {
  EC,
  EabError,
  SC,
  isCollectionVisible,
  isKnownScope,
  resolveVisibleCollections,
  type Classification,
  type KbCollectionAcl,
} from '@eab/domain'
import { loadKbCollectionAcls } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok, requireScope } from '../http.js'
import { resolveActor } from '../session.js'
import { KB_SOURCE_LABEL } from '../kb-external.js'

interface CollectionRow {
  id: string
  name: string
  description: string | null
  acl_mode: string
  acl_roles: string | null
  acl_dept_paths: string | null
  owner_user_id: string | null
  source_kind: string | null
}

interface CountRow {
  cid: string
  total: number
  confidential: number
}

interface DocRow {
  id: string
  title: string
  classification: string
  chunk_count: number
  status: string
}

const CHUNK_FIELDS = ['company_id', 'collection_id', 'classification'] as const

function parseArray(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function registerKbRoutes(app: FastifyInstance, deps: ServerDeps): void {
  /**
   * 知识库列表：返回"配置"和"当前身份是否可见"。
   * 可见性不是拿 isCollectionVisible 挨个算完就完——同时跑一遍真实的 SQL 谓词，
   * 让页面能直接看到"列表现在就按这个 where 查"，两者不一致会标出来。
   */
  app.get('/api/kb/collections', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.KB_READ)

    const acls = loadKbCollectionAcls(deps.db, subject.companyId)
    const visibleIds = resolveVisibleCollections(subject, acls)

    const filter = buildScopeFilter(subject, SC.KB_READ, 'kb_chunk', { collections: acls })
    const compiled = predicateToSql(filter.predicate, { allowedFields: [...CHUNK_FIELDS] })
    const chunkHits = deps.db
      .prepare(
        `SELECT collection_id AS cid, COUNT(*) AS total, 0 AS confidential
           FROM kb_chunks WHERE ${compiled.sql} GROUP BY collection_id`,
      )
      .all(...(compiled.params as Array<string | number>)) as unknown as CountRow[]
    const sqlCount = new Map(chunkHits.map((row) => [row.cid, Number(row.total)]))

    const docStats = deps.db
      .prepare(
        `SELECT collection_id AS cid, COUNT(*) AS total,
                SUM(CASE WHEN classification = 'confidential' THEN 1 ELSE 0 END) AS confidential
           FROM kb_docs
          WHERE company_id = ? AND deleted_at IS NULL
          GROUP BY collection_id`,
      )
      .all(subject.companyId) as unknown as CountRow[]
    const docMap = new Map(docStats.map((row) => [row.cid, row]))

    const chunkTotals = deps.db
      .prepare(
        `SELECT collection_id AS cid, COUNT(*) AS total FROM kb_chunks WHERE company_id = ? GROUP BY collection_id`,
      )
      .all(subject.companyId) as unknown as CountRow[]
    const chunkMap = new Map(chunkTotals.map((row) => [row.cid, Number(row.total)]))

    const rows = deps.db
      .prepare(
        `SELECT id, name, description, acl_mode, acl_roles, acl_dept_paths, owner_user_id, source_kind
           FROM kb_collections
          WHERE company_id = ? AND deleted_at IS NULL AND status = 'active'
          ORDER BY name`,
      )
      .all(subject.companyId) as unknown as CollectionRow[]

    return ok({
      predicate: { reason: filter.reason, sql: compiled.sql, params: compiled.params },
      collections: rows.map((row) => {
        const acl: KbCollectionAcl | undefined = acls.find((item) => item.collectionId === row.id)
        const docStat = docMap.get(row.id)
        return {
          id: row.id,
          name: row.name,
          description: row.description,
          acl: {
            mode: row.acl_mode,
            roles: parseArray(row.acl_roles),
            deptPaths: parseArray(row.acl_dept_paths),
            ownerUserId: row.owner_user_id,
            // 配置写坏的库会被 loader 跳过：页面要能看见"它现在是关着的"
            valid: acl !== undefined,
          },
          docCount: Number(docStat?.total ?? 0),
          confidentialDocs: Number(docStat?.confidential ?? 0),
          chunkCount: chunkMap.get(row.id) ?? 0,
          visible: visibleIds.has(row.id),
          sqlChunkCount: sqlCount.get(row.id) ?? 0,
          sourceKind: row.source_kind ?? 'local',
          sourceLabel: KB_SOURCE_LABEL[(row.source_kind ?? 'local') as keyof typeof KB_SOURCE_LABEL] ?? row.source_kind,
        }
      }),
    })
  })

  /** 知识库详情：看不到的库直接 403，并说明是哪条规则拦的 */
  app.get('/api/kb/docs', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.KB_READ)

    const query = (req.query ?? {}) as Record<string, string | undefined>
    const collectionId = query.collectionId
    if (collectionId === undefined || collectionId.length === 0) {
      throw new EabError(EC.VALIDATION, '缺少 collectionId')
    }

    const collection = deps.db
      .prepare(
        `SELECT id, name, acl_mode FROM kb_collections
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      )
      .get(collectionId, subject.companyId) as { id: string; name: string; acl_mode: string } | undefined
    if (!collection) throw new EabError(EC.NOT_FOUND, '知识库不存在')

    const acl = loadKbCollectionAcls(deps.db, subject.companyId).find((item) => item.collectionId === collectionId)
    if (acl === undefined) {
      throw new EabError(EC.SCOPE_DENIED, '该知识库的可见范围配置无效，已按"不可见"处理', {
        hint: '让知识库管理员修好可见范围（模式或所有者缺失）后再访问',
        details: { reason: 'kb-acl-missing', collectionId },
      })
    }
    if (!isCollectionVisible(acl, subject)) {
      throw new EabError(EC.SCOPE_DENIED, '无权访问该知识库', {
        hint: '该库配置为「仅特定角色/部门可见」，当前身份不在范围内',
        details: { reason: 'kb-collection-denied', collectionId, mode: acl.mode },
      })
    }

    const docs = deps.db
      .prepare(
        `SELECT id, title, classification, chunk_count, status
           FROM kb_docs
          WHERE collection_id = ? AND company_id = ? AND deleted_at IS NULL
          ORDER BY title`,
      )
      .all(collectionId, subject.companyId) as unknown as DocRow[]

    const canSeeConfidential = subject.scopes.has(SC.KB_ADMIN)
    return ok({
      collection: { id: collection.id, name: collection.name, aclMode: acl.mode },
      docs: docs.map((doc) => {
        const classification = doc.classification as Classification
        return {
          id: doc.id,
          title: doc.title,
          classification,
          chunkCount: Number(doc.chunk_count),
          status: doc.status,
          visible: classification !== 'confidential' || canSeeConfidential,
        }
      }),
    })
  })

  /** 能力自查：给页面/前端渲染菜单用（ADR-13：前端不自己判权限） */
  app.get('/api/kb/can', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    const query = (req.query ?? {}) as Record<string, string | undefined>
    const scope = query.scope ?? ''
    if (!isKnownScope(scope)) throw new EabError(EC.VALIDATION, `未知权限标识: ${scope}`)
    return ok({ scope, allowed: subject.scopes.has(scope) })
  })
}
