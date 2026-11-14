import { describe, expect, it } from 'vitest'
import { withActiveFileDefaults } from '../src/routes/tools.js'

const active = { id: 'file_q1', relPath: '文档/季度复盘.docx' }

describe('工具参数按右侧预览文件兜底', () => {
  it('office_* 缺 fileId 与 path 时补当前文件', () => {
    const out = withActiveFileDefaults('office.find', { query: '标题' }, active)
    expect(out.fileId).toBe('file_q1')
    expect(out.query).toBe('标题')
  })

  it('模型自己给了 path 或 fileId 时一律不覆盖', () => {
    const byPath = withActiveFileDefaults('office.replace', { path: '文档/别的.docx', oldText: 'a' }, active)
    expect(byPath.fileId).toBeUndefined()
    expect(byPath.path).toBe('文档/别的.docx')

    const byId = withActiveFileDefaults('office.read_range', { fileId: 'file_x', elementId: 'p1' }, active)
    expect(byId.fileId).toBe('file_x')
  })

  it('workspace.read 缺 path 时补相对路径', () => {
    const out = withActiveFileDefaults('workspace.read', {}, active)
    expect(out.path).toBe('文档/季度复盘.docx')
  })

  it('其它工具与没有预览文件的情况保持原样', () => {
    const payload = { query: '今天的日程' }
    expect(withActiveFileDefaults('tool.search', payload, active)).toBe(payload)
    expect(withActiveFileDefaults('office.find', payload, undefined)).toBe(payload)
    // 空字符串的 fileId 视同没给
    expect(withActiveFileDefaults('office.find', { fileId: '  ' }, active).fileId).toBe('file_q1')
  })
})
