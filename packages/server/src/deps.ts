import type { Db } from '@eab/storage'
import type { ServerConfig } from './config.js'

export interface ServerDeps {
  readonly db: Db
  readonly config: ServerConfig
  readonly companyId: string
  readonly migrations: readonly string[]
  /** 解析后的控制台口令（环境变量优先；本机演示自动生成） */
  readonly consoleToken: string
  /** 控制台确认更新后的优雅退出；由 main.ts 注入 */
  readonly shutdown?: () => void
}
