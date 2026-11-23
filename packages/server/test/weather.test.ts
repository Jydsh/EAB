import { describe, expect, it } from 'vitest'
import { EC } from '@eab/domain'
import { getWeather, weatherCodeText } from '../src/weather.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const CHONGQING = {
  id: 1814906,
  name: '重庆',
  latitude: 29.56026,
  longitude: 106.55771,
  country: '中国',
  country_code: 'CN',
  admin1: '重庆市',
  admin2: '重庆市',
  timezone: 'Asia/Shanghai',
}

function forecastBody() {
  return {
    timezone: 'Asia/Shanghai',
    current: {
      time: '2026-11-22T17:00',
      temperature_2m: 16.2,
      apparent_temperature: 16.1,
      relative_humidity_2m: 74,
      precipitation: 0,
      weather_code: 3,
      wind_speed_10m: 4.3,
    },
    daily: {
      time: ['2026-11-22', '2026-11-23', '2026-11-24'],
      weather_code: [3, 53, 80],
      temperature_2m_max: [16.5, 15.9, 14.5],
      temperature_2m_min: [11.9, 13.4, 11.6],
      precipitation_probability_max: [0, 92, 99],
      sunrise: ['2026-11-22T07:23', '2026-11-23T07:24', '2026-11-24T07:25'],
      sunset: ['2026-11-22T17:55', '2026-11-23T17:55', '2026-11-24T17:55'],
    },
  }
}

function geocodeQueries(calls: string[]): string[] {
  return calls
    .filter((call) => call.includes('geocoding-api'))
    .map((call) => new URL(call).searchParams.get('name') ?? '')
}

