/**
 * 权限审批流程模板与版本持久化。
 *
 * 边界：模板元信息按公司保存；草稿固定为 current_version + 1；发布时冻结
 * flow_json 快照并保留旧版本，运行时可按 workflow_version 回溯。
 */
import { randomUUID } from 'node:crypto'
import { EC, EabError } from '@eab/domain'
import type { Db } from '@eab/storage'

export type ApprovalFlowBranch = {
  id: string
  label: string
  rule?: { field?: string; op?: string; value?: string }
  nodes: ApprovalFlowNode[]
}

export type ApprovalFlowNode = {
  id: string
  kind: 'start' | 'condition' | 'approval' | 'cc' | 'end'
  title: string
  desc?: string
  meta?: string
  mode?: string
  source?: string
  approvers?: Array<{ id: string; name: string }>
  /** 指定角色审批：提交时按角色解析成员，同一节点会签。 */
  roleCode?: string
  roleName?: string
  /** 直属上级 / 部门负责人链的节点级数，1–10；缺省时使用默认审批链级数。 */
  maxLevels?: number
  /** 审批人空缺时是否追加公司管理员兜底；缺省时沿用默认审批策略。 */
  fallbackAdmin?: boolean
  timeoutHours?: number
  branches?: ApprovalFlowBranch[]
  /** 自由连线模式：出线目标节点 id；一旦出现该字段，整张图按显式连线渲染与校验。 */
  nextIds?: string[]
  /** 出线标签，按目标节点 id 索引；条件节点用于分支名称。 */
  edgeLabels?: Record<string, string>
  /** 条件节点出线规则，按目标节点 id 索引。 */
  edgeRules?: Record<string, ApprovalFlowBranch['rule']>
  /** 四向端口锚点，按目标节点 id 索引；缺省时前端按节点相对位置自动推导。 */
  edgePorts?: Record<string, { from?: 'top' | 'bottom' | 'left' | 'right'; to?: 'top' | 'bottom' | 'left' | 'right' }>
  [key: string]: unknown
}

export interface ApprovalWorkflowView {
  id: string
  name: string
  description: string
  status: 'draft' | 'published' | 'disabled'
  version: number
  draftVersion: number | null
  publishedVersion: number | null
  scopeMode: string
  roleMode: string
  flow: ApprovalFlowNode[]
  validation: string[]
  updatedAt: number
  createdAt: number
}

export interface FlowValidation {
  valid: boolean
  errors: string[]
}

type WorkflowRow = {
  id: string
  company_id: string
  name: string
  description: string
  status: string
  scope_mode: string
  role_mode: string
  current_version: number
  draft_version_id: string | null
  published_version_id: string | null
  created_by: string | null
  created_at: number
  updated_at: number
}

type VersionRow = {
  id: string
  workflow_id: string
  company_id: string
  version: number
  status: string
  flow_json: string
  validation_json: string | null
  published_at: number | null
}

export interface SaveWorkflowInput {
  id?: string
  name?: string
  description?: string
  scopeMode?: string
  roleMode?: string
  flow?: unknown
}

const NODE_KINDS = new Set(['start', 'condition', 'approval', 'cc', 'end'])
const APPROVER_SOURCES = new Set(['dept_chain', 'members', 'manager', 'company_admin', 'role'])
const CONDITION_FIELDS = new Set(['scopeRisk', 'role', 'dept', 'else'])
const MAX_NODES = 100

