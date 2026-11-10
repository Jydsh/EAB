import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, migrate } from '@eab/storage'
import { SC } from '@eab/domain'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import type { RequestActor } from '../src/session.js'
import { executeTool, toolResourceLocks } from '../src/routes/tools.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function testDeps() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-tool-lock-'))
  dirs.push(dir)
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  // 单测不搭完整公司/成员主数据，只验证锁的串行行为
  db.exec('PRAGMA foreign_keys = OFF')
  const config = { dbPath: join(dir, 'eab.db'), dataDir: dir } as ServerConfig
  const deps: ServerDeps = { db, config, companyId: 'c1', migrations: [], consoleToken: '' }
  const actor = {
    subject: {
      companyId: 'c1',
      userId: 'u_lock',
      status: 'active',
      deptId: 'd_lock',
      deptPath: '/d_lock',
      deptChain: [],
      roles: ['member'],
      scopes: new Set([SC.WORKSPACE_WRITE, SC.AGENT_TOOL_INVOKE]),
    },
    person: {
      id: 'u_lock',
      name: '锁测试员工',
      title: null,
      deptId: 'd_lock',
      deptPath: '/d_lock',
      deptName: '测试部门',
      companyId: 'c1',
      companyName: '测试公司',
    },
  } as unknown as RequestActor
  return { deps, actor }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('工具资源锁接入', () => {
  it('workspace.write 会等待同一路径的资源锁', async () => {
    const { deps, actor } = testDeps()
    const key = 'workspace:file:c1:u_lock:notes/todo.md'
    const release = await toolResourceLocks.acquire(key)

    const call = executeTool(deps, actor, 'workspace.write', {
      path: 'notes/todo.md',
      text: 'hello',
    })
    let settled = false
    void call.then(() => {
      settled = true
    })

    await sleep(40)
    expect(settled).toBe(false)
    expect(toolResourceLocks.isHeld(key)).toBe(true)

    release()
    await call
    expect(toolResourceLocks.isHeld(key)).toBe(false)
  })
})
