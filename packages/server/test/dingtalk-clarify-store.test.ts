import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import type { DingTalkClarifyState } from '../src/dingtalk-card.js'
import { createDingTalkClarifyCardStore } from '../src/dingtalk-clarify-store.js'

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('钉钉答题卡状态持久化', () => {
  it('服务重建后仍能按 outTrackId 恢复题组、当前页和逐空草稿', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eab-dingtalk-clarify-'))
    tempDirs.push(dir)
    const path = join(dir, 'eab.db')
    const first = openDatabase({ path })
    migrate(first)

    const state: DingTalkClarifyState = {
      sessionId: 'chat_test',
      question: '第一题',
      options: [],
      kind: 'text',
      step: 1,
      index: 1,
      questions: [
        { id: 'q1', question: '第一题', options: [], kind: 'text' },
        { id: 'q2', question: '第二题', options: [], kind: 'text' },
      ],
      answers: {
        1: { selected: [], text: '停电、验电', blanks: ['停电', '验电'] },
      },
    }
    createDingTalkClarifyCardStore(first, 'c1').save('card-1', state)
    first.close()

    const second = openDatabase({ path })
    try {
      migrate(second)
      const restored = createDingTalkClarifyCardStore(second, 'c1').load('card-1')
      expect(restored).toMatchObject({
        sessionId: 'chat_test',
        index: 1,
        answers: {
          1: { text: '停电、验电', blanks: ['停电', '验电'] },
        },
      })
    } finally {
      second.close()
    }
  })
})
