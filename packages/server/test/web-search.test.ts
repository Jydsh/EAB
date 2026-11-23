import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EC } from '@eab/domain'
import { clearWebSearchCache, searchWeb, webSearchStatus } from '../src/web-search.js'

beforeEach(() => clearWebSearchCache())

function mockJson(value: unknown): typeof import('../src/net-policy.js').fetchJson {
  return (async () => value) as typeof import('../src/net-policy.js').fetchJson
}

describe('互联网搜索', () => {
  it('未配置 provider 时返回明确提示，不抛工具失败', async () => {
    const result = await searchWeb({ query: '重庆 规划' }, { env: {} })
    expect(result).toMatchObject({ configured: false, provider: 'none', results: [], total: 0 })
    expect(result.hint).toContain('搜索服务未配置')
  })

  it('SearXNG 映射结果、限定站点并去重', async () => {
    const request = vi.fn(mockJson({
      results: [
        { title: '结果一', url: 'https://a.example/1', content: '摘要一', publishedDate: '2026-11-20' },
        { title: '结果一重复', url: 'https://a.example/1', content: '重复', publishedDate: '2026-11-20' },
        { title: '结果二', url: 'https://b.example/2', content: '摘要二' },
        { title: '', url: 'https://empty.example/', content: '空标题' },
      ],
    }))
    const result = await searchWeb(
      { query: '重庆 规划', count: 2, site: 'https://gov.cn/news', freshness: 'week' },
      { env: { EAB_WEB_SEARCH_PROVIDER: 'searxng', EAB_SEARXNG_URL: 'http://127.0.0.1:8080' }, fetchJsonImpl: request },
    )

    expect(request).toHaveBeenCalledOnce()
    const endpoint = new URL(request.mock.calls[0][0] as string)
    expect(endpoint.pathname).toBe('/search')
    expect(endpoint.searchParams.get('q')).toBe('重庆 规划 site:gov.cn')
    expect(endpoint.searchParams.get('format')).toBe('json')
    expect(endpoint.searchParams.get('time_range')).toBe('week')
    expect(result.results).toHaveLength(2)
    expect(result.results[0]).toMatchObject({ title: '结果一', site: 'a.example' })
  })

  it('“今天/今日 + 具体日期”去掉冗余日期，避免变成日历搜索', async () => {
    const request = vi.fn(mockJson({ results: [] }))
    await searchWeb(
      { query: '今天新闻 2026-11-23', freshness: 'day' },
      { env: { EAB_WEB_SEARCH_PROVIDER: 'searxng', EAB_SEARXNG_URL: 'http://127.0.0.1:8080' }, fetchJsonImpl: request },
    )
    const endpoint = new URL(request.mock.calls[0][0] as string)
    expect(endpoint.searchParams.get('q')).toBe('今天新闻')
  })

  it('SearXNG 时间窗被上游过滤成空时自动放宽并标注', async () => {
    const request = vi.fn(async (url: string) => {
      const endpoint = new URL(url)
      return endpoint.searchParams.has('time_range')
        ? { results: [] }
        : { results: [{ title: '放宽结果', url: 'https://example.com/news', content: '摘要' }] }
    }) as unknown as typeof import('../src/net-policy.js').fetchJson
    const result = await searchWeb(
      { query: '今天新闻', count: 1, freshness: 'day' },
      { env: { EAB_WEB_SEARCH_PROVIDER: 'searxng', EAB_SEARXNG_URL: 'http://127.0.0.1:8080' }, fetchJsonImpl: request },
    )

    expect(request).toHaveBeenCalledTimes(2)
    expect(result.results[0]).toMatchObject({ title: '放宽结果' })
    expect(result.hint).toContain('已放宽为不限时间')
  })

  it('博查按官方字段映射，缺少 Key 时提示配置', async () => {
    const request = mockJson({
      data: {
        webPages: {
          value: [
            {
              name: '博查结果',
              url: 'https://example.com/a',
              summary: '摘要',
              datePublished: '2026-11-18T10:00:00+08:00',
              siteName: '示例站',
            },
          ],
        },
      },
    })
    const missing = await searchWeb({ query: '测试' }, { env: { EAB_WEB_SEARCH_PROVIDER: 'bocha' }, fetchJsonImpl: request })
    expect(missing.configured).toBe(false)
    expect(missing.hint).toContain('EAB_BOCHA_API_KEY')

    const result = await searchWeb(
      { query: '测试', count: 1 },
      { env: { EAB_WEB_SEARCH_PROVIDER: 'bocha', EAB_BOCHA_API_KEY: 'key' }, fetchJsonImpl: request },
    )
    expect(result.results[0]).toMatchObject({ title: '博查结果', site: '示例站', publishedAt: '2026-11-18T10:00:00+08:00' })
  })

  it('相同查询命中缓存，不重复请求', async () => {
    const request = vi.fn(mockJson({ results: [{ title: 'A', url: 'https://a.example/', content: 'S' }] }))
    const options = {
      env: { EAB_WEB_SEARCH_PROVIDER: 'searxng' as const, EAB_SEARXNG_URL: 'http://127.0.0.1:8080' },
      fetchJsonImpl: request,
    }
    await searchWeb({ query: '缓存' }, options)
    await searchWeb({ query: '缓存' }, options)
    expect(request).toHaveBeenCalledOnce()
  })

  it('provider 未实现或返回错误时给出错误码', async () => {
    const request = (async () => {
      const error = new Error('boom')
      throw Object.assign(error, { code: EC.UPSTREAM })
    }) as unknown as typeof import('../src/net-policy.js').fetchJson

    await expect(
      searchWeb(
        { query: '错误' },
        { env: { EAB_WEB_SEARCH_PROVIDER: 'tavily', EAB_TAVILY_API_KEY: 'key' }, fetchJsonImpl: request },
      ),
    ).rejects.toBeTruthy()
  })

  it('状态摘要不回显密钥', () => {
    expect(webSearchStatus({})).toMatchObject({ provider: 'none', configured: false })
    expect(webSearchStatus({ EAB_WEB_SEARCH_PROVIDER: 'bocha', EAB_BOCHA_API_KEY: 'secret' })).toMatchObject({
      provider: 'bocha',
      configured: true,
      detail: '密钥已配置',
    })
  })
})
