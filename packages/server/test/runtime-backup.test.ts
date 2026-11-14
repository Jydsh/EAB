import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '@eab/storage'
import type { ServerDeps } from '../src/deps.js'
import { createRuntimeBackup, RUNTIME_BACKUP_EXCLUDES } from '../src/runtime-backup.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('运行数据备份', () => {
  it('包含插件数据根与设置，不复制密钥文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eab-runtime-backup-'))
    roots.push(root)
    mkdirSync(join(root, 'dsh-home', 'scopes', 'users', 'c1', 'u1'), { recursive: true })
    writeFileSync(join(root, 'dsh-home', 'scopes', 'users', 'c1', 'u1', 'state.json'), '{"ok":true}')
    mkdirSync(join(root, 'plugins', 'demo', 'lib'), { recursive: true })
    writeFileSync(join(root, 'plugins', 'demo', 'lib', 'client.js'), 'export default 1')
    mkdirSync(join(root, 'workspaces'), { recursive: true })
    writeFileSync(join(root, 'console-settings.json'), '{"host":"127.0.0.1"}')
    writeFileSync(join(root, 'secrets.json'), '{"token":"should-not-copy"}')

    const db = openDatabase({ path: join(root, 'eab.db') })
    const deps = {
      db,
      companyId: 'c1',
      config: {
        dataDir: root,
        dbPath: join(root, 'eab.db'),
        backupsDir: join(root, 'backups'),
      },
    } as unknown as ServerDeps

    const result = await createRuntimeBackup(deps)
    const backupDb = join(result.dir, 'eab.db')
    const manifest = JSON.parse(readFileSync(join(result.dir, 'manifest.json'), 'utf8')) as {
      includes: string[]
      excludes: string[]
      size: number
    }

    expect(existsSync(backupDb)).toBe(true)
    expect(existsSync(join(result.dir, 'runtime', 'dsh-home', 'scopes', 'users', 'c1', 'u1', 'state.json'))).toBe(true)
    expect(existsSync(join(result.dir, 'runtime', 'plugins', 'demo', 'lib', 'client.js'))).toBe(true)
    expect(existsSync(join(result.dir, 'runtime', 'console-settings.json'))).toBe(true)
    expect(existsSync(join(result.dir, 'runtime', 'secrets.json'))).toBe(false)
    expect(manifest.includes).toEqual(expect.arrayContaining(['eab.db', 'dsh-home', 'plugins', 'console-settings.json']))
    expect(manifest.excludes).toEqual(RUNTIME_BACKUP_EXCLUDES)
    expect(manifest.size).toBeGreaterThan(0)
    expect(manifest.size).toBe(result.size)
    db.close()
  })
})
