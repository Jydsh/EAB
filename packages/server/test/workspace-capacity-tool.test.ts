import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, migrate } from '@eab/storage'
import { SC } from '@eab/domain'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { executeTool, TOOLS, toolSpecsForActor } from '../src/routes/tools.js'

function testDeps() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-workspace-capacity-'))
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.exec('PRAGMA foreign_keys = OFF')
  db.prepare(
    `INSERT INTO workspace_quota_policies (company_id, scope_type, scope_id, limit_bytes, file_limit_bytes, updated_at)
     VALUES ('c1', 'user', 'u1', 100, 10, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO workspace_files (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, created_at, updated_at)
     VALUES ('f1', 'c1', 'user', 'u1', 'u1', 'a.txt', 'a.txt', 90, 1, 1)`,
  ).run()
  const userDir = join(dir, 'workspaces', 'c1', 'user-u1')
  mkdirSync(userDir, { recursive: true })
  writeFileSync(join(userDir, 'a.txt'), 'hello workspace', 'utf8')
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
      scopes: new Set([SC.WORKSPACE_READ, SC.WORKSPACE_WRITE]),
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

describe('agent 个人云空间容量工具', () => {
  it('注册为 workspace.capacity，并返回剩余空间和预警', async () => {
    const { dir, deps, actor } = testDeps()
    try {
      expect(TOOLS.some((tool) => tool.id === 'workspace.capacity')).toBe(true)
      expect(TOOLS.some((tool) => tool.id === 'workspace.send_dingtalk')).toBe(true)
      expect(TOOLS.some((tool) => tool.id === 'workspace.rename')).toBe(true)
      expect(TOOLS.some((tool) => tool.id === 'workspace.delete')).toBe(true)
      const specs = toolSpecsForActor(deps.db, actor as unknown as Parameters<typeof executeTool>[1], {
        kind: 'cloud',
      })
      expect(specs.some((spec) => spec.function.name === 'workspace_capacity')).toBe(true)
      expect(specs.some((spec) => spec.function.name === 'workspace_send_dingtalk')).toBe(true)
      expect(specs.some((spec) => spec.function.name === 'workspace_rename')).toBe(true)
      expect(specs.some((spec) => spec.function.name === 'workspace_delete')).toBe(true)
      const localSpecs = toolSpecsForActor(deps.db, actor as unknown as Parameters<typeof executeTool>[1], {
        kind: 'local',
        spaceId: 'lsp_test',
      })
      expect(localSpecs.some((spec) => spec.function.name === 'workspace_capacity')).toBe(false)
      expect(localSpecs.some((spec) => spec.function.name === 'workspace_send_dingtalk')).toBe(false)
      expect(localSpecs.some((spec) => spec.function.name === 'workspace_rename')).toBe(false)
      expect(localSpecs.some((spec) => spec.function.name === 'workspace_delete')).toBe(false)
      const noneSpecs = toolSpecsForActor(deps.db, actor as unknown as Parameters<typeof executeTool>[1], {
        kind: 'none',
      })
      expect(noneSpecs.some((spec) => spec.function.name.startsWith('workspace_'))).toBe(false)
      expect(noneSpecs.some((spec) => spec.function.name.startsWith('local_'))).toBe(false)
      const renamed = (await executeTool(
        deps,
        actor as unknown as Parameters<typeof executeTool>[1],
        'workspace.rename',
        { path: 'a.txt', newName: 'b.txt' },
      )) as Record<string, unknown>
      expect(renamed).toMatchObject({ renamed: true, from: 'a.txt', to: 'b.txt', name: 'b.txt' })
      expect(existsSync(join(dir, 'workspaces', 'c1', 'user-u1', 'b.txt'))).toBe(true)
      expect(existsSync(join(dir, 'workspaces', 'c1', 'user-u1', 'a.txt'))).toBe(false)
      const result = (await executeTool(
        deps,
        actor as unknown as Parameters<typeof executeTool>[1],
        'workspace.capacity',
        {},
      )) as Record<string, unknown>
      expect(result).toMatchObject({
        scope: '个人云空间',
        usedBytes: 90,
        limitBytes: 100,
        remainingBytes: 10,
        percent: 90,
        level: 'warning',
      })
      expect((result.warning as { message: string }).message).toContain('快满了')
      const deleted = (await executeTool(
        deps,
        actor as unknown as Parameters<typeof executeTool>[1],
        'workspace.delete',
        { path: 'b.txt' },
      )) as Record<string, unknown>
      expect(deleted).toMatchObject({ deleted: true, fileName: 'b.txt', recycled: true })
      expect(existsSync(join(dir, 'workspaces', 'c1', 'user-u1', 'b.txt'))).toBe(false)
      const afterDelete = (await executeTool(
        deps,
        actor as unknown as Parameters<typeof executeTool>[1],
        'workspace.capacity',
        {},
      )) as Record<string, unknown>
      expect(afterDelete).toMatchObject({ usedBytes: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
