import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { deleteSecret, resolveSecret, storeSecret } from '../src/secrets.js'

const dirs: string[] = []

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eab-secrets-'))
  dirs.push(dir)
  return join(dir, 'eab.db')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('secrets store', () => {
  it('keeps existing keys when adding another secret', () => {
    const dbPath = tempDbPath()
    storeSecret(dbPath, 'EAB_DINGTALK_APP_SECRET_TEST', 'dingtalk-value', 'EAB_DINGTALK_APP_SECRET')
    storeSecret(dbPath, 'EAB_FEISHU_APP_SECRET_TEST', 'feishu-value', 'EAB_FEISHU_APP_SECRET')
    expect(resolveSecret(dbPath, 'EAB_DINGTALK_APP_SECRET_TEST')).toBe('dingtalk-value')
    expect(resolveSecret(dbPath, 'EAB_FEISHU_APP_SECRET_TEST')).toBe('feishu-value')
  })

  it('recovers a lost key from the previous version backup', () => {
    const dbPath = tempDbPath()
    storeSecret(dbPath, 'EAB_DINGTALK_APP_SECRET_TEST', 'dingtalk-value', 'EAB_DINGTALK_APP_SECRET')
    storeSecret(dbPath, 'EAB_FEISHU_APP_SECRET_TEST', 'feishu-value', 'EAB_FEISHU_APP_SECRET')
    // 模拟外部把主文件覆盖成只剩飞书密钥；上一版备份仍应能解析出钉钉密钥。
    writeFileSync(
      join(dirname(dbPath), 'secrets.json'),
      `${JSON.stringify({ EAB_FEISHU_APP_SECRET_TEST: 'feishu-value' }, null, 2)}\n`,
      'utf8',
    )
    expect(resolveSecret(dbPath, 'EAB_DINGTALK_APP_SECRET_TEST')).toBe('dingtalk-value')
  })

  it('does not resurrect an explicitly deleted key from backup', () => {
    const dbPath = tempDbPath()
    storeSecret(dbPath, 'EAB_DINGTALK_APP_SECRET_TEST', 'dingtalk-value', 'EAB_DINGTALK_APP_SECRET')
    storeSecret(dbPath, 'EAB_FEISHU_APP_SECRET_TEST', 'feishu-value', 'EAB_FEISHU_APP_SECRET')
    deleteSecret(dbPath, 'EAB_DINGTALK_APP_SECRET_TEST')
    expect(resolveSecret(dbPath, 'EAB_DINGTALK_APP_SECRET_TEST')).toBe('')
    expect(readFileSync(join(dirname(dbPath), 'secrets.json.bak'), 'utf8')).not.toContain('dingtalk-value')
  })
})
