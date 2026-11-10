/**
 * 模型压测：用固定并发把同一句测试请求打给真实模型，只收集延迟和成功率，
 * 不写会话、不写消息。控制台的一次压测就是一个 state，轮询接口读它的快照。
 */
export interface ModelStressFailure {
  readonly index: number
  readonly code: string
  readonly message: string
  readonly durationMs: number
}

export interface ModelStressState {
  readonly total: number
  readonly concurrency: number
  readonly startedAt: number
  completed: number
  success: number
  failed: number
  readonly latencies: number[]
  readonly errors: ModelStressFailure[]
  finishedAt: number | null
  running: boolean
}

export interface ModelStressSnapshot {
  total: number
  concurrency: number
  completed: number
  success: number
  failed: number
  running: boolean
  elapsedMs: number
  successRate: number
  latencyMs: { min: number; p50: number; p95: number; max: number }
  throughputRps: number
  errors: readonly ModelStressFailure[]
  startedAt: number
  finishedAt: number | null
}

export type ModelStressCall = (index: number) => Promise<unknown>

export function createModelStressState(total: number, concurrency: number): ModelStressState {
  return {
    total,
    concurrency,
    startedAt: Date.now(),
    completed: 0,
    success: 0,
    failed: 0,
    latencies: [],
    errors: [],
    finishedAt: null,
    running: true,
  }
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))
  return sorted[index]
}

export function modelStressSnapshot(state: ModelStressState): ModelStressSnapshot {
  const sorted = [...state.latencies].sort((a, b) => a - b)
  const elapsedMs = Math.max(0, (state.finishedAt ?? Date.now()) - state.startedAt)
  const elapsedSeconds = elapsedMs / 1000
  return {
    total: state.total,
    concurrency: state.concurrency,
    completed: state.completed,
    success: state.success,
    failed: state.failed,
    running: state.running,
    elapsedMs,
    successRate: state.completed ? state.success / state.completed : 0,
    latencyMs: {
      min: sorted[0] ?? 0,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted[sorted.length - 1] ?? 0,
    },
    throughputRps: elapsedSeconds > 0 ? state.completed / elapsedSeconds : 0,
    errors: state.errors.slice(0, 8),
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  }
}

export async function runModelStress(state: ModelStressState, call: ModelStressCall): Promise<void> {
  let next = 0
  const workerCount = Math.max(1, Math.min(state.concurrency, state.total))
  const worker = async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= state.total) return
      const started = performance.now()
      try {
        await call(index)
        state.success += 1
        state.latencies.push(performance.now() - started)
      } catch (error) {
        state.failed += 1
        const durationMs = performance.now() - started
        state.errors.push({
          index,
          code: typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code?: unknown }).code) : 'EAB_STRESS_FAILED',
          message: error instanceof Error ? error.message : String(error),
          durationMs,
        })
      } finally {
        state.completed += 1
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  } finally {
    state.finishedAt = Date.now()
    state.running = false
  }
}
