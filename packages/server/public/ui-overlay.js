/* ==========================================================================
   EAB Overlay Runtime
   --------------------------------------------------------------------------
   window.EABOverlay.toast(message, options)
   window.EABOverlay.popconfirm(trigger, options)
   window.EABOverlay.closeAll()

   Toast 复用现有 .top-toast 结构；Popconfirm 负责锚点定位、边界翻转、
   键盘焦点、Esc/点外取消和异步确认，不引入第三方依赖。
   ========================================================================== */

(() => {
  'use strict'

  const TOAST_MAX = 3
  const TOAST_LEAVE_MS = 180
  const TOAST_DEFAULT_MS = {
    success: 3200,
    info: 4000,
    warn: 4800,
    error: 6000,
  }
  const TOAST_ICON = {
    success: '<path d="m5 12 4 4 10-10"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    warn: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 17a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>',
    error: '<path d="M6 6l12 12"/><path d="m18 6-12 12"/>',
  }

  let toastSeq = 0
  let activePopconfirm = null

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true

  function normalizeTone(tone) {
    const value = String(tone || '').toLowerCase()
    if (value === 'error' || value === 'bad' || value === 'danger') return 'error'
    if (value === 'warn' || value === 'warning') return 'warn'
    if (value === 'info' || value === 'brand') return 'info'
    return 'success'
  }

  function ensureToastHost() {
    let host = document.querySelector('.top-toast-host')
    if (host) return host
    host = document.createElement('div')
    host.className = 'top-toast-host'
    if (document.body.classList.contains('chat-body')) host.classList.add('chat-toast-host')
    document.body.appendChild(host)
    return host
  }

  function makeIcon(kind) {
    const icon = document.createElement('span')
    icon.className = 'top-toast-icon'
    icon.setAttribute('aria-hidden', 'true')
    icon.innerHTML = `<svg viewBox="0 0 24 24" focusable="false">${TOAST_ICON[kind] || TOAST_ICON.success}</svg>`
    return icon
  }

  function toast(message, options = {}) {
    const text = String(message ?? '').trim()
    if (!text) return { dismiss() {} }

    const tone = normalizeTone(options.tone)
    const explicitDuration = Number(options.duration)
    const duration = options.persistent
      ? 0
      : Number.isFinite(explicitDuration) && explicitDuration >= 0
        ? explicitDuration
        : TOAST_DEFAULT_MS[tone] || 4000

    const host = ensureToastHost()
    for (const old of host.querySelectorAll('.top-toast')) {
      if (!old.classList.contains('is-leaving') && old.dataset.message === text) old._eabDismiss?.()
    }
    while (host.querySelectorAll('.top-toast:not(.is-leaving)').length >= TOAST_MAX) {
      const oldest = host.querySelector('.top-toast:not(.is-leaving)')
      if (!oldest) break
      oldest._eabDismiss?.()
    }

    const item = document.createElement('div')
    const toastId = `eab-toast-${++toastSeq}`
    item.className = `top-toast is-${tone}${duration === 0 ? ' is-persistent' : ''}`
    item.id = toastId
    item.dataset.message = text
    item.setAttribute('role', tone === 'error' ? 'alert' : 'status')
    item.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite')
    item.setAttribute('aria-atomic', 'true')
    if (duration > 0) item.style.setProperty('--eab-toast-duration', `${duration}ms`)

    const copy = document.createElement('span')
    copy.className = 'top-toast-copy'
    copy.textContent = text

    const close = document.createElement('button')
    close.className = 'top-toast-close'
    close.type = 'button'
    close.setAttribute('aria-label', '关闭提示')
    close.textContent = '×'

    item.append(makeIcon(tone), copy)

    let actionButton = null
    if (options.action && options.action.label) {
      actionButton = document.createElement('button')
      actionButton.className = 'top-toast-action'
      actionButton.type = 'button'
      actionButton.textContent = String(options.action.label)
      item.appendChild(actionButton)
    }
    item.appendChild(close)
    host.appendChild(item)

    let closed = false
    let timer = 0
    let startedAt = 0
    let remaining = duration
    let hovering = false
    let focusWithin = false

    const dismiss = () => {
      if (closed) return
      closed = true
      window.clearTimeout(timer)
      timer = 0
      item.classList.add('is-leaving')
      window.setTimeout(
        () => {
          item.remove()
          if (host && !host.childElementCount) host.remove()
          try {
            options.onClose?.()
          } catch {
            /* 关闭回调异常不影响提示清理 */
          }
        },
        reducedMotion() ? 0 : TOAST_LEAVE_MS,
      )
    }

    item._eabDismiss = dismiss

    const pause = () => {
      if (!timer || closed) return
      window.clearTimeout(timer)
      timer = 0
      remaining -= Math.max(0, performance.now() - startedAt)
      item.classList.add('is-paused')
    }

    const resume = () => {
      if (closed || timer || duration === 0) return
      if (remaining <= 0) {
        dismiss()
        return
      }
      item.classList.remove('is-paused')
      startedAt = performance.now()
      timer = window.setTimeout(dismiss, remaining)
    }

    const syncTimer = () => {
      if (hovering || focusWithin) pause()
      else resume()
    }

    if (duration > 0) {
      startedAt = performance.now()
      timer = window.setTimeout(dismiss, duration)
      item.addEventListener('mouseenter', () => {
        hovering = true
        syncTimer()
      })
      item.addEventListener('mouseleave', () => {
        hovering = false
        syncTimer()
      })
      item.addEventListener('focusin', () => {
        focusWithin = true
        syncTimer()
      })
      item.addEventListener('focusout', (event) => {
        if (item.contains(event.relatedTarget)) return
        focusWithin = false
        syncTimer()
      })
    }

    close.addEventListener('click', dismiss)
    if (actionButton) {
      actionButton.addEventListener('click', () => {
        dismiss()
        try {
          options.action.onClick?.()
        } catch {
          /* 用户动作异常不阻断提示关闭 */
        }
      })
    }

    return { dismiss, element: item }
  }

  function makeButton(label, className) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `eab-popconfirm-btn${className ? ` ${className}` : ''}`
    button.textContent = label
    return button
  }

  function popconfirm(trigger, options = {}) {
    if (activePopconfirm) activePopconfirm.cancel(true)
    if (!(trigger instanceof HTMLElement) || !trigger.isConnected) return Promise.resolve(false)

    return new Promise((resolve) => {
      const titleText = String(options.title || '确认操作？')
      const messageText = String(options.message || '')
      const detailText = String(options.detail || '')
      const confirmText = String(options.confirmText || '确定')
      const cancelText = String(options.cancelText || '取消')
      const tone = String(options.tone || 'danger') === 'warning' ? 'warning' : String(options.tone || 'danger') === 'primary' ? 'primary' : 'danger'
      const uid = `eab-popconfirm-${++toastSeq}`
      const titleId = `${uid}-title`
      const messageId = `${uid}-message`
      let settled = false
      let busy = false

      const layer = document.createElement('div')
      layer.className = 'eab-popconfirm-layer'
      layer.dataset.eabPopconfirmLayer = '1'

      const panel = document.createElement('div')
      panel.className = 'eab-popconfirm'
      panel.setAttribute('role', 'alertdialog')
      panel.setAttribute('aria-modal', 'true')
      panel.setAttribute('aria-labelledby', titleId)
      if (messageText) panel.setAttribute('aria-describedby', messageId)
      panel.style.visibility = 'hidden'

      const arrow = document.createElement('span')
      arrow.className = 'eab-popconfirm-arrow'
      arrow.setAttribute('aria-hidden', 'true')

      const copy = document.createElement('div')
      copy.className = 'eab-popconfirm-copy'
      const title = document.createElement('strong')
      title.className = 'eab-popconfirm-title'
      title.id = titleId
      title.textContent = titleText
      copy.appendChild(title)
      if (messageText) {
        const message = document.createElement('p')
        message.className = 'eab-popconfirm-message'
        message.id = messageId
        message.textContent = messageText
        copy.appendChild(message)
      }
      if (detailText) {
        const detail = document.createElement('p')
        detail.className = 'eab-popconfirm-detail'
        detail.textContent = detailText
        copy.appendChild(detail)
      }

      const error = document.createElement('p')
      error.className = 'eab-popconfirm-error'
      error.setAttribute('role', 'alert')
      error.hidden = true

      const actions = document.createElement('div')
      actions.className = 'eab-popconfirm-actions'
      const cancelButton = makeButton(cancelText)
      const confirmButton = makeButton(
        confirmText,
        tone === 'warning' ? 'is-warning' : tone === 'primary' ? 'is-primary' : 'is-danger',
      )
      actions.append(cancelButton, confirmButton)

      panel.append(arrow, copy, error, actions)
      layer.appendChild(panel)
      document.body.appendChild(layer)
      document.body.classList.add('eab-popconfirm-open')

      const place = () => {
        if (!trigger.isConnected) return
        const rect = trigger.getBoundingClientRect()
        const vw = window.innerWidth
        const vh = window.innerHeight
        const pad = 12
        const gap = 10
        const pw = panel.offsetWidth
        const ph = panel.offsetHeight
        let placement = options.placement === 'top' || options.placement === 'bottom' ? options.placement : 'auto'
        if (placement === 'auto') {
          placement = rect.bottom + gap + ph <= vh - pad ? 'bottom' : 'top'
        }
        let top = placement === 'bottom' ? rect.bottom + gap : rect.top - gap - ph
        if (top < pad) {
          placement = 'bottom'
          top = rect.bottom + gap
        }
        if (top + ph > vh - pad) {
          placement = 'top'
          top = rect.top - gap - ph
        }
        top = clamp(top, pad, Math.max(pad, vh - pad - ph))
        const left = clamp(rect.left + rect.width / 2 - pw / 2, pad, Math.max(pad, vw - pad - pw))
        const arrowX = clamp(rect.left + rect.width / 2 - left, 18, Math.max(18, pw - 18))

        panel.style.left = `${Math.round(left)}px`
        panel.style.top = `${Math.round(top)}px`
        panel.dataset.placement = placement
        panel.style.setProperty('--eab-pop-arrow-x', `${Math.round(arrowX)}px`)
        panel.style.setProperty('--eab-pop-origin', placement === 'bottom' ? `${Math.round(arrowX)}px 0%` : `${Math.round(arrowX)}px 100%`)
        panel.style.setProperty('--eab-pop-shift', placement === 'bottom' ? '-4px' : '4px')
        panel.style.visibility = ''
      }

      const close = (value) => {
        if (settled) return
        settled = true
        document.removeEventListener('keydown', onKey, true)
        window.removeEventListener('resize', place)
        window.removeEventListener('scroll', onScroll, true)
        layer.remove()
        document.body.classList.remove('eab-popconfirm-open')
        if (activePopconfirm?.panel === panel) activePopconfirm = null
        if (trigger.isConnected) {
          try {
            trigger.focus({ preventScroll: true })
          } catch {
            trigger.focus()
          }
        }
        resolve(value)
      }

      const cancel = (force = false) => {
        if ((busy && !force) || settled) return
        try {
          options.onCancel?.()
        } catch {
          /* 取消回调异常不阻断关闭 */
        }
        close(false)
      }

      const confirm = async () => {
        if (busy || settled) return
        busy = true
        panel.classList.add('is-busy')
        cancelButton.disabled = true
        confirmButton.disabled = true
        error.hidden = true
        const originalText = confirmButton.textContent
        confirmButton.textContent = String(options.loadingText || '处理中…')
        try {
          const result = await options.onConfirm?.()
          if (result === false) throw new Error(String(options.failureMessage || '操作未完成，请重试'))
          close(true)
        } catch (err) {
          error.textContent = err?.message || '操作失败，请重试'
          error.hidden = false
          busy = false
          panel.classList.remove('is-busy')
          cancelButton.disabled = false
          confirmButton.disabled = false
          confirmButton.textContent = originalText
          confirmButton.focus()
        }
      }

      const onKey = (event) => {
        if (settled) return
        if (event.key === 'Escape') {
          event.preventDefault()
          cancel()
          return
        }
        if (event.key !== 'Tab') return
        const first = cancelButton
        const last = confirmButton
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }

      const onScroll = (event) => {
        if (panel.contains(event.target)) return
        cancel()
      }

      layer.addEventListener('click', (event) => {
        if (event.target === layer) cancel()
      })
      cancelButton.addEventListener('click', cancel)
      confirmButton.addEventListener('click', confirm)
      document.addEventListener('keydown', onKey, true)
      window.addEventListener('resize', place)
      window.addEventListener('scroll', onScroll, true)

      activePopconfirm = { panel, cancel }
      place()
      cancelButton.focus({ preventScroll: true })
    })
  }

  function closeAll() {
    document.querySelectorAll('.top-toast:not(.is-leaving)').forEach((item) => item._eabDismiss?.())
    activePopconfirm?.cancel(true)
  }

  /* ------------------------------------------------------------------------
     B27：全站模态焦点守卫
     - 只接管 role="dialog" + aria-modal="true" 的可见浮层；
     - 已有本地 Tab 循环的确认卡标 data-eab-focus-owned，避免双重处理；
     - 打开时记住触发元素，关闭/移除后回到触发元素；
     - 不主动关闭浮层，Esc 仍交给各浮层自己的关闭逻辑。
     ------------------------------------------------------------------------ */
  const DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]'
  const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'summary',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
  ].join(',')
  const dialogOpeners = new WeakMap()
  let lastExternalFocus = null

  function isVisible(node) {
    if (!(node instanceof Element) || !node.isConnected) return false
    if (node.closest('[hidden]')) return false
    const style = getComputedStyle(node)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }

  function visibleDialogs() {
    return [...document.querySelectorAll(DIALOG_SELECTOR)].filter(isVisible)
  }

  function activeDialog() {
    return visibleDialogs().at(-1) || null
  }

  function focusableIn(root) {
    return [...root.querySelectorAll(FOCUSABLE_SELECTOR)]
      .filter(isVisible)
      .filter((node) => !node.closest('[inert]'))
  }

  function rememberExternalFocus(target) {
    if (!(target instanceof Element)) return
    if (target === document.body || target === document.documentElement) return
    lastExternalFocus = target
  }

  function restoreFocus(target) {
    if (!(target instanceof HTMLElement) || !target.isConnected) return
    if (target.closest('[hidden], [inert]')) return
    if (activeDialog()) return
    target.focus({ preventScroll: true })
  }

  function showDialog(dialog) {
    if (!dialogOpeners.has(dialog)) {
      dialogOpeners.set(dialog, lastExternalFocus)
    }
    if (dialog.contains(document.activeElement)) return
    const focusFirst = () => {
      if (!dialog.isConnected || !isVisible(dialog) || dialog.contains(document.activeElement)) return
      const first = focusableIn(dialog)[0]
      if (first) {
        first.focus({ preventScroll: true })
        return
      }
      if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1')
      dialog.focus({ preventScroll: true })
    }
    requestAnimationFrame(focusFirst)
    setTimeout(focusFirst, 60)
  }

  function closeDialog(dialog) {
    const opener = dialogOpeners.get(dialog)
    if (!opener) return
    dialogOpeners.delete(dialog)
    if (!visibleDialogs().length) requestAnimationFrame(() => restoreFocus(opener))
  }

  function dialogsInside(node) {
    if (!(node instanceof Element)) return []
    const list = []
    if (node.matches(DIALOG_SELECTOR)) list.push(node)
    list.push(...node.querySelectorAll(DIALOG_SELECTOR))
    return list
  }

  function syncDialogs(node) {
    for (const dialog of dialogsInside(node)) {
      if (isVisible(dialog)) showDialog(dialog)
      else closeDialog(dialog)
    }
  }

  document.addEventListener(
    'focusin',
    (event) => {
      const dialog = activeDialog()
      const target = event.target
      if (!(target instanceof Element)) return
      if (dialog && dialog.contains(target)) return
      rememberExternalFocus(target)
    },
    true,
  )

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || event.defaultPrevented) return
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const dialog = activeDialog()
    if (!dialog) return
    if (dialog.closest('[data-eab-focus-owned="1"]')) return
    const items = focusableIn(dialog)
    if (!items.length) {
      event.preventDefault()
      if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1')
      dialog.focus({ preventScroll: true })
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const current = document.activeElement
    if (!dialog.contains(current)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus({ preventScroll: true })
      return
    }
    if (event.shiftKey && (current === first || current === dialog)) {
      event.preventDefault()
      last.focus({ preventScroll: true })
      return
    }
    if (!event.shiftKey && (current === last || current === dialog)) {
      event.preventDefault()
      first.focus({ preventScroll: true })
    }
  })

  /* 图标按钮的可读名称：只有符号/无文字且有 data-tip/title 时补 aria-label。 */
  function labelIconButton(node) {
    if (!(node instanceof HTMLElement)) return
    if (!node.matches('button, a[href]')) return
    if (node.getAttribute('aria-label') || node.getAttribute('aria-labelledby')) return
    const text = (node.innerText || '').replace(/\s+/g, '')
    const onlySymbol = !text || /^[×✕✖⋯·•⌄⌃‹›<>←→↑↓+\-—–]+$/.test(text)
    if (!onlySymbol) return
    const tip = node.getAttribute('data-tip') || node.getAttribute('title') || ''
    const symbolLabel = /^[×✕✖]$/.test(text) ? '关闭' : /^⋯$/.test(text) ? '更多操作' : ''
    const label = (tip || symbolLabel).replace(/\s+/g, ' ').trim().slice(0, 80)
    if (label) node.setAttribute('aria-label', label)
  }

  function labelIconButtons(root) {
    if (!(root instanceof Element)) return
    labelIconButton(root)
    root.querySelectorAll('button, a[href]').forEach(labelIconButton)
  }

  /* 标准 tablist：Tab 只停在当前页签，左右/上下箭头切换，Home/End 到首尾。 */
  function visibleTabs(list) {
    return [...list.querySelectorAll('[role="tab"]')].filter(isVisible)
  }

  function syncTabStops(list) {
    const tabs = visibleTabs(list)
    if (tabs.length < 2) return
    const active =
      tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') ||
      tabs.find((tab) => tab.classList.contains('is-active')) ||
      tabs[0]
    tabs.forEach((tab) => {
      tab.tabIndex = tab === active ? 0 : -1
    })
  }

  function setupTablist(list) {
    if (!(list instanceof Element) || !list.matches('[role="tablist"]')) return
    syncTabStops(list)
    if (list.dataset.eabTabsReady === '1') return
    list.dataset.eabTabsReady = '1'
    list.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
      const tabs = visibleTabs(list)
      if (tabs.length < 2) return
      event.preventDefault()
      const current = tabs.indexOf(document.activeElement)
      let next = current < 0 ? tabs.findIndex((tab) => tab.tabIndex === 0) : current
      if (next < 0) next = 0
      if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = tabs.length - 1
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (next - 1 + tabs.length) % tabs.length
      else next = (next + 1) % tabs.length
      const tab = tabs[next]
      tab.focus({ preventScroll: true })
      tab.click()
    })
    list.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('[role="tab"]')) syncTabStops(list)
    })
  }

  function setupTablists(root) {
    if (!(root instanceof Element)) return
    if (root.matches('[role="tablist"]')) setupTablist(root)
    root.querySelectorAll('[role="tablist"]').forEach(setupTablist)
    const owner = root.closest?.('[role="tablist"]')
    if (owner) setupTablist(owner)
  }

  function initFocusGuard() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', initFocusGuard, { once: true })
      return
    }
    labelIconButtons(document.body)
    setupTablists(document.body)
    syncDialogs(document.body)
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'childList') {
          record.addedNodes.forEach((node) => {
            syncDialogs(node)
            labelIconButtons(node)
            setupTablists(node)
          })
          record.removedNodes.forEach((node) => {
            dialogsInside(node).forEach(closeDialog)
          })
          continue
        }
        if (record.target instanceof Element && record.target.matches(DIALOG_SELECTOR)) {
          if (isVisible(record.target)) showDialog(record.target)
          else closeDialog(record.target)
          continue
        }
        if (record.target instanceof Element) {
          dialogsInside(record.target).forEach((dialog) => {
            if (isVisible(dialog)) showDialog(dialog)
            else closeDialog(dialog)
          })
        }
        requestAnimationFrame(() => setupTablists(document.body))
      }
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'aria-hidden'],
    })
  }

  window.EABFocus = {
    activeDialog,
    focusableIn,
    labelIconButtons,
    version: '2026.11.25',
  }

  window.EABOverlay = {
    toast,
    popconfirm,
    closeAll,
    version: '2026.11.24',
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFocusGuard, { once: true })
  } else {
    initFocusGuard()
  }
})()
