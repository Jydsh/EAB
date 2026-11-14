import { describe, expect, it } from 'vitest'
import { strToU8, unzipSync, zipSync } from 'fflate'
import {
  addDocxComment,
  addXlsxCellComment,
  appendXlsxSheet,
  applyDocxRevisions,
  deleteDocxComment,
  deleteDocxTable,
  deleteXlsxCellComment,
  deleteXlsxSheet,
  findInOutline,
  findInPptx,
  findInXlsx,
  formatDocxText,
  formatXlsxCell,
  formatXlsxDimension,
  insertDocxTable,
  insertDocxText,
  insertXlsxColumn,
  insertXlsxRow,
  mergeDocxTableCells,
  readDocxComments,
  readDocxOutline,
  readDocxRange,
  readDocxRevisions,
  readDocxTrackChanges,
  readPptxOutline,
  readXlsxComments,
  readXlsxOutline,
  replyDocxComment,
  replaceDocxText,
  replacePptxText,
  replaceXlsxCellText,
  resolveDocxComment,
  setDocxTrackChanges,
  splitDocxTableMergedCells,
} from '../src/office-content.js'

function makeDocx(documentXml: string): Buffer {
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
      ),
      'word/_rels/document.xml.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
      ),
      'word/document.xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${documentXml}</w:body>
</w:document>`,
      ),
    }),
  )
}

function documentXmlOf(buffer: Buffer): string {
  const files = unzipSync(new Uint8Array(buffer))
  return new TextDecoder().decode(files['word/document.xml'])
}

function makeXlsx(sheetXml: string, sharedStrings = '', sheetExtra = ''): Buffer {
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
      'xl/workbook.xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="隐患台账" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
      ),
      'xl/sharedStrings.xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">${sharedStrings}</sst>`,
      ),
      'xl/styles.xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  ${sheetExtra}
  <sheetData>${sheetXml}</sheetData>
</worksheet>`,
      ),
    }),
  )
}

const SAMPLE = `
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>安全防护记录本</w:t></w:r></w:p>
  <w:p><w:r><w:t>第一段：</w:t></w:r><w:r><w:t>检查消防设施 &amp; 记录</w:t></w:r></w:p>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
  <w:p><w:r><w:t>结束</w:t></w:r></w:p>
