import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isActiveUpdate, lastUpdatePath, markUpdateStartFailed, parseUpdateResult, waitForUpdaterStarted } from '../src/update.js'

describe('更新结果状态', () => {
  it('识别更新器新版状态与回滚信息', () => {
    const result = parseUpdateResult(JSON.stringify({
      status: 'rolled_back',
      ok: false,
      version: '2026.11.19',
      previousVersion: '2026.11.18',
      startedAt: '2026-11-19T01:00:00.000Z',
      finishedAt: '2026-11-19T01:02:00.000Z',
      error: '新版本未恢复健康',
      rolledBack: true,
    }))
    expect(result?.status).toBe('rolled_back')
    expect(result?.version).toBe('2026.11.19')
    expect(result?.previousVersion).toBe('2026.11.18')
    expect(result?.error).toBe('新版本未恢复健康')
    expect(result?.rolledBack).toBe(true)
  })

  it('兼容旧状态文件：只有 ok 与 at 时推断成功或失败', () => {
    const success = parseUpdateResult(JSON.stringify({ version: '2026.11.14', at: '2026-11-14T09:56:12.806Z', ok: true }))
    expect(success?.status).toBe('succeeded')
    expect(success?.ok).toBe(true)
    const failure = parseUpdateResult(JSON.stringify({ version: '2026.11.14', at: '2026-11-14T09:56:12.806Z', ok: false }))
    expect(failure?.status).toBe('failed')
    expect(failure?.ok).toBe(false)
  })

  it('忽略损坏或无法判断的状态文件', () => {
    expect(parseUpdateResult('not json')).toBeNull()
    expect(parseUpdateResult('[]')).toBeNull()
    expect(parseUpdateResult(JSON.stringify({ version: '2026.11.18' }))).toBeNull()
  })
})

describe('更新进行中判定', () => {
  it('30 分钟内的 starting/running 视为进行中', () => {
    const now = Date.parse('2026-11-19T02:00:00.000Z')
    expect(isActiveUpdate(parseUpdateResult(JSON.stringify({
      status: 'running',
      version: '2026.11.19',
      startedAt: '2026-11-19T01:55:00.000Z',
    })), now)).toBe(true)
  })

  it('已结束或超时的状态不再阻止下一次更新', () => {
    const now = Date.parse('2026-11-19T02:00:00.000Z')
    expect(isActiveUpdate(parseUpdateResult(JSON.stringify({
      status: 'succeeded',
      version: '2026.11.19',
      startedAt: '2026-11-19T01:55:00.000Z',
    })), now)).toBe(false)
    expect(isActiveUpdate(parseUpdateResult(JSON.stringify({
      status: 'running',
      version: '2026.11.19',
      startedAt: '2026-11-19T00:00:00.000Z',
    })), now)).toBe(false)
  })
})

describe('更新器启动握手', () => {
  const originalHome = process.env.EAB_HOME
  let tempHome = ''

  afterEach(() => {
    if (tempHome) rmSync(tempHome, { recursive: true, force: true })
    tempHome = ''
    if (originalHome === undefined) delete process.env.EAB_HOME
    else process.env.EAB_HOME = originalHome
  })

  const useTempHome = () => {
    tempHome = mkdtempSync(join(tmpdir(), 'eab-update-result-'))
    process.env.EAB_HOME = tempHome
    mkdirSync(join(tempHome, 'updates'), { recursive: true })
    return lastUpdatePath()
  }

  it('不把上一轮遗留的 running 当成本次更新器已接管', async () => {
    const path = useTempHome()
    writeFileSync(path, JSON.stringify({
      status: 'running',
      version: '2026.11.18',
      startedAt: '2026-11-19T01:00:00.000Z',
      updaterPid: 111,
    }), 'utf8')
    expect(await waitForUpdaterStarted(250, '2026-11-19T02:00:00.000Z')).toBe(false)
  })

  it('只有仍处于 starting 时才能标记启动失败', () => {
    const path = useTempHome()
    writeFileSync(path, JSON.stringify({
      status: 'running',
      version: '2026.11.19',
      startedAt: '2026-11-19T02:00:00.000Z',
      updaterPid: 222,
    }), 'utf8')
    markUpdateStartFailed('测试失败')
    expect(parseUpdateResult(readFileSync(path, 'utf8'))?.status).toBe('running')

    markUpdateStartFailed('测试失败', 222)
    const killed = parseUpdateResult(readFileSync(path, 'utf8'))
    expect(killed?.status).toBe('failed')
    expect(killed?.error).toBe('测试失败')

    writeFileSync(path, JSON.stringify({
      status: 'starting',
      version: '2026.11.19',
      startedAt: '2026-11-19T02:00:00.000Z',
    }), 'utf8')
    markUpdateStartFailed('测试失败')
    const result = parseUpdateResult(readFileSync(path, 'utf8'))
    expect(result?.status).toBe('failed')
    expect(result?.error).toBe('测试失败')
  })
})
