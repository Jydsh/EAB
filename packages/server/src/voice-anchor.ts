/**
 * 个人音色锚点：用“声音描述”生成一次固定参考音频，之后每句都用它做 Voice Clone。
 *
 * 为什么需要：
 * Breeze-TTS-2 的 Voice Design 每次推理都会重新设计说话人，同一段描述、同一个 seed
 * 也只能让结果“接近”，不能保证跨请求同一个人。只把整段回答合成一次，只能保证段内一致；
 * 下一条回答仍会换人。把首次生成的音频连同精确文字稿保存下来，后续每句都发
 * ref_audio + ref_text，才能让所有回答共用同一个说话人。
 */
import { createHash, randomUUID } from 'node:crypto'
import { EC, EabError } from '@eab/domain'
import type { Db } from '@eab/storage'
import { callSpeech } from './llm.js'
import { DEFAULT_VOICE_INSTRUCTIONS, type VoiceProfile } from './voice-profile.js'

export const ANCHOR_TEXT = '你好，我是 EAB 企业智能助手。接下来，我会用这个声音为你播报。'
/** 系统默认音色的固定描述；与员工配置里的默认说明保持同一份文本。 */
export const DEFAULT_ANCHOR_INSTRUCTION = DEFAULT_VOICE_INSTRUCTIONS
const MAX_ANCHOR_BYTES = 6 * 1024 * 1024

export interface VoiceAnchor {
  readonly audio: Uint8Array
  readonly text: string
  readonly modelId: string
}

const inflight = new Map<string, Promise<VoiceAnchor>>()

function anchorKey(companyId: string, userId: string, voiceId: string, modelId: string, instructions: string): string {
  return [companyId, userId, voiceId, modelId, createHash('sha256').update(instructions).digest('hex').slice(0, 16)].join('|')
}

function decodeAnchor(audio: unknown, text: unknown, modelId: unknown, expectedModel: string): VoiceAnchor | null {
  const encoded = String(audio || '')
  const transcript = String(text || '').trim()
  if (!encoded || !transcript || String(modelId || '') !== expectedModel) return null
  try {
    const bytes = Buffer.from(encoded, 'base64')
    if (!bytes.byteLength || bytes.byteLength > MAX_ANCHOR_BYTES) return null
    return { audio: new Uint8Array(bytes), text: transcript, modelId: expectedModel }
  } catch {
    return null
  }
}

function readAnchor(
  db: Db,
  companyId: string,
  userId: string,
  profile: VoiceProfile,
  expectedModel: string,
): VoiceAnchor | null {
  if (profile.activeVoiceId !== 'default') {
    const row = db
      .prepare(
        `SELECT anchor_audio, anchor_text, anchor_model_id
           FROM user_voice_presets
          WHERE company_id = ? AND user_id = ? AND id = ?
          LIMIT 1`,
      )
      .get(companyId, userId, profile.activeVoiceId) as
      | { anchor_audio?: string | null; anchor_text?: string | null; anchor_model_id?: string | null }
      | undefined
    return decodeAnchor(row?.anchor_audio, row?.anchor_text, row?.anchor_model_id, expectedModel)
  }
  const row = db
    .prepare(
      `SELECT anchor_audio, anchor_text, anchor_model_id
         FROM user_voice_profiles
        WHERE company_id = ? AND user_id = ?
        LIMIT 1`,
    )
    .get(companyId, userId) as
    | { anchor_audio?: string | null; anchor_text?: string | null; anchor_model_id?: string | null }
    | undefined
  return decodeAnchor(row?.anchor_audio, row?.anchor_text, row?.anchor_model_id, expectedModel)
}

function saveAnchor(
  db: Db,
  companyId: string,
  userId: string,
  profile: VoiceProfile,
  modelId: string,
  anchor: VoiceAnchor,
): void {
  const encoded = Buffer.from(anchor.audio).toString('base64')
  const now = Date.now()
  if (profile.activeVoiceId !== 'default') {
    db.prepare(
      `UPDATE user_voice_presets
          SET anchor_audio = ?, anchor_text = ?, anchor_model_id = ?, anchor_updated_at = ?, updated_at = ?
        WHERE company_id = ? AND user_id = ? AND id = ?`,
    ).run(encoded, anchor.text, modelId, now, now, companyId, userId, profile.activeVoiceId)
    return
  }
  // 默认音色可能还没有 profile 行；先插一条默认配置，再写锚点。
  db.prepare(
    `INSERT INTO user_voice_profiles
       (company_id, user_id, voice, instructions, enabled, active_voice_id, updated_at,
        anchor_audio, anchor_text, anchor_model_id, anchor_updated_at)
     VALUES (?, ?, 'S0', '', 1, 'default', ?, ?, ?, ?, ?)
     ON CONFLICT(company_id, user_id) DO UPDATE SET
       anchor_audio = excluded.anchor_audio,
       anchor_text = excluded.anchor_text,
       anchor_model_id = excluded.anchor_model_id,
       anchor_updated_at = excluded.anchor_updated_at`,
  ).run(companyId, userId, now, encoded, anchor.text, modelId, now)
}

/**
 * 读取或惰性生成当前音色的锚点。首次调用会真正合成一次参考音频，约几秒；
 * 后续请求直接读库/内存缓存，不再重新设计说话人。
 */
export async function ensureVoiceAnchor(
  db: Db,
  dbPath: string,
  companyId: string,
  userId: string,
  modelId: string,
  profile: VoiceProfile,
): Promise<VoiceAnchor> {
  const instructions = String(profile.instructions || '').trim() || DEFAULT_ANCHOR_INSTRUCTION
  const version = `${modelId}|${createHash('sha256').update(instructions).digest('hex').slice(0, 16)}`
  const cacheKey = anchorKey(companyId, userId, profile.activeVoiceId, modelId, instructions)
  const cached = readAnchor(db, companyId, userId, profile, version)
  if (cached) return cached
  const running = inflight.get(cacheKey)
  if (running) return running
  const task = (async () => {
    const result = await callSpeech(db, dbPath, companyId, modelId, ANCHOR_TEXT, {
      voice: profile.voice,
      instructions,
      seed: profile.seed,
      format: 'wav',
    })
    if (!result.audio.byteLength) throw new EabError(EC.VALIDATION, '生成个人音色锚点失败：音频为空')
    const anchor: VoiceAnchor = {
      audio: new Uint8Array(result.audio),
      text: ANCHOR_TEXT,
      modelId: version,
    }
    saveAnchor(db, companyId, userId, profile, version, anchor)
    return anchor
  })().finally(() => {
    inflight.delete(cacheKey)
  })
  inflight.set(cacheKey, task)
  return task
}

/** 供管理脚本/测试使用：生成一个不落库的临时锚点。 */
export async function synthesizeVoiceAnchor(
  db: Db,
  dbPath: string,
  companyId: string,
  modelId: string,
  instructions: string,
  seed: number,
): Promise<VoiceAnchor> {
  const result = await callSpeech(db, dbPath, companyId, modelId, ANCHOR_TEXT, {
    instructions,
    seed,
    format: 'wav',
  })
  if (!result.audio.byteLength) throw new EabError(EC.VALIDATION, '生成个人音色锚点失败：音频为空')
  return {
    audio: new Uint8Array(result.audio),
    text: ANCHOR_TEXT,
    modelId: `${modelId}|${randomUUID().slice(0, 8)}`,
  }
}
