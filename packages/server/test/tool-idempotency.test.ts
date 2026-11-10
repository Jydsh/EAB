import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, migrate } from '@eab/storage'
import { SC } from '@eab/domain'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import type { RequestActor } from '../src/session.js'
import { executeTool } from '../src/routes/tools.js'
import { saveUserWorkspaceFile } from '../src/routes/workspace.js'
import {
  beginToolOperation,
  completeToolOperation,
  failToolOperation,
  hashToolArgs,
  resolveToolOperationKey,
} from '../src/tool-idempotency.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function testDeps() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-tool-idempotency-'))
  dirs.push(dir)
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.exec('PRAGMA foreign_keys = OFF')
  const config = { dbPath: join(dir, 'eab.db'), dataDir: dir } as ServerConfig
  const deps: ServerDeps = { db, config, companyId: 'c1', migrations: [], consoleToken: '' }
  const actor = {
    subject: {
      companyId: 'c1',
      userId: 'u_idem',
      status: 'active',
      deptId: 'd_idem',
      deptPath: '/d_idem',
      deptChain: [],
      roles: ['member'],
      scopes: new Set([SC.WORKSPACE_WRITE, SC.ORG_MEMBER_MANAGE, SC.AGENT_TOOL_INVOKE]),
    },
    person: {
      id: 'u_idem',
      name: '幂等测试员工',
      title: null,
      deptId: 'd_idem',
      deptPath: '/d_idem',
      deptName: '测试部门',
      companyId: 'c1',
      companyName: '测试公司',
    },
  } as unknown as RequestActor
  return { db, deps, actor }
}

describe('工具幂等键', () => {
  it('参数顺序不影响哈希，显式键优先，无回合 id 时不启用', () => {
    expect(hashToolArgs({ a: 1, b: 2 })).toBe(hashToolArgs({ b: 2, a: 1 }))
    expect(hashToolArgs({ a: 1 })).not.toBe(hashToolArgs({ a: 2 }))

    const withTurn = resolveToolOperationKey({ toolId: 'workspace.delete', args: { path: 'a.txt' }, turnId: 't1' })
    expect(withTurn).toBe(resolveToolOperationKey({ toolId: 'workspace.delete', args: { path: 'a.txt' }, turnId: 't1' }))
    expect(withTurn).not.toBe(resolveToolOperationKey({ toolId: 'workspace.delete', args: { path: 'a.txt' }, turnId: 't2' }))
    expect(resolveToolOperationKey({ toolId: 'workspace.delete', args: {}, idempotencyKey: 'user-key', turnId: 't1' })).toBe('user-key')
    expect(resolveToolOperationKey({ toolId: 'workspace.delete', args: {} })).toBeNull()
  })

  it('成功结果可重放，失败后允许重新执行', () => {
    const { db } = testDeps()
    const start = beginToolOperation({ db, companyId: 'c1', userId: 'u_idem', toolId: 'workspace.delete', key: 'k1', now: 1000 })
    expect(start.kind).toBe('execute')
    if (start.kind !== 'execute') throw new Error('unexpected')

    completeToolOperation(db, start.id, { deleted: true, fileId: 'f1' }, 1000)
    expect(beginToolOperation({ db, companyId: 'c1', userId: 'u_idem', toolId: 'workspace.delete', key: 'k1', now: 1001 })).toEqual({
      kind: 'replay',
      result: { deleted: true, fileId: 'f1' },
    })

    const failed = beginToolOperation({ db, companyId: 'c1', userId: 'u_idem', toolId: 'workspace.delete', key: 'k2', now: 1000 })
    if (failed.kind !== 'execute') throw new Error('unexpected')
    failToolOperation(db, failed.id, new Error('boom'), 1000)
    expect(beginToolOperation({ db, companyId: 'c1', userId: 'u_idem', toolId: 'workspace.delete', key: 'k2', now: 1001 }).kind).toBe('execute')
  })
})

describe('外部副作用工具接入幂等', () => {
  it('workspace.delete 同键重复调用不会因文件已删除而报错，直接返回首次结果', async () => {
    const { db, deps, actor } = testDeps()
    saveUserWorkspaceFile(deps, actor, {
      relPath: '待删除.txt',
      buffer: Buffer.from('hello'),
      mime: 'text/plain',
      channel: 'web',
    })

    const first = await executeTool(deps, actor, 'workspace.delete', { path: '待删除.txt' }, { kind: 'cloud' }, {
      idempotencyKey: 'delete-1',
    })
    const repeats: unknown[] = []
    for (let i = 0; i < 9; i += 1) {
      repeats.push(
        await executeTool(deps, actor, 'workspace.delete', { path: '待删除.txt' }, { kind: 'cloud' }, {
          idempotencyKey: 'delete-1',
        }),
      )
    }

    expect(first).toMatchObject({ deleted: true })
    expect(repeats.every((item) => JSON.stringify(item) === JSON.stringify(first))).toBe(true)
    const rows = db.prepare("SELECT status, result_json FROM tool_operations WHERE tool_id = 'workspace.delete' AND idempotency_key = 'delete-1'").all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'succeeded' })
  })
})
