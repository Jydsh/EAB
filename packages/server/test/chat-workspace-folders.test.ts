import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8')
const start = source.indexOf('/* ---------------- 云空间虚拟目录 ---------------- */')
const end = source.indexOf('function workspaceFileUrl')
if (start < 0 || end <= start) throw new Error('无法从 chat.js 定位云空间目录函数')
const directorySource = source.slice(start, end)
const {
  workspaceNormalizePath,
  workspaceFileParentPath,
  workspacePathExists,
  workspaceDirView,
  workspaceFolderNameError,
  workspaceFolderPathJoin,
} = new Function(
  `${directorySource}; return {
    workspaceNormalizePath,
    workspaceFileParentPath,
    workspacePathExists,
    workspaceDirView,
    workspaceFolderNameError,
    workspaceFolderPathJoin,
  }`,
)() as {
  workspaceNormalizePath: (value: string) => string
  workspaceFileParentPath: (fileOrPath: string | { relPath?: string; name?: string }) => string
  workspacePathExists: (
    files: Array<{ relPath?: string; name?: string }>,
    path: string,
  ) => boolean
  workspaceDirView: (
    files: Array<{
      id: string
      name: string
      relPath: string
      updatedAt?: number
      shared?: boolean
    }>,
    path: string,
  ) => {
    path: string
    folders: Array<{ name: string; path: string; fileCount: number; folderCount: number; shared: boolean }>
    files: Array<{ id: string }>
  }
  workspaceFolderNameError: (value: string) => string
  workspaceFolderPathJoin: (parentPath: string, name: string) => string
}

const files = [
  { id: 'root', name: 'README.md', relPath: 'README.md', updatedAt: 10 },
  { id: 'b', name: 'b.md', relPath: 'docs/b.md', updatedAt: 20, shared: true },
  { id: 'c', name: 'c.txt', relPath: 'docs/c.txt', updatedAt: 30 },
  { id: 'd', name: 'd.md', relPath: 'docs/deep/d.md', updatedAt: 40 },
  { id: 'e', name: 'e.txt', relPath: 'other/e.txt', updatedAt: 50 },
]

describe('云空间虚拟目录', () => {
  it('根目录只显示直接文件和一级文件夹，并统计整个文件夹的文件数', () => {
    const view = workspaceDirView(files, '')
    expect(view.path).toBe('')
    expect(view.folders.map((folder) => folder.name)).toEqual(['docs', 'other'])
    expect(view.folders[0]).toMatchObject({
      path: 'docs',
      fileCount: 3,
      shared: true,
    })
    expect(view.folders[1]).toMatchObject({ path: 'other', fileCount: 1, shared: false })
    expect(view.files.map((file) => file.id)).toEqual(['root'])
  })

  it('进入子目录后显示下层文件夹和直接文件，不混入其它目录', () => {
    const view = workspaceDirView(files, 'docs')
    expect(view.folders.map((folder) => folder.name)).toEqual(['deep'])
    expect(view.folders[0]).toMatchObject({ path: 'docs/deep', fileCount: 1 })
    expect(view.files.map((file) => file.id)).toEqual(['c', 'b'])
  })

  it('多级目录和末尾斜杠会归一化，文件所在目录不丢层级', () => {
    expect(workspaceNormalizePath('docs//deep/')).toBe('docs/deep')
    expect(workspaceNormalizePath('\\docs\\deep\\d.md')).toBe('docs/deep/d.md')
    expect(workspaceFileParentPath('docs/deep/d.md')).toBe('docs/deep')
    expect(workspaceFileParentPath({ relPath: 'README.md', name: 'README.md' })).toBe('')
    expect(workspaceDirView(files, 'docs/deep').files.map((file) => file.id)).toEqual(['d'])
  })

  it('目录不存在时返回空视图，供列表回退根目录', () => {
    expect(workspacePathExists(files, '')).toBe(true)
    expect(workspacePathExists(files, 'docs/deep')).toBe(true)
    expect(workspacePathExists(files, 'missing')).toBe(false)
    const view = workspaceDirView(files, 'missing')
    expect(view.folders).toEqual([])
    expect(view.files).toEqual([])
  })

  it('空文件夹用 .gitkeep 占位时显示文件夹本身，不把占位文件当用户文件', () => {
    const placeholderFiles = [
      { id: 'keep', name: '.gitkeep', relPath: 'text/.gitkeep' },
    ]
    const root = workspaceDirView(placeholderFiles, '')
    expect(root.folders).toEqual([
      { name: 'text', path: 'text', fileCount: 0, folderCount: 0, shared: false },
    ])
    expect(root.files).toEqual([])
    expect(workspacePathExists(placeholderFiles, 'text')).toBe(true)
    const inside = workspaceDirView(placeholderFiles, 'text')
    expect(inside.folders).toEqual([])
    expect(inside.files).toEqual([])
  })

  it('只有子文件夹时也显示文件夹计数，不再误报空文件夹', () => {
    const nested = [
      { id: 'keep', name: '.gitkeep', relPath: 'docs/qa-child/qa-grand/.gitkeep' },
      { id: 'plan', name: 'plan.md', relPath: 'docs/qa-child/plan.md' },
    ]
    const root = workspaceDirView(nested, '')
    expect(root.folders[0]).toMatchObject({
      path: 'docs',
      fileCount: 1,
      folderCount: 1,
    })
    const child = workspaceDirView(nested, 'docs/qa-child')
    expect(child.folders).toEqual([
      { name: 'qa-grand', path: 'docs/qa-child/qa-grand', fileCount: 0, folderCount: 0, shared: false },
    ])
    expect(child.files.map((file) => file.id)).toEqual(['plan'])
  })

  it('文件夹名称校验与路径拼接和右键菜单保持一致', () => {
    expect(workspaceFolderNameError('工作计划')).toBe('')
    expect(workspaceFolderNameError('')).toMatch(/不能为空/)
    expect(workspaceFolderNameError('a/b')).toMatch(/斜杠/)
    expect(workspaceFolderNameError('..')).toMatch(/具体的文件夹名称/)
    expect(workspaceFolderNameError('_recycle')).toMatch(/不能以 \. 或 _ 开头/)
    expect(workspaceFolderNameError('CON')).toMatch(/Windows 保留名/)
    expect(workspaceFolderNameError('结尾点.')).toMatch(/不能以点或空格结尾/)
    expect(workspaceFolderPathJoin('docs', '工作计划')).toBe('docs/工作计划')
    expect(workspaceFolderPathJoin('', '工作计划')).toBe('工作计划')
    expect(workspaceFolderPathJoin('/docs/', '工作计划')).toBe('docs/工作计划')
  })
})
