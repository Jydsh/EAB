import { describe, expect, it } from 'vitest'
import {
  buildOfficeEditorConfig,
  buildOfficePluginConfig,
  forceSaveOfficeDocument,
  officeDocumentKey,
  officeDocumentType,
  officeScriptUrl,
  signOfficeJwt,
  verifyOfficeJwt,
} from '../src/onlyoffice.js'

const secret = 'test-onlyoffice-secret-0123456789abcdef'

function decodeJwtPart(token: string, index = 1): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[index], 'base64url').toString('utf8')) as Record<string, unknown>
}

describe('OnlyOffice 接入辅助', () => {
  it('按扩展名识别 Word / Excel / PPT', () => {
    expect(officeDocumentType('方案.docx')).toBe('word')
    expect(officeDocumentType('报表.xlsx')).toBe('cell')
    expect(officeDocumentType('汇报.pptx')).toBe('slide')
    expect(officeDocumentType('说明.pdf')).toBeNull()
    expect(officeDocumentType('无扩展名', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(
      'word',
    )
  })

  it('文档 key 随文件版本变化，同一版本稳定', () => {
    expect(officeDocumentKey('f1', 100)).toBe(officeDocumentKey('f1', 100))
    expect(officeDocumentKey('f1', 100)).not.toBe(officeDocumentKey('f1', 101))
  })

  it('生成带签名的编辑器配置，只读模式关闭编辑权限', () => {
    const config = buildOfficeEditorConfig({
      fileId: 'f1',
      fileName: '方案.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      updatedAt: 100,
      userId: 'u1',
      userName: '李鹏',
      mode: 'view',
      contentUrl: 'http://host.docker.internal:8787/content',
      callbackUrl: 'http://host.docker.internal:8787/callback',
      secret,
    })
    expect(config.documentType).toBe('word')
    expect(config.editorConfig.mode).toBe('view')
    expect(config.document.permissions).toMatchObject({ edit: false })
    const payload = decodeJwtPart(config.token)
    expect(payload.documentType).toBe('word')
    expect(payload.token).toBeUndefined()
    expect(officeScriptUrl('http://127.0.0.1:8080/')).toBe(
      'http://127.0.0.1:8080/web-apps/apps/api/documents/api.js',
    )
  })

  it('只有传入插件配置时才注入 autostart 和 pluginsData', () => {
    const base = {
      fileId: 'f1',
      fileName: '方案.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      updatedAt: 100,
      userId: 'u1',
      userName: '李鹏',
      mode: 'edit' as const,
      contentUrl: 'http://host.docker.internal:8787/content',
      callbackUrl: 'http://host.docker.internal:8787/callback',
      secret,
    }
    const plain = buildOfficeEditorConfig(base)
    expect(plain.editorConfig.plugins).toBeUndefined()

    const withPlugin = buildOfficeEditorConfig({
      ...base,
      pluginConfigUrl: 'http://127.0.0.1:8787/api/workspace/office/plugin/config?token=p1',
    })
    expect(withPlugin.editorConfig.plugins).toMatchObject({
      autostart: ['asc.{EAB00001-0000-4000-8000-000000000001}'],
      pluginsData: ['http://127.0.0.1:8787/api/workspace/office/plugin/config?token=p1'],
    })
    const payload = decodeJwtPart(withPlugin.token)
    expect((payload.editorConfig as Record<string, unknown>).plugins).toEqual(withPlugin.editorConfig.plugins)
  })

  it('插件 config.json 用绝对入口并保留短期 token', () => {
    const config = buildOfficePluginConfig('plugin-token', 'word')
    expect(config.guid).toBe('asc.{EAB00001-0000-4000-8000-000000000001}')
    expect(config).not.toHaveProperty('baseUrl')
    expect(config.variations).toEqual([
      expect.objectContaining({
        type: 'panelRight',
        url: 'index.html?token=plugin-token',
        icons: ['icon.png'],
        EditorsSupport: ['word'],
      }),
    ])
  })

  it('xlsx 插件 config.json 声明 cell 编辑器并保留 token', () => {
    const config = buildOfficePluginConfig('plugin-token', 'cell')
    expect(config.variations).toEqual([
      expect.objectContaining({
        type: 'panelRight',
        url: 'index.html?token=plugin-token',
        EditorsSupport: ['cell'],
      }),
    ])
  })

  it('pptx 插件 config.json 声明 slide 编辑器并保留 token', () => {
    const config = buildOfficePluginConfig('plugin-token', 'slide')
    expect(config.variations).toEqual([
      expect.objectContaining({
        type: 'panelRight',
        url: 'index.html?token=plugin-token',
        EditorsSupport: ['slide'],
      }),
    ])
  })

  it('无 token 的插件元数据同时支持 word、cell 和 slide', () => {
    const config = buildOfficePluginConfig('')
    expect(config.variations).toEqual([
      expect.objectContaining({
        EditorsSupport: ['word', 'cell', 'slide'],
        url: 'index.html?token=',
      }),
    ])
  })

  it('签名令牌可校验，篡改和过期都会被拒绝', () => {
    const now = Math.floor(Date.now() / 1000)
    const token = signOfficeJwt(
      {
        kind: 'callback',
        fileId: 'f1',
        companyId: 'c1',
        userId: 'u1',
        mode: 'edit',
        version: 100,
        iat: now,
        exp: now + 60,
      },
      secret,
    )
    expect(verifyOfficeJwt(token, secret)).toMatchObject({ kind: 'callback', fileId: 'f1' })
    expect(verifyOfficeJwt(`${token.slice(0, -1)}x`, secret)).toBeNull()
    const expired = signOfficeJwt(
      {
        kind: 'content',
        fileId: 'f1',
        companyId: 'c1',
        userId: 'u1',
        mode: 'view',
        version: 100,
        iat: now - 120,
        exp: now - 60,
      },
      secret,
    )
    expect(verifyOfficeJwt(expired, secret)).toBeNull()
  })

  it('强制保存调用 /command 并携带 forcesave JWT', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const result = await forceSaveOfficeDocument({
      url: 'http://documentserver:8080/',
      secret,
      key: 'doc-key-1',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        return new Response(JSON.stringify({ error: 0, key: 'doc-key-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
    })
    expect(result).toMatchObject({ error: 0, key: 'doc-key-1', noChanges: false })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://documentserver:8080/command?shardkey=doc-key-1')
    const body = JSON.parse(String(calls[0].init?.body)) as { c?: string; key?: string; token?: string }
    expect(body).toMatchObject({ c: 'forcesave', key: 'doc-key-1' })
    expect(decodeJwtPart(String(body.token))).toMatchObject({ c: 'forcesave', key: 'doc-key-1' })
  })

  it('/command 返回 404 时回退旧命令地址，错误 4 表示没有修改', async () => {
    const calls: string[] = []
    const result = await forceSaveOfficeDocument({
      url: 'http://documentserver:8080',
      secret,
      key: 'doc-key-2',
      fetchImpl: (async (url: string) => {
        calls.push(url)
        if (url.includes('/coauthoring/CommandService.ashx')) {
          return new Response(JSON.stringify({ error: 4, key: 'doc-key-2' }), { status: 200 })
        }
        return new Response('not found', { status: 404 })
      }) as typeof fetch,
    })
    expect(calls).toEqual([
      'http://documentserver:8080/command?shardkey=doc-key-2',
      'http://documentserver:8080/coauthoring/CommandService.ashx?shardkey=doc-key-2',
    ])
    expect(result).toMatchObject({ error: 4, noChanges: true, message: '没有需要保存的修改' })
  })
})
