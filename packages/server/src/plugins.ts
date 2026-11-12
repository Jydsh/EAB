/**
 * 插件加载器（对齐 DSH 的 "everything is a plugin" 思路，但只做我们需要的部分）。
 *
 * 契约（写进文档 12.9）：
 * - 一个插件 = `plugins/<id>/` 目录，里面必须有 `plugin.json`（清单）+ 它声明的页面文件。
 * - 清单只允许声明**能力与贡献点**，不允许声明"我要拿什么权限"以外的运行时魔法：
 *   `scopes` 是它调用接口需要的权限，控制台按这个告诉管理员"装它要授什么"。
 * - 清单一律先校验再暴露；校验失败不崩服务，标记 invalid + 原因，页面上能看见。
 * - 插件页面用 iframe 隔离渲染（`/plugins/assets/<id>/<file>`），不给它主页面 DOM。
 *
 * 这一版不做的事（避免假装支持）：
 * - 不支持插件进程外运行、不支持热加载（改完要重启服务）、不支持插件自定义后端路由。
 * - 插件页面里的取数调用要走 EAB 的 HTTP API（带 `?as=` 开发预览身份），没有独立的插件后端。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pluginDataRoot, userScope } from './plugin-scope.js'
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EC, EabError, SC } from '@eab/domain'
import type { Db } from '@eab/storage'
import { readVersion } from './http.js'

export interface PluginPage {
  readonly id: string
  readonly title: string
  readonly file: string
  /** html = EAB 自带页面的静态 HTML；dsh-client = DSH 插件 client bundle，由 DSH 兼容运行时渲染 */
  readonly kind?: 'html' | 'dsh-client'
}

/** DSH 插件协议段（package.json 的 dsh 字段）归一化后的只读视图 */
export interface PluginDshInfo {
  readonly packageName: string
  /** 清单声明要挂进 reactor 的 bundle patch 文件（相对插件根） */
  readonly bundlePatch: string | null
  readonly clientInject: readonly string[]
  readonly platform: string
  /** DSH 宿主版本要求 / 允许的 profile 列表 */
  readonly compatibility: { readonly dsh: string; readonly profiles: readonly string[] } | null
  /** host 侧入口（相对插件根），存在即代表它能跑 RPC / 工具等宿主能力 */
  readonly hostEntry: string | null
  /** client 侧入口（相对插件根），存在即代表它能贡献页面 */
  readonly clientEntry: string | null
  readonly hasHost: boolean
  readonly hasClient: boolean
  /** 发布时声明的 files 白名单；安装只复制这些条目，顺手避开 .tmp / test / tgz */
  readonly files: readonly string[]
}

/** EAB 视为兼容的 DSH 宿主版本（与 D:/dsh 里两个插件声明的版本一致） */
export const EAB_DSH_COMPAT_VERSION = '0.2.1-rc.2'
/** EAB 控制台等价于 DSH 的 web profile（desktop 专属插件不装） */
export const EAB_DSH_PROFILE = 'web'

export interface PluginInstallRecord {
  readonly pluginId: string
  readonly version: string
  readonly source: string
  readonly sourceRef: string | null
  readonly checksum: string | null
  readonly installedBy: string | null
  readonly installedAt: number
  readonly updatedAt: number
  readonly removedAt: number | null
}

/** 某一家公司的安装归属；插件代码目录仍共享，隔离的是“谁装了、谁启停、谁卸载” */
export interface PluginCompanyInstallRecord {
  readonly companyId: string
  readonly pluginId: string
  readonly installedBy: string | null
  readonly installedAt: number
  readonly updatedAt: number
  readonly removedAt: number | null
}

/** 某个员工的个人安装归属；个人插件只有本人可见、本人启停、本人卸载 */
export interface PluginUserInstallRecord {
  readonly companyId: string
  readonly userId: string
  readonly pluginId: string
  readonly enabled: boolean
  readonly installedAt: number
  readonly updatedAt: number
  readonly removedAt: number | null
}

/** 管理后台只读查看的个人插件安装：按“员工 + 插件”一条，不混入公司安装。 */
export interface AdminPersonalPluginRecord {
  readonly key: string
  readonly userId: string
  readonly userName: string
  readonly pluginId: string
  readonly name: string
  readonly version: string
  readonly description: string
  readonly author: string
  readonly format: 'eab' | 'dsh'
  readonly pages: number
  readonly scopes: readonly string[]
  readonly valid: boolean
  readonly error: string | null
  readonly enabled: boolean
  readonly installedAt: number
  readonly updatedAt: number
  readonly source: string | null
}

export interface PluginRecord {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description: string
  readonly author: string
  readonly homepage: string
  readonly license: string
  readonly keywords: readonly string[]
  readonly scopes: readonly string[]
  readonly pages: readonly PluginPage[]
  /** 清单格式：EAB 原生 plugin.json，或 DSH 插件的 package.json 的 dsh 段 */
  readonly format: 'eab' | 'dsh'
  readonly dsh: PluginDshInfo | null
  readonly enabled: boolean
  readonly valid: boolean
  readonly error: string | null
  /** 绝对目录，用于拼资源路径；对外不暴露 */
  readonly dir: string
  /** 清单 + 页面内容的指纹，用来判断"磁盘上的包换了没" */
  readonly checksum: string
  /** 服务器上的安装记录；部署侧手工放目录时为空 = "已发现、未登记安装" */
  readonly install: PluginInstallRecord | null
  /** 当前公司的安装归属（由 loadPlugins 填充；未装为空） */
  readonly companyInstall?: PluginCompanyInstallRecord | null
  /** 当前员工的个人安装归属（由 loadPluginsForUser 填充；未装为空） */
  readonly userInstall?: PluginUserInstallRecord | null
}

export interface PluginEventRecord {
  readonly id: number
  readonly pluginId: string
  readonly companyId: string | null
  readonly event: string
  readonly actorId: string | null
  readonly detail: string | null
  readonly at: number
}

let pluginRootPath = process.env.EAB_PLUGINS_DIR || fileURLToPath(new URL('../../../plugins', import.meta.url))

/** 启动时由 main.ts 按「独立配置 > 总存储位置 > 内置默认」解析后注入。 */
export function setPluginRoot(path: string): void {
  pluginRootPath = path
}

function trashDir(): string {
  return join(pluginRootPath, '.trash')
}
const KNOWN_SCOPES = new Set<string>(Object.values(SC))
const ID_PATTERN = /^[a-z][a-z0-9-]{1,40}$/

/** 安装来源：浏览器上传的文件夹 / 历史本地目录 / npm 包（可换镜像）/ GitHub 仓库 */
export type PluginInstallSource = 'browser-dir' | 'local-dir' | 'npm' | 'github'

export interface PluginRegistryPreset {
  readonly id: string
  readonly label: string
  readonly url: string
  readonly hint: string
}

/** 国内常用 npm 镜像；custom 允许管理员填自建 registry */
export const PLUGIN_REGISTRIES: readonly PluginRegistryPreset[] = [
  { id: 'npm', label: 'npm 官方', url: 'https://registry.npmjs.org', hint: '海外直连，可能较慢' },
  { id: 'npmmirror', label: '淘宝 npmmirror', url: 'https://registry.npmmirror.com', hint: '国内推荐，同步快' },
  { id: 'tencent', label: '腾讯云镜像', url: 'https://mirrors.cloud.tencent.com/npm/', hint: '腾讯云内网/公网可用' },
  { id: 'huawei', label: '华为云镜像', url: 'https://repo.huaweicloud.com/repository/npm/', hint: '华为云镜像站' },
]

const NPM_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const NPM_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+~^*<>=|-]{0,63}$/
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/


interface RawManifest {
  id?: unknown
  name?: unknown
  version?: unknown
  description?: unknown
  author?: unknown
  homepage?: unknown
  license?: unknown
  keywords?: unknown
  compatibility?: unknown
  scopes?: unknown
  pages?: unknown
}

function checksumOf(dir: string, pages: readonly PluginPage[]): string {
  const hash = createHash('sha256')
  hash.update(readFileSync(join(dir, 'plugin.json'), 'utf8'))
  for (const page of [...pages].sort((a, b) => a.file.localeCompare(b.file))) {
    hash.update(page.file)
    try {
      hash.update(readFileSync(join(dir, page.file)))
    } catch {
      // 文件缺失已在校验阶段报错，这里只保证指纹不崩
    }
  }
  return hash.digest('hex').slice(0, 16)
}

