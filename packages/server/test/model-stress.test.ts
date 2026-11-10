import { describe, expect, it } from 'vitest'
import { createModelStressState, modelStressSnapshot, runModelStress } from '../src/model-stress.js'

describe('model stress runner', () => {
  it('respects the concurrency cap and aggregates successes and failures', async () => {
    const state = createModelStressState(12, 3)
    let active = 0
    let maxActive = 0

    await runModelStress(state, async (index) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        await new Promise((resolve) => setTimeout(resolve, index % 3 === 0 ? 8 : 4))
        if (index === 5) throw new Error('上游返回 503')
      } finally {
        active -= 1
      }
    })

    const snapshot = modelStressSnapshot(state)
    expect(maxActive).toBeLessThanOrEqual(3)
    expect(snapshot.completed).toBe(12)
    expect(snapshot.success).toBe(11)
    expect(snapshot.failed).toBe(1)
    expect(snapshot.errors).toHaveLength(1)
    expect(snapshot.errors[0].message).toContain('503')
    expect(snapshot.successRate).toBeCloseTo(11 / 12)
    expect(snapshot.latencyMs.p50).toBeGreaterThan(0)
    expect(snapshot.throughputRps).toBeGreaterThan(0)
    expect(snapshot.running).toBe(false)
  })

  it('keeps the first eight errors only in the snapshot', async () => {
    const state = createModelStressState(10, 2)
    await runModelStress(state, async (index) => {
      if (index >= 2) throw new Error(`失败 ${index}`)
    })
    const snapshot = modelStressSnapshot(state)
    expect(snapshot.failed).toBe(8)
    expect(snapshot.errors).toHaveLength(8)
    expect(snapshot.errors[0].index).toBe(2)
    expect(snapshot.latencyMs.min).toBeGreaterThanOrEqual(0)
  })
})
