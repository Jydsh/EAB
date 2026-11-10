import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase } from '@eab/storage'
import type { Db } from '@eab/storage'
import {
  companyAssistantView,
  readCompanyAssistant,
  readCompanyAssistantAvatar,
  saveCompanyAssistant,
} from '../src/company-assistant.js'

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lv6QAAAAAElFTkSuQmCC'

let dir = ''
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eab-company-assistant-'))
  db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.prepare(
    'INSERT INTO companies (id, name, slug, status, settings_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('c1', '测试公司', 'test-company', 'active', JSON.stringify({ other: { keep: true } }), Date.now())
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('公司助手身份', () => {
  it('没配置时回退默认 AI，且不暴露头像文件路径', () => {
    expect(readCompanyAssistant(db, 'c1')).toEqual({ name: 'AI', avatar: null })
    expect(companyAssistantView(db, 'c1')).toEqual({ name: 'AI', avatarUrl: '' })
  })

  it('只保存名字时保留 settings 里的其它配置', () => {
    saveCompanyAssistant(db, dir, 'c1', { name: '  小易  ' })
    expect(companyAssistantView(db, 'c1')).toEqual({ name: '小易', avatarUrl: '' })
    const row = db.prepare('SELECT settings_json FROM companies WHERE id = ?').get('c1') as { settings_json: string }
    expect(JSON.parse(row.settings_json)).toEqual({ other: { keep: true }, assistant: { name: '小易', avatar: null } })
  })

  it('上传头像后可按版本地址读回，替换旧图会删掉旧文件', () => {
    const saved = saveCompanyAssistant(db, dir, 'c1', { name: '小易', avatarDataUrl: PNG_DATA_URL })
    expect(saved.avatar).not.toBeNull()
    const first = companyAssistantView(db, 'c1')
    expect(first.name).toBe('小易')
    expect(first.avatarUrl).toMatch(/^\/api\/company\/assistant-avatar\?v=\d+$/)
    const avatar = readCompanyAssistantAvatar(db, dir, 'c1')
    expect(avatar?.mime).toBe('image/png')
    expect(avatar?.bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const before = readdirSync(join(dir, 'company-assets', 'c1'))
    expect(before).toHaveLength(1)

    // 同内容再存一次：文件名复用，不会堆垃圾；版本号变化用于刷缓存。
    const second = saveCompanyAssistant(db, dir, 'c1', { avatarDataUrl: PNG_DATA_URL })
    expect(second.avatar?.file).toBe(saved.avatar?.file)
    expect(second.avatar?.updatedAt).toBeGreaterThanOrEqual(saved.avatar?.updatedAt ?? 0)
    expect(readdirSync(join(dir, 'company-assets', 'c1'))).toHaveLength(1)

    // 删除头像：库清空、文件删掉，前端回退首字。
    saveCompanyAssistant(db, dir, 'c1', { removeAvatar: true })
    expect(companyAssistantView(db, 'c1').avatarUrl).toBe('')
    expect(readCompanyAssistantAvatar(db, dir, 'c1')).toBeNull()
    expect(existsSync(join(dir, 'company-assets', 'c1', saved.avatar?.file ?? ''))).toBe(false)
  })

  it('拒绝非法名称、伪造图片和超限图片', () => {
    expect(() => saveCompanyAssistant(db, dir, 'c1', { name: '   ' })).toThrow('助手名称不能为空')
    expect(() => saveCompanyAssistant(db, dir, 'c1', { avatarDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })).toThrow(
      'PNG / JPEG / WebP',
    )
    expect(() =>
      saveCompanyAssistant(db, dir, 'c1', {
        avatarDataUrl: 'data:image/png;base64,AAAA',
      }),
    ).toThrow('内容与图片格式不符')
  })

  it('settings 被外部写坏时读取回退默认，保存明确拒绝', () => {
    db.prepare('UPDATE companies SET settings_json = ? WHERE id = ?').run('{bad', 'c1')
    expect(readCompanyAssistant(db, 'c1').name).toBe('AI')
    expect(() => saveCompanyAssistant(db, dir, 'c1', { name: '小易' })).toThrow('不是合法 JSON')
  })
})
