import { describe, expect, it } from 'vitest'
import { describeCompletedToolCall } from '../src/routes/chat.js'

describe('工具完成后空正文的事实化回退', () => {
  it('把 office.replace 的结构化结果压成可读完成句', () => {
    const text = describeCompletedToolCall({
      name: '局部替换 Office 文档文本',
      toolId: 'office.replace',
      summary: JSON.stringify({
        elementId: 'p2',
        previousText: '第二段开头：真实 docx 对话第二轮验证，第一段和第三段不变。',
        nextText: '第二段开头：第三轮真实验收，第一段和第三段不变。',
        replacements: 1,
        wrote: true,
        saved: true,
      }),
    })
    expect(text).toContain('p2')
    expect(text).toContain('第三轮真实验收')
    expect(text).toContain('文件已保存')
    expect(text).not.toContain('请再发一次')
  })

  it('普通文本结果直接转成完成句', () => {
    expect(describeCompletedToolCall({
      name: '读取修订',
      summary: '共 2 条修订，1 条插入、1 条删除',
    })).toBe('已完成：共 2 条修订，1 条插入、1 条删除')
  })

  it('无法识别的结构化结果不编造完成结论', () => {
    expect(describeCompletedToolCall({
      name: '搜索工具',
      toolId: 'tool.search',
      summary: JSON.stringify({ items: [{ name: 'x' }] }),
    })).toBeNull()
  })
})
