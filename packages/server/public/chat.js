/*
 * 员工工作台（对话页）。
 *
 * 产品口径（12.7）：员工只对话。身份来自登录（开发期用 ?as= 预览），模型只列有权用的。
 * 布局对照 DeepSeek / 豆包 / 千问 网页版：左侧账号与可用模型，右侧对话；
 * 模型选择在输入框里；附件随消息发送：文本类读正文，图片转 dataURL 走视觉输入。
 */

const $ = (sel) => document.querySelector(sel)
const qs = (extra) => {
  const params = new URLSearchParams(location.search)
  if (extra) params.set('as', extra)
  const text = params.toString()
  return text ? `?${text}` : ''
}
const qsAppend = (url) => {
  const text = qs()
  if (!text) return url
  return `${url}${url.includes('?') ? '&' : '?'}${text.slice(1)}`
}
const currentAs = () => new URLSearchParams(location.search).get('as')

const ROLE_LABEL = {
  super_admin: '平台超管',
  company_admin: '公司管理员',
  company_sub_admin: '企业级子管理员',
  dept_admin: '部门管理员',
  kb_admin: '知识库运营',
  auditor: '审计员',
  member: '普通员工',
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  })
}

function answerInline(text) {
  const codeTokens = []
  let html = String(text ?? '').replace(/`([^`\n]+)`/g, (_, code) => {
    codeTokens.push(`<code>${code}</code>`)
    return `\u0001${codeTokens.length - 1}\u0001`
  })
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  html = html.replace(
    /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
  )
  return html.replace(/\u0001(\d+)\u0001/g, (_, index) => codeTokens[Number(index)] ?? '')
}

function isAnswerTableSeparator(line) {
  const cells = String(line ?? '').trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

function splitAnswerTableRow(line) {
  const body = String(line ?? '').trim().replace(/^\|/, '').replace(/\|$/, '')
  return body.split('|').map((cell) => cell.trim())
}

function isAnswerBlockStart(lines, index) {
  const line = lines[index]
  if (!line.trim()) return true
  if (/^\u0000CODE\d+\u0000$/.test(line)) return true
  if (/^\s{0,3}(#{1,6})\s+/.test(line)) return true
  if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true
  if (/^\s{0,3}>\s?/.test(line)) return true
  if (/^\s*[-*+]\s+/.test(line)) return true
  if (/^\s*\d+[.)]\s+/.test(line)) return true
  if (line.includes('|') && index + 1 < lines.length && isAnswerTableSeparator(lines[index + 1])) return true
  return false
}

/** Markdown：标题、列表、表格、引用、分隔线、代码块、行内代码、加粗、斜体、链接。 */
function renderAnswer(text) {
  const source = esc(String(text ?? '').replace(/\r\n?/g, '\n'))
  const codeBlocks = []
  const body = source.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => {
    const index = codeBlocks.length
    codeBlocks.push(code.replace(/\n$/, ''))
    return `\u0000CODE${index}\u0000`
  })
  const lines = body.split('\n')
  const output = []

  for (let index = 0; index < lines.length; ) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }

    const codeMatch = /^\u0000CODE(\d+)\u0000$/.exec(line.trim())
    if (codeMatch) {
      const code = codeBlocks[Number(codeMatch[1])] ?? ''
      output.push(`<pre class="answer-code">${code}</pre>`)
      index += 1
      continue
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      const level = Math.min(6, heading[1].length)
      output.push(`<h${level}>${answerInline(heading[2].trim())}</h${level}>`)
      index += 1
      continue
    }

    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      output.push('<hr>')
      index += 1
      continue
    }

    if (line.includes('|') && index + 1 < lines.length && isAnswerTableSeparator(lines[index + 1])) {
      const header = splitAnswerTableRow(line)
      const rows = []
      let cursor = index + 2
      while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim()) {
        rows.push(splitAnswerTableRow(lines[cursor]))
        cursor += 1
      }
      const headHtml = header.map((cell) => `<th>${answerInline(cell)}</th>`).join('')
      const bodyHtml = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${answerInline(cell)}</td>`).join('')}</tr>`)
        .join('')
      output.push(
        `<div class="answer-table"><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`,
      )
      index = cursor
      continue
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      const quotes = []
      let cursor = index
      while (cursor < lines.length && /^\s{0,3}>\s?/.test(lines[cursor])) {
        quotes.push(answerInline(lines[cursor].replace(/^\s{0,3}>\s?/, '')))
        cursor += 1
      }
      output.push(`<blockquote>${quotes.join('<br>')}</blockquote>`)
      index = cursor
      continue
    }

    const unordered = /^\s{0,3}[-*+]\s+(.+)$/.exec(line)
    const ordered = /^\s{0,3}\d+[.)]\s+(.+)$/.exec(line)
    if (unordered || ordered) {
      const tag = unordered ? 'ul' : 'ol'
      const pattern = unordered ? /^\s{0,3}[-*+]\s+(.+)$/ : /^\s{0,3}\d+[.)]\s+(.+)$/
      const items = []
      let cursor = index
      while (cursor < lines.length) {
        const match = pattern.exec(lines[cursor])
        if (!match) break
        items.push(`<li>${answerInline(match[1])}</li>`)
        cursor += 1
      }
      output.push(`<${tag}>${items.join('')}</${tag}>`)
      index = cursor
      continue
    }

    const paragraph = []
    let cursor = index
    while (cursor < lines.length && !isAnswerBlockStart(lines, cursor)) {
      paragraph.push(answerInline(lines[cursor]))
      cursor += 1
    }
    if (paragraph.length) output.push(`<p>${paragraph.join('<br>')}</p>`)
    index = cursor > index ? cursor : index + 1
  }

  return output.join('')
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function fmtQuota(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value >= 1024 * 1024 * 1024) {
    const gb = value / 1024 / 1024 / 1024
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`
  }
  if (value >= 1024 * 1024) {
    const mb = value / 1024 / 1024
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
  }
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

function banner(message, tone = 'ok') {
  const old = document.querySelector('.chat-banner')
  if (old) old.remove()
  const el = document.createElement('div')
  el.className = `chat-banner ${tone === 'bad' ? 'is-bad' : tone === 'warn' ? 'is-warn' : 'is-ok'}`
  el.textContent = message
  document.body.appendChild(el)
  window.setTimeout(() => el.remove(), 3200)
}

async function api(path, options) {
  const response = await fetch(path, options)
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload || payload.ok === false) {
    const err = new Error((payload && (payload.error?.message || payload.message)) || `HTTP ${response.status}`)
    err.code = payload && (payload.error?.code || payload.code)
    err.details = payload && (payload.error?.details || payload.details)
    err.hint = payload && (payload.error?.hint || payload.hint)
    err.traceId = payload && (payload.error?.traceId || payload.traceId)
    err.status = response.status
    throw err
  }
  return payload.data
}

const state = {
  me: null,
  assistant: null,
  models: [],
  autoModelId: null,
  canChat: true,
  selected: '',
  sending: false,
  /** 正在流式回复时后来提交的消息：先排队，等当前回复结束再按顺序发送 */
  queue: [],
  /** queue=按顺序排队；interrupt=新消息打断当前回复 */
  chatSendMode: 'queue',
  activeController: null,
  attachments: [],
  personas: [],
  sessionId: null,
  sessions: [],
  historyBefore: null,
  historyHasMore: false,
  historyLoading: false,
  historyMessageIds: new Set(),
  liveTurns: new Map(),
  liveEventSource: null,
  sessionRefreshTimer: 0,
  files: [],
  spaceKind: 'cloud',
  spaceLabel: '云空间',
  plugins: [],
  pluginData: null,
  pluginSelected: null,
  pluginTab: 'overview',
  pluginPageKey: null,
  mode: 'chat',
  /** 当前实际停留的界面：chat / workspace / settings，刷新后恢复 */
  view: 'chat',
  filePreview: null,
}

const HISTORY_PAGE_SIZE = 10
const HISTORY_TOP_THRESHOLD = 120
const SCROLL_BOTTOM_THRESHOLD = 180
const CHAT_LOCATION_STORAGE_KEY = 'eab.chat.location.v1'

function chatLocationStorageKey() {
  const personId = state.me?.person?.id
  return personId ? `${CHAT_LOCATION_STORAGE_KEY}.${personId}` : ''
}

function readChatLocation() {
  const key = chatLocationStorageKey()
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return {
      sessionId: typeof parsed?.sessionId === 'string' ? parsed.sessionId : null,
      view: ['chat', 'workspace', 'settings'].includes(parsed?.view) ? parsed.view : 'chat',
      mode: parsed?.mode === 'workspace' ? 'workspace' : 'chat',
    }
  } catch {
    return null
  }
}

function persistChatLocation() {
  const key = chatLocationStorageKey()
  if (!key) return
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        sessionId: state.sessionId || '',
        view: state.view || 'chat',
        mode: state.mode === 'workspace' ? 'workspace' : 'chat',
      }),
    )
  } catch {
    /* 浏览器禁用本地存储时不影响当前页面 */
  }
}

function restoreChatLocation(location) {
  if (!location || location.view === 'chat') return
  const workspaceBehindSettings = location.view === 'settings' && location.mode === 'workspace'
  setChatMode(location.view === 'workspace' || workspaceBehindSettings ? 'workspace' : 'chat')
  if (location.view === 'settings') showSettings()
}

/* ---------------- 登录态 ---------------- */

async function loadPersonas() {
  try {
    const data = await api('/api/dev/personas')
    state.personas = data.personas
    return data.personas
  } catch {
    state.personas = []
    return []
  }
}

function showLogin() {
  $('#login-gate').hidden = false
  // 登录页是独占页面：把背后的工作台整体收掉，避免空状态或历史会话从登录卡上方/下方透出来。
  const side = $('#chat-side')
  const stage = $('#chat-stage')
  if (side) side.hidden = true
  if (stage) stage.hidden = true
  for (const id of ['#mode-switch', '#chat-title', '#login-btn', '#side-user', '#side-actions', '#side-sessions', '#side-files', '#attach-strip']) {
    const node = $(id)
    if (node) node.hidden = true
  }
  $('#composer-box').style.display = 'none'
  $('#composer-foot').textContent = '登录后可开始对话'
}

async function renderLogin() {
  // 登录页绝不列成员、绝不提供“直接选人登录”。身份只能由本人扫码或输入自己的账号密码取得。
  $('#login-sub').textContent = '用工号、邮箱或手机号登录。账号只能由本人登录，密码校验在服务端完成。'
  $('#login-sub').hidden = true
}

async function doLogin(event) {
  event.preventDefault()
  const account = $('#login-account').value.trim()
  const password = $('#login-password').value
  const errorBox = $('#login-error')
  const button = $('#login-submit')
  errorBox.hidden = true
  button.disabled = true
  button.textContent = '登录中…'
  try {
    await api('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account, password }),
    })
    location.href = '/chat'
  } catch (err) {
    errorBox.textContent = `${err.message}${err.code ? `（${err.code}）` : ''}`
    errorBox.hidden = false
    button.disabled = false
    button.textContent = '登录'
  }
}

/* ---------------- 会话历史 ---------------- */

function resetThread() {
  state.liveTurns.clear()
  const thread = $('#thread')
  for (const child of [...thread.children]) {
    if (child.id !== 'chat-empty') child.remove()
  }
  $('#chat-empty').hidden = false
  setEmptyVisible(true)
  updateScrollBottomButton()
}

function renderSessions() {
  const box = $('#session-list')
  $('#side-sessions').hidden = state.sessions.length === 0 && !state.me
  if (state.sessions.length === 0) {
    box.innerHTML = '<div class="side-session-empty">还没有对话</div>'
    return
  }
  box.innerHTML = state.sessions
    .map((session) => {
      // 左侧已经有「钉钉」来源徽标，标题里不再重复前缀。
      const displayTitle =
        session.source === 'dingtalk' ? String(session.title || '').replace(/^钉钉\s*·\s*/, '') : session.title
      return `<div class="side-session ${session.id === state.sessionId ? 'active' : ''}" data-session="${esc(session.id)}">
        <button class="side-session-main" type="button" data-open="${esc(session.id)}" title="${esc(session.title)}">${
          session.source === 'dingtalk' ? '<span class="side-session-source">钉钉</span>' : ''
        }${esc(displayTitle)}</button>
        <button class="side-session-more" type="button" data-more="${esc(session.id)}" title="会话操作" aria-label="会话操作">⋯</button>
      </div>`
    })
    .join('')
  for (const button of box.querySelectorAll('[data-open]')) {
    button.addEventListener('click', () => openSession(button.dataset.open))
  }
  for (const button of box.querySelectorAll('[data-more]')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      showSessionMenu(button.dataset.more, button.getBoundingClientRect())
    })
  }
  for (const row of box.querySelectorAll('.side-session')) {
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      showSessionMenu(row.dataset.session, row.getBoundingClientRect())
    })
  }
}

async function loadSessions() {
  try {
    const data = await api(`/api/chat/sessions${qs()}`)
    state.sessions = data.sessions || []
  } catch {
    state.sessions = []
  }
  renderSessions()
}

/** 钉钉侧刚写入的消息：同一会话就追加到当前对话，其它会话只更新左侧列表。 */
function appendLiveMessage(message, sessionId) {
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) return
  const id = String(message.id || '')
  if (!id || state.historyMessageIds.has(id)) return
  state.historyMessageIds.add(id)

  const thread = $('#thread')
  const follow = thread
    ? thread.scrollHeight - thread.scrollTop - thread.clientHeight <= SCROLL_BOTTOM_THRESHOLD + 40
    : false
  appendMessage(
    message.role === 'user' ? 'me' : 'ai',
    message.text,
    message.role === 'assistant' && message.modelName ? message.modelName : undefined,
    message.meta && message.meta.attachments,
    message.role === 'assistant' ? message.meta : undefined,
    { scroll: false, messageId: id, channel: message.meta?.channel },
  )
  if (follow) scrollThreadToBottomInstant()
  if (sessionId && sessionId === state.sessionId) scheduleSessionRefresh()
}

function scheduleSessionRefresh() {
  if (state.sessionRefreshTimer) return
  state.sessionRefreshTimer = window.setTimeout(async () => {
    state.sessionRefreshTimer = 0
    await loadSessions()
  }, 600)
}

/**
 * 打开工作台后订阅服务端消息事件。
 * 钉钉私聊和网页对话共用 chat_messages；钉钉侧落库后由服务端广播到这里，
 * 当前会话直接追加，新会话则刷新左侧列表，不需要用户再手动刷新页面。
 */
function setupChatEvents() {
  if (state.liveEventSource || typeof EventSource === 'undefined') return
  const source = new EventSource(`/api/chat/events${qs()}`)
  state.liveEventSource = source

  source.addEventListener('chat', (event) => {
    let payload = null
    try {
      payload = JSON.parse(event.data)
    } catch {
      return
    }
    if (!payload?.sessionId) return

    // 钉钉侧模型还在生成：同一会话里先把增量正文/思考过程渲染出来。
    if (payload.type === 'delta') {
      if (payload.sessionId !== state.sessionId) {
        scheduleSessionRefresh()
        return
      }
      if (!payload.messageId || !payload.text) return
      if (state.historyMessageIds.has(payload.messageId)) return
      let turn = state.liveTurns.get(payload.messageId)
      if (!turn) {
        turn = createAiTurn()
        state.liveTurns.set(payload.messageId, turn)
      }
      if (payload.kind === 'reasoning') turn.reasoning(payload.text)
      else turn.content(payload.text)
      return
    }

    // 钉钉侧正在调用工具：同一会话里补出工具卡片，避免只在落库后一次性出现。
    if (payload.type === 'tool') {
      if (payload.sessionId !== state.sessionId) {
        scheduleSessionRefresh()
        return
      }
      if (!payload.messageId || !payload.tool) return
      if (state.historyMessageIds.has(payload.messageId)) return
      let turn = state.liveTurns.get(payload.messageId)
      if (!turn) {
        turn = createAiTurn()
        state.liveTurns.set(payload.messageId, turn)
      }
      if (payload.tool.type === 'tool') turn.tool(payload.tool)
      else turn.toolResult(payload.tool)
      return
    }

    if (payload.type !== 'message' || !payload.message) return
    if (payload.sessionId === state.sessionId) {
      const id = String(payload.message.id || '')
      const liveTurn = id ? state.liveTurns.get(id) : null
      if (liveTurn) {
        state.liveTurns.delete(id)
        state.historyMessageIds.add(id)
        const meta = payload.message.meta || {}
        liveTurn.finish({
          text: payload.message.text,
          modelName: payload.message.modelName,
          citations: meta.citations,
          channel: meta.channel,
        })
        scheduleSessionRefresh()
        return
      }
      appendLiveMessage(payload.message, payload.sessionId)
    } else {
      scheduleSessionRefresh()
    }
  })

  // EventSource 会自己重连；这里不主动 close，避免服务重启后永久失去推送。
  source.addEventListener('error', () => {
    // 浏览器会自动重连，保持引用即可。
  })
}

let scrollBottomButtonFrame = 0

function updateScrollBottomButton() {
  const thread = $('#thread')
  const button = $('#scroll-bottom')
  if (!thread || !button) return
  const distanceToBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight
  button.hidden = distanceToBottom <= SCROLL_BOTTOM_THRESHOLD
}

function queueScrollBottomButtonUpdate() {
  if (scrollBottomButtonFrame) return
  scrollBottomButtonFrame = requestAnimationFrame(() => {
    scrollBottomButtonFrame = 0
    updateScrollBottomButton()
  })
}

function scrollThreadToBottomSmooth() {
  const thread = $('#thread')
  if (!thread) return
  thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' })
  queueScrollBottomButtonUpdate()
}

function scrollThreadToBottomInstant() {
  const thread = $('#thread')
  if (!thread) return
  const previous = thread.style.scrollBehavior
  // 容器 CSS 是 smooth；切会话要“直接落在底部”，不能从顶部再滑过去。
  thread.style.scrollBehavior = 'auto'
  thread.scrollTop = thread.scrollHeight
  queueScrollBottomButtonUpdate()
  requestAnimationFrame(() => {
    if (!thread.isConnected) return
    thread.scrollTop = thread.scrollHeight
    if (previous) thread.style.scrollBehavior = previous
    else thread.style.removeProperty('scroll-behavior')
    updateScrollBottomButton()
  })
}

function resetHistoryState() {
  state.historyBefore = null
  state.historyHasMore = false
  state.historyLoading = false
  state.historyMessageIds.clear()
}

function historyMessagesUrl(sessionId, before) {
  const params = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) })
  if (before) params.set('before', String(before))
  const base = qs()
  return `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages${base}${base ? '&' : '?'}${params.toString()}`
}

function ensureHistoryLoader() {
  const thread = $('#thread')
  if (!thread) return null
  let loader = thread.querySelector('.history-loader')
  if (loader) return loader
  loader = document.createElement('div')
  loader.className = 'history-loader'
  loader.textContent = '正在加载更早的消息…'
  loader.hidden = true
  const firstMessage = thread.querySelector('.msg')
  thread.insertBefore(loader, firstMessage || null)
  return loader
}

