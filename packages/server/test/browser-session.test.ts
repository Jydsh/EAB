import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EC, EabError } from '@eab/domain'
import {
  browserProxyConfig,
  closeBrowserRuntime,
  executeBrowserAction,
  type BrowserResult,
} from '../src/browser-session.js'

const HTML = `<!doctype html>
<html><head><title>EAB Browser Test</title></head>
<body>
  <h1 id="status">静态首页</h1>
  <a id="next" href="/next">下一页</a>
  <button id="change" type="button">改文字</button>
  <form action="/submitted" method="get">
    <input type="search" name="q" placeholder="搜索">
    <button id="submit" type="submit">提交</button>
  </form>
  <input type="password" name="p" placeholder="密码">
  <script>
    document.getElementById('change').onclick = () => {
      document.getElementById('status').textContent = '已点击'
    }
  </script>
</body></html>`

describe('内置浏览器会话', () => {
  let server: Server
  let baseUrl = ''
  const shotDir = mkdtempSync(join(tmpdir(), 'eab-browser-'))

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/next') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><head><title>下一页</title></head><body><p>第二页正文</p></body></html>')
        return
      }
      if (req.url === '/submitted') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><head><title>不应到达</title></head><body>表单已提交</body></html>')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(HTML)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器启动失败')
    baseUrl = `http://127.0.0.1:${address.port}`
    process.env.EAB_BROWSER_ENABLED = '1'
    process.env.EAB_BROWSER_CHANNEL = process.platform === 'win32' ? 'msedge' : 'chromium'
    process.env.EAB_BROWSER_HEADLESS = '1'
  })

  afterAll(async () => {
    await closeBrowserRuntime()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function options(ownerKey: string) {
    return {
      ownerKey,
      allowPrivateNetwork: true,
      allowedPorts: [Number(new URL(baseUrl).port)],
      saveScreenshot: (buffer: Buffer, filename: string) => {
        const path = join(shotDir, filename)
        writeFileSync(path, buffer)
        return { fileId: 'wf_test', name: filename, relPath: filename, size: buffer.length, mime: 'image/png' }
      },
    }
  }

  function element(result: BrowserResult, name: string) {
    return result.elements.find((item) => item.name === name || item.name.startsWith(name))
  }

  it('打开页面返回标题、正文和可点击元素', async () => {
    const opened = await executeBrowserAction({ action: 'open', url: `${baseUrl}/` }, options('u1'))
    expect(opened.pageId).toMatch(/^bp_/)
    expect(opened.title).toBe('EAB Browser Test')
    expect(opened.text).toContain('静态首页')
    expect(element(opened, '下一页')?.tag).toBe('a')
    expect(element(opened, '改文字')?.tag).toBe('button')
    expect(element(opened, '搜索')?.tag).toBe('input')

    const pageId = opened.pageId!
    const clickedButton = await executeBrowserAction(
      { action: 'click', pageId, ref: element(opened, '改文字')!.ref },
      options('u1'),
    )
    expect(clickedButton.text).toContain('已点击')

    const clickedLink = await executeBrowserAction(
      { action: 'click', pageId, ref: element(opened, '下一页')!.ref },
      options('u1'),
    )
    expect(clickedLink.title).toBe('下一页')
    expect(clickedLink.text).toContain('第二页正文')
    await executeBrowserAction({ action: 'close', pageId }, options('u1'))
  }, 30_000)

  it('只允许在搜索框输入，禁止提交表单和密码框', async () => {
    const opened = await executeBrowserAction({ action: 'open', url: `${baseUrl}/` }, options('u2'))
    const pageId = opened.pageId!
    const typed = await executeBrowserAction(
      { action: 'type', pageId, ref: element(opened, '搜索')!.ref, text: '重庆' },
      options('u2'),
    )
    expect(typed.elements.some((item) => item.value === '重庆')).toBe(true)

    await expect(
      executeBrowserAction(
        { action: 'type', pageId, ref: element(opened, '密码')!.ref, text: 'secret' },
        options('u2'),
      ),
    ).rejects.toMatchObject({ code: EC.VALIDATION })

    await expect(
      executeBrowserAction(
        { action: 'click', pageId, ref: element(opened, '提交')!.ref },
        options('u2'),
      ),
    ).rejects.toMatchObject({ code: EC.VALIDATION })
    await executeBrowserAction({ action: 'close', pageId }, options('u2'))
  })

  it('截图落到回调存储，并返回文件元数据', async () => {
    const opened = await executeBrowserAction({ action: 'open', url: `${baseUrl}/` }, options('u3'))
    const shot = await executeBrowserAction(
      { action: 'screenshot', pageId: opened.pageId!, fullPage: true },
      options('u3'),
    )
    expect(shot.screenshot?.size).toBeGreaterThan(0)
    expect(shot.screenshot?.mime).toBe('image/png')
    expect(shot.screenshot?.name).toMatch(/^浏览器截图-.*\.png$/)
    await executeBrowserAction({ action: 'close', pageId: opened.pageId! }, options('u3'))
  })

  it('不同用户不能操作彼此页面', async () => {
    const opened = await executeBrowserAction({ action: 'open', url: `${baseUrl}/` }, options('u4'))
    await expect(
      executeBrowserAction({ action: 'snapshot', pageId: opened.pageId! }, options('u5')),
    ).rejects.toMatchObject({ code: EC.FORBIDDEN })
    await executeBrowserAction({ action: 'close', pageId: opened.pageId! }, options('u4'))
  })

  it('默认拒绝本机/内网地址', async () => {
    await expect(
      executeBrowserAction(
        { action: 'open', url: `${baseUrl}/` },
        { ...options('u6'), allowPrivateNetwork: false, allowedPorts: [] },
      ),
    ).rejects.toBeInstanceOf(EabError)
  })

  it('页面 id 过期后给出明确错误', async () => {
    await expect(
      executeBrowserAction({ action: 'snapshot', pageId: 'bp_not_exists' }, options('u7')),
    ).rejects.toMatchObject({ code: EC.NOT_FOUND })
  })

  it('浏览器代理解析支持专用变量、鉴权和 NO_PROXY', () => {
    expect(browserProxyConfig({})).toBeNull()
    expect(
      browserProxyConfig({
        EAB_BROWSER_PROXY: 'http://user:pass@127.0.0.1:7890',
        EAB_NO_PROXY: 'localhost,127.0.0.1',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      server: 'http://127.0.0.1:7890',
      bypass: 'localhost,127.0.0.1',
      username: 'user',
      password: 'pass',
    })
    expect(browserProxyConfig({ EAB_HTTP_PROXY: '127.0.0.1:7890' } as NodeJS.ProcessEnv)).toEqual({
      server: 'http://127.0.0.1:7890',
    })
    expect(() => browserProxyConfig({ EAB_BROWSER_PROXY: 'socks5://127.0.0.1:1080' } as NodeJS.ProcessEnv)).toThrow(
      EabError,
    )
  })
})
