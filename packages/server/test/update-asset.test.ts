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
  it('无同日序号的基础版本低于任一两位序号版本', () => {
    expect(isNewerVersion('2026.11.18', '2026.11.18.01')).toBe(true)
    expect(isNewerVersion('2026.11.18.01', '2026.11.18')).toBe(false)
    expect(isNewerVersion('2026.11.18.01', '2026.11.18.02')).toBe(true)
    expect(isNewerVersion('2026.11.18.02', '2026.11.18.01')).toBe(false)
  })

  it('按年、月、日、同日序号依次比较', () => {
    expect(isNewerVersion('2026.11.17', '2026.11.18')).toBe(true)
    expect(isNewerVersion('2026.11.18', '2026.11.17')).toBe(false)
    expect(isNewerVersion('2026.11.18.99', '2026.11.19')).toBe(true)
    expect(isNewerVersion('2026.11.19', '2026.11.18.99')).toBe(false)
    expect(isNewerVersion('2026.11.18.01', '2026.11.18.01')).toBe(false)
  })

  it('去除 v 前缀后比较', () => {
    expect(normalizeVersion('v2026.11.15')).toBe('2026.11.15')
    expect(normalizeVersion('v2026.11.15.01')).toBe('2026.11.15.01')
    expect(isNewerVersion('v2026.11.17', 'v2026.11.18.01')).toBe(true)
  })

  it('拒绝非日期版本格式，避免把 -1、一位序号或非法日期当成更新', () => {
    expect(isNewerVersion('2026.11.18', '2026.11.18-1')).toBe(false)
    expect(isNewerVersion('2026.11.18', '2026.11.18.1')).toBe(false)
    expect(isNewerVersion('2026.11.18', '2026.11.18.00')).toBe(false)
    expect(isNewerVersion('2026.11.18', '2026.02.30')).toBe(false)
    expect(isNewerVersion('2026.11.18', '')).toBe(false)
  })
})