async function loadOlderMessages() {
  const thread = $('#thread')
  const sessionId = state.sessionId
  if (!thread || !sessionId || state.historyLoading || !state.historyHasMore || !state.historyBefore) return

  state.historyLoading = true
  const loader = ensureHistoryLoader()
  if (loader) {
    loader.hidden = false
    loader.textContent = '正在加载更早的消息…'
  }
  const previousBehavior = thread.style.scrollBehavior

  try {
    const data = await api(historyMessagesUrl(sessionId, state.historyBefore))
    if (state.sessionId !== sessionId) return
    const messages = Array.isArray(data.messages) ? data.messages : []
    if (messages.length === 0) {
      state.historyHasMore = false
      state.historyBefore = null
      if (loader) loader.hidden = true
      return
    }

    // 后端按 before 游标只会返回更早的消息；这里再按 id 去重，防止同一页
    // 因滚动事件或异常游标被重复插入，也保证“已加载过的历史不再重复请求”。
    const newMessages = messages.filter((message) => {
      const id = String(message.id || '')
      if (!id) return true
      if (state.historyMessageIds.has(id)) return false
      state.historyMessageIds.add(id)
      return true
    })
    if (newMessages.length === 0) {
      state.historyHasMore = false
      state.historyBefore = null
      if (loader) loader.hidden = true
      return
    }

    if (loader) loader.hidden = true
    // 先记录高度和位置，插到顶部后按“新增高度”补偿，避免阅读位置跳动。
    thread.style.scrollBehavior = 'auto'
    const previousHeight = thread.scrollHeight
    const previousTop = thread.scrollTop
    for (let index = newMessages.length - 1; index >= 0; index -= 1) {
      const message = newMessages[index]
      appendMessage(
        message.role === 'user' ? 'me' : 'ai',
        message.text,
        message.role === 'assistant' && message.modelName ? message.modelName : undefined,
        message.meta && message.meta.attachments,
        message.role === 'assistant' ? message.meta : undefined,
        { scroll: false, prepend: true, channel: message.meta?.channel },
      )
    }
    thread.scrollTop = previousTop + (thread.scrollHeight - previousHeight)

    state.historyBefore = Boolean(data.hasMore) ? data.nextBefore || newMessages[0].id : null
    state.historyHasMore = Boolean(data.hasMore)
  } catch (err) {
    console.warn('加载更早消息失败', err)
    if (loader) {
      loader.textContent = '加载更早的消息失败，继续上滑可重试'
      window.setTimeout(() => {
        if (loader.isConnected) loader.hidden = true
      }, 2500)
    }
  } finally {
    if (state.sessionId === sessionId) state.historyLoading = false
    requestAnimationFrame(() => {
      if (!thread.isConnected) return
      if (previousBehavior) thread.style.scrollBehavior = previousBehavior
      else thread.style.removeProperty('scroll-behavior')
      if (state.sessionId === sessionId) fillHistoryIfNeeded()
      updateScrollBottomButton()
    })
  }
}

function onThreadScroll() {
  const thread = $('#thread')
  updateScrollBottomButton()
  if (!thread || state.historyLoading || !state.historyHasMore || !state.historyBefore) return
  if (thread.scrollTop <= HISTORY_TOP_THRESHOLD) loadOlderMessages()
}

/** 首屏或上一页太短、没有滚动条时，继续补到能滚动为止，否则用户无法触发更早历史。 */
function fillHistoryIfNeeded() {
  const thread = $('#thread')
  if (!thread || state.historyLoading || !state.historyHasMore || !state.historyBefore) return
  if (thread.scrollHeight <= thread.clientHeight + 4) loadOlderMessages()
}

async function openSession(sessionId) {
  clearQueuedMessages()
  hideSettings()
  setChatMode('chat')
  try {
    const data = await api(historyMessagesUrl(sessionId))
    state.sessionId = data.session.id
    state.view = 'chat'
    persistChatLocation()
    applySessionSpace(data.session)
    const sessionModelId = data.session.modelId || data.session.model_id || ''
    if (sessionModelId && state.models.some((model) => model.id === sessionModelId)) {
      setSelected(sessionModelId, { persist: false })
    } else {
      setSelected('', { persist: false })
      if (sessionModelId) banner('本会话原来使用的模型已不可用，已切回自动选择', 'warn')
    }
    state.historyBefore = Boolean(data.hasMore) ? data.nextBefore || null : null
    state.historyHasMore = Boolean(data.hasMore)
    state.historyLoading = false
    state.historyMessageIds.clear()
    $('#chat-title').textContent = data.session.title
    resetThread()
    const thread = $('#thread')
    if (thread) thread.style.visibility = 'hidden'
    try {
      for (const message of data.messages) {
        if (message.id) state.historyMessageIds.add(message.id)
        appendMessage(
          message.role === 'user' ? 'me' : 'ai',
          message.text,
          message.role === 'assistant' && message.modelName ? message.modelName : undefined,
          message.meta && message.meta.attachments,
          message.role === 'assistant' ? message.meta : undefined,
          { scroll: false, channel: message.meta?.channel },
        )
      }
      if (data.messages.length > 0) {
        setEmptyVisible(false)
        scrollThreadToBottomInstant()
      }
    } finally {
      if (thread) thread.style.visibility = ''
    }
    renderSessions()
    requestAnimationFrame(() => {
      if (state.sessionId === data.session.id) fillHistoryIfNeeded()
      updateScrollBottomButton()
    })
  } catch (err) {
    resetHistoryState()
    appendMessage('ai', `${err.message}${err.code ? `（${err.code}）` : ''}`)
  }
}

function newSession() {
  clearQueuedMessages()
  hideSettings()
  setChatMode('chat')
  state.sessionId = null
  setSelected('', { persist: false })
  resetHistoryState()
  $('#chat-title').textContent = '新对话'
  resetThread()
  renderSessions()
  persistChatLocation()
  $('#input').focus()
}

function sessionById(sessionId) {
  return state.sessions.find((session) => session.id === sessionId)
}

function hideSessionMenu() {
  const menu = $('#session-menu')
  if (!menu) return
  menu.hidden = true
  menu.dataset.session = ''
}

function showSessionMenu(sessionId, anchor) {
  const menu = $('#session-menu')
  const session = sessionById(sessionId)
  if (!menu || !session) return
  hideFileMenu()
  menu.innerHTML = `<div class="session-menu-title">${esc(session.title)}</div>
    <button type="button" data-act="rename">重命名</button>
    <button type="button" data-act="delete" class="is-danger">删除</button>`
  menu.dataset.session = sessionId
  menu.hidden = false
  const box = menu.getBoundingClientRect()
  const left = Math.min(Math.max(8, anchor.right - box.width), window.innerWidth - box.width - 8)
  const below = anchor.bottom + 4
  const top = below + box.height + 8 > window.innerHeight ? Math.max(8, anchor.top - box.height - 4) : below
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
}

function openConfirmCard({ eyebrow = '危险操作', title, targetLabel = '目标', target, message, confirmText = '删除', cancelText = '取消' }) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay confirm-overlay'
    overlay.innerHTML = `<div class="modal confirm-card" role="dialog" aria-modal="true" aria-labelledby="confirm-card-title" aria-describedby="confirm-card-message">
      <div class="confirm-card-head">
        <span class="confirm-card-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2.6 14.2 13.4H1.8L8 2.6Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M8 6.2v3.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><circle cx="8" cy="11.4" r=".65" fill="currentColor"/></svg></span>
        <div class="confirm-card-titles">
          <span class="confirm-card-eyebrow">${esc(eyebrow)}</span>
          <h3 id="confirm-card-title">${esc(title)}</h3>
        </div>
        <button class="modal-x" type="button" aria-label="关闭">×</button>
      </div>
      <div class="confirm-card-body">
        <div class="confirm-card-target"><span>${esc(targetLabel)}</span><strong>${esc(target || '未命名')}</strong></div>
        <p class="confirm-card-message" id="confirm-card-message">${esc(message)}</p>
      </div>
      <div class="confirm-card-actions">
        <button class="btn ghost" type="button" data-confirm-cancel>${esc(cancelText)}</button>
        <button class="btn danger" type="button" data-confirm-ok>${esc(confirmText)}</button>
      </div>
    </div>`
    document.body.appendChild(overlay)
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey)
      overlay.remove()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected && !previousFocus.closest('[hidden]')) {
        previousFocus.focus({ preventScroll: true })
      } else {
        $('#input')?.focus()
      }
      resolve(value)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') finish(false)
    }
    document.addEventListener('keydown', onKey)
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finish(false)
    })
    overlay.querySelector('.modal-x').addEventListener('click', () => finish(false))
    overlay.querySelector('[data-confirm-cancel]').addEventListener('click', () => finish(false))
    overlay.querySelector('[data-confirm-ok]').addEventListener('click', () => finish(true))
    overlay.querySelector('[data-confirm-cancel]').focus()
  })
}

