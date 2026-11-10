import { describe, expect, it } from 'vitest'
import { openDatabase, migrate } from '@eab/storage'
import { SC } from '@eab/domain'
import { executeTool, searchToolCatalog, toolSpecsForActor, toolSpecsForAgent } from '../src/routes/tools.js'

function testEnv() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
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
  const deps = { db, config: { dbPath: ':memory:' }, companyId: 'c1' } as any
  return { deps, actor }
}

describe('Agent 工具按需加载', () => {
  it('首轮只带核心工具和 tool_search，完整工具目录仍可按权限加载', () => {
    const { deps, actor } = testEnv()
    const core = toolSpecsForAgent(deps.db, actor, { kind: 'cloud' })
    const all = toolSpecsForActor(deps.db, actor, { kind: 'cloud' })

    expect(core.some((tool) => tool.function.name === 'tool_search')).toBe(true)
    expect(core.some((tool) => tool.function.name === 'workspace_list')).toBe(true)
    expect(core.some((tool) => tool.function.name === 'workspace_send_dingtalk')).toBe(false)
    expect(all.some((tool) => tool.function.name === 'workspace_send_dingtalk')).toBe(true)
  })

  it('按中文场景搜索能命中文件发送、定时任务和计算工具', async () => {
    const { deps, actor } = testEnv()
    const send = (await executeTool(deps, actor, 'tool.search', { query: '把文件发到钉钉' })) as {
      tools: Array<{ functionName: string }>
    }
    const schedule = (await executeTool(deps, actor, 'tool.search', { query: '查看我的定时任务' })) as {
      tools: Array<{ functionName: string }>
    }
    const math = (await executeTool(deps, actor, 'tool.search', { query: '计算' })) as {
      tools: Array<{ functionName: string }>
    }

    expect(send.tools.some((tool) => tool.functionName === 'workspace_send_dingtalk')).toBe(true)
    expect(schedule.tools.some((tool) => tool.functionName === 'schedule_list')).toBe(true)
    expect(math.tools.some((tool) => tool.functionName === 'math_eval')).toBe(true)
  })

  it('搜索结果只返回当前员工和当前空间可用的工具', () => {
    const { deps, actor } = testEnv()
    const localSearch = searchToolCatalog(deps.db, actor, { kind: 'local', spaceId: 'lsp_test' }, '发送文件到钉钉')
    expect(localSearch.tools.some((tool) => tool.functionName === 'workspace_send_dingtalk')).toBe(false)
    const noScopeActor = { ...actor, subject: { ...actor.subject, scopes: new Set([SC.CHAT_USE]) } }
    const noScope = searchToolCatalog(deps.db, noScopeActor as any, { kind: 'cloud' }, '发送文件到钉钉')
    expect(noScope.tools.length).toBe(0)
  })
})
