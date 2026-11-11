/**
 * 插件模型健康状态。
 *
 * 插件模型不落 `models` 表，上游可用度只能靠实际调用判断。这里维护进程内健康表：
 * - 新注册的插件模型默认“未验证”，探测通过后才进入模型目录与对话候选；
 * - 定时用最短请求探测当前仍启用的插件模型，失败的模型立即从目录隐藏；
 * - 对话里真实调用失败的模型立即标记不可用，成功则恢复；
 * - 插件停用/卸载后由调用方移除模型，这里只负责健康状态。
 *
 * 不把探测结果写库：插件路由本身是运行时注册的，重启后重新探测比读旧状态更可靠。
 */
import { EC, EabError } from '@eab/domain'
import {
  callPluginModel,
  listAllPluginModels,
  type PluginModelDefinition,
} from './plugin-models.js'
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

/** 未探测过的模型默认不可用：必须先真实探测通过，才允许出现在模型目录里。 */
export function isModelHealthy(companyId: string, modelId: string): boolean {
  return companyHealth(companyId).get(modelId)?.healthy === true
}

/**
 * 插件把模型摘掉或模型定义变化时，清掉旧健康结论。
 * 否则同一个 plugin: id 回来时会被当成“已探测可用”，绕过真实回复检验。
 */
export function forgetModelHealth(companyId: string, modelIds: readonly string[]): void {
  const rows = companyHealth(companyId)
  for (const modelId of modelIds) rows.delete(String(modelId))
}

export function isModelHealthKnown(companyId: string, modelId: string): boolean {
  return companyHealth(companyId).has(modelId)
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

const probesInFlight = new Map<string, Promise<boolean>>()

/**
 * 用最小请求探测一个插件模型。探测不经过对话额度，也不落对话消息。
 * 失败包括上游异常、超时、空回复；任一都标记该模型暂时不可用。
 * 同一个模型的重叠探测共用一个请求，避免启动扫描、注册通知和手动刷新重复消耗额度。
 */
export function probePluginModel(
  companyId: string,
  modelId: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const key = `${companyId}:${modelId}`
  const existing = probesInFlight.get(key)
  if (existing) return existing
  const task = (async (): Promise<boolean> => {
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
  })()
  probesInFlight.set(key, task)
  void task.finally(() => {
    if (probesInFlight.get(key) === task) probesInFlight.delete(key)
  })
  return task
}

interface ProbeBatchResult {
  readonly checked: number
  readonly healthy: number
  readonly failed: PluginModelDefinition[]
}

/** 批量探测，限制并发，避免几十个插件模型同时打上游。 */
async function probeModels(
  companyId: string,
  models: readonly PluginModelDefinition[],
  timeoutMs: number,
  concurrency = 3,
): Promise<ProbeBatchResult> {
  const failed: PluginModelDefinition[] = []
  let healthy = 0
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < models.length) {
      const index = cursor
      cursor += 1
      const model = models[index]
      if (!model) return
      const ok = await probePluginModel(companyId, model.id, timeoutMs)
      if (ok) healthy += 1
      else failed.push(model)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), models.length) }, () => worker()),
  )
  return { checked: models.length, healthy, failed }
}

/**
 * 注册/刷新后补探测尚未验证的模型。已经有探测结果的模型不重复探测，
 * 失败模型由定时监控继续重试；手动刷新通道时走 probePluginChannelModels 强制重测。
 */
export async function probeUnverifiedPluginModels(
  companyId: string,
  timeoutMs = 15_000,
): Promise<ProbeBatchResult> {
  const models = listAllPluginModels(companyId).filter(
    (model) => !isModelHealthKnown(companyId, model.id),
  )
  if (models.length === 0) return { checked: 0, healthy: 0, failed: [] }
  return probeModels(companyId, models, timeoutMs, 3)
}

/** 控制台「刷新插件模型」：对这条通道下的模型做一次真实回复探测。 */
export async function probePluginChannelModels(
  companyId: string,
  channelId: string,
  timeoutMs = 15_000,
): Promise<ProbeBatchResult> {
  const models = listAllPluginModels(companyId).filter(
    (model) => model.channelId === String(channelId),
  )
  if (models.length === 0) return { checked: 0, healthy: 0, failed: [] }
  return probeModels(companyId, models, timeoutMs, 3)
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
  let startupRetries = 0

  async function probeAll(): Promise<void> {
    if (running || stopped) return
    const models = listAllPluginModels(companyId)
    if (models.length === 0) {
      // 插件 adapter 的 listModels() 可能晚于启动返回；前几秒补扫几次，避免首轮漏掉。
      if (startupRetries < 5) {
        startupRetries += 1
        const retry = setTimeout(() => void probeAll(), 2_000)
        retry.unref?.()
      }
      return
    }
    running = true
    try {
      const result = await probeModels(companyId, models, timeoutMs, 3)
      if (result.failed.length > 0) {
        console.warn(
          `[eab] 模型健康检查：${result.failed.length}/${result.checked} 个插件模型暂时不可用：` +
            result.failed.map((model) => model.name).join('、'),
        )
      } else {
        console.log(`[eab] 模型健康检查：${result.checked} 个插件模型均可用`)
      }
    } finally {
      running = false
    }
  }

  // 首轮不阻塞启动；探测本身带超时，失败的模型不会进入模型目录。
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
