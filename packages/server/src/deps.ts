import type { Db } from '@eab/storage'
import type { ServerConfig } from './config.js'
import type { ChatCapacity } from './chat-capacity.js'
import type { NetworkApplyResult, NetworkTarget } from './network-settings.js'
import type { BackendRuntime } from './backends/runtime.js'

export interface ServerDeps {
  readonly db: Db
  readonly config: ServerConfig
  readonly companyId: string
  readonly migrations: readonly string[]
  /** 可选后端插件状态（SQLite 内置 + Redis/PG 外部）；测试可不注入 */
  readonly backends?: BackendRuntime
  /** 解析后的控制台口令（环境变量优先；本机演示自动生成） */
  readonly consoleToken: string
  /** 网页对话全局并发/排队闸门；buildApp 时按配置创建，测试可注入替身 */
  readonly chatCapacity?: ChatCapacity
  /** 控制台确认更新后的优雅退出；由 main.ts 注入 */
  readonly shutdown?: () => void
  /** 控制台保存监听地址/端口后重建监听；由 main.ts 注入，测试环境没有时只写设置。 */
  readonly applyNetwork?: (next: NetworkTarget) => Promise<NetworkApplyResult> | NetworkApplyResult
}
