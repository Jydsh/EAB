/**
 * 可在线切换的 SQLite 连接。
 *
 * 存储位置保存后不再要求重启：先用 `VACUUM INTO` 生成一致性快照，
 * 校验目标库后在一个同步代码段里完成“写设置 + 切连接”。
 * 旧连接不立即 close——已经拿在手里的 Statement 还能安全读完；
 * 但切到只读，避免切库后的迟到写落进旧库。
 */
import { closeSync, existsSync, mkdirSync, openSync, readSync } from 'node:fs'
import { dirname } from 'node:path'
import { openDatabase, type Db } from '@eab/storage'
import { EC, EabError } from '@eab/domain'

export interface PreparedDatabase {
  readonly db: Db
  /** 原子地把当前连接指向新库；调用后旧库变只读并保留到进程退出。 */
  activate(): void
  /** 放弃本次准备：关闭新库，当前连接不受影响。 */
  discard(): void
}

export class LiveDatabase {
  readonly db: Db
  private current: Db
  private currentPath: string
  private retired: Db[] = []

  constructor(initialPath: string) {
    this.current = openDatabase({ path: initialPath })
    this.currentPath = initialPath
    const self = this
    this.db = new Proxy({} as Db, {
      get(_target, property) {
        const value = Reflect.get(self.current as unknown as object, property)
        return typeof value === 'function' ? value.bind(self.current) : value
      },
      set(_target, property, value) {
        Reflect.set(self.current as unknown as object, property, value)
        return true
      },
      has(_target, property) {
        return property in (self.current as unknown as object)
      },
    })
  }

  get path(): string {
    return this.currentPath
  }

  /** 生成目标库快照；目标文件必须尚不存在。 */
  snapshotTo(targetPath: string): void {
    mkdirSync(dirname(targetPath), { recursive: true })
    try {
      this.current.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // checkpoint 遇到长读事务时可能忙；VACUUM INTO 自己仍会读取一致性快照。
    }
    const escaped = targetPath.replace(/'/g, "''")
    this.current.exec(`VACUUM INTO '${escaped}'`)
  }

  /**
   * 打开并校验目标库，但先不切换。
   * 调用方可以在这之后写设置文件，再调用 activate()，两步都在同一个同步段里。
   */
  prepareAt(targetPath: string): PreparedDatabase {
    if (!existsSync(targetPath)) {
      throw new EabError(EC.VALIDATION, `目标数据库不存在：${targetPath}`)
    }
    let header = Buffer.alloc(0)
    let fd: number | null = null
    try {
      fd = openSync(targetPath, 'r')
      header = Buffer.alloc(16)
      readSync(fd, header, 0, 16, 0)
    } catch (error) {
      throw new EabError(EC.VALIDATION, `目标数据库不可读：${(error as Error).message}`)
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // 只读校验句柄，关闭失败不影响后续判断
        }
      }
    }
    if (header.toString('latin1') !== 'SQLite format 3\u0000') {
      throw new EabError(EC.VALIDATION, `目标文件不是有效的 SQLite 数据库：${targetPath}`)
    }
    const next = openDatabase({ path: targetPath })
    try {
      const check = next.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined
      if (check?.integrity_check !== 'ok') {
        throw new EabError(EC.VALIDATION, `目标数据库完整性校验失败：${check?.integrity_check ?? '未知结果'}`)
      }
    } catch (error) {
      next.close()
      throw error
    }

    let activated = false
    return {
      db: next,
      activate: () => {
        if (activated) return
        activated = true
        const old = this.current
        this.current = next
        this.currentPath = targetPath
        this.retired.push(old)
        try {
          old.exec('PRAGMA query_only = ON')
        } catch {
          // 旧连接上如果还有未结束事务，只读开关可能失败；它已经不再被主连接使用。
        }
      },
      discard: () => {
        if (activated) return
        next.close()
      },
    }
  }

  close(): void {
    for (const db of [this.current, ...this.retired]) {
      try {
        db.close()
      } catch {
        // 退出阶段逐个关闭，单个失败不阻塞其它连接。
      }
    }
    this.retired = []
  }
}
