import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import {
  beginChannelTurn,
  claimChannelTurn,
  finishChannelTurn,
  getChannelTurn,
  listRecoverableChannelTurns,
  setChannelTurnCard,
  setChannelTurnProgress,
} from '../src/channel-turns.js'

function memoryDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  return db
}

function begin(db: ReturnType<typeof memoryDb>, id: string, eventKey: string) {
  return beginChannelTurn(db, {
    id,
    companyId: 'c1',
    provider: 'dingtalk',
    externalId: 'staff-1',
    userId: 'u1',
    sessionId: 's1',
    eventKey,
    payload: { msgId: eventKey, text: { content: '经营中心有哪些人' } },
    userMessageId: `user-${id}`,
    assistantMessageId: id,
    agentTurnId: `agent-${id}`,
    startedAt: Date.now(),
  })
}

describe('渠道中断回合持久化', () => {
  it('登记后能被启动恢复扫描到，卡片和工具进度可回读', () => {
    const db = memoryDb()
    expect(begin(db, 'turn-1', 'msg-1')).toBe(true)

    const [turn] = listRecoverableChannelTurns(db, 'dingtalk')
    expect(turn?.id).toBe('turn-1')
    expect(turn?.status).toBe('running')
    expect(turn?.payload).toMatchObject({ msgId: 'msg-1' })

    setChannelTurnCard(db, 'turn-1', 'eab_a2ui_abc', 'a2ui')
    setChannelTurnProgress(db, 'turn-1', { tools: [{ name: 'org.directory', status: 'done' }] })
    const saved = getChannelTurn(db, 'turn-1')
    expect(saved?.cardInstanceId).toBe('eab_a2ui_abc')
    expect(saved?.cardKind).toBe('a2ui')
    expect(saved?.progress).toMatchObject({ tools: [{ name: 'org.directory', status: 'done' }] })
  })

  it('同一事件只登记一次，不会覆盖已有进度', () => {
    const db = memoryDb()
    expect(begin(db, 'turn-1', 'msg-1')).toBe(true)
    expect(begin(db, 'turn-2', 'msg-1')).toBe(false)
    expect(getChannelTurn(db, 'turn-1')?.assistantMessageId).toBe('turn-1')
    expect(getChannelTurn(db, 'turn-2')).toBeNull()
  })

  it('完成/失败后不再进入恢复队列', () => {
    const db = memoryDb()
    begin(db, 'turn-1', 'msg-1')
    finishChannelTurn(db, 'turn-1', 'completed')
    expect(listRecoverableChannelTurns(db, 'dingtalk')).toEqual([])

    begin(db, 'turn-2', 'msg-2')
    finishChannelTurn(db, 'turn-2', 'failed', '模型调用失败')
    expect(listRecoverableChannelTurns(db, 'dingtalk')).toEqual([])
    expect(getChannelTurn(db, 'turn-2')?.error).toBe('模型调用失败')
  })

  it('恢复权只被一个实例抢到，超过重试上限不再抢占', () => {
    const db = memoryDb()
    begin(db, 'turn-1', 'msg-1')
    expect(claimChannelTurn(db, 'turn-1', 1)).toBe(true)
    expect(getChannelTurn(db, 'turn-1')?.status).toBe('recovering')
    expect(getChannelTurn(db, 'turn-1')?.attempts).toBe(1)
    // 已经达到上限，第二个实例不能再抢。
    expect(claimChannelTurn(db, 'turn-1', 1)).toBe(false)
  })
})
