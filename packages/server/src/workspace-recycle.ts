/**
 * 云空间回收区清理。
 *
 * 删除文件时 `deleteUserWorkspaceFile` 只做软删：把文件移到 `_recycle/`，
 * 配额立即释放，但磁盘副本会一直保留。这里按控制台设置的保留天数，
 * 删除超过期限的物理副本，并删除回收区元数据及其依赖（历史快照、共享、
 * GUI 兜底、Office 刷新水位），避免“回收站已清空但记录还挂着”。
 *
 * 安全边界：只处理 `workspace_files.recycled_path` 指向的、位于云空间根目录
 * 之内的普通文件；路径越界、目录、符号链接一律跳过，绝不做通配删除。
 */
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Db } from '@eab/storage'
import { withTransaction } from '@eab/storage'

export interface WorkspaceRecyclePruneResult {
  /** 生效的保留天数；0 表示永久保留 */
  days: number
  /** 清理截止时间戳；0 表示未启用 */
  cutoff: number
  /** 实际删除的物理文件数 */
  files: number
  /** 实际释放的磁盘字节数 */
  bytes: number
  /** 清理后删除的回收区元数据行数（含文件已不存在但记录仍超期的行） */
  rows: number
  skipped: boolean
  /** 因路径越界/非普通文件/删除失败而没有清理的文件 ID */
  skippedIds: string[]
}

interface RecycleRow {
  id: string
  name: string
  size: number
  recycled_path: string
}

/** 云空间根目录；与 workspace.ts 的默认推导保持一致。 */
export function workspaceRootFor(dbPath: string, workspacesDir?: string | null): string {
  return workspacesDir ?? join(dirname(dbPath), 'workspaces')
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

interface VersionPathRow {
  id: string
  storage_path: string
}

function mapSafeVersionTarget(root: string, realRoot: string | null, target: string): string | null {
  const resolved = resolve(target)
  if (!isInsideRoot(root, resolved)) return null
  try {
    if (existsSync(resolved)) {
      if (!lstatSync(resolved).isFile()) return null
      if (realRoot && !isInsideRoot(realRoot, realpathSync(resolved))) return null
    }
  } catch {
    return null
  }
  return resolved
}

/**
 * 删除一个回收站条目的全部元数据与历史快照。
 * 任何快照文件无法安全删除时返回 false，保留父行与 recycled_path，下一轮继续重试。
 */
function purgeRecycleMetadata(
  db: Db,
  fileId: string,
  root: string,
  realRoot: string | null,
): boolean {
  const versions = db
    .prepare(
      `SELECT id, storage_path FROM workspace_file_versions
        WHERE file_id = ?`,
    )
    .all(fileId) as unknown as VersionPathRow[]

  for (const version of versions) {
    const target = mapSafeVersionTarget(root, realRoot, version.storage_path)
    if (!target) return false
    if (existsSync(target)) {
      try {
        rmSync(target, { force: true })
      } catch {
        return false
      }
    }
  }

  withTransaction(db, () => {
    db.prepare('DELETE FROM workspace_file_versions WHERE file_id = ?').run(fileId)
    db.prepare('DELETE FROM workspace_shares WHERE file_id = ?').run(fileId)
    db.prepare('DELETE FROM workspace_gui_fallbacks WHERE file_id = ?').run(fileId)
    db.prepare('DELETE FROM workspace_office_refresh_guards WHERE file_id = ?').run(fileId)
    db.prepare('DELETE FROM workspace_files WHERE id = ?').run(fileId)
  })
  return true
}

/**
 * 按保留天数清理回收区。`days <= 0` 时直接跳过；重复执行是幂等的。
 * 删除失败时保留 `recycled_path`，下一轮还能再试，不会把记录误标成已清。
 */
export function pruneWorkspaceRecycle(
  db: Db,
  workspaceRoot: string,
  days: number,
): WorkspaceRecyclePruneResult {
  const keepDays = Number.isFinite(days) && days > 0 ? Math.trunc(days) : 0
  if (keepDays <= 0) {
    return { days: 0, cutoff: 0, files: 0, bytes: 0, rows: 0, skipped: true, skippedIds: [] }
  }

  const root = resolve(workspaceRoot)
  let realRoot: string | null = null
  try {
    realRoot = realpathSync(root)
  } catch {
    // 根目录还没建出来时没有可清理的文件，保留词法路径守卫即可。
  }
  const cutoff = Date.now() - keepDays * 86_400_000
  const rows = db
    .prepare(
      `SELECT id, name, size, recycled_path
         FROM workspace_files
        WHERE deleted_at IS NOT NULL
          AND deleted_at < ?
          AND recycled_path IS NOT NULL
        ORDER BY deleted_at ASC`,
    )
    .all(cutoff) as unknown as RecycleRow[]

  let files = 0
  let bytes = 0
  let cleared = 0
  const skippedIds: string[] = []

  for (const row of rows) {
    const target = resolve(row.recycled_path)
    // 只删云空间根目录内的普通文件；目录/符号链接/越界路径不碰。
    if (!isInsideRoot(root, target)) {
      skippedIds.push(row.id)
      continue
    }
    let existed = false
    let isRegularFile = false
    try {
      if (existsSync(target)) {
        existed = true
        isRegularFile = lstatSync(target).isFile()
      }
    } catch {
      skippedIds.push(row.id)
      continue
    }
    if (existed && !isRegularFile) {
      skippedIds.push(row.id)
      continue
    }
    // 词法路径在根内不代表物理路径也在根内：父目录可能是指向外部的符号链接。
    if (existed && realRoot) {
      try {
        if (!isInsideRoot(realRoot, realpathSync(target))) {
          skippedIds.push(row.id)
          continue
        }
      } catch {
        skippedIds.push(row.id)
        continue
      }
    }

    let removedBytes = 0
    if (existed) {
      try {
        removedBytes = lstatSync(target).size
        rmSync(target, { force: true })
      } catch {
        // 文件被占用/权限不足：保留 recycled_path，下次再试。
        skippedIds.push(row.id)
        continue
      }
      files += 1
      bytes += removedBytes
    }

    // 物理副本已不存在也算清理完成；连同回收区元数据和依赖一起删除。
    if (!purgeRecycleMetadata(db, row.id, root, realRoot)) {
      skippedIds.push(row.id)
      continue
    }
    cleared += 1
  }

  return {
    days: keepDays,
    cutoff,
    files,
    bytes,
    rows: cleared,
    skipped: false,
    skippedIds,
  }
}
