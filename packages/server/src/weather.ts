import { EC, EabError } from '@eab/domain'

/**
 * 天气查询适配器。
 *
 * 默认使用 Open-Meteo 的公开接口：不需要 API Key，先做城市地理编码，再取当前天气和
 * 1–7 天预报。接口是外部边界，失败时明确返回错误，不伪造天气数据。
 */

const GEOCODE_ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/forecast'
const REQUEST_TIMEOUT_MS = 8_000
const REQUEST_RETRY_DELAY_MS = 350
const MAX_REQUEST_ATTEMPTS = 2
const MAX_LOCATION_LENGTH = 80

export interface WeatherInput {
  location: string
  days?: number
}

export interface WeatherFetchOptions {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export interface WeatherLocation {
  name: string
  displayName: string
  country?: string
  admin1?: string
  admin2?: string
  latitude: number
  longitude: number
  timezone: string
  source: 'geocoding' | 'coordinates'
  /** 区县名无法直接匹配时，是否回退到了上级城市或去掉行政区后缀 */
  approximate?: boolean
  /** 用户原始输入，仅回退时返回 */
  resolvedFrom?: string
  /** 回退说明，直接给模型解释数据口径 */
  note?: string
  /** 命中方式：精确、上级城市、去后缀 */
  matchType?: 'exact' | 'parent-city' | 'trimmed'
}

export interface WeatherCurrent {
  time: string
  weather: string
  weatherCode: number
  temperatureC: number
  feelsLikeC: number
  humidityPercent: number
  precipitationMm: number
  windSpeedKmh: number
}

export interface WeatherDaily {
  date: string
  weather: string
  weatherCode: number
  highC: number
  lowC: number
  precipitationProbabilityPercent: number | null
  sunrise: string | null
  sunset: string | null
}

export interface WeatherResult {
  location: WeatherLocation
  current: WeatherCurrent
  daily: WeatherDaily[]
  summary: string
  provider: 'Open-Meteo'
  updatedAt: string
}

interface GeocodeResult {
  name: string
  latitude: number
  longitude: number
  country?: string
  country_code?: string
  admin1?: string
  admin2?: string
  timezone?: string
}

interface GeocodeResponse {
  results?: GeocodeResult[]
}

interface GeocodeCandidate {
  query: string
  kind: 'exact' | 'parent-city' | 'trimmed'
}

/** 行政区后缀，按从长到短排列，避免“新区”被“区”先截断。 */
const ADMIN_SUFFIX =
  /(?:特别行政区|自治区|自治州|自治县|自治旗|高新区|开发区|新区|地区|市辖区|省|市|区|县|旗|盟)$/u

interface ForecastResponse {
  timezone?: string
  current?: {
    time?: string
    temperature_2m?: number
    apparent_temperature?: number
    relative_humidity_2m?: number
    precipitation?: number
    weather_code?: number
    wind_speed_10m?: number
  }
  daily?: {
    time?: string[]
    weather_code?: number[]
    temperature_2m_max?: number[]
    temperature_2m_min?: number[]
    precipitation_probability_max?: Array<number | null>
    sunrise?: string[]
    sunset?: string[]
  }
}

/** WMO 天气代码的中文可读描述。 */
const WEATHER_CODE_TEXT: Record<number, string> = {
  0: '晴',
  1: '大部晴朗',
  2: '多云',
  3: '阴',
  45: '有雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '强阵雪',
  95: '雷暴',
  96: '雷暴伴小冰雹',
  99: '雷暴伴大冰雹',
}

export function weatherCodeText(code: number | null | undefined): string {
  if (code === null || code === undefined || !Number.isFinite(code)) return '未知天气'
  return WEATHER_CODE_TEXT[Number(code)] ?? `天气代码 ${Number(code)}`
}

function uniqueParts(parts: Array<string | null | undefined>): string[] {
  return parts
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .filter((part, index, all) => all.indexOf(part) === index)
}

function locationFromCoordinates(text: string): { latitude: number; longitude: number } | null {
  const match = text.match(/^\s*([-+]?\d{1,3}(?:\.\d+)?)\s*[,，\s]\s*([-+]?\d{1,3}(?:\.\d+)?)\s*$/)
  if (!match) return null
  const latitude = Number(match[1])
  const longitude = Number(match[2])
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new EabError(EC.VALIDATION, '坐标范围不正确：纬度需在 -90~90，经度需在 -180~180')
  }
  return { latitude, longitude }
}

function displayName(result: GeocodeResult): string {
  return uniqueParts([result.name, result.admin1, result.admin2, result.country]).join(' · ')
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name?: unknown }).name ?? '')
    : ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}

function isTimeoutError(error: unknown): boolean {
  const name = errorName(error)
  return name === 'AbortError' || name === 'TimeoutError' || /timed? ?out|aborted/i.test(errorMessage(error))
}

