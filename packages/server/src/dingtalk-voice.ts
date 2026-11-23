/**
 * 钉钉语音回复出口：个人音色 → TTS → OGG/Opus → 钉钉原生语音气泡。
 * 语音是文字回答之后的附加通道，任何失败都不能回滚已经发出的文字。
 */
import type { ServerDeps } from './deps.js'
import { callSpeech } from './llm.js'
import { resolveModelForPurpose } from './model-registry.js'
import { resolveVoiceProfile } from './voice-profile.js'
import { toDingTalkVoice } from './voice-audio.js'
import { voiceReplyTextOf } from './voice-text.js'
import { sendDingTalkVoiceToUser } from './dingtalk-outbound.js'

export interface DingTalkVoiceReplyResult {
  readonly sent: boolean
  readonly reason?: 'disabled' | 'no-tts' | 'empty-text'
  readonly mediaId?: string
  readonly durationMs?: number
}

export async function sendDingTalkVoiceReply(
  deps: ServerDeps,
  companyId: string,
  userId: string,
  text: string,
): Promise<DingTalkVoiceReplyResult> {
  const profile = resolveVoiceProfile(deps.db, companyId, userId)
  if (!profile.enabled) return { sent: false, reason: 'disabled' }
  const model = resolveModelForPurpose(deps.db, companyId, 'tts.default')
  if (!model) return { sent: false, reason: 'no-tts' }
  const speechText = voiceReplyTextOf(text)
  if (!speechText) return { sent: false, reason: 'empty-text' }

  const speech = await callSpeech(deps.db, deps.config.dbPath, companyId, model.id, speechText, {
    voice: profile.voice,
    instructions: profile.instructions,
    seed: profile.seed,
    format: 'mp3',
  })
  const voice = await toDingTalkVoice(Buffer.from(speech.audio), speech.mime)
  const sent = await sendDingTalkVoiceToUser(deps, {
    companyId,
    userId,
    buffer: voice.buffer,
    mime: voice.mime,
    durationMs: speech.durationMs || voice.durationMs,
    fileName: voice.fileName,
  })
  return { sent: true, mediaId: sent.mediaId, durationMs: sent.durationMs }
}
