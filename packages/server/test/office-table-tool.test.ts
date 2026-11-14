import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { readDocxOutline } from '../src/office-content.js'
import { executeTool } from '../src/routes/tools.js'

function makeDocx(): Buffer {
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
  <w:body>
    <w:p><w:r><w:t>表格前</w:t></w:r></w:p>
    <w:tbl>
      <w:tblGrid><w:gridCol w:w="1200"/><w:gridCol w:w="3000"/><w:gridCol w:w="1500"/></w:tblGrid>
      <w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>C1</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>C2</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>A3</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B3</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>C3</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:p><w:r><w:t>表格后</w:t></w:r></w:p>
  </w:body>
</w:document>`,
      ),
    }),
  )
}

function makeMergedDocx(): Buffer {
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
  <w:body>
    <w:p><w:r><w:t>表格前</w:t></w:r></w:p>
    <w:tbl>
      <w:tblGrid><w:gridCol w:w="1200"/><w:gridCol w:w="3000"/><w:gridCol w:w="1500"/></w:tblGrid>
      <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>合并标题</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr>
      <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>C2</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>A3</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B3</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>C3</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:p><w:r><w:t>表格后</w:t></w:r></w:p>
  </w:body>
</w:document>`,
      ),
    }),
  )
}


function documentXmlOf(buffer: Buffer): string {
  const files = unzipSync(new Uint8Array(buffer))
  const xml = files['word/document.xml']
  if (!xml) throw new Error('missing document.xml')
  return new TextDecoder().decode(xml)
}

function testDeps(buffer: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'eab-table-tool-'))
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.exec('PRAGMA foreign_keys = OFF')
  const userDir = join(dir, 'workspaces', 'c1', 'user-u1')
  mkdirSync(userDir, { recursive: true })
  const relPath = '表格验收.docx'
  writeFileSync(join(userDir, relPath), buffer)
  db.prepare(
    `INSERT INTO workspace_files (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, created_at, updated_at)
     VALUES ('f1', 'c1', 'user', 'u1', 'u1', ?, ?, ?, 1, 1)`,
  ).run(relPath, relPath, buffer.length)
  const config = { dbPath: join(dir, 'eab.db'), dataDir: dir } as ServerConfig
  const deps = { db, config, companyId: 'c1', migrations: [], consoleToken: '' } as ServerDeps
  const actor = {
    subject: {
      companyId: 'c1',
      userId: 'u1',
      status: 'active',
      deptId: 'd1',
      deptPath: '/d1',
      deptChain: [],
      roles: [],
      scopes: new Set([SC.AGENT_TOOL_INVOKE, SC.WORKSPACE_READ, SC.WORKSPACE_WRITE]),
    },
    person: {
      id: 'u1',
      name: '测试员工',
      title: null,
      deptId: 'd1',
      deptPath: '/d1',
      deptName: '测试部门',
      companyId: 'c1',
      companyName: '测试公司',
    },
  }
  return { dir, deps, actor }
}

