import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'
import {
  pluginPackageFingerprint,
  reloadPluginHostInstance,
  reloadPluginHosts,
  stopPluginHosts,
} from '../src/plugin-host.js'
import { pluginToolCatalogFor } from '../src/plugin-tools.js'
import { companyScope, pluginInstanceKey, userScope } from '../src/plugin-scope.js'
import { pluginRoot, setPluginRoot } from '../src/plugins.js'

const originalRoot = pluginRoot()
const temps: string[] = []

afterEach(() => {
  stopPluginHosts()
  setPluginRoot(originalRoot)
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function memoryDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  return db
}

function installBoth(db: ReturnType<typeof memoryDb>, pluginId: string) {
  db.prepare(
    `INSERT INTO plugin_company_installs
       (company_id, plugin_id, installed_by, installed_at, updated_at, removed_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run('c1', pluginId, 'u1', 1, 1)
  db.prepare(
    `INSERT INTO plugin_user_installs
       (company_id, user_id, plugin_id, enabled, installed_at, updated_at, removed_at)
     VALUES (?, ?, ?, 1, ?, ?, NULL)`,
  ).run('c1', 'u1', pluginId, 1, 1)
}

function writePlugin(root: string, toolName: string): string {
  const dir = join(root, 'probe-watch')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'probe-watch',
        version: '1.0.0',
        type: 'module',
        main: 'lib/index.js',
        dsh: { client: { platform: 'web' } },
      },
      null,
      2,
    ),
    'utf8',
  )
  writeFileSync(
    join(dir, 'lib', 'index.js'),
    `export function apply(ctx) {
  ctx.inject(['tools'], (child) => {
    child.tools.register('${toolName}', {
      description: '${toolName}',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: () => ({ ok: '${toolName}' }),
    })
  })
}
`,
    'utf8',
  )
  return dir
}

function writeConfigPlugin(root: string): string {
  const dir = join(root, 'probe-config-watch')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'probe-config-watch',
        version: '1.0.0',
        type: 'module',
        main: 'lib/index.js',
        dsh: { client: { platform: 'web' } },
      },
      null,
      2,
    ),
    'utf8',
  )
  writeFileSync(
    join(dir, 'lib', 'index.js'),
    `import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function configuredTool() {
  try {
    return JSON.parse(readFileSync(join(process.env.DSH_HOME, 'probe-config-watch', 'config.json'), 'utf8')).toolName
  } catch {
    return 'probe_config_default'
  }
}

export function apply(ctx) {
  // apply 阶段也要能读到本实例的 DSH_HOME，不能只保证模块求值阶段。
  const applyToolName = configuredTool()
  ctx.inject(['tools'], (child) => {
    child.tools.register(applyToolName, {
      description: applyToolName,
      parameters: { type: 'object', properties: {}, required: [] },
      execute: () => ({ ok: applyToolName }),
    })
  })
}
`,
    'utf8',
  )
  return dir
}

function writeConfig(dataRoot: string, toolName: string): void {
  const dir = join(dataRoot, 'probe-config-watch')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ toolName }), 'utf8')
}

function toolNames(db: ReturnType<typeof memoryDb>, scope?: 'company' | 'user'): string[] {
  return pluginToolCatalogFor(
    db,
    {
      subject: {
        companyId: 'c1',
        userId: 'u1',
        scopes: new Set([SC.AGENT_TOOL_INVOKE]),
      },
    },
    { allCompanyInstances: true, scope },
  ).map((item) => item.name)
}

describe('插件包实时热重载', () => {
  it('公司级和个人级实例都感知同一插件包变化并重新注册工具', async () => {
    const db = memoryDb()
    const root = mkdtempSync(join(tmpdir(), 'eab-plugin-watch-'))
    temps.push(root)
    const home = join(root, 'dsh-home')
    setPluginRoot(root)
    installBoth(db, 'probe-watch')
    const dir = writePlugin(root, 'probe_watch_one')

    const options = { dbPath: ':memory:', companyId: 'c1', dshHomeDir: home }
    await reloadPluginHosts(db, options)
    expect(toolNames(db)).toContain('probe_watch_one')
    const before = pluginPackageFingerprint(dir)

    await new Promise((resolve) => setTimeout(resolve, 30))
    const modulePath = join(dir, 'lib', 'index.js')
    writeFileSync(
      modulePath,
      `export function apply(ctx) {
  ctx.inject(['tools'], (child) => {
    child.tools.register('probe_watch_two', {
      description: 'probe_watch_two',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: () => ({ ok: 'probe_watch_two' }),
    })
  })
}
`,
      'utf8',
    )
    expect(pluginPackageFingerprint(dir)).not.toBe(before)

    // watcher 每 2s 扫一次、连续两次指纹一致后重载；等待自动生效而不是直接调用 reload。
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline && !toolNames(db).includes('probe_watch_two')) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(toolNames(db)).toContain('probe_watch_two')
    expect(toolNames(db)).not.toContain('probe_watch_one')
    db.close()
  }, 20_000)

  it('公司和个人实例的 config.json 变化只重载对应实例', async () => {
    const db = memoryDb()
    const root = mkdtempSync(join(tmpdir(), 'eab-plugin-config-watch-'))
    temps.push(root)
    const home = join(root, 'dsh-home')
    const companyData = home
    const personalData = join(home, 'scopes', 'users', 'c1', 'u1')
    setPluginRoot(root)
    installBoth(db, 'probe-config-watch')
    writeConfigPlugin(root)
    writeConfig(companyData, 'probe_config_company_one')
    writeConfig(personalData, 'probe_config_personal_one')

    const options = { dbPath: ':memory:', companyId: 'c1', dshHomeDir: home }
    await reloadPluginHosts(db, options)
    expect(toolNames(db, 'company')).toContain('probe_config_company_one')
    expect(toolNames(db, 'user')).toContain('probe_config_personal_one')

    writeConfig(companyData, 'probe_config_company_two')
    await reloadPluginHostInstance(
      pluginInstanceKey('c1', 'probe-config-watch', companyScope()),
      db,
      options,
    )
    expect(toolNames(db, 'company')).toContain('probe_config_company_two')
    expect(toolNames(db, 'company')).not.toContain('probe_config_company_one')
    // 个人实例没有被公司配置变化带走。
    expect(toolNames(db, 'user')).toContain('probe_config_personal_one')

    writeConfig(personalData, 'probe_config_personal_two')
    await reloadPluginHostInstance(
      pluginInstanceKey('c1', 'probe-config-watch', userScope('u1')),
      db,
      options,
    )
    expect(toolNames(db, 'user')).toContain('probe_config_personal_two')
    expect(toolNames(db, 'user')).not.toContain('probe_config_personal_one')
    expect(toolNames(db, 'company')).toContain('probe_config_company_two')
    db.close()
  }, 20_000)
})