async function renameSession(sessionId, currentTitle) {
  if (!sessionId) return
  const title = window.prompt('会话名称', currentTitle || '新对话')
  if (!title || !title.trim()) return
  const next = title.trim()
  try {
    await api(`/api/chat/sessions/${encodeURIComponent(sessionId)}${qs()}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: next }),
    })
    if (state.sessionId === sessionId) $('#chat-title').textContent = next
    await loadSessions()
  } catch (err) {
    alert(err.message)
  }
}

async function deleteSession(sessionId) {
  if (!sessionId) return
  const session = sessionById(sessionId)
  const confirmed = await openConfirmCard({
    eyebrow: '会话管理',
    title: '删除这个会话？',
    targetLabel: '要删除的会话',
    target: `「${session?.title || '未命名'}」`,
    message: '删除后聊天记录会软删除，可在数据库审计中追溯。',
    confirmText: '删除会话',
  })
  if (!confirmed) return
  try {
    await api(`/api/chat/sessions/${encodeURIComponent(sessionId)}${qs()}`, { method: 'DELETE' })
    if (state.sessionId === sessionId) {
      state.sessionId = null
      $('#chat-title').textContent = '新对话'
      resetHistoryState()
      resetThread()
      persistChatLocation()
    }
    await loadSessions()
  } catch (err) {
    alert(err.message)
  }
}

/* ---------------- 个人工作区（上传文件 + 对话写入文件） ---------------- */

async function loadWorkspaceFiles() {
  try {
    const [data, quota] = await Promise.all([
      api(`/api/workspace/files${qs()}`),
      api(`/api/workspace/quota${qs()}`).catch(() => null),
    ])
    state.files = data.items || []
    if (state.me) $('#side-files').hidden = false
    renderWorkspaceFiles()
    if (quota) {
      renderWorkspaceQuota(quota)
      maybeWarnWorkspaceQuota(quota)
    }
  } catch (err) {
    state.files = []
    $('#ws-list').innerHTML = `<div class="muted" style="font-size:12px;padding:4px">${esc(err.message)}</div>`
  }
}

function renderWorkspaceQuota(quota) {
  const box = $('#ws-quota-popover')
  if (!box) return
  const user = quota.user || {}
  const used = Math.max(0, Number(user.used) || 0)
  const limit = Math.max(0, Number(user.limit ?? user.limitBytes) || 0)
  const fileLimit = Math.max(0, Number(quota.fileLimitBytes ?? user.fileLimitBytes) || 0)
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0
  const remaining = Math.max(
    0,
    Number(quota.remainingBytes ?? user.remainingBytes ?? (limit - used)) || 0,
  )
  const warning = quota.warning || user.warning || {}
  const level = String(warning.level || (percent >= 100 ? 'full' : percent >= 95 ? 'critical' : percent >= 85 ? 'warning' : percent >= 75 ? 'notice' : 'normal'))
  const warningMessage = String(warning.message || '').trim()
  const source = String(quota.quotaSource || user.source || 'default')
  const sourceLabel =
    source === 'user' ? '个人配置' : source === 'role' ? '角色配置' : '默认配置'
  const roleText = Array.isArray(quota.roleCodes) && quota.roleCodes.length ? ` · ${quota.roleCodes.join(' / ')}` : ''
  const badge = $('#ws-info')
  badge?.classList.toggle('is-high', level === 'notice' || level === 'warning')
  badge?.classList.toggle('is-critical', level === 'critical' || level === 'full')
  badge?.setAttribute(
    'aria-label',
    `云空间剩余 ${fmtSize(remaining)}；已用 ${fmtSize(used)} / ${fmtQuota(limit)}${warningMessage ? `；${warningMessage}` : ''}`,
  )
  const warningHtml =
    warningMessage && level !== 'normal'
      ? `<div class="ws-quota-warning${level === 'critical' || level === 'full' ? ' is-critical' : ''}">${esc(warningMessage)}</div>`
      : ''
  box.innerHTML = `
    <div class="ws-quota-head">
      <span class="ws-quota-label">云空间</span>
      <span class="ws-quota-value"><strong>${esc(fmtSize(used))}</strong><span class="ws-quota-sep">/</span>${esc(
        fmtQuota(limit),
      )}</span>
    </div>
    <div class="ws-quota-bar" role="progressbar" aria-label="云空间已用空间" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(
      percent,
    )}" title="已用 ${esc(fmtSize(used))}，容量 ${esc(fmtQuota(limit))}">
      <span class="ws-quota-fill${level === 'critical' || level === 'full' ? ' is-critical' : level === 'notice' || level === 'warning' ? ' is-high' : ''}" style="width:${percent.toFixed(1)}%"></span>
    </div>
    ${warningHtml}
    <div class="ws-quota-foot">
      <span>剩余 ${esc(fmtSize(remaining))} · 单文件 ≤ ${esc(fmtQuota(fileLimit))}</span>
      <span class="ws-quota-source" title="容量与单文件上限由管理员在控制台配置">${esc(sourceLabel)}${esc(
        roleText,
      )}</span>
    </div>
    <div class="ws-quota-note">文件保存在 EAB 服务端，换设备登录仍可见</div>`
}

let lastWorkspaceWarningLevel = ''
function maybeWarnWorkspaceQuota(quota) {
  const user = quota.user || {}
  const used = Math.max(0, Number(user.used) || 0)
  const limit = Math.max(0, Number(user.limit ?? user.limitBytes) || 0)
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 100
  const warning = quota.warning || user.warning || {}
  const level = String(
    warning.level ||
      (percent >= 100 ? 'full' : percent >= 95 ? 'critical' : percent >= 85 ? 'warning' : percent >= 75 ? 'notice' : 'normal'),
  )
  if (level === 'normal') {
    lastWorkspaceWarningLevel = ''
    return
  }
  if (level === lastWorkspaceWarningLevel) return
  lastWorkspaceWarningLevel = level
  const message = String(warning.message || '').trim()
  if (!message) return
  banner(`${message} 可在侧栏「云空间」查看详情。`, level === 'critical' || level === 'full' ? 'bad' : 'warn')
}

function spaceLabelFor(kind) {
  return kind === 'none' ? '不使用文件' : '云空间'
}

function renderSpaceChip() {
  const label = $('#space-chip-label')
  const chip = $('#space-chip')
  if (!label || !chip) return
  const kind = state.spaceKind === 'none' ? 'none' : 'cloud'
  state.spaceKind = kind
  state.spaceLabel = spaceLabelFor(kind)
  label.textContent = state.spaceLabel
  chip.classList.toggle('is-none', kind === 'none')
  chip.title = kind === 'none'
    ? '本轮不读写文件；点击可切换到云空间'
    : '云空间默认可用；点击可切换为不使用文件空间'
  chip.setAttribute('aria-label', `文件空间：${state.spaceLabel}`)
}

function applySessionSpace(session) {
  const saved = session?.space_kind
  state.spaceKind = saved === 'none' ? 'none' : 'cloud'
  renderSpaceChip()
}

function setSpace(kind, _spaceId, options = {}) {
  state.spaceKind = kind === 'none' ? 'none' : 'cloud'
  renderSpaceChip()
  hideSpaceMenu()
  if (!options.silent) {
    closeWorkspaceFile()
    banner(`文件空间已切换为「${spaceLabelFor(state.spaceKind)}」；发送新消息后生效。`, 'ok')
  }
}

function hideSpaceMenu() {
  const menu = $('#space-menu')
  if (menu) menu.hidden = true
  $('#space-chip')?.setAttribute('aria-expanded', 'false')
}

/** 空间气泡独立绑定：即使当前账号没有可用模型，也能打开/关闭空间菜单 */
function bindSpacePicker() {
  const chip = $('#space-chip')
  const menu = $('#space-menu')
  if (!chip || !menu) return
  chip.addEventListener('click', (event) => {
    event.stopPropagation()
    const open = menu.hidden
    if (open) renderSpaceMenu()
    menu.hidden = !open
    chip.setAttribute('aria-expanded', open ? 'true' : 'false')
  })
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#space-chip') && !event.target.closest('#space-menu')) hideSpaceMenu()
  })
}

function renderSpaceMenu() {
  const menu = $('#space-menu')
  if (!menu) return
  const options = [
    { kind: 'cloud', label: '云空间', desc: '默认可用，文件保存在云端' },
    { kind: 'none', label: '不使用文件空间', desc: '本轮只聊天，不读写任何文件' },
  ]
  menu.innerHTML = options
    .map(
      (option) => `<button class="space-menu-item${state.spaceKind === option.kind ? ' is-active' : ''}" type="button" data-space-kind="${option.kind}">
        <span class="space-menu-name">${option.label}</span>
        <span class="space-menu-desc">${option.desc}</span>
      </button>`,
    )
    .join('')
  for (const button of menu.querySelectorAll('[data-space-kind]')) {
    button.addEventListener('click', () => setSpace(button.dataset.spaceKind))
  }
}
function workspaceFileUrl(file) {
  return `/api/workspace/files/${encodeURIComponent(file.id)}/download${qs()}`
}

function workspaceFileDate(value) {
  const date = new Date(Number(value) || 0)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '—'
}

function renderWorkspaceFiles() {
  const box = $('#ws-list')
  if (!box) return
  if (state.files.length === 0) {
    box.innerHTML = '<div class="muted" style="font-size:12px;padding:4px">还没有文件。点「上传」，或让对话把内容写进云空间。</div>'
    return
  }
  const activeId = state.filePreview?.id
  box.innerHTML = state.files
    .map(
      (file) => `<div class="side-file${activeId === file.id ? ' is-active' : ''}" data-file-row="${esc(file.id)}">
        <button class="side-file-name" type="button" data-file-open="${esc(file.id)}" title="${esc(file.relPath)}">${esc(file.name)}${file.shared ? ' <span class="side-file-shared">共享</span>' : ''}</button>
        <span class="side-file-size">${fmtSize(file.size)}</span>
        <button class="side-file-more" type="button" data-file-more="${esc(file.id)}" title="文件操作" aria-label="文件操作" aria-haspopup="menu">⋯</button>
      </div>`,
    )
    .join('')
  for (const button of box.querySelectorAll('[data-file-open]')) {
    button.addEventListener('click', () => openWorkspaceFile(button.dataset.fileOpen))
  }
  for (const button of box.querySelectorAll('[data-file-more]')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      showFileMenu(button.dataset.fileMore, button.getBoundingClientRect())
    })
  }
  for (const row of box.querySelectorAll('[data-file-row]')) {
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      showFileMenu(
        row.dataset.fileRow,
        { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY },
        true,
      )
    })
  }
}

function fileById(fileId) {
  return state.files.find((file) => file.id === fileId)
}

function hideFileMenu() {
  const menu = $('#file-menu')
  if (!menu) return
  menu.hidden = true
  menu.dataset.file = ''
}

function showFileMenu(fileId, anchor, atPoint = false) {
  const menu = $('#file-menu')
  const file = fileById(fileId)
  if (!menu || !file) return
  hideSessionMenu()
  const owner = file.ownerUserId === state.me?.person?.id
  menu.innerHTML = `<div class="session-menu-title">${esc(file.name)}</div>
    ${
      owner
        ? `<button type="button" data-file-act="send-dingtalk">发送到钉钉</button>
           <button type="button" data-file-act="rename">重命名</button>
           <button type="button" data-file-act="edit">编辑</button>
           <button type="button" data-file-act="delete" class="is-danger">删除</button>`
        : `<button type="button" data-file-act="download">下载</button>
           <button type="button" data-file-act="send-dingtalk">发送到钉钉</button>`
    }`
  menu.dataset.file = fileId
  menu.hidden = false
  const box = menu.getBoundingClientRect()
  const left = atPoint
    ? Math.min(anchor.left, window.innerWidth - box.width - 8)
    : Math.min(Math.max(8, anchor.right - box.width), window.innerWidth - box.width - 8)
  const top = atPoint
    ? Math.min(anchor.top, window.innerHeight - box.height - 8)
    : anchor.bottom + 4 + box.height + 8 > window.innerHeight
      ? Math.max(8, anchor.top - box.height - 4)
      : anchor.bottom + 4
  menu.style.left = `${Math.max(8, left)}px`
  menu.style.top = `${Math.max(8, top)}px`
}

async function renameWorkspaceFile(file) {
  if (!file) return
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>重命名文件</h3><button class="modal-x" type="button">×</button></div>
    <p class="hint">只改文件名；同名文件已存在时会提示。</p>
    <div class="form-grid"><label><span>文件名</span><input id="ws-rename-input" value="${esc(
      file.name,
    )}" /></label></div>
    <div class="modal-state" id="ws-rename-state"></div>
    <div class="modal-actions"><button class="btn ghost" type="button" id="ws-rename-cancel">取消</button><button class="btn primary" type="button" id="ws-rename-save">保存</button></div>
  </div>`
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  const input = overlay.querySelector('#ws-rename-input')
  const stateEl = overlay.querySelector('#ws-rename-state')
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#ws-rename-cancel').addEventListener('click', close)
  input.focus()
  input.select()
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') overlay.querySelector('#ws-rename-save').click()
  })
  overlay.querySelector('#ws-rename-save').addEventListener('click', async () => {
    const next = input.value.trim()
    if (!next) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '文件名不能为空'
      return
    }
    if (next === file.name) {
      close()
      return
    }
    stateEl.className = 'modal-state muted'
    stateEl.textContent = '正在保存…'
    try {
      await api(`/api/workspace/files/${encodeURIComponent(file.id)}${qs()}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: next }),
      })
      close()
      await loadWorkspaceFiles()
      if (state.filePreview?.id === file.id) await openWorkspaceFile(file.id)
      banner('文件已重命名', 'ok')
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '重命名失败'
    }
  })
}

async function editWorkspaceFile(file) {
  if (!file) return
  if (!isTextLike(file)) {
    banner('这个文件类型不支持在线编辑，请下载后编辑。', 'bad')
    return
  }
  if (Number(file.size) > 5 * 1024 * 1024) {
    banner('文本文件超过 5 MB，请下载后编辑。', 'bad')
    return
  }
  await openWorkspaceFile(file.id)
  if (state.filePreview?.id === file.id && workspacePreviewTextLoaded) beginWorkspaceEdit()
}

function deleteWorkspaceFile(file, fromPreview = false) {
  if (!file) return
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>删除文件</h3><button class="modal-x" type="button">×</button></div>
    <p class="hint">「${esc(file.name)}」会移到回收区并保留元数据，可在审计中追溯。</p>
    <div class="modal-state" id="ws-delete-state"></div>
    <div class="modal-actions"><button class="btn ghost" type="button" id="ws-delete-cancel">取消</button><button class="btn danger" type="button" id="ws-delete-confirm">删除</button></div>
  </div>`
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  const stateEl = overlay.querySelector('#ws-delete-state')
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#ws-delete-cancel').addEventListener('click', close)
  overlay.querySelector('#ws-delete-confirm').addEventListener('click', async () => {
    stateEl.className = 'modal-state muted'
    stateEl.textContent = '正在删除…'
    try {
      await api(`/api/workspace/files/${encodeURIComponent(file.id)}${qs()}`, { method: 'DELETE' })
      close()
      if (fromPreview && state.filePreview?.id === file.id) closeWorkspaceFile()
      await loadWorkspaceFiles()
      banner('文件已移到回收区', 'ok')
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '删除失败'
    }
  })
}

async function sendWorkspaceFileToDingTalk(file) {
  if (!file) return
  const button = $('#file-pane-send-dingtalk')
  const oldText = button ? button.textContent : ''
  if (button) {
    button.disabled = true
    button.textContent = '发送中…'
  }
  try {
    const sent = await api(`/api/workspace/files/${encodeURIComponent(file.id)}/send-dingtalk${qs()}`, {
      method: 'POST',
    })
    banner(`已发送到钉钉：${sent.fileName}`, 'ok')
  } catch (err) {
    banner(err.message || '发送到钉钉失败', 'bad')
  } finally {
    if (button) {
      button.disabled = false
      button.textContent = oldText || '发送到钉钉'
    }
  }
}

/* ---------------- 个人工作区：右侧文件预览与编辑 ---------------- */

let workspacePreviewText = ''
let workspacePreviewTextLoaded = false
let workspacePreviewObjectUrl = ''
let workspacePreviewSaving = false
let workspacePreviewToken = 0

function isImageLike(file) {
  const mime = file.mime || file.type || ''
  return /^image\//i.test(mime) || /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(file.name || '')
}

function isPdfLike(file) {
  const mime = file.mime || file.type || ''
  return /^application\/pdf$/i.test(mime) || /\.pdf$/i.test(file.name || '')
}

function setFilePaneBody(node) {
  const body = $('#file-pane-body')
  if (!body) return
  body.innerHTML = ''
  body.appendChild(node)
}

function filePaneMessage(message, tone = 'muted') {
  const holder = document.createElement('div')
  holder.className = `file-pane-empty ${tone === 'bad' ? 'is-bad' : ''}`
  const text = document.createElement('p')
  text.textContent = message
  holder.appendChild(text)
  setFilePaneBody(holder)
}

function releaseWorkspacePreviewUrl() {
  if (workspacePreviewObjectUrl) {
    URL.revokeObjectURL(workspacePreviewObjectUrl)
    workspacePreviewObjectUrl = ''
  }
}

async function openWorkspaceFile(id) {
  const file = state.files.find((item) => item.id === id)
  if (!file) {
    banner('文件已不存在，列表可能刚被刷新', 'bad')
    await loadWorkspaceFiles()
    return
  }
  releaseWorkspacePreviewUrl()
  const token = ++workspacePreviewToken
  state.filePreview = file
  workspacePreviewText = ''
  workspacePreviewTextLoaded = false
  const pane = $('#file-pane')
  pane.hidden = false
  $('#thread').hidden = true
  $('#workspace-pane').hidden = true
  $('.composer').hidden = true
  $('#file-pane-editor').hidden = true
  $('#file-pane-body').hidden = false
  $('#file-pane-kicker').textContent = '云空间'
  $('#file-pane-name').textContent = file.name
  const meta = [fmtSize(file.size), `更新于 ${workspaceFileDate(file.updatedAt)}`, file.shared ? '共享文件' : '个人文件', file.relPath]
  $('#file-pane-meta').textContent = meta.filter(Boolean).join(' · ')
  $('#chat-title').textContent = `云空间 · ${file.name}`
  const owner = file.ownerUserId === state.me?.person?.id
  $('#file-pane-rename').hidden = true
  $('#file-pane-edit').hidden = true
  $('#file-pane-delete').hidden = !owner
  $('#file-pane-download').hidden = false
  $('#file-pane-send-dingtalk').hidden = false
  renderWorkspaceFiles()
  filePaneMessage('正在读取文件…')
  try {
    const response = await fetch(workspaceFileUrl(file), { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`读取文件失败（HTTP ${response.status}）`)
    const blob = await response.blob()
    if (token !== workspacePreviewToken || state.filePreview?.id !== file.id) return
    if (isTextLike(file)) {
      if (file.size > 5 * 1024 * 1024) {
        filePaneMessage('这个文本文件超过 5 MB，先在右侧下载后查看。')
        $('#file-pane-edit').hidden = true
        return
      }
      const text = await blob.text()
      workspacePreviewText = text
      workspacePreviewTextLoaded = true
      const pre = document.createElement('pre')
      pre.className = 'file-text-view'
      pre.textContent = text || '（空文件）'
      setFilePaneBody(pre)
      $('#file-pane-edit').hidden = !owner
      return
    }
    if (isImageLike(file)) {
      workspacePreviewObjectUrl = URL.createObjectURL(blob)
      const image = document.createElement('img')
      image.className = 'file-image-view'
      image.alt = file.name
      image.src = workspacePreviewObjectUrl
      setFilePaneBody(image)
      return
    }
    if (isPdfLike(file)) {
      workspacePreviewObjectUrl = URL.createObjectURL(blob)
      const frame = document.createElement('iframe')
      frame.className = 'file-pdf-view'
      frame.title = file.name
      frame.src = workspacePreviewObjectUrl
      setFilePaneBody(frame)
      return
    }
    filePaneMessage('这个文件类型不能直接预览，点右上角「下载」查看内容。')
  } catch (err) {
    if (token !== workspacePreviewToken) return
    filePaneMessage(`读取失败：${err.message}`, 'bad')
  }
}

function closeWorkspaceFile() {
  workspacePreviewToken += 1
  state.filePreview = null
  workspacePreviewText = ''
  workspacePreviewTextLoaded = false
  releaseWorkspacePreviewUrl()
  $('#file-pane').hidden = true
  $('#file-pane-editor').hidden = true
  $('#file-pane-rename').hidden = true
  $('#file-pane-body').hidden = false
  $('#file-pane-body').innerHTML = ''
  $('#thread').hidden = state.mode !== 'chat'
  $('.composer').hidden = state.mode !== 'chat'
  $('#workspace-pane').hidden = state.mode !== 'workspace'
  $('#chat-title').textContent = state.mode === 'workspace' ? '' : state.sessionId ? '对话' : '新对话'
  renderWorkspaceFiles()
}

function beginWorkspaceEdit() {
  const file = state.filePreview
  if (!file || !workspacePreviewTextLoaded) return
  $('#file-pane-body').hidden = true
  $('#file-pane-editor').hidden = false
  $('#file-pane-text').value = workspacePreviewText
  $('#file-pane-editor-hint').textContent = '保存后会覆盖原文件内容；空内容也可以保存。'
  $('#file-pane-text').focus()
}

function cancelWorkspaceEdit() {
  $('#file-pane-editor').hidden = true
  $('#file-pane-body').hidden = false
}

async function saveWorkspaceEdit() {
  const file = state.filePreview
  if (!file || workspacePreviewSaving) return
  const text = $('#file-pane-text').value
  workspacePreviewSaving = true
  $('#file-pane-save').disabled = true
  try {
    await api(`/api/workspace/files${qs()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file.relPath, text, mime: file.mime || 'text/plain; charset=utf-8' }),
    })
    banner('文件内容已保存', 'ok')
    await loadWorkspaceFiles()
    if (state.files.some((item) => item.id === file.id)) await openWorkspaceFile(file.id)
    else closeWorkspaceFile()
  } catch (err) {
    $('#file-pane-editor-hint').textContent = `保存失败：${err.message}`
  } finally {
    workspacePreviewSaving = false
    $('#file-pane-save').disabled = false
  }
}

async function deleteWorkspacePreview() {
  const file = state.filePreview
  if (!file) return
  deleteWorkspaceFile(file, true)
}

function downloadWorkspacePreview() {
  const file = state.filePreview
  if (!file) return
  const link = document.createElement('a')
  link.href = workspaceFileUrl(file)
  link.download = file.name
  document.body.appendChild(link)
  link.click()
  link.remove()
}

function bindWorkspaceFilePane() {
  $('#file-pane-close')?.addEventListener('click', closeWorkspaceFile)
  $('#file-pane-download')?.addEventListener('click', downloadWorkspacePreview)
  $('#file-pane-send-dingtalk')?.addEventListener('click', () => {
    const file = state.filePreview
    if (file && file.id) sendWorkspaceFileToDingTalk(file)
  })
  $('#file-pane-edit')?.addEventListener('click', beginWorkspaceEdit)
  $('#file-pane-cancel')?.addEventListener('click', cancelWorkspaceEdit)
  $('#file-pane-save')?.addEventListener('click', saveWorkspaceEdit)
  $('#file-pane-delete')?.addEventListener('click', deleteWorkspacePreview)
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

const TEXT_EXT = /\.(txt|md|markdown|json|csv|tsv|log|js|mjs|cjs|ts|tsx|jsx|html|htm|css|xml|yml|yaml|ini|conf|sql|py|java|go|rs|sh|ps1|bat)\b/i
const TEXT_MIME = /^text\/|application\/(json|xml|x-yaml|yaml|x-ndjson|csv)/i

function isTextLike(file) {
  const mime = file.mime || file.type || ''
  return TEXT_EXT.test(file.name || '') || TEXT_MIME.test(mime)
}

function safeFileName(file) {
  if (file.name) return file.name
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/jpeg' ? 'jpg' : 'bin'
  return `粘贴文件-${Date.now()}.${ext}`
}

async function readTextAttachment(file) {
  const slice = file.size > 1024 * 1024 ? file.slice(0, 1024 * 1024) : file
  const text = await slice.text()
  return text.slice(0, 12000)
}

async function uploadWorkspaceFiles(fileList) {
  for (const file of fileList) {
    if (file.size > 50 * 1024 * 1024) {
      alert(`${file.name} 超过 50 MB，已跳过`)
      continue
    }
    try {
      await api(`/api/workspace/files${qs()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: file.name,
          mime: file.type || undefined,
          contentBase64: await readAsBase64(file),
        }),
      })
    } catch (err) {
      alert(`${file.name} 上传失败：${err.message}`)
    }
  }
  await loadWorkspaceFiles()
}

/* ---------------- 左侧账号信息 ---------------- */

/** 只接受 http(s) 地址，避免把后端字段当任意 URI 塞进 img。 */
function safeAvatarUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  // 同源头像代理；只接受固定路径（可带用户/头像版本参数），不接受任意相对地址。
  if (raw === '/api/me/avatar' || raw.startsWith('/api/me/avatar?')) return raw
  if (raw === '/api/company/assistant-avatar' || raw.startsWith('/api/company/assistant-avatar?')) return raw
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

/**
 * 头像统一渲染：有地址就用钉钉头像，没有/加载失败就露姓名首字。
 * 首字始终在 span 里，img 盖在上面；onerror 只摘掉图片和 has-photo，不留下破图。
 */
function avatarInner(name, url, fallback, eager = false) {
  const initial = esc(String(fallback || String(name || '我').trim().slice(0, 1) || '我'))
  const safeUrl = safeAvatarUrl(url)
  if (!safeUrl) return initial
  return `<img class="avatar-img" src="${esc(safeUrl)}" alt="" loading="${eager ? 'eager' : 'lazy'}" onerror="this.parentElement.classList.remove('has-photo');this.remove()">${initial}`
}

function avatarMarkup(name, url, className, fallback, eager = false) {
  const hasPhoto = Boolean(safeAvatarUrl(url))
  return `<span class="${className}${hasPhoto ? ' has-photo' : ''}">${avatarInner(name, url, fallback, eager)}</span>`
}

/**
 * 头像代理地址必须按“当前用户 + 头像地址”区分。
 * 否则同一浏览器切换账号时，浏览器会命中上一个人的 /api/me/avatar 缓存，
 * 出现“所有人的头像都是同一个人”的假象。版本参数只用于换缓存键，服务端不读取。
 */
function meAvatarUrl(me = state.me) {
  const person = me?.person
  if (!person?.avatar) return ''
  return `/api/me/avatar?v=${encodeURIComponent(`${person.id}:${person.avatar}`)}`
}

/** 后台「公司资料 → 助手身份」配置；没配置时回退到现在的「AI」。 */
function assistantIdentity() {
  const assistant = state.assistant || {}
  const name = String(assistant.name || '').trim() || 'AI'
  return { name, avatarUrl: assistant.avatarUrl || '' }
}

/**
 * AI 消息左侧统一身份区：头像在上、名字在下，和「我」的 who-me 排版对应。
 * 短名字（AI / 小易）无头像时直接露全名，长名字只露首字。
 */
function aiWhoMarkup() {
  const { name, avatarUrl } = assistantIdentity()
  const fallback = name.length <= 2 ? name : name.slice(0, 1)
  // 没配头像且名字很短时，徽标本身就露全名，不再重复一行名字；保持旧版「AI」的观感。
  const showName = Boolean(avatarUrl) || name.length > 2
  return `<div class="who-ai">${avatarMarkup(name, avatarUrl, 'who-badge ai', fallback, true)}${
    showName ? `<span class="who-name" title="${esc(name)}">${esc(name)}</span>` : ''
  }</div>`
}

function renderSideUser(me) {
  $('#side-user').hidden = false
  const sideAvatar = $('#user-avatar')
  const avatarSrc = meAvatarUrl(me)
  sideAvatar.innerHTML = avatarInner(me.person.name, avatarSrc)
  sideAvatar.classList.toggle('has-photo', Boolean(avatarSrc))
  $('#user-name').textContent = me.person.name
  $('#user-title').textContent = me.person.title || '—'
  const company = me.company?.name || ''
  const dept = me.person.deptName || ''
  const org = $('#user-org')
  if (company && dept && dept !== company) {
    org.innerHTML = `<span class="side-org-company">${esc(company)}</span><span class="side-org-dept">${esc(dept)}</span>`
    org.dataset.orgText = `${company} · ${dept}`
  } else {
    org.textContent = org.dataset.orgText = company || dept || '—'
  }
  $('#user-roles').innerHTML = (me.roles || [])
    .map((role) => `<span class="pill">${esc(ROLE_LABEL[role] || role)}</span>`)
    .join('')
}

async function showMemories() {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  const render = (items) => {
    const rows = items.length
      ? items
          .map(
            (item) => `<div class="mini-row"><span>${esc(item.content)} <span class="desc">${
              item.confirmed ? '已确认' : '待确认'
            } · ${esc(item.scopeType)}</span></span><span>${
              item.confirmed ? '' : `<button class="link-btn accent" type="button" data-mem-confirm="${esc(item.id)}">确认</button>`
            }<button class="link-btn danger-link" type="button" data-mem-del="${esc(item.id)}">删除</button></span></div>`,
          )
          .join('')
      : '<span class="hint">还没有记忆。把偏好或长期事项写下来，确认后下轮对话会自动带上。</span>'
    overlay.innerHTML = `<div class="modal">
      <div class="modal-head"><h3>我的记忆</h3><button class="modal-x" type="button">×</button></div>
      <div class="hint">只有你确认过的记忆会进入对话上下文；模型不能自己写长期记忆。</div>
      <div class="modal-section-title">已有记忆 <span>${items.length} 条</span></div>
      <div class="mini-list">${rows}</div>
      <div class="field-stack" style="padding-top:12px">
        <label class="field"><span>新增一条</span><input id="mem-input" placeholder="例如：汇报材料尽量用一页纸" maxlength="1000" /></label>
      </div>
      <div class="modal-state" id="mem-state"></div>
      <div class="modal-actions"><button class="btn primary" type="button" id="mem-add">保存</button><button class="btn ghost" type="button" id="mem-close">关闭</button></div>
    </div>`
    const close = () => overlay.remove()
    overlay.querySelector('.modal-x').addEventListener('click', close)
    overlay.querySelector('#mem-close').addEventListener('click', close)
    overlay.querySelector('#mem-add').addEventListener('click', async () => {
      const stateEl = overlay.querySelector('#mem-state')
      const content = overlay.querySelector('#mem-input').value.trim()
      if (!content) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '先写点内容'
        return
      }
      try {
        await api('/api/memories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, scopeType: 'user' }) })
        await refresh()
      } catch (err) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = err.message || '保存失败'
      }
    })
    for (const button of overlay.querySelectorAll('[data-mem-confirm]')) {
      button.addEventListener('click', async () => {
        await api(`/api/memories/${encodeURIComponent(button.dataset.memConfirm)}/confirm`, { method: 'POST' }).catch(() => null)
        await refresh()
      })
    }
    for (const button of overlay.querySelectorAll('[data-mem-del]')) {
      button.addEventListener('click', async () => {
        await api(`/api/memories/${encodeURIComponent(button.dataset.memDel)}`, { method: 'DELETE' }).catch(() => null)
        await refresh()
      })
    }
  }
  const refresh = async () => {
    try {
      const data = await api('/api/memories')
      render(data.memories || [])
    } catch (err) {
      render([])
      const stateEl = overlay.querySelector('#mem-state')
      if (stateEl) stateEl.textContent = err.message
    }
  }
  document.body.appendChild(overlay)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove()
  })
  await refresh()
}

