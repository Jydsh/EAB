/**
 * 把最终回答整理成适合朗读的纯文本。
 * 目标不是改写语义，只去掉会破坏朗读节奏的 Markdown、代码、表格和链接地址。
 */
export function speakableReply(text: unknown, max = 600): string {
  let value = String(text ?? '')
  // 代码块和表格不朗读，保留一句可理解的占位；否则 TTS 会读出大量符号。
  value = value.replace(/```[\s\S]*?```/g, '（代码已省略）')
  value = value.replace(/^\s*\|.*\|\s*$/gm, '')
  value = value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  value = value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  value = value.replace(/<[^>]+>/g, '')
  value = value.replace(/`([^`]+)`/g, '$1')
  value = value.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  value = value.replace(/^\s{0,3}>\s?/gm, '')
  value = value.replace(/^\s*[-*+]\s+/gm, '')
  value = value.replace(/^\s*\d+[.)、]\s+/gm, '')
  value = value.replace(/[*_~]/g, '')
  value = value.replace(/\s*\n\s*/g, '。')
  value = value.replace(/。{2,}/g, '。')
  value = value.replace(/[ \t]+/g, ' ')
  value = value.trim().replace(/^。+|。+$/g, '')
  if (value.length <= max) return value
  const head = value.slice(0, max)
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('；'))
  return `${cut >= max * 0.6 ? head.slice(0, cut + 1) : head}。`
}

/** 钉钉语音转码前统一按可朗读文本截断，避免生成几十分钟的音频。 */
export function voiceReplyTextOf(text: unknown): string {
  return speakableReply(text, 600)
}
