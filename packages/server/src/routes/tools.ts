/**
 * 工具注册表（TOOL-01 ~ TOOL-06）。
 *
 * 注册的工具都有：id、中文名、说明、所需 scope、是否高危（需审批）、参数 JSON Schema。
 * 调用统一走 `POST /api/tools/:id/invoke`，先鉴权、再审批、再执行、再审计。
 * 不在本地执行任意脚本；工具白名单是代码常量，插件想加工具必须走插件清单。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { EC, EabError, SC, ulid, type Scope } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import { assertScoped, buildScopeFilter, predicateToSql } from '@eab/authz'
import type { Db } from '@eab/storage'
import type { ToolParameterSchema } from '../llm.js'
import { safeJoin } from '@eab/workspace'
import type { ServerDeps } from '../deps.js'
import { ok, requireScope } from '../http.js'
import { resolveActor, type RequestActor } from '../session.js'
import { hashPassword } from '../password.js'
import { KeyedMutex, KeyedSemaphore, LockAbortedError, LockTimeoutError, SemaphoreQueueFullError, SemaphoreTimeoutError } from '../concurrency.js'
import { acquireCoordinationSlot, coordinationStatus, readCapacityCount } from '../backends/coordination.js'
import { beginToolInflight } from '../tool-inflight.js'
import {
  beginToolOperation,
  completeToolOperation,
  failToolOperation,
  resolveToolOperationKey,
} from '../tool-idempotency.js'
import { retrieveExternalKb } from '../kb-external.js'
import { executePluginTool, pluginToolCatalogFor, pluginToolSpecsFor, prefersPersonalPluginTools, resolvePluginToolByCatalogId } from '../plugin-tools.js'
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
import { sendDingTalkFileToUser } from '../dingtalk-outbound.js'
import { sendDingTalkFileToConversation, uploadFileToUserDrive } from '../dingtalk-drive.js'
import {
  createRobotUserFileSend,
  markRobotUserFileSendFailed,
  markRobotUserFileSendSent,
} from '../dingtalk-file-echo.js'
import {
  applyWorkspaceTextEdits,
  deleteUserWorkspaceFile,
  isTextEditableFile,
  readUserWorkspaceFile,
  renameUserWorkspaceFile,
  editUserWorkspaceFile,
  userScopeDir,
  type WorkspaceTextEdit,
} from './workspace.js'
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
  /** 调用方显式提供的幂等键，优先于 turnId */
  idempotencyKey?: string
  /**
   * 右侧预览/编辑中的文件。模型漏传 fileId、path 时用它兜底，
   * 避免「明明开着文件还要反问是哪个文件」。
   */
  activeFile?: { id: string; relPath?: string }
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

