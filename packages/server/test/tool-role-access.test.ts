import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { EC, EabError, SC } from '@eab/domain'
import {
  listCompanyRoleOptions,
  pluginToolAccessId,
  readToolRoleAccess,
  setToolRoleAccess,
  toolAllowedForRoles,
} from '../src/tool-role-access.js'
import { executeTool, toolSpecsForActor, toolSpecsForAgent } from '../src/routes/tools.js'
import {
  clearPluginContributions,
  pluginToolCatalogFor,
  pluginToolSpecsFor,
  registerPluginTool,
  resolvePluginToolByCatalogId,
  resolvePluginToolForActor,
} from '../src/plugin-tools.js'
import { companyScope, pluginInstanceKey, userScope } from '../src/plugin-scope.js'

const dbs: Array<{ close: () => void }> = []
const pluginKeys: string[] = []

afterEach(() => {
  for (const key of pluginKeys.splice(0)) clearPluginContributions(key)
  for (const db of dbs.splice(0)) db.close()
})

function testEnv() {
  const db = openDatabase({ path: ':memory:' })
  dbs.push(db)
  migrate(db)
  db.prepare('INSERT INTO companies (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
    'c1',
    '甲科技',
    'c1',
    'active',
    1,
  )
  const insertRole = db.prepare(
    'INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  for (const [id, code, name, builtin] of [
    ['r_member', 'member', '普通员工', 1],
    ['r_admin', 'company_admin', '公司管理员', 1],
    ['r_auditor', 'auditor', '审计员', 1],
    ['r_super', 'super_admin', '平台超管', 1],
  ]) {
    insertRole.run(id, 'c1', code, name, 'company', builtin, 1)
  }

  const actor = (roles: string[], userId = 'u1') =>
    ({
      subject: {
        companyId: 'c1',
        userId,
        status: 'active',
        deptId: 'd1',
        deptPath: '/d1',
        deptChain: [],
        roles,
        scopes: new Set(Object.values(SC)),
      },
      person: {
        id: userId,
        name: userId,
        title: null,
        deptId: 'd1',
        deptPath: '/d1',
        deptName: '测试部门',
        companyId: 'c1',
        companyName: '甲科技',
      },
    }) as any
  const deps = { db, config: { dbPath: ':memory:' }, companyId: 'c1' } as any
  return { db, deps, actor }
}

function toolVisible(specs: Array<{ function: { name: string } }>, name: string): boolean {
  return specs.some((spec) => spec.function.name === name)
}

