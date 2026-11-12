import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'
import { companyScope, pluginInstanceKey, userScope, type PluginScope } from '../src/plugin-scope.js'
import {
  clearPluginContributions,
  pluginToolCatalogFor,
  pluginToolSpecsFor,
  registerPluginTool,
  resolvePluginToolForActor,
} from '../src/plugin-tools.js'
import { toolSpecsForActor, toolSpecsForAgent } from '../src/routes/tools.js'

const dbs: Array<{ close: () => void }> = []
const registeredKeys: string[] = []

afterEach(() => {
  for (const key of registeredKeys.splice(0)) clearPluginContributions(key)
  for (const db of dbs.splice(0)) db.close()
})

function memoryDb() {
  const db = openDatabase({ path: ':memory:' })
  dbs.push(db)
  db.exec(`
    CREATE TABLE plugin_company_installs (
      company_id TEXT, plugin_id TEXT, installed_by TEXT, installed_at INTEGER, updated_at INTEGER, removed_at INTEGER
    );
    CREATE TABLE plugin_user_installs (
      company_id TEXT, user_id TEXT, plugin_id TEXT, enabled INTEGER, installed_at INTEGER, updated_at INTEGER, removed_at INTEGER
    );
    CREATE TABLE plugin_states (
      company_id TEXT, plugin_id TEXT, enabled INTEGER, updated_by TEXT, updated_at INTEGER
    );
  `)
  return db
}

function actor(companyId = 'c1', userId = 'u1') {
  return {
    subject: {
      companyId,
      userId,
      scopes: new Set([SC.AGENT_TOOL_INVOKE]),
    },
  }
}

function registerDemo(
  companyId: string,
  pluginId: string,
  scope: PluginScope,
  name = 'demo_tool',
) {
  const instanceKey = pluginInstanceKey(companyId, pluginId, scope)
  const result = registerPluginTool(instanceKey, companyId, pluginId, scope, name, {
    description: 'demo',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: () => ({ ok: true }),
  })
  if (result.ok) registeredKeys.push(instanceKey)
  return instanceKey
}

