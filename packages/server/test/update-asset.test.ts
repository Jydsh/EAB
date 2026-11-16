import { describe, expect, it } from 'vitest'
import { chooseSourceAsset, isNewerVersion, normalizeVersion, type ReleaseAsset } from '../src/update.js'

function asset(name: string, digest: string | null = null): ReleaseAsset {
  return {
    name,
    url: `https://github.com/Jydsh/EAB/releases/download/v2026.11.15/${name}`,
    size: 3798601,
    digest,
  }
}

describe('更新包资产选择', () => {
  it('优先选择源码 zip，并保留 Release 提供的 sha256', () => {
    const selected = chooseSourceAsset([
      asset('EAB-2026.11.15-Setup.exe'),
      asset('EAB-2026.11.15-windows.zip'),
      asset('EAB-2026.11.15.zip', 'sha256:1f9d516c209c3a70da5bff278a1705014fef1bb0a0ab79607e06dc98258bef7c'),
    ])
    expect(selected?.name).toBe('EAB-2026.11.15.zip')
    expect(selected?.digest).toBe('sha256:1f9d516c209c3a70da5bff278a1705014fef1bb0a0ab79607e06dc98258bef7c')
  })

  it('只有安装包或校验文件时返回 null，不把安装包当源码', () => {
    expect(chooseSourceAsset([
      asset('EAB-2026.11.15-Setup.exe'),
      asset('EAB-2026.11.15-desktop-win64.zip'),
      asset('EAB-2026.11.15.sha256'),
    ])).toBeNull()
  })

  it('没有 zip 时返回 null，由调用方回退到 zipball', () => {
    expect(chooseSourceAsset([asset('EAB-2026.11.15.tar.gz')])).toBeNull()
  })
})

describe('版本比较', () => {
  it('去除 v 前缀后按数字段比较', () => {
    expect(normalizeVersion('v2026.11.15')).toBe('2026.11.15')
    expect(isNewerVersion('2026.11.15', '2026.11.16')).toBe(true)
    expect(isNewerVersion('2026.11.16', '2026.11.15')).toBe(false)
    expect(isNewerVersion('2026.11.15', '2026.11.15')).toBe(false)
  })
})
