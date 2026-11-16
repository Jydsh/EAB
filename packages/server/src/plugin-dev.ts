/**
 * 插件自开发（DSH 式 bundle 自举）：
 * - 在员工云空间里生成一个可编辑的 DSH UI 插件骨架；
 * - 把工作区目录直接安装成个人插件实例，安装即热生效，不需要浏览器上传或重启服务；
 * - 安装后返回 `/plugin-kernel.html` 预览地址，插件页会自己轮询版本指纹并在重装后刷新。
 *
 * 这里只做“包结构 + 安装 + 预览地址”，真正的插件代码由 Agent 用 workspace.write /
 * workspace.edit 在工作区里改。插件源码不写进 plugins/<id>，安装时由 plugins.ts 复制。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EC, EabError } from '@eab/domain'
import type { Db } from '@eab/storage'
import { installPluginPackage, type InstallPluginResult, type PluginRecord } from './plugins.js'

/** 员工工作区里放自开发插件的默认目录，和普通文件一样可以被 workspace 工具编辑。 */
export const PLUGIN_DEV_DIR = '.eab-plugins'

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,40}$/

export function normalizePluginDevId(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[/@]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41)
    .replace(/-+$/, '')
  const id = /^[a-z]/.test(raw) ? raw : `p-${raw}`.slice(0, 41)
  if (!id || !PLUGIN_ID_PATTERN.test(id)) {
    throw new EabError(EC.VALIDATION, `插件 id 不合法：${String(value ?? '')}；要求小写字母开头，只含 a-z 0-9 -，2-41 位`)
  }
  return id
}

export interface PluginDevScaffoldOptions {
  /** 插件包目录（绝对路径，通常是 userScopeDir/.eab-plugins/<id>） */
  readonly dir: string
  readonly pluginId: string
  readonly title: string
  readonly description?: string
  readonly accent?: string
  /** 已存在时是否允许重置为模板；默认 false，避免覆盖 Agent 已经写好的页面 */
  readonly overwrite?: boolean
}

export interface PluginDevScaffoldResult {
  readonly dir: string
  readonly pluginId: string
  readonly files: string[]
  readonly created: boolean
}

function assertDirEmptyOrAllowed(dir: string, overwrite: boolean): boolean {
  if (!existsSync(dir)) return true
  if (!statSync(dir).isDirectory()) {
    throw new EabError(EC.VALIDATION, `插件源码路径不是目录：${dir}`)
  }
  const packagePath = join(dir, 'package.json')
  if (existsSync(packagePath) && !overwrite) {
    throw new EabError(EC.CONFLICT, `插件源码目录已存在：${dir}`, {
      hint: '继续用 workspace.edit 改现有文件；确需重置为模板时传 overwrite=true。',
    })
  }
  return false
}

