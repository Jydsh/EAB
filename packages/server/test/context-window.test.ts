import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../src/llm.js'
import { compressMessagesForContext, estimateTokens } from '../src/context-window.js'

function chat(role: ChatMessage['role'], text: string): ChatMessage {
  return { role, content: text }
}

describe('上下文压缩', () => {
  it('按 token 预算把较早历史压成摘要，保留最近消息与当前问题', () => {
    const history: ChatMessage[] = []
    for (let index = 0; index < 8; index += 1) {
      history.push(chat('user', `第 ${index} 轮用户问题：${'背景资料'.repeat(80)}`))
      history.push(chat('assistant', `第 ${index} 轮助手回答：${'处理结果'.repeat(80)}`))
    }
    const messages: ChatMessage[] = [
      chat('system', '你是企业助手。'),
      ...history,
      chat('user', '现在请总结今天的重点。'),
    ]

    const result = compressMessagesForContext(messages, {
      maxContext: 1800,
      maxOutputTokens: 300,
      toolTokens: 100,
    })

    expect(result.compressed).toBe(true)
    expect(result.removedMessages).toBeGreaterThan(0)
    expect(result.messages.some((message) => message.role === 'system' && String(message.content).includes('较早对话压缩摘要'))).toBe(true)
    expect(result.messages[result.messages.length - 1]?.content).toBe('现在请总结今天的重点。')
    expect(result.afterTokens).toBeLessThanOrEqual(result.beforeTokens)
  })

  it('预算充足时原样返回，不产生压缩消息', () => {
    const messages: ChatMessage[] = [
      chat('system', '你是企业助手。'),
      chat('user', '上一轮问题'),
      chat('assistant', '上一轮回答'),
      chat('user', '这一轮问题'),
    ]

    const result = compressMessagesForContext(messages, {
      maxContext: 32_000,
      maxOutputTokens: 4096,
    })

    expect(result.compressed).toBe(false)
    expect(result.messages).toEqual(messages)
    expect(result.removedMessages).toBe(0)
  })

  it('按中日韩字符与普通字符分别估算 token', () => {
    expect(estimateTokens('你好')).toBe(2)
    expect(estimateTokens('hello')).toBe(2)
    expect(estimateTokens('中文abc')).toBe(3)
  })
})
