/**
 * 可选后端插件：SQLite 是默认内置存储，PostgreSQL / Redis 是外部增强。
 *
 * 约束：
 * - 没有外部服务时，EAB 必须照常启动并使用内置能力；
 * - 外部后端连接失败默认只降级，不阻塞启动；只有显式 strict 才失败；
 * - 状态只暴露能力与健康，不回显连接串、密码。
 */
export type BackendKind = 'cache' | 'storage'

export type BackendState = 'ready' | 'degraded' | 'disabled' | 'failed'

export interface BackendStatus {
  readonly id: string
  readonly kind: BackendKind
  readonly label: string
  readonly mode: 'builtin' | 'external'
  readonly state: BackendState
  readonly detail: string
  readonly capabilities: readonly string[]
  readonly metrics?: Readonly<Record<string, number | string>>
}

export interface BackendHandle {
  readonly id: string
  status(): BackendStatus
  close(): Promise<void>
}
