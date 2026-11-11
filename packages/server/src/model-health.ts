/**
 * 插件模型健康状态。
 *
 * 插件模型不落 `models` 表，上游可用度只能靠实际调用判断。这里维护进程内健康表：
 * - 定时用最短请求探测插件模型，失败的模型从对话候选里过滤掉；
 * - 对话里真实调用失败的模型立即标记不可用，成功则恢复；
 * - 健康状态只影响对话候选，不改变控制台的模型目录展示。
 *
 * 不把探测结果写库：插件路由本身是运行时注册的，重启后重新探测比读旧状态更可靠。
 */
import { EC, EabError } from '@eab/domain'
import { callPluginModel, listPluginModels, type PluginModelDefinition } from './plugin-models.js'
import type { ChatMessage } from './llm.js'

interface ModelHealthEntry {
  readonly healthy: boolean
  readonly checkedAt: number
  readonly failures: number
  readonly lastError: string
}

const healthByCompany = new Map<string, Map<string, ModelHealthEntry>>()

function companyHealth(companyId: string): Map<string, ModelHealthEntry> {
  let rows = healthByCompany.get(companyId)
  if (!rows) {
    rows = new Map()
    healthByCompany.set(companyId, rows)
  }
  return rows
}

function errorText(error: unknown): string {
  if (error instanceof EabError) return error.message
  return error instanceof Error ? error.message : String(error)
}

/** 成功调用或成功探测：恢复为可用。 */
export function markModelHealthy(companyId: string, modelId: string): void {
  const rows = companyHealth(companyId)
  const previous = rows.get(modelId)
  rows.set(modelId, {
    healthy: true,
    checkedAt: Date.now(),
    failures: previous?.failures ?? 0,
    lastError: '',
  })
}

/** 失败调用或失败探测：标记不可用，供对话候选过滤。 */
export function markModelUnhealthy(companyId: string, modelId: string, reason: string): void {
  const rows = companyHealth(companyId)
  const previous = rows.get(modelId)
  rows.set(modelId, {
    healthy: false,
    checkedAt: Date.now(),
    failures: (previous?.failures ?? 0) + 1,
    lastError: reason.slice(0, 300),
  })
}

/** 未探测过的模型默认可用，避免服务刚启动时把所有插件模型隐藏掉。 */
export function isModelHealthy(companyId: string, modelId: string): boolean {
  return companyHealth(companyId).get(modelId)?.healthy !== false
}

/**
 * 按健康状态过滤候选。全部不可用时返回空数组，让调用方明确报“当前没有可用模型”，
 * 而不是静默换成一个同样不可用的模型。
 */
export function filterHealthyModels<T extends { id: string }>(companyId: string, models: readonly T[]): T[] {
  return models.filter((model) => isModelHealthy(companyId, model.id))
}

/**
 * 判断一次失败是否应算作“模型不可回复”。
 * 用户中止、参数校验、权限问题不算模型健康问题。
 */
export function shouldMarkModelFailure(error: unknown): boolean {
  if (!error) return false
  if (error instanceof EabError) {
    if (error.code === EC.SCOPE_DENIED || error.code === EC.VALIDATION || error.code === EC.NOT_FOUND) return false
    return error.code === EC.UPSTREAM || error.code === EC.RATE_LIMITED || error.code === EC.CONFLICT
  }
  const name = (error as { name?: string }).name
  return name !== 'AbortError'
}

/**
 * 用最小请求探测一个插件模型。探测不经过对话额度，也不落对话消息。
 * 失败包括上游异常、超时、空回复；任一都标记该模型暂时不可用。
 */
export async function probePluginModel(
  companyId: string,
  modelId: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs))
  const messages: ChatMessage[] = [{ role: 'user', content: '请只回复两个字：可用' }]
  try {
    const result = await callPluginModel(
      companyId,
      modelId,
      messages,
      { signal: controller.signal },
      8,
    )
    if (!result) throw new EabError(EC.UPSTREAM, '插件模型已下线或尚未完成注册')
    if (!result.text.trim()) throw new EabError(EC.UPSTREAM, '插件模型返回空回复')
    markModelHealthy(companyId, modelId)
    return true
  } catch (error) {
    const reason = controller.signal.aborted ? '探测超时' : errorText(error)
    markModelUnhealthy(companyId, modelId, reason)
    return false
  } finally {
    clearTimeout(timer)
  }
}

export interface ModelHealthMonitorOptions {
  readonly intervalMs?: number
  readonly timeoutMs?: number
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 15_000

function positiveMs(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) >= 5_000 ? Math.trunc(value as number) : fallback
}

/**
 * 启动插件模型定时探测。首轮立即跑一次，之后按 intervalMs 周期执行；
 * 返回停止函数，服务关闭时清理定时器。
 */
export function startModelHealthMonitor(
  companyId: string,
  options: ModelHealthMonitorOptions = {},
): () => void {
  const intervalMs = positiveMs(options.intervalMs, DEFAULT_INTERVAL_MS)
  const timeoutMs = positiveMs(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  let running = false
  let stopped = false

  async function probeAll(): Promise<void> {
    if (running || stopped) return
    const models = listPluginModels(companyId)
    if (models.length === 0) return
    running = true
    const failed: PluginModelDefinition[] = []
    try {
      for (const model of models) {
        if (stopped) break
        const okModel = await probePluginModel(companyId, model.id, timeoutMs)
        if (!okModel) failed.push(model)
      }
      if (failed.length > 0) {
        console.warn(
          `[eab] 模型健康检查：${failed.length}/${models.length} 个插件模型暂时不可用：` +
            failed.map((model) => model.name).join('、'),
        )
      } else {
        console.log(`[eab] 模型健康检查：${models.length} 个插件模型均可用`)
      }
    } finally {
      running = false
    }
  }

  // 首轮不阻塞启动；探测本身带超时，失败只影响对话候选。
  void probeAll()
  const timer = setInterval(() => void probeAll(), intervalMs)
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/** 供测试或运维查看当前健康快照。 */
export function modelHealthSnapshot(companyId: string): Array<{
  modelId: string
  healthy: boolean
  checkedAt: number
  failures: number
  lastError: string
}> {
  return [...companyHealth(companyId).entries()].map(([modelId, entry]) => ({
    modelId,
    healthy: entry.healthy,
    checkedAt: entry.checkedAt,
    failures: entry.failures,
    lastError: entry.lastError,
  }))
}