function showMyCaps() {
  const me = state.me
  if (!me) return
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  const caps = (me.capabilities || []).map((cap) => `<span class="chip" title="${esc(cap.scope)}">${esc(cap.label)}</span>`).join('')
  const roles = (me.roles || []).map((role) => `<span class="pill">${esc(ROLE_LABEL[role] || role)}</span>`).join('')
  overlay.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>我的权限</h3><button class="modal-x" type="button">×</button></div>
    <div class="kv-grid">
      <div><span>姓名</span><strong>${esc(me.person.name)}</strong></div>
      <div><span>部门</span><strong>${esc(me.person.deptName || '—')}</strong></div>
      <div><span>公司</span><strong>${esc(me.company?.name || '—')}</strong></div>
      <div><span>角色</span><strong>${roles || '—'}</strong></div>
    </div>
    <div class="modal-section-title">能做的事 <span>${(me.capabilities || []).length} 项</span></div>
    <div class="scope-groups"><div class="scope-group">${caps || '<span class="muted">暂无</span>'}</div></div>
    <div class="modal-actions"><button class="btn primary" type="button" id="caps-ok">知道了</button></div>
  </div>`
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#caps-ok').addEventListener('click', close)
}

function showPasswordModal() {
  const configured = state.me?.passwordConfigured === true
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `<div class="modal password-modal">
    <div class="modal-head"><h3>${configured ? '修改密码' : '设置登录密码'}</h3><button class="modal-x" type="button">×</button></div>
    <p class="hint">${
      configured
        ? '修改成功后，其他设备上的登录会失效，当前浏览器保持登录。'
        : '当前账号由钉钉同步，还没有设置过登录密码，直接设置新密码即可；设置后其他设备上的登录会失效，当前浏览器保持登录。'
    }</p>
    <div class="form-grid">
      ${
        configured
          ? '<label class="password-old"><span>当前密码</span><input id="password-old" type="password" autocomplete="current-password" spellcheck="false" placeholder="输入当前登录密码" /></label>'
          : ''
      }
      <label><span>新密码</span><input id="password-new" type="password" autocomplete="new-password" spellcheck="false" maxlength="128" placeholder="至少 8 位" /></label>
      <label><span>确认新密码</span><input id="password-confirm" type="password" autocomplete="new-password" spellcheck="false" maxlength="128" placeholder="再输入一次新密码" /></label>
    </div>
    <div class="modal-state" id="password-state"></div>
    <div class="modal-actions"><button class="btn ghost" type="button" id="password-cancel">取消</button><button class="btn primary" type="button" id="password-save">${configured ? '保存新密码' : '设置密码'}</button></div>
  </div>`
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  const oldInput = overlay.querySelector('#password-old')
  const newInput = overlay.querySelector('#password-new')
  const confirmInput = overlay.querySelector('#password-confirm')
  const saveButton = overlay.querySelector('#password-save')
  const stateEl = overlay.querySelector('#password-state')
  let busy = false

  const fail = (message, focus) => {
    stateEl.className = 'modal-state bad'
    stateEl.textContent = message
    if (focus) {
      focus.focus()
      focus.select?.()
    }
  }

  const submit = async () => {
    if (busy) return
    const oldPassword = oldInput?.value ?? ''
    const newPassword = newInput.value
    const confirmPassword = confirmInput.value
    if (configured && !oldPassword) return fail('请输入当前密码', oldInput)
    if (newPassword.length < 8) return fail('新密码至少 8 位', newInput)
    if (newPassword !== confirmPassword) return fail('两次输入的新密码不一致', confirmInput)
    if (configured && newPassword === oldPassword) return fail('新密码不能和当前密码相同', newInput)
    busy = true
    saveButton.disabled = true
    saveButton.textContent = '正在保存…'
    stateEl.className = 'modal-state muted'
    stateEl.textContent = configured ? '正在更新密码…' : '正在设置密码…'
    try {
      await api('/api/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      })
      if (state.me) state.me.passwordConfigured = true
      renderPasswordSettingRow()
      close()
      banner(configured ? '密码已修改，其他设备已退出登录' : '登录密码已设置，其他设备已退出登录', 'ok')
    } catch (err) {
      busy = false
      saveButton.disabled = false
      saveButton.textContent = configured ? '保存新密码' : '设置密码'
      fail(err.message || '密码设置失败', /当前密码|旧密码/.test(err.message || '') ? oldInput : null)
    }
  }

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#password-cancel').addEventListener('click', close)
  saveButton.addEventListener('click', submit)
  for (const input of [oldInput, newInput, confirmInput].filter(Boolean)) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        submit()
      }
    })
  }
  ;(oldInput ?? newInput).focus()
}

/* ---------------- 工作台：对话 / 个人插件 ---------------- */

function setChatMode(mode) {
  if (state.filePreview) closeWorkspaceFile()
  const next = mode === 'workspace' ? 'workspace' : 'chat'
  state.mode = next
  state.view = next
  $('.chat-main').classList.toggle('is-workspace', next === 'workspace')
  $('#thread').hidden = next !== 'chat'
  $('.composer').hidden = next !== 'chat'
  $('#workspace-pane').hidden = next !== 'workspace'
  for (const button of $('#mode-switch').querySelectorAll('[data-mode]')) {
    const active = button.dataset.mode === next
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-selected', active ? 'true' : 'false')
  }
  if (next === 'workspace') {
    $('#chat-title').textContent = ''
    loadMyPlugins()
  } else {
    $('#chat-title').textContent = state.sessionId ? '对话' : '新对话'
  }
  persistChatLocation()
}

async function loadMyPlugins() {
  const rail = $('#my-plugin-rail')
  const detail = $('#my-plugin-detail')
  if (!rail || !detail) return
  rail.innerHTML = '<div class="plugin-empty muted">正在读取插件…</div>'
  detail.innerHTML = '<div class="plugin-empty muted">正在读取插件…</div>'
  try {
    const data = await api(`/api/my/plugins${qs()}`)
    state.pluginData = data
    state.plugins = Array.isArray(data.plugins) ? data.plugins : []
    if (!state.pluginSelected || !state.plugins.some((item) => item.id === state.pluginSelected)) {
      state.pluginSelected = state.plugins[0]?.id ?? null
      state.pluginTab = 'overview'
      state.pluginPageKey = null
    }
    renderMyPluginWorkspace()
  } catch (err) {
    rail.innerHTML = `<div class="plugin-empty bad">读取插件失败：${esc(err.message)}</div>`
    detail.innerHTML = `<div class="plugin-empty bad">读取插件失败：${esc(err.message)}</div>`
  }
}

const MY_PLUGIN_SOURCE_LABEL = {
  'browser-dir': '本机文件夹',
  npm: 'npm 包',
  github: 'GitHub 仓库',
  catalog: '服务器插件目录',
}

function myPluginStatus(plugin) {
  if (!plugin.valid) return { label: '清单无效', tone: 'danger' }
  if (!plugin.enabled) return { label: '已停用', tone: 'warn' }
  if (plugin.host?.error) return { label: '启用 · host 异常', tone: 'danger' }
  if (plugin.format === 'dsh') {
    return plugin.host?.loaded
      ? { label: '运行中', tone: 'ok' }
      : { label: '已启用 · host 待加载', tone: 'warn' }
  }
  return { label: '已启用', tone: 'ok' }
}

function myPluginStatusPill(plugin) {
  const status = myPluginStatus(plugin)
  return `<span class="pill ${status.tone}">${esc(status.label)}</span>`
}

function myPluginSourceLabel(plugin) {
  return MY_PLUGIN_SOURCE_LABEL[plugin.install?.source] || plugin.install?.source || '个人安装'
}

function myPluginPageUrl(data, plugin, page) {
  const kind = page.kind || 'html'
  if (kind === 'dsh-client') {
    const params = new URLSearchParams({
      id: plugin.id,
      entry: page.file,
      company: data.companyId || '',
      version: plugin.version || '',
      title: page.title || plugin.name || plugin.id,
      scope: 'user',
    })
    if (currentAs()) params.set('as', currentAs())
    return `/plugin-host.html?${params.toString()}`
  }
  const path = String(page.file || '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  const params = new URLSearchParams(location.search)
  params.set('scope', 'user')
  const text = params.toString()
  return `/plugins/assets/${encodeURIComponent(plugin.id)}/${path}${text ? `?${text}` : ''}`
}

function myPluginRailItem(plugin) {
  const status = myPluginStatus(plugin)
  const active = plugin.id === state.pluginSelected
  const format = plugin.format === 'dsh' ? 'DSH' : 'EAB'
  return `<button class="plugin-rail-item ${active ? 'is-active' : ''} ${plugin.enabled ? '' : 'is-muted'}" type="button" data-my-plugin-select="${esc(plugin.id)}">
    <span class="plugin-rail-avatar ${plugin.enabled ? '' : 'ghost'}">${esc((plugin.name || plugin.id).slice(0, 1).toUpperCase())}</span>
    <span class="plugin-rail-text">
      <strong>${esc(plugin.name || plugin.id)}</strong>
      <small>${esc(format)} · v${esc(plugin.version || '—')} · ${esc(status.label)}</small>
    </span>
    <span class="plugin-rail-dot ${status.tone === 'ok' ? 'ok' : status.tone === 'warn' ? 'warn' : 'bad'}" aria-hidden="true"></span>
  </button>`
}

function myPluginRailHtml(data) {
  const plugins = data.plugins || state.plugins || []
  const stats = data.stats || { installed: plugins.length, enabled: 0, tools: 0 }
  const who = state.me?.person?.name || '个人空间'
  return `<div class="plugin-scope-block">
      <span class="plugin-scope-eyebrow">个人空间</span>
      <strong>${esc(who)}</strong>
      <small>只显示你自己安装的插件</small>
    </div>
    <div class="plugin-rail-metrics">
      <div><strong>${stats.installed}</strong><span>已装</span></div>
      <div><strong>${stats.enabled}</strong><span>启用</span></div>
      <div><strong>${stats.tools}</strong><span>工具</span></div>
    </div>
    <div class="plugin-rail-actions">
      <button class="btn ghost sm" type="button" data-my-plugin-install>安装插件…</button>
      <button class="btn ghost sm" type="button" data-my-plugin-refresh>刷新</button>
    </div>
    <div class="plugin-rail-head">已安装 <span class="muted">${plugins.length}</span></div>
    <div class="plugin-rail-list">
      ${plugins.length ? plugins.map(myPluginRailItem).join('') : '<div class="plugin-empty">还没有个人插件</div>'}
    </div>`
}

function myPluginOverviewBody(data, plugin) {
  const pages = plugin.pages || []
  const tools = plugin.tools || []
  const scopes = plugin.scopes || []
  const pagesHtml = pages.length
    ? pages
        .map(
          (page) =>
            `<button class="btn ghost sm" type="button" data-my-plugin-page="${esc(page.file)}" ${plugin.enabled ? '' : 'disabled title="先启用插件"'}>${esc(page.title || page.id)}</button>`,
        )
        .join('')
    : '<span class="muted">没有页面入口</span>'
  const toolHtml = tools.length
    ? tools.map((tool) => `<span class="chip">${esc(tool.name)}</span>`).join('')
    : '<span class="muted">没有注册工具</span>'
  return `<div class="plugin-overview">
    <section class="plugin-block">
      <h3>插件概况</h3>
      <div class="plugin-kv">
        <div><span>版本</span><strong>v${esc(plugin.version || '—')}</strong></div>
        <div><span>格式</span><strong>${plugin.format === 'dsh' ? 'DSH 插件' : 'EAB 插件'}</strong></div>
        <div><span>作者</span><strong>${esc(plugin.author || '未知作者')}</strong></div>
        <div><span>许可证</span><strong>${esc(plugin.license || '未声明')}</strong></div>
        <div><span>关键词</span><strong>${esc((plugin.keywords || []).join('、') || '—')}</strong></div>
        <div><span>权限需求</span><strong>${esc(scopes.join('、') || '无')}</strong></div>
      </div>
      <div class="plugin-page-list"><span>贡献页面</span><div>${pagesHtml}</div></div>
    </section>
    <section class="plugin-block">
      <h3>安装与归属</h3>
      <div class="plugin-kv">
        <div><span>归属</span><strong>个人安装（只影响我）</strong></div>
        <div><span>安装方式</span><strong>${esc(myPluginSourceLabel(plugin))}</strong></div>
        <div><span>安装时间</span><strong>${esc(workspaceFileDate(plugin.install?.installedAt))}</strong></div>
        <div><span>最近更新</span><strong>${esc(workspaceFileDate(plugin.install?.updatedAt))}</strong></div>
        <div><span>校验和</span><span class="mono">${esc(plugin.install?.checksum || plugin.checksum || '—')}</span></div>
      </div>
      <div class="plugin-inject-row"><span>工具</span><div>${toolHtml}</div></div>
    </section>
    <section class="plugin-block">
      <h3>运行状态</h3>
      <div class="plugin-kv">
        <div><span>启用状态</span><strong>${esc(myPluginStatus(plugin).label)}</strong></div>
        <div><span>对话模型</span><strong>${tools.length ? `${tools.length} 个工具已注册` : '没有工具，只提供页面'}</strong></div>
        <div><span>DSH 宿主</span><strong>${plugin.format === 'dsh' ? (plugin.host?.loaded ? '已运行' : plugin.host?.error || '未运行') : '不需要'}</strong></div>
      </div>
      <div class="plugin-note">停用或卸载个人安装后，这个插件由个人安装贡献的工具会从你的工具列表移除；如果公司也安装并启用了同一插件，公司那份仍可能对全员可用。</div>
    </section>
  </div>`
}

function myPluginPagesBody(data, plugin) {
  const pages = plugin.pages || []
  if (!plugin.valid) {
    return `<div class="plugin-page-blocked"><strong>插件清单无效</strong><span>${esc(plugin.error || '无法读取插件页面')}</span></div>`
  }
  if (!plugin.enabled) {
    return `<div class="plugin-page-blocked">
      <div><strong>插件已停用</strong><span>启用后才能在个人工作台里打开页面。</span></div>
      <button class="btn primary sm" type="button" data-my-plugin-toggle data-next-enabled="1">启用插件</button>
    </div>`
  }
  if (!pages.length) {
    return `<div class="plugin-note">这个插件没有声明页面，只提供工具或后台能力。</div>`
  }
  const active = pages.find((page) => page.file === state.pluginPageKey) || pages[0]
  const url = myPluginPageUrl(data, plugin, active)
  const switcher =
    pages.length > 1
      ? `<div class="plugin-page-switch">${pages
          .map(
            (page) =>
              `<button class="plugin-page-tab ${page === active ? 'is-active' : ''}" type="button" data-my-plugin-page="${esc(page.file)}">${esc(page.title || page.id)}</button>`,
          )
          .join('')}</div>`
      : ''
  return `${switcher}<div class="ws-plugin-frame"><iframe title="${esc(active.title || plugin.name)}" sandbox="allow-same-origin allow-scripts allow-forms" src="${esc(url)}"></iframe></div>`
}

function myPluginToolsBody(plugin) {
  const tools = plugin.tools || []
  if (!plugin.enabled) {
    return `<div class="plugin-page-blocked">
      <div><strong>插件已停用</strong><span>启用后，插件注册的工具才会出现在对话模型的工具列表里。</span></div>
      <button class="btn primary sm" type="button" data-my-plugin-toggle data-next-enabled="1">启用插件</button>
    </div>`
  }
  if (!tools.length) {
    return `<div class="plugin-note">这个插件没有注册工具；它的能力可能在页面里，或者只提供宿主通道。</div>`
  }
  return `<div class="plugin-note">这些工具已经注册给对话模型，由个人安装提供。停用或卸载个人安装后会从你的个人工具集移除；公司级安装的同一插件不受影响。</div>
    <div class="ws-tool-list">
      ${tools
        .map((tool) => {
          const properties = tool.input?.properties && typeof tool.input.properties === 'object' ? tool.input.properties : {}
          const required = Array.isArray(tool.input?.required) ? tool.input.required : []
          const params = Object.keys(properties)
            .map((name) => `<span class="chip">${esc(name)}${required.includes(name) ? ' · 必填' : ''}</span>`)
            .join('')
          return `<article class="ws-tool-row">
            <div class="ws-tool-main">
              <div class="ws-tool-head"><code>${esc(tool.name)}</code><span class="pill ${tool.available ? 'ok' : 'warn'}">${tool.available ? '已注册给模型' : '当前账号无调用权限'}</span></div>
              <p>${esc(tool.description || '没有描述')}</p>
              <div class="ws-tool-params">${params || '<span class="muted">无参数</span>'}</div>
            </div>
            <span class="ws-tool-id mono">${esc(tool.id)}</span>
          </article>`
        })
        .join('')}
    </div>`
}

function myPluginVersionsBody(plugin) {
  const install = plugin.install || {}
  return `<div class="plugin-version-current">
      <div><span class="plugin-version-label">当前版本</span><strong>v${esc(plugin.version || '—')}</strong></div>
      ${myPluginStatusPill(plugin)}
    </div>
    <section class="plugin-block">
      <h3>安装记录</h3>
      <div class="plugin-kv">
        <div><span>安装范围</span><strong>个人安装</strong></div>
        <div><span>安装方式</span><strong>${esc(myPluginSourceLabel(plugin))}</strong></div>
        <div><span>首次安装</span><strong>${esc(workspaceFileDate(install.installedAt))}</strong></div>
        <div><span>最近更新</span><strong>${esc(workspaceFileDate(install.updatedAt))}</strong></div>
        <div><span>校验和</span><span class="mono">${esc(install.checksum || plugin.checksum || '—')}</span></div>
        <div><span>生命周期</span><strong>${esc(plugin.lifecycle || (plugin.enabled ? 'enabled' : 'disabled'))}</strong></div>
      </div>
      <div class="plugin-note">个人卸载只会解除你自己的安装，不会删除插件文件，也不影响公司和同事。</div>
    </section>`
}

function myPluginSettingsBody(plugin) {
  const host = plugin.host
  const hostBlock =
    plugin.format === 'dsh'
      ? `<div class="plugin-host-detail">
          <div class="plugin-setting-row" style="margin:0 0 10px;padding:0;border:0;background:transparent">
            <div><strong>DSH 宿主</strong><span>${host?.loaded ? '已运行，插件页面可以通过宿主通道读写数据。' : esc(host?.error || '尚未加载；启用后宿会自动重扫。')}</span></div>
            <span class="pill ${host?.loaded ? 'ok' : 'warn'}">${host?.loaded ? '运行中' : '未运行'}</span>
          </div>
          <div class="plugin-host-routes">${(host?.routes || []).length ? host.routes.map((route) => `<span class="chip">${esc(route)}</span>`).join('') : '<span class="muted">没有注册通道</span>'}</div>
          <button class="btn ghost sm" type="button" data-my-plugin-host-refresh>刷新宿主状态</button>
        </div>`
      : `<div class="plugin-note">这是静态页面插件，不需要 DSH 宿主。</div>`
  return `<div class="plugin-setting-row">
      <div><strong>个人启用</strong><span>只影响你自己；停用后个人安装的页面入口和工具会收起，公司安装的同一插件不受影响。</span></div>
      <button class="btn ${plugin.enabled ? 'ghost' : 'primary'} sm" type="button" data-my-plugin-toggle data-next-enabled="${plugin.enabled ? '0' : '1'}">${plugin.enabled ? '停用' : '启用'}</button>
    </div>
    ${hostBlock}
    <div class="plugin-danger-zone">
      <div><strong>卸载个人插件</strong><span>只解除你自己的安装。公司级安装和别人的工作台不受影响。</span></div>
      <button class="btn ghost sm danger-text" type="button" data-my-plugin-uninstall>卸载…</button>
    </div>`
}

function myPluginDetailHtml(data, plugin) {
  const status = myPluginStatus(plugin)
  const formatBadge = `<span class="plugin-format-badge ${plugin.format === 'dsh' ? 'dsh' : ''}">${plugin.format === 'dsh' ? 'DSH' : 'EAB'}</span>`
  const tab = state.pluginTab || 'overview'
  const tabs = [
    ['overview', '概览', ''],
    ['pages', '页面', (plugin.pages || []).length],
    ['tools', '工具', (plugin.tools || []).length],
    ['versions', '版本', ''],
    ['settings', '设置', ''],
  ]
  const tabHtml = tabs
    .map(
      ([key, label, count]) =>
        `<button class="plugin-tab ${tab === key ? 'is-active' : ''}" type="button" data-my-plugin-tab="${key}" role="tab" aria-selected="${tab === key}">${label}${count !== '' ? `<span class="plugin-tab-count">${count}</span>` : ''}</button>`,
    )
    .join('')
  const body =
    tab === 'pages'
      ? myPluginPagesBody(data, plugin)
      : tab === 'tools'
        ? myPluginToolsBody(plugin)
        : tab === 'versions'
          ? myPluginVersionsBody(plugin)
          : tab === 'settings'
            ? myPluginSettingsBody(plugin)
            : myPluginOverviewBody(data, plugin)
  const pageAction = (plugin.pages || []).length
    ? `<button class="btn ghost sm" type="button" data-my-plugin-page-first ${plugin.enabled ? '' : 'disabled title="先启用插件"'}>打开页面</button>`
    : ''
  return `<section class="panel plugin-detail">
    <div class="plugin-detail-head">
      <div class="plugin-title">
        <span class="plugin-avatar">${esc((plugin.name || plugin.id).slice(0, 1).toUpperCase())}</span>
        <div class="plugin-title-text">
          <div class="plugin-title-row"><h2>${esc(plugin.name || plugin.id)}</h2>${formatBadge}${myPluginStatusPill(plugin)}</div>
          <div class="plugin-subline"><span>v${esc(plugin.version || '—')}</span><span>${esc(plugin.author || '未知作者')}</span><span>个人安装</span></div>
        </div>
      </div>
      <div class="plugin-detail-actions">
        ${pageAction}
        <button class="btn ghost sm" type="button" data-my-plugin-toggle data-next-enabled="${plugin.enabled ? '0' : '1'}">${plugin.enabled ? '停用' : '启用'}</button>
        <button class="btn ghost sm danger-text" type="button" data-my-plugin-uninstall>卸载…</button>
      </div>
    </div>
    <div class="plugin-tabs" role="tablist">${tabHtml}</div>
    <div id="plugin-tab-body">${body}</div>
  </section>`
}

function myPluginWelcomeHtml(data) {
  const plugins = data.plugins || []
  const stats = data.stats || { installed: plugins.length, enabled: 0, tools: 0 }
  const empty = plugins.length === 0
  return `<div class="plugin-welcome">
    <div class="plugin-welcome-mark">P</div>
    <h2>${empty ? '还没有个人插件' : '从左侧选择一个插件'}</h2>
    <p>${empty ? '这里只显示你自己安装的插件。公司安装的插件不会混进来；安装后可以启停、卸载和打开插件页面。' : '左侧列出的是你本人安装的插件，点一个就能查看详情、启停、卸载和打开页面。'}</p>
    <div class="plugin-welcome-stats">
      <div><strong>${stats.installed}</strong><span>已安装</span></div>
      <div><strong>${stats.enabled}</strong><span>已启用</span></div>
      <div><strong>${stats.tools}</strong><span>可用工具</span></div>
    </div>
    <div class="plugin-welcome-actions">
      <button class="btn primary" type="button" data-my-plugin-install>安装个人插件</button>
      <button class="btn ghost" type="button" data-my-plugin-refresh>刷新</button>
    </div>
  </div>`
}

function renderMyPluginWorkspace() {
  const rail = $('#my-plugin-rail')
  const detail = $('#my-plugin-detail')
  if (!rail || !detail) return
  const data = state.pluginData || { plugins: state.plugins, stats: null }
  rail.innerHTML = myPluginRailHtml(data)
  const plugin = (data.plugins || []).find((item) => item.id === state.pluginSelected)
  detail.innerHTML = plugin ? myPluginDetailHtml(data, plugin) : myPluginWelcomeHtml(data)
  bindMyPluginWorkspace()
}

function openMyPluginUninstall(plugin) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `<div class="modal plugin-install-modal">
    <div class="modal-head">
      <div><h3>卸载「${esc(plugin.name || plugin.id)}」</h3><span class="muted">只解除你自己的个人安装</span></div>
      <button class="modal-x" type="button">×</button>
    </div>
    <div class="plugin-danger-zone" style="margin-top:4px">
      <div><strong>确认从个人工作台卸载？</strong><span>插件文件不会被删除，公司级安装和别人的工作台不受影响；之后可以重新安装。</span></div>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" type="button" data-my-uninstall-cancel>取消</button>
      <button class="btn danger" type="button" data-my-uninstall-confirm>卸载</button>
    </div>
  </div>`
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('[data-my-uninstall-cancel]') || event.target.closest('.modal-x')) close()
  })
  overlay.querySelector('[data-my-uninstall-confirm]').addEventListener('click', async (event) => {
    const button = event.currentTarget
    button.disabled = true
    try {
      await api(`/api/my/plugins/${encodeURIComponent(plugin.id)}/uninstall${qs()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      close()
      await loadMyPlugins()
      banner('已卸载个人插件', 'ok')
    } catch (err) {
      button.disabled = false
      banner(`卸载失败：${err.message}`, 'bad')
    }
  })
}

