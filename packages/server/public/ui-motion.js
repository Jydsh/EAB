/* ==========================================================================
   EAB Motion Layer runtime
   --------------------------------------------------------------------------
   只处理需要运行时计算的效果：reveal / spotlight / magnetic / tilt /
   stagger / parallax / count / typewriter / scramble / marquee / spring。
   其余效果由 CSS 完成。所有效果必须显式写在 data-motion 上，不自动全局挂载。
   ========================================================================== */
(() => {
  'use strict'

  const doc = document
  const root = doc.documentElement
  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)')
  const hasIO = 'IntersectionObserver' in window
  const readyClass = 'eab-motion-ready'
  const observers = new Set()
  const parallaxItems = new Set()
  let booted = false
  let parallaxFrame = 0
  let parallaxBound = false
  let mutationObserver = null

  const reduced = () => reduceQuery.matches
  const canHover = () => finePointer.matches

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

  const ensureIO = () => {
    if (!hasIO) return null
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          io.unobserve(entry.target)
          const callback = entry.target.__eabOnVisible
          if (typeof callback === 'function') callback()
          delete entry.target.__eabOnVisible
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 }
    )
    observers.add(io)
    return io
  }

  const whenVisible = (el, callback) => {
    if (!hasIO) {
      callback()
      return
    }
    const io = ensureIO()
    el.__eabOnVisible = callback
    io.observe(el)
  }

  const inViewport = (el) => {
    const rect = el.getBoundingClientRect()
    return rect.top < window.innerHeight && rect.bottom > 0
  }

  const markIndexes = (parent) => {
    Array.from(parent.children).forEach((child, index) => {
      child.style.setProperty('--eab-i', String(Math.min(index, 12)))
    })
  }

  const settleVisible = () => {
    for (const el of doc.querySelectorAll('[data-motion~="stagger"]:not(.is-motion-in):not(.is-motion-skip)')) {
      if (inViewport(el)) el.classList.add('is-motion-in')
    }
    for (const el of doc.querySelectorAll('[data-motion~="reveal"]:not(.is-motion-in):not(.is-motion-skip)')) {
      if (inViewport(el)) el.classList.add('is-motion-in')
    }
  }

  const setupReveal = (el) => {
    if (reduced() || !hasIO || inViewport(el)) {
      el.classList.add('is-motion-skip')
      return
    }
    whenVisible(el, () => {
      el.classList.remove('is-motion-skip')
      el.classList.add('is-motion-in')
    })
  }

  const setupStagger = (el) => {
    markIndexes(el)
    if (reduced() || !hasIO || inViewport(el)) {
      el.classList.add('is-motion-in')
      return
    }
    whenVisible(el, () => {
      markIndexes(el)
      el.classList.add('is-motion-in')
    })
  }

  const setupSpotlight = (el) => {
    if (!canHover() || reduced()) return
    let frame = 0
    let nextX = 50
    let nextY = 50

    const paint = () => {
      frame = 0
      el.style.setProperty('--eab-spot-x', `${nextX}%`)
      el.style.setProperty('--eab-spot-y', `${nextY}%`)
    }

    const move = (event) => {
      const rect = el.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      nextX = ((event.clientX - rect.left) / rect.width) * 100
      nextY = ((event.clientY - rect.top) / rect.height) * 100
      if (!frame) frame = window.requestAnimationFrame(paint)
    }

    el.addEventListener('pointerenter', (event) => {
      el.classList.add('is-spotlight')
      move(event)
    })
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', () => {
      el.classList.remove('is-spotlight')
      if (frame) window.cancelAnimationFrame(frame)
      frame = 0
    })
  }

  const setupMagnetic = (el) => {
    if (!canHover() || reduced()) return
    const strength = Number(el.dataset.magnetStrength || 0.24)
    let frame = 0
    let nextX = 0
    let nextY = 0

    const paint = () => {
      frame = 0
      el.style.setProperty('--eab-magnet-x', `${nextX.toFixed(2)}px`)
      el.style.setProperty('--eab-magnet-y', `${nextY.toFixed(2)}px`)
    }

    const move = (event) => {
      const rect = el.getBoundingClientRect()
      const relX = event.clientX - rect.left - rect.width / 2
      const relY = event.clientY - rect.top - rect.height / 2
      nextX = clamp(relX * strength, -18, 18)
      nextY = clamp(relY * strength, -14, 14)
      if (!frame) frame = window.requestAnimationFrame(paint)
    }

    el.addEventListener('pointerenter', (event) => {
      el.classList.add('is-magnetized')
      move(event)
    })
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', () => {
      el.classList.remove('is-magnetized')
      nextX = 0
      nextY = 0
      if (!frame) frame = window.requestAnimationFrame(paint)
    })
  }

  const setupTilt = (el) => {
    if (!canHover() || reduced()) return
    const max = Number(el.dataset.tiltMax || 6)
    let frame = 0
    let nextX = 0
    let nextY = 0

    const paint = () => {
      frame = 0
      el.style.setProperty('--eab-tilt-x', `${nextX.toFixed(2)}deg`)
      el.style.setProperty('--eab-tilt-y', `${nextY.toFixed(2)}deg`)
    }

    const move = (event) => {
      const rect = el.getBoundingClientRect()
      const px = (event.clientX - rect.left) / rect.width - 0.5
      const py = (event.clientY - rect.top) / rect.height - 0.5
      nextY = clamp(px * max * 2, -max, max)
      nextX = clamp(-py * max * 2, -max, max)
      if (!frame) frame = window.requestAnimationFrame(paint)
    }

    el.addEventListener('pointerenter', (event) => {
      el.classList.add('is-tilting')
      move(event)
    })
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', () => {
      el.classList.remove('is-tilting')
      nextX = 0
      nextY = 0
      if (!frame) frame = window.requestAnimationFrame(paint)
    })
  }

  const setupParallax = (el) => {
    el.__eabParallaxSpeed = Number(el.dataset.parallaxSpeed || 0.08)
    parallaxItems.add(el)
    renderParallax()
    if (!parallaxBound) {
      parallaxBound = true
      window.addEventListener('scroll', requestParallax, { passive: true })
      window.addEventListener('resize', requestParallax)
    }
  }

  const requestParallax = () => {
    if (parallaxFrame) return
    parallaxFrame = window.requestAnimationFrame(() => {
      parallaxFrame = 0
      renderParallax()
    })
  }

  const renderParallax = () => {
    if (reduced()) {
      for (const el of parallaxItems) el.style.setProperty('--eab-parallax-y', '0px')
      return
    }
    for (const el of parallaxItems) {
      if (!el.isConnected) {
        parallaxItems.delete(el)
        continue
      }
      const rect = el.getBoundingClientRect()
      const center = rect.top + rect.height / 2
      const offset = (window.innerHeight / 2 - center) * (el.__eabParallaxSpeed || 0.08)
      el.style.setProperty('--eab-parallax-y', `${clamp(offset, -90, 90).toFixed(2)}px`)
    }
  }

  const formatNumber = (value, decimals) =>
    new Intl.NumberFormat('zh-CN', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(value)

  const setupCount = (el) => {
    const target = Number(el.dataset.countTo)
    if (!Number.isFinite(target)) return
    const decimals = Number(el.dataset.countDecimals || 0)
    const suffix = el.dataset.countSuffix || ''
    const prefix = el.dataset.countPrefix || ''
    const finalText = `${prefix}${formatNumber(target, decimals)}${suffix}`
    el.setAttribute('aria-label', finalText)

    if (reduced()) {
      el.textContent = finalText
      return
    }

    whenVisible(el, () => {
      const startValue = Number(el.dataset.countFrom || 0)
      const duration = Number(el.dataset.countDuration || 1200)
      const startedAt = performance.now()

      const tick = (now) => {
        const progress = clamp((now - startedAt) / duration, 0, 1)
        const eased = 1 - Math.pow(1 - progress, 4)
        const value = startValue + (target - startValue) * eased
        el.textContent = `${prefix}${formatNumber(value, decimals)}${suffix}`
        if (progress < 1) window.requestAnimationFrame(tick)
        else el.textContent = finalText
      }

      window.requestAnimationFrame(tick)
    })
  }

  const setupTypewriter = (el) => {
    const finalText = el.dataset.typewriter || el.textContent.trim()
    if (!finalText) return
    el.setAttribute('aria-label', finalText)
    if (reduced()) {
      el.textContent = finalText
      return
    }

    let started = false
    whenVisible(el, () => {
      if (started) return
      started = true
      const maxMs = Number(el.dataset.typeSpeed || 42)
      const duration = Math.min(1400, Math.max(280, finalText.length * maxMs))
      const step = Math.max(12, duration / finalText.length)
      let index = 0
      el.textContent = ''
      el.classList.add('is-typing')

      const tick = () => {
        index += 1
        el.textContent = finalText.slice(0, index)
        if (index < finalText.length) {
          window.setTimeout(tick, step)
        } else {
          el.classList.remove('is-typing')
        }
      }
      window.setTimeout(tick, 60)
    })
  }

  const scrambleChars = '!<>-_\\/[]{}—=+*^?#01ABCDEF'
  const setupScramble = (el) => {
    const finalText = el.dataset.scrambleText || el.textContent.trim()
    if (!finalText) return
    el.setAttribute('aria-label', finalText)
    if (reduced()) {
      el.textContent = finalText
      return
    }

    let started = false
    const run = () => {
      if (started) return
      started = true
      const duration = Number(el.dataset.scrambleDuration || 720)
      const startedAt = performance.now()
      const tick = (now) => {
        const progress = clamp((now - startedAt) / duration, 0, 1)
        const revealed = Math.floor(finalText.length * progress)
        let output = ''
        for (let index = 0; index < finalText.length; index += 1) {
          const char = finalText[index]
          if (index < revealed || char === ' ' || char === '\n') output += char
          else output += scrambleChars[Math.floor(Math.random() * scrambleChars.length)]
        }
        el.textContent = output
        if (progress < 1) window.requestAnimationFrame(tick)
        else el.textContent = finalText
      }
      window.requestAnimationFrame(tick)
    }

    whenVisible(el, run)
    el.addEventListener('click', () => {
      if (el.dataset.scrambleReplay !== 'false') {
        started = false
        run()
      }
    })
  }

  const setupMarquee = (el) => {
    if (el.dataset.marqueeClone === 'false') return
    const track = el.querySelector('.eab-marquee-track') || el.firstElementChild
    if (!track || track.dataset.marqueeCloned === '1') return
    const nodes = Array.from(track.children)
    if (!nodes.length) return
    for (const node of nodes) {
      const clone = node.cloneNode(true)
      clone.setAttribute('aria-hidden', 'true')
      track.appendChild(clone)
    }
    track.dataset.marqueeCloned = '1'
  }

  const setupSpring = (el) => {
    if (reduced()) {
      el.classList.add('is-motion-skip')
      return
    }
    window.requestAnimationFrame(() => el.classList.add('is-motion-in'))
  }

  const setupOne = (el) => {
    if (el.__eabMotionReady) return
    el.__eabMotionReady = true
    const modes = (el.dataset.motion || '').split(/\s+/).filter(Boolean)

    if (modes.includes('reveal')) setupReveal(el)
    if (modes.includes('stagger')) setupStagger(el)
    if (modes.includes('spotlight')) setupSpotlight(el)
    if (modes.includes('magnetic')) setupMagnetic(el)
    if (modes.includes('tilt')) setupTilt(el)
    if (modes.includes('parallax')) setupParallax(el)
    if (modes.includes('count')) setupCount(el)
    if (modes.includes('typewriter')) setupTypewriter(el)
    if (modes.includes('scramble')) setupScramble(el)
    if (modes.includes('marquee')) setupMarquee(el)
    if (modes.includes('spring')) setupSpring(el)
  }

  const scan = (scope) => {
    if (!scope) return
    if (scope.nodeType === 1 && scope.matches('[data-motion]')) setupOne(scope)
    if (!scope.querySelectorAll) return
    for (const el of scope.querySelectorAll('[data-motion]')) setupOne(el)
  }

  const scheduleScan = (scope) => {
    scan(scope)
  }

  const observe = () => {
    if (mutationObserver) return
    mutationObserver = new MutationObserver((records) => {
      const scopes = new Set()
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue
          if (node.matches?.('[data-motion]') || node.querySelector?.('[data-motion]')) scopes.add(node)
        }
      }
      for (const scope of scopes) scheduleScan(scope)
    })
    mutationObserver.observe(doc.documentElement, { childList: true, subtree: true })
  }

  const init = (scope = doc) => {
    scan(scope)
    if (!booted) {
      booted = true
      root.classList.add(readyClass)
      observe()
      requestParallax()
      settleVisible()
      window.addEventListener('scroll', settleVisible, { passive: true })
      window.addEventListener('resize', settleVisible)
      reduceQuery.addEventListener?.('change', () => {
        for (const io of observers) io.disconnect()
        observers.clear()
        for (const el of doc.querySelectorAll('[data-motion]')) {
          el.__eabMotionReady = false
          setupOne(el)
        }
        renderParallax()
      })
    }
    return window.EABMotion
  }

  doc.addEventListener('eab:motion-refresh', () => init())
  window.addEventListener('load', () => init(), { once: true })
  window.setTimeout(() => init(), 0)

  window.EABMotion = {
    init,
    refresh: init,
    reduceMotion: reduced,
    version: '2026.11.24'
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', () => init(), { once: true })
  } else {
    init()
  }
})()
