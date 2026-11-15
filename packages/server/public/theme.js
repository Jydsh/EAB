/*
 * 主题偏好：cookie + localStorage，先读 cookie。
 * 8787（对话）和 8788（控制台）端口不同，localStorage 不共享，但同主机的 cookie 共享，
 * 所以在后台切深色，刷新对话页也会跟着变。
 */
(function () {
  var KEY = 'eab_theme'
  var root = document.documentElement
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null

  function readCookie() {
    try {
      var hit = document.cookie.split('; ').filter(function (item) {
        return item.indexOf(KEY + '=') === 0
      })[0]
      if (!hit) return null
      var value = decodeURIComponent(hit.slice(KEY.length + 1))
      return value === 'dark' || value === 'light' ? value : null
    } catch {
      return null
    }
  }

  function readLocal() {
    try {
      var value = window.localStorage.getItem(KEY)
      return value === 'dark' || value === 'light' ? value : null
    } catch {
      return null
    }
  }

  function explicitTheme() {
    return readCookie() || readLocal()
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
      document.cookie = KEY + '=' + theme + '; path=/; max-age=31536000; SameSite=Lax'
    } catch {}
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

  // 同一页面的另一个标签页改了主题，这里跟着切。
  window.addEventListener('storage', function (event) {
    if (event.key !== KEY) return
    if (event.newValue === 'dark' || event.newValue === 'light') apply(event.newValue)
  })

  // 8787 与 8788 端口不同，localStorage 不互通；切回这个标签页时重读 cookie，
  // 让后台切好的主题在对话页立即可见。
  function syncFromSharedCookie() {
    if (document.visibilityState === 'hidden') return
    var theme = explicitTheme()
    if (theme && theme !== root.dataset.theme) apply(theme)
  }
  window.addEventListener('focus', syncFromSharedCookie)
  document.addEventListener('visibilitychange', syncFromSharedCookie)

  // 用户没有明确选择过时，跟随系统。
  if (media) {
    var onChange = function (event) {
      if (!explicitTheme()) apply(event.matches ? 'dark' : 'light')
    }
    if (media.addEventListener) media.addEventListener('change', onChange)
    else if (media.addListener) media.addListener(onChange)
  }
})()
