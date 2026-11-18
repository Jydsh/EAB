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

/**
 * 自动知识库检索的触发词。
 *
 * 比意图判定的 KB_PATTERN 更宽，但刻意排除“申请 / 合同 / 采购 / 培训”这类
 * 会横跨业务数据和日常写作的裸词：只有和制度/流程/模板等组合时才检索，
 * 避免用户问业务记录、让你写邮件时也把无关制度片段塞进上下文。
 */
const KB_QUERY_PATTERN = /知识库|资料库|文档库|内部资料|公司资料|企业资料|制度|规定|流程|规则|政策|手册|规范|标准|办法|细则|条例|指南|报销|差旅|出差|请假|年假|调休|考勤|加班|薪资|工资|绩效|福利|社保|公积金|入职|离职|转正|采购流程|采购制度|合同审批|合同模板|用印|盖章|审批流程|审批权限|权限申请|账号申请|IT支持|运维规范/i

/** 用户正在让你创作/改写内容（不是查询制度），避免把“写年假邮件”误当成知识库问答。 */
const AUTHORING_TASK_PATTERN = /^(?:请|麻烦)?\s*(?:帮我|给我)?\s*(?:写|起草|生成|制作|整理|做|设计|改|修改|翻译|总结|润色|列个|列出)/i
/** 即使是创作任务，用户明确点名制度/流程/条款时仍需要知识库依据。 */
const EXPLICIT_POLICY_PATTERN = /制度|规定|流程|规则|政策|标准|条款|手册|规范|办法|细则|条例|指南|知识库|内部资料|公司资料/i
/** 在查个人业务记录/单据/余额，不是查制度；没有明确制度词时不应注入知识库。 */
const BUSINESS_RECORD_PATTERN = /记录|单据|订单|台账|明细|报表|统计|进度|状态|余额|剩余|列表|数据|报销单|请假单|考勤表|工资条|我的(?:报销|请假|考勤|工资|年假|调休|加班)/i

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

/**
 * 本轮是否需要自动检索知识库。
 *
 * 目的不是替代 kb_search，而是避免每轮都把 TopK 片段塞进系统提示：
 * - 明确问制度/流程/资料、或意图模型判定 kb 时检索；
 * - 纯闲聊、写作、业务数据、人员问题时跳过，模型仍可按需调用 kb_search；
 * - 用户让你写/做东西但没有点名制度依据时跳过，避免无关片段污染创作任务。
 */
export function shouldAutoRetrieveKb(
  text: string,
  intent: ChatIntentResult | null = null,
): boolean {
  const value = String(text || '').trim()
  if (!value) return false
  // 高置信度的 kb 判定优先，即使问题以“写/整理”开头，也可能确实要先查制度。
  if (intent?.intent === 'kb' && intent.confidence >= 0.7) return true
  if (AUTHORING_TASK_PATTERN.test(value) && !EXPLICIT_POLICY_PATTERN.test(value)) return false
  if (BUSINESS_RECORD_PATTERN.test(value) && !EXPLICIT_POLICY_PATTERN.test(value)) return false
  if (KB_QUERY_PATTERN.test(value)) return true
  return intent?.intent === 'kb'
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
      return '用户在问制度或资料。只使用与当前问题直接相关的知识库片段；片段不足时再调用 kb_search 补齐，不要把无关片段、通用常识或工具返回混进制度回答。'
    default:
      return ''
  }
}