function pluginClientSource(pluginId: string, title: string, description: string, accent: string): string {
  const accentJson = JSON.stringify(accent)
  const titleJson = JSON.stringify(title)
  const descriptionJson = JSON.stringify(description)
  return `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pluginId)},
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ACCENT = ${accentJson}
    const TITLE = ${titleJson}
    const DESCRIPTION = ${descriptionJson}

    function SelfDevCard() {
      const [tick, setTick] = React.useState(0)
      const [now, setNow] = React.useState(function () { return new Date() })
      React.useEffect(function () {
        const timer = setInterval(function () {
          setTick(function (value) { return value + 1 })
          setNow(new Date())
        }, 1000)
        return function () { clearInterval(timer) }
      }, [])

      const pad = function (value) { return String(value).padStart(2, '0') }
      const clock = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds())

      return h('section', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          padding: 24,
          borderRadius: 18,
          border: '1px solid color-mix(in srgb, ' + ACCENT + ' 26%, transparent)',
          background: 'linear-gradient(135deg, color-mix(in srgb, ' + ACCENT + ' 10%, #ffffff) 0%, #ffffff 58%)',
          color: '#15202b',
          boxShadow: '0 18px 46px rgba(16, 38, 68, 0.10)',
          fontFamily: 'inherit',
        },
      }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 } }, [
          h('div', { key: 'copy', style: { minWidth: 0 } }, [
            h('div', {
              key: 'kicker',
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 999,
                background: 'color-mix(in srgb, ' + ACCENT + ' 14%, #ffffff)',
                color: ACCENT,
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: '0.08em',
              },
            }, 'EAB SELF-DEV PLUGIN'),
            h('h1', { key: 'title', style: { margin: '12px 0 6px', fontSize: 26, lineHeight: 1.2, letterSpacing: '-0.02em' } }, TITLE),
            h('p', { key: 'desc', style: { margin: 0, color: '#52606d', fontSize: 14, lineHeight: 1.7 } }, DESCRIPTION),
          ]),
          h('div', {
            key: 'clock',
            style: {
              flex: '0 0 auto',
              minWidth: 104,
              padding: '10px 12px',
              borderRadius: 12,
              background: '#0f172a',
              color: '#e2e8f0',
              textAlign: 'center',
              fontVariantNumeric: 'tabular-nums',
            },
          }, [
            h('div', { key: 't', style: { fontSize: 11, opacity: 0.66, letterSpacing: '0.12em' } }, 'LIVE'),
            h('div', { key: 'v', style: { marginTop: 4, fontSize: 22, fontWeight: 700 } }, clock),
          ]),
        ]),
        h('div', { key: 'stats', style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 } }, [
          ['插件 ID', ${JSON.stringify(pluginId)}],
          ['热更新', '已生效'],
          ['运行帧', String(tick) + 's'],
        ].map(function (item) {
          return h('div', {
            key: item[0],
            style: {
              padding: '12px 14px',
              borderRadius: 12,
              border: '1px solid #e6ebf1',
              background: 'rgba(255, 255, 255, 0.78)',
            },
          }, [
            h('div', { key: 'k', style: { fontSize: 11, color: '#6b7785', letterSpacing: '0.08em' } }, item[0]),
            h('div', { key: 'v', style: { marginTop: 5, fontSize: 15, fontWeight: 700, color: '#1f2937', overflowWrap: 'anywhere' } }, item[1]),
          ])
        })),
        h('div', {
          key: 'hint',
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            paddingTop: 4,
            color: '#5b6673',
            fontSize: 13,
          },
        }, [
          h('span', { key: 'text' }, 'Agent 改完 client.js 后再 install 一次，这个页面会在 2 秒内自动刷新。'),
          h('a', {
            key: 'reload',
            href: location.href,
            style: { color: ACCENT, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' },
          }, '立即刷新'),
        ]),
      ])
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: 'home', order: 10 }, SelfDevCard)
        })
      },
    }
  },
})
`
}

