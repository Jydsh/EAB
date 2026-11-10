import { describe, expect, it } from 'vitest'
import { openDatabase, migrate } from '@eab/storage'
import {
  consumeRobotUserFileSend,
  createRobotUserFileSend,
  markRobotUserFileSendFailed,
  markRobotUserFileSendSent,
} from '../src/dingtalk-file-echo.js'

function testDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  return db
}

const base = {
  companyId: 'c1',
  userId: 'u1',
  conversationId: 'cid_robot_chat',
  fileName: '安全防护记录表.docx',
  sizeBytes: 15968,
}

describe('机器人以用户身份发文件的回声标记', () => {
  it('同会话同文件名命中后只消费一次', () => {
    const db = testDb()
    createRobotUserFileSend(db, base)
    expect(consumeRobotUserFileSend(db, base)?.fileName).toBe(base.fileName)
    expect(consumeRobotUserFileSend(db, base)).toBeNull()
  })

  it('不同会话不命中，用户自己发的文件仍走保存', () => {
    const db = testDb()
    createRobotUserFileSend(db, base)
    expect(consumeRobotUserFileSend(db, { ...base, conversationId: 'cid_other' })).toBeNull()
  })

  it('发送成功后（sent）仍可被入站回声消费', () => {
    const db = testDb()
    const id = createRobotUserFileSend(db, base)
    markRobotUserFileSendSent(db, id, { fileId: '242564220465', spaceId: '29958906015' })
    expect(consumeRobotUserFileSend(db, base)).not.toBeNull()
  })

  it('发送失败（failed）不会被误判为机器人代发', () => {
    const db = testDb()
    const id = createRobotUserFileSend(db, base)
    markRobotUserFileSendFailed(db, id)
    expect(consumeRobotUserFileSend(db, base)).toBeNull()
  })
})
