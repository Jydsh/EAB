import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../src/llm.js'
import { capToolResultText, compactMessagesForModelCall, compressMessagesForContext, estimateTokens } from '../src/context-window.js'

function chat(role: ChatMessage['role'], text: string): ChatMessage {
  return { role, content: text }
}

function toolCall(id: string, name: string, args: string): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
  }
}

function toolResult(id: string, text: string): ChatMessage {
  return { role: 'tool', tool_call_id: id, content: text }
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

  it('工具循环每轮压缩：旧工具轮次收成摘要，只保留最近一组工具结果', () => {
    const messages: ChatMessage[] = [
      chat('system', '你是企业助手。'),
      chat('user', '读取项目日志并分析异常。'),
      toolCall('c1', 'workspace.read', '{"path":"a.log"}'),
      toolResult('c1', `第一轮结果：${'异常日志'.repeat(2_000)}`),
      toolCall('c2', 'workspace.read', '{"path":"b.log"}'),
      toolResult('c2', '第二轮结果：发现 3 条异常。'),
    ]

    const result = compactMessagesForModelCall(messages, {
      maxContext: 2_500,
      maxOutputTokens: 200,
    })

    expect(result.compressed).toBe(true)
    expect(result.messages.some((message) => message.role === 'system' && String(message.content).includes('较早工具调用压缩摘要'))).toBe(true)
    expect(result.messages.some((message) => message.role === 'system' && String(message.content).includes('workspace.read'))).toBe(true)
    expect(result.messages.filter((message) => message.role === 'tool')).toHaveLength(1)
    expect(result.messages[result.messages.length - 1]?.content).toBe('第二轮结果：发现 3 条异常。')
    expect(result.afterTokens).toBeLessThanOrEqual(2_500 - 200 - 256)
  })

  it('工具循环最近一组工具结果仍超预算时按剩余预算截断', () => {
    const messages: ChatMessage[] = [
      chat('system', '你是企业助手。'),
      chat('user', '读取大文件。'),
      toolCall('c1', 'workspace.read', '{"path":"big.log"}'),
      toolResult('c1', 'HEAD-' + '记录'.repeat(2_000) + '-TAIL'),
    ]

    const result = compactMessagesForModelCall(messages, {
      maxContext: 1_600,
      maxOutputTokens: 200,
    })

    expect(result.compressed).toBe(true)
    expect(result.messages.filter((message) => message.role === 'tool')).toHaveLength(1)
    expect(String(result.messages[result.messages.length - 1]?.content)).toContain('HEAD-')
    expect(String(result.messages[result.messages.length - 1]?.content)).not.toContain('-TAIL')
  })

  it('预算充足时工具循环保持原样', () => {
    const messages: ChatMessage[] = [
      chat('system', '你是企业助手。'),
      chat('user', '读取项目日志。'),
      toolCall('c1', 'workspace.read', '{"path":"a.log"}'),
      toolResult('c1', '第一轮结果：没有异常。'),
    ]

    const result = compactMessagesForModelCall(messages, {
      maxContext: 32_000,
      maxOutputTokens: 4_096,
    })

    expect(result.compressed).toBe(false)
    expect(result.messages).toEqual(messages)
  })

  it('按中日韩字符与普通字符分别估算 token', () => {
    expect(estimateTokens('你好')).toBe(2)
    expect(estimateTokens('hello')).toBe(2)
    expect(estimateTokens('中文abc')).toBe(3)
  })

  it('超长工具结果按字符预算截断，并明确提示未发送中间内容', () => {
    const text = `HEAD-${'记录'.repeat(30_000)}-TAIL`
    const result = capToolResultText(text, 4_000, 60_002)

    expect(result.truncated).toBe(true)
    expect(result.originalChars).toBe(text.length)
    expect(result.text.length).toBeLessThan(text.length)
    expect(result.text.startsWith('HEAD-')).toBe(true)
    expect(result.text.endsWith('-TAIL')).toBe(true)
    expect(result.text).toContain('工具结果已截断')
    expect(result.text).toContain('共 60002 条记录')
    expect(result.text).toContain('回答时必须先说明“数据量过大，只展示了部分记录”')
  })

  it('已保存批次时在截断提示里给出 batchId 与后续工具', () => {
    const text = `HEAD-${'记录'.repeat(30_000)}-TAIL`
    const result = capToolResultText(text, 4_000, 60_002, 'b1b1b1b1-1111-4111-8111-111111111111')

    expect(result.truncated).toBe(true)
    expect(result.text).toContain('完整记录已保存为批次 b1b1b1b1-1111-4111-8111-111111111111')
    expect(result.text).toContain('batch_analyze')
    expect(result.text).toContain('batch_read')
  })

  it('文本批次在截断提示里给出字符数与 batchId', () => {
    const text = `HEAD-${'正文'.repeat(30_000)}-TAIL`
    const result = capToolResultText(text, 4_000, null, 't1t1t1t1-1111-4111-8111-111111111111', text.length)

    expect(result.truncated).toBe(true)
    expect(result.text).toContain(`完整内容共 ${text.length} 字符`)
    expect(result.text).toContain('只展示了部分内容')
    expect(result.text).toContain('完整内容已保存为批次 t1t1t1t1-1111-4111-8111-111111111111')
  })

  it('未超过预算的工具结果保持原样', () => {
    const text = '{"ok":true,"result":"短结果"}'
    const result = capToolResultText(text, 4_000)

    expect(result.truncated).toBe(false)
    expect(result.text).toBe(text)
  })
})
