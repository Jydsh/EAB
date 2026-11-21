import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { zipSync, strToU8 } from 'fflate'
import {
  EICAR_SIGNATURE,
  inspectChatAttachment,
  isChatAttachmentRelPath,
} from '../src/attachment-security.js'

function zip(files: Record<string, string>): Buffer {
  const entries: Record<string, Uint8Array> = {}
  for (const [name, value] of Object.entries(files)) entries[name] = strToU8(value)
  return Buffer.from(zipSync(entries))
}

const VALID_DOCX = zip({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
})

const PDF = readFileSync(new URL('./fixtures/chat-attachment/network-guide.pdf', import.meta.url))

describe('对话附件安全入口', () => {
  it('只有「对话附件/」目录走附件安全策略', () => {
    expect(isChatAttachmentRelPath('对话附件/2026-11-21/a/报告.pdf')).toBe(true)
    expect(isChatAttachmentRelPath('/对话附件/2026-11-21/a/报告.pdf')).toBe(true)
    expect(isChatAttachmentRelPath('项目资料/报告.pdf')).toBe(false)
    expect(isChatAttachmentRelPath('对话附件.exe')).toBe(false)
  })

  it('放过真实 PDF 与结构完整的 DOCX', () => {
    expect(inspectChatAttachment({ filename: '网络手册.pdf', mime: 'application/pdf', buffer: PDF })).toEqual({
      extension: '.pdf',
      mime: 'application/pdf',
    })
    expect(inspectChatAttachment({
      filename: '纪要.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: VALID_DOCX,
    }).extension).toBe('.docx')
  })

  it('拒绝可执行文件、脚本、快捷方式、压缩包与 SVG', () => {
    for (const name of ['木马.exe', '脚本.ps1', '快捷方式.lnk', '压缩包.zip', '矢量图.svg', '网页.html']) {
      expect(() => inspectChatAttachment({ filename: name, buffer: Buffer.from('safe text') })).toThrow(/不允许发送/)
    }
  })

  it('扩展名伪装：PDF 里是 PNG、DOCX 缺少主结构、EXE 改名成 PDF 都会被拒绝', () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    )
    expect(() => inspectChatAttachment({ filename: '伪装.pdf', buffer: png })).toThrow(/PDF 文件头不正确/)
    expect(() => inspectChatAttachment({
      filename: '伪装.docx',
      buffer: zip({ 'word/document.xml': '<document/>' }),
    })).toThrow(/缺少 Office 文档主结构/)
    expect(() => inspectChatAttachment({
      filename: '程序.pdf',
      buffer: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(32)]),
    })).toThrow(/Windows 可执行文件/)
  })

  it('命中 EICAR 标准测试串即拒绝，并给出不是真实病毒的说明', () => {
    expect(() => inspectChatAttachment({
      filename: 'eicar.txt',
      mime: 'text/plain',
      buffer: Buffer.from(EICAR_SIGNATURE, 'utf8'),
    })).toThrow(/EICAR/)
    try {
      inspectChatAttachment({
        filename: 'eicar.txt',
        mime: 'text/plain',
        buffer: Buffer.from(EICAR_SIGNATURE, 'utf8'),
      })
    } catch (error) {
      expect((error as { hint?: string }).hint).toContain('标准测试串')
    }
  })

  it('文本里夹二进制 NUL 会被当成伪装拒绝', () => {
    expect(() => inspectChatAttachment({
      filename: '伪装.txt',
      buffer: Buffer.from([0x68, 0x69, 0x00, 0x01]),
    })).toThrow(/二进制内容/)
  })

  it('空文件与缺少扩展名不能进入对话', () => {
    expect(() => inspectChatAttachment({ filename: '空.pdf', buffer: Buffer.alloc(0) })).toThrow(/内容为空/)
    expect(() => inspectChatAttachment({ filename: '无扩展名', buffer: Buffer.from('hello') })).toThrow(/缺少扩展名/)
  })
})