describe('工具角色可用性', () => {
  it('没有配置时所有角色可用', () => {
    const { db, actor } = testEnv()
    expect(toolVisible(toolSpecsForActor(db, actor(['member']), { kind: 'cloud' }), 'time_now')).toBe(true)
    expect(toolVisible(toolSpecsForActor(db, actor(['auditor']), { kind: 'cloud' }), 'time_now')).toBe(true)
    expect(readToolRoleAccess(db, 'c1', 'time.now')).toEqual({ mode: 'all', roles: [] })
  })

  it('配置为指定角色后，下发目录和执行入口同时收窄；平台超管始终放行', async () => {
    const { db, deps, actor } = testEnv()
    setToolRoleAccess(db, 'c1', 'time.now', { mode: 'roles', roles: ['company_admin'] })

    const member = actor(['member'])
    const admin = actor(['company_admin'])
    const superAdmin = actor(['super_admin'])
    expect(toolVisible(toolSpecsForActor(db, member, { kind: 'cloud' }), 'time_now')).toBe(false)
    expect(toolVisible(toolSpecsForActor(db, admin, { kind: 'cloud' }), 'time_now')).toBe(true)
    expect(toolVisible(toolSpecsForActor(db, superAdmin, { kind: 'cloud' }), 'time_now')).toBe(true)

    await expect(executeTool(deps, member, 'time.now', {})).rejects.toMatchObject({
      code: EC.FORBIDDEN,
    })
    await expect(executeTool(deps, admin, 'time.now', {})).resolves.toMatchObject({ iso: expect.any(String) })
    await expect(executeTool(deps, superAdmin, 'time.now', {})).resolves.toMatchObject({ iso: expect.any(String) })
  })

  it('对话首轮下发的核心工具也按角色白名单过滤', () => {
    const { db, actor } = testEnv()
    setToolRoleAccess(db, 'c1', 'workspace.read', { mode: 'roles', roles: ['company_admin'] })
    const member = actor(['member'])
    const admin = actor(['company_admin'])
    expect(toolVisible(toolSpecsForAgent(db, member, { kind: 'cloud' }), 'workspace_read')).toBe(false)
    expect(toolVisible(toolSpecsForAgent(db, admin, { kind: 'cloud' }), 'workspace_read')).toBe(true)
  })

  it('可以恢复所有角色；未知角色与非法 mode 被拒绝', () => {
    const { db } = testEnv()
    setToolRoleAccess(db, 'c1', 'time.now', { mode: 'roles', roles: ['member'] })
    expect(readToolRoleAccess(db, 'c1', 'time.now')).toEqual({ mode: 'roles', roles: ['member'] })
    setToolRoleAccess(db, 'c1', 'time.now', { mode: 'all' })
    expect(readToolRoleAccess(db, 'c1', 'time.now')).toEqual({ mode: 'all', roles: [] })

    expect(() => setToolRoleAccess(db, 'c1', 'time.now', { mode: 'roles', roles: ['not_a_role'] })).toThrow(EabError)
    expect(() => setToolRoleAccess(db, 'c1', 'time.now', { mode: 'nobody' })).toThrow(EabError)
    expect(listCompanyRoleOptions(db, 'c1').map((role) => role.code)).toContain('member')
  })

  it('插件工具按 pluginId + 工具名共享角色配置', () => {
    const { db, actor } = testEnv()
    const instanceKey = pluginInstanceKey('c1', 'p_role_demo', companyScope())
    pluginKeys.push(instanceKey)
    const registered = registerPluginTool(instanceKey, 'c1', 'p_role_demo', companyScope(), 'role_demo_tool', {
      description: 'demo',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: () => ({ ok: true }),
    })
    expect(registered.ok).toBe(true)
    db.prepare(
      'INSERT INTO plugin_company_installs (company_id, plugin_id, installed_by, installed_at, updated_at, removed_at) VALUES (?, ?, ?, ?, ?, NULL)',
    ).run('c1', 'p_role_demo', 'u1', 1, 1)

    setToolRoleAccess(db, 'c1', pluginToolAccessId('p_role_demo', 'role_demo_tool'), {
      mode: 'roles',
      roles: ['member'],
    })

    const member = actor(['member'])
    const auditor = actor(['auditor'], 'u2')
    expect(pluginToolSpecsFor(db, member).map((spec) => (spec.function as { name: string }).name)).toContain('role_demo_tool')
    expect(pluginToolSpecsFor(db, auditor)).toEqual([])
    expect(resolvePluginToolForActor(db, member, 'role_demo_tool')).not.toBeNull()
    expect(resolvePluginToolForActor(db, auditor, 'role_demo_tool')).toBeNull()
    const catalogId = pluginToolCatalogFor(db, member).find((tool) => tool.name === 'role_demo_tool')?.id
    expect(catalogId).toBeTruthy()
    expect(resolvePluginToolByCatalogId(db, member, String(catalogId))).not.toBeNull()
    expect(resolvePluginToolByCatalogId(db, auditor, String(catalogId))).toBeNull()
    expect(pluginToolCatalogFor(db, auditor).find((tool) => tool.name === 'role_demo_tool')?.available).toBe(false)
    expect(toolAllowedForRoles({ mode: 'all', roles: [] }, [])).toBe(true)
  })

  it('公司插件工具在角色表就绪后仍沿用默认所有角色', () => {
    const { db, actor } = testEnv()
    const instanceKey = pluginInstanceKey('c1', 'p_company_default', companyScope())
    pluginKeys.push(instanceKey)
    registerPluginTool(instanceKey, 'c1', 'p_company_default', companyScope(), 'company_default_tool', {
      description: 'demo',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: () => ({ ok: true }),
    })
    db.prepare(
      'INSERT INTO plugin_company_installs (company_id, plugin_id, installed_by, installed_at, updated_at, removed_at) VALUES (?, ?, ?, ?, ?, NULL)',
    ).run('c1', 'p_company_default', 'u1', 1, 1)

    const member = actor(['member'])
    expect(pluginToolSpecsFor(db, member).map((spec) => (spec.function as { name: string }).name)).toContain('company_default_tool')
    expect(pluginToolCatalogFor(db, member).find((tool) => tool.name === 'company_default_tool')?.available).toBe(true)
  })

  it('个人插件工具归安装人本人，不需要角色授权；别人不可见', () => {
    const { db, actor } = testEnv()
    const instanceKey = pluginInstanceKey('c1', 'p_default_deny', userScope('u1'))
    pluginKeys.push(instanceKey)
    const registered = registerPluginTool(instanceKey, 'c1', 'p_default_deny', userScope('u1'), 'deny_by_default_tool', {
      description: 'demo',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: () => ({ ok: true }),
    })
    expect(registered.ok).toBe(true)
    db.prepare(
      'INSERT INTO plugin_user_installs (company_id, user_id, plugin_id, enabled, installed_at, updated_at, removed_at) VALUES (?, ?, ?, 1, ?, ?, NULL)',
    ).run('c1', 'u1', 'p_default_deny', 1, 1)

    const member = actor(['member'])
    // 安装人自己：装完就能用，不需要管理员再配角色
    expect(pluginToolSpecsFor(db, member).map((spec) => (spec.function as { name: string }).name)).toContain('deny_by_default_tool')
    expect(resolvePluginToolForActor(db, member, 'deny_by_default_tool')).not.toBeNull()
    expect(pluginToolCatalogFor(db, member).find((tool) => tool.name === 'deny_by_default_tool')?.available).toBe(true)

    // 角色配置对个人工具不再生效：白名单只给了 auditor，本人（member）照样可用
    setToolRoleAccess(db, 'c1', pluginToolAccessId('p_default_deny', 'deny_by_default_tool'), {
      mode: 'roles',
      roles: ['auditor'],
    })
    expect(pluginToolCatalogFor(db, member).find((tool) => tool.name === 'deny_by_default_tool')?.available).toBe(true)

    // 别人：个人实例不进他的实例列表，看不到也用不了
    const other = actor(['member'], 'u2')
    expect(pluginToolSpecsFor(db, other).map((spec) => (spec.function as { name: string }).name)).not.toContain('deny_by_default_tool')
    expect(resolvePluginToolForActor(db, other, 'deny_by_default_tool')).toBeNull()

    expect(toolAllowedForRoles(undefined, ['member'], false)).toBe(false)
    expect(toolAllowedForRoles(undefined, ['member'], true)).toBe(true)
  })

  it('个人插件工具只有安装人本人看得到，管理员后台也不展示', () => {
    const { db, actor } = testEnv()
    const instanceKey = pluginInstanceKey('c1', 'p_personal_catalog', userScope('u2'))
    pluginKeys.push(instanceKey)
    registerPluginTool(instanceKey, 'c1', 'p_personal_catalog', userScope('u2'), 'personal_catalog_tool', {
      description: 'demo',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: () => ({ ok: true }),
    })
    db.prepare(
      'INSERT INTO plugin_user_installs (company_id, user_id, plugin_id, enabled, installed_at, updated_at, removed_at) VALUES (?, ?, ?, 1, ?, ?, NULL)',
    ).run('c1', 'u2', 'p_personal_catalog', 1, 1)

    // 管理员（哪怕是超管）也看不到别人的个人工具，平台目录/后台都不展示
    const consoleActor = actor(['company_admin'], 'u1')
    expect(pluginToolCatalogFor(db, consoleActor).find((tool) => tool.name === 'personal_catalog_tool')).toBeUndefined()
    expect(
      pluginToolCatalogFor(db, consoleActor, { allCompanyInstances: true }).find(
        (tool) => tool.name === 'personal_catalog_tool',
      ),
    ).toBeUndefined()
    expect(
      pluginToolCatalogFor(db, consoleActor, { allCompanyInstances: true, scope: 'company' }).find(
        (tool) => tool.name === 'personal_catalog_tool',
      ),
    ).toBeUndefined()
    expect(
      pluginToolCatalogFor(db, actor(['super_admin'], 'u1'), { allCompanyInstances: true }).find(
        (tool) => tool.name === 'personal_catalog_tool',
      ),
    ).toBeUndefined()

    // 安装人本人：能看到、能用，不需要任何角色授权
    const owner = actor(['member'], 'u2')
    expect(pluginToolCatalogFor(db, owner).find((tool) => tool.name === 'personal_catalog_tool')?.available).toBe(true)
    expect(pluginToolSpecsFor(db, owner).map((spec) => (spec.function as { name: string }).name)).toContain('personal_catalog_tool')
    // 角色表里配置无关：配置与否都不影响本人可用
    setToolRoleAccess(db, 'c1', pluginToolAccessId('p_personal_catalog', 'personal_catalog_tool'), {
      mode: 'roles',
      roles: ['auditor'],
    })
    expect(pluginToolCatalogFor(db, owner).find((tool) => tool.name === 'personal_catalog_tool')?.available).toBe(true)
    // 平台通用目录（公司范围）仍不展示个人工具
    expect(
      pluginToolCatalogFor(db, owner, { scope: 'company' }).find((tool) => tool.name === 'personal_catalog_tool'),
    ).toBeUndefined()
  })
})