function bindMyPluginWorkspace() {
  for (const button of document.querySelectorAll('[data-my-plugin-select]')) {
    button.onclick = () => {
      state.pluginSelected = button.dataset.myPluginSelect
      state.pluginTab = 'overview'
      state.pluginPageKey = null
      renderMyPluginWorkspace()
    }
  }
  for (const button of document.querySelectorAll('[data-my-plugin-tab]')) {
    button.onclick = () => {
      state.pluginTab = button.dataset.myPluginTab
      if (state.pluginTab === 'pages' && !state.pluginPageKey) {
        const plugin = state.plugins.find((item) => item.id === state.pluginSelected)
        state.pluginPageKey = plugin?.pages?.[0]?.file ?? null
      }
      renderMyPluginWorkspace()
    }
  }
  for (const button of document.querySelectorAll('[data-my-plugin-page]')) {
    button.onclick = () => {
      state.pluginTab = 'pages'
      state.pluginPageKey = button.dataset.myPluginPage
      renderMyPluginWorkspace()
    }
  }
  for (const button of document.querySelectorAll('[data-my-plugin-page-first]')) {
    button.onclick = () => {
      const plugin = state.plugins.find((item) => item.id === state.pluginSelected)
      state.pluginTab = 'pages'
      state.pluginPageKey = plugin?.pages?.[0]?.file ?? null
      renderMyPluginWorkspace()
    }
  }
  for (const button of document.querySelectorAll('[data-my-plugin-toggle]')) {
    button.onclick = async () => {
      const enabled = button.dataset.nextEnabled === '1'
      button.disabled = true
      try {
        await api(`/api/my/plugins/${encodeURIComponent(state.pluginSelected)}/state${qs()}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        })
        await loadMyPlugins()
        banner(enabled ? '已启用个人插件' : '已停用个人插件', 'ok')
      } catch (err) {
        button.disabled = false
        banner(`启停失败：${err.message}`, 'bad')
      }
    }
  }
  for (const button of document.querySelectorAll('[data-my-plugin-host-refresh]')) {
    button.onclick = async () => {
      button.disabled = true
      try {
        const data = await api(`/api/my/plugins/${encodeURIComponent(state.pluginSelected)}/host${qs()}`)
        const plugin = state.plugins.find((item) => item.id === state.pluginSelected)
        if (plugin) plugin.host = data.status
        renderMyPluginWorkspace()
      } catch (err) {
        button.disabled = false
        banner(`刷新宿主状态失败：${err.message}`, 'bad')
      }
    }
  }
  for (const button of document.querySelectorAll('[data-my-plugin-install]')) {
    button.onclick = showPluginInstall
  }
  for (const button of document.querySelectorAll('[data-my-plugin-refresh]')) {
    button.onclick = () => loadMyPlugins()
  }
  for (const button of document.querySelectorAll('[data-my-plugin-uninstall]')) {
    button.onclick = () => {
      const plugin = state.plugins.find((item) => item.id === state.pluginSelected)
      if (plugin) openMyPluginUninstall(plugin)
    }
  }
}

function ensureHintTip() {
  let tip = document.getElementById('hint-tip')
  if (tip) return tip
  tip = document.createElement('div')
  tip.className = 'hint-tip'
  tip.id = 'hint-tip'
  tip.setAttribute('role', 'tooltip')
  document.body.appendChild(tip)
  return tip
}

function bindHintTips(root) {
  const targets = Array.from(root.querySelectorAll('[data-tip]'))
  if (!targets.length) return () => {}
  const tip = ensureHintTip()
  let current = null
  const hide = () => {
    if (current) current.removeAttribute('aria-describedby')
    current = null
    tip.classList.remove('is-visible')
  }
  const show = (target) => {
    const text = target.dataset.tip
    if (!text) return
    if (current && current !== target) current.removeAttribute('aria-describedby')
    current = target
    target.setAttribute('aria-describedby', 'hint-tip')
    tip.textContent = text
    tip.style.left = '0px'
    tip.style.top = '0px'
    tip.classList.add('is-visible')
    const rect = target.getBoundingClientRect()
    const tipWidth = tip.offsetWidth
    const tipHeight = tip.offsetHeight
    let left = rect.left + rect.width / 2 - tipWidth / 2
    left = Math.max(8, Math.min(left, window.innerWidth - tipWidth - 8))
    let top = rect.bottom + 8
    if (top + tipHeight > window.innerHeight - 8) top = rect.top - tipHeight - 8
    tip.style.left = `${Math.round(left)}px`
    tip.style.top = `${Math.max(8, Math.round(top))}px`
  }
  for (const target of targets) {
    target.addEventListener('pointerenter', () => show(target))
    target.addEventListener('pointerleave', hide)
    target.addEventListener('focus', () => show(target))
    target.addEventListener('blur', hide)
  }
  return () => {
    hide()
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`))
    reader.readAsDataURL(file)
  })
}

async function readPluginFolderFiles(files) {
  const out = []
  for (const file of files) {
    const rel = String(file.webkitRelativePath || file.name).replace(/\\/g, '/')
    const parts = rel.split('/').filter(Boolean)
    const path = parts.length > 1 ? parts.slice(1).join('/') : rel
    const dataUrl = await readFileAsDataUrl(file)
    const comma = dataUrl.indexOf(',')
    if (comma < 0) throw new Error(`读取文件失败：${file.name}`)
    out.push({ path, data: dataUrl.slice(comma + 1) })
  }
  return out
}

function showPluginInstall() {
  const installedCount = state.plugins?.length || 0
  const who = state.me?.person?.name || '你'
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `<div class="modal plugin-install-modal personal-install-modal">
    <div class="modal-head install-modal-head">
      <div>
        <span class="install-eyebrow">PERSONAL PLUGIN</span>
        <div class="personal-install-title"><h3>安装个人插件</h3><span class="install-tab-badge hint-badge" data-tip="个人安装只记在你名下：同事看不到、不会被公司启用；卸载也只移除你这一份。" tabindex="0" aria-label="个人安装说明">仅自己可见</span></div>
        <p class="install-sub">装到「${esc(who)}」的个人工作台 · 已装 ${installedCount} 个</p>
      </div>
      <button class="modal-x" type="button" aria-label="关闭">×</button>
    </div>
    <div class="install-source-tabs" role="tablist" aria-label="安装来源">
      <button class="install-source-tab" type="button" data-install-source="browser-dir">
        <span class="install-source-icon"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1.8 4.3a1.3 1.3 0 0 1 1.3-1.3h3.1l1.4 1.5h4.3a1.3 1.3 0 0 1 1.3 1.3v6.1a1.3 1.3 0 0 1-1.3 1.3H3.1a1.3 1.3 0 0 1-1.3-1.3V4.3Z" stroke="currentColor" stroke-width="1.1"/><path d="M2 6.2h12" stroke="currentColor" stroke-width="1.1"/></svg></span>
        <span><strong>本机文件夹 <em class="install-tab-badge">推荐</em></strong><small>浏览器上传</small></span>
      </button>
      <button class="install-source-tab" type="button" data-install-source="npm">
        <span class="install-source-icon"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2.2 4.2 8 1.8l5.8 2.4v7.6L8 14.2l-5.8-3V4.2Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M2.6 4.4 8 6.8l5.4-2.4M8 6.8v7" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg></span>
        <span><strong>npm 包 <em class="install-tab-badge">联网</em></strong><small>包名直装</small></span>
      </button>
      <button class="install-source-tab" type="button" data-install-source="github">
        <span class="install-source-icon"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="4.4" cy="3.4" r="1.7" stroke="currentColor" stroke-width="1.1"/><circle cx="11.6" cy="3.4" r="1.7" stroke="currentColor" stroke-width="1.1"/><circle cx="8" cy="12.8" r="1.7" stroke="currentColor" stroke-width="1.1"/><path d="M4.4 5.1v2.4c0 1.3 1.1 2.4 2.4 2.4h2.4c1.3 0 2.4-1.1 2.4-2.4V5.1" stroke="currentColor" stroke-width="1.1"/><path d="M8 9.9v1.2" stroke="currentColor" stroke-width="1.1"/></svg></span>
        <span><strong>GitHub <em class="install-tab-badge">联网</em></strong><small>公开仓库直装</small></span>
      </button>
    </div>
    <div class="install-panel" data-install-panel="browser-dir">
      <div class="install-section-head">
        <div class="install-section-title"><strong>从我的电脑选择插件文件夹</strong><span class="hint-badge icon-only" data-tip="选择包含 plugin.json 的文件夹。支持 EAB 插件（plugin.json）和 DSH 插件（package.json 带 dsh 段）；浏览器只把文件夹里的文件副本上传给服务端，安装结束即删除临时目录。" tabindex="0" aria-label="插件文件夹说明"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.1"/><path d="M8 7.4v3.4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".8" fill="currentColor"/></svg></span></div>
        <span class="pi-local-pill">浏览器上传</span>
      </div>
      <div class="pi-path-row">
        <input id="pi-folder-input" type="file" webkitdirectory directory multiple hidden />
        <button class="btn ghost pi-browse" type="button" id="pi-pick-folder">选择插件文件夹…</button>
      </div>
      <div class="pi-path-status" id="pi-path-status" hidden></div>
    </div>
    <div class="install-panel" data-install-panel="npm">
      <div class="install-grid">
        <label class="install-field install-span-2"><span class="install-field-label">npm 包名 <span class="hint-badge icon-only" data-tip="只取包内容，不执行 npm install、prepare 或任何生命周期脚本。默认安装 latest 版本。" tabindex="0" aria-label="npm 安装说明"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.1"/><path d="M8 7.4v3.4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".8" fill="currentColor"/></svg></span></span>
          <input id="pi-npm-name" class="mono" placeholder="eab-plugin-oncall 或 @scope/eab-plugin-x" />
        </label>
      </div>
    </div>
    <div class="install-panel" data-install-panel="github">
      <div class="install-grid">
        <label class="install-field install-span-2"><span class="install-field-label">GitHub 仓库 <span class="hint-badge icon-only" data-tip="公开仓库可直接装；私有仓库暂不支持匿名下载。默认分支和仓库根目录会自动识别。" tabindex="0" aria-label="GitHub 安装说明"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.1"/><path d="M8 7.4v3.4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".8" fill="currentColor"/></svg></span></span>
          <input id="pi-github-repo" class="mono" placeholder="owner/repo，例如 your-name/eab-plugin-oncall" />
        </label>
      </div>
    </div>
    <div class="install-meta-row">
      <label class="install-overwrite-inline">
        <input type="checkbox" id="pi-overwrite" />
        <span>覆盖同名插件 <em class="install-tab-badge warn hint-badge" data-tip="会替换插件库里的同名目录；已有配置不保证保留。" tabindex="0" aria-label="覆盖风险说明">谨慎</em></span>
      </label>
      <span class="install-tab-badge hint-badge" id="pi-note" data-tip="本机文件夹：浏览器选中你电脑上的插件文件夹，把文件副本上传给服务端校验后安装；适合自己开发和离线安装。" tabindex="0" aria-label="安装来源说明">来源说明</span>
      <span class="install-tab-badge hint-badge" data-tip="① 读取插件目录 → ② 校验清单 → ③ 写入插件库 → ④ 出现在个人工作台" tabindex="0" aria-label="安装流程说明">安装流程</span>
      <span class="install-tab-badge hint-badge" data-tip="安装后可在个人工作台启停或卸载。" tabindex="0" aria-label="安装归属说明">只装到你名下</span>
    </div>
    <div class="modal-state" id="pi-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="pi-submit">安装插件</button>
      <button class="btn ghost" type="button" id="pi-cancel">取消</button>
    </div>
  </div>`
  document.body.appendChild(overlay)
  const disposeHintTips = bindHintTips(overlay)
  const close = () => {
    disposeHintTips()
    overlay.remove()
  }
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#pi-cancel').addEventListener('click', close)

  const tabs = Array.from(overlay.querySelectorAll('[data-install-source]'))
  const panels = Array.from(overlay.querySelectorAll('[data-install-panel]'))
  const noteEl = overlay.querySelector('#pi-note')
  const stateEl = overlay.querySelector('#pi-state')
  const folderInput = overlay.querySelector('#pi-folder-input')
  const pickFolder = overlay.querySelector('#pi-pick-folder')
  const pathStatus = overlay.querySelector('#pi-path-status')
  let selectedFolderFiles = []
  let selectedFolderName = ''
  let source = 'browser-dir'

  const sourceNotes = {
    'browser-dir': '本机文件夹：浏览器选中你电脑上的插件文件夹，把文件副本上传给服务端校验后安装；适合自己开发和离线安装。',
    npm: 'npm / 镜像：从 registry 拉 tarball 后校验；不执行 npm install、prepare 或任何生命周期脚本。',
    github: 'GitHub：下载仓库 tarball 后校验；仓库里必须有 plugin.json，构建产物需随仓库提交。',
  }

  const syncFolderStatus = () => {
    if (selectedFolderFiles.length === 0) {
      pathStatus.hidden = true
      pathStatus.innerHTML = ''
      return
    }
    const total = selectedFolderFiles.reduce((sum, file) => sum + (file.size || 0), 0)
    pathStatus.hidden = false
    pathStatus.innerHTML = `<span class="pi-path-status-icon"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1.8 4.3a1.3 1.3 0 0 1 1.3-1.3h3.1l1.4 1.5h4.3a1.3 1.3 0 0 1 1.3 1.3v6.1a1.3 1.3 0 0 1-1.3 1.3H3.1a1.3 1.3 0 0 1-1.3-1.3V4.3Z" stroke="currentColor" stroke-width="1.1"/></svg></span>
      <span class="pi-path-status-copy"><strong>${esc(selectedFolderName)}</strong><small>${selectedFolderFiles.length} 个文件 · ${esc(fmtSize(total))}</small></span>
      <span class="pill ok">已选择</span>`
  }

  const syncSource = (next) => {
    source = next
    for (const tab of tabs) {
      const active = tab.dataset.installSource === next
      tab.classList.toggle('is-active', active)
      tab.setAttribute('aria-selected', active ? 'true' : 'false')
    }
    for (const panel of panels) panel.classList.toggle('is-hidden', panel.dataset.installPanel !== next)
    noteEl.dataset.tip = sourceNotes[next] || ''
    noteEl.setAttribute('aria-label', sourceNotes[next] || '安装来源说明')
    stateEl.className = 'modal-state'
    stateEl.textContent = ''
  }
  for (const tab of tabs) tab.addEventListener('click', () => syncSource(tab.dataset.installSource))
  pickFolder.addEventListener('click', () => {
    folderInput.value = ''
    folderInput.click()
  })
  folderInput.addEventListener('change', () => {
    selectedFolderFiles = Array.from(folderInput.files || [])
    const firstPath = String(selectedFolderFiles[0]?.webkitRelativePath || '')
    selectedFolderName = firstPath.split('/').filter(Boolean)[0] || '插件文件夹'
    syncFolderStatus()
    if (selectedFolderFiles.length > 0) {
      stateEl.className = 'modal-state ok'
      stateEl.textContent = `已选择「${selectedFolderName}」，点「安装插件」上传并安装`
    }
  })
  syncSource(source)

  const submit = overlay.querySelector('#pi-submit')
  submit.addEventListener('click', async () => {
    const body = {
      source,
      overwrite: overlay.querySelector('#pi-overwrite').checked,
    }
    if (source === 'browser-dir') {
      if (selectedFolderFiles.length === 0) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '请选择一个插件文件夹（含 plugin.json 或 DSH 的 package.json）'
        return
      }
      stateEl.className = 'modal-state muted'
      stateEl.textContent = '正在读取文件夹并上传…'
      body.files = await readPluginFolderFiles(selectedFolderFiles)
      body.folderName = selectedFolderName
    }
    if (source === 'npm') {
      body.packageName = overlay.querySelector('#pi-npm-name').value.trim()
      if (!body.packageName) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '请填 npm 包名'
        return
      }
    }
    if (source === 'github') {
      body.repo = overlay.querySelector('#pi-github-repo').value.trim()
      if (!body.repo) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '请填 GitHub 仓库（owner/repo）'
        return
      }
    }
    stateEl.className = 'modal-state muted'
    stateEl.textContent = '正在读取并校验插件…'
    submit.disabled = true
    submit.textContent = '安装中…'
    try {
      await api('/api/my/plugins/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      close()
      await loadMyPlugins()
      banner('个人插件已安装，入口已出现在工作台', 'ok')
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = `${err.message}${err.code ? `（${err.code}）` : ''}`
      submit.disabled = false
      submit.textContent = '安装插件'
    }
  })
}

