/**
 * 正在执行中的工具登记（进程内、只读观测）。
 *
 * 目的：工具耗时看板只能看到「已经跑完的」，卡在工具里的时候看不到任何东西。
 * 这张登记表让控制台能回答「现在谁卡在哪个工具上、卡了多少秒」，也是判断
 * 要不要做对话后台化的实时证据。
 *
 * 约束：只记内存，不落库、不加锁、不参与调度；漏登记的代价只是少一行展示，
 * 不会影响工具本身的行为。
 */

export interface ToolInflightEntry {
  readonly id: string
  readonly toolId: string
  readonly runId: string | null
  readonly channel: string | null
  readonly startedAt: number
}

export interface ToolInflightView {
  toolId: string
  runId: string | null
  channel: string | null
  elapsedMs: number
}

const inflight = new Map<string, ToolInflightEntry>()
let seq = 0

export function beginToolInflight(opts: {
  toolId: string
  runId?: string | null
  channel?: string | null
}): { end: () => void } {
  seq += 1
  const id = `${opts.toolId}#${seq}`
  inflight.set(id, {
    id,
    toolId: opts.toolId,
    runId: opts.runId ?? null,
    channel: opts.channel ?? null,
    startedAt: Date.now(),
  })
  let done = false
  return {
    end() {
      if (done) return
      done = true
      inflight.delete(id)
    },
  }
}

export function toolInflightSnapshot(limit = 10, now = Date.now()): ToolInflightView[] {
  return [...inflight.values()]
    .map((entry) => ({
      toolId: entry.toolId,
      runId: entry.runId,
      channel: entry.channel,
      elapsedMs: Math.max(0, now - entry.startedAt),
    }))
    .sort((a, b) => b.elapsedMs - a.elapsedMs)
    .slice(0, Math.max(1, limit))
}

export function toolInflightCount(): number {
  return inflight.size
}

/** 测试用：清空登记，避免用例之间互相影响 */
export function resetToolInflightForTest(): void {
  inflight.clear()
  seq = 0
}
