import { randomUUID } from 'node:crypto'
import type { Db } from '@eab/storage'

export type AgentReviewVerdict = 'approve' | 'reject' | 'error'

export interface AgentReviewTraceLike {
  toolId?: string
  name?: string
  status?: string
  args?: Record<string, unknown>
}

export interface ReviewSubmission {
  verdict: 'approve' | 'reject'
  reason: string
  evidence: string[]
}

export interface AgentTaskReviewInput {
  companyId: string
  userId: string
  teamId: string
  taskId: string
  workerKey: string
  childRunId: string
  reviewerRunId: string
  reviewerModelId: string
  verdict: AgentReviewVerdict
  reason: string
  evidence: string[]
  durationMs: number
}

export interface AgentTaskReviewRecord extends AgentTaskReviewInput {
  id: string
  createdAt: number
}

export interface CriticPromptInput {
  taskTitle: string
  prompt: string
  acceptance: string
  builderText: string
  artifacts: Array<{ name: string; path?: string; uri?: string; preview?: string }>
  toolSummary: string[]
}

const MAX_REASON = 2_000
const MAX_EVIDENCE = 8
const MAX_EVIDENCE_CHARS = 600

function clean(value: unknown, max = MAX_REASON): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function parseEvidence(value: unknown): string[] {
  let list: unknown[] = []
  if (Array.isArray(value)) list = value
  else if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) list = parsed
    } catch {
      list = value.split(/\n|；|;/)
    }
  }
  return list
    .map((item) => clean(item, MAX_EVIDENCE_CHARS))
    .filter(Boolean)
    .slice(0, MAX_EVIDENCE)
}

/**
 * 从验收员本轮的 trace 里读取最后一次 review.verdict 提交。
 * 只认工具参数，不认正文里的“我认为通过”，避免模型用自然语言绕过门禁。
 */
export function reviewVerdictFromTraces(traces: readonly AgentReviewTraceLike[]): ReviewSubmission | null {
  const trace = [...traces].reverse().find((item) =>
    item?.toolId === 'review.verdict' || item?.name === 'review_verdict'
  )
  // 没有提交工具、或最后一次提交本身执行失败，都按“没有有效结论”处理。
  if (!trace) return null
  if (trace.status && trace.status !== 'done') return null
  const args = trace.args && typeof trace.args === 'object' ? trace.args : {}
  const verdict = clean(args.verdict, 20).toLowerCase()
  if (verdict !== 'approve' && verdict !== 'reject') return null
  const reason = clean(args.reason)
  const evidence = parseEvidence(args.evidence)
  // 没有理由或没有证据的提交不成立；宁可 fail closed，也不让空话通过。
  if (!reason || evidence.length === 0) return null
  return { verdict, reason, evidence }
}

export function buildCriticPrompt(input: CriticPromptInput): string {
  const artifacts = input.artifacts.length > 0
    ? input.artifacts
        .map((item) => `- ${item.name}${item.path ? `（${item.path}）` : ''}${
          item.uri ? `（${item.uri}）` : ''
        }${item.preview ? `；预览：${item.preview}` : ''}`)
        .join('\n')
    : '（实现员没有登记产物）'
  const tools = input.toolSummary.length > 0
    ? input.toolSummary.map((item) => `- ${item}`).join('\n')
    : '（没有可用的工具记录）'
  return `你是独立验收员，负责复核另一个实现员刚完成的工程任务。你没有写权限，不能代替实现员改代码，只能读、查、跑验证，然后给出结论。

【被验收任务】
${clean(input.taskTitle, 200)}

【原始任务要求】
${clean(input.prompt, 2_000)}

【验收标准】
${clean(input.acceptance, 1_500) || '（原任务没有显式验收标准，请按原始要求逐条核对）'}

【实现员回报】
${clean(input.builderText, 1_500) || '（实现员没有给出文字回报）'}

【实现员登记产物】
${artifacts}

【实现员执行过的工具与结果摘要】
${tools}

【复核职责】
1. 必须实际检查证据，不能只相信实现员自述。至少读取一个相关文件，或运行一次测试/构建/核对命令。
2. 可读文件、搜索工作区、运行测试或构建；不要写文件、改代码、删除、重命名、发消息或登记产物。
3. 逐条对照验收标准。出现以下任一情况必须 reject：
   - 没有真实测试/构建通过证据，或测试失败；
   - 代码/文件没有真正改到目标位置，或只改了说明没有实现；
   - 需求只覆盖一部分，或交付物与原始要求不一致；
   - 实现员只在自述里声称完成，没有可复查的证据。
4. 只有证据充分满足验收标准时才 approve。
5. 最后必须调用 review_verdict 工具提交结论：
   - verdict：approve 或 reject；
   - reason：一句话说明通过或不通过的关键依据；
   - evidence：至少 1 条具体证据，写清命令、文件路径或测试结果。
   不调用 review_verdict、或 evidence 为空，系统会按“未通过”处理。`
}

export function recordAgentTaskReview(db: Db, input: AgentTaskReviewInput): AgentTaskReviewRecord {
  const id = `review_${randomUUID()}`
  const createdAt = Date.now()
  const evidence = input.evidence.map((item) => clean(item, MAX_EVIDENCE_CHARS)).filter(Boolean).slice(0, MAX_EVIDENCE)
  const reason = clean(input.reason) || '未提供复核理由'
  db.prepare(
    `INSERT INTO agent_task_reviews (
      id, company_id, user_id, team_id, task_id, worker_key, child_run_id,
      reviewer_run_id, reviewer_model_id, verdict, reason, evidence_json,
      duration_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.companyId,
    input.userId,
    input.teamId,
    input.taskId,
    input.workerKey,
    input.childRunId,
    input.reviewerRunId,
    input.reviewerModelId,
    input.verdict,
    reason,
    JSON.stringify(evidence),
    Math.max(0, Math.round(input.durationMs)),
    createdAt,
  )
  return { ...input, id, reason, evidence, createdAt }
}

export function latestAgentTaskReview(
  db: Db,
  companyId: string,
  taskId: string,
): AgentTaskReviewRecord | null {
  const row = db.prepare(
    `SELECT id, company_id, user_id, team_id, task_id, worker_key, child_run_id,
            reviewer_run_id, reviewer_model_id, verdict, reason, evidence_json,
            duration_ms, created_at
       FROM agent_task_reviews
      WHERE company_id = ? AND task_id = ?
      ORDER BY created_at DESC
      LIMIT 1`,
  ).get(companyId, taskId) as Record<string, unknown> | undefined
  if (!row) return null
  let evidence: string[] = []
  try {
    evidence = parseEvidence(row.evidence_json)
  } catch {
    evidence = []
  }
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    userId: String(row.user_id),
    teamId: String(row.team_id),
    taskId: String(row.task_id),
    workerKey: String(row.worker_key),
    childRunId: String(row.child_run_id ?? ''),
    reviewerRunId: String(row.reviewer_run_id),
    reviewerModelId: String(row.reviewer_model_id ?? ''),
    verdict: String(row.verdict) as AgentReviewVerdict,
    reason: String(row.reason ?? ''),
    evidence,
    durationMs: Number(row.duration_ms ?? 0),
    createdAt: Number(row.created_at ?? 0),
  }
}

/** 验收员工具白名单：只读 + 跑验证，没有 workspace.write/edit/delete。 */
export const AGENT_CRITIC_TOOL_NAMES: readonly string[] = [
  'workspace_list',
  'workspace_read',
  'workspace_search',
  'project_exec',
  'project_job',
  'office_read_outline',
  'review_verdict',
]
