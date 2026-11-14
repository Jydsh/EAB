import { describe, expect, it } from 'vitest'
import { previewCapabilityOf } from '../src/routes/workspace.js'

function row(name: string, mime = '') {
  return { name, mime } as never
}

describe('工作区预览能力矩阵', () => {
  it('Office 文档在 OnlyOffice 可用时走 office，本人可编辑', () => {
    expect(previewCapabilityOf(row('安全制度.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), true, true)).toMatchObject({
      kind: 'office',
      mode: 'edit',
      agentOps: expect.arrayContaining(['read', 'edit', 'comment', 'track_changes']),
    })
  })

  it('OnlyOffice 未配置时 Office 文档不创建空预览面板', () => {
    expect(previewCapabilityOf(row('安全制度.docx'), true, false)).toMatchObject({
      kind: 'none',
      reason: expect.stringContaining('OnlyOffice'),
    })
  })

  it('txt/csv/html 优先走文本降级预览，即使 OnlyOffice 也支持这些扩展名', () => {
    for (const name of ['记录.txt', '条款.csv', '说明.html']) {
      expect(previewCapabilityOf(row(name, 'text/plain'), true, true)).toMatchObject({
        kind: 'text',
        mode: 'edit',
        agentOps: expect.arrayContaining(['read', 'select', 'diff']),
      })
    }
  })

  it('共享 PDF 走只读预览并暴露文本/标注能力', () => {
    expect(previewCapabilityOf(row('扫描件.pdf', 'application/pdf'), false, true)).toMatchObject({
      kind: 'pdf',
      mode: 'view',
      agentOps: expect.arrayContaining(['read', 'extract_text', 'highlight', 'annotate']),
    })
  })

  it('图片走区域选择与 OCR 能力', () => {
    expect(previewCapabilityOf(row('现场照片.png', 'image/png'), true, true)).toMatchObject({
      kind: 'image',
      agentOps: expect.arrayContaining(['read', 'select_region', 'ocr', 'annotate']),
    })
  })

  it('没有预览能力的二进制文件返回 none 和原因', () => {
    expect(previewCapabilityOf(row('归档.zip', 'application/zip'), true, true)).toMatchObject({
      kind: 'none',
      agentOps: [],
      reason: expect.any(String),
    })
  })
})
