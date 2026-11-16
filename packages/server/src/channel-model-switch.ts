import type { Db } from '@eab/storage'
import { EC, EabError } from '@eab/domain'
import {
  planChannelModelCommand,
  type ChannelModelOption,
} from './channel-model-command.js'
import type { ChatToolSpec } from './routes/tools.js'

/** 只允许渠道父 Agent 使用的会话模型切换工具；网页和子 Agent 不注入。 */
export const SWITCH_CHAT_MODEL_TOOL_NAME = 'switch_chat_model'

export const SWITCH_CHAT_MODEL_TOOL_SPEC: ChatToolSpec = {
  type: 'function',
  function: {
    name: SWITCH_CHAT_MODEL_TOOL_NAME,
    description:
      '切换当前钉钉/飞书会话使用的模型，或恢复自动选择、列出当前身份可用模型。用户说“换一个模型 / 切到某个模型 / 换另外一个模型 / 用自动选择 / 有哪些模型”时必须调用本工具，不要回答“没有切换模型的工具”。target 只能填当前身份可用模型清单里的名称或 ID；本工具只能操作当前会话，不能切换其他会话。切换成功后本条回复仍由原模型生成，从下一条消息开始生效，回复时必须如实说明这一点，不能声称本条回复已经由新模型生成。',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['switch', 'auto', 'list'],
          description: 'switch=切换到 target；auto=恢复自动选择；list=只列出当前模型和可用模型。不填时按 target 是否存在推断。',
        },
        target: {
          type: 'string',
          description: '要切换到的模型名称或 ID，必须来自当前身份可用模型清单；mode=switch 时必填。',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
}

export interface ModelSwitchContext {
  /** 当前身份可见的 chat 模型；已按角色和权限过滤。 */
  models: readonly ChannelModelOption[]
  /** 会话里保存的模型偏好；null 表示自动选择。 */
  currentModelId: string | null
  /** 本条回复实际使用的模型；仅用于说明“下一条生效”。 */
  activeModelId: string | null
  /** 写当前会话的 model_id；null 表示恢复自动选择。 */
  onChange: (modelId: string | null) => void | Promise<void>
}

export interface ModelSwitchToolResult {
  ok: boolean
  changed: boolean
  mode: 'switch' | 'auto' | 'list'
  modelId?: string | null
  modelName?: string
  message: string
}

function activeModelName(context: ModelSwitchContext): string {
  if (!context.activeModelId) return '当前模型'
  return context.models.find((model) => model.id === context.activeModelId)?.name || '当前模型'
}

function listMessage(context: ModelSwitchContext): string {
  const command = planChannelModelCommand('/model', context.models, context.currentModelId)
  const text = command?.kind === 'list'
    ? command.text
    : `当前身份没有可用的模型。`
  if (!context.currentModelId && context.activeModelId) {
    return `${text}\n当前实际使用：${activeModelName(context)}（自动选择中）`
  }
  return text
}

function switchSuccessMessage(context: ModelSwitchContext, modelName: string): string {
  return `已切换当前会话模型为「${modelName}」。这条回复仍由原模型「${activeModelName(context)}」生成；从下一条消息开始使用新模型。`
}

/**
 * 执行 Agent 的 switch_chat_model 调用。
 * 只使用调用方传入的可见模型，匹配不到/匹配多个时绝不写库，避免切换越权模型。
 */
export async function executeModelSwitchTool(
  context: ModelSwitchContext,
  rawArgs: Record<string, unknown> = {},
): Promise<ModelSwitchToolResult> {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
  const target = String(args.target ?? args.model ?? args.name ?? '').trim()
  const rawMode = String(args.mode ?? '').trim().toLowerCase()
  const mode: 'switch' | 'auto' | 'list' =
    rawMode === 'auto' || rawMode === 'list' || rawMode === 'switch'
      ? rawMode
      : target ? 'switch' : 'list'

  if (mode === 'list') {
    return {
      ok: true,
      changed: false,
      mode,
      modelId: context.currentModelId,
      message: listMessage(context),
    }
  }

  if (mode === 'auto') {
    if (context.currentModelId === null) {
      return {
        ok: true,
        changed: false,
        mode,
        modelId: null,
        message: `当前已经是自动选择，实际使用「${activeModelName(context)}」；下一条消息会继续按可用模型自动选择。`,
      }
    }
    await context.onChange(null)
    return {
      ok: true,
      changed: true,
      mode,
      modelId: null,
      message: `已恢复自动选择。这条回复仍由原模型「${activeModelName(context)}」生成；从下一条消息开始按可用模型自动选择。`,
    }
  }

  if (!target) {
    return {
      ok: false,
      changed: false,
      mode: 'list',
      modelId: context.currentModelId,
      message: `需要提供要切换到的模型名称或 ID。\n${listMessage(context)}`,
    }
  }

  // 复用渠道命令解析，保证 Agent 工具和 /model 命令使用同一套“唯一匹配才切换”的规则。
  const command = planChannelModelCommand(`切换到 ${target}`, context.models, context.currentModelId)
  if (command?.kind === 'auto') {
    if (context.currentModelId === null) {
      return {
        ok: true,
        changed: false,
        mode: 'auto',
        modelId: null,
        message: `当前已经是自动选择，实际使用「${activeModelName(context)}」；下一条消息会继续按可用模型自动选择。`,
      }
    }
    await context.onChange(null)
    return {
      ok: true,
      changed: true,
      mode: 'auto',
      modelId: null,
      message: `已恢复自动选择。这条回复仍由原模型「${activeModelName(context)}」生成；从下一条消息开始按可用模型自动选择。`,
    }
  }

  if (command?.kind === 'switch') {
    const selected = context.models.find((model) => model.id === command.modelId)
    const modelName = selected?.name || target
    if (context.currentModelId === command.modelId) {
      return {
        ok: true,
        changed: false,
        mode: 'switch',
        modelId: command.modelId,
        modelName,
        message: `当前会话已经在使用「${modelName}」，不需要重复切换；这条回复仍由「${activeModelName(context)}」生成。`,
      }
    }
    await context.onChange(command.modelId ?? null)
    return {
      ok: true,
      changed: true,
      mode: 'switch',
      modelId: command.modelId,
      modelName,
      message: switchSuccessMessage(context, modelName),
    }
  }

  if (command?.kind === 'ambiguous') {
    return {
      ok: false,
      changed: false,
      mode: 'switch',
      message: command.text,
    }
  }

  return {
    ok: false,
    changed: false,
    mode: 'switch',
    message: command?.kind === 'not-found'
      ? command.text
      : `没有找到你有权限使用的模型「${target}」。\n${listMessage(context)}`,
  }
}

/**
 * 写当前公司、当前用户的当前会话模型偏好。
 * 单条 UPDATE 即提交点；成功后下一次读取 chat_sessions.model_id 即可看到新值。
 * 会话不存在、已删除或不属于该用户时不写入，并返回 NOT_FOUND。
 */
export function updateConversationModelPreference(
  db: Db,
  input: {
    companyId: string
    userId: string
    sessionId: string
    modelId: string | null
  },
): void {
  const result = db
    .prepare(
      `UPDATE chat_sessions
          SET model_id = ?, updated_at = ?
        WHERE id = ? AND company_id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .run(input.modelId, Date.now(), input.sessionId, input.companyId, input.userId)
  if (Number(result.changes) !== 1) {
    throw new EabError(EC.NOT_FOUND, '当前会话不存在或已失效，无法切换模型')
  }
}
