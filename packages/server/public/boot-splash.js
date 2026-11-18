/**
 * 登录后启动层控制器。
 *
 * 设计约束：
 * - 只在 /admin、/chat 使用，不能影响登录门本身；
 * - 登录跳转播放完整片头；普通刷新只播轻启动代码动画，应用就绪即退场；
 * - 电影片头失败、缺少片源、浏览器拒绝自动播放时，都要回退代码版，不能黑屏；
 * - 所有选择都以服务端下发的 window.EAB_BOOT_CONFIG 为准。
 */
(function () {
  'use strict'

  const overlay = document.getElementById('eab-boot')
  if (!overlay) return

  const script = document.currentScript
  const surface = script && script.dataset.surface === 'admin' ? 'admin' : 'chat'
  const defaults = {
    enabled: true,
    mode: 'code',
    surface,
    assetUrl: null,
    assetDurationSec: null,
    durationMax: surface === 'admin' ? 2.6 : 6.5,
    allowSound: false,
    allowSkip: true,
    playOn: 'login',
    title: 'EAB',
    subtitle: surface === 'admin' ? '管理控制台' : '企业智能体基座',
  }
  const config = Object.assign({}, defaults, window.EAB_BOOT_CONFIG || {})
  config.surface = surface

  const video = document.getElementById('eab-boot-video')
  const code = document.getElementById('eab-boot-code')
  const titleNode = document.getElementById('eab-boot-title')
  const subtitleNode = document.getElementById('eab-boot-subtitle')
  const filmTitle = document.getElementById('eab-boot-film-title')
  const filmSubtitle = document.getElementById('eab-boot-film-subtitle')
  const statusNode = document.getElementById('eab-boot-status')
  const soundButton = document.getElementById('eab-boot-sound')
  const skipButton = document.getElementById('eab-boot-skip')
  const playButton = document.getElementById('eab-boot-play')
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const state = {
    started: false,
    ready: false,
    minElapsed: false,
    filmDone: false,
    finished: false,
    leaving: false,
    mode: 'code',
    refresh: false,
    startedAt: 0,
    minMs: 0,
    paceMs: 1600,
    maxTimer: 0,
    progressTimer: 0,
    refreshStatusTimer: 0,
    refreshSlowTimer: 0,
    playAttempted: false,
    previewing: false,
    leaveScheduled: false,
    loginTransition: false,
    fullIntro: false,
    finishTimer: 0,
  }

  function safeGet(key) {
    try {
      return window.sessionStorage.getItem(key)
    } catch {
      return null
    }
  }

  function safeSet(key, value) {
    try {
      window.sessionStorage.setItem(key, value)
    } catch {
      /* 隐私模式禁用 sessionStorage 时，只影响去重，不影响启动 */
    }
  }

  function safeRemove(key) {
    try {
      window.sessionStorage.removeItem(key)
    } catch {
      /* 隐私模式禁用 sessionStorage 时，只影响去重，不影响启动 */
    }
  }

  function bootIntent() {
    if (!config.enabled || config.mode === 'off') return 'off'
    // 登录成功后由目标页面播放完整启动动画做过渡，避免中间出现空白帧。
    const requested = new URL(location.href).searchParams.get('eab_boot')
    if (requested === 'full') return 'full'
    if (requested === 'off') return 'off'
    const jump = safeGet('eab.boot.next') === surface
    if (jump) {
      safeRemove('eab.boot.next')
      return 'login'
    }
    if (config.playOn === 'always') return 'full'
    if (config.playOn === 'new-session' && safeGet(`eab.boot.seen.${surface}`) !== '1') return 'full'
    // 刷新不是登录跳转：不重播完整片头，只保留一段可观察的代码轻启动。
    return 'refresh'
  }

  function clearRefreshTimers() {
    clearTimeout(state.refreshStatusTimer)
    clearTimeout(state.refreshSlowTimer)
    state.refreshStatusTimer = 0
    state.refreshSlowTimer = 0
  }

  function scheduleRefreshStatus() {
    clearRefreshTimers()
    state.refreshStatusTimer = window.setTimeout(() => {
      if (state.finished || state.leaving || !state.refresh) return
      setStatus(surface === 'admin' ? '正在加载组织与权限…' : '正在加载工作区…')
    }, 650)
    state.refreshSlowTimer = window.setTimeout(() => {
      if (state.finished || state.leaving || !state.refresh) return
      setStatus('网络较慢，仍在加载…')
    }, 2000)
  }

  function clearBootBackground() {
    // 保留首帧兜底样式，但退场后让 body 自己的底色接管，避免页面边缘露出深绿色。
    document.documentElement.style.background = 'transparent'
  }

  function resetLoginScroll() {
    if (!state.fullIntro) return
    // 登录跳转不能被浏览器恢复成上一次的滚动位置，否则控制台标题栏会“消失”，看起来像布局变形。
    try {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
      document.documentElement.scrollTop = 0
      document.body.scrollTop = 0
    } catch {
      /* ignore */
    }
  }

  function setText(node, value) {
    if (node) node.textContent = value || ''
  }

  function applyCopy() {
    setText(titleNode, config.title)
    setText(subtitleNode, config.subtitle)
    setText(filmTitle, config.title)
    setText(filmSubtitle, config.subtitle)
  }

  function setMode(mode) {
    state.mode = mode
    overlay.dataset.mode = mode
    if (video) video.hidden = mode !== 'film'
  }

  function setStatus(text) {
    setText(statusNode, text)
  }

  function show() {
    overlay.hidden = false
    overlay.setAttribute('aria-hidden', 'false')
    document.documentElement.classList.add('eab-booting')
  }

  function setProgress(value) {
    const progress = Math.max(0, Math.min(1, value))
    overlay.style.setProperty('--boot-arc', `${72 + progress * 216}deg`)
  }

  function startProgress() {
    clearInterval(state.progressTimer)
    state.progressTimer = window.setInterval(() => {
      if (state.finished) return
      const elapsed = Date.now() - state.startedAt
      const target = state.ready
        ? 1
        : Math.min(0.9, elapsed / Math.max(1, state.paceMs))
      setProgress(target)
      if (state.ready && target >= 1) clearInterval(state.progressTimer)
    }, 120)
  }

  function resetVisual() {
    clearRefreshTimers()
    clearTimeout(state.maxTimer)
    state.refresh = false
    overlay.classList.remove('is-leaving', 'is-film-ready', 'is-login-transition', 'is-refresh')
    overlay.style.removeProperty('--boot-arc')
    setProgress(0)
    setMode('code')
    if (video) {
      video.pause()
      video.removeAttribute('src')
      try {
        video.load()
      } catch {
        /* ignore */
      }
      video.muted = true
      video.hidden = true
    }
    if (playButton) playButton.hidden = true
    if (soundButton) soundButton.hidden = true
    if (skipButton) skipButton.hidden = true
  }

  function finish(force) {
    if (state.finished || state.leaving) return
    if (!force && (!state.ready || !state.minElapsed)) return
    state.leaving = true
    clearInterval(state.progressTimer)
    clearTimeout(state.maxTimer)
    clearRefreshTimers()
    if (video) {
      try {
        video.pause()
      } catch {
        /* ignore */
      }
    }
    overlay.classList.add('is-leaving')
    resetLoginScroll()
    clearTimeout(state.finishTimer)
    state.finishTimer = window.setTimeout(() => {
      state.finishTimer = 0
      state.finished = true
      overlay.hidden = true
      overlay.setAttribute('aria-hidden', 'true')
      overlay.classList.remove('is-leaving', 'is-film-ready', 'is-login-transition', 'is-refresh')
      document.documentElement.classList.remove('eab-booting')
      clearBootBackground()
      resetLoginScroll()
      if (video) {
        video.removeAttribute('src')
        try {
          video.load()
        } catch {
          /* ignore */
        }
      }
    }, reduceMotion ? 180 : 340)
  }

  function checkFinish() {
    if (state.finished || state.leaving || state.leaveScheduled) return
    if (!state.ready || !state.minElapsed) return
    if (state.mode === 'film' && !state.filmDone) return
    // 至少让浏览器画出一帧启动层，避免加载极快时闪一下就消失。
    state.leaveScheduled = true
    // 后台标签页不会触发 rAF；这里必须有计时器兜底，否则启动层会一直盖住页面。
    if (document.hidden || typeof window.requestAnimationFrame !== 'function') {
      window.setTimeout(() => {
        state.leaveScheduled = false
        finish()
      }, reduceMotion ? 0 : 32)
      return
    }
    const raf = window.requestAnimationFrame
    raf(() => {
      raf(() => {
        state.leaveScheduled = false
        finish()
      })
    })
  }

  function fallbackToCode(reason) {
    if (state.mode !== 'film') return
    clearTimeout(state.maxTimer)
    setMode('code')
    overlay.classList.remove('is-film-ready')
    if (video) {
      video.pause()
      video.removeAttribute('src')
      try {
        video.load()
      } catch {
        /* ignore */
      }
      video.hidden = true
    }
    if (playButton) playButton.hidden = true
    if (soundButton) soundButton.hidden = true
    state.filmDone = true
    if (state.previewing) {
      const elapsed = Date.now() - state.startedAt
      state.minMs = Math.max(1200, state.minMs || 1200)
      state.minElapsed = false
      window.setTimeout(() => {
        state.minElapsed = true
        checkFinish()
      }, Math.max(350, state.minMs - elapsed))
    } else {
      state.minElapsed = true
      checkFinish()
    }
    if (reason) setStatus(reason)
  }

  function prepareCode() {
    setMode('code')
    overlay.classList.remove('is-film-ready')
    if (soundButton) soundButton.hidden = true
    setStatus(surface === 'admin' ? '正在加载控制台配置…' : '正在验证登录状态…')
    state.minMs = 0
    state.filmDone = true
    if (!state.previewing) {
      // 正常启动：不设最短展示，首屏 ready 就退场，动画只覆盖真实加载时间。
      state.minElapsed = true
      return
    }
    // 后台预览：需要一个可观察的播放时长，不写入真实启动流程。
    state.minElapsed = false
    const previewMs = Math.max(1200, Math.min(2400, Number(config.durationMax) * 1000))
    window.setTimeout(() => {
      state.minElapsed = true
      setStatus('正在进入…')
      checkFinish()
    }, previewMs)
  }

  function showPlayButton() {
    if (playButton) playButton.hidden = false
    setStatus('浏览器拦截了自动播放，点一下开始')
    if (video) video.pause()
  }

  function attemptPlay() {
    if (!video || state.mode !== 'film') return
    state.playAttempted = true
    video.muted = true
    const promise = video.play()
    if (promise && typeof promise.catch === 'function') {
      promise
        .then(() => {
          if (playButton) playButton.hidden = true
          setStatus('正在播放片头…')
        })
        .catch(() => showPlayButton())
    }
  }

  function filmDone() {
    if (state.filmDone) return
    clearTimeout(state.maxTimer)
    state.filmDone = true
    state.minElapsed = true
    setStatus('正在进入…')
    checkFinish()
  }

  function prepareFilm() {
    if (!video || !config.assetUrl || (reduceMotion && !state.previewing)) {
      prepareCode()
      return
    }
    setMode('film')
    overlay.classList.remove('is-film-ready')
    state.filmDone = false
    state.minElapsed = false
    state.minMs = 0
    if (soundButton) soundButton.hidden = !config.allowSound
    if (skipButton) skipButton.hidden = !config.allowSkip
    if (playButton) playButton.hidden = true
    setStatus('正在播放片头…')
    video.hidden = false
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.src = config.assetUrl
    video.addEventListener('canplay', () => {
      if (!state.playAttempted) attemptPlay()
      window.setTimeout(() => overlay.classList.add('is-film-ready'), reduceMotion ? 0 : 420)
    }, { once: true })
    video.addEventListener('ended', filmDone, { once: true })
    video.addEventListener('error', () => fallbackToCode('片源无法播放，已回退代码高定版'), { once: true })
    video.load()
    const cap = Math.max(0.8, Math.min(Number(config.durationMax) || 6.5, Number(config.assetDurationSec) || 8))
    state.maxTimer = window.setTimeout(filmDone, cap * 1000 + 80)
  }

  function start(options) {
    if (state.started && !options?.preview && !options?.loginTransition) return
    if (options?.loginTransition) {
      // 失败后可能再次扫码：先清掉上一轮的退场状态，再重新铺层。
      resetVisual()
      state.started = false
    }
    if (state.started && options?.preview) {
      // 预览时先让上一轮退场，避免两层叠着
      resetVisual()
      state.finished = false
      state.leaving = false
      state.leaveScheduled = false
    }
    state.started = true
    state.ready = false
    state.minElapsed = false
    state.filmDone = false
    state.finished = false
    state.leaving = false
    state.leaveScheduled = false
    state.loginTransition = Boolean(options?.loginTransition)
    state.fullIntro = Boolean(options?.fullIntro)
    state.refresh = Boolean(options?.refresh)
    overlay.classList.toggle('is-login-transition', state.loginTransition)
    overlay.classList.toggle('is-refresh', state.refresh)
    state.startedAt = Date.now()
    clearTimeout(state.finishTimer)
    clearTimeout(state.maxTimer)
    state.finishTimer = 0
    state.paceMs = state.refresh ? 900 : 1600
    applyCopy()
    show()
    startProgress()
    if (options?.fullIntro) {
      // 登录过渡只覆盖真实加载时间：应用 ready 就退场，不强制播完整片头。
      prepareCode()
      state.minMs = 250
      state.minElapsed = false
      setStatus(surface === 'admin' ? '正在进入管理控制台…' : '正在进入工作台…')
      clearTimeout(state.maxTimer)
      state.maxTimer = window.setTimeout(() => {
        if (state.ready) {
          state.minElapsed = true
          checkFinish()
          return
        }
        setStatus('页面加载较慢，正在等待控制台就绪…')
        state.maxTimer = window.setTimeout(() => finish(true), 5000)
      }, 8000)
      window.setTimeout(() => {
        if (state.finished || state.leaving) return
        state.minElapsed = true
        checkFinish()
      }, 250)
      return
    }
    if (options?.preview) {
      if (config.mode === 'film' && config.assetUrl) prepareFilm()
      else prepareCode()
      state.ready = true
      checkFinish()
      return
    }
    if (options?.loginTransition) {
      // 扫码登录过渡：只做加载覆盖，不写一次性规则，也不等电影片长。
      prepareCode()
      setStatus('已识别扫码，正在登录…')
      return
    }
    if (state.refresh) {
      // 刷新轻启动：不加载 MP4，不播放完整片头；至少保留 480ms，应用就绪即退场。
      prepareCode()
      state.minMs = 480
      state.minElapsed = false
      setStatus(surface === 'admin' ? '正在恢复控制台…' : '正在恢复会话…')
      scheduleRefreshStatus()
      window.setTimeout(() => {
        if (state.finished || state.leaving || !state.refresh) return
        state.minElapsed = true
        // 只有应用已经就绪时才展示“即将进入”，否则继续保留真实加载文案。
        if (state.ready) setStatus('即将进入')
        checkFinish()
      }, 480)
      // 页面脚本没就绪时也不能无限盖住内容；到点后退回应用自己的页面。
      state.maxTimer = window.setTimeout(() => finish(true), 2600)
      return
    }
    if (config.mode === 'film' && config.assetUrl) prepareFilm()
    else prepareCode()
    safeSet(`eab.boot.seen.${surface}`, '1')
    if (config.fallbackReason) setStatus(config.fallbackReason)
  }

  function ready(text) {
    if (!state.started) return
    clearRefreshTimers()
    state.ready = true
    if (text) setStatus(text)
    else if (state.mode === 'film' && !state.filmDone) setStatus('影片播完就进入…')
    else setStatus('正在进入…')
    setProgress(1)
    checkFinish()
  }

  function beginLogin(text) {
    if (state.started && !state.finished && !state.leaving) {
      setStatus(text || '已识别扫码，正在登录…')
      return
    }
    state.previewing = false
    state.started = false
    start({ loginTransition: true })
    setStatus(text || '已识别扫码，正在登录…')
  }

  function fail(text) {
    if (!state.started) return
    clearRefreshTimers()
    setStatus(text || '启动遇到问题')
    window.setTimeout(() => finish(true), 1600)
  }

  function preview(nextConfig) {
    if (!state.started) {
      state.started = true
      resetVisual()
    }
    const next = Object.assign({}, config, nextConfig || {})
    Object.assign(config, next)
    state.previewing = true
    start({ preview: true })
  }

  if (skipButton) {
    skipButton.addEventListener('click', () => {
      if (state.loginTransition) return
      finish(true)
    })
  }
  if (soundButton) {
    soundButton.addEventListener('click', () => {
      if (!video) return
      video.muted = !video.muted
      soundButton.textContent = video.muted ? '开启声音' : '关闭声音'
      if (!video.muted) {
        video.volume = 1
        if (video.paused) attemptPlay()
      }
    })
  }
  if (playButton) {
    playButton.addEventListener('click', () => {
      attemptPlay()
      overlay.classList.add('is-film-ready')
    })
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (overlay.hidden) return
    if (state.loginTransition) return
    if (!config.allowSkip && state.mode === 'film') return
    finish(true)
  })

  if (soundButton) soundButton.textContent = '开启声音'
  if (skipButton) skipButton.textContent = '跳过'

  window.EABBoot = {
    ready,
    fail,
    preview,
    finish,
    beginLogin,
    get started() {
      return state.started
    },
    get finished() {
      return state.finished
    },
    surface,
    config,
  }

  try {
    const intent = bootIntent()
    if (intent === 'off') {
      overlay.hidden = true
      overlay.setAttribute('aria-hidden', 'true')
      document.documentElement.classList.remove('eab-booting')
      clearBootBackground()
    } else if (intent === 'full' || intent === 'login') {
      start({ fullIntro: true })
    } else {
      start({ refresh: true })
    }
  } catch (error) {
    // 启动层自身出错时，宁可少一段动画，也不能让覆盖层把后台页面按住。
    console.error('[eab-boot] 启动层初始化失败，已直接进入页面', error)
    overlay.hidden = true
    overlay.setAttribute('aria-hidden', 'true')
    document.documentElement.classList.remove('eab-booting')
    clearBootBackground()
  }
})()