const DEFAULT_WORKFLOWS: Array<{
  id: string
  name: string
  description: string
  scopeMode: string
  roleMode: string
  status: 'draft' | 'published'
  flow: ApprovalFlowNode[]
}> = [
  {
    id: 'awf_default',
    name: '默认权限流程',
    description: '普通权限点按部门负责人链审批，管理类权限升级到公司管理员。',
    scopeMode: '全部权限点',
    roleMode: '全部员工角色',
    status: 'published',
    flow: [
      { id: 'start', kind: 'start', title: '发起申请', desc: '全部权限点 · 至少选择 1 项', meta: '申请人本人' },
      {
        id: 'cond_risk',
        kind: 'condition',
        title: '是否包含管理类权限？',
        desc: '按权限危险级别自动分流',
        meta: '条件分支',
        branches: [
          {
            id: 'branch_admin',
            label: '是 · 管理类',
            nodes: [
              { id: 'a_admin_1', kind: 'approval', title: '企业级管理员审批', desc: '或签 · 2 人 · 72 小时', meta: '或签' },
              { id: 'a_admin_2', kind: 'approval', title: '平台超管复核', desc: '会签 · 1 人 · 24 小时', meta: '会签' },
            ],
          },
          {
            id: 'branch_normal',
            label: '否 · 普通权限',
            nodes: [
              { id: 'a_dept', kind: 'approval', title: '部门负责人审批', desc: '直属上级 / 部门负责人链 · 默认级数 · 72 小时', meta: '负责人链' },
            ],
          },
        ],
      },
      { id: 'cc_owner', kind: 'cc', title: '抄送申请人直属上级', desc: '站内通知 + 钉钉机器人', meta: '抄送' },
      { id: 'end', kind: 'end', title: '结束', desc: '通过：个人授权 / 拒绝：通知申请人', meta: '结束' },
    ],
  },
  {
    id: 'awf_sensitive',
    name: '高敏权限流程',
    description: '导出、外部连接、成员管理等高风险权限需要双人复核。',
    scopeMode: '按权限点',
    roleMode: '全部员工角色',
    status: 'published',
    flow: [
      { id: 'start', kind: 'start', title: '发起申请', desc: '高敏权限点 · 至少 1 项', meta: '申请人本人' },
      { id: 'a_admin', kind: 'approval', title: '公司管理员审批', desc: '会签 · 2 人 · 48 小时', meta: '会签' },
      { id: 'a_owner', kind: 'approval', title: '平台超管复核', desc: '依次审批 · 1 人 · 24 小时', meta: '依次审批' },
      { id: 'cc_audit', kind: 'cc', title: '抄送审计员', desc: '站内通知', meta: '抄送' },
      { id: 'end', kind: 'end', title: '结束', desc: '通过：个人授权 24 小时 / 拒绝：通知申请人', meta: '结束' },
    ],
  },
  {
    id: 'awf_dept_custom',
    name: '研发部临时权限',
    description: '部门自定义流程草稿，尚未发布。',
    scopeMode: '按权限分组',
    roleMode: '研发部 · 普通员工',
    status: 'draft',
    flow: [
      { id: 'start', kind: 'start', title: '发起申请', desc: '研发部权限分组 · 至少 1 项', meta: '申请人本人' },
      { id: 'a_lead', kind: 'approval', title: '研发负责人审批', desc: '或签 · 1 人 · 48 小时', meta: '或签' },
      { id: 'end', kind: 'end', title: '结束', desc: '通过：个人授权 3 天 / 拒绝：通知申请人', meta: '结束' },
    ],
  },
]

function workflowColumns() {
  return `id, company_id, name, description, status, scope_mode, role_mode,
          current_version, draft_version_id, published_version_id,
          created_by, created_at, updated_at`
}

function normalizeFlow(value: unknown): ApprovalFlowNode[] {
  if (!Array.isArray(value)) throw new EabError(EC.VALIDATION, 'flow 必须是节点数组')
  if (value.length > MAX_NODES) throw new EabError(EC.VALIDATION, `流程节点不能超过 ${MAX_NODES} 个`)
  return value as ApprovalFlowNode[]
}

function collectFlowNodes(flow: ApprovalFlowNode[], out: ApprovalFlowNode[] = []): ApprovalFlowNode[] {
  for (const node of flow || []) {
    out.push(node)
    if (Array.isArray(node?.branches)) {
      for (const branch of node.branches) collectFlowNodes(Array.isArray(branch?.nodes) ? branch.nodes : [], out)
    }
  }
  return out
}

