/**
 * 知识库模型清洗：把解析后的块交给对话模型做“保事实去噪”，再按块标记还原。
 *
 * 约束：
 * - 只允许删噪声（页眉页脚、页码、重复空行、OCR 乱码），不得改数字、日期、金额、地址；
 * - 优先按【块n】标记还原；模型漏标记时按 JSON、空行段落、单块直返逐级降级；
 * - 还原后仍缺失的块保留规则清洗结果，不把整篇任务判失败；
 * - 长文档按字符预算分批，避免单次请求超出上下文。
 */
import { callModel, type ChatMessage } from './llm.js'
import type { Db } from '@eab/storage'
import type { KbBlock } from './kb-splitter.js'

const MAX_BATCH_CHARS = 6000
const MAX_BATCH_BLOCKS = 12
/** 一批里最多为几个漏标记的块单独补洗；再多了直接保留规则结果，避免长文档串行爆炸。 */
const MAX_SINGLE_RETRIES_PER_BATCH = 4
/**
 * 清洗基本是等长改写；按输入长度给输出预算，长文档给足输出空间，避免标记被截断。
 */
const MAX_OUTPUT_TOKENS = 8192
const MIN_OUTPUT_TOKENS = 768
export const MODEL_CLEAN_BATCH_TIMEOUT_MS = 120_000
export const MODEL_CLEAN_SINGLE_TIMEOUT_MS = 90_000
/** 同一文档最多并行几批；太大会把本地模型排队拖慢，3 批已能覆盖大多数长文档。 */
const MODEL_CLEAN_CONCURRENCY = 3

function outputBudget(sourceChars: number): number {
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, Math.ceil(sourceChars * 1.15)))
}

export interface ModelCleanResult {
  readonly blocks: KbBlock[]
  readonly modelId: string
  /** 有块没能从模型输出还原、沿用规则结果的条数。 */
  readonly keptOriginalCount: number
}

export interface ModelCleanProgress {
  readonly completedBatches: number
  readonly totalBatches: number
  readonly completedBlocks: number
  readonly totalBlocks: number
}

export interface ModelCleanOptions {
  /** 每完成一批回调一次；用于四步浮层显示“已清洗 3 / 5 批”。 */
  readonly onProgress?: (progress: ModelCleanProgress) => void
  /** 文档级清洗预算到点后中止仍在排队的模型请求，避免超时后继续占用 vLLM。 */
  readonly signal?: AbortSignal
}

function batchBlocks(blocks: KbBlock[]): Array<{ start: number; items: KbBlock[] }> {
  const batches: Array<{ start: number; items: KbBlock[] }> = []
  let start = 0
  let items: KbBlock[] = []
  let chars = 0
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    if (
      items.length > 0 &&
      (chars + block.text.length > MAX_BATCH_CHARS || items.length >= MAX_BATCH_BLOCKS)
    ) {
      batches.push({ start, items })
      start = i
      items = []
      chars = 0
    }
    items.push(block)
    chars += block.text.length
  }
  if (items.length > 0) batches.push({ start, items })
  return batches
}

function stripFence(text: string): string {
  return text
    .replace(/^\s*```[a-zA-Z]*\s*/, '')
    .replace(/\s*```\s*$/, '')
    .trim()
}

/** 模型常见的标记变体：全角【块1】、半角[块1]、`### 块1`、`【1】`。 */
function markerBodies(text: string): Map<number, string> {
  const found = new Map<number, string>()
  const patterns = [
    /【\s*块\s*(\d+)\s*】([\s\S]*?)(?=【\s*块\s*\d+\s*】|$)/g,
    /\[块\s*(\d+)\]([\s\S]*?)(?=\[块\s*\d+\]|$)/g,
    /(?:^|\n)\s*(?:#{1,6}\s*)?块\s*(\d+)\s*[:：]?\s*\n([\s\S]*?)(?=(?:^|\n)\s*(?:#{1,6}\s*)?块\s*\d+\s*[:：]?\s*\n|$)/g,
    /【\s*(\d+)\s*】([\s\S]*?)(?=【\s*\d+\s*】|$)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const index = Number(match[1])
      const body = (match[2] ?? '').trim()
      if (Number.isFinite(index) && body) found.set(index, body)
      else if (Number.isFinite(index)) found.set(index, '')
    }
    if (found.size > 0) break
  }
  return found
}