describe('office.insert 表格删除', () => {
  it('按 action=delete 删除表格行和列，并写回云空间文件', async () => {
    const { dir, deps, actor } = testDeps(makeDocx())
    const actorArg = actor as unknown as Parameters<typeof executeTool>[1]
    const disk = join(dir, 'workspaces', 'c1', 'user-u1', '表格验收.docx')
    try {
      const deletedRow = (await executeTool(deps, actorArg, 'office.insert', {
        fileId: 'f1',
        action: 'delete',
        elementId: 't1-r2',
      })) as Record<string, unknown>
      expect(deletedRow).toMatchObject({
        action: 'delete',
        structureKind: 'table_row',
        deletedRow: 2,
        remainingRows: 2,
        remainingColumns: 3,
        wrote: true,
        saved: true,
      })
      const afterRow = readDocxOutline(readFileSync(disk), 50, { includeTableRows: true })
      const tableAfterRow = afterRow.elements[1]
      expect(tableAfterRow.kind).toBe('table')
      if (tableAfterRow.kind === 'table') {
        expect(tableAfterRow.rows).toBe(2)
        expect(tableAfterRow.preview.map((row) => row.cells.map((cell) => cell.text))).toEqual([
          ['A1', 'B1', 'C1'],
          ['A3', 'B3', 'C3'],
        ])
      }

      const deletedColumn = (await executeTool(deps, actorArg, 'office.insert', {
        fileId: 'f1',
        action: 'delete',
        elementId: 't1-c2',
      })) as Record<string, unknown>
      expect(deletedColumn).toMatchObject({
        action: 'delete',
        structureKind: 'table_column',
        deletedColumn: 2,
        remainingRows: 2,
        remainingColumns: 2,
        wrote: true,
      })
      const afterColumn = readDocxOutline(readFileSync(disk), 50, { includeTableRows: true })
      const tableAfterColumn = afterColumn.elements[1]
      expect(tableAfterColumn.kind).toBe('table')
      if (tableAfterColumn.kind === 'table') {
        expect(tableAfterColumn.preview.map((row) => row.cells.map((cell) => cell.text))).toEqual([
          ['A1', 'C1'],
          ['A3', 'C3'],
        ])
      }
      expect(afterColumn.elements.map((element) => element.kind)).toEqual(['paragraph', 'table', 'paragraph'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('按 action=split/merge 处理合并表并允许后续列删除', async () => {
    const { dir, deps, actor } = testDeps(makeMergedDocx())
    const actorArg = actor as unknown as Parameters<typeof executeTool>[1]
    const disk = join(dir, 'workspaces', 'c1', 'user-u1', '表格验收.docx')
    try {
      const split = (await executeTool(deps, actorArg, 'office.insert', {
        fileId: 'f1',
        action: 'split',
        elementId: 't1',
      })) as Record<string, unknown>
      expect(split).toMatchObject({
        action: 'split',
        structureKind: 'table_split',
        splitCells: 2,
        remainingRows: 3,
        remainingColumns: 3,
        wrote: true,
        saved: true,
      })
      const afterSplit = readDocxOutline(readFileSync(disk), 50, { includeTableRows: true })
      const splitTable = afterSplit.elements[1]
      expect(splitTable.kind).toBe('table')
      if (splitTable.kind === 'table') {
        expect(splitTable.preview.map((row) => row.cells.map((cell) => cell.text))).toEqual([
          ['合并标题', '', ''],
          ['', '', 'C2'],
          ['A3', 'B3', 'C3'],
        ])
      }

      const deleted = (await executeTool(deps, actorArg, 'office.insert', {
        fileId: 'f1',
        action: 'delete',
        elementId: 't1-c2',
      })) as Record<string, unknown>
      expect(deleted).toMatchObject({
        action: 'delete',
        structureKind: 'table_column',
        deletedColumn: 2,
        remainingRows: 3,
        remainingColumns: 2,
        wrote: true,
      })
      const afterDelete = readDocxOutline(readFileSync(disk), 50, { includeTableRows: true })
      const deletedTable = afterDelete.elements[1]
      if (deletedTable.kind === 'table') {
        expect(deletedTable.preview.map((row) => row.cells.map((cell) => cell.text))).toEqual([
          ['合并标题', ''],
          ['', 'C2'],
          ['A3', 'C3'],
        ])
      }

      const merged = (await executeTool(deps, actorArg, 'office.insert', {
        fileId: 'f1',
        action: 'merge',
        elementId: 't1-r1-c1:t1-r1-c2',
      })) as Record<string, unknown>
      expect(merged).toMatchObject({
        action: 'merge',
        structureKind: 'table_merge',
        mergedRows: 1,
        mergedColumns: 2,
        remainingRows: 3,
        remainingColumns: 2,
        wrote: true,
      })
      const xml = documentXmlOf(readFileSync(disk))
      expect(xml.match(/<w:gridSpan w:val="2"\/>/g)).toHaveLength(1)
      expect(xml).toContain('合并标题')
      await expect(
        executeTool(deps, actorArg, 'office.insert', {
          fileId: 'f1',
          action: 'insert',
          elementId: 't1-c2',
          text: '新列',
        }),
      ).rejects.toThrow('列插入暂不支持')

      const deletedMerged = (await executeTool(deps, actorArg, 'office.insert', {
        fileId: 'f1',
        action: 'delete',
        elementId: 't1-c2',
      })) as Record<string, unknown>
      expect(deletedMerged).toMatchObject({
        action: 'delete',
        structureKind: 'table_column',
        deletedColumn: 2,
        remainingRows: 3,
        remainingColumns: 1,
        wrote: true,
      })
      const afterMergedDelete = readDocxOutline(readFileSync(disk), 50, { includeTableRows: true })
      const mergedDeletedTable = afterMergedDelete.elements[1]
      if (mergedDeletedTable.kind === 'table') {
        expect(mergedDeletedTable.preview.map((row) => row.cells.map((cell) => cell.text))).toEqual([
          ['合并标题'],
          [''],
          ['A3'],
        ])
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