function autoName() {
  return state.models.find((m) => m.id === state.autoModelId)?.name ?? ''
}

const CHAT_MODEL_TAG_LABELS = {
  chat: '对话',
  reasoning: '推理',
  decision: '决策',
  vision: '图片识别',
  multimodal: '多模态',
  code: '代码',
  tool: '工具调用',
  embedding: '向量',
  audio: '语音',
  video: '视频',
  long_context: '长文本',
  fast: '快速',
}

function modelTagsLabel(tags = []) {
  return (tags || []).map((tag) => CHAT_MODEL_TAG_LABELS[String(tag || '').toLowerCase()] || tag).join(' / ')
}

function modelLabel(modelId) {
  if (!modelId) return autoName() ? `自动（${autoName()}）` : '自动'
  return state.models.find((m) => m.id === modelId)?.name ?? modelId
}

function setSelected(modelId, options = {}) {
  const visible = modelId ? state.models.find((m) => m.id === modelId) : null
  state.selected = visible ? visible.id : ''
  $('#model-chip-label').textContent = modelLabel(state.selected)
  $('#model-menu').hidden = true
  $('#model-chip').setAttribute('aria-expanded', 'false')
  renderModelMenus()
  renderAttachments()
  if (options.persist !== false && state.sessionId) persistSessionModel(state.selected)
}

async function persistSessionModel(modelId) {
  try {
    await api(`/api/chat/sessions/${encodeURIComponent(state.sessionId)}/model${qs()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId: modelId || null }),
    })
  } catch (err) {
    banner(`模型已切换，但当前会话没有保存：${err.message || '保存失败'}`, 'warn')
  }
}

function renderSideModels() {
  const list = $('#side-models')
  const rows = []
  if (state.autoModelId) {
    rows.push(
      `<button class="side-model ${state.selected === '' ? 'is-active' : ''}" type="button" data-model="">
        <strong>自动选择</strong>
        <span>按你的权限挑一个最合适的${autoName() ? `（现在会选 ${esc(autoName())}）` : ''}</span>
      </button>`,
    )
  }
  for (const model of state.models) {
    rows.push(
      `<button class="side-model ${state.selected === model.id ? 'is-active' : ''}" type="button" data-model="${esc(model.id)}">
        <strong>${esc(model.name)}</strong>
        <span>${esc(model.desc || '')}${model.tags && model.tags.length ? ` · ${esc(modelTagsLabel(model.tags))}` : ''}</span>
      </button>`,
    )
  }
  list.innerHTML = rows.join('')
  for (const button of list.querySelectorAll('[data-model]')) {
    button.addEventListener('click', () => setSelected(button.dataset.model))
  }
}

function renderModelMenu() {
  const menu = $('#model-menu')
  const options = []
  if (state.autoModelId) {
    options.push(
      `<button class="model-option ${state.selected === '' ? 'is-active' : ''}" type="button" data-model="">
        <strong>自动选择</strong>
        <span>${autoName() ? `让系统按你的权限挑，现在会选 ${esc(autoName())}` : '让系统按你的权限挑'}</span>
      </button>`,
    )
  }
  for (const model of state.models) {
    options.push(
      `<button class="model-option ${state.selected === model.id ? 'is-active' : ''}" type="button" data-model="${esc(model.id)}">
        <strong>${esc(model.name)}</strong>
        <span>${esc(model.desc || '')}${model.supportsVision ? ' · 图片识别' : ''}</span>
      </button>`,
    )
  }
  menu.innerHTML = options.join('') || '<div class="muted" style="padding:8px;font-size:12px">没有可用模型</div>'
  for (const button of menu.querySelectorAll('[data-model]')) {
    button.addEventListener('click', () => setSelected(button.dataset.model))
  }
}

function renderModelMenus() {
  renderSideModels()
  renderModelMenu()
}

/* ---------------- 对话内模型切换 ---------------- */

function compactModelText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\u3000·_.\-/／（）()]+/g, '')
}

function modelMatches(query) {
  const q = compactModelText(query).replace(/模型$/g, '')
  if (!q) return []
  const exact = state.models.filter((model) => compactModelText(model.name) === q || compactModelText(model.id) === q)
  if (exact.length > 0) return exact
  return state.models.filter((model) => {
    const name = compactModelText(model.name)
    const id = compactModelText(model.id)
    return name.includes(q) || id.includes(q) || (name.length >= 2 && q.includes(name))
  })
}

function appendModelCommandNote(text) {
  setEmptyVisible(false)
  const node = document.createElement('div')
  node.className = 'chat-command-note'
  node.textContent = text
  $('#thread').appendChild(node)
  scrollThreadToBottomInstant()
}

function appendModelCommandCard(title, models, hint = '') {
  setEmptyVisible(false)
  const node = document.createElement('div')
  node.className = 'chat-command-card'
  const autoRow = state.autoModelId
    ? `<button class="chat-command-option ${state.selected === '' ? 'is-active' : ''}" type="button" data-model="">
        <strong>自动选择${state.selected === '' ? ' · 当前' : ''}</strong>
        <span>${autoName() ? `让系统按你的权限挑，现在会选 ${esc(autoName())}` : '让系统按你的权限挑'}</span>
      </button>`
    : ''
  const rows = models.map((model) => {
    const active = state.selected === model.id
    const detail = [model.desc, model.tags && model.tags.length ? modelTagsLabel(model.tags) : '', model.supportsVision ? '图片识别' : '']
      .filter(Boolean)
      .join(' · ')
    return `<button class="chat-command-option ${active ? 'is-active' : ''}" type="button" data-model="${esc(model.id)}">
      <strong>${esc(model.name)}${active ? ' · 当前' : ''}</strong>
      <span>${esc(detail || '可用模型')}</span>
    </button>`
  })
  node.innerHTML = `<div class="chat-command-head"><strong>${esc(title)}</strong><span>${esc(hint)}</span></div>
    <div class="chat-command-list">${autoRow}${rows.join('')}</div>`
  $('#thread').appendChild(node)
  node.querySelectorAll('[data-model]').forEach((button) => {
    button.addEventListener('click', () => {
      const modelId = button.dataset.model || ''
      const model = modelId ? state.models.find((item) => item.id === modelId) : null
      if (modelId && !model) return
      setSelected(modelId)
      node.remove()
      appendModelCommandNote(modelId ? `已切换到「${model.name}」。接下来的消息会使用它。` : `已切回自动选择${autoName() ? `（现在会选「${autoName()}」）` : ''}。`)
    })
  })
  scrollThreadToBottomInstant()
}

function handleModelCommand(rawText) {
  const text = String(rawText || '').trim()
  if (!text || text.length > 160 || state.attachments.length > 0) return false
  if (/^\/(model|models|模型)$/i.test(text) || /^(切换模型|换模型)$/.test(text)) {
    appendModelCommandCard(
      `可用模型（${state.models.length}）`,
      state.models,
      '只来自当前身份有权限使用的模型，点选即可切换',
    )
    return true
  }
  if (/^\/(auto|自动)$/i.test(text)) {
    setSelected('')
    appendModelCommandNote(`已切回自动选择${autoName() ? `（现在会选「${autoName()}」）` : ''}。`)
    return true
  }

  const patterns = [
    /^\/model\s+([\s\S]+)$/i,
    /^切换到\s*([\s\S]+)$/,
    /^切换模型(?:到|为|成)?\s*([\s\S]+)$/,
    /^换成\s*([\s\S]+)$/,
    /^换用\s*([\s\S]+)$/,
    /^使用\s*([\s\S]+?)\s*模型$/,
    /^用\s*([\s\S]+?)\s*模型$/,
  ]
  let query = ''
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match) {
      query = String(match[1] || '').trim().replace(/(?:模型|吧|呢|。|！|!)$/g, '').trim()
      break
    }
  }
  if (!query) return false
  if (compactModelText(query) === '自动' || compactModelText(query) === 'auto' || compactModelText(query) === '默认') {
    setSelected('')
    appendModelCommandNote(`已切回自动选择${autoName() ? `（现在会选「${autoName()}」）` : ''}。`)
    return true
  }

  const matches = modelMatches(query)
  if (matches.length === 0) {
    appendModelCommandCard(
      `没有找到「${query}」`,
      state.models,
      '只列出当前身份有权限使用的模型，可直接点选',
    )
    return true
  }
  if (matches.length > 1) {
    appendModelCommandCard(`找到 ${matches.length} 个匹配「${query}」的模型`, matches, '点选一个切换')
    return true
  }
  setSelected(matches[0].id)
  appendModelCommandNote(`已切换到「${matches[0].name}」。接下来的消息会使用它。`)
  return true
}

/* ---------------- 空态与消息 ---------------- */

function setEmptyVisible(visible) {
  const empty = $('#chat-empty')
  if (empty) empty.hidden = !visible
}

function renderEmpty(me) {
  const org =
    me.company && me.person.deptName !== me.company.name
      ? `${me.company.name} · ${me.person.deptName}`
      : me.person.deptName
  $('#empty-title').textContent = `你好，${me.person.name}`
  $('#empty-sub').textContent = `${org} · ${state.models.length} 个模型可用。问点什么开始。`
}

function renderSuggestions() {
  const prompts = ['帮我起草一封跟进邮件', '把这份会议要点整理成待办', '公司差旅报销怎么走']
  $('#suggest').innerHTML = prompts
    .map((text) => `<button type="button" data-prompt="${esc(text)}">${esc(text)}</button>`)
    .join('')
  for (const button of $('#suggest').querySelectorAll('[data-prompt]')) {
    button.addEventListener('click', () => {
      const input = $('#input')
      input.value = button.dataset.prompt
      input.focus()
      autosize()
    })
  }
}

function attachmentChips(list) {
  return list
    .map(
      (file) =>
        `<span>${esc(file.name)} · ${esc(fmtSize(file.size))}</span>`,
    )
    .join('')
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0.1s'
  return ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`
}

function prettyPayload(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (!text) return '（空）'
  return text.length > 1600 ? `${text.slice(0, 1600)}\n…（已截断）` : text
}

function toolStatusText(trace) {
  if (trace.status === 'running') return '执行中'
  if (trace.status === 'error') return '失败'
  return `完成 · ${formatElapsed(trace.durationMs)}`
}

function toolCardHtml(trace) {
  const done = trace.status !== 'running'
  return `<div class="tool-card ${trace.status === 'error' ? 'is-error' : ''} ${done ? 'is-collapsed' : ''}" data-tool-card="${esc(trace.id)}">
    <button class="tool-head" type="button" aria-expanded="${done ? 'false' : 'true'}">
      <span class="tool-dot"></span>
      <strong>${esc(trace.name)}</strong>
      <span class="tool-status">${esc(toolStatusText(trace))}</span>
      <span class="tool-chevron">⌄</span>
    </button>
    <div class="tool-body">
      <div class="tool-row"><span>参数</span><pre>${esc(prettyPayload(trace.args))}</pre></div>
      ${
        trace.summary
          ? `<div class="tool-row"><span>${trace.status === 'error' ? '错误' : '结果'}</span><pre>${esc(prettyPayload(trace.summary))}</pre></div>`
          : ''
      }
    </div>
  </div>`
}

function thinkPanelHtml(reasoning, collapsed) {
  return `<div class="think-panel${collapsed ? ' is-collapsed' : ''}">
    <button class="think-head" type="button" aria-expanded="${collapsed ? 'false' : 'true'}">
      <span class="think-icon">✦</span>
      <span class="think-title">${collapsed ? '已深度思考' : '正在思考…'}</span>
      <span class="think-chevron">⌄</span>
    </button>
    <div class="think-body">${esc(reasoning)}</div>
  </div>`
}

function channelTag(channel) {
  if (channel === 'dingtalk') return '<span class="channel-tag">钉钉</span>'
  return ''
}

function historyAiBubble(text, meta, rich) {
  const reasoning = String(rich?.reasoning || '').trim()
  const tools = Array.isArray(rich?.toolCalls) ? rich.toolCalls : []
  const channel = channelTag(rich?.channel)
  return `${reasoning ? thinkPanelHtml(reasoning, true) : ''}
    ${tools.length > 0 ? `<div class="tool-list">${tools.map((trace) => toolCardHtml(trace)).join('')}</div>` : ''}
    <div class="answer-text">${renderAnswer(text)}</div>
    ${meta || channel ? `<span class="meta">${channel}${meta ? esc(meta) : ''}</span>` : ''}`
}

function bindToolToggles(node) {
  for (const button of node.querySelectorAll('.tool-head, .think-head')) {
    button.addEventListener('click', () => {
      const panel = button.closest('.tool-card, .think-panel')
      if (!panel) return
      const collapsed = panel.classList.toggle('is-collapsed')
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
    })
  }
}

function myDisplayName() {
  return String(state.me?.person?.name || $('#user-name')?.textContent || '我').trim() || '我'
}

function appendMessage(role, text, meta, attachments, rich, options = {}) {
  setEmptyVisible(false)
  const node = document.createElement('div')
  node.className = `msg ${role === 'me' ? 'me' : 'ai'}`
  if (options.messageId) node.dataset.messageId = String(options.messageId)
  const files = attachments && attachments.length ? `<div class="bubble-files">${attachmentChips(attachments)}</div>` : ''
  const meName = myDisplayName()
  const channel = channelTag(options.channel)
  node.innerHTML =
    role === 'me'
      ? `<div class="bubble">${esc(text)}${files}</div>
        <div class="who-me"><span class="who-name">${esc(meName)}</span>${channel}${avatarMarkup(meName, meAvatarUrl(), 'who-badge me')}</div>`
      : `${aiWhoMarkup()}<div class="bubble ai-turn">${historyAiBubble(text, meta, rich || {})}</div>`
  const thread = $('#thread')
  if (options.prepend) {
    const firstMessage = thread.querySelector('.msg')
    thread.insertBefore(node, firstMessage || null)
  } else {
    thread.appendChild(node)
  }
  bindToolToggles(node)
  if (options.scroll !== false) node.scrollIntoView({ block: 'end', behavior: 'smooth' })
  queueScrollBottomButtonUpdate()
  return node
}

/** 创建一条可实时更新的 AI 回答：思考过程 + 工具卡片 + 最终答案。 */
function createAiTurn() {
  setEmptyVisible(false)
  const node = document.createElement('div')
  node.className = 'msg ai'
  node.innerHTML = `${aiWhoMarkup()}<div class="bubble ai-turn">
    <div class="think-panel" hidden>
      <button class="think-head" type="button" aria-expanded="true">
        <span class="think-icon">✦</span><span class="think-title">正在思考…</span><span class="think-chevron">⌄</span>
      </button>
      <div class="think-body"></div>
    </div>
    <div class="tool-list" hidden></div>
    <div class="ai-status"><span class="ai-status-dot"></span><span class="ai-status-text">正在连接模型…</span></div>
    <div class="answer-text"></div>
    <span class="meta" hidden></span>
  </div>`
  $('#thread').appendChild(node)
  bindToolToggles(node)
  scrollThreadToBottomInstant()

  const think = node.querySelector('.think-panel')
  const thinkTitle = node.querySelector('.think-title')
  const thinkBody = node.querySelector('.think-body')
  const toolList = node.querySelector('.tool-list')
  const status = node.querySelector('.ai-status')
  const statusText = node.querySelector('.ai-status-text')
  const answer = node.querySelector('.answer-text')
  const metaLine = node.querySelector('.meta')
  const startedAt = Date.now()
  let firstAnswerAt = 0
  let rawAnswer = ''
  let answerRenderQueued = false
  let scrollQueued = false

  const scroll = () => {
    if (scrollQueued) return
    scrollQueued = true
    requestAnimationFrame(() => {
      scrollQueued = false
      scrollThreadToBottomInstant()
    })
  }
  const setStatus = (text) => {
    if (!text) {
      status.hidden = true
      return
    }
    status.hidden = false
    statusText.textContent = text
  }
  const collapseThink = (done) => {
    if (think.hidden) return
    think.classList.add('is-collapsed')
    think.querySelector('.think-head').setAttribute('aria-expanded', 'false')
    if (done) {
      const thinkingMs = (firstAnswerAt || Date.now()) - startedAt
      thinkTitle.textContent = `已深度思考 · ${formatElapsed(thinkingMs)}`
    }
  }
  // 流式阶段也按 Markdown 渲染；每帧最多重排一次，避免逐 token 抖动。
  const renderStreamingAnswer = () => {
    if (answerRenderQueued) return
    answerRenderQueued = true
    requestAnimationFrame(() => {
      answerRenderQueued = false
      answer.innerHTML = renderAnswer(rawAnswer)
      scroll()
    })
  }

  return {
    node,
    reasoning(text) {
      if (!text) return
      think.hidden = false
      thinkBody.textContent += text
      thinkTitle.textContent = '正在思考…'
      setStatus('正在思考…')
      thinkBody.scrollTop = thinkBody.scrollHeight
      scroll()
    },
    content(text) {
      if (!text) return
      if (!firstAnswerAt) firstAnswerAt = Date.now()
      if (!rawAnswer) setStatus('')
      collapseThink(false)
      rawAnswer += text
      renderStreamingAnswer()
    },
    tool(event) {
      if (toolList.hidden) {
        toolList.hidden = false
      }
      const trace = { id: event.id, name: event.name, toolId: event.toolId, args: event.args, status: 'running', summary: '', durationMs: 0 }
      toolList.insertAdjacentHTML('beforeend', toolCardHtml(trace))
      const card = toolList.lastElementChild
      card.querySelector('.tool-head').addEventListener('click', () => {
        const collapsed = card.classList.toggle('is-collapsed')
        card.querySelector('.tool-head').setAttribute('aria-expanded', collapsed ? 'false' : 'true')
      })
      setStatus(`正在调用「${event.name}」…`)
      scroll()
    },
    toolResult(event) {
      const card = [...toolList.querySelectorAll('.tool-card')].find((item) => item.dataset.toolCard === event.id)
      if (!card) return
      card.classList.toggle('is-error', event.status === 'error')
      card.classList.add('is-collapsed')
      const head = card.querySelector('.tool-head')
      head.setAttribute('aria-expanded', 'false')
      card.querySelector('.tool-status').textContent = event.status === 'error'
        ? `失败 · ${formatElapsed(event.durationMs)}`
        : `完成 · ${formatElapsed(event.durationMs)}`
      const body = card.querySelector('.tool-body')
      const resultRow = body.querySelector('.tool-result-row')
      const row = resultRow || document.createElement('div')
      if (!resultRow) {
        row.className = 'tool-row tool-result-row'
        row.innerHTML = `<span>${event.status === 'error' ? '错误' : '结果'}</span><pre></pre>`
        body.appendChild(row)
      }
      row.querySelector('pre').textContent = prettyPayload(event.summary)
      setStatus(event.status === 'error' ? `工具「${card.querySelector('strong')?.textContent || ''}」失败` : '')
      scroll()
    },
    finish(data) {
      setStatus('')
      collapseThink(true)
      const finalText = String(data?.text || '').trim()
      if (finalText) rawAnswer = finalText
      if (rawAnswer) answer.innerHTML = renderAnswer(rawAnswer)
      else if (!answer.textContent) answer.textContent = '（没有返回内容）'
      const citations = data.citations && data.citations.length ? ` · 引用 ${data.citations.length} 条` : ''
      const thinking = think.hidden ? '' : ` · 思考 ${formatElapsed((firstAnswerAt || Date.now()) - startedAt)}`
      metaLine.hidden = false
      metaLine.innerHTML = `${channelTag(data.channel)}${esc(`${data.modelName || ''}${data.autoSelected ? ' · 自动选择' : ''}${thinking}${citations}`)}`
      // 固定模型的会话发生故障转移时，后端已写回接替模型；气泡同步为实际接替模型。
      if (!data.autoSelected && data.fallbackFromModelId && data.modelId) {
        setSelected(data.modelId, { persist: false })
      }
      scroll()
    },
    fail(message, meta) {
      setStatus('')
      collapseThink(true)
      if (!answer.textContent) answer.textContent = message || '回答失败'
      answer.classList.add('is-error')
      if (meta) {
        metaLine.hidden = false
        metaLine.textContent = meta
      }
      scroll()
    },
    stop() {
      setStatus('')
      collapseThink(true)
      if (!rawAnswer) answer.textContent = '已停止生成'
      metaLine.hidden = false
      metaLine.textContent = '已停止生成'
      scroll()
    },
  }
}

function appendTyping() {
  setEmptyVisible(false)
  const node = document.createElement('div')
  node.className = 'msg ai'
  node.innerHTML = `${aiWhoMarkup()}<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>`
  $('#thread').appendChild(node)
  node.scrollIntoView({ block: 'end', behavior: 'smooth' })
  return node
}

function renderDenied(err) {
  $('#thread').innerHTML = `<div class="chat-denied">
    <strong>${esc(err.message)}</strong>
    <span class="mono">${esc(err.code || '')}${err.traceId ? ` · traceId ${esc(err.traceId)}` : ''}</span>
    <span class="mono">换一个账号登录，或让管理员在控制台里给你的角色授这个权限。</span>
  </div>`
  $('#composer-foot').textContent = '当前账号不能对话'
  $('#model-chip').disabled = true
  $('#send').disabled = true
  const input = $('#input')
  input.disabled = true
  input.placeholder = '当前账号不能对话'
  $('#login-btn').hidden = false
  $('#login-btn').textContent = '切换账号'
}

/* ---------------- 附件 ---------------- */

const MAX_FILES = 4
const MAX_FILE_SIZE = 10 * 1024 * 1024

function renderAttachments() {
  const strip = $('#attach-strip')
  if (state.attachments.length === 0) {
    strip.hidden = true
    strip.innerHTML = ''
    updateSendState()
    return
  }
  strip.hidden = false
  const activeModel = state.models.find((m) => m.id === (state.selected || state.autoModelId))
  const visionReady = !activeModel || activeModel.supportsVision !== false
  strip.innerHTML = state.attachments
    .map((file, index) => {
      const isImage = file.type.startsWith('image/')
      const thumb = isImage
        ? `<img src="${esc(file.previewUrl || '')}" alt="" />`
        : `<span class="file-ico">${esc((file.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase())}</span>`
      const kind = file.readable === 'text'
        ? '文本可读'
        : file.readable === 'image'
          ? visionReady
            ? '图片可读'
            : '当前模型不支持图片'
          : '仅附件'
      const kindMuted = file.readable === 'none' || (file.readable === 'image' && !visionReady)
      return `<div class="attach-chip">
        ${thumb}
        <div class="attach-meta">
          <span class="attach-name" title="${esc(file.name)}">${esc(file.name)}</span>
          <span class="attach-size">${esc(fmtSize(file.size))}<span class="attach-kind ${kindMuted ? 'is-muted' : ''}">${kind}</span></span>
        </div>
        <button class="attach-remove" type="button" data-remove="${index}" aria-label="移除">×</button>
      </div>`
    })
    .join('')
  for (const button of strip.querySelectorAll('[data-remove]')) {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.remove)
      const removed = state.attachments[index]
      if (removed && removed.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      state.attachments.splice(index, 1)
      renderAttachments()
    })
  }
  updateSendState()
}

