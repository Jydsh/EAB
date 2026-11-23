import { describe, expect, it } from 'vitest'
import type { RequestActor } from '../src/session.js'
import type { ChatToolSpec } from '../src/routes/tools.js'
import type { ChatMemoryHit } from '../src/chat-memory.js'
import { buildSystemPrompt } from '../src/routes/chat.js'

const actor = {
  person: { companyName: '测试公司', name: '测试用户', deptName: '测试部门' },
} as unknown as RequestActor

const tools = [
  {
    type: 'function',
    function: { name: 'kb_search', description: '检索知识库', parameters: { type: 'object', properties: {}, required: [] } },
  },
] as unknown as ChatToolSpec[]

const memoryHit: ChatMemoryHit = {
  messageId: 'm1',
  sessionId: 's1',
  sessionTitle: '上周的对话',
  role: 'assistant',
  createdAt: Date.now() - 3600_000,
  excerpt: '魏竣豪本月加班合计 213.27 小时，共 17 条',
  context: '当时的助手：魏竣豪 2026 年 11 月加班合计 213.27 小时，共 17 条。',
  score: 0.8,
}

function prompt(userQuestion: string, extra: Partial<Parameters<typeof buildSystemPrompt>[0]> = {}): string {
  return buildSystemPrompt({
    actor,
    chatTools: tools,
    memories: [],
    memoryHits: [memoryHit],
    sessionSummary: '【会话早期摘要】用户之前查过李鹏的加班数据。',
    hasAttachments: false,
    spaceKind: 'cloud',
    spaceLabel: '云空间',
    userQuestion,
    hits: [],
    ...extra,
  })
}

describe('取数轮的系统提示降级（所有工具通用）', () => {
  it('数据类问题：只出现一份 6 条数据规则，并说明记忆不可当数据', () => {
    const text = prompt('邓骏的本月加班数据')
    expect(text).toContain('【数据回合规则｜就这 6 条，按顺序执行】')
    expect(text).toContain('插件、知识库、数据库、文件读取都算')
    expect(text).toContain('长期记忆、会话摘要、历史回答、上一轮工具结果、模型常识都不算数据')
    // B2：四套互相覆盖的规则已合并，旧标题不应再出现
    for (const legacy of ['【实时数据硬规则', '【数值计算硬规则', '【明细表硬规则', '【口径自检】']) {
      expect(text, legacy).not.toContain(legacy)
    }
    // 同一条要求在提示里只出现一次，模型才不会逐条复述
    expect(text.match(/人名按用户原话原样传/g)).toHaveLength(1)
    expect(text.match(/rowStats/g)).toHaveLength(1)
    expect(text.match(/禁止编造、补全/g)).toHaveLength(1)
  })

  it('数据类问题：不注入历史对话记忆片段（避免串上一轮数字）', () => {
    const text = prompt('邓骏的本月加班数据')
    expect(text).not.toContain('【历史对话检索｜回忆素材')
    expect(text).not.toContain('213.27')
  })

  it('数据类问题：摘要保留但标为过时线索', () => {
    const text = prompt('本月差旅花了多少')
    expect(text).toContain('摘要里的数字、名单和结论都已过时')
  })

  it('非数据问题（写作/闲聊）保留记忆，也不加取数规则', () => {
    const text = prompt('帮我起草一封跟进邮件')
    expect(text).toContain('【历史对话检索｜回忆素材')
    expect(text).not.toContain('【数据回合规则')
  })

  it('数据类问题+有 math_eval 与 batch_read：算数与明细要求并入同一条，不另起一段', () => {
    const text = prompt('邓骏的本月加班数据', {
      chatTools: [
        ...tools,
        { type: 'function', function: { name: 'math_eval', description: '计算', parameters: { type: 'object', properties: {}, required: [] } } },
        { type: 'function', function: { name: 'batch_read', description: '读批次', parameters: { type: 'object', properties: {}, required: [] } } },
      ] as unknown as ChatToolSpec[],
    })
    expect(text).toContain('必须调 math_eval 把原值按顺序放进 values')
    expect(text).toContain('先用 batch_read 读到行')
    expect(text).not.toContain('【数值计算硬规则')
  })

  it('非数据问题但要用算数：只留一句 math_eval 提示，不注入整套数据规则', () => {
    const text = prompt('帮我算一下 3.5 加 7.75', {
      chatTools: [
        ...tools,
        { type: 'function', function: { name: 'math_eval', description: '计算', parameters: { type: 'object', properties: {}, required: [] } } },
      ] as unknown as ChatToolSpec[],
    })
    expect(text).toContain('需要合计、平均或占比时调用 math_eval')
    expect(text).not.toContain('【数据回合规则')
  })

  it('数据类问题：长期记忆只能理解意图，不能当本轮答案', () => {
    const text = prompt('李鹏本月加班合计多少', { memories: [{ content: '李鹏是重庆东环线组成员' } as never] })
    expect(text).toContain('本轮要的是实时数据')
  })
})
