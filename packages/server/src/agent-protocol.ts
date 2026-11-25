/**
 * Agent 团队的协议中立核心类型。
 *
 * 这里不出现 MCP / A2A / ACP 的运行时对象，只定义团队内部统一使用的任务阶段、
 * 产物引用和预算；外部协议在适配层做翻译。
 *
 * 设计边界：
 * - `status` 仍是原有 5 个生命周期，不扩 CHECK 约束；
 * - `phase` 表达暂停/拒绝原因，和 `status` 正交；
 * - 所有 JSON 字段在写入前归一化，读取时容错，避免旧任务/坏数据把团队面板打崩。
 */

export const TASK_PHASES = ['none', 'input_required', 'auth_required', 'rejected'] as const
export type TaskPhase = (typeof TASK_PHASES)[number]

export type ProtocolTaskStatus =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'

export interface TaskBudget {
  maxTokens?: number
  maxCostMicros?: number
  maxDurationMs?: number
  maxRounds?: number
}

export const ARTIFACT_SOURCES = ['workspace', 'cloud', 'inline', 'mcp', 'a2a'] as const
export type ArtifactSource = (typeof ARTIFACT_SOURCES)[number]

export interface AgentArtifactRef {
  id: string
  name: string
  mimeType: string
  size: number
  checksum: string
  source: ArtifactSource
  uri: string
  /** 工作区/云空间文件 id；前端复用现有文件预览时直接打开它 */
  fileId?: string
  preview?: string
}

export function isTaskPhase(value: unknown): value is TaskPhase {
  return typeof value === 'string' && (TASK_PHASES as readonly string[]).includes(value)
}

export function normalizeTaskPhase(value: unknown, fallback: TaskPhase = 'none'): TaskPhase {
  return isTaskPhase(value) ? value : fallback
}

/**
 * 把内部生命周期 + 暂停原因合成对外可读状态。
 * A2A 适配器只需要调用这一处，团队面板也用同一个口径。
 */
export function protocolStatusOf(
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled',
  phase: TaskPhase,
): ProtocolTaskStatus {
  if (phase === 'rejected') return 'rejected'
  if (phase === 'input_required') return 'input-required'
  if (phase === 'auth_required') return 'auth-required'
  if (status === 'queued') return 'submitted'
  if (status === 'running') return 'working'
  if (status === 'succeeded') return 'completed'
  if (status === 'cancelled') return 'canceled'
  return 'failed'
}

function positiveInteger(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

/** 预算只接受正整数；未知或坏值丢弃，不让一个负数把执行器卡死。 */
export function parseTaskBudget(value: unknown): TaskBudget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const budget: TaskBudget = {}
  const maxTokens = positiveInteger(raw.maxTokens)
  if (maxTokens !== undefined) budget.maxTokens = maxTokens
  const maxCostMicros = positiveInteger(raw.maxCostMicros)
  if (maxCostMicros !== undefined) budget.maxCostMicros = maxCostMicros
  const maxDurationMs = positiveInteger(raw.maxDurationMs)
  if (maxDurationMs !== undefined) budget.maxDurationMs = maxDurationMs
  const maxRounds = positiveInteger(raw.maxRounds)
  if (maxRounds !== undefined) budget.maxRounds = maxRounds
  return budget
}

function safeString(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function sizeLabel(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '大小未知'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function checksumLabel(checksum: string): string {
  if (!checksum) return '无校验和'
  const [algorithm, digest] = checksum.split(':')
  if (digest) return `${algorithm}:${digest.slice(0, 16)}…`
  return checksum.slice(0, 24)
}

/**
 * 父 Agent 看到的单条产物摘要：名称、类型、大小、校验和、句柄和预览。
 * 预览只放登记时的短摘要，不复制文件全文。
 */
export function artifactBrief(artifact: AgentArtifactRef): string {
  const idPart = artifact.fileId
    ? `，fileId:${artifact.fileId}`
    : artifact.uri
      ? `，uri:${artifact.uri.slice(0, 160)}`
      : ''
  const preview = artifact.preview ? `；预览：${artifact.preview}` : ''
  return `${artifact.name}（${artifact.mimeType || '未知类型'}，${sizeLabel(artifact.size)}，${checksumLabel(artifact.checksum)}${artifact.source === 'a2a' ? '，A2A' : ''}${idPart}）${preview}`
}

export function artifactManifest(artifacts: readonly AgentArtifactRef[], limit = 6): string {
  if (artifacts.length === 0) return ''
  const shown = artifacts.slice(0, limit)
  const more = artifacts.length > shown.length ? `；另有 ${artifacts.length - shown.length} 个产物未展开` : ''
  return shown.map(artifactBrief).join('；') + more
}

/** 产物引用统一结构；缺 id/name/uri 的条目直接丢弃，避免空卡。 */
export function parseAgentArtifacts(value: unknown): AgentArtifactRef[] {
  if (!Array.isArray(value)) return []
  const artifacts: AgentArtifactRef[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const raw = item as Record<string, unknown>
    const id = safeString(raw.id, 128)
    const name = safeString(raw.name, 256) || id
    const uri = safeString(raw.uri, 2000)
    if (!id || !uri) continue
    const source = typeof raw.source === 'string' && (ARTIFACT_SOURCES as readonly string[]).includes(raw.source)
      ? raw.source as ArtifactSource
      : 'workspace'
    const size = Number(raw.size)
    const mimeType = safeString(raw.mimeType, 128) || 'application/octet-stream'
    const preview = safeString(raw.preview, 500) || `${name}（${mimeType}）`
    artifacts.push({
      id,
      name,
      mimeType,
      size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : 0,
      checksum: safeString(raw.checksum, 128),
      source,
      uri,
      ...(safeString(raw.fileId, 128) ? { fileId: safeString(raw.fileId, 128) } : {}),
      preview,
    })
  }
  return artifacts
}

/** 旧任务没有这些列时，读取侧统一回落到空数组。 */
export function parseAgentArtifactJson(value: unknown): AgentArtifactRef[] {
  if (typeof value === 'string') {
    if (!value.trim()) return []
    try {
      return parseAgentArtifacts(JSON.parse(value))
    } catch {
      return []
    }
  }
  return parseAgentArtifacts(value)
}
