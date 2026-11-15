/**
 * 登录后启动动画：全局默认 + 公司覆盖。
 *
 * - 配置：全局写 console-settings.json，公司只写 companies.settings_json.boot；
 * - 媒体：MP4 放在数据目录 boot-assets/，数据库只存公司覆盖里的 assetId；
 * - 对外：只暴露展示字段和媒体 URL，不暴露磁盘路径、上传文件名或密钥。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { EC, EabError } from '@eab/domain'
import type { Db } from '@eab/storage'
import {
  DEFAULT_BOOT_ANIMATION,
  readCompanyBoot,
  readConsoleSettings,
  writeConsoleSettings,
  type BootAnimationMode,
  type BootAnimationSettings,
  type BootPlayOn,
  type BootSurfaceSettings,
  type CompanyBootSettings,
} from './settings.js'

export const MAX_BOOT_ASSET_BYTES = 8 * 1024 * 1024
const MIN_DURATION_SEC = 0.8
const MAX_DURATION_SEC = 8

export interface BootAsset {
  id: string
  file: string
  bytes: number
  mime: 'video/mp4'
  durationSec: number
  name: string
  createdAt: string
}

export interface BootAssetFile {
  asset: BootAsset
  path: string
}

export interface PublicBootConfig {
  enabled: boolean
  mode: BootAnimationMode
  surface: 'admin' | 'chat'
  assetUrl: string | null
  assetDurationSec: number | null
  durationMax: number
  allowSound: boolean
  allowSkip: boolean
  playOn: BootPlayOn
  title: string
  subtitle: string
  revision: number
  fallbackReason?: string
}

type BootSurfaceInput = Partial<
  Pick<
    BootSurfaceSettings,
    'mode' | 'assetId' | 'durationMax' | 'allowSound' | 'allowSkip' | 'playOn' | 'title' | 'subtitle'
  >
>

export interface SaveBootInput {
  enabled?: boolean
  admin?: BootSurfaceInput
  chat?: BootSurfaceInput
}

export interface SaveCompanyBootInput {
  useGlobal?: boolean
  chat?: BootSurfaceInput
}

function bootDataDir(dataDir: string | undefined, dbPath: string): string {
  return join(dataDir || dirname(dbPath), 'boot-assets')
}

export function resolveBootDataDir(dataDir: string | undefined, dbPath: string): string {
  return bootDataDir(dataDir, dbPath)
}

function safeName(value: unknown): string {
  let raw = typeof value === 'string' ? value : ''
  try {
    raw = decodeURIComponent(raw)
  } catch {
    /* 没编码成功的名称直接按原值处理 */
  }
  raw = basename(raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return (raw || 'EAB 启动片头').slice(0, 80)
}

function isAssetId(value: unknown): value is string {
  return typeof value === 'string' && /^boot-[a-f0-9]{24}$/.test(value)
}

function normalizeText(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : ''
  return text ? text.slice(0, 60) : fallback
}

function normalizeMode(value: unknown, fallback: BootAnimationMode): BootAnimationMode {
  return value === 'off' || value === 'code' || value === 'film' ? value : fallback
}

function normalizePlayOn(value: unknown, fallback: BootPlayOn): BootPlayOn {
  return value === 'login' || value === 'new-session' || value === 'always' ? value : fallback
}

function normalizeDuration(value: unknown, fallback: number): number {
  const duration = Number(value)
  if (!Number.isFinite(duration) || duration < MIN_DURATION_SEC || duration > MAX_DURATION_SEC) {
    return fallback
  }
  return Math.round(duration * 10) / 10
}

function applySurfaceInput(current: BootSurfaceSettings, input: BootSurfaceInput | undefined): BootSurfaceSettings {
  if (!input || typeof input !== 'object') return { ...current }
  return {
    mode: normalizeMode(input.mode, current.mode),
    assetId: input.assetId === null ? null : isAssetId(input.assetId) ? input.assetId : current.assetId,
    durationMax: normalizeDuration(input.durationMax, current.durationMax),
    allowSound: input.allowSound === undefined ? current.allowSound : input.allowSound === true,
    allowSkip: input.allowSkip === undefined ? current.allowSkip : input.allowSkip === true,
    playOn: normalizePlayOn(input.playOn, current.playOn),
    title: normalizeText(input.title, current.title),
    subtitle: normalizeText(input.subtitle, current.subtitle),
  }
}

