/**
 * 图片 OCR：把图片作为多模态消息交给视觉模型，返回纯文本。
 *
 * 不在服务端做本地 OCR 推理：EAB 的 OCR 能力跟着模型路由走，
 * 没配 kb.ocr 或模型不支持图片时由调用方降级为 needs_config。
 */
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { callModel, type ChatMessage } from './llm.js'
import type { Db } from '@eab/storage'
import type { KbBlock } from './kb-splitter.js'
import type { KbParseResult } from './kb-parsers.js'

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

export interface ImageUnderstanding {
  /** 一句话说明图片是什么（图表/截图/流程图/照片），用于没有文字的图片也能被检索。 */
  readonly caption: string
  /** 图中可见文字，保留表格行列、编号、数字、日期、金额和地址。 */
  readonly text: string
}

function parseUnderstanding(raw: string): ImageUnderstanding {
  const normalized = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
  const json = normalized.match(/\{[\s\S]*\}/)?.[0]
  if (json) {
    try {
      const parsed = JSON.parse(json) as { caption?: unknown; text?: unknown; ocr?: unknown }
      const caption = typeof parsed.caption === 'string' ? parsed.caption.trim() : ''
      const text = typeof parsed.text === 'string'
        ? parsed.text.trim()
        : typeof parsed.ocr === 'string'
          ? parsed.ocr.trim()
          : ''
      if (caption || text) return { caption, text }
    } catch {
      // 继续按文本标记解析
    }
  }
  const captionMatch = /(?:摘要|说明|图片描述|caption)\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:文字|OCR|正文|text)\s*[:：]|$)/i.exec(normalized)
  const textMatch = /(?:文字|OCR|正文|text)\s*[:：]\s*([\s\S]*)$/i.exec(normalized)
  if (captionMatch || textMatch) {
    return {
      caption: (captionMatch?.[1] ?? '').trim().slice(0, 300),
      text: (textMatch?.[1] ?? '').trim(),
    }
  }
  return { caption: '', text: normalized }
}

/**
 * 图片理解：一次模型调用同时产出“图片说明”和“图中文字”。
 * 纯 OCR 对流程图、架构图、无字截图没有召回价值，因此说明和文字都进切片。
 */
export async function understandImageWithModel(
  db: Db,
  dbPath: string,
  companyId: string,
  modelId: string,
  buffer: Buffer,
  filename: string,
): Promise<ImageUnderstanding> {
  const mime = MIME_BY_EXT[extname(filename).toLowerCase()] || 'image/png'
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是企业知识库的图片理解引擎。请同时完成两件事：1）用一句不超过 80 字的中文说明图片是什么（截图/流程图/架构图/表格/照片/示意图），概括主体和关键对象；2）转录图中全部可见文字，保留表格行列、编号、数字、日期、金额、地址和命令。不要推测图中没有的内容。' +
        '只输出 JSON，不要解释：{"caption":"一句话说明","text":"图中全部文字，没有文字则为空字符串"}',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: `请理解图片 ${filename}，按 JSON 返回 caption 与 text。` },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ]
  const result = await callModel(db, dbPath, companyId, modelId, messages, 4096, {
    timeoutMs: 120_000,
  })
  const raw = (result?.text || '').trim()
  if (!raw) throw new Error('图片理解模型没有返回内容')
  return parseUnderstanding(raw)
}

export async function ocrImageWithModel(
  db: Db,
  dbPath: string,
  companyId: string,
  modelId: string,
  buffer: Buffer,
  filename: string,
): Promise<KbParseResult> {
  const mime = MIME_BY_EXT[extname(filename).toLowerCase()] || 'image/png'
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是企业知识库的 OCR 引擎。只转录图片中的可见文字，保留表格行列、编号、数字、日期、金额和地址；不要描述图片、不要总结、不要补充图中没有的内容。没有文字时只输出空字符串。',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: '请转录这张图片里的全部文字。' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ]
  const result = await callModel(db, dbPath, companyId, modelId, messages, 4096, {
    timeoutMs: 120_000,
  })
  const text = (result?.text || '').trim()
  if (!text) throw new Error('OCR 模型没有返回文字')
  const block: KbBlock = {
    id: randomUUID(),
    text,
    type: 'paragraph',
    headingPath: [],
    meta: { ocr: true, filename },
  }
  return {
    blocks: [block],
    text,
    meta: { parser: 'ocr', filename, modelId },
    pageCount: 1,
  }
}
