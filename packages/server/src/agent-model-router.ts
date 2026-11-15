/**
 * 父 Agent → 子 Agent 模型分配：优先让 SystemOne 决策模型按任务内容选择。
 *
 * 这里只负责“决策模型能选什么、怎么问、怎么解析”；可见性与最终执行仍由 chat.ts 负责。
 * 任何失败都返回 null，由调用方回退现有的能力匹配规则，不能阻断子 Agent 启动。
 */
import type { Db } from '@eab/storage'
import { resolveModelForPurpose } from './model-registry.js'
import { callSystemOne, type SystemOneQuestion } from './llm.js'

export interface RoutableAgentModel {
  readonly id: string
  readonly name: string
  readonly capabilities?: readonly string[]
  readonly tags?: readonly string[]
  readonly priority: number
  readonly endpointKind?: string
}

export interface RoutableAgentTask {
  readonly title?: string
  readonly prompt: string
  readonly modelId?: string
  readonly key?: string
}

export interface AgentModelDecision {
  readonly modelId: string
  readonly modelName: string
  readonly reason: string
  readonly confidence?: number
}

interface DecisionRequest {
  state: Record<string, unknown>
  questions: Record<string, SystemOneQuestion>
  /** questionId → tasks 下标 */
  taskIndexes: Map<string, number>
  /** 短标签（m1/m2…）→ 候选模型；降低小模型把 UUID 当标签时的歧义 */
  labelToModel: Map<string, RoutableAgentModel>
  candidates: RoutableAgentModel[]
}

/** 只有普通对话端点能真正跑子 Agent；SystemOne 本身是“选模型”的工具，不参与被选。 */
function candidateModels(models: readonly RoutableAgentModel[]): RoutableAgentModel[] {
  const seen = new Set<string>()
  return models.filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return (model.endpointKind ?? 'chat') === 'chat'
  })
}

function clip(text: string, max: number): string {
  const value = text.trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function modelDescription(model: RoutableAgentModel): string {
  const capabilities = [...(model.capabilities ?? []), ...(model.tags ?? [])]
    .map((item) => item.trim())
    .filter(Boolean)
  const capabilityText = [...new Set(capabilities)].slice(0, 8).join(' / ') || '通用对话'
  return `${model.name}；能力：${capabilityText}`
}

export function buildSubAgentDecisionRequest(
  tasks: readonly RoutableAgentTask[],
  models: readonly RoutableAgentModel[],
): DecisionRequest | null {
  const candidates = candidateModels(models)
  if (tasks.length === 0 || candidates.length < 2) return null

  const stateTasks = tasks.map((task, index) => ({
    key: task.key ?? `t${index + 1}`,
    title: task.title ?? `子任务 ${index + 1}`,
    prompt: clip(task.prompt, 2_000),
  }))
  const labels = new Map<string, string>()
  candidates.forEach((model, index) => labels.set(model.id, `m${index + 1}`))
  const labelToModel = new Map(
    candidates.map((model) => [labels.get(model.id) ?? model.id, model] as const),
  )

  const state = {
    purpose: 'agent.model_choice',
    tasks: stateTasks,
    models: candidates.map((model) => ({
      label: labels.get(model.id),
      id: model.id,
      name: model.name,
      capabilities: [...new Set([...(model.capabilities ?? []), ...(model.tags ?? [])])].slice(0, 8),
      priority: model.priority,
    })),
  }

  const criteria: Record<string, string> = {}
  for (const model of candidates) criteria[labels.get(model.id) ?? model.id] = modelDescription(model)

  const questions: Record<string, SystemOneQuestion> = {}
  const taskIndexes = new Map<string, number>()
  tasks.forEach((task, index) => {
    // 显式指定模型优先级最高，不把这道题送去决策，避免多一次无意义的调用。
    if (task.modelId) return
    const questionId = `task_${index + 1}`
    taskIndexes.set(questionId, index)
    questions[questionId] = {
      type: 'choice',
      instructions: `为 state.tasks 中 key=${stateTasks[index].key} 的子任务选择最适合执行的模型。优先任务所需能力，其次避免多个子任务集中到同一模型，最后参考模型优先级。只从 criteria 的模型中选择一个。`,
      criteria,
    }
  })

  if (taskIndexes.size === 0) return null
  return { state, questions, taskIndexes, labelToModel, candidates }
}

/**
 * 本地小模型对“相近候选”的置信度往往偏低；0.5 会让它全部退回能力匹配。
 * 0.3 仍能过滤明显无法区分的答案，同时保留明确任务上的决策结果。
 */
const MIN_CONFIDENCE = 0.3

/**
 * 用 agent.model_choice 用途绑定的 SystemOne 模型，一次批量决定这一批子任务的模型。
 * 返回 null 表示未配置、未启用、低置信度或调用失败，调用方必须回退到 chooseSubAgentModel。
 */
export async function planSubAgentModelsWithDecision(opts: {
  db: Db
  dbPath: string
  companyId: string
  tasks: readonly RoutableAgentTask[]
  models: readonly RoutableAgentModel[]
  /** 公司模型目录；决策模型是服务端基础设施，不要求对员工可见 */
  decisionCatalog?: readonly RoutableAgentModel[]
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<Map<number, AgentModelDecision> | null> {
  const decisionModel = resolveModelForPurpose(opts.db, opts.companyId, 'agent.model_choice')
  if (!decisionModel || decisionModel.endpointKind !== 'systemone') return null
  // 用途路由可能绑定了已删除/停用的模型；只认当前目录里真实存在的那个。
  const decisionCatalog = opts.decisionCatalog ?? opts.models
  if (!decisionCatalog.some((model) => model.id === decisionModel.id)) return null

  const request = buildSubAgentDecisionRequest(opts.tasks, opts.models)
  if (!request) return null

  try {
    const result = await callSystemOne(
      opts.db,
      opts.dbPath,
      opts.companyId,
      decisionModel.id,
      request.state,
      request.questions,
      { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 15_000 },
    )
    const decisions = new Map<number, AgentModelDecision>()
    for (const [questionId, taskIndex] of request.taskIndexes) {
      const answer = result.answers[questionId]
      if (!answer || typeof answer.choice !== 'string') continue
      const model =
        request.labelToModel.get(answer.choice) ??
        request.candidates.find((item) => item.id === answer.choice)
      if (!model) continue
      const confidence = Number(answer.confidence)
      if (Number.isFinite(confidence) && confidence < MIN_CONFIDENCE) continue
      decisions.set(taskIndex, {
        modelId: model.id,
        modelName: model.name,
        reason: Number.isFinite(confidence)
          ? `SystemOne 决策模型按任务内容选择 ${model.name}（置信度 ${Math.round(confidence * 100)}%）`
          : `SystemOne 决策模型按任务内容选择 ${model.name}`,
        confidence: Number.isFinite(confidence) ? confidence : undefined,
      })
    }
    return decisions.size > 0 ? decisions : null
  } catch (error) {
    if (opts.signal?.aborted) throw error
    console.warn(`[agent.model_choice] SystemOne 决策失败，回退能力匹配：${String(error)}`)
    return null
  }
}
