import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, migrate, type Db } from '@eab/storage'
import {
  agentCardBrief,
  builtinAgentCards,
  listAgentCards,
  runtimeAgentCard,
} from '../src/agent-capability-registry.js'

const handles: Db[] = []

afterEach(() => {
  for (const db of handles.splice(0)) db.close()
})

function makeDb(): Db {
  const db = openDatabase({ path: ':memory:' })
  handles.push(db)
  migrate(db)
  const now = Date.now()
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('c1', '测试公司', 'capability-registry', 'active', now)
  return db
}

describe('Agent 能力卡注册表', () => {
  it('内置五张岗位卡按固定顺序返回，并包含技能与工具', () => {
    const cards = builtinAgentCards()
    expect(cards.map((card) => card.agentKey)).toEqual([
      'researcher',
      'builder',
      'critic',
      'producer',
      'worker',
    ])
    expect(cards.every((card) => card.kind === 'builtin' && card.enabled)).toBe(true)
    expect(cards[1]).toMatchObject({
      name: '实现员',
      limits: { maxRounds: 120, timeoutMs: 1_800_000 },
    })
    expect(cards[1].skills).toContain('代码实现')
    expect(cards[1].tools).toContain('project.exec')
  })

  it('编队摘要只给岗位、技能和工具 id，并跳过停用或离线岗位', () => {
    const brief = agentCardBrief()
    expect(brief).toContain('【可用岗位能力卡')
    expect(brief).toContain('researcher（检索员）')
    expect(brief).toContain('builder（实现员）')
    expect(brief).not.toContain('系统提示词')

    const filtered = agentCardBrief(builtinAgentCards().map((card) => (
      card.agentKey === 'builder' ? { ...card, health: 'offline' as const } : card
    )))
    expect(filtered).not.toContain('builder（实现员）')

    const disabled = agentCardBrief(builtinAgentCards().map((card) => (
      card.agentKey === 'critic' ? { ...card, enabled: false } : card
    )))
    expect(disabled).not.toContain('critic（验收员）')
    expect(agentCardBrief([])).toContain('没有可用的内部岗位')
  })

  it('公司行覆盖同名内置岗位，A2A 行作为额外卡追加', () => {
    const db = makeDb()
    const now = Date.now()
    db.prepare(`INSERT INTO agent_cards
      (id, company_id, agent_key, kind, name, version, description, skills_json, tools_json, limits_json, endpoint_json, health, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        'card-build', 'c1', 'builder', 'builtin', '架构实现员', '2', '公司覆盖后的实现岗',
        '["接口实现","架构改造"]', '["project.exec","workspace.edit"]', '{"maxRounds":30}',
        '{"kind":"internal","team":"arch"}', 'degraded', 1, now, now,
      )
    db.prepare(`INSERT INTO agent_cards
      (id, company_id, agent_key, kind, name, version, description, skills_json, tools_json, limits_json, endpoint_json, health, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        'card-a2a', 'c1', 'travel-planner', 'a2a', '旅行规划 Agent', '1', '外部 A2A 卡',
        '["行程规划"]', '[]', '{}', '{"kind":"a2a","url":"https://agent.example/card"}', 'healthy', 1, now, now,
      )
    // 坏 JSON 不能让整张表读失败。
    db.prepare(`INSERT INTO agent_cards
      (id, company_id, agent_key, kind, name, version, description, skills_json, tools_json, limits_json, endpoint_json, health, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('card-bad', 'c1', 'bad-json', 'a2a', '坏卡', '1', '', '{bad', '{bad', '{bad', '{bad', 'healthy', 1, now, now)

    const cards = listAgentCards(db, 'c1')
    expect(cards.map((card) => card.agentKey).slice(0, 5)).toEqual([
      'researcher', 'builder', 'critic', 'producer', 'worker',
    ])
    const builder = cards.find((card) => card.agentKey === 'builder')
    expect(builder).toMatchObject({
      id: 'card-build',
      name: '架构实现员',
      version: '2',
      description: '公司覆盖后的实现岗',
      health: 'degraded',
      source: 'company',
      overridden: true,
      limits: { maxRounds: 30 },
    })
    expect(builder?.skills).toEqual(['接口实现', '架构改造'])
    expect(builder?.endpoint).toMatchObject({ team: 'arch' })
    expect(agentCardBrief(cards)).toContain('builder（架构实现员）')
    expect(agentCardBrief(cards)).not.toContain('旅行规划 Agent')

    const remote = cards.find((card) => card.agentKey === 'travel-planner')
    expect(remote).toMatchObject({ kind: 'a2a', source: 'company' })
    expect(remote?.endpoint).toMatchObject({ kind: 'a2a', url: 'https://agent.example/card' })

    const bad = cards.find((card) => card.agentKey === 'bad-json')
    expect(bad).toMatchObject({ skills: [], tools: [], limits: {}, endpoint: { kind: 'internal' } })
  })

  it('运行时卡表达岗位、团队归属和退役状态', () => {
    expect(runtimeAgentCard({
      teamId: 'session:s1',
      workerKey: 'session:k:build',
      name: '丑牛',
      role: 'builder',
      status: 'running',
      maxRounds: 24,
      timeoutMs: 600_000,
    })).toMatchObject({
      id: 'runtime:session:s1:session:k:build',
      kind: 'runtime',
      agentKey: 'builder',
      name: '丑牛',
      skills: ['builder'],
      limits: { maxRounds: 24, timeoutMs: 600_000 },
      endpoint: { kind: 'internal', teamId: 'session:s1', workerKey: 'session:k:build' },
      health: 'healthy',
      enabled: true,
    })
    const retired = runtimeAgentCard({
      teamId: 'session:s1',
      workerKey: 'session:k:build',
      role: 'builder',
      status: 'retired',
    })
    expect(retired).toMatchObject({ health: 'offline', enabled: false })
  })
})
