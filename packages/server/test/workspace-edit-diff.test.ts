import { describe, expect, it } from 'vitest'
import { buildWorkspaceEditDiff } from '../src/routes/workspace.js'

describe('文件修改差异', () => {
  it('单行替换只显示删掉和新增的那一行', () => {
    const diff = buildWorkspaceEditDiff([
      { find: 'export const line13 = 13', replace: 'export const line13 = "蓝鲸-编辑-13"' },
    ])
    expect(diff).toMatchObject({ added: 1, removed: 1, truncated: false })
    expect(diff.lines).toEqual([
      { type: 'del', text: 'export const line13 = 13' },
      { type: 'add', text: 'export const line13 = "蓝鲸-编辑-13"' },
    ])
  })

  it('多行片段只保留真正变化的行，前后未变行折叠', () => {
    const diff = buildWorkspaceEditDiff([
      {
        find: 'const a = 1\nconst b = 2\nconst c = 3',
        replace: 'const a = 1\nconst b = 20\nconst c = 3',
      },
    ])
    expect(diff.lines).toEqual([
      { type: 'del', text: 'const b = 2' },
      { type: 'add', text: 'const b = 20' },
    ])
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
  })

  it('删除片段只显示删除行', () => {
    const diff = buildWorkspaceEditDiff([{ find: 'delete me\n', replace: '' }])
    expect(diff.lines).toEqual([{ type: 'del', text: 'delete me' }])
    expect(diff.added).toBe(0)
    expect(diff.removed).toBe(1)
  })

  it('差异超过上限时标记截断，不把整文件贴进工具卡', () => {
    const find = Array.from({ length: 100 }, (_, index) => `old-${index}`).join('\n')
    const replace = Array.from({ length: 100 }, (_, index) => `new-${index}`).join('\n')
    const diff = buildWorkspaceEditDiff([{ find, replace }])
    expect(diff.lines).toHaveLength(80)
    expect(diff.truncated).toBe(true)
  })
})