function isRetryableTransportError(error: unknown): boolean {
  if (isTimeoutError(error)) return true
  return /fetch failed|network|socket|ECONN|ETIMEDOUT|EAI_AGAIN|terminated/i.test(errorMessage(error))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 外部天气接口偶发连接超时；超时/网络错误重试一次，HTTP 4xx/5xx 不重试。 */
async function fetchWeatherJson<T>(
  url: URL,
  what: string,
  options: WeatherFetchOptions,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    if (options.signal?.aborted) throw new EabError(EC.CONFLICT, '天气查询已取消')
    try {
      const response = await (options.fetchImpl ?? fetch)(url, {
        signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) throw new EabError(EC.UPSTREAM, `${what}返回 HTTP ${response.status}`)
      try {
        return (await response.json()) as T
      } catch {
        throw new EabError(EC.UPSTREAM, `${what}返回了无法解析的数据`)
      }
    } catch (error) {
      if (options.signal?.aborted) throw new EabError(EC.CONFLICT, '天气查询已取消')
      // HTTP 状态错误已经说明上游可达，不再重试；只恢复连接超时和网络错误。
      if (error instanceof EabError) throw error
      lastError = error
      if (!isRetryableTransportError(error) || attempt === MAX_REQUEST_ATTEMPTS) {
        throw new EabError(
          EC.UPSTREAM,
          isTimeoutError(error) ? `${what}请求超时，请稍后重试` : `无法连接${what}，请稍后重试`,
          { cause: error },
        )
      }
      await sleep(REQUEST_RETRY_DELAY_MS)
    }
  }
  throw new EabError(EC.UPSTREAM, `${what}请求失败，请稍后重试`, { cause: lastError })
}

/**
 * 生成地理编码候选。
 *
 * Open-Meteo 对“重庆市两江新区”这类完整行政区名匹配很差，但“重庆”可以命中；
 * 因此在精确查询失败后，按“上级城市 → 去掉行政区后缀”回退，避免模型收到错误后
 * 再重复调用一次天气工具。回退结果会带 approximate/note，不伪装成精确命中。
 */
function locationCandidates(text: string): GeocodeCandidate[] {
  const candidates: GeocodeCandidate[] = [{ query: text, kind: 'exact' }]
  const seen = new Set<string>([text])
  const add = (query: string, kind: GeocodeCandidate['kind']): void => {
    const clean = query.trim()
    if (!clean || clean.length < 2 || seen.has(clean)) return
    seen.add(clean)
    candidates.push({ query: clean, kind })
  }

  // “重庆市两江新区”优先回退到“重庆”，比丢掉“两江”更安全。
  const cityIndex = text.indexOf('市')
  if (cityIndex >= 2 && cityIndex <= 8) {
    add(text.slice(0, cityIndex), 'parent-city')
  }

  // “渝北区”可回退到“渝北”；“天河”这类多义结果会在 pickGeocodeResult 中拒绝。
  let trimmed = text
  for (let i = 0; i < 4; i += 1) {
    const match = trimmed.match(ADMIN_SUFFIX)
    if (!match || match.index === undefined || match.index < 2) break
    trimmed = trimmed.slice(0, match.index)
    add(trimmed, 'trimmed')
  }

  return candidates
}

function pickGeocodeResult(results: GeocodeResult[], candidate: GeocodeCandidate): GeocodeResult | undefined {
  const cnResults = results.filter((result) => result.country_code === 'CN')
  const pool = cnResults.length > 0 ? cnResults : results
  if (candidate.kind === 'exact') return pool[0]

  const haystack = (result: GeocodeResult): string =>
    [result.name, result.admin1, result.admin2, result.country].filter(Boolean).join(' ')
  if (candidate.kind === 'parent-city') {
    return pool.find((result) => haystack(result).includes(candidate.query))
  }

  // 去掉“区/县”后的短名可能对应多个地方（例如“天河”），只有唯一中国结果才接受。
  return cnResults.length === 1 ? cnResults[0] : undefined
}

async function geocode(query: string, options: WeatherFetchOptions): Promise<GeocodeResult[]> {
  const url = new URL(GEOCODE_ENDPOINT)
  url.searchParams.set('name', query)
  url.searchParams.set('count', '5')
  url.searchParams.set('language', 'zh')
  url.searchParams.set('format', 'json')
  const data = await fetchWeatherJson<GeocodeResponse>(url, '城市查询服务', options)
  return data.results ?? []
}

async function resolveLocation(
  rawLocation: string,
  options: WeatherFetchOptions,
): Promise<WeatherLocation> {
  const trimmed = rawLocation.trim()
  if (!trimmed) throw new EabError(EC.VALIDATION, 'location 不能为空，请提供城市或区县名')
  if (trimmed.length > MAX_LOCATION_LENGTH) {
    throw new EabError(EC.VALIDATION, `location 过长，最多 ${MAX_LOCATION_LENGTH} 个字符`)
  }

  const coordinates = locationFromCoordinates(trimmed)
  if (coordinates) {
    return {
      name: `${coordinates.latitude}, ${coordinates.longitude}`,
      displayName: `${coordinates.latitude}, ${coordinates.longitude}`,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      timezone: 'auto',
      source: 'coordinates',
    }
  }

  for (const candidate of locationCandidates(trimmed)) {
    const results = await geocode(candidate.query, options)
    const picked = pickGeocodeResult(results, candidate)
    if (!picked) continue
    if (!Number.isFinite(picked.latitude) || !Number.isFinite(picked.longitude)) {
      throw new EabError(EC.UPSTREAM, `城市查询服务没有返回「${candidate.query}」的经纬度`)
    }
    const resolvedName = displayName(picked) || picked.name
    const approximate = candidate.kind !== 'exact'
    const note = approximate
      ? candidate.kind === 'parent-city'
        ? `未精确匹配「${trimmed}」，按${candidate.query}全市数据参考`
        : `未精确匹配「${trimmed}」，按「${candidate.query}」的数据参考`
      : undefined
    return {
      name: picked.name,
      displayName: resolvedName,
      country: picked.country,
      admin1: picked.admin1,
      admin2: picked.admin2,
      latitude: picked.latitude,
      longitude: picked.longitude,
      timezone: picked.timezone || 'auto',
      source: 'geocoding',
      approximate,
      resolvedFrom: approximate ? trimmed : undefined,
      note,
      matchType: candidate.kind,
    }
  }

  throw new EabError(EC.VALIDATION, `没有找到「${trimmed}」，请补充省份或换成更常见的城市名`, {
    details: { location: trimmed },
  })
}

function normalizeDays(days: number | undefined): number {
  const value = days === undefined ? 3 : Math.trunc(Number(days))
  if (!Number.isFinite(value) || value < 1 || value > 7) {
    throw new EabError(EC.VALIDATION, 'days 必须是 1–7 的整数')
  }
  return value
}

function requireNumber(value: unknown, what: string): number {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new EabError(EC.UPSTREAM, `天气服务没有返回有效的${what}`)
  return number
}

export async function getWeather(
  input: WeatherInput,
  options: WeatherFetchOptions = {},
): Promise<WeatherResult> {
  const days = normalizeDays(input.days)
  const location = await resolveLocation(String(input.location ?? ''), options)

  const url = new URL(FORECAST_ENDPOINT)
  url.searchParams.set('latitude', String(location.latitude))
  url.searchParams.set('longitude', String(location.longitude))
  url.searchParams.set(
    'current',
    'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
  )
  url.searchParams.set(
    'daily',
    'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
  )
  url.searchParams.set('timezone', location.timezone)
  url.searchParams.set('forecast_days', String(days))

  const data = await fetchWeatherJson<ForecastResponse>(url, '天气服务', options)
  const current = data.current
  if (!current) throw new EabError(EC.UPSTREAM, '天气服务没有返回当前天气')

  const currentWeatherCode = requireNumber(current.weather_code, '天气代码')
  const currentWeather: WeatherCurrent = {
    time: String(current.time ?? ''),
    weather: weatherCodeText(currentWeatherCode),
    weatherCode: currentWeatherCode,
    temperatureC: requireNumber(current.temperature_2m, '当前温度'),
    feelsLikeC: requireNumber(current.apparent_temperature, '体感温度'),
    humidityPercent: requireNumber(current.relative_humidity_2m, '湿度'),
    precipitationMm: requireNumber(current.precipitation, '降水量'),
    windSpeedKmh: requireNumber(current.wind_speed_10m, '风速'),
  }

  const dailyData = data.daily
  const dailyDates = dailyData?.time ?? []
  const daily: WeatherDaily[] = dailyDates.slice(0, days).map((date, index) => {
    const code = dailyData?.weather_code?.[index]
    return {
      date,
      weather: weatherCodeText(code),
      weatherCode: Number(code ?? 0),
      highC: Number(dailyData?.temperature_2m_max?.[index] ?? 0),
      lowC: Number(dailyData?.temperature_2m_min?.[index] ?? 0),
      precipitationProbabilityPercent:
        dailyData?.precipitation_probability_max?.[index] === null ||
        dailyData?.precipitation_probability_max?.[index] === undefined
          ? null
          : Number(dailyData.precipitation_probability_max[index]),
      sunrise: dailyData?.sunrise?.[index] ?? null,
      sunset: dailyData?.sunset?.[index] ?? null,
    }
  })

  const dailySummary = daily
    .map((item) => `${item.date} ${item.weather} ${item.lowC}~${item.highC}°C`)
    .join('；')
  const summaryLead = location.note ? `${location.note}：` : ''
  const summary = `${summaryLead}${location.displayName}当前${currentWeather.weather}，${currentWeather.temperatureC}°C，体感${currentWeather.feelsLikeC}°C，湿度${currentWeather.humidityPercent}%。未来${days}天：${dailySummary}`

  return {
    location: {
      ...location,
      timezone: data.timezone || location.timezone,
    },
    current: currentWeather,
    daily,
    summary,
    provider: 'Open-Meteo',
    updatedAt: new Date().toISOString(),
  }
}
