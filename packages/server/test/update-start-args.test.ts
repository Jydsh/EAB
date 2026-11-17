import { describe, expect, it } from 'vitest'
import { buildUpdateArgs } from '../src/update.js'

const ROOT = 'D:\\AI kaifa\\EAB'

describe('一键更新启动参数', () => {
  it('始终带 --restart=1 和旧进程 pid，更新器才能确认新进程已接管', () => {
    const args = buildUpdateArgs('2026.11.17', 'https://github.com/Jydsh/EAB/releases/download/v2026.11.17/EAB.zip', ROOT, 'sha256:abcd', 4321)
    expect(args).toContain('--apply')
    expect(args).toContain('--restart=1')
    expect(args).toContain(`--root=${ROOT}`)
    expect(args).toContain('--old-pid=4321')
    expect(args).toContain('--sha256=sha256:abcd')
  })

  it('没有摘要时不追加空的 --sha256', () => {
    const args = buildUpdateArgs('2026.11.17', 'https://github.com/Jydsh/EAB/releases/download/v2026.11.17/EAB.zip', ROOT, null, 123)
    expect(args.some((item) => item.startsWith('--sha256='))).toBe(false)
    expect(args).toContain('--restart=1')
  })
})