`

describe('office-content', () => {
  it('reads paragraphs and tables in document order', () => {
    const outline = readDocxOutline(makeDocx(SAMPLE))
    expect(outline.elementCount).toBe(4)
    expect(outline.elements.map((element) => element.kind)).toEqual(['paragraph', 'paragraph', 'table', 'paragraph'])
    const heading = outline.elements[0]
    expect(heading.kind).toBe('paragraph')
    if (heading.kind === 'paragraph') {
      expect(heading.text).toBe('安全防护记录本')
      expect(heading.headingLevel).toBe(1)
    }
    const table = outline.elements[2]
    expect(table.kind).toBe('table')
    if (table.kind === 'table') {
      expect(table.rows).toBe(2)
      expect(table.columns).toBe(2)
      expect(table.preview[0].cells.map((cell) => cell.text)).toEqual(['A1', 'B1'])
      expect(table.preview[1].cells[1].id).toBe('t1-r2-c2')
    }
  })

  it('truncates when maxElements is smaller than the document', () => {
    const outline = readDocxOutline(makeDocx(SAMPLE), 2)
    expect(outline.elements).toHaveLength(2)
    expect(outline.truncated).toBe(true)
  })

  it('finds text and regex in paragraphs and table cells', () => {
    const outline = readDocxOutline(makeDocx(SAMPLE))
    const plain = findInOutline(outline, '消防')
    expect(plain).toHaveLength(1)
    expect(plain[0].elementId).toBe('p2')
    expect(plain[0].text).toContain('检查消防设施')

    const regex = findInOutline(outline, '第[一二]段', { regex: true })
    expect(regex[0].elementId).toBe('p2')

    const bad = findInOutline.bind(null, outline, '[', { regex: true })
    expect(() => bad()).toThrow('正则表达式无效')
    expect(findInOutline(outline, 'A1')).toHaveLength(0)

    const withTable = readDocxOutline(makeDocx(SAMPLE), 500, { includeTableRows: true })
    const cell = findInOutline(withTable, 'A1')
    expect(cell).toHaveLength(1)
    expect(cell[0].kind).toBe('table_cell')
    expect(cell[0].elementId).toBe('t1-r1-c1')
    expect(cell[0].row).toBe(1)
    expect(cell[0].column).toBe(1)
  })

  it('replaces only the targeted paragraph or table cell text', () => {
    const source = makeDocx(SAMPLE)
    const paragraph = replaceDocxText(source, { elementId: 'p2', oldText: '消防', newText: '灭火' })
    expect(paragraph.previousText).toContain('检查消防设施')
    expect(paragraph.nextText).toContain('检查灭火设施')
    expect((readDocxOutline(paragraph.buffer).elements[3] as { text: string }).text).toBe('结束')
    expect((readDocxOutline(paragraph.buffer).elements[0] as { text: string }).text).toBe('安全防护记录本')

    const cell = replaceDocxText(source, { elementId: 't1-r1-c1', newText: '新值' })
    expect(cell.nextText).toBe('新值')
    const afterCell = readDocxOutline(cell.buffer)
    const table = afterCell.elements[2]
    expect((afterCell.elements[0] as { text: string }).text).toBe('安全防护记录本')
    expect(table.kind).toBe('table')
    if (table.kind === 'table') {
      expect(table.preview[0].cells[0].text).toBe('新值')
      expect(table.preview[1].cells[1].text).toBe('B2')
    }

    const acrossRuns = replaceDocxText(source, { elementId: 'p2', oldText: '第一段：检查', newText: '第二段：核对' })
    expect(acrossRuns.nextText).toBe('第二段：核对消防设施 & 记录')
  })

  it('reads w:ins / w:del revisions with author and paragraph scope', () => {
    const source = makeDocx(`
      <w:p>
        <w:r><w:t>保留：</w:t></w:r>
        <w:ins w:id="1" w:author="张三" w:date="2026-11-14T01:00:00Z"><w:r><w:t>新增</w:t></w:r></w:ins>
        <w:del w:id="2" w:author="李四" w:date="2026-11-14T02:00:00Z"><w:r><w:delText>删除</w:delText></w:r></w:del>
      </w:p>
    `)
    const report = readDocxRevisions(source)
    expect(report.revisionCount).toBe(2)
    expect(report.insertions).toBe(1)
    expect(report.deletions).toBe(1)
    expect(report.truncated).toBe(false)
    expect(report.revisions.map((revision) => revision.kind)).toEqual(['insert', 'delete'])
    expect(report.revisions[0]).toMatchObject({
      author: '张三',
      text: '新增',
      elementId: 'p1',
      elementKind: 'paragraph',
      start: 3,
      end: 5,
    })
    expect(report.revisions[1]).toMatchObject({ author: '李四', text: '删除', elementId: 'p1' })
    expect(report.authors.map((author) => [author.author, author.insertions, author.deletions])).toEqual([
      ['张三', 1, 0],
      ['李四', 0, 1],
    ])
  })

  it('writes tracked replacements as w:ins / w:del and keeps a clean XML', () => {
    const source = makeDocx(SAMPLE)
    const tracked = replaceDocxText(source, {
      elementId: 'p2',
      oldText: '消防',
      newText: '灭火',
      trackChanges: true,
      author: 'EAB 验收',
    })
    expect(tracked.tracked).toBe(true)
    expect(tracked.previousText).toContain('检查消防设施')
    expect(tracked.nextText).toBe('第一段：检查灭火设施 & 记录')
    const xml = documentXmlOf(tracked.buffer)
    expect(xml).toContain('<w:ins w:id="2" w:author="EAB 验收"')
    expect(xml).toContain('<w:del w:id="1" w:author="EAB 验收"')
    expect(xml).toContain('<w:delText>消防</w:delText>')
    expect(xml).not.toContain('<w:ins w:id="2" w:author="EAB 验收"><w:r><w:t>灭火</w:t>')
    expect(xml).toMatch(/<w:ins\b[^>]*><w:r><w:t>灭火<\/w:t><\/w:r><\/w:ins>/)

    const report = readDocxRevisions(tracked.buffer)
    expect(report.revisionCount).toBe(2)
    expect(report.revisions[0]).toMatchObject({ kind: 'delete', text: '消防', elementId: 'p2' })
    expect(report.revisions[1]).toMatchObject({ kind: 'insert', text: '灭火', elementId: 'p2' })
    expect((readDocxOutline(tracked.buffer).elements[1] as { text: string }).text).toBe('第一段：检查灭火设施 & 记录')

    expect(() =>
      replaceDocxText(tracked.buffer, {
        elementId: 'p2',
        oldText: '灭火',
        newText: '灭火器',
        trackChanges: true,
      }),
    ).toThrow('目标元素已包含修订标记')
  })

  it('writes a zero-length tracked insertion without duplicating surrounding text', () => {
    const source = makeDocx(`
      <w:p><w:r><w:t>标题</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">  </w:t></w:r></w:p>
    `)
    const tracked = replaceDocxText(source, {
      elementId: 'p2',
      newText: '【新增】',
      trackChanges: true,
      author: 'EAB 验收',
    })
    expect(tracked.tracked).toBe(true)
    expect(tracked.nextText).toBe('【新增】')
    const xml = documentXmlOf(tracked.buffer)
    expect(xml.match(/【新增】/g)?.length).toBe(1)
    expect(xml.match(/xml:space="preserve">  <\/w:t>/g)?.length).toBe(1)
    expect(xml).toMatch(/<w:ins\b[^>]*><w:r><w:t>【新增】<\/w:t><\/w:r><\/w:ins>/)
    const report = readDocxRevisions(tracked.buffer)
    expect(report.insertions).toBe(1)
    expect(report.deletions).toBe(0)
  })

  it('rejects tracked writes inside an element that already holds revisions', () => {
    const source = makeDocx(`
      <w:p><w:r><w:t>原文</w:t></w:r></w:p>
      <w:p><w:ins w:id="9" w:author="张三"><w:r><w:t>已有</w:t></w:r></w:ins><w:r><w:t>文本</w:t></w:r></w:p>
    `)
    expect(() =>
      replaceDocxText(source, { elementId: 'p2', oldText: '文本', newText: '内容', trackChanges: true }),
    ).toThrow('目标元素已包含修订标记')
  })

  it('enables and disables docx track changes without touching document.xml', () => {
    const source = makeDocx(SAMPLE)
    const before = documentXmlOf(source)
    expect(readDocxTrackChanges(source)).toBe(false)
    const enabled = setDocxTrackChanges(source, true)
    expect(enabled.changed).toBe(true)
    expect(readDocxTrackChanges(enabled.buffer)).toBe(true)
    expect(documentXmlOf(enabled.buffer)).toBe(before)
    const files = unzipSync(new Uint8Array(enabled.buffer))
    expect(files['word/settings.xml']).toBeTruthy()
    expect(new TextDecoder().decode(files['word/settings.xml'])).toContain('<w:trackChanges/>')
    const disabled = setDocxTrackChanges(enabled.buffer, false)
    expect(disabled.changed).toBe(true)
    expect(readDocxTrackChanges(disabled.buffer)).toBe(false)
    expect(documentXmlOf(disabled.buffer)).toBe(before)
  })

  it('accepts and rejects w:ins / w:del revisions by id or all', () => {
    const source = makeDocx(`
      <w:p>
        <w:r><w:t>保留：</w:t></w:r>
        <w:ins w:id="1" w:author="张三"><w:r><w:t>新增</w:t></w:r></w:ins>
        <w:del w:id="2" w:author="李四"><w:r><w:delText>删除</w:delText></w:r></w:del>
      </w:p>
    `)
    const accepted = applyDocxRevisions(source, { action: 'accept', all: true })
    expect(accepted.processed).toBe(2)
    expect(accepted.revisionIds).toEqual(['1', '2'])
    expect(accepted.remaining).toBe(0)
    expect(documentXmlOf(accepted.buffer)).not.toContain('<w:ins')
    expect(documentXmlOf(accepted.buffer)).not.toContain('<w:del')
    expect(readDocxRange(accepted.buffer, { elementId: 'p1' }).text).toBe('保留：新增')

    const rejected = applyDocxRevisions(source, { action: 'reject', all: true })
    expect(rejected.processed).toBe(2)
    expect(rejected.remaining).toBe(0)
    expect(documentXmlOf(rejected.buffer)).not.toContain('<w:ins')
    expect(documentXmlOf(rejected.buffer)).not.toContain('<w:del')
    expect(documentXmlOf(rejected.buffer)).toContain('<w:t>删除</w:t>')
    expect(readDocxRange(rejected.buffer, { elementId: 'p1' }).text).toBe('保留：删除')

    const oneByOne = applyDocxRevisions(source, { action: 'accept', revisionId: '1' })
    expect(oneByOne.processed).toBe(1)
    expect(oneByOne.remaining).toBe(1)
    expect(documentXmlOf(oneByOne.buffer)).not.toContain('w:id="1"')
    expect(documentXmlOf(oneByOne.buffer)).toContain('<w:del w:id="2"')
    expect(() => applyDocxRevisions(source, { action: 'accept', revisionId: '99' })).toThrow('没有找到修订')
  })

  it('adds a phrase-level comment range instead of covering the whole paragraph', () => {
    const source = makeDocx(
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' +
        '<w:r><w:rPr><w:rFonts w:ascii="黑体" w:eastAsia="黑体"/></w:rPr><w:t>安全防护记录本</w:t></w:r></w:p>',
    )
    const added = addDocxComment(source, {
      elementId: 'p1',
      text: '核对防护措施',
      oldText: '防护',
      occurrence: 1,
      author: '验收',
    })
    expect(added.commentId).toBe(1)
    expect(readDocxRange(added.buffer, { elementId: 'p1' }).text).toBe('安全防护记录本')
    const xml = documentXmlOf(added.buffer)
    const leftAt = xml.indexOf('<w:t>安全</w:t>')
    const startAt = xml.indexOf('<w:commentRangeStart w:id="1"/>')
    const markedAt = xml.indexOf('<w:t>防护</w:t>')
    const endAt = xml.indexOf('<w:commentRangeEnd w:id="1"/>')
    const restAt = xml.indexOf('<w:t>记录本</w:t>')
    expect(leftAt).toBeGreaterThanOrEqual(0)
    expect(leftAt).toBeLessThan(startAt)
    expect(startAt).toBeLessThan(markedAt)
    expect(markedAt).toBeLessThan(endAt)
    expect(endAt).toBeLessThan(restAt)
    expect(xml.indexOf('<w:commentRangeStart w:id="1"/>', startAt + 1)).toBe(-1)
    expect(xml).toContain('<w:commentReference w:id="1"/>')
    expect(readDocxComments(added.buffer).comments[0]).toMatchObject({
      id: 1,
      author: '验收',
      text: '核对防护措施',
      resolved: false,
      threadRootId: 1,
    })
    const replied = replyDocxComment(added.buffer, { commentId: 1, text: '已核对', author: '复核' })
    expect(readDocxRange(replied.buffer, { elementId: 'p1' }).text).toBe('安全防护记录本')
    const removed = deleteDocxComment(replied.buffer, { commentId: 1 })
    expect(removed.deletedCommentIds).toEqual([1, 2])
    expect(readDocxRange(removed.buffer, { elementId: 'p1' }).text).toBe('安全防护记录本')
  })

  it('deletes only comment anchors and keeps text before the commented paragraph', () => {
    const source = makeDocx(
      '<w:p><w:r><w:t>附件三</w:t></w:r></w:p>' +
        '<w:tbl><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>' +
        '<w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
        '<w:p><w:r><w:t>通知开放信号后在线路上作业</w:t></w:r></w:p>',
    )
    const added = addDocxComment(source, {
      elementId: 'p2',
      text: '请确认停止作业要求',
      oldText: '通知开放信号',
      occurrence: 1,
      author: '验收',
    })
    expect(added.start).toBe(0)
    expect(added.end).toBe(6)
    const replied = replyDocxComment(added.buffer, { commentId: added.commentId, text: '已确认', author: '复核' })
    const deleted = deleteDocxComment(replied.buffer, { commentId: added.commentId })
    expect(deleted.deletedCommentIds).toEqual([added.commentId, replied.commentId])
    expect(readDocxRange(deleted.buffer, { elementId: 'p1' }).text).toBe('附件三')
    expect(readDocxRange(deleted.buffer, { elementId: 't1-r1-c1' }).text).toBe('A')
    expect(readDocxRange(deleted.buffer, { elementId: 't1-r1-c2' }).text).toBe('B')
    expect(readDocxRange(deleted.buffer, { elementId: 'p2' }).text).toBe('通知开放信号后在线路上作业')
    expect(readDocxOutline(deleted.buffer).elements.map((element) => element.kind)).toEqual(['paragraph', 'table', 'paragraph'])
    expect(readDocxComments(deleted.buffer)).toMatchObject({ total: 0, open: 0, resolvedCount: 0, threads: 0 })
    const xml = documentXmlOf(deleted.buffer)
    expect(xml).not.toContain('commentRangeStart')
    expect(xml).not.toContain('commentRangeEnd')
    expect(xml).not.toContain('commentReference')
  })

  it('lists, replies to, resolves and deletes comments with replies and anchors', () => {
    const source = makeDocx('<w:p><w:r><w:t>安全防护记录本</w:t></w:r></w:p>')
    const added = addDocxComment(source, { elementId: 'p1', text: '请确认', author: '验收' })
    expect(readDocxRange(added.buffer, { elementId: 'p1' }).text).toBe('安全防护记录本')
    const list1 = readDocxComments(added.buffer)
    expect(list1).toMatchObject({ total: 1, open: 1, resolvedCount: 0, threads: 1 })
    expect(list1.comments[0]).toMatchObject({ id: added.commentId, parentId: null, threadRootId: added.commentId })

    const replied = replyDocxComment(added.buffer, {
      commentId: added.commentId,
      text: '已确认',
      author: '复核',
    })
    expect(replied.commentId).toBe(added.commentId + 1)
    expect(replied.parentCommentId).toBe(added.commentId)
    const list2 = readDocxComments(replied.buffer)
    expect(list2.total).toBe(2)
    expect(list2.comments.find((comment) => comment.id === added.commentId)?.threadRootId).toBe(added.commentId)
    expect(list2.comments.find((comment) => comment.id === replied.commentId)).toMatchObject({
      parentId: added.commentId,
      threadRootId: added.commentId,
      text: '已确认',
    })

    const resolved = resolveDocxComment(replied.buffer, { commentId: added.commentId, resolved: true })
    const list3 = readDocxComments(resolved.buffer)
    expect(list3.comments.find((comment) => comment.id === added.commentId)?.resolved).toBe(true)
    expect(list3.resolvedCount).toBe(1)

    const deleted = deleteDocxComment(resolved.buffer, { commentId: added.commentId })
    expect(deleted.deletedCommentIds).toEqual([added.commentId, replied.commentId])
    const list4 = readDocxComments(deleted.buffer)
    expect(list4).toMatchObject({ total: 0, open: 0, resolvedCount: 0, threads: 0 })
    expect(readDocxRange(deleted.buffer, { elementId: 'p1' }).text).toBe('安全防护记录本')
    const xml = documentXmlOf(deleted.buffer)
    expect(xml).not.toContain('commentRangeStart')
    expect(xml).not.toContain('commentRangeEnd')
    expect(xml).not.toContain('commentReference')
  })

  it('persists commentsExtended and commentsIds thread metadata and removes it on delete', () => {
    const source = makeDocx('<w:p><w:r><w:t>安全防护记录本</w:t></w:r></w:p>')
    const added = addDocxComment(source, { elementId: 'p1', text: '请确认', author: '验收' })
    const files1 = unzipSync(new Uint8Array(added.buffer))
    const extended1 = new TextDecoder().decode(files1['word/commentsExtended.xml'])
    const ids1 = new TextDecoder().decode(files1['word/commentsIds.xml'])
    expect(extended1).toContain('<w15:commentEx')
    expect(extended1).toMatch(/w15:paraId="[0-9A-F]{8}"/)
    expect(extended1).toContain('w15:done="0"')
    expect(ids1).toContain('<w16cid:commentId')
    expect(ids1).toMatch(/w16cid:durableId="[0-9A-F]{8}"/)
    const contentTypes = new TextDecoder().decode(files1['[Content_Types].xml'])
    expect(contentTypes).toContain('commentsExtended+xml')
    expect(contentTypes).toContain('commentsIds+xml')
    const rels = new TextDecoder().decode(files1['word/_rels/document.xml.rels'])
    expect(rels).toContain('relationships/commentsExtended')
    expect(rels).toContain('relationships/commentsIds')

    const replied = replyDocxComment(added.buffer, { commentId: added.commentId, text: '已确认', author: '复核' })
    const files2 = unzipSync(new Uint8Array(replied.buffer))
    const extended2 = new TextDecoder().decode(files2['word/commentsExtended.xml'])
    const ids2 = new TextDecoder().decode(files2['word/commentsIds.xml'])
    expect(extended2).toContain('w15:paraIdParent=')
    expect((ids2.match(/<w16cid:commentId\b/g) ?? []).length).toBe(2)

    const resolved = resolveDocxComment(replied.buffer, { commentId: added.commentId, resolved: true })
    const files3 = unzipSync(new Uint8Array(resolved.buffer))
    const extended3 = new TextDecoder().decode(files3['word/commentsExtended.xml'])
    expect(extended3).toMatch(/w15:paraId="[0-9A-F]{8}"[^>]*w15:done="1"/)

    const deleted = deleteDocxComment(resolved.buffer, { commentId: added.commentId })
    const files4 = unzipSync(new Uint8Array(deleted.buffer))
    const extended4 = new TextDecoder().decode(files4['word/commentsExtended.xml'])
    const ids4 = new TextDecoder().decode(files4['word/commentsIds.xml'])
    expect(extended4).not.toContain('<w15:commentEx')
    expect(ids4).not.toContain('<w16cid:commentId')
  })

  it('inserts a paragraph before or after a target and keeps its paragraph style', () => {
    const source = makeDocx(SAMPLE)
    const after = insertDocxText(source, { elementId: 'p1', text: '新增第一行\n新增第二行' })
    const outline = readDocxOutline(after.buffer)
    expect(outline.elementCount).toBe(5)
    expect(outline.elements[1].kind).toBe('paragraph')
    if (outline.elements[1].kind === 'paragraph') {
      expect(outline.elements[1].text).toBe('新增第一行\n新增第二行')
      expect(outline.elements[1].headingLevel).toBe(1)
    }
    expect((outline.elements[0] as { text: string }).text).toBe('安全防护记录本')

    const beforeTable = insertDocxText(source, { elementId: 't1', position: 'before', text: '表格前说明' })
    const beforeOutline = readDocxOutline(beforeTable.buffer)
    expect(beforeOutline.elementCount).toBe(5)
    expect((beforeOutline.elements[2] as { text: string }).text).toBe('表格前说明')
    expect(beforeOutline.elements[3].kind).toBe('table')
  })

  it('inserts a paragraph inside a table cell and keeps the cell structure', () => {
    const source = makeDocx(SAMPLE)
    const after = insertDocxText(source, { elementId: 't1-r1-c1', text: '单元格新增\n第二行' })
    expect(after.kind).toBe('table_cell')
    expect(after.position).toBe('after')
    const xml = documentXmlOf(after.buffer)
    expect(xml).toContain('单元格新增')
    expect(xml).toContain('第二行')
    const outline = readDocxOutline(after.buffer, 50, { includeTableRows: true })
    const table = outline.elements[2]
    expect(outline.elements[0]).toMatchObject({ id: 'p1', text: '安全防护记录本' })
    expect(table.kind).toBe('table')
    if (table.kind === 'table') {
      expect(table.rows).toBe(2)
      expect(table.columns).toBe(2)
      expect(table.preview[0].cells[0].text).toBe('A1单元格新增\n第二行')
      expect(table.preview[0].cells[1].text).toBe('B1')
      expect(table.preview[1].cells[0].text).toBe('A2')
    }

    const before = insertDocxText(source, { elementId: 't1-r1-c2', text: '单元格前置', position: 'before' })
    const beforeXml = documentXmlOf(before.buffer)
    expect(before.kind).toBe('table_cell')
    expect(beforeXml.indexOf('单元格前置')).toBeLessThan(beforeXml.indexOf('B1'))
  })

  it('inserts a docx table row with new values and keeps row/cell formatting', () => {
    const table = `
  <w:tbl>
    <w:tblGrid><w:gridCol w:w="1200"/><w:gridCol w:w="3000"/></w:tblGrid>
    <w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:shd w:fill="EDEDED"/></w:tcPr><w:p><w:pPr><w:pStyle w:val="TableText"/></w:pPr><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>`
    const source = makeDocx(table)
    const result = insertDocxTable(source, {
      elementId: 't1-r1',
      position: 'after',
      text: '新增A\t新增B',
    })
    expect(result.kind).toBe('table_row')
    expect(result.insertedValues).toEqual(['新增A', '新增B'])
    const outline = readDocxOutline(result.buffer, 50, { includeTableRows: true })
    const parsed = outline.elements[0]
    expect(parsed.kind).toBe('table')
    if (parsed.kind === 'table') {
      expect(parsed.rows).toBe(3)
      expect(parsed.preview[1].cells.map((cell) => cell.text)).toEqual(['新增A', '新增B'])
      expect(parsed.preview[2].cells.map((cell) => cell.text)).toEqual(['A2', 'B2'])
    }
    const xml = documentXmlOf(result.buffer)
    expect(xml.match(/<w:tr\b/g)).toHaveLength(3)
    expect(xml).toContain('<w:cantSplit/>')
    expect(xml).toContain('<w:shd w:fill="EDEDED"/>')
    expect(xml).toContain('<w:pStyle w:val="TableText"/>')
  })

  it('inserts a docx table column and keeps all row cell counts aligned', () => {
    const table = `
  <w:tbl>
    <w:tblGrid><w:gridCol w:w="1200"/><w:gridCol w:w="3000"/></w:tblGrid>
    <w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>`
    const source = makeDocx(table)
    const result = insertDocxTable(source, {
      elementId: 't1-c1',
      position: 'after',
      text: '新列1\n新列2',
    })
    expect(result.kind).toBe('table_column')
    expect(result.insertedValues).toEqual(['新列1', '新列2'])
    const outline = readDocxOutline(result.buffer, 50, { includeTableRows: true })
    const parsed = outline.elements[0]
    expect(parsed.kind).toBe('table')
    if (parsed.kind === 'table') {
      expect(parsed.rows).toBe(2)
      expect(parsed.columns).toBe(3)
      expect(parsed.preview[0].cells.map((cell) => cell.text)).toEqual(['A1', '新列1', 'B1'])
      expect(parsed.preview[1].cells.map((cell) => cell.text)).toEqual(['A2', '新列2', 'B2'])
    }
    const xml = documentXmlOf(result.buffer)
    expect(xml.match(/<w:gridCol\b/g)).toHaveLength(3)
  })

  it('deletes a docx table row and keeps the remaining rows and surrounding paragraphs', () => {
    const table = `
  <w:tbl>
    <w:tblGrid><w:gridCol w:w="1200"/><w:gridCol w:w="3000"/></w:tblGrid>
    <w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>A3</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B3</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>`
    const source = makeDocx(`<w:p><w:r><w:t>表格前</w:t></w:r></w:p>${table}<w:p><w:r><w:t>表格后</w:t></w:r></w:p>`)
    const result = deleteDocxTable(source, { elementId: 't1-r2' })
    expect(result).toMatchObject({ kind: 'table_row', deletedRow: 2, remainingRows: 2, remainingColumns: 2 })
    const outline = readDocxOutline(result.buffer, 50, { includeTableRows: true })
    expect(outline.elements.map((element) => element.kind)).toEqual(['paragraph', 'table', 'paragraph'])
    const parsed = outline.elements[1]
    expect(parsed.kind).toBe('table')
    if (parsed.kind === 'table') {
      expect(parsed.rows).toBe(2)
      expect(parsed.columns).toBe(2)
      expect(parsed.preview.map((row) => row.cells.map((cell) => cell.text))).toEqual([
        ['A1', 'B1'],
        ['A3', 'B3'],
      ])
    }
    expect(readDocxRange(result.buffer, { elementId: 'p1' }).text).toBe('表格前')
    expect(readDocxRange(result.buffer, { elementId: 'p2' }).text).toBe('表格后')
    expect(() => deleteDocxTable(source, { elementId: 't1-r4' })).toThrow('没有第 4 行')
  })

  it('deletes a docx table column from the grid and every row', () => {
    const table = `
  <w:tbl>
    <w:tblGrid><w:gridCol w:w="1200"/><w:gridCol w:w="3000"/><w:gridCol w:w="1500"/></w:tblGrid>
    <w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>C1</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>C2</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>`
    const source = makeDocx(table)
    const result = deleteDocxTable(source, { elementId: 't1-c2' })
    expect(result).toMatchObject({ kind: 'table_column', deletedColumn: 2, remainingRows: 2, remainingColumns: 2 })
    const outline = readDocxOutline(result.buffer, 50, { includeTableRows: true })
    const parsed = outline.elements[0]
    expect(parsed.kind).toBe('table')
    if (parsed.kind === 'table') {
      expect(parsed.rows).toBe(2)
      expect(parsed.columns).toBe(2)
      expect(parsed.preview.map((row) => row.cells.map((cell) => cell.text))).toEqual([
        ['A1', 'C1'],
        ['A2', 'C2'],
      ])
    }
    expect(documentXmlOf(result.buffer).match(/<w:gridCol\b/g)).toHaveLength(2)
    expect(() => deleteDocxTable(source, { elementId: 't1-c4' })).toThrow('没有第 4 列')
  })

  it('rejects deleting the last row or column and shrinks a merged grid cell on column deletion', () => {
    const oneRow = makeDocx(
      '<w:tbl><w:tblGrid><w:gridCol w:w="1200"/></w:tblGrid>' +
        '<w:tr><w:tc><w:p><w:r><w:t>唯一</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    )
    expect(() => deleteDocxTable(oneRow, { elementId: 't1-r1' })).toThrow('最后一行')
    expect(() => deleteDocxTable(oneRow, { elementId: 't1-c1' })).toThrow('最后一列')
    const merged = makeDocx(
      '<w:tbl><w:tblGrid><w:gridCol w:w="1200"/><w:gridCol w:w="3000"/></w:tblGrid>' +
        '<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并</w:t></w:r></w:p></w:tc></w:tr>' +
        '<w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    )
    const shrunk = deleteDocxTable(merged, { elementId: 't1-c2' })
    expect(shrunk).toMatchObject({ kind: 'table_column', deletedColumn: 2, remainingRows: 2, remainingColumns: 1 })
    const shrunkOutline = readDocxOutline(shrunk.buffer, 50, { includeTableRows: true })
    const shrunkTable = shrunkOutline.elements[0]
    expect(shrunkTable.kind).toBe('table')
    if (shrunkTable.kind === 'table') {
      expect(shrunkTable.columns).toBe(1)
      expect(shrunkTable.preview.map((row) => row.cells.map((cell) => cell.text))).toEqual([['合并'], ['A2']])
    }
    expect(documentXmlOf(shrunk.buffer)).not.toContain('gridSpan')
  })

  it('deletes a merged row and promotes the next vertical-merge cell to restart', () => {
    const table = `
  <w:tbl>
    <w:tblGrid><w:gridCol w:w="1200"/><w:gridCol w:w="3000"/></w:tblGrid>
    <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>合并标题</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>A3</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B3</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>`
    const result = deleteDocxTable(makeDocx(table), { elementId: 't1-r1' })
    expect(result).toMatchObject({ kind: 'table_row', deletedRow: 1, remainingRows: 2, remainingColumns: 2 })
    const xml = documentXmlOf(result.buffer)
    expect(xml.match(/<w:vMerge w:val="restart"\/>/g)).toHaveLength(1)
    expect(xml).not.toContain('<w:vMerge/>')
    expect(xml).toContain('合并标题')
    expect(readDocxRange(result.buffer, { elementId: 't1-r1-c1' }).text).toContain('合并标题')
    expect(readDocxRange(result.buffer, { elementId: 't1-r2' }).text).toContain('A3')
  })

  it('shrinks vertical-merge grid spans when a column is deleted', () => {
    const table = `
  <w:tbl>
    <w:tblGrid><w:gridCol w:w="1200"/><w:gridCol w:w="3000"/></w:tblGrid>
    <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>合并标题</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>A3</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B3</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>`
    const result = deleteDocxTable(makeDocx(table), { elementId: 't1-c2' })
    expect(result).toMatchObject({ kind: 'table_column', deletedColumn: 2, remainingRows: 3, remainingColumns: 1 })
    const xml = documentXmlOf(result.buffer)
    expect(xml).not.toContain('gridSpan')
    expect(xml.match(/<w:vMerge w:val="restart"\/>/g)).toHaveLength(1)
    expect(xml.match(/<w:vMerge\/>/g)).toHaveLength(1)
    const parsed = readDocxOutline(result.buffer, 50, { includeTableRows: true }).elements[0]
    if (parsed.kind !== 'table') throw new Error('expected table')
    expect(parsed.columns).toBe(1)
    expect(parsed.preview.map((row) => row.cells.map((cell) => cell.text))).toEqual([['合并标题'], [''], ['A3']])
  })

  it('splits merged cells into grid cells while preserving the first cell text', () => {
    const table = `
  <w:tbl>
    <w:tblGrid><w:gridCol w:w="1200"/><w:gridCol w:w="3000"/></w:tblGrid>
    <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>合并标题</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>A3</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B3</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>`
    const result = splitDocxTableMergedCells(makeDocx(table), { elementId: 't1' })
    expect(result).toMatchObject({ kind: 'table_split', splitCells: 2, remainingRows: 3, remainingColumns: 2 })
    const xml = documentXmlOf(result.buffer)
    expect(xml).not.toContain('w:gridSpan')
    expect(xml).not.toContain('w:vMerge')
    const outline = readDocxOutline(result.buffer, 50, { includeTableRows: true })
    const parsed = outline.elements[0]
    if (parsed.kind !== 'table') throw new Error('expected table')
    expect(parsed.rows).toBe(3)
    expect(parsed.preview.map((row) => row.cells.map((cell) => cell.text))).toEqual([
      ['合并标题', ''],
      ['', ''],
      ['A3', 'B3'],
    ])
  })

  it('merges a rectangular unmerged range and can split it back', () => {
    const table = `
  <w:tbl>
    <w:tblGrid><w:gridCol w:w="1200"/><w:gridCol w:w="3000"/></w:tblGrid>
    <w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr>
    <w:tr><w:tc><w:p/></w:tc><w:tc><w:p/></w:tc></w:tr>
  </w:tbl>`
    const source = makeDocx(table)
    const merged = mergeDocxTableCells(source, { range: 't1-r1-c1:t1-r2-c2' })
    expect(merged).toMatchObject({
      kind: 'table_merge',
      mergedRows: 2,
      mergedColumns: 2,
      remainingRows: 2,
      remainingColumns: 2,
    })
    const xml = documentXmlOf(merged.buffer)
    expect(xml.match(/<w:gridSpan w:val="2"\/>/g)).toHaveLength(2)
    expect(xml).toContain('<w:vMerge w:val="restart"/>')
    expect(xml).toContain('<w:vMerge w:val="continue"/>')
    expect(readDocxRange(merged.buffer, { elementId: 't1-r1-c1' }).text).toBe('A1')
    expect(() =>
      mergeDocxTableCells(source, { range: 't1-r1-c1:t1-r1-c2' }),
    ).not.toThrow()
    const bad = makeDocx(
      '<w:tbl><w:tblGrid><w:gridCol w:w="1200"/><w:gridCol w:w="3000"/></w:tblGrid>' +
        '<w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>' +
        '<w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    )
    expect(() => mergeDocxTableCells(bad, { range: 't1-r1-c1:t1-r2-c2' })).toThrow('仍有文本')
    expect(() => mergeDocxTableCells(merged.buffer, { range: 't1-r1-c1:t1-r2-c2' })).toThrow('请先用 action=split')
    const split = splitDocxTableMergedCells(merged.buffer, { elementId: 't1' })
    expect(split.splitCells).toBe(2)
    expect(documentXmlOf(split.buffer)).not.toContain('w:gridSpan')
    expect(readDocxRange(split.buffer, { elementId: 't1-r1-c1' }).text).toBe('A1')
  })


  it('rejects docx table structure insertion when cells are merged', () => {
    const table = `
  <w:tbl>
    <w:tblGrid><w:gridCol w:w="1200"/><w:gridCol w:w="3000"/></w:tblGrid>
    <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>`
    expect(() =>
      insertDocxTable(makeDocx(table), { elementId: 't1-c2', position: 'after', text: '' }),
    ).toThrow('合并单元格')
  })

  it('rejects empty insert text and a missing cell', () => {
    const source = makeDocx(SAMPLE)
    expect(() => insertDocxText(source, { elementId: 'p1', text: '  ' })).toThrow('text 不能为空')
    expect(() => insertDocxText(source, { elementId: 't1-r3-c1', text: '新增' })).toThrow('没有第 3 行')
  })

  it('formats only the target paragraph or cell and preserves text and styles', () => {
    const source = makeDocx(SAMPLE)
    const formatted = formatDocxText(source, {
      elementId: 'p2',
      bold: true,
      italic: true,
      underline: true,
      color: '#FF0000',
      highlight: 'yellow',
      fontSize: 14,
    })
    expect(formatted.kind).toBe('paragraph')
    expect(formatted.applied).toEqual(['bold', 'italic', 'underline', 'color', 'highlight', 'fontSize'])
    expect(formatted.runCount).toBe(2)
    const xml = documentXmlOf(formatted.buffer)
    expect(xml).toContain('<w:b/>')
    expect(xml).toContain('<w:i/>')
    expect(xml).toContain('<w:u w:val="single"/>')
    expect(xml).toContain('<w:color w:val="FF0000"/>')
    expect(xml).toContain('<w:highlight w:val="yellow"/>')
    expect(xml).toContain('<w:sz w:val="28"/>')
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>')
    expect(readDocxOutline(formatted.buffer).elements[1]).toMatchObject({ text: '第一段：检查消防设施 & 记录' })

    const firstParagraphXml = xml.slice(xml.indexOf('<w:p>'), xml.indexOf('</w:p>'))
    expect(firstParagraphXml).not.toContain('<w:b/>')
    expect(firstParagraphXml).not.toContain('<w:color')

    const cell = formatDocxText(source, { elementId: 't1-r1-c1', italic: true, color: '00AA00' })
    expect(cell.kind).toBe('table_cell')
    const cellXml = documentXmlOf(cell.buffer)
    expect(cellXml).toContain('<w:color w:val="00AA00"/>')
    expect(readDocxOutline(cell.buffer, 50, { includeTableRows: true }).elements[2]).toMatchObject({
      rows: 2,
      columns: 2,
    })

    expect(() => formatDocxText(source, { elementId: 'p2', color: 'red' })).toThrow('6 位十六进制')
    expect(() => formatDocxText(source, { elementId: 'p2', highlight: 'pink' })).toThrow('不支持的 highlight')
    expect(() => formatDocxText(source, { elementId: 'p2' })).toThrow('至少指定一个格式属性')
  })

  it('reads a docx paragraph range with run formats and paragraph spacing', () => {
    const source = makeDocx(
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/><w:spacing w:line="360" w:before="120"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="FF0000"/><w:sz w:val="28"/><w:rFonts w:eastAsia="宋体"/></w:rPr><w:t>重点</w:t></w:r><w:r><w:t>普通</w:t></w:r></w:p>',
    )
    const full = readDocxRange(source, { elementId: 'p1' })
    expect(full.elementKind).toBe('paragraph')
    expect(full.text).toBe('重点普通')
    expect(full.totalLength).toBe(4)
    expect(full.runs).toHaveLength(2)
    expect(full.runs[0].format).toEqual({
      bold: true,
      italic: false,
      color: 'FF0000',
      fontSize: 14,
      fontFamily: '宋体',
    })
    expect(full.runs[1].format.bold).toBe(false)
    expect(full.paragraph).toMatchObject({ style: 'Heading1', align: 'center', lineSpacing: 1.5, spaceBefore: 6 })

    const partial = readDocxRange(source, { elementId: 'p1', start: 1, end: 3 })
    expect(partial.text).toBe('点普')
    expect(partial.runs.map((run) => run.text)).toEqual(['点', '普'])
    expect(partial.runs.map((run) => [run.start, run.end])).toEqual([
      [1, 2],
      [2, 3],
    ])
    expect(() => readDocxRange(source, { elementId: 'p1', start: 3, end: 9 })).toThrow('文本范围')
  })

  it('reads a docx table, row, column and cell as structured ranges', () => {
    const source = makeDocx(SAMPLE)
    const table = readDocxRange(source, { elementId: 't1' })
    expect(table.elementKind).toBe('table')
    expect(table.text).toBe('A1\tB1\nA2\tB2')
    expect(table.table).toMatchObject({ id: 't1', rows: 2, columns: 2 })
    expect(table.table?.data[1].cells.map((cell) => cell.text)).toEqual(['A2', 'B2'])

    const row = readDocxRange(source, { elementId: 't1-r2' })
    expect(row.elementKind).toBe('table_row')
    expect(row.text).toBe('A2\tB2')
    expect(row.table?.data[0].cells.map((cell) => cell.id)).toEqual(['t1-r2-c1', 't1-r2-c2'])

    const column = readDocxRange(source, { elementId: 't1-c2' })
    expect(column.elementKind).toBe('table_column')
    expect(column.text).toBe('B1\nB2')
    expect(column.table?.data.map((item) => item.cells[0].text)).toEqual(['B1', 'B2'])

    const cell = readDocxRange(source, { elementId: 't1-r2-c2' })
    expect(cell.elementKind).toBe('table_cell')
    expect(cell.text).toBe('B2')
    expect(cell.runs.map((item) => item.text)).toEqual(['B2'])

    expect(() => readDocxRange(source, { elementId: 't1', start: 1, end: 2 })).toThrow('start/end 只支持')
  })

  it('rejects unsupported range element IDs', () => {
    expect(() => readDocxRange(makeDocx(SAMPLE), { elementId: 'x9' })).toThrow('无法识别的元素 ID')
  })

  it('formats paragraph alignment and spacing without touching other paragraphs', () => {
    const source = makeDocx(SAMPLE)
    const formatted = formatDocxText(source, {
      elementId: 'p2',
      align: 'center',
      lineSpacing: 1.5,
      spaceBefore: 6,
      spaceAfter: 6,
      fontFamily: '宋体',
    })
    expect(formatted.applied).toEqual(['fontFamily', 'align', 'lineSpacing', 'spaceBefore', 'spaceAfter'])
    expect(formatted.runCount).toBe(2)
    const xml = documentXmlOf(formatted.buffer)
    expect(xml).toContain('<w:jc w:val="center"/>')
    expect(xml).toContain('<w:spacing w:line="360" w:lineRule="auto" w:before="120" w:after="120"/>')
    expect(xml).toContain('<w:rFonts w:ascii="宋体" w:hAnsi="宋体" w:eastAsia="宋体" w:cs="宋体"/>')
    expect(readDocxOutline(formatted.buffer).elements[1]).toMatchObject({ text: '第一段：检查消防设施 & 记录' })
    const firstParagraphXml = xml.slice(xml.indexOf('<w:p>'), xml.indexOf('</w:p>'))
    expect(firstParagraphXml).not.toContain('<w:jc')
    expect(firstParagraphXml).not.toContain('<w:rFonts')
  })

  it('keeps existing paragraph spacing attributes when only line spacing changes', () => {
    const source = makeDocx('<w:p><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:r><w:t>只有一段</w:t></w:r></w:p>')
    const formatted = formatDocxText(source, { elementId: 'p1', lineSpacing: 2 })
    const xml = documentXmlOf(formatted.buffer)
    expect(xml).toContain('<w:spacing w:before="240" w:after="120" w:line="480" w:lineRule="auto"/>')
  })

  it('rejects invalid paragraph format values', () => {
    const source = makeDocx(SAMPLE)
    expect(() => formatDocxText(source, { elementId: 'p2', align: 'middle' })).toThrow('不支持的 align')
    expect(() => formatDocxText(source, { elementId: 'p2', lineSpacing: 0 })).toThrow('lineSpacing')
    expect(() => formatDocxText(source, { elementId: 'p2', spaceBefore: -1 })).toThrow('spaceBefore')
    expect(() => formatDocxText(source, { elementId: 'p2', fontFamily: '  ' })).toThrow('fontFamily 不能为空')
  })

  it('adds comments to a paragraph and a table cell with one comments part', () => {
    const source = makeDocx(SAMPLE)
    const first = addDocxComment(source, { elementId: 'p2', text: '请核对消防设施', author: '何工' })
    expect(first.commentId).toBe(1)
    expect(first.kind).toBe('paragraph')
    const files = unzipSync(new Uint8Array(first.buffer))
    const documentXml = new TextDecoder().decode(files['word/document.xml'])
    const commentsXml = new TextDecoder().decode(files['word/comments.xml'])
    const relsXml = new TextDecoder().decode(files['word/_rels/document.xml.rels'])
    const contentTypes = new TextDecoder().decode(files['[Content_Types].xml'])
    expect(commentsXml).toContain('请核对消防设施')
    expect(commentsXml).toContain('w:author="何工"')
    expect(documentXml).toContain('<w:commentRangeStart w:id="1"/>')
    expect(documentXml).toContain('<w:commentRangeEnd w:id="1"/>')
    expect(documentXml).toContain('<w:commentReference w:id="1"/>')
    expect(relsXml).toContain('relationships/comments')
    expect(contentTypes).toContain('/word/comments.xml')
    expect(readDocxOutline(first.buffer).elements[1]).toMatchObject({ kind: 'paragraph', text: '第一段：检查消防设施 & 记录' })

    const second = addDocxComment(first.buffer, { elementId: 't1-r1-c1', text: '单元格批注' })
    expect(second.commentId).toBe(2)
    expect(second.kind).toBe('table_cell')
    const secondFiles = unzipSync(new Uint8Array(second.buffer))
    const secondComments = new TextDecoder().decode(secondFiles['word/comments.xml'])
    const secondDocument = new TextDecoder().decode(secondFiles['word/document.xml'])
    expect(secondComments).toContain('单元格批注')
    expect(secondDocument).toContain('<w:commentRangeStart w:id="2"/>')
    expect(secondDocument).toContain('<w:commentReference w:id="2"/>')
    expect(
      readDocxOutline(second.buffer, 50, { includeTableRows: true }).elements[2],
    ).toMatchObject({ rows: 2, columns: 2 })

    expect(() => addDocxComment(source, { elementId: 'p2', text: '  ' })).toThrow('text 不能为空')
  })

  it('rejects ambiguous matches and supports occurrence=0', () => {
    const source = makeDocx('<w:p><w:r><w:t>甲 甲 乙</w:t></w:r></w:p>')
    expect(() => replaceDocxText(source, { elementId: 'p1', oldText: '甲', newText: '丙' })).toThrow('请指定 occurrence')
    const all = replaceDocxText(source, { elementId: 'p1', oldText: '甲', newText: '丙', occurrence: 0 })
    expect(all.replacements).toBe(2)
    expect(all.nextText).toBe('丙 丙 乙')
    expect(() => replaceDocxText(source, { elementId: 'p1', oldText: '丁', newText: '丙' })).toThrow('没有找到 oldText')
  })

  it('inserts text into an empty table cell', () => {
    const source = makeDocx('<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>')
    const result = replaceDocxText(source, { elementId: 't1-r1-c1', newText: '填写内容' })
    expect(result.nextText).toBe('填写内容')
    expect(readDocxOutline(result.buffer, 50, { includeTableRows: true }).elements[0]).toMatchObject({
      rows: 1,
      columns: 1,
    })
  })

  it('rejects a non-docx zip', () => {
    expect(() => readDocxOutline(Buffer.from('not a zip'))).toThrow('不是有效的 Office Open XML')
  })
})

describe('xlsx-content', () => {
  const XLSX_SHEET = `
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>旧内容</t></is></c><c r="B2"><v>42</v></c></row>
  `
  const SHARED = '<si><t>标题</t></si><si><t>原说明</t></si>'

  it('reads sheets and cells, and finds a shared-string cell', () => {
    const source = makeXlsx(XLSX_SHEET, SHARED)
    const outline = readXlsxOutline(source)
    expect(outline.sheetCount).toBe(1)
    expect(outline.sheets[0].name).toBe('隐患台账')
    expect(outline.sheets[0].rows).toBe(2)
    expect(outline.sheets[0].columns).toBe(2)
    expect(outline.sheets[0].cells.map((cell) => cell.text)).toEqual(['标题', '原说明', '旧内容', '42'])

    const matches = findInXlsx(source, '原说明')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      elementId: 's1-r1-c2',
      sheetName: '隐患台账',
      address: 'B1',
      row: 1,
      column: 2,
    })
  })

  it('replaces only the targeted xlsx cell and keeps other cells and shared strings', () => {
    const source = makeXlsx(XLSX_SHEET, SHARED)
    const result = replaceXlsxCellText(source, {
      elementId: 's1-r1-c2',
      oldText: '原说明',
      newText: '新说明',
    })
    expect(result.previousText).toBe('原说明')
    expect(result.nextText).toBe('新说明')
    expect(result.replacements).toBe(1)

    const files = unzipSync(new Uint8Array(result.buffer))
    const sheetXml = new TextDecoder().decode(files['xl/worksheets/sheet1.xml'])
    const sharedXml = new TextDecoder().decode(files['xl/sharedStrings.xml'])
    expect(sheetXml).toContain('r="B1"')
    expect(sheetXml).toContain('新说明')
    expect(sheetXml).toContain('旧内容')
    expect(sheetXml).toContain('<v>42</v>')
    expect(sharedXml).toContain('原说明')

    const outline = readXlsxOutline(result.buffer)
    expect(outline.sheets[0].cells.map((cell) => cell.text)).toEqual(['标题', '新说明', '旧内容', '42'])
  })

  it('replaces part of an inline string cell and supports numeric cells', () => {
    const source = makeXlsx(XLSX_SHEET, SHARED)
    const inline = replaceXlsxCellText(source, {
      elementId: 's1-r2-c1',
      oldText: '旧',
      newText: '新',
    })
    expect(inline.nextText).toBe('新内容')

    const numeric = replaceXlsxCellText(source, {
      elementId: 's1-r2-c2',
      oldText: '42',
      newText: '43',
    })
    expect(numeric.nextText).toBe('43')
    const numericXml = new TextDecoder().decode(
      unzipSync(new Uint8Array(numeric.buffer))['xl/worksheets/sheet1.xml'],
    )
    expect(numericXml).toContain('<c r="B2"><v>43</v></c>')

    const numberToText = replaceXlsxCellText(source, {
      elementId: 's1-r2-c2',
      oldText: '42',
      newText: '四十二',
    })
    expect(numberToText.nextText).toBe('四十二')
    expect(readXlsxOutline(numberToText.buffer).sheets[0].cells.map((cell) => cell.text)).toEqual([
      '标题',
      '原说明',
      '旧内容',
      '四十二',
    ])

    const formulaSheet = '<row r="1"><c r="A1" t="str"><f>SUM(B1)</f><v>3</v></c></row>'
    const formulaSource = makeXlsx(formulaSheet)
    const formulaEdit = replaceXlsxCellText(formulaSource, {
      elementId: 's1-r1-c1',
      newText: '=SUM(B1:B2)',
    })
    expect(formulaEdit.nextText).toBe('=SUM(B1:B2)')
    const formulaXml = new TextDecoder().decode(
      unzipSync(new Uint8Array(formulaEdit.buffer))['xl/worksheets/sheet1.xml'],
    )
    expect(formulaXml).toContain('<f>SUM(B1:B2)</f>')
    expect(formulaXml).not.toContain('<v>3</v>')
    expect(readXlsxOutline(formulaEdit.buffer).sheets[0].cells[0]).toMatchObject({
      address: 'A1',
      formula: true,
    })
    expect(() =>
      replaceXlsxCellText(formulaSource, { elementId: 's1-r1-c1', newText: '新值' }),
    ).toThrow('含公式')
  })

  it('formats a single xlsx cell with font, fill and number format without touching other cells', () => {
    const source = makeXlsx('<row r="1"><c r="A1" t="inlineStr"><is><t>合计</t></is></c><c r="B1"><v>0.125</v></c></row>')
    const result = formatXlsxCell(source, {
      elementId: 's1-r1-c1',
      bold: true,
      color: 'FF0000',
      fill: 'FFF2CC',
      fontSize: 14,
      numberFormat: '0.000%',
    })
    expect(result.applied).toEqual(['bold', 'color', 'fill', 'fontSize', 'numberFormat'])
    expect(result.styleIndex).toBeGreaterThan(0)
    const files = unzipSync(new Uint8Array(result.buffer))
    const sheetXml = new TextDecoder().decode(files['xl/worksheets/sheet1.xml'])
    const stylesXml = new TextDecoder().decode(files['xl/styles.xml'])
    expect(sheetXml).toContain('r="A1"')
    expect(sheetXml).toContain(`s="${result.styleIndex}"`)
    expect(sheetXml).toContain('<v>0.125</v>')
    expect(stylesXml).toContain('<b/>')
    expect(stylesXml).toContain('<color rgb="FFFF0000"/>')
    expect(stylesXml).toContain('<fgColor rgb="FFFFF2CC"/>')
    expect(stylesXml).toContain('<sz val="14"/>')
    expect(stylesXml).toContain('formatCode="0.000%"')
    expect(stylesXml).toContain('applyNumberFormat="1"')

    // 同一格式重复应用必须复用已有样式，不能无限增长 styles.xml。
    const repeat = formatXlsxCell(result.buffer, {
      elementId: 's1-r1-c1',
      bold: true,
      color: 'FF0000',
      fill: 'FFF2CC',
      fontSize: 14,
      numberFormat: '0.000%',
    })
    expect(repeat.styleIndex).toBe(result.styleIndex)
    expect(new TextDecoder().decode(unzipSync(new Uint8Array(repeat.buffer))['xl/styles.xml'])).toContain('<cellXfs count="2">')
  })

  it('writes into an empty cell and appends a missing row without touching other cells', () => {
    const source = makeXlsx(XLSX_SHEET, SHARED)
    const emptyCell = replaceXlsxCellText(source, {
      elementId: 's1-r1-c4',
      newText: '新增',
    })
    expect(emptyCell.previousText).toBe('')
    expect(emptyCell.nextText).toBe('新增')
    expect(readXlsxOutline(emptyCell.buffer).sheets[0].cells.map((cell) => cell.text)).toEqual([
      '标题',
      '原说明',
      '新增',
      '旧内容',
      '42',
    ])
    const insertedXml = new TextDecoder().decode(
      unzipSync(new Uint8Array(emptyCell.buffer))['xl/worksheets/sheet1.xml'],
    )
    expect(insertedXml).toContain('r="D1"')

    const missingRow = replaceXlsxCellText(source, {
      elementId: 's1-r3-c1',
      newText: '第三行',
    })
    expect(readXlsxOutline(missingRow.buffer).sheets[0].cells.map((cell) => cell.text)).toContain('第三行')
    const sparse = makeXlsx(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>第一行</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>第三行</t></is></c></row>',
    )
    const middleRow = replaceXlsxCellText(sparse, { elementId: 's1-r2-c1', newText: '第二行' })
    const middleXml = new TextDecoder().decode(
      unzipSync(new Uint8Array(middleRow.buffer))['xl/worksheets/sheet1.xml'],
    )
    expect(middleXml.indexOf('r="1"')).toBeLessThan(middleXml.indexOf('r="2"'))
    expect(middleXml.indexOf('r="2"')).toBeLessThan(middleXml.indexOf('r="3"'))
    expect(() =>
      replaceXlsxCellText(source, { elementId: 's1-r1-c4', oldText: '不存在', newText: '新增' }),
    ).toThrow('空单元格')
  })

  it('inserts an xlsx row, shifts later rows, updates dimension and merges, and guards formulas', () => {
    const extra =
      '<dimension ref="A1:B2"/><mergeCells count="2"><mergeCell ref="A1:B1"/><mergeCell ref="A2:B2"/></mergeCells>'
    const source = makeXlsx(XLSX_SHEET, SHARED, extra)
    const result = insertXlsxRow(source, {
      elementId: 's1-r1',
      position: 'after',
      text: '新增A\t新增B',
    })
    expect(result.insertedRow).toBe(2)
    expect(result.insertedValues).toEqual(['新增A', '新增B'])
    const outline = readXlsxOutline(result.buffer).sheets[0]
    expect(outline.cells.map((cell) => `${cell.address}:${cell.text}`)).toEqual([
      'A1:标题',
      'B1:原说明',
      'A2:新增A',
      'B2:新增B',
      'A3:旧内容',
      'B3:42',
    ])
    const xml = new TextDecoder().decode(
      unzipSync(new Uint8Array(result.buffer))['xl/worksheets/sheet1.xml'],
    )
    expect(xml).toContain('<dimension ref="A1:B3"/>')
    expect(xml).toContain('<mergeCell ref="A1:B1"/>')
    expect(xml).toContain('<mergeCell ref="A3:B3"/>')
    expect(xml).toContain('<row r="3">')
    expect(() =>
      insertXlsxRow(makeXlsx('<row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row>'), {
        elementId: 's1-r1',
        text: '新行',
      }),
    ).toThrow('公式')
    expect(() =>
      insertXlsxRow(
        makeXlsx('<row r="1"><c r="A1" t="inlineStr"><is><t>标题</t></is></c></row>', '', '<dataValidations count="1"/>'),
        { elementId: 's1-r1', text: '新行' },
      ),
    ).toThrow('数据验证')
  })

  it('inserts an xlsx column, shifts cells and widths, and fills per-row values', () => {
    const extra =
      '<cols><col min="1" max="2" width="12"/></cols><dimension ref="A1:B2"/><mergeCells count="1"><mergeCell ref="A1:B2"/></mergeCells>'
    const source = makeXlsx(XLSX_SHEET, SHARED, extra)
    const result = insertXlsxColumn(source, {
      elementId: 's1-c1',
      position: 'after',
      text: '新增列1\n新增列2',
    })
    expect(result.insertedColumn).toBe(2)
    expect(result.insertedValues).toEqual(['新增列1', '新增列2'])
    const outline = readXlsxOutline(result.buffer).sheets[0]
    expect(outline.cells.map((cell) => `${cell.address}:${cell.text}`)).toEqual([
      'A1:标题',
      'B1:新增列1',
      'C1:原说明',
      'A2:旧内容',
      'B2:新增列2',
      'C2:42',
    ])
    expect(outline.columns).toBe(3)
    const xml = new TextDecoder().decode(
      unzipSync(new Uint8Array(result.buffer))['xl/worksheets/sheet1.xml'],
    )
    expect(xml).toContain('<dimension ref="A1:C2"/>')
    expect(xml).toContain('<mergeCell ref="A1:C2"/>')
    expect(xml).toContain('<col min="1" max="3" width="12"/>')
  })

  it('appends and deletes xlsx worksheets and keeps workbook parts consistent', () => {
    const source = makeXlsx(XLSX_SHEET, SHARED)
    const added = appendXlsxSheet(source, '新增表')
    expect(added).toMatchObject({ kind: 'sheet', sheetId: 's2', sheetName: '新增表', sheetCount: 2 })
    const addedFiles = unzipSync(new Uint8Array(added.buffer))
    const workbookXml = new TextDecoder().decode(addedFiles['xl/workbook.xml'])
    const relsXml = new TextDecoder().decode(addedFiles['xl/_rels/workbook.xml.rels'])
    const contentTypes = new TextDecoder().decode(addedFiles['[Content_Types].xml'])
    expect(workbookXml).toContain('<sheet name="新增表" sheetId="2" r:id="rId2"/>')
    expect(relsXml).toContain('Target="worksheets/sheet2.xml"')
    expect(contentTypes).toContain('/xl/worksheets/sheet2.xml')
    expect(addedFiles['xl/worksheets/sheet2.xml']).toBeTruthy()
    expect(readXlsxOutline(added.buffer)).toMatchObject({ sheetCount: 2 })
    expect(readXlsxOutline(added.buffer).sheets[1].name).toBe('新增表')

    const written = replaceXlsxCellText(added.buffer, { elementId: 's2-r1-c1', newText: '结构验收' })
    expect(readXlsxOutline(written.buffer).sheets[1].cells).toEqual([
      expect.objectContaining({ address: 'A1', text: '结构验收' }),
    ])

    expect(() => appendXlsxSheet(source, '  ')).toThrow('不能为空')
    expect(() => appendXlsxSheet(source, '隐患台账')).toThrow('已存在')
    expect(() => appendXlsxSheet(source, '坏/名称')).toThrow('不能包含')

    const deleted = deleteXlsxSheet(written.buffer, 's2')
    expect(deleted).toMatchObject({ kind: 'sheet', deletedSheetId: 's2', remainingSheets: 1 })
    expect(readXlsxOutline(deleted.buffer).sheetCount).toBe(1)
    const deletedFiles = unzipSync(new Uint8Array(deleted.buffer))
    expect(deletedFiles['xl/worksheets/sheet2.xml']).toBeUndefined()
    expect(new TextDecoder().decode(deletedFiles['xl/workbook.xml'])).not.toContain('新增表')
    expect(new TextDecoder().decode(deletedFiles['xl/_rels/workbook.xml.rels'])).not.toContain('sheet2.xml')
    expect(new TextDecoder().decode(deletedFiles['[Content_Types].xml'])).not.toContain('sheet2.xml')
    expect(() => deleteXlsxSheet(source, 's1')).toThrow('至少需要保留一个工作表')

    const crossRef = makeXlsx('<row r="1"><c r="A1" t="str"><f>SUM(\'新增表\'!A1)</f><v>0</v></c></row>')
    const crossRefAdded = appendXlsxSheet(crossRef, '新增表')
    expect(() => deleteXlsxSheet(crossRefAdded.buffer, 's2')).toThrow('公式引用了 新增表')

    const validationRef = makeXlsx(
      XLSX_SHEET,
      SHARED,
      '<dataValidations count="1"><dataValidation type="list"><formula1>\'新增表\'!$A$1:$A$3</formula1></dataValidation></dataValidations>',
    )
    const validationAdded = appendXlsxSheet(validationRef, '新增表')
    expect(() => deleteXlsxSheet(validationAdded.buffer, 's2')).toThrow('公式引用了 新增表')

    const conditionalRef = makeXlsx(
      XLSX_SHEET,
      SHARED,
      '<conditionalFormatting sqref="A1"><cfRule type="expression"><formula>新增表!A1</formula></cfRule></conditionalFormatting>',
    )
    const conditionalAdded = appendXlsxSheet(conditionalRef, '新增表')
    expect(() => deleteXlsxSheet(conditionalAdded.buffer, 's2')).toThrow('公式引用了 新增表')
  })

  it('sets xlsx column widths and row heights, splitting existing column ranges', () => {
    const withCols = makeXlsx(
      XLSX_SHEET,
      SHARED,
      '<cols><col min="1" max="3" width="10" customWidth="1"/></cols>',
    )
    const col = formatXlsxDimension(withCols, { elementId: 's1-c2', columnWidth: 20 })
    expect(col).toMatchObject({ kind: 'sheet_column', applied: ['columnWidth'], columns: 1 })
    const colXml = new TextDecoder().decode(
      unzipSync(new Uint8Array(col.buffer))['xl/worksheets/sheet1.xml'],
    )
    expect(colXml).toContain('<col min="1" max="1" width="10" customWidth="1"/>')
    expect(colXml).toContain('<col min="2" max="2" width="20" customWidth="1"/>')
    expect(colXml).toContain('<col min="3" max="3" width="10" customWidth="1"/>')

    const noCols = formatXlsxDimension(makeXlsx(XLSX_SHEET), {
      elementId: 's1-c2:c3',
      columnWidth: 18,
    })
    const noColsXml = new TextDecoder().decode(
      unzipSync(new Uint8Array(noCols.buffer))['xl/worksheets/sheet1.xml'],
    )
    expect(noCols).toMatchObject({ columns: 2 })
    const noColsBlock = /<cols>[\s\S]*?<\/cols>/.exec(noColsXml)?.[0] ?? ''
    expect(noColsBlock).toContain('min="2"')
    expect(noColsBlock).toContain('max="3"')
    expect(noColsBlock).toContain('width="18"')
    expect(noColsXml.indexOf('<cols>')).toBeLessThan(noColsXml.indexOf('<sheetData'))

    const row = formatXlsxDimension(makeXlsx(XLSX_SHEET), { elementId: 's1-r2', rowHeight: 30 })
    expect(row).toMatchObject({ kind: 'sheet_row', applied: ['rowHeight'], rows: 1 })
    const rowXml = new TextDecoder().decode(
      unzipSync(new Uint8Array(row.buffer))['xl/worksheets/sheet1.xml'],
    )
    expect(rowXml).toMatch(/<row r="2" ht="30" customHeight="1">/)

    const missingRows = formatXlsxDimension(makeXlsx(XLSX_SHEET), {
      elementId: 's1-r3:r4',
      rowHeight: 25,
    })
    const missingXml = new TextDecoder().decode(
      unzipSync(new Uint8Array(missingRows.buffer))['xl/worksheets/sheet1.xml'],
    )
    expect(missingRows).toMatchObject({ rows: 2 })
    expect(missingXml).toContain('<row r="3" ht="25" customHeight="1"/>')
    expect(missingXml).toContain('<row r="4" ht="25" customHeight="1"/>')

    expect(() => formatXlsxDimension(withCols, { elementId: 's1-c2', columnWidth: 300 })).toThrow(
      'columnWidth',
    )
    expect(() => formatXlsxDimension(withCols, { elementId: 's1-r2', rowHeight: 500 })).toThrow(
      'rowHeight',
    )
    expect(() => formatXlsxDimension(withCols, { elementId: 's1-c2', rowHeight: 20 })).toThrow(
      '列宽设置请使用 columnWidth',
    )
    expect(() => formatXlsxDimension(withCols, { elementId: 's1-c2:c3', columnWidth: 18, rowHeight: 20 })).toThrow(
      '列宽设置请使用 columnWidth',
    )
  })

  it('bounds xlsx dimensions and removes only worksheet-owned related parts', () => {
    const source = makeXlsx(XLSX_SHEET)
    expect(() => formatXlsxDimension(source, { elementId: 's1-c16385', columnWidth: 10 })).toThrow(
      '16384',
    )
    expect(() => formatXlsxDimension(source, { elementId: 's1-r1048577', rowHeight: 10 })).toThrow(
      '1048576',
    )
    expect(() =>
      formatXlsxDimension(source, { elementId: 's1-r1:r20001', rowHeight: 10 }),
    ).toThrow('20000')

    const added = appendXlsxSheet(source, '新增表')
    const files = unzipSync(new Uint8Array(added.buffer))
    files['xl/comments1.xml'] = strToU8(
      '<?xml version="1.0"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>EAB Agent</author></authors><commentList><comment ref="A1" authorId="0"><text><r><t>共享批注</t></r></text></comment></commentList></comments>',
    )
    files['xl/drawings/vmlDrawing1.vml'] = strToU8('<xml/>')
    files['xl/worksheets/_rels/sheet1.xml.rels'] = strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/></Relationships>',
    )
    files['xl/worksheets/_rels/sheet2.xml.rels'] = strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="../sharedStrings.xml"/></Relationships>',
    )
    files['[Content_Types].xml'] = strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/><Override PartName="/xl/drawings/vmlDrawing1.vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/></Types>',
    )

    const deleted = deleteXlsxSheet(Buffer.from(zipSync(files)), 's2')
    const deletedFiles = unzipSync(new Uint8Array(deleted.buffer))
    expect(deletedFiles['xl/comments1.xml']).toBeTruthy()
    expect(deletedFiles['xl/sharedStrings.xml']).toBeTruthy()
    expect(deletedFiles['xl/drawings/vmlDrawing1.vml']).toBeUndefined()
    expect(deletedFiles['xl/worksheets/_rels/sheet2.xml.rels']).toBeUndefined()
    expect(new TextDecoder().decode(deletedFiles['[Content_Types].xml'])).toContain('comments1.xml')
    expect(new TextDecoder().decode(deletedFiles['[Content_Types].xml'])).not.toContain('vmlDrawing1.vml')

    const chartFiles = unzipSync(new Uint8Array(added.buffer))
    chartFiles['xl/charts/chart1.xml'] = strToU8('<chart><c:f>新增表!$A$1</c:f></chart>')
    expect(() => deleteXlsxSheet(Buffer.from(zipSync(chartFiles)), 's2')).toThrow('图表或数据透视表')
  })
})

describe('xlsx cell comments', () => {
  const XLSX_SHEET = `
    <row r="1"><c r="A1" t="inlineStr"><is><t>项目</t></is></c><c r="B1" t="inlineStr"><is><t>值</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>负责人</t></is></c><c r="B2"><v>42</v></c></row>
  `
  it('adds comments, reads them back and cleans up the last comment', () => {
    const source = makeXlsx(XLSX_SHEET)
    const first = addXlsxCellComment(source, {
      elementId: 's1-r1-c1',
      text: '这是 A1 的批注 & <验收>',
      author: '验收员',
    })
    expect(first).toMatchObject({
      kind: 'sheet_cell',
      elementId: 's1-r1-c1',
      sheetId: 's1',
      sheetName: '隐患台账',
      cell: 'A1',
      commentId: 1,
      author: '验收员',
    })
    const files = unzipSync(new Uint8Array(first.buffer))
    const commentsXml = new TextDecoder().decode(files['xl/comments/comment1.xml'])
    expect(commentsXml).toContain('<author>验收员</author>')
    expect(commentsXml).toContain('ref="A1"')
    expect(commentsXml).toContain('这是 A1 的批注 &amp; &lt;验收&gt;')
    const vmlXml = new TextDecoder().decode(files['xl/drawings/vmlDrawing1.vml'])
    expect(vmlXml).toContain('<x:Row>0</x:Row><x:Column>0</x:Column>')
    const relsXml = new TextDecoder().decode(files['xl/worksheets/_rels/sheet1.xml.rels'])
    expect(relsXml).toContain('Target="/xl/comments/comment1.xml"')
    expect(relsXml).toContain('Target="/xl/drawings/vmlDrawing1.vml"')
    const typesXml = new TextDecoder().decode(files['[Content_Types].xml'])
    expect(typesXml).toContain('Extension="vml"')
    expect(typesXml).toContain('/xl/comments/comment1.xml')

    expect(readXlsxComments(first.buffer)).toMatchObject({
      total: 1,
      resolvedCount: 0,
      comments: [
        {
          id: 1,
          elementId: 's1-r1-c1',
          sheetName: '隐患台账',
          cell: 'A1',
          author: '验收员',
          text: '这是 A1 的批注 & <验收>',
        },
      ],
    })

    const second = addXlsxCellComment(first.buffer, {
      elementId: 's1-r2-c2',
      text: '这是 B2 的批注',
      author: 'EAB Agent',
    })
    expect(second.commentId).toBe(2)
    expect(readXlsxComments(second.buffer).comments.map((comment) => comment.cell)).toEqual(['A1', 'B2'])

    const deleted = deleteXlsxCellComment(second.buffer, { elementId: 's1-r1-c1' })
    expect(deleted).toMatchObject({ elementId: 's1-r1-c1', cell: 'A1', deleted: true, remaining: 1 })
    const afterDelete = unzipSync(new Uint8Array(deleted.buffer))
    const afterComments = new TextDecoder().decode(afterDelete['xl/comments/comment1.xml'])
    expect(afterComments).not.toContain('ref="A1"')
    expect(afterComments).toContain('ref="B2"')
    const afterVml = new TextDecoder().decode(afterDelete['xl/drawings/vmlDrawing1.vml'])
    expect(afterVml).toContain('<x:Row>1</x:Row><x:Column>1</x:Column>')
    expect(afterVml).not.toContain('<x:Row>0</x:Row><x:Column>0</x:Column>')

    const deletedLast = deleteXlsxCellComment(deleted.buffer, { commentId: 1 })
    expect(deletedLast).toMatchObject({ cell: 'B2', remaining: 0 })
    const empty = unzipSync(new Uint8Array(deletedLast.buffer))
    expect(empty['xl/comments/comment1.xml']).toBeUndefined()
    expect(empty['xl/drawings/vmlDrawing1.vml']).toBeUndefined()
    expect(new TextDecoder().decode(empty['xl/worksheets/_rels/sheet1.xml.rels'])).not.toContain('comments')
    expect(new TextDecoder().decode(empty['[Content_Types].xml'])).not.toContain('comments/comment1.xml')
  })

  it('keeps a VML part that still contains non-comment shapes after deleting the last comment', () => {
    const added = addXlsxCellComment(makeXlsx(XLSX_SHEET), {
      elementId: 's1-r1-c1',
      text: '最后一条',
    })
    const files = unzipSync(new Uint8Array(added.buffer))
    const vml = new TextDecoder().decode(files['xl/drawings/vmlDrawing1.vml'])
    files['xl/drawings/vmlDrawing1.vml'] = strToU8(
      vml.replace(
        '</xml>',
        '<v:shape xmlns:v="urn:schemas-microsoft-com:vml" xmlns:x="urn:schemas-microsoft-com:office:excel" type="#_x0000_t202"><x:ClientData ObjectType="Button"><x:Anchor>1, 1, 0, 0, 2, 2, 0, 0</x:Anchor></x:ClientData></v:shape></xml>',
      ),
    )
    const withButton = Buffer.from(zipSync(files))
    const deleted = deleteXlsxCellComment(withButton, { elementId: 's1-r1-c1' })
    expect(deleted.remaining).toBe(0)
    const after = unzipSync(new Uint8Array(deleted.buffer))
    expect(after['xl/comments/comment1.xml']).toBeUndefined()
    const afterVml = new TextDecoder().decode(after['xl/drawings/vmlDrawing1.vml'])
    expect(afterVml).toContain('ObjectType="Button"')
    expect(afterVml).not.toContain('ObjectType="Note"')
    const rels = new TextDecoder().decode(after['xl/worksheets/_rels/sheet1.xml.rels'])
    expect(rels).not.toContain('/comments/comment1.xml')
    expect(rels).toContain('/xl/drawings/vmlDrawing1.vml')
    const types = new TextDecoder().decode(after['[Content_Types].xml'])
    expect(types).toContain('Extension="vml"')
    expect(types).not.toContain('/xl/comments/comment1.xml')
  })

  it('reads and deletes openpyxl-style comments that use absolute relationship targets', () => {
    const files = unzipSync(new Uint8Array(makeXlsx(XLSX_SHEET)))
    files['xl/comments/comment1.xml'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>验收员</author><author>EAB Agent</author></authors><commentList><comment ref="A1" authorId="0" shapeId="0"><text><t>这是 A1 的批注</t></text></comment><comment ref="B2" authorId="1" shapeId="0"><text><t>这是 B2 的批注</t></text></comment></commentList></comments>',
    )
    files['xl/drawings/commentsDrawing1.vml'] = strToU8(
      '<xml><v:shape xmlns:v="urn:schemas-microsoft-com:vml" xmlns:x="urn:schemas-microsoft-com:office:excel" type="#_x0000_t202"><x:ClientData ObjectType="Note"><x:Row>0</x:Row><x:Column>0</x:Column></x:ClientData></v:shape><v:shape xmlns:v="urn:schemas-microsoft-com:vml" xmlns:x="urn:schemas-microsoft-com:office:excel" type="#_x0000_t202"><x:ClientData ObjectType="Note"><x:Row>1</x:Row><x:Column>1</x:Column></x:ClientData></v:shape></xml>',
    )
    files['xl/worksheets/_rels/sheet1.xml.rels'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="/xl/comments/comment1.xml" Id="comments"/><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="/xl/drawings/commentsDrawing1.vml" Id="anysvml"/></Relationships>',
    )
    files['[Content_Types].xml'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Override PartName="/xl/comments/comment1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/></Types>',
    )
    const sample = Buffer.from(zipSync(files))
    expect(readXlsxComments(sample).comments.map((comment) => `${comment.cell}:${comment.author}:${comment.text}`)).toEqual([
      'A1:验收员:这是 A1 的批注',
      'B2:EAB Agent:这是 B2 的批注',
    ])

    const deleted = deleteXlsxCellComment(sample, { elementId: 's1-r1-c1' })
    expect(deleted.remaining).toBe(1)
    expect(readXlsxComments(deleted.buffer).comments.map((comment) => comment.cell)).toEqual(['B2'])
  })

  it('rejects duplicate cells and unsupported xlsx comment operations', () => {
    const source = makeXlsx(XLSX_SHEET)
    const added = addXlsxCellComment(source, { elementId: 's1-r1-c1', text: '第一条' })
    expect(() => addXlsxCellComment(added.buffer, { elementId: 's1-r1-c1', text: '第二条' })).toThrow(
      '已有批注',
    )
    expect(() => addXlsxCellComment(source, { elementId: 's1-r1-c1', text: '   ' })).toThrow('不能为空')
    expect(() => deleteXlsxCellComment(source, { elementId: 's1-r1-c1' })).toThrow('没有批注文件')
    expect(() => deleteXlsxCellComment(added.buffer, { elementId: 's1-r2-c2' })).toThrow('没有批注')
  })

  it('removes sheet-owned comments and VML when deleting the sheet', () => {
    const twoSheets = appendXlsxSheet(makeXlsx(XLSX_SHEET), '新增表')
    const commented = addXlsxCellComment(twoSheets.buffer, {
      elementId: 's2-r1-c1',
      text: '新增表批注',
    })
    const deleted = deleteXlsxSheet(commented.buffer, 's2')
    const files = unzipSync(new Uint8Array(deleted.buffer))
    expect(files['xl/comments/comment1.xml']).toBeUndefined()
    expect(files['xl/drawings/vmlDrawing1.vml']).toBeUndefined()
    expect(files['xl/worksheets/_rels/sheet2.xml.rels']).toBeUndefined()
    expect(new TextDecoder().decode(files['[Content_Types].xml'])).not.toContain('comments/comment1.xml')
  })
})

describe('pptx local text replacement', () => {
  const slideXml =
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<p:cSld><p:spTree><p:sp><p:txBody>' +
    '<a:p><a:r><a:rPr b="1"/><a:t>第一段</a:t></a:r></a:p>' +
    '<a:p><a:r><a:rPr i="1"/><a:t>跨</a:t></a:r><a:r><a:t>run 文本</a:t></a:r></a:p>' +
    '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'

  it('reads slide paragraphs and finds text', () => {
    const source = makePptx(slideXml)
    const outline = readPptxOutline(source)
    expect(outline.slideCount).toBe(1)
    expect(outline.slides[0].paragraphs.map((paragraph) => paragraph.text)).toEqual([
      '第一段',
      '跨run 文本',
    ])
    const match = findInPptx(source, '第一段')
    expect(match).toHaveLength(1)
    expect(match[0].elementId).toBe('s1-p1')
    expect(match[0].slideName).toBe('幻灯片 1')
  })

  it('replaces text in one run without touching run formatting', () => {
    const source = makePptx(slideXml)
    const result = replacePptxText(source, {
      elementId: 's1-p1',
      oldText: '第一',
      newText: '新第一',
    })
    expect(result.nextText).toBe('新第一段')
    expect(result.previousText).toBe('第一段')
    const xml = new TextDecoder().decode(unzipSync(new Uint8Array(result.buffer))['ppt/slides/slide1.xml'])
    expect(xml).toContain('<a:rPr b="1"/>')
    expect(xml).toContain('<a:t>新第一段</a:t>')
  })

  it('replaces across runs, keeps the first run format and clears the remaining run', () => {
    const source = makePptx(slideXml)
    const result = replacePptxText(source, {
      elementId: 's1-p2',
      oldText: '跨run 文本',
      newText: '合并文本',
    })
    expect(result.nextText).toBe('合并文本')
    const outline = readPptxOutline(result.buffer)
    expect(outline.slides[0].paragraphs[1].text).toBe('合并文本')
    const xml = new TextDecoder().decode(unzipSync(new Uint8Array(result.buffer))['ppt/slides/slide1.xml'])
    expect(xml).toContain('<a:rPr i="1"/>')
    expect(xml).toMatch(/<a:t>合并文本<\/a:t><\/a:r><a:r><a:t><\/a:t>/)
  })

  it('keeps an adjacent run when the match starts exactly at a run boundary', () => {
    const source = makePptx(slideXml)
    const result = replacePptxText(source, {
      elementId: 's1-p2',
      oldText: 'run 文本',
      newText: '替换',
    })
    expect(result.nextText).toBe('跨替换')
    const xml = new TextDecoder().decode(unzipSync(new Uint8Array(result.buffer))['ppt/slides/slide1.xml'])
    expect(xml).toContain('<a:t>跨</a:t>')
    expect(xml).toContain('<a:t>替换</a:t>')
  })

  it('replaces a whole paragraph and rejects unsupported line breaks', () => {
    const source = makePptx(slideXml)
    const result = replacePptxText(source, { elementId: 's1-p2', newText: '整段替换' })
    expect(readPptxOutline(result.buffer).slides[0].paragraphs[1].text).toBe('整段替换')
    expect(() =>
      replacePptxText(source, { elementId: 's1-p1', newText: '第一行\n第二行' }),
    ).toThrow('不支持换行')
  })
})

function makePptx(slideXml: string): Buffer {
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
      ),
      'ppt/presentation.xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
      ),
      'ppt/_rels/presentation.xml.rels': strToU8(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
      ),
      'ppt/slides/slide1.xml': strToU8(slideXml),
    }),
  )
}