async function readClipboardImage() {
  if (!navigator.clipboard?.read) return null
  const items = await navigator.clipboard.read()
  for (const item of items) {
    const type = item.types.find((entry) => entry.startsWith('image/'))
    if (!type) continue
    const blob = await item.getType(type)
    if (!blob.size) continue
    const ext = type === 'image/jpeg' ? 'jpg' : type.split('/')[1] || 'png'
    return new File([blob], `粘贴图片-${Date.now()}.${ext}`, { type })
  }
  return null
}

async function addFiles(fileList) {
  const incoming = [...fileList]
  for (const raw of incoming) {
    if (state.attachments.length >= MAX_FILES) break
    let file = raw
    // 部分浏览器把剪贴板截图给成 0 字节 File；此时退回读剪贴板原图
    if (file.size === 0 && (file.type || '').startsWith('image/')) {
      try {
        file = (await readClipboardImage()) || file
      } catch {
        // 用户拒绝授权时继续走下面的提示
      }
    }
    if (file.size === 0 && (file.type || '').startsWith('image/')) {
      alert('没读到剪贴板图片：请在浏览器弹窗里允许读取剪贴板，或直接点「上传图片」。')
      continue
    }
    if (file.size > MAX_FILE_SIZE) {
      alert(`「${safeFileName(file)}」超过 10MB，先不加入。`)
      continue
    }
    const name = safeFileName(file)
    const type = file.type || 'application/octet-stream'
    const entry = {
      name,
      size: file.size,
      type,
      file,
      text: '',
      readable: 'none',
      previewUrl: type.startsWith('image/') ? URL.createObjectURL(file) : '',
    }
    if (isTextLike(file)) {
      try {
        entry.text = await readTextAttachment(file)
        entry.readable = entry.text ? 'text' : 'none'
      } catch {
        entry.readable = 'none'
      }
    } else if (type.startsWith('image/')) {
      entry.readable = 'image'
    }
    state.attachments.push(entry)
  }
  renderAttachments()
}

/* ---------------- 发送 ---------------- */

function updateSendState() {
  const text = $('#input').value.trim()
  $('#send').disabled = state.models.length === 0 || (!text && state.attachments.length === 0)
}

/** 只在真的出现排队消息时提示；只有一条正在回复的消息时不占输入区。 */
function renderQueueState() {
  const bar = $('#queue-bar')
  if (!bar) return
  const queued = state.queue.length
  const stopReply = $('#stop-reply')
  if (stopReply) stopReply.hidden = !state.sending || queued > 0
  bar.hidden = queued === 0
  if (bar.hidden) return
  const text = state.sending
    ? `正在回复，后面还有 ${queued} 条排队`
    : `有 ${queued} 条消息等待发送`
  const label = $('#queue-text')
  if (label) label.textContent = text
  const stop = $('#queue-stop')
  if (stop) {
    stop.textContent = '停止当前回复并发送'
    stop.disabled = !state.sending
  }
}

/** 切换会话时丢掉尚未提交的排队消息，避免把旧会话的消息发到新会话。 */
function clearQueuedMessages() {
  if (state.queue.length === 0) return
  for (const item of state.queue) item.node?.remove()
  state.queue = []
  renderQueueState()
}

function stopCurrentReply() {
  if (!state.sending || !state.activeController) return
  state.activeController.abort()
}

function autosize() {
  const el = $('#input')
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`
}

/** 读取后端 SSE：meta / reasoning / delta / tool / tool_result / done / error。 */
async function streamChat(payload, onEvent, signal) {
  const response = await fetch(`/api/chat/messages${qs()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, stream: true }),
    signal,
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const err = new Error(body?.error?.message || body?.message || `HTTP ${response.status}`)
    err.code = body?.error?.code || body?.code
    err.traceId = body?.error?.traceId || body?.traceId
    throw err
  }
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('text/event-stream') || !response.body) {
    throw new Error('服务端没有返回流式响应')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const consume = (block) => {
    let event = 'message'
    const dataLines = []
    for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/\r$/, '')
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length === 0) return
    let data = null
    try {
      data = JSON.parse(dataLines.join('\n'))
    } catch {
      return
    }
    onEvent(event, data)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) consume(block)
  }
  buffer += decoder.decode()
  if (buffer.trim()) consume(buffer)
}

async function buildAttachmentPayload(list) {
  return Promise.all(
    list.map(async (item) => {
      const payload = { name: item.name, size: item.size, type: item.type }
      if (item.readable === 'text' && item.text) payload.text = item.text
      if (item.readable === 'image' && item.file) payload.dataUrl = await readAsDataUrl(item.file)
      return payload
    }),
  )
}

async function send() {
  const input = $('#input')
  const text = input.value.trim()
  if (!text && state.attachments.length === 0) return
  if (handleModelCommand(text)) {
    input.value = ''
    input.style.height = '44px'
    updateSendState()
    return
  }

  const modelId = state.selected || null
  const pending = state.attachments.slice()
  const attachmentMeta = pending.map((file) => ({
    name: file.name,
    size: file.size,
    type: file.type,
  }))

  const item = {
    text,
    modelId,
    pending,
    attachmentMeta,
    sessionId: state.sessionId,
    node: null,
  }

  // 打断模式：新消息优先。丢掉尚未发送的旧排队项，并中止当前回复；
  // 当前 drainQueue 的 finally 会接着消费这条新消息。
  if (state.sending && state.chatSendMode === 'interrupt') {
    const dropped = state.queue.splice(0)
    for (const queued of dropped) {
      queued.node?.remove()
      for (const file of queued.pending) {
        if (file.previewUrl) URL.revokeObjectURL(file.previewUrl)
      }
    }
    stopCurrentReply()
  }

  state.queue.push(item)
  input.value = ''
  input.style.height = '44px'
  item.node = appendMessage('me', text, undefined, attachmentMeta)
  scrollThreadToBottomInstant()

  state.attachments = []
  renderAttachments()
  for (const file of pending) {
    if (file.previewUrl) URL.revokeObjectURL(file.previewUrl)
  }

  renderQueueState()
  void drainQueue()
}

/** 依次消费排队消息；当前回复结束后自动接上一条。 */
async function drainQueue() {
  if (state.sending) return
  const item = state.queue.shift()
  if (!item) {
    renderQueueState()
    return
  }

  state.sending = true
  const controller = new AbortController()
  state.activeController = controller
  renderQueueState()
  updateSendState()

  const turn = createAiTurn()
  const targetSessionId = item.sessionId ?? state.sessionId
  let streamError = null
  let sawDone = false

  try {
    const attachments = await buildAttachmentPayload(item.pending)
    if (controller.signal.aborted) throw new DOMException('已停止', 'AbortError')
    await streamChat(
      {
        modelId: item.modelId,
        text: item.text,
        attachments,
        sessionId: targetSessionId,
        spaceKind: state.spaceKind,
      },
      (event, data) => {
        const sameSession = targetSessionId === null ? state.sessionId === null : state.sessionId === targetSessionId
        if (event === 'meta') {
          if (sameSession) {
            state.sessionId = data.sessionId || state.sessionId
            persistChatLocation()
            if (data.sessionId) {
              for (const queued of state.queue) {
                if (!queued.sessionId) queued.sessionId = data.sessionId
              }
            }
          }
          if (data.sessionId && $('#chat-title').textContent === '新对话') {
            $('#chat-title').textContent = (item.text || attachments[0]?.name || '新对话').slice(0, 24)
          }
        } else if (event === 'reasoning') {
          turn.reasoning(data.text)
        } else if (event === 'delta') {
          turn.content(data.text)
        } else if (event === 'tool') {
          turn.tool(data)
        } else if (event === 'tool_result') {
          turn.toolResult(data)
        } else if (event === 'done') {
          sawDone = true
          if (sameSession) {
            state.sessionId = data.sessionId || state.sessionId
            persistChatLocation()
          }
          turn.finish(data)
          loadSessions()
          void loadWorkspaceFiles()
        } else if (event === 'error') {
          const err = new Error(data.message || '模型调用失败')
          err.code = data.code
          streamError = err
        }
      },
      controller.signal,
    )
    if (streamError) throw streamError
    if (!sawDone && !controller.signal.aborted) throw new Error('回答流意外中断，请重试')
  } catch (err) {
    if (controller.signal.aborted) {
      turn.stop()
    } else {
      turn.fail(`${err.message}${err.code ? `\n（${err.code}）` : ''}`, err.traceId ? `traceId ${err.traceId}` : '请求失败')
    }
  } finally {
    state.sending = false
    if (state.activeController === controller) state.activeController = null
    updateSendState()
    renderQueueState()
    if (state.queue.length > 0) {
      void drainQueue()
    } else {
      $('#input').focus()
    }
  }
}

/* ---------------- 启动 ---------------- */

/* ---------------- 设置页 ---------------- */

function renderSettingsProfile() {
  const box = $('#settings-profile')
  if (!box) return
  // 直接复用侧栏已经渲染好的身份信息，避免两处字段口径不一致
  const name = $('#user-name')?.textContent?.trim() || '—'
  const title = $('#user-title')?.textContent?.trim() || '—'
  const org = $('#user-org')?.dataset.orgText || $('#user-org')?.textContent?.trim() || '—'
  const roles = $('#user-roles')?.innerHTML || ''
  const rawId = String(state.me?.person?.id || '')
  const account = rawId.replace(/^u_[a-z0-9]+_/i, '') || '—'
  box.innerHTML = `
    ${avatarMarkup(name, meAvatarUrl(), 'settings-profile-avatar')}
    <div class="settings-profile-main">
      <strong>${esc(name)}</strong>
      <span>${esc(title)} · ${esc(org)}</span>
      <span class="settings-profile-account" title="${esc(rawId)}">账号：${esc(account)}</span>
    </div>
    <div class="settings-profile-roles">${roles}</div>`
  renderPasswordSettingRow()
}

function renderPasswordSettingRow() {
  const row = $('#settings-password')
  if (!row) return
  const configured = state.me?.passwordConfigured === true
  const title = row.querySelector('strong')
  const hint = row.querySelector('em')
  if (title) title.textContent = configured ? '修改密码' : '设置登录密码'
  if (hint) {
    hint.textContent = configured
      ? '更新登录密码，其他设备会退出登录'
      : '当前账号还没有设置过密码，先设置一个登录密码'
  }
}

function renderChatSendModeSetting() {
  const segment = $('#settings-send-segment')
  const hint = $('#settings-send-mode-hint')
  if (!segment) return
  const mode = state.chatSendMode === 'interrupt' ? 'interrupt' : 'queue'
  for (const button of segment.querySelectorAll('[data-send-mode]')) {
    const active = button.dataset.sendMode === mode
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-checked', active ? 'true' : 'false')
  }
  if (hint) {
    hint.textContent =
      mode === 'interrupt'
        ? '打断：立即停止当前回复，优先发送这条新消息'
        : '排队：当前回复结束后，再按顺序发送'
  }
}

function showSettings() {
  const stage = $('#settings-stage')
  if (!stage) return
  $('.chat-head').hidden = true
  $('.chat-main').hidden = true
  stage.hidden = false
  $('#open-settings').classList.add('is-active')
  state.view = 'settings'
  persistChatLocation()
  renderSettingsProfile()
  renderChatSendModeSetting()
}

function hideSettings() {
  const stage = $('#settings-stage')
  if (!stage) return
  stage.hidden = true
  $('.chat-head').hidden = false
  $('.chat-main').hidden = false
  $('#open-settings').classList.remove('is-active')
  state.view = state.mode
  persistChatLocation()
  $('#input').focus()
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' })
  } catch {
    // 网络失败也要回登录页
  }
  location.href = '/chat'
}

let settingsBound = false
function bindSettings() {
  if (settingsBound) return
  settingsBound = true
  $('#open-settings').addEventListener('click', showSettings)
  $('#settings-back').addEventListener('click', hideSettings)
  $('#settings-memories').addEventListener('click', showMemories)
  $('#settings-caps').addEventListener('click', showMyCaps)
  $('#settings-password').addEventListener('click', showPasswordModal)
  $('#settings-logout').addEventListener('click', logout)
  $('#settings-send-segment').addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-send-mode]')
    if (!button) return
    const next = button.dataset.sendMode
    if (next !== 'queue' && next !== 'interrupt') return
    if (next === state.chatSendMode) return
    const previous = state.chatSendMode
    state.chatSendMode = next
    renderChatSendModeSetting()
    const buttons = [...$('#settings-send-segment').querySelectorAll('button')]
    for (const item of buttons) item.disabled = true
    try {
      const saved = await api('/api/me/chat-send-mode', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatSendMode: next }),
      })
      state.chatSendMode = saved.chatSendMode === 'interrupt' ? 'interrupt' : 'queue'
      if (state.me) state.me.chatSendMode = state.chatSendMode
      renderChatSendModeSetting()
      banner(state.chatSendMode === 'interrupt' ? '已改为打断模式' : '已改为排队模式', 'ok')
    } catch (err) {
      state.chatSendMode = previous
      renderChatSendModeSetting()
      banner(err.message || '保存失败，请重试', 'bad')
    } finally {
      for (const item of buttons) item.disabled = false
    }
  })
}

