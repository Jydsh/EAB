import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8')
const start = source.indexOf('/** CoT 单行摘要取思考内容的第一句')
const end = source.indexOf('function toolStatusText')
if (start < 0 || end <= start) throw new Error('无法从 chat.js 定位思考预览函数')
const previewSource = source.slice(start, end)
const { firstLinePreview, livePreview } = new Function(
  `${previewSource}; return { firstLinePreview, livePreview }`,
)() as {
  firstLinePreview: (text: string, maxLength?: number) => string
  livePreview: (text: string, maxLength?: number) => string
}

describe('思考过程单行预览', () => {
  it('长段落追加时跟随最新内容，而不是停在开头', () => {
    const first = '先核对仓库状态和远端地址，再确认发布工作流，然后整理未提交的改动，准备提交并推送。'.repeat(3)
    const next = `${first}最后确认服务健康。`
    const firstPreview = livePreview(first)
    const nextPreview = livePreview(next)
    expect(firstPreview).not.toBe(nextPreview)
    expect(nextPreview.startsWith('…')).toBe(true)
    expect(nextPreview.endsWith('最后确认服务健康。')).toBe(true)
  })

  it('首行摘要保持不变，不能拿来做流式预览', () => {
    const first = '先核对仓库状态和远端地址，再确认发布工作流，然后整理未提交的改动，准备提交并推送。'.repeat(3)
    const next = `${first}最后确认服务健康。`
    expect(firstLinePreview(next)).toBe(firstLinePreview(first))
  })

  it('未超过上限时保留完整内容并去掉 Markdown 强调标记', () => {
    expect(livePreview('**检查** 标签和 Release')).toBe('检查 标签和 Release')
  })
})
