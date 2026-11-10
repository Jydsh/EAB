import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireProcessLock, ProcessLockError } from '../src/process-lock.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eab-process-lock-'))
  dirs.push(dir)
  return dir
}

describe('EAB 单写进程锁', () => {
  it('同一数据目录第二个进程被拒绝，释放后可以重新获取', () => {
    const dir = tempDir()
    const dbPath = join(dir, 'eab.db')
    const first = acquireProcessLock(dir, dbPath)
    expect(first.info.pid).toBe(process.pid)
    expect(existsSync(first.path)).toBe(true)
    expect(readFileSync(first.path, 'utf8')).toContain(String(process.pid))

    expect(() => acquireProcessLock(dir, dbPath)).toThrow(ProcessLockError)
    first.release()
    expect(existsSync(first.path)).toBe(false)

    const second = acquireProcessLock(dir, dbPath)
    second.release()
  })

  it('进程异常退出留下的失效锁会被清理', () => {
    const dir = tempDir()
    const dbPath = join(dir, 'eab.db')
    const lockPath = join(dir, 'eab-server.lock')
    writeFileSync(lockPath, JSON.stringify({ pid: 999999999, startedAt: 1, dbPath }), 'utf8')

    const lock = acquireProcessLock(dir, dbPath)
    expect(lock.info.pid).toBe(process.pid)
    lock.release()
  })
})
