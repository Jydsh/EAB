import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { zipSync, strToU8 } from 'fflate'
import {
  CHAT_DOCUMENT_MAX_BYTES,
  isChatDocumentFilename,
  parseChatDocument,
} from '../src/chat-attachment-document.js'

function zip(files: Record<string, string>): Buffer {
  const entries: Record<string, Uint8Array> = {}
  for (const [name, value] of Object.entries(files)) entries[name] = strToU8(value)
  return Buffer.from(zipSync(entries))
}

const DOCX = zip({
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>月度例会纪要</w:t></w:r></w:p>
<w:p><w:r><w:t>下周完成排查。</w:t></w:r></w:p>
</w:body></w:document>`,
})

const XLSX = zip({
  'xl/sharedStrings.xml': `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>姓名</t></si><si><t>张三</t></si></sst>`,
  'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="人员" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
  'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>`,
})

const PPTX = zip({
  'ppt/slides/slide1.xml': `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>项目周报</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
})

describe('对话附件文档解析', () => {
  it('识别 PDF / Word / Excel / PPT，普通文档不进入解析', () => {
    expect(isChatDocumentFilename('报告.PDF')).toBe(true)
    expect(isChatDocumentFilename('纪要.docx')).toBe(true)
    expect(isChatDocumentFilename('台账.xlsx')).toBe(true)
    expect(isChatDocumentFilename('台账.xlsm')).toBe(true)
    expect(isChatDocumentFilename('汇报.pptx')).toBe(true)
    expect(isChatDocumentFilename('截图.png')).toBe(false)
    expect(isChatDocumentFilename('记录.txt')).toBe(false)
  })

  it('PDF 提取文本层并返回页数', async () => {
    const buffer = readFileSync(new URL('./fixtures/chat-attachment/network-guide.pdf', import.meta.url))
    const result = await parseChatDocument({
      fileId: 'f_pdf',
      filename: 'network-guide.pdf',
      mime: 'application/pdf',
      buffer,
      updatedAt: 1,
    })
    expect(result).toMatchObject({ parser: 'pdf', pageCount: 2, truncated: false })
    expect(result?.text).toContain('Network configuration guide')
    expect(result?.text).toContain('Switch management IP is 192.168.1.10')
  })

  it('DOCX 提取正文，不把 run 拆成空格', async () => {
    const result = await parseChatDocument({
      fileId: 'f_docx',
      filename: '纪要.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: DOCX,
      updatedAt: 2,
    })
    expect(result).toMatchObject({ parser: 'docx', pageCount: 0, truncated: false })
    expect(result?.text).toContain('月度例会纪要')
    expect(result?.text).toContain('下周完成排查。')
  })

  it('XLSX 提取共享字符串与单元格，返回表格文本', async () => {
    const result = await parseChatDocument({
      fileId: 'f_xlsx',
      filename: '台账.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: XLSX,
      updatedAt: 3,
    })
    expect(result).toMatchObject({ parser: 'xlsx', pageCount: 0 })
    expect(result?.text).toContain('姓名')
    expect(result?.text).toContain('张三')
  })

  it('XLSM 复用 XLSX 解析器', async () => {
    const result = await parseChatDocument({
      fileId: 'f_xlsm',
      filename: '宏台账.xlsm',
      mime: 'application/vnd.ms-excel.sheet.macroEnabled.12',
      buffer: XLSX,
      updatedAt: 4,
    })
    expect(result?.parser).toBe('xlsx')
    expect(result?.text).toContain('张三')
  })

  it('PPTX 按页提取文本框', async () => {
    const result = await parseChatDocument({
      fileId: 'f_pptx',
      filename: '汇报.pptx',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      buffer: PPTX,
      updatedAt: 5,
    })
    expect(result).toMatchObject({ parser: 'pptx', pageCount: 1 })
    expect(result?.text).toContain('项目周报')
  })

  it('扫描 PDF 有 OCR 回调时逐页识别，没有 OCR 时提示配置', async () => {
    const buffer = readFileSync(new URL('./fixtures/chat-attachment/scanned-note.pdf', import.meta.url))
    const withoutOcr = await parseChatDocument({
      fileId: 'f_scan_no_ocr',
      filename: 'scanned-note.pdf',
      mime: 'application/pdf',
      buffer,
      updatedAt: 8,
    })
    expect(withoutOcr?.text).toBe('')
    expect(withoutOcr?.warning).toMatch(/OCR/)

    const seen: Array<{ filename: string; pageNo: number; png: Buffer }> = []
    const withOcr = await parseChatDocument({
      fileId: 'f_scan_with_ocr',
      filename: 'scanned-note.pdf',
      mime: 'application/pdf',
      buffer,
      updatedAt: 8,
      ocrModelId: 'vision-test',
      ocrPage: async (png, filename, pageNo) => {
        seen.push({ png, filename, pageNo })
        return 'SCAN TEST - EQUIPMENT ID EAB-2026-11-21'
      },
    })
    expect(withOcr).toMatchObject({ parser: 'pdf', pageCount: 1, ocrPageCount: 1 })
    expect(withOcr?.text).toContain('EAB-2026-11-21')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.filename).toBe('scanned-note.pdf')
    expect(seen[0]?.pageNo).toBe(1)
    expect(seen[0]?.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  it('整份扫描 PDF 的 OCR 全部失败时返回可行动提示，不把失败页提示当正文', async () => {
    const buffer = readFileSync(new URL('./fixtures/chat-attachment/scanned-note.pdf', import.meta.url))
    const failed = await parseChatDocument({
      fileId: 'f_scan_ocr_failed',
      filename: 'scanned-note.pdf',
      mime: 'application/pdf',
      buffer,
      updatedAt: 9,
      ocrModelId: 'vision-test',
      ocrPage: async () => {
        throw new Error('视觉模型超时')
      },
    })
    expect(failed?.text).toBe('')
    expect(failed?.warning).toContain('视觉模型超时')
  })

  it('老式 Office 返回可行动提示，不抛错阻断消息', async () => {
    const result = await parseChatDocument({
      fileId: 'f_doc',
      filename: '老纪要.doc',
      mime: 'application/msword',
      buffer: Buffer.from('legacy'),
      updatedAt: 6,
    })
    expect(result?.text).toBe('')
    expect(result?.warning).toContain('老式 Office 格式')
  })

  it('超过解析上限时只提示，不读取正文', async () => {
    const result = await parseChatDocument({
      fileId: 'f_big',
      filename: '大文件.pdf',
      mime: 'application/pdf',
      buffer: Buffer.alloc(CHAT_DOCUMENT_MAX_BYTES + 1),
      updatedAt: 7,
    })
    expect(result?.text).toBe('')
    expect(result?.warning).toContain('暂不解析正文')
  })

  it('同一文件版本命中缓存，不会重复解析', async () => {
    const first = await parseChatDocument({
      fileId: 'f_cache',
      filename: '缓存.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: DOCX,
      updatedAt: 100,
    })
    const second = await parseChatDocument({
      fileId: 'f_cache',
      filename: '缓存.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: DOCX,
      updatedAt: 100,
    })
    expect(second).toBe(first)
  })
})
