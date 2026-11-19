import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { unzipSync } from 'fflate'
import { openDatabase, migrate } from '@eab/storage'
import { SC } from '@eab/domain'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { executeTool } from '../src/routes/tools.js'
import { readXlsxOutline } from '../src/office-content.js'
import { parseDelimitedRecords, parseTabularText } from '../src/delimited.js'
import { buildXlsx } from '../src/xlsx-create.js'

function testDeps() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-xlsx-write-'))
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.exec('PRAGMA foreign_keys = OFF')
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
      scopes: new Set([SC.WORKSPACE_READ, SC.WORKSPACE_WRITE, SC.AGENT_TOOL_INVOKE]),
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

describe('delimited 解析', () => {
  it('解析带引号、字段内逗号和字段内换行的 CSV', () => {
    const parsed = parseDelimitedRecords(
      '\uFEFF站名,问题,数量\n"贵阳北（弱电）","A,B 两个问题",3\n"眉山东","第一行\n第二行",5\n',
      ',',
    )
    expect(parsed?.columns).toEqual(['站名', '问题', '数量'])
    expect(parsed?.rows).toHaveLength(2)
    expect(parsed?.rows[0]).toMatchObject({ 站名: '贵阳北（弱电）', 问题: 'A,B 两个问题', 数量: '3' })
    expect(parsed?.rows[1]?.问题).toBe('第一行\n第二行')
  })

  it('识别 Markdown 表格并跳过对齐行', () => {
    const table = parseTabularText('| 站名 | 条数 |\n| --- | ---: |\n| 贵阳北（弱电） | 103 |\n| 眉山东 | 5 |')
    expect(table.format).toBe('markdown')
    expect(table.columns).toEqual(['站名', '条数'])
    expect(table.rows).toEqual([['贵阳北（弱电）', '103'], ['眉山东', '5']])
  })

  it('普通多行文本按每行一列保留，不误判成 CSV', () => {
    const table = parseTabularText('分析结果如下：\n总记录数：179条\n贵阳北（弱电）：103条')
    expect(table.format).toBe('lines')
    expect(table.columns).toEqual(['内容'])
    expect(table.rows).toHaveLength(3)
  })
})

describe('真实 xlsx 生成', () => {
  it('生成的工作簿包含 workbook、worksheet 和单元格文本', () => {
    const buffer = buildXlsx([{
      name: '汇总',
      rows: [['站名', '条数'], ['贵阳北（弱电）', 103], ['眉山东', 5]],
    }])
    expect(buffer.subarray(0, 2).toString('utf8')).toBe('PK')
    const files = unzipSync(new Uint8Array(buffer))
    expect(Object.keys(files)).toContain('xl/workbook.xml')
    const sheet = new TextDecoder().decode(files['xl/worksheets/sheet1.xml'])
    expect(sheet).toContain('贵阳北（弱电）')
    expect(sheet).toContain('<v>103</v>')
    const outline = readXlsxOutline(buffer)
    expect(outline.sheets.map((item) => item.name)).toEqual(['汇总'])
    expect(outline.sheets[0]?.cells[0]).toMatchObject({ address: 'A1', text: '站名' })
    expect(outline.sheets[0]?.cells[3]).toMatchObject({ address: 'B2', text: '103' })
  })

  it('workspace.write 写 .xlsx 时生成真实工作簿并登记正确 mime', async () => {
    const { dir, deps, actor } = testDeps()
    try {
      const result = (await executeTool(
        deps,
        actor as unknown as Parameters<typeof executeTool>[1],
        'workspace.write',
        {
          path: '分析/检查整治分析结果.xlsx',
          text: '站名,记录数,占比\n贵阳北（弱电）,103,57.5%\n贵阳北（机电）,53,29.6%\n眉山东,5,2.8%',
        },
      )) as Record<string, unknown>
      expect(result.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      expect(String(result.note)).toContain('真实 xlsx')
      const filePath = join(dir, 'workspaces', 'c1', 'user-u1', '分析', '检查整治分析结果.xlsx')
      const bytes = readFileSync(filePath)
      expect(bytes.subarray(0, 2).toString('utf8')).toBe('PK')
      const row = deps.db
        .prepare('SELECT mime FROM workspace_files WHERE rel_path = ?')
        .get('分析/检查整治分析结果.xlsx') as { mime?: string } | undefined
      expect(row?.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('workspace.write 拒绝把文本冒充 docx/pptx', async () => {
    const { dir, deps, actor } = testDeps()
    try {
      await expect(executeTool(
        deps,
        actor as unknown as Parameters<typeof executeTool>[1],
        'workspace.write',
        { path: '假文档.docx', text: '这不是 Word 文件' },
      )).rejects.toThrow(/不支持直接生成 \.docx/)
      await expect(executeTool(
        deps,
        actor as unknown as Parameters<typeof executeTool>[1],
        'workspace.write',
        { path: '假演示.pptx', text: '这不是 PPT 文件' },
      )).rejects.toThrow(/不支持直接生成 \.pptx/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