/** 只支持 >= 一种比较，够用且不假装自己是完整 semver */
function eabVersionAtLeast(required: string, actual: string): boolean {
  const match = required.trim().match(/^>=\s*(\d+(?:\.\d+){0,2})$/)
  if (!match) return true
  const want = match[1].split('.').map(Number)
  const have = actual.split('.').map((item) => Number(item.replace(/[^\d].*$/, '')) || 0)
  for (let i = 0; i < Math.max(want.length, have.length); i += 1) {
    const a = want[i] ?? 0
    const b = have[i] ?? 0
    if (a !== b) return b > a
  }
  return true
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

interface RawDshClient {
  inject?: unknown
  platform?: unknown
  entry?: unknown
}

interface RawDshBundle {
  patch?: unknown
}

interface RawDshCompatibility {
  dsh?: unknown
  profiles?: unknown
}

interface RawDshSection {
  bundle?: RawDshBundle
  client?: RawDshClient
  compatibility?: RawDshCompatibility
  ui?: { pages?: unknown; title?: unknown }
}

interface RawPackageJson {
  name?: unknown
  version?: unknown
  description?: unknown
  author?: unknown
  homepage?: unknown
  license?: unknown
  keywords?: unknown
  main?: unknown
  exports?: unknown
  files?: unknown
  engines?: { node?: unknown }
  dsh?: RawDshSection
}

/** 把 npm 包名归一化成 EAB 目录 id：@scope/name → scope-name，只留 [a-z0-9-] */
function dshPluginIdOf(packageName: string): string {
  const raw = packageName
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[/@]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  const trimmed = raw.slice(0, 41).replace(/-+$/, '')
  if (!trimmed) return ''
  return /^[a-z]/.test(trimmed) ? trimmed : `p-${trimmed}`.slice(0, 41)
}

/** 只接受插件根目录内的相对路径；越界 / 绝对路径一律视为未声明 */
function insidePlugin(root: string, relativePath: string): string | null {
  const rel = relativePath.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!rel || rel.startsWith('/') || rel.includes('..') || /^[A-Za-z]:/.test(rel)) return null
  const target = resolve(root, rel)
  if (!target.startsWith(root + sep)) return null
  return rel
}

function exportEntry(exportsField: unknown, key: string): string {
  if (typeof exportsField === 'string') return key === '.' ? exportsField : ''
  if (!exportsField || typeof exportsField !== 'object') return ''
  const value = (exportsField as Record<string, unknown>)[key]
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const nested = (value as Record<string, unknown>).default
    if (typeof nested === 'string') return nested
  }
  return ''
}

function dshHostCompatible(required: string, actual: string): boolean {
  const want = required.trim()
  if (!want) return true
  if (want === actual) return true
  const atLeast = want.match(/^>=\s*(\d+(?:\.\d+){0,2})$/)
  if (!atLeast) return false
  return eabVersionAtLeast(`>=${atLeast[1]}`, actual)
}