describe('天气查询适配器', () => {
  it('先做城市地理编码，再取当前天气和三天预报', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input))
      if (String(input).includes('geocoding-api')) {
        return jsonResponse({ results: [CHONGQING] })
      }
      return jsonResponse(forecastBody())
    }) as typeof fetch

    const result = await getWeather({ location: '重庆', days: 3 }, { fetchImpl })

    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('geocoding-api.open-meteo.com')
    expect(calls[1]).toContain('api.open-meteo.com')
    expect(result.location.displayName).toBe('重庆 · 重庆市 · 中国')
    expect(result.location.timezone).toBe('Asia/Shanghai')
    expect(result.current).toMatchObject({
      weather: '阴',
      weatherCode: 3,
      temperatureC: 16.2,
      feelsLikeC: 16.1,
      humidityPercent: 74,
      precipitationMm: 0,
      windSpeedKmh: 4.3,
    })
    expect(result.daily.map((item) => item.weather)).toEqual(['阴', '毛毛雨', '小阵雨'])
    expect(result.daily.map((item) => item.highC)).toEqual([16.5, 15.9, 14.5])
    expect(result.daily.map((item) => item.precipitationProbabilityPercent)).toEqual([0, 92, 99])
    expect(result.summary).toContain('当前阴，16.2°C')
    expect(result.provider).toBe('Open-Meteo')
  })

  it('坐标输入跳过地理编码，只请求预报', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input))
      return jsonResponse(forecastBody())
    }) as typeof fetch

    const result = await getWeather({ location: '29.56, 106.56', days: 1 }, { fetchImpl })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('api.open-meteo.com')
    expect(result.location.displayName).toBe('29.56, 106.56')
    expect(result.location.source).toBe('coordinates')
    expect(result.daily).toHaveLength(1)
  })

  it('完整行政区名匹配失败时回退到上级城市，一次调用拿到结果', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      const text = String(input)
      calls.push(text)
      if (text.includes('geocoding-api')) {
        const name = new URL(text).searchParams.get('name')
        return jsonResponse({ results: name === '重庆' ? [CHONGQING] : [] })
      }
      return jsonResponse(forecastBody())
    }) as typeof fetch

    const result = await getWeather({ location: '重庆市两江新区', days: 3 }, { fetchImpl })

    expect(geocodeQueries(calls)).toEqual(['重庆市两江新区', '重庆'])
    expect(result.location).toMatchObject({
      name: '重庆',
      approximate: true,
      resolvedFrom: '重庆市两江新区',
      matchType: 'parent-city',
      note: '未精确匹配「重庆市两江新区」，按重庆全市数据参考',
    })
    expect(result.summary).toContain('未精确匹配「重庆市两江新区」')
  })

  it('区县名去掉行政区后缀后唯一命中时正常返回', async () => {
    const calls: string[] = []
    const yubei = { ...CHONGQING, name: '渝北' }
    const fetchImpl = (async (input: string | URL | Request) => {
      const text = String(input)
      calls.push(text)
      if (text.includes('geocoding-api')) {
        const name = new URL(text).searchParams.get('name')
        return jsonResponse({ results: name === '渝北' ? [yubei] : [] })
      }
      return jsonResponse(forecastBody())
    }) as typeof fetch

    const result = await getWeather({ location: '渝北区' }, { fetchImpl })

    expect(geocodeQueries(calls)).toEqual(['渝北区', '渝北'])
    expect(result.location).toMatchObject({
      name: '渝北',
      approximate: true,
      resolvedFrom: '渝北区',
      matchType: 'trimmed',
      note: '未精确匹配「渝北区」，按「渝北」的数据参考',
    })
  })

  it('去后缀后出现多个同名地点时拒绝猜测', async () => {
    const ambiguous = [
      { ...CHONGQING, name: '天河', admin1: '福建省', admin2: '漳州市' },
      { ...CHONGQING, name: '天河', admin1: '浙江省', admin2: '温州市' },
    ]
    const fetchImpl = (async (input: string | URL | Request) => {
      const text = String(input)
      if (text.includes('geocoding-api')) {
        const name = new URL(text).searchParams.get('name')
        return jsonResponse({ results: name === '天河' ? ambiguous : [] })
      }
      return jsonResponse(forecastBody())
    }) as typeof fetch

    await expect(getWeather({ location: '天河区' }, { fetchImpl })).rejects.toMatchObject({
      code: EC.VALIDATION,
      message: expect.stringContaining('没有找到'),
    })
  })

  it('找不到城市时明确报校验错误，不返回假数据', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ results: [] })) as unknown as typeof fetch

    await expect(getWeather({ location: '不存在的地名' }, { fetchImpl })).rejects.toMatchObject({
      code: EC.VALIDATION,
      message: expect.stringContaining('没有找到'),
    })
  })

  it('上游失败时返回 502 错误，HTTP 错误不重试', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return jsonResponse({ error: true }, 503)
    }) as unknown as typeof fetch

    await expect(getWeather({ location: '重庆' }, { fetchImpl })).rejects.toMatchObject({
      code: EC.UPSTREAM,
      message: expect.stringContaining('HTTP 503'),
    })
    expect(calls).toBe(1)
  })

  it('预报首次超时后自动重试一次并返回结果', async () => {
    let forecastCalls = 0
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes('geocoding-api')) {
        return jsonResponse({ results: [CHONGQING] })
      }
      forecastCalls += 1
      if (forecastCalls === 1) {
        const error = new Error('The operation was aborted due to timeout')
        error.name = 'TimeoutError'
        throw error
      }
      return jsonResponse(forecastBody())
    }) as typeof fetch

    const result = await getWeather({ location: '重庆', days: 3 }, { fetchImpl })

    expect(forecastCalls).toBe(2)
    expect(result.current.weather).toBe('阴')
    expect(result.daily).toHaveLength(3)
  })

  it('重试后仍超时返回中文上游错误，不泄露底层英文错误', async () => {
    let forecastCalls = 0
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes('geocoding-api')) {
        return jsonResponse({ results: [CHONGQING] })
      }
      forecastCalls += 1
      const error = new Error('The operation was aborted due to timeout')
      error.name = 'TimeoutError'
      throw error
    }) as typeof fetch

    await expect(getWeather({ location: '重庆', days: 3 }, { fetchImpl })).rejects.toMatchObject({
      code: EC.UPSTREAM,
      message: expect.stringContaining('天气服务请求超时'),
    })
    expect(forecastCalls).toBe(2)
  })

  it('校验天数范围，非法参数不发起外部请求', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return jsonResponse({ results: [CHONGQING] })
    }) as unknown as typeof fetch

    await expect(getWeather({ location: '重庆', days: 0 }, { fetchImpl })).rejects.toMatchObject({
      code: EC.VALIDATION,
      message: expect.stringContaining('1–7'),
    })
    expect(called).toBe(false)
  })

  it('WMO 天气代码映射为中文', () => {
    expect(weatherCodeText(0)).toBe('晴')
    expect(weatherCodeText(3)).toBe('阴')
    expect(weatherCodeText(61)).toBe('小雨')
    expect(weatherCodeText(95)).toBe('雷暴')
    expect(weatherCodeText(999)).toBe('天气代码 999')
  })
})
