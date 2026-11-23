/**
 * 员工个人语音配置。
 *
 * 产品口径（2026-11-23，第二版）：
 * - 内置音色只保留一个系统默认，不再暴露 S0–S9 让员工挑选；
 * - 员工可以保存多段“专属声音描述”，并选择其中一段作为默认回复音色；
 * - seed 由公司 + 员工稳定派生，不落库；Breeze-TTS-2 的 Voice Design 每次都会重新设计
 *   说话人，因此跨请求一致性由 voice-anchor 的参考音频克隆保证，单次合成不再承担该职责；
 * - 网页和钉钉共用同一份配置，不做渠道分叉；
 * - 不采集本人录音，也不做声纹克隆。
 */
import { createHash, randomUUID } from 'node:crypto'
import { EC, EabError } from '@eab/domain'
import type { Db } from '@eab/storage'

export const DEFAULT_VOICE = 'S0'
export const DEFAULT_VOICE_ID = 'default'
export const DEFAULT_VOICE_NAME = '系统默认'
export const DEFAULT_VOICE_ENABLED = true
export const MAX_VOICE_NAME = 40
export const MAX_VOICE_INSTRUCTIONS = 200

export interface VoiceProfile {
  readonly voice: string
  readonly activeVoiceId: string
  readonly instructions: string
  readonly enabled: boolean
  /** 只参与 TTS 请求，不落库，也不返回给前端。 */
  readonly seed: number
}

export interface VoiceProfilePatch {
  readonly enabled?: boolean
  readonly activeVoiceId?: string
}

export interface VoicePreset {
  readonly id: string
  readonly name: string
  readonly instructions: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface VoicePresetInput {
  readonly name?: string
  readonly instructions?: string
}

interface VoiceProfileRow {
  active_voice_id?: string | null
  enabled?: number | null
}

interface VoicePresetRow {
  id: string
  name: string
  instructions: string
  created_at: number
  updated_at: number
}

function cleanInstructions(value: unknown): string {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, MAX_VOICE_INSTRUCTIONS)
}

function requireInstructions(value: unknown): string {
  const instructions = cleanInstructions(value)
  if (!instructions) throw new EabError(EC.VALIDATION, '请填写声音描述')
  return instructions
}

function cleanName(value: unknown): string {
  return String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_VOICE_NAME)
}

/** 每个员工一个稳定种子；换公司、换账号都会得到不同音色。 */
export function voiceSeedOf(companyId: string, userId: string): number {
  const digest = createHash('sha256').update(`${companyId}:${userId}`).digest()
  const seed = digest.readUInt32BE(0) & 0x7fffffff
  return seed || 1
}

