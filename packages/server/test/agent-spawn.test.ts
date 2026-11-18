import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'

const state = vi.hoisted(() => ({
  rootCalls: 0,
  childCalls: 0,
  activeChildren: 0,
  maxActiveChildren: 0,
}))

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>()
  return {
    ...actual,
    callModelStream: vi.fn(async (
      _db: unknown,
      _path: unknown,
      _company: unknown,
      _model: unknown,
      messages: Array<{ role: string; content: string }>,
      options: { onEvent?: (event: { type: 'content' | 'reasoning'; text: string }) => void },
    ) => {
      // 子 Agent 现在带独立的 system 角色，用角色判断而不是消息条数。
      const isChild = messages.some(
        (message) => message.role === 'system' && message.content.includes('父 Agent 分派的子 Agent'),
      )
      if (isChild) {
        state.childCalls += 1
        state.activeChildren += 1
        state.maxActiveChildren = Math.max(state.maxActiveChildren, state.activeChildren)
        try {
          // 留出重叠窗口，验证两个子 Agent 是同时在跑，而不是排队串行。
          await new Promise((resolve) => setTimeout(resolve, 25))
          const content = messages[messages.length - 1]?.content ?? ''
          if (content.includes('【交付前自检门禁】')) {
            return {
              text: '',
              reasoning: '',
              toolCalls: [
                {
                  id: 'verify-project-exec',
                  type: 'function',
                  function: {
                    name: 'project_exec',
                    arguments: JSON.stringify({
                      description: '运行自检命令',
                      command: 'node -e "console.log(\'test\')"',
                    }),
                  },
                },
              ],
              promptTokens: 1,
              completionTokens: 1,
            }
          }
          if (content.includes('自检验证任务')) {
            options.onEvent?.({ type: 'content', text: '已完成实现，未运行验证' })
            return { text: '已完成实现，未运行验证', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
          }
          if (content.includes('任务B')) throw new Error('子任务 B 模型失败')
          options.onEvent?.({ type: 'content', text: `完成：${content}` })
          return { text: `完成：${content}`, reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
        } finally {
          state.activeChildren -= 1
        }
      }
      const content = messages[messages.length - 1]?.content ?? ''
      if (content.includes('失败修复闭环')) {
        state.rootCalls += 1
        return {
          text: '',
          reasoning: '',
          toolCalls: [
            {
              id: 'spawn-repair-loop',
              type: 'function',
              function: {
                name: 'agent_spawn',
                arguments: JSON.stringify({
                  tasks: [
                    { key: 'test-1', role: 'builder', title: '子鼠（测试执行）', prompt: '运行 node --test 确认失败' },
                    { key: 'debug-1', role: 'builder', title: '丑牛（错误定位）', prompt: '定位 calc.mjs 里的实现错误' },
                    { key: 'fix-1', role: 'builder', title: '寅虎（代码修正）', prompt: '修正 calc.mjs 后重新运行测试' },
                    { key: 'test-2', role: 'critic', title: '卯兔·丁（复测验证）', prompt: '复测修正后的结果直到通过' },
                  ],
                }),
              },
            },
          ],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      if (content.includes('依赖切片测试')) {
        state.rootCalls += 1
        return {
          text: '',
          reasoning: '',
          toolCalls: [
            {
              id: 'spawn-dependent',
              type: 'function',
              function: {
                name: 'agent_spawn',
                arguments: JSON.stringify({
                  tasks: [
                    { key: 'build-1', role: 'builder', title: '子鼠（项目创建）', prompt: '创建 calc.mjs 文件并实现 add 函数' },
                    { key: 'build-2', role: 'builder', title: '丑牛（测试执行）', prompt: '运行 node --test 测试 calc.test.mjs' },
                  ],
                }),
              },
            },
          ],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      if (content.includes('自检闭环')) {
        state.rootCalls += 1
        return {
          text: '',
          reasoning: '',
          toolCalls: [
            {
              id: 'spawn-self-check',
              type: 'function',
              function: {
                name: 'agent_spawn',
                arguments: JSON.stringify({
                  tasks: [
                    { key: 'build-1', role: 'builder', title: '子鼠（接口实现）', prompt: '自检验证任务：实现一个接口并实际跑测试。' },
                  ],
                }),
              },
            },
          ],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      if (content.includes('超并发')) {
        state.rootCalls += 1
        return {
          text: '',
          reasoning: '',
          toolCalls: [
            {
              id: 'spawn-over-limit',
              type: 'function',
              function: {
                name: 'agent_spawn',
                arguments: JSON.stringify({
                  tasks: [
                    { title: '任务 1', prompt: '任务1：查资料' },
                    { title: '任务 2', prompt: '任务2：查资料' },
                    { title: '任务 3', prompt: '任务3：查资料' },
                    { title: '任务 4', prompt: '任务4：查资料' },
                    { title: '任务 5', prompt: '任务5：查资料' },
                  ],
                }),
              },
            },
          ],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      if (content.includes('别名角色')) {
        state.rootCalls += 1
        return {
          text: '',
          reasoning: '',
          toolCalls: [
            {
              id: 'spawn-alias-role',
              type: 'function',
              function: {
                name: 'agent_spawn',
                arguments: JSON.stringify({
                  // 真实模型既可能把 tasks 再 stringify 一层，也可能把裸换行直接塞进
                  // JSON 字符串里；这里两种形态一起覆盖。
                  tasks: '[{"key":"research-1","role":"analyzer","title":"阿研（资料分析）","prompt":"分析这批资料\n的关键结论"},{"key":"write-1","role":"summarizer","prompt":"汇总材料并给出结论"}]',
                }),
              },
            },
          ],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      if (content.includes('并行分析')) {
        state.rootCalls += 1
        return {
          text: '',
          reasoning: '',
          toolCalls: [
            {
              id: 'spawn-1',
              type: 'function',
              function: {
                name: 'agent_spawn',
                arguments: JSON.stringify({
                  tasks: [
                    { title: '任务 A', prompt: '任务A：查资料' },
                    { title: '任务 B', prompt: '任务B：写总结' },
                  ],
                }),
              },
            },
          ],
          promptTokens: 1,
          completionTokens: 1,
        }
      }
      state.rootCalls += 1
      options.onEvent?.({ type: 'content', text: '全部完成' })
      return { text: '全部完成', reasoning: '', toolCalls: [], promptTokens: 1, completionTokens: 1 }
    }),
  }
})

import { listAgentRuns } from '../src/agent-runtime.js'
import { runAgentTurn } from '../src/routes/chat.js'

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
  const deps = {
    db,
    config: { dbPath: ':memory:', agentMaxParallel: 4, agentMaxDepth: 2, agentMaxRetries: 1 },
    companyId: 'c1',
  } as any
  return { deps, actor }
}

describe('多 Agent 并行调度', () => {
  it('父子 run 独立记录；一个子 Agent 失败不影响另一个和父任务', async () => {
    state.rootCalls = 0
    state.childCalls = 0
    state.activeChildren = 0
    state.maxActiveChildren = 0
    const { deps, actor } = testEnv()
    const events: any[] = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '请并行分析两个方向' }],
      maxTokens: 16,
      emit: (event) => events.push(event),
    })

    expect(result?.text).toBe('全部完成')
    expect(result?.toolCalls[0]?.toolId).toBe('agent.spawn')
    expect(state.childCalls).toBe(3) // 任务 A 一次，任务 B 失败后按 retries=1 再试一次
    expect(state.maxActiveChildren).toBeGreaterThanOrEqual(2) // 初始批次确实同时启动

    const agentEvents = events.filter((event) => event.type === 'agent')
    expect(agentEvents.filter((event) => event.action === 'assign')).toHaveLength(2)
    expect(agentEvents.filter((event) => event.action === 'spawn')).toHaveLength(3)
    expect(agentEvents.filter((event) => event.action === 'done')).toHaveLength(2)
    expect(agentEvents.filter((event) => event.action === 'done').map((event) => event.status))
      .toEqual(expect.arrayContaining(['unregistered', 'failed']))
    expect(agentEvents.filter((event) => event.action === 'content').length).toBeGreaterThan(0)
    expect(agentEvents.filter((event) => event.action === 'report').length).toBe(1)

    const runs = listAgentRuns(deps.db, 'c1')
    expect(runs).toHaveLength(4) // 根任务 + 任务 A + 任务 B 两次尝试
    const root = runs.find((run) => run.parentRunId === null)
    const a = runs.find((run) => (run.title ?? '').includes('子鼠'))
    const bRuns = runs.filter((run) => (run.title ?? '').includes('丑牛'))
    expect(root?.status).toBe('succeeded')
    expect(root?.id).toBe(result?.runId)
    expect(a?.parentRunId).toBe(root?.id)
    expect(a?.status).toBe('succeeded')
    expect(a?.sessionId).toBe(`agent:${a?.id}`)
    expect(bRuns).toHaveLength(2)
    expect(bRuns.every((run) => run.status === 'failed')).toBe(true)
    expect(bRuns.every((run) => run.parentRunId === root?.id)).toBe(true)
    expect(a?.id).not.toBe(bRuns[0]?.id)
  })

  it('常见角色别名自动归一，子 Agent 名字按生肖/天干顺序分配且不重名', async () => {
    state.rootCalls = 0
    state.childCalls = 0
    state.activeChildren = 0
    state.maxActiveChildren = 0
    const { deps, actor } = testEnv()
    const events: any[] = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '请按别名角色派发' }],
      maxTokens: 16,
      emit: (event) => events.push(event),
    })

    expect(result?.toolCalls[0]?.status).toBe('done')
    const assigns = events.filter((event) => event.type === 'agent' && event.action === 'assign')
    expect(assigns).toHaveLength(2)
    expect(assigns.map((event) => event.role)).toEqual(['researcher', 'producer'])
    expect(assigns[0]?.title).toBe('子鼠（资料分析）')
    expect(assigns[1]?.title).toMatch(/^丑牛（/)
    expect(assigns[1]?.title).not.toMatch(/^子任务/)
    expect(assigns[0]?.title).not.toBe(assigns[1]?.title)
  })

  it('超过 agentMaxParallel 时显式报错，不静默丢弃也不注册残缺团队', async () => {
    state.rootCalls = 0
    state.childCalls = 0
    state.activeChildren = 0
    state.maxActiveChildren = 0
    const { deps, actor } = testEnv()
    const events: any[] = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '请超并发派发五个子任务' }],
      maxTokens: 16,
      emit: (event) => events.push(event),
    })

    expect(result?.text).toBe('全部完成')
    expect(result?.toolCalls[0]?.toolId).toBe('agent.spawn')
    expect(result?.toolCalls[0]?.status).toBe('error')
    expect(result?.toolCalls[0]?.summary).toContain('一次最多并行 4 个子任务')
    expect(state.childCalls).toBe(0)
    expect(events.filter((event) => event.type === 'agent' && event.action === 'assign')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'agent' && event.action === 'spawn')).toHaveLength(0)
    const toolResult = events.find((event) => event.type === 'tool_result')
    expect(toolResult?.status).toBe('error')
  })

  it('工程子任务没有测试通过证据时被自检门禁拦回，补跑测试通过后才交付', async () => {
    state.rootCalls = 0
    state.childCalls = 0
    state.activeChildren = 0
    state.maxActiveChildren = 0
    const previousMode = process.env.EAB_PROJECT_EXEC
    process.env.EAB_PROJECT_EXEC = '1'
    let workspace: string | undefined
    try {
      const { deps, actor } = testEnv()
      // project.exec 需要真实存在的工作区；用临时目录避免污染仓库，
      // 也让“补跑测试 exitCode=0”成为可核验证据。
      workspace = mkdtempSync(join(tmpdir(), 'eab-spawn-'))
      mkdirSync(join(workspace, 'c1', 'user-u1'), { recursive: true })
      deps.config.workspacesDir = workspace
      const events: any[] = []
      const result = await runAgentTurn({
        deps,
        actor,
        modelId: 'model_test',
        messages: [{ role: 'user', content: '请自检闭环完成一个接口实现' }],
        maxTokens: 16,
        emit: (event) => events.push(event),
      })

      expect(result?.text).toBe('全部完成')
      // 子 Agent 第一次说“已完成实现”但没有验证，门禁必须让它继续跑测试。
      const childContents = events
        .filter((event) => event.type === 'agent' && event.action === 'content')
        .map((event) => String(event.text ?? ''))
      expect(childContents.some((text) => text.includes('已完成实现，未运行验证'))).toBe(true)
      const childTool = events.find(
        (event) => event.type === 'agent'
          && event.action === 'tool'
          && event.tool?.toolId === 'project.exec',
      )
      expect(childTool).toBeTruthy()

      const runs = listAgentRuns(deps.db, 'c1')
      const child = runs.find((run) => run.parentRunId !== null)
      expect(child?.status).toBe('succeeded')
      expect(child?.title).toContain('子鼠')
    } finally {
      if (previousMode === undefined) delete process.env.EAB_PROJECT_EXEC
      else process.env.EAB_PROJECT_EXEC = previousMode
      if (workspace) rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('“创建文件 + 运行测试”的依赖切片会被合并成一个工程闭环，不再先跑空测试', async () => {
    state.rootCalls = 0
    state.childCalls = 0
    state.activeChildren = 0
    state.maxActiveChildren = 0
    const { deps, actor } = testEnv()
    const events: any[] = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '依赖切片测试：创建文件后跑测试' }],
      maxTokens: 16,
      emit: (event) => events.push(event),
    })

    expect(result?.text).toBe('全部完成')
    const assigns = events.filter((event) => event.type === 'agent' && event.action === 'assign')
    expect(assigns).toHaveLength(1)
    expect(assigns[0]?.title).toContain('子鼠')
    expect(state.childCalls).toBe(1)

    const runs = listAgentRuns(deps.db, 'c1')
    expect(runs.filter((run) => run.parentRunId !== null)).toHaveLength(1)
  })

  it('“测试→定位→修正→复测”串行闭环会合并成一个工程任务，避免四个岗位互相等待', async () => {
    state.rootCalls = 0
    state.childCalls = 0
    state.activeChildren = 0
    state.maxActiveChildren = 0
    const { deps, actor } = testEnv()
    const events: any[] = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '失败修复闭环：测试失败后修到通过' }],
      maxTokens: 16,
      emit: (event) => events.push(event),
    })

    expect(result?.text).toBe('全部完成')
    const assigns = events.filter((event) => event.type === 'agent' && event.action === 'assign')
    expect(assigns).toHaveLength(1)
    expect(assigns[0]?.title).toContain('子鼠')
    expect(state.childCalls).toBe(1)

    const runs = listAgentRuns(deps.db, 'c1')
    expect(runs.filter((run) => run.parentRunId !== null)).toHaveLength(1)
  })
})
