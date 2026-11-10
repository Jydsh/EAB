/**
 * 单写进程锁。
 *
 * SQLite 适合单进程写、多进程读；两个 EAB 服务进程同时写同一个库会互相抢写锁，
 * 表现为随机的 SQLITE_BUSY、长事务和难以复现的覆盖。这里在启动阶段就用一个
 * 独占锁文件把第二个写进程挡在门外，失败信息直接告诉用户当前是谁占着库。
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export interface ProcessLockInfo {
  readonly pid: number
  readonly startedAt: number
  readonly dbPath: string
}

export class ProcessLockError extends Error {
  readonly code = 'EAB_DB_WRITE_LOCKED'
  readonly holder: ProcessLockInfo | null

  constructor(message: string, holder: ProcessLockInfo | null) {
    super(message)
    this.name = 'ProcessLockError'
    this.holder = holder
  }
}

export interface ProcessLock {
  readonly path: string
  readonly info: ProcessLockInfo
  release(): void
}

function readLock(path: string): ProcessLockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProcessLockInfo>
    if (!parsed || typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid)) return null
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      dbPath: typeof parsed.dbPath === 'string' ? parsed.dbPath : '',
    }
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 说明进程存在但当前用户无权发信号；ESRCH 才是已经退出。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 尝试获取单写进程锁；已有活进程占用时抛 ProcessLockError。 */
export function acquireProcessLock(dataDir: string, dbPath: string): ProcessLock {
  const path = join(dataDir, 'eab-server.lock')
  const info: ProcessLockInfo = { pid: process.pid, startedAt: Date.now(), dbPath }

  const tryCreate = (): number | null => {
    try {
      return openSync(path, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return null
    }
  }

  let fd = tryCreate()
  if (fd === null) {
    const holder = readLock(path)
    if (holder && isProcessAlive(holder.pid)) {
      throw new ProcessLockError(
        `数据库正被另一个 EAB 服务进程写占用（PID ${holder.pid}，启动于 ${new Date(holder.startedAt).toLocaleString('zh-CN')}）。` +
          '同一个 SQLite 库只能由一个 EAB 服务进程写；请先停止旧进程再启动。',
        holder,
      )
    }
    // 上次进程异常退出留下的锁：清掉后只重试一次，避免两个新进程同时抢删。
    try {
      unlinkSync(path)
    } catch {
      // 另一个启动者可能已经清掉，继续走重试。
    }
    fd = tryCreate()
    if (fd === null) {
      const secondHolder = readLock(path)
      throw new ProcessLockError('另一个 EAB 服务进程正在启动，请稍后重试。', secondHolder)
    }
  }

  try {
    writeSync(fd, JSON.stringify(info))
  } finally {
    closeSync(fd)
  }

  let released = false
  const release = (): void => {
    if (released) return
    released = true
    try {
      const current = readLock(path)
      // 只删除自己写的锁，避免误删刚接手的新进程锁。
      if (current?.pid === process.pid) unlinkSync(path)
    } catch {
      // 退出清理失败不阻塞进程结束；残留锁会被下一次启动判定为失效。
    }
  }

  return { path, info, release }
}
