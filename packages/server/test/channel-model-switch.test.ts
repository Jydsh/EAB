import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { executeModelSwitchTool, updateConversationModelPreference, SWITCH_CHAT_MODEL_TOOL_SPEC } from '../src/channel-model-switch.js'
import { buildSystemPrompt } from '../src/routes/chat.js'
import type { ChannelModelOption } from '../src/channel-model-command.js'

const models: ChannelModelOption[] = [
  { id: 'deepseek-v4-flash', name: 'Deepseek V4 Flash' },
  { id: 'deepseek-v4-pro', name: 'Deepseek V4 Pro' },
  { id: 'plugin:our-free-model:mimo-v2.6-pro-free', name: 'MiMo V2.6 Pro' },
]

function context(overrides: Partial<Parameters<typeof executeModelSwitchTool>[0]> = {}) {
  const changes: Array<string | null> = []
  return {
    changes,
    value: {
      models,
      currentModelId: 'deepseek-v4-flash' as string | null,
      activeModelId: 'deepseek-v4-flash' as string | null,
      onChange: (modelId: string | null) => {
        changes.push(modelId)
      },
      ...overrides,
    },
  }
}

function testDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  const now = Date.now()
  db.prepare("INSERT INTO companies (id, name, slug, status, created_at) VALUES ('c1', '测试公司', 'c1', 'active', ?)").run(now)
  db.prepare(
    "INSERT INTO departments (id, company_id, name, path, created_at) VALUES ('d1', 'c1', '测试部门', 'd1', ?)",
  ).run(now)
  db.prepare(
    "INSERT INTO users (id, company_id, dept_id, dept_path, name, status, created_at, updated_at) VALUES ('u1', 'c1', 'd1', 'd1', '测试用户', 'active', ?, ?)",
  ).run(now, now)
  db.prepare(
    "INSERT INTO chat_sessions (id, company_id, user_id, title, model_id, created_at, updated_at) VALUES ('s1', 'c1', 'u1', '测试会话', 'deepseek-v4-flash', ?, ?)",
  ).run(now, now)
  return db
}

describe('渠道会话模型切换工具', () => {
  it('list 只返回当前模型和候选，不写库', async () => {
    const { changes, value } = context()
    const result = await executeModelSwitchTool(value, { mode: 'list' })
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(false)
    expect(changes).toEqual([])
    expect(result.message).toContain('当前模型：Deepseek V4 Flash')
    expect(result.message).toContain('MiMo V2.6 Pro')
  })

  it('switch 唯一命中后只写入目标模型，并说明下一条消息生效', async () => {
    const { changes, value } = context()
    const result = await executeModelSwitchTool(value, { mode: 'switch', target: 'MiMo V2.6 Pro' })
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.modelId).toBe('plugin:our-free-model:mimo-v2.6-pro-free')
    expect(changes).toEqual(['plugin:our-free-model:mimo-v2.6-pro-free'])
    expect(result.message).toContain('下一条消息开始使用新模型')
  })

  it('没有权限或不存在时不写入，也不泄漏候选以外的模型', async () => {
    const { changes, value } = context()
    const result = await executeModelSwitchTool(value, { mode: 'switch', target: 'qwen-max' })
    expect(result.ok).toBe(false)
    expect(result.changed).toBe(false)
    expect(changes).toEqual([])
    expect(result.message).toContain('没有找到你有权限使用的模型')
  })

  it('auto 恢复自动选择；已经在自动时不重复写库', async () => {
    const fixed = context()
    const switched = await executeModelSwitchTool(fixed.value, { mode: 'auto' })
    expect(switched.changed).toBe(true)
    expect(fixed.changes).toEqual([null])

    const auto = context({ currentModelId: null })
    const already = await executeModelSwitchTool(auto.value, { mode: 'auto' })
    expect(already.changed).toBe(false)
    expect(auto.changes).toEqual([])
    expect(already.message).toContain('已经是自动选择')
  })

  it('切换到当前已选模型时不重复写库', async () => {
    const { changes, value } = context()
    const result = await executeModelSwitchTool(value, { mode: 'switch', target: 'Deepseek V4 Flash' })
    expect(result.changed).toBe(false)
    expect(changes).toEqual([])
    expect(result.message).toContain('已经在使用')
  })

  it('持久写只更新当前公司、当前用户的当前会话', () => {
    const db = testDb()
    updateConversationModelPreference(db, {
      companyId: 'c1',
      userId: 'u1',
      sessionId: 's1',
      modelId: 'plugin:our-free-model:mimo-v2.6-pro-free',
    })
    expect(
      (db.prepare("SELECT model_id FROM chat_sessions WHERE id = 's1'").get() as { model_id: string }).model_id,
    ).toBe('plugin:our-free-model:mimo-v2.6-pro-free')

    expect(() =>
      updateConversationModelPreference(db, {
        companyId: 'c1',
        userId: 'u2',
        sessionId: 's1',
        modelId: null,
      }),
    ).toThrow(/当前会话不存在或已失效/)
  })

  it('只有渠道工具在提示里时，系统提示才要求调用 switch_chat_model', () => {
    const actor = {
      subject: { companyId: 'c1', userId: 'u1' },
      person: {
        id: 'u1',
        name: '测试员工',
        deptName: '测试部门',
        companyName: '测试公司',
      },
    } as any
    const base = {
      actor,
      memories: [],
      hits: [],
      hasAttachments: false,
      availableModels: models,
      currentModelId: 'deepseek-v4-flash',
    }
    const withSwitch = buildSystemPrompt({
      ...base,
      chatTools: [SWITCH_CHAT_MODEL_TOOL_SPEC],
    })
    expect(withSwitch).toContain('【当前会话模型操作】')
    expect(withSwitch).toContain('必须调用 switch_chat_model')

    const withoutSwitch = buildSystemPrompt({ ...base, chatTools: [] })
    expect(withoutSwitch).not.toContain('【当前会话模型操作】')
  })
})