function validateExplicitLinks(nodes: ApprovalFlowNode[], errors: string[]): void {
  const byId = new Map<string, ApprovalFlowNode>()
  for (const node of nodes) byId.set(String(node.id ?? ''), node)
  const outgoing = new Map<string, string[]>()

  for (const node of nodes) {
    const id = String(node.id ?? '')
    if (!Object.prototype.hasOwnProperty.call(node, 'nextIds')) {
      outgoing.set(id, [])
    } else if (!Array.isArray(node.nextIds)) {
      errors.push(`节点 ${id || '(空)'} 的 nextIds 必须是数组`)
      outgoing.set(id, [])
      continue
    } else {
      const targets: string[] = []
      for (const raw of node.nextIds) {
        const target = String(raw ?? '').trim()
        if (!target) {
          errors.push(`节点 ${id || '(空)'} 存在空的出线目标`)
          continue
        }
        if (target === id) {
          errors.push(`节点 ${id || '(空)'} 不能连接到自身`)
          continue
        }
        if (!byId.has(target)) {
          errors.push(`节点 ${id || '(空)'} 的出线目标不存在：${target}`)
          continue
        }
        if (targets.includes(target)) {
          errors.push(`节点 ${id || '(空)'} 存在重复出线：${target}`)
          continue
        }
        targets.push(target)
      }
      outgoing.set(id, targets)
    }

    const labels = node.edgeLabels
    if (labels !== undefined && (!labels || typeof labels !== 'object' || Array.isArray(labels))) {
      errors.push(`节点 ${id || '(空)'} 的 edgeLabels 必须是对象`)
    } else if (labels) {
      for (const key of Object.keys(labels)) {
        if (!(outgoing.get(id) || []).includes(key)) {
          errors.push(`节点 ${id || '(空)'} 的连线标签指向不存在的出线：${key}`)
        }
        if (typeof labels[key] !== 'string') errors.push(`节点 ${id || '(空)'} 的连线标签必须是文本`)
      }
    }
    const rules = node.edgeRules
    if (rules !== undefined && (!rules || typeof rules !== 'object' || Array.isArray(rules))) {
      errors.push(`节点 ${id || '(空)'} 的 edgeRules 必须是对象`)
    }
    const ports = node.edgePorts
    if (ports !== undefined && (!ports || typeof ports !== 'object' || Array.isArray(ports))) {
      errors.push(`节点 ${id || '(空)'} 的 edgePorts 必须是对象`)
    } else if (ports) {
      for (const [key, value] of Object.entries(ports)) {
        if (!(outgoing.get(id) || []).includes(key)) {
          errors.push(`节点 ${id || '(空)'} 的连线端口指向不存在的出线：${key}`)
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          errors.push(`节点 ${id || '(空)'} 的连线 ${key} 端口必须是对象`)
          continue
        }
        for (const sideKey of ['from', 'to'] as const) {
          const side = (value as Record<string, unknown>)[sideKey]
          if (side === undefined) continue
          if (side !== 'top' && side !== 'bottom' && side !== 'left' && side !== 'right') {
            errors.push(`节点 ${id || '(空)'} 的连线 ${key} ${sideKey} 端口方向不合法`)
          }
        }
      }
    }
  }

  if (!byId.has('start')) return
  const startOut = outgoing.get('start') || []
  if (startOut.length !== 1) errors.push('开始节点必须且只能有一条出线')
  for (const [id, node] of byId) {
    const out = outgoing.get(id) || []
    if (node.kind === 'end' && out.some((target) => byId.get(target)?.kind !== 'cc')) {
      errors.push(`结束节点 ${id} 只能连接到抄送节点`)
    }
    if (node.kind !== 'end' && node.kind !== 'cc' && !out.length) {
      errors.push(`节点 ${id || '(空)'} 没有出线，流程会在此中断`)
    }
  }

  for (const node of nodes) {
    if (node.kind !== 'condition') continue
    const id = String(node.id ?? '')
    const out = outgoing.get(id) || []
    if (out.length < 2) errors.push(`条件节点 ${id || '(空)'} 至少需要两条出线`)
    let elseCount = 0
    const labels = node.edgeLabels || {}
    const rules = node.edgeRules || {}
    const labelSet = new Set<string>()
    for (const target of out) {
      const label = String(labels[target] ?? '').trim()
      if (!label) errors.push(`条件节点 ${id || '(空)'} 的出线缺少分支名称`)
      else if (labelSet.has(label)) errors.push(`条件节点 ${id || '(空)'} 的分支名称重复：${label}`)
      if (label) labelSet.add(label)
      const rule = rules[target]
      if (!rule || typeof rule !== 'object') {
        errors.push(`条件节点 ${id || '(空)'} 的分支「${label || target}」缺少条件规则`)
        continue
      }
      const field = String(rule.field ?? '').trim()
      if (!field || !CONDITION_FIELDS.has(field)) {
        errors.push(`分支「${label || target}」条件类型不合法：${field || '(空)'}`)
      }
      if (field === 'else') elseCount += 1
      if ((field === 'role' || field === 'dept') && !String(rule.value ?? '').trim()) {
        errors.push(`分支「${label || target}」缺少条件值`)
      }
    }
    if (elseCount > 1) errors.push(`条件节点 ${id || '(空)'} 最多只能有一个「否则」分支`)
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  let cycle = ''
  const dfs = (id: string) => {
    if (cycle) return
    if (visiting.has(id)) {
      cycle = id
      return
    }
    if (visited.has(id)) return
    visiting.add(id)
    for (const target of outgoing.get(id) || []) dfs(target)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of byId.keys()) dfs(id)
  if (cycle) errors.push(`流程存在循环连线：${cycle}`)

  const reachable = new Set<string>()
  const stack = ['start']
  while (stack.length) {
    const id = stack.pop()!
    if (reachable.has(id)) continue
    reachable.add(id)
    for (const target of outgoing.get(id) || []) stack.push(target)
  }
  for (const id of byId.keys()) {
    if (!reachable.has(id)) errors.push(`节点 ${id} 无法从开始节点到达`)
  }
}

export function validateApprovalFlow(flow: ApprovalFlowNode[], strict = true): FlowValidation {
  const errors: string[] = []
  const ids = new Set<string>()
  const kinds = new Set<string>()
  const nodeMap = new Map<string, ApprovalFlowNode>()
  const scanned = collectFlowNodes(flow)
  const explicitMode = scanned.some((node) => Array.isArray(node?.nextIds))
  let nodeCount = 0
  let approvalCount = 0

  const walk = (nodes: ApprovalFlowNode[], path: string, inBranch: boolean) => {
    const seenInLevel = new Set<string>()
    for (const node of nodes) {
      nodeCount += 1
      if (!node || typeof node !== 'object') {
        errors.push(`${path}存在无效节点`)
        continue
      }
      const id = String(node.id ?? '').trim()
      if (!id) errors.push(`${path}存在缺少 id 的节点`)
      else if (ids.has(id)) errors.push(`节点 id 重复：${id}`)
      else ids.add(id)
      if (id && !nodeMap.has(id)) nodeMap.set(id, node)
      if (seenInLevel.has(id)) errors.push(`${path}同一层级节点 id 重复：${id}`)
      seenInLevel.add(id)
      const kind = String(node.kind ?? '')
      if (!NODE_KINDS.has(kind)) errors.push(`${path}节点 ${id || '(空)'} 类型不合法：${kind}`)
      kinds.add(kind)
      if (!String(node.title ?? '').trim()) errors.push(`${path}节点 ${id || '(空)'} 缺少名称`)
      if (kind === 'approval') {
        approvalCount += 1
        const mode = String(node.mode ?? node.meta ?? '').trim()
        if (!mode) errors.push(`审批节点 ${id || '(空)'} 缺少审批方式`)
        const source = String(node.source ?? '').trim()
        if (source && !APPROVER_SOURCES.has(source)) {
          errors.push(`审批节点 ${id || '(空)'} 审批人来源不合法：${source}`)
        }
        if (node.maxLevels !== undefined && node.maxLevels !== null) {
          const levels = Number(node.maxLevels)
          if (!Number.isInteger(levels) || levels < 1 || levels > 10) {
            errors.push(`审批节点 ${id || '(空)'} 的审批级数必须是 1–10 的整数`)
          }
        }
        if (source === 'role') {
          const roleCode = String(node.roleCode ?? '').trim()
          if (!roleCode) errors.push(`审批节点 ${id || '(空)'} 选择指定角色审批时必须选择角色`)
          if (!mode.includes('会签')) errors.push(`审批节点 ${id || '(空)'} 的指定角色必须使用会签方式`)
        }
        if (source === 'members') {
          const approvers = Array.isArray(node.approvers) ? node.approvers : []
          if (!approvers.length) errors.push(`审批节点 ${id || '(空)'} 选择指定成员审批时至少需要 1 名成员`)
          for (const approver of approvers) {
            if (!approver || !String(approver.id ?? '').trim() || !String(approver.name ?? '').trim()) {
              errors.push(`审批节点 ${id || '(空)'} 的指定成员信息不完整`)
              break
            }
          }
        }
      }
      if (kind === 'condition') {
        const branches = Array.isArray(node.branches) ? node.branches : []
        if (!explicitMode) {
          if (!branches.length) errors.push(`条件节点 ${id || '(空)'} 至少需要一个分支`)
          let elseCount = 0
          const branchIds = new Set<string>()
          for (const branch of branches) {
            if (!branch || typeof branch !== 'object') {
              errors.push(`条件节点 ${id || '(空)'} 存在无效分支`)
              continue
            }
            const branchId = String(branch.id ?? '').trim()
            if (branchId && branchIds.has(branchId)) errors.push(`条件节点 ${id || '(空)'} 的分支 id 重复：${branchId}`)
            if (branchId) branchIds.add(branchId)
            if (!String(branch.label ?? '').trim()) errors.push(`条件节点 ${id || '(空)'} 存在缺少名称的分支`)
            const rule = branch.rule && typeof branch.rule === 'object' ? branch.rule : null
            if (rule?.field) {
              if (!CONDITION_FIELDS.has(String(rule.field))) {
                errors.push(`分支「${branch.label || '(空)'}」条件类型不合法：${rule.field}`)
              }
              if (rule.field === 'else') elseCount += 1
              if ((rule.field === 'role' || rule.field === 'dept') && !String(rule.value ?? '').trim()) {
                errors.push(`分支「${branch.label || '(空)'}」缺少条件值`)
              }
            }
            const branchNodes = Array.isArray(branch.nodes) ? branch.nodes : []
            if (strict && !branchNodes.length) errors.push(`分支「${branch.label || '(空)'}」至少需要一个节点`)
          }
          if (elseCount > 1) errors.push(`条件节点 ${id || '(空)'} 最多只能有一个「否则」分支`)
        }
        for (const branch of branches) {
          if (!branch || typeof branch !== 'object') continue
          const branchNodes = Array.isArray(branch.nodes) ? branch.nodes : []
          walk(branchNodes, `分支「${branch.label || '(空)'}」`, true)
        }
      }
    }
    if (strict && inBranch && !explicitMode && !nodes.some((node) => node?.kind === 'approval')) {
      errors.push(`${path}至少需要一个审批节点`)
    }
  }

  walk(flow, '流程', false)
  if (explicitMode) validateExplicitLinks([...nodeMap.values()], errors)
  if (!kinds.has('start')) errors.push('流程缺少开始节点')
  if (!kinds.has('end')) errors.push('流程缺少结束节点')
  if (strict && approvalCount === 0) errors.push('流程至少需要一个审批节点')
  return { valid: errors.length === 0, errors }
}

function readVersion(db: Db, id: string | null, companyId: string): VersionRow | null {
  if (!id) return null
  const row = db
    .prepare(
      `SELECT id, workflow_id, company_id, version, status, flow_json, validation_json, published_at
         FROM approval_workflow_versions
        WHERE id = ? AND company_id = ? AND workflow_id IN (
          SELECT id FROM approval_workflows WHERE company_id = ? AND deleted_at IS NULL
        ) LIMIT 1`,
    )
    .get(id, companyId, companyId) as VersionRow | undefined
  return row ?? null
}

function parseFlow(row: VersionRow | null): ApprovalFlowNode[] {
  if (!row) return []
  try {
    const parsed = JSON.parse(row.flow_json)
    return Array.isArray(parsed) ? (parsed as ApprovalFlowNode[]) : []
  } catch {
    return []
  }
}

function readWorkflow(db: Db, row: WorkflowRow): ApprovalWorkflowView {
  const draft = readVersion(db, row.draft_version_id, row.company_id)
  const published = readVersion(db, row.published_version_id, row.company_id)
  const active = draft ?? published
  const validation = active?.validation_json ? JSON.parse(active.validation_json) : null
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: (row.status === 'published' || row.status === 'disabled' ? row.status : 'draft'),
    version: Number(row.current_version) || 0,
    draftVersion: draft ? Number(draft.version) : null,
    publishedVersion: published ? Number(published.version) : null,
    scopeMode: row.scope_mode || '全部权限点',
    roleMode: row.role_mode || '全部员工角色',
    flow: parseFlow(active),
    validation: Array.isArray(validation) ? validation : [],
    updatedAt: Number(row.updated_at),
    createdAt: Number(row.created_at),
  }
}

