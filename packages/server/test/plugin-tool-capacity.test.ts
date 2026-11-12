import { describe, expect, it } from 'vitest'
import { executePluginTool, pluginToolSemaphore } from '../src/plugin-tools.js'

function fakeTool(pluginId: string, execute: (args: Record<string, unknown>) => unknown) {
  return {
    instanceKey: pluginId,
    companyId: 'c1',
    scope: { kind: 'company' } as const,
    pluginId,
    name: 'slow_tool',
    description: 'test',
    parameters: {},
    execute,
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('插件工具并发与超时', () => {
  it('超过插件并发上限时第二个调用排队', async () => {
    const pluginId = `p-concurrency-${Date.now()}`
    let releaseFirst: () => void = () => {}
    const first = executePluginTool(
      fakeTool(pluginId, () => new Promise<void>((resolve) => (releaseFirst = resolve))),
      {},
      {},
      { maxConcurrent: 1, timeoutMs: 5000 },
    )
    let secondDone = false
    const second = executePluginTool(fakeTool(pluginId, () => 'second'), {}, {}, {
      maxConcurrent: 1,
      timeoutMs: 1000,
    }).then((result) => {
      secondDone = true
      return result
    })

    await Promise.resolve()
    expect(secondDone).toBe(false)
    releaseFirst()
    await first
    await expect(second).resolves.toBe('second')
    expect(secondDone).toBe(true)
    expect(pluginToolSemaphore.pending(pluginId)).toBe(0)
  })

  it('插件工具执行超过超时时间会明确失败', async () => {
    const pluginId = `p-timeout-${Date.now()}`
    const execution = executePluginTool(
      fakeTool(pluginId, async () => {
        await sleep(100)
        return 'late'
      }),
      {},
      {},
      { maxConcurrent: 1, timeoutMs: 20 },
    )
    await expect(execution).rejects.toThrow('执行超时')
    expect(pluginToolSemaphore.pending(pluginId)).toBe(0)
  })
})