let ssoSdkPromise = null
let ssoBound = false
let ssoQrLoaded = false
let ssoQrAppId = null
let ssoMethods = null
let loginMode = 'password'
let loginModeBound = false
let ssoWatchTimer = 0
let qrExpiryTimer = 0
/** 钉钉登录二维码官方有效期为 15 分钟；到期先罩一层灰，不让用户继续扫死码。 */
const DINGTALK_QR_TTL_MS = 15 * 60 * 1000

function hideQrExpired() {
  const overlay = $('#login-qr-expired')
  if (overlay) overlay.hidden = true
}

function showQrExpired() {
  const overlay = $('#login-qr-expired')
  if (!overlay) return
  overlay.hidden = false
  hideSsoError()
}

function hideSsoError() {
  const errorBox = $('#login-sso-error')
  const errorLink = $('#login-sso-error-link')
  if (errorBox) errorBox.hidden = true
  if (errorLink) {
    errorLink.hidden = true
    errorLink.href = '#'
  }
}

function renderSsoError(err) {
  const errorBox = $('#login-sso-error')
  const errorLink = $('#login-sso-error-link')
  if (errorBox) {
    errorBox.textContent = err?.message || '登录失败，请重试'
    errorBox.hidden = false
  }
  const applyUrl = String(err?.details?.applyUrl || '')
  if (errorLink) {
    if (applyUrl) {
      errorLink.href = applyUrl
      errorLink.hidden = false
    } else {
      errorLink.hidden = true
      errorLink.href = '#'
    }
  }
}

function scheduleQrExpiry() {
  clearTimeout(qrExpiryTimer)
  const qr = $('#login-qr')
  if (qr) qr.dataset.expiresAt = String(Date.now() + DINGTALK_QR_TTL_MS)
  qrExpiryTimer = window.setTimeout(() => {
    if (ssoQrLoaded) showQrExpired()
  }, DINGTALK_QR_TTL_MS)
}

function loadDingTalkLoginSdk() {
  if (window.DTFrameLogin) return Promise.resolve()
  if (ssoSdkPromise) return ssoSdkPromise
  ssoSdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://g.alicdn.com/dingding/h5-dingtalk-login/0.21.0/ddlogin.js'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('钉钉扫码组件加载失败，请检查网络或刷新本页重试'))
    document.head.appendChild(script)
  })
  return ssoSdkPromise
}

async function showDingTalkQr(force = false) {
  // 已经渲染过且 AppKey 没变才复用；换机器人后必须重新生成二维码，不能拿旧 client_id 硬扫。
  if (ssoQrLoaded && !force) {
    const current = String(ssoMethods?.dingtalk?.appId || '')
    if (current && current === ssoQrAppId) return
  }
  const panel = $('#login-sso-dingtalk')
  const frame = $('#login-qr-frame')
  const tab = $('#login-tab-dingtalk')
  hideQrExpired()
  clearTimeout(qrExpiryTimer)
  hideSsoError()
  if (tab) tab.disabled = true
  try {
    const company = new URLSearchParams(location.search).get('company') || ''
    const query = company ? `?company=${encodeURIComponent(company)}` : ''
    const data = await api(`/api/auth/dingtalk/start${query}`)
    if (!data.url || !data.appId) throw new Error('没有拿到钉钉登录地址')
    panel.hidden = false
    frame.innerHTML = ''
    const openLink = $('#login-qr-open')
    if (openLink) openLink.href = data.url
    await loadDingTalkLoginSdk()
    if (typeof window.DTFrameLogin !== 'function') {
      throw new Error('钉钉扫码组件加载失败，请刷新本页重试')
    }
    window.DTFrameLogin(
      { id: 'login-qr-frame', width: 260, height: 260 },
      {
        redirect_uri: encodeURIComponent(`${location.origin}/api/auth/dingtalk/callback`),
        client_id: data.appId,
        scope: 'openid',
        response_type: 'code',
        state: data.state,
        prompt: 'consent',
      },
      async (result) => {
        try {
          const login = await api('/api/auth/dingtalk/exchange', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              company,
              authCode: result.authCode,
              state: result.state || data.state,
            }),
          })
          location.href = (login && login.redirectPath) || '/chat'
        } catch (err) {
          renderSsoError(err)
        }
      },
      (msg) => {
        // 组件偶尔会用空消息回调一次；此时二维码通常仍可扫，不弹误导性的红条
        if (!msg) return
        const text = String(msg)
        if (/过期|失效|expired|refresh/i.test(text)) {
          showQrExpired()
          return
        }
        renderSsoError(new Error(text))
      },
    )
    ssoQrLoaded = true
    ssoQrAppId = data.appId
    scheduleQrExpiry()
  } catch (err) {
    renderSsoError(err)
  } finally {
    if (tab) tab.disabled = false
  }
}

function selectLoginMode(mode) {
  const qr = mode === 'qr'
  loginMode = qr ? 'qr' : 'password'
  $('#login-card')?.classList.toggle('is-password-mode', !qr)
  $('#login-mode-qr')?.classList.toggle('is-active', qr)
  $('#login-mode-password')?.classList.toggle('is-active', !qr)
  const paneQr = $('#login-pane-qr')
  const panePassword = $('#login-pane-password')
  if (paneQr) paneQr.hidden = !qr
  if (panePassword) panePassword.hidden = qr
  if (!qr) return
  if (ssoMethods?.dingtalk?.configured) void showDingTalkQr(false)
}

function selectSsoMethod(method) {
  const isDing = method === 'dingtalk'
  $('#login-tab-dingtalk')?.classList.toggle('is-active', isDing)
  $('#login-tab-feishu')?.classList.toggle('is-active', !isDing)
  $('#login-sso-dingtalk').hidden = !isDing
  $('#login-sso-feishu').hidden = isDing
  hideSsoError()
  const sub = $('#login-qr-sub')
  const foot = $('#login-qr-foot')
  if (sub) sub.textContent = isDing
    ? '打开手机钉钉扫一扫，确认后这台电脑会自动登录。'
    : '飞书扫码登录链路还在接入中；可先切到「账号密码」登录。'
  if (foot) foot.textContent = isDing
    ? '二维码由钉钉官方组件渲染，手机不需要访问本机地址；扫码只用于身份登录。'
    : '飞书扫码登录接入中；企业身份与权限仍按公司、部门、角色隔离。'
  if (isDing && ssoMethods?.dingtalk?.configured) void showDingTalkQr(false)
}

function paintSsoAppId() {
  // AppKey 是内部路由排障信息，登录页不给普通员工展示。
  const appIdEl = $('#login-sso-appid')
  if (!appIdEl) return
  appIdEl.hidden = true
  appIdEl.textContent = ''
}

function paintLoginBrand() {
  const el = $('#login-brand-name')
  if (!el) return
  const companyName = String(ssoMethods?.companyName || ssoMethods?.dingtalk?.tenantName || '').trim()
  el.textContent = companyName ? `企业智能体基座 · ${companyName}` : '企业智能体基座'
}

async function setupLoginSso() {
  const tabs = $('#login-sso-tabs')
  const empty = $('#login-sso-empty')
  const modeTabs = $('#login-mode-tabs')
  const paneQr = $('#login-pane-qr')
  const panePassword = $('#login-pane-password')
  try {
    const company = new URLSearchParams(location.search).get('company') || ''
    const query = company ? `?company=${encodeURIComponent(company)}` : ''
    ssoMethods = await api(`/api/auth/methods${query}`)
  } catch {
    ssoMethods = null
  }
  const ding = Boolean(ssoMethods?.dingtalk?.configured)
  const feishu = Boolean(ssoMethods?.feishu?.configured)
  $('#login-card')?.classList.toggle('has-sso', ding || feishu)
  paintSsoAppId()
  paintLoginBrand()

  if (!loginModeBound) {
    loginModeBound = true
    $('#login-mode-qr')?.addEventListener('click', () => selectLoginMode('qr'))
    $('#login-mode-password')?.addEventListener('click', () => selectLoginMode('password'))
  }

  if (!ding && !feishu) {
    // 没配扫码：直接把账号密码作为唯一入口，不显示模式切换。
    modeTabs.hidden = true
    tabs.hidden = true
    $('#login-sso-dingtalk').hidden = true
    $('#login-sso-feishu').hidden = true
    empty.hidden = false
    if (paneQr) paneQr.hidden = true
    if (panePassword) panePassword.hidden = false
    loginMode = 'password'
    return
  }

  // 配了扫码：扫码是主入口，账号密码是次级模式。
  modeTabs.hidden = false
  if (paneQr) paneQr.hidden = false
  if (panePassword) panePassword.hidden = true
  loginMode = 'qr'
  const qrSub = $('#login-qr-sub')
  if (qrSub) qrSub.textContent = ding
    ? '打开手机钉钉扫一扫，确认后这台电脑会自动登录。'
    : '打开手机飞书扫一扫，确认后这台电脑会自动登录。'

  empty.hidden = true
  tabs.hidden = !(ding && feishu)
  $('.login-sso-body')?.classList.toggle('with-tabs', !tabs.hidden)
  if (ding) {
    $('#login-tab-dingtalk').hidden = false
    $('#login-tab-feishu').hidden = !feishu
    selectSsoMethod('dingtalk')
  } else {
    $('#login-tab-dingtalk').hidden = true
    $('#login-tab-feishu').hidden = false
    selectSsoMethod('feishu')
  }

  /**
   * 控制台换机器人时，登录页可能一直开着。
   * 每 30 秒核对一次 AppKey：变了就丢缓存，重新出二维码，避免一直扫旧码报 900103。
   */
  if (!ssoWatchTimer) {
    ssoWatchTimer = setInterval(async () => {
      const previous = String(ssoMethods?.dingtalk?.appId || '')
      try {
        const company = new URLSearchParams(location.search).get('company') || ''
        const query = company ? `?company=${encodeURIComponent(company)}` : ''
        const next = await api(`/api/auth/methods${query}`)
        const changed = String(next?.dingtalk?.appId || '') !== previous
        ssoMethods = next
        paintLoginBrand()
        if (!changed) return
        paintSsoAppId()
        ssoQrLoaded = false
        ssoQrAppId = null
        if (loginMode === 'qr' && next?.dingtalk?.configured) void showDingTalkQr(true)
      } catch {
        /* 网络抖动不影响当前二维码 */
      }
    }, 30_000)
  }

  if (ssoBound) return
  ssoBound = true
  $('#login-tab-dingtalk')?.addEventListener('click', () => selectSsoMethod('dingtalk'))
  $('#login-tab-feishu')?.addEventListener('click', () => selectSsoMethod('feishu'))
  $('#login-qr-refresh')?.addEventListener('click', () => {
    ssoQrLoaded = false
    void showDingTalkQr(true)
  })
  $('#login-qr-expired')?.addEventListener('click', () => {
    hideQrExpired()
    ssoQrLoaded = false
    void showDingTalkQr(true)
  })
}

async function boot() {
  const as = currentAs()
  $('#login-form').addEventListener('submit', doLogin)

  // 登录页右侧扫码入口由 setupLoginSso() 按公司已配置的渠道动态展示。

  for (const button of $('#mode-switch').querySelectorAll('[data-mode]')) {
    button.addEventListener('click', () => setChatMode(button.dataset.mode))
  }
  bindWorkspaceFilePane()
  bindSpacePicker()
  setChatMode('chat')

  let hasSession = false
  try {
    await api('/api/auth/me')
    hasSession = true
  } catch {
    hasSession = false
  }

  // 既没有开发预览身份、也没有真实登录会话 → 只显示登录
  // ?login=1 可强制回到登录页，用于切换账号或验证扫码登录。
  const forceLogin = new URLSearchParams(location.search).get('login') === '1'
  if (forceLogin || (!as && !hasSession)) {
    showLogin()
    await renderLogin()
    await setupLoginSso()
    return
  }

  $('#login-gate').hidden = true
  const sideShell = $('#chat-side')
  const stageShell = $('#chat-stage')
  if (sideShell) sideShell.hidden = false
  if (stageShell) stageShell.hidden = false
  $('#mode-switch').hidden = false
  $('#chat-title').hidden = false
  $('#demo-pill').hidden = true

  // 侧栏需要身份列表（开发预览可切换账号）
  await loadPersonas()

  let me = null
  try {
    me = await api(`/api/me${qs()}`)
    state.me = me
    state.chatSendMode = me.chatSendMode === 'interrupt' ? 'interrupt' : 'queue'
    state.assistant = me.assistant || { name: 'AI', avatarUrl: '' }
  } catch (err) {
    // as 指向不存在/失效的人 → 回到登录页，而不是显示别人的信息
    showLogin()
    await renderLogin()
    await setupLoginSso()
    $('#login-sub').textContent = `登录态无效（${err.message}），请重新登录。`
    $('#login-sub').hidden = false
    return
  }

  renderSideUser(me)
  $('#side-files').hidden = false

  try {
    const models = await api(`/api/chat/models${qs()}`)
    state.models = models.models
    state.autoModelId = models.autoModelId
    state.canChat = models.canChat && models.canUseModel
    if (!state.canChat) {
      renderDenied(new Error('当前账号没有对话 / 使用模型的权限（chat:use、model:use）'))
      return
    }
    if (models.models.length === 0) {
      renderDenied(new Error('你的角色里没有任何可用模型，请联系管理员授权'))
      return
    }
    renderModelMenus()
    setSelected('')
    renderEmpty(me)
    renderSuggestions()
    renderAttachments()
    $('#demo-pill').hidden = !models.models.every((model) => model.provider === 'demo')
    await loadSessions()
    setupChatEvents()
    const savedLocation = readChatLocation()
    if (state.sessions.length > 0) {
      const savedSessionId = savedLocation?.sessionId
      if (savedSessionId && state.sessions.some((session) => session.id === savedSessionId)) {
        await openSession(savedSessionId)
      } else if (savedSessionId === '') {
        newSession()
      } else {
        await openSession(state.sessions[0].id)
      }
    } else {
      newSession()
    }
    restoreChatLocation(savedLocation)
    await loadWorkspaceFiles()
  } catch (err) {
    renderDenied(err)
    return
  }

  // 输入区
  $('#thread').addEventListener('scroll', onThreadScroll, { passive: true })
  $('#scroll-bottom').addEventListener('click', scrollThreadToBottomSmooth)
  window.addEventListener('resize', queueScrollBottomButtonUpdate)
  $('#send').addEventListener('click', send)
  $('#queue-stop').addEventListener('click', stopCurrentReply)
  $('#stop-reply').addEventListener('click', stopCurrentReply)
  $('#input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  })
  $('#input').addEventListener('input', () => {
    autosize()
    updateSendState()
  })
  $('#input').addEventListener('focus', () => $('#composer-box').classList.add('is-focus'))

  // 空间选择：输入框左侧气泡（已在 boot 早期绑定，保证无模型时也可切换）
  // 云空间角标：悬停 / 聚焦 / 点击都能看到配额信息
  const quotaPopover = $('#ws-quota-popover')
  const quotaBadge = $('#ws-info')
  const showQuota = () => {
    if (!quotaPopover) return
    quotaPopover.hidden = false
    quotaBadge?.setAttribute('aria-expanded', 'true')
  }
  const hideQuota = () => {
    if (!quotaPopover) return
    quotaPopover.hidden = true
    quotaBadge?.setAttribute('aria-expanded', 'false')
  }
  quotaBadge?.addEventListener('mouseenter', showQuota)
  quotaBadge?.addEventListener('focus', showQuota)
  quotaBadge?.addEventListener('click', (event) => {
    event.stopPropagation()
    if (quotaPopover?.hidden) showQuota()
    else hideQuota()
  })
  quotaBadge?.addEventListener('mouseleave', () => {
    if (!quotaBadge.matches(':focus')) hideQuota()
  })
  quotaBadge?.addEventListener('blur', hideQuota)
  quotaPopover?.addEventListener('mouseenter', showQuota)
  quotaPopover?.addEventListener('mouseleave', hideQuota)

  document.addEventListener('click', (event) => {
    if (!event.target.closest('#ws-info') && !event.target.closest('#ws-quota-popover')) hideQuota()
  })

  // 模型选择：输入框里的气泡
  $('#model-chip').addEventListener('click', () => {
    const menu = $('#model-menu')
    const open = menu.hidden
    menu.hidden = !open
    $('#model-chip').setAttribute('aria-expanded', open ? 'true' : 'false')
  })
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#model-chip') && !event.target.closest('#model-menu')) {
      $('#model-menu').hidden = true
      $('#model-chip').setAttribute('aria-expanded', 'false')
    }
  })

  // 附件
  $('#pick-image').addEventListener('click', () => $('#file-image').click())
  $('#pick-file').addEventListener('click', () => $('#file-any').click())
  $('#file-image').addEventListener('change', (event) => {
    addFiles(event.target.files || [])
    event.target.value = ''
  })
  $('#file-any').addEventListener('change', (event) => {
    addFiles(event.target.files || [])
    event.target.value = ''
  })

  // 粘贴：截图/图片/文件可直接 Ctrl+V 进输入区
  $('#composer-box').addEventListener('paste', (event) => {
    const items = Array.from(event.clipboardData?.items || [])
    const files = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean)
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  })

  // 拖拽文件到输入区同样加入附件
  $('#composer-box').addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types?.includes('Files')) event.preventDefault()
  })
  $('#composer-box').addEventListener('drop', (event) => {
    const files = Array.from(event.dataTransfer?.files || [])
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  })

  // 会话
  $('#new-session').addEventListener('click', newSession)
  $('#session-menu').addEventListener('click', (event) => {
    const action = event.target.closest('[data-act]')
    if (!action) return
    const sessionId = $('#session-menu').dataset.session
    const session = sessionById(sessionId)
    hideSessionMenu()
    if (action.dataset.act === 'rename') renameSession(sessionId, session?.title)
    else if (action.dataset.act === 'delete') deleteSession(sessionId)
  })
  $('#file-menu').addEventListener('click', (event) => {
    const action = event.target.closest('[data-file-act]')
    if (!action) return
    const fileId = $('#file-menu').dataset.file
    const file = fileById(fileId)
    hideFileMenu()
    if (!file) return
    if (action.dataset.fileAct === 'rename') renameWorkspaceFile(file)
    else if (action.dataset.fileAct === 'edit') editWorkspaceFile(file)
    else if (action.dataset.fileAct === 'delete') deleteWorkspaceFile(file)
    else if (action.dataset.fileAct === 'send-dingtalk') sendWorkspaceFileToDingTalk(file)
    else if (action.dataset.fileAct === 'download') {
      const link = document.createElement('a')
      link.href = workspaceFileUrl(file)
      link.download = file.name
      document.body.appendChild(link)
      link.click()
      link.remove()
    }
  })
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#session-menu') && !event.target.closest('.side-session-more')) hideSessionMenu()
    if (!event.target.closest('#file-menu') && !event.target.closest('.side-file-more')) hideFileMenu()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideSessionMenu()
      hideFileMenu()
      hideSpaceMenu()
      hideQuota()
    }
  })
  window.addEventListener('resize', () => {
    hideSessionMenu()
    hideFileMenu()
    hideSpaceMenu()
    hideQuota()
  })

  // 个人工作区
  $('#ws-upload').addEventListener('click', () => $('#ws-input').click())
  $('#ws-input').addEventListener('change', async (event) => {
    const files = event.target.files || []
    event.target.value = ''
    if (files.length) await uploadWorkspaceFiles(files)
  })

  // 设置入口与设置页
  bindSettings()
  $('#login-btn').addEventListener('click', () => {
    location.href = '/chat'
  })

  $('#input').focus()
}

bindSettings()
bindHintTips($('#workspace-pane'))
boot()
