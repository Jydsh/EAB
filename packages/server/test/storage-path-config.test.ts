import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  applyPendingStorageMigrations,
  readConsoleSettings,
  resolveStorage,
  writeConsoleSettings,
} from '../src/settings.js'

let home = ''
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.EAB_HOME
  home = mkdtempSync(join(tmpdir(), 'eab-storage-paths-'))
  process.env.EAB_HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.EAB_HOME
  else process.env.EAB_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

describe('存储路径解析', () => {
  it('独立配置优先，没配跟随总存储位置', () => {
    const base = join(home, 'data')
    const customWs = join(home, 'ws-on-d')
    writeConsoleSettings({
      dataDir: base,
      paths: { database: null, workspaces: customWs, tmp: null, backups: null, plugins: null, dshHome: null },
    })
    const resolved = resolveStorage(join(home, 'eab.db'))
    expect(resolved.dataDir).toBe(base)
    expect(resolved.dbPath).toBe(join(base, 'eab.db'))
    expect(resolved.workspacesDir).toBe(customWs)
    expect(resolved.tmpDir).toBe(join(base, 'tmp'))
    expect(resolved.backupsDir).toBe(join(base, 'backups'))
  })

  it('数据库可以单独放到另一目录，凭据跟着数据库目录走', () => {
    const base = join(home, 'data')
    const customDb = join(home, 'db-only')
    writeConsoleSettings({
      dataDir: base,
      paths: { database: customDb, workspaces: null, tmp: null, backups: null, plugins: null, dshHome: null },
    })
    const resolved = resolveStorage(join(home, 'eab.db'))
    expect(resolved.dbDir).toBe(customDb)
    expect(resolved.dbPath).toBe(join(customDb, 'eab.db'))
    expect(resolved.dataDir).toBe(base)
  })

  it('EAB_PLUGINS_DIR 优先级最高', () => {
    const base = join(home, 'data')
    const envPlugins = join(home, 'plugins-env')
    writeConsoleSettings({
      dataDir: base,
      paths: { database: null, workspaces: null, tmp: null, backups: null, plugins: join(home, 'plugins-ui'), dshHome: null },
    })
    const resolved = resolveStorage(join(home, 'eab.db'), undefined, envPlugins)
    expect(resolved.pluginsDir).toBe(envPlugins)
    expect(resolved.pluginsEnvLocked).toBe(true)
  })
})

describe('存储迁移', () => {
  it('复制到新目录、校验通过后清空 pending，旧目录保留', () => {
    const source = join(home, 'old-ws')
    const target = join(home, 'new-ws')
    mkdirSync(join(source, 'c1', 'user-u1'), { recursive: true })
    writeFileSync(join(source, 'c1', 'user-u1', 'a.txt'), 'hello')
    writeConsoleSettings({
      paths: { database: null, workspaces: target, tmp: null, backups: null, plugins: null, dshHome: null },
      pendingMigrations: [
        {
          key: 'workspaces',
          kind: 'directory',
          from: source,
          to: target,
          createdAt: new Date().toISOString(),
        },
      ],
    })

    const result = applyPendingStorageMigrations()
    expect(result.moved).toEqual([target])
    expect(readFileSync(join(target, 'c1', 'user-u1', 'a.txt'), 'utf8')).toBe('hello')
    expect(existsSync(source)).toBe(true)
    expect(readConsoleSettings().pendingMigrations).toEqual([])
  })

  it('目标目录已有数据时拒绝覆盖，并保留原文件', () => {
    const source = join(home, 'old-ws')
    const target = join(home, 'busy-ws')
    mkdirSync(source, { recursive: true })
    mkdirSync(target, { recursive: true })
    writeFileSync(join(source, 'a.txt'), 'old')
    writeFileSync(join(target, 'keep.txt'), 'keep')
    writeConsoleSettings({
      pendingMigrations: [
        {
          key: 'workspaces',
          kind: 'directory',
          from: source,
          to: target,
          createdAt: new Date().toISOString(),
        },
      ],
    })

    expect(() => applyPendingStorageMigrations()).toThrow(/已有数据/)
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep')
    expect(readFileSync(join(source, 'a.txt'), 'utf8')).toBe('old')
    expect(readConsoleSettings().pendingMigrations).toHaveLength(1)
  })
})
