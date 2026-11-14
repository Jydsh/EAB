/**
 * 意图判定（用途路由 `router.intent` 的运行时实现）。
 *
 * 设计口径：
 * - **只在控制台显式绑定 `router.intent` 时启用**。`resolveModelForPurpose` 在未绑定时会按能力
 *   自动回退，而 chat 模型基本都满足判定条件——若也启用，会让每轮对话白多一次模型调用。
 * - 判定失败 / 超时 / 输出不合规，一律返回 `null`，调用方按"没判定"处理，不影响回答。
 * - 判定结果只作为"提示"注入系统提示词，不改用户已选的对话模型，也不静默换模型。
 */
import type { Db } from '@eab/storage'
import { callModel, type CallResult } from './llm.js'
import { explainModelRoute, type ModelCapabilityRecord } from './model-registry.js'

export const CHAT_INTENTS = ['org', 'kb', 'chat'] as const
export type ChatIntent = (typeof CHAT_INTENTS)[number]

export interface ChatIntentResult {
  readonly intent: ChatIntent
  /** 0–1；关键词兜底时固定 0.4 */
  readonly confidence: number
  readonly modelId: string
  /** model = 判定模型给出；keyword = 输出无法解析时的关键词兜底 */
  readonly basis: 'model' | 'keyword'
}

/** 判定用的最小提示词：只要一行 JSON，减少小模型跑偏。 */
const INTENT_PROMPT = [
  '你是企业助手的意图路由器。只输出一行 JSON，不要解释，不要 Markdown 代码块。',
  '格式：{"intent":"org|kb|chat","confidence":0.0}',
  '规则：',
  '- org：问人、部门、上下级、通讯录、谁负责，例如「我们组长是谁」「研发部有哪些人」',
  '- kb：问公司制度、流程、规定、报销、请假、年假、政策、手册，例如「年假怎么算」',
  '- chat：普通问答、写作、计算、代码、闲聊，或无法判断',
  '无法判断时用 chat，confidence 取 0.3 到 0.5。',
].join('\n')

export type IntentCall = (model: ModelCapabilityRecord, text: string) => Promise<CallResult | null>

const ORG_PATTERN = /组长|上级|领导|部门|通讯录|谁负责|负责人|找谁|组织架构|同事|工号|汇报给|下属/
const KB_PATTERN = /制度|规定|流程|报销|请假|年假|调休|政策|手册|规范|标准|怎么申请|审批|条款/

export function normalizeIntent(value: unknown): ChatIntent | null {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return null
  if ((CHAT_INTENTS as readonly string[]).includes(raw)) return raw as ChatIntent
  // 兼容中文标签与近义写法
  if (/org|组织|人员|通讯录|部门/.test(raw)) return 'org'
  if (/kb|知识|制度|资料|政策/.test(raw)) return 'kb'
  if (/chat|闲聊|普通|问答/.test(raw)) return 'chat'
  return null
}

/** 从模型输出里抽出 `{"intent":...,"confidence":...}`；允许前后有杂字。 */
function parseModelIntent(text: string): { intent: ChatIntent; confidence: number } | null {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const payload = JSON.parse(text.slice(start, end + 1)) as { intent?: unknown; confidence?: unknown }
    const intent = normalizeIntent(payload.intent)
    if (!intent) return null
    const confidence = Number(payload.confidence)
    return { intent, confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.6 }
  } catch {
    return null
  }
}

/** 关键词兜底：模型输出不可解析时仍给出可用判定，只是置信度更低。 */
export function keywordIntent(text: string): ChatIntent {
  const value = text.trim()
  if (!value) return 'chat'
  if (ORG_PATTERN.test(value)) return 'org'
  if (KB_PATTERN.test(value)) return 'kb'
  return 'chat'
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`意图判定超时（${timeoutMs}ms）`)), timeoutMs)
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * 判定一条用户消息的意图。
 * 返回 `null` 表示"这轮不判定"：未显式绑定、模型调用失败、超时、或输出无法解析且关键词也无法给出确定结论。
 */
export async function classifyChatIntent(
  db: Db,
  dbPath: string,
  companyId: string,
  text: string,
  options: { call?: IntentCall; timeoutMs?: number } = {},
): Promise<ChatIntentResult | null> {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.length > 4_000) return null

  const route = explainModelRoute(db, companyId, 'router.intent')
  // 只有显式绑定才算"已配置"；自动回退不启用，避免每轮多一次调用。
  if (route.source !== 'route' || !route.model) return null
  const model = route.model

  const call: IntentCall =
    options.call ??
    ((target, input) =>
      callModel(
        db,
        dbPath,
        companyId,
        target.id,
        [
          { role: 'system', content: INTENT_PROMPT },
          { role: 'user', content: input.slice(0, 1_200) },
        ],
        32,
      ))

  let result: CallResult | null = null
  try {
    result = await withTimeout(call(model, trimmed), options.timeoutMs ?? 8_000)
  } catch (error) {
    console.warn('[intent] 判定降级，按未判定处理：', error instanceof Error ? error.message : String(error))
    return null
  }
  if (!result || !result.text) return null

  const parsed = parseModelIntent(result.text)
  if (parsed) {
    return { intent: parsed.intent, confidence: parsed.confidence, modelId: model.id, basis: 'model' }
  }
  return { intent: keywordIntent(trimmed), confidence: 0.4, modelId: model.id, basis: 'keyword' }
}

/** 把判定结果转成系统提示的一行；未判定返回空串。 */
export function intentHintOf(result: ChatIntentResult | null): string {
  if (!result) return ''
  switch (result.intent) {
    case 'org':
      return '用户在问人员或组织关系，优先调用 org_directory 取真实部门、上级与成员信息，不要凭印象作答。'
    case 'kb':
      return '用户在问制度或资料，优先依据下面的知识库片段；片段不足时再调用知识库检索补齐，不要编造条款。'
    default:
      return ''
  }
}