function parseDshManifest(
  dir: string,
  dirName: string,
  raw: RawPackageJson,
  rawText: string,
): { record: PluginRecord; enabledDefault: boolean } {
  const fail = (error: string, format: 'eab' | 'dsh' = 'dsh', dsh: PluginDshInfo | null = null): PluginRecord => ({
    id: dirName,
    name: dirName,
    version: '—',
    description: '',
    author: '',
    homepage: '',
    license: '',
    keywords: [],
    scopes: [],
    pages: [],
    format,
    dsh,
    enabled: false,
    valid: false,
    error,
    dir,
    checksum: '',
    install: null,
  })

  const packageName = asString(raw.name) || dirName
  const id = dshPluginIdOf(packageName)
  if (!id) return { record: fail(`package.json 的 name 不合法：${packageName}`), enabledDefault: false }
  if (id !== dirName) return { record: fail(`插件 id（${id}）必须与目录名（${dirName}）一致`), enabledDefault: false }

  const version = asString(raw.version)
  if (!version) return { record: fail('package.json 缺少 version'), enabledDefault: false }

  const dsh = raw.dsh && typeof raw.dsh === 'object' ? raw.dsh : null
  if (!dsh) return { record: fail('package.json 里没有 dsh 段，不是 DSH 插件'), enabledDefault: false }

  const bundlePatchRaw = asString(dsh.bundle?.patch)
  const bundlePatch = bundlePatchRaw ? insidePlugin(dir, bundlePatchRaw) : null
  if (bundlePatchRaw && !bundlePatch) {
    return { record: fail(`dsh.bundle.patch 路径不合法：${bundlePatchRaw}`), enabledDefault: false }
  }
  if (bundlePatch && (!existsSync(join(dir, bundlePatch)) || !statSync(join(dir, bundlePatch)).isFile())) {
    return { record: fail(`dsh.bundle.patch 文件不存在：${bundlePatch}`), enabledDefault: false }
  }

  const clientEntryRaw =
    asString(dsh.client?.entry) ||
    exportEntry(raw.exports, './client') ||
    exportEntry(raw.exports, './lib/client.js') ||
    (existsSync(join(dir, 'lib/client.js')) ? 'lib/client.js' : '')
  const clientEntry = clientEntryRaw ? insidePlugin(dir, clientEntryRaw) : null
  if (clientEntryRaw && !clientEntry) {
    return { record: fail(`client 入口路径不合法：${clientEntryRaw}`), enabledDefault: false }
  }
  if (clientEntry && (!existsSync(join(dir, clientEntry)) || !statSync(join(dir, clientEntry)).isFile())) {
    return { record: fail(`client 入口文件不存在：${clientEntry}`), enabledDefault: false }
  }

  const hostEntryRaw =
    asString(raw.main) ||
    exportEntry(raw.exports, '.') ||
    (existsSync(join(dir, 'dist/index.js')) ? 'dist/index.js' : '')
  const hostEntry = hostEntryRaw ? insidePlugin(dir, hostEntryRaw) : null
  if (hostEntryRaw && !hostEntry) {
    return { record: fail(`host 入口路径不合法：${hostEntryRaw}`), enabledDefault: false }
  }
  if (hostEntry && (!existsSync(join(dir, hostEntry)) || !statSync(join(dir, hostEntry)).isFile())) {
    return { record: fail(`host 入口文件不存在：${hostEntry}`), enabledDefault: false }
  }

  const clientInject = Array.isArray(dsh.client?.inject)
    ? dsh.client.inject.map(asString).filter(Boolean).slice(0, 20)
    : []
  const platform = asString(dsh.client?.platform) || 'web'
  if (platform !== EAB_DSH_PROFILE) {
    return { record: fail(`插件声明的 client.platform 是 ${platform}，EAB 只能承载 ${EAB_DSH_PROFILE}`), enabledDefault: false }
  }

  const compatibilityRaw = dsh.compatibility && typeof dsh.compatibility === 'object' ? dsh.compatibility : null
  const requiredDsh = asString(compatibilityRaw?.dsh)
  const profiles = Array.isArray(compatibilityRaw?.profiles)
    ? compatibilityRaw.profiles.map(asString).filter(Boolean).slice(0, 8)
    : []
  if (profiles.length && !profiles.includes(EAB_DSH_PROFILE)) {
    return {
      record: fail(`插件只允许 profile ${profiles.join(' / ')}，EAB 不在兼容列表里（需要包含 ${EAB_DSH_PROFILE}）`),
      enabledDefault: false,
    }
  }
  if (requiredDsh && !dshHostCompatible(requiredDsh, EAB_DSH_COMPAT_VERSION)) {
    return {
      record: fail(`插件要求 DSH ${requiredDsh}，EAB 的 DSH 兼容版本是 ${EAB_DSH_COMPAT_VERSION}`),
      enabledDefault: false,
    }
  }

  if (!hostEntry && !clientEntry) {
    return { record: fail('插件既没有 host 入口也没有 client 入口'), enabledDefault: false }
  }

  // 发布包声明的 files 白名单：安装时只复制这些条目（省掉 test / .tmp / tgz 残留）
  const files = Array.isArray(raw.files)
    ? raw.files
        .map(asString)
        .filter(Boolean)
        .map((item) => item.replace(/^\.\//, '').replace(/\\/g, '/'))
        .filter((item) => !item.includes('..') && !item.startsWith('/') && !/^[A-Za-z]:/.test(item))
        .slice(0, 40)
    : []

  const displayName = asString(dsh.ui?.title) || packageName
  const pages: PluginPage[] = []
  const uiPages = Array.isArray(dsh.ui?.pages) ? dsh.ui.pages : []
  for (const item of uiPages) {
    const page = item as { id?: unknown; title?: unknown; file?: unknown }
    const pageId = asString(page.id)
    const file = asString(page.file)
    if (!pageId || !file) continue
    const rel = insidePlugin(dir, file)
    if (!rel) continue
    pages.push({ id: pageId, title: asString(page.title) || displayName, file: rel, kind: 'dsh-client' })
  }
  if (!pages.length && clientEntry) {
    pages.push({ id: 'console', title: displayName, file: clientEntry, kind: 'dsh-client' })
  }

  const authorRaw = raw.author
  const author =
    typeof authorRaw === 'string'
      ? authorRaw.trim()
      : typeof authorRaw === 'object' && authorRaw !== null
        ? asString((authorRaw as { name?: unknown }).name)
        : ''
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.map(asString).filter(Boolean).slice(0, 12)
    : []

  const dshInfo: PluginDshInfo = {
    packageName,
    bundlePatch,
    clientInject,
    platform,
    compatibility: compatibilityRaw
      ? { dsh: requiredDsh || '未声明', profiles }
      : null,
    hostEntry,
    clientEntry,
    hasHost: Boolean(hostEntry),
    hasClient: Boolean(clientEntry),
    files,
  }

  const checksumHash = createHash('sha256')
  checksumHash.update(rawText)
  for (const rel of [bundlePatch, clientEntry, hostEntry].filter(Boolean) as string[]) {
    checksumHash.update(rel)
    try {
      checksumHash.update(readFileSync(join(dir, rel)))
    } catch {
      // 入口文件缺失已在上方报错
    }
  }

  const record: PluginRecord = {
    id,
    name: displayName,
    version,
    description: asString(raw.description),
    author,
    homepage: asString(raw.homepage),
    license: asString(raw.license),
    keywords,
    scopes: [],
    pages,
    format: 'dsh',
    dsh: dshInfo,
    enabled: true,
    valid: true,
    error: null,
    dir,
    checksum: checksumHash.digest('hex').slice(0, 16),
    install: null,
  }
  return { record, enabledDefault: true }
}

function parseManifest(dir: string, dirName: string): { record: PluginRecord; enabledDefault: boolean } {
  const manifestPath = join(dir, 'plugin.json')
  const packagePath = join(dir, 'package.json')
  const fail = (error: string): PluginRecord => ({
    id: dirName,
    name: dirName,
    version: '—',
    description: '',
    author: '',
    homepage: '',
    license: '',
    keywords: [],
    scopes: [],
    pages: [],
    format: existsSync(packagePath) && !existsSync(manifestPath) ? 'dsh' : 'eab',
    dsh: null,
    enabled: false,
    valid: false,
    error,
    dir,
    checksum: '',
    install: null,
  })

  if (existsSync(manifestPath)) {
    let raw: RawManifest
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as RawManifest
    } catch (err) {
      return { record: fail(`plugin.json 不是合法 JSON：${(err as Error).message}`), enabledDefault: false }
    }
    return parseEabManifest(dir, dirName, raw)
  }

  if (existsSync(packagePath)) {
    let rawText = ''
    let raw: RawPackageJson
    try {
      rawText = readFileSync(packagePath, 'utf8')
      raw = JSON.parse(rawText) as RawPackageJson
    } catch (err) {
      return { record: fail(`package.json 不是合法 JSON：${(err as Error).message}`), enabledDefault: false }
    }
    if (raw.dsh && typeof raw.dsh === 'object') {
      return parseDshManifest(dir, dirName, raw, rawText)
    }
    return { record: fail('package.json 里没有 dsh 段，也不是 EAB 插件（缺 plugin.json）'), enabledDefault: false }
  }

  return { record: fail('缺少 plugin.json；package.json 里也没有 dsh 插件段'), enabledDefault: false }
}

function parseEabManifest(
  dir: string,
  dirName: string,
  raw: RawManifest,
): { record: PluginRecord; enabledDefault: boolean } {
  const fail = (error: string): PluginRecord => ({
    id: dirName,
    name: dirName,
    version: '—',
    description: '',
    author: '',
    homepage: '',
    license: '',
    keywords: [],
    scopes: [],
    pages: [],
    format: 'eab',
    dsh: null,
    enabled: false,
    valid: false,
    error,
    dir,
    checksum: '',
    install: null,
  })

  const id = asString(raw.id) || dirName
  if (!ID_PATTERN.test(id)) return { record: fail(`id 不合法（要求 ${ID_PATTERN}）：${id}`), enabledDefault: false }
  if (id !== dirName) return { record: fail(`id（${id}）必须与目录名（${dirName}）一致`), enabledDefault: false }

  const name = asString(raw.name)
  if (!name) return { record: fail('缺少 name'), enabledDefault: false }

  const version = asString(raw.version)
  if (!version) return { record: fail('缺少 version'), enabledDefault: false }

  const scopesRaw = Array.isArray(raw.scopes) ? raw.scopes : []
  const scopes: string[] = []
  for (const item of scopesRaw) {
    const scope = asString(item)
    if (!NEW_SCOPE_OK(scope)) return { record: fail(`声明了未知权限：${scope}`), enabledDefault: false }
    scopes.push(scope)
  }

  const pagesRaw = Array.isArray(raw.pages) ? raw.pages : []
  const pages: PluginPage[] = []
  const seenPageIds = new Set<string>()
  const seenFiles = new Set<string>()
  for (const item of pagesRaw) {
    const page = item as { id?: unknown; title?: unknown; file?: unknown }
    const pageId = asString(page.id)
    const title = asString(page.title)
    const file = asString(page.file)
    if (!pageId || !title || !file) return { record: fail('pages 里的每一项都要有 id / title / file'), enabledDefault: false }
    if (seenPageIds.has(pageId)) return { record: fail(`页面 id 重复：${pageId}`), enabledDefault: false }
    if (seenFiles.has(file)) return { record: fail(`页面文件重复：${file}`), enabledDefault: false }
    if (file.includes('..') || file.startsWith('/') || file.includes('\\')) {
      return { record: fail(`页面文件路径不合法：${file}`), enabledDefault: false }
    }
    const pagePath = join(dir, file)
    if (!existsSync(pagePath) || !statSync(pagePath).isFile()) {
      return { record: fail(`页面文件不存在：${file}`), enabledDefault: false }
    }
    seenPageIds.add(pageId)
    seenFiles.add(file)
    pages.push({ id: pageId, title, file, kind: 'html' })
  }

  const compatibility = raw.compatibility as { eab?: unknown } | undefined
  const required = asString(compatibility?.eab)
  const current = readVersion()
  if (required && !eabVersionAtLeast(required, current)) {
    return { record: fail(`要求 EAB ${required}，当前 ${current}`), enabledDefault: false }
  }

  const authorRaw = raw.author
  const author =
    typeof authorRaw === 'string'
      ? authorRaw.trim()
      : typeof authorRaw === 'object' && authorRaw !== null
        ? asString((authorRaw as { name?: unknown }).name)
        : ''
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.map(asString).filter(Boolean).slice(0, 12)
    : []

  const record: PluginRecord = {
    id,
    name,
    version,
    description: asString(raw.description),
    author,
    homepage: asString(raw.homepage),
    license: asString(raw.license),
    keywords,
    scopes,
    pages,
    format: 'eab',
    dsh: null,
    enabled: true,
    valid: true,
    error: null,
    dir,
    checksum: checksumOf(dir, pages),
    install: null,
  }
  return { record, enabledDefault: true }
}

/** 用函数包一层，方便以后从"全部 SC"改成"插件允许申请的 SC 白名单" */
function NEW_SCOPE_OK(scope: string): boolean {
  return KNOWN_SCOPES.has(scope)
}

 /** 读取磁盘上所有插件目录，按公司过滤“装了哪些”，再叠加上这家企业的启停状态 */
 export function loadPlugins(db: Db, companyId: string): PluginRecord[] {
   if (!existsSync(pluginRootPath)) return []

   const states = db
     .prepare('SELECT plugin_id, enabled FROM plugin_states WHERE company_id = ?')
     .all(companyId) as unknown as Array<{ plugin_id: string; enabled: number }>
   const enabledMap = new Map(states.map((row) => [row.plugin_id, row.enabled === 1]))

   const companyRows = db
     .prepare(
       `SELECT company_id, plugin_id, installed_by, installed_at, updated_at, removed_at
          FROM plugin_company_installs WHERE company_id = ?`,
     )
     .all(companyId) as unknown as Array<{
     company_id: string
     plugin_id: string
     installed_by: string | null
     installed_at: number
     updated_at: number
     removed_at: number | null
   }>
   const companyOwned = new Map(
     companyRows.map((row) => [
       row.plugin_id,
       {
         companyId: row.company_id,
         pluginId: row.plugin_id,
         installedBy: row.installed_by,
         installedAt: row.installed_at,
         updatedAt: row.updated_at,
         removedAt: row.removed_at,
       } satisfies PluginCompanyInstallRecord,
     ]),
   )

   const allOwners = db
     .prepare('SELECT plugin_id, company_id FROM plugin_company_installs WHERE removed_at IS NULL')
     .all() as unknown as Array<{ plugin_id: string; company_id: string }>
   const activeOwners = new Map<string, Set<string>>()
   for (const row of allOwners) {
     const set = activeOwners.get(row.plugin_id) ?? new Set<string>()
     set.add(row.company_id)
     activeOwners.set(row.plugin_id, set)
   }

   // 个人安装归属也参与“谁能看到”的判断：没有公司安装、只有某人个人安装的包，
   // 不能作为“未认领插件”出现在其他员工或公司插件列表里。
   const personalOwned = new Set(
     (
       db
         .prepare(
           `SELECT DISTINCT plugin_id FROM plugin_user_installs
             WHERE company_id = ? AND removed_at IS NULL`,
         )
         .all(companyId) as unknown as Array<{ plugin_id: string }>
     ).map((row) => row.plugin_id),
   )

   const installRows = db
     .prepare(
       `SELECT plugin_id, version, source, source_ref, checksum, installed_by, installed_at, updated_at, removed_at
          FROM plugin_installs`,
     )
     .all() as unknown as Array<{
     plugin_id: string
     version: string
     source: string
     source_ref: string | null
     checksum: string | null
     installed_by: string | null
     installed_at: number
     updated_at: number
     removed_at: number | null
   }>
   const installMap = new Map(
     installRows.map((row) => [
       row.plugin_id,
       {
         pluginId: row.plugin_id,
         version: row.version,
         source: row.source,
         sourceRef: row.source_ref,
         checksum: row.checksum,
         installedBy: row.installed_by,
         installedAt: row.installed_at,
         updatedAt: row.updated_at,
         removedAt: row.removed_at,
       } satisfies PluginInstallRecord,
     ]),
   )

   const dirs = readdirSync(pluginRootPath)
     .filter((name) => !name.startsWith('.') && !name.startsWith('_'))
     .filter((name) => {
       const full = join(pluginRootPath, name)
       return statSync(full).isDirectory()
     })

   return dirs
     .flatMap((dirName) => {
       const { record } = parseManifest(join(pluginRootPath, dirName), dirName)
       const owned = companyOwned.get(record.id)
       const owners = activeOwners.get(record.id) ?? new Set<string>()
       // 当前公司没装、别家公司装了 → 不进入当前公司的列表；磁盘上没人认领的才作为“已发现”展示
       if (owned) {
         if (owned.removedAt) return []
       } else if (owners.size > 0) {
         return []
       } else if (personalOwned.has(record.id)) {
         // 个人插件只对安装人可见，由 loadPluginsForUser 的 personalOnly 分支补回
         return []
       }
       const stored = enabledMap.get(record.id)
       return [{
         ...record,
         enabled: record.valid && (stored ?? record.enabled),
         install: installMap.get(record.id) ?? null,
         companyInstall: owned ?? null,
         userInstall: null,
       }]
     })
     .sort((a, b) => a.id.localeCompare(b.id))
 }

/** 员工视角：公司级插件 + 本人个人插件；本人没装且公司没装的条目会以“可安装”出现 */
export function loadPluginsForUser(
  db: Db,
  companyId: string,
  userId: string,
  includeAllUsers = false,
): PluginRecord[] {
  const base = loadPlugins(db, companyId)
  const rows = db
    .prepare(
      includeAllUsers
        ? `SELECT company_id, user_id, plugin_id, enabled, installed_at, updated_at, removed_at
             FROM plugin_user_installs
            WHERE company_id = ?`
        : `SELECT company_id, user_id, plugin_id, enabled, installed_at, updated_at, removed_at
             FROM plugin_user_installs
            WHERE company_id = ? AND user_id = ?`,
    )
    .all(...(includeAllUsers ? [companyId] : [companyId, userId])) as unknown as Array<{
    company_id: string
    user_id: string
    plugin_id: string
    enabled: number
    installed_at: number
    updated_at: number
    removed_at: number | null
  }>
  const userMap = new Map(
    rows.map((row) => [
      row.plugin_id,
      {
        companyId: row.company_id,
        userId: row.user_id,
        pluginId: row.plugin_id,
        enabled: row.enabled === 1,
        installedAt: row.installed_at,
        updatedAt: row.updated_at,
        removedAt: row.removed_at,
      } satisfies PluginUserInstallRecord,
    ]),
  )
  const companyInstalled = new Set(
    base
      .filter((plugin) => plugin.companyInstall && !plugin.companyInstall.removedAt)
      .map((plugin) => plugin.id),
  )
  const visible = new Set(base.map((plugin) => plugin.id))
  const personalOnly = rows
    .filter((row) => row.removed_at === null && !visible.has(row.plugin_id))
    .flatMap((row) => {
      const dir = join(pluginRootPath, row.plugin_id)
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
      const { record } = parseManifest(dir, row.plugin_id)
      const personal = userMap.get(row.plugin_id)
      if (!personal) return []
      return [{
        ...record,
        enabled: record.valid && personal.enabled,
        install: installRecordOf(db, row.plugin_id),
        companyInstall: null,
        userInstall: personal,
      } satisfies PluginRecord]
    })

  const merged = base
    .flatMap((plugin) => {
      const personal = userMap.get(plugin.id) ?? null
      if (personal && !personal.removedAt) {
        return [{
          ...plugin,
          enabled: plugin.valid && personal.enabled,
          userInstall: personal,
        }]
      }
      // 本人卸载了、公司也没装 → 不再出现在“我的插件”
      if (personal?.removedAt && !companyInstalled.has(plugin.id)) return []
      return [{ ...plugin, userInstall: personal }]
    })

  return [...merged, ...personalOnly].sort((a, b) => {
    const aPersonal = Boolean(a.userInstall && !a.userInstall.removedAt)
    const bPersonal = Boolean(b.userInstall && !b.userInstall.removedAt)
    if (aPersonal !== bPersonal) return aPersonal ? -1 : 1
    return a.id.localeCompare(b.id)
  })
}

/** 员工个人工作台：只返回本人安装且未卸载的插件，不混入公司级插件 */
export function loadPersonalPluginsForUser(db: Db, companyId: string, userId: string): PluginRecord[] {
  return loadPluginsForUser(db, companyId, userId).filter(
    (plugin) => Boolean(plugin.userInstall && !plugin.userInstall.removedAt),
  )
}

/** 管理后台只读：列出本司所有员工的个人插件安装，一条记录只属于一个员工。 */
export function loadAdminPersonalPlugins(db: Db, companyId: string): AdminPersonalPluginRecord[] {
  const rows = db
    .prepare(
      `SELECT ui.user_id, ui.plugin_id, ui.enabled, ui.installed_at, ui.updated_at,
              COALESCE(u.name, '') AS user_name
         FROM plugin_user_installs ui
         LEFT JOIN users u ON u.id = ui.user_id AND u.company_id = ui.company_id
        WHERE ui.company_id = ? AND ui.removed_at IS NULL
        ORDER BY ui.updated_at DESC, ui.user_id, ui.plugin_id`,
    )
    .all(companyId) as unknown as Array<{
    user_id: string
    plugin_id: string
    enabled: number
    installed_at: number
    updated_at: number
    user_name: string
  }>

  const parsed = new Map<string, { record: PluginRecord | null; error: string | null }>()
  const readRecord = (pluginId: string) => {
    const cached = parsed.get(pluginId)
    if (cached) return cached
    const dir = join(pluginRootPath, pluginId)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      const missing = { record: null, error: '插件目录不存在，可能已被移除' }
      parsed.set(pluginId, missing)
      return missing
    }
    try {
      const { record } = parseManifest(dir, pluginId)
      const value = { record, error: record.error }
      parsed.set(pluginId, value)
      return value
    } catch (err) {
      const failed = {
        record: null,
        error: err instanceof Error ? err.message : '插件清单读取失败',
      }
      parsed.set(pluginId, failed)
      return failed
    }
  }

  return rows.map((row) => {
    const { record, error } = readRecord(row.plugin_id)
    const install = installRecordOf(db, row.plugin_id)
    return {
      key: `${row.user_id}:${row.plugin_id}`,
      userId: row.user_id,
      userName: row.user_name || row.user_id,
      pluginId: row.plugin_id,
      name: record?.name || row.plugin_id,
      version: record?.version || install?.version || '—',
      description: record?.description || '',
      author: record?.author || '',
      format: record?.format || 'eab',
      pages: record?.pages.length || 0,
      scopes: record?.scopes || [],
      valid: Boolean(record?.valid) && !error,
      error,
      enabled: row.enabled === 1,
      installedAt: Number(row.installed_at),
      updatedAt: Number(row.updated_at),
      source: install?.source || null,
    } satisfies AdminPersonalPluginRecord
  })
}