function getWorkflowRow(db: Db, companyId: string, id: string): WorkflowRow {
  const row = db
    .prepare(
      `SELECT ${workflowColumns()}
         FROM approval_workflows
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL
        LIMIT 1`,
    )
    .get(id, companyId) as WorkflowRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, '流程模板不存在')
  return row
}

function insertWorkflow(
  db: Db,
  companyId: string,
  createdBy: string,
  input: { id: string; name: string; description: string; scopeMode: string; roleMode: string },
  now: number,
): WorkflowRow {
  db.prepare(
    `INSERT INTO approval_workflows
       (id, company_id, name, description, status, scope_mode, role_mode,
        current_version, draft_version_id, published_version_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, 0, NULL, NULL, ?, ?, ?)`,
  ).run(
    input.id,
    companyId,
    input.name,
    input.description,
    input.scopeMode,
    input.roleMode,
    createdBy,
    now,
    now,
  )
  return getWorkflowRow(db, companyId, input.id)
}

function writeDraftVersion(
  db: Db,
  workflow: WorkflowRow,
  flow: ApprovalFlowNode[],
  createdBy: string,
  now: number,
): { id: string; version: number } {
  const version = Number(workflow.current_version || 0) + 1
  const existing = workflow.draft_version_id
    ? readVersion(db, workflow.draft_version_id, workflow.company_id)
    : null
  const validation = validateApprovalFlow(flow, false)
  if (existing && Number(existing.version) === version) {
    db.prepare(
      `UPDATE approval_workflow_versions
          SET flow_json = ?, validation_json = ?, updated_at = ?, created_by = ?
        WHERE id = ?`,
    ).run(JSON.stringify(flow), JSON.stringify(validation.errors), now, createdBy, existing.id)
    return { id: existing.id, version }
  }
  const id = `awfv_${randomUUID().replace(/-/g, '')}`
  db.prepare(
    `INSERT INTO approval_workflow_versions
       (id, workflow_id, company_id, version, status, flow_json, validation_json,
        created_by, created_at, updated_at, published_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    workflow.id,
    workflow.company_id,
    version,
    JSON.stringify(flow),
    JSON.stringify(validation.errors),
    createdBy,
    now,
    now,
  )
  return { id, version }
}

export function ensureApprovalWorkflowSeeds(db: Db, companyId: string, createdBy = 'system-seed'): void {
  // 只在公司从未有过任何流程模板时写入种子。用户把模板全部删除后，
  // 仍保留软删除行，不能再次自动补回，否则空状态无法维持。
  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM approval_workflows WHERE company_id = ?`)
    .get(companyId) as { n: number }
  if (Number(count?.n) > 0) return
  const now = Date.now()
  for (const seed of DEFAULT_WORKFLOWS) {
    const row = insertWorkflow(db, companyId, createdBy, {
      id: seed.id,
      name: seed.name,
      description: seed.description,
      scopeMode: seed.scopeMode,
      roleMode: seed.roleMode,
    }, now)
    const version = writeDraftVersion(db, row, seed.flow, createdBy, now)
    if (seed.status === 'published') {
      db.prepare(
        `UPDATE approval_workflow_versions
            SET status = 'published', published_at = ?, updated_at = ?
          WHERE id = ?`,
      ).run(now, now, version.id)
      db.prepare(
        `UPDATE approval_workflows
            SET status = 'published', current_version = ?, draft_version_id = NULL,
                published_version_id = ?, updated_at = ?
          WHERE id = ?`,
      ).run(version.version, version.id, now, row.id)
    } else {
      db.prepare(
        `UPDATE approval_workflows
            SET status = 'draft', draft_version_id = ?, updated_at = ?
          WHERE id = ?`,
      ).run(version.id, now, row.id)
    }
  }
}

