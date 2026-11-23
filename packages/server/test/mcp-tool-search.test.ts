import { describe, expect, it } from 'vitest'
import { openDatabase, migrate } from '@eab/storage'
import { SC } from '@eab/domain'
import { searchToolCatalog, toolSpecsForActor, toolSpecsForAgent } from '../src/routes/tools.js'
import { mcpToolFunctionName } from '../src/mcp-registry.js'

function env(includeScope = true) {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  const now = Date.now()
  db.prepare(`INSERT INTO mcp_servers
    (id, company_id, name, transport, endpoint, auth_type, secret_ref, allowed_tools_json, enabled, health, last_sync_at, last_error, failure_count, cooldown_until, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('mcp1', 'c1', 'Docs Hub', 'http', 'http://127.0.0.1:1/mcp', 'none', '', '[]', 1, 'healthy', now, '', 0, null, 'u1', now, now)
  db.prepare(`INSERT INTO mcp_tools
    (id, server_id, company_id, name, description, input_schema_json, annotations_json, enabled, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      'tool1', 'mcp1', 'c1', 'docs.search', 'Search company docs',
      JSON.stringify({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }),
      JSON.stringify({ readOnlyHint: true }), 1, now,
    )
  const actor = {
    subject: {
      companyId: 'c1',
      userId: 'u1',
      status: 'active',
      deptId: 'd1',
      deptPath: '/d1',
      deptChain: [],
      roles: [],
      scopes: new Set(includeScope ? Object.values(SC) : Object.values(SC).filter((scope) => scope !== SC.AGENT_TOOL_INVOKE)),
    },
    person: { id: 'u1', name: '测试员工', companyId: 'c1', companyName: '测试公司' },
  } as any
  return { db, actor }
}

describe('MCP 工具进入工具目录', () => {
  const functionName = mcpToolFunctionName('Docs Hub', 'docs.search', 'mcp1')

  it('tool_search 能命中 MCP 只读工具，并返回服务器来源', () => {
    const { db, actor } = env()
    const result = searchToolCatalog(db, actor, { kind: 'cloud' }, 'search company docs')
    const hit = result.tools.find((tool) => tool.functionName === functionName)
    expect(hit).toMatchObject({ source: 'mcp', serverName: 'Docs Hub', toolId: 'mcp:mcp1:docs.search' })
    expect(hit?.parameters).toEqual([{ name: 'query', type: 'string', description: '', required: true }])
  })

  it('MCP 工具出现在完整目录和 tool_search 目录，但首轮不直接下发', () => {
    const { db, actor } = env()
    const all = toolSpecsForActor(db, actor, { kind: 'cloud' })
    const firstRound = toolSpecsForAgent(db, actor, { kind: 'cloud' }, '帮我查一下公司文档')
    expect(all.some((tool) => tool.function.name === functionName)).toBe(true)
    expect(firstRound.some((tool) => tool.function.name === functionName)).toBe(false)
  })

  it('没有工具调用 scope 时 MCP 工具不可见', () => {
    const { db, actor } = env(false)
    expect(toolSpecsForActor(db, actor, { kind: 'cloud' }).some((tool) => tool.function.name.startsWith('mcp_'))).toBe(false)
    expect(searchToolCatalog(db, actor, { kind: 'cloud' }, 'docs search').tools.some((tool) => tool.source === 'mcp')).toBe(false)
  })
})
