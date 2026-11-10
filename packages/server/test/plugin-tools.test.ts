import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'
import {
  clearPluginContributions,
  pluginToolSpecsFor,
  registerPluginTool,
  resolvePluginToolForActor,
} from '../src/plugin-tools.js'

const dbs: Array<{ close: () => void }> = []

afterEach(() => {
  clearPluginContributions('p_tools_test')
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

describe('插件工具按安装/启用状态过滤', () => {
  it('公司安装未卸载时可见；公司停用、个人停用、卸载后都不可见', () => {
    const db = memoryDb()
    db.prepare(
      'INSERT INTO plugin_company_installs (company_id, plugin_id, installed_by, installed_at, updated_at, removed_at) VALUES (?, ?, ?, ?, ?, NULL)',
    ).run('c1', 'p_tools_test', 'u1', 1, 1)
    registerPluginTool('p_tools_test', 'demo_tool', {
      description: 'demo',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: () => ({ ok: true }),
    })

    expect(pluginToolSpecsFor(db, actor())).toHaveLength(1)
    expect(resolvePluginToolForActor(db, actor(), 'demo_tool')?.pluginId).toBe('p_tools_test')

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

    // 公司卸载后，个人显式安装仍可独立使用（个人安装不依赖公司安装记录）
    db.prepare(
      'INSERT INTO plugin_user_installs (company_id, user_id, plugin_id, enabled, installed_at, updated_at, removed_at) VALUES (?, ?, ?, 1, ?, ?, NULL)',
    ).run('c1', 'u1', 'p_tools_test', 4, 4)
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
})