/** 取某个插件里某个页面文件的绝对路径；越界 / 未启用 / 不存在都返回 null */
export function resolvePluginAsset(
  plugins: readonly PluginRecord[],
  pluginId: string,
  file: string,
): string | null {
  const plugin = plugins.find((item) => item.id === pluginId)
  if (!plugin || !plugin.enabled) return null
  if (file.includes('..') || file.startsWith('/') || file.includes('\\')) return null
  const target = resolve(plugin.dir, file)
  if (!target.startsWith(plugin.dir + sep)) return null
  if (!existsSync(target) || !statSync(target).isFile()) return null
  return target
}

export function setPluginEnabled(
  db: Db,
  companyId: string,
  pluginId: string,
  enabled: boolean,
  userId: string,
): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO plugin_states (company_id, plugin_id, enabled, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (company_id, plugin_id)
     DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(companyId, pluginId, enabled ? 1 : 0, userId, now)
  recordPluginEvent(db, {
    pluginId,
    companyId,
    event: enabled ? 'enable' : 'disable',
    actorId: userId,
    detail: null,
  })
}

/** 个人插件启停：只改本人那一行，不影响公司级启停和其他员工 */
export function setUserPluginEnabled(
  db: Db,
  companyId: string,
  userId: string,
  pluginId: string,
  enabled: boolean,
): void {
  const now = Date.now()
  const row = userInstallOf(db, companyId, userId, pluginId)
  if (!row || row.removedAt) {
    throw new EabError(EC.NOT_FOUND, `你还没有安装插件：${pluginId}`)
  }
  db.prepare(
    `UPDATE plugin_user_installs
        SET enabled = ?, updated_at = ?
      WHERE company_id = ? AND user_id = ? AND plugin_id = ? AND removed_at IS NULL`,
  ).run(enabled ? 1 : 0, now, companyId, userId, pluginId)
  recordPluginEvent(db, {
    pluginId,
    companyId,
    event: enabled ? 'enable' : 'disable',
    actorId: userId,
    detail: JSON.stringify({ scope: 'user', userId }),
  })
}

