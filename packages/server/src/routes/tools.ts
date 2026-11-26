/**
 * 工具注册表（TOOL-01 ~ TOOL-06）。
 *
 * 注册的工具都有：id、中文名、说明、所需 scope、是否高危（需审批）、参数 JSON Schema。
 * 调用统一走 `POST /api/tools/:id/invoke`，先鉴权、再审批、再执行、再审计。
 * 不在本地执行任意脚本；工具白名单是代码常量，插件想加工具必须走插件清单。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative } from 'node:path'
import { EC, EabError, SC, ulid, type Scope } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import { assertScoped, buildScopeFilter, predicateToSql } from '@eab/authz'
import type { Db } from '@eab/storage'
import type { ToolParameterSchema } from '../llm.js'
import { safeJoin, isWithinRoot } from '@eab/workspace'
import { parseTabularText } from '../delimited.js'
import { buildXlsxFromTabular } from '../xlsx-create.js'
import type { ServerDeps } from '../deps.js'
import { ok, requireScope } from '../http.js'
import { resolveActor, type RequestActor } from '../session.js'
import { hashPassword } from '../password.js'
import { KeyedMutex, KeyedSemaphore, LockAbortedError, LockTimeoutError, SemaphoreQueueFullError, SemaphoreTimeoutError } from '../concurrency.js'
import { acquireCoordinationSlot, coordinationStatus, readCapacityCount } from '../backends/coordination.js'
import { beginToolInflight } from '../tool-inflight.js'
import {
  ensureToolApproval,
  requiresToolApprovalForArgs,
  toolApprovalPolicy,
  toolRisk,
  type ToolApprovalMode,
  type ToolApprovalPolicy,
  type ToolApprovalRequest,
  type ToolRisk,
} from '../tool-approval.js'
import {
  beginToolOperation,
  completeToolOperation,
  failToolOperation,
  resolveToolOperationKey,
} from '../tool-idempotency.js'
import { retrieveExternalKb } from '../kb-external.js'
import { getDocAsset } from '../kb-assets.js'
import { executePluginTool, pluginToolCatalogFor, pluginToolSpecsFor, pluginToolSpecsForQuery, prefersPersonalPluginTools, resolvePluginToolByCatalogId, invalidatePluginToolSpecsEverywhere } from '../plugin-tools.js'
import { mcpToolSpecsFor, resolveMcpToolForActor } from '../mcp-registry.js'
import { hasUsableA2APeers, delegateA2ATask, cancelA2ADelegation } from '../a2a-registry.js'
import { refreshPluginHosts } from '../plugin-host.js'
import { createPluginDevScaffold, installPluginDevBundle, normalizePluginDevId, pluginDevIdFromDir, pluginPreviewLink, PLUGIN_DEV_DIR } from '../plugin-dev.js'
import { createSkillDevScaffold, installSkillDevBundle, normalizeSkillDevId, skillDevIdFromDir, skillPreviewLink, SKILL_DEV_DIR } from '../skill-dev.js'
import {
  companySkillPolicy,
  ensureSkillInstallApproval,
  loadPersonalSkills,
  previewSkillInstall,
} from '../skills.js'
import { loadPersonalPluginsForUser } from '../plugins.js'
import {
  readToolRoleAccessMap,
  toolAllowedForActor,
  toolAllowedForRoles,
} from '../tool-role-access.js'
import type { ActiveSpace } from '../space.js'
import {
  resolveUserWorkspaceQuota,
  workspaceCapacity,
  workspaceUsedBytes,
} from '../workspace-quota.js'
import { CAPABILITY_TOOL_GROUPS, isSingleFileOfficeEdit, officeToolIdsForQuery, routeCapabilities } from '../capability-route.js'
import { getWeather } from '../weather.js'
import { webFetch } from '../web-fetch.js'
import { searchWeb } from '../web-search.js'
import { effectiveWebSearchEnv } from '../web-search-config.js'
import { assertWebToolRateLimit, type WebToolId } from '../web-rate-limit.js'
import { browserStatus, executeBrowserAction, type BrowserAction } from '../browser-session.js'
import { assertPublicHttpUrl } from '../net-policy.js'
import { browserNetworkSettingsView } from '../browser-network-config.js'
import { publishAgentArtifact } from '../agent-artifacts.js'
import {
  AGENT_PLAN_MAX_STEPS,
  updateAgentPlanStep,
  writeAgentPlan,
  type AgentPlanStepInput,
  type AgentPlanStepStatus,
} from '../agent-plan.js'
import type { AgentTeamStore } from '../agent-team.js'
import {
  MEMORY_TYPE_LABELS,
  embedMemoryRow,
  findMemoryDuplicateOrConflict,
  findStructuredFactConflict,
  memoryLooksSensitive,
  memoryStatus,
  normalizeFactKey,
  normalizeMemoryType,
  type MemoryType,
} from '../memory-os.js'
import { memoryAutoConfirmEnabled, personalMemoryAutoActivates, structuredFactFromContent } from '../memory-extractor.js'
import { DINGTALK_OUTBOUND_FILE_LIMIT_BYTES, sendDingTalkFileToUser } from '../dingtalk-outbound.js'
import { sendDingTalkFileToConversation, uploadFileToUserDrive } from '../dingtalk-drive.js'
import {
  createRobotUserFileSend,
  markRobotUserFileSendFailed,
  markRobotUserFileSendSent,
} from '../dingtalk-file-echo.js'
import {
  applyWorkspaceTextEdits,
  buildWorkspaceEditDiff,
  createWorkspaceFileSnapshot,
  createUserWorkspaceFolder,
  deleteUserWorkspaceFile,
  deleteUserWorkspaceFolder,
  exportWorkspaceFileToPdf,
  getWorkspaceGuiFallback,
  isTextEditableFile,
  listWorkspaceFileVersions,
  prepareWorkspaceGuiFallback,
  publishWorkspaceFilesChanged,
  readUserWorkspaceFile,
  renameUserWorkspaceFile,
  renameUserWorkspaceFolder,
  reportWorkspaceGuiFallback,
  restoreWorkspaceFileVersion,
  saveUserWorkspaceFile,
  editUserWorkspaceFile,
  userScopeDir,
  workspaceFolderSummaries,
  type WorkspaceTextEdit,
} from './workspace.js'
import { generateImageToWorkspace } from './content.js'
import { countTextLines, readTextFileRange, searchWorkspaceText, type TextRangeResult, type TextSearchResult } from '../workspace-text.js'
import { saveTextBatch } from '../batch-results.js'
import { analyzeWorkspaceFile } from '../workspace-analyze.js'
import {
  type LocalProject,
} from '../local-project.js'
import {
  deleteProjectEntry,
  editProjectText,
  listProjectEntries,
  readProjectText,
  searchProjectText,
  writeProjectText,
} from '../project-files.js'
import {
  assertProjectExecEnabled,
  killProjectJob,
  listProjectJobs,
  parseProjectCommandAllowlist,
  projectSandboxCapability,
  readProjectJob,
  resolveProjectExecMode,
  runProjectCommand,
  startProjectJob,
} from '../project-runner.js'
import { createSchedule, deleteSchedule, listSchedules } from '../schedule.js'
import {
  addDocxComment,
  addXlsxCellComment,
  appendXlsxSheet,
  applyDocxRevisions,
  deleteDocxComment,
  deleteDocxTable,
  deleteXlsxCellComment,
  deleteXlsxSheet,
  findInOutline,
  findInPptx,
  findInXlsx,
  formatDocxText,
  formatXlsxCell,
  formatXlsxDimension,
  insertDocxTable,
  insertDocxText,
  insertXlsxColumn,
  insertXlsxRow,
  mergeDocxTableCells,
  readDocxComments,
  readDocxOutline,
  readDocxRange,
  readDocxRevisions,
  readDocxTrackChanges,
  readPptxOutline,
  readXlsxComments,
  readXlsxOutline,
  replyDocxComment,
  replaceDocxText,
  rewriteDocxElementText,
  replacePptxText,
  replaceXlsxCellText,
  resolveDocxComment,
  setDocxTrackChanges,
  splitDocxTableMergedCells,
} from '../office-content.js'

export interface ToolDef {
  id: string
  name: string
  description: string
  scope: Scope
  dangerous: boolean
  input: Record<string, Omit<ToolParameterSchema, 'required'> & { required?: boolean }>
  /** 并发属性：read 只读；write 按资源键互斥；exclusive 全局/公司级互斥。默认 read */
  concurrency?: 'read' | 'write' | 'exclusive'
  /**
   * 风险分级。不填时按 id / dangerous / concurrency 推导：
   * project.exec 等为 exec，删除/发消息/改密码为 irreversible，普通写入为 write。
   */
  risk?: ToolRisk
  /** 显式覆盖审批策略；高危工具默认 always，普通工具 never。 */
  approval?: ToolApprovalPolicy
  /** 互斥资源键；返回 null 表示该次调用不需要加锁 */
  lockKey?: (
    deps: ServerDeps,
    actor: RequestActor,
    args: Record<string, unknown>,
    space: ActiveSpace,
  ) => string | null
  /** 是否对外部副作用做幂等去重；只对发送、删除、改名、建任务这类不可重复动作开启。 */
  idempotent?: boolean
}

export interface ToolExecutionContext {
  /** 当前对话的会话 id；定时任务创建时用它绑定结果回到哪个会话 */
  sessionId?: string
  /** 当前入口：web / dingtalk 等，决定定时任务默认回推通道 */
  channel?: 'web' | 'dingtalk'
  /** 用户停止生成时用它中断等待中的资源锁 */
  signal?: AbortSignal
  /** 一次用户消息内的 Agent 回合 id；同一回合重复调用按参数去重 */
  turnId?: string
  /** 当前 Agent run 的 trace id；A2A 远端任务沿用它回写映射 */
  traceId?: string
  /** 调用方显式提供的幂等键，优先于 turnId */
  idempotencyKey?: string
  /**
   * 右侧预览/编辑中的文件。模型漏传 fileId、path 时用它兜底，
   * 避免「明明开着文件还要反问是哪个文件」。
   */
  activeFile?: { id: string; relPath?: string }
  /**
   * 发起本轮对话的桌面客户端设备 id。
   * 只有桌面页面会带 x-eab-desktop-device；浏览器工具据此把动作路由到右侧原生标签页。
   */
  desktopDeviceId?: string
  /** 当前子 Agent 的任务行；只有子 Agent 轮次才有，用于产物登记 */
  agentTaskId?: string
  /** 当前会话的团队存储；产物登记和 trace 归属都从这里取 */
  agentTeam?: AgentTeamStore
  /**
   * 工具审批模式：
   * wait=网页聊天，生成待办后推送卡片并等待；defer=返回待办 id；
   * bypass=已由入口完成权限校验的内部路径。默认 defer（测试环境为 bypass）。
   */
  approval?: ToolApprovalMode
  /** 直接工具 API 在管理员审批后带回的审批 id。 */
  approvalId?: string
  /** 当前 assistant 消息 id；审批卡片用它定位聊天气泡。 */
  messageId?: string
  /** 审批待办产生时回调，聊天入口用它发布 SSE。 */
  onApprovalPending?: (request: ToolApprovalRequest) => void
}

/**
 * 工具参数声明保留 JSON Schema 结构：除了普通字符串参数，也允许澄清选项这类数组参数。
 * 这里只描述发给模型的 schema，实际参数仍由各工具自行校验。
 */
export type ChatToolParameterSchema = ToolParameterSchema

export interface ChatToolSpec {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, ChatToolParameterSchema>
      required: string[]
      additionalProperties: false
    }
  }
}

type Actor = ReturnType<typeof resolveActor>

/** 文件名纠错只做空白差异匹配；不做模糊相似度，避免把模型带到另一个文件。 */
function nearestWorkspacePath(deps: ServerDeps, actor: RequestActor, rawPath: string): string | null {
  const normalized = rawPath.replace(/[\s\u3000]+/g, '').replace(/\\/g, '/').toLowerCase()
  if (!normalized) return null
  const rows = deps.db
    .prepare(
      'SELECT name, rel_path FROM workspace_files WHERE company_id = ? AND owner_user_id = ? AND deleted_at IS NULL',
    )
    .all(actor.subject.companyId, actor.subject.userId) as unknown as Array<{ name: string; rel_path: string }>
  const matches = rows.filter((row) => {
    const rel = String(row.rel_path || '').replace(/\\/g, '/')
    const name = String(row.name || '')
    return rel.replace(/[\s\u3000]+/g, '').toLowerCase() === normalized
      || name.replace(/[\s\u3000]+/g, '').toLowerCase() === normalized
  })
  return matches.length === 1 ? matches[0].rel_path : null
}

/**
 * 工具级资源锁。只在当前 EAB 进程内有效，用于挡住“同一文件/同一任务被两个 Agent
 * 同时读改写”。跨进程部署需要换成数据库/Redis 锁（见 P0-4）。
 */
export const toolResourceLocks = new KeyedMutex()

/** 工具级并发名额；不同工具互不占名额，同一工具超过上限时排队。 */
export const toolSemaphore = new KeyedSemaphore()

interface ToolMetric {
  runs: number
  failures: number
  totalDurationMs: number
  maxDurationMs: number
  lockWaitMs: number
}

const toolMetrics = new Map<string, ToolMetric>()

/** 记录一次工具执行的耗时和锁等待，供 /metrics 与控制台并发面板读取。 */
export function recordToolRun(toolId: string, durationMs: number, status: 'ok' | 'failed' | 'replay', lockWaitMs: number): void {
  const item = toolMetrics.get(toolId) ?? { runs: 0, failures: 0, totalDurationMs: 0, maxDurationMs: 0, lockWaitMs: 0 }
  item.runs += 1
  if (status === 'failed') item.failures += 1
  item.totalDurationMs += Math.max(0, durationMs)
  item.maxDurationMs = Math.max(item.maxDurationMs, durationMs)
  item.lockWaitMs += Math.max(0, lockWaitMs)
  toolMetrics.set(toolId, item)
}

/**
 * 共享模式下把工具并发数从 Redis 读回来。
 *
 * 升级前控制台看到的是「本实例」的并发；多个实例各持一份，数字对不上实际负载。
 * 共享名额在 Redis 里是全局计数，这里按当前注册的工具逐个读回，让面板显示全局值。
 * 未接 Redis 时返回 null，调用方继续使用本实例统计。
 */
export async function sharedToolCapacityStats(): Promise<{
  total: number
  keys: Array<{ key: string; active: number; queued: number }>
} | null> {
  if (!coordinationStatus().shared) return null
  const keys = TOOLS.map((tool) => `tool:${tool.id}`)
  const counts = await Promise.all(keys.map((key) => readCapacityCount(key)))
  if (counts.every((count) => count === null)) return null
  const entries = keys
    .map((key, index) => ({ key, active: counts[index] ?? 0, queued: 0 }))
    .filter((item) => item.active > 0)
  return {
    total: entries.reduce((sum, item) => sum + item.active, 0),
    keys: entries,
  }
}

export function toolConcurrencyStats(): {
  active: number
  queued: number
  keys: ReadonlyArray<{ key: string; active: number; queued: number }>
  runs: number
  failures: number
  avgDurationMs: number
  maxDurationMs: number
  lockWaitMs: number
  byTool: ReadonlyArray<{ toolId: string; runs: number; failures: number; avgDurationMs: number; maxDurationMs: number; lockWaitMs: number }>
} {
  const semaphore = toolSemaphore.stats()
  const byTool = [...toolMetrics.entries()]
    .map(([toolId, item]) => ({
      toolId,
      runs: item.runs,
      failures: item.failures,
      avgDurationMs: item.runs ? Math.round(item.totalDurationMs / item.runs) : 0,
      maxDurationMs: item.maxDurationMs,
      lockWaitMs: item.lockWaitMs,
    }))
    .sort((a, b) => b.runs - a.runs)
  const runs = byTool.reduce((sum, item) => sum + item.runs, 0)
  const failures = byTool.reduce((sum, item) => sum + item.failures, 0)
  const totalDurationMs = [...toolMetrics.values()].reduce((sum, item) => sum + item.totalDurationMs, 0)
  return {
    ...semaphore,
    runs,
    failures,
    avgDurationMs: runs ? Math.round(totalDurationMs / runs) : 0,
    maxDurationMs: [...toolMetrics.values()].reduce((max, item) => Math.max(max, item.maxDurationMs), 0),
    lockWaitMs: [...toolMetrics.values()].reduce((sum, item) => sum + item.lockWaitMs, 0),
    byTool,
  }
}

function toolConcurrencyLimit(tool: ToolDef, deps: ServerDeps): number {
  const max = Math.max(1, deps.config.toolMaxConcurrent ?? 8)
  if (tool.concurrency === 'exclusive') return 1
  // 写工具通常还要拿资源锁，名额比读工具少，避免大量写一起排队抢锁。
  if (tool.concurrency === 'write') return Math.max(1, Math.min(4, max))
  return max
}

