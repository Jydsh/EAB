import { createHash } from 'node:crypto'
import { estimateTokens } from './context-window.js'

/**
 * 系统提示的固定六段。段顺序就是最终拼装顺序：
 * 身份边界 → 本轮任务 → 工具与数据 → 执行编排 → 记忆知识 → 输出约束。
 *
 * 这里只负责“装配与快照”，不负责决定每段写什么；业务规则仍由 buildSystemPrompt 生成。
 */
export type PromptSectionId =
  | 'identity'
  | 'task'
  | 'tools'
  | 'execution'
  | 'memory'
  | 'output'

export const PROMPT_SECTION_ORDER: readonly PromptSectionId[] = [
  'identity',
  'task',
  'tools',
  'execution',
  'memory',
  'output',
]

export interface PromptSection {
  id: PromptSectionId
  /** 段版本；段内规则发生实质修改时递增，便于回溯。 */
  version: string
  /** 估算 token 预算，超过只标记，不静默截断。 */
  budget: number
  /** 诊断用标题，不进入最终提示。 */
  title: string
  /** 段内块；空值会被丢弃。块之间用空行分隔。 */
  parts: readonly (string | false | null | undefined)[]
}

export interface PromptSectionSnapshot {
  id: PromptSectionId
  version: string
  title: string
  chars: number
  tokens: number
  budget: number
  overBudget: boolean
  blocks: number
  droppedDuplicates: number
}

export interface CompiledPrompt {
  /** 最终发给模型的完整系统提示。 */
  text: string
  /** 编译器版本，不是业务提示内容版本。 */
  compilerVersion: string
  /** 由最终文本计算的稳定指纹，用来判断“这次实际用了哪份提示”。 */
  promptVersion: string
  chars: number
  tokens: number
  sections: readonly PromptSectionSnapshot[]
  overBudgetSections: readonly PromptSectionId[]
  droppedDuplicates: number
}

export const PROMPT_COMPILER_VERSION = 'agt04-v1'

/** 每段的默认预算；集中放在这里，避免预算散落在拼接代码里。 */
export const PROMPT_SECTION_BUDGETS: Record<PromptSectionId, number> = {
  identity: 1200,
  task: 1200,
  tools: 7000,
  execution: 3200,
  memory: 3000,
  output: 600,
}

export const PROMPT_SECTION_TITLES: Record<PromptSectionId, string> = {
  identity: '身份与边界',
  task: '本轮任务与上下文',
  tools: '工具与数据规则',
  execution: '计划、执行与验收',
  memory: '记忆与知识库',
  output: '输出与禁止项',
}

const ORDER_INDEX = new Map(PROMPT_SECTION_ORDER.map((id, index) => [id, index]))

function normalizeBlock(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function blockKey(text: string): string {
  // 只折叠空白，不做语义合并；同一条规则写出两种措辞仍应人工发现，而不是被编译器“猜”成重复。
  return normalizeBlock(text).replace(/\s+/g, ' ').toLowerCase()
}

function promptFingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * 按固定六段装配提示。
 *
 * - 空段不输出，避免留下空标题；
 * - 完全相同的块只保留第一次出现，跨段也去重；
 * - 段顺序强制按 PROMPT_SECTION_ORDER，不依赖调用方数组顺序；
 * - 超预算不截断，只记录，防止悄悄丢规则。
 */
export function compilePromptSections(sections: readonly PromptSection[]): CompiledPrompt {
  const ordered = [...sections].sort(
    (a, b) => (ORDER_INDEX.get(a.id) ?? 99) - (ORDER_INDEX.get(b.id) ?? 99),
  )
  const seen = new Set<string>()
  let droppedDuplicates = 0
  const renderedSections: string[] = []
  const snapshots: PromptSectionSnapshot[] = []

  for (const section of ordered) {
    const kept: string[] = []
    let sectionDropped = 0
    for (const raw of section.parts) {
      if (!raw) continue
      const normalized = normalizeBlock(String(raw))
      if (!normalized) continue
      const key = blockKey(normalized)
      if (seen.has(key)) {
        sectionDropped += 1
        droppedDuplicates += 1
        continue
      }
      seen.add(key)
      kept.push(normalized)
    }
    if (kept.length === 0) continue
    const body = kept.join('\n\n')
    const tokens = estimateTokens(body)
    const budget = section.budget > 0 ? section.budget : PROMPT_SECTION_BUDGETS[section.id]
    renderedSections.push(body)
    snapshots.push({
      id: section.id,
      version: section.version,
      title: section.title,
      chars: body.length,
      tokens,
      budget,
      overBudget: tokens > budget,
      blocks: kept.length,
      droppedDuplicates: sectionDropped,
    })
  }

  const text = renderedSections.join('\n\n')
  return {
    text,
    compilerVersion: PROMPT_COMPILER_VERSION,
    promptVersion: promptFingerprint(text),
    chars: text.length,
    tokens: estimateTokens(text),
    sections: snapshots,
    overBudgetSections: snapshots.filter((section) => section.overBudget).map((section) => section.id),
    droppedDuplicates,
  }
}

/** 把编译结果压成适合写进 chat_messages.meta_json 的小对象。 */
export function promptSnapshotForMeta(compiled: CompiledPrompt): Record<string, unknown> {
  return {
    compilerVersion: compiled.compilerVersion,
    promptVersion: compiled.promptVersion,
    chars: compiled.chars,
    tokens: compiled.tokens,
    overBudget: compiled.overBudgetSections,
    droppedDuplicates: compiled.droppedDuplicates,
    sections: compiled.sections.map((section) => ({
      id: section.id,
      version: section.version,
      chars: section.chars,
      tokens: section.tokens,
      budget: section.budget,
      overBudget: section.overBudget,
      blocks: section.blocks,
    })),
  }
}