/** 个人卸载：只解除本人，删除本人实例数据；公司级安装和其他员工不受影响 */
export function uninstallUserPlugin(
  db: Db,
  companyId: string,
  userId: string,
  pluginId: string,
  dataOptions?: { dbPath: string; dataDir?: string; dshHomeDir?: string },
): { pluginId: string; removed: boolean; dataRoot: string | null } {
  const row = userInstallOf(db, companyId, userId, pluginId)
  if (!row || row.removedAt) {
    throw new EabError(EC.NOT_FOUND, `你还没有安装插件：${pluginId}`)
  }
  const now = Date.now()
  db.prepare(
    `UPDATE plugin_user_installs
        SET removed_at = ?, updated_at = ?
      WHERE company_id = ? AND user_id = ? AND plugin_id = ? AND removed_at IS NULL`,
  ).run(now, now, companyId, userId, pluginId)
  // 个人实例的 DSH_HOME 只属于这个员工；卸载时整棵目录删除。
  // 公司实例的 DSH_HOME（dsh-home 根）和其他员工的 scopes 子目录不在这个路径下。
  let dataRoot: string | null = null
  if (dataOptions) {
    dataRoot = pluginDataRoot(dataOptions, companyId, userScope(userId))
    rmSync(dataRoot, { recursive: true, force: true })
  }
  let trashPath: string | null = null
  const stillUsedByCompany = activeCompanyOwners(db, pluginId) > 0
  const stillUsedByUser = activeUserOwners(db, pluginId) > 0
  // 最后一个归属人卸载后，包目录也要移走；否则会以“未认领插件”重新出现在别人列表里。
  if (!stillUsedByCompany && !stillUsedByUser) {
    const dir = join(pluginRootPath, pluginId)
    if (existsSync(dir)) {
      const { record } = parseManifest(dir, pluginId)
      mkdirSync(trashDir(), { recursive: true })
      trashPath = join(trashDir(), `${pluginId}-${Date.now()}`)
      renameSync(dir, trashPath)
      const existing = installRecordOf(db, pluginId)
      db.prepare(
        `INSERT INTO plugin_installs
           (plugin_id, version, source, source_ref, checksum, installed_by, installed_at, updated_at, removed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (plugin_id)
         DO UPDATE SET removed_at = excluded.removed_at, updated_at = excluded.updated_at`,
      ).run(
        pluginId,
        record.version,
        existing?.source ?? 'disk',
        existing?.sourceRef ?? dir,
        existing?.checksum ?? record.checksum,
        userId,
        existing?.installedAt ?? now,
        now,
        now,
      )
    }
  }
  recordPluginEvent(db, {
    pluginId,
    companyId,
    event: 'uninstall',
    actorId: userId,
    detail: JSON.stringify({ scope: 'user', userId, trashPath, dataRoot }),
  })
  return { pluginId, removed: true, dataRoot }
}

/* ---------------- 生命周期：安装 / 更新 / 卸载 / 事件 ---------------- */

const COPY_SKIP = new Set(['node_modules', '.git', '.tmp', '.trash', '.staging'])

/** 把 package.json 的 files 白名单展开成相对文件列表（目录递归，跳过 node_modules 等） */
function collectSelectedFiles(dir: string, entries: readonly string[]): string[] {
  const out: string[] = []
  const visit = (rel: string): void => {
    const full = join(dir, rel)
    if (!existsSync(full)) return
    const stat = statSync(full)
    if (stat.isFile()) {
      out.push(rel.replace(/\\/g, '/'))
      return
    }
    if (!stat.isDirectory()) return
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (COPY_SKIP.has(entry.name)) continue
      visit(`${rel}/${entry.name}`)
    }
  }
  for (const entry of entries) visit(entry)
  return out
}

function copySelectedFiles(source: string, target: string, files: readonly string[]): void {
  for (const rel of files) {
    const from = join(source, rel)
    if (!existsSync(from) || !statSync(from).isFile()) continue
    const to = join(target, rel)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
  }
}

function copyPackage(source: string, target: string, record: PluginRecord): void {
  const whitelist = record.format === 'dsh' ? record.dsh?.files ?? [] : []
  if (whitelist.length) {
    // DSH 包按发布声明复制：package.json + files 白名单，避开 test / .tmp / tgz 等调试残留
    const files = ['package.json', ...collectSelectedFiles(source, whitelist)]
    copySelectedFiles(source, target, files)
    return
  }
  cpSync(source, target, {
    recursive: true,
    filter: (src) => {
      const name = basename(src)
      if (COPY_SKIP.has(name)) return false
      return true
    },
  })
}

function installRecordOf(
  db: Db,
  pluginId: string,
): PluginInstallRecord | null {  const row = db
    .prepare(
      `SELECT plugin_id, version, source, source_ref, checksum, installed_by, installed_at, updated_at, removed_at
         FROM plugin_installs WHERE plugin_id = ?`,
    )
    .get(pluginId) as
    | {
        plugin_id: string
        version: string
        source: string
        source_ref: string | null
        checksum: string | null
        installed_by: string | null
        installed_at: number
        updated_at: number
        removed_at: number | null
      }
    | undefined
  if (!row) return null
  return {
    pluginId: row.plugin_id,
    version: row.version,
    source: row.source,
    sourceRef: row.source_ref,
    checksum: row.checksum,
    installedBy: row.installed_by,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
  }
}

function companyInstallOf(db: Db, companyId: string, pluginId: string): PluginCompanyInstallRecord | null {
  const row = db
    .prepare(
      `SELECT company_id, plugin_id, installed_by, installed_at, updated_at, removed_at
         FROM plugin_company_installs WHERE company_id = ? AND plugin_id = ?`,
    )
    .get(companyId, pluginId) as
    | {
        company_id: string
        plugin_id: string
        installed_by: string | null
        installed_at: number
        updated_at: number
        removed_at: number | null
      }
    | undefined
  if (!row) return null
  return {
    companyId: row.company_id,
    pluginId: row.plugin_id,
    installedBy: row.installed_by,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
  }
}

function activeCompanyOwners(db: Db, pluginId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total FROM plugin_company_installs
        WHERE plugin_id = ? AND removed_at IS NULL`,
    )
    .get(pluginId) as { total: number } | undefined
  return Number(row?.total ?? 0)
}

function activeUserOwners(db: Db, pluginId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total FROM plugin_user_installs
        WHERE plugin_id = ? AND removed_at IS NULL`,
    )
    .get(pluginId) as { total: number } | undefined
  return Number(row?.total ?? 0)
}

function userInstallOf(
  db: Db,
  companyId: string,
  userId: string,
  pluginId: string,
): PluginUserInstallRecord | null {
  const row = db
    .prepare(
      `SELECT company_id, user_id, plugin_id, enabled, installed_at, updated_at, removed_at
         FROM plugin_user_installs
        WHERE company_id = ? AND user_id = ? AND plugin_id = ?`,
    )
    .get(companyId, userId, pluginId) as
    | {
        company_id: string
        user_id: string
        plugin_id: string
        enabled: number
        installed_at: number
        updated_at: number
        removed_at: number | null
      }
    | undefined
  if (!row) return null
  return {
    companyId: row.company_id,
    userId: row.user_id,
    pluginId: row.plugin_id,
    enabled: row.enabled === 1,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
  }
}



export interface InstallPluginOptions {
  readonly companyId: string
  readonly overwrite?: boolean
  readonly installedBy: string
  /** 记录用的来源标签：browser-dir / npm / github / catalog */
  readonly source?: string
  /** 来源引用：浏览器上传的文件夹名、npm 包名+镜像、GitHub 仓库+ref */
  readonly sourceRef?: string
  /**
   * 安装归属：company = 公司级（默认，管理员装，全员可见）
   *           user    = 个人级（员工自己装，只有本人可见）
   */
  readonly scope?: 'company' | 'user'
  /** scope=user 时必填：装给哪个员工 */
  readonly userId?: string
}

export interface InstallPluginResult {
  readonly plugin: PluginRecord
  readonly replaced: boolean
  readonly sourcePath: string
  readonly trashPath: string | null
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}

/** 只读清单 id，用来把任意来源目录（npm 的 package/、GitHub 的 repo-ref/）映射成 plugins/<id> */
function manifestIdOf(dir: string): string | null {
  const manifestPath = join(dir, 'plugin.json')
  if (existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as RawManifest
      return asString(raw.id) || null
    } catch {
      return null
    }
  }
  const packagePath = join(dir, 'package.json')
  if (!existsSync(packagePath)) return null
  try {
    const raw = JSON.parse(readFileSync(packagePath, 'utf8')) as RawPackageJson
    if (!raw.dsh || typeof raw.dsh !== 'object') return null
    return dshPluginIdOf(asString(raw.name)) || null
  } catch {
    return null
  }
}

function isPluginRoot(dir: string): boolean {
  if (existsSync(join(dir, 'plugin.json'))) return true
  const packagePath = join(dir, 'package.json')
  if (!existsSync(packagePath)) return false
  try {
    const raw = JSON.parse(readFileSync(packagePath, 'utf8')) as RawPackageJson
    return Boolean(raw.dsh && typeof raw.dsh === 'object')
  } catch {
    return false
  }
}

function preparePackage(source: string, logicalId: string): PluginRecord {
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new EabError(EC.VALIDATION, `插件目录不存在：${source}`)
  }
  if (!isPluginRoot(source)) {
    throw new EabError(EC.VALIDATION, '这个目录里没有 plugin.json，package.json 里也没有 dsh 段，不是插件包')
  }
  if (!ID_PATTERN.test(logicalId)) {
    throw new EabError(EC.VALIDATION, `插件 id 不合法（要求 ${ID_PATTERN}）：${logicalId}`)
  }

  const { record } = parseManifest(source, logicalId)
  if (!record.valid) throw new EabError(EC.VALIDATION, `插件清单不合法：${record.error ?? '未知原因'}`)
  return record
}