function assetPath(dir: string, assetId: string): string {
  return join(dir, `${assetId}.mp4`)
}

function metaPath(dir: string, assetId: string): string {
  return join(dir, `${assetId}.json`)
}

function readAssetMeta(dir: string, assetId: string): BootAsset | null {
  if (!isAssetId(assetId)) return null
  try {
    const raw = JSON.parse(readFileSync(metaPath(dir, assetId), 'utf8')) as Partial<BootAsset>
    const file = typeof raw.file === 'string' ? raw.file : `${assetId}.mp4`
    if (!/^boot-[a-f0-9]{24}\.mp4$/.test(file)) return null
    const bytes = Number(raw.bytes)
    const durationSec = Number(raw.durationSec)
    if (!existsSync(assetPath(dir, assetId)) || !Number.isFinite(bytes) || !Number.isFinite(durationSec)) return null
    return {
      id: assetId,
      file,
      bytes,
      mime: 'video/mp4',
      durationSec,
      name: typeof raw.name === 'string' ? raw.name : 'EAB 启动片头',
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

export function listBootAssets(dataDir: string | undefined, dbPath: string): BootAsset[] {
  const dir = bootDataDir(dataDir, dbPath)
  if (!existsSync(dir)) return []
  const assets: BootAsset[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const asset = readAssetMeta(dir, name.slice(0, -5))
    if (asset) assets.push(asset)
  }
  return assets.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function readBootAsset(
  dataDir: string | undefined,
  dbPath: string,
  assetId: string,
): BootAssetFile | null {
  const dir = bootDataDir(dataDir, dbPath)
  const asset = readAssetMeta(dir, assetId)
  if (!asset) return null
  return { asset, path: assetPath(dir, assetId) }
}

/** 删除媒体库片源；调用方需先确认没有启用中的配置引用它。 */
export function deleteBootAsset(dataDir: string | undefined, dbPath: string, assetId: string): boolean {
  const dir = bootDataDir(dataDir, dbPath)
  if (!readAssetMeta(dir, assetId)) return false
  rmSync(assetPath(dir, assetId), { force: true })
  rmSync(metaPath(dir, assetId), { force: true })
  return true
}

/** 只做轻量 MP4 头校验：ISO BMFF ftyp + moov/mvhd，不信任前端文件名或 MIME。 */
function assertMp4(bytes: Buffer): void {
  if (bytes.byteLength < 32) throw new EabError(EC.VALIDATION, '视频文件太小，不能作为片头')
  if (bytes.subarray(4, 8).toString('ascii') !== 'ftyp') {
    throw new EabError(EC.VALIDATION, '只支持 MP4 视频（缺少 ftyp 文件头）', {
      hint: '请用 H.264 MP4，并确认文件不是改扩展名的其它格式。',
    })
  }
  if (bytes.indexOf('moov') < 0) {
    throw new EabError(EC.VALIDATION, 'MP4 缺少 moov 元数据，浏览器无法播放', {
      hint: '导出时勾选“快速启动 / faststart”，或换一个标准 MP4。',
    })
  }
}

function readMvhdDuration(bytes: Buffer): number {
  const index = bytes.indexOf('mvhd')
  if (index < 0) return 0
  const payload = index + 4
  if (payload + 4 > bytes.length) return 0
  const version = bytes[payload]
  let timescale = 0
  let duration = 0
  if (version === 1) {
    if (payload + 32 > bytes.length) return 0
    timescale = bytes.readUInt32BE(payload + 20)
    duration = Number(bytes.readBigUInt64BE(payload + 24))
  } else {
    if (payload + 20 > bytes.length) return 0
    timescale = bytes.readUInt32BE(payload + 12)
    duration = bytes.readUInt32BE(payload + 16)
  }
  if (!timescale || !Number.isFinite(duration) || duration <= 0) return 0
  return Math.round((duration / timescale) * 10) / 10
}

export function saveBootAsset(
  dataDir: string | undefined,
  dbPath: string,
  bytes: Buffer,
  originalName: unknown,
): BootAsset {
  if (bytes.byteLength > MAX_BOOT_ASSET_BYTES) {
    throw new EabError(EC.VALIDATION, `片头视频不能超过 ${Math.round(MAX_BOOT_ASSET_BYTES / 1024 / 1024)} MB`)
  }
  assertMp4(bytes)
  const durationSec = readMvhdDuration(bytes)
  if (durationSec < MIN_DURATION_SEC || durationSec > MAX_DURATION_SEC) {
    throw new EabError(EC.VALIDATION, `片头时长必须在 ${MIN_DURATION_SEC}–${MAX_DURATION_SEC} 秒之间`, {
      hint: `当前识别为 ${durationSec || '未知'} 秒；建议员工端 5–6 秒、管理端 2–4 秒。`,
    })
  }
  const dir = bootDataDir(dataDir, dbPath)
  mkdirSync(dir, { recursive: true })
  const id = `boot-${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}`
  const file = `${id}.mp4`
  const target = assetPath(dir, id)
  if (!existsSync(target)) {
    const temp = join(dir, `.${file}.tmp-${process.pid}-${Date.now()}`)
    try {
      writeFileSync(temp, bytes, { mode: 0o600 })
      renameSync(temp, target)
    } catch (error) {
      try {
        if (existsSync(temp)) rmSync(temp, { force: true })
      } catch {
        // 清理失败不覆盖原始错误
      }
      throw error
    }
  }
  const asset: BootAsset = {
    id,
    file,
    bytes: bytes.byteLength,
    mime: 'video/mp4',
    durationSec,
    name: safeName(originalName),
    createdAt: new Date().toISOString(),
  }
  const tempMeta = join(dir, `.${id}.json.tmp-${process.pid}-${Date.now()}`)
  writeFileSync(tempMeta, `${JSON.stringify(asset, null, 2)}\n`, { mode: 0o600 })
  renameSync(tempMeta, metaPath(dir, id))
  return asset
}

function requireAsset(dataDir: string | undefined, dbPath: string, assetId: string | null): BootAsset {
  if (!assetId) {
    throw new EabError(EC.VALIDATION, '电影片头必须先选择一个已上传的片源', {
      hint: '先在“启动动画”里上传 MP4，或在模式里选择代码高定版。',
    })
  }
  const found = readBootAsset(dataDir, dbPath, assetId)
  if (!found) {
    throw new EabError(EC.VALIDATION, '片源不存在或已损坏，请重新上传', {
      hint: '片源被移动/删除后，配置不会生效；保存前请确认媒体库里的文件仍可用。',
    })
  }
  return found.asset
}

function readCompanySettingsRow(db: Db, companyId: string): Record<string, unknown> {
  const row = db.prepare('SELECT settings_json FROM companies WHERE id = ?').get(companyId) as
    | { settings_json?: string | null }
    | undefined
  if (!row?.settings_json) return {}
  try {
    const value = JSON.parse(row.settings_json) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    throw new EabError(EC.VALIDATION, '公司配置不是合法 JSON，请先修复后再保存启动动画', {
      hint: 'companies.settings_json 被外部写坏时，不能直接覆盖，否则会把其它配置一起丢掉。',
    })
  }
}

export function readCompanyBootSettings(db: Db, companyId: string): CompanyBootSettings {
  return readCompanyBoot(readCompanySettingsRow(db, companyId).boot)
}

export function saveCompanyBootSettings(
  db: Db,
  companyId: string,
  input: SaveCompanyBootInput,
): CompanyBootSettings {
  const current = readCompanyBootSettings(db, companyId)
  const next: CompanyBootSettings = {
    useGlobal: input.useGlobal === undefined ? current.useGlobal : input.useGlobal === true,
    chat: {
      ...current.chat,
      ...(input.chat && typeof input.chat === 'object'
        ? {
            ...(input.chat.mode === undefined ? {} : { mode: normalizeMode(input.chat.mode, current.chat.mode ?? 'code') }),
            ...(input.chat.assetId === undefined
              ? {}
              : { assetId: input.chat.assetId === null ? null : isAssetId(input.chat.assetId) ? input.chat.assetId : current.chat.assetId }),
            ...(input.chat.durationMax === undefined
              ? {}
              : { durationMax: normalizeDuration(input.chat.durationMax, current.chat.durationMax ?? 6.5) }),
            ...(input.chat.allowSound === undefined ? {} : { allowSound: input.chat.allowSound === true }),
            ...(input.chat.allowSkip === undefined ? {} : { allowSkip: input.chat.allowSkip === true }),
            ...(input.chat.playOn === undefined
              ? {}
              : { playOn: normalizePlayOn(input.chat.playOn, current.chat.playOn ?? 'login') }),
            ...(input.chat.title === undefined ? {} : { title: normalizeText(input.chat.title, 'EAB') }),
            ...(input.chat.subtitle === undefined
              ? {}
              : { subtitle: normalizeText(input.chat.subtitle, '企业智能体基座') }),
          }
        : {}),
    },
  }
  const settings = readCompanySettingsRow(db, companyId)
  const nextSettings = { ...settings, boot: next }
  db.prepare('UPDATE companies SET settings_json = ? WHERE id = ?').run(JSON.stringify(nextSettings), companyId)
  return next
}

export function saveGlobalBootSettings(
  dataDir: string | undefined,
  dbPath: string,
  input: SaveBootInput,
): BootAnimationSettings {
  const current = readConsoleSettings().bootAnimation
  const next: BootAnimationSettings = {
    enabled: input.enabled === undefined ? current.enabled : input.enabled === true,
    revision: current.revision + 1,
    admin: applySurfaceInput(current.admin, input.admin),
    chat: applySurfaceInput(current.chat, input.chat),
  }
  for (const [surface, value] of [
    ['admin', next.admin],
    ['chat', next.chat],
  ] as const) {
    if (value.mode === 'film') requireAsset(dataDir, dbPath, value.assetId ?? null)
    if (value.mode === 'off') continue
    if (value.durationMax < MIN_DURATION_SEC || value.durationMax > MAX_DURATION_SEC) {
      throw new EabError(EC.VALIDATION, `${surface === 'admin' ? '管理端' : '员工端'}时长上限不合法`)
    }
  }
  writeConsoleSettings({ bootAnimation: next })
  return next
}

function effectiveSurface(
  global: BootAnimationSettings,
  company: CompanyBootSettings,
  surface: 'admin' | 'chat',
): BootSurfaceSettings {
  if (surface === 'admin') return global.admin
  return company.useGlobal ? global.chat : { ...global.chat, ...company.chat }
}

export function publicBootConfig(
  db: Db,
  companyId: string,
  dataDir: string | undefined,
  dbPath: string,
  surface: 'admin' | 'chat',
): PublicBootConfig {
  const global = readConsoleSettings().bootAnimation
  const company = readCompanyBootSettings(db, companyId)
  const selected = effectiveSurface(global, company, surface)
  const base: PublicBootConfig = {
    enabled: global.enabled,
    mode: global.enabled ? selected.mode : 'off',
    surface,
    assetUrl: null,
    assetDurationSec: null,
    durationMax: selected.durationMax,
    allowSound: selected.allowSound,
    allowSkip: selected.allowSkip,
    playOn: selected.playOn,
    title: selected.title || DEFAULT_BOOT_ANIMATION[surface].title,
    subtitle: selected.subtitle || DEFAULT_BOOT_ANIMATION[surface].subtitle,
    revision: global.revision,
  }
  if (!base.enabled || base.mode !== 'film') return base
  const asset = selected.assetId ? readBootAsset(dataDir, dbPath, selected.assetId) : null
  if (!asset) {
    return {
      ...base,
      mode: 'code',
      fallbackReason: selected.assetId ? '片源不存在或已损坏，已回退代码高定版' : '未选择片源，已回退代码高定版',
    }
  }
  return {
    ...base,
    assetUrl: `/boot/assets/${asset.asset.id}?v=${base.revision}`,
    assetDurationSec: asset.asset.durationSec,
  }
}
