import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deleteLocalFile, type LocalSpaceRow } from '../src/local-space.js'
import { listToolDefinitions } from '../src/routes/tools.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function space(root: string, mode: LocalSpaceRow['mode'] = 'read_write'): LocalSpaceRow {
  return {
    id: 'lsp_test',
    company_id: 'c1',
    user_id: 'u_test',
    name: 'test',
    root_path: root,
    root_realpath: root,
    mode,
    allow_sensitive: 1,
    created_at: Date.now(),
    updated_at: Date.now(),
    last_used_at: null,
    deleted_at: null,
  }
}

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eab-local-delete-'))
  dirs.push(dir)
  return dir
}

describe('本地空间删除文件', () => {
  it('删除单个文件并返回相对路径和大小', () => {
    const root = tempRoot()
    const target = join(root, 'old.log')
    writeFileSync(target, 'hello', 'utf8')

    expect(deleteLocalFile(space(root), 'old.log')).toEqual({
      relPath: 'old.log',
      size: 5,
    })
    expect(existsSync(target)).toBe(false)
  })

  it('拒绝删除目录、根目录、不存在的路径和只读空间', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'folder'))
    const readOnly = space(root, 'read_only')
    writeFileSync(join(root, 'cannot-delete.txt'), 'x', 'utf8')

    expect(() => deleteLocalFile(space(root), 'folder')).toThrow('该路径不是文件')
    expect(() => deleteLocalFile(space(root), '')).toThrow('不能删除本地空间根目录')
    expect(() => deleteLocalFile(space(root), 'missing.txt')).toThrow('文件不存在或已被移动')
    expect(() => deleteLocalFile(readOnly, 'cannot-delete.txt')).toThrow('只读模式')
    expect(existsSync(join(root, 'cannot-delete.txt'))).toBe(true)
  })

  it('拒绝跳出根目录的相对路径', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'keep.txt'), 'x', 'utf8')
    expect(() => deleteLocalFile(space(root), '../keep.txt')).toThrow()
  })

  it('本地删除工具已注册且对模型可用', () => {
    const tool = listToolDefinitions().find((item) => item.id === 'local.delete')
    expect(tool?.dangerous).toBe(false)
    expect(tool?.scope).toBe('local-space:write')
  })
})