/** 已校验过的来源目录 → plugins/<id>；先暂存、二次校验、旧目录进 .trash、再登记审计 */
function commitPluginPackage(
  db: Db,
  source: string,
  prepared: PluginRecord,
  options: InstallPluginOptions,
): InstallPluginResult {
  const dirName = prepared.id
  mkdirSync(pluginRootPath, { recursive: true })
  const staging = join(pluginRootPath, `.staging-${dirName}-${Date.now()}-${randomSuffix()}`)
  const dest = join(pluginRootPath, dirName)
  let trashPath: string | null = null
  const installSource = options.source ?? 'local-dir'
  const sourceRef = options.sourceRef ?? source

  try {
    copyPackage(source, staging, prepared)
    const { record: staged } = parseManifest(staging, dirName)
    if (!staged.valid) throw new EabError(EC.VALIDATION, `复制后的插件清单不合法：${staged.error ?? '未知原因'}`)

    const existingCompany = companyInstallOf(db, options.companyId, dirName)
    const existingGlobal = installRecordOf(db, dirName)
    const owners = activeCompanyOwners(db, dirName)
    const isUserScope = options.scope === 'user'
    const existingUser = isUserScope && options.userId
      ? userInstallOf(db, options.companyId, options.userId, dirName)
      : null
    const userOwners = activeUserOwners(db, dirName)
    const destExists = existsSync(dest)
    const currentActive = Boolean(existingCompany && !existingCompany.removedAt)
    const currentUserActive = Boolean(existingUser && !existingUser.removedAt)
    let replaced = false
    /** 共享目录没有替换时，返回目录里真实在用的插件，而不是本次上传的暂存副本。 */
    let installedRecord: PluginRecord | null = null

    if (isUserScope && !options.userId) {
      throw new EabError(EC.VALIDATION, '个人插件安装缺少员工身份')
    }

    if (destExists) {
      const { record: onDisk } = parseManifest(dest, dirName)
      installedRecord = onDisk
      if (onDisk.checksum !== staged.checksum) {
        // 包目录是公司安装和个人安装共用的，只能保留一个版本。
        // 当前安装人自己的旧归属不算“别人”，其他任何活跃归属都会阻止单独覆盖。
        const ownActive = isUserScope ? (currentUserActive ? 1 : 0) : (currentActive ? 1 : 0)
        const otherOwners = Math.max(0, owners + userOwners - ownActive)
        const sameVersion = onDisk.version === staged.version
        // 公司安装和个人安装共用一份同版本包时，不能因为另一个归属已经装了同版本，
        // 就把新归属挡在安装入口外；同版本直接复用现有共享包，只登记新归属。
        const reuseSharedForSameVersion = sameVersion && otherOwners > 0
        if (otherOwners > 0 && !reuseSharedForSameVersion) {
          const message = sameVersion
            ? `插件 ${dirName} 的 ${onDisk.version} 版本已有其他归属在使用，但内容指纹不同，不能覆盖共享包`
            : `插件 ${dirName} 当前共享版本是 ${onDisk.version}，不能由这次安装单独替换为 ${staged.version}`
          throw new EabError(EC.CONFLICT, message, {
            hint: sameVersion
              ? '同一版本的内容指纹不同，不能直接覆盖共享包；请确认包来源，或先让其他归属卸载后再覆盖。'
              : '同一个插件包被公司安装和多个个人安装共用；已有其他归属在使用该版本时，请先让其他归属卸载，或按相同版本安装。',
            details: {
              onDiskVersion: onDisk.version,
              requestedVersion: staged.version,
              owners,
              userOwners,
              otherOwners,
              onDiskChecksum: onDisk.checksum,
              requestedChecksum: staged.checksum,
            },
          })
        }
        if (!reuseSharedForSameVersion && !options.overwrite) {
          throw new EabError(EC.VALIDATION, `插件 ${dirName} 目录已存在；替换为 ${staged.version} 请显式确认覆盖`)
        }
        if (!reuseSharedForSameVersion) {
          mkdirSync(trashDir(), { recursive: true })
          trashPath = join(trashDir(), `${dirName}-${Date.now()}`)
          renameSync(dest, trashPath)
          renameSync(staging, dest)
          replaced = true
          installedRecord = null
        }
      }
      // 指纹相同：只登记当前安装归属，不动物理目录；公司/个人可以共用同一个包。
    } else {
      renameSync(staging, dest)
      replaced = false
    }

    const now = Date.now()
    // 共享目录没有变化且制品仍有效时，沿用原来的制品记录，避免把别家公司的来源信息改掉
    const reuseGlobal = Boolean(destExists && !replaced && existingGlobal && !existingGlobal.removedAt)
    const install: PluginInstallRecord = reuseGlobal && existingGlobal
      ? existingGlobal
      : {
          pluginId: dirName,
          version: staged.version,
          source: installSource,
          sourceRef,
          checksum: staged.checksum,
          installedBy: options.installedBy,
          installedAt: now,
          updatedAt: now,
          removedAt: null,
        }

    if (!reuseGlobal) {
      db.prepare(
        `INSERT INTO plugin_installs
           (plugin_id, version, source, source_ref, checksum, installed_by, installed_at, updated_at, removed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (plugin_id)
         DO UPDATE SET version = excluded.version, source = excluded.source, source_ref = excluded.source_ref,
                       checksum = excluded.checksum, installed_by = excluded.installed_by,
                       updated_at = excluded.updated_at, removed_at = NULL`,
      ).run(
        install.pluginId,
        install.version,
        install.source,
        install.sourceRef,
        install.checksum,
        install.installedBy,
        existingGlobal?.installedAt ?? install.installedAt,
        now,
      )
    }

    if (isUserScope && options.userId) {
      const userId = options.userId
      db.prepare(
        `INSERT INTO plugin_user_installs
           (company_id, user_id, plugin_id, enabled, installed_at, updated_at, removed_at)
         VALUES (?, ?, ?, 1, ?, ?, NULL)
         ON CONFLICT(company_id, user_id, plugin_id)
         DO UPDATE SET enabled = 1, updated_at = excluded.updated_at, removed_at = NULL`,
      ).run(
        options.companyId,
        userId,
        dirName,
        existingUser?.installedAt ?? now,
        now,
      )
      recordPluginEvent(db, {
        pluginId: dirName,
        companyId: options.companyId,
        event: existingUser && !existingUser.removedAt ? 'update' : 'install',
        actorId: options.installedBy,
        detail: JSON.stringify({
          scope: 'user',
          userId,
          from: existingUser && !existingUser.removedAt ? existingGlobal?.version ?? null : null,
          to: install.version,
          source: installSource,
          sourceRef,
        }),
      })
    } else {
      db.prepare(
        `INSERT INTO plugin_company_installs
           (company_id, plugin_id, installed_by, installed_at, updated_at, removed_at)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT (company_id, plugin_id)
         DO UPDATE SET installed_by = excluded.installed_by, updated_at = excluded.updated_at, removed_at = NULL`,
      ).run(
        options.companyId,
        dirName,
        options.installedBy,
        existingCompany?.installedAt ?? now,
        now,
      )
      recordPluginEvent(db, {
        pluginId: dirName,
        companyId: options.companyId,
        event: existingCompany && !existingCompany.removedAt ? 'update' : 'install',
        actorId: options.installedBy,
        detail: JSON.stringify({
          scope: 'company',
          from: existingCompany && !existingCompany.removedAt ? existingGlobal?.version ?? null : null,
          to: install.version,
          source: installSource,
          sourceRef,
        }),
      })
    }
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
    return {
      plugin: { ...(installedRecord ?? staged), enabled: true, install },
      replaced,
      sourcePath: sourceRef,
      trashPath,
    }
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    if (trashPath && existsSync(trashPath) && !existsSync(dest)) {
      renameSync(trashPath, dest)
    }
    throw err
  }
}

/**
 * 从服务器本地目录安装一个插件包。
 *
 * 本地目录仍然是最稳的来源：部署侧把包放在服务器上，由管理员在控制台选择目录。
 * npm / GitHub 走同一条 commit 流程，只是前面的"取包"方式不同。
 */
export function installPluginPackage(
  db: Db,
  sourcePath: string,
  options: InstallPluginOptions,
): InstallPluginResult {
  const source = resolve(sourcePath)
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new EabError(EC.VALIDATION, `插件目录不存在：${sourcePath}`)
  }
  const logicalId = manifestIdOf(source) ?? basename(source)
  const prepared = preparePackage(source, logicalId)
  return commitPluginPackage(db, source, prepared, {
    ...options,
    source: options.source ?? 'local-dir',
    sourceRef: options.sourceRef ?? source,
  })
}

/* ---------------- 远程来源：npm / 国内镜像 / GitHub ---------------- */

function assertNpmPackageName(value: string): string {
  const name = value.trim()
  if (!name) throw new EabError(EC.VALIDATION, '请填 npm 包名（例如 eab-plugin-oncall 或 @scope/eab-plugin-x）')
  if (!NPM_NAME_PATTERN.test(name)) throw new EabError(EC.VALIDATION, `npm 包名不合法：${name}`)
  return name
}

