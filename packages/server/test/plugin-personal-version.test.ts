import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '@eab/storage'
import {
  installPluginPackage,
  loadPersonalPluginsForUser,
  loadPlugins,
  loadPluginsForUser,
  personalPluginPackageDir,
  pluginRoot,
  readPluginForInstance,
  setPluginRoot,
  uninstallUserPlugin,
} from '../src/plugins.js'

const originalRoot = pluginRoot()
const temps: string[] = []

afterEach(() => {
  setPluginRoot(originalRoot)
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function memoryDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  return db
}

function makeSource(root: string, id: string, version: string, body: string): string {
  const dir = join(root, `source-${id}-${version}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), body, 'utf8')
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      id,
      name: id,
      version,
      description: '个人版本测试插件',
      pages: [{ id: 'main', title: '主页面', file: 'index.html' }],
    }),
    'utf8',
  )
  return dir
}

function install(
  db: ReturnType<typeof memoryDb>,
  source: string,
  options: {
    companyId: string
    userId?: string
    scope?: 'company' | 'user'
    overwrite?: boolean
    installedBy: string
  },
) {
  return installPluginPackage(db, source, {
    companyId: options.companyId,
    installedBy: options.installedBy,
    scope: options.scope,
    userId: options.userId,
    overwrite: options.overwrite,
    source: 'test',
  })
}

describe('插件个人版本与公司版本分离', () => {
  it('个人版本不一致时使用自己的独立包，版本一致后回到共享包', () => {
    const db = memoryDb()
    const root = mkdtempSync(join(tmpdir(), 'eab-plugin-personal-'))
    temps.push(root)
    setPluginRoot(join(root, 'plugins'))

    const v1 = makeSource(root, 'personal-switch', '2026.11.1', '<h1>company v1</h1>')
    const v2 = makeSource(root, 'personal-switch', '2026.11.2', '<h1>user v2</h1>')

    install(db, v1, { companyId: 'c1', scope: 'company', installedBy: 'admin' })
    expect(loadPlugins(db, 'c1')[0]?.version).toBe('2026.11.1')

    install(db, v2, { companyId: 'c1', scope: 'user', userId: 'u1', installedBy: 'u1' })
    const personalDir = personalPluginPackageDir('c1', 'u1', 'personal-switch')
    expect(existsSync(personalDir)).toBe(true)
    expect(existsSync(join(personalDir, '.eab-package.json'))).toBe(true)
    expect(existsSync(join(root, 'plugins', 'personal-switch', '.eab-package.json'))).toBe(false)
    expect(loadPlugins(db, 'c1')[0]?.version).toBe('2026.11.1')
    expect(loadPersonalPluginsForUser(db, 'c1', 'u1')[0]?.version).toBe('2026.11.2')
    expect(loadPersonalPluginsForUser(db, 'c1', 'u1')[0]?.dir).toBe(personalDir)
    expect(
      readPluginForInstance('c1', 'personal-switch', { kind: 'user', userId: 'u1' })?.version,
    ).toBe('2026.11.2')
    // 控制台预览是管理员视角，看公司共享包，不能被成员个人版本覆盖。
    expect(
      loadPluginsForUser(db, 'c1', 'u1', true)
        .find((plugin) => plugin.id === 'personal-switch')?.version,
    ).toBe('2026.11.1')
    expect(loadPlugins(db, 'c1')[0]?.dir).toBe(join(root, 'plugins', 'personal-switch'))

    // 个人重新装回公司同版本：删除个人独立目录，只保留共享归属。
    install(db, v1, { companyId: 'c1', scope: 'user', userId: 'u1', installedBy: 'u1' })
    expect(existsSync(personalDir)).toBe(false)
    expect(loadPersonalPluginsForUser(db, 'c1', 'u1')[0]?.version).toBe('2026.11.1')
    expect(loadPersonalPluginsForUser(db, 'c1', 'u1')[0]?.dir).toBe(
      join(root, 'plugins', 'personal-switch'),
    )
    db.close()
  })

  it('公司升级共享包时，把仍使用共享旧版本的个人迁移成个人旧版本', () => {
    const db = memoryDb()
    const root = mkdtempSync(join(tmpdir(), 'eab-plugin-migrate-'))
    temps.push(root)
    setPluginRoot(join(root, 'plugins'))

    const v1 = makeSource(root, 'company-upgrade', '2026.11.1', '<h1>shared v1</h1>')
    const v3 = makeSource(root, 'company-upgrade', '2026.11.3', '<h1>company v3</h1>')
    const v2 = makeSource(root, 'company-upgrade', '2026.11.2', '<h1>user own v2</h1>')

    install(db, v1, { companyId: 'c1', scope: 'company', installedBy: 'admin' })
    // 员工在 v1 时使用共享包。
    install(db, v1, { companyId: 'c1', scope: 'user', userId: 'u1', installedBy: 'u1' })
    expect(existsSync(personalPluginPackageDir('c1', 'u1', 'company-upgrade'))).toBe(false)

    install(db, v3, { companyId: 'c1', scope: 'company', installedBy: 'admin', overwrite: true })
    const migrated = personalPluginPackageDir('c1', 'u1', 'company-upgrade')
    expect(existsSync(migrated)).toBe(true)
    expect(loadPlugins(db, 'c1')[0]?.version).toBe('2026.11.3')
    expect(loadPersonalPluginsForUser(db, 'c1', 'u1')[0]?.version).toBe('2026.11.1')

    // 员工已有自己的 v1 时，公司再升级不应覆盖个人版本。
    install(db, v2, {
      companyId: 'c1',
      scope: 'user',
      userId: 'u1',
      installedBy: 'u1',
      overwrite: true,
    })
    expect(loadPersonalPluginsForUser(db, 'c1', 'u1')[0]?.version).toBe('2026.11.2')
    expect(existsSync(personalPluginPackageDir('c1', 'u1', 'company-upgrade'))).toBe(true)

    // 个人卸载只删自己的独立包，公司共享包和其他成员不受影响。
    uninstallUserPlugin(db, 'c1', 'u1', 'company-upgrade')
    expect(existsSync(personalPluginPackageDir('c1', 'u1', 'company-upgrade'))).toBe(false)
    expect(loadPersonalPluginsForUser(db, 'c1', 'u1')).toHaveLength(0)
    expect(loadPlugins(db, 'c1')[0]?.version).toBe('2026.11.3')
    db.close()
  })

  it('没有公司包时，第二个成员装不同版本会落到自己的独立包，不覆盖第一个成员', () => {
    const db = memoryDb()
    const root = mkdtempSync(join(tmpdir(), 'eab-plugin-personal-only-'))
    temps.push(root)
    setPluginRoot(join(root, 'plugins'))

    const v1 = makeSource(root, 'personal-only', '2026.11.1', '<h1>u1 v1</h1>')
    const v2 = makeSource(root, 'personal-only', '2026.11.2', '<h1>u2 v2</h1>')

    install(db, v1, { companyId: 'c1', scope: 'user', userId: 'u1', installedBy: 'u1' })
    expect(existsSync(personalPluginPackageDir('c1', 'u1', 'personal-only'))).toBe(false)
    expect(loadPersonalPluginsForUser(db, 'c1', 'u1')[0]?.version).toBe('2026.11.1')

    install(db, v2, { companyId: 'c1', scope: 'user', userId: 'u2', installedBy: 'u2' })
    expect(existsSync(personalPluginPackageDir('c1', 'u2', 'personal-only'))).toBe(true)
    expect(loadPersonalPluginsForUser(db, 'c1', 'u1')[0]?.version).toBe('2026.11.1')
    expect(loadPersonalPluginsForUser(db, 'c1', 'u2')[0]?.version).toBe('2026.11.2')
    db.close()
  })
})
