import { describe, expect, it } from 'vitest'
import {
  notifyDingTalkClarifyFromWeb,
  registerDingTalkClarifySync,
} from '../src/dingtalk-clarify-sync.js'

describe('网页作答同步钉钉澄清卡片', () => {
  it('按会话调用最近登记的处理，并回传答案', async () => {
    const calls: Array<{ answer: string; step: number }> = []
    registerDingTalkClarifySync('s-sync-1', async (answer, step) => {
      calls.push({ answer, step })
      return true
    })
    await expect(notifyDingTalkClarifyFromWeb('s-sync-1', '允许通行', 2)).resolves.toBe(true)
    expect(calls).toEqual([{ answer: '允许通行', step: 2 }])
  })

  it('同一会话只保留最新卡片处理器', async () => {
    const calls: string[] = []
    registerDingTalkClarifySync('s-sync-2', async () => {
      calls.push('old')
      return true
    })
    registerDingTalkClarifySync('s-sync-2', async () => {
      calls.push('new')
      return true
    })
    await notifyDingTalkClarifyFromWeb('s-sync-2', '答案', 1)
    expect(calls).toEqual(['new'])
  })

  it('没有登记卡片或处理器失败时返回 false，不抛出', async () => {
    await expect(notifyDingTalkClarifyFromWeb('s-sync-missing', '答案', 1)).resolves.toBe(false)
    registerDingTalkClarifySync('s-sync-3', async () => {
      throw new Error('network down')
    })
    await expect(notifyDingTalkClarifyFromWeb('s-sync-3', '答案', 1)).resolves.toBe(false)
  })
})
