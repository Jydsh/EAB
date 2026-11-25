import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase, type Db } from '@eab/storage'
import {
  getAgentRunDetail,
  listAgentRuns,
  recordAgentRunFormation,
  recordAgentRunSpawnedAgents,
  startAgentRun,
} from '../src/agent-runtime.js'
import type { TeamFormationDecision } from '../src/agent-team-formation.js'

const dbs: Db[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

const decision: TeamFormationDecision = {
  force: true,
  reason: 'complex_multi_slice',
  detail: '可拆成 2–4 个互不依赖、可独立验收的切片：前后端并行交付。',
  signals: ['前后端并行交付'],
  minAgents: 2,
  maxAgents: 4,
}

function env() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  dbs.push(db)
  return db
}

describe('编队理由持久化', () => {
  it('判定与拦截条件写入根 run，派发成功后补记实际人数', () => {
    const db = env()
    const run = startAgentRun(db, {
      id: 'run-root',
      companyId: 'c1',
      userId: 'u1',
      sessionId: 's1',
      agentId: 'eab-main',
    })
    recordAgentRunFormation(db, 'run-root', decision, false, ['active_sub_agent_task'])
    recordAgentRunSpawnedAgents(db, 'run-root', 3)

    const detail = getAgentRunDetail(db, 'c1', 'run-root')
    expect(detail?.runs[0]?.formation).toMatchObject({
      force: true,
      applied: false,
      reason: 'complex_multi_slice',
      signals: ['前后端并行交付'],
      blockedBy: ['active_sub_agent_task'],
      spawnedAgents: 3,
    })
    expect(detail?.runs[0]?.formation?.detail).toContain('2–4 个')

    const runs = listAgentRuns(db, 'c1', { sessionId: 's1' })
    expect(runs.find((item) => item.id === 'run-root')?.formation?.spawnedAgents).toBe(3)

    run.finish('succeeded')
  })

  it('历史 run 没有 formation_json 时返回 null，不回填假理由', () => {
    const db = env()
    const run = startAgentRun(db, {
      id: 'run-legacy',
      companyId: 'c1',
      userId: 'u1',
      sessionId: 's1',
      agentId: 'eab-main',
    })
    const detail = getAgentRunDetail(db, 'c1', 'run-legacy')
    expect(detail?.runs[0]?.formation).toBeNull()
    run.finish('succeeded')
  })
})
