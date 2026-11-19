/**
 * 切片的“检索文本”和“向量文本”。
 *
 * 标题路径通常只存在 block/chunk 元数据里，正文不重复标题。关键词检索只扫
 * kb_chunks.text 时，用户问“三、申诉、执行与公示”这类制度条框会召回不到，
 * 向量也缺少章节语义。这里统一把 headingPath 拼到检索/向量输入前，既不改
 * 写库里的切片正文，也不影响后台预览和人工修正。
 */

function parseMeta(metaJson: string | null | undefined): Record<string, unknown> {
  if (!metaJson) return {}
  try {
    const value = JSON.parse(metaJson) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 从 chunk.meta_json 读取标题路径；损坏或缺失时返回空数组。 */
export function headingPathFromMeta(metaJson: string | null | undefined): string[] {
  const meta = parseMeta(metaJson)
  const value = meta.headingPath
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item ?? '').trim()).filter(Boolean)
}

/** 标题路径的展示行，例如「制度 > 三、申诉、执行与公示」。 */
export function headingLineFromMeta(metaJson: string | null | undefined): string {
  return headingPathFromMeta(metaJson).join(' > ')
}

/**
 * 关键词检索、重排序、回答上下文使用的文本：标题路径 + 正文。
 * 正文本身已包含同一标题时不再重复，避免首标题切片变成两份。
 */
export function chunkRetrievalText(metaJson: string | null | undefined, text: string): string {
  const body = String(text ?? '').trim()
  const heading = headingLineFromMeta(metaJson)
  if (!heading || !body) return body
  if (body.startsWith(heading) || body.includes(heading)) return body
  return `${heading}\n${body}`
}

/** 向量化输入与检索文本保持一致，让“章节标题”进入语义空间。 */
export function chunkEmbeddingText(metaJson: string | null | undefined, text: string): string {
  return chunkRetrievalText(metaJson, text)
}