function assertNpmVersion(value: string): string {
  const version = value.trim()
  if (!version) return ''
  if (!NPM_VERSION_PATTERN.test(version)) {
    throw new EabError(EC.VALIDATION, '版本只支持精确版本号或 dist-tag（例如 1.2.3 / latest / beta），不支持复杂 range')
  }
  return version
}

function normalizeRegistry(value: string | undefined): string {
  const raw = (value || PLUGIN_REGISTRIES[0].url).trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new EabError(EC.VALIDATION, `registry 地址不合法：${raw}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new EabError(EC.VALIDATION, 'registry 只支持 http(s)')
  }
  if (url.username || url.password || url.hash) {
    throw new EabError(EC.VALIDATION, 'registry 地址不能带账号密码或 hash')
  }
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    throw new EabError(EC.VALIDATION, '只有本机 registry 才允许 http，公网请用 https')
  }
  url.search = ''
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path || '/'
  return url.toString().replace(/\/$/, '')
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function encodedNpmName(name: string): string {
  return name.startsWith('@') ? name.replace('/', '%2F') : encodeURIComponent(name)
}

interface NpmDistMeta {
  tarball?: unknown
}

interface NpmPackageMeta {
  'dist-tags'?: Record<string, unknown>
  versions?: Record<string, { dist?: NpmDistMeta }>
}

function selectNpmDist(meta: NpmPackageMeta, requested: string): { version: string; tarball: string } {
  const versions = meta.versions && typeof meta.versions === 'object' ? meta.versions : {}
  const tags = meta['dist-tags'] && typeof meta['dist-tags'] === 'object' ? meta['dist-tags'] : {}
  let resolved = ''
  if (requested) {
    if (versions[requested]) resolved = requested
    else if (typeof tags[requested] === 'string' && versions[tags[requested]]) resolved = tags[requested]
    else throw new EabError(EC.VALIDATION, `这个包里没有版本 / 标签：${requested}`)
  } else if (typeof tags.latest === 'string' && versions[tags.latest]) {
    resolved = tags.latest
  } else {
    throw new EabError(EC.VALIDATION, '这个包没有 latest 标签，请显式填版本')
  }
  const tarball = asString(versions[resolved]?.dist?.tarball)
  if (!tarball) throw new EabError(EC.VALIDATION, `版本 ${resolved} 没有可下载的 tarball`)
  return { version: resolved, tarball }
}

async function fetchJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'EAB-plugin-installer' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new EabError(EC.VALIDATION, `请求 ${url} 失败：${(err as Error).message}`)
  }
  if (!response.ok) throw new EabError(EC.VALIDATION, `请求 ${url} 返回 ${response.status}`)
  const text = await response.text()
  if (text.length > 8 * 1024 * 1024) throw new EabError(EC.VALIDATION, 'registry 元数据过大，已拒绝')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new EabError(EC.VALIDATION, `registry 返回的不是合法 JSON：${url}`)
  }
}

async function downloadArchive(url: string, dest: string, timeoutMs = 30_000): Promise<void> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: { accept: 'application/gzip,application/octet-stream,*/*', 'user-agent': 'EAB-plugin-installer' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new EabError(EC.VALIDATION, `下载失败：${(err as Error).message}`)
  }
  if (!response.ok) throw new EabError(EC.VALIDATION, `下载 ${url} 返回 ${response.status}`)
  const finalUrl = new URL(response.url || url)
  if (finalUrl.protocol === 'http:' && !isLocalHost(finalUrl.hostname)) {
    throw new EabError(EC.VALIDATION, '下载被重定向到非 https 地址，已拒绝')
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(dest, buffer)
}

function runCommand(command: string, args: readonly string[], timeoutMs = 60_000): string {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 12 * 1024 * 1024,
  })
  if (result.error) throw new EabError(EC.VALIDATION, `${command} 执行失败：${result.error.message}`)
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}\n${result.stdout || ''}`.trim().slice(0, 400)
    throw new EabError(EC.VALIDATION, `${command} 执行失败${detail ? `：${detail}` : ''}`)
  }
  return result.stdout || ''
}

/** 解压前先看清单，拒绝绝对路径、盘符和 .. 穿越 */
function assertArchiveEntries(archive: string): void {
  const listing = runCommand('tar', ['-tzf', archive], 30_000)
  const entries = listing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!entries.length) throw new EabError(EC.VALIDATION, '压缩包是空的')
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/')
    if (entry.includes('\\')) throw new EabError(EC.VALIDATION, `压缩包里有反斜杠路径，已拒绝：${entry}`)
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
      throw new EabError(EC.VALIDATION, `压缩包里有绝对路径，已拒绝：${entry}`)
    }
    if (normalized.split('/').some((part) => part === '..')) {
      throw new EabError(EC.VALIDATION, `压缩包里有越界路径，已拒绝：${entry}`)
    }
  }
}

/** 解压后拒绝符号链接；文件数和体积不做限制 */
function assertExtractedTree(dir: string): void {
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) throw new EabError(EC.VALIDATION, `压缩包里有符号链接，已拒绝：${entry.name}`)
      if (stat.isDirectory()) visit(full)
    }
  }
  visit(dir)
}

function extractArchive(archive: string, dest: string): void {
  assertArchiveEntries(archive)
  mkdirSync(dest, { recursive: true })
  runCommand('tar', ['-xzf', archive, '-C', dest], 60_000)
  assertExtractedTree(dest)
}

/** 在解压结果里找唯一的插件根（plugin.json 或带 dsh 段的 package.json）；根目录优先，最多下钻两层 */
function findPluginRoot(root: string, maxDepth = 2): string {
  const found: string[] = []
  const visit = (dir: string, depth: number): void => {
    if (isPluginRoot(dir)) found.push(dir)
    if (depth >= maxDepth) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (COPY_SKIP.has(entry.name) || entry.name === 'node_modules') continue
      visit(join(dir, entry.name), depth + 1)
    }
  }
  visit(root, 0)
  if (!found.length) throw new EabError(EC.VALIDATION, '压缩包里没有 plugin.json 或 DSH 插件的 package.json，不是插件包')
  if (found.includes(root)) return root
  if (found.length === 1) return found[0]
  throw new EabError(EC.VALIDATION, '压缩包里发现多个插件清单，请用「仓库内子目录」指定其中一个')
}

function assertGithubRepo(value: string): { owner: string; repo: string; full: string } {
  const repo = value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '')
  if (!GITHUB_REPO_PATTERN.test(repo)) {
    throw new EabError(EC.VALIDATION, 'GitHub 仓库格式应为 owner/repo，例如 xmanrui/dsh-im')
  }
  const [owner, name] = repo.split('/')
  return { owner, repo: name, full: `${owner}/${name}` }
}

function assertGithubRef(value: string): string {
  const ref = value.trim()
  if (!ref) return ''
  if (ref.length > 120 || ref.startsWith('-') || ref.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new EabError(EC.VALIDATION, 'GitHub 分支 / 标签不合法')
  }
  return ref
}

function encodeGithubRef(ref: string): string {
  return ref
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function assertSubdir(value: string): string {
  const subdir = value.trim().replace(/^\.\//, '')
  if (!subdir || subdir === '.') return ''
  if (subdir.includes('\\') || subdir.startsWith('/') || /^[A-Za-z]:/.test(subdir)) {
    throw new EabError(EC.VALIDATION, '仓库内子目录必须是相对路径')
  }
  if (subdir.split('/').some((part) => part === '..' || part === '')) {
    throw new EabError(EC.VALIDATION, '仓库内子目录不能包含 .. 或空段')
  }
  return subdir
}

function githubApiBase(): string {
  const raw = (process.env.EAB_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '')
  const url = new URL(raw)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    throw new EabError(EC.VALIDATION, 'EAB_GITHUB_API 只支持 https 或本机 http')
  }
  return raw
}

function githubCodeloadBase(): string {
  const raw = (process.env.EAB_GITHUB_CODELOAD || 'https://codeload.github.com').replace(/\/+$/, '')
  const url = new URL(raw)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    throw new EabError(EC.VALIDATION, 'EAB_GITHUB_CODELOAD 只支持 https 或本机 http')
  }
  return raw
}

export interface NpmInstallOptions {
  readonly companyId: string
  readonly packageName: string
  readonly version?: string
  readonly registry?: string
  readonly overwrite?: boolean
  readonly installedBy: string
  readonly scope?: 'company' | 'user'
  readonly userId?: string
}

