/**
 * 工具注册表（TOOL-01 ~ TOOL-06）。
 *
 * 注册的工具都有：id、中文名、说明、所需 scope、是否高危（需审批）、参数 JSON Schema。
 * 调用统一走 `POST /api/tools/:id/invoke`，先鉴权、再审批、再执行、再审计。
 * 不在本地执行任意脚本；工具白名单是代码常量，插件想加工具必须走插件清单。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import {
  beginToolOperation,
  completeToolOperation,
  failToolOperation,
  resolveToolOperationKey,
} from '../tool-idempotency.js'
import { retrieveExternalKb } from '../kb-external.js'
import { executePluginTool, pluginToolCatalogFor, pluginToolSpecsFor, resolvePluginToolForActor } from '../plugin-tools.js'
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
import { deleteUserWorkspaceFile, readUserWorkspaceFile, renameUserWorkspaceFile, userScopeDir } from './workspace.js'
import { createSchedule, deleteSchedule, listSchedules } from '../schedule.js'

export interface ToolDef {
  id: string
  name: string
  description: string
  scope: Scope
  dangerous: boolean
  input: Record<string, { type: string; description: string; required?: boolean }>
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
      '把一个复杂任务拆成多个互不依赖的子任务，并行交给多个子 Agent 执行。适合“同时查三份资料”“分别分析几个文件”“多模型各给一版方案”这类可以并行的任务。每个子 Agent 有独立运行记录和会话锁；一个子任务失败不会取消其他子任务。tasks 必须是 JSON 数组字符串，每项形如 {"title":"资料A","prompt":"完整子任务指令","modelId":"可选模型 id","retries":1}。不要让子任务互相依赖，不要用子 Agent 代替普通的一次工具调用。',
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
    description: '把一段文本写成个人工作区里的文件（同名覆盖）',
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
  'org.directory',
  'kb.search',
  'schedule.create',
  'workspace.list',
  'workspace.read',
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
  'workspace.list': '文件 列表 我的文件 云空间 workspace file list',
  'workspace.capacity': '容量 空间 剩余 配额 满了吗 capacity quota space',
  'workspace.write': '写文件 保存 新建文件 文本 write file save',
  'workspace.read': '读文件 查看文件 打开文件 内容 read file',
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
  const specs = toolSpecsForActor(db, actor, space)
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
  const specs = toolSpecsForActor(db, actor, space)
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
    pluginToolSpecsFor(db, actor).map((spec) => {
      const fn = spec.function as { name?: unknown } | undefined
      return String(fn?.name ?? '')
    }),
  )
  return specs.filter((spec) => allowedCore.has(spec.function.name) || pluginNames.has(spec.function.name))
}

/** 云空间是唯一可用的文件空间；none 不暴露文件工具。 */
function toolAllowedInSpace(toolId: string, space: ActiveSpace): boolean {
  if (toolId.startsWith('workspace.')) return space.kind === 'cloud'
  return true
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
export function toolSpecsForActor(db: Db, actor: Actor, space: ActiveSpace = { kind: 'cloud' }): ChatToolSpec[] {
  const builtin: ChatToolSpec[] = TOOLS.filter(
    (tool) =>
      !tool.dangerous &&
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
          Object.entries(tool.input).map(([key, value]) => [key, { type: value.type, description: value.description }]),
        ),
        required: Object.entries(tool.input)
          .filter(([, value]) => value.required)
          .map(([key]) => key),
        additionalProperties: false,
      },
    },
  }))
  const builtinNames = new Set(builtin.map((tool) => tool.function.name))
  const pluginSpecs = pluginToolSpecsFor(db, actor)
    .map((spec) => spec as unknown as ChatToolSpec)
    // 插件工具不能覆盖 EAB 内置工具的同名 function
    .filter((spec) => !builtinNames.has(spec.function.name))
  return [...builtin, ...pluginSpecs]
}

/** 执行一个工具。鉴权在本函数内再做一次，调用方仍需自己处理高危审批。 */
export async function executeTool(
  deps: ServerDeps,
  actor: Actor,
  toolId: string,
  args: Record<string, unknown>,
  space: ActiveSpace = { kind: 'cloud' },
  context: ToolExecutionContext = {},
): Promise<unknown> {
  const tool = TOOLS.find((item) => item.id === toolId)
  if (!tool) throw new EabError(EC.NOT_FOUND, `工具不存在: ${toolId}`)
  requireScope(actor.subject, tool.scope)
  if (!toolAllowedInSpace(tool.id, space)) {
    throw new EabError(EC.FORBIDDEN, `工具 ${tool.id} 不属于当前文件空间`)
  }

  const startedAt = Date.now()
  let toolRelease: (() => void) | null = null
  try {
    toolRelease = await toolSemaphore.acquire(tool.id, {
      limit: toolConcurrencyLimit(tool, deps),
      queueLimit: deps.config.toolQueueLimit ?? 200,
      timeoutMs: deps.config.toolTimeoutMs ?? 30_000,
      signal: context.signal,
    })
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
          .run(ulid(), actor.subject.companyId, actor.subject.userId, actor.subject.userId, path, basename(path), size, target, Date.now(), Date.now())
      }
      result = { path, size }
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
    return ok({
      tools: [
        ...TOOLS.map((tool) => ({
          id: tool.id,
          name: tool.name,
          description: tool.description,
          dangerous: tool.dangerous,
          available: actor.subject.scopes.has(tool.scope),
          input: tool.input,
          source: 'builtin' as const,
        })),
        ...pluginToolCatalogFor(deps.db, actor).map((tool) => ({
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

      // 插件工具：id 形如 plugin:<pluginId>:<toolName>，权限与内置工具一致
      if (req.params.id.startsWith('plugin:')) {
        requireScope(actor.subject, SC.AGENT_TOOL_INVOKE)
        const rest = req.params.id.slice('plugin:'.length)
        const colon = rest.indexOf(':')
        const pluginId = colon >= 0 ? rest.slice(0, colon) : ''
        const functionName = colon >= 0 ? rest.slice(colon + 1) : ''
        const pluginTool = pluginId ? resolvePluginToolForActor(deps.db, actor, functionName) : null
        if (!pluginTool || pluginTool.pluginId !== pluginId) {
          throw new EabError(EC.NOT_FOUND, `插件工具不存在或当前不可用: ${req.params.id}`)
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
        audit(deps, req, `tool.invoke.plugin:${pluginId}:${pluginTool.name}`, {
          toolId: `plugin:${pluginId}:${pluginTool.name}`,
          args,
        })
        return ok({ toolId: `plugin:${pluginId}:${pluginTool.name}`, result })
      }

      const tool = TOOLS.find((item) => item.id === req.params.id)
      if (!tool) throw new EabError(EC.NOT_FOUND, `工具不存在: ${req.params.id}`)
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
