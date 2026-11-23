import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase, type Db } from '@eab/storage'
import {
  DEFAULT_VOICE,
  MAX_VOICE_INSTRUCTIONS,
  createVoicePreset,
  deleteVoicePreset,
  listVoicePresets,
  resolveVoiceProfile,
  saveVoiceProfile,
  updateVoicePreset,
  voiceProfileView,
  voiceSeedOf,
} from '../src/voice-profile.js'

const dbs: Db[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

function testDb(): Db {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  dbs.push(db)
  const now = Date.now()
  db.prepare(
    `INSERT INTO companies (id, name, slug, status, created_at)
     VALUES ('c1', '测试公司', 'test', 'active', ?)`,
  ).run(now)
  db.prepare(
    `INSERT INTO departments (id, company_id, parent_id, name, path, depth, created_at)
     VALUES ('d1', 'c1', NULL, '测试部门', '/c1/d1', 1, ?)`,
  ).run(now)
  for (const [id, name] of [
    ['u1', '员工一'],
    ['u2', '员工二'],
  ] as const) {
    db.prepare(
      `INSERT INTO users (id, company_id, dept_id, dept_path, name, status, missing_runs, chat_send_mode, created_at, updated_at)
       VALUES (?, 'c1', 'd1', '/c1/d1', ?, 'active', 0, 'queue', ?, ?)`,
    ).run(id, name, now, now)
  }
  return db
}

describe('voice profile', () => {
  it('没有个人记录时使用唯一的内置系统默认，并开启语音回复', () => {
    const db = testDb()
    const profile = resolveVoiceProfile(db, 'c1', 'u1')
    expect(profile).toMatchObject({ voice: DEFAULT_VOICE, activeVoiceId: 'default', instructions: '', enabled: true })
    expect(voiceProfileView(profile)).toMatchObject({
      enabled: true,
      activeVoiceId: 'default',
      instructions: '',
      voices: [{ id: 'default', name: '系统默认', builtin: true, active: true }],
    })
  })

  it('可保存多段声音方案，并立即使用新保存的一段', () => {
    const db = testDb()
    const first = createVoicePreset(db, 'c1', 'u1', {
      name: '稳重技术同事',
      instructions: '低沉、沉稳的男声，语速稍慢',
    })
    expect(first.activeVoiceId).not.toBe('default')
    expect(first.instructions).toBe('低沉、沉稳的男声，语速稍慢')
    expect(listVoicePresets(db, 'c1', 'u1')).toHaveLength(1)

    const second = createVoicePreset(db, 'c1', 'u1', {
      name: '轻快同事',
      instructions: '年轻、轻快的女声，语速自然',
    })
    expect(second.activeVoiceId).not.toBe(first.activeVoiceId)
    expect(listVoicePresets(db, 'c1', 'u1')).toHaveLength(2)
    expect(resolveVoiceProfile(db, 'c1', 'u2')).toMatchObject({ activeVoiceId: 'default', instructions: '' })
  })

  it('切换默认、修改描述和删除当前方案都能保持一致', () => {
    const db = testDb()
    const created = createVoicePreset(db, 'c1', 'u1', {
      name: '我的声音',
      instructions: '温和、清晰的声音',
    })
    const switched = saveVoiceProfile(db, 'c1', 'u1', { activeVoiceId: 'default', enabled: false })
    expect(switched).toMatchObject({ activeVoiceId: 'default', instructions: '', enabled: false })

    const updated = updateVoicePreset(db, 'c1', 'u1', created.activeVoiceId, {
      name: '更新后的声音',
      instructions: '更低沉、更慢的声音',
    })
    expect(updated.activeVoiceId).toBe('default')

    saveVoiceProfile(db, 'c1', 'u1', { activeVoiceId: created.activeVoiceId })
    const removed = deleteVoicePreset(db, 'c1', 'u1', created.activeVoiceId)
    expect(removed).toMatchObject({ activeVoiceId: 'default', instructions: '' })
    expect(listVoicePresets(db, 'c1', 'u1')).toEqual([])
  })

  it('拒绝不存在的声音方案、空描述和非法默认值', () => {
    const db = testDb()
    expect(() => saveVoiceProfile(db, 'c1', 'u1', { activeVoiceId: 'vp_missing' })).toThrow(/声音方案/)
    expect(() => createVoicePreset(db, 'c1', 'u1', { name: '空', instructions: '   ' })).toThrow(/声音描述/)
    expect(() =>
      updateVoicePreset(db, 'c1', 'u1', 'vp_missing', { instructions: '声音' }),
    ).toThrow(/声音方案/)
  })

  it('描述和名称按上限截断，同名会自动区分', () => {
    const db = testDb()
    const first = createVoicePreset(db, 'c1', 'u1', {
      name: '声音'.repeat(30),
      instructions: '声'.repeat(MAX_VOICE_INSTRUCTIONS + 40),
    })
    expect(first.instructions).toHaveLength(MAX_VOICE_INSTRUCTIONS)
    const preset = listVoicePresets(db, 'c1', 'u1')[0]
    expect(preset.name).toHaveLength(40)
    const second = createVoicePreset(db, 'c1', 'u1', {
      name: preset.name,
      instructions: '另一段声音',
    })
    expect(second.activeVoiceId).not.toBe(first.activeVoiceId)
    const names = listVoicePresets(db, 'c1', 'u1').map((item) => item.name)
    expect(names).toHaveLength(2)
    expect(names).toContain(`${preset.name.slice(0, 38)} 2`)
  })

  it('员工种子稳定且不同员工不同', () => {
    expect(voiceSeedOf('c1', 'u1')).toBe(voiceSeedOf('c1', 'u1'))
    expect(voiceSeedOf('c1', 'u1')).not.toBe(voiceSeedOf('c1', 'u2'))
    expect(voiceSeedOf('c1', 'u1')).not.toBe(voiceSeedOf('c2', 'u1'))
  })
})