/** 模型有时会把每批重新编号成 1..n；能一一对应时映射回整篇的块序号。 */
function alignBatchIndices(found: Map<number, string>, count: number, start: number): Map<number, string> {
  if (found.size === 0) return found
  const expected = Array.from({ length: count }, (_, i) => start + i)
  if (expected.filter((index) => found.has(index)).length >= Math.ceil(count / 2)) return found
  if (found.size !== count) return found
  const bodies = [...found.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1])
  return new Map(bodies.map((body, i) => [start + i, body]))
}

function parseJsonBlocks(text: string, originals: KbBlock[], start: number): Map<number, string> | null {
  const normalized = stripFence(text)
  const candidate = normalized.match(/[\[{][\s\S]*[\]}]/)?.[0]
  if (!candidate) return null
  try {
    const parsed = JSON.parse(candidate) as unknown
    const items = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { blocks?: unknown }).blocks)
        ? ((parsed as { blocks: unknown[] }).blocks)
        : null
    if (!items) return null
    if (items.every((item) => typeof item === 'string') && items.length === originals.length) {
      return new Map(items.map((item, i) => [start + i, String(item).trim()]))
    }
    const found = new Map<number, string>()
    items.forEach((item, i) => {
      if (!item || typeof item !== 'object') return
      const record = item as { id?: unknown; index?: unknown; block?: unknown; text?: unknown }
      const rawIndex = record.index ?? record.block ?? (typeof record.id === 'string' ? record.id.replace(/\D+/g, '') : record.id)
      const index = Number(rawIndex)
      const body = typeof record.text === 'string' ? record.text.trim() : ''
      if (Number.isFinite(index)) found.set(index, body)
      else if (i < originals.length) found.set(start + i, body)
    })
    return alignBatchIndices(found, originals.length, start)
  } catch {
    return null
  }
}

function parseModelBlocks(text: string, originals: KbBlock[], start: number): Map<number, string> {
  const normalized = stripFence(text)
  if (originals.length === 1) {
    const marked = markerBodies(normalized)
    if (marked.has(start)) return new Map([[start, marked.get(start) ?? '']])
    return new Map([[start, normalized]])
  }
  const json = parseJsonBlocks(normalized, originals, start)
  if (json && json.size > 0) return json
  const marked = markerBodies(normalized)
  if (marked.size > 0) return alignBatchIndices(marked, originals.length, start)
  // 没有任何标记时，按空行段落猜分；段数正好等于块数才采用。
  const chunks = normalized.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)
  if (chunks.length === originals.length) {
    return new Map(chunks.map((item, i) => [start + i, item]))
  }
  throw new Error('模型清洗输出缺少块标记，已回退规则清洗')
}

/** 单块兜底：不要求标记，直接让模型只返回正文。 */
async function cleanSingleBlock(
  db: Db,
  dbPath: string,
  companyId: string,
  modelId: string,
  block: KbBlock,
  signal?: AbortSignal,
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是企业知识库的文档清洗器。只删除页码、页眉页脚、重复空行、扫描噪声和无意义符号；不得改写、总结或补充事实。保留所有数字、日期、金额、IP、地址、命令和专有名词。只输出清洗后的正文，不要解释。',
    },
    { role: 'user', content: block.text },
  ]
  const result = await callModel(
    db,
    dbPath,
    companyId,
    modelId,
    messages,
    outputBudget(block.text.length),
    { timeoutMs: MODEL_CLEAN_SINGLE_TIMEOUT_MS, disableThinking: true, signal },
  )
  const text = stripFence(result?.text || '')
  if (!text) throw new Error('模型清洗没有返回内容')
  return text
}

/** 按固定并发跑完所有批次，结果按原批次顺序返回，避免清洗后块顺序被打乱。 */
async function runBatchPool<T>(
  batches: readonly T[],
  worker: (batch: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(MODEL_CLEAN_CONCURRENCY, batches.length) }, async () => {
    while (next < batches.length) {
      const index = next
      next += 1
      await worker(batches[index]!, index)
    }
  })
  await Promise.all(runners)
}

