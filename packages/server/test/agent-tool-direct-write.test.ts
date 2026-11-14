import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openDatabase, migrate } from '@eab/storage'
import { SC } from '@eab/domain'

const state = vi.hoisted(() => ({
  calls: 0,
  toolLists: [] as string[][],
}))

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>()
  return {
    ...actual,
    callModelStream: vi.fn(async (_db: unknown, _path: unknown, _company: unknown, _model: unknown, _messages: unknown, options: { tools?: Array<{ function: { name: string } }>; onEvent?: (event: { type: 'content' | 'reasoning'; text: string }) => void }) => {
      state.toolLists.push((options.tools ?? []).map((tool) => tool.function.name))
      state.calls += 1
      if (state.calls === 1) {
        return {
          text: '',
          reasoning: '',
          toolCalls: [
            {
              id: 'write-1',
              type: 'function',
              function: {
                name: 'workspace_write',
                arguments: JSON.stringify({ path: 'auto-write.txt', content: '同轮直接写入' }),
              },
            },
          ],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      options.onEvent?.({ type: 'content', text: '写入完成' })
      return { text: '写入完成', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
    }),
  }
})

import { runAgentTurn } from '../src/routes/chat.js'

function testEnv(root: string) {
  const db = openDatabase({ path: join(root, 'eab.sqlite') })
  migrate(db)
  db.prepare(
    "INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c1', '测试公司', 'test', 'active', 1)",
  ).run()
  db.prepare(
    "INSERT INTO departments (id, company_id, name, path, depth, order_no, created_at) VALUES ('d1', 'c1', '测试部门', '/d1', 0, 0, 1)",
  ).run()
  db.prepare(
    "INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES ('u1', 'c1', 'd1', '/d1', '测试员工', 'active', 1, 1)",
  ).run()
  const actor = {
    subject: {
      companyId: 'c1',
      userId: 'u1',
      status: 'active',
      deptId: 'd1',
      deptPath: '/d1',
      deptChain: [],
      roles: [],
      scopes: new Set(Object.values(SC)),
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
  } as any
  const deps = {
    db,
    config: { dbPath: join(root, 'eab.sqlite'), workspacesDir: join(root, 'workspaces') },
    companyId: 'c1',
  } as any
  return { deps, actor }
}

describe('Agent 工具同轮直接调用', () => {
  it('未搜索时直接调用 workspace_write，也能自动激活并使用 content 别名写入', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eab-agent-write-'))
    let deps: ReturnType<typeof testEnv>['deps'] | undefined
    try {
      const env = testEnv(root)
      deps = env.deps
      const result = await runAgentTurn({
        deps,
        actor: env.actor,
        modelId: 'model_test',
        messages: [{ role: 'user', content: '新建一个文件' }],
        maxTokens: 64,
        emit: () => {},
      })

      expect(result?.toolCalls.map((tool) => tool.toolId)).toEqual(['workspace.write'])
      expect(result?.toolCalls[0]?.status, result?.toolCalls[0]?.summary).toBe('done')
      expect(result?.text).toBe('写入完成')
      const saved = readFileSync(join(root, 'workspaces', 'c1', 'user-u1', 'auto-write.txt'), 'utf8')
      expect(saved).toBe('同轮直接写入')
    } finally {
      deps?.db.close()
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // Windows 上 SQLite 句柄释放有延迟；临时目录不影响测试结论。
      }
    }
  })
})