describe('插件工具按安装/启用状态过滤', () => {
  it('公司安装未卸载时可见；公司停用、个人停用、卸载后都不可见', () => {
    const db = memoryDb()
    db.prepare(
      'INSERT INTO plugin_company_installs (company_id, plugin_id, installed_by, installed_at, updated_at, removed_at) VALUES (?, ?, ?, ?, ?, NULL)',
    ).run('c1', 'p_tools_test', 'u1', 1, 1)
    registerDemo('c1', 'p_tools_test', companyScope())

    expect(pluginToolSpecsFor(db, actor())).toHaveLength(1)
    expect(resolvePluginToolForActor(db, actor(), 'demo_tool')?.pluginId).toBe('p_tools_test')
    // 插件工具要随 Agent 首轮工具直接下发，不能只靠 tool_search 按业务词命中
    expect(
      toolSpecsForAgent(db, actor() as any, { kind: 'cloud' }).some((spec) => spec.function.name === 'demo_tool'),
    ).toBe(true)

    // 公司级停用：立即不可见、也解析不到
    db.prepare('INSERT INTO plugin_states (company_id, plugin_id, enabled, updated_by, updated_at) VALUES (?, ?, 0, ?, ?)')
      .run('c1', 'p_tools_test', 'u1', 2)
    expect(pluginToolSpecsFor(db, actor())).toHaveLength(0)
    expect(resolvePluginToolForActor(db, actor(), 'demo_tool')).toBeNull()

    // 公司恢复启用
    db.prepare('UPDATE plugin_states SET enabled = 1 WHERE company_id = ? AND plugin_id = ?').run('c1', 'p_tools_test')
    expect(pluginToolSpecsFor(db, actor())).toHaveLength(1)

    // 公司级卸载
    db.prepare('UPDATE plugin_company_installs SET removed_at = ? WHERE company_id = ? AND plugin_id = ?')
      .run(3, 'c1', 'p_tools_test')
    expect(pluginToolSpecsFor(db, actor())).toHaveLength(0)

    // 公司卸载后，个人显式安装仍可独立使用（个人实例有自己的注册）
    db.prepare(
      'INSERT INTO plugin_user_installs (company_id, user_id, plugin_id, enabled, installed_at, updated_at, removed_at) VALUES (?, ?, ?, 1, ?, ?, NULL)',
    ).run('c1', 'u1', 'p_tools_test', 4, 4)
    registerDemo('c1', 'p_tools_test', userScope('u1'))
    expect(pluginToolSpecsFor(db, actor())).toHaveLength(1)

    // 删除公司安装记录后，个人安装仍然生效
    db.prepare('DELETE FROM plugin_company_installs WHERE company_id = ? AND plugin_id = ?').run('c1', 'p_tools_test')
    expect(pluginToolSpecsFor(db, actor())).toHaveLength(1)

    // 个人停用
    db.prepare('UPDATE plugin_user_installs SET enabled = 0 WHERE company_id = ? AND user_id = ? AND plugin_id = ?')
      .run('c1', 'u1', 'p_tools_test')
    expect(pluginToolSpecsFor(db, actor())).toHaveLength(0)

    // 个人卸载
    db.prepare('UPDATE plugin_user_installs SET removed_at = ? WHERE company_id = ? AND user_id = ? AND plugin_id = ?')
      .run(5, 'c1', 'u1', 'p_tools_test')
    expect(pluginToolSpecsFor(db, actor())).toHaveLength(0)
  })

  it('同名插件公司停用后，个人安装仍只对安装人可见', () => {
    const db = memoryDb()
    db.prepare(
      'INSERT INTO plugin_company_installs (company_id, plugin_id, installed_by, installed_at, updated_at, removed_at) VALUES (?, ?, ?, ?, ?, NULL)',
    ).run('c1', 'p_tools_test', 'u1', 1, 1)
    db.prepare('INSERT INTO plugin_states (company_id, plugin_id, enabled, updated_by, updated_at) VALUES (?, ?, 0, ?, ?)')
      .run('c1', 'p_tools_test', 'u1', 2)
    db.prepare(
      'INSERT INTO plugin_user_installs (company_id, user_id, plugin_id, enabled, installed_at, updated_at, removed_at) VALUES (?, ?, ?, 1, ?, ?, NULL)',
    ).run('c1', 'u1', 'p_tools_test', 4, 4)
    registerDemo('c1', 'p_tools_test', userScope('u1'))

    expect(pluginToolSpecsFor(db, actor('c1', 'u1'))).toHaveLength(1)
    expect(pluginToolSpecsFor(db, actor('c1', 'u2'))).toHaveLength(0)
    expect(resolvePluginToolForActor(db, actor('c1', 'u2'), 'demo_tool')).toBeNull()
  })

  it('两个员工各自安装同一个插件时都可用，未安装的员工不可用', () => {
    const db = memoryDb()
    for (const userId of ['u1', 'u2']) {
      db.prepare(
        'INSERT INTO plugin_user_installs (company_id, user_id, plugin_id, enabled, installed_at, updated_at, removed_at) VALUES (?, ?, ?, 1, ?, ?, NULL)',
      ).run('c1', userId, 'p_tools_test', 4, 4)
      registerDemo('c1', 'p_tools_test', userScope(userId))
    }

    expect(pluginToolSpecsFor(db, actor('c1', 'u1'))).toHaveLength(1)
    expect(pluginToolSpecsFor(db, actor('c1', 'u2'))).toHaveLength(1)
    expect(pluginToolSpecsFor(db, actor('c1', 'u3'))).toHaveLength(0)
  })

  it('个人工具只属于安装人；公司插件和内置工具按角色权限', () => {
    const db = memoryDb()
    db.prepare(
      'INSERT INTO plugin_company_installs (company_id, plugin_id, installed_by, installed_at, updated_at, removed_at) VALUES (?, ?, ?, ?, ?, NULL)',
    ).run('c1', 'p_tools_test', 'admin', 1, 1)
    db.prepare(
      'INSERT INTO plugin_user_installs (company_id, user_id, plugin_id, enabled, installed_at, updated_at, removed_at) VALUES (?, ?, ?, 1, ?, ?, NULL)',
    ).run('c1', 'u1', 'p_tools_test', 4, 4)
    // 公司实例和个人实例注册不同工具，才能看出各自的可见范围。
    registerDemo('c1', 'p_tools_test', companyScope(), 'company_tool')
    registerDemo('c1', 'p_tools_test', userScope('u1'), 'personal_tool')

    const owner = {
      subject: {
        companyId: 'c1',
        userId: 'u1',
        scopes: new Set([SC.AGENT_TOOL_INVOKE]),
      },
    }
    const colleague = {
      subject: {
        companyId: 'c1',
        userId: 'u2',
        scopes: new Set([SC.AGENT_TOOL_INVOKE]),
      },
    }
    const noToolRole = {
      subject: {
        companyId: 'c1',
        userId: 'u2',
        scopes: new Set([SC.CHAT_USE]),
      },
    }

    const functionName = (spec: Record<string, unknown>) => String((spec.function as { name?: unknown } | undefined)?.name ?? '')
    const ownerNames = pluginToolSpecsFor(db, owner).map(functionName)
    expect(ownerNames).toContain('personal_tool')
    expect(ownerNames).toContain('company_tool')

    const colleagueNames = pluginToolSpecsFor(db, colleague).map(functionName)
    expect(colleagueNames).toContain('company_tool')
    expect(colleagueNames).not.toContain('personal_tool')
    expect(pluginToolCatalogFor(db, colleague).map((tool) => tool.name)).not.toContain('personal_tool')
    expect(resolvePluginToolForActor(db, colleague, 'personal_tool')).toBeNull()

    // 公司工具也受角色权限约束：角色没有 agent:tool:invoke 时，公司插件工具不可见
    expect(pluginToolSpecsFor(db, noToolRole)).toHaveLength(0)
    expect(resolvePluginToolForActor(db, noToolRole, 'company_tool')).toBeNull()

    // 内置工具继续按各自 scope 走角色权限，插件工具不改变这条规则。
    const toolInvokeOnly = toolSpecsForActor(db, owner as any, { kind: 'cloud' })
      .map((spec) => spec.function.name)
    expect(toolInvokeOnly).not.toContain('workspace_write')
    const withWorkspaceWrite = toolSpecsForActor(
      db,
      {
        subject: {
          ...owner.subject,
          scopes: new Set([SC.AGENT_TOOL_INVOKE, SC.WORKSPACE_WRITE]),
        },
      } as any,
      { kind: 'cloud' },
    ).map((spec) => spec.function.name)
    expect(withWorkspaceWrite).toContain('workspace_write')
  })
})