export async function cleanBlocksWithModel(
  db: Db,
  dbPath: string,
  companyId: string,
  modelId: string,
  blocks: KbBlock[],
  options: ModelCleanOptions = {},
): Promise<ModelCleanResult> {
  if (blocks.length === 0) return { blocks, modelId, keptOriginalCount: 0 }
  const batches = batchBlocks(blocks)
  const batchResults = new Array<{ blocks: KbBlock[]; keptOriginalCount: number }>(batches.length)
  let completedBatches = 0
  let completedBlocks = 0
  const reportProgress = () => {
    completedBatches += 1
    try {
      options.onProgress?.({
        completedBatches,
        totalBatches: batches.length,
        completedBlocks,
        totalBlocks: blocks.length,
      })
    } catch {
      // 进度回调只服务 UI，不能影响清洗结果。
    }
  }

  await runBatchPool(batches, async (batch, batchIndex) => {
    let keptOriginalCount = 0
    try {
      const body = batch.items.map((block, i) => `【块${batch.start + i}】\n${block.text}`).join('\n\n')
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            '你是企业知识库的文档清洗器。只做去噪，不改写事实。保留所有数字、日期、金额、IP、地址、命令和专有名词；删除页码、页眉页脚、重复空行、扫描噪声、无意义符号。' +
            '输出格式必须逐块保留标记，示例：\n输入：\n【块1】\n第 1 页\n设备地址 192.168.1.1\n\n输出：\n【块1】\n设备地址 192.168.1.1\n' +
            '不要新增解释、前言、标题或代码块，不要合并块，不要省略任何【块n】。',
        },
        { role: 'user', content: body },
      ]
      const result = await callModel(
        db,
        dbPath,
        companyId,
        modelId,
        messages,
        outputBudget(body.length),
        { timeoutMs: MODEL_CLEAN_BATCH_TIMEOUT_MS, disableThinking: true, signal: options.signal },
      )
      if (!result || !result.text.trim()) throw new Error('模型清洗没有返回内容')
      let parsed: Map<number, string>
      try {
        parsed = parseModelBlocks(result.text, batch.items, batch.start)
      } catch (batchError) {
        // 很小的批次逐块兜底；批次稍大直接保留规则结果，避免一个漏标记拖出几十次串行请求。
        if (batch.items.length > 3) throw batchError
        parsed = new Map()
        for (let i = 0; i < batch.items.length; i += 1) {
          const block = batch.items[i]
          parsed.set(batch.start + i, await cleanSingleBlock(db, dbPath, companyId, modelId, block, options.signal))
        }
      }

      const out: KbBlock[] = []
      const missing: Array<{ index: number; block: KbBlock }> = []
      batch.items.forEach((block, i) => {
        const index = batch.start + i
        // 图片块正文来自视觉模型的 OCR/摘要，不允许二次改写或丢弃，否则 chunk 会丢掉图片回链。
        if (block.type === 'image') {
          out.push(block)
          return
        }
        if (!parsed.has(index)) {
          missing.push({ index, block })
          return
        }
        const text = (parsed.get(index) ?? '').trim()
        // 标记存在但正文为空，表示模型判定这个块全是噪声，应当整块丢弃。
        if (text) out.push({ ...block, text })
      })

      // 只给少量漏标记的块补洗；其余沿用规则清洗结果，保证长文档耗时有上限。
      for (const item of missing.slice(0, MAX_SINGLE_RETRIES_PER_BATCH)) {
        try {
          const text = await cleanSingleBlock(db, dbPath, companyId, modelId, item.block)
          out.push({ ...item.block, text })
        } catch {
          keptOriginalCount += 1
          out.push(item.block)
        }
      }
      for (const item of missing.slice(MAX_SINGLE_RETRIES_PER_BATCH)) {
        keptOriginalCount += 1
        out.push(item.block)
      }
      batchResults[batchIndex] = { blocks: out, keptOriginalCount }
    } catch {
      // 单批模型失败不判整篇失败：保留这一批的规则清洗文本，继续跑其它批次。
      batchResults[batchIndex] = {
        blocks: batch.items.map((block) => block),
        keptOriginalCount: batch.items.length,
      }
    } finally {
      completedBlocks += batch.items.length
      reportProgress()
    }
  })

  const cleaned: KbBlock[] = []
  let keptOriginalCount = 0
  for (const result of batchResults) {
    cleaned.push(...result.blocks)
    keptOriginalCount += result.keptOriginalCount
  }
  return { blocks: cleaned, modelId, keptOriginalCount }
}