export const TOOLS: readonly ToolDef[] = [
  {
    id: 'tool.search',
    name: '搜索工具目录',
    description:
      '搜索当前员工可用的工具目录。当前对话只加载了常用工具；当需要文件发送/重命名/删除、容量查询、定时任务管理、计算或插件能力等未直接列出的能力时，先调用本工具。query 用用户原话或中文/英文能力词（例如“发送文件到钉钉”“查看我的定时任务”“计算 (1200+300)/4”“plugin”）；返回匹配工具的名称、用途和参数，下一轮会自动加载这些工具，之后即可直接调用。不要因为工具列表里暂时没有就直接说做不到。',
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
    id: 'agent.spawn',
    name: '并行子 Agent',
    description:
      '把一个复杂任务拆成多个互不依赖的子任务，并行交给多个子 Agent 执行。适合“同时查三份资料”“分别分析几个文件”“多模型各给一版方案”这类可以并行的任务。每个子 Agent 有独立运行记录和会话锁；一个子任务失败不会取消其他子任务。tasks 必须是 JSON 数组字符串，每项形如 {"key":"research-a","title":"资料A","prompt":"完整子任务指令","modelId":"可选模型 id","retries":1}。key 是团队内的稳定标识（建议英文短名），后续可用 agent_task 凭 key 继续给它派活，复用同一个子 Agent 窗口与会话；子 Agent 完成一次任务后若没有新任务，会在空闲一段时间后自动注销，需要再工作时重新 agent_spawn。不要让子任务互相依赖，不要用子 Agent 代替普通的一次工具调用。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'read',
    input: {
      tasks: {
        type: 'string',
        description: 'JSON 数组字符串；每项必须包含 prompt，可选 title、modelId、retries',
        required: true,
      },
    },
  },
  {
    id: 'agent.task',
    name: '继续派活给子 Agent',
    description:
      '给团队里已经存在的子 Agent 继续派一个新任务，复用同一个子 Agent 会话与同一个可视窗口，不需要重新创建。仅在本轮已经用 agent_spawn 创建过子 Agent 后可用；agent 必须填 agent.spawn 返回或此前事件里给出的 key。子 Agent 完成任务后如果没有再派新任务，会在空闲一段时间后自动注销，那时必须重新 agent_spawn。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'read',
    input: {
      agent: { type: 'string', description: '目标子 Agent 的团队 key', required: true },
      prompt: { type: 'string', description: '这次要它做的完整任务指令', required: true },
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
      context: { type: 'string', description: '可选：为什么需要这个信息、你已经做到哪一步' },
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
    name: '四则运算',
    description: '计算 + - * / 与括号，不支持函数与变量',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    input: { expression: { type: 'string', description: '例如 (1200+300)/4', required: true } },
  },
  {
    id: 'org.directory',
    name: '组织通讯录（对话式）',
    description:
      '不要求用户先输入姓名。按对话意图查组织：intent=leader 查“我的组长/我的上级/我所在部门”；intent=me 查“我是谁/我在哪个部门”；intent=departments 查“公司有哪些部门/组织架构”；intent=members 查某个部门有谁（需要查看成员权限）；intent=search 按姓名/岗位关键字查人（需要查看成员权限）。返回部门、岗位、组长，不返回手机号。',
    scope: SC.CHAT_USE,
    dangerous: false,
    input: {
      intent: {
        type: 'string',
        description: 'leader | me | departments | members | search，按用户问题选择',
        required: true,
      },
      query: { type: 'string', description: 'intent=members 时填部门名；intent=search 时填姓名/岗位关键字' },
    },
  },
  {
    id: 'org.search',
    name: '通讯录搜索',
    description: '按姓名/工号/岗位搜索本公司在职成员，返回部门与岗位，不返回手机号',
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
    name: '提交团队学习',
    description:
      '成员在对话里明确说“以后都这样/让团队也按这个规则/把这条经验分享给大家/记住这个规范”时，把可复用的规则提炼成一条不超过 1000 字的团队记忆候选，提交给管理员审核。审核通过后会自动进入全公司所有成员的对话上下文，实现跨成员学习扩散。只提交提炼后的规则，不要提交原始聊天、密码、手机号、身份证号、客户隐私或一次性任务内容。',
    scope: SC.MEMORY_WRITE,
    dangerous: false,
    input: {
      content: {
        type: 'string',
        description: '提炼后的可复用规则或经验，一句话到一小段，最多 1000 字',
        required: true,
      },
    },
  },
  {
    id: 'workspace.list',
    name: '列出我的文件',
    description: '列出个人工作区里未删除的文件',
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
    id: 'workspace.write',
    name: '写入工作区文件',
    description:
      '把一段文本写成个人工作区里的文件（同名覆盖）。如果文件已存在且只需要改其中某几段、某几个字段，优先调用 workspace.edit，不要整篇重写；只有新建文件或确实要整篇替换时才用本工具。成功后只说明文件名和结果，不要重复粘贴文件正文，界面会展示文件内容预览。',
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
      '只修改文件中指定的片段，不整篇覆盖。适用场景：方案只需更新其中一段、表格只需改几个字段、说明文档只替换某一节。先用 workspace.read 读取原文，把要改的原文精确复制到 find，把新内容放到 replace；一次可传多个 edits，按顺序执行，任何一条找不到原文都会整体失败且不写盘。支持 txt/md/csv/json/代码等文本文件。Word .docx、Excel .xlsx/.xlsm、PowerPoint .pptx 请改用 office.find 定位、office.replace 局部替换；不要用 workspace.edit 改 Office 文件。成功后只说明文件名和改动条数，不要重复粘贴文件正文。',
    scope: SC.WORKSPACE_WRITE,
    dangerous: false,
    concurrency: 'write',
    lockKey: (deps, actor, args) => workspaceFileLockKey(deps, actor, args),
    input: {
      path: { type: 'string', description: '相对路径，例如 docs/方案.md', required: true },
      edits: {
        type: 'array',
        description: '局部替换列表；每项 find 必须与原文完全一致，replace 为新内容',
        required: true,
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            find: { type: 'string', description: '要替换的原文片段（区分大小写和空白）' },
            replace: { type: 'string', description: '替换后的新内容，可为空字符串表示删除' },
            occurrence: {
              type: 'integer',
              description: '可选：只替换第几个匹配（从 1 开始）；不传则替换全部匹配',
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
    description: '读取云空间里一个文本文件的正文（最大 5 MB）',
    scope: SC.WORKSPACE_READ,
    dangerous: false,
    input: {
      path: { type: 'string', description: '相对路径，例如 notes/todo.md', required: true },
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
      '读取 docx 指定范围的完整文本、run 级格式摘要和表格结构，不截断、不改文件。elementId 支持 pN 段落、tN 整张表、tN-rN 表格行、tN-cN 表格列、tN-rN-cN 表格单元格；start/end 是目标段落或单元格完整文本内的字符偏移，只对 pN 和 tN-rN-cN 有效。返回 text、start/end、totalLength、runs（每段文本的 bold/italic/underline/color/fontSize/fontFamily/style）和表格行列数据。xlsx/pptx 暂未覆盖，会明确报错。只读，不打开 OnlyOffice。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    input: {
      fileId: { type: 'string', description: '云空间文件 id；和 path 二选一' },
      path: { type: 'string', description: '云空间相对路径；和 fileId 二选一' },
      elementId: { type: 'string', description: 'docx 的 pN、tN、tN-rN、tN-cN 或 tN-rN-cN', required: true },
      start: { type: 'number', description: '目标段落/单元格完整文本内的起始字符偏移，默认 0' },
      end: { type: 'number', description: '目标段落/单元格完整文本内的结束字符偏移，默认文本长度' },
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
      '只替换 docx 指定段落/表格单元格、xlsx/xlsm 指定单元格中的文本，或 pptx 指定幻灯片段落中的文本，不整篇/整表重写，其他内容、样式和结构保持不变。先用 office.find 拿到 docx 的 pN / tN-rN-cN、xlsx 的 sN-rN-cN 或 pptx 的 sN-pM，再把原文精确放到 oldText；省略 oldText 表示替换该元素可见文本。xlsx 空单元格可直接用 sN-rN-cN 写入整格；数字单元格可改成数字或文本；公式单元格只能改成以 = 开头的新公式，不能静默改成静态值。已有缺失行会按行号插入，保持工作表行顺序。pptx 段落跨多个文本 run 时，新文本沿用第一个 run 的格式，其余 run 清空；不支持段落内换行。命中多处时必须指定 occurrence（1 起，0 仅 xlsx 支持）。写入后会自动保存并记录 workspace.file.agent_edit 审计。支持 docx、xlsx、xlsm、pptx。',
    scope: SC.AGENT_TOOL_INVOKE,
    dangerous: false,
    concurrency: 'write',
    lockKey: (deps, actor, args) => workspaceFileLockKey(deps, actor, args),
    input: {
      elementId: { type: 'string', description: 'office.read_outline / office.find 返回的 pN、tN-rN-cN（docx）、sN-rN-cN（xlsx）或 sN-pM（pptx）；xlsx 空单元格也可直接按该格式指定', required: true },
      fileId: { type: 'string', description: '云空间文件 id；和 path 二选一' },
      path: { type: 'string', description: '云空间相对路径；和 fileId 二选一' },
      oldText: { type: 'string', description: '要替换的原文；省略时替换该元素整段可见文本' },
      newText: { type: 'string', description: '替换后的新文本；空字符串表示删除', required: true },
      occurrence: { type: 'number', description: '第几次命中，1 起；0 表示全部（仅 xlsx）；默认 1' },
      trackChanges: { type: 'boolean', description: 'docx 专用：true 时把旧文本写入 w:del、新文本写入 w:ins，保留修订标记；目标已有修订时先接受或拒绝' },
      author: { type: 'string', description: 'docx 修订作者，默认 EAB Agent' },
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
    id: 'workspace.send_dingtalk',
    name: '发送云空间文件到钉钉',
    description:
      '把个人云空间里的文件作为钉钉文件消息发给当前用户。用户说“把文件发给我/发到钉钉/把这个文件发我”时调用；先用 workspace.list 找到文件名或相对路径，再传 path，或直接传 workspace.list 返回的 fileId。钉钉单聊里会用用户方向的原生文件消息发送（右侧气泡、带预览/未查收/下载/编辑），机器人识别回声后不重复保存；网页会话退回机器人文件消息。只支持当前员工的个人云空间文件，单个文件不超过 20 MB。',
    scope: SC.WORKSPACE_READ,
    dangerous: false,
    concurrency: 'write',
    lockKey: (deps, actor, args) => workspaceFileLockKey(deps, actor, args),
    idempotent: true,
    input: {
      fileId: { type: 'string', description: 'workspace.list 返回的文件 id；和 path 二选一' },
      path: { type: 'string', description: '文件相对路径或文件名，例如 suale.txt；和 fileId 二选一' },
    },
  },
  {
    id: 'workspace.rename',
    name: '重命名云空间文件',
    description:
      '修改个人云空间里一个文件的名字。用户说“重命名/改名/把文件名改成…”时调用；先用 workspace.list 找到文件，再传 fileId 或 path，并提供 newName。只改文件名，不移动文件。',
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
      '删除个人云空间里的一个文件。用户明确说“删掉/删除/清理某个文件”时调用；先用 workspace.list 找到 fileId 或 path。只能删自己的文件；删除是软删，文件会移到回收目录，列表里不再显示，但保留可审计。不要用它删除目录或非个人云空间文件。',
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
 * 其余工具（文件发送/改名/删除、容量、定时任务列表、计算、插件等）通过 tool_search 按需加载。
 * 这样工具数量继续增长时，首轮请求不会线性膨胀。
 */
export const AGENT_CORE_TOOL_IDS: readonly string[] = [
  'tool.search',
  'time.now',
  'agent.spawn',
  'agent.task',
  'agent.ask_parent',
  'org.directory',
  'kb.search',
  'schedule.create',
  'workspace.list',
  'workspace.read',
  'workspace.edit',
  'office.read_outline',
  'office.read_range',
  'office.find',
  'office.revisions',
  'office.replace',
  'office.insert',
  'office.format',
  'office.comment',
  'memory.propose',
]

export interface ToolSearchHit {
  toolId: string
  functionName: string
  name: string
  description: string
  source: 'builtin' | 'plugin'
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
  'schedule.create': '提醒 定时 日程 每天 每周 几点 定时任务 remind schedule timer',
  'schedule.list': '查看定时任务 我的任务 提醒列表 任务状态 schedule list',
  'schedule.delete': '取消定时任务 删除提醒 停止任务 cancel schedule delete',
  'math.eval': '计算 算一下 四则运算 加减乘除 数学 math calculate calculator',
  'org.directory': '通讯录 组织架构 部门 组长 上级 同事 成员 查找人 org directory',
  'org.search': '找人 搜索成员 姓名 工号 岗位 search member',
  'kb.search': '知识库 文档 资料 检索 搜索 制度 流程 kb rag search',
  'memory.propose': '团队学习 共享记忆 记住 规范 以后都这样 扩散 经验 沉淀 team memory learn share',
  'workspace.list': '文件 列表 我的文件 云空间 workspace file list',
  'workspace.capacity': '容量 空间 剩余 配额 满了吗 capacity quota space',
  'workspace.write': '写文件 保存 新建文件 文本 整篇 write file save',
  'workspace.edit': '局部修改 局部编辑 只改一段 改字段 替换片段 修订 patch edit replace',
  'workspace.read': '读文件 查看文件 打开文件 内容 read file',
  'office.read_outline': '读取文档结构 文档大纲 段落 表格 单元格 工作表 幻灯片 docx xlsx Excel pptx PowerPoint Office 文档结构 read outline document structure paragraph table sheet slide',
  'office.read_range': '读取文档范围 读全文 读段落全文 读表格 读单元格 读整行 读整列 文本区间 格式摘要 range read full text paragraph table cell row column runs font format docx',
  'office.find': '文档查找 在文档中找 定位文本 查找段落 查找单元格 查找幻灯片 xlsx pptx Excel PowerPoint find document search cell slide',
  'office.revisions': '读取修订 查看修订 修订记录 插入删除 作者 接受修订 拒绝修订 开启修订 关闭修订 track changes revision accept reject w:ins w:del docx',
  'office.replace': '替换文档文本 改段落 改单元格 修改word 修改Excel 修改PPT xlsx xlsm pptx replace office text update cell formula slide paragraph',
  'office.insert': '插入段落 新增段落 插入整行 插入整列 删除整行 删除整列 合并单元格 拆分单元格 删除表格行 删除表格列 xlsx Excel insert delete merge split paragraph row column office',
  'office.format': '设置格式 加粗 斜体 下划线 字体颜色 高亮 填充 数字格式 字号 format bold italic underline color highlight fill numberFormat number format font size xlsx',
  'office.comment': '加批注 批注 评论 单元格批注 工作表批注 Excel批注 回复批注 解决批注 删除批注 批注列表 短语批注 comment annotation note list reply resolve delete xlsx Excel cell comment',
  'workspace.send_dingtalk': '发送文件 发文件 发给我 钉钉 send file dingtalk attachment',
  'workspace.rename': '重命名 改名 文件名 rename file',
  'workspace.delete': '删除文件 删掉 清理文件 delete file remove',
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
    const name = def?.name ?? spec.function.name
    const description = def?.description ?? spec.function.description
    const id = def?.id ?? spec.function.name
    const alias = TOOL_SEARCH_ALIASES[id] ?? ''
    const haystack = `${spec.function.name} ${id} ${name} ${description} ${alias}`.toLowerCase()
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
      source: def ? 'builtin' : 'plugin',
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

/** Agent 首轮只提交核心工具 + tool_search，其余按需加载。 */
export function toolSpecsForAgent(
  db: Db,
  actor: Actor,
  space: ActiveSpace = { kind: 'cloud' },
  query = '',
): ChatToolSpec[] {
  const coreNames = new Set(AGENT_CORE_TOOL_IDS.map(toolFunctionName))
  const specs = toolSpecsForActor(db, actor, space, query)
  /**
   * 通讯录是核心工具，但只在问题确实在问人/部门/上下级时下发。
   * 业务数据问题（录入了几条检查整治、台账、统计）里常出现“东环线/工区/站点”
   * 这类组织名称，模型容易把它当成通讯录查询；按完整问题判断意图后隐藏它，
   * 能避免截图里“检查整治 → 组织通讯录”的误选。
   */
  const cleanQuery = String(query || '').trim()
  const businessIntent =
    /(检查|整治|台账|记录|录入|统计|数量|几条|多少条|明细|报表|工单|数据|接口|明细|汇总|填报)/.test(
      cleanQuery,
    )
  const wantsOrg =
    !cleanQuery ||
    (!businessIntent &&
      /(通讯录|组织架构|组织关系|部门|科室|班组|小组|组长|副组长|负责人|上级|下级|领导|同事|成员|人名|姓名|工号|岗位|职务|找谁|谁是|有谁|哪些人|人员名单|联系方式|人数|多少人|几个人|几人)/.test(
        cleanQuery,
      ))
  const allowedCore = new Set([...coreNames].filter((name) => wantsOrg || name !== 'org_directory'))
  /**
   * 插件工具不能只依赖 tool_search：插件通常是业务数据入口，模型按
   * “查工区/班次/某个组织的数据”搜索时，工具名和描述未必命中业务词。
   * 因此把当前员工已启用插件的工具直接随首轮工具下发；内置工具仍按需加载。
   */
  const pluginNames = new Set(
    pluginToolSpecsFor(db, actor, { preferPersonal: prefersPersonalPluginTools(query) }).map((spec) => {
      const fn = spec.function as { name?: unknown } | undefined
      return String(fn?.name ?? '')
    }),
  )
  return specs.filter((spec) => allowedCore.has(spec.function.name) || pluginNames.has(spec.function.name))
}

/** 云空间是唯一可用的文件空间；none 不暴露文件工具。 */
function toolAllowedInSpace(toolId: string, space: ActiveSpace): boolean {
  if (toolId.startsWith('workspace.') || toolId.startsWith('office.')) return space.kind === 'cloud'
  return true
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
  return [...builtin, ...pluginSpecs]
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

  let toolStatus: 'ok' | 'failed' = 'ok'
  try {
    let result: unknown
    const now = new Date()
    switch (tool.id) {
    case 'agent.spawn':
      throw new EabError(EC.VALIDATION, 'agent.spawn 只能由对话 Agent 调度器执行')
    case 'agent.task':
      throw new EabError(EC.VALIDATION, 'agent.task 只能由对话 Agent 调度器执行')
    case 'tool.search':
      result = searchToolCatalog(deps.db, actor, space, String(args.query ?? ''), args.limit === undefined ? 8 : Number(args.limit))
      break
    case 'time.now':
      result = { iso: now.toISOString(), local: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }
      break
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
      const expression = String(args.expression ?? '')
      result = { expression, value: evaluate(expression) }
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
        })),
        externalCount: external.length,
      }
      break
    }
    case 'workspace.list': {
      const rows = deps.db
        .prepare('SELECT id, name, rel_path, size, updated_at FROM workspace_files WHERE company_id = ? AND owner_user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')
        .all(actor.subject.companyId, actor.subject.userId)
      result = { files: rows }
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
      let content: Buffer
      try {
        content = readFileSync(target)
      } catch {
        throw new EabError(EC.NOT_FOUND, `云空间文件不存在: ${path}`)
      }
      if (content.byteLength > 5 * 1024 * 1024) {
        throw new EabError(EC.VALIDATION, '文件超过 5 MB，请下载后查看')
      }
      result = { path, size: content.byteLength, text: content.toString('utf8'), truncated: false }
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
    case 'workspace.send_dingtalk': {
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
            hint: '先调用 workspace.list 查看文件名和相对路径，再用 path 或 fileId 发送。',
          })
        }
        targetId = row.id
      }
      const file = readUserWorkspaceFile(deps, actor, targetId)
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
    case 'memory.propose': {
      const content = String(args.content ?? '').trim()
      if (!content) throw new EabError(EC.VALIDATION, '团队学习内容不能为空')
      if (content.length > 1000) throw new EabError(EC.VALIDATION, '单条团队学习最多 1000 字')
      const duplicate = deps.db
        .prepare(
          `SELECT id, confirmed FROM memories
            WHERE company_id = ? AND scope_type = 'company' AND scope_id = ? AND deleted_at IS NULL AND content = ?
            LIMIT 1`,
        )
        .get(actor.subject.companyId, actor.subject.companyId, content) as { id: string; confirmed: number } | undefined
      if (duplicate) {
        result = {
          id: duplicate.id,
          scopeType: 'company',
          confirmed: duplicate.confirmed === 1,
          status: duplicate.confirmed === 1 ? 'active' : 'pending',
          duplicate: true,
          note: duplicate.confirmed === 1 ? '这条团队记忆已经生效' : '这条团队学习已经在待审核队列里，无需重复提交',
        }
        break
      }
      const id = `mem_${ulid()}`
      const now = Date.now()
      deps.db
        .prepare(
          `INSERT INTO memories (id, company_id, scope_type, scope_id, user_id, content, confirmed, created_at)
           VALUES (?, ?, 'company', ?, ?, ?, 0, ?)`,
        )
        .run(id, actor.subject.companyId, actor.subject.companyId, actor.person.id, content, now)
      appendAudit(deps.db, {
        companyId: actor.subject.companyId,
        actorUserId: actor.person.id,
        action: 'memory.propose',
        resourceType: 'memory',
        resourceId: id,
        result: 'success',
        detail: { scopeType: 'company', length: content.length },
        ip: null,
        channel: 'web',
      })
      result = {
        id,
        scopeType: 'company',
        confirmed: false,
        status: 'pending',
        note: '已提交团队学习候选，待管理员审核通过后对全公司所有智能体生效',
      }
      break
    }
    case 'workspace.write': {
      const path = String(args.path ?? '')
      const text = String(args.text ?? '')
      if (!path) throw new EabError(EC.VALIDATION, 'path 不能为空')
      const root = userScopeDir(deps, actor.subject.companyId, actor.subject.userId)
      const target = safeJoin(root, path)
      if (!target) throw new EabError(EC.VALIDATION, '非法路径')
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, text, 'utf8')
      const row = deps.db
        .prepare(
          `SELECT id FROM workspace_files WHERE company_id = ? AND scope_type = 'user' AND scope_id = ? AND rel_path = ? AND deleted_at IS NULL`,
        )
        .get(actor.subject.companyId, actor.subject.userId, path) as { id: string } | undefined
      const size = Buffer.byteLength(text, 'utf8')
      const fileId = row?.id ?? ulid()
      if (row) {
        deps.db
          .prepare('UPDATE workspace_files SET size = ?, storage_path = ?, updated_at = ? WHERE id = ?')
          .run(size, target, Date.now(), row.id)
      } else {
        deps.db
          .prepare(
            `INSERT INTO workspace_files (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, mime, storage_path, created_at, updated_at)
             VALUES (?, ?, 'user', ?, ?, ?, ?, ?, 'text/plain', ?, ?, ?)`,
          )
          .run(fileId, actor.subject.companyId, actor.subject.userId, actor.subject.userId, path, basename(path), size, target, Date.now(), Date.now())
      }
      result = { fileId, path, size, created: !row }
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
      if (row) {
        deps.db
          .prepare('UPDATE workspace_files SET size = ?, storage_path = ?, updated_at = ? WHERE id = ?')
          .run(size, target, Date.now(), row.id)
      } else {
        deps.db
          .prepare(
            `INSERT INTO workspace_files (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, mime, storage_path, created_at, updated_at)
             VALUES (?, ?, 'user', ?, ?, ?, ?, ?, 'text/plain', ?, ?, ?)`,
          )
          .run(fileId, actor.subject.companyId, actor.subject.userId, actor.subject.userId, path, basename(path), size, target, Date.now(), Date.now())
      }
      result = {
        fileId,
        path,
        size,
        changes: applied.changes,
        matchedEdits: applied.matchedEdits,
        edited: true,
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
    if (operationId) completeToolOperation(deps.db, operationId, result)
    return result
  } catch (error) {
    toolStatus = 'failed'
    if (operationId) failToolOperation(deps.db, operationId, error)
    throw error
  } finally {
    release?.()
    toolRelease?.()
    recordToolRun(tool.id, Date.now() - startedAt, toolStatus, lockWaitMs)
  }
}

export function registerToolRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/tools', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireEnabled(actor)
    requireScope(actor.subject, SC.AGENT_TOOL_LIST)
    const roleAccess = readToolRoleAccessMap(deps.db, actor.subject.companyId)
    return ok({
      tools: [
        ...TOOLS.map((tool) => ({
          id: tool.id,
          name: tool.name,
          description: tool.description,
          dangerous: tool.dangerous,
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

      if (tool.dangerous) {
        const approvalId = req.body?.approvalId
        const approval = approvalId
          ? (deps.db
              .prepare('SELECT * FROM approvals WHERE id = ? AND company_id = ? AND requester_user_id = ? AND action = ?')
              .get(approvalId, actor.subject.companyId, actor.subject.userId, `tool:${tool.id}`) as
              | { id: string; status: string; expires_at: number | null }
              | undefined)
          : undefined
        if (!approval || approval.status !== 'approved' || (approval.expires_at && approval.expires_at < Date.now())) {
          const now = Date.now()
          const resourceId = String(args.userId ?? '')
          // 先把已经过期的 pending 标成 expired，避免它继续占着唯一索引。
          deps.db
            .prepare(
              `UPDATE approvals
                  SET status = 'expired', decided_by = 'system:expired', decided_at = ?
                WHERE company_id = ? AND requester_user_id = ? AND action = ? AND resource_id = ?
                  AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
            )
            .run(now, actor.subject.companyId, actor.subject.userId, `tool:${tool.id}`, resourceId, now)
          const existing = deps.db
            .prepare(
              `SELECT id FROM approvals WHERE company_id = ? AND requester_user_id = ? AND action = ? AND status = 'pending'
                 AND resource_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1`,
            )
            .get(actor.subject.companyId, actor.subject.userId, `tool:${tool.id}`, resourceId, now) as
            | { id: string }
            | undefined
          let id = existing?.id
          if (!id) {
            const candidate = ulid()
            try {
              deps.db
                .prepare(
                  `INSERT INTO approvals (id, company_id, requester_user_id, action, resource_type, resource_id, payload_json, status, created_at, expires_at)
                   VALUES (?, ?, ?, ?, 'user', ?, ?, 'pending', ?, ?)`,
                )
                .run(
                  candidate,
                  actor.subject.companyId,
                  actor.subject.userId,
                  `tool:${tool.id}`,
                  resourceId,
                  JSON.stringify({ tool: tool.id, args: { userId: args.userId } }),
                  now,
                  now + 30 * 60 * 1000,
                )
              id = candidate
            } catch (error) {
              // 唯一索引冲突说明另一个并发请求刚插入了同一条待办，读回它的 id。
              const raced = deps.db
                .prepare(
                  `SELECT id FROM approvals WHERE company_id = ? AND requester_user_id = ? AND action = ? AND status = 'pending'
                     AND resource_id = ? ORDER BY created_at DESC LIMIT 1`,
                )
                .get(actor.subject.companyId, actor.subject.userId, `tool:${tool.id}`, resourceId) as
                | { id: string }
                | undefined
              if (!raced) throw error
              id = raced.id
            }
          }
          throw new EabError(EC.APPROVAL_REQUIRED, `「${tool.name}」需要审批，已生成待办`, {
            details: { approvalId: id, toolId: tool.id },
            hint: '让拥有审批权限的管理员在控制台「审批」页通过后，再带 approvalId 调用一次',
          })
        }
      }

      const result = await executeTool(deps, actor, tool.id, args, { kind: 'cloud' }, {
        idempotencyKey: typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : undefined,
      })
      audit(deps, req, `tool.invoke.${tool.id}`, { toolId: tool.id, args: tool.id === 'admin.password.reset' ? { userId: args.userId } : args })
      return ok({ toolId: tool.id, result })
    },
  )
}

export function listToolDefinitions(): readonly ToolDef[] {
  return TOOLS
}