function rowToPreset(row: VoicePresetRow): VoicePreset {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export function listVoicePresets(db: Db, companyId: string, userId: string): VoicePreset[] {
  const rows = db
    .prepare(
      `SELECT id, name, instructions, created_at, updated_at
         FROM user_voice_presets
        WHERE company_id = ? AND user_id = ?
        ORDER BY updated_at DESC, created_at DESC`,
    )
    .all(companyId, userId) as unknown as VoicePresetRow[]
  return rows.map(rowToPreset)
}

function getVoicePreset(db: Db, companyId: string, userId: string, id: string): VoicePreset | null {
  if (!id || id === DEFAULT_VOICE_ID) return null
  const row = db
    .prepare(
      `SELECT id, name, instructions, created_at, updated_at
         FROM user_voice_presets
        WHERE company_id = ? AND user_id = ? AND id = ?
        LIMIT 1`,
    )
    .get(companyId, userId, id) as VoicePresetRow | undefined
  return row ? rowToPreset(row) : null
}

function uniqueName(
  db: Db,
  companyId: string,
  userId: string,
  requested: string,
  excludeId?: string,
): string {
  const base = requested || '我的声音'
  for (let index = 1; index <= 50; index += 1) {
    const suffix = index === 1 ? '' : ` ${index}`
    const candidate = `${base.slice(0, MAX_VOICE_NAME - suffix.length)}${suffix}`
    const exists = db
      .prepare(
        `SELECT 1 FROM user_voice_presets
          WHERE company_id = ? AND user_id = ? AND lower(name) = lower(?)
            AND id <> ?
          LIMIT 1`,
      )
      .get(companyId, userId, candidate, excludeId ?? '') as unknown
    if (!exists) return candidate
  }
  return `${base.slice(0, MAX_VOICE_NAME - 5)} ${randomUUID().slice(0, 4)}`
}

/** 只读当前员工配置；没有记录时返回系统默认，不自动插行。 */
export function resolveVoiceProfile(db: Db, companyId: string, userId: string): VoiceProfile {
  const row = db
    .prepare(
      `SELECT active_voice_id, enabled
         FROM user_voice_profiles
        WHERE company_id = ? AND user_id = ?
        LIMIT 1`,
    )
    .get(companyId, userId) as VoiceProfileRow | undefined
  const activeVoiceId = String(row?.active_voice_id || DEFAULT_VOICE_ID)
  const preset = getVoicePreset(db, companyId, userId, activeVoiceId)
  return {
    voice: DEFAULT_VOICE,
    activeVoiceId: preset ? activeVoiceId : DEFAULT_VOICE_ID,
    instructions: preset?.instructions ?? '',
    enabled: row?.enabled == null ? DEFAULT_VOICE_ENABLED : Number(row.enabled) !== 0,
    seed: voiceSeedOf(companyId, userId),
  }
}

function writeProfile(
  db: Db,
  companyId: string,
  userId: string,
  input: { activeVoiceId: string; enabled: boolean },
): void {
  db.prepare(
    `INSERT INTO user_voice_profiles (company_id, user_id, voice, instructions, enabled, active_voice_id, updated_at)
     VALUES (?, ?, ?, '', ?, ?, ?)
     ON CONFLICT(company_id, user_id) DO UPDATE SET
       voice = excluded.voice,
       instructions = '',
       enabled = excluded.enabled,
       active_voice_id = excluded.active_voice_id,
       updated_at = excluded.updated_at`,
  ).run(
    companyId,
    userId,
    DEFAULT_VOICE,
    input.enabled ? 1 : 0,
    input.activeVoiceId,
    Date.now(),
  )
}

/**
 * 部分更新个人配置。未传字段沿用当前值。
 * activeVoiceId 只能是系统默认或当前员工已保存的声音方案。
 */
export function saveVoiceProfile(
  db: Db,
  companyId: string,
  userId: string,
  patch: VoiceProfilePatch,
): VoiceProfile {
  const current = resolveVoiceProfile(db, companyId, userId)
  const activeVoiceId = patch.activeVoiceId === undefined ? current.activeVoiceId : String(patch.activeVoiceId).trim()
  if (
    activeVoiceId !== DEFAULT_VOICE_ID &&
    !getVoicePreset(db, companyId, userId, activeVoiceId)
  ) {
    throw new EabError(EC.VALIDATION, '没有找到这个声音方案', { details: { activeVoiceId } })
  }
  const enabled = patch.enabled === undefined ? current.enabled : patch.enabled === true
  writeProfile(db, companyId, userId, { activeVoiceId, enabled })
  return resolveVoiceProfile(db, companyId, userId)
}

export function createVoicePreset(
  db: Db,
  companyId: string,
  userId: string,
  input: VoicePresetInput,
): VoiceProfile {
  const now = Date.now()
  const name = uniqueName(db, companyId, userId, cleanName(input.name))
  const instructions = requireInstructions(input.instructions)
  const id = `vp_${randomUUID()}`
  db.prepare(
    `INSERT INTO user_voice_presets (id, company_id, user_id, name, instructions, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, companyId, userId, name, instructions, now, now)
  const current = resolveVoiceProfile(db, companyId, userId)
  writeProfile(db, companyId, userId, { activeVoiceId: id, enabled: current.enabled })
  return resolveVoiceProfile(db, companyId, userId)
}

export function updateVoicePreset(
  db: Db,
  companyId: string,
  userId: string,
  id: string,
  input: VoicePresetInput,
): VoiceProfile {
  const current = getVoicePreset(db, companyId, userId, id)
  if (!current) throw new EabError(EC.NOT_FOUND, '没有找到这个声音方案')
  const now = Date.now()
  const name =
    input.name === undefined
      ? current.name
      : uniqueName(db, companyId, userId, cleanName(input.name), id)
  const instructions =
    input.instructions === undefined ? current.instructions : requireInstructions(input.instructions)
  db.prepare(
    `UPDATE user_voice_presets
        SET name = ?, instructions = ?, updated_at = ?
      WHERE company_id = ? AND user_id = ? AND id = ?`,
  ).run(name, instructions, now, companyId, userId, id)
  return resolveVoiceProfile(db, companyId, userId)
}

export function deleteVoicePreset(db: Db, companyId: string, userId: string, id: string): VoiceProfile {
  const existing = getVoicePreset(db, companyId, userId, id)
  if (!existing) throw new EabError(EC.NOT_FOUND, '没有找到这个声音方案')
  const current = resolveVoiceProfile(db, companyId, userId)
  db.prepare(
    `DELETE FROM user_voice_presets WHERE company_id = ? AND user_id = ? AND id = ?`,
  ).run(companyId, userId, id)
  if (current.activeVoiceId === id) {
    writeProfile(db, companyId, userId, { activeVoiceId: DEFAULT_VOICE_ID, enabled: current.enabled })
  }
  return resolveVoiceProfile(db, companyId, userId)
}

export interface VoiceView {
  id: string
  name: string
  instructions: string
  builtin: boolean
  active: boolean
}

/** 默认配置对外只给前端需要的字段，seed 不外泄。 */
export function voiceProfileView(profile: VoiceProfile, presets: VoicePreset[] = []): {
  enabled: boolean
  activeVoiceId: string
  instructions: string
  voices: VoiceView[]
} {
  const voices: VoiceView[] = [
    {
      id: DEFAULT_VOICE_ID,
      name: DEFAULT_VOICE_NAME,
      instructions: '',
      builtin: true,
      active: profile.activeVoiceId === DEFAULT_VOICE_ID,
    },
    ...presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      instructions: preset.instructions,
      builtin: false,
      active: profile.activeVoiceId === preset.id,
    })),
  ]
  return {
    enabled: profile.enabled,
    activeVoiceId: profile.activeVoiceId,
    instructions: profile.instructions,
    voices,
  }
}
