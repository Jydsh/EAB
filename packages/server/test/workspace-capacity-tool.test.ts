import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  it('写入文件时返回稳定的 fileId，供对话里的文件操作预览打开', async () => {
    const { dir, deps, actor } = testDeps()
    try {
      const first = (await executeTool(
        deps,
        actor as unknown as Parameters<typeof executeTool>[1],
        'workspace.write',
        { path: 'b.txt', text: 'hello' },
      )) as Record<string, unknown>
      expect(first).toMatchObject({ path: 'b.txt', size: 5, created: true })
      expect(typeof first.fileId).toBe('string')
      expect(existsSync(join(dir, 'workspaces', 'c1', 'user-u1', 'b.txt'))).toBe(true)

      const second = (await executeTool(
        deps,
        actor as unknown as Parameters<typeof executeTool>[1],
        'workspace.write',
        { path: 'b.txt', text: 'hello2' },
      )) as Record<string, unknown>
      expect(second.fileId).toBe(first.fileId)
      expect(second).toMatchObject({ path: 'b.txt', size: 6, created: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

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

describe('agent 局部修改工作区文件', () => {
  it('只替换指定片段，不整篇重写；多个片段按顺序生效', async () => {
    const { dir, deps, actor } = testDeps()
    try {
      const result = (await executeTool(
        deps,
        actor as unknown as Parameters<typeof executeTool>[1],
        'workspace.edit',
        {
          path: 'a.txt',
          edits: [
            { find: 'hello', replace: '你好' },
            { find: 'workspace', replace: 'EAB' },
          ],
        },
      )) as Record<string, unknown>
      expect(result).toMatchObject({ path: 'a.txt', changes: 2, edited: true })
      expect(readFileSync(join(dir, 'workspaces', 'c1', 'user-u1', 'a.txt'), 'utf8')).toBe('你好 EAB')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('找不到原文时整体失败，不写入半成品', async () => {
    const { dir, deps, actor } = testDeps()
    try {
      await expect(
        executeTool(
          deps,
          actor as unknown as Parameters<typeof executeTool>[1],
          'workspace.edit',
          {
            path: 'a.txt',
            edits: [
              { find: 'hello', replace: '你好' },
              { find: '不存在的段落', replace: '新内容' },
            ],
          },
        ),
      ).rejects.toThrow('没有找到要替换的原文')
      expect(readFileSync(join(dir, 'workspaces', 'c1', 'user-u1', 'a.txt'), 'utf8')).toBe('hello workspace')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('注册为 workspace.edit，并向模型暴露嵌套 edits 参数', () => {
    const { dir, deps, actor } = testDeps()
    try {
      expect(TOOLS.some((tool) => tool.id === 'workspace.edit')).toBe(true)
      const spec = toolSpecsForActor(deps.db, actor as unknown as Parameters<typeof executeTool>[1], {
        kind: 'cloud',
      }).find((item) => item.function.name === 'workspace_edit')
      expect(spec?.function.parameters.required).toContain('edits')
      expect(spec?.function.parameters.properties.edits.type).toBe('array')
      expect(spec?.function.parameters.properties.edits.items?.type).toBe('object')
      expect(spec?.function.parameters.properties.edits.items?.required).toEqual(['find', 'replace'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Office 二进制不会被文本局部编辑误改', async () => {
    const { dir, deps, actor } = testDeps()
    try {
      await expect(
        executeTool(
          deps,
          actor as unknown as Parameters<typeof executeTool>[1],
          'workspace.edit',
          { path: '方案.docx', edits: [{ find: '旧内容', replace: '新内容' }] },
        ),
      ).rejects.toThrow('该文件类型暂不支持 Agent 文本局部编辑')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('跨成员团队学习候选', () => {
  it('memory.propose 只写入待审核的公司级候选，确认后才进入全员上下文', async () => {
    const { dir, deps, actor } = testDeps()
    try {
      const learningActor = {
        ...actor,
        subject: {
          ...actor.subject,
          scopes: new Set([...actor.subject.scopes, SC.MEMORY_WRITE]),
        },
      }
      const result = (await executeTool(
        deps,
        learningActor as unknown as Parameters<typeof executeTool>[1],
        'memory.propose',
        { content: '以后修改方案文档时只改指定段落，不要整篇重写。' },
      )) as Record<string, unknown>
      expect(result).toMatchObject({ scopeType: 'company', confirmed: false, status: 'pending' })
      const row = deps.db
        .prepare('SELECT scope_type, scope_id, user_id, confirmed, content FROM memories WHERE id = ?')
        .get(String(result.id)) as { scope_type: string; scope_id: string; user_id: string; confirmed: number; content: string }
      expect(row).toMatchObject({
        scope_type: 'company',
        scope_id: 'c1',
        user_id: 'u1',
        confirmed: 0,
      })
      expect(row.content).toContain('不要整篇重写')
      const spec = toolSpecsForActor(deps.db, learningActor as unknown as Parameters<typeof executeTool>[1], {
        kind: 'cloud',
      }).find((item) => item.function.name === 'memory_propose')
      expect(spec).toBeTruthy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
