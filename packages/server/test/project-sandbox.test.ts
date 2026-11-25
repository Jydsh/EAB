import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EabError } from '@eab/domain'
import {
  assertProjectCommandAllowed,
  assertProjectExecEnabled,
  parseProjectCommandAllowlist,
  projectSandboxCapability,
  projectSandboxLaunch,
  resolveProjectExecMode,
  runProjectCommand,
} from '../src/project-runner.js'

const original = { ...process.env }
const dirs: string[] = []

afterEach(() => {
  for (const key of [
    'EAB_PROJECT_EXEC',
    'EAB_PROJECT_SANDBOX',
    'EAB_PROJECT_SANDBOX_BACKEND',
    'EAB_PROJECT_COMMAND_ALLOWLIST',
    'PATH',
  ]) {
    const value = original[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eab-project-sandbox-'))
  dirs.push(dir)
  return dir
}

function fakeBackend(name: string): string {
  const dir = root()
  writeFileSync(join(dir, name), '')
  writeFileSync(join(dir, `${name}.EXE`), '')
  return dir
}

describe('项目命令 OS 沙箱与白名单', () => {
  it('解析 off / local / strict 三种模式', () => {
    expect(resolveProjectExecMode({})).toBe('off')
    expect(resolveProjectExecMode({ EAB_PROJECT_EXEC: '1' })).toBe('local')
    expect(resolveProjectExecMode({ EAB_PROJECT_EXEC: 'true' })).toBe('local')
    expect(resolveProjectExecMode({ EAB_PROJECT_EXEC: 'strict' })).toBe('strict')
    expect(resolveProjectExecMode({ EAB_PROJECT_SANDBOX: 'sandbox' })).toBe('strict')
  })

  it('strict 没有后端时检测为不可用，不伪装成已隔离', () => {
    const capability = projectSandboxCapability(
      { EAB_PROJECT_SANDBOX_BACKEND: 'docker', PATH: '', PATHEXT: '.EXE;.CMD' },
      'win32',
    )
    expect(capability.backend).toBeNull()
    expect(capability.detail).toContain('Docker')
    expect(capability.network).toBe('unrestricted')
  })

  it('显式 none 不参与自动探测，防止被 auto 绕过', () => {
    const dir = fakeBackend('docker')
    const capability = projectSandboxCapability(
      { EAB_PROJECT_SANDBOX_BACKEND: 'none', PATH: dir, PATHEXT: '.EXE;.CMD' },
      'win32',
    )
    expect(capability.backend).toBeNull()
    expect(capability.detail).toContain('none')
  })

  it('Docker 后端参数包含断网、只读根、权限降级和工作区挂载', () => {
    const dir = fakeBackend('docker')
    const workspaces = root()
    const launch = projectSandboxLaunch(workspaces, workspaces, 'node -e "console.log(1)"', {
      EAB_PROJECT_EXEC: 'strict',
      EAB_PROJECT_SANDBOX_BACKEND: 'docker',
      EAB_PROJECT_COMMAND_ALLOWLIST: '^node\\s',
      PATH: dir,
      PATHEXT: '.EXE;.CMD',
    })
    expect(launch.shell.command).toBe('docker')
    expect(launch.enforcement).toBe('docker')
    expect(launch.network).toBe('denied')
    expect(launch.args).toEqual(
      expect.arrayContaining([
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--read-only',
        '--pids-limit',
        '-v',
        `${workspaces}:/workspace:rw`,
        '-w',
        '/workspace',
      ]),
    )
    expect(launch.args).toEqual(expect.arrayContaining(['bash', '-lc', 'node -e "console.log(1)"']))
  })

  it('bwrap 后端参数包含网络命名空间隔离和只读系统绑定', () => {
    const dir = fakeBackend('bwrap')
    const workspaces = root()
    const launch = projectSandboxLaunch(workspaces, workspaces, 'node -e "console.log(1)"', {
      EAB_PROJECT_EXEC: 'strict',
      EAB_PROJECT_SANDBOX_BACKEND: 'bwrap',
      EAB_PROJECT_COMMAND_ALLOWLIST: '^node\\s',
      PATH: dir,
      PATHEXT: '.EXE;.CMD',
    })
    expect(launch.shell.command).toBe('bwrap')
    expect(launch.enforcement).toBe('bwrap')
    expect(launch.network).toBe('denied')
    expect(launch.args).toEqual(
      expect.arrayContaining([
        '--unshare-net',
        '--unshare-pid',
        '--bind',
        workspaces,
        workspaces,
        '--chdir',
        workspaces,
      ]),
    )
    expect(launch.args).toEqual(expect.arrayContaining(['--', 'bash', '-lc']))
  })

  it('strict 模式没有后端时拒绝执行，不回落 local', async () => {
    process.env.EAB_PROJECT_EXEC = 'strict'
    process.env.EAB_PROJECT_SANDBOX_BACKEND = 'docker'
    process.env.PATH = ''
    expect(() => assertProjectExecEnabled()).toThrow(EabError)
    const dir = root()
    const error = await runProjectCommand({
      root: dir,
      command: `node -e "console.log('strict-blocked')"`,
    }).catch((reason) => reason)
    expect(error).toBeInstanceOf(EabError)
    expect(error.code).toBe('EAB_FORBIDDEN')
    expect(error.details?.sandboxAvailable).toBe(false)
  })

  it('白名单命中才放行，未命中直接拒绝', async () => {
    process.env.EAB_PROJECT_EXEC = '1'
    process.env.EAB_PROJECT_COMMAND_ALLOWLIST = 'allow-ok'
    const dir = root()
    const allowed = await runProjectCommand({
      root: dir,
      command: `node -e "console.log('allow-ok')"`,
    })
    expect(allowed.status).toBe('completed')
    expect(allowed.stdout).toContain('allow-ok')
    expect(allowed.enforcement).toBe('none')
    expect(allowed.sandboxMode).toBe('local')
    expect(allowed.network).toBe('unrestricted')

    const blocked = await runProjectCommand({
      root: dir,
      command: `node -e "console.log('should-not-run')"`,
    }).catch((reason) => reason)
    expect(blocked).toBeInstanceOf(EabError)
    expect(blocked.code).toBe('EAB_FORBIDDEN')
    expect(blocked.details?.guard).toBe('command-allowlist-v1')
  }, 20_000)

  it('白名单按行解析，支持注释并拒绝非法正则', () => {
    const rules = parseProjectCommandAllowlist('# 注释\n^pnpm\\s+test$\n\n^git\\s+status$')
    expect(rules).toHaveLength(2)
    expect(rules[0]!.test('pnpm test')).toBe(true)
    expect(rules[1]!.test('git status')).toBe(true)
    expect(() => parseProjectCommandAllowlist('[')).toThrow(EabError)
  })

  it('strict 模式必须配置白名单，即使后端可用也不能执行任意命令', () => {
    expect(() => parseProjectCommandAllowlist('')).not.toThrow()
    // 这里只验证策略函数本身；不依赖本机是否装了 Docker/bwrap。
    expect(() => assertProjectCommandAllowed('node -e "console.log(1)"', { mode: 'strict' })).toThrow(
      /白名单/,
    )
  })
})
