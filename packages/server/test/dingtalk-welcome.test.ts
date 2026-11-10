import { describe, expect, it } from 'vitest'
import { buildDingTalkWelcome } from '../src/dingtalk-bot.js'

describe('钉钉绑定欢迎语', () => {
  it('只保留一段打招呼：自我介绍、能力、网页工作台', () => {
    expect(buildDingTalkWelcome('重庆居易智能科技有限公司').split('\n')).toEqual([
      '你好，我是「重庆居易智能科技有限公司」的 EAB 企业智能助手。',
      '制度、部门、负责人可以直接问我；文档、表格、定时任务也可以交给我处理。',
      '这里和 EAB 网页工作台共用同一段对话，随时可以接着聊。',
    ])
  })

  it('不包含连接状态和会话语义的技术说明', () => {
    const text = buildDingTalkWelcome('甲科技')
    expect(text).not.toContain('已连接')
    expect(text).not.toContain('删除会话')
    expect(text).not.toContain('聊天历史')
  })
})
