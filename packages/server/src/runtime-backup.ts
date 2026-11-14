import { existsSync, rmSync, statSync, readdirSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ServerDeps } from './deps.js'

/** 运行数据备份必须覆盖的目录；插件包与每实例 dsh-home 都在这里。 */
export const RUNTIME_BACKUP_DIRS = ['dsh-home', 'plugins', 'dsh', 'workspaces', 'company-assets'] as const
/** 控制台设置单独文件；密钥文件刻意不进入备份，避免复制后长期留在备份盘。 */
export const RUNTIME_BACKUP_FILES = ['console-settings.json'] as const
export const RUNTIME_BACKUP_EXCLUDES = ['secrets.json', 'admin-credentials.txt'] as const

export interface RuntimeBackupManifest {
  readonly format: 'eab-runtime-backup-v1'
  readonly companyId: string
  readonly createdAt: string
  readonly db: 'eab.db'
  readonly includes: readonly string[]
  readonly excludes: readonly string[]
  /** 备份完成时算好的总大小，列表直接读取，避免每次递归 1.6 万个文件。 */
  readonly size: number
}

export interface RuntimeBackupResult {
  readonly dir: string
  readonly name: string
  readonly size: number
  readonly createdAt: string
  readonly manifest: RuntimeBackupManifest
}

function dataRoot(deps: ServerDeps): string {
  return deps.config.dataDir ?? dirname(deps.config.dbPath)
}

function backupRoot(deps: ServerDeps): string {
  return deps.config.backupsDir ?? join(dataRoot(deps), 'backups')
}

export function backupPathSize(path: string): number {
  if (!existsSync(path)) return 0
  const stat = statSync(path)
  if (stat.isFile()) return stat.size
  return readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => {
    const child = join(path, entry.name)
    return sum + backupPathSize(child)
  }, 0)
}

/**
 * 生成运行数据快照目录。SQLite 用 VACUUM INTO 生成一致性快照；
 * 插件包、dsh-home、workspaces 等直接复制，恢复时由 CLI 按 manifest 回填。
 */
export async function createRuntimeBackup(deps: ServerDeps): Promise<RuntimeBackupResult> {
  const root = dataRoot(deps)
  const outRoot = backupRoot(deps)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = `eab-runtime-${stamp}`
  const dir = join(outRoot, name)
  await fs.mkdir(dir, { recursive: true })
  const includes: string[] = []
  try {
    deps.db.prepare('VACUUM INTO ?').run(join(dir, 'eab.db'))
    includes.push('eab.db')
    for (const relative of RUNTIME_BACKUP_DIRS) {
      const source = join(root, relative)
      if (!existsSync(source)) continue
      await fs.cp(source, join(dir, 'runtime', relative), { recursive: true })
      includes.push(relative)
    }
    for (const relative of RUNTIME_BACKUP_FILES) {
      const source = join(root, relative)
      if (!existsSync(source)) continue
      await fs.cp(source, join(dir, 'runtime', relative))
      includes.push(relative)
    }
    const size = backupPathSize(dir)
    const manifest: RuntimeBackupManifest = {
      format: 'eab-runtime-backup-v1',
      companyId: deps.companyId,
      createdAt: new Date().toISOString(),
      db: 'eab.db',
      includes,
      excludes: [...RUNTIME_BACKUP_EXCLUDES],
      size,
    }
    await fs.writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    return { dir, name, size, createdAt: manifest.createdAt, manifest }
  } catch (error) {
    // 半成品备份不能被当成可恢复快照。
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}
