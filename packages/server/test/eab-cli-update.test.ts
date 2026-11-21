import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
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

async function runUpdate(args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, 'update', ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        EAB_UPDATE_API_BASE: base,
        EAB_UPDATE_REPO: 'Jydsh/EAB',
      },
    })
    return { status: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { status: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
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

describe('eab update 指定版本', () => {
  it('列出可用版本并标记当前版本', async () => {
    const result = await runUpdate(['--list', '--limit=3'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`v${current}  `)
    expect(result.stdout).toContain('← 当前版本')
    expect(result.stdout).toContain(`v${older}`)
    expect(result.stdout).toContain('eab update --apply --version=<版本>')
  })

  it('指定较旧版本时显示降级，并给出对应安装命令', async () => {
    const result = await runUpdate([`--version=${older}`])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`目标版本：v${older}（降级）`)
    expect(result.stdout).toContain(`eab update --apply --version=${older}`)
  })

  it('支持空格分隔的 --version 写法', async () => {
    const result = await runUpdate(['--version', older])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`目标版本：v${older}（降级）`)
  })

  it('指定较新版本时显示升级', async () => {
    const result = await runUpdate([`--version=${newer}`])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`目标版本：v${newer}（升级）`)
  })

  it('同版本安装必须显式 --force', async () => {
    const result = await runUpdate([`--version=${current}`, '--apply'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('如需重装，请加 --force')
  })

  it('拒绝非法版本号和不带值的 --version', async () => {
    const invalid = await runUpdate(['--version=2026.13.40'])
    expect(invalid.status).toBe(1)
    expect(invalid.stderr).toContain('版本号格式应为')
    const missing = await runUpdate(['--version'])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('--version 需要版本号')
  })
})
