/**
 * 网页工作台 → 钉钉澄清卡片的单向同步登记表。
 *
 * 钉钉私聊里的一次 ask_user 会生成一张 A2UI 卡片；用户也可能在网页工作台
 * 的同一会话里作答。网页提交时通过这里登记的处理器把卡片切到“已作答”状态，
 * 避免钉钉那侧一直停在旧选项上。
 *
 * 这里只保存进程内回调，不保存卡片内容；服务重启后旧卡本身也失效，重新出题即可。
 */

type ClarifySyncHandler = (answer: string, step: number) => Promise<boolean>

interface ClarifySyncEntry {
  handler: ClarifySyncHandler
  updatedAt: number
}

const MAX_ENTRIES = 200
const ENTRY_TTL_MS = 12 * 60 * 60_000
const entries = new Map<string, ClarifySyncEntry>()

function prune(): void {
  const now = Date.now()
  for (const [sessionId, entry] of entries) {
    if (now - entry.updatedAt > ENTRY_TTL_MS) entries.delete(sessionId)
  }
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (!oldest) break
    entries.delete(oldest)
  }
}

/** 钉钉卡片收口并带澄清时登记；同一会话只保留最新一张卡。 */
export function registerDingTalkClarifySync(sessionId: string, handler: ClarifySyncHandler): void {
  const key = String(sessionId ?? '').trim()
  if (!key) return
  prune()
  entries.delete(key)
  entries.set(key, { handler, updatedAt: Date.now() })
}

/** 新的钉钉回复开始建卡时先清掉旧登记，避免后续网页作答去更新过期卡片。 */
export function clearDingTalkClarifySync(sessionId: string): void {
  const key = String(sessionId ?? '').trim()
  if (key) entries.delete(key)
}

/** 网页提交澄清答案时调用；没有登记过钉钉卡片则直接返回 false。 */
export async function notifyDingTalkClarifyFromWeb(
  sessionId: string,
  answer: string,
  step: number,
): Promise<boolean> {
  const key = String(sessionId ?? '').trim()
  if (!key) return false
  const entry = entries.get(key)
  if (!entry) return false
  if (Date.now() - entry.updatedAt > ENTRY_TTL_MS) {
    entries.delete(key)
    return false
  }
  try {
    const synced = await entry.handler(String(answer ?? '').trim(), Number(step) || 0)
    if (synced) console.info('[eab] 网页作答已同步钉钉澄清卡片：', key, `step=${step}`)
    return synced
  } catch (error) {
    console.warn('[eab] 网页作答同步钉钉卡片失败：', (error as Error).message)
    return false
  }
}