export function listApprovalWorkflows(db: Db, companyId: string): ApprovalWorkflowView[] {
  ensureApprovalWorkflowSeeds(db, companyId)
  const rows = db
    .prepare(
      `SELECT ${workflowColumns()}
         FROM approval_workflows
        WHERE company_id = ? AND deleted_at IS NULL
        ORDER BY CASE status WHEN 'published' THEN 0 ELSE 1 END, updated_at DESC, created_at ASC`,
    )
    .all(companyId) as unknown as WorkflowRow[]
  return rows.map((row) => readWorkflow(db, row))
}

export interface PublishedApprovalFlow {
  id: string
  name: string
  version: number
  scopeMode: string
  roleMode: string
  flow: ApprovalFlowNode[]
}

/** 运行时只读已发布版本，避免草稿改动影响已提交申请。 */
export function listPublishedApprovalFlows(db: Db, companyId: string): PublishedApprovalFlow[] {
  ensureApprovalWorkflowSeeds(db, companyId)
  const rows = db
    .prepare(
      `SELECT w.id, w.name, w.scope_mode, w.role_mode, v.version, v.flow_json
         FROM approval_workflows w
         JOIN approval_workflow_versions v ON v.id = w.published_version_id
        WHERE w.company_id = ? AND w.deleted_at IS NULL
          AND w.status = 'published' AND v.status = 'published'
        ORDER BY w.updated_at DESC, w.created_at ASC`,
    )
    .all(companyId) as unknown as Array<{
    id: string
    name: string
    scope_mode: string
    role_mode: string
    version: number
    flow_json: string
  }>
  return rows.map((row) => {
    let flow: ApprovalFlowNode[] = []
    try {
      const parsed = JSON.parse(row.flow_json)
      if (Array.isArray(parsed)) flow = parsed as ApprovalFlowNode[]
    } catch {
      flow = []
    }
    return {
      id: row.id,
      name: row.name,
      version: Number(row.version) || 0,
      scopeMode: row.scope_mode || '全部权限点',
      roleMode: row.role_mode || '全部员工角色',
      flow,
    }
  })
}

