import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { pruneWorkspaceRecycle } from '../src/workspace-recycle.js'

const roots: string[] = []
const day = 86_400_000

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'eab-recycle-test-'))
  roots.push(root)
  return root
}

function seedCompany(db: ReturnType<typeof openDatabase>, now: number) {
  db.prepare(
    "INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c1', '测试公司', 'c1', 'active', ?)",
  ).run(now)
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('云空间回收区保留清理', () => {
  it('物理删除超过保留期的回收区文件，并清理元数据与依赖', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    const root = tempRoot()
    const now = Date.now()
    seedCompany(db, now)

    const oldFile = join(root, 'c1', 'user-u1', '_recycle', 'file-old.txt')
    mkdirSync(join(root, 'c1', 'user-u1', '_recycle'), { recursive: true })
    writeFileSync(oldFile, 'old-content')
    db.prepare(
      `INSERT INTO workspace_files
         (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, deleted_at,
          recycled_path, created_at, updated_at)
       VALUES ('file-old', 'c1', 'user', 'u1', 'u1', 'old.txt', 'old.txt', 11, ?, ?, ?, ?)`,
    ).run(now - 40 * day, oldFile, now - 41 * day, now - 40 * day)

    const versionPath = join(root, 'c1', 'user-u1', '_versions', 'file-old', '1.txt')
    mkdirSync(join(root, 'c1', 'user-u1', '_versions', 'file-old'), { recursive: true })
    writeFileSync(versionPath, 'snapshot')
    db.prepare(
      `INSERT INTO workspace_file_versions
         (id, company_id, file_id, version, size, storage_path, source, created_by, created_at)
       VALUES ('ver-old', 'c1', 'file-old', 1, 8, ?, 'test', 'u1', ?)`,
    ).run(versionPath, now - 40 * day)
    db.prepare(
      `INSERT INTO workspace_shares
         (id, company_id, file_id, scope_type, scope_id, created_by, created_at)
       VALUES ('share-old', 'c1', 'file-old', 'user', 'u1', 'u1', ?)`,
    ).run(now - 40 * day)
    db.prepare(
      `INSERT INTO workspace_gui_fallbacks
         (id, company_id, file_id, user_id, gui_action, gui_label, mode, steps_json, status, created_at, expires_at)
       VALUES ('gui-old', 'c1', 'file-old', 'u1', 'print', '打印', 'native', '[]', 'succeeded', ?, ?)`,
    ).run(now - 40 * day, now - 39 * day)
    db.prepare(
      `INSERT INTO workspace_office_refresh_guards
         (company_id, file_id, cutoff, updated_at)
       VALUES ('c1', 'file-old', ?, ?)`,
    ).run(now - 40 * day, now - 40 * day)

    const keepFile = join(root, 'c1', 'user-u1', '_recycle', 'file-keep.txt')
    writeFileSync(keepFile, 'keep')
    db.prepare(
      `INSERT INTO workspace_files
         (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, deleted_at,
          recycled_path, created_at, updated_at)
       VALUES ('file-keep', 'c1', 'user', 'u1', 'u1', 'keep.txt', 'keep.txt', 4, ?, ?, ?, ?)`,
    ).run(now - 2 * day, keepFile, now - 3 * day, now - 2 * day)

    const result = pruneWorkspaceRecycle(db, root, 30)
    expect(result).toMatchObject({ days: 30, files: 1, bytes: 11, rows: 1, skipped: false })
    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(versionPath)).toBe(false)
    expect(existsSync(keepFile)).toBe(true)
    expect(db.prepare("SELECT id FROM workspace_files WHERE id = 'file-old'").get()).toBeUndefined()
    expect(db.prepare("SELECT id FROM workspace_file_versions WHERE id = 'ver-old'").get()).toBeUndefined()
    expect(db.prepare("SELECT id FROM workspace_shares WHERE id = 'share-old'").get()).toBeUndefined()
    expect(db.prepare("SELECT id FROM workspace_gui_fallbacks WHERE id = 'gui-old'").get()).toBeUndefined()
    expect(
      db.prepare("SELECT file_id FROM workspace_office_refresh_guards WHERE file_id = 'file-old'").get(),
    ).toBeUndefined()
    expect((db.prepare("SELECT recycled_path FROM workspace_files WHERE id = 'file-keep'").get() as any).recycled_path).toBe(keepFile)

    db.close()
  })

  it('回收路径越界时跳过，不删除根目录外的文件', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    const root = tempRoot()
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'do-not-delete')
    const now = Date.now()
    seedCompany(db, now)
    db.prepare(
      `INSERT INTO workspace_files
         (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, deleted_at,
          recycled_path, created_at, updated_at)
       VALUES ('file-outside', 'c1', 'user', 'u1', 'u1', 'outside.txt', 'outside.txt', 13, ?, ?, ?, ?)`,
    ).run(now - 40 * day, outside, now - 41 * day, now - 40 * day)

    // 用一个只包含 _recycle 子目录的根，outside.txt 在根内但不在 _recycle 下；
    // 这里直接用更窄的根模拟越界，确保路径守卫拦截。
    const narrowRoot = join(root, 'c1', 'user-u1', '_recycle')
    mkdirSync(narrowRoot, { recursive: true })
    const result = pruneWorkspaceRecycle(db, narrowRoot, 30)
    expect(result.files).toBe(0)
    expect(result.skippedIds).toContain('file-outside')
    expect(existsSync(outside)).toBe(true)

    db.close()
  })

  it('保留天数为 0 时永久保留，不做任何删除', () => {
    const db = openDatabase({ path: ':memory:' })
    migrate(db)
    const root = tempRoot()
    const now = Date.now()
    seedCompany(db, now)
    const file = join(root, 'c1', 'user-u1', '_recycle', 'file.txt')
    mkdirSync(join(root, 'c1', 'user-u1', '_recycle'), { recursive: true })
    writeFileSync(file, 'x')
    db.prepare(
      `INSERT INTO workspace_files
         (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, deleted_at,
          recycled_path, created_at, updated_at)
       VALUES ('file-zero', 'c1', 'user', 'u1', 'u1', 'file.txt', 'file.txt', 1, ?, ?, ?, ?)`,
    ).run(now - 40 * day, file, now - 41 * day, now - 40 * day)

    const result = pruneWorkspaceRecycle(db, root, 0)
    expect(result).toMatchObject({ days: 0, files: 0, rows: 0, skipped: true })
    expect(existsSync(file)).toBe(true)

    db.close()
  })
})
