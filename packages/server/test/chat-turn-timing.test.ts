import { describe, expect, it } from 'vitest'
import { createTurnTimingTracker } from '../src/routes/chat.js'

describe('chat turn timing', () => {
  it('records first-token latency and splits generation windows at tool boundaries', () => {
    let clock = 100
    const timing = createTurnTimingTracker(clock, () => clock)

    clock = 130
    timing.token()
    clock = 160
    timing.token()
    clock = 170
    timing.boundary()
    clock = 220
    timing.token()
    clock = 235
    timing.token()
    clock = 240
    timing.finish()

    expect(timing.snapshot()).toEqual({
      ttftMs: 30,
      genMs: 45,
      wallMs: 140,
    })
  })

  it('keeps zero timing when the turn produced no model tokens', () => {
    let clock = 100
    const timing = createTurnTimingTracker(clock, () => clock)
    clock = 125
    timing.finish()

    expect(timing.snapshot()).toEqual({ ttftMs: 0, genMs: 0, wallMs: 25 })
  })
})