function pluginIconSvg(accent: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect x="2" y="2" width="60" height="60" rx="16" fill="${accent}"/>
  <path d="M18 22h28v6H18zm0 12h18v6H18z" fill="#fff" opacity=".92"/>
  <circle cx="45" cy="43" r="7" fill="#fff"/>
</svg>
`
}

export function createPluginDevScaffold(options: PluginDevScaffoldOptions): PluginDevScaffoldResult {
  const pluginId = normalizePluginDevId(options.pluginId)
  const dir = options.dir
  const created = assertDirEmptyOrAllowed(dir, Boolean(options.overwrite))
  const title = String(options.title || pluginId).trim() || pluginId
  const description =
    String(options.description || '').trim() ||
    '这是 Agent 在 EAB 工作区里写出来的 DSH UI 插件：安装后立即生效，改完源码再安装一次就能看到新界面。'
  const accentRaw = String(options.accent || '#2563eb').trim()
  const accent = /^#[0-9a-f]{6}$/i.test(accentRaw) ? accentRaw : '#2563eb'
  mkdirSync(join(dir, 'locale'), { recursive: true })

  const packageJson = {
    name: pluginId,
    version: '0.1.0',
    private: true,
    type: 'module',
    description,
    exports: {
      '.': './index.js',
      './client': './client.js',
      './locale/*.json': './locale/*.json',
      './icon': './icon.svg',
    },
    files: ['index.js', 'client.js', 'cordis.patch.yml', 'locale', 'icon.svg', 'README.md'],
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: {
        platform: 'web',
        immediately: true,
      },
      ui: {
        title,
        pages: [{ id: 'home', title, file: 'client.js' }],
      },
    },
  }

  const files: Array<[string, string]> = [
    ['package.json', `${JSON.stringify(packageJson, null, 2)}\n`],
    ['cordis.patch.yml', `- insert:\n    - id: ${pluginId}\n      name: ${pluginId}\n`],
    ['index.js', `/** Host half of the self-developed bundle; the Client module owns the page UI. */\nexport function apply() {}\n`],
    ['client.js', pluginClientSource(pluginId, title, description, accent)],
    ['icon.svg', pluginIconSvg(accent)],
    [
      'locale/zh-CN.json',
      `${JSON.stringify({ 'plugin.title': title, 'plugin.description': description }, null, 2)}\n`,
    ],
    [
      'README.md',
      [
        `# ${title}`,
        '',
        '这是 EAB Agent 自开发插件骨架，结构对齐 DSH bundle：',
        '',
        '- `package.json`：`dsh.bundle.patch` 指向 Cordis patch，`dsh.client` 声明 web client，`dsh.ui.pages` 指向 client.js。',
        '- `cordis.patch.yml`：把插件行插入当前 profile。',
        '- `index.js`：Host 侧 `apply()`；当前页面不需要 Host 能力。',
        '- `client.js`：`window.__ModuleLoader__.load` 注册模块，并在 `apply(ctx)` 里往 `main` slot 注册页面。',
        '',
        '改 `client.js` 后调用 `plugin_dev` action=install 热更新；不要手工复制到 plugins 目录，也不要重启服务。',
        '',
      ].join('\n'),
    ],
  ]
  for (const [rel, text] of files) {
    writeFileSync(join(dir, rel), text, 'utf8')
  }
  return { dir, pluginId, files: files.map(([rel]) => rel), created }
}

export interface PluginDevInstallOptions {
  readonly companyId: string
  readonly userId: string
  readonly installedBy: string
  readonly dir: string
  readonly sourceRef?: string
}

export function installPluginDevBundle(db: Db, options: PluginDevInstallOptions): InstallPluginResult {
  const dir = options.dir
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new EabError(EC.VALIDATION, `插件源码目录不存在：${dir}；先调用 plugin_dev action=create`)
  }
  return installPluginPackage(db, dir, {
    companyId: options.companyId,
    installedBy: options.installedBy,
    scope: 'user',
    userId: options.userId,
    overwrite: true,
    source: 'workspace-dev',
    sourceRef: options.sourceRef ?? dir,
  })
}

export interface PluginPreviewLink {
  readonly id: string
  readonly title: string
  readonly version: string
  readonly checksum: string
  readonly entry: string
  readonly previewPath: string
  readonly pageCount: number
}

/** 给聊天工具卡和 Agent 回话用；前端会再追加当前 `as` 开发身份。 */
export function pluginPreviewLink(plugin: PluginRecord, companyId: string, scope: 'user' | 'console' = 'user'): PluginPreviewLink {
  const page = plugin.pages[0]
  const params = new URLSearchParams({
    id: plugin.id,
    company: companyId,
    version: plugin.version,
    title: page?.title || plugin.name || plugin.id,
    scope,
  })
  if (page?.file) params.set('entry', page.file)
  if (plugin.checksum) params.set('h', plugin.checksum)
  return {
    id: plugin.id,
    title: plugin.name || plugin.id,
    version: plugin.version,
    checksum: plugin.checksum,
    entry: page?.file || '',
    previewPath: `/plugin-kernel.html?${params.toString()}`,
    pageCount: plugin.pages.length,
  }
}

/** 只读 package.json 的 name，给“目录已存在但没有 pluginId 参数”的更新路径兜底。 */
export function pluginDevIdFromDir(dir: string): string {
  const packagePath = join(dir, 'package.json')
  if (!existsSync(packagePath)) {
    throw new EabError(EC.VALIDATION, `插件源码目录里没有 package.json：${dir}`)
  }
  try {
    const raw = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: unknown }
    return normalizePluginDevId(raw.name)
  } catch (error) {
    if (error instanceof EabError) throw error
    throw new EabError(EC.VALIDATION, `package.json 不是合法 JSON：${dir}`)
  }
}
