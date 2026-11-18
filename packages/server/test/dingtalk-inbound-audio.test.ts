import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import type { ServerDeps } from '../src/deps.js'
import { handleDingTalkMessage, inboundAudio, inboundText } from '../src/dingtalk-bot.js'

describe('钉钉语音消息解析', () => {
  it('audio 消息优先使用钉钉 recognition 作为本轮文本', () => {
    const payload = {
      msgtype: 'audio',
      content: {
        duration: 3000,
        downloadCode: 'audio-code-1',
        recognition: '你现在能听到我说的什么吗？',
      },
    }
    expect(inboundText(payload)).toBe('你现在能听到我说的什么吗？')
    expect(inboundAudio(payload)).toEqual({
      downloadCode: 'audio-code-1',
      recognition: '你现在能听到我说的什么吗？',
      durationMs: 3000,
    })
  })

  it('recognition 为空时仍保留下载码，交给 asr.default 兜底转写', () => {
    const payload = {
      msgtype: 'audio',
      content: { duration: 4000, downloadCode: 'audio-code-2', recognition: '   ' },
    }
    expect(inboundText(payload)).toBe('')
    expect(inboundAudio(payload)).toEqual({
      downloadCode: 'audio-code-2',
      recognition: '',
      durationMs: 4000,
    })
  })

  it('audio 缺少 duration 时按 0 处理，非 audio 消息不进入语音分支', () => {
    expect(inboundAudio({ msgtype: 'audio', content: { downloadCode: 'audio-code-3' } })).toEqual({
      downloadCode: 'audio-code-3',
      recognition: '',
      durationMs: 0,
    })
    expect(inboundAudio({ msgtype: 'text', text: { content: '你好' } })).toBeNull()
  })

  it('带 recognition 的语音消息不会落到 empty-text 能力介绍', async () => {
    const db = openDatabase({ path: ':memory:' })
    try {
      migrate(db)
      const now = Date.now()
      db.prepare(
        `INSERT INTO companies (id, name, slug, status, created_at)
         VALUES ('c1', '测试公司', 'test', 'active', ?)`,
      ).run(now)
      db.prepare(
        `INSERT INTO channel_configs (id, company_id, provider, enabled, status, app_id, created_at, updated_at)
         VALUES ('cc_dingtalk', 'c1', 'dingtalk', 1, 'bound', 'ding_test_app', ?, ?)`,
      ).run(now, now)
      const deps = {
        db,
        companyId: 'c1',
        config: { dbPath: ':memory:' },
      } as unknown as ServerDeps
      const result = await handleDingTalkMessage(
        deps,
        {
          msgtype: 'audio',
          senderStaffId: 'staff-audio',
          msgId: 'audio-msg-1',
          content: {
            duration: 3000,
            downloadCode: 'audio-code-1',
            recognition: '你现在能听到我说的什么吗？',
          },
        },
        { dedupe: false },
      )
      // 已越过空消息判断并进入正常渠道流程；未绑定成员时应在身份检查处停下。
      expect(result.reason).toBe('identity-unbound')
      expect(result.text).not.toContain('EAB 目前支持文字、图片、文件和语音')
    } finally {
      db.close()
    }
  })
})
