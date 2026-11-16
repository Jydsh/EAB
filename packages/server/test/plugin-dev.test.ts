import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '@eab/storage'
import { createPluginDevScaffold, installPluginDevBundle, pluginPreviewLink } from '../src/plugin-dev.js'
import { pluginRoot, setPluginRoot } from '../src/plugins.js'

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

describe('插件自开发闭环', () => {
  it('在工作区生成 DSH bundle，安装为个人插件，再编辑后热更新', () => {
    const db = memoryDb()
    const root = mkdtempSync(join(tmpdir(), 'eab-plugin-dev-'))
    temps.push(root)
    setPluginRoot(join(root, 'plugins'))
    const dir = join(root, 'workspace', '.eab-plugins', 'eab-self-card')

    const created = createPluginDevScaffold({ dir, pluginId: 'eab-self-card', title: '自开发卡片' })
    expect(created.created).toBe(true)
    expect(created.files).toContain('client.js')
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toContain('id: eab-self-card')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('"pages"')
    expect(readFileSync(join(dir, 'client.js'), 'utf8')).toContain('ctx.slots.register')

    const first = installPluginDevBundle(db, {
      companyId: 'c1',
      userId: 'u1',
      installedBy: 'u1',
      dir,
    })
    expect(first.plugin.id).toBe('eab-self-card')
    expect(first.plugin.pages.length).toBe(1)
    expect(first.plugin.pages[0].file).toBe('client.js')
    const userInstall = db
      .prepare(
        `SELECT user_id, removed_at FROM plugin_user_installs
          WHERE company_id = ? AND user_id = ? AND plugin_id = ?`,
      )
      .get('c1', 'u1', 'eab-self-card') as { user_id: string; removed_at: number | null } | undefined
    expect(userInstall?.user_id).toBe('u1')
    expect(userInstall?.removed_at).toBeNull()
    const firstChecksum = first.plugin.checksum
    const installedClient = join(root, 'plugins', 'eab-self-card', 'client.js')
    expect(readFileSync(installedClient, 'utf8')).toContain('EAB SELF-DEV PLUGIN')
    const preview = pluginPreviewLink(first.plugin, 'c1')
    expect(preview.previewPath).toContain('/plugin-kernel.html?')
    expect(preview.previewPath).toContain('entry=client.js')
    expect(preview.previewPath).toContain(`h=${first.plugin.checksum}`)
    expect(preview.previewPath).toContain('scope=user')

    const edited = readFileSync(join(dir, 'client.js'), 'utf8').replace('EAB SELF-DEV PLUGIN', 'EAB HOT UPDATED')
    writeFileSync(join(dir, 'client.js'), edited, 'utf8')

    const second = installPluginDevBundle(db, {
      companyId: 'c1',
      userId: 'u1',
      installedBy: 'u1',
      dir,
    })
    expect(second.replaced).toBe(true)
    expect(second.plugin.checksum).not.toBe(firstChecksum)
    expect(readFileSync(installedClient, 'utf8')).toContain('EAB HOT UPDATED')
    db.close()
  })

  it('拒绝用已有目录直接重置，避免覆盖 Agent 写好的页面', () => {
    const root = mkdtempSync(join(tmpdir(), 'eab-plugin-dev-conflict-'))
    temps.push(root)
    const dir = join(root, '.eab-plugins', 'eab-keep')
    createPluginDevScaffold({ dir, pluginId: 'eab-keep', title: '保留' })
    expect(() => createPluginDevScaffold({ dir, pluginId: 'eab-keep', title: '覆盖' })).toThrow(/已存在/)
  })
})
