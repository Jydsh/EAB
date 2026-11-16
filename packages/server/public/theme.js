/*
 * 主题偏好：按页面表面隔离（工作台 / 管理后台）。
 * 8787（对话）和 8788（控制台）端口不同，localStorage 天然隔离；
 * 这里只读写当前表面自己的键，不再使用同主机共享 cookie，避免互相带动。
 */
(function () {
  var surface =
    (document.currentScript && document.currentScript.getAttribute('data-surface')) ||
    (location.pathname.indexOf('/admin') === 0 ? 'admin' : 'chat')
  var KEY = 'eab_theme:' + surface
  var LEGACY_KEY = 'eab_theme'
  var root = document.documentElement
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null

  function readLocal(key) {
    try {
      var value = window.localStorage.getItem(key)
      return value === 'dark' || value === 'light' ? value : null
    } catch {
      return null
    }
  }

  function readLegacy() {
    // 旧版在同一个 origin 的 localStorage 里也写过主题；只迁移本端口自己的值，
    // 不读取同主机共享 cookie，避免 8787/8788 首次加载时又被旧 cookie 串起来。
    return readLocal(LEGACY_KEY)
  }

  function explicitTheme() {
    var own = readLocal(KEY)
    if (own) return own
    // 一次性兼容旧版：旧偏好迁到当前表面，之后两个表面各用各的键。
    var legacy = readLegacy()
    if (!legacy) return null
    try {
      window.localStorage.setItem(KEY, legacy)
    } catch {}
    return legacy
  }

  function systemTheme() {
    return media && media.matches ? 'dark' : 'light'
  }

  function currentTheme() {
    return explicitTheme() || systemTheme()
  }

  function apply(theme) {
    var next = theme === 'dark' ? 'dark' : 'light'
    root.dataset.theme = next
    root.style.colorScheme = next
    document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
      var dark = next === 'dark'
      button.setAttribute('aria-checked', dark ? 'true' : 'false')
      button.setAttribute('aria-label', dark ? '切换到浅色主题' : '切换到深色主题')
      button.title = '切换深浅色主题'
    })
  }

  function persist(theme) {
    try {
      window.localStorage.setItem(KEY, theme)
    } catch {}
  }

  function bind() {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
      if (button.dataset.themeBound === '1') return
      button.dataset.themeBound = '1'
      button.addEventListener('click', function () {
        var next = root.dataset.theme === 'dark' ? 'light' : 'dark'
        persist(next)
        apply(next)
      })
    })
    apply(currentTheme())
  }

  // 尽早应用，避免首屏先亮后暗。
  apply(currentTheme())

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind, { once: true })
  } else {
    bind()
  }

  // 同一表面、同一浏览器的另一个标签页改了主题，这里跟着切；跨端口不再同步。
  window.addEventListener('storage', function (event) {
    if (event.key !== KEY) return
    if (event.newValue === 'dark' || event.newValue === 'light') apply(event.newValue)
  })

  // 用户没有明确选择过时，跟随系统。
  if (media) {
    var onChange = function (event) {
      if (!explicitTheme()) apply(event.matches ? 'dark' : 'light')
    }
    if (media.addEventListener) media.addEventListener('change', onChange)
    else if (media.addListener) media.addListener(onChange)
  }
})()
