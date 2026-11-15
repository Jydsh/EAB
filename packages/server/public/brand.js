/**
 * 管理控制台 / 员工对话共用的品牌外观。
 *
 * 读取公开的 /api/branding，写入当前页面的 favicon、标签标题、Logo 和品牌名。
 * 上传/保存逻辑放在控制台的「系统与运维」页，这里只负责渲染，避免登录页
 * 也依赖控制台接口。
 */
(function () {
  const DEFAULTS = {
    console: {
      logoText: 'EAB',
      brandName: '企业智能体基座',
      tabTitle: 'EAB 管理控制台',
      iconDataUrl: null,
    },
    chat: {
      logoText: 'EAB',
      brandName: '企业AI智能体基座',
      tabTitle: 'EAB 工作台',
      iconDataUrl: null,
    },
  }

  const normalizeText = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback)

  function normalizeSurface(raw, fallback) {
    const source = raw && typeof raw === 'object' ? raw : {}
    return {
      logoText: normalizeText(source.logoText, fallback.logoText),
      brandName: normalizeText(source.brandName, fallback.brandName),
      tabTitle: normalizeText(source.tabTitle, fallback.tabTitle),
      iconDataUrl: typeof source.iconDataUrl === 'string' && source.iconDataUrl.startsWith('data:image/')
        ? source.iconDataUrl
        : null,
    }
  }

  function normalize(raw) {
    const source = raw && typeof raw === 'object' ? raw : {}
    return {
      console: normalizeSurface(source.console, DEFAULTS.console),
      chat: normalizeSurface(source.chat, DEFAULTS.chat),
    }
  }

  function surfaceName() {
    const path = location.pathname.toLowerCase()
    return path.startsWith('/admin') || path.includes('admin-gate') ? 'console' : 'chat'
  }

  function xmlEscape(value) {
    return String(value).replace(/[<>&"']/g, (char) => ({
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      '"': '&quot;',
      "'": '&apos;',
    }[char]))
  }

  /** 没有上传图标时，用 Logo 文字生成一个同样可用的 favicon，避免标签页回到默认空白。 */
  function textIcon(text) {
    const value = xmlEscape(String(text || 'EAB').slice(0, 8))
    const fontSize = [...String(text || 'EAB')].length > 2 ? 20 : 28
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="15" fill="#0f766e"/>
      <text x="32" y="34" text-anchor="middle" dominant-baseline="middle" fill="#ffffff"
        font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="${fontSize}" font-weight="700">${value}</text>
    </svg>`
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  }

  function iconType(dataUrl) {
    const match = /^data:(image\/[^;]+)/i.exec(String(dataUrl || ''))
    return match ? match[1] : 'image/png'
  }

  function ensureFavicon() {
    let favicon = document.querySelector('#eab-favicon')
    if (!favicon) {
      favicon = document.createElement('link')
      favicon.id = 'eab-favicon'
      favicon.rel = 'icon'
      document.head.appendChild(favicon)
    }
    return favicon
  }

  function paintLogo(el, surface) {
    if (!el) return
    const icon = surface.iconDataUrl
    el.classList.toggle('has-image', Boolean(icon))
    el.replaceChildren()
    if (icon) {
      const image = document.createElement('img')
      image.src = icon
      image.alt = ''
      image.setAttribute('aria-hidden', 'true')
      el.appendChild(image)
      return
    }
    el.textContent = surface.logoText
  }

  function apply(surface, custom) {
    const next = custom || state[surface]
    document.title = next.tabTitle || DEFAULTS[surface].tabTitle
    const favicon = ensureFavicon()
    favicon.type = next.iconDataUrl ? iconType(next.iconDataUrl) : 'image/svg+xml'
    favicon.href = next.iconDataUrl || textIcon(next.logoText)
    for (const el of document.querySelectorAll('[data-brand-logo]')) paintLogo(el, next)
    for (const el of document.querySelectorAll('[data-brand-name]')) el.textContent = next.brandName
    document.documentElement.dataset.brandReady = '1'
    window.dispatchEvent(new CustomEvent('eab:branding', { detail: next }))
  }

  let state = normalize(null)
  let loading = null
  let lastLoadedAt = 0

  async function fetchBranding() {
    const res = await fetch('/api/branding', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body || body.ok === false) throw new Error(body?.message || `HTTP ${res.status}`)
    return normalize(body.data?.branding)
  }

  async function load() {
    if (loading) return loading
    const run = (async () => {
      try {
        state = await fetchBranding()
        lastLoadedAt = Date.now()
        apply(surfaceName())
      } catch {
        // 读不到时保留页面默认品牌，不让登录/对话入口因为品牌接口失败而卡住
        apply(surfaceName())
      }
      return state
    })()
    loading = run.finally(() => { loading = null })
    return loading
  }

  const Brand = {
    defaults: DEFAULTS,
    normalize,
    get current() {
      return state
    },
    get loadedAt() {
      return lastLoadedAt
    },
    load,
    apply: (surface = surfaceName(), custom) => apply(surface, custom),
    textIcon,
    iconType,
  }

  window.EABBrand = Brand
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void load(), { once: true })
  } else {
    void load()
  }
  window.addEventListener('focus', () => void load())
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void load()
  })
})()