/** npm / 国内镜像：只拉 registry 元数据和 tarball，解包后复用本地安装器；不执行 npm install 或生命周期脚本 */
export async function installPluginFromNpm(db: Db, options: NpmInstallOptions): Promise<InstallPluginResult> {
  const packageName = assertNpmPackageName(options.packageName)
  const version = assertNpmVersion(options.version ?? '')
  const registry = normalizeRegistry(options.registry)
  const meta = await fetchJson<NpmPackageMeta>(`${registry}/${encodedNpmName(packageName)}`)
  const dist = selectNpmDist(meta, version)
  const temp = mkdtempSync(join(tmpdir(), 'eab-plugin-npm-'))
  try {
    const archive = join(temp, 'package.tgz')
    const extractDir = join(temp, 'extract')
    await downloadArchive(dist.tarball, archive, 45_000)
    extractArchive(archive, extractDir)
    const root = findPluginRoot(extractDir)
    const logicalId = manifestIdOf(root) ?? basename(root)
    const prepared = preparePackage(root, logicalId)
    return commitPluginPackage(db, root, prepared, {
      companyId: options.companyId,
      overwrite: options.overwrite,
      installedBy: options.installedBy,
      source: 'npm',
      sourceRef: `npm:${packageName}@${dist.version}?registry=${encodeURIComponent(registry)}`,
      scope: options.scope,
      userId: options.userId,
    })
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

export interface GithubInstallOptions {
  readonly companyId: string
  readonly repo: string
  readonly ref?: string
  readonly subdir?: string
  readonly overwrite?: boolean
  readonly installedBy: string
  readonly scope?: 'company' | 'user'
  readonly userId?: string
}

/** GitHub：按仓库 + 分支/标签下载 codeload tarball，解包后复用本地安装器；不执行仓库脚本 */
export async function installPluginFromGithub(
  db: Db,
  options: GithubInstallOptions,
): Promise<InstallPluginResult> {
  const repo = assertGithubRepo(options.repo)
  const requestedRef = assertGithubRef(options.ref ?? '')
  const subdir = assertSubdir(options.subdir ?? '')
  const apiBase = githubApiBase()
  const codeloadBase = githubCodeloadBase()

  let ref = requestedRef
  if (!ref) {
    try {
      const meta = await fetchJson<{ default_branch?: unknown }>(`${apiBase}/repos/${repo.full}`)
      ref = asString(meta.default_branch) || 'main'
    } catch {
      ref = 'main'
    }
  }

  const temp = mkdtempSync(join(tmpdir(), 'eab-plugin-github-'))
  try {
    const archive = join(temp, 'repo.tar.gz')
    const extractDir = join(temp, 'extract')
    const candidates = requestedRef ? [requestedRef] : Array.from(new Set([ref, 'main', 'master']))
    let lastError: unknown = null
    for (const candidate of candidates) {
      try {
        const url = `${codeloadBase}/${repo.owner}/${repo.repo}/tar.gz/${encodeGithubRef(candidate)}`
        await downloadArchive(url, archive, 60_000)
        ref = candidate
        lastError = null
        break
      } catch (err) {
        lastError = err
      }
    }
    if (lastError) throw lastError

    extractArchive(archive, extractDir)
    const root = subdir ? resolve(extractDir, subdir) : findPluginRoot(extractDir)
    if (subdir && !root.startsWith(extractDir + sep)) {
      throw new EabError(EC.VALIDATION, '仓库内子目录越界')
    }
    if (!isPluginRoot(root)) {
      throw new EabError(EC.VALIDATION, `仓库子目录里没有插件清单（plugin.json 或 DSH 插件的 package.json）：${subdir}`)
    }
    const logicalId = manifestIdOf(root) ?? basename(root)
    const prepared = preparePackage(root, logicalId)
    return commitPluginPackage(db, root, prepared, {
      companyId: options.companyId,
      overwrite: options.overwrite,
      installedBy: options.installedBy,
      source: 'github',
      sourceRef: `github:${repo.full}${ref ? `#${ref}` : ''}${subdir ? `?dir=${encodeURIComponent(subdir)}` : ''}`,
      scope: options.scope,
      userId: options.userId,
    })
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

export interface UninstallPluginResult {
  readonly pluginId: string
  readonly trashPath: string | null
  readonly version: string
  readonly shared: boolean
}

/** 卸载当前公司的安装；只有最后一家公司卸载时才把共享目录移到 plugins/.trash */
export function uninstallPluginPackage(db: Db, pluginId: string, actorId: string, companyId: string): UninstallPluginResult {
  if (!ID_PATTERN.test(pluginId)) throw new EabError(EC.VALIDATION, `插件 id 不合法：${pluginId}`)
  const ownRecord = companyInstallOf(db, companyId, pluginId)
  const ownersBefore = activeCompanyOwners(db, pluginId)
  if (!ownRecord && ownersBefore > 0) {
    throw new EabError(EC.CONFLICT, `插件 ${pluginId} 由其他公司安装，当前公司不能卸载`, {
      hint: '要先使用请先安装；要彻底移除请让已安装的公司卸载。',
    })
  }
  if (!ownRecord) {
    const personalOwners = activeUserOwners(db, pluginId)
    throw new EabError(
      EC.NOT_FOUND,
      personalOwners > 0
        ? `插件 ${pluginId} 只有员工个人安装，控制台不能卸载`
        : `当前公司没有安装插件 ${pluginId}`,
      {
        hint:
          personalOwners > 0
            ? '个人插件由员工本人在个人工作台卸载；控制台只读查看，不代操作。'
            : '控制台只能卸载已登记到当前公司的插件。',
      },
    )
  }
  if (ownRecord?.removedAt) {
    throw new EabError(EC.NOT_FOUND, `当前公司没有安装插件 ${pluginId}`)
  }

  const dir = join(pluginRootPath, pluginId)
  if (!existsSync(dir)) throw new EabError(EC.NOT_FOUND, `插件不在磁盘上：${pluginId}`)
  const { record } = parseManifest(dir, pluginId)
  const now = Date.now()

  db.prepare('DELETE FROM plugin_states WHERE company_id = ? AND plugin_id = ?').run(companyId, pluginId)
  db.prepare(
    `INSERT INTO plugin_company_installs
       (company_id, plugin_id, installed_by, installed_at, updated_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (company_id, plugin_id)
     DO UPDATE SET removed_at = excluded.removed_at, updated_at = excluded.updated_at`,
  ).run(companyId, pluginId, actorId, ownRecord?.installedAt ?? now, now, now)

  const ownersAfter = activeCompanyOwners(db, pluginId)
  const personalOwners = activeUserOwners(db, pluginId)
  const shared = ownersAfter > 0
  let trashPath: string | null = null
  // 还有公司或员工在用这个包时，不能把目录移走；公司卸载只解除公司归属。
  if (!shared && personalOwners === 0) {
    mkdirSync(trashDir(), { recursive: true })
    trashPath = join(trashDir(), `${pluginId}-${Date.now()}`)
    renameSync(dir, trashPath)
    const existing = installRecordOf(db, pluginId)
    db.prepare(
      `INSERT INTO plugin_installs
         (plugin_id, version, source, source_ref, checksum, installed_by, installed_at, updated_at, removed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (plugin_id)
       DO UPDATE SET removed_at = excluded.removed_at, updated_at = excluded.updated_at`,
    ).run(
      pluginId,
      record.version,
      existing?.source ?? 'disk',
      existing?.sourceRef ?? dir,
      existing?.checksum ?? record.checksum,
      actorId,
      existing?.installedAt ?? now,
      now,
      now,
    )
  }

  recordPluginEvent(db, {
    pluginId,
    companyId,
    event: 'uninstall',
    actorId,
    detail: JSON.stringify({ trashPath, version: record.version, shared, personalOwners }),
  })

  return { pluginId, trashPath, version: record.version, shared }
}

export function recordPluginEvent(
  db: Db,
  input: {
    pluginId: string
    companyId?: string | null
    event: string
    actorId?: string | null
    detail?: string | null
  },
): void {
  db.prepare(
    `INSERT INTO plugin_events (plugin_id, company_id, event, actor_id, detail, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.pluginId, input.companyId ?? null, input.event, input.actorId ?? null, input.detail ?? null, Date.now())
}

export function listPluginEvents(db: Db, limit = 20, companyId?: string): PluginEventRecord[] {
  const rows = db
    .prepare(
      `SELECT id, plugin_id, company_id, event, actor_id, detail, at
         FROM plugin_events
        ${companyId ? 'WHERE company_id IS NULL OR company_id = ?' : ''}
        ORDER BY at DESC LIMIT ?`,
    )
    .all(...(companyId ? [companyId, Math.min(Math.max(limit, 1), 100)] : [Math.min(Math.max(limit, 1), 100)]))
    .slice(0, Math.min(Math.max(limit, 1), 100)) as unknown as Array<{
    id: number
    plugin_id: string
    company_id: string | null
    event: string
    actor_id: string | null
    detail: string | null
    at: number
  }>
  return rows.map((row) => ({
    id: row.id,
    pluginId: row.plugin_id,
    companyId: row.company_id,
    event: row.event,
    actorId: row.actor_id,
    detail: row.detail,
    at: row.at,
  }))
}

export function pluginRoot(): string {
  return pluginRootPath
}

/** 磁盘上的插件目录清单（跳过 .trash / .staging / 下划线目录） */
export function listPluginDirectories(): Array<{ id: string; dir: string }> {
  if (!existsSync(pluginRootPath)) return []
  return readdirSync(pluginRootPath)
    .filter((name) => !name.startsWith('.') && !name.startsWith('_'))
    .flatMap((name) => {
      const dir = join(pluginRootPath, name)
      try {
        return statSync(dir).isDirectory() ? [{ id: name, dir }] : []
      } catch {
        return []
      }
    })
}

/** 按目录名读取单个插件清单（DSH host 运行时启动时用） */
export function readPluginDirectory(id: string): PluginRecord | null {
  if (!ID_PATTERN.test(id)) return null
  const dir = join(pluginRootPath, id)
  if (!existsSync(dir)) return null
  const { record } = parseManifest(dir, id)
  return { ...record, enabled: record.valid }
}

export function relativeToRoot(path: string): string {
  return relative(pluginRootPath, path)
}

