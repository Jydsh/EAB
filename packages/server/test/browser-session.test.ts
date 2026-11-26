import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EC, EabError } from '@eab/domain'
import {
  browserPageState,
  browserProxyConfig,
  captureBrowserPageFrame,
  captureBrowserPageStorageState,
  clickBrowserPageAt,
  closeBrowserRuntime,
  executeBrowserAction,
  fillBrowserPageCredentials,
  pressBrowserPageKey,
  scrollBrowserPageBy,
  typeBrowserPageText,
  type BrowserResult,
  type BrowserRuntimeOptions,
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
  <input type="email" name="u" placeholder="账号">
  <input type="password" name="p" placeholder="密码">
  <button id="hot" style="position:fixed;left:10px;top:10px;width:80px;height:40px" onclick="document.getElementById('status').textContent='热点已点击'">热点</button>
  <input id="focus" style="position:fixed;left:10px;bottom:10px;width:260px;height:32px" aria-label="工作台输入框">
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
      if (req.url === '/qr') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          '<html><head><title>扫码登录</title></head><body><div class="qrcode-login" style="width:180px;height:180px">二维码</div></body></html>',
        )
        return
      }
      if (req.url === '/set-cookie') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'eab_session=restored; Path=/; HttpOnly',
        })
        res.end('<html><head><title>登录成功</title></head><body>已登录</body></html>')
        return
      }
      if (req.url === '/echo-cookie') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          `<html><head><title>Cookie 回显</title></head><body>${String(req.headers.cookie ?? '') || 'no-cookie'}</body></html>`,
        )
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

  function options(ownerKey: string, extra: Partial<BrowserRuntimeOptions> = {}): BrowserRuntimeOptions {
    return {
      ownerKey,
      allowPrivateNetwork: true,
      allowedPorts: [Number(new URL(baseUrl).port)],
      saveScreenshot: (buffer: Buffer, filename: string) => {
        const path = join(shotDir, filename)
        writeFileSync(path, buffer)
        return { fileId: 'wf_test', name: filename, relPath: filename, size: buffer.length, mime: 'image/png' }
      },
      ...extra,
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

  it('支持前进后退、刷新和地址栏跳转', async () => {
    const opened = await executeBrowserAction({ action: 'open', url: `${baseUrl}/` }, options('u10'))
    const pageId = opened.pageId!
    const next = await executeBrowserAction(
      { action: 'click', pageId, ref: element(opened, '下一页')!.ref },
      options('u10'),
    )
    expect(next.title).toBe('下一页')

    const back = await executeBrowserAction({ action: 'back', pageId }, options('u10'))
    expect(back.title).toBe('EAB Browser Test')
    const forward = await executeBrowserAction({ action: 'forward', pageId }, options('u10'))
    expect(forward.title).toBe('下一页')
    const reload = await executeBrowserAction({ action: 'reload', pageId }, options('u10'))
    expect(reload.title).toBe('下一页')
    const navigated = await executeBrowserAction(
      { action: 'navigate', pageId, url: `${baseUrl}/` },
      options('u10'),
    )
    expect(navigated.title).toBe('EAB Browser Test')
    await executeBrowserAction({ action: 'close', pageId }, options('u10'))
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

  it('服务端填入已保存账号密码，不自动提交', async () => {
    const opened = await executeBrowserAction({ action: 'open', url: `${baseUrl}/` }, options('u6'))
    const pageId = opened.pageId!
    const filled = await fillBrowserPageCredentials(
      pageId,
      'u6',
      'alice@example.com',
      'S3cret!',
    )
    expect(filled.action).toBe('fill')
    expect(filled.hint).toContain('已填入')
    const state = await browserPageState(pageId, 'u6')
    expect(element(state, '账号')?.value).toBe('alice@example.com')
    expect(element(state, '密码')?.value).toBe('S3cret!')
    expect(state.url).not.toContain('/submitted')
    await executeBrowserAction({ action: 'close', pageId }, options('u6'))
  }, 30_000)

  it('页面没有密码框时拒绝填入，不猜测登录表单', async () => {
    const opened = await executeBrowserAction({ action: 'open', url: `${baseUrl}/next` }, options('u7'))
    const pageId = opened.pageId!
    await expect(
      fillBrowserPageCredentials(pageId, 'u7', 'alice@example.com', 'S3cret!'),
    ).rejects.toMatchObject({ code: EC.VALIDATION })
    await executeBrowserAction({ action: 'close', pageId }, options('u7'))
  }, 30_000)

  it('识别扫码登录页并提示本人扫码，不尝试解码', async () => {
    const opened = await executeBrowserAction({ action: 'open', url: `${baseUrl}/qr` }, options('u8'))
    const pageId = opened.pageId!
    await expect(
      fillBrowserPageCredentials(pageId, 'u8', 'alice@example.com', 'S3cret!'),
    ).rejects.toMatchObject({ code: EC.VALIDATION, message: expect.stringContaining('扫码') })
    await executeBrowserAction({ action: 'close', pageId }, options('u8'))
  }, 30_000)

  it('登录态可在新上下文恢复 Cookie', async () => {
    const opened = await executeBrowserAction({ action: 'open', url: `${baseUrl}/set-cookie` }, options('u9'))
    const snapshot = await captureBrowserPageStorageState(opened.pageId!, 'u9')
    expect(JSON.stringify(snapshot.storageState)).toContain('eab_session')
    await closeBrowserRuntime()
    const restored = await executeBrowserAction(
      { action: 'open', url: `${baseUrl}/echo-cookie` },
      options('u9', { storageState: snapshot.storageState as BrowserRuntimeOptions['storageState'] }),
    )
    expect(restored.text).toContain('eab_session=restored')
    await executeBrowserAction({ action: 'close', pageId: restored.pageId! }, options('u9'))
  }, 40_000)

  it('截图落到回调存储，并返回文件元数据', async () => {    const opened = await executeBrowserAction({ action: 'open', url: `${baseUrl}/` }, options('u3'))
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

  it('工作台可以取实时帧、按坐标点击、输入和滚动', async () => {
    const opened = await executeBrowserAction({ action: 'open', url: `${baseUrl}/` }, options('u8'))
    const pageId = opened.pageId!

    const frame = await captureBrowserPageFrame(pageId, 'u8')
    expect(frame.buffer.length).toBeGreaterThan(0)
    expect(frame.width).toBe(1280)
    expect(frame.height).toBe(800)
    expect(frame.title).toBe('EAB Browser Test')

    const state = await browserPageState(pageId, 'u8')
    expect(state.action).toBe('snapshot')
    expect(state.pageId).toBe(pageId)

    const clicked = await clickBrowserPageAt(pageId, 'u8', 50, 30)
    expect(clicked.text).toContain('热点已点击')

    await clickBrowserPageAt(pageId, 'u8', 100, 770)
    const typed = await typeBrowserPageText(pageId, 'u8', '工作台')
    expect(typed.elements.some((item) => item.value === '工作台')).toBe(true)

    const keyed = await pressBrowserPageKey(pageId, 'u8', 'Backspace')
    expect(keyed.action).toBe('type')

    const scrolled = await scrollBrowserPageBy(pageId, 'u8', 120)
    expect(scrolled.action).toBe('scroll')

    await expect(captureBrowserPageFrame(pageId, 'u9')).rejects.toMatchObject({ code: EC.FORBIDDEN })
    await executeBrowserAction({ action: 'close', pageId }, options('u8'))
  }, 30_000)

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