export function getApprovalWorkflow(db: Db, companyId: string, id: string): ApprovalWorkflowView {
  return readWorkflow(db, getWorkflowRow(db, companyId, id))
}

export function saveApprovalWorkflow(
  db: Db,
  companyId: string,
  createdBy: string,
  input: SaveWorkflowInput,
): ApprovalWorkflowView {
  const flow = normalizeFlow(input.flow)
  const name = String(input.name ?? '').trim()
  if (!name) throw new EabError(EC.VALIDATION, '流程名称不能为空')
  const description = String(input.description ?? '').trim().slice(0, 500)
  const scopeMode = String(input.scopeMode ?? '全部权限点').trim().slice(0, 80) || '全部权限点'
  const roleMode = String(input.roleMode ?? '全部员工角色').trim().slice(0, 120) || '全部员工角色'
  const now = Date.now()

  let workflow: WorkflowRow
  if (input.id) {
    workflow = getWorkflowRow(db, companyId, String(input.id))
    db.prepare(
      `UPDATE approval_workflows
          SET name = ?, description = ?, scope_mode = ?, role_mode = ?, status = 'draft', updated_at = ?
        WHERE id = ? AND company_id = ?`,
    ).run(name, description, scopeMode, roleMode, now, workflow.id, companyId)
    workflow = getWorkflowRow(db, companyId, workflow.id)
  } else {
    const duplicate = db
      .prepare(
        `SELECT id FROM approval_workflows
          WHERE company_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(companyId, name) as { id: string } | undefined
    if (duplicate) throw new EabError(EC.VALIDATION, '流程名称已存在')
    workflow = insertWorkflow(db, companyId, createdBy, {
      id: `awf_${randomUUID().replace(/-/g, '')}`,
      name,
      description,
      scopeMode,
      roleMode,
    }, now)
  }

  const draft = writeDraftVersion(db, workflow, flow, createdBy, now)
  db.prepare(
    `UPDATE approval_workflows
        SET draft_version_id = ?, status = 'draft', updated_at = ?
      WHERE id = ? AND company_id = ?`,
  ).run(draft.id, now, workflow.id, companyId)
  return getApprovalWorkflow(db, companyId, workflow.id)
}

export function publishApprovalWorkflow(
  db: Db,
  companyId: string,
  createdBy: string,
  id: string,
  flowInput?: unknown,
): ApprovalWorkflowView {
  const workflow = getWorkflowRow(db, companyId, id)
  const now = Date.now()
  let draft = readVersion(db, workflow.draft_version_id, companyId)
  let flow: ApprovalFlowNode[]

  if (flowInput !== undefined) {
    flow = normalizeFlow(flowInput)
    const validation = validateApprovalFlow(flow, true)
    if (!validation.valid) throw new EabError(EC.VALIDATION, `流程校验未通过：${validation.errors.join('；')}`)
    const created = writeDraftVersion(db, workflow, flow, createdBy, now)
    const row = readVersion(db, created.id, companyId)
    if (!row) throw new EabError(EC.INTERNAL, '草稿版本写入失败')
    draft = row
    db.prepare(
      `UPDATE approval_workflows SET draft_version_id = ?, status = 'draft', updated_at = ?
        WHERE id = ? AND company_id = ?`,
    ).run(draft.id, now, workflow.id, companyId)
  } else if (!draft) {
    const published = readVersion(db, workflow.published_version_id, companyId)
    flow = parseFlow(published)
    if (!flow.length) throw new EabError(EC.VALIDATION, '流程还没有保存草稿')
    const validation = validateApprovalFlow(flow, true)
    if (!validation.valid) throw new EabError(EC.VALIDATION, `流程校验未通过：${validation.errors.join('；')}`)
    const created = writeDraftVersion(db, workflow, flow, createdBy, now)
    const row = readVersion(db, created.id, companyId)
    if (!row) throw new EabError(EC.INTERNAL, '草稿版本写入失败')
    draft = row
    db.prepare(
      `UPDATE approval_workflows SET draft_version_id = ?, updated_at = ?
        WHERE id = ? AND company_id = ?`,
    ).run(draft.id, now, workflow.id, companyId)
  } else {
    flow = parseFlow(draft)
  }

  const validation = validateApprovalFlow(flow, true)
  if (!validation.valid) {
    db.prepare(`UPDATE approval_workflow_versions SET validation_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(validation.errors), now, draft.id)
    throw new EabError(EC.VALIDATION, `流程校验未通过：${validation.errors.join('；')}`)
  }
  const previous = readVersion(db, workflow.published_version_id, companyId)
  if (previous && previous.id !== draft.id) {
    db.prepare(`UPDATE approval_workflow_versions SET status = 'superseded', updated_at = ? WHERE id = ?`)
      .run(now, previous.id)
  }
  db.prepare(
    `UPDATE approval_workflow_versions
        SET status = 'published', validation_json = ?, published_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(JSON.stringify(validation.errors), now, now, draft.id)
  db.prepare(
    `UPDATE approval_workflows
        SET status = 'published', current_version = ?, draft_version_id = NULL,
            published_version_id = ?, updated_at = ?
      WHERE id = ? AND company_id = ?`,
  ).run(Number(draft.version), draft.id, now, workflow.id, companyId)
  return getApprovalWorkflow(db, companyId, workflow.id)
}

export function deleteApprovalWorkflow(
  db: Db,
  companyId: string,
  id: string,
): { id: string; name: string } {
  const workflow = getWorkflowRow(db, companyId, id)
  const now = Date.now()
  db.prepare(
    `UPDATE approval_workflows
        SET status = 'disabled', deleted_at = ?, updated_at = ?
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
  ).run(now, now, workflow.id, companyId)
  // 版本行保留，审计和发布历史仍可追溯到原模板。
  return { id: workflow.id, name: workflow.name }
}

export function validateWorkflowFlow(flowInput: unknown): FlowValidation {
  return validateApprovalFlow(normalizeFlow(flowInput), true)
}
