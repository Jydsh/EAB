import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cli = fileURLToPath(new URL('../../../scripts/eab.mjs', import.meta.url))
const current = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version as string
const older = '2026.01.01'
const newer = '2099.01.01'

let server: Server
let base = ''

function release(version: string) {
  return {
    tag_name: `v${version}`,
    html_url: `https://example.com/releases/v${version}`,
    published_at: '2026-01-01T00:00:00Z',
    zipball_url: `${base}/source-${version}.zip`,
    assets: [
      {
        name: `EAB-${version}.zip`,
        browser_download_url: `${base}/source-${version}.zip`,
        digest: `sha256:${'a'.repeat(64)}`,
      },
    ],
  }
}

const execFileAsync = promisify(execFile)

async function runCli(cliPath: string, args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, 'update', ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        EAB_UPDATE_API_BASE: base,
        EAB_UPDATE_REPO: 'Jydsh/EAB',
        ...env,
      },
    })
    return { status: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { status: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

async function runUpdate(args: string[], env: Record<string, string> = {}) {
  return runCli(cli, args, env)
}

function createCliSandbox() {
  const sandbox = mkdtempSync(join(tmpdir(), 'eab-update-cli-'))
  mkdirSync(join(sandbox, 'scripts'), { recursive: true })
  copyFileSync(cli, join(sandbox, 'scripts', 'eab.mjs'))
  copyFileSync(
    fileURLToPath(new URL('../../../scripts/windows-console.mjs', import.meta.url)),
    join(sandbox, 'scripts', 'windows-console.mjs'),
  )
  writeFileSync(join(sandbox, 'package.json'), JSON.stringify({ name: 'eab', version: current }))
  const marker = join(sandbox, 'updater-args.json')
  writeFileSync(
    join(sandbox, 'scripts', 'eab-update.mjs'),
    "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.EAB_TEST_MARKER, JSON.stringify(process.argv.slice(2)))\n",
  )
  return {
    root: sandbox,
    cli: join(sandbox, 'scripts', 'eab.mjs'),
    marker,
    env: {
      EAB_HOME: join(sandbox, 'home'),
      EAB_PORT: '65000',
      EAB_ADMIN_PORT: '65001',
      EAB_TEST_MARKER: marker,
    } as Record<string, string>,
    cleanup: () => rmSync(sandbox, { recursive: true, force: true }),
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/repos/Jydsh/EAB/releases/latest') {
      res.end(JSON.stringify(release(current)))
      return
    }
    if (url.pathname === '/repos/Jydsh/EAB-latest/releases/latest') {
      res.end(JSON.stringify(release(newer)))
      return
    }
    if (url.pathname === '/repos/Jydsh/EAB/releases') {
      res.end(JSON.stringify([release(newer), release(current), release(older)]))
      return
    }
    const tag = url.pathname.match(/^\/repos\/Jydsh\/EAB\/releases\/tags\/(.+)$/)?.[1]
    if (tag) {
      const version = decodeURIComponent(tag).replace(/^v/, '')
      if ([current, older, newer].includes(version)) {
        res.end(JSON.stringify(release(version)))
        return
      }
    }
    res.statusCode = 404
    res.end(JSON.stringify({ message: 'Not Found' }))
  })
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试服务器没有监听端口')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
})

describe('eab update 升级与降级', () => {
  it('列出可用版本并标记当前版本', async () => {
    const result = await runUpdate(['--list', '--limit=3'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`v${current}  `)
    expect(result.stdout).toContain('← 当前版本')
    expect(result.stdout).toContain(`v${older}`)
    expect(result.stdout).toContain('eab update <版本>')
  })

  it('位置参数直接指定较旧版本，输出降级和安装命令', async () => {
    const result = await runUpdate([older, '--check'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`目标版本：v${older}（降级）`)
    expect(result.stdout).toContain(`执行安装：eab update ${older}`)
    expect(result.stdout).not.toContain('--apply')
  })

  it('位置参数不带 --apply 时直接调用更新器安装指定版本', async () => {
    const sandbox = createCliSandbox()
    try {
      const result = await runCli(sandbox.cli, [older], sandbox.env)
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('正在停止服务并执行降级')
      expect(existsSync(sandbox.marker)).toBe(true)
      const args = JSON.parse(readFileSync(sandbox.marker, 'utf8')) as string[]
      expect(args).toContain('--apply')
      expect(args).toContain(`--version=${older}`)
      expect(args).toContain('--restart=1')
      expect(args).toContain(`--root=${sandbox.root}`)
    } finally {
      sandbox.cleanup()
    }
  })

  it('eab update 不带版本号时直接安装 GitHub 最新版本', async () => {
    const sandbox = createCliSandbox()
    try {
      const result = await runCli(sandbox.cli, [], { ...sandbox.env, EAB_UPDATE_REPO: 'Jydsh/EAB-latest' })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`最新版本：v${newer}（有新版本）`)
      expect(result.stdout).toContain('正在停止服务并执行升级')
      const args = JSON.parse(readFileSync(sandbox.marker, 'utf8')) as string[]
      expect(args).toContain(`--version=${newer}`)
    } finally {
      sandbox.cleanup()
    }
  })

  it('eab update 不带版本时检查最新版本，不再要求 --apply', async () => {
    const result = await runUpdate(['--check'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`最新版本：v${current}`)
    expect(result.stdout).toContain('当前已是')
    expect(result.stdout).not.toContain('确认安装')
  })

  it('支持空格分隔的 --version 写法', async () => {
    const result = await runUpdate(['--version', older, '--check'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`目标版本：v${older}（降级）`)
  })

  it('指定较新版本时输出升级', async () => {
    const result = await runUpdate([`--version=${newer}`, '--check'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`目标版本：v${newer}（升级）`)
  })

  it('同版本不安装，提示加 --force 重装', async () => {
    const result = await runUpdate([current, '--check'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`当前已是 v${current}`)
    expect(result.stdout).toContain('--force')
  })

  it('拒绝非法版本号、不带值的 --version 和多个版本号', async () => {
    const invalid = await runUpdate(['--version=2026.13.40'])
    expect(invalid.status).toBe(1)
    expect(invalid.stderr).toContain('版本号格式应为')
    const missing = await runUpdate(['--version'])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('--version 需要版本号')
    const multiple = await runUpdate([older, current, '--check'])
    expect(multiple.status).toBe(1)
    expect(multiple.stderr).toContain('只能指定一个版本号')
    const conflict = await runUpdate([older, `--version=${current}`, '--check'])
    expect(conflict.status).toBe(1)
    expect(conflict.stderr).toContain('版本号只能指定一个')
  })
})
