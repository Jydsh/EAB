import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const cli = fileURLToPath(new URL('../../../scripts/eab.mjs', import.meta.url))
const root = fileURLToPath(new URL('../../../', import.meta.url))
const execFileAsync = promisify(execFile)

async function runCli(args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, EAB_SEARXNG_AUTO: '0' },
    })
    return { status: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { status: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

describe('SearXNG 端口参数', () => {
  it('帮助里同时给出指定端口与自动选择', async () => {
    const { stdout } = await runCli(['help'])
    expect(stdout).toContain('eab searxng install [--port=8080|auto]')
    expect(stdout).toContain('eab start')
    expect(stdout).toContain('--searxng-port=8080|auto')
  })

  it('非法端口在安装前被拒绝', async () => {
    const { status, stderr } = await runCli(['searxng', 'install', '--port=abc'])
    expect(status).toBe(1)
    expect(stderr).toContain('SearXNG 端口必须是 1–65535 的整数')
  })

  it('端口超出范围也会被拒绝', async () => {
    const { status, stderr } = await runCli(['searxng', 'install', '--port=70000'])
    expect(status).toBe(1)
    expect(stderr).toContain('SearXNG 端口必须是 1–65535 的整数')
  })
})