function workspaceFileLockKey(
  deps: ServerDeps,
  actor: RequestActor,
  args: Record<string, unknown>,
): string {
  const companyId = actor.subject.companyId
  const userId = actor.subject.userId
  let path = String(args.path ?? '').trim()
  const fileId = String(args.fileId ?? '').trim()
  const imageUrl = String(args.url ?? '').trim()
  if (!path && !fileId && imageUrl) path = imageUrl
  if (!path && fileId) {
    const row = deps.db
      .prepare('SELECT rel_path FROM workspace_files WHERE id = ? AND company_id = ? AND owner_user_id = ? AND deleted_at IS NULL')
      .get(fileId, companyId, userId) as { rel_path: string } | undefined
    path = row?.rel_path ?? `id:${fileId}`
  }
  if (path && fileId) {
    // 同时给了 fileId 和 path 时以真实元数据路径为准，避免两种写法锁不到一起。
    const row = deps.db
      .prepare('SELECT rel_path FROM workspace_files WHERE id = ? AND company_id = ? AND owner_user_id = ? AND deleted_at IS NULL')
      .get(fileId, companyId, userId) as { rel_path: string } | undefined
    if (row?.rel_path) path = row.rel_path
  }
  if (path && !fileId) {
    const row = deps.db
      .prepare(
        `SELECT rel_path FROM workspace_files
          WHERE company_id = ? AND owner_user_id = ? AND deleted_at IS NULL
            AND (rel_path = ? OR name = ?)
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(companyId, userId, path, path) as { rel_path: string } | undefined
    if (row?.rel_path) path = row.rel_path
  }
  return `workspace:file:${companyId}:${userId}:${path || 'unknown'}`
}

function scheduleCreateLockKey(actor: RequestActor): string {
  return `schedule:create:${actor.subject.companyId}:${actor.subject.userId}`
}

function scheduleDeleteLockKey(actor: RequestActor, args: Record<string, unknown>): string {
  return `schedule:delete:${actor.subject.companyId}:${actor.subject.userId}:${String(args.id ?? 'unknown')}`
}

export function adminPasswordLockKey(actor: RequestActor, args: Record<string, unknown>): string {
  return `admin:password:${actor.subject.companyId}:${String(args.userId ?? 'unknown')}`
}

const DINGTALK_IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
}

function dingTalkImageMimeOf(name: string, mime?: string | null): string | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  const byExt = ext ? DINGTALK_IMAGE_MIME_BY_EXT[ext] : undefined
  if (!byExt) return null
  return mime && /^image\//i.test(mime) ? mime : byExt
}

interface WorkspaceImageFile {
  readonly name: string
  readonly relPath: string
  readonly size: number
  readonly mime: string
  readonly buffer: Buffer
}

/** 知识库图片在对话里是相对地址；钉钉客户端没有 EAB 的登录态和域名，不能直接加载。 */
function kbAssetRefOf(raw: string): { docId: string; assetId: string } | null {
  let pathname = raw
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) pathname = new URL(raw).pathname
  } catch {
    return null
  }
  const clean = pathname.split('?')[0]?.split('#')[0] ?? ''
  const match =
    clean.match(/^\/api\/kb\/assets\/([^/]+)\/([^/]+)\/?$/) ??
    clean.match(/^\/api\/console\/kb\/docs\/([^/]+)\/assets\/([^/]+)\/?$/)
  if (!match) return null
  return { docId: decodeURIComponent(match[1]!), assetId: decodeURIComponent(match[2]!) }
}

/**
 * 发送图片时允许读取个人云空间里已落盘、但还没登记进 workspace_files 的文件。
 * `project.exec`、图片导出等工具会直接把 PNG/JPG 写在用户工作区，模型拿到的是
 * 相对路径；如果只查元数据表，这些图片会被误判成“云空间里没有”。
 * 只读、只允许图片、限制在用户自己的云空间根目录内，符号链接也做了真实路径校验。
 */
function readWorkspaceImageFileByPath(
  deps: ServerDeps,
  actor: RequestActor,
  rawPath: string,
): WorkspaceImageFile {
  const root = userScopeDir(deps, actor.subject.companyId, actor.subject.userId)
  if (!existsSync(root)) {
    throw new EabError(EC.NOT_FOUND, `云空间里没有找到文件: ${rawPath}`)
  }
  const rootReal = realpathSync(root)
  const normalized = rawPath.replace(/\\/g, '/')
  let candidate: string
  if (isAbsolute(rawPath)) {
    const rel = relative(rootReal, rawPath)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new EabError(EC.FORBIDDEN, '图片必须位于当前员工的个人云空间内')
    }
    candidate = safeJoin(rootReal, rel)
  } else {
    candidate = safeJoin(rootReal, normalized)
  }
  if (!existsSync(candidate)) {
    throw new EabError(EC.NOT_FOUND, `云空间里没有找到文件: ${rawPath}`)
  }
  const real = realpathSync(candidate)
  if (!isWithinRoot(rootReal, real)) {
    throw new EabError(EC.FORBIDDEN, '图片必须位于当前员工的个人云空间内')
  }
  const stat = statSync(real)
  if (!stat.isFile()) throw new EabError(EC.VALIDATION, `不是文件: ${rawPath}`)
  const mime = dingTalkImageMimeOf(real)
  if (!mime) {
    throw new EabError(EC.VALIDATION, '只有图片可以作为图片消息发送', {
      details: { path: rawPath },
      hint: '支持 png、jpg、jpeg、gif、bmp、webp；其它文件请用文件发送能力。',
    })
  }
  if (stat.size > DINGTALK_OUTBOUND_FILE_LIMIT_BYTES) {
    throw new EabError(EC.VALIDATION, '图片超过钉钉发送上限（20 MB），没有发出去', {
      details: { size: stat.size, limit: DINGTALK_OUTBOUND_FILE_LIMIT_BYTES },
      hint: '请压缩图片后再发送。',
    })
  }
  return {
    name: basename(real),
    relPath: relative(rootReal, real).replace(/\\/g, '/'),
    size: stat.size,
    mime,
    buffer: readFileSync(real),
  }
}

/**
 * 全文分析不是把整份文件塞进模型上下文，而是服务端分块读取后逐段分析再汇总。
 * 单次上限 2,000,000 字符，按 40,000 字符分块约 50 段，避免一次分析无限调用模型；
 * 小文件直接全文返回，让模型自己做精确核对。
 */
const WORKSPACE_ANALYZE_MAX_CHARS = 2_000_000
const WORKSPACE_ANALYZE_DIRECT_CHARS = 50_000

export const TOOLS: readonly ToolDef[] = [
  {
    id: 'tool.search',
    name: '搜索工具目录',
    description:
      '搜索当前员工可用的工具目录。当前对话只加载了常用工具；当需要文件/图片发送、重命名/删除、容量查询、定时任务管理、计算或插件能力等未直接列出的能力时，先调用本工具。query 用用户原话或中文/英文能力词（例如“发送文件到钉钉”“把图片发给我”“查看我的定时任务”“计算 (1200+300)/4”“plugin”）；返回匹配工具的名称、用途和参数，下一轮会自动加载这些工具，之后即可直接调用。不要因为工具列表里暂时没有就直接说做不到。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    input: {
      query: { type: 'string', description: '用户要完成的能力或场景关键词，支持中英文与工具 id 片段', required: true },
      limit: { type: 'number', description: '最多返回几个工具，默认 8，范围 1-12' },
    },
  },
  {
    id: 'time.now',
    name: '当前时间',
    description: '返回服务器当前时间（ISO 与本地时区），用于换算日程',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    input: {},
  },
  {
    id: 'weather.now',
    name: '查看天气',
    description:
      '查询指定城市或区县的当前天气和未来 1–7 天预报；返回温度、体感温度、湿度、降水、风速、天气现象、日出日落，数据来自 Open-Meteo。完整行政区名查不到时会自动回退到上级城市或去掉行政区后缀，并在 note 中说明数据口径；一次调用即可，不要因为第一个区县名没匹配就重复调用。用户没有说明地点时不要猜，先问城市。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'read',
    input: {
      location: {
        type: 'string',
        description: '城市或区县名，如“重庆”“渝北”“北京朝阳”；也支持“纬度,经度”坐标',
        required: true,
      },
      days: {
        type: 'number',
        description: '预报天数，默认 3，范围 1–7',
      },
    },
  },
  {
    id: 'web.search',
    name: '搜索互联网',
    description:
      '搜索公开互联网，返回标题、链接和摘要，适合“查一下最新政策/新闻/资料”。搜索服务由管理员配置；未配置时会返回明确提示，不要反复重试。搜到结果后如果用户需要原文或准确细节，再用 web.fetch 读取具体链接；不要根据摘要编造正文。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'read',
    input: {
      query: { type: 'string', description: '搜索关键词，尽量短而具体', required: true },
      count: { type: 'number', description: '返回条数，默认 5，范围 1–10' },
      freshness: { type: 'string', description: '时效：all / day / week / month，默认 all' },
      site: { type: 'string', description: '限定站点域名，例如 gov.cn' },
    },
  },
  {
    id: 'web.fetch',
    name: '读取网页',
    description:
      '读取一个公开网页或文本链接，提取标题、正文、发布时间和少量链接。用户给出 URL、要求总结链接/公告/文章时优先使用。只支持公网 http/https，不能访问内网、本机、带账号密码的链接，也不携带登录态；需要登录的页面让用户提供公开链接。返回 truncated=true 时可带 start 继续读同一页，不要重新抓一遍。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'read',
    input: {
      url: { type: 'string', description: '要读取的完整 http/https 链接', required: true },
      format: { type: 'string', description: 'text 返回正文（默认），html 返回原始 HTML' },
      maxChars: { type: 'number', description: '单次返回字符数，默认 6000，最大 20000' },
      start: { type: 'number', description: '从第几个字符继续读，配合 nextStart 使用' },
    },
  },
  {
    id: 'browser',
    name: '内置浏览器',
    description:
      '浏览器工具。桌面端会直接操作用户右侧已打开的浏览器标签页：action=list 先列出所有标签页及当前页；action=snapshot 不传 pageId 读取当前标签页标题、正文和可点击元素 ref；action=activate 切换标签页；action=open 在右侧新建标签并返回正文；action=click 按 ref 点链接/普通按钮；action=type 只在搜索框/文本框输入；action=scroll / back / forward / reload / navigate 操作当前页；action=screenshot 截图到个人云空间；action=close 关闭标签。用户说“这个网页/右侧页面/当前标签”时，先 list 或 snapshot，不要用 web.fetch 猜正文。不能提交表单、登录、上传下载、支付或执行任意脚本。网页端无桌面连接时回退服务端无头浏览器，除 open 外的动作要传 pageId；只看静态正文优先用 web.fetch。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'write',
    lockKey: (_deps, actor) => `browser:${actor.subject.companyId}:${actor.subject.userId}`,
    input: {
      action: {
        type: 'string',
        description: 'list / snapshot / activate / open / click / type / scroll / back / forward / reload / navigate / screenshot / close',
        required: true,
      },
      url: { type: 'string', description: 'action=open / navigate 时要打开的完整 http/https 链接' },
      pageId: { type: 'string', description: '目标标签页 id；桌面端省略时作用于当前标签页，网页端除 open 外必传' },
      ref: { type: 'string', description: 'snapshot 返回的元素引用，如 e1' },
      text: { type: 'string', description: 'action=type 时要输入的文字，最多 500 字' },
      direction: { type: 'string', description: 'action=scroll 方向：down（默认）/ up' },
      fullPage: { type: 'boolean', description: 'action=screenshot 是否截整页，默认 false' },
    },
  },
  {
    id: 'plan.write',
    name: '写任务计划',
    description:
      '复杂任务先写一份可跟踪的计划，最多 7 步，一步一个可验收动作。第一次调用省略 planKey 即创建；执行中要改计划时传上次返回的 planKey，系统会保留旧版本并生成新版本。单步问答、简单查询、单个小文件读写不要调用。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'write',
    lockKey: (_deps, actor, args) => `plan:${actor.subject.companyId}:${String(args.planKey ?? 'new').slice(0, 64)}`,
    input: {
      planKey: {
        type: 'string',
        description: '可选。改写已有计划时传上次返回的 planKey；新计划留空',
      },
      title: {
        type: 'string',
        description: '计划标题，例如“核对本月加班并出表”；最多 120 字',
      },
      steps: {
        type: 'array',
        description: `步骤数组，1–${AGENT_PLAN_MAX_STEPS} 项；每项含 title，可选 detail、owner、status`,
        required: true,
        minItems: 1,
        maxItems: AGENT_PLAN_MAX_STEPS,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', description: '这一步做什么，动词开头，最多 120 字' },
            detail: { type: 'string', description: '可选补充：输入、约束或验收标准' },
            owner: { type: 'string', description: '可选：负责的 Agent 角色或团队 key' },
            status: {
              type: 'string',
              description: '可选：初始状态，默认 pending',
              enum: ['pending', 'running', 'done', 'failed', 'skipped'],
            },
          },
          required: ['title'],
        },
      },
    },
  },
  {
    id: 'plan.step',
    name: '更新计划步骤',
    description:
      '执行中更新某一步的状态。每完成、失败或跳过一步就更新，不要都留到最后补。planKey 用 plan_write 返回的值，seq 从 1 开始；状态只允许 pending / running / done / failed / skipped，note 写一句结果或失败原因。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'write',
    lockKey: (_deps, actor, args) => `plan:${actor.subject.companyId}:${String(args.planKey ?? 'latest').slice(0, 64)}`,
    input: {
      planKey: {
        type: 'string',
        description: '可选。默认取当前会话最新计划；多计划并存时传 plan_write 返回的 planKey',
      },
      seq: {
        type: 'number',
        description: '要更新的步骤序号，从 1 开始',
        required: true,
      },
      status: {
        type: 'string',
        description: '新状态',
        required: true,
        enum: ['pending', 'running', 'done', 'failed', 'skipped'],
      },
      note: {
        type: 'string',
        description: '可选：一句结果摘要或失败原因，最多 500 字',
      },
    },
  },
  {
    id: 'agent.spawn',
    name: '并行子 Agent',
    description:
      '把复杂任务拆成 1–4 个互不依赖的子任务并行执行；能并行的检索、分析、实现/验收优先多派，单主线才派 1 个，不要反问用户派几个。单个文件的小范围读写不要派；文件修改子任务必须包含定位、写入和复读验收，不能只派只读定位。子任务不得互相依赖，父 Agent 统一汇总；工程任务要写具体测试/构建命令并自测。每会话最多 8 个活跃岗位。前台实质任务优先 background:true，派完一句话说明编队。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'read',
    input: {
      tasks: {
        type: 'string',
        description: 'JSON 数组字符串；每项必填 prompt（目标/输入/约束/验收，≤150 字），可选 key、role（producer/critic/researcher/builder/worker）、title、parentKey、acceptance、pinned、modelId、retries、budget（{maxTokens,maxDurationMs,maxRounds}，只能收紧岗位卡上限）',
        required: true,
      },
      background: {
        type: 'boolean',
        description: 'true=后台执行并立即返回 taskId，父 Agent 可结束本回合；默认 false 同步等待。前台实质任务传 true',
      },
    },
  },
  {
    id: 'agent.retire',
    name: '收掉子 Agent 岗位',
    description:
      '父 Agent 专用。把一个不再需要的子 Agent 岗位软注销：它不再出现在活跃花名册、不占团队容量，但 worker 行和上下文消息会保留 24 小时，保留期内仍可用 agent_task 用同一个 key 复活。running 或 pinned 的岗位默认不能收，确实要强收传 force:true；一般只在任务收口、岗位合并、或团队容量已满时使用。评审链里的 critic 不要提前收掉。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'write',
    input: {
      agent: { type: 'string', description: '要收掉的子 Agent 团队 key', required: true },
      reason: { type: 'string', description: '可选：为什么收掉这个岗位，例如“评审已收口”“合并到 builder”' },
      force: {
        type: 'boolean',
        description: '可选：true 表示连 running 或 pinned 岗位也强制注销；会取消它当前排队/执行中的任务',
      },
    },
  },
  {
    id: 'agent.publish_artifact',
    name: '登记任务产物',
    description:
      '子 Agent 专用。把本次任务真正交付给用户的东西登记为产物，父 Agent、团队面板和后续 trace 会看到同一个引用；只登记元数据，不复制文件。工作区文件用 path（相对个人云空间根），已有文件用 fileId，外部 MCP/A2A/网页链接用 uri + name。多个产物分多次调用。登记不会自动发给用户，最终仍要在回报正文里说明哪个产物对应哪项交付。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'write',
    input: {
      path: { type: 'string', description: '个人云空间内的相对路径，例如 reports/巡检周报.md；与 fileId、uri 三选一' },
      fileId: { type: 'string', description: '个人云空间文件 id；与 path、uri 三选一' },
      uri: { type: 'string', description: '外部产物 uri，支持 mcp: / a2a: / https: / http: / eab:；与 path、fileId 三选一' },
      name: { type: 'string', description: '展示名称；用 uri 登记时必填，文件可省略并用真实文件名' },
      mimeType: { type: 'string', description: '可选：外部 uri 的媒体类型；不传时按文件扩展名推断，仍未知则记为 text/uri-list' },
      preview: { type: 'string', description: '可选：交付摘要，最多 500 字；不传时文本文件自动截取开头、二进制文件自动生成元数据摘要' },
    },
  },
  {
    id: 'review.verdict',
    name: '提交独立验收结论',
    description:
      '独立验收员专用。读完实现员交付和真实证据后，用本工具提交 approve 或 reject；只有 approve 且证据充分，任务状态机才会把实现任务标记成功。不要用正文口头通过代替本工具。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'write',
    input: {
      verdict: {
        type: 'string',
        description: 'approve=验收通过；reject=验收不通过，必须说明缺口',
        required: true,
      },
      reason: {
        type: 'string',
        description: '通过或不通过的关键依据，最多 2000 字',
        required: true,
      },
      evidence: {
        type: 'array',
        description: '实际检查过的证据，至少 1 条；每项写清命令、文件路径或测试结果',
        required: true,
        minItems: 1,
        maxItems: 8,
        items: { type: 'string', description: '一条具体证据，最多 600 字' },
      },
    },
  },
  {
    id: 'a2a.delegate',
    name: '派遣 A2A 远端 Agent',
    description:
      '把一个自包含任务交给公司已登记、已同步 Agent Card 的 A2A 远端 Agent，并等待它完成或暂停。只在可用岗位能力卡或 A2A 远端清单里出现 peer 时使用；不要把内部子任务改用远端 Agent，也不要用 agent_spawn 创建远端岗位。peer 原样填卡上的 id；skill 填技能 id，白名单要求时必须指定。远端返回 input-required/auth-required 时要把问题交给用户，不要自己编造答案。完成后按返回的 text 和 artifacts 汇总，不要复述远端内部推理。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'write',
    idempotent: true,
    lockKey: (_deps, actor, args) => `a2a:${actor.subject.companyId}:${String(args.peer ?? '').slice(0, 120)}`,
    input: {
      peer: { type: 'string', description: 'A2A 远端 Agent 的 peer id，可带 a2a: 前缀；来自能力卡或 a2a 清单', required: true },
      prompt: { type: 'string', description: '完整、自包含的委派目标、输入、约束和验收标准，最多 4000 字', required: true },
      skill: { type: 'string', description: '要使用的远端技能 id；配置了技能白名单时必填' },
      contextId: { type: 'string', description: '继续同一个远端上下文时填入上次返回的 contextId' },
      timeoutSeconds: { type: 'number', description: '最多等待多少秒，默认 120，范围 5–300；超时后任务保留，可再取消' },
    },
  },
  {
    id: 'a2a.cancel',
    name: '取消 A2A 远端任务',
    description:
      '取消一个 EAB 已派出的 A2A 远端任务。delegationId 用 a2a_delegate 返回的 delegationId；任务已完成、已取消或没有远端 taskId 时直接返回当前状态，不会重复发送取消。远端已经执行了不可逆动作时，取消不保证撤回外部副作用。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'write',
    input: {
      delegationId: { type: 'string', description: 'a2a_delegate 返回的本地任务 id', required: true },
    },
  },
  {
    id: 'agent.task',
    name: '继续派活给子 Agent',
    description:
      '给团队里已经存在的子 Agent 继续派一个新任务，复用同一个子 Agent 会话与同一个可视窗口，不需要重新创建。agent 必须填 agent.spawn 返回或此前事件里给出的 key。子 Agent 完成任务后如果没有再派新任务，会在空闲一段时间后自动注销；只要这个 key 仍有历史任务，系统会按同一个 key 自动恢复窗口和会话，不需要改用 agent_spawn。如果 key 已被软注销，保留期内 agent_task 仍可复活它。目标正在执行时，本工具返回 ok:false + suggestedTool=agent_message，不会重复派活；此时只追加约束请改用 agent_message，等它完成后再派下一件事。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'read',
    input: {
      agent: { type: 'string', description: '目标子 Agent 的团队 key', required: true },
      prompt: { type: 'string', description: '这次要它做的完整任务指令', required: true },
      background: {
        type: 'boolean',
        description: '可选：true 表示后台执行，立即返回 taskId；子 Agent 处于 waiting 时通常应同步等待它把本轮做完',
      },
    },
  },
  {
    id: 'agent.wait',
    name: '等待子 Agent 事件',
    description:
      '父 Agent 专用。后台子 Agent 完成任务、提出问题或失败时会产生事件；调用本工具等待下一个事件。网页前台对话不要使用：等待会占住当前会话，用户无法继续提问；后台完成会自动唤醒父 Agent。仅在没有自动唤醒的同步管理场景下使用。返回 event=null 表示超时。事件里的 key 可直接用于 agent_task 继续派活。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'read',
    input: {
      timeoutSeconds: {
        type: 'number',
        description: '最多等多少秒；默认 30，范围 1-120',
      },
    },
  },
  {
    id: 'agent.message',
    name: '给运行中的子 Agent 发指示',
    description:
      '父 Agent 专用。子 Agent 正在后台执行、还没有提出问题时，可追加一条方向性指示（例如“优先看 2025 年数据”“不要改原文件”）。子 Agent 会在下一轮工具循环前读到；它已经完成或正在等待回答时不要用本工具，改用 agent_task 继续派活。目标不是运行中时，本工具返回 ok:false + suggestedTool=agent_task + lastTask，不会抛错；不要重试同一条指示。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'read',
    input: {
      agent: { type: 'string', description: '目标子 Agent 的团队 key', required: true },
      text: { type: 'string', description: '要追加的指示，写清约束或优先级', required: true },
    },
  },
  {
    id: 'agent.resume',
    name: '从检查点继续子 Agent',
    description:
      '父 Agent 专用。某个子 Agent 的后台任务因为服务重启被打断、状态为 failed 且保留了检查点时，用本工具从上次进度继续，而不是从头再做。默认后台执行并立即返回新 taskId；如果没有可用检查点会明确报错，这时改用 agent_task 重新派活。已经成功完成的任务不要 resume，应派新任务。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'read',
    input: {
      agent: { type: 'string', description: '目标子 Agent 的团队 key', required: true },
      taskId: { type: 'string', description: '可选：指定要恢复的任务 id；不填则取该 key 最近一条任务' },
      background: {
        type: 'boolean',
        description: '可选：默认 true 后台续跑；false 则同步等待续跑结果',
      },
    },
  },
  {
    id: 'agent.ask_parent',
    name: '向父 Agent 提问',
    description:
      '只有子 Agent 可用。执行中发现缺少关键信息、需要用户授权或要父 Agent 做决策时，调用它把问题交给父 Agent。本轮会暂停并返回“等待父 Agent”；父 Agent 可以直接回答，也可以先向用户确认，然后用 agent_task 把答复发回来，你会在同一个会话里继续。不要用它代替普通工具调用，也不要在能自行判断时反复提问。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'read',
    input: {
      question: { type: 'string', description: '要父 Agent 回答或向用户确认的问题', required: true },
      context: { type: 'string', description: '可选：为什么需要这个信息、你已经做到哪一步、试过什么' },
      options: { type: 'string', description: '可选：2–3 个备选方向，用 | 分隔，便于父 Agent 拍板' },
      recommendation: { type: 'string', description: '可选：你建议走哪个方向及理由' },
    },
  },
  {
    id: 'agent.consult',
    name: '向团队同事发起协作',
    description:
      '只有子 Agent 可用。需要另一个同事已掌握的数据、产出或判断，或需要跨岗位协调时，调用它向主 Agent 提交协作申请，并写清想让谁配合、要什么、你已经做到哪一步。主 Agent 会决定直接答复你，还是先去协调目标同事。它和 agent_ask_parent 一样会让本轮暂停，主 Agent 答复后你在同一个会话里继续；能自己查到的不要用。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'read',
    input: {
      agent: { type: 'string', description: '希望配合的同事团队 key；不确定时可以写岗位描述', required: true },
      question: { type: 'string', description: '需要对方提供的信息、判断或产出', required: true },
      context: { type: 'string', description: '可选：你已经做到哪一步、为什么需要对方' },
      options: { type: 'string', description: '可选：2–3 个备选方向，用 | 分隔，便于主 Agent 拍板' },
      recommendation: { type: 'string', description: '可选：你建议走哪个方向及理由' },
    },
  },
  {
    id: 'schedule.create',
    name: '创建定时任务',
    description:
      '创建属于当前员工自己的定时提醒。它是挂在当前会话上的持久提醒，到点后会在原会话里自动跑一轮并把结果回复给用户。用户说“30 秒后提醒我 / 明天早上 8 点提醒我开会 / 每天 9 点把日报发我 / 每周一 10 点汇总上周数据 / 每 10 分钟检查一次”时调用。prompt 写到点要执行的完整任务。时间选择器优先级：after_seconds（多少秒后一次）> every_seconds（每多少秒，最少 300）> at（指定时间）> daily/weekly（日历规则）。不要自己计算绝对时间。',
    scope: SC.SCHEDULE_WRITE,
    dangerous: false,
    concurrency: 'write',
    lockKey: (_deps, actor) => scheduleCreateLockKey(actor),
    idempotent: true,
    input: {
      title: { type: 'string', description: '任务标题，最多 40 字；不填则用 prompt 前 20 字' },
      prompt: {
        type: 'string',
        description: '到点要执行的任务，写成完整一句话，例如“汇总上周安全防护记录并给出三点结论”',
        required: true,
      },
      mode: { type: 'string', description: 'once | daily | weekly | interval；给了 after_seconds/every_seconds 时可省略' },
      at: { type: 'string', description: 'once 用，例如 2026-11-10 09:00 或 2026-11-10T09:00:00+08:00' },
      time: { type: 'string', description: 'daily/weekly 用，HH:MM，例如 08:30' },
      days: { type: 'string', description: 'weekly 用，0=周日…6=周六，可写 1,3,5' },
      intervalMinutes: { type: 'string', description: 'interval 用，最小 5 分钟，例如 30' },
      afterSeconds: { type: 'string', description: '多少秒后触发一次（once），最少 30，例如 60' },
      everySeconds: { type: 'string', description: '每隔多少秒重复（interval），最少 300，例如 600' },
      timezone: { type: 'string', description: '时区，默认 Asia/Shanghai；一般不用填' },
      channel: { type: 'string', description: '结果回推通道：dingtalk（默认，回到当前员工钉钉）或 web（只落网页会话）' },
    },
  },
  {
    id: 'schedule.list',
    name: '查看我的定时任务',
    description: '列出当前员工自己创建的定时任务，返回标题、规则、下次执行时间、最近结果和失败原因。用户问“我有哪些定时任务/那个提醒还在吗”时调用。',
    scope: SC.SCHEDULE_READ,
    dangerous: false,
    input: {
      status: { type: 'string', description: '可选过滤：active | paused | done | error | cancelled | running' },
    },
  },
  {
    id: 'schedule.delete',
    name: '删除定时任务',
    description: '删除当前员工自己的一个定时任务，删除后不会再有后续触发。用户说“取消明天那个提醒/删掉那个任务/不要再发了”时调用；先用 schedule.list 找到 id。',
    scope: SC.SCHEDULE_WRITE,
    dangerous: false,
    concurrency: 'write',
    lockKey: (_deps, actor, args) => scheduleDeleteLockKey(actor, args),
    idempotent: true,
    input: {
      id: { type: 'string', description: 'schedule.list 返回的任务 id', required: true },
    },
  },
  {
    id: 'math.eval',
    name: '计算与汇总',
    description:
      '做四则运算，或对一组数字求和、平均、最小值、最大值。凡是回答里要出现“合计/总计/平均/共多少小时/共多少钱”，必须把每一项原值按顺序放进 values 再调用本工具，禁止心算或先四舍五入；只有单个算式时才用 expression。values 至少 3 项，两项数字的运算（如 总时长/人数）必须用 expression。values 只收一维数组，元素必须是数字或数字字符串（如 10.3、“10.3小时”、“10:18”）；不要传 [{label,value}] 这类带标签的对象数组，分组标签留在图表数据里，不要塞进 values。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    input: {
      expression: { type: 'string', description: '单个算式，例如 (1200+300)/4' },
      values: {
        type: 'array',
        description: '要汇总的一维数值数组，例如 [10.3, 7.75, 11, 11.4]；时长可写 10.3、10.3小时 或 10:18。不要传 {label,value} 对象',
        items: {
          type: 'string',
          description: '单个数字或时长字符串，例如 10.3、10.3小时、10:18；不要对象',
        },
        minItems: 3,
        maxItems: 500,
      },
    },
  },
  {
    id: 'org.directory',
    name: '组织通讯录（仅组织关系）',
    description:
      '仅查组织关系，不含手机号、身份证号、入职/转正日期、司龄、学历、籍贯、身高体重等人事档案字段。按对话意图查组织：intent=leader 查“我的组长/我的上级/我所在部门”；intent=me 查“我是谁/我在哪个部门”；intent=departments 查“公司有哪些部门/组织架构”；intent=members 查某个部门有谁（需要查看成员权限）；intent=search 按姓名/岗位关键字查人（需要查看成员权限）。返回部门、岗位、组长。用户问“某人的个人信息/个人档案/身份证/手机号/入职/学历/籍贯”时，不要用本工具回答，改用人员档案接口。',
    scope: SC.CHAT_USE,
    dangerous: false,
    input: {
      intent: {
        type: 'string',
        enum: ['leader', 'me', 'departments', 'members', 'search'],
        description: 'leader | me | departments | members | search，按用户问题选择',
        required: true,
      },
      query: { type: 'string', description: 'intent=members 时填部门名；intent=search 时填姓名/岗位关键字' },
    },
  },
  {
    id: 'org.search',
    name: '通讯录搜索（仅组织关系）',
    description: '仅按姓名/工号/岗位搜索本公司在职成员，返回部门与岗位；不含手机号、身份证号、入职/转正、学历、籍贯等人事档案字段。查完整人事资料请用人员档案接口。',
    scope: SC.ORG_MEMBER_READ,
    dangerous: false,
    input: { query: { type: 'string', description: '姓名或工号关键字', required: true } },
  },
  {
    id: 'kb.search',
    name: '知识库检索',
    description: '在当前用户可见的知识库里检索片段（与对话同一条可见性规则）',
    scope: SC.KB_READ,
    dangerous: false,
    input: { query: { type: 'string', description: '要检索的问题或关键词', required: true } },
  },
  {
    id: 'memory.propose',
    name: '记住偏好或团队规则',
    description:
      '把用户明确表达的长期记忆提炼成候选。用户说“记住我的偏好/以后给我这样回复/我习惯用这个格式”时，scopeType=user，写当前成员的个人记忆，高置信且不冲突会直接生效，不需要用户再去设置里确认，也不会共享给团队；只有与旧记忆冲突时才停下等本人确认。用户说“让团队都按这个规则/把这条经验分享给大家/记住这个规范”时，scopeType=company，提交管理员审核，通过后进入全公司上下文。只提交提炼后的规则，不要提交原始聊天、密码、手机号、身份证号、客户隐私或一次性任务内容。',
    scope: SC.MEMORY_WRITE,
    dangerous: false,
    input: {
      content: {
        type: 'string',
        description: '提炼后的可复用偏好、事实、规则或经验，一句话到一小段，最多 1000 字',
        required: true,
      },
      scopeType: {
        type: 'string',
        enum: ['user', 'company'],
        description: '记忆范围：user 只记到当前用户个人记忆，需本人确认；company 作为团队规则候选，需管理员确认。用户说“记住我/以后给我”用 user，说“让团队/大家”用 company',
      },
      memoryType: {
        type: 'string',
        enum: ['preference', 'fact', 'decision', 'episode'],
        description: '记忆类型：preference 偏好、fact 事实、decision 决策/口径、episode 一次任务情景；个人记忆默认 preference，团队规则默认 decision',
      },
      factKey: {
        type: 'string',
        description: '稳定事实键，仅当 memoryType=fact 时使用，例如 user.name、user.fear、project.eab.owner。同一范围同一 factKey 只保留一条有效事实；不同值会进入冲突确认，不静默覆盖',
      },
      subject: {
        type: 'string',
        description: '事实主语，例如“我”“张三”“EAB 项目”，最多 80 字',
      },
      predicate: {
        type: 'string',
        description: '事实谓词/属性，例如“姓名”“害怕”“负责人”，最多 80 字',
      },
      object: {
        type: 'string',
        description: '事实值，例如“小张”“狗”，最多 200 字；与 content 一起写入',
      },
      confidence: {
        type: 'number',
        description: '置信度 0–1；用户亲口明确说的事实用 0.95–1，模型推断不要提交',
      },
    },
  },
  {
    id: 'workspace.list',
    name: '列出我的文件和文件夹',
    description:
      '列出个人云空间里未删除的文件和文件夹。返回 folders（完整相对路径、名称、后代文件数）与 files（不含 .gitkeep 占位）；路径用 / 分隔，可直接传给 workspace.read / workspace.folder。',
    scope: SC.WORKSPACE_READ,
    dangerous: false,
    input: {},
  },
  {
    id: 'workspace.capacity',
    name: '个人云空间容量',
    description:
      '查询个人云空间的已用、总容量、剩余空间和容量预警等级。用户问“我还有多少空间/云空间快满了吗/还能不能放大文件”时调用；返回 remainingBytes、percent 和 warning.message，回答时优先给出剩余空间和预警原话。',
    scope: SC.WORKSPACE_READ,
    dangerous: false,
    input: {},
  },
  {
    id: 'content.generate_image',
    name: '生成图片',
    description:
      '按文字描述生成一张图片并保存到个人云空间，返回文件名、大小和下载地址。仅当用户明确要求画图、生成图片、做海报/插画/配图/头像时才调用；不要在普通问答、数据整理或文档写作中主动配图。生成不进入对话主链路，也不会把图片塞进模型上下文。支持 PNG/JPEG/WEBP/GIF。',
    scope: SC.WORKSPACE_WRITE,
    dangerous: false,
    concurrency: 'write',
    input: {
      prompt: { type: 'string', description: '图片描述，写清主体、风格、构图、配色和需要的文字', required: true },
      size: { type: 'string', description: '可选尺寸，格式 宽x高，例如 1024x1024、1024x1536；不填由模型默认' },
    },
  },
  {
    id: 'workspace.write',
    name: '写入工作区文件',
    description:
      '把一段文本写成个人工作区里的文件（同名覆盖）。如果文件已存在且只需要改其中某几段、某几个字段，优先调用 workspace.edit，不要整篇重写；只有新建文件或确实要整篇替换时才用本工具。' +
      '写 .xlsx 时服务端会把 CSV/TSV、Markdown 表格、JSON 记录或逐行文本转换成真实 Excel 工作簿，不再把纯文本冒充 xlsx。' +
      'docx/pptx/xls/xlsm 不能用本工具生成；需要多列表格时优先写 .csv/.tsv 文本。成功后只说明文件名和结果，不要重复粘贴文件正文，界面会展示文件内容预览。',
    scope: SC.WORKSPACE_WRITE,
    dangerous: false,
    concurrency: 'write',
    lockKey: (deps, actor, args) => workspaceFileLockKey(deps, actor, args),
    input: {
      path: { type: 'string', description: '相对路径，例如 notes/todo.md', required: true },
      text: { type: 'string', description: '文本内容', required: true },
    },
  },
  {
    id: 'workspace.edit',
    name: '局部修改工作区文件',
    description:
      '只改文本文件中的指定片段，不整篇覆盖。先 workspace.read 取原文；把原文精确复制到 find，新内容放 replace；多个 edits 顺序执行，任一未命中则整体失败、不写盘。支持 txt/md/csv/json/代码。Office 文件改用 office.find + office.replace。成功后只说文件名和改动条数。',
    scope: SC.WORKSPACE_WRITE,
    dangerous: false,
    concurrency: 'write',
    lockKey: (deps, actor, args) => workspaceFileLockKey(deps, actor, args),
    input: {
      path: { type: 'string', description: '相对路径，如 docs/方案.md', required: true },
      edits: {
        type: 'array',
        description: '替换列表；每项 find 必须与原文完全一致，replace 为新内容',
        required: true,
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            find: { type: 'string', description: '要替换的原文（区分大小写/空白）' },
            replace: { type: 'string', description: '新内容；空字符串=删除' },
            occurrence: {
              type: 'integer',
              description: '只替换第几个匹配（1 起）；不传=全部',
            },
          },
          required: ['find', 'replace'],
        },
      },
    },
  },
  {
    id: 'workspace.read',
    name: '读取工作区文件',
    description:
      '读取云空间文本文件。mode=lines（默认）按行读，单次最多 2000 行/50 KB、单行 2000 字符，超出返回 nextOffset，用 offset 续读。mode=analyze 完整读取并统计/总结整份文件，不受行数/字节限制，单文件上限 200 万字符；建议传 question。代码/长日志先 workspace.search 定位 path:line 再读附近。',
    scope: SC.WORKSPACE_READ,
    dangerous: false,
    input: {
      path: { type: 'string', description: '相对路径，如 notes/todo.md', required: true },
      mode: {
        type: 'string',
        description: 'lines=按行分页（默认）；analyze=完整读取并统计/总结整份文件',
        enum: ['lines', 'analyze'],
      },
      offset: { type: 'number', description: 'mode=lines：起始行，默认 1' },
      limit: { type: 'number', description: 'mode=lines：读取行数，默认/最大 2000' },
      question: {
        type: 'string',
        description: 'mode=analyze：要基于全文回答的问题；不填则总结结构和关键数据',
      },
    },
  },
  {
    id: 'workspace.search',
    name: '搜索工作区文件',
    description:
      '在云空间文本文件里按关键词/正则搜索，返回 path、line、column、命中行和 total；query 也是文件名时返回 nameMatches。默认 30 条、最多 100，truncated=true 表示还有更多。默认递归，30 秒/2000 文件/单文件 2 MB，跳过 node_modules、.git、dist；先定位 path:line，再用 workspace.read 读上下文。',
    scope: SC.WORKSPACE_READ,
    dangerous: false,
    input: {
      query: { type: 'string', description: '要搜索的文本或正则', required: true },
      path: { type: 'string', description: '可选：相对路径的文件或目录，默认整个工作区' },
      maxResults: { type: 'number', description: '最多返回几条，默认 30，最大 100' },
      regex: { type: 'boolean', description: '是否当正则，默认 false' },
      caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false' },
    },
  },
  {
    id: 'project.list',
    name: '浏览本地项目文件',
    description:
      '列出当前本地项目目录下的文件和文件夹。path 是相对项目根的目录（默认根目录），depth 默认 1、最大 3；自动跳过 .git、node_modules、dist 等大目录。返回 type、size、updatedAt 和相对 path，下一步再用 project.read 读内容。只能访问当前项目根目录，不能跳出。',
    scope: SC.LOCAL_SPACE_READ,
    dangerous: false,
    input: {
      path: { type: 'string', description: '可选：相对项目根的目录，默认根目录' },
      depth: { type: 'number', description: '可选：递归层数，默认 1，最大 3' },
      limit: { type: 'number', description: '可选：最多返回多少条，默认 300，最大 1000' },
    },
  },
  {
    id: 'project.read',
    name: '读取本地项目文件',
    description:
      '按行读取当前本地项目里的文本文件，返回 path、size、text、startLine、endLine、totalLines 和 nextOffset；offset 是行号（从 1 开始），limit 默认 2000 行。代码、配置、Markdown 都可用；二进制文件请改用 project.exec 调用系统工具。',
    scope: SC.LOCAL_SPACE_READ,
    dangerous: false,
    input: {
      path: { type: 'string', description: '相对项目根的文本文件路径', required: true },
      offset: { type: 'number', description: '可选：起始行号，从 1 开始' },
      limit: { type: 'number', description: '可选：本次最多读多少行，默认 2000' },
    },
  },
  {
    id: 'project.write',
    name: '写入本地项目文件',
    description:
      '在当前本地项目里创建或覆盖文本文件。path 相对项目根，父目录不存在会自动创建；返回 path、size、created。只接受文本内容，二进制 Office 文件请用对应工具或在项目里运行构建命令；单个文件最大 5 MB。敏感文件（.env、私钥、凭据）默认拒绝，需要用户在项目设置里显式开启。',
    scope: SC.LOCAL_SPACE_WRITE,
    dangerous: false,
    input: {
      path: { type: 'string', description: '相对项目根的文件路径，例如 src/index.ts', required: true },
      text: { type: 'string', description: '完整文件内容', required: true },
    },
  },
  {
    id: 'project.edit',
    name: '局部修改本地项目文件',
    description:
      '用精确 find/replace 局部修改当前本地项目里的文本文件，不重写整个文件。edits 是数组，每项包含 find、replace，可选 occurrence；所有 find 必须命中，任何一处失败整次修改不落盘。改完返回 changes、matchedEdits 和 diff。',
    scope: SC.LOCAL_SPACE_WRITE,
    dangerous: false,
    input: {
      path: { type: 'string', description: '相对项目根的文本文件路径', required: true },
      edits: {
        type: 'array',
        description: '修改列表，每项 { find, replace, occurrence? }',
        required: true,
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            find: { type: 'string', description: '要替换的原文（区分大小写/空白）' },
            replace: { type: 'string', description: '新内容；空字符串=删除' },
            occurrence: {
              type: 'integer',
              description: '只替换第几个匹配（1 起）；不传=全部',
            },
          },
          required: ['find', 'replace'],
        },
      },
    },
  },
  {
    id: 'project.delete',
    name: '删除本地项目文件',
    description:
      '删除当前本地项目里的一个文件（不是目录）。path 相对项目根；只删文件，不会递归删除文件夹。这是不可逆操作，每次执行都需要用户审批；项目只读模式下拒绝。',
    scope: SC.LOCAL_SPACE_WRITE,
    dangerous: true,
    input: {
      path: { type: 'string', description: '相对项目根的文件路径', required: true },
    },
  },
  {
    id: 'project.search',
    name: '搜索本地项目文本',
    description:
      '在当前本地项目里按关键词/正则搜索文本文件，返回 path、line、column、命中行和 total；query 也是文件名时返回 nameMatches。默认 30 条、最多 100，递归搜索但跳过 .git、node_modules、dist；先用它定位 path:line，再用 project.read 读上下文。',
    scope: SC.LOCAL_SPACE_READ,
    dangerous: false,
    input: {
      query: { type: 'string', description: '要搜索的文本或正则', required: true },
      path: { type: 'string', description: '可选：相对项目根的目录或文件，默认整个项目' },
      maxResults: { type: 'number', description: '最多返回几条，默认 30，最大 100' },
      regex: { type: 'boolean', description: '是否当正则，默认 false' },
      caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false' },
    },
  },
  {
    id: 'project.exec',
    name: '执行项目命令',
    description:
      '在项目工作区执行一条 shell 命令，和 DSH 的 bash 工具一样每次调用都是全新 shell，不保留 cd 或环境变量。cwd 是相对项目工作区的目录，不能跳出工作区；默认 120 秒、最多 600 秒，超时会杀整个进程树。返回 stdout、stderr、exitCode、timedOut、durationMs、enforcement、sandboxMode、network；非零退出是结果而不是工具错误。输出各保留 64 KB 尾部，超出时完整输出保存为文本批次并返回 batchId。npm install、构建、测试、启动 dev server 等长命令用 runInBackground=true，然后 project.job 查看或终止。Windows 走 PowerShell，Linux/macOS 走 bash；EAB_PROJECT_EXEC=strict 时只通过 Docker/bwrap 沙箱执行，并要求配置 EAB_PROJECT_COMMAND_ALLOWLIST，网络默认拒绝。',
    scope: SC.WORKSPACE_WRITE,
    dangerous: false,
    risk: 'exec',
    approval: 'always',
    input: {
      description: {
        type: 'string',
        description: '5-10 个词说明这条命令要做什么，鼠标悬停/审计用，例如“安装依赖”',
        required: true,
      },
      command: { type: 'string', description: '要执行的命令；Windows 是 PowerShell 语法，Linux/macOS 是 bash 语法', required: true },
      cwd: { type: 'string', description: '可选：相对项目工作区的子目录，默认工作区根；不能使用 .. 跳出工作区' },
      timeoutMs: { type: 'number', description: '可选：前台命令超时毫秒，默认 120000，最大 600000' },
      runInBackground: { type: 'boolean', description: '可选：true 时立即返回 jobId，长命令用 project.job 查看输出/终止' },
    },
  },
  {
    id: 'project.job',
    name: '项目后台任务',
    description:
      '管理 project.exec 用 runInBackground=true 启动的后台任务。action=list 列出当前用户的任务；output 读取某个任务的 stdout/stderr/状态；kill 终止任务树。任务只在内存保留 30 分钟，服务重启后不会恢复。前台命令不要用它，直接看 project.exec 的返回。',
    scope: SC.WORKSPACE_WRITE,
    dangerous: false,
    risk: 'exec',
    approval: 'always',
    input: {
      action: {
        type: 'string',
        description: 'list / output / kill，默认 output',
        enum: ['list', 'output', 'kill'],
      },
      jobId: { type: 'string', description: 'action=output 或 kill 时必填' },
    },
  },
  {
    id: 'plugin.dev',
    name: '自开发插件',
    description:
      'Agent 给自己开发并热安装 DSH UI 插件的闭环。action=create：在云空间 `.eab-plugins/<pluginId>` 生成可编辑的 DSH bundle 骨架（package.json / cordis.patch.yml / index.js / client.js / icon / locale）；然后必须用 workspace.read 读 client.js，再用 workspace.edit 改成用户要的页面。action=install：把该目录直接安装/更新成当前员工的个人插件，安装立即刷新插件宿主和工具目录，不需要浏览器上传目录，也不需要重启服务；返回 previewPath，可直接打开 /plugin-kernel.html 看真实 UI。改完 client.js 后再次 install 即为热更新，插件页会按版本指纹自动刷新。action=list：列出本人已安装插件及其预览地址。插件页优先用 `main` slot，用 `ctx.slots.register({name:"main",key:"home"}, Component)`，不要在 document.body 挂第二棵应用；Host 侧 index.js 可以只导出空的 apply()。',
    scope: SC.PLUGIN_INSTALL,
    dangerous: false,
    input: {
      action: {
        type: 'string',
        description: 'create 生成插件骨架；install 安装/热更新；list 列出本人插件',
        enum: ['create', 'install', 'list'],
        required: true,
      },
      pluginId: {
        type: 'string',
        description: '插件 id，小写字母开头、只含 a-z 0-9 -，例如 eab-self-card；install 时可从 package.json 推断',
      },
      title: { type: 'string', description: 'create 时的页面标题；默认用 pluginId' },
      description: { type: 'string', description: 'create 时的页面说明，会写进模板正文' },
      accent: { type: 'string', description: 'create 时的主色，六位十六进制，例如 #2563eb' },
      dir: {
        type: 'string',
        description: `插件源码目录，相对云空间根目录；默认 ${PLUGIN_DEV_DIR}/<pluginId>。install 时用它定位要安装的包`,
      },
      overwrite: {
        type: 'boolean',
        description: 'create 时目录已存在是否重置为模板，默认 false；重置会覆盖已写好的页面，非必要不要用',
      },
    },
  },
  {
    id: 'skill.dev',
    name: '自开发技能',
    description:
      'Agent 给自己开发并热安装个人技能的闭环。action=create：在云空间 `.eab-skills/<skillId>` 生成可编辑的技能骨架（skill.json + SKILL.md + README.md）；然后必须用 workspace.read 读 SKILL.md，再用 workspace.edit 改成用户要的技能说明。action=install：把该目录直接安装/更新成当前员工的个人技能，写库和写盘后下一轮对话立即加载，不需要浏览器上传目录，也不需要重启服务；返回 previewPath，可直接打开 `/chat?workspace=skills&skill=<id>` 看技能工作台里的真实详情和启用状态。改完 SKILL.md 后再次 install 即为热更新，checksum 和详情同步刷新。action=list：列出本人已安装技能及其工作台地址。骨架默认是 L0 纯提示词技能，只允许 chat:use / skill:list / skill:use，tools 为空；不要硬塞脚本或可执行文件，安装仍会走静态安全扫描和公司个人安装审批策略。',
    scope: SC.SKILL_INSTALL,
    dangerous: false,
    input: {
      action: {
        type: 'string',
        description: 'create 生成技能骨架；install 安装/热更新；list 列出本人技能',
        enum: ['create', 'install', 'list'],
        required: true,
      },
      skillId: {
        type: 'string',
        description: '技能 id，小写字母开头、只含 a-z 0-9 -，例如 eab-meeting-notes；install 时可从 skill.json 推断',
      },
      title: { type: 'string', description: 'create 时的技能名称；默认用 skillId' },
      description: { type: 'string', description: 'create 时的技能说明，会写进 skill.json 和 SKILL.md' },
      triggers: {
        type: 'array',
        description: 'create 时的触发词列表，最多 20 个；默认用 skillId 和整理类触发词',
        items: { type: 'string' },
      },
      dir: {
        type: 'string',
        description: `技能源码目录，相对云空间根目录；默认 ${SKILL_DEV_DIR}/<skillId>。install 时用它定位要安装的包`,
      },
      overwrite: {
        type: 'boolean',
        description: 'create 时目录已存在是否重置为模板，默认 false；重置会覆盖已写好的说明，非必要不要用',
      },
    },
  },
  {
    id: 'office.read_outline',
    name: '读取 Office 文档结构',
    description:
      '读取 docx 的段落、标题和表格结构，读取 xlsx/xlsm 的工作表、行列和单元格文本，或读取 pptx 的幻灯片段落文本，返回稳定 ID、公式标记和预览。只读，不需要打开 OnlyOffice，也不会修改文件。先确认 fileId 或相对路径。pptx 段落 ID 为 sN-pM，可用 office.find/office.replace 做文本级局部替换。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    input: {
      fileId: { type: 'string', description: '云空间文件 id；和 path 二选一' },
      path: { type: 'string', description: '云空间相对路径；和 fileId 二选一' },
      maxElements: { type: 'number', description: '最多返回多少个顶层元素，默认 200，范围 1-500' },
    },
  },
  {
    id: 'office.read_range',
    name: '读取 Office 文档范围',
    description:
      '读取 docx 指定范围完整文本、run 格式和表格结构，不截断/不改文件。elementId 支持 pN、tN、tN-rN、tN-cN、tN-rN-cN；start/end 是 pN 或 tN-rN-cN 的字符偏移。返回 text、runs（bold/italic/underline/color/fontSize/fontFamily/style）和表格数据。xlsx/pptx 暂不支持。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    input: {
      fileId: { type: 'string', description: '文件 id（与 path 二选一）' },
      path: { type: 'string', description: '相对路径（与 fileId 二选一）' },
      elementId: { type: 'string', description: 'docx 的 pN、tN、tN-rN、tN-cN 或 tN-rN-cN', required: true },
      start: { type: 'number', description: '起始字符偏移，默认 0' },
      end: { type: 'number', description: '结束字符偏移，默认文本末尾' },
    },
  },
  {
    id: 'office.find',
    name: '在 Office 文档中查找文本',
    description:
      '在 docx 段落/表格单元格、xlsx/xlsm 单元格或 pptx 幻灯片段落中按文本或正则查找，返回元素 ID（docx 段落 pN、表格单元格 tN-rN-cN，xlsx 单元格 sN-rN-cN，pptx 段落 sN-pM）、工作表/幻灯片/地址、公式标记、命中位置和上下文，供后续定位/修改使用。只读。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    input: {
      query: { type: 'string', description: '要查找的文本或正则表达式', required: true },
      fileId: { type: 'string', description: '云空间文件 id；和 path 二选一' },
      path: { type: 'string', description: '云空间相对路径；和 fileId 二选一' },
      regex: { type: 'boolean', description: '是否把 query 当正则，默认 false' },
      limit: { type: 'number', description: '最多返回多少条命中，默认 20，范围 1-100' },
    },
  },
  {
    id: 'office.revisions',
    name: '读取或处理 Word 修订',
    description:
      '读取 docx 修订，或设置修订开关、接受/拒绝修订。action=read（默认）返回插入/删除数量、作者、日期、文本范围和段落/单元格 ID；action=enable/disable 改 settings.xml 的 w:trackChanges；action=accept/reject 处理 w:ins/w:del 并原子保存。只识别 w:ins / w:del（含 w:delText），移动和格式修订仍需人工在编辑器处理。接受/拒绝时传 revisionId，或 all=true 处理全部。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    input: {
      fileId: { type: 'string', description: '云空间文件 id；和 path 二选一' },
      path: { type: 'string', description: '云空间相对路径；和 fileId 二选一' },
      action: {
        type: 'string',
        description: 'read（默认）、enable、disable、accept 或 reject',
      },
      revisionId: { type: 'string', description: 'accept/reject 指定的修订 id；与 all 二选一' },
      all: { type: 'boolean', description: 'accept/reject 是否处理全部修订；与 revisionId 二选一' },
      maxRevisions: { type: 'number', description: 'read 时最多返回多少条修订，默认 200，范围 1-500' },
    },
  },
  {
    id: 'office.replace',
    name: '局部替换 Office 文档文本',
    description:
      '只替换指定元素文本，不整篇/整表重写。docx 用 pN/tN-rN-cN，xlsx/xlsm 用 sN-rN-cN，pptx 用 sN-pM；先 office.find 定位。oldText 精确匹配；docx/xlsx 非空目标必须提供命中原文，仅空段落/空单元格可省略。docx 替换范围跨多种 run 格式时拒绝，请把 oldText 收窄到单个 run 内。xlsx 空单元格可直接写入；公式单元格只能改成 = 开头的新公式。多处命中必须指定 occurrence（1 起；0 仅 xlsx=全部）。自动保存并记审计。支持 docx/xlsx/xlsm/pptx；pptx 不支持段内换行。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'write',
    lockKey: (deps, actor, args) => workspaceFileLockKey(deps, actor, args),
    input: {
      elementId: { type: 'string', description: 'docx pN/tN-rN-cN；xlsx sN-rN-cN；pptx sN-pM（office.find 获取）', required: true },
      fileId: { type: 'string', description: '文件 id（与 path 二选一）' },
      path: { type: 'string', description: '相对路径（与 fileId 二选一）' },
      oldText: { type: 'string', description: '命中原文；docx/xlsx 非空目标必填，仅空段落/空单元格可省略' },
      newText: { type: 'string', description: '新文本；空=删除', required: true },
      occurrence: { type: 'number', description: '1 起；0=全部（仅 xlsx）；默认 1' },
      trackChanges: { type: 'boolean', description: 'docx：true 保留 w:del/w:ins 修订；已有修订先接受/拒绝' },
      author: { type: 'string', description: 'docx 修订作者，默认 EAB Agent' },
    },
  },
  {
    id: 'office.rewrite',
    name: '整段重写并统一 docx 格式',
    description:
      '仅在用户明确要求把整个 docx 段落/单元格重写成新文本，并同时指定统一格式时使用。不得用于“保留原有格式”的普通替换，也不得替代 office.replace 做局部修改。会一次覆盖目标元素全部可见文本，再把指定格式统一应用到所有 run；不支持 xlsx/pptx。先用 office.find 或 office.read_range 确认 elementId 和原文。至少给一个格式属性。写入后自动保存并记审计。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'write',
    lockKey: (deps, actor, args) => workspaceFileLockKey(deps, actor, args),
    input: {
      elementId: { type: 'string', description: 'docx 段落 pN 或表格单元格 tN-rN-cN', required: true },
      fileId: { type: 'string', description: '文件 id（与 path 二选一）' },
      path: { type: 'string', description: '相对路径（与 fileId 二选一）' },
      newText: { type: 'string', description: '整段新文本；空=清空该元素', required: true },
      bold: { type: 'boolean', description: '统一加粗；false=统一不加粗' },
      italic: { type: 'boolean', description: '统一斜体；false=统一不斜体' },
      underline: { type: 'string', description: '统一下划线样式；false=清除' },
      color: { type: 'string', description: '统一字体颜色，6 位十六进制，例如 FF0000' },
      fontSize: { type: 'number', description: '统一字号（磅），例如 12' },
      fontFamily: { type: 'string', description: '统一字体族，例如 宋体、Arial' },
      align: { type: 'string', description: '段落对齐：left/center/right/justify' },
    },
  },
  {
    id: 'office.insert',
    name: '插入/删除/合并/拆分 Office 表格结构',
    description:
      '编辑 docx 表格结构：action=insert 在指定段落或表格行/列前后插入内容；action=delete 删除 docx 表格行/列；action=merge 合并一个矩形单元格区域；action=split 拆分整张表的合并单元格。先用 office.read_outline / office.find 拿到 pN、tN、tN-rN-cN、tN-rN、tN-cN。删除行会保留并重接纵向合并；删除列按表格网格缩减或移除覆盖该列的单元格，横向合并单元格会减少 gridSpan。插入列、插入含纵向合并的行和合并区域前，若表格仍有合并单元格，先用 action=split 归一化。docx 表格行用制表符分隔多列，列用换行分隔各行值。xlsx 支持插入行/列、用 elementId=workbook 追加工作表、用 elementId=sN 删除工作表；插入行/列会同步移动引用，跨表公式、命名区域、图表或数据透视表引用目标工作表时拒绝删除。删除工作表时会清理它独占的批注、VML、绘图、表格等关联部件，仍被其他工作表引用的部件保留。写入后自动保存并记录 workspace.file.agent_edit 审计；pptx 结构变更暂不支持。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'write',
    lockKey: (deps, actor, args) => workspaceFileLockKey(deps, actor, args),
    input: {
      elementId: { type: 'string', description: 'insert/delete/split 的 docx 段落 pN、表格 tN、表格单元格 tN-rN-cN、表格行 tN-rN、表格列 tN-cN；action=merge 时传合并范围 tN-rA-cA:tN-rB-cB；xlsx 行 sN-rN / 列 sN-cN（也可传该行任意单元格 sN-rN-cN）；xlsx 追加工作表用 workbook，删除工作表用 sN', required: true },
      fileId: { type: 'string', description: '云空间文件 id；和 path 二选一' },
      path: { type: 'string', description: '云空间相对路径；和 fileId 二选一' },
      action: { type: 'string', description: 'insert（默认）、delete、merge 或 split；split 用 elementId=tN 拆分整张表的合并单元格，merge 用 elementId=tN-rA-cA:tN-rB-cB 合并矩形区域；xlsx 删除工作表用 action=delete + elementId=sN' },
      text: { type: 'string', description: 'action=insert 时必填：docx 新段落文本，可包含换行和制表符；docx 表格行用制表符分隔多列、表格列用换行分隔各行值；xlsx 行用制表符分隔多列，列用换行分隔各行值，空字符串表示空行/空列；xlsx 追加工作表时为新工作表名称' },
      position: { type: 'string', description: 'action=insert 时的 before 或 after，默认 after' },
    },
  },
  {
    id: 'office.format',
    name: '设置 Office 文档格式',
    description:
      '只对 docx 指定段落/表格单元格，或 xlsx/xlsm 指定单元格、整列/整行设置格式，不改动其他内容、文本和结构。先用 office.find 或 office.read_outline 拿到 pN / tN-rN-cN / sN-rN-cN。支持加粗、斜体、下划线、字体颜色、字号、字体族和数字格式；docx 段落另支持对齐、行距、段前段后间距；xlsx 另支持单元格填充色、列宽和行高（elementId 用 sN-cN / sN-rN，可带范围 sN-c2:c4、sN-r2:r4）。传 false 或 none 可清除对应格式。写入后自动保存并记录 workspace.file.agent_edit 审计。pptx 暂不支持。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'write',
    lockKey: (deps, actor, args) => workspaceFileLockKey(deps, actor, args),
    input: {
      elementId: { type: 'string', description: 'office.read_outline / office.find 返回的 pN、tN-rN-cN；xlsx 单元格 sN-rN-cN，列宽 sN-cN 或 sN-c2:c4，行高 sN-rN 或 sN-r2:r4', required: true },
      fileId: { type: 'string', description: '云空间文件 id；和 path 二选一' },
      path: { type: 'string', description: '云空间相对路径；和 fileId 二选一' },
      bold: { type: 'boolean', description: '是否加粗；false 表示清除' },
      italic: { type: 'boolean', description: '是否斜体；false 表示清除' },
      underline: { type: 'string', description: 'true/false，或 single/double/dotted/wave 等下划线样式；false 表示清除' },
      color: { type: 'string', description: '字体颜色，6 位十六进制，例如 FF0000；none 表示清除' },
      highlight: { type: 'string', description: 'docx 高亮色：yellow/green/cyan/magenta/blue/red 等；none 表示清除' },
      fill: { type: 'string', description: 'xlsx 单元格填充色，6 位十六进制，例如 FFF2CC；none 表示清除' },
      fontSize: { type: 'number', description: '字号（磅），例如 14' },
      fontFamily: { type: 'string', description: 'docx 字体族，例如 宋体、黑体、Arial' },
      align: { type: 'string', description: 'docx 段落对齐：left / center / right / justify' },
      lineSpacing: { type: 'number', description: 'docx 行距倍数，1 到 3，例如 1.5' },
      spaceBefore: { type: 'number', description: 'docx 段前间距（磅），例如 6' },
      spaceAfter: { type: 'number', description: 'docx 段后间距（磅），例如 6' },
      numberFormat: { type: 'string', description: 'xlsx 数字格式，例如 0.00%、#,##0、yyyy-mm-dd，或 builtin:14' },
      columnWidth: { type: 'number', description: 'xlsx 列宽（字符数，0 到 255），elementId 用 sN-cN 或 sN-c2:c4；列号范围 1-16384' },
      rowHeight: { type: 'number', description: 'xlsx 行高（磅，0 到 409），elementId 用 sN-rN 或 sN-r2:r4；行号范围 1-1048576，单次最多 20000 行' },
    },
  },
  {
    id: 'office.comment',
    name: '管理文档批注',
    description:
      '管理 docx/xlsx 批注。docx：action=add（默认）给 pN 段落或 tN-rN-cN 单元格加批注，可用 oldText/occurrence 或 start/end 把范围收窄到短语；action=list 列出批注、回复数、是否解决；action=reply 回复指定批注；action=resolve 解决/重新打开；action=delete 删除批注及其回复和锚点。xlsx：action=add 给 sN-rN-cN 单元格加批注，action=list 列出单元格批注，action=delete 按 elementId 或 commentId 删除；xlsx 单元格批注是扁平批注，不支持 reply/resolve，也不支持 oldText/start/end。自动创建 comments/VML、关系项和内容类型，写入后原子保存并记录审计。pptx 暂不支持。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'write',
    lockKey: (deps, actor, args) => workspaceFileLockKey(deps, actor, args),
    input: {
      action: {
        type: 'string',
        description: 'add（默认）、list、reply、resolve 或 delete；xlsx 只支持 add、list、delete',
      },
      elementId: {
        type: 'string',
        description: 'add 时的 pN、tN-rN-cN 或 xlsx 的 sN-rN-cN；xlsx delete 也可用 elementId 指定单元格',
      },
      commentId: {
        type: 'number',
        description: 'docx reply/resolve/delete 的批注 id；xlsx list 返回的序号，可用于 delete；list 时返回全部',
      },
      fileId: { type: 'string', description: '云空间文件 id；和 path 二选一' },
      path: { type: 'string', description: '云空间相对路径；和 fileId 二选一' },
      text: { type: 'string', description: 'add/reply 的批注正文' },
      author: { type: 'string', description: '批注作者，默认 EAB Agent' },
      oldText: { type: 'string', description: 'docx add 时锚定短语；和 start/end 二选一；xlsx 不支持' },
      occurrence: { type: 'number', description: 'docx oldText 命中多次时的序号，1 起' },
      start: { type: 'number', description: 'docx add 时的起始字符偏移；和 oldText 二选一；xlsx 不支持' },
      end: { type: 'number', description: 'docx add 时的结束字符偏移；和 oldText 二选一；xlsx 不支持' },
      resolved: { type: 'boolean', description: 'docx resolve 时 true 标记解决，false 重新打开，默认 true；xlsx 不支持' },
    },
  },
  {
    id: 'office.versions',
    name: '管理文档历史版本',
    description:
      '管理个人云空间 Office 文档的历史版本。action=list（默认）列出快照，返回 version、size、source、summary、createdAt 和当前文件版本；action=snapshot 把当前内容存为手动快照，无变化时复用已有快照并返回 created=false；action=restore 恢复到 versionId 指定的历史版本，恢复前自动再存一份当前版本。仅文件本人可用；共享只读用户不能查看或恢复旧版本。先用 workspace.list 或 office.read_outline 找到文件，再传 fileId 或 path。',
    scope: SC.WORKSPACE_WRITE,
    dangerous: false,
    concurrency: 'write',
    lockKey: (deps, actor, args) => workspaceFileLockKey(deps, actor, args),
    input: {
      action: { type: 'string', description: 'list（默认）、snapshot 或 restore' },
      fileId: { type: 'string', description: '云空间文件 id；和 path 二选一' },
      path: { type: 'string', description: '云空间相对路径或文件名；和 fileId 二选一' },
      versionId: { type: 'string', description: 'restore 时的版本 id，来自 action=list 返回的 id' },
    },
  },
  {
    id: 'office.export',
    name: '导出 Office 文档为 PDF',
    description:
      '把个人云空间里的 docx/xlsx/pptx 通过 OnlyOffice 转成 PDF，并在云空间生成一个同名 PDF 新文件（重名时自动加序号），不覆盖源文件、不修改源文件版本。当前只支持 format=pdf。导出共享只读文件时也允许。先用 workspace.list 找到文件，再传 fileId 或 path。',
    scope: SC.WORKSPACE_READ,
    dangerous: false,
    concurrency: 'write',
    input: {
      fileId: { type: 'string', description: '云空间文件 id；和 path 二选一' },
      path: { type: 'string', description: '云空间相对路径或文件名；和 fileId 二选一' },
      format: { type: 'string', description: '导出格式，当前只支持 pdf，默认 pdf' },
    },
  },
  {
    id: 'office.gui',
    name: '准备或上报 GUI 兜底',
    description:
      '为 OnlyOffice 里没有 API 的原生入口准备受控人工兜底，或查询/上报结果。只允许四类动作：print（打印/打印设置）、macro（只打开宏管理器，EAB 不读取、不保存、不执行宏代码）、export（导出选项）、dialog（仅 docx 的 page_setup 页面设置 / header_footer 页眉页脚）。action=prepare 只登记白名单动作、生成用户操作步骤并写审计，不会自动点击、打印或执行宏；用户必须在前端弹窗点击确认后，才能由用户自己在 OnlyOffice 界面完成。action=status 查询状态；action=report 上报用户看到的结果（result=success/failure）。失败后同一条 fallbackId 不得再次确认或上报，必须重新发起；不要尝试白名单外的按钮、任意坐标或伪造成功。',
    scope: SC.WORKSPACE_WRITE,
    dangerous: false,
    concurrency: 'write',
    lockKey: (deps, actor, args) => workspaceFileLockKey(deps, actor, args),
    input: {
      action: { type: 'string', description: 'prepare（默认）、status 或 report' },
      fileId: { type: 'string', description: '云空间文件 id；和 path 二选一' },
      path: { type: 'string', description: '云空间相对路径或文件名；和 fileId 二选一' },
      guiAction: { type: 'string', description: '白名单动作：print、macro、export 或 dialog；prepare 必填' },
      dialog: { type: 'string', description: 'guiAction=dialog 时必填：page_setup 或 header_footer，仅 docx' },
      format: { type: 'string', description: 'guiAction=export 时的目标格式提示：pdf、docx、xlsx、pptx 或 csv' },
      note: { type: 'string', description: '给用户看的备注，最多 200 字' },
      fallbackId: { type: 'string', description: 'status/report 时的兜底 id，来自 prepare 返回' },
      result: { type: 'string', description: 'report 时必填：success 或 failure' },
      detail: { type: 'string', description: 'report=failure 时必填的失败原因，最多 500 字' },
    },
  },
  {
    id: 'workspace.send_dingtalk',
    name: '发送文件或图片到钉钉',
    description:
      '把个人云空间里的文件或工作区里的图片作为钉钉消息发给当前用户。用户说“把文件发给我/发到钉钉/把这张图片发我/图片发我”时调用；先用 workspace.list 找到文件名或相对路径，再传 path，或直接传 workspace.list 返回的 fileId。图片支持个人云空间里已登记的文件，也支持 project.exec、导出等工具刚写到工作区但还没登记进 workspace_files 的 png/jpg/jpeg/gif/bmp/webp；图片会走钉钉原生图片消息，直接显示为图片气泡。非图片走文件消息；只支持当前员工的个人云空间和工作区，单个文件不超过 20 MB。',
    scope: SC.WORKSPACE_READ,
    dangerous: false,
    concurrency: 'write',
    lockKey: (deps, actor, args) => workspaceFileLockKey(deps, actor, args),
    idempotent: true,
    input: {
      fileId: { type: 'string', description: 'workspace.list 返回的文件 id；和 path、url 三选一' },
      path: {
        type: 'string',
        description: '文件/图片的相对路径或文件名，例如 suale.txt、charts/sales.png；和 fileId、url 三选一',
      },
      url: {
        type: 'string',
        description:
          '知识库图片地址，例如 /api/kb/assets/<docId>/<assetId> 或 /api/console/kb/docs/<docId>/assets/<assetId>；和 fileId、path 三选一。只接受这两种 EAB 知识库图片地址，不接受任意外部 URL。',
      },
    },
  },
  {
    id: 'workspace.rename',
    name: '重命名云空间文件',
    description:
      '修改个人云空间里一个文件的名字。用户说“重命名/改名/把文件名改成…”时调用；先用 workspace.list 找到文件，再传 fileId 或 path，并提供 newName。只改文件名，不移动文件；文件夹重命名请用 workspace.folder action=rename。',
    scope: SC.WORKSPACE_WRITE,
    dangerous: false,
    concurrency: 'write',
    lockKey: (deps, actor, args) => workspaceFileLockKey(deps, actor, args),
    idempotent: true,
    input: {
      fileId: { type: 'string', description: 'workspace.list 返回的文件 id；和 path 二选一' },
      path: { type: 'string', description: '文件相对路径或文件名，例如 suale.txt；和 fileId 二选一' },
      newName: { type: 'string', description: '新文件名或新相对路径，例如 安全防护记录表.docx', required: true },
    },
  },
  {
    id: 'workspace.delete',
    name: '删除云空间文件',
    description:
      '删除个人云空间里的一个文件。用户明确说“删掉/删除/清理某个文件”时调用；先用 workspace.list 找到 fileId 或 path。只能删自己的文件；删除是软删，文件会移到回收目录，列表里不再显示，但保留可审计。不要用它删除目录；文件夹删除请用 workspace.folder action=delete。',
    scope: SC.WORKSPACE_WRITE,
    dangerous: false,
    concurrency: 'write',
    lockKey: (deps, actor, args) => workspaceFileLockKey(deps, actor, args),
    idempotent: true,
    input: {
      fileId: { type: 'string', description: 'workspace.list 返回的文件 id；和 path 二选一' },
      path: { type: 'string', description: '文件相对路径或文件名，例如 安全防护记录表.docx；和 fileId 二选一' },
    },
  },
  {
    id: 'workspace.folder',
    name: '管理云空间文件夹',
    description:
      '创建、重命名或删除个人云空间的文件夹。先用 workspace.list 查看 folders 的完整路径。action=create：传 path 表示要新建的完整文件夹路径（如 docs/工作计划），会生成可见的空文件夹；action=rename：传 path 现有文件夹路径，再传 newName 新名称（只改最后一级，不会移动层级）；action=delete：传 path，递归软删该文件夹内所有本人文件到回收区，并清理空目录。只操作自己的文件夹；如果文件夹里包含其他成员共享来的文件，会拒绝整体改名/删除，避免误动他人文件。',
    scope: SC.WORKSPACE_WRITE,
    dangerous: false,
    concurrency: 'write',
    approval: 'always',
    lockKey: (_deps, actor) => `workspace:folder:${actor.subject.companyId}:${actor.subject.userId}`,
    idempotent: true,
    input: {
      action: {
        type: 'string',
        description: 'create（新建）、rename（重命名）或 delete（删除）',
        required: true,
      },
      path: {
        type: 'string',
        description: '文件夹完整相对路径，例如 docs 或 docs/工作计划',
        required: true,
      },
      newName: {
        type: 'string',
        description: 'action=rename 时必填：新文件夹名称，例如 资料；不能包含斜杠',
      },
    },
  },
  {
    id: 'admin.password.reset',
    name: '重置成员密码',
    description: '给指定成员重置密码并吊销其全部会话。高危：需要审批。',
    scope: SC.ORG_MEMBER_MANAGE,
    dangerous: true,
    concurrency: 'exclusive',
    lockKey: (_deps, actor, args) => adminPasswordLockKey(actor, args),
    idempotent: true,
    input: {
      userId: { type: 'string', description: '成员 id', required: true },
      password: { type: 'string', description: '新密码（至少 8 位）', required: true },
    },
  },
]

function requireEnabled(actor: ReturnType<typeof resolveActor>): void {
  if (actor.subject.status !== 'active') throw new EabError(EC.FORBIDDEN, '账号已被停用')
}

function audit(deps: ServerDeps, req: FastifyRequest, action: string, detail: Record<string, unknown>): void {
  const actor = resolveActor(deps.db, deps.config, req)
  appendAudit(deps.db, {
    companyId: actor.subject.companyId,
    actorUserId: actor.subject.userId,
    action,
    resourceType: 'tool',
    resourceId: String(detail.toolId ?? ''),
    resourceScope: null,
    result: 'success',
    detail,
    traceId: String(req.id),
    ip: req.ip,
    channel: 'web',
  })
}

/**
 * 联网工具审计：只记调用动作、目标 URL/搜索词、结果规模，不记网页正文和密钥。
 * 审计写入失败不能覆盖工具本身的成功或失败结果。
 */
function auditWebTool(
  deps: ServerDeps,
  actor: Actor,
  toolId: WebToolId,
  detail: Record<string, unknown>,
  result: 'success' | 'failure',
  startedAt: number,
  context: ToolExecutionContext,
  error?: unknown,
): void {
  try {
    appendAudit(deps.db, {
      companyId: actor.subject.companyId,
      actorUserId: actor.subject.userId,
      action: `net.${toolId}`,
      resourceType: 'network',
      resourceId: toolId,
      resourceScope: null,
      result,
      detail: {
        ...detail,
        toolId,
        durationMs: Date.now() - startedAt,
        ...(error ? { error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) } : {}),
        sessionId: context.sessionId ?? null,
        channel: context.channel ?? null,
      },
      traceId: context.turnId ?? null,
      ip: null,
      channel: context.channel === 'dingtalk' ? 'dingtalk' : 'web',
    })
  } catch {
    // 审计存储故障不阻断工具返回
  }
}

/** 只允许数字、括号、四则运算；用递归下降，不用 eval */
function evaluate(expression: string): number {
  const tokens = expression.replace(/\s+/g, '')
  if (!/^[0-9+\-*/().%]+$/.test(tokens)) throw new EabError(EC.VALIDATION, '表达式只允许数字与 + - * / ( ) %')
  let index = 0
  function number(): number {
    const start = index
    while (index < tokens.length && /[0-9.]/.test(tokens[index])) index++
    if (start === index) throw new EabError(EC.VALIDATION, '表达式格式错误')
    return Number(tokens.slice(start, index))
  }
  function factor(): number {
    if (tokens[index] === '+') {
      index++
      return factor()
    }
    if (tokens[index] === '-') {
      index++
      return -factor()
    }
    if (tokens[index] === '(') {
      index++
      const value = addsub()
      if (tokens[index] !== ')') throw new EabError(EC.VALIDATION, '括号不匹配')
      index++
      return value
    }
    return number()
  }
  function muldiv(): number {
    let value = factor()
    while (tokens[index] === '*' || tokens[index] === '/' || tokens[index] === '%') {
      const op = tokens[index++]
      const right = factor()
      if ((op === '/' || op === '%') && right === 0) throw new EabError(EC.VALIDATION, '不能除以 0')
      value = op === '*' ? value * right : op === '/' ? value / right : value % right
    }
    return value
  }
  function addsub(): number {
    let value = muldiv()
    while (tokens[index] === '+' || tokens[index] === '-') {
      const op = tokens[index++]
      const right = muldiv()
      value = op === '+' ? value + right : value - right
    }
    return value
  }
  const result = addsub()
  if (index !== tokens.length) throw new EabError(EC.VALIDATION, '表达式有未解析的字符')
  if (!Number.isFinite(result)) throw new EabError(EC.VALIDATION, '结果超出范围')
  return result
}

/**
 * 汇总一组数值：模型常把时长/金额口头心算，漏行或算错。
 * 这里统一解析数字与“10.3小时”“10:18”这类时长写法，按小时求和并给出条数。
 */
function summaryValueAt(item: unknown, index: number, depth = 0): unknown {
  if (item && typeof item === 'object') {
    if (Array.isArray(item) || depth >= 2) {
      throw new EabError(
        EC.VALIDATION,
        `values[${index}] 必须是数字或时长字符串，不能是数组/嵌套对象。请传纯数值，例如 [65.15, 55.2, 57.43]`,
      )
    }
    const record = item as Record<string, unknown>
    // 兼容模型把“周标签 + 数值”包成 {label, value}；只取 value，标签不参与计算。
    if ('value' in record) return summaryValueAt(record.value, index, depth + 1)
    throw new EabError(
      EC.VALIDATION,
      `values[${index}] 不是有效数字：收到对象但不含 value。values 只收纯数字或 {value: 数字}；标签请留在图表数据里`,
    )
  }
  return item
}

function summarizeValues(raw: unknown[]): { count: number; sum: number; avg: number; min: number; max: number; unit: 'hours' | 'number' } {
  if (!raw.length) throw new EabError(EC.VALIDATION, 'values 不能为空')
  if (raw.length > 500) throw new EabError(EC.VALIDATION, 'values 最多 500 项')
  let unit: 'hours' | 'number' = 'number'
  const nums = raw.map((item, index) => {
    const valueItem = summaryValueAt(item, index)
    if (typeof valueItem === 'number') {
      if (!Number.isFinite(valueItem)) throw new EabError(EC.VALIDATION, `values[${index}] 不是有效数字`)
      return valueItem
    }
    const text = String(valueItem ?? '').trim()
    if (!text) throw new EabError(EC.VALIDATION, `values[${index}] 为空`)
    const clock = text.match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/)
    if (clock) {
      const minutes = Number(clock[2]) + (clock[3] ? Number(clock[3]) / 60 : 0)
      if (minutes >= 60) throw new EabError(EC.VALIDATION, `values[${index}] 的分钟数不能超过 59`)
      unit = 'hours'
      return Number(clock[1]) + minutes / 60
    }
    const hoursSuffix = /(小时|个小时|hours?|hrs?|h)$/i.test(text)
    const numeric = text.replace(/(小时|个小时|hours?|hrs?|h)$/i, '').trim()
    const value = Number(numeric)
    if (!Number.isFinite(value)) throw new EabError(EC.VALIDATION, `values[${index}] 不是有效数字：${text}`)
    if (hoursSuffix) unit = 'hours'
    return value
  })
  const sum = nums.reduce((total, value) => total + value, 0)
  const round = (value: number) => Math.round(value * 100) / 100
  return {
    count: nums.length,
    sum: round(sum),
    avg: round(sum / nums.length),
    min: round(Math.min(...nums)),
    max: round(Math.max(...nums)),
    unit,
  }
}

/** 组织通讯录工具：只读，不返回手机号；按 subject 的 dataScope 裁剪可见成员。 */
function visibleUserIds(db: Db, actor: Actor): string[] | null {
  if (!actor.subject.scopes.has(SC.ORG_MEMBER_READ)) return null
  const filter = buildScopeFilter(actor.subject, SC.ORG_MEMBER_READ, 'user')
  assertScoped(filter, actor.subject)
  const compiled = predicateToSql(filter.predicate, {
    allowedFields: ['company_id', 'dept_path', 'id'],
  })
  const rows = db
    .prepare(`SELECT id FROM users WHERE ${compiled.sql}`)
    .all(...(compiled.params as string[])) as unknown as Array<{ id: string }>
  return rows.map((row) => row.id)
}

function leaderOfDept(db: Db, companyId: string, deptId: string): { deptName: string; name: string; title: string | null; level: 'own' | 'ancestor' } | null {
  const dept = db
    .prepare('SELECT id, name, path FROM departments WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
    .get(deptId, companyId) as { id: string; name: string; path: string } | undefined
  if (!dept) return null
  const segments = dept.path.split('/').filter(Boolean)
  // 自身 → 逐级上级部门；取第一个配了负责人的部门
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const candidate = db
      .prepare(
        `SELECT d.name AS dept_name, u.name, u.title
           FROM departments d JOIN users u ON u.id = d.manager_user_id
          WHERE d.id = ? AND d.company_id = ? AND d.deleted_at IS NULL
            AND u.deleted_at IS NULL AND u.status = 'active'`,
      )
      .get(segments[index], companyId) as { dept_name: string; name: string; title: string | null } | undefined
    if (candidate) {
      return {
        deptName: candidate.dept_name,
        name: candidate.name,
        title: candidate.title,
        level: index === segments.length - 1 ? 'own' : 'ancestor',
      }
    }
  }
  return null
}

function companyDisplayName(db: Db, companyId: string): string {
  const row = db.prepare('SELECT name FROM companies WHERE id = ?').get(companyId) as
    | { name?: string }
    | undefined
  return row?.name?.trim() || '公司'
}

function orgDirectory(db: Db, actor: Actor, args: Record<string, unknown>): unknown {
  const intent = String(args.intent ?? '').trim()
  if (intent === 'me' || intent === 'leader') {
    const leader = leaderOfDept(db, actor.subject.companyId, actor.person.deptId)
    return {
      intent,
      me: {
        name: actor.person.name,
        title: actor.person.title,
        deptName: actor.person.deptName,
      },
      leader,
      note:
        leader === null
          ? '这个部门在组织数据里没有登记负责人，无法确认组长；可以请管理员在「组织与权限」里配置部门负责人。'
          : leader.level === 'ancestor'
            ? `你所在部门没有单独登记负责人，已取上级部门「${leader.deptName}」的负责人。`
            : '',
    }
  }

  if (intent === 'departments') {
    const companyName = companyDisplayName(db, actor.subject.companyId)
    const rows = db
      .prepare(
        `SELECT d.name, d.parent_id, d.depth, d.path, m.name AS leader_name,
                (SELECT COUNT(*) FROM users u
                  WHERE u.dept_id = d.id AND u.company_id = d.company_id
                    AND u.deleted_at IS NULL AND u.status = 'active') AS member_count
           FROM departments d LEFT JOIN users m ON m.id = d.manager_user_id
          WHERE d.company_id = ? AND d.deleted_at IS NULL
          ORDER BY d.path LIMIT 100`,
      )
      .all(actor.subject.companyId) as unknown as Array<{
      name: string
      parent_id: string | null
      depth: number
      path: string
      leader_name: string | null
      member_count: number
    }>
    return {
      intent,
      company: companyName,
      totalDepartments: rows.length,
      departments: rows.map((row) => ({
        // 根部门是公司容器；公司改名后，通讯录工具展示的顶层名称也必须跟着改。
        name: row.parent_id === null ? companyName : row.name,
        depth: row.depth,
        leader: row.leader_name,
        memberCount: Number(row.member_count),
      })),
    }
  }

  if (intent === 'members' || intent === 'search') {
    const query = String(args.query ?? '').trim()
    const visible = visibleUserIds(db, actor)
    if (visible === null) {
      return {
        intent,
        denied: true,
        reason: '当前角色没有查看成员名单的权限（org:member:read），只能查看自己的部门、组长和部门列表。',
      }
    }
    const placeholders = visible.length > 0 ? visible.map(() => '?').join(',') : 'NULL'
    if (intent === 'members') {
      if (!query) throw new EabError(EC.VALIDATION, '查部门成员时 query 填部门名')
      const dept = db
        .prepare(
          `SELECT id, name FROM departments
            WHERE company_id = ? AND deleted_at IS NULL AND name LIKE ? LIMIT 1`,
        )
        .get(actor.subject.companyId, `%${query}%`) as { id: string; name: string } | undefined
      if (!dept) return { intent, query, found: false, message: `没有找到名称包含「${query}」的部门。` }
      const people = db
        .prepare(
          `SELECT u.name, u.title, d.name AS dept_name, m.name AS leader_name
             FROM users u JOIN departments d ON d.id = u.dept_id
             LEFT JOIN users m ON m.id = d.manager_user_id
            WHERE u.company_id = ? AND u.dept_id = ? AND u.deleted_at IS NULL AND u.status = 'active'
              AND u.id IN (${placeholders})
            ORDER BY u.name LIMIT 50`,
        )
        .all(actor.subject.companyId, dept.id, ...visible) as unknown as Array<{
        name: string
        title: string | null
        dept_name: string
        leader_name: string | null
      }>
      return {
        intent,
        department: dept.name,
        visible: people.length,
        people: people.map((row) => ({
          name: row.name,
          title: row.title,
          deptName: row.dept_name,
          leader: row.leader_name,
        })),
      }
    }
    if (!query) throw new EabError(EC.VALIDATION, '查人时 query 不能为空')
    const people = db
      .prepare(
        `SELECT u.name, u.title, u.employee_no, d.name AS dept_name, m.name AS leader_name
           FROM users u JOIN departments d ON d.id = u.dept_id
           LEFT JOIN users m ON m.id = d.manager_user_id
          WHERE u.company_id = ? AND u.deleted_at IS NULL AND u.status = 'active'
            AND u.id IN (${placeholders})
            AND (u.name LIKE ? OR u.employee_no LIKE ? OR u.title LIKE ?)
          ORDER BY u.name LIMIT 20`,
      )
      .all(actor.subject.companyId, ...visible, `%${query}%`, `%${query}%`, `%${query}%`) as unknown as Array<{
      name: string
      title: string | null
      employee_no: string | null
      dept_name: string
      leader_name: string | null
    }>
    return {
      intent,
      query,
      people: people.map((row) => ({
        name: row.name,
        title: row.title,
        employeeNo: row.employee_no,
        deptName: row.dept_name,
        leader: row.leader_name,
      })),
    }
  }

  throw new EabError(EC.VALIDATION, `不支持的 intent: ${intent}`, {
    hint: '可用 leader / me / departments / members / search',
  })
}

function orgSearch(db: Db, companyId: string, query: string) {
  return db
    .prepare(
      `SELECT u.name, u.title, u.employee_no, d.name AS dept_name
         FROM users u JOIN departments d ON d.id = u.dept_id
        WHERE u.company_id = ? AND u.deleted_at IS NULL AND u.status = 'active'
          AND (u.name LIKE ? OR u.employee_no LIKE ? OR u.title LIKE ?)
        ORDER BY u.name LIMIT 20`,
    )
    .all(companyId, `%${query}%`, `%${query}%`, `%${query}%`)
}

/** OpenAI function 名只允许字母数字下划线；工具 id 里的点换成下划线。 */
export function toolFunctionName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

export function resolveToolByFunctionName(name: string): ToolDef | undefined {
  return TOOLS.find((tool) => toolFunctionName(tool.id) === name)
}

/**
 * Agent 默认常驻的核心工具：高频、低参数、几乎每轮都可能用到。
 * 文件读写/搜索/文件夹、定时任务、计算、插件等通过能力路由或 tool_search 按需加载。
 * 这样工具数量继续增长时，首轮请求不会线性膨胀。
 */
export const AGENT_CORE_TOOL_IDS: readonly string[] = [
  'tool.search',
  'time.now',
  'math.eval',
  'plan.write',
  'plan.step',
  'agent.spawn',
  'agent.task',
  'agent.ask_parent',
  'agent.publish_artifact',
  'agent.wait',
  'agent.message',
  'agent.resume',
  'kb.search',
]

export interface ToolSearchHit {
  toolId: string
  functionName: string
  name: string
  description: string
  source: 'builtin' | 'plugin' | 'mcp'
  serverName?: string
  parameters: Array<{ name: string; type: string; description: string; required: boolean }>
  score: number
}

export interface ToolSearchResult {
  query: string
  total: number
  tools: ToolSearchHit[]
  hint: string
}

/** 把中文查询拆成短词，避免用户说“把文件发到钉钉”时整句匹配不到。 */
function toolSearchTerms(query: string): string[] {
  const lower = query.toLowerCase().trim()
  const terms = new Set<string>()
  if (lower) terms.add(lower)
  for (const token of lower.split(/[^a-z0-9_\u4e00-\u9fff]+/i)) {
    if (token) terms.add(token)
  }
  const han = lower.replace(/[^\u4e00-\u9fff]+/g, '')
  for (let i = 0; i < han.length - 1; i += 1) {
    const bigram = han.slice(i, i + 2)
    if (bigram.length === 2) terms.add(bigram)
  }
  const stopwords = new Set(['的', '了', '吗', '呢', '把', '给', '我', '你', '他', '她', '它', '请', '帮', '一个', '一下', '怎么', '如何', '什么', '哪些'])
  return [...terms].filter((term) => term.length >= 2 && !stopwords.has(term))
}

/** 工具描述之外的可检索同义词：中文口语、英文和常见叫法。 */
const TOOL_SEARCH_ALIASES: Record<string, string> = {
  'time.now': '时间 现在 几点 日期 今天 星期 time date now clock',
  'weather.now': '天气 气温 温度 多少度 几度 下雨 降雨 降水 下雪 降雪 预报 冷不冷 热不热 湿度 风力 weather forecast temperature rain snow',
  'web.search': '上网 联网 搜索 搜一下 查一下 查资料 最新 新闻 公告 网页 网站 链接 互联网 search web internet google baidu bing',
  'web.fetch': '读取网页 打开链接 总结链接 网页正文 网址 网页内容 公告原文 文章 链接 fetch url webpage article link read',
  browser: '浏览器 内置浏览器 打开网页 网页截图 点开 点击 页面快照 渲染 动态网页 登录后 网页操作 browser screenshot click snapshot',
  'schedule.create': '提醒 定时 日程 每天 每周 几点 定时任务 remind schedule timer',
  'schedule.list': '查看定时任务 我的任务 提醒列表 任务状态 schedule list',
  'schedule.delete': '取消定时任务 删除提醒 停止任务 cancel schedule delete',
  'math.eval': '计算 算一下 四则运算 加减乘除 数学 求和 合计 总计 汇总 平均 平均时长 小时 加班时长 金额合计 math calculate calculator sum total average',
  'org.directory': '通讯录 组织架构 部门 组长 上级 同事 成员 查找人 org directory',
  'org.search': '找人 搜索成员 姓名 工号 岗位 search member',
  'kb.search': '知识库 文档 资料 检索 搜索 制度 流程 kb rag search',
  'memory.propose': '团队学习 共享记忆 记住 规范 以后都这样 扩散 经验 沉淀 个人偏好 我的偏好 记住我的 我的格式 以后给我 我习惯 team memory learn share preference personal',
  'content.generate_image': '生成图片 画图 画一张 插图 插画 海报 配图 头像 文生图 image generate draw picture poster illustration',
  'workspace.list': '文件 列表 我的文件 云空间 workspace file list',
  'workspace.capacity': '容量 空间 剩余 配额 满了吗 capacity quota space',
  'workspace.write': '写文件 保存 新建文件 文本 整篇 write file save',
  'workspace.edit': '局部修改 局部编辑 只改一段 改字段 替换片段 修订 patch edit replace',
  'plugin.dev': '插件 自开发插件 给自己开发插件 开发插件 插件包 热安装 热更新 安装插件 预览插件 UI 挂件 小组件 卡片 页面 bundle dsh cordis slot plugin install hot reload preview widget',
  'skill.dev': '技能 自开发技能 给自己开发技能 开发技能 技能包 热安装 热更新 安装技能 预览技能 技能说明 提示词技能 SKILL.md skill install hot reload preview prompt skill',
  'workspace.read': '读文件 查看文件 打开文件 内容 read file',
  'office.read_outline': '读取文档结构 文档大纲 段落 表格 单元格 工作表 幻灯片 docx xlsx Excel pptx PowerPoint Office 文档结构 read outline document structure paragraph table sheet slide',
  'office.read_range': '读取文档范围 读全文 读段落全文 读表格 读单元格 读整行 读整列 文本区间 格式摘要 range read full text paragraph table cell row column runs font format docx',
  'office.find': '文档查找 在文档中找 定位文本 查找段落 查找单元格 查找幻灯片 xlsx pptx Excel PowerPoint find document search cell slide',
  'office.revisions': '读取修订 查看修订 修订记录 插入删除 作者 接受修订 拒绝修订 开启修订 关闭修订 track changes revision accept reject w:ins w:del docx',
  'office.replace': '替换文档文本 改段落 改单元格 修改word 修改Excel 修改PPT xlsx xlsm pptx replace office text update cell formula slide paragraph',
  'office.rewrite': '整段重写 整段改写 统一格式 统一加粗 统一字号 rewrite paragraph uniform format docx',
  'office.insert': '插入段落 新增段落 插入整行 插入整列 删除整行 删除整列 合并单元格 拆分单元格 删除表格行 删除表格列 xlsx Excel insert delete merge split paragraph row column office',
  'office.format': '设置格式 加粗 斜体 下划线 字体颜色 高亮 填充 数字格式 字号 format bold italic underline color highlight fill numberFormat number format font size xlsx',
  'office.comment': '加批注 批注 评论 单元格批注 工作表批注 Excel批注 回复批注 解决批注 删除批注 批注列表 短语批注 comment annotation note list reply resolve delete xlsx Excel cell comment',
  'office.versions': '历史版本 版本列表 版本快照 手动快照 恢复到历史版本 回退 撤销 旧版本 version versions snapshot restore rollback history',
  'office.export': '导出PDF 转PDF 文档转PDF 导出图片 export pdf convert print',
  'office.gui': '打印 打印设置 宏 宏管理器 导出选项 页面设置 页眉页脚 原生对话框 GUI兜底 人工兜底 print macro export dialog fallback',
  'workspace.send_dingtalk': '发送文件 发文件 发给我 钉钉 发图片 图片发我 发送图片 发图 send file image picture dingtalk attachment',
  'workspace.rename': '重命名 改名 文件名 rename file',
  'workspace.delete': '删除文件 删掉 清理文件 delete file remove',
  'workspace.folder': '文件夹 目录 新建文件夹 创建文件夹 建目录 重命名文件夹 改名文件夹 删除文件夹 移除目录 folder directory mkdir rmdir rename folder delete folder',
  'admin.password.reset': '重置密码 改密码 成员密码 password reset',
}

/**
 * 在当前员工可见、当前空间可用的工具里做轻量检索。
 * 只返回名称、用途和参数提示，不返回完整 JSON Schema；完整 Schema 由 Agent 循环按命中结果加载。
 */
export function searchToolCatalog(
  db: Db,
  actor: Actor,
  space: ActiveSpace = { kind: 'cloud' },
  query: string,
  limit = 8,
): ToolSearchResult {
  const clean = query.trim()
  if (!clean) throw new EabError(EC.VALIDATION, 'query 不能为空')
  const capped = Math.min(12, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 8))
  const specs = toolSpecsForActor(db, actor, space, clean)
  const builtinByFunction = new Map(TOOLS.map((tool) => [toolFunctionName(tool.id), tool]))
  const terms = toolSearchTerms(clean)
  const hits: ToolSearchHit[] = []

  for (const spec of specs) {
    if (spec.function.name === 'tool_search') continue
    const def = builtinByFunction.get(spec.function.name)
    const mcpEntry = !def && spec.function.name.startsWith('mcp_')
      ? resolveMcpToolForActor(db, actor, spec.function.name)
      : null
    const name = def?.name
      ?? (mcpEntry ? `${mcpEntry.tool.name}（${mcpEntry.server.name}）` : spec.function.name)
    const description = def?.description ?? spec.function.description
    const id = def?.id ?? mcpEntry?.toolId ?? spec.function.name
    const alias = TOOL_SEARCH_ALIASES[id] ?? (mcpEntry ? `mcp 外部工具 服务器 ${mcpEntry.server.name} ${mcpEntry.tool.name}` : '')
    const haystack = `${spec.function.name} ${id} ${name} ${description} ${alias} ${mcpEntry?.server.name ?? ''}`.toLowerCase()
    let score = 0
    if (haystack.includes(clean.toLowerCase())) score += 50
    for (const term of terms) {
      if (spec.function.name.toLowerCase() === term) score += 120
      else if (spec.function.name.toLowerCase().includes(term)) score += 22
      if (name.toLowerCase() === term) score += 100
      else if (name.toLowerCase().includes(term)) score += 30
      if (id.toLowerCase().includes(term)) score += 14
      if (alias.includes(term)) score += 12
      if (description.toLowerCase().includes(term)) score += 9
    }
    if (score <= 0) continue
    const required = spec.function.parameters.required ?? []
    hits.push({
      toolId: id,
      functionName: spec.function.name,
      name,
      description: description.length > 220 ? `${description.slice(0, 220)}…` : description,
      source: def ? 'builtin' : mcpEntry ? 'mcp' : 'plugin',
      ...(mcpEntry ? { serverName: mcpEntry.server.name } : {}),
      parameters: Object.entries(spec.function.parameters.properties ?? {}).map(([key, value]) => ({
        name: key,
        type: value.type,
        description: value.description ?? '',
        required: required.includes(key),
      })),
      score,
    })
  }

  hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-CN'))
  return {
    query: clean,
    total: hits.length,
    tools: hits.slice(0, capped),
    hint: hits.length
      ? '这些工具已按匹配度排序，并会在本次工具结果之后自动加载完整参数；直接继续调用即可，不需要让用户再次确认，也不要向用户解释工具加载机制。'
      : '没有匹配到可用工具；换一个中文/英文能力词再试，或直接说明做不到。',
  }
}

/** Agent 首轮只提交核心工具 + 当前能力路由命中的工具组；其余按需加载。 */
export function toolSpecsForAgent(
  db: Db,
  actor: Actor,
  space: ActiveSpace = { kind: 'cloud' },
  query = '',
  options: {
    activeFile?: { name?: string | null }
    allowPlanTools?: boolean
    /** 独立验收员专用：把 review.verdict 放进本轮工具目录 */
    allowReviewTools?: boolean
    /** 岗位卡硬 allowlist：卡里登记的工具必须直接可见，不能等能力路由命中 */
    toolIdAllowlist?: readonly string[]
  } = {},
): ChatToolSpec[] {
  // 计划是主 Agent 的编排对象；子 Agent 的 sessionId 是隔离的 agent:* 会话，
  // 让它写计划只会污染计划表并让前端看不到，所以默认不给子 Agent。
  const coreNames = new Set(
    AGENT_CORE_TOOL_IDS
      .filter((id) => options.allowPlanTools !== false || !id.startsWith('plan.'))
      .map(toolFunctionName),
  )
  if (options.allowReviewTools) coreNames.add(toolFunctionName('review.verdict'))
  /**
   * 能力路由只决定“直接下发哪些工具组”，不绕过角色/空间/权限过滤。
   * 没命中的工具仍可通过 tool_search 加载，避免每轮把所有 Office/项目/开发工具都塞进上下文。
   */
  const route = routeCapabilities(query, { activeFile: options.activeFile })
  const routedIds: string[] = []
  // 没有 query 的调用（定时任务旧入口、内部目录枚举）保持原有文件能力，避免未知上下文丢工具。
  if (query.trim() === '' || route.workspace) routedIds.push(...CAPABILITY_TOOL_GROUPS.workspace)
  if (route.office) routedIds.push(...officeToolIdsForQuery(query))
  if (route.project) routedIds.push(...CAPABILITY_TOOL_GROUPS.project)
  // 本地项目空间把文件工具常驻，不依赖关键词命中：用户可能只说“继续做”。
  if (space.kind === 'local') routedIds.push(...CAPABILITY_TOOL_GROUPS.projectFiles)
  if (route.pluginDev) routedIds.push(...CAPABILITY_TOOL_GROUPS.pluginDev)
  if (route.skillDev) routedIds.push(...CAPABILITY_TOOL_GROUPS.skillDev)
  if (route.schedule) routedIds.push(...CAPABILITY_TOOL_GROUPS.schedule)
  if (route.org) routedIds.push(...CAPABILITY_TOOL_GROUPS.org)
  if (route.weather) routedIds.push(...CAPABILITY_TOOL_GROUPS.weather)
  if (route.web) routedIds.push(...CAPABILITY_TOOL_GROUPS.web)
  if (route.browser) routedIds.push(...CAPABILITY_TOOL_GROUPS.browser)
  if (route.memoryRule) routedIds.push(...CAPABILITY_TOOL_GROUPS.memoryRule)
  if (route.content) routedIds.push(...CAPABILITY_TOOL_GROUPS.content)
  const allowedCore = new Set([...coreNames, ...routedIds.map(toolFunctionName)])
  // 岗位卡工具是硬合同：只要卡里登记且空间/权限允许，就直接进入工具表，
  // 不要求任务的提问文本一定命中 workspace/project/office 路由关键词。
  if (options.toolIdAllowlist) {
    for (const id of options.toolIdAllowlist) allowedCore.add(toolFunctionName(id))
  }
  // A2A 远端 Agent 已同步时，主 Agent 本轮就能直接看见派遣工具；没有可用 Peer 时仍可按需搜索，不占上下文。
  if (hasUsableA2APeers(db, actor.subject.companyId)) {
    allowedCore.add(toolFunctionName('a2a.delegate'))
    allowedCore.add(toolFunctionName('a2a.cancel'))
  }
  // 单文件局部编辑直接走 office.find → replace/format → read_range，
  // 不下发团队工具，避免模型把“定位一段”拆成子任务后误以为已经写入。
  if (isSingleFileOfficeEdit(query, { activeFile: options.activeFile })) {
    for (const name of allowedCore) {
      if (name.startsWith('agent_') || name.startsWith('a2a_')) allowedCore.delete(name)
    }
  }
  /**
   * 插件工具不能只依赖 tool_search：插件通常是业务数据入口，模型按
   * “查工区/班次/某个组织的数据”搜索时，工具名和描述未必命中业务词。
   * 因此业务意图命中时整包下发；普通闲聊只下发与问题词面相关的插件工具，
   * 其余插件工具仍可由 tool_search 加载，不再每轮固定携带全部 schema。
   */
  const pluginNames = new Set(
    pluginToolSpecsForQuery(db, actor, query, { preferPersonal: prefersPersonalPluginTools(query) }).map((spec) => {
      const fn = spec.function as { name?: unknown } | undefined
      return String(fn?.name ?? '')
    }),
  )
  const specs = toolSpecsForActor(db, actor, space, query)
  return specs.filter((spec) => allowedCore.has(spec.function.name) || pluginNames.has(spec.function.name))
}

/** 云空间是唯一可用的文件空间；none 不暴露文件工具。 */
function resolvePluginDevDir(root: string, raw: unknown): string {
  const value = String(raw ?? '').trim()
  if (value === '') return ''
  if (isAbsolute(value)) {
    const rel = relative(root, value)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new EabError(EC.VALIDATION, `插件目录必须位于当前云空间内：${value}`)
    }
    return value
  }
  return safeJoin(root, value.replace(/\\/g, '/'))
}

function resolveSkillDevDir(root: string, raw: unknown): string {
  const value = String(raw ?? '').trim()
  if (value === '') return ''
  if (isAbsolute(value)) {
    const rel = relative(root, value)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new EabError(EC.VALIDATION, `技能目录必须位于当前云空间内：${value}`)
    }
    return value
  }
  return safeJoin(root, value.replace(/\\/g, '/'))
}

function toolAllowedInSpace(toolId: string, space: ActiveSpace): boolean {
  if (toolId === 'plugin.dev') return space.kind === 'cloud'
  if (toolId === 'skill.dev') return space.kind === 'cloud'
  if (toolId.startsWith('workspace.') || toolId.startsWith('office.')) return space.kind === 'cloud'
  // 本地文件工具只在本地项目空间出现；云空间继续使用 workspace.*。
  if (toolId.startsWith('project.') && !['project.exec', 'project.job'].includes(toolId)) {
    return space.kind === 'local'
  }
  if (toolId === 'project.exec' || toolId === 'project.job') {
    if (resolveProjectExecMode() === 'off') return false
    // 云空间仍保留原有的项目命令能力；本地项目空间使用自己的根目录。
    return space.kind === 'cloud' || space.kind === 'local'
  }
  return true
}

/** 本地项目工具直接使用会话已校验的空间对象，不重新查库，避免子 Agent 跨员工拿项目。 */
function localProjectForSpace(space: ActiveSpace): LocalProject {
  if (space.kind !== 'local') {
    throw new EabError(EC.FORBIDDEN, '当前不在本地项目空间，不能使用本地项目文件工具')
  }
  return {
    id: space.id,
    name: space.name,
    rootPath: space.root,
    rootRealPath: space.root,
    mode: space.mode,
    allowSensitive: space.allowSensitive,
    deviceId: space.deviceId,
    instructions: space.instructions,
    cloudRefs: space.cloudRefs,
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
  }
}

function projectRootForSpace(
  deps: ServerDeps,
  actor: RequestActor,
  space: ActiveSpace,
): string {
  if (space.kind === 'local') return space.root
  return userScopeDir(deps, actor.subject.companyId, actor.subject.userId)
}

/** 模型有时把 steps 作为 JSON 字符串传；两种都接住，非法输入在写库前就报清楚。 */
function parsePlanStepsArgument(raw: unknown): AgentPlanStepInput[] {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      throw new EabError(EC.VALIDATION, 'plan.write 的 steps 必须是 JSON 数组，或按 schema 直接传数组')
    }
  }
  if (!Array.isArray(value)) {
    throw new EabError(EC.VALIDATION, 'plan.write 的 steps 必须是数组')
  }
  return value.map((step, index) => {
    if (!step || typeof step !== 'object') {
      throw new EabError(EC.VALIDATION, `plan.write 第 ${index + 1} 步必须是对象`)
    }
    const record = step as Record<string, unknown>
    return {
      title: String(record.title ?? ''),
      detail: record.detail === undefined ? undefined : String(record.detail),
      owner: record.owner === undefined ? undefined : String(record.owner),
      status: record.status === undefined ? undefined : String(record.status) as AgentPlanStepStatus,
    }
  })
}

interface OfficeFileRef {
  fileId: string
  name: string
  relPath: string
  version: string
  buffer: Buffer
}

/** xlsx 与 xlsm 共用 OOXML 内容层；xlsm 只多一个 vbaProject 部件，局部改 XML 不会丢宏。 */
function isXlsxFileName(name: string): boolean {
  return /\.(xlsx|xlsm)$/i.test(name)
}

function isPptxFileName(name: string): boolean {
  return /\.pptx$/i.test(name)
}

/** 解析 office 工具的 fileId/path 参数；docx 与 xlsx 共用这段定位逻辑。 */
function resolveOfficeFile(
  deps: ServerDeps,
  actor: RequestActor,
  args: Record<string, unknown>,
): OfficeFileRef {
  const fileIdArg = String(args.fileId ?? '').trim()
  const pathArg = String(args.path ?? '').trim()
  let row: { id: string; name: string; rel_path: string; updated_at: string } | undefined
  if (fileIdArg) {
    row = deps.db
      .prepare(
        `SELECT id, name, rel_path, updated_at FROM workspace_files
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(fileIdArg, actor.subject.companyId) as typeof row
  } else if (pathArg) {
    row = deps.db
      .prepare(
        `SELECT id, name, rel_path, updated_at FROM workspace_files
          WHERE company_id = ? AND owner_user_id = ? AND deleted_at IS NULL
            AND (rel_path = ? OR name = ?)
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(actor.subject.companyId, actor.subject.userId, pathArg, pathArg) as typeof row
  } else {
    throw new EabError(EC.VALIDATION, 'fileId 和 path 至少提供一个')
  }
  if (!row) throw new EabError(EC.NOT_FOUND, '云空间里没有找到该文件')
  const file = readUserWorkspaceFile(deps, actor, row.id)
  return {
    fileId: file.id,
    name: file.name,
    relPath: file.relPath,
    version: row.updated_at,
    buffer: file.buffer,
  }
}

function resolveOfficeDocx(
  deps: ServerDeps,
  actor: RequestActor,
  args: Record<string, unknown>,
): OfficeFileRef {
  const file = resolveOfficeFile(deps, actor, args)
  if (!/\.docx$/i.test(file.name)) {
    throw new EabError(EC.VALIDATION, `${file.name} 不是 docx；xlsx/xlsm/pptx 请用 office.find/office.replace 做局部替换`)
  }
  return file
}

/** 取当前对话对应的钉钉机器人单聊 openConversationId；网页会话或旧会话可能为空。 */
function openConversationIdForTool(
  deps: ServerDeps,
  companyId: string,
  context: ToolExecutionContext,
): string {
  const sessionId = String(context.sessionId ?? '').trim()
  if (!sessionId) return ''
  const row = deps.db
    .prepare(
      `SELECT open_conversation_id FROM chat_sessions
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL
        LIMIT 1`,
    )
    .get(sessionId, companyId) as { open_conversation_id: string | null } | undefined
  return String(row?.open_conversation_id ?? '').trim()
}

/** 给对话模型用的工具声明：内置工具 + 当前员工已安装且启用插件的工具。 */
export function toolSpecsForActor(
  db: Db,
  actor: Actor,
  space: ActiveSpace = { kind: 'cloud' },
  query = '',
): ChatToolSpec[] {
  const roleAccess = readToolRoleAccessMap(db, actor.subject.companyId)
  const builtin: ChatToolSpec[] = TOOLS.filter(
    (tool) =>
      !tool.dangerous &&
      toolAllowedForRoles(roleAccess.get(tool.id), actor.subject.roles ?? []) &&
      actor.subject.scopes.has(tool.scope) &&
      toolAllowedInSpace(tool.id, space),
  ).map((tool): ChatToolSpec => ({
    type: 'function' as const,
    function: {
      name: toolFunctionName(tool.id),
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(tool.input).map(([key, value]) => {
            const { required: _required, ...schema } = value
            return [key, schema]
          }),
        ),
        required: Object.entries(tool.input)
          .filter(([, value]) => value.required)
          .map(([key]) => key),
        additionalProperties: false,
      },
    },
  }))
  const builtinNames = new Set(builtin.map((tool) => tool.function.name))
  const pluginSpecs = pluginToolSpecsFor(db, actor, {
    preferPersonal: prefersPersonalPluginTools(query),
  })
    .map((spec) => spec as unknown as ChatToolSpec)
    // 插件工具不能覆盖 EAB 内置工具的同名 function
    .filter((spec) => !builtinNames.has(spec.function.name))
  const pluginNames = new Set(pluginSpecs.map((spec) => spec.function.name))
  const mcpSpecs = mcpToolSpecsFor(db, actor)
    .map((spec) => spec as ChatToolSpec)
    // MCP 是外部工具源，不能覆盖内置或已安装插件的同名 function
    .filter((spec) => !builtinNames.has(spec.function.name) && !pluginNames.has(spec.function.name))
  return [...builtin, ...pluginSpecs, ...mcpSpecs]
}

/** 执行一个工具。鉴权在本函数内再做一次，调用方仍需自己处理高危审批。 */
/**
 * 工具参数兜底：模型漏传 fileId / path 时，回落到右侧预览文件。
 * 规则刻意保守：
 * - 只在「fileId 和 path 都没给」时才补，绝不覆盖模型自己写的值；
 * - office_* 补 fileId；workspace.read 补相对路径；
 * - 其它工具一律不动，避免张冠李戴。
 */
export function withActiveFileDefaults(
  toolId: string,
  args: Record<string, unknown>,
  activeFile?: { id: string; relPath?: string },
): Record<string, unknown> {
  if (!activeFile?.id) return args
  const hasFileId = typeof args.fileId === 'string' && args.fileId.trim() !== ''
  const hasPath = typeof args.path === 'string' && args.path.trim() !== ''
  if (toolId.startsWith('office.')) {
    return hasFileId || hasPath ? args : { ...args, fileId: activeFile.id }
  }
  if (toolId === 'workspace.read' && !hasPath && activeFile.relPath) {
    return { ...args, path: activeFile.relPath }
  }
  return args
}

export async function executeTool(
  deps: ServerDeps,
  actor: Actor,
  toolId: string,
  rawArgs: Record<string, unknown>,
  space: ActiveSpace = { kind: 'cloud' },
  context: ToolExecutionContext = {},
): Promise<unknown> {
  const tool = TOOLS.find((item) => item.id === toolId)
  if (!tool) throw new EabError(EC.NOT_FOUND, `工具不存在: ${toolId}`)
  const args = withActiveFileDefaults(tool.id, rawArgs, context.activeFile)
  if (!toolAllowedForActor(deps.db, actor, tool.id)) {
    throw new EabError(EC.FORBIDDEN, `当前角色不可使用工具「${tool.name}」`, {
      details: { toolId: tool.id, roles: actor.subject.roles ?? [] },
      hint: '请管理员在控制台「工具」页调整该工具的可用角色',
    })
  }
  requireScope(actor.subject, tool.scope)
  if (!toolAllowedInSpace(tool.id, space)) {
    throw new EabError(EC.FORBIDDEN, `工具 ${tool.id} 不属于当前文件空间`)
  }

  // 高危工具先过审批门禁，再抢并发名额和资源锁：等待审批时不能占着工具槽位，
  // 否则一个没人点的审批会把整类工具卡死。
  if (requiresToolApprovalForArgs(tool, args)) {
    const mode: ToolApprovalMode =
      context.approval ?? (process.env.NODE_ENV === 'test' ? 'bypass' : 'defer')
    await ensureToolApproval(deps.db, actor.subject, tool, args, {
      mode,
      approvalId: context.approvalId,
      toolName: tool.name,
      messageId: context.messageId,
      sessionId: context.sessionId,
      runId: context.traceId,
      turnId: context.turnId,
      channel: context.channel,
      traceId: context.traceId,
      signal: context.signal,
      onPending: context.onApprovalPending,
    })
  }

  const startedAt = Date.now()
  let toolRelease: (() => void) | null = null
  try {
    const lease = await acquireCoordinationSlot(`tool:${tool.id}`, {
      limit: toolConcurrencyLimit(tool, deps),
      ttlSec: 300,
      waitMs: deps.config.toolTimeoutMs ?? 30_000,
      queueLimit: deps.config.toolQueueLimit ?? 200,
      signal: context.signal,
    })
    // 从占到名额开始登记「正在执行」，随 release 一起注销（释放点只有一个，不会漏）。
    const inflight = beginToolInflight({ toolId: tool.id, channel: context.channel ?? null })
    toolRelease = () => {
      inflight.end()
      lease.release()
    }
  } catch (error) {
    recordToolRun(tool.id, Date.now() - startedAt, 'failed', 0)
    if (error instanceof SemaphoreTimeoutError) {
      throw new EabError(EC.RATE_LIMITED, '工具并发已满，等待超时，请稍后重试', {
        details: { toolId: tool.id, timeoutMs: error.timeoutMs },
      })
    }
    if (error instanceof SemaphoreQueueFullError) {
      throw new EabError(EC.RATE_LIMITED, '工具排队已满，请稍后重试', {
        details: { toolId: tool.id, queueLimit: error.queueLimit },
      })
    }
    if (error instanceof LockAbortedError) {
      throw new EabError(EC.CONFLICT, '操作已取消')
    }
    throw error
  }

  const lockStartedAt = Date.now()
  const lockKey = tool.concurrency && tool.concurrency !== 'read'
    ? tool.lockKey?.(deps, actor, args, space) ?? null
    : null
  let release: (() => void) | null = null
  if (lockKey) {
    try {
      release = await toolResourceLocks.acquire(lockKey, {
        timeoutMs: 30_000,
        signal: context.signal,
      })
    } catch (error) {
      toolRelease?.()
      recordToolRun(tool.id, Date.now() - startedAt, 'failed', Date.now() - lockStartedAt)
      if (error instanceof LockTimeoutError) {
        throw new EabError(EC.CONFLICT, '资源正被其他 Agent 占用，等待超时，请稍后重试', {
          details: { resource: lockKey },
        })
      }
      if (error instanceof LockAbortedError) {
        throw new EabError(EC.CONFLICT, '操作已取消')
      }
      throw error
    }
  }
  const lockWaitMs = lockKey ? Date.now() - lockStartedAt : 0

  const operationKey = tool.idempotent
    ? resolveToolOperationKey({
        toolId: tool.id,
        args,
        turnId: context.turnId,
        idempotencyKey: context.idempotencyKey,
      })
    : null
  let operationId: string | null = null
  if (operationKey) {
    let start: ReturnType<typeof beginToolOperation>
    try {
      start = beginToolOperation({
        db: deps.db,
        companyId: actor.subject.companyId,
        userId: actor.subject.userId,
        toolId: tool.id,
        key: operationKey,
      })
    } catch (error) {
      // 幂等表写入失败时不能把资源锁/工具名额留在手里。
      release?.()
      toolRelease?.()
      recordToolRun(tool.id, Date.now() - startedAt, 'failed', lockWaitMs)
      throw error
    }
    if (start.kind === 'replay') {
      release?.()
      toolRelease?.()
      recordToolRun(tool.id, Date.now() - startedAt, 'replay', lockWaitMs)
      return start.result
    }
    if (start.kind === 'busy') {
      release?.()
      toolRelease?.()
      recordToolRun(tool.id, Date.now() - startedAt, 'failed', lockWaitMs)
      throw new EabError(EC.CONFLICT, '同一操作正在执行，请稍后重试', {
        details: { toolId: tool.id, retryAfterMs: start.retryAfterMs },
      })
    }
    operationId = start.id
  }

  if (tool.id === 'web.search' || tool.id === 'web.fetch' || tool.id === 'browser') {
    try {
      assertWebToolRateLimit(actor.subject.companyId, actor.subject.userId, tool.id)
    } catch (error) {
      release?.()
      toolRelease?.()
      if (operationId) failToolOperation(deps.db, operationId, error)
      recordToolRun(tool.id, Date.now() - startedAt, 'failed', lockWaitMs)
      throw error
    }
  }

  let toolStatus: 'ok' | 'failed' = 'ok'
  let webAudit: { toolId: WebToolId; detail: Record<string, unknown> } | null = null
  try {
    let result: unknown
    const now = new Date()
    switch (tool.id) {
    case 'a2a.delegate': {
      const seconds = args.timeoutSeconds === undefined ? 120 : Number(args.timeoutSeconds)
      result = await delegateA2ATask({
        db: deps.db,
        dbPath: deps.config.dbPath,
        actor,
        peer: args.peer,
        prompt: args.prompt,
        skill: args.skill,
        contextId: args.contextId,
        traceId: context.traceId,
        timeoutMs: (Number.isFinite(seconds) ? seconds : 120) * 1_000,
        signal: context.signal,
      })
      break
    }
    case 'a2a.cancel':
      result = await cancelA2ADelegation({
        db: deps.db,
        dbPath: deps.config.dbPath,
        actor,
        delegationId: args.delegationId,
        timeoutMs: 30_000,
        signal: context.signal,
      })
      break
    case 'review.verdict': {
      if (!context.sessionId?.startsWith('agent:critic:')) {
        throw new EabError(EC.FORBIDDEN, '验收结论只能由独立验收员会话提交')
      }
      const verdict = String(args.verdict ?? '').trim().toLowerCase()
      if (verdict !== 'approve' && verdict !== 'reject') {
        throw new EabError(EC.VALIDATION, '验收结论必须是 approve 或 reject')
      }
      const reason = String(args.reason ?? '').replace(/\s+/g, ' ').trim()
      if (!reason) throw new EabError(EC.VALIDATION, '验收结论必须写明理由')
      const evidence = (Array.isArray(args.evidence) ? args.evidence : [])
        .map((item) => String(item ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 8)
      if (evidence.length === 0) throw new EabError(EC.VALIDATION, '验收结论至少需要 1 条具体证据')
      result = {
        accepted: true,
        verdict,
        reason: reason.slice(0, 2_000),
        evidence: evidence.map((item) => item.slice(0, 600)),
      }
      break
    }
    case 'plan.write': {
      if (!context.sessionId || context.sessionId.startsWith('agent:')) {
        throw new EabError(EC.VALIDATION, '任务计划只能由主 Agent 在用户对话会话内维护')
      }
      result = writeAgentPlan(deps.db, {
        companyId: actor.subject.companyId,
        userId: actor.person.id,
        sessionId: context.sessionId,
        traceId: context.traceId ?? null,
        planKey: args.planKey === undefined ? null : String(args.planKey),
        title: args.title === undefined ? null : String(args.title),
        steps: parsePlanStepsArgument(args.steps),
      })
      break
    }
    case 'plan.step': {
      if (!context.sessionId || context.sessionId.startsWith('agent:')) {
        throw new EabError(EC.VALIDATION, '任务计划只能由主 Agent 在用户对话会话内维护')
      }
      const status = String(args.status ?? '')
      if (!['pending', 'running', 'done', 'failed', 'skipped'].includes(status)) {
        throw new EabError(EC.VALIDATION, `计划步骤状态不合法: ${status || '空'}`)
      }
      result = updateAgentPlanStep(deps.db, {
        companyId: actor.subject.companyId,
        userId: actor.person.id,
        sessionId: context.sessionId,
        traceId: context.traceId ?? null,
        planKey: args.planKey === undefined ? null : String(args.planKey),
        seq: Number(args.seq),
        status: status as AgentPlanStepStatus,
        note: args.note === undefined ? null : String(args.note),
      })
      break
    }
    case 'agent.spawn':
      throw new EabError(EC.VALIDATION, 'agent.spawn 只能由对话 Agent 调度器执行')
    case 'agent.task':
      throw new EabError(EC.VALIDATION, 'agent.task 只能由对话 Agent 调度器执行')
    case 'agent.publish_artifact': {
      if (!context.agentTaskId || !context.agentTeam) {
        throw new EabError(EC.FORBIDDEN, '只有正在执行的子 Agent 任务可以登记产物')
      }
      const artifact = await publishAgentArtifact({
        db: deps.db,
        team: context.agentTeam,
        taskId: context.agentTaskId,
        companyId: actor.subject.companyId,
        userId: actor.person.id,
        workspaceRoot: userScopeDir(deps, actor.subject.companyId, actor.person.id),
        path: args.path === undefined ? undefined : String(args.path),
        fileId: args.fileId === undefined ? undefined : String(args.fileId),
        uri: args.uri === undefined ? undefined : String(args.uri),
        name: args.name === undefined ? undefined : String(args.name),
        mimeType: args.mimeType === undefined ? undefined : String(args.mimeType),
        preview: args.preview === undefined ? undefined : String(args.preview),
      })
      result = {
        ok: true,
        artifact,
        taskArtifactCount: context.agentTeam.listArtifacts(context.agentTaskId).length,
      }
      break
    }
    case 'tool.search':
      result = searchToolCatalog(deps.db, actor, space, String(args.query ?? ''), args.limit === undefined ? 8 : Number(args.limit))
      break
    case 'time.now':
      result = { iso: now.toISOString(), local: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }
      break
    case 'weather.now':
      result = await getWeather({
        location: String(args.location ?? ''),
        days: args.days === undefined ? undefined : Number(args.days),
      })
      break
    case 'web.search': {
      const query = String(args.query ?? '')
      webAudit = {
        toolId: 'web.search',
        detail: {
          query: query.slice(0, 120),
          site: args.site === undefined ? null : String(args.site).slice(0, 120),
          requestedCount: args.count === undefined ? null : Number(args.count),
        },
      }
      const searchResult = await searchWeb(
        {
          query,
          count: args.count === undefined ? undefined : Number(args.count),
          freshness:
            args.freshness === 'day' || args.freshness === 'week' || args.freshness === 'month'
              ? args.freshness
              : 'all',
          site: args.site === undefined ? undefined : String(args.site),
        },
        { env: effectiveWebSearchEnv(deps.config.dbPath) },
      )
      result = searchResult
      webAudit.detail = {
        ...webAudit.detail,
        provider: searchResult.provider,
        configured: searchResult.configured,
        total: searchResult.total,
      }
      break
    }
    case 'web.fetch': {
      const url = String(args.url ?? '')
      webAudit = {
        toolId: 'web.fetch',
        detail: {
          url: url.slice(0, 2_000),
          format: args.format === 'html' ? 'html' : 'text',
        },
      }
      const fetched = await webFetch({
        url,
        format: args.format === 'html' ? 'html' : 'text',
        maxChars: args.maxChars === undefined ? undefined : Number(args.maxChars),
        start: args.start === undefined ? undefined : Number(args.start),
      })
      result = fetched
      webAudit.detail = {
        ...webAudit.detail,
        finalUrl: fetched.finalUrl,
        title: fetched.title,
        chars: fetched.text.length,
        truncated: fetched.truncated,
      }
      break
    }
    case 'browser': {
      const status = browserStatus()
      if (!status.enabled) {
        throw new EabError(EC.VALIDATION, '内置浏览器已关闭', { hint: '让管理员设置 EAB_BROWSER_ENABLED=1' })
      }
      webAudit = {
        toolId: 'browser',
        detail: {
          action: String(args.action ?? ''),
          pageId: args.pageId === undefined ? null : String(args.pageId),
          url: args.url === undefined ? null : String(args.url).slice(0, 2_000),
        },
      }
      const browserPolicy = browserNetworkSettingsView()
      const desktopDeviceId = deps.desktopBridge?.resolveOnlineDevice(
        actor.subject.companyId,
        actor.person.id,
        context.desktopDeviceId,
      )
      const desktopAction = String(args.action ?? '').trim()
      const desktopBrowserActions = new Set([
        'open', 'snapshot', 'list', 'activate', 'click', 'type', 'scroll',
        'back', 'forward', 'reload', 'navigate', 'screenshot', 'close',
      ])
      if (desktopDeviceId && desktopBrowserActions.has(desktopAction)) {
        if (!['open', 'navigate'].includes(desktopAction) && args.url !== undefined && String(args.url).trim()) {
          throw new EabError(EC.VALIDATION, `action=${desktopAction} 不需要 url`)
        }
        let targetUrl = args.url === undefined ? undefined : String(args.url)
        if (desktopAction === 'open' || desktopAction === 'navigate') {
          if (!targetUrl || !targetUrl.trim()) throw new EabError(EC.VALIDATION, `${desktopAction} 需要 url`)
          targetUrl = (await assertPublicHttpUrl(targetUrl, {
            allowPrivateNetwork: browserPolicy.enabled,
            privateNetworkHosts: browserPolicy.enabled ? browserPolicy.allowedHosts : [],
          })).href
        }
        const payload = await deps.desktopBridge!.browserCall<Record<string, unknown>>(
          actor.subject.companyId,
          actor.person.id,
          desktopDeviceId,
          {
            action: desktopAction,
            sessionId: context.sessionId ? String(context.sessionId) : undefined,
            url: targetUrl,
            pageId: args.pageId === undefined ? undefined : String(args.pageId),
            ref: args.ref === undefined ? undefined : String(args.ref),
            text: args.text === undefined ? undefined : String(args.text),
            direction: args.direction === 'up' ? 'up' : 'down',
          },
          30_000,
        )
        let screenshot: { fileId: string; name: string; relPath: string; size: number; mime: string } | null = null
        if (typeof payload.screenshotBase64 === 'string' && payload.screenshotBase64) {
          const buffer = Buffer.from(payload.screenshotBase64, 'base64')
          const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
          const saved = saveUserWorkspaceFile(deps, actor, {
            relPath: `浏览器截图-${stamp}.png`,
            buffer,
            mime: 'image/png',
            channel: context.channel,
          })
          screenshot = {
            fileId: saved.id,
            name: saved.name,
            relPath: saved.relPath,
            size: saved.size,
            mime: saved.mime ?? 'image/png',
          }
        }
        const browserFields = { ...payload }
        delete browserFields.screenshotBase64
        delete browserFields.screenshotMime
        delete browserFields.screenshotWidth
        delete browserFields.screenshotHeight
        delete browserFields.tabs
        delete browserFields.activePageId
        delete browserFields.native
        const nativeResult = {
          action: desktopAction,
          pageId: typeof browserFields.pageId === 'string' ? browserFields.pageId : null,
          title: typeof browserFields.title === 'string' ? browserFields.title : null,
          url: typeof browserFields.url === 'string' ? browserFields.url : null,
          text: typeof browserFields.text === 'string' ? browserFields.text : null,
          elements: Array.isArray(browserFields.elements) ? browserFields.elements : [],
          screenshot,
          truncated: Boolean(browserFields.truncated),
          closed: Boolean(browserFields.closed),
          hint: typeof browserFields.hint === 'string' ? browserFields.hint : null,
          native: true,
          tabs: Array.isArray(payload.tabs) ? payload.tabs : undefined,
          activePageId: typeof payload.activePageId === 'string' ? payload.activePageId : undefined,
        }
        result = nativeResult
        webAudit.detail = {
          ...webAudit.detail,
          surface: 'desktop',
          deviceId: desktopDeviceId,
          action: desktopAction,
          url: nativeResult.url,
          title: nativeResult.title,
          elements: nativeResult.elements.length,
          screenshotFileId: screenshot?.fileId ?? null,
          closed: nativeResult.closed,
        }
        break
      }
      if (!desktopDeviceId && ['list', 'activate'].includes(desktopAction)) {
        throw new EabError(EC.CONFLICT, `action=${desktopAction} 只支持桌面端右侧浏览器`, {
          hint: '打开 EAB 桌面端并保持登录后重试；网页模式没有可列出的桌面标签页。',
        })
      }
      const browserResult = await executeBrowserAction(
        {
          action: String(args.action ?? '') as BrowserAction,
          url: args.url === undefined ? undefined : String(args.url),
          pageId: args.pageId === undefined ? undefined : String(args.pageId),
          ref: args.ref === undefined ? undefined : String(args.ref),
          text: args.text === undefined ? undefined : String(args.text),
          direction: args.direction === 'up' ? 'up' : 'down',
          fullPage: args.fullPage === true,
        },
        {
          ownerKey: `${actor.subject.companyId}:${actor.subject.userId}`,
          signal: context.signal,
          allowPrivateNetwork: browserPolicy.enabled,
          privateNetworkHosts: browserPolicy.enabled ? browserPolicy.allowedHosts : [],
          saveScreenshot: (buffer, filename) => {
            const saved = saveUserWorkspaceFile(deps, actor, {
              relPath: filename,
              buffer,
              mime: 'image/png',
              channel: context.channel,
            })
            return {
              fileId: saved.id,
              name: saved.name,
              relPath: saved.relPath,
              size: saved.size,
              mime: saved.mime ?? 'image/png',
            }
          },
        },
      )
      result = browserResult
      webAudit.detail = {
        ...webAudit.detail,
        action: browserResult.action,
        url: browserResult.url,
        title: browserResult.title,
        elements: browserResult.elements.length,
        screenshotFileId: browserResult.screenshot?.fileId ?? null,
        privateAccess: browserPolicy.enabled,
        closed: browserResult.closed,
      }
      break
    }
    case 'schedule.create':
      result = createSchedule(
        deps.db,
        actor,
        {
          title: args.title === undefined ? undefined : String(args.title),
          prompt: String(args.prompt ?? ''),
          mode: String(args.mode ?? ''),
          at: args.at === undefined ? undefined : String(args.at),
          time: args.time === undefined ? undefined : String(args.time),
          days: args.days === undefined ? undefined : String(args.days),
          intervalMinutes: args.intervalMinutes === undefined ? undefined : String(args.intervalMinutes),
          afterSeconds: args.afterSeconds === undefined ? undefined : String(args.afterSeconds),
          everySeconds: args.everySeconds === undefined ? undefined : String(args.everySeconds),
          timezone: args.timezone === undefined ? undefined : String(args.timezone),
          channel: args.channel === undefined ? undefined : String(args.channel),
        },
        { sessionId: context.sessionId, channel: context.channel === 'dingtalk' ? 'dingtalk' : 'web' },
      )
      break
    case 'schedule.list':
      result = {
        schedules: listSchedules(deps.db, actor, args.status === undefined ? undefined : String(args.status)),
      }
      break
    case 'schedule.delete': {
      const id = String(args.id ?? '').trim()
      if (!id) throw new EabError(EC.VALIDATION, 'id 不能为空')
      result = deleteSchedule(deps.db, actor, id)
      break
    }
    case 'math.eval': {
      const expression = String(args.expression ?? '').trim()
      const rawValues = Array.isArray(args.values) ? args.values : []
      if (!expression && !rawValues.length) {
        throw new EabError(EC.VALIDATION, '请提供 expression 或 values')
      }
      if (rawValues.length) {
        // 两项数字的“汇总”几乎都是把合计/条数又当成了两条记录（实测 [195.86,20] 被加成 215.86）；
        // 两项运算一律走 expression，values 只接受真正的明细序列。
        if (rawValues.length < 3) {
          throw new EabError(EC.VALIDATION, 'values 至少要有 3 个数；两项数字的运算请改用 expression，例如 195.86/20')
        }
        const summary = summarizeValues(rawValues)
        result = expression ? { ...summary, expression, value: evaluate(expression) } : summary
      } else {
        result = { expression, value: evaluate(expression) }
      }
      break
    }
    case 'org.directory':
      result = orgDirectory(deps.db, actor, args)
      break
    case 'org.search': {
      const query = String(args.query ?? '').trim()
      if (!query) throw new EabError(EC.VALIDATION, 'query 不能为空')
      result = { people: orgSearch(deps.db, actor.subject.companyId, query) }
      break
    }
    case 'kb.search': {
      const query = String(args.query ?? '').trim()
      if (!query) throw new EabError(EC.VALIDATION, 'query 不能为空')
      const { retrieveKb } = await import('./chat.js')
      const local = await retrieveKb(deps.db, deps.config.dbPath, actor, query)
      const external = await retrieveExternalKb(deps.db, deps.config.dbPath, actor, query, 4)
      const hits = [...local, ...external].slice(0, 6)
      result = {
        hits: hits.map((hit) => ({
          collection: hit.collectionName,
          title: hit.docTitle,
          text: hit.text,
          source: 'source' in hit ? hit.source : 'local',
          docId: 'docId' in hit ? hit.docId ?? null : null,
          chunkId: 'chunkId' in hit ? hit.chunkId ?? null : null,
          layout: 'layout' in hit ? hit.layout ?? null : null,
          freshness: 'freshness' in hit ? hit.freshness ?? null : null,
          images: 'images' in hit ? hit.images ?? [] : [],
        })),
        externalCount: external.length,
      }
      break
    }
    case 'workspace.list': {
      const rows = deps.db
        .prepare(
          'SELECT id, name, rel_path, size, updated_at FROM workspace_files WHERE company_id = ? AND owner_user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC',
        )
        .all(actor.subject.companyId, actor.subject.userId) as unknown as Array<{
        id: string
        name: string
        rel_path: string
        size: number
        updated_at: number
      }>
      result = {
        folders: workspaceFolderSummaries(rows),
        files: rows.filter((row) => row.name !== '.gitkeep'),
      }
      break
    }
    case 'workspace.capacity': {
      const policy = resolveUserWorkspaceQuota(deps.db, actor.subject.companyId, actor.subject.userId)
      const used = workspaceUsedBytes(deps.db, actor.subject.companyId, 'user', actor.subject.userId)
      const capacity = workspaceCapacity(policy.limitBytes, used)
      result = {
        scope: '个人云空间',
        usedBytes: capacity.usedBytes,
        limitBytes: capacity.limitBytes,
        remainingBytes: capacity.remainingBytes,
        percent: Number(capacity.percent.toFixed(1)),
        level: capacity.level,
        warning: { level: capacity.level, message: capacity.message },
        fileLimitBytes: policy.fileLimitBytes,
        quotaSource: policy.source,
        roleCodes: policy.roleCodes,
      }
      break
    }
    case 'workspace.read': {
      const path = String(args.path ?? '')
      const root = userScopeDir(deps, actor.subject.companyId, actor.subject.userId)
      const target = safeJoin(root, path)
      const mode = String(args.mode ?? 'lines').trim().toLowerCase() || 'lines'
      if (mode === 'analyze') {
        let size = 0
        let text = ''
        try {
          size = statSync(target).size
          text = readFileSync(target, 'utf8')
        } catch (error) {
          if (error instanceof EabError) throw error
          const suggestion = nearestWorkspacePath(deps, actor, path)
          throw new EabError(
            EC.NOT_FOUND,
            suggestion
              ? `云空间文件不存在: ${path}；最接近的是 ${suggestion}，请直接使用这个 path`
              : `云空间文件不存在: ${path}`,
          )
        }
        const question = String(args.question ?? '').trim()
          || '总结整份文件的内容、结构、关键数据、分布和异常；如果能确认总量，请给出总量。'
        const totalLines = countTextLines(text)
        if (text.length > WORKSPACE_ANALYZE_MAX_CHARS) {
          throw new EabError(
            EC.VALIDATION,
            `文件有 ${text.length.toLocaleString('en-US')} 字符，超过全文分析上限 ${WORKSPACE_ANALYZE_MAX_CHARS.toLocaleString('en-US')} 字符；请先用 workspace.search 缩小范围，或把文件拆分后再分析`,
          )
        }
        if (text.length <= WORKSPACE_ANALYZE_DIRECT_CHARS) {
          // 小文件直接全文返回：模型可以逐项核对，不额外消耗多轮模型调用。
          result = {
            path,
            mode: 'full',
            size,
            text,
            startLine: totalLines > 0 ? 1 : 0,
            endLine: totalLines,
            totalLines,
            truncated: false,
            truncatedByBytes: false,
            longLines: 0,
            nextOffset: null,
            coverage: '全文已返回，可直接基于 text 做精确分析',
          }
          break
        }
        // 大文件不做逐段模型调用：服务端直接解析/统计全文，避免上游限流或超时
        // 导致只分析了前面几段。结构化文件给出全量字段计数，文本给出全量行数和高频内容。
        const analysis = analyzeWorkspaceFile(text, path, question)
        result = {
          path,
          mode: 'overview',
          size,
          totalChars: text.length,
          totalLines,
          kind: analysis.kind,
          totalRows: analysis.totalRows,
          columns: analysis.columns,
          question,
          overview: analysis.overview,
          answer: analysis.overview,
          coverage: analysis.coverage,
        }
        break
      }
      if (mode !== 'lines') {
        throw new EabError(EC.VALIDATION, `mode 只能是 lines 或 analyze，收到: ${mode}`)
      }
      let range: TextRangeResult
      try {
        range = readTextFileRange(target, {
          offset: args.offset === undefined ? undefined : Number(args.offset),
          limit: args.limit === undefined ? undefined : Number(args.limit),
        })
      } catch (error) {
        if (error instanceof EabError) throw error
        const suggestion = nearestWorkspacePath(deps, actor, path)
        throw new EabError(
          EC.NOT_FOUND,
          suggestion
            ? `云空间文件不存在: ${path}；最接近的是 ${suggestion}，请直接使用这个 path`
            : `云空间文件不存在: ${path}`,
        )
      }
      result = {
        path,
        size: range.size,
        text: range.text,
        startLine: range.startLine,
        endLine: range.endLine,
        totalLines: range.totalLines,
        truncated: range.truncated,
        truncatedByBytes: range.truncatedByBytes,
        longLines: range.longLines,
        nextOffset: range.nextOffset,
        mode: 'lines',
        ...(range.truncated
          ? {
              analysisHint:
                '这次只返回了一页。如果问题需要基于整份文件统计或总结，请改用 mode="analyze" 并传 question，服务端会读完整份文件再分析；不要只读第一页就下结论。',
            }
          : {}),
      }
      break
    }
    case 'workspace.search': {
      const root = userScopeDir(deps, actor.subject.companyId, actor.subject.userId)
      const rawPath = String(args.path ?? '').trim()
      const target =
        rawPath === '' || rawPath === '.' || rawPath === './' || rawPath === '.\\' || rawPath === '/' || rawPath === '\\'
          ? root
          : safeJoin(root, rawPath)
      let search: TextSearchResult
      try {
        search = searchWorkspaceText(root, target, {
          query: String(args.query ?? ''),
          maxResults: args.maxResults === undefined ? undefined : Number(args.maxResults),
          regex: Boolean(args.regex),
          caseSensitive: Boolean(args.caseSensitive),
        })
      } catch (error) {
        if (error instanceof EabError) throw error
        throw new EabError(EC.NOT_FOUND, `云空间路径不存在: ${String(args.path ?? '')}`)
      }
      result = {
        query: String(args.query ?? ''),
        path: String(args.path ?? ''),
        regex: Boolean(args.regex),
        caseSensitive: Boolean(args.caseSensitive),
        count: search.matches.length,
        total: search.total,
        filesScanned: search.filesScanned,
        truncated: search.truncated,
        timeLimitHit: search.timeLimitHit,
        matches: search.matches,
        nameMatches: search.nameMatches,
      }
      break
    }
    case 'project.list': {
      const project = localProjectForSpace(space)
      const listing = await listProjectEntries(
        deps,
        project,
        actor.subject.companyId,
        actor.subject.userId,
        String(args.path ?? ''),
        {
          depth: args.depth === undefined ? 1 : Number(args.depth),
          limit: args.limit === undefined ? undefined : Number(args.limit),
        },
      )
      result = {
        project: project.name,
        path: listing.path,
        entries: listing.entries,
        total: listing.total,
        truncated: listing.truncated,
        note: 'path 都是相对项目根的路径；目录条目 type=dir，文件 type=file。需要读内容时用 project.read。',
      }
      break
    }
    case 'project.read': {
      const project = localProjectForSpace(space)
      const range = await readProjectText(
        deps,
        project,
        actor.subject.companyId,
        actor.subject.userId,
        String(args.path ?? ''),
        {
          offset: args.offset === undefined ? undefined : Number(args.offset),
          limit: args.limit === undefined ? undefined : Number(args.limit),
        },
      )
      result = {
        project: project.name,
        path: range.path,
        size: range.size,
        text: range.text,
        startLine: range.startLine,
        endLine: range.endLine,
        totalLines: range.totalLines,
        truncated: range.truncated,
        truncatedByBytes: range.truncatedByBytes,
        longLines: range.longLines,
        nextOffset: range.nextOffset,
        mode: 'lines',
      }
      break
    }
    case 'project.search': {
      const project = localProjectForSpace(space)
      const search = await searchProjectText(
        deps,
        project,
        actor.subject.companyId,
        actor.subject.userId,
        String(args.path ?? ''),
        {
          query: String(args.query ?? ''),
          maxResults: args.maxResults === undefined ? undefined : Number(args.maxResults),
          regex: Boolean(args.regex),
          caseSensitive: Boolean(args.caseSensitive),
        },
      )
      result = {
        project: project.name,
        query: String(args.query ?? ''),
        path: String(args.path ?? ''),
        regex: Boolean(args.regex),
        caseSensitive: Boolean(args.caseSensitive),
        count: search.matches.length,
        total: search.total,
        filesScanned: search.filesScanned,
        truncated: search.truncated,
        timeLimitHit: search.timeLimitHit,
        matches: search.matches,
        nameMatches: search.nameMatches,
      }
      break
    }
    case 'project.write': {
      const project = localProjectForSpace(space)
      if (project.mode === 'read_only') throw new EabError(EC.FORBIDDEN, '当前项目是只读模式')
      const rawPath = String(args.path ?? '').trim()
      const text = String(args.text ?? '')
      const written = await writeProjectText(
        deps,
        project,
        actor.subject.companyId,
        actor.subject.userId,
        rawPath,
        text,
      )
      result = {
        project: project.name,
        path: written.path,
        size: written.size,
        created: written.created,
        overwritten: written.overwritten,
      }
      break
    }
    case 'project.edit': {
      const project = localProjectForSpace(space)
      if (project.mode === 'read_only') throw new EabError(EC.FORBIDDEN, '当前项目是只读模式')
      const rawPath = String(args.path ?? '').trim()
      if (!isTextEditableFile(rawPath)) {
        throw new EabError(EC.VALIDATION, '该文件类型暂不支持局部文本编辑')
      }
      let rawEdits: unknown = args.edits
      if (typeof rawEdits === 'string') {
        try {
          rawEdits = JSON.parse(rawEdits)
        } catch {
          throw new EabError(EC.VALIDATION, 'edits 必须是 JSON 数组')
        }
      }
      if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
        throw new EabError(EC.VALIDATION, 'edits 不能为空', { hint: '每项至少包含 find 和 replace' })
      }
      if (rawEdits.length > 50) throw new EabError(EC.VALIDATION, '一次最多修改 50 处')
      const edits: WorkspaceTextEdit[] = rawEdits.map((item, index) => {
        if (!item || typeof item !== 'object') {
          throw new EabError(EC.VALIDATION, `第 ${index + 1} 项不是有效对象`)
        }
        const value = item as Record<string, unknown>
        const find = String(value.find ?? '')
        const replace = String(value.replace ?? '')
        if (!find) throw new EabError(EC.VALIDATION, `第 ${index + 1} 项 find 不能为空`)
        return {
          find,
          replace,
          ...(value.occurrence === undefined ? {} : { occurrence: Number(value.occurrence) }),
        }
      })
      const edited = await editProjectText(
        deps,
        project,
        actor.subject.companyId,
        actor.subject.userId,
        rawPath,
        edits,
      )
      result = {
        project: project.name,
        path: edited.path,
        size: edited.size,
        changes: edited.changes,
        matchedEdits: edited.matchedEdits,
        edited: true,
        diff: edited.diff,
      }
      break
    }
    case 'project.delete': {
      const project = localProjectForSpace(space)
      const deleted = await deleteProjectEntry(
        deps,
        project,
        actor.subject.companyId,
        actor.subject.userId,
        args.path,
      )
      result = {
        project: project.name,
        path: deleted.path,
        deleted: true,
        size: deleted.size,
      }
      break
    }
    case 'project.exec': {
      assertProjectExecEnabled()
      if (space.kind === 'local' && localProjectForSpace(space).deviceId) {
        throw new EabError(
          EC.FORBIDDEN,
          '当前项目目录在桌面端电脑上，服务端不能直接在远端执行命令',
          { hint: '本轮桌面文件桥只开放文件读写；命令执行仍由桌面终端手动完成。' },
        )
      }
      const root = projectRootForSpace(deps, actor, space)
      const command = String(args.command ?? '')
      const cwd = args.cwd === undefined || args.cwd === null ? undefined : String(args.cwd)
      const timeoutMs = args.timeoutMs === undefined || args.timeoutMs === null ? undefined : Number(args.timeoutMs)
      const background = Boolean(args.runInBackground)

      if (background) {
        const view = startProjectJob(
          { companyId: actor.subject.companyId, userId: actor.subject.userId },
          { root, command, cwd, timeoutMs },
        )
        result = {
          ...view,
          mode: 'background',
          note: `命令已在后台运行，jobId=${view.jobId}。用 project.job action=output 查看输出，action=kill 终止。`,
        }
        break
      }

      const run = await runProjectCommand({ root, command, cwd, timeoutMs })
      const { fullOutput, ...publicResult } = run
      const payload: Record<string, unknown> = { ...publicResult }
      if (run.truncated && fullOutput && fullOutput.length > 0 && deps.config.dataDir) {
        const saved = saveTextBatch({
          dataDir: deps.config.dataDir,
          companyId: actor.subject.companyId,
          userId: actor.subject.userId,
          toolId: 'project.exec',
          text: fullOutput,
          minChars: 4_000,
        })
        if (saved) {
          payload.batch = saved
          payload.note = `stdout/stderr 超过 64 KB，模型只看到尾部；完整输出已保存为文本批次 ${saved.id}，需要全量日志时用 batch_read / batch_analyze。`
        }
      }
      if (run.status !== 'completed' && payload.note === undefined) {
        payload.note = run.timedOut
          ? `命令超过 ${timeoutMs ?? 120_000}ms 被终止；进程树已 kill。`
          : run.aborted
            ? '命令被调用方取消。'
            : `命令以 ${run.exitCode ?? 'signal'} 结束；非零退出是结果，不是工具错误，可以读 stderr 后继续修。`
      }
      result = payload
      break
    }
    case 'project.job': {
      assertProjectExecEnabled()
      const owner = { companyId: actor.subject.companyId, userId: actor.subject.userId }
      const action = String(args.action ?? 'output').trim().toLowerCase()
      if (action === 'list') {
        result = {
          jobs: listProjectJobs(owner),
          note: '后台任务只在内存保留 30 分钟；服务重启后不会恢复。',
        }
        break
      }
      const jobId = String(args.jobId ?? '').trim()
      if (jobId === '') throw new EabError(EC.VALIDATION, `action=${action} 需要 jobId`)
      if (action === 'output') {
        const view = readProjectJob(owner, jobId)
        result = {
          ...view,
          note:
            view.status === 'running'
              ? '任务仍在运行；等一会儿再 output。'
              : view.status === 'completed'
                ? '任务已完成。'
                : '任务已结束；读 stdout/stderr 判断结果。',
        }
        break
      }
      if (action === 'kill') {
        const view = killProjectJob(owner, jobId)
        result = { ...view, note: '已发送终止；进程树会被 kill。' }
        break
      }
      throw new EabError(EC.VALIDATION, `action 只能是 list/output/kill，收到: ${action}`)
    }
    case 'plugin.dev': {
      const root = userScopeDir(deps, actor.subject.companyId, actor.subject.userId)
      const action = String(args.action ?? '').trim().toLowerCase()
      if (action !== 'create' && action !== 'install' && action !== 'list') {
        throw new EabError(EC.VALIDATION, `action 只能是 create/install/list，收到: ${action || '空'}`)
      }
      if (action === 'list') {
        const plugins = loadPersonalPluginsForUser(deps.db, actor.subject.companyId, actor.subject.userId)
        result = {
          action: 'list',
          plugins: plugins.map((plugin) => {
            const preview = pluginPreviewLink(plugin, actor.subject.companyId)
            return {
              id: plugin.id,
              name: plugin.name,
              version: plugin.version,
              enabled: plugin.enabled,
              checksum: plugin.checksum,
              pageCount: plugin.pages.length,
              previewPath: preview.previewPath,
              source: plugin.install?.source ?? null,
            }
          }),
          note: '这里只列本人安装的插件；previewPath 可直接打开真实插件页。',
        }
        break
      }

      const requestedId = String(args.pluginId ?? '').trim()
      const pluginId = requestedId ? normalizePluginDevId(requestedId) : ''
      const rawDir = String(args.dir ?? '').trim() || (pluginId ? `${PLUGIN_DEV_DIR}/${pluginId}` : '')
      if (!rawDir) {
        throw new EabError(EC.VALIDATION, '需要 pluginId 或 dir 指定插件源码目录')
      }
      const dir = resolvePluginDevDir(root, rawDir)
      const dirRel = relative(root, dir).replace(/\\/g, '/')

      if (action === 'create') {
        if (!pluginId) throw new EabError(EC.VALIDATION, 'create 需要 pluginId')
        const scaffold = createPluginDevScaffold({
          dir,
          pluginId,
          title: String(args.title ?? '').trim() || pluginId,
          description: args.description === undefined ? undefined : String(args.description),
          accent: args.accent === undefined ? undefined : String(args.accent),
          overwrite: Boolean(args.overwrite),
        })
        result = {
          action: 'create',
          application: 'created',
          pluginId: scaffold.pluginId,
          dir: dirRel,
          files: scaffold.files,
          next: `用 workspace.read 读 ${dirRel}/client.js，再用 workspace.edit 改成目标页面；改完调用 plugin.dev action=install 热安装并拿 previewPath。`,
          note: 'create 只生成模板；第一次 install 之后插件页才会真实出现。',
        }
        break
      }

      const actualId = pluginId || pluginDevIdFromDir(dir)
      const installed = installPluginDevBundle(deps.db, {
        companyId: actor.subject.companyId,
        userId: actor.subject.userId,
        installedBy: actor.subject.userId,
        dir,
        sourceRef: dirRel || actualId,
      })
      await refreshPluginHosts(deps.db, {
        dbPath: deps.config.dbPath,
        dshHomeDir: deps.config.dshHomeDir,
        companyId: actor.subject.companyId,
      })
      invalidatePluginToolSpecsEverywhere()
      const preview = pluginPreviewLink(installed.plugin, actor.subject.companyId)
      const warnings = installed.plugin.pages.length === 0
        ? ['插件没有声明 dsh.ui.pages，安装成功但没有可打开的 UI 页面']
        : []
      result = {
        action: 'install',
        application: warnings.length === 0 ? 'applied' : 'applied_with_warnings',
        replaced: installed.replaced,
        plugin: {
          id: installed.plugin.id,
          name: installed.plugin.name,
          version: installed.plugin.version,
          checksum: installed.plugin.checksum,
          enabled: installed.plugin.enabled,
          pageCount: installed.plugin.pages.length,
          pages: installed.plugin.pages.map((page) => ({ id: page.id, title: page.title, file: page.file })),
        },
        dir: dirRel,
        previewPath: preview.previewPath,
        warnings,
        note: '安装已在当前进程热生效，无需重启服务；打开 previewPath 就是真实插件 UI。改完 client.js 再 install 一次，插件页会按 version+h 自动刷新。',
      }
      break
    }
    case 'skill.dev': {
      const root = userScopeDir(deps, actor.subject.companyId, actor.subject.userId)
      const action = String(args.action ?? '').trim().toLowerCase()
      if (action !== 'create' && action !== 'install' && action !== 'list') {
        throw new EabError(EC.VALIDATION, `action 只能是 create/install/list，收到: ${action || '空'}`)
      }
      if (action === 'list') {
        const skills = loadPersonalSkills(deps.db, actor.subject.companyId, actor.subject.userId)
        result = {
          action: 'list',
          skills: skills.map((skill) => {
            const preview = skillPreviewLink(skill, actor.subject.companyId)
            return {
              id: skill.id,
              name: skill.name,
              version: skill.version,
              level: skill.level,
              risk: skill.risk,
              enabled: skill.enabled,
              valid: skill.valid,
              checksum: skill.checksum,
              triggerCount: skill.triggers.length,
              previewPath: preview.previewPath,
              source: skill.source,
            }
          }),
          note: '这里只列本人安装的技能；previewPath 可直接打开技能工作台并选中该技能。',
        }
        break
      }

      const requestedId = String(args.skillId ?? '').trim()
      const skillId = requestedId ? normalizeSkillDevId(requestedId) : ''
      const rawDir = String(args.dir ?? '').trim() || (skillId ? `${SKILL_DEV_DIR}/${skillId}` : '')
      if (!rawDir) {
        throw new EabError(EC.VALIDATION, '需要 skillId 或 dir 指定技能源码目录')
      }
      const dir = resolveSkillDevDir(root, rawDir)
      const dirRel = relative(root, dir).replace(/\\/g, '/')

      if (action === 'create') {
        if (!skillId) throw new EabError(EC.VALIDATION, 'create 需要 skillId')
        const scaffold = createSkillDevScaffold({
          dir,
          skillId,
          title: String(args.title ?? '').trim() || skillId,
          description: args.description === undefined ? undefined : String(args.description),
          triggers: Array.isArray(args.triggers) ? args.triggers.map((item) => String(item)) : undefined,
          overwrite: Boolean(args.overwrite),
        })
        result = {
          action: 'create',
          application: 'created',
          skillId: scaffold.skillId,
          dir: dirRel,
          files: scaffold.files,
          next: `用 workspace.read 读 ${dirRel}/SKILL.md，再用 workspace.edit 改成目标技能说明；改完调用 skill.dev action=install 热安装并拿 previewPath。`,
          note: 'create 只生成模板；第一次 install 之后技能才会进入对话的技能目录。',
        }
        break
      }

      const actualId = skillId || skillDevIdFromDir(dir)
      const baseOptions = {
        companyId: actor.subject.companyId,
        installedBy: actor.subject.userId,
        scope: 'user' as const,
        userId: actor.subject.userId,
        overwrite: true,
        source: 'workspace-dev',
        sourceRef: dirRel || actualId,
      }
      let approvalId: string | undefined
      let expectedChecksum: string | undefined
      const policy = companySkillPolicy(deps.db, actor.subject.companyId)
      if (policy.requirePersonalInstallApproval) {
        const preview = previewSkillInstall(deps.db, dir, baseOptions)
        const approval = ensureSkillInstallApproval(deps.db, {
          companyId: actor.subject.companyId,
          requesterUserId: actor.subject.userId,
          scope: 'user',
          skillId: preview.skillId,
          skillName: preview.name,
          version: preview.version,
          checksum: preview.checksum,
          overwrite: true,
          sourceRef: baseOptions.sourceRef,
        })
        if (approval.status !== 'approved') {
          throw new EabError(
            EC.APPROVAL_REQUIRED,
            `个人技能安装按公司策略需要管理员审批（审批单 ${approval.approvalId}）。管理员在控制台「审批」页通过后，再次调用 skill.dev action=install 即可继续。`,
            {
              details: {
                approvalId: approval.approvalId,
                skillId: preview.skillId,
                checksum: preview.checksum,
                scope: 'user',
              },
            },
          )
        }
        approvalId = approval.approvalId
        expectedChecksum = preview.checksum
      }

      const installed = installSkillDevBundle(deps.db, {
        companyId: actor.subject.companyId,
        userId: actor.subject.userId,
        installedBy: actor.subject.userId,
        dir,
        sourceRef: baseOptions.sourceRef,
        expectedChecksum,
        approvalId,
      })
      const preview = skillPreviewLink(installed.skill, actor.subject.companyId)
      const warnings: string[] = []
      if (!policy.enabled) warnings.push('公司技能总开关已关闭，安装已落库但当前不会注入对话')
      if (!installed.skill.valid) warnings.push(`技能未通过安装后校验：${installed.skill.error || '未知原因'}`)
      if (installed.skill.risk !== 'low') warnings.push(`技能风险级别为 ${installed.skill.risk}，请检查扫描结论`)
      const instructionPreview = installed.skill.instructions
        .split(/\r?\n/)
        .slice(0, 12)
        .join('\n')
        .slice(0, 900)
      result = {
        action: 'install',
        application: warnings.length === 0 ? 'applied' : 'applied_with_warnings',
        replaced: installed.replaced,
        skill: {
          id: installed.skill.id,
          name: installed.skill.name,
          version: installed.skill.version,
          checksum: installed.skill.checksum,
          level: installed.skill.level,
          risk: installed.skill.risk,
          enabled: installed.skill.enabled,
          valid: installed.skill.valid,
          scope: installed.skill.scope,
          triggers: installed.skill.triggers,
          tools: installed.skill.tools,
        },
        dir: dirRel,
        previewPath: preview.previewPath,
        instructionPreview,
        warnings,
        note: '安装已写库并复制到 skills 目录；下一轮对话会重新扫描并加载技能，无需重启服务。改完 SKILL.md 再 install 一次即热更新。',
      }
      break
    }
    case 'office.read_outline': {
      const file = resolveOfficeFile(deps, actor, args)
      const operationId = `op_${ulid()}`
      if (isXlsxFileName(file.name)) {
        const maxCells = args.maxElements === undefined ? 200 : Number(args.maxElements)
        const outline = readXlsxOutline(file.buffer, Number.isFinite(maxCells) ? maxCells : 200)
        outline.fileName = file.name
        result = {
          fileId: file.fileId,
          name: file.name,
          relPath: file.relPath,
          version: file.version,
          operationId,
          kind: 'xlsx',
          sheetCount: outline.sheetCount,
          sheets: outline.sheets,
          truncated: outline.truncated,
          editorSync: false,
          wrote: false,
        }
        break
      }
      if (isPptxFileName(file.name)) {
        const maxElements = args.maxElements === undefined ? 200 : Number(args.maxElements)
        const outline = readPptxOutline(file.buffer, Number.isFinite(maxElements) ? maxElements : 200)
        outline.fileName = file.name
        result = {
          fileId: file.fileId,
          name: file.name,
          relPath: file.relPath,
          version: file.version,
          operationId,
          kind: 'pptx',
          slideCount: outline.slideCount,
          slides: outline.slides,
          truncated: outline.truncated,
          editorSync: false,
          wrote: false,
        }
        break
      }
      const docx = resolveOfficeDocx(deps, actor, args)
      const maxElements = args.maxElements === undefined ? 200 : Number(args.maxElements)
      const outline = readDocxOutline(docx.buffer, Number.isFinite(maxElements) ? maxElements : 200)
      outline.fileName = docx.name
      result = {
        fileId: docx.fileId,
        name: docx.name,
        relPath: docx.relPath,
        version: docx.version,
        operationId,
        elementCount: outline.elementCount,
        elements: outline.elements,
        truncated: outline.truncated,
        editorSync: false,
        wrote: false,
      }
      break
    }
    case 'office.read_range': {
      const elementId = String(args.elementId ?? '').trim()
      if (!elementId) throw new EabError(EC.VALIDATION, 'elementId 不能为空')
      const file = resolveOfficeFile(deps, actor, args)
      if (isXlsxFileName(file.name)) {
        throw new EabError(EC.VALIDATION, 'office.read_range 暂只支持 docx；xlsx/xlsm 请先用 office.read_outline 或 office.find', {
          hint: 'xlsx 单元格读取请用 sN-rN-cN；行列范围目前由 read_outline 的 cells 覆盖。',
        })
      }
      if (isPptxFileName(file.name)) {
        throw new EabError(EC.VALIDATION, 'office.read_range 暂只支持 docx；pptx 请先用 office.read_outline 或 office.find', {
          hint: 'pptx 段落读取请用 sN-pM。',
        })
      }
      const docx = resolveOfficeDocx(deps, actor, args)
      const start = args.start === undefined ? undefined : Number(args.start)
      const end = args.end === undefined ? undefined : Number(args.end)
      if (start !== undefined && !Number.isFinite(start)) throw new EabError(EC.VALIDATION, 'start 必须是数字')
      if (end !== undefined && !Number.isFinite(end)) throw new EabError(EC.VALIDATION, 'end 必须是数字')
      let range
      try {
        range = readDocxRange(docx.buffer, {
          elementId,
          ...(start === undefined ? {} : { start }),
          ...(end === undefined ? {} : { end }),
        })
      } catch (error) {
        throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
          hint: '先用 office.read_outline 确认 pN、tN、tN-rN、tN-cN 或 tN-rN-cN；start/end 只对 pN 和 tN-rN-cN 有效。',
        })
      }
      result = {
        fileId: docx.fileId,
        name: docx.name,
        relPath: docx.relPath,
        version: docx.version,
        operationId: `op_${ulid()}`,
        ...range,
        wrote: false,
        editorSync: false,
      }
      break
    }
    case 'office.find': {
      const query = String(args.query ?? '').trim()
      if (!query) throw new EabError(EC.VALIDATION, 'query 不能为空')
      const file = resolveOfficeFile(deps, actor, args)
      const operationId = `op_${ulid()}`
      if (isXlsxFileName(file.name)) {
        const limit = args.limit === undefined ? 20 : Number(args.limit)
        const matches = findInXlsx(file.buffer, query, {
          regex: args.regex === true,
          limit: Number.isFinite(limit) ? limit : 20,
        })
        result = {
          fileId: file.fileId,
          name: file.name,
          relPath: file.relPath,
          version: file.version,
          operationId,
          kind: 'xlsx',
          query,
          regex: args.regex === true,
          matches,
          matchCount: matches.length,
          wrote: false,
          hint: '调用 office.replace 时请原样传入本结果的 fileId（或同一个 path）和命中的 elementId。',
        }
        break
      }
      if (isPptxFileName(file.name)) {
        const limit = args.limit === undefined ? 20 : Number(args.limit)
        const matches = findInPptx(file.buffer, query, {
          regex: args.regex === true,
          limit: Number.isFinite(limit) ? limit : 20,
        })
        result = {
          fileId: file.fileId,
          name: file.name,
          relPath: file.relPath,
          version: file.version,
          operationId,
          kind: 'pptx',
          query,
          regex: args.regex === true,
          matches,
          matchCount: matches.length,
          wrote: false,
          hint: '调用 office.replace 时请原样传入本结果的 fileId（或同一个 path）和命中的 elementId（sN-pM）。',
        }
        break
      }
      const docx = resolveOfficeDocx(deps, actor, args)
      const outline = readDocxOutline(docx.buffer, 500, { includeTableRows: true })
      outline.fileName = docx.name
      const limit = args.limit === undefined ? 20 : Number(args.limit)
      const matches = findInOutline(outline, query, {
        regex: args.regex === true,
        limit: Number.isFinite(limit) ? limit : 20,
      })
      result = {
        fileId: docx.fileId,
        name: docx.name,
        relPath: docx.relPath,
        version: docx.version,
        operationId,
        query,
        regex: args.regex === true,
        matches,
        matchCount: matches.length,
        wrote: false,
        hint: '调用 office.replace 时请原样传入本结果的 fileId（或同一个 path）和命中的 elementId。',
      }
      break
    }
    case 'office.revisions': {
      const action = args.action === undefined ? 'read' : String(args.action)
      if (!['read', 'enable', 'disable', 'accept', 'reject'].includes(action)) {
        throw new EabError(EC.VALIDATION, 'action 只能是 read、enable、disable、accept 或 reject')
      }
      const file = resolveOfficeFile(deps, actor, args)
      if (!/\.docx$/i.test(file.name)) {
        throw new EabError(EC.VALIDATION, 'office.revisions 只支持 docx；xlsx/pptx 暂不支持修订和修订开关')
      }
      const operationId = `op_${ulid()}`
      if (action === 'read') {
        const maxRevisions = args.maxRevisions === undefined ? 200 : Number(args.maxRevisions)
        const report = readDocxRevisions(
          file.buffer,
          Number.isFinite(maxRevisions) ? maxRevisions : 200,
        )
        result = {
          fileId: file.fileId,
          name: file.name,
          relPath: file.relPath,
          version: file.version,
          operationId,
          revisionCount: report.revisionCount,
          insertions: report.insertions,
          deletions: report.deletions,
          authors: report.authors,
          revisions: report.revisions,
          truncated: report.truncated,
          trackChanges: readDocxTrackChanges(file.buffer),
          wrote: false,
          hint:
            report.revisionCount > 0
              ? '处理修订请用 action=accept/reject，并传 revisionId 或 all=true；接受/拒绝会原子保存。'
              : '当前文档没有 w:ins/w:del 修订；可用 office.replace 的 trackChanges=true 写入修订。',
        }
        break
      }
      if (action === 'enable' || action === 'disable') {
        let edit
        try {
          edit = setDocxTrackChanges(file.buffer, action === 'enable')
        } catch (error) {
          throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
            hint: 'docx 需要可写的 word/settings.xml；当前实现会按需创建 settings 部件和关系项。',
          })
        }
        if (!edit.changed) {
          result = {
            fileId: file.fileId,
            name: file.name,
            relPath: file.relPath,
            version: file.version,
            operationId,
            trackChanges: edit.enabled,
            changed: false,
            wrote: false,
            saved: false,
            editorSync: false,
          }
          break
        }
        const saved = editUserWorkspaceFile(deps, actor, file.fileId, edit.buffer, {
          baseVersion: Number(file.version),
          source: 'office.revisions',
          operationId,
          action,
        })
        result = {
          fileId: file.fileId,
          name: file.name,
          relPath: file.relPath,
          version: saved.updatedAt,
          operationId,
          trackChanges: edit.enabled,
          changed: true,
          wrote: true,
          saved: true,
          editorSync: false,
        }
        break
      }
      const revisionId = args.revisionId === undefined ? undefined : String(args.revisionId).trim()
      if (!revisionId && args.all !== true) {
        throw new EabError(EC.VALIDATION, 'accept/reject 需要 revisionId，或 all=true 处理全部修订')
      }
      let edit
      try {
        edit = applyDocxRevisions(file.buffer, {
          action: action === 'accept' ? 'accept' : 'reject',
          ...(revisionId ? { revisionId } : {}),
          ...(args.all === true ? { all: true } : {}),
        })
      } catch (error) {
        throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
          hint: '先用 action=read 确认 revision id；移动和格式修订不在当前覆盖范围。',
        })
      }
      if (edit.processed === 0) {
        result = {
          fileId: file.fileId,
          name: file.name,
          relPath: file.relPath,
          version: file.version,
          operationId,
          action: edit.action,
          processed: 0,
          revisionIds: [],
          remaining: edit.remaining,
          trackChanges: edit.trackChanges,
          wrote: false,
          saved: false,
          editorSync: false,
        }
        break
      }
      const saved = editUserWorkspaceFile(deps, actor, file.fileId, edit.buffer, {
        baseVersion: Number(file.version),
        source: 'office.revisions',
        operationId,
        action: edit.action,
        processed: edit.processed,
        revisionIds: edit.revisionIds,
      })
      result = {
        fileId: file.fileId,
        name: file.name,
        relPath: file.relPath,
        version: saved.updatedAt,
        operationId,
        action: edit.action,
        processed: edit.processed,
        revisionIds: edit.revisionIds,
        remaining: edit.remaining,
        trackChanges: edit.trackChanges,
        wrote: true,
        saved: true,
        editorSync: false,
      }
      break
    }
    case 'office.rewrite': {
      const elementId = String(args.elementId ?? '').trim()
      if (!elementId) throw new EabError(EC.VALIDATION, 'elementId 不能为空')
      if (typeof args.newText !== 'string') throw new EabError(EC.VALIDATION, 'newText 必须是字符串')
      const boolArg = (name: string): boolean | undefined => {
        const value = args[name]
        if (value === undefined) return undefined
        if (typeof value === 'boolean') return value
        if (value === 'true') return true
        if (value === 'false') return false
        throw new EabError(EC.VALIDATION, `${name} 必须是布尔值`)
      }
      const bold = boolArg('bold')
      const italic = boolArg('italic')
      let underline: boolean | string | undefined
      if (args.underline !== undefined) {
        if (typeof args.underline === 'boolean') underline = args.underline
        else if (typeof args.underline === 'string') {
          const value = args.underline.trim()
          underline = value === 'true' || value === 'false' ? value === 'true' : value
        } else throw new EabError(EC.VALIDATION, 'underline 必须是布尔值或下划线样式')
      }
      const color = args.color === undefined ? undefined : String(args.color)
      const fontFamily = args.fontFamily === undefined ? undefined : String(args.fontFamily)
      const align = args.align === undefined ? undefined : String(args.align)
      const fontSize = args.fontSize === undefined ? undefined : Number(args.fontSize)
      if (fontSize !== undefined && !Number.isFinite(fontSize)) {
        throw new EabError(EC.VALIDATION, 'fontSize 必须是数字')
      }
      if (
        bold === undefined &&
        italic === undefined &&
        underline === undefined &&
        color === undefined &&
        fontSize === undefined &&
        fontFamily === undefined &&
        align === undefined
      ) {
        throw new EabError(EC.VALIDATION, '至少指定一个统一格式属性：bold、italic、underline、color、fontSize、fontFamily 或 align')
      }
      const docx = resolveOfficeDocx(deps, actor, args)
      const operationId = `op_${ulid()}`
      let edit
      try {
        edit = rewriteDocxElementText(docx.buffer, {
          elementId,
          newText: args.newText,
          ...(bold === undefined ? {} : { bold }),
          ...(italic === undefined ? {} : { italic }),
          ...(underline === undefined ? {} : { underline }),
          ...(color === undefined ? {} : { color }),
          ...(fontSize === undefined ? {} : { fontSize }),
          ...(fontFamily === undefined ? {} : { fontFamily }),
          ...(align === undefined ? {} : { align }),
        })
      } catch (error) {
        throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
          hint: '整段重写只用于用户明确要求覆盖整个段落/单元格并统一格式；保留原格式的局部修改请改用 office.replace 并把 oldText 收窄到单个 run。',
        })
      }
      const saved = editUserWorkspaceFile(deps, actor, docx.fileId, edit.buffer, {
        baseVersion: Number(docx.version),
        source: 'office.rewrite',
        operationId,
        elementId: edit.elementId,
        replacements: edit.replacements,
      })
      result = {
        fileId: docx.fileId,
        name: docx.name,
        relPath: docx.relPath,
        version: saved.updatedAt,
        operationId,
        kind: 'docx',
        elementId: edit.elementId,
        elementKind: edit.kind,
        previousText: edit.previousText,
        nextText: edit.nextText,
        replacements: edit.replacements,
        applied: edit.applied,
        runCount: edit.runCount,
        wrote: true,
        saved: true,
        editorSync: false,
      }
      break
    }
    case 'office.insert': {
      const elementId = String(args.elementId ?? '').trim()
      if (!elementId) throw new EabError(EC.VALIDATION, 'elementId 不能为空')
      const action = args.action === undefined ? 'insert' : String(args.action)
      if (action !== 'insert' && action !== 'delete' && action !== 'merge' && action !== 'split') {
        throw new EabError(EC.VALIDATION, 'action 只能是 insert、delete、merge 或 split')
      }
      if (action === 'insert' && typeof args.text !== 'string') {
        throw new EabError(EC.VALIDATION, 'action=insert 时 text 必须是字符串')
      }
      const text = typeof args.text === 'string' ? args.text : ''
      const position = args.position === undefined ? 'after' : String(args.position)
      if (position !== 'before' && position !== 'after') {
        throw new EabError(EC.VALIDATION, 'position 只能是 before 或 after')
      }
      const file = resolveOfficeFile(deps, actor, args)
      const operationId = `op_${ulid()}`
      if (isXlsxFileName(file.name)) {
        if (action === 'insert' && elementId === 'workbook') {
          let edit
          try {
            edit = appendXlsxSheet(file.buffer, text)
          } catch (error) {
            throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
              hint: '追加工作表用 elementId=workbook，text 传新工作表名称；名称不能超过 31 个字符，不能包含 \\ / ? * [ ] :，也不能与已有工作表重名。',
            })
          }
          const saved = editUserWorkspaceFile(deps, actor, file.fileId, edit.buffer, {
            baseVersion: Number(file.version),
            source: 'office.insert',
            operationId,
            elementId: 'workbook',
            text,
          })
          result = {
            fileId: file.fileId,
            name: file.name,
            relPath: file.relPath,
            version: saved.updatedAt,
            operationId,
            kind: 'xlsx',
            elementId: 'workbook',
            structureKind: 'sheet',
            sheetId: edit.sheetId,
            sheetName: edit.sheetName,
            sheetCount: edit.sheetCount,
            wrote: true,
            saved: true,
            editorSync: false,
          }
          break
        }
        if (action === 'delete' && /^s\d+$/i.test(elementId)) {
          let edit
          try {
            edit = deleteXlsxSheet(file.buffer, elementId)
          } catch (error) {
            throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
              hint: '删除工作表用 action=delete + elementId=sN；至少保留一个工作表。其他工作表公式或命名区域引用目标表时会拒绝删除，请先改引用。',
            })
          }
          const saved = editUserWorkspaceFile(deps, actor, file.fileId, edit.buffer, {
            baseVersion: Number(file.version),
            source: 'office.insert',
            operationId,
            elementId,
          })
          result = {
            fileId: file.fileId,
            name: file.name,
            relPath: file.relPath,
            version: saved.updatedAt,
            operationId,
            kind: 'xlsx',
            elementId,
            structureKind: 'sheet',
            deletedSheetId: edit.deletedSheetId,
            deletedSheetName: edit.deletedSheetName,
            remainingSheets: edit.remainingSheets,
            wrote: true,
            saved: true,
            editorSync: false,
          }
          break
        }
        if (action !== 'insert') {
          throw new EabError(EC.VALIDATION, 'xlsx 结构操作只支持插入/删除工作表、插入行/列；删除行/列、合并和拆分暂只支持 docx')
        }
        let edit
        let editKind: 'row' | 'column'
        try {
          if (/^s\d+-c\d+$/i.test(elementId)) {
            edit = insertXlsxColumn(file.buffer, {
              elementId,
              position: position as 'before' | 'after',
              text,
            })
            editKind = 'column'
          } else {
            edit = insertXlsxRow(file.buffer, {
              elementId,
              position: position as 'before' | 'after',
              text,
            })
            editKind = 'row'
          }
        } catch (error) {
          throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
            hint: '先用 office.read_outline 确认工作表 sN、目标行号 rN 或列号 cN；行 text 用制表符分隔多列，列 text 用换行分隔各行值。含公式或数据验证的工作表会拒绝结构插入。',
          })
        }
        const saved = editUserWorkspaceFile(deps, actor, file.fileId, edit.buffer, {
          baseVersion: Number(file.version),
          source: 'office.insert',
          operationId,
          elementId: edit.elementId,
          text,
        })
        result = {
          fileId: file.fileId,
          name: file.name,
          relPath: file.relPath,
          version: saved.updatedAt,
          operationId,
          kind: 'xlsx',
          elementId: edit.elementId,
          structureKind: editKind,
          ...(editKind === 'row'
            ? { insertedRow: (edit as { insertedRow: number }).insertedRow }
            : { insertedColumn: (edit as { insertedColumn: number }).insertedColumn }),
          insertedValues: edit.insertedValues,
          wrote: true,
          saved: true,
          editorSync: false,
        }
        break
      }
      if (isPptxFileName(file.name)) {
        throw new EabError(EC.VALIDATION, 'pptx 暂不支持结构插入、删除、合并或拆分；请用 office.replace 替换指定段落文本')
      }
      const docx = resolveOfficeDocx(deps, actor, args)
      const tableStructure = /^t\d+-r\d+$/i.test(elementId) || /^t\d+-c\d+$/i.test(elementId)
      if (action === 'split') {
        let split
        try {
          split = splitDocxTableMergedCells(docx.buffer, { elementId })
        } catch (error) {
          throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
            hint: 'action=split 的 elementId 必须是整张表 tN；拆分后表格每行单元格数等于 gridCol 数。',
          })
        }
        const saved = editUserWorkspaceFile(deps, actor, docx.fileId, split.buffer, {
          baseVersion: Number(docx.version),
          source: 'office.insert',
          operationId,
          action,
          elementId: split.elementId,
          splitCells: split.splitCells,
        })
        result = {
          fileId: docx.fileId,
          name: docx.name,
          relPath: docx.relPath,
          version: saved.updatedAt,
          operationId,
          action,
          elementId: split.elementId,
          kind: 'docx',
          structureKind: split.kind,
          splitCells: split.splitCells,
          remainingRows: split.remainingRows,
          remainingColumns: split.remainingColumns,
          wrote: true,
          saved: true,
          editorSync: false,
        }
        break
      }
      if (action === 'merge') {
        let merged
        try {
          merged = mergeDocxTableCells(docx.buffer, { range: elementId })
        } catch (error) {
          throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
            hint: 'action=merge 用 elementId=tN-rA-cA:tN-rB-cB；区域必须无合并单元格，且除左上角外不能有文本。',
          })
        }
        const saved = editUserWorkspaceFile(deps, actor, docx.fileId, merged.buffer, {
          baseVersion: Number(docx.version),
          source: 'office.insert',
          operationId,
          action,
          elementId: merged.elementId,
          mergedRows: merged.mergedRows,
          mergedColumns: merged.mergedColumns,
        })
        result = {
          fileId: docx.fileId,
          name: docx.name,
          relPath: docx.relPath,
          version: saved.updatedAt,
          operationId,
          action,
          elementId: merged.elementId,
          kind: 'docx',
          structureKind: merged.kind,
          mergedRows: merged.mergedRows,
          mergedColumns: merged.mergedColumns,
          remainingRows: merged.remainingRows,
          remainingColumns: merged.remainingColumns,
          wrote: true,
          saved: true,
          editorSync: false,
        }
        break
      }
      if (action === 'delete') {
        if (!tableStructure) {
          throw new EabError(EC.VALIDATION, 'action=delete 只支持 docx 表格行 tN-rN 或表格列 tN-cN')
        }
        let deletion
        try {
          deletion = deleteDocxTable(docx.buffer, { elementId })
        } catch (error) {
          throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
            hint: '先用 office.read_outline 确认 tN-rN 或 tN-cN；表格至少保留一行/一列；删除列按 grid 列号计算，含 gridSpan/vMerge 的表会直接缩减或移除对应网格单元格。',
          })
        }
        const saved = editUserWorkspaceFile(deps, actor, docx.fileId, deletion.buffer, {
          baseVersion: Number(docx.version),
          source: 'office.insert',
          operationId,
          action,
          elementId: deletion.elementId,
        })
        result = {
          fileId: docx.fileId,
          name: docx.name,
          relPath: docx.relPath,
          version: saved.updatedAt,
          operationId,
          action,
          elementId: deletion.elementId,
          kind: 'docx',
          structureKind: deletion.kind,
          ...(deletion.kind === 'table_row'
            ? { deletedRow: deletion.deletedRow }
            : { deletedColumn: deletion.deletedColumn }),
          remainingRows: deletion.remainingRows,
          remainingColumns: deletion.remainingColumns,
          wrote: true,
          saved: true,
          editorSync: false,
        }
        break
      }
      let edit
      try {
        edit = tableStructure
          ? insertDocxTable(docx.buffer, { elementId, position, text })
          : insertDocxText(docx.buffer, { elementId, position, text })
      } catch (error) {
        throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
          hint: '先用 office.read_outline 确认 pN、tN、tN-rN-cN、tN-rN 或 tN-cN；行 text 用制表符分隔多列，列 text 用换行分隔各行值；目标行含纵向合并或表格含合并单元格时，请先 action=split。',
        })
      }
      const saved = editUserWorkspaceFile(deps, actor, docx.fileId, edit.buffer, {
        baseVersion: Number(docx.version),
        source: 'office.insert',
        operationId,
        elementId: edit.elementId,
        position: edit.position,
        text,
      })
      result = tableStructure
        ? {
            fileId: docx.fileId,
            name: docx.name,
            relPath: docx.relPath,
            version: saved.updatedAt,
            operationId,
            elementId: edit.elementId,
            kind: 'docx',
            structureKind: (edit as { kind: string }).kind,
            position: edit.position,
            insertedValues: (edit as { insertedValues: string[] }).insertedValues,
            wrote: true,
            saved: true,
            editorSync: false,
          }
        : {
            fileId: docx.fileId,
            name: docx.name,
            relPath: docx.relPath,
            version: saved.updatedAt,
            operationId,
            elementId: edit.elementId,
            kind: (edit as { kind: string }).kind,
            position: edit.position,
            insertedText: (edit as { insertedText: string }).insertedText,
            wrote: true,
            saved: true,
            editorSync: false,
          }
      break
    }
    case 'office.format': {
      const elementId = String(args.elementId ?? '').trim()
      if (!elementId) throw new EabError(EC.VALIDATION, 'elementId 不能为空')
      const boolArg = (name: string): boolean | undefined => {
        const value = args[name]
        if (value === undefined) return undefined
        if (typeof value !== 'boolean') throw new EabError(EC.VALIDATION, `${name} 必须是布尔值`)
        return value
      }
      const bold = boolArg('bold')
      const italic = boolArg('italic')
      let underline: boolean | string | undefined
      if (args.underline !== undefined) {
        if (typeof args.underline === 'boolean') underline = args.underline
        else if (typeof args.underline === 'string') {
          const value = args.underline.trim()
          if (value === 'true' || value === 'false') underline = value === 'true'
          else underline = value
        } else throw new EabError(EC.VALIDATION, 'underline 必须是布尔值或下划线样式')
      }
      const color = args.color === undefined ? undefined : String(args.color)
      const highlight = args.highlight === undefined ? undefined : String(args.highlight)
      const fill = args.fill === undefined ? undefined : String(args.fill)
      const numberFormat = args.numberFormat === undefined ? undefined : String(args.numberFormat)
      const fontFamily = args.fontFamily === undefined ? undefined : String(args.fontFamily)
      const align = args.align === undefined ? undefined : String(args.align)
      const fontSize = args.fontSize === undefined ? undefined : Number(args.fontSize)
      if (fontSize !== undefined && !Number.isFinite(fontSize)) {
        throw new EabError(EC.VALIDATION, 'fontSize 必须是数字')
      }
      const numberArg = (name: string): number | undefined => {
        if (args[name] === undefined) return undefined
        const value = Number(args[name])
        if (!Number.isFinite(value)) throw new EabError(EC.VALIDATION, `${name} 必须是数字`)
        return value
      }
      const lineSpacing = numberArg('lineSpacing')
      const spaceBefore = numberArg('spaceBefore')
      const spaceAfter = numberArg('spaceAfter')
      const columnWidth = numberArg('columnWidth')
      const rowHeight = numberArg('rowHeight')
      if (
        bold === undefined &&
        italic === undefined &&
        underline === undefined &&
        color === undefined &&
        highlight === undefined &&
        fill === undefined &&
        numberFormat === undefined &&
        fontSize === undefined &&
        fontFamily === undefined &&
        align === undefined &&
        lineSpacing === undefined &&
        spaceBefore === undefined &&
        spaceAfter === undefined &&
        columnWidth === undefined &&
        rowHeight === undefined
      ) {
        throw new EabError(EC.VALIDATION, '至少指定一个格式属性：bold、italic、underline、color、highlight、fill、fontSize、fontFamily、numberFormat、align、lineSpacing、spaceBefore、spaceAfter、columnWidth 或 rowHeight')
      }
      const file = resolveOfficeFile(deps, actor, args)
      const operationId = `op_${ulid()}`
      if (isXlsxFileName(file.name)) {
        if (highlight !== undefined) {
          throw new EabError(EC.VALIDATION, 'xlsx 单元格请用 fill 指定填充色，不用 highlight')
        }
        if (
          columnWidth !== undefined ||
          rowHeight !== undefined ||
          /^s\d+-[cr]\d+(?::[cr]\d+)?$/i.test(elementId)
        ) {
          const hasCellFormat =
            bold !== undefined ||
            italic !== undefined ||
            underline !== undefined ||
            color !== undefined ||
            fill !== undefined ||
            fontSize !== undefined ||
            numberFormat !== undefined ||
            fontFamily !== undefined ||
            align !== undefined ||
            lineSpacing !== undefined ||
            spaceBefore !== undefined ||
            spaceAfter !== undefined
          if (hasCellFormat) {
            throw new EabError(EC.VALIDATION, 'xlsx 列宽/行高不能和单元格样式同时设置；请分两次调用')
          }
          let edit
          try {
            edit = formatXlsxDimension(file.buffer, {
              elementId,
              ...(columnWidth === undefined ? {} : { columnWidth }),
              ...(rowHeight === undefined ? {} : { rowHeight }),
            })
          } catch (error) {
            throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
              hint: 'xlsx 列宽用 elementId=sN-cN 或 sN-c2:c4 + columnWidth（列号 1-16384）；行高用 elementId=sN-rN 或 sN-r2:r4 + rowHeight（行号 1-1048576，单次最多 20000 行）。',
            })
          }
          const saved = editUserWorkspaceFile(deps, actor, file.fileId, edit.buffer, {
            baseVersion: Number(file.version),
            source: 'office.format',
            operationId,
            elementId: edit.elementId,
            applied: edit.applied,
          })
          result = {
            fileId: file.fileId,
            name: file.name,
            relPath: file.relPath,
            version: saved.updatedAt,
            operationId,
            elementId: edit.elementId,
            kind: edit.kind,
            applied: edit.applied,
            ...(edit.columns === undefined ? {} : { columns: edit.columns }),
            ...(edit.rows === undefined ? {} : { rows: edit.rows }),
            wrote: true,
            saved: true,
            editorSync: false,
          }
          break
        }
        if (fontFamily !== undefined || align !== undefined || lineSpacing !== undefined || spaceBefore !== undefined || spaceAfter !== undefined) {
          throw new EabError(EC.VALIDATION, 'xlsx 暂不支持 fontFamily、align、lineSpacing、spaceBefore、spaceAfter；请改用 bold、italic、underline、color、fill、fontSize 或 numberFormat')
        }
        let edit
        try {
          edit = formatXlsxCell(file.buffer, {
            elementId,
            ...(bold === undefined ? {} : { bold }),
            ...(italic === undefined ? {} : { italic }),
            ...(underline === undefined ? {} : { underline }),
            ...(color === undefined ? {} : { color }),
            ...(fill === undefined ? {} : { fill }),
            ...(fontSize === undefined ? {} : { fontSize }),
            ...(numberFormat === undefined ? {} : { numberFormat }),
          })
        } catch (error) {
          throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
            hint: 'xlsx 单元格用 sN-rN-cN；空单元格请先用 office.replace 写入内容，再设置格式。',
          })
        }
        const saved = editUserWorkspaceFile(deps, actor, file.fileId, edit.buffer, {
          baseVersion: Number(file.version),
          source: 'office.format',
          operationId,
          elementId: edit.elementId,
          applied: edit.applied,
        })
        result = {
          fileId: file.fileId,
          name: file.name,
          relPath: file.relPath,
          version: saved.updatedAt,
          operationId,
          elementId: edit.elementId,
          kind: edit.kind,
          applied: edit.applied,
          styleIndex: edit.styleIndex,
          wrote: true,
          saved: true,
          editorSync: false,
        }
        break
      }
      if (!/\.docx$/i.test(file.name)) {
        throw new EabError(EC.VALIDATION, `${file.name} 不是 docx 或 xlsx/xlsm，暂不支持格式设置`)
      }
      if (columnWidth !== undefined || rowHeight !== undefined) {
        throw new EabError(EC.VALIDATION, 'columnWidth、rowHeight 只适用于 xlsx/xlsm，docx 请使用段落或表格单元格格式')
      }
      const docx = file
      let edit
      try {
        edit = formatDocxText(docx.buffer, {
          elementId,
          ...(bold === undefined ? {} : { bold }),
          ...(italic === undefined ? {} : { italic }),
          ...(underline === undefined ? {} : { underline }),
          ...(color === undefined ? {} : { color }),
          ...(highlight === undefined ? {} : { highlight }),
          ...(fontSize === undefined ? {} : { fontSize }),
          ...(fontFamily === undefined ? {} : { fontFamily }),
          ...(align === undefined ? {} : { align }),
          ...(lineSpacing === undefined ? {} : { lineSpacing }),
          ...(spaceBefore === undefined ? {} : { spaceBefore }),
          ...(spaceAfter === undefined ? {} : { spaceAfter }),
        })
      } catch (error) {
        throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
          hint: '先用 office.find 确认 pN 或 tN-rN-cN；只给目标元素设置格式，不要整篇重排。',
        })
      }
      const saved = editUserWorkspaceFile(deps, actor, docx.fileId, edit.buffer, {
        baseVersion: Number(docx.version),
        source: 'office.format',
        operationId,
        elementId: edit.elementId,
        applied: edit.applied,
      })
      result = {
        fileId: docx.fileId,
        name: docx.name,
        relPath: docx.relPath,
        version: saved.updatedAt,
        operationId,
        elementId: edit.elementId,
        kind: edit.kind,
        applied: edit.applied,
        runCount: edit.runCount,
        wrote: true,
        saved: true,
        editorSync: false,
      }
      break
    }
    case 'office.comment': {
      const action = args.action === undefined ? 'add' : String(args.action)
      if (!['add', 'list', 'reply', 'resolve', 'delete'].includes(action)) {
        throw new EabError(EC.VALIDATION, 'action 只能是 add、list、reply、resolve 或 delete')
      }
      const file = resolveOfficeFile(deps, actor, args)
      if (/\.(xlsx|xlsm)$/i.test(file.name)) {
        if (action === 'reply' || action === 'resolve') {
          throw new EabError(EC.VALIDATION, 'xlsx 单元格批注是扁平批注，不支持 reply 或 resolve；请用 add/list/delete')
        }
        const operationId = `op_${ulid()}`
        if (action === 'list') {
          const comments = readXlsxComments(file.buffer)
          result = {
            fileId: file.fileId,
            name: file.name,
            relPath: file.relPath,
            version: file.version,
            operationId,
            action: 'list',
            kind: 'xlsx',
            total: comments.total,
            resolved: comments.resolvedCount,
            unresolved: comments.open,
            comments: comments.comments,
            wrote: false,
            editorSync: false,
          }
          break
        }
        if (action === 'add') {
          const elementId = String(args.elementId ?? '').trim()
          if (!elementId) throw new EabError(EC.VALIDATION, 'xlsx add 时 elementId 不能为空，请传 sN-rN-cN')
          if (typeof args.text !== 'string' || !args.text.trim()) {
            throw new EabError(EC.VALIDATION, 'text 不能为空')
          }
          if (args.oldText !== undefined || args.start !== undefined || args.end !== undefined || args.occurrence !== undefined) {
            throw new EabError(EC.VALIDATION, 'xlsx 批注不支持 oldText/start/end/occurrence，请直接给单元格加批注')
          }
          const author = args.author === undefined ? undefined : String(args.author).trim()
          let edit
          try {
            edit = addXlsxCellComment(file.buffer, {
              elementId,
              text: args.text,
              ...(author ? { author } : {}),
            })
          } catch (error) {
            throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
              hint: '先用 office.find 或 office.read_outline 确认 xlsx 的 sN-rN-cN；同一单元格只能有一条批注。',
            })
          }
          const saved = editUserWorkspaceFile(deps, actor, file.fileId, edit.buffer, {
            baseVersion: Number(file.version),
            source: 'office.comment',
            operationId,
            action,
            elementId: edit.elementId,
            commentId: edit.commentId,
            author: edit.author,
            text: edit.text,
          })
          result = {
            fileId: file.fileId,
            name: file.name,
            relPath: file.relPath,
            version: saved.updatedAt,
            operationId,
            action,
            kind: edit.kind,
            elementId: edit.elementId,
            sheetId: edit.sheetId,
            sheetName: edit.sheetName,
            cell: edit.cell,
            commentId: edit.commentId,
            author: edit.author,
            wrote: true,
            saved: true,
            editorSync: false,
          }
          break
        }
        const elementIdArg = args.elementId === undefined ? '' : String(args.elementId).trim()
        const commentIdArg = args.commentId === undefined ? undefined : Number(args.commentId)
        if (commentIdArg !== undefined && (!Number.isInteger(commentIdArg) || commentIdArg < 1)) {
          throw new EabError(EC.VALIDATION, 'commentId 必须是正整数')
        }
        if (elementIdArg && commentIdArg !== undefined) {
          throw new EabError(EC.VALIDATION, 'xlsx delete 时 elementId 和 commentId 只能二选一')
        }
        if (!elementIdArg && commentIdArg === undefined) {
          throw new EabError(EC.VALIDATION, 'xlsx delete 需要 elementId 或 commentId')
        }
        let edit
        try {
          edit = deleteXlsxCellComment(file.buffer, {
            ...(elementIdArg ? { elementId: elementIdArg } : {}),
            ...(commentIdArg === undefined ? {} : { commentId: commentIdArg }),
          })
        } catch (error) {
          throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
            hint: '先用 action=list 确认单元格和 commentId；删除最后一个批注会同时清理 comments、VML 和关系项。',
          })
        }
        const saved = editUserWorkspaceFile(deps, actor, file.fileId, edit.buffer, {
          baseVersion: Number(file.version),
          source: 'office.comment',
          operationId,
          action,
          elementId: edit.elementId,
          commentId: edit.commentId,
          remaining: edit.remaining,
        })
        result = {
          fileId: file.fileId,
          name: file.name,
          relPath: file.relPath,
          version: saved.updatedAt,
          operationId,
          action,
          kind: edit.kind,
          elementId: edit.elementId,
          sheetId: edit.sheetId,
          sheetName: edit.sheetName,
          cell: edit.cell,
          commentId: edit.commentId,
          deleted: edit.deleted,
          remaining: edit.remaining,
          wrote: true,
          saved: true,
          editorSync: false,
        }
        break
      }
      const docx = resolveOfficeDocx(deps, actor, args)
      const operationId = `op_${ulid()}`
      if (action === 'list') {
        const comments = readDocxComments(docx.buffer)
        result = {
          fileId: docx.fileId,
          name: docx.name,
          relPath: docx.relPath,
          version: docx.version,
          operationId,
          action: 'list',
          total: comments.total,
          resolved: comments.resolvedCount,
          unresolved: comments.open,
          comments: comments.comments,
          wrote: false,
          editorSync: false,
        }
        break
      }
      const commentIdArg = args.commentId === undefined ? undefined : Number(args.commentId)
      if (action !== 'add' && (commentIdArg === undefined || !Number.isInteger(commentIdArg) || commentIdArg < 1)) {
        throw new EabError(EC.VALIDATION, 'commentId 必须是正整数')
      }
      const commentId = commentIdArg ?? 0
      const author = args.author === undefined ? undefined : String(args.author).trim()
      let edit
      try {
        if (action === 'add') {
          const elementId = String(args.elementId ?? '').trim()
          if (!elementId) throw new EabError(EC.VALIDATION, 'elementId 不能为空')
          if (typeof args.text !== 'string' || !args.text.trim()) throw new EabError(EC.VALIDATION, 'text 不能为空')
          const oldText = args.oldText === undefined ? undefined : String(args.oldText)
          const occurrenceArg = args.occurrence === undefined ? undefined : Number(args.occurrence)
          if (occurrenceArg !== undefined && (!Number.isInteger(occurrenceArg) || occurrenceArg < 1)) {
            throw new EabError(EC.VALIDATION, 'occurrence 必须是正整数')
          }
          const start = args.start === undefined ? undefined : Number(args.start)
          const end = args.end === undefined ? undefined : Number(args.end)
          if (oldText !== undefined && (start !== undefined || end !== undefined)) {
            throw new EabError(EC.VALIDATION, 'oldText 和 start/end 只能二选一')
          }
          edit = addDocxComment(docx.buffer, {
            elementId,
            text: args.text,
            ...(author ? { author } : {}),
            ...(oldText !== undefined ? { oldText } : {}),
            ...(occurrenceArg !== undefined ? { occurrence: occurrenceArg } : {}),
            ...(start === undefined ? {} : { start }),
            ...(end === undefined ? {} : { end }),
          })
          const saved = editUserWorkspaceFile(deps, actor, docx.fileId, edit.buffer, {
            baseVersion: Number(docx.version),
            source: 'office.comment',
            operationId,
            action,
            elementId: edit.elementId,
            commentId: edit.commentId,
            author: edit.author,
            text: edit.text,
          })
          result = {
            fileId: docx.fileId,
            name: docx.name,
            relPath: docx.relPath,
            version: saved.updatedAt,
            operationId,
            action,
            elementId: edit.elementId,
            kind: edit.kind,
            commentId: edit.commentId,
            author: edit.author,
            ...(edit.start === undefined ? {} : { start: edit.start }),
            ...(edit.end === undefined ? {} : { end: edit.end }),
            wrote: true,
            saved: true,
            editorSync: false,
          }
          break
        }
        if (action === 'reply') {
          if (typeof args.text !== 'string' || !args.text.trim()) throw new EabError(EC.VALIDATION, 'text 不能为空')
          edit = replyDocxComment(docx.buffer, {
            commentId,
            text: args.text,
            ...(author ? { author } : {}),
          })
        } else if (action === 'resolve') {
          edit = resolveDocxComment(docx.buffer, {
            commentId,
            resolved: args.resolved !== false,
          })
        } else {
          edit = deleteDocxComment(docx.buffer, { commentId })
        }
      } catch (error) {
        if (error instanceof EabError) throw error
        throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
          hint:
            action === 'add'
              ? '先用 office.find 确认 pN 或 tN-rN-cN；批注范围可传 oldText 或 start/end 收窄到短语。'
              : '先用 action=list 确认 commentId；删除会连同回复和锚点一起移除。',
        })
      }
      const saved = editUserWorkspaceFile(deps, actor, docx.fileId, edit.buffer, {
        baseVersion: Number(docx.version),
        source: 'office.comment',
        operationId,
        action: edit.action,
        commentId: edit.commentId,
        ...(edit.replyId === undefined ? {} : { replyId: edit.replyId }),
        ...(edit.deletedIds === undefined ? {} : { deletedIds: edit.deletedIds }),
      })
      result = {
        fileId: docx.fileId,
        name: docx.name,
        relPath: docx.relPath,
        version: saved.updatedAt,
        operationId,
        action: edit.action,
        commentId: edit.commentId,
        ...(edit.replyId === undefined ? {} : { replyId: edit.replyId }),
        ...(edit.resolved === undefined ? {} : { resolved: edit.resolved }),
        ...(edit.deletedIds === undefined ? {} : { deletedIds: edit.deletedIds }),
        wrote: true,
        saved: true,
        editorSync: false,
      }
      break
    }
    case 'office.replace': {
      const elementId = String(args.elementId ?? '').trim()
      if (!elementId) throw new EabError(EC.VALIDATION, 'elementId 不能为空')
      if (typeof args.newText !== 'string') throw new EabError(EC.VALIDATION, 'newText 必须是字符串')
      const file = resolveOfficeFile(deps, actor, args)
      const operationId = `op_${ulid()}`
      const occurrenceArg = args.occurrence === undefined ? undefined : Number(args.occurrence)
      const commonOptions = {
        elementId,
        ...(typeof args.oldText === 'string' ? { oldText: args.oldText } : {}),
        newText: args.newText,
        ...(occurrenceArg === undefined || !Number.isFinite(occurrenceArg) ? {} : { occurrence: occurrenceArg }),
      }
      if (isXlsxFileName(file.name)) {
        let edit
        try {
          edit = replaceXlsxCellText(file.buffer, commonOptions)
        } catch (error) {
          throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
            hint: '先用 office.find 确认 xlsx 单元格 ID（sN-rN-cN）、工作表名和原文，再只替换目标单元格；不要整表覆盖。',
          })
        }
        const saved = editUserWorkspaceFile(deps, actor, file.fileId, edit.buffer, {
          baseVersion: Number(file.version),
          source: 'office.replace',
          operationId,
          elementId: edit.elementId,
          replacements: edit.replacements,
        })
        result = {
          fileId: file.fileId,
          name: file.name,
          relPath: file.relPath,
          version: saved.updatedAt,
          operationId,
          kind: 'xlsx',
          elementId: edit.elementId,
          cellKind: edit.kind,
          previousText: edit.previousText,
          nextText: edit.nextText,
          replacements: edit.replacements,
          wrote: true,
          saved: true,
          editorSync: false,
        }
        break
      }
      if (isPptxFileName(file.name)) {
        if (occurrenceArg === 0) {
          throw new EabError(EC.VALIDATION, 'pptx 段落替换暂不支持 occurrence=0；请分别指定第几处')
        }
        let edit
        try {
          edit = replacePptxText(file.buffer, commonOptions)
        } catch (error) {
          throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
            hint: '先用 office.find 确认 pptx 段落 ID（sN-pM）和原文；跨 run 时新文本沿用第一个 run 的格式。',
          })
        }
        const saved = editUserWorkspaceFile(deps, actor, file.fileId, edit.buffer, {
          baseVersion: Number(file.version),
          source: 'office.replace',
          operationId,
          elementId: edit.elementId,
          replacements: edit.replacements,
        })
        result = {
          fileId: file.fileId,
          name: file.name,
          relPath: file.relPath,
          version: saved.updatedAt,
          operationId,
          kind: 'pptx',
          elementId: edit.elementId,
          paragraphKind: edit.kind,
          previousText: edit.previousText,
          nextText: edit.nextText,
          replacements: edit.replacements,
          wrote: true,
          saved: true,
          editorSync: false,
        }
        break
      }
      const docx = resolveOfficeDocx(deps, actor, args)
      let edit
      try {
        edit = replaceDocxText(docx.buffer, {
          ...commonOptions,
          ...(args.trackChanges === true ? { trackChanges: true } : {}),
          ...(typeof args.author === 'string' && args.author.trim() ? { author: args.author.trim() } : {}),
        })
      } catch (error) {
        throw new EabError(EC.VALIDATION, error instanceof Error ? error.message : String(error), {
          hint: '先用 office.find 确认 elementId 与原文，再只替换目标片段；不要整篇重写。需要保留修订标记时传 trackChanges=true。',
        })
      }
      const saved = editUserWorkspaceFile(deps, actor, docx.fileId, edit.buffer, {
        baseVersion: Number(docx.version),
        source: 'office.replace',
        operationId,
        elementId: edit.elementId,
        replacements: edit.replacements,
      })
      result = {
        fileId: docx.fileId,
        name: docx.name,
        relPath: docx.relPath,
        version: saved.updatedAt,
        operationId,
        elementId: edit.elementId,
        kind: edit.kind,
        previousText: edit.previousText,
        nextText: edit.nextText,
        replacements: edit.replacements,
        ...(edit.tracked ? { trackChanges: true } : {}),
        wrote: true,
        saved: true,
        editorSync: false,
      }
      break
    }
    case 'office.versions': {
      const file = resolveOfficeFile(deps, actor, args)
      const action = String(args.action ?? 'list').trim().toLowerCase() || 'list'
      if (action === 'list') {
        const versions = listWorkspaceFileVersions(deps, actor, file.fileId)
        result = {
          fileId: file.fileId,
          name: file.name,
          relPath: file.relPath,
          version: Number(file.version),
          count: versions.length,
          versions,
          wrote: false,
        }
        break
      }
      if (action === 'snapshot') {
        const snapshot = createWorkspaceFileSnapshot(deps, actor, file.fileId)
        result = {
          fileId: file.fileId,
          name: file.name,
          relPath: file.relPath,
          created: snapshot.created,
          version: snapshot.version,
          versionId: snapshot.id,
          size: snapshot.size,
          source: snapshot.source,
          summary: snapshot.summary,
          wrote: snapshot.created,
        }
        break
      }
      if (action === 'restore') {
        const versionId = String(args.versionId ?? '').trim()
        if (!versionId) throw new EabError(EC.VALIDATION, 'restore 需要 versionId；先调用 action=list 获取')
        const restored = restoreWorkspaceFileVersion(deps, actor, file.fileId, versionId)
        result = {
          fileId: restored.file.id,
          name: restored.file.name,
          relPath: restored.file.relPath,
          version: restored.file.updatedAt,
          size: restored.file.size,
          restoredVersion: {
            id: restored.restoredVersion.id,
            version: restored.restoredVersion.version,
            createdAt: restored.restoredVersion.createdAt,
          },
          snapshot: restored.file.snapshot ?? null,
          wrote: true,
        }
        break
      }
      throw new EabError(EC.VALIDATION, 'action 只能是 list、snapshot 或 restore')
    }
    case 'office.export': {
      const file = resolveOfficeFile(deps, actor, args)
      const format = (String(args.format ?? 'pdf').trim().toLowerCase() || 'pdf')
      if (format !== 'pdf') throw new EabError(EC.VALIDATION, '当前只支持导出 PDF')
      let exported: Awaited<ReturnType<typeof exportWorkspaceFileToPdf>>
      try {
        exported = await exportWorkspaceFileToPdf(deps, actor, file.fileId)
      } catch (error) {
        throw error instanceof EabError
          ? error
          : new EabError(EC.INTERNAL, `导出 PDF 失败：${error instanceof Error ? error.message : String(error)}`)
      }
      const stem = file.name.replace(/\.[^.]+$/, '')
      const saved = saveUserWorkspaceFile(deps, actor, {
        relPath: `${stem}.pdf`,
        buffer: exported.buffer,
        mime: 'application/pdf',
        channel: 'agent',
      })
      result = {
        sourceFileId: file.fileId,
        sourceName: file.name,
        fileId: saved.id,
        name: saved.name,
        relPath: saved.relPath,
        size: saved.size,
        format: 'pdf',
        wrote: true,
      }
      break
    }
    case 'office.gui': {
      const action = (String(args.action ?? 'prepare').trim().toLowerCase() || 'prepare')
      if (action !== 'prepare' && action !== 'status' && action !== 'report') {
        throw new EabError(EC.VALIDATION, 'action 只能是 prepare、status 或 report')
      }
      const fallbackId = String(args.fallbackId ?? '').trim()
      let fileId = String(args.fileId ?? '').trim()
      if (action !== 'prepare' && !fileId) {
        if (!fallbackId) throw new EabError(EC.VALIDATION, 'status/report 需要 fallbackId，或同时提供 fileId')
        const row = deps.db
          .prepare(
            `SELECT file_id FROM workspace_gui_fallbacks
              WHERE id = ? AND company_id = ? AND user_id = ? LIMIT 1`,
          )
          .get(fallbackId, actor.subject.companyId, actor.subject.userId) as { file_id: string } | undefined
        if (!row) throw new EabError(EC.NOT_FOUND, 'GUI 兜底记录不存在')
        fileId = row.file_id
      }
      const ctx = {
        actor,
        traceId: context.turnId,
        channel: 'agent' as const,
      }
      if (action === 'prepare') {
        const prepared = prepareWorkspaceGuiFallback(deps, ctx, {
          fileId: fileId || undefined,
          path: String(args.path ?? '').trim() || undefined,
          action: String(args.guiAction ?? '').trim() || undefined,
          dialog: String(args.dialog ?? '').trim() || undefined,
          format: String(args.format ?? '').trim() || undefined,
          note: String(args.note ?? '').trim() || undefined,
        })
        result = {
          ...prepared,
          wrote: false,
          requiresUserConfirmation: true,
          agentCanConfirm: false,
          hint: '已生成兜底步骤；请让用户在前端“GUI 兜底”弹窗里点击确认，再由用户自己在 OnlyOffice 完成。不要自行确认或伪造结果。',
        }
        break
      }
      if (action === 'status') {
        const status = getWorkspaceGuiFallback(deps, ctx, fileId, fallbackId)
        result = {
          ...status,
          wrote: false,
          agentCanConfirm: false,
        }
        break
      }
      const reportStatus = String(args.result ?? '').trim().toLowerCase()
      if (reportStatus !== 'success' && reportStatus !== 'failure') {
        throw new EabError(EC.VALIDATION, 'report 需要 result=success 或 failure')
      }
      const reported = reportWorkspaceGuiFallback(
        deps,
        ctx,
        fileId,
        fallbackId,
        reportStatus,
        String(args.detail ?? '').trim(),
      )
      result = {
        ...reported,
        wrote: false,
        reported: true,
        retryable: reportStatus === 'success',
      }
      break
    }
    case 'workspace.send_dingtalk': {
      const fileIdArg = String(args.fileId ?? '').trim()
      const pathArg = String(args.path ?? '').trim()
      const urlArg = String(args.url ?? '').trim()
      if (urlArg) {
        const ref = kbAssetRefOf(urlArg)
        if (!ref) {
          throw new EabError(EC.VALIDATION, '只支持发送 EAB 知识库图片地址', {
            details: { url: urlArg },
            hint: 'url 只接受 /api/kb/assets/<docId>/<assetId> 或 /api/console/kb/docs/<docId>/assets/<assetId>。',
          })
        }
        requireScope(actor.subject, SC.KB_READ)
        const { row, buffer } = getDocAsset(
          deps.db,
          deps.config,
          actor.subject.companyId,
          ref.docId,
          ref.assetId,
        )
        const fileName = row.source_name || `${row.id}.png`
        const mime = dingTalkImageMimeOf(fileName, row.mime)
        if (!mime) {
          throw new EabError(EC.VALIDATION, '知识库资产不是支持的图片格式', {
            details: { docId: ref.docId, assetId: ref.assetId, mime: row.mime },
          })
        }
        const sent = await sendDingTalkFileToUser(deps, {
          companyId: actor.subject.companyId,
          userId: actor.subject.userId,
          fileName,
          mime,
          buffer,
        })
        result = {
          sent: true,
          delivery: 'image',
          source: 'kb-asset',
          to: '钉钉机器人私聊',
          fileName,
          size: buffer.length,
          docId: ref.docId,
          assetId: ref.assetId,
          mime,
          fileType: sent.fileType,
          mediaType: sent.mediaType,
          mediaId: sent.mediaId,
        }
        break
      }
      let targetId = fileIdArg
      let diskImage: WorkspaceImageFile | null = null
      if (!targetId) {
        if (!pathArg) throw new EabError(EC.VALIDATION, 'fileId 和 path 至少提供一个')
        const row = deps.db
          .prepare(
            `SELECT id FROM workspace_files
              WHERE company_id = ? AND owner_user_id = ? AND deleted_at IS NULL
                AND (rel_path = ? OR name = ?)
              ORDER BY updated_at DESC LIMIT 1`,
          )
          .get(actor.subject.companyId, actor.subject.userId, pathArg, pathArg) as { id: string } | undefined
        if (row) {
          targetId = row.id
        } else {
          // 图片可能刚由 project.exec/导出工具写到磁盘，还没进 workspace_files；
          // 只在这类文件确实是用户工作区内的图片时放行。
          try {
            diskImage = readWorkspaceImageFileByPath(deps, actor, pathArg)
          } catch (error) {
            if (error instanceof EabError && error.code === EC.NOT_FOUND) {
              throw new EabError(EC.NOT_FOUND, `云空间里没有找到文件: ${pathArg}`, {
                hint: '先调用 workspace.list 查看文件名和相对路径，再用 path 或 fileId 发送；图片也可以是工作区里刚生成的相对路径。',
              })
            }
            throw error
          }
        }
      }
      const file = targetId ? readUserWorkspaceFile(deps, actor, targetId) : diskImage!
      const imageMime = dingTalkImageMimeOf(file.name, file.mime)
      if (imageMime) {
        // 图片走机器人原生图片消息，直接在钉钉里显示为图片气泡；不再走
        // convFile 用户方向文件消息，否则客户端只会把它当普通文件附件。
        const sent = await sendDingTalkFileToUser(deps, {
          companyId: actor.subject.companyId,
          userId: actor.subject.userId,
          fileName: file.name,
          mime: imageMime,
          buffer: file.buffer,
        })
        result = {
          sent: true,
          delivery: 'image',
          to: '钉钉机器人私聊',
          fileName: file.name,
          size: file.size,
          relPath: file.relPath,
          mime: imageMime,
          fileType: sent.fileType,
          mediaType: sent.mediaType,
          mediaId: sent.mediaId,
        }
        break
      }
      if (space.kind === 'cloud') {
        // 钉钉会话里优先用「用户方向」发文件：convFile/conversations/files/send 会以
        // 操作人 unionId 发出，文件落在机器人私聊右侧，客户端原生带预览/未查收/下载/编辑。
        // 机器人随后会收到同一条 file 入站消息，用 robot_user_file_sends 一次性标记拦截，
        // 跳过个人云空间保存，只回复「你要的文件已发送」。
        const openConversationId = openConversationIdForTool(deps, actor.subject.companyId, context)
        if (context.channel === 'dingtalk' && openConversationId) {
          const uploaded = await uploadFileToUserDrive(deps, {
            companyId: actor.subject.companyId,
            userId: actor.subject.userId,
            fileName: file.name,
            mime: file.mime,
            buffer: file.buffer,
          })
          const markerId = createRobotUserFileSend(deps.db, {
            companyId: actor.subject.companyId,
            userId: actor.subject.userId,
            conversationId: openConversationId,
            fileName: uploaded.fileName,
            sizeBytes: uploaded.size,
          })
          try {
            const sent = await sendDingTalkFileToConversation(deps, {
              companyId: actor.subject.companyId,
              userId: actor.subject.userId,
              openConversationId,
              spaceId: uploaded.spaceId,
              dentryId: uploaded.dentryId,
            })
            markRobotUserFileSendSent(deps.db, markerId, {
              fileId: sent.fileId,
              spaceId: sent.spaceId,
              fileName: sent.name || uploaded.fileName,
            })
            result = {
              sent: true,
              delivery: 'file-user-identity',
              to: '钉钉机器人私聊（用户方向）',
              fileName: sent.name || uploaded.fileName,
              size: uploaded.size,
              relPath: file.relPath,
              fileId: sent.fileId,
            }
          } catch (error) {
            markRobotUserFileSendFailed(deps.db, markerId)
            throw error
          }
          break
        }
        // 网页会话拿不到 openConversationId 时退回机器人 sampleFile，保证仍有文件送达。
        const sent = await sendDingTalkFileToUser(deps, {
          companyId: actor.subject.companyId,
          userId: actor.subject.userId,
          fileName: file.name,
          mime: file.mime,
          buffer: file.buffer,
        })
        result = {
          sent: true,
          delivery: 'file',
          to: '钉钉机器人私聊',
          fileName: file.name,
          size: file.size,
          relPath: file.relPath,
          fileType: sent.fileType,
          mediaType: sent.mediaType,
        }
        break
      }
      const sent = await sendDingTalkFileToUser(deps, {
        companyId: actor.subject.companyId,
        userId: actor.subject.userId,
        fileName: file.name,
        mime: file.mime,
        buffer: file.buffer,
      })
      result = {
        sent: true,
        delivery: 'file',
        to: '钉钉',
        fileName: file.name,
        size: file.size,
        relPath: file.relPath,
        fileType: sent.fileType,
        mediaType: sent.mediaType,
      }
      break
    }
    case 'workspace.rename': {
      const fileIdArg = String(args.fileId ?? '').trim()
      const pathArg = String(args.path ?? '').trim()
      let targetId = fileIdArg
      if (!targetId) {
        if (!pathArg) throw new EabError(EC.VALIDATION, 'fileId 和 path 至少提供一个')
        const row = deps.db
          .prepare(
            `SELECT id FROM workspace_files
              WHERE company_id = ? AND owner_user_id = ? AND deleted_at IS NULL
                AND (rel_path = ? OR name = ?)
              ORDER BY updated_at DESC LIMIT 1`,
          )
          .get(actor.subject.companyId, actor.subject.userId, pathArg, pathArg) as { id: string } | undefined
        if (!row) {
          throw new EabError(EC.NOT_FOUND, `云空间里没有找到文件: ${pathArg}`, {
            hint: '先调用 workspace.list 查看文件名和相对路径，再用 path 或 fileId 重命名。',
          })
        }
        targetId = row.id
      }
      const newName = String(args.newName ?? args.name ?? '').trim()
      if (!newName) throw new EabError(EC.VALIDATION, 'newName 不能为空')
      const renamed = renameUserWorkspaceFile(deps, actor, targetId, newName)
      result = {
        renamed: true,
        fileId: renamed.file.id,
        from: renamed.from,
        to: renamed.to,
        name: renamed.file.name,
      }
      break
    }
    case 'workspace.delete': {
      const fileIdArg = String(args.fileId ?? '').trim()
      const pathArg = String(args.path ?? '').trim()
      let targetId = fileIdArg
      if (!targetId) {
        if (!pathArg) throw new EabError(EC.VALIDATION, 'fileId 和 path 至少提供一个')
        const row = deps.db
          .prepare(
            `SELECT id FROM workspace_files
              WHERE company_id = ? AND owner_user_id = ? AND deleted_at IS NULL
                AND (rel_path = ? OR name = ?)
              ORDER BY updated_at DESC LIMIT 1`,
          )
          .get(actor.subject.companyId, actor.subject.userId, pathArg, pathArg) as { id: string } | undefined
        if (!row) {
          throw new EabError(EC.NOT_FOUND, `云空间里没有找到文件: ${pathArg}`, {
            hint: '先调用 workspace.list 查看文件名和相对路径，再用 path 或 fileId 删除。',
          })
        }
        targetId = row.id
      }
      const deleted = deleteUserWorkspaceFile(deps, actor, targetId)
      result = {
        deleted: true,
        fileId: deleted.file.id,
        fileName: deleted.file.name,
        relPath: deleted.file.relPath,
        size: deleted.file.size,
        recycled: true,
      }
      break
    }
    case 'workspace.folder': {
      const action = String(args.action ?? '').trim().toLowerCase()
      const pathArg = String(args.path ?? '').trim()
      if (!action) throw new EabError(EC.VALIDATION, 'action 不能为空；可选 create、rename、delete')
      if (!pathArg) throw new EabError(EC.VALIDATION, 'path 不能为空')
      if (action === 'create') {
        const created = createUserWorkspaceFolder(deps, actor, pathArg)
        result = {
          created: true,
          folderPath: created.folderPath,
          name: created.folderPath.split('/').pop(),
          note: '文件夹已创建；空文件夹会保留在云空间列表和 workspace.list 的 folders 里。',
        }
        break
      }
      if (action === 'rename') {
        const newName = String(args.newName ?? args.name ?? '').trim()
        if (!newName) throw new EabError(EC.VALIDATION, 'action=rename 时 newName 不能为空')
        const renamed = renameUserWorkspaceFolder(deps, actor, pathArg, newName)
        result = {
          renamed: true,
          from: renamed.from,
          to: renamed.to,
          folderPath: renamed.to,
          fileCount: renamed.fileCount,
        }
        break
      }
      if (action === 'delete') {
        const deleted = deleteUserWorkspaceFolder(deps, actor, pathArg)
        result = {
          deleted: true,
          folderPath: deleted.folderPath,
          fileCount: deleted.fileCount,
          recycled: true,
          note: '文件夹内的本人文件已移到回收区；其他成员共享来的文件不会被删除。',
        }
        break
      }
      throw new EabError(EC.VALIDATION, `不支持的 action: ${action}`, {
        hint: 'action 只能是 create、rename 或 delete。',
      })
    }
    case 'memory.propose': {
      let content = String(args.content ?? '').trim()
      if (!content) throw new EabError(EC.VALIDATION, '记忆内容不能为空')
      if (content.length > 1000) throw new EabError(EC.VALIDATION, '单条记忆最多 1000 字')
      const requestedScope = args.scopeType === undefined ? 'company' : String(args.scopeType).trim().toLowerCase()
      if (requestedScope !== 'user' && requestedScope !== 'company') {
        throw new EabError(EC.VALIDATION, 'scopeType 只能是 user 或 company')
      }
      const scopeType: 'user' | 'company' = requestedScope
      const defaultType: MemoryType = scopeType === 'user' ? 'preference' : 'decision'
      const requestedType = args.memoryType === undefined ? defaultType : String(args.memoryType).trim().toLowerCase()
      const memoryType: MemoryType =
        requestedType === 'preference' || requestedType === 'fact' || requestedType === 'decision' || requestedType === 'episode'
          ? requestedType
          : normalizeMemoryType(requestedType, defaultType)
      const scopeId = scopeType === 'user' ? actor.person.id : actor.subject.companyId
      const subject = String(args.subject ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
      const predicate = String(args.predicate ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
      const objectText = String(args.object ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
      const factKey = memoryType === 'fact' ? normalizeFactKey(args.factKey) : ''
      const derived = memoryType === 'fact' && !factKey ? structuredFactFromContent(content) : null
      const resolvedSubject = subject || derived?.subject || ''
      const resolvedPredicate = predicate || derived?.predicate || ''
      const resolvedObject = objectText || derived?.objectText || ''
      const resolvedFactKey = factKey || derived?.factKey || ''
      const resolvedConfidence = Number.isFinite(Number(args.confidence))
        ? Math.max(0, Math.min(1, Number(args.confidence)))
        : derived?.confidence ?? 1
      if (resolvedFactKey && !resolvedObject) {
        content = content || [resolvedSubject, resolvedPredicate].filter(Boolean).join(' ')
      }
      if (resolvedObject && !content.includes(resolvedObject)) {
        content = [content, resolvedObject].filter(Boolean).join('：')
      }
      if (memoryLooksSensitive(content) || (resolvedObject && memoryLooksSensitive(resolvedObject))) {
        throw new EabError(EC.VALIDATION, '这条内容包含敏感凭证或隐私信息，不能写入长期记忆')
      }
      const existing = resolvedFactKey
        ? findStructuredFactConflict(deps.db, {
            companyId: actor.subject.companyId,
            scopeType,
            scopeId,
            factKey: resolvedFactKey,
            objectText: resolvedObject || content,
          })
        : findMemoryDuplicateOrConflict(deps.db, {
            companyId: actor.subject.companyId,
            scopeType,
            scopeId,
            memoryType,
            content,
          })
      if (existing?.kind === 'duplicate') {
        result = {
          id: existing.memory.id,
          scopeType,
          memoryType,
          memoryTypeLabel: MEMORY_TYPE_LABELS[memoryType],
          factKey: (existing.memory.factKey ?? resolvedFactKey) || null,
          confirmed: existing.memory.confirmed === 1,
          status: memoryStatus({
            confirmed: existing.memory.confirmed,
            conflict_with: existing.memory.conflict_with ?? null,
          }),
          duplicate: true,
          note: scopeType === 'user'
            ? existing.memory.confirmed === 1
              ? '这条个人记忆已经生效'
              : '这条个人记忆已在你的待确认区，无需重复提交'
            : existing.memory.confirmed === 1
              ? '这条团队记忆已经生效'
              : '这条团队学习已经在待审核队列里，无需重复提交',
        }
        break
      }
      const id = `mem_${ulid()}`
      const now = Date.now()
      const conflictWith = existing?.kind === 'conflict' ? existing.memory.id : null
      // 用户明确让记住的个人事实/偏好/决策，高置信且不冲突就直接生效；团队记忆始终待管理员审核。
      const autoActivate =
        memoryAutoConfirmEnabled() &&
        scopeType === 'user' &&
        !conflictWith &&
        personalMemoryAutoActivates(memoryType, resolvedConfidence)
      deps.db
        .prepare(
          `INSERT INTO memories
             (id, company_id, scope_type, scope_id, user_id, content, memory_type, confirmed,
              conflict_with, subject, predicate, object_text, fact_key, confidence,
              valid_from, importance, sensitivity, extraction_source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', 'tool', ?)`,
        )
        .run(
          id,
          actor.subject.companyId,
          scopeType,
          scopeId,
          actor.person.id,
          content,
          memoryType,
          autoActivate ? 1 : 0,
          conflictWith,
          resolvedSubject || null,
          resolvedPredicate || null,
          resolvedObject || null,
          resolvedFactKey || null,
          resolvedConfidence,
          now,
          memoryType === 'fact' ? 0.7 : 0.6,
          now,
        )
      await embedMemoryRow(deps.db, deps.config.dbPath, actor.subject.companyId, {
        id,
        content,
        memory_type: memoryType,
        confirmed: autoActivate ? 1 : 0,
        conflict_with: conflictWith,
        created_at: now,
      })
      appendAudit(deps.db, {
        companyId: actor.subject.companyId,
        actorUserId: actor.person.id,
        action: 'memory.propose',
        resourceType: 'memory',
        resourceId: id,
        result: 'success',
        detail: {
          scopeType,
          memoryType,
          length: content.length,
          autoActivated: autoActivate,
          ...(conflictWith ? { conflictWith } : {}),
        },
        ip: null,
        channel: 'web',
      })
      result = {
        id,
        scopeType,
        memoryType,
        memoryTypeLabel: MEMORY_TYPE_LABELS[memoryType],
        ...(resolvedFactKey
          ? {
              factKey: resolvedFactKey,
              subject: resolvedSubject || null,
              predicate: resolvedPredicate || null,
              object: resolvedObject || null,
            }
          : {}),
        confirmed: autoActivate,
        status: conflictWith ? 'conflict' : autoActivate ? 'active' : 'pending',
        conflictWith,
        note: scopeType === 'user'
          ? conflictWith
            ? '这条个人记忆与你已确认的旧记忆高度相近，已标为冲突待确认；你在“我的记忆”里确认替换后才会生效'
            : autoActivate
              ? '已记住并自动生效，仅用于你个人的对话上下文，不会共享给团队；可随时在“我的记忆”里删除'
              : '已记为你的个人记忆候选，待你在“我的记忆”确认后生效；不会自动共享给团队'
          : conflictWith
            ? '这条团队学习与已确认的旧记忆高度相近，已标为冲突待确认；管理员确认后才会替换旧记忆'
            : '已提交团队学习候选，待管理员审核通过后对全公司所有智能体生效',
      }
      break
    }
    case 'content.generate_image': {
      const prompt = String(args.prompt ?? '').trim()
      if (!prompt) throw new EabError(EC.VALIDATION, 'prompt 不能为空')
      const asset = await generateImageToWorkspace(deps, actor, {
        prompt,
        size: typeof args.size === 'string' ? args.size : undefined,
        channel: context.channel ?? 'agent',
        traceId: context.traceId ?? null,
      })
      result = {
        fileId: asset.file.id,
        name: asset.file.name,
        relPath: asset.file.relPath,
        size: asset.file.size,
        mime: asset.file.mime,
        downloadUrl: asset.downloadUrl,
        modelKey: asset.modelKey,
        note: `已生成图片「${asset.file.name}」并保存到个人云空间；下载地址 ${asset.downloadUrl}`,
      }
      break
    }
    case 'workspace.write': {
      const path = String(args.path ?? '')
      const text = String(args.text ?? '')
      if (!path) throw new EabError(EC.VALIDATION, 'path 不能为空')
      if (text.startsWith('PK\u0003\u0004')) {
        throw new EabError(EC.VALIDATION, 'workspace.write 只接受文本内容，不能直接写二进制 Office 文件', {
          hint: '请把表格写成 CSV/TSV 文本并保存为 .csv，或保存为 .xlsx 让服务端自动转换成真实工作簿；docx/pptx 请用对应的 Office 工具处理。',
        })
      }
      const ext = extname(path).toLowerCase()
      if (ext === '.docx' || ext === '.docm' || ext === '.pptx' || ext === '.pptm' || ext === '.xls' || ext === '.xlsm') {
        throw new EabError(EC.VALIDATION, `workspace.write 不支持直接生成 ${ext} 文件`, {
          hint: 'docx/pptx/xls/xlsm 需要二进制结构，不能用一段文本冒充。表格请写 .csv/.tsv，或写 .xlsx 由服务端生成真实工作簿；Word/PowerPoint 请另存为文本或使用对应的 Office 编辑工具。',
        })
      }
      const root = userScopeDir(deps, actor.subject.companyId, actor.subject.userId)
      const target = safeJoin(root, path)
      if (!target) throw new EabError(EC.VALIDATION, '非法路径')
      mkdirSync(dirname(target), { recursive: true })
      let buffer: Buffer = Buffer.from(text, 'utf8')
      let mime = 'text/plain'
      let note: string | undefined
      if (ext === '.xlsx') {
        const table = parseTabularText(text)
        buffer = buildXlsxFromTabular({
          sheetName: basename(path, ext),
          columns: table.columns,
          rows: table.rows,
        })
        mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        const formatLabel = table.format === 'json'
          ? 'JSON 记录'
          : table.format === 'markdown'
            ? 'Markdown 表格'
            : table.format === 'csv' || table.format === 'tsv'
              ? table.format.toUpperCase()
              : '逐行文本'
        note = `已把${formatLabel}转换为真实 xlsx：${table.rows.length} 行数据、${table.columns.length} 列，可直接用 Excel/OnlyOffice 打开。`
        if (table.format === 'lines') {
          note += ' 当前内容没有识别出多列结构，已按每行一列保存；需要多列表格时请写 CSV、TSV 或 Markdown 表格。'
        }
      }
      writeFileSync(target, buffer)
      const row = deps.db
        .prepare(
          `SELECT id FROM workspace_files WHERE company_id = ? AND scope_type = 'user' AND scope_id = ? AND rel_path = ? AND deleted_at IS NULL`,
        )
        .get(actor.subject.companyId, actor.subject.userId, path) as { id: string } | undefined
      const size = buffer.byteLength
      const fileId = row?.id ?? ulid()
      const now = Date.now()
      if (row) {
        deps.db
          .prepare('UPDATE workspace_files SET size = ?, mime = ?, storage_path = ?, updated_at = ? WHERE id = ?')
          .run(size, mime, target, now, row.id)
      } else {
        deps.db
          .prepare(
            `INSERT INTO workspace_files (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, mime, storage_path, created_at, updated_at)
             VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(fileId, actor.subject.companyId, actor.subject.userId, actor.subject.userId, path, basename(path), size, mime, target, now, now)
      }
      publishWorkspaceFilesChanged(actor.subject.companyId, actor.subject.userId, row ? 'updated' : 'created', [fileId])
      result = { fileId, path, size, created: !row, mime, ...(note ? { note } : {}) }
      break
    }
    case 'workspace.edit': {
      const path = String(args.path ?? '')
      if (!path) throw new EabError(EC.VALIDATION, 'path 不能为空')
      if (!isTextEditableFile(path)) {
        throw new EabError(EC.VALIDATION, '该文件类型暂不支持 Agent 文本局部编辑', {
          hint: 'docx 请先用 office.find 定位段落/单元格，xlsx/xlsm 请先定位单元格，pptx 请先定位段落 sN-pM，再用 office.replace 只替换该元素；workspace.edit 只支持 txt/md/csv/json/代码等文本文件。',
        })
      }
      let rawEdits: unknown = args.edits
      if (typeof rawEdits === 'string') {
        try {
          rawEdits = JSON.parse(rawEdits)
        } catch {
          throw new EabError(EC.VALIDATION, 'edits 必须是 JSON 数组')
        }
      }
      if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
        throw new EabError(EC.VALIDATION, 'edits 不能为空', { hint: '每项至少包含 find 和 replace' })
      }
      if (rawEdits.length > 50) throw new EabError(EC.VALIDATION, '一次最多修改 50 处')
      const edits: WorkspaceTextEdit[] = rawEdits.map((item, index) => {
        if (!item || typeof item !== 'object') {
          throw new EabError(EC.VALIDATION, `第 ${index + 1} 项不是有效对象`)
        }
        const value = item as Record<string, unknown>
        const find = String(value.find ?? '')
        const replace = String(value.replace ?? '')
        if (!find) throw new EabError(EC.VALIDATION, `第 ${index + 1} 项 find 不能为空`)
        return {
          find,
          replace,
          ...(value.occurrence === undefined ? {} : { occurrence: Number(value.occurrence) }),
        }
      })
      const root = userScopeDir(deps, actor.subject.companyId, actor.subject.userId)
      const target = safeJoin(root, path)
      if (!target) throw new EabError(EC.VALIDATION, '非法路径')
      if (!existsSync(target)) throw new EabError(EC.NOT_FOUND, '要修改的文件不存在', { hint: '新文件请先用 workspace.write 创建' })
      const source = readFileSync(target, 'utf8')
      if (Buffer.byteLength(source, 'utf8') > 5 * 1024 * 1024) {
        throw new EabError(EC.VALIDATION, '文件超过 5 MB，暂不支持局部编辑')
      }
      const applied = applyWorkspaceTextEdits(source, edits)
      writeFileSync(target, applied.text, 'utf8')
      const row = deps.db
        .prepare(
          `SELECT id FROM workspace_files WHERE company_id = ? AND scope_type = 'user' AND scope_id = ? AND rel_path = ? AND deleted_at IS NULL`,
        )
        .get(actor.subject.companyId, actor.subject.userId, path) as { id: string } | undefined
      const size = Buffer.byteLength(applied.text, 'utf8')
      const fileId = row?.id ?? ulid()
      const now = Date.now()
      if (row) {
        deps.db
          .prepare('UPDATE workspace_files SET size = ?, storage_path = ?, updated_at = ? WHERE id = ?')
          .run(size, target, now, row.id)
      } else {
        deps.db
          .prepare(
            `INSERT INTO workspace_files (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, mime, storage_path, created_at, updated_at)
             VALUES (?, ?, 'user', ?, ?, ?, ?, ?, 'text/plain', ?, ?, ?)`,
          )
          .run(fileId, actor.subject.companyId, actor.subject.userId, actor.subject.userId, path, basename(path), size, target, now, now)
      }
      publishWorkspaceFilesChanged(actor.subject.companyId, actor.subject.userId, row ? 'updated' : 'created', [fileId])
      result = {
        fileId,
        path,
        size,
        changes: applied.changes,
        matchedEdits: applied.matchedEdits,
        edited: true,
        diff: buildWorkspaceEditDiff(edits),
      }
      break
    }

    case 'admin.password.reset': {
      const userId = String(args.userId ?? '')
      const password = String(args.password ?? '')
      if (password.length < 8) throw new EabError(EC.VALIDATION, '密码至少 8 位')
      const user = deps.db
        .prepare('SELECT id, name FROM users WHERE id = ? AND company_id = ? AND deleted_at IS NULL')
        .get(userId, actor.subject.companyId) as { id: string; name: string } | undefined
      if (!user) throw new EabError(EC.NOT_FOUND, '成员不存在')
      const now = Date.now()
      deps.db
        .prepare('UPDATE users SET password_hash = ?, password_set_at = ?, updated_at = ? WHERE id = ?')
        .run(hashPassword(password), now, now, user.id)
      result = { userId: user.id, name: user.name, reset: true }
      break
    }
    default:
      throw new EabError(EC.NOT_FOUND, `未实现的工具: ${tool.id}`)
  }
    if (webAudit) {
      auditWebTool(deps, actor, webAudit.toolId, webAudit.detail, 'success', startedAt, context)
    }
    if (operationId) completeToolOperation(deps.db, operationId, result)
    return result
  } catch (error) {
    toolStatus = 'failed'
    if (webAudit) {
      auditWebTool(deps, actor, webAudit.toolId, webAudit.detail, 'failure', startedAt, context, error)
    }
    if (operationId) failToolOperation(deps.db, operationId, error)
    throw error
  } finally {
    release?.()
    toolRelease?.()
    recordToolRun(tool.id, Date.now() - startedAt, toolStatus, lockWaitMs)
  }
}

function projectExecStatus(): {
  mode: ReturnType<typeof resolveProjectExecMode>
  backend: string | null
  backendDetail: string
  network: 'unrestricted' | 'denied'
  strictReady: boolean
  allowlistRules: number
  allowlistError: string | null
} {
  const mode = resolveProjectExecMode()
  let allowlistRules = 0
  let allowlistError: string | null = null
  try {
    allowlistRules = parseProjectCommandAllowlist(process.env.EAB_PROJECT_COMMAND_ALLOWLIST).length
  } catch (error) {
    allowlistError = (error as Error).message
  }
  if (mode !== 'strict') {
    return {
      mode,
      backend: null,
      backendDetail: mode === 'local' ? '本地执行：仅路径锁和危险命令黑名单，没有 OS 隔离' : '未启用项目命令执行',
      network: 'unrestricted',
      strictReady: true,
      allowlistRules,
      allowlistError,
    }
  }
  const capability = projectSandboxCapability()
  return {
    mode,
    backend: capability.backend,
    backendDetail: capability.detail,
    network: capability.backend ? 'denied' : 'unrestricted',
    strictReady: Boolean(capability.backend) && !allowlistError && allowlistRules > 0,
    allowlistRules,
    allowlistError,
  }
}

export function registerToolRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/tools', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.AGENT_TOOL_LIST)
    const roleAccess = readToolRoleAccessMap(deps.db, actor.subject.companyId)
    return ok({
      projectExec: projectExecStatus(),
      tools: [
        ...TOOLS.map((tool) => ({
          id: tool.id,
          name: tool.name,
          description: tool.description,
          dangerous: tool.dangerous,
          risk: toolRisk(tool),
          approval: toolApprovalPolicy(tool),
          available:
            actor.subject.scopes.has(tool.scope) &&
            toolAllowedForRoles(roleAccess.get(tool.id), actor.subject.roles ?? []),
          input: tool.input,
          source: 'builtin' as const,
        })),
        // 个人插件工具不进入平台通用工具目录；安装人只在个人工作台看到并调用自己的工具。
        ...pluginToolCatalogFor(deps.db, actor, { scope: 'company' }).map((tool) => ({
          id: tool.id,
          name: tool.name,
          description: tool.description,
          dangerous: false,
          available: tool.available,
          input: tool.input,
          source: 'plugin' as const,
          pluginId: tool.pluginId,
        })),
      ],
    })
  })

  app.post<{
    Params: { id: string }
    Body: { args?: Record<string, unknown>; approvalId?: string; sessionId?: string; idempotencyKey?: string }
  }>(
    '/api/tools/:id/invoke',
    async (req) => {
      const actor = resolveActor(deps.db, deps.config, req)
      requireEnabled(actor)
      const args = (req.body?.args ?? {}) as Record<string, unknown>

      // 插件工具：id 形如 plugin:<instanceKey>:<toolName>，权限与内置工具一致
      if (req.params.id.startsWith('plugin:')) {
        requireScope(actor.subject, SC.AGENT_TOOL_INVOKE)
        const pluginTool = resolvePluginToolByCatalogId(deps.db, actor, req.params.id)
        if (!pluginTool) {
          throw new EabError(EC.NOT_FOUND, `插件工具不存在或当前角色不可用: ${req.params.id}`)
        }
        const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : ''
        const result = await executePluginTool(
          pluginTool,
          args,
          {
            agent: { session: { id: sessionId } },
            session: { id: sessionId },
          },
          {
            maxConcurrent: deps.config.pluginToolMaxConcurrent ?? 4,
            timeoutMs: deps.config.pluginToolTimeoutMs ?? 60_000,
          },
        )
        audit(deps, req, `tool.invoke.plugin:${pluginTool.pluginId}:${pluginTool.name}`, {
          toolId: `plugin:${pluginTool.pluginId}:${pluginTool.name}`,
          args,
        })
        return ok({ toolId: req.params.id, result })
      }

      const tool = TOOLS.find((item) => item.id === req.params.id)
      if (!tool) throw new EabError(EC.NOT_FOUND, `工具不存在: ${req.params.id}`)
      if (!toolAllowedForActor(deps.db, actor, tool.id)) {
        throw new EabError(EC.FORBIDDEN, `当前角色不可使用工具「${tool.name}」`, {
          details: { toolId: tool.id, roles: actor.subject.roles ?? [] },
          hint: '请管理员在控制台「工具」页调整该工具的可用角色',
        })
      }
      requireScope(actor.subject, tool.scope)

      const result = await executeTool(deps, actor, tool.id, args, { kind: 'cloud' }, {
        idempotencyKey: typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : undefined,
        // 直接 API 不阻塞等审批：没有可用审批就生成待办并返回 202，
        // 管理员在控制台通过后，调用方带 approvalId 重试。
        approval: 'defer',
        approvalId: typeof req.body?.approvalId === 'string' ? req.body.approvalId : undefined,
      })
      audit(deps, req, `tool.invoke.${tool.id}`, { toolId: tool.id, args: tool.id === 'admin.password.reset' ? { userId: args.userId } : args })
      return ok({ toolId: tool.id, result })
    },
  )
}

export function listToolDefinitions(): readonly ToolDef[] {
  return TOOLS
}
