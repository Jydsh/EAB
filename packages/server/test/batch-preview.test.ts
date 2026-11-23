import { describe, expect, it } from 'vitest'
import { batchPreviewTable } from '../src/routes/chat.js'

/** DSH 加班明细行：字段多、值带中文、单行较长，是最容易把预算吃掉的形状。 */
function dshRows(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    ObjectId: `id-${index}`,
    姓名: '蒋平安',
    所在部门: '重庆东环线组',
    开始时间: `2026/11/${String((index % 28) + 1).padStart(2, '0')} 18:00:00`,
    结束时间: `2026/11/${String((index % 28) + 1).padStart(2, '0')} 23:00:00`,
    '加班时长（H）': '5.5',
    作业地: '安顺',
    工作内容: '其它（上述加班场景以外）',
    加班场景: '跨部门或支持本部门创收业务：实际管理或作业',
    填写时间: '2026/11/20 20:56:19',
  }))
}

describe('batchPreviewTable', () => {
  it('表头只出现一次，每行一行 TSV，行数与列数完整', () => {
    const rows = dshRows(12)
    const columns = Object.keys(rows[0]!)
    const preview = batchPreviewTable(rows, columns, 200_000)
    const lines = preview.text.split('\n')
    expect(lines).toHaveLength(13)
    expect(preview.shown).toBe(12)
    expect(lines[0]).toBe(columns.join('\t'))
    for (const line of lines.slice(1)) {
      expect(line.split('\t')).toHaveLength(columns.length)
      expect(line).toContain('蒋平安')
    }
  })

  it('预算不够时截断在整行边界，不产生半行', () => {
    const rows = dshRows(120)
    const columns = Object.keys(rows[0]!)
    const preview = batchPreviewTable(rows, columns, 3_000)
    expect(preview.shown).toBeGreaterThan(0)
    expect(preview.shown).toBeLessThan(120)
    const lines = preview.text.split('\n')
    expect(lines).toHaveLength(preview.shown + 1)
    for (const line of lines.slice(1)) {
      expect(line.split('\t')).toHaveLength(columns.length)
    }
  })

  it('同预算下比 JSON 放得下更多行（这就是换 TSV 的原因）', () => {
    const rows = dshRows(60)
    const preview = batchPreviewTable(rows, Object.keys(rows[0]!), 12_000)
    const jsonChars = JSON.stringify(rows).length
    expect(jsonChars).toBeGreaterThan(12_000)
    expect(preview.shown).toBeGreaterThan(30)
  })

  it('单元格里的换行和制表符被压平，不会破坏表格结构', () => {
    const rows = [{ 姓名: '蒋平安', 备注: '第一行\n第二行\t列' }]
    const preview = batchPreviewTable(rows, ['姓名', '备注'], 1_000)
    const lines = preview.text.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]!.split('\t')).toHaveLength(2)
  })
})
