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

/** 归一化代码块内容，用于识别“文件正文被重复贴进回复”的情况。 */
function normalizeAnswerCodeBlock(value, alreadyEscaped = false) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n')
  return (alreadyEscaped ? text : esc(text)).replace(/^\n+|\n+$/g, '').trim()
}

/** 去掉“内容如下：”这类只为引出被隐藏文件正文的尾句，避免气泡里留下空引子。 */
function trimFileContentCodeLeadIn(html) {
  const trimmed = html.replace(
    /(?:，|,)?\s*(?:文件)?(?:内容|正文)(?:如下|为|是)?\s*[：:]?(<\/p>)$/,
    '。$1',
  )
  return /^<p>\s*(?:。)?\s*<\/p>$/.test(trimmed) ? '' : trimmed
}

/** 写入成功的工作区文件正文；消息气泡里的同名代码块由顶部吊顶卡/文件预览承担，不再重复展示。 */
function writtenFileContentBlocks(tools) {
  const blocks = new Set()
  for (const trace of Array.isArray(tools) ? tools : []) {
    if (String(trace?.toolId || '') !== 'workspace.write') continue
    if (String(trace?.status || '') !== 'done') continue
    const args = trace?.args
    if (!args || typeof args !== 'object') continue
    for (const key of ['content', 'text', 'body', 'data']) {
      const value = args[key]
      if (typeof value === 'string' && value.trim()) blocks.add(normalizeAnswerCodeBlock(value))
    }
  }
  return blocks
}

/** Markdown：标题、列表、表格、引用、分隔线、代码块、行内代码、加粗、斜体、链接。 */
function renderAnswer(text, options = {}) {
  const source = esc(String(text ?? '').replace(/\r\n?/g, '\n'))
  const omitCodeBlocks = options.omitCodeBlocks instanceof Set ? options.omitCodeBlocks : null
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
      if (omitCodeBlocks && omitCodeBlocks.has(normalizeAnswerCodeBlock(code, true))) {
        if (output.length) {
          const trimmed = trimFileContentCodeLeadIn(output[output.length - 1])
          if (trimmed) output[output.length - 1] = trimmed
          else output.pop()
        }
        index += 1
        continue
      }
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

let loginRedirectStarted = false

function isAuthProbePath(path) {
  const raw = String(path || '')
  return raw.startsWith('/api/auth/') || raw.startsWith('/api/dev/personas')
}

/**
 * 员工会话缺失或过期：不再把 401 交给页面提示，直接回到登录页。
 * 保留 company，去掉可能失效的 as，避免重新进入预览身份。
 */
function redirectToLogin() {
  if (loginRedirectStarted) return
  loginRedirectStarted = true
  const params = new URLSearchParams()
  const company = new URLSearchParams(location.search).get('company')
  if (company) params.set('company', company)
  params.set('login', '1')
  location.replace(`/chat?${params.toString()}`)
}

/** 返回一个永不结束的 Promise：跳转已发起，调用方不应再显示错误或弹提示。 */
function waitForLoginRedirect() {
  return new Promise(() => {})
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
    if (response.status === 401 && !isAuthProbePath(path)) {
      redirectToLogin()
      return waitForLoginRedirect()
    }
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
  /** 当前会话选中的思考档位；模型没有思考菜单时为空 */
  reasoningEffort: '',
  /** 会话切换序号：连续点击多个会话时只接受最后一次请求的结果 */
  openSeq: 0,
  /** 每个会话独立的发送队列、控制器和实时回答节点；null 键表示尚未落库的新对话 */
  runtimes: new Map(),
  /** 刷新/重新登录后从服务端取回仍在运行的回合，按 messageId 保存 */
  activeRunSnapshots: new Map(),
  /** queue=按顺序排队；interrupt=新消息打断当前回复 */
  chatSendMode: 'queue',
  attachments: [],
  personas: [],
  sessionId: null,
  sessions: [],
  historyBefore: null,
  historyHasMore: false,
  historyLoading: false,
  historyMessageIds: new Set(),
  /** 正在实时更新的 AI 回合，按 assistant messageId 索引；节点可脱离当前会话保留 */
  liveTurns: new Map(),
  /** 本页 POST 流正在直接渲染的 messageId；EventSource 不重复叠加同一段增量 */
  localLiveMessageIds: new Set(),
  /** 当前等待用户在底部输入区选择方向的澄清请求 */
  pendingClarify: null,
  /** 多页引导式澄清的当前流程：复用同一条 AI 消息继续推进，不新增用户气泡 */
  clarifyFlow: null,
  /** 右键“编辑后重发”暂存的消息；下一次发送会先回退并替换它 */
  messageEdit: null,
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
  workspaceKind: 'plugins',
  skills: [],
  skillData: null,
  skillSelected: null,
  mode: 'chat',
  /** 当前实际停留的界面：chat / workspace / settings，刷新后恢复 */
  view: 'chat',
  filePreview: null,
  /** 当前对话回合的子 Agent 团队；key 为 childId，同一子 Agent 复用同一窗口 */
  agentRuns: new Map(),
  /** 父 Agent 名称，用于团队标题 */
  agentParentName: '',
  /** 当前回合的根 run */
  agentParentRunId: '',
  /** 团队列表里被选中、详情窗口正在展示的子 Agent */
  agentSelectedId: '',
  /** 右侧工作台当前面板：team / file */
  workbenchTab: 'team',
  /** 团队与文件是否并排显示 */
  workbenchSplit: false,
  /** 顶部吊顶卡片当前跟踪的文件操作；不随 AI 气泡销毁，整个会话内保留。 */
  fileActivity: null,
  fileDockClosed: false,
  /** 本轮对话结束后，吊顶卡不再常驻，避免和最终回答抢注意力。 */
  fileDockSettled: false,
  /** 右侧文件预览打开时，顶部吊顶卡让位给预览；关闭预览后恢复。 */
  fileDockPreviewSuppressed: false,
  previewSelection: null,
}

const HISTORY_PAGE_SIZE = 10
const HISTORY_TOP_THRESHOLD = 120
const SCROLL_STICK_THRESHOLD = 8
const SIDEBAR_COLLAPSED_KEY = 'eab.chat.sidebarCollapsed'
const FILE_SPLIT_RATIO_KEY = 'eab.chat.fileSplitRatio'
/** 右栏（Agent 团队 / 文件）与对话之间的宽度比例，独立于文件预览记住 */
const TEAM_SPLIT_RATIO_KEY = 'eab.chat.teamSplitRatio'
const TEAM_LIST_WIDTH_KEY = 'eab.chat.teamListWidth'
const SIDE_SECTION_RATIO_KEY = 'eab.chat.sideSectionRatio'
/** 用户主动上滚后，流式输出不再抢滚动；滚回触底附近才恢复跟随。 */
let threadScrollPinned = true
let threadScrollLastTop = 0
let threadHasNewBelow = false
/** 引导问题等待用户选择的最长时间；超时自动采用第一个方向。 */
const CLARIFY_AUTO_SELECT_MS = 180000
const DEFAULT_INPUT_PLACEHOLDER = '输入消息，Enter 发送，Shift + Enter 换行；/model 切换模型'
const CHAT_LOCATION_STORAGE_KEY = 'eab.chat.location.v1'

/**
 * 发送状态归属到会话，而不是页面全局：
 * A 会话回复时切到 B，B 仍可独立发送、独立选模型，A 的节点继续在后台更新。
 */
function runtimeKey(sessionId) {
  return sessionId || '__new__'
}

function runtimeFor(sessionId) {
  const key = runtimeKey(sessionId)
  let runtime = state.runtimes.get(key)
  if (!runtime) {
    runtime = {
      key,
      sessionId: sessionId || null,
      sending: false,
      controller: null,
      queue: [],
      turn: null,
      messageId: null,
      runId: null,
      title: '',
    }
    state.runtimes.set(key, runtime)
  }
  return runtime
}

function currentRuntime() {
  return runtimeFor(state.sessionId)
}

function migrateRuntime(runtime, sessionId) {
  if (!runtime || !sessionId) return runtime
  const next = runtimeFor(sessionId)
  if (next !== runtime) {
    const oldKey = runtime.key
    runtime.sessionId = sessionId
    if (next.queue.length > 0) runtime.queue.push(...next.queue)
    if (next.turn && !runtime.turn) runtime.turn = next.turn
    state.runtimes.delete(next.key)
    state.runtimes.delete(oldKey)
    runtime.key = runtimeKey(sessionId)
    state.runtimes.set(runtime.key, runtime)
  }
  return runtime
}

function markSessionReadLocally(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId)
  if (session) session.unread = false
}

function notifySessionRead(sessionId) {
  if (!sessionId) return
  markSessionReadLocally(sessionId)
  renderSessions()
  void api(`/api/chat/sessions/${encodeURIComponent(sessionId)}/read${qs()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => {
    /* 已读标记失败不阻塞对话；下次打开会话会再次标记 */
  })
}

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
  clearClarifyDock({ abort: true })
  clearFileActivity()
  const thread = $('#thread')
  for (const child of [...thread.children]) {
    if (child.id !== 'chat-empty') child.remove()
  }
  $('#chat-empty').hidden = false
  setEmptyVisible(true)
  updateScrollBottomButton()
}

function sessionUpdatedAt(session) {
  const raw = session && (session.updatedAt || session.lastMessageAt || session.createdAt)
  const ts = raw ? Date.parse(raw) : NaN
  return Number.isFinite(ts) ? ts : 0
}

/** 会话列表按最近活动倒序；接口已排序，这里再兜底保证本地即时更新也不会乱序。 */
function sortSessionsByRecent(sessions) {
  return [...(sessions || [])].sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a))
}

function markSessionActive(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId)
  if (!session) return
  session.updatedAt = new Date().toISOString()
  state.sessions = sortSessionsByRecent(state.sessions)
}

/**
 * 会话是否仍在生成。当前页看 runtime，其它页看服务端运行快照；
 * 两者都覆盖后才能让左侧列表在切页/后台回复时保持同步。
 */
function sessionIsRunning(sessionId) {
  const runtime = state.runtimes.get(runtimeKey(sessionId))
  if (runtime?.sending) return true
  for (const snapshot of state.activeRunSnapshots.values()) {
    if (snapshot.sessionId === sessionId && snapshot.status === 'running') return true
  }
  return false
}

function renderSessions() {
  const box = $('#session-list')
  const sessions = sortSessionsByRecent(state.sessions)
  $('#side-sessions').hidden = sessions.length === 0 && !state.me
  if (sessions.length === 0) {
    box.innerHTML = '<div class="side-session-empty">还没有对话</div>'
    syncSideSectionSplit()
    return
  }
  box.innerHTML = sessions
    .map((session) => {
      // 左侧已经有「钉钉」来源徽标，标题里不再重复前缀。
      const displayTitle =
        session.source === 'dingtalk' ? String(session.title || '').replace(/^钉钉\s*·\s*/, '') : session.title
      const running = sessionIsRunning(session.id)
      return `<div class="side-session ${session.id === state.sessionId ? 'active' : ''}" data-session="${esc(session.id)}">
        <button class="side-session-main" type="button" data-open="${esc(session.id)}" title="${esc(session.title)}">${
          running
            ? '<span class="side-session-running" role="status" aria-label="正在回复" title="正在回复"></span>'
            : session.unread && session.id !== state.sessionId
              ? '<span class="side-session-unread" aria-label="有新的回复" title="有新的回复"></span>'
              : ''
        }${
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
  syncSideSectionSplit()
}

async function loadSessions() {
  try {
    const data = await api(`/api/chat/sessions${qs()}`)
    state.sessions = sortSessionsByRecent(data.sessions || [])
  } catch {
    state.sessions = []
  }
  renderSessions()
}

/** 同一 messageId 的后续结果：更新原气泡，而不是再追加一条。 */
function updateKnownMessage(message, sessionId) {
  if (!message || !message.id) return false
  const id = String(message.id)
  const thread = $('#thread')
  if (!thread) return false
  const node = Array.from(thread.querySelectorAll('.msg')).find((item) => item.dataset.messageId === id)
  if (!node) return false
  const role = message.role === 'user' ? 'me' : 'ai'
  node.chatMessage = {
    id,
    role: message.role,
    text: String(message.text || ''),
    createdAt: message.createdAt || new Date().toISOString(),
  }
  setMessageTime(node, message.createdAt)
  const bubble = node.querySelector('.bubble')
  if (!bubble) return false
  if (role === 'me') {
    bubble.textContent = String(message.text || '')
  } else {
    bubble.innerHTML = historyAiBubble(
      String(message.text || ''),
      message.modelName || '',
      message.meta || {},
      {
        createdAt: message.createdAt,
        messageId: id,
        channel: message.meta?.channel,
      },
    )
    bindToolToggles(node)
  }
  refreshMessageActions(node)
  syncMessageActionAvailability()
  queueScrollBottomButtonUpdate()
  return true
}

/** 钉钉侧刚写入的消息：同一会话就追加到当前对话，其它会话只更新左侧列表。 */
function appendLiveMessage(message, sessionId) {
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) return
  const id = String(message.id || '')
  if (!id) return
  // 引导续跑复用原 assistant 消息 ID：已渲染过就就地替换正文/思考/工具，不再长新气泡。
  if (updateKnownMessage(message, sessionId)) return
  if (state.localLiveMessageIds.has(id)) return
  // 当前页面正在接收本地 SSE 的这一轮：最终消息由本地 turn 收尾，避免再叠加一条。
  if (message.role === 'assistant' && sessionId && sessionId === state.sessionId) {
    const runtime = runtimeFor(sessionId)
    if (runtime.sending) return
  }
  state.historyMessageIds.add(id)
  // 多页引导的中间选择/追问只用于续跑，不进入聊天消息流。
  if (isHiddenClarifyStep(message)) return

  const thread = $('#thread')
  const follow = Boolean(thread && threadScrollPinned)
  const messageClarify =
    message.role === 'assistant' && message.meta?.clarify && typeof message.meta.clarify === 'object'
      ? message.meta.clarify
      : null
  appendMessage(
    message.role === 'user' ? 'me' : 'ai',
    message.text,
    message.role === 'assistant' && message.modelName ? message.modelName : undefined,
    message.meta && message.meta.attachments,
    message.role === 'assistant' ? message.meta : undefined,
    { scroll: false, messageId: id, channel: message.meta?.channel, pendingClarify: Boolean(messageClarify), createdAt: message.createdAt },
  )
  if (message.role === 'user') clearClarifyDock()
  else if (messageClarify) showClarifyDock(messageClarify, { flowMeta: message.meta, auto: true })
  if (follow) scrollThreadToBottomInstant()
  else markThreadNewContent()
  if (sessionId && sessionId === state.sessionId) scheduleSessionRefresh()
}

function scheduleSessionRefresh() {
  if (state.sessionRefreshTimer) return
  state.sessionRefreshTimer = window.setTimeout(async () => {
    state.sessionRefreshTimer = 0
    await loadSessions()
  }, 600)
}

/** 服务端仍在跑的回合快照；页面刷新/重新登录后据此恢复半截输出。 */
function runSnapshotOf(payload) {
  const messageId = String(payload?.messageId || '')
  if (!messageId) return null
  let snapshot = state.activeRunSnapshots.get(messageId)
  if (!snapshot) {
    snapshot = {
      runId: payload.runId || '',
      sessionId: String(payload.sessionId || ''),
      messageId,
      modelId: payload.modelId || '',
      modelName: payload.modelName || '',
      autoSelected: Boolean(payload.autoSelected),
      status: 'running',
      reasoning: '',
      text: '',
      toolCalls: [],
    }
    state.activeRunSnapshots.set(messageId, snapshot)
  }
  return snapshot
}

/** 为后台回合建立（或取回）可脱离当前会话存在的 AI 节点。 */
function liveTurnForSnapshot(snapshot, options = {}) {
  if (!snapshot?.messageId) return null
  let entry = state.liveTurns.get(snapshot.messageId)
  if (!entry && state.historyMessageIds.has(snapshot.messageId)) {
    // 该消息已经落库并渲染，迟到的运行快照不能再长出一个空节点。
    return null
  }
  if (!entry) {
    // 同一个会话可能已经由 POST 流创建了气泡；优先复用 runtime.turn，
    // 避免 EventSource 的增量画到一个隐藏节点上，页面一直停在“正在思考…”。
    const runtime = state.runtimes.get(runtimeKey(snapshot.sessionId))
    const reuseTurn =
      runtime?.turn && runtime.sending && snapshot.sessionId === runtime.sessionId
        ? runtime.turn
        : runtime?.messageId === snapshot.messageId && runtime.turn
          ? runtime.turn
          : null
    entry = {
      turn: reuseTurn || createAiTurn({ append: false }),
      sessionId: snapshot.sessionId,
      messageId: snapshot.messageId,
      hydrated: Boolean(reuseTurn),
    }
    state.liveTurns.set(snapshot.messageId, entry)
    if (entry.turn.node) {
      entry.turn.node.dataset.messageId = snapshot.messageId
      entry.turn.node.chatMessage = {
        id: snapshot.messageId,
        role: 'assistant',
        text: String(snapshot.text || ''),
        createdAt: new Date().toISOString(),
      }
      refreshMessageActions(entry.turn.node)
    }
  }
  let hydratedNow = false
  if (!entry.hydrated && (snapshot.reasoning || snapshot.text || snapshot.toolCalls?.length)) {
    entry.hydrated = true
    entry.turn.hydrate(snapshot)
    hydratedNow = true
  }
  /**
   * 事件是先写进 run 快照再广播的，所以首次创建节点时 hydrate 已经包含
   * 当前这条增量；调用方不能再重复应用一次，否则正文/工具会多一份。
   */
  entry.skipPayload = Boolean(options.fromEvent && hydratedNow)
  if (snapshot.sessionId === state.sessionId) entry.turn.appendToThread()
  return entry
}

/** 切换回某个会话时，把仍在输出/排队的节点重新挂回消息流。 */
function attachLiveTurnForSession(sessionId) {
  for (const snapshot of state.activeRunSnapshots.values()) {
    if (snapshot.sessionId !== sessionId || snapshot.status !== 'running') continue
    const entry = liveTurnForSnapshot(snapshot)
    if (entry) entry.turn.appendToThread()
  }
  for (const entry of state.liveTurns.values()) {
    if (entry.sessionId !== sessionId) continue
    entry.turn.appendToThread()
  }
  const runtime = state.runtimes.get(runtimeKey(sessionId))
  if (runtime?.turn) runtime.turn.appendToThread()
}

async function loadActiveRuns() {
  try {
    const data = await api(`/api/chat/runs/active${qs()}`)
    for (const run of data.runs || []) {
      if (!run?.messageId) continue
      state.activeRunSnapshots.set(run.messageId, run)
    }
  } catch {
    // 恢复失败不阻塞页面；历史消息仍然可用
  }
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

    // 模型正在生成：先把增量记到该消息的快照，再决定是否渲染。
    if (payload.type === 'delta') {
      if (payload.sessionId === state.sessionId) {
        const runtime = runtimeFor(payload.sessionId)
        if (runtime.sending && runtime.turn) return
      }
      if (payload.messageId && state.localLiveMessageIds.has(String(payload.messageId))) return
      const wasKnown = state.activeRunSnapshots.has(String(payload.messageId || ''))
      const snapshot = runSnapshotOf(payload)
      if (!snapshot || !payload.text) return
      if (!wasKnown && payload.sessionId !== state.sessionId) renderSessions()
      if (payload.kind === 'reasoning') snapshot.reasoning += String(payload.text)
      else snapshot.text += String(payload.text)
      if (payload.sessionId !== state.sessionId) return
      const entry = liveTurnForSnapshot(snapshot, { fromEvent: true })
      if (!entry) return
      if (entry.skipPayload) {
        entry.skipPayload = false
        return
      }
      if (payload.kind === 'reasoning') entry.turn.reasoning(payload.text)
      else entry.turn.content(payload.text)
      return
    }

    // 工具开始/结束：同样先补快照，当前会话才实时画卡片。
    if (payload.type === 'tool') {
      if (payload.sessionId === state.sessionId) {
        const runtime = runtimeFor(payload.sessionId)
        if (runtime.sending && runtime.turn) return
      }
      if (payload.messageId && state.localLiveMessageIds.has(String(payload.messageId))) return
      const wasKnown = state.activeRunSnapshots.has(String(payload.messageId || ''))
      const snapshot = runSnapshotOf(payload)
      if (!snapshot || !payload.tool) return
      if (!wasKnown && payload.sessionId !== state.sessionId) renderSessions()
      const tool = payload.tool
      if (tool.type === 'tool') {
        snapshot.toolCalls.push({
          id: tool.id,
          name: tool.name,
          toolId: tool.toolId,
          args: tool.args,
          status: 'running',
          summary: '',
          durationMs: 0,
        })
      } else {
        const trace = snapshot.toolCalls.find((item) => item.id === tool.id)
        if (trace) {
          trace.status = tool.status
          trace.summary = tool.summary
          trace.durationMs = tool.durationMs
        }
      }
      if (payload.sessionId !== state.sessionId) return
      const entry = liveTurnForSnapshot(snapshot, { fromEvent: true })
      if (!entry) return
      if (entry.skipPayload) {
        entry.skipPayload = false
        return
      }
      if (tool.type === 'tool') entry.turn.tool(tool)
      else entry.turn.toolResult(tool)
      return
    }

    if (payload.type !== 'message' || !payload.message) return
    if (payload.message.id) state.activeRunSnapshots.delete(String(payload.message.id))
    if (payload.sessionId === state.sessionId) {
      const id = String(payload.message.id || '')
      const liveTurn = id ? state.liveTurns.get(id) : null
      if (liveTurn) {
        state.liveTurns.delete(id)
        state.localLiveMessageIds.delete(id)
        state.activeRunSnapshots.delete(id)
        state.historyMessageIds.add(id)
        if (liveTurn.turn.node) {
          liveTurn.turn.node.dataset.messageId = id
          liveTurn.turn.node.chatMessage = {
            id,
            role: 'assistant',
            text: String(payload.message.text || ''),
            createdAt: payload.message.createdAt || new Date().toISOString(),
          }
          setMessageTime(liveTurn.turn.node, payload.message.createdAt)
          refreshMessageActions(liveTurn.turn.node)
        }
        const meta = payload.message.meta || {}
        // EventSource 的最终消息也携带完整 reasoning / toolCalls；不能只传正文，
        // 否则实时气泡收尾后会丢掉“已深度思考”和工具调用记录（刷新后才恢复）。
        liveTurn.turn.finish({
          text: payload.message.text,
          modelId: payload.message.modelId,
          modelName: payload.message.modelName,
          autoSelected: meta.autoSelected === true,
          fallbackFromModelId: meta.fallbackFromModelId || null,
          citations: meta.citations,
          channel: meta.channel,
          reasoning: meta.reasoning || '',
          toolCalls: Array.isArray(meta.toolCalls) ? meta.toolCalls : [],
          clarify: meta.clarify,
          createdAt: payload.message.createdAt,
        })
        syncMessageActionAvailability()
        if (payload.message.role === 'assistant') notifySessionRead(payload.sessionId)
        renderSessions()
        scheduleSessionRefresh()
        return
      }
      appendLiveMessage(payload.message, payload.sessionId)
      if (payload.message.role === 'assistant') {
        notifySessionRead(payload.sessionId)
        renderSessions()
      }
    } else {
      // 非当前会话完成回复：先在本页立刻点红点，再向服务端同步未读状态。
      if (payload.message.role === 'assistant') {
        const session = state.sessions.find((item) => item.id === payload.sessionId)
        if (session) {
          session.unread = true
          renderSessions()
        }
      }
      scheduleSessionRefresh()
    }
  })

  // EventSource 会自己重连；这里不主动 close，避免服务重启后永久失去推送。
  source.addEventListener('error', () => {
    // 浏览器会自动重连，保持引用即可。
  })
}

let scrollBottomButtonFrame = 0

function threadDistanceToBottom(thread = $('#thread')) {
  if (!thread) return 0
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight
}

function pinThreadToBottom() {
  threadScrollPinned = true
  threadHasNewBelow = false
  queueScrollBottomButtonUpdate()
}

/** 切回对话页时按当前真实位置校准贴底状态，避免旧位置仍被当成“正在跟随”。 */
function syncThreadScrollState() {
  const thread = $('#thread')
  if (!thread) return
  threadScrollLastTop = thread.scrollTop
  threadScrollPinned = threadDistanceToBottom(thread) <= SCROLL_STICK_THRESHOLD
  if (threadScrollPinned) threadHasNewBelow = false
  updateScrollBottomButton()
}

function unpinThreadFromBottom() {
  threadScrollPinned = false
  queueScrollBottomButtonUpdate()
}

/** 用户正在看旧内容时只记录“下方有新内容”，不改变滚动位置。 */
function markThreadNewContent() {
  if (threadScrollPinned) return
  threadHasNewBelow = true
  queueScrollBottomButtonUpdate()
}

function updateScrollBottomButton() {
  const button = $('#scroll-bottom')
  if (!button) return
  // 贴底时内容增长可能让距离暂时变大，不能因此闪出按钮。
  button.hidden = threadScrollPinned
  button.classList.toggle('has-new', threadHasNewBelow)
  const label = threadHasNewBelow ? '有新内容，回到最新消息' : '回到最新消息'
  button.title = label
  button.setAttribute('aria-label', label)
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
  pinThreadToBottom()
  thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' })
  queueScrollBottomButtonUpdate()
}

function scrollThreadToBottomInstant() {
  const thread = $('#thread')
  if (!thread) return
  pinThreadToBottom()
  const previous = thread.style.scrollBehavior
  // 容器 CSS 是 smooth；切会话要“直接落在底部”，不能从顶部再滑过去。
  thread.style.scrollBehavior = 'auto'
  thread.scrollTop = thread.scrollHeight
  threadScrollLastTop = thread.scrollTop
  queueScrollBottomButtonUpdate()
  requestAnimationFrame(() => {
    if (!thread.isConnected) return
    thread.scrollTop = thread.scrollHeight
    threadScrollLastTop = thread.scrollTop
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
      // 多页澄清的中间答复/中间问题只用于续跑，不在聊天记录里显示。
      if (isHiddenClarifyStep(message)) continue
      appendMessage(
        message.role === 'user' ? 'me' : 'ai',
        message.text,
        message.role === 'assistant' && message.modelName ? message.modelName : undefined,
        message.meta && message.meta.attachments,
        message.role === 'assistant' ? message.meta : undefined,
        { scroll: false, prepend: true, channel: message.meta?.channel, messageId: message.id, createdAt: message.createdAt },
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
  if (!thread) return
  const top = thread.scrollTop
  const distance = threadDistanceToBottom(thread)
  // 程序滚动到底只会让 top 变大；top 变小说明用户主动上滚，立刻停止跟随。
  if (top < threadScrollLastTop - 1) {
    unpinThreadFromBottom()
  } else if (top > threadScrollLastTop + 1 && distance <= SCROLL_STICK_THRESHOLD) {
    // 用户向下滚到接近底部，或程序滚动落到底部时恢复跟随。
    pinThreadToBottom()
  }
  threadScrollLastTop = top
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
  hideSettings()
  setChatMode('chat')
  resetAgentRuns()
  if (state.messageEdit) cancelMessageEdit({ clearInput: true, silent: true })
  const seq = ++state.openSeq
  try {
    const data = await api(historyMessagesUrl(sessionId))
    if (seq !== state.openSeq) return
    state.sessionId = data.session.id
    state.view = 'chat'
    persistChatLocation()
    applySessionSpace(data.session)
    const sessionModelId = data.session.modelId || data.session.model_id || ''
    const sessionEffort = data.session.reasoningEffort || data.session.reasoning_effort || ''
    if (sessionModelId && state.models.some((model) => model.id === sessionModelId)) {
      setSelected(sessionModelId, { persist: false, reasoningEffort: sessionEffort })
    } else {
      setSelected('', { persist: false, reasoningEffort: sessionEffort })
      if (sessionModelId) banner('本会话原来使用的模型已不可用，已切回自动选择', 'warn')
    }
    state.historyBefore = Boolean(data.hasMore) ? data.nextBefore || null : null
    state.historyHasMore = Boolean(data.hasMore)
    state.historyLoading = false
    state.historyMessageIds.clear()
    markSessionReadLocally(data.session.id)
    renderSessions()
    $('#chat-title').textContent = data.session.title
    resetThread()
    const thread = $('#thread')
    const pendingClarify = trailingPendingClarify(data.messages)
    if (thread) thread.style.visibility = 'hidden'
    try {
      for (const message of data.messages) {
        if (message.id) state.historyMessageIds.add(message.id)
        // 多页澄清的中间答复/中间问题只用于续跑，不在聊天记录里显示。
        if (isHiddenClarifyStep(message)) continue
        appendMessage(
          message.role === 'user' ? 'me' : 'ai',
          message.text,
          message.role === 'assistant' && message.modelName ? message.modelName : undefined,
          message.meta && message.meta.attachments,
          message.role === 'assistant' ? message.meta : undefined,
          { scroll: false, channel: message.meta?.channel, pendingClarify: pendingClarify === message, messageId: message.id, createdAt: message.createdAt },
        )
      }
      if (data.messages.length > 0) {
        setEmptyVisible(false)
        scrollThreadToBottomInstant()
      }
    } finally {
      if (thread) thread.style.visibility = ''
    }
    attachLiveTurnForSession(data.session.id)
    if (pendingClarify?.meta?.clarify) {
      showClarifyDock(pendingClarify.meta.clarify, { flowMeta: pendingClarify.meta, auto: true })
    } else {
      clearClarifyDock()
    }
    renderSessions()
    renderQueueState()
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
  hideSettings()
  setChatMode('chat')
  if (state.messageEdit) cancelMessageEdit({ clearInput: true, silent: true })
  state.openSeq += 1
  state.sessionId = null
  setSelected('', { persist: false })
  resetAgentRuns()
  resetHistoryState()
  $('#chat-title').textContent = '新对话'
  resetThread()
  renderSessions()
  renderQueueState()
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

function hideMessageMenu() {
  const menu = $('#message-menu')
  if (!menu) return
  menu.hidden = true
  menu.dataset.message = ''
}

function showMessageMenu(node, x, y) {
  const menu = $('#message-menu')
  if (!menu || !node) return
  const data = node.chatMessage || null
  const id = String(data?.id || node.dataset.messageId || '')
  if (!id) return
  const role = data?.role === 'user' || node.classList.contains('me') ? 'user' : 'assistant'
  const text = String(data?.text || node.querySelector('.bubble')?.innerText || '').trim()
  const busy = sessionReplyBusy()
  const preview = text ? text.replace(/\s+/g, ' ').slice(0, 48) : role === 'user' ? '我的消息' : 'AI 回答'
  hideSessionMenu()
  hideFileMenu()
  menu.innerHTML = `<div class="session-menu-title">${esc(preview)}</div>
    ${
      role === 'user'
        ? `<button type="button" data-message-act="edit" ${busy ? 'disabled' : ''}>编辑后重发</button>
           <button type="button" data-message-act="recall" ${busy ? 'disabled' : ''}>撤回</button>`
        : ''
    }
    <button type="button" data-message-act="delete" class="is-danger" ${busy ? 'disabled' : ''}>删除</button>
    ${busy ? '<div class="session-menu-hint">回复结束后可操作</div>' : ''}`
  menu.dataset.message = id
  menu.hidden = false
  const box = menu.getBoundingClientRect()
  const left = Math.min(Math.max(8, x), window.innerWidth - box.width - 8)
  const top = Math.min(Math.max(8, y), window.innerHeight - box.height - 8)
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
}

function messageDeleteUrl(id, mode) {
  return qsAppend(`/api/chat/messages/${encodeURIComponent(id)}?mode=${encodeURIComponent(mode)}`)
}

async function deleteMessageApi(id, mode) {
  return api(messageDeleteUrl(id, mode), {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
}

function removeDeletedMessageNodes(ids) {
  const removed = new Set((ids || []).map((id) => String(id)))
  if (removed.size === 0) return
  const thread = $('#thread')
  if (thread) {
    for (const node of thread.querySelectorAll('.msg[data-message-id]')) {
      if (removed.has(String(node.dataset.messageId))) node.remove()
    }
  }
  for (const id of removed) {
    state.historyMessageIds.delete(id)
    state.liveTurns.delete(id)
    state.activeRunSnapshots.delete(id)
    state.localLiveMessageIds.delete(id)
  }
  const first = thread?.querySelector('.msg[data-message-id]')
  state.historyBefore = first?.dataset.messageId || null
  if (thread && !thread.querySelector('.msg')) setEmptyVisible(true)
  updateScrollBottomButton()
}

function renderMessageEditBar() {
  const bar = $('#message-edit-bar')
  if (!bar) return
  bar.hidden = !state.messageEdit
}

function cancelMessageEdit({ clearInput = false, silent = false } = {}) {
  const had = Boolean(state.messageEdit)
  state.messageEdit = null
  renderMessageEditBar()
  const input = $('#input')
  if (had && clearInput && input) {
    input.value = ''
    input.style.height = '44px'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  if (had && !silent) banner('已取消编辑')
}

function beginEditMessage(message) {
  const id = String(message?.id || '')
  const text = String(message?.text || '')
  if (!id) return
  if (sessionReplyBusy()) {
    banner('回复结束后再编辑消息', 'warn')
    return
  }
  state.messageEdit = { id, sessionId: state.sessionId, text }
  const input = $('#input')
  if (input) {
    input.value = text
    input.style.height = '44px'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
    input.setSelectionRange(text.length, text.length)
  }
  renderMessageEditBar()
}

async function recallMessage(message) {
  const id = String(message?.id || '')
  if (!id) return
  if (sessionReplyBusy()) {
    banner('回复结束后再撤回消息', 'warn')
    return
  }
  const confirmed = await openConfirmCard({
    eyebrow: '撤回消息',
    title: '撤回这条提问？',
    targetLabel: '消息',
    target: String(message.text || '').slice(0, 40),
    message: '撤回后会删除这条提问和紧随其后的回答，并把原文放回输入框；后续消息不会被删除。',
    confirmText: '撤回',
  })
  if (!confirmed) return
  try {
    const result = await deleteMessageApi(id, 'turn')
    removeDeletedMessageNodes(result.deletedIds)
    const input = $('#input')
    if (input) {
      input.value = String(message.text || '')
      input.style.height = '44px'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
    }
    banner('已撤回，原文已放回输入框', 'ok')
    void loadSessions()
  } catch (err) {
    banner(`撤回失败：${err.message}`, 'bad')
  }
}

async function deleteMessage(message) {
  const id = String(message?.id || '')
  if (!id) return
  if (sessionReplyBusy()) {
    banner('回复结束后再删除消息', 'warn')
    return
  }
  const isUser = message.role === 'user'
  const confirmed = await openConfirmCard({
    eyebrow: '删除消息',
    title: isUser ? '删除这条提问和回答？' : '删除这条回答？',
    targetLabel: isUser ? '提问' : '回答',
    target: String(message.text || '').slice(0, 40),
    message: isUser ? '会同时删除这条提问和紧随其后的回答；后续消息保留。' : '只删除这一条回答，不影响其它消息。',
  })
  if (!confirmed) return
  try {
    const result = await deleteMessageApi(id, isUser ? 'turn' : 'message')
    removeDeletedMessageNodes(result.deletedIds)
    banner('已删除消息', 'ok')
    void loadSessions()
  } catch (err) {
    banner(`删除失败：${err.message}`, 'bad')
  }
}

function handleMessageAction(action, message) {
  const act = String(action || '')
  if (!message?.id || !act) return
  if (act === 'edit') beginEditMessage(message)
  else if (act === 'recall') recallMessage(message)
  else if (act === 'delete') deleteMessage(message)
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
    syncSideSectionSplit()
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
  syncSideSectionSplit()
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

/* ---------------- 多 Agent 运行台 ---------------- */

function agentStatusText(status) {
  if (status === 'waiting') return '等待父 Agent 回答'
  if (status === 'done') return '已完成 · 待命'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  return '运行中'
}

function agentStatusClass(status) {
  if (status === 'waiting') return 'is-waiting'
  if (status === 'done') return 'is-done'
  if (status === 'failed') return 'is-failed'
  if (status === 'cancelled') return 'is-cancelled'
  return 'is-running'
}

/** 子 Agent 完成、且这么久没有新任务，就从团队栏注销（执行资源早已释放）。 */
const AGENT_TEAM_IDLE_MS = 120000

function syncWorkbenchLayout() {
  const rail = $('#workbench-rail')
  const teamPane = $('#team-pane')
  const filePane = $('#file-pane')
  const main = $('.chat-main')
  if (!rail || !teamPane || !filePane || !main) return

  const inChat = state.mode === 'chat'
  const hasTeam = inChat && state.agentRuns.size > 0
  const hasFile = inChat && Boolean(state.filePreview)
  rail.hidden = !(hasTeam || hasFile)

  // 当前面板没有内容时自动切到另一个，避免打开一个空白面板。
  if (state.workbenchTab === 'team' && !hasTeam && hasFile) state.workbenchTab = 'file'
  if (state.workbenchTab === 'file' && !hasFile && hasTeam) state.workbenchTab = 'team'

  const showTeam = hasTeam && (state.workbenchSplit || state.workbenchTab === 'team')
  const showFile = hasFile && (state.workbenchSplit || state.workbenchTab === 'file')
  teamPane.hidden = !showTeam
  filePane.hidden = !showFile
  $('#workbench-body')?.classList.toggle('is-split', state.workbenchSplit && showTeam && showFile)

  const tabs = $('#workbench-tabs')
  if (tabs) {
    tabs.hidden = !hasTeam && !hasFile
    tabs.querySelectorAll('[data-workbench-tab]').forEach((tab) => {
      const name = tab.getAttribute('data-workbench-tab')
      const available = name === 'team' ? hasTeam : hasFile
      tab.hidden = !available
      const selected = state.workbenchSplit || state.workbenchTab === name
      tab.classList.toggle('is-active', selected)
      tab.setAttribute('aria-selected', selected ? 'true' : 'false')
    })
    const count = $('#workbench-team-count')
    if (count) {
      const total = state.agentRuns.size
      count.hidden = total === 0
      count.textContent = String(total)
    }
    const split = $('#workbench-split')
    if (split) {
      split.hidden = !(hasTeam && hasFile)
      split.classList.toggle('is-active', state.workbenchSplit)
      split.setAttribute('aria-pressed', state.workbenchSplit ? 'true' : 'false')
    }
  }

  if (inChat) main.classList.toggle('is-split-preview', !rail.hidden)
  // 右栏（团队或文件）出现时就是可拖拽分栏，鼠标拖分界线即可改两边宽度。
  main.classList.toggle('is-workbench-open', !rail.hidden)
  main.classList.toggle('is-team-only', !rail.hidden && hasTeam && !hasFile)
  main.classList.toggle('is-team-file', !rail.hidden && hasTeam && hasFile)
  const resizer = $('#file-split-resizer')
  if (resizer) resizer.hidden = !(inChat && !rail.hidden)
}

function beginParentAgentTurn(runId) {
  const next = String(runId || '').trim()
  if (next) state.agentParentRunId = next
  const title = $('#chat-title')?.textContent?.trim()
  state.agentParentName = title && title !== '新对话' ? title : '当前对话'
  renderAgentDock()
}

/** 一次任务结束后安排注销：空闲期内没有新事件就把窗口移出团队。 */
function scheduleAgentRetire(childId, updatedAt) {
  const run = state.agentRuns.get(childId)
  if (!run) return
  if (run.retireTimer) clearTimeout(run.retireTimer)
  const wait = Math.max(0, updatedAt + AGENT_TEAM_IDLE_MS - Date.now())
  run.retireTimer = setTimeout(() => {
    const current = state.agentRuns.get(childId)
    if (!current) return
    if ((current.status || 'running') === 'running') return
    if (Date.now() - (current.updatedAt || 0) < AGENT_TEAM_IDLE_MS - 1000) {
      scheduleAgentRetire(childId, current.updatedAt || Date.now())
      return
    }
    state.agentRuns.delete(childId)
    renderAgentDock()
  }, wait)
}

function pushThreadEntry(thread, entry) {
  const last = thread[thread.length - 1]
  // 流式输出碎片合并成一条，避免每几个字一个气泡。
  if (entry.kind === 'content' && last && last.kind === 'content') {
    last.text = `${last.text}${entry.text}`
    return
  }
  thread.push(entry)
  if (thread.length > 200) thread.splice(0, thread.length - 200)
}

function updateAgentEvent(data) {
  if (!data || data.type !== 'agent' || !data.childId) return
  const previous = state.agentRuns.get(data.childId) || {}
  const thread = Array.isArray(previous.thread) ? previous.thread.slice() : []
  const next = {
    ...previous,
    childId: data.childId,
    key: data.key || previous.key || '',
    parentRunId: data.parentRunId || previous.parentRunId || '',
    runId: data.runId || previous.runId || '',
    agentId: data.agentId || previous.agentId || '',
    index: Number(data.index) || previous.index || state.agentRuns.size + 1,
    attempt: Number(data.attempt) || previous.attempt || 0,
    title: data.title || previous.title || '子 Agent',
    modelId: data.modelId || previous.modelId || '',
    modelName: data.modelName || previous.modelName || '',
    modelReason: data.modelReason || previous.modelReason || '',
    status: data.status === 'unregistered' ? 'done' : (data.status || previous.status || 'running'),
    assign: data.action === 'assign' ? String(data.text || '').slice(0, 600) : previous.assign || '',
    text: previous.text || '',
    steps: Array.isArray(previous.steps) ? previous.steps.slice() : [],
    thread,
    error: data.error || previous.error || '',
    durationMs: Number(data.durationMs) || previous.durationMs || 0,
    toolCount: Number.isFinite(Number(data.toolCount)) ? Number(data.toolCount) : (previous.toolCount || 0),
    updatedAt: Date.now(),
    retireTimer: previous.retireTimer,
  }

  if (data.action === 'assign') {
    pushThreadEntry(thread, { kind: 'assign', text: String(data.text || '（派发任务）'), at: Date.now() })
    // 新任务派下来 → 取消上一次的注销计划，并把窗口展开看过程。
    if (next.retireTimer) {
      clearTimeout(next.retireTimer)
      next.retireTimer = null
    }
    next.status = 'running'
  } else if (data.action === 'content') {
    next.text = `${next.text}${data.text || ''}`.slice(-4000)
    pushThreadEntry(thread, { kind: 'content', text: String(data.text || ''), at: Date.now() })
  } else if (data.action === 'report') {
    next.text = `${next.text}${next.text ? '\n' : ''}${data.text || ''}`.slice(-4000)
    pushThreadEntry(thread, { kind: 'report', text: String(data.text || ''), at: Date.now(), error: data.error || '' })
  } else if (data.action === 'question') {
    // 子 Agent 主动向父 Agent 提问：本轮暂停，等父 Agent 回复后继续。
    next.status = 'waiting'
    next.text = String(data.text || '').slice(0, 2400)
    pushThreadEntry(thread, { kind: 'question', text: next.text || '（需要父 Agent 回答）', at: Date.now() })
    if (next.retireTimer) {
      clearTimeout(next.retireTimer)
      next.retireTimer = null
    }
  } else if (data.action === 'done') {
    if (data.text) next.text = String(data.text).slice(0, 2400)
    next.status = data.status === 'unregistered' ? 'done' : (data.status || 'done')
    const last = thread[thread.length - 1]
    const plain = (value) => String(value || '').replace(/\s+/g, '').trim()
    // 流式正文已经展示过同一段最终答案时，不再追加一条重复气泡。
    if (last && last.kind === 'content' && data.text && plain(last.text) === plain(data.text)) {
      last.final = true
      last.status = next.status
    } else {
      pushThreadEntry(thread, {
        kind: 'done',
        text: String(data.text || data.error || (next.status === 'failed' ? '执行失败' : '任务完成')),
        at: Date.now(),
        status: next.status,
      })
    }
  }

  if (data.action === 'tool' && data.tool) {
    const stepId = String(data.tool.id || '')
    if (stepId && !next.steps.some((step) => step.id === stepId)) {
      next.steps.push({
        id: stepId,
        name: data.tool.name || data.tool.toolId || '工具调用',
        toolId: data.tool.toolId || '',
        status: 'running',
        summary: '',
        durationMs: 0,
      })
      pushThreadEntry(thread, {
        kind: 'tool',
        id: stepId,
        text: data.tool.name || data.tool.toolId || '工具调用',
        at: Date.now(),
        status: 'running',
      })
    }
  }
  if (data.action === 'tool_result' && data.tool) {
    const stepId = String(data.tool.id || '')
    const step = next.steps.find((item) => item.id === stepId)
    if (step) {
      step.status = data.status === 'failed' ? 'error' : 'done'
      step.summary = data.summary || ''
      step.durationMs = Number(data.durationMs) || 0
    }
    const entry = thread.find((item) => item.kind === 'tool' && item.id === stepId)
    if (entry) {
      entry.status = data.status === 'failed' ? 'error' : 'done'
      entry.summary = data.summary || ''
      entry.durationMs = Number(data.durationMs) || 0
    }
  }

  state.agentRuns.set(data.childId, next)
  // 新派发的子 Agent 直接成为详情窗口的焦点，用户不用再找
  if (
    data.action === 'assign' ||
    data.action === 'question' ||
    !state.agentSelectedId ||
    !state.agentRuns.has(state.agentSelectedId)
  ) {
    state.agentSelectedId = data.childId
  }
  renderAgentDock()
  if (data.action === 'done') scheduleAgentRetire(data.childId, next.updatedAt)
}

function agentThreadEntryHtml(entry) {
  const time = entry.at ? new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : ''
  if (entry.kind === 'assign') {
    return `<div class="agent-chat-row is-parent">
      <div class="agent-chat-main">
        <div class="agent-chat-meta"><span>父 Agent · 派发</span>${time ? `<time>${esc(time)}</time>` : ''}</div>
        <div class="agent-chat-bubble is-parent">${esc(entry.text)}</div>
      </div>
      <span class="agent-chat-avatar is-parent" aria-hidden="true">父</span>
    </div>`
  }
  if (entry.kind === 'question') {
    return `<div class="agent-chat-row is-agent">
      <span class="agent-chat-avatar is-agent" aria-hidden="true">子</span>
      <div class="agent-chat-main">
        <div class="agent-chat-meta"><span>子 Agent · 提问</span>${time ? `<time>${esc(time)}</time>` : ''}</div>
        <div class="agent-chat-bubble is-question">${esc(entry.text)}</div>
      </div>
    </div>`
  }
  if (entry.kind === 'report') {
    return `<div class="agent-chat-row is-agent">
      <span class="agent-chat-avatar is-agent" aria-hidden="true">子</span>
      <div class="agent-chat-main">
        <div class="agent-chat-meta"><span>子 Agent · 过程记录</span>${time ? `<time>${esc(time)}</time>` : ''}</div>
        <div class="agent-chat-bubble is-report${entry.error ? ' is-error' : ''}">${esc(entry.text)}</div>
      </div>
    </div>`
  }
  if (entry.kind === 'content') {
    const label = entry.final ? '子 Agent · 回报' : '子 Agent'
    return `<div class="agent-chat-row is-agent">
      <span class="agent-chat-avatar is-agent" aria-hidden="true">子</span>
      <div class="agent-chat-main">
        <div class="agent-chat-meta"><span>${label}</span>${time ? `<time>${esc(time)}</time>` : ''}</div>
        <div class="agent-chat-bubble is-agent${entry.final ? ' is-final' : ''}">${esc(entry.text)}</div>
      </div>
    </div>`
  }
  if (entry.kind === 'tool') {
    const mark = entry.status === 'error' ? '✕' : entry.status === 'running' ? '◐' : '✓'
    const detail = entry.summary || (entry.status === 'running' ? '执行中…' : '')
    const seconds = entry.durationMs > 0 ? ` · ${formatElapsed(entry.durationMs)}` : ''
    return `<div class="agent-chat-tool is-${entry.status === 'error' ? 'error' : entry.status === 'running' ? 'running' : 'done'}">
      <span class="agent-chat-tool-mark" aria-hidden="true">${mark}</span>
      <strong title="${esc(entry.text)}">${esc(entry.text)}</strong>
      <span title="${esc(detail)}">${esc(detail)}${seconds}</span>
    </div>`
  }
  if (entry.kind === 'done') {
    const label = entry.status === 'failed' ? '子 Agent · 失败' : entry.status === 'cancelled' ? '子 Agent · 已取消' : '子 Agent · 完成'
    return `<div class="agent-chat-row is-agent">
      <span class="agent-chat-avatar is-agent${entry.status === 'failed' ? ' is-error' : ''}" aria-hidden="true">子</span>
      <div class="agent-chat-main">
        <div class="agent-chat-meta"><span>${label}</span>${time ? `<time>${esc(time)}</time>` : ''}</div>
        <div class="agent-chat-bubble is-done${entry.status === 'failed' ? ' is-error' : ''}">${esc(entry.text || label)}</div>
      </div>
    </div>`
  }
  return ''
}

/** 列表行的短状态，详情里用完整文案 */
function agentStatusShort(status) {
  if (status === 'waiting') return '待回复'
  if (status === 'done') return '待命'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  return '运行中'
}

/** 团队列表里的一行：左边编号，右边标题 + 进度，状态靠右 */
function agentListRowHtml(run, selected) {
  const status = run.status || 'running'
  const time = run.durationMs ? formatElapsed(run.durationMs) : ''
  const meta = [run.key, `${run.toolCount || 0} 次工具`, time].filter(Boolean).join(' · ')
  return `<button class="agent-row ${agentStatusClass(status)}${selected ? ' is-selected' : ''}" type="button" role="listitem" data-agent-select="${esc(run.childId)}" aria-current="${selected ? 'true' : 'false'}" title="${esc(run.title)}">
    <span class="agent-row-index">${String(run.index || 1).padStart(2, '0')}</span>
    <span class="agent-row-body">
      <span class="agent-row-line">
        <strong class="agent-row-title">${esc(run.title)}</strong>
        <span class="agent-row-state"><span class="agent-status-dot" aria-hidden="true"></span>${agentStatusShort(status)}</span>
      </span>
      <span class="agent-row-meta">${esc(meta)}</span>
    </span>
  </button>`
}

/** 右侧预览：一个子 Agent 与父 Agent 的对话流，父右子左。 */
function agentDetailHtml(run) {
  const status = run.status || 'running'
  const thread = (run.thread || []).map(agentThreadEntryHtml).join('')
  const model = run.modelName || run.modelId || '自动分配'
  const key = run.key || ''
  const facts = [
    `<span class="agent-chat-fact" title="${esc(run.modelReason || '')}"><b>${esc(model)}</b></span>`,
    `<span class="agent-chat-fact">${Number(run.toolCount) || 0} 次工具</span>`,
    run.durationMs ? `<span class="agent-chat-fact">${formatElapsed(run.durationMs)}</span>` : '',
  ].filter(Boolean).join('')
  const hint = status === 'waiting'
    ? '子 Agent 正在等父 Agent 回答'
    : status === 'running'
      ? '子 Agent 正在工作，过程会实时出现在这里'
      : '本轮结束；继续对话会复用这个子 Agent 的上下文'
  return `<article class="agent-chat-panel ${agentStatusClass(status)}" data-agent-child="${esc(run.childId)}" aria-label="${esc(run.title)}，${agentStatusText(status)}">
    <header class="agent-chat-head">
      <div class="agent-chat-head-main">
        <span class="agent-chat-index">AGENT ${String(run.index || 1).padStart(2, '0')}</span>
        <strong class="agent-chat-title" title="${esc(run.title)}">${esc(run.title)}</strong>
        ${key ? `<span class="agent-chat-key" title="父 Agent 用这个 key 继续对话">${esc(key)}</span>` : ''}
      </div>
      <span class="agent-chat-state"><span class="agent-status-dot" aria-hidden="true"></span>${agentStatusText(status)}</span>
    </header>
    <div class="agent-chat-facts">${facts}</div>
    <div class="agent-chat-thread" role="log" aria-live="polite">
      ${thread || `<p class="agent-chat-placeholder">${status === 'running' ? '等待子 Agent 的第一条消息…' : '还没有对话记录。'}</p>`}
    </div>
    <footer class="agent-chat-foot">
      <span class="agent-chat-hint">${esc(hint)}</span>
      ${run.error ? `<span class="agent-chat-error" title="${esc(run.error)}">${esc(run.error)}</span>` : ''}
      ${status === 'running' || status === 'waiting' ? '' : `<button class="agent-chat-continue" type="button" data-agent-continue="${esc(key)}" title="让父 Agent 继续和这个子 Agent 对话">继续对话</button>`}
    </footer>
  </article>`
}

function renderAgentDock() {
  const pane = $('#team-pane')
  const list = $('#team-list')
  const detail = $('#team-detail')
  const split = $('#team-split')
  const summary = $('#team-summary')
  if (!pane || !list || !detail) return
  const runs = [...state.agentRuns.values()].sort((a, b) => (a.index || 0) - (b.index || 0))
  const empty = $('#team-empty')
  if (empty) empty.hidden = runs.length > 0
  if (split) split.hidden = runs.length === 0
  if (runs.length === 0) {
    state.agentSelectedId = ''
    list.innerHTML = ''
    detail.innerHTML = ''
    if (summary) summary.textContent = '等待派发'
  } else {
    const active = runs.filter((run) => (run.status || 'running') === 'running').length
    const waiting = runs.filter((run) => run.status === 'waiting').length
    if (summary) {
      summary.textContent = waiting > 0
        ? `${active} 工作中 · ${waiting} 待回答 · 共 ${runs.length} 个`
        : active > 0
          ? `${active} 工作中 · 共 ${runs.length} 个子 Agent`
          : `${runs.length} 个子 Agent · 已全部完成`
    }
    const parent = $('#team-manager-name')
    if (parent) parent.textContent = `父 Agent · ${state.agentParentName || '当前对话'}`
    // 选中项失效（被注销）时回落到运行中的第一个，否则第一个
    const previousSelectedId = state.agentSelectedId
    let selected = runs.find((run) => run.childId === state.agentSelectedId)
    if (!selected) {
      selected = runs.find((run) => (run.status || 'running') === 'running')
        || runs.find((run) => run.status === 'waiting')
        || runs[0]
      state.agentSelectedId = selected.childId
    }
    // 切到别的 Agent 时从顶部读，避免沿用上一个窗口的滚动位置
    const scrollTop = selected.childId === previousSelectedId ? detail.scrollTop : 0
    list.innerHTML = runs.map((run) => agentListRowHtml(run, run.childId === selected.childId)).join('')
    detail.innerHTML = agentDetailHtml(selected)
    detail.scrollTop = scrollTop
  }
  syncWorkbenchLayout()
}

function resetAgentRuns() {
  for (const run of state.agentRuns.values()) {
    if (run.retireTimer) clearTimeout(run.retireTimer)
  }
  state.agentRuns.clear()
  state.agentSelectedId = ''
  state.agentParentRunId = ''
  state.agentParentName = ''
  renderAgentDock()
}

/* ---------------- 个人工作区：右侧文件预览与编辑 ---------------- */

let workspacePreviewText = ''
let workspacePreviewTextLoaded = false
let workspacePreviewObjectUrl = ''
let workspacePreviewSaving = false
let workspacePreviewToken = 0
/** 模型正在生成的文件内容草稿；只在右侧预览层展示，不参与磁盘写入。 */
let fileStreamDraft = null
/** 当前预览的字符揭示动画；tool 参数一次性到达时也保留打字机可见性。 */
let fileStreamReveal = null
let onlyOfficeScriptPromise = null
let onlyOfficeEditor = null
let onlyOfficeMode = 'view'
/** 编辑态收到云端新版本时，警告条绑定的文件 id；空表示没有待刷新提示。 */
let filePaneSyncFileId = ''

function isOfficeLike(file) {
  return /\.(docx?|docm|dotx?|rtf|xlsx?|xlsm|xltx?|pptx?|pptm|potx?|odt|ods|odp|ott|ots|otp)$/i.test(
    file?.name || '',
  )
}

function destroyOnlyOfficeEditor() {
  if (onlyOfficeEditor) {
    try {
      onlyOfficeEditor.destroyEditor()
    } catch {
      /* 编辑器已经关闭或脚本还没完成初始化 */
    }
    onlyOfficeEditor = null
  }
}

function loadOnlyOfficeApi(scriptUrl) {
  if (window.DocsAPI) return Promise.resolve()
  if (onlyOfficeScriptPromise) return onlyOfficeScriptPromise
  onlyOfficeScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = scriptUrl
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      onlyOfficeScriptPromise = null
      reject(new Error('OnlyOffice 脚本加载失败，请检查文档服务地址'))
    }
    document.head.appendChild(script)
  })
  return onlyOfficeScriptPromise
}

async function openWorkspaceOffice(file, mode) {
  const token = workspacePreviewToken
  const owner = file.ownerUserId === state.me?.person?.id
  destroyOnlyOfficeEditor()
  filePaneMessage(mode === 'edit' ? '正在准备编辑…' : '正在加载文档…')
  try {
    const result = await api(
      qsAppend(`/api/workspace/files/${encodeURIComponent(file.id)}/office-config?mode=${mode === 'edit' ? 'edit' : 'view'}`),
    )
    if (token !== workspacePreviewToken || state.filePreview?.id !== file.id) return
    if (!result?.configured) {
      filePaneMessage(result?.reason || 'OnlyOffice 文档服务未配置')
      return
    }
    const holder = document.createElement('div')
    holder.id = 'onlyoffice-editor'
    holder.className = 'onlyoffice-editor'
    setFilePaneBody(holder)
    await loadOnlyOfficeApi(result.scriptUrl)
    if (token !== workspacePreviewToken || state.filePreview?.id !== file.id) return
    onlyOfficeMode = result.mode
    onlyOfficeEditor = new window.DocsAPI.DocEditor('onlyoffice-editor', result.config)
    const edit = $('#file-pane-edit')
    if (edit) {
      edit.hidden = !owner
      edit.textContent = onlyOfficeMode === 'edit' ? '预览' : '编辑'
      edit.title = onlyOfficeMode === 'edit' ? '切换为只读预览' : '在线编辑并保存回云空间'
    }
  } catch (err) {
    if (token !== workspacePreviewToken) return
    filePaneMessage(`文档服务加载失败：${err.message}`, 'bad')
  }
}


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
  hidePreviewSelection()
}

function hideFilePaneSyncNotice() {
  filePaneSyncFileId = ''
  const notice = $('#file-pane-sync-notice')
  if (notice) notice.hidden = true
  const text = $('#file-pane-sync-text')
  if (text) text.textContent = ''
}

function showFilePaneSyncNotice(fileId, message) {
  const notice = $('#file-pane-sync-notice')
  const text = $('#file-pane-sync-text')
  if (!notice || !text) return
  filePaneSyncFileId = fileId || ''
  text.textContent = message
  notice.hidden = false
  const button = $('#file-pane-refresh')
  if (button) {
    button.disabled = false
    button.textContent = '刷新到云端版本'
  }
}

async function refreshFilePaneToCloudVersion() {
  const fileId = filePaneSyncFileId || String(state.filePreview?.id || '')
  if (!fileId) return
  const file = state.files.find((item) => item.id === fileId)
  const name = file?.name ? `《${file.name}》` : '当前文档'
  const confirmed = window.confirm(
    `刷新到云端版本会关闭 ${name} 当前编辑器，编辑器里还没保存的修改不会合并，会直接丢失。\n\n` +
      '请先点插件“保存到云空间”，或撤销未保存的修改，再刷新。\n\n' +
      '确定现在放弃当前编辑内容并刷新到云端版本吗？',
  )
  if (!confirmed) return
  const button = $('#file-pane-refresh')
  if (button) {
    button.disabled = true
    button.textContent = '正在刷新…'
  }
  try {
    // 先抬高刷新水位：关闭旧编辑器触发的保存回调若仍是旧版本，服务端会丢弃，
    // 避免旧内容覆盖刚多出来的云端版本。
    await api(`/api/workspace/office/${encodeURIComponent(fileId)}/refresh-guard`, {
      method: 'POST',
    })
    hideFilePaneSyncNotice()
    await loadWorkspaceFiles()
    const latest = state.files.find((item) => item.id === fileId)
    if (!latest) {
      closeWorkspaceFile()
      banner('文件已不存在，无法刷新到云端版本', 'bad')
      return
    }
    await openWorkspaceFile(fileId, { mode: 'edit' })
    banner('已刷新到云端版本', 'ok')
  } catch (err) {
    banner(`刷新到云端版本失败：${err.message}`, 'bad')
  } finally {
    if (button) {
      button.disabled = false
      button.textContent = '刷新到云端版本'
    }
  }
}

function hidePreviewSelection() {
  state.previewSelection = null
  const button = $('#file-selection-action')
  if (button) button.hidden = true
}

/**
 * 普通文本/表格预览在父页面 DOM 内，可以直接读取 selection；
 * OnlyOffice 在跨域 iframe 里，父页面拿不到它内部的选区，因此这里只对本地预览生效。
 */
function refreshPreviewSelection() {
  const body = $('#file-pane-body')
  const button = $('#file-selection-action')
  const file = state.filePreview
  if (!body || !button || !file) {
    hidePreviewSelection()
    return
  }
  const selection = window.getSelection()
  const text = String(selection?.toString?.() || '').replace(/\s+/g, ' ').trim()
  const anchor = selection?.anchorNode
  if (!text || !anchor || !body.contains(anchor)) {
    hidePreviewSelection()
    return
  }
  state.previewSelection = { fileId: file.id, fileName: file.name, text: text.slice(0, 800) }
  button.hidden = false
  button.textContent = '引用选中内容并修改'
}

function quotePreviewSelection() {
  const selected = state.previewSelection
  const input = $('#input')
  if (!selected || !input) return
  if (state.mode !== 'chat') {
    setChatMode('chat')
    if (state.filePreview?.id) void openWorkspaceFile(state.filePreview.id, { split: true })
  }
  const truncated = String(selected.text).length >= 800 ? '\n（选中的内容较长，已截取前 800 字）' : ''
  input.value = `请修改《${selected.fileName}》中的这段内容：\n"""${selected.text}"""${truncated}\n\n修改要求：`
  input.style.height = '44px'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.focus()
  const end = input.value.length
  input.setSelectionRange(end, end)
  hidePreviewSelection()
  const selection = window.getSelection()
  selection?.removeAllRanges?.()
}

function releaseWorkspacePreviewUrl() {
  if (workspacePreviewObjectUrl) {
    URL.revokeObjectURL(workspacePreviewObjectUrl)
    workspacePreviewObjectUrl = ''
  }
}

function previewKindForFile(file) {
  if (isOfficeLike(file)) return 'office'
  if (isTextLike(file)) return 'text'
  if (isImageLike(file)) return 'image'
  if (isPdfLike(file)) return 'pdf'
  return 'none'
}

async function fetchPreviewCapability(file) {
  try {
    return await api(`/api/workspace/files/${encodeURIComponent(file.id)}/preview-capability`)
  } catch {
    // 老服务或网络抖动时退回本地类型判断，打开失败由现有错误提示兜住。
    return null
  }
}

/** 本轮要上报的「右侧预览文件」：没有打开预览时返回 undefined，服务端据此忽略。 */
function activePreviewFilePayload() {
  const file = state.filePreview
  if (!file || state.mode !== 'chat') return undefined
  return {
    id: String(file.id || ''),
    name: String(file.name || ''),
    relPath: file.relPath ? String(file.relPath) : undefined,
  }
}

async function openWorkspaceFile(id, options = {}) {
  const file = state.files.find((item) => item.id === id)
  if (!file) {
    banner('文件已不存在，列表可能刚被刷新', 'bad')
    await loadWorkspaceFiles()
    return
  }
  const requestSeq = ++workspacePreviewToken
  const capability = await fetchPreviewCapability(file)
  if (requestSeq !== workspacePreviewToken) return
  const kind = capability?.kind || previewKindForFile(file)
  if (kind === 'none') {
    // 没有可用预览能力时不创建面板，也不让右栏出现空白占位。
    banner(capability?.reason || `《${file.name}》暂不支持在线预览，请下载后查看。`, 'warn')
    return
  }
  if (fileStreamDraft && fileStreamDraft.fileId !== file.id) finishStreamingFilePreview()
  releaseWorkspacePreviewUrl()
  destroyOnlyOfficeEditor()
  hideFilePaneSyncNotice()
  const token = requestSeq
  const split = state.mode === 'chat' && options.split !== false
  state.filePreview = file
  workspacePreviewText = ''
  workspacePreviewTextLoaded = false
  hidePreviewSelection()
  const pane = $('#file-pane')
  pane.hidden = false
  suppressFileDockForPreview()
  const chatMain = $('.chat-main')
  chatMain.classList.add('is-file-preview')
  chatMain.classList.toggle('is-split-preview', split)
  if (split) restoreFileSplitRatio()
  syncWorkbenchLayout()
  // 对话内预览保留左栏对话和输入区，只把右侧让给文件；工作台/窄屏仍走整页预览。
  $('#thread').hidden = !split
  $('#workspace-pane').hidden = true
  $('.composer').hidden = !split
  $('#file-pane-editor').hidden = true
  $('#file-pane-body').hidden = false
  $('#file-pane-kicker').textContent = split ? '对话内预览' : '云空间'
  $('#file-pane-name').textContent = file.name
  const meta = [fmtSize(file.size), `更新于 ${workspaceFileDate(file.updatedAt)}`, file.shared ? '共享文件' : '个人文件', file.relPath]
  $('#file-pane-meta').textContent = meta.filter(Boolean).join(' · ')
  if (!split) $('#chat-title').textContent = `云空间 · ${file.name}`
  else $('#chat-title').textContent = state.sessionId ? '对话' : '新对话'
  const owner = file.ownerUserId === state.me?.person?.id
  $('#file-pane-rename').hidden = true
  $('#file-pane-edit').hidden = true
  $('#file-pane-edit').textContent = '编辑'
  $('#file-pane-edit').title = '编辑文件内容'
  $('#file-pane-delete').hidden = !owner
  $('#file-pane-download').hidden = false
  $('#file-pane-send-dingtalk').hidden = false
  renderWorkspaceFiles()
  if (isOfficeLike(file)) {
    await openWorkspaceOffice(file, options.mode === 'edit' ? 'edit' : 'view')
    return
  }
  filePaneMessage('正在读取文件…')
  try {
    const response = await fetch(workspaceFileUrl(file), { credentials: 'same-origin' })
    if (response.status === 401) {
      redirectToLogin()
      return waitForLoginRedirect()
    }
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
      const liveDraft = fileStreamDraft && fileStreamDraft.fileId === file.id ? fileStreamDraft : null
      const shownText = liveDraft ? liveDraft.text : text
      workspacePreviewText = shownText
      workspacePreviewTextLoaded = true
      const pre = document.createElement('pre')
      pre.className = `file-text-view${liveDraft ? ' is-streaming' : ''}`
      pre.textContent = shownText || '（空文件）'
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

function updateFileFullscreenButton() {
  const pane = $('#file-pane')
  const button = $('#file-pane-fullscreen')
  if (!button) return
  const active = Boolean(
    pane && (document.fullscreenElement === pane || document.body.classList.contains('is-file-preview-fullscreen')),
  )
  button.classList.toggle('is-active', active)
  button.setAttribute('aria-pressed', String(active))
  button.title = active ? '退出全屏预览' : '全屏预览'
  button.setAttribute('aria-label', active ? '退出全屏预览' : '全屏预览')
  const label = $('#file-pane-fullscreen-label')
  if (label) label.textContent = active ? '退出全屏' : '全屏'
}

async function exitFilePreviewFullscreen() {
  const pane = $('#file-pane')
  document.body.classList.remove('is-file-preview-fullscreen')
  if (pane && document.fullscreenElement === pane && document.exitFullscreen) {
    try {
      await document.exitFullscreen()
    } catch {
      /* 浏览器可能已经退出全屏 */
    }
  }
  updateFileFullscreenButton()
}

async function toggleFilePreviewFullscreen() {
  const pane = $('#file-pane')
  if (!pane || pane.hidden) return
  if (document.fullscreenElement === pane) {
    await exitFilePreviewFullscreen()
    return
  }
  if (document.body.classList.contains('is-file-preview-fullscreen')) {
    await exitFilePreviewFullscreen()
    return
  }
  document.body.classList.add('is-file-preview-fullscreen')
  updateFileFullscreenButton()
}

function closeWorkspaceFile() {
  void exitFilePreviewFullscreen()
  finishStreamingFilePreview()
  workspacePreviewToken += 1
  state.filePreview = null
  workspacePreviewText = ''
  workspacePreviewTextLoaded = false
  releaseWorkspacePreviewUrl()
  destroyOnlyOfficeEditor()
  hideFilePaneSyncNotice()
  $('#file-pane').hidden = true
  $('#file-split-resizer').hidden = true
  $('.chat-main').classList.remove('is-file-preview')
  hidePreviewSelection()
  $('#file-pane-editor').hidden = true
  $('#file-pane-rename').hidden = true
  $('#file-pane-body').hidden = false
  $('#file-pane-body').innerHTML = ''
  $('#thread').hidden = state.mode !== 'chat'
  $('.composer').hidden = state.mode !== 'chat'
  $('#workspace-pane').hidden = state.mode !== 'workspace'
  $('#chat-title').textContent = state.mode === 'workspace' ? '工作台' : state.sessionId ? '对话' : '新对话'
  syncWorkbenchLayout()
  renderWorkspaceFiles()
  restoreFileDockAfterPreview()
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

async function downloadWorkspaceFile(file) {
  const response = await fetch(workspaceFileUrl(file), { credentials: 'same-origin' })
  if (response.status === 401) {
    redirectToLogin()
    return waitForLoginRedirect()
  }
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`)
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function downloadWorkspacePreview() {
  const file = state.filePreview
  if (!file) return
  downloadWorkspaceFile(file).catch((err) => banner(err.message, 'bad'))
}

/** 右侧工作台：团队 / 文件 / 并排。两个面板同级，团队不在文件预览里面。 */
function bindWorkbenchTabs() {
  const tabs = $('#workbench-tabs')
  if (tabs) {
    tabs.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-workbench-tab]')
      if (!tab) return
      state.workbenchSplit = false
      state.workbenchTab = tab.getAttribute('data-workbench-tab') === 'file' ? 'file' : 'team'
      syncWorkbenchLayout()
    })
  }
  $('#workbench-split')?.addEventListener('click', () => {
    state.workbenchSplit = !state.workbenchSplit
    syncWorkbenchLayout()
  })
  // 子 Agent 列表：点哪一行，右边的详情窗口就切到哪个 Agent 的工作过程。
  $('#team-list')?.addEventListener('click', (event) => {
    const row = event.target.closest('[data-agent-select]')
    if (!row) return
    const childId = row.getAttribute('data-agent-select') || ''
    if (!state.agentRuns.has(childId)) return
    state.agentSelectedId = childId
    renderAgentDock()
  })
  // 「继续派活」：把这个子 Agent 的 key 写进输入框，父 Agent 拿到后就会用 agent_task 复用它
  $('#team-detail')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-agent-continue]')
    if (!button) return
    const key = button.getAttribute('data-agent-continue') || ''
    const input = $('#input')
    if (!input) return
    const prefix = key ? `让子 Agent「${key}」继续做：` : '让刚才的子 Agent 继续做：'
    if (!input.value.trim()) input.value = prefix
    else if (!input.value.includes(key)) input.value = `${prefix}${input.value}`
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function bindWorkspaceFilePane() {
  $('#file-pane-close')?.addEventListener('click', closeWorkspaceFile)
  $('#file-pane-download')?.addEventListener('click', downloadWorkspacePreview)
  $('#file-pane-refresh')?.addEventListener('click', () => {
    void refreshFilePaneToCloudVersion()
  })
  window.addEventListener('message', (event) => {
    // OnlyOffice 插件嵌在文档服务器里，跨域不能直接调用 EAB；令牌过期时由它
    // 请求顶层页面重新打开当前预览，保存成功时由它请求刷新为查看态。
    const messageType = event.data && event.data.type
    if (messageType !== 'eab:onlyoffice:reopen' && messageType !== 'eab:onlyoffice:saved') return
    let origin
    try {
      origin = new URL(event.origin)
    } catch {
      return
    }
    const expectedPort = window.location.port || (window.location.protocol === 'https:' ? '443' : '80')
    if (origin.port !== expectedPort) return
    const file = state.filePreview
    if (!file || !isOfficeLike(file)) return
    if (messageType === 'eab:onlyoffice:saved') {
      if (String(event.data.fileId || '') !== String(file.id)) return
      refreshWorkspaceAfterPluginSave(file, event.data)
      return
    }
    const mode = onlyOfficeMode === 'edit' ? 'edit' : 'view'
    const reopen = async () => {
      await loadWorkspaceFiles()
      const latest = state.files.find((item) => item.id === file.id)
      if (!latest) {
        banner('文件已不存在，无法重新打开预览', 'bad')
        return
      }
      return openWorkspaceFile(latest.id, { mode }).catch((err) =>
        banner(`重新打开预览失败：${err.message}`, 'bad'),
      )
    }
    if (mode !== 'edit') {
      void reopen()
      return
    }
    // 与 S3 刷新共用同一水位保护：关闭旧编辑器前先抬高 cutoff，
    // 旧会话即使因关闭触发保存回调，也不能覆盖云端新版本。
    void api(`/api/workspace/office/${encodeURIComponent(file.id)}/refresh-guard`, {
      method: 'POST',
    })
      .then(reopen)
      .catch((err) => banner(`重新打开预览失败：${err.message}`, 'bad'))
  })
  $('#file-pane-fullscreen')?.addEventListener('click', () => {
    void toggleFilePreviewFullscreen()
  })
  document.addEventListener('fullscreenchange', updateFileFullscreenButton)
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (!document.body.classList.contains('is-file-preview-fullscreen')) return
    document.body.classList.remove('is-file-preview-fullscreen')
    updateFileFullscreenButton()
  })
  $('#file-pane-send-dingtalk')?.addEventListener('click', () => {
    const file = state.filePreview
    if (file && file.id) sendWorkspaceFileToDingTalk(file)
  })
  $('#file-pane-edit')?.addEventListener('click', () => {
    const file = state.filePreview
    if (!file) return
    if (isOfficeLike(file)) {
      openWorkspaceOffice(file, onlyOfficeMode === 'edit' ? 'view' : 'edit')
      return
    }
    beginWorkspaceEdit()
  })
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
      <div class="hint">只有确认过的记忆会进入对话上下文；模型可提交团队学习候选，但需要管理员确认后才会全公司生效。</div>
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

/** 顶部标题跟随当前页面：工作台显示「工作台」，对话显示会话标题（没有就显示 对话 / 新对话） */
function syncChatTitle() {
  const el = $('#chat-title')
  if (!el) return
  if (state.mode === 'workspace') {
    el.textContent = '工作台'
    return
  }
  const sessions = Array.isArray(state.sessions) ? state.sessions : []
  const current = state.sessionId ? sessions.find((item) => item.id === state.sessionId) : null
  el.textContent = (current && current.title) || (state.sessionId ? '对话' : '新对话')
}

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
    syncChatTitle()
    if (state.workspaceKind === 'skills') loadMySkills()
    else loadMyPlugins()
  } else {
    syncChatTitle()
    syncThreadScrollState()
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
    warmMyPluginKernel(data)
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

/** 个人插件操作按当前账号角色授权；权限数据未加载时先按锁定处理。 */
function myPluginCan(action) {
  return state.pluginData?.permissions?.[action] === true
}

function myPluginLockedNote(action) {
  const labels = { install: '安装个人插件', configure: '启停个人插件', uninstall: '卸载个人插件' }
  return `<div class="plugin-note plugin-permission-note">当前账号的角色没有「${labels[action] || action}」权限，操作已锁定；请联系管理员在控制台「角色管理」里授权。</div>`
}

function myPluginStatusPill(plugin) {
  const status = myPluginStatus(plugin)
  return `<span class="pill ${status.tone}">${esc(status.label)}</span>`
}

function myPluginSourceLabel(plugin) {
  return MY_PLUGIN_SOURCE_LABEL[plugin.install?.source] || plugin.install?.source || '个人安装'
}

let myPluginKernelWarmStarted = false
const prefetchedMyPluginAssets = new Set()

/** 个人插件 client bundle 的稳定 URL；v= 版本、h= 校验和，同版本覆盖更新也能失效。 */
function myPluginClientAssetUrl(plugin, page) {
  const path = String(page.file || '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  const version = encodeURIComponent(plugin.version || '')
  const checksum = encodeURIComponent(plugin.checksum || '')
  const versionKey = version ? `&v=${version}` : ''
  const checksumKey = checksum ? `&h=${checksum}` : ''
  return `/plugins/assets/${encodeURIComponent(plugin.id)}/${path}?scope=user${versionKey}${checksumKey}`
}

function prefetchMyPluginClientBundles(plugins) {
  for (const plugin of plugins || []) {
    if (!plugin.valid || !plugin.enabled) continue
    for (const page of plugin.pages || []) {
      if ((page.kind || 'html') !== 'dsh-client') continue
      const url = myPluginClientAssetUrl(plugin, page)
      if (prefetchedMyPluginAssets.has(url)) continue
      prefetchedMyPluginAssets.add(url)
      fetch(url, { credentials: 'include', cache: 'force-cache' }).catch(() => {})
    }
  }
}

function warmMyPluginKernel(data) {
  if (!data || !data.companyId) return
  const run = () => {
    // 共享内核只启动一次；每轮个人插件列表刷新只补拉新增/升级的 bundle。
    if (!myPluginKernelWarmStarted) {
      myPluginKernelWarmStarted = true
      const frame = document.createElement('iframe')
      const params = new URLSearchParams({ warm: '1', scope: 'user', company: data.companyId || '' })
      if (currentAs()) params.set('as', currentAs())
      frame.src = `/plugin-kernel.html?${params.toString()}`
      frame.title = 'DSH 插件内核预热'
      frame.tabIndex = -1
      frame.setAttribute('aria-hidden', 'true')
      frame.style.cssText = 'position:absolute;width:1px;height:1px;left:-10px;top:-10px;opacity:0;pointer-events:none;border:0'
      let cleaned = false
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        frame.remove()
        window.removeEventListener('message', onMessage)
      }
      const onMessage = (event) => {
        if (event.origin !== location.origin) return
        if (event.source !== frame.contentWindow) return
        if (event.data && event.data.type === 'eab-plugin-kernel-warm') cleanup()
      }
      window.addEventListener('message', onMessage)
      frame.addEventListener('load', () => setTimeout(cleanup, 8000), { once: true })
      document.body.appendChild(frame)
    }

    prefetchMyPluginClientBundles(data.plugins || [])
  }
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 2000 })
  else setTimeout(run, 800)
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
    if (plugin.checksum) params.set('h', plugin.checksum)
    if (currentAs()) params.set('as', currentAs())
    return `/plugin-kernel.html?${params.toString()}`
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
  return `<div class="plugin-rail-top">
      <div class="plugin-scope-block">
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
        <button class="btn primary sm" type="button" data-my-plugin-install ${myPluginCan('install') ? '' : 'disabled title="当前角色没有安装个人插件权限"'}>＋ 安装插件</button>
        <button class="btn ghost sm" type="button" data-my-plugin-refresh>刷新</button>
      </div>
    </div>
    <div class="plugin-rail-head">已安装 <span class="muted">${plugins.length}</span><span class="plugin-rail-head-hint" title="点击卡片切换下方详情" aria-label="点击卡片切换下方详情"><svg aria-hidden="true" width="10" height="10" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.2"/><path d="M8 7.4v3.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="4.6" r=".9" fill="currentColor"/></svg></span></div>
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
        <div><span>对话模型</span><strong>${tools.length ? `${tools.length} 个工具 · ${tools.filter((tool) => tool.available).length} 个已授权` : '没有工具，只提供页面'}</strong></div>
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
      <button class="btn primary sm" type="button" data-my-plugin-toggle data-next-enabled="1" ${myPluginCan('configure') ? '' : 'disabled title="当前角色没有启停个人插件权限"'}>启用插件</button>
    </div>${myPluginCan('configure') ? '' : myPluginLockedNote('configure')}`
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
      <button class="btn primary sm" type="button" data-my-plugin-toggle data-next-enabled="1" ${myPluginCan('configure') ? '' : 'disabled title="当前角色没有启停个人插件权限"'}>启用插件</button>
    </div>${myPluginCan('configure') ? '' : myPluginLockedNote('configure')}`
  }
  if (!tools.length) {
    return `<div class="plugin-note">这个插件没有注册工具；它的能力可能在页面里，或者只提供宿主通道。</div>`
  }
  return `<div class="plugin-note">这些是你个人安装的插件注册的工具，只有你能看到、也只有你能用，不需要角色授权。停用或卸载个人安装后会从你的个人工具集移除；公司级安装的同一插件不受影响。</div>
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
              <div class="ws-tool-head"><code>${esc(tool.name)}</code><span class="pill ${tool.available ? 'ok' : 'warn'}">${tool.available ? '本人可用' : '当前账号不可用'}</span></div>
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
      <button class="btn ${plugin.enabled ? 'ghost' : 'primary'} sm" type="button" data-my-plugin-toggle data-next-enabled="${plugin.enabled ? '0' : '1'}" ${myPluginCan('configure') ? '' : 'disabled title="当前角色没有启停个人插件权限"'}>${plugin.enabled ? '停用' : '启用'}</button>
    </div>
    ${myPluginCan('configure') ? '' : myPluginLockedNote('configure')}
    ${hostBlock}
    <div class="plugin-danger-zone">
      <div><strong>卸载个人插件</strong><span>只解除你自己的安装。公司级安装和别人的工作台不受影响。</span></div>
      <button class="btn ghost sm danger-text" type="button" data-my-plugin-uninstall ${myPluginCan('uninstall') ? '' : 'disabled title="当前角色没有卸载个人插件权限"'}>卸载…</button>
    </div>
    ${myPluginCan('uninstall') ? '' : myPluginLockedNote('uninstall')}`
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
  const lockedActions = [
    myPluginCan('configure') ? '' : '启停个人插件',
    myPluginCan('uninstall') ? '' : '卸载个人插件',
  ].filter(Boolean)
  const permissionNote = lockedActions.length
    ? `<div class="plugin-note plugin-permission-note">当前账号的角色没有「${lockedActions.join('」「')}」权限，相关按钮已锁定；请联系管理员在控制台「角色管理」里授权。</div>`
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
        <button class="btn ghost sm" type="button" data-my-plugin-toggle data-next-enabled="${plugin.enabled ? '0' : '1'}" ${myPluginCan('configure') ? '' : 'disabled title="当前角色没有启停个人插件权限"'}>${plugin.enabled ? '停用' : '启用'}</button>
        <button class="btn ghost sm danger-text" type="button" data-my-plugin-uninstall ${myPluginCan('uninstall') ? '' : 'disabled title="当前角色没有卸载个人插件权限"'}>卸载…</button>
      </div>
    </div>
    ${permissionNote}
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
      <button class="btn primary" type="button" data-my-plugin-install ${myPluginCan('install') ? '' : 'disabled title="当前角色没有安装个人插件权限"'}>安装个人插件</button>
      <button class="btn ghost" type="button" data-my-plugin-refresh>刷新</button>
    </div>
    ${myPluginCan('install') ? '' : myPluginLockedNote('install')}
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

/* ---------------- 工作台：个人技能 ---------------- */

const SKILL_LEVEL_LABEL = {
  L0: 'L0 纯提示词',
  L1: 'L1 只读工具',
  L2: 'L2 写入工具',
  L3: 'L3 页面 / 后台',
}

const SKILL_RISK_LABEL = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  critical: '严重风险',
}

function mySkillRiskTone(risk) {
  if (risk === 'low') return 'ok'
  if (risk === 'medium') return 'warn'
  return 'danger'
}

function mySkillStatus(skill) {
  if (!skill.valid) return { label: '已拦截', tone: 'danger' }
  if (!skill.enabled) return { label: '已停用', tone: 'warn' }
  if (skill.risk === 'medium') return { label: '已启用 · 中风险', tone: 'warn' }
  return { label: '已启用', tone: 'ok' }
}

function mySkillCan(action) {
  return state.skillData?.permissions?.[action] === true
}

function mySkillLockedNote(action) {
  const labels = { install: '安装个人技能', configure: '启停个人技能', uninstall: '卸载个人技能' }
  return `<div class="plugin-note plugin-permission-note">当前账号的角色没有「${labels[action] || action}」权限，操作已锁定；请联系管理员在控制台「角色管理」里授权。</div>`
}

function mySkillStatusPill(skill) {
  const status = mySkillStatus(skill)
  return `<span class="pill ${status.tone}">${esc(status.label)}</span>`
}

function mySkillRailItem(skill) {
  const status = mySkillStatus(skill)
  const active = skill.id === state.skillSelected
  return `<button class="plugin-rail-item ${active ? 'is-active' : ''} ${skill.enabled && skill.valid ? '' : 'is-muted'}" type="button" data-my-skill-select="${esc(skill.id)}">
    <span class="plugin-rail-avatar ${skill.enabled && skill.valid ? '' : 'ghost'}">${esc((skill.name || skill.id).slice(0, 1).toUpperCase())}</span>
    <span class="plugin-rail-text">
      <strong>${esc(skill.name || skill.id)}</strong>
      <small>${esc(skill.level || 'L0')} · v${esc(skill.version || '—')} · ${esc(status.label)}</small>
    </span>
    <span class="plugin-rail-dot ${status.tone === 'ok' ? 'ok' : status.tone === 'warn' ? 'warn' : 'bad'}" aria-hidden="true"></span>
  </button>`
}

function mySkillRailHtml(data) {
  const skills = data.skills || state.skills || []
  const stats = data.stats || { installed: skills.length, enabled: 0, valid: 0, blocked: 0 }
  const who = state.me?.person?.name || '个人空间'
  return `<div class="plugin-rail-top">
      <div class="plugin-scope-block">
        <span class="plugin-scope-eyebrow">个人技能</span>
        <strong>${esc(who)}</strong>
        <small>只显示你自己安装的技能</small>
      </div>
      <div class="plugin-rail-metrics">
        <div><strong>${stats.installed}</strong><span>已装</span></div>
        <div><strong>${stats.enabled}</strong><span>启用</span></div>
        <div><strong>${stats.blocked || 0}</strong><span>拦截</span></div>
      </div>
      <div class="plugin-rail-actions">
        <button class="btn primary sm" type="button" data-my-skill-install ${mySkillCan('install') ? '' : 'disabled title="当前角色没有安装个人技能权限"'}>＋ 安装技能</button>
        <button class="btn ghost sm" type="button" data-my-skill-refresh>刷新</button>
      </div>
    </div>
    <div class="plugin-rail-head">已安装 <span class="muted">${skills.length}</span><span class="plugin-rail-head-hint" title="点击卡片切换下方详情" aria-label="点击卡片切换下方详情"><svg aria-hidden="true" width="10" height="10" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.2"/><path d="M8 7.4v3.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="4.6" r=".9" fill="currentColor"/></svg></span></div>
    <div class="plugin-rail-list">
      ${skills.length ? skills.map(mySkillRailItem).join('') : '<div class="plugin-empty">还没有个人技能</div>'}
    </div>`
}

function mySkillFindingsHtml(skill) {
  const findings = skill.findings || []
  if (!findings.length) {
    return `<div class="plugin-note">安装扫描、启用检查和文件指纹校验均通过；技能只注入业务说明，不执行脚本。</div>`
  }
  return `<div class="ws-tool-list">
    ${findings
      .slice(0, 12)
      .map(
        (finding) => `<article class="ws-tool-row">
          <div class="ws-tool-main">
            <div class="ws-tool-head"><code>${esc(finding.code)}</code><span class="pill ${finding.severity === 'critical' || finding.severity === 'high' ? 'danger' : 'warn'}">${esc(finding.category || finding.severity)}</span></div>
            <p>${esc(finding.message)}</p>
            <div class="ws-tool-params"><span class="chip">${esc(finding.file)}:${esc(finding.line)}</span>${finding.excerpt ? `<span class="chip">${esc(finding.excerpt.slice(0, 80))}</span>` : ''}</div>
          </div>
        </article>`,
      )
      .join('')}
  </div>`
}

function mySkillDetailHtml(data, skill) {
  const status = mySkillStatus(skill)
  const scopes = skill.scopes || []
  const tools = skill.tools || []
  const triggers = skill.triggers || []
  const references = skill.references || []
  const install = skill.install || {}
  const blocked = !skill.valid
  return `<section class="panel plugin-detail">
    <div class="plugin-detail-head">
      <div class="plugin-title">
        <span class="plugin-avatar">${esc((skill.name || skill.id).slice(0, 1).toUpperCase())}</span>
        <div class="plugin-title-text">
          <div class="plugin-title-row"><h2>${esc(skill.name || skill.id)}</h2><span class="plugin-format-badge">SKILL</span><span class="pill ${mySkillRiskTone(skill.risk)}">${esc(SKILL_RISK_LABEL[skill.risk] || skill.risk)}</span>${mySkillStatusPill(skill)}</div>
          <div class="plugin-subline"><span>v${esc(skill.version || '—')}</span><span>${esc(skill.author || '未知作者')}</span><span>${esc(SKILL_LEVEL_LABEL[skill.level] || skill.level)}</span></div>
        </div>
      </div>
      <div class="plugin-detail-actions">
        <button class="btn ghost sm" type="button" data-my-skill-toggle data-next-enabled="${skill.enabled ? '0' : '1'}" ${mySkillCan('configure') && !blocked ? '' : 'disabled title="当前角色没有启停个人技能权限"'}>${skill.enabled ? '停用' : '启用'}</button>
        <button class="btn ghost sm danger-text" type="button" data-my-skill-uninstall ${mySkillCan('uninstall') ? '' : 'disabled title="当前角色没有卸载个人技能权限"'}>卸载…</button>
      </div>
    </div>
    <div class="plugin-block">
      <h3>技能概况</h3>
      <div class="plugin-kv">
        <div><span>技能 ID</span><strong class="mono">${esc(skill.id)}</strong></div>
        <div><span>能力等级</span><strong>${esc(SKILL_LEVEL_LABEL[skill.level] || skill.level)}</strong></div>
        <div><span>声明权限</span><strong>${esc(scopes.join('、') || '无')}</strong></div>
        <div><span>触发词</span><strong>${esc(triggers.join('、') || '无')}</strong></div>
        <div><span>声明工具</span><strong>${esc(tools.join('、') || '无')}</strong></div>
        <div><span>安装范围</span><strong>个人安装（只影响我）</strong></div>
        <div><span>安装方式</span><strong>${esc(install.source === 'browser-dir' ? '本机文件夹' : install.source || '个人安装')}</strong></div>
        <div><span>安装时间</span><strong>${esc(workspaceFileDate(install.installedAt))}</strong></div>
        <div><span>校验和</span><span class="mono">${esc(skill.checksum || '—')}</span></div>
      </div>
      <div class="plugin-note">${esc(skill.description || '没有技能说明')}</div>
    </div>
    <div class="plugin-block">
      <h3>安全与隔离</h3>
      ${blocked ? `<div class="plugin-page-blocked"><strong>技能已被拦截</strong><span>${esc(skill.error || '技能包没有通过安全扫描')}。检查 .quarantine 中的记录，修复后重新安装。</span></div>` : ''}
      <div class="plugin-kv">
        <div><span>风险结论</span><strong>${esc(SKILL_RISK_LABEL[skill.risk] || skill.risk)}</span></div>
        <div><span>checksum</span><span class="mono">${esc(skill.checksum || '—')}</span></div>
        <div><span>加载状态</span><strong>${skill.valid ? '扫描通过' : '拒绝加载'}</strong></div>
        <div><span>可执行脚本</span><strong>第一版禁止</strong></div>
      </div>
      ${mySkillFindingsHtml(skill)}
    </div>
    <div class="plugin-block">
      <h3>引用文件</h3>
      <div class="plugin-page-list"><span>references/assets</span><div>${references.length ? references.map((file) => `<span class="chip">${esc(file)}</span>`).join('') : '<span class="muted">没有引用或素材文件</span>'}</div></div>
    </div>
    <div class="plugin-block">
      <h3>运行状态</h3>
      <div class="plugin-kv">
        <div><span>启用状态</span><strong>${esc(status.label)}</strong></div>
        <div><span>对话注入</span><strong>${skill.valid && skill.enabled ? '已注入业务说明' : '未注入'}</strong></div>
        <div><span>工具调用</span><strong>仍受 agent:tool:invoke 与工具白名单约束</strong></div>
      </div>
      <div class="plugin-danger-zone">
        <div><strong>卸载个人技能</strong><span>只解除你自己的安装，不删除技能目录、审计和隔离记录。</span></div>
        <button class="btn ghost sm danger-text" type="button" data-my-skill-uninstall ${mySkillCan('uninstall') ? '' : 'disabled title="当前角色没有卸载个人技能权限"'}>卸载…</button>
      </div>
    </div>
  </section>`
}

function mySkillWelcomeHtml(data) {
  const skills = data.skills || []
  const stats = data.stats || { installed: 0, enabled: 0, valid: 0, blocked: 0 }
  const empty = skills.length === 0
  return `<div class="plugin-welcome">
    <div class="plugin-welcome-mark">S</div>
    <h2>${empty ? '还没有个人技能' : '从左侧选择一个技能'}</h2>
    <p>${empty ? '技能包由 skill.json 和 SKILL.md 组成；安装前会先扫描破坏命令、越权指令、凭证读取和外发行为，高风险包直接拦截。' : '左侧列出的是你本人安装的技能，点一个可以查看风险结论、引用文件、启停和卸载。'}</p>
    <div class="plugin-welcome-stats">
      <div><strong>${stats.installed}</strong><span>已安装</span></div>
      <div><strong>${stats.enabled}</strong><span>已启用</span></div>
      <div><strong>${stats.blocked || 0}</strong><span>被拦截</span></div>
    </div>
    <div class="plugin-welcome-actions">
      <button class="btn primary" type="button" data-my-skill-install ${mySkillCan('install') ? '' : 'disabled title="当前角色没有安装个人技能权限"'}>安装个人技能</button>
      <button class="btn ghost" type="button" data-my-skill-refresh>刷新</button>
    </div>
    ${mySkillCan('install') ? '' : mySkillLockedNote('install')}
  </div>`
}

function renderMySkillWorkspace() {
  const rail = $('#my-plugin-rail')
  const detail = $('#my-plugin-detail')
  if (!rail || !detail) return
  const data = state.skillData || { skills: state.skills, stats: null }
  rail.innerHTML = mySkillRailHtml(data)
  const skill = (data.skills || []).find((item) => item.id === state.skillSelected)
  detail.innerHTML = skill ? mySkillDetailHtml(data, skill) : mySkillWelcomeHtml(data)
  bindMySkillWorkspace()
}

async function loadMySkills() {
  const rail = $('#my-plugin-rail')
  const detail = $('#my-plugin-detail')
  if (!rail || !detail) return
  rail.innerHTML = '<div class="plugin-empty muted">正在读取技能…</div>'
  detail.innerHTML = '<div class="plugin-empty muted">正在读取技能…</div>'
  try {
    const data = await api(`/api/my/skills${qs()}`)
    state.skillData = data
    state.skills = Array.isArray(data.skills) ? data.skills : []
    if (!state.skillSelected || !state.skills.some((item) => item.id === state.skillSelected)) {
      state.skillSelected = state.skills[0]?.id ?? null
    }
    renderMySkillWorkspace()
  } catch (err) {
    rail.innerHTML = `<div class="plugin-empty bad">读取技能失败：${esc(err.message)}</div>`
    detail.innerHTML = `<div class="plugin-empty bad">读取技能失败：${esc(err.message)}</div>`
  }
}

function openMySkillUninstall(skill) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `<div class="modal plugin-install-modal">
    <div class="modal-head">
      <div><h3>卸载「${esc(skill.name || skill.id)}」</h3><span class="muted">只解除你自己的个人安装</span></div>
      <button class="modal-x" type="button">×</button>
    </div>
    <div class="plugin-danger-zone" style="margin-top:4px">
      <div><strong>确认从个人工作台卸载？</strong><span>技能目录、审计记录和隔离记录都会保留；之后可以重新安装。</span></div>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" type="button" data-my-skill-uninstall-cancel>取消</button>
      <button class="btn danger" type="button" data-my-skill-uninstall-confirm>卸载</button>
    </div>
  </div>`
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('[data-my-skill-uninstall-cancel]') || event.target.closest('.modal-x')) close()
  })
  overlay.querySelector('[data-my-skill-uninstall-confirm]').addEventListener('click', async (event) => {
    const button = event.currentTarget
    button.disabled = true
    try {
      await api(`/api/my/skills/${encodeURIComponent(skill.id)}${qs()}`, { method: 'DELETE' })
      close()
      state.skillSelected = null
      await loadMySkills()
      banner('已卸载个人技能', 'ok')
    } catch (err) {
      button.disabled = false
      banner(`卸载失败：${err.message}`, 'bad')
    }
  })
}

function showSkillInstall() {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `<div class="modal plugin-install-modal">
    <div class="modal-head install-modal-head">
      <div><span class="install-eyebrow">PERSONAL SKILL INSTALLER</span><h3>安装个人技能</h3><span class="muted">只影响你自己</span></div>
      <button class="modal-x" type="button">×</button>
    </div>
    <div class="install-source-tabs" role="tablist" aria-label="个人技能安装来源">
      <button class="install-source-tab is-active" type="button" data-si-source="browser-dir">
        <span class="install-source-icon">⌂</span><span><strong>本机文件夹</strong><small>选择已有技能包</small></span>
      </button>
      <button class="install-source-tab" type="button" data-si-source="git">
        <span class="install-source-icon">◐</span><span><strong>GitHub 仓库</strong><small>仓库 + 分支 / 子目录</small></span>
      </button>
      <button class="install-source-tab" type="button" data-si-source="http">
        <span class="install-source-icon">⇣</span><span><strong>压缩包 URL</strong><small>tar.gz / zip 直链</small></span>
      </button>
    </div>
    <div class="install-panel" data-si-panel="browser-dir">
      <input id="si-folder-input" type="file" webkitdirectory directory multiple hidden />
      <div class="plugin-install-actions">
        <button class="btn ghost" type="button" id="si-pick-folder">选择技能文件夹…</button>
        <span class="muted" id="si-folder-name">未选择</span>
      </div>
    </div>
    <div class="install-panel is-hidden" data-si-panel="git">
      <div class="install-grid">
        <label class="install-field install-span-2"><span class="install-label">GitHub 仓库</span>
          <input id="si-git-repo" placeholder="owner/repo，例如 Jydsh/eab-skills" autocomplete="off" />
        </label>
        <label class="install-field"><span class="install-label">分支 / 标签</span>
          <input id="si-git-ref" placeholder="留空 = 默认分支" autocomplete="off" />
        </label>
        <label class="install-field"><span class="install-label">仓库内子目录</span>
          <input id="si-git-subdir" placeholder="可选，例如 skills/fixed-field-edit" autocomplete="off" />
        </label>
      </div>
    </div>
    <div class="install-panel is-hidden" data-si-panel="http">
      <label class="install-field"><span class="install-label">技能压缩包 URL</span>
        <input id="si-http-url" placeholder="https://example.com/skills/fixed-field-edit.tar.gz" autocomplete="off" />
      </label>
    </div>
    <div class="install-options">
      <label class="install-check">
        <input type="checkbox" id="si-overwrite" />
        <span><strong>覆盖同名技能</strong><small>已安装同一技能 id 时替换为新包；不勾选会提示冲突。</small></span>
      </label>
    </div>
    <div class="install-flow">
      <span id="si-flow-first">① 读取文件夹</span><i>→</i><span>② 静态安全扫描</span><i>→</i><span>③ 安装到个人</span>
      <div class="install-note" id="si-note"></div>
    </div>
    <div class="install-progress" id="si-progress" hidden aria-live="polite">
      <div class="install-progress-track"><span class="install-progress-bar"></span></div>
      <div class="install-progress-meta"><span id="si-progress-text">正在安装…</span><span id="si-progress-time" class="mono">0s</span></div>
    </div>
    <div class="modal-state" id="si-state"></div>
    <div class="modal-actions">
      <button class="btn ghost" type="button" data-si-cancel>取消</button>
      <button class="btn primary" type="button" id="si-submit" disabled>安装技能</button>
    </div>
  </div>`
  document.body.appendChild(overlay)
  const close = () => {
    if (progressTimer) clearInterval(progressTimer)
    overlay.remove()
  }
  const stateEl = overlay.querySelector('#si-state')
  const submit = overlay.querySelector('#si-submit')
  const nameEl = overlay.querySelector('#si-folder-name')
  const noteEl = overlay.querySelector('#si-note')
  const flowFirst = overlay.querySelector('#si-flow-first')
  const progressEl = overlay.querySelector('#si-progress')
  const progressText = overlay.querySelector('#si-progress-text')
  const progressTime = overlay.querySelector('#si-progress-time')
  const tabs = Array.from(overlay.querySelectorAll('[data-si-source]'))
  const panels = Array.from(overlay.querySelectorAll('[data-si-panel]'))
  let entries = []
  let source = 'browser-dir'
  let progressTimer = null
  let progressStartedAt = 0

  const sourceNotes = {
    'browser-dir': '本机文件夹：浏览器只上传文件副本，服务端落到临时目录扫描；安装后立即删除临时目录。',
    git: 'GitHub：下载仓库 tarball 后解包；仓库里必须有 skill.json 和 SKILL.md。只取内容，不执行仓库脚本。',
    http: '压缩包 URL：只支持 tar.gz / zip；解包后照常静态扫描。默认只允许公网 https。',
  }
  const setInstalling = (busy) => {
    for (const control of overlay.querySelectorAll('.install-source-tab, .install-field input, .install-check input, #si-pick-folder')) control.disabled = busy
  }
  const stopProgressClock = () => {
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = null
  }
  const startProgress = (text) => {
    stopProgressClock()
    progressStartedAt = Date.now()
    progressEl.hidden = false
    progressEl.classList.remove('is-done')
    progressText.textContent = text
    progressTime.textContent = '0s'
    stateEl.className = 'modal-state'
    stateEl.textContent = ''
    setInstalling(true)
    progressTimer = setInterval(() => {
      const seconds = Math.max(0, Math.floor((Date.now() - progressStartedAt) / 1000))
      progressTime.textContent = `${seconds}s`
    }, 500)
  }
  const failProgress = () => {
    stopProgressClock()
    progressEl.hidden = true
    setInstalling(false)
  }
  const syncSubmit = () => {
    submit.disabled = source === 'browser-dir' && entries.length === 0
  }
  const syncSource = (next) => {
    source = next
    for (const tab of tabs) {
      const active = tab.dataset.siSource === next
      tab.classList.toggle('is-active', active)
      tab.setAttribute('aria-selected', active ? 'true' : 'false')
    }
    for (const panel of panels) panel.classList.toggle('is-hidden', panel.dataset.siPanel !== next)
    noteEl.innerHTML = `${String(sourceNotes[next] || '')}`
    flowFirst.textContent = next === 'browser-dir' ? '① 读取文件夹' : '① 下载并解包'
    stateEl.className = 'modal-state'
    stateEl.textContent = ''
    syncSubmit()
  }
  const apply = (list, label) => {
    entries = list
    nameEl.textContent = `${label} · ${list.length} 个文件`
    stateEl.className = 'modal-state ok'
    stateEl.textContent = list.length ? '已选择，点「安装技能」上传并扫描' : ''
    syncSubmit()
  }
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('[data-si-cancel]') || event.target.closest('.modal-x')) close()
  })
  for (const tab of tabs) tab.addEventListener('click', () => syncSource(tab.dataset.siSource))
  const pick = overlay.querySelector('#si-pick-folder')
  const input = overlay.querySelector('#si-folder-input')
  pick.addEventListener('click', async () => {
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        const dir = await window.showDirectoryPicker({ id: 'eab-skill-folder', mode: 'read' })
        apply(await collectDirectoryEntries(dir, `${dir.name}/`, []), dir.name)
      } catch (err) {
        if (err && err.name === 'AbortError') return
        stateEl.className = 'modal-state bad'
        stateEl.textContent = `读取文件夹失败：${err?.message || err}`
      }
      return
    }
    input.value = ''
    input.click()
  })
  input.addEventListener('change', () => {
    const files = Array.from(input.files || [])
    apply(files.map((file) => ({ rel: String(file.webkitRelativePath || file.name), file })), files[0]?.webkitRelativePath?.split('/')[0] || '技能文件夹')
  })
  syncSource(source)

  submit.addEventListener('click', async () => {
    const body = {
      source,
      overwrite: overlay.querySelector('#si-overwrite').checked,
    }
    if (source === 'git') {
      body.repo = overlay.querySelector('#si-git-repo').value.trim()
      body.ref = overlay.querySelector('#si-git-ref').value.trim()
      body.subdir = overlay.querySelector('#si-git-subdir').value.trim()
      if (!body.repo) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '请填 GitHub 仓库（owner/repo）'
        return
      }
    } else if (source === 'http') {
      body.url = overlay.querySelector('#si-http-url').value.trim()
      if (!body.url) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '请填写技能压缩包 URL'
        return
      }
    } else {
      if (!entries.length) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '请选择技能文件夹'
        return
      }
      stateEl.className = 'modal-state'
      stateEl.textContent = '正在读取文件夹…'
      body.files = await readPluginFolderFiles(entries)
    }
    startProgress(source === 'git'
      ? '正在从 GitHub 下载仓库 tarball 并解包…'
      : source === 'http'
        ? '正在下载技能压缩包并解包…'
        : '正在上传并扫描技能包…')
    submit.textContent = '安装中…'
    try {
      await api(`/api/my/skills/install${qs()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      stopProgressClock()
      progressEl.classList.add('is-done')
      progressText.textContent = '安装完成，正在刷新技能列表…'
      progressTime.textContent = '完成'
      try {
        await loadMySkills()
      } catch {
        // 安装已成功；刷新失败不改变结果。
      }
      await new Promise((resolve) => setTimeout(resolve, 700))
      close()
      state.skillSelected = null
      banner('已安装个人技能', 'ok')
    } catch (err) {
      failProgress()
      submit.disabled = false
      submit.textContent = '安装技能'
      if (err?.details?.approvalId || err?.code === 'EAB_APPROVAL_REQUIRED') {
        stateEl.className = 'modal-state'
        stateEl.textContent = `已提交安装审批：${err.message || '等待管理员通过'}`
      } else {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = `安装失败：${err.message}`
      }
    }
  })
}

function bindMySkillWorkspace() {
  for (const button of document.querySelectorAll('[data-my-skill-select]')) {
    button.onclick = () => {
      state.skillSelected = button.dataset.mySkillSelect
      renderMySkillWorkspace()
    }
  }
  for (const button of document.querySelectorAll('[data-my-skill-toggle]')) {
    button.onclick = async () => {
      const enabled = button.dataset.nextEnabled === '1'
      button.disabled = true
      try {
        await api(`/api/my/skills/${encodeURIComponent(state.skillSelected)}/state${qs()}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        })
        await loadMySkills()
        banner(enabled ? '已启用技能' : '已停用技能', 'ok')
      } catch (err) {
        button.disabled = false
        banner(`启停失败：${err.message}`, 'bad')
      }
    }
  }
  for (const button of document.querySelectorAll('[data-my-skill-install]')) button.onclick = showSkillInstall
  for (const button of document.querySelectorAll('[data-my-skill-refresh]')) button.onclick = () => loadMySkills()
  for (const button of document.querySelectorAll('[data-my-skill-uninstall]')) {
    button.onclick = () => {
      const skill = state.skills.find((item) => item.id === state.skillSelected)
      if (skill) openMySkillUninstall(skill)
    }
  }
}

function setWorkspaceKind(kind) {
  const next = kind === 'skills' ? 'skills' : 'plugins'
  if (state.workspaceKind === next) return
  state.workspaceKind = next
  for (const button of document.querySelectorAll('#workspace-kind-switch [data-workspace-kind]')) {
    const active = button.dataset.workspaceKind === next
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-selected', active ? 'true' : 'false')
  }
  const eyebrow = $('#workspace-eyebrow')
  const title = $('#workspace-title')
  const badge = $('#workspace-scope-badge')
  if (eyebrow) eyebrow.textContent = next === 'skills' ? 'PERSONAL SKILL WORKSPACE' : 'PERSONAL PLUGIN WORKSPACE'
  if (title) title.textContent = next === 'skills' ? '技能工作台' : '我的工作台'
  if (badge) {
    badge.textContent = next === 'skills' ? '仅本人技能' : '仅本人可见'
    badge.dataset.tip =
      next === 'skills'
        ? '只显示你自己安装的技能。安装、启停、卸载和风险详情都只影响你本人；高风险包会被拦截并写入隔离记录。'
        : '只显示你自己安装的插件。启停、卸载、查看详情和打开插件页面都只影响你本人，不会碰公司和别人的安装。'
  }
  if (state.mode === 'workspace') {
    if (next === 'skills') loadMySkills()
    else loadMyPlugins()
  }
}

function bindWorkspaceKindSwitch() {
  for (const button of document.querySelectorAll('#workspace-kind-switch [data-workspace-kind]')) {
    button.onclick = () => setWorkspaceKind(button.dataset.workspaceKind)
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

/** 目录选择器（showDirectoryPicker）用：递归收集文件，跳过依赖/版本库目录，避免把 node_modules 一起传上去 */
const PLUGIN_FOLDER_SKIP = new Set(['node_modules', '.git', '.svn', '.hg'])

async function collectDirectoryEntries(dirHandle, prefix, out, limit = 4000) {
  for await (const entry of dirHandle.values()) {
    if (out.length >= limit) throw new Error(`这个文件夹里文件超过 ${limit} 个，请确认选的是插件目录本身`)
    if (entry.kind === 'directory') {
      if (PLUGIN_FOLDER_SKIP.has(entry.name)) continue
      await collectDirectoryEntries(entry, `${prefix}${entry.name}/`, out, limit)
      continue
    }
    out.push({ rel: `${prefix}${entry.name}`, file: await entry.getFile() })
  }
  return out
}

async function readPluginFolderFiles(entries) {
  const out = []
  for (const { rel: rawRel, file } of entries) {
    const rel = String(rawRel || file.name).replace(/\\/g, '/')
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
        <div class="install-section-title"><strong>从我的电脑选择插件文件夹</strong><span class="hint-badge icon-only" data-tip="选择包含 plugin.json 的文件夹。支持 EAB 插件（plugin.json）和 DSH 插件（package.json 带 dsh 段）；只上传文件夹里的文件副本，安装结束即删除临时目录；会自动跳过 node_modules、.git 等依赖目录。" tabindex="0" aria-label="插件文件夹说明"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.1"/><path d="M8 7.4v3.4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".8" fill="currentColor"/></svg></span></div>
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
    <div class="install-progress" id="pi-progress" hidden aria-live="polite">
      <div class="install-progress-track"><span class="install-progress-bar"></span></div>
      <div class="install-progress-meta">
        <span id="pi-progress-text">正在安装…</span>
        <span id="pi-progress-time" class="mono">0s</span>
      </div>
    </div>
    <div class="modal-state" id="pi-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="pi-submit">安装插件</button>
      <button class="btn ghost" type="button" id="pi-cancel">取消</button>
    </div>
  </div>`
  document.body.appendChild(overlay)
  const disposeHintTips = bindHintTips(overlay)
  let progressTimer = null
  const close = () => {
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = null
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
  const progressEl = overlay.querySelector('#pi-progress')
  const progressText = overlay.querySelector('#pi-progress-text')
  const progressTime = overlay.querySelector('#pi-progress-time')
  let progressStartedAt = 0
  const stopProgressClock = () => {
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = null
  }
  const setInstalling = (busy) => {
    overlay.querySelector('.modal').classList.toggle('is-installing', busy)
    for (const control of overlay.querySelectorAll('.install-source-tab, .install-field input, .install-field select, .install-overwrite-inline input, #pi-pick-folder')) {
      control.disabled = busy
    }
  }
  const startProgress = (text) => {
    stopProgressClock()
    progressStartedAt = Date.now()
    progressEl.hidden = false
    progressEl.classList.remove('is-done')
    progressText.textContent = text
    progressTime.textContent = '0s'
    stateEl.className = 'modal-state'
    stateEl.textContent = ''
    setInstalling(true)
    progressTimer = setInterval(() => {
      const seconds = Math.max(0, Math.floor((Date.now() - progressStartedAt) / 1000))
      progressTime.textContent = `${seconds}s`
    }, 500)
  }
  const updateProgress = (text) => {
    progressText.textContent = text
  }
  const completeProgress = (text) => {
    stopProgressClock()
    progressEl.hidden = false
    progressEl.classList.add('is-done')
    progressText.textContent = text
    progressTime.textContent = '完成'
  }
  const failProgress = () => {
    stopProgressClock()
    progressEl.hidden = true
    setInstalling(false)
  }
  const folderInput = overlay.querySelector('#pi-folder-input')
  const pickFolder = overlay.querySelector('#pi-pick-folder')
  const pathStatus = overlay.querySelector('#pi-path-status')
  let selectedFolderEntries = []
  let selectedFolderName = ''
  let source = 'browser-dir'

  const sourceNotes = {
    'browser-dir': '本机文件夹：浏览器选中你电脑上的插件文件夹，把文件副本上传给服务端校验后安装；适合自己开发和离线安装。',
    npm: 'npm / 镜像：从 registry 拉 tarball 后校验；不执行 npm install、prepare 或任何生命周期脚本。',
    github: 'GitHub：下载仓库 tarball 后校验；仓库里必须有 plugin.json，构建产物需随仓库提交。',
  }

  const syncFolderStatus = () => {
    if (selectedFolderEntries.length === 0) {
      pathStatus.hidden = true
      pathStatus.innerHTML = ''
      return
    }
    const total = selectedFolderEntries.reduce((sum, entry) => sum + (entry.file.size || 0), 0)
    pathStatus.hidden = false
    pathStatus.innerHTML = `<span class="pi-path-status-icon"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1.8 4.3a1.3 1.3 0 0 1 1.3-1.3h3.1l1.4 1.5h4.3a1.3 1.3 0 0 1 1.3 1.3v6.1a1.3 1.3 0 0 1-1.3 1.3H3.1a1.3 1.3 0 0 1-1.3-1.3V4.3Z" stroke="currentColor" stroke-width="1.1"/></svg></span>
      <span class="pi-path-status-copy"><strong>${esc(selectedFolderName)}</strong><small>${selectedFolderEntries.length} 个文件 · ${esc(fmtSize(total))}</small></span>
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
  const applyFolderSelection = (entries) => {
    selectedFolderEntries = entries
    selectedFolderName = String(entries[0]?.rel || '').split('/').filter(Boolean)[0] || '插件文件夹'
    syncFolderStatus()
    if (entries.length > 0) {
      stateEl.className = 'modal-state ok'
      stateEl.textContent = `已选择「${selectedFolderName}」，共 ${entries.length} 个文件，点「安装插件」上传并安装`
    }
  }
  pickFolder.addEventListener('click', async () => {
    // 新版 Chrome/Edge 优先用目录选择器：它不会再弹浏览器原生的「将 N 个文件上传到此网站？」确认
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        const dir = await window.showDirectoryPicker({ id: 'eab-plugin-folder', mode: 'read' })
        const entries = await collectDirectoryEntries(dir, `${dir.name}/`, [])
        applyFolderSelection(entries)
      } catch (err) {
        if (err && err.name === 'AbortError') return
        stateEl.className = 'modal-state bad'
        stateEl.textContent = `读取文件夹失败：${err?.message || err}`
      }
      return
    }
    folderInput.value = ''
    folderInput.click()
  })
  folderInput.addEventListener('change', () => {
    const files = Array.from(folderInput.files || [])
    applyFolderSelection(files.map((file) => ({ rel: String(file.webkitRelativePath || file.name), file })))
  })
  syncSource(source)

  const submit = overlay.querySelector('#pi-submit')
  submit.addEventListener('click', async () => {
    const body = {
      source,
      overwrite: overlay.querySelector('#pi-overwrite').checked,
    }
    if (source === 'browser-dir' && selectedFolderEntries.length === 0) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '请选择一个插件文件夹（含 plugin.json 或 DSH 的 package.json）'
      return
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
    const initialText = source === 'browser-dir'
      ? '正在读取文件夹并上传…'
      : source === 'npm'
        ? '正在从 npm 拉取并校验…'
        : '正在从 GitHub 下载并校验…'
    startProgress(initialText)
    submit.disabled = true
    submit.textContent = '安装中…'
    try {
      if (source === 'browser-dir') {
        body.files = await readPluginFolderFiles(selectedFolderEntries)
        body.folderName = selectedFolderName
        updateProgress('正在上传并校验插件…')
      }
      await api('/api/my/plugins/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      completeProgress('安装完成，正在刷新个人工作台…')
      try {
        await loadMyPlugins()
      } catch {
        // 安装已经成功，列表刷新失败不改变安装结果，也不阻止自动关闭。
      }
      await new Promise((resolve) => setTimeout(resolve, 900))
      close()
      banner('个人插件已安装，入口已出现在工作台', 'ok')
    } catch (err) {
      failProgress()
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

function thinkingConfigForModel(modelId) {
  const id = modelId || state.autoModelId || ''
  const model = state.models.find((item) => item.id === id)
  const config = model?.thinking
  if (!config?.enabled || !Array.isArray(config.options) || config.options.length === 0) return null
  return config
}

function activeThinkingConfig() {
  return thinkingConfigForModel(state.selected)
}

function thinkingDefault(config) {
  const fallback = config.options[0]?.id || ''
  return config.options.some((item) => item.id === config.defaultEffort) ? config.defaultEffort : fallback
}

function thinkingLabel(config, effort) {
  return config.options.find((item) => item.id === effort)?.label || effort
}

function renderThinkingMenu(config) {
  const menu = $('#think-menu')
  if (!menu) return
  const options = config.options
    .map((item) => {
      const active = item.id === state.reasoningEffort
      return `<button class="think-option${active ? ' is-active' : ''}" type="button" role="option" aria-selected="${active}" data-think="${esc(item.id)}">
        <span>
          <strong>${esc(item.label || item.id)}</strong>
          <small>${esc(item.hint || '模型声明的思考档位。')}</small>
        </span>
        <span class="think-check" aria-hidden="true">${active ? '✓' : ''}</span>
      </button>`
    })
    .join('')
  menu.innerHTML = options
}

function syncThinkingChip() {
  const wrap = $('#think-wrap')
  const menu = $('#think-menu')
  const chip = $('#think-chip')
  if (!wrap || !menu || !chip) return
  const config = activeThinkingConfig()
  if (!config) {
    state.reasoningEffort = ''
    wrap.hidden = true
    menu.hidden = true
    chip.setAttribute('aria-expanded', 'false')
    return
  }
  if (!config.options.some((item) => item.id === state.reasoningEffort)) {
    state.reasoningEffort = thinkingDefault(config)
  }
  wrap.hidden = false
  $('#think-chip-label').textContent = `思考：${thinkingLabel(config, state.reasoningEffort)}`
  renderThinkingMenu(config)
}

function setThinkingEffort(effort, options = {}) {
  const config = activeThinkingConfig()
  if (!config || !config.options.some((item) => item.id === effort)) return
  state.reasoningEffort = effort
  $('#think-menu').hidden = true
  $('#think-chip').setAttribute('aria-expanded', 'false')
  syncThinkingChip()
  if (options.persist !== false && state.sessionId) {
    persistSessionModel(state.selected, state.reasoningEffort)
  }
}

function setSelected(modelId, options = {}) {
  const visible = modelId ? state.models.find((m) => m.id === modelId) : null
  state.selected = visible ? visible.id : ''
  const config = thinkingConfigForModel(state.selected)
  const requested = String(options.reasoningEffort || '').trim()
  state.reasoningEffort = config
    ? (config.options.some((item) => item.id === requested) ? requested : thinkingDefault(config))
    : ''
  $('#model-chip-label').textContent = modelLabel(state.selected)
  $('#model-menu').hidden = true
  $('#model-chip').setAttribute('aria-expanded', 'false')
  renderModelMenus()
  renderAttachments()
  syncThinkingChip()
  if (options.persist !== false && state.sessionId) {
    persistSessionModel(state.selected, state.reasoningEffort)
  }
}

async function persistSessionModel(modelId, reasoningEffort = state.reasoningEffort) {
  try {
    await api(`/api/chat/sessions/${encodeURIComponent(state.sessionId)}/model${qs()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelId: modelId || null,
        reasoningEffort: reasoningEffort || null,
      }),
    })
  } catch (err) {
    banner(`模型已切换，但当前会话没有保存：${err.message || '保存失败'}`, 'warn')
  }
}

/**
 * 接替模型成功后刷新一次目录：服务端会把真实成功的模型排到前面，
 * 自动模式下一次就直接选它，不再先撞刚失败的模型。
 */
async function refreshModelCatalog() {
  try {
    const data = await api(`/api/chat/models${qs()}`)
    if (!data?.models?.length) return
    state.models = data.models
    state.autoModelId = data.autoModelId
    if (state.selected && !state.models.some((model) => model.id === state.selected)) {
      state.selected = ''
    }
    renderModelMenus()
    $('#model-chip-label').textContent = modelLabel(state.selected)
    syncThinkingChip()
  } catch {
    // 目录刷新失败不影响已经完成的回答，下一轮服务端仍按健康顺序选择。
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
        <span>${esc(model.desc || '')}${model.tags && model.tags.length ? ` · ${esc(modelTagsLabel(model.tags))}` : ''}${model.thinking?.enabled ? ' · 可调思考' : ''}</span>
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
        <span>${esc(model.desc || '')}${model.supportsVision ? ' · 图片识别' : ''}${model.thinking?.enabled ? ' · 可调思考' : ''}</span>
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
    const detail = [model.desc, model.tags && model.tags.length ? modelTagsLabel(model.tags) : '', model.supportsVision ? '图片识别' : '', model.thinking?.enabled ? '可调思考' : '']
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

function oneLinePreview(text, maxLength = 120) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > maxLength ? `…${normalized.slice(-maxLength)}` : normalized
}

function toolStatusText(trace) {
  if (trace.status === 'running') return '执行中'
  if (trace.status === 'error') return '失败'
  return `完成 · ${formatElapsed(trace.durationMs)}`
}

function toolDetailHtml(trace) {
  return `<div class="tool-detail ${trace.status === 'error' ? 'is-error' : ''}" data-tool-detail="${esc(trace.id)}">
    <div class="tool-detail-head">
      <strong>${esc(trace.name)}</strong>
      <span class="tool-detail-status">${esc(toolStatusText(trace))}</span>
    </div>
    <div class="tool-row"><span>参数</span><pre>${esc(prettyPayload(trace.args))}</pre></div>
    ${
      trace.summary
        ? `<div class="tool-row"><span>${trace.status === 'error' ? '错误' : '结果'}</span><pre>${esc(prettyPayload(trace.summary))}</pre></div>`
        : ''
    }
  </div>`
}

function latestToolPreview(tools) {
  const running = tools.find((tool) => tool.status === 'running')
  if (running) return `${running.name} · 执行中`
  const latest = tools.at(-1)
  if (!latest) return ''
  return `${latest.name}${latest.status === 'error' ? ' · 失败' : ''} · ${formatElapsed(latest.durationMs)}`
}

/* ---------------- Agent 文件操作预览 ---------------- */

const FILE_OPERATION_TOOLS = new Set([
  'workspace.write',
  'workspace.edit',
  'office.replace',
  'office.insert',
  'office.format',
  'office.comment',
  'workspace.read',
  'workspace.rename',
  'workspace.delete',
  'workspace.send_dingtalk',
])

const OFFICE_OPERATION_KINDS = {
  'office.replace': 'edit',
  'office.insert': 'insert',
  'office.format': 'format',
  'office.comment': 'comment',
}

const FILE_OPERATION_COPY = {
  write: { action: '写入文件', running: '正在写入', done: '已保存', error: '写入失败' },
  edit: { action: '局部修改文件', running: '正在修改', done: '已修改', error: '修改失败' },
  insert: { action: '插入文档内容', running: '正在插入', done: '已插入', error: '插入失败' },
  format: { action: '设置文档格式', running: '正在设置格式', done: '已设置格式', error: '设置格式失败' },
  comment: { action: '添加文档批注', running: '正在添加批注', done: '已添加批注', error: '添加批注失败' },
  read: { action: '读取文件', running: '正在读取', done: '已读取', error: '读取失败' },
  rename: { action: '重命名文件', running: '正在重命名', done: '已重命名', error: '重命名失败' },
  delete: { action: '删除文件', running: '正在删除', done: '已删除', error: '删除失败' },
  send: { action: '发送文件', running: '正在发送', done: '已发送', error: '发送失败' },
}

function parseToolSummaryObject(trace) {
  const raw = String(trace?.summary || '').trim()
  if (!raw.startsWith('{')) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    // 摘要超过服务端 1200 字上限时会被截断；至少把 fileId 取出来，预览按钮仍可用。
    const fileId = raw.match(/"fileId"\s*:\s*"([^"]+)"/)?.[1]
    return fileId ? { fileId } : null
  }
}

function baseFileName(path) {
  const value = String(path || '').trim()
  if (!value) return ''
  return value.split(/[\\/]/).pop() || value
}

function fileBadgeLabel(name) {
  const ext = String(name || '').split('.').pop()?.toLowerCase() || ''
  if (['doc', 'docx', 'docm', 'rtf', 'odt'].includes(ext)) return { label: 'DOC', tone: 'doc' }
  if (['xls', 'xlsx', 'xlsm', 'csv', 'ods'].includes(ext)) return { label: 'XLS', tone: 'sheet' }
  if (['ppt', 'pptx', 'pptm', 'odp'].includes(ext)) return { label: 'PPT', tone: 'slide' }
  if (ext === 'pdf') return { label: 'PDF', tone: 'pdf' }
  if (['md', 'markdown', 'txt', 'log', 'json', 'yml', 'yaml'].includes(ext)) return { label: 'TXT', tone: 'text' }
  return { label: 'FILE', tone: 'file' }
}

function isOfficeFileName(name) {
  return /\.(?:doc|docx|docm|xls|xlsx|xlsm|ppt|pptx|pptm|odt|ods|odp)(?:$)/i.test(String(name || ''))
}

/**
 * 从尚未闭合的 JSON 参数里取出字符串字段。
 * 模型流式生成 tool_call.arguments 时，text 往往只有开头一半；
 * 不能直接 JSON.parse，所以逐字符解析并处理 \"、\n、\uXXXX。
 */
function partialJsonStringField(raw, key) {
  const source = String(raw || '')
  const marker = `"${key}"`
  let searchFrom = 0
  while (searchFrom < source.length) {
    const keyAt = source.indexOf(marker, searchFrom)
    if (keyAt < 0) return ''
    let i = keyAt + marker.length
    while (i < source.length && /\s/.test(source[i])) i += 1
    if (source[i] !== ':') {
      searchFrom = keyAt + marker.length
      continue
    }
    i += 1
    while (i < source.length && /\s/.test(source[i])) i += 1
    if (source[i] !== '"') return ''
    i += 1
    let result = ''
    while (i < source.length) {
      const char = source[i]
      if (char === '"') return result
      if (char !== '\\') {
        result += char
        i += 1
        continue
      }
      const next = source[i + 1]
      if (next === undefined) return result
      if (next === 'n') {
        result += '\n'
        i += 2
        continue
      }
      if (next === 'r') {
        result += '\r'
        i += 2
        continue
      }
      if (next === 't') {
        result += '\t'
        i += 2
        continue
      }
      if (next === 'b') {
        result += '\b'
        i += 2
        continue
      }
      if (next === 'f') {
        result += '\f'
        i += 2
        continue
      }
      if (next === 'u') {
        const hex = source.slice(i + 2, i + 6)
        if (!/^[0-9a-f]{4}$/i.test(hex)) return result
        result += String.fromCharCode(parseInt(hex, 16))
        i += 6
        continue
      }
      result += next
      i += 2
    }
    return result
  }
  return ''
}

function partialWorkspaceWriteArgs(raw) {
  return {
    path: partialJsonStringField(raw, 'path') || partialJsonStringField(raw, 'relPath'),
    text:
      partialJsonStringField(raw, 'text') ||
      partialJsonStringField(raw, 'content') ||
      partialJsonStringField(raw, 'body') ||
      partialJsonStringField(raw, 'data'),
  }
}

function isWorkspaceWriteToolName(name) {
  return /workspace[._]write/i.test(String(name || ''))
}

function isOfficeReplaceToolName(name) {
  return /office[._]replace/i.test(String(name || ''))
}

function isOfficeInsertToolName(name) {
  return /office[._]insert/i.test(String(name || ''))
}

function partialOfficeReplaceArgs(raw) {
  return {
    path: partialJsonStringField(raw, 'path') || partialJsonStringField(raw, 'relPath'),
    fileId: partialJsonStringField(raw, 'fileId'),
    elementId: partialJsonStringField(raw, 'elementId'),
    newText: partialJsonStringField(raw, 'newText') || partialJsonStringField(raw, 'text'),
  }
}

function partialOfficeInsertArgs(raw) {
  return {
    path: partialJsonStringField(raw, 'path') || partialJsonStringField(raw, 'relPath'),
    fileId: partialJsonStringField(raw, 'fileId'),
    elementId: partialJsonStringField(raw, 'elementId'),
    text: partialJsonStringField(raw, 'text'),
  }
}

/** Office 局部编辑的流式预览：只展示当前目标元素的新文本，文件仍在工具完成后原子保存。 */
function applyStreamingOfficePreview(fileId, path, elementId, text) {
  const file = state.filePreview
  if (!file) return
  const idMatch = Boolean(fileId && String(file.id || '') === String(fileId))
  if (!idMatch && !filePreviewMatchesPath(file, path)) return
  const targetPath = path && filePreviewMatchesPath(file, path) ? path : file.relPath
  const prefix = elementId ? `编辑 ${elementId}\n` : ''
  applyStreamingFilePreview(targetPath || file.relPath, `${prefix}${String(text || '')}`)
}

function filePreviewMatchesPath(file, path) {
  if (!file) return false
  const target = String(path || '').trim()
  if (!target) return false
  const targetName = baseFileName(target)
  return Boolean(
    target === file.relPath ||
      target === file.name ||
      targetName === file.name ||
      targetName === baseFileName(file.relPath || ''),
  )
}

function streamingPreviewNode() {
  const body = $('#file-pane-body')
  if (!body || body.hidden) return null
  const existing = body.querySelector('pre.file-text-view')
  if (existing) return existing
  // OnlyOffice / PDF / 图片预览时不替换宿主，避免把编辑器或 iframe 拆掉。
  if (body.querySelector('#onlyoffice-editor, iframe, img')) return null
  const pre = document.createElement('pre')
  pre.className = 'file-text-view'
  body.innerHTML = ''
  body.appendChild(pre)
  return pre
}

/** 把模型生成中的文本写入右侧文本预览；文件本身等 tool 完成后再原子落盘。 */
function applyStreamingFilePreview(path, text) {
  const file = state.filePreview
  if (!file || !filePreviewMatchesPath(file, path)) return
  const draft = {
    fileId: file.id,
    path: String(path || ''),
    text: String(text || ''),
    updatedAt: Date.now(),
    office: isOfficeLike(file),
  }
  fileStreamDraft = draft
  if (draft.office) {
    const body = $('#file-pane-body')
    if (!body || body.hidden) return
    let overlay = body.querySelector('.file-stream-draft')
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.className = 'file-stream-draft'
      overlay.innerHTML = '<div class="file-stream-draft-head"><span class="file-stream-draft-dot"></span>Agent 正在生成 Office 文档内容 · 完成后由 OnlyOffice 刷新</div><pre></pre>'
      body.appendChild(overlay)
    }
    const pre = overlay.querySelector('pre')
    if (pre) revealPreviewText(pre, draft.text, body)
    body.scrollTop = body.scrollHeight
    return
  }
  if (!isTextLike(file)) return
  const pre = streamingPreviewNode()
  if (!pre) return
  const body = $('#file-pane-body')
  revealPreviewText(pre, draft.text, body)
  workspacePreviewText = draft.text
  workspacePreviewTextLoaded = true
}

/**
 * 模型工具参数若一次整块到达，直接整段替换会看不到过程；
 * 这里按字符揭示到完整文本，后续真实增量仍会继续续写。
 */
function revealPreviewText(el, text, body) {
  const full = String(text || '')
  const isText = el.classList.contains('file-text-view')
  el.classList.add('is-streaming')
  if (!full) {
    el.textContent = isText ? '（空文件）' : ''
    return
  }
  const same = fileStreamReveal && fileStreamReveal.el === el
  const previousFull = fileStreamReveal?.fullText || ''
  let shown = 0
  let startedAt = performance.now()
  if (same && full.startsWith(previousFull) && previousFull) {
    shown = fileStreamReveal.shown
    startedAt = performance.now() - (shown / Math.max(1, full.length)) * fileStreamReveal.duration
  }
  if (same) {
    fileStreamReveal.fullText = full
  } else {
    fileStreamReveal = {
      el,
      fullText: full,
      shown,
      startedAt,
      duration: Math.min(1600, Math.max(450, full.length * 1.2)),
      onDone: null,
    }
  }
  el.textContent = full.slice(0, shown)
  const nearBottom = body ? body.scrollHeight - body.scrollTop - body.clientHeight < 80 : true
  const tick = () => {
    const state = fileStreamReveal
    if (!state || state.el !== el) return
    const target = state.fullText
    const elapsed = performance.now() - state.startedAt
    const count = Math.max(
      state.shown,
      Math.min(target.length, Math.floor((target.length * elapsed) / state.duration)),
    )
    state.shown = count
    el.textContent = target.slice(0, count)
    if (body && nearBottom) body.scrollTop = body.scrollHeight
    if (count < target.length) {
      setTimeout(tick, 16)
      return
    }
    fileStreamReveal = null
    const onDone = state.onDone
    if (onDone) {
      clearStreamingPreviewArtifacts()
      onDone()
    }
  }
  setTimeout(tick, 16)
}

function clearStreamingPreviewArtifacts() {
  const body = $('#file-pane-body')
  if (!body) return
  body.querySelector('.file-stream-draft')?.remove()
  body.querySelector('pre.file-text-view.is-streaming')?.classList.remove('is-streaming')
  fileStreamReveal = null
}

function finishStreamingFilePreview(onDone) {
  const draft = fileStreamDraft
  fileStreamDraft = null
  if (onDone && fileStreamReveal) {
    fileStreamReveal.onDone = onDone
    return
  }
  if (!draft && !fileStreamReveal) {
    onDone?.()
    return
  }
  clearStreamingPreviewArtifacts()
  onDone?.()
}

/** 把工作区工具轨迹转成文件操作卡片所需的最小信息，不把原始参数直接铺在对话里。 */
function fileOperationInfo(trace) {
  if (!trace || !FILE_OPERATION_TOOLS.has(String(trace.toolId || ''))) return null
  const kind = OFFICE_OPERATION_KINDS[trace.toolId] || String(trace.toolId).slice('workspace.'.length)
  const copy = FILE_OPERATION_COPY[kind]
  if (!copy) return null
  const args = trace.args && typeof trace.args === 'object' ? trace.args : {}
  const summary = parseToolSummaryObject(trace) || {}
  const rawPath = String(args.path || '').trim()
  const summaryPath = String(summary.path || summary.relPath || '').trim()
  const targetPath = kind === 'rename'
    ? String(summary.to || args.newName || rawPath).trim()
    : (summaryPath || rawPath)
  const fallbackName = String(summary.fileName || summary.name || '').trim()
  const name = baseFileName(targetPath) || fallbackName || (kind === 'send' ? '云空间文件' : '文件')
  // 发送到钉钉的结果里 fileId 是钉钉侧文件 ID，不是云空间 ID；发送卡用 relPath 定位。
  const fileId = kind === 'send' ? '' : String(summary.fileId || args.fileId || '').trim()
  const text = kind === 'write'
    ? String(args.text ?? '')
    : (kind === 'read' ? String(summary.text ?? '') : (
      kind === 'edit' ? String(args.newText ?? summary.nextText ?? '') : (
        kind === 'insert' ? String(args.text ?? (Array.isArray(summary.insertedValues) ? summary.insertedValues.join(' ') : '') ?? '') : ''
      )
    ))
  const previewPath = fileId && state.filePreview && String(state.filePreview.id || '') === fileId
    ? String(state.filePreview.relPath || '')
    : ''
  const edits = kind === 'edit' && Array.isArray(args.edits) ? args.edits : []
  const changes = kind === 'edit'
    ? Number(summary.changes ?? summary.replacements ?? edits.length) || 0
    : 0
  const created = summary.created === true
  const from = String(summary.from || rawPath || '').trim()
  const to = String(summary.to || args.newName || targetPath || '').trim()
  return {
    kind,
    copy,
    path: targetPath || from || previewPath,
    name,
    fileId,
    text,
    edits,
    changes,
    created,
    from,
    to,
    status: trace.status === 'running' ? 'running' : trace.status === 'error' ? 'error' : 'done',
    statusLabel: trace.status === 'running'
      ? copy.running
      : trace.status === 'error' ? copy.error : copy.done,
    durationMs: Number(trace.durationMs) || 0,
    errorText: trace.status === 'error' ? String(trace.summary || '').trim() : '',
  }
}

function fileOperationPreviewHtml(op) {
  if (op.kind === 'rename') {
    if (!op.from && !op.to) return ''
    return `<div class="file-op-change">
      <span class="file-op-change-label">名称变更</span>
      <span class="file-op-change-value is-old">${esc(op.from || '—')}</span>
      <span class="file-op-change-arrow">→</span>
      <span class="file-op-change-value is-new">${esc(op.to || '—')}</span>
    </div>`
  }
  if (op.kind === 'delete') {
    return `<div class="file-op-note">文件已从云空间列表移除，移到回收目录保留审计。</div>`
  }
  if (op.kind === 'edit') {
    if (op.status === 'running') {
      return '<div class="file-op-note is-live"><span class="file-op-loading-dot"></span>Agent 正在定位并修改指定片段…</div>'
    }
    return `<div class="file-op-note">只修改了 ${op.changes || 0} 处片段，其余内容保持不变。</div>`
  }
  if (op.kind === 'insert' || op.kind === 'format' || op.kind === 'comment') {
    if (op.status === 'running') {
      return '<div class="file-op-note is-live"><span class="file-op-loading-dot"></span>Agent 正在写入目标元素…</div>'
    }
    if (op.status === 'error') return '<div class="file-op-note">没有写入文件，原始内容保持不变。</div>'
    const doneText = op.kind === 'insert'
      ? '已在目标位置插入新内容，其他元素未整体重写。'
      : op.kind === 'format'
        ? '已按目标元素设置字符格式，其他段落和表格结构未改动。'
        : '已给目标元素添加批注，原文未修改。'
    return `<div class="file-op-note">${doneText}</div>`
  }
  if (op.kind === 'write' || op.kind === 'read') {
    const raw = String(op.text || '')
    if (!raw) {
      return op.status === 'running'
        ? '<div class="file-op-note is-live"><span class="file-op-loading-dot"></span>Agent 正在生成内容…</div>'
        : '<div class="file-op-note">空文件</div>'
    }
    const lines = raw.split(/\r?\n/)
    const shown = lines.slice(0, 14).join('\n')
    const omitted = lines.length > 14 || raw.length > 1800
    const size = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(raw).length : raw.length
    const officeWarning = op.kind === 'write' && isOfficeFileName(op.name)
      ? '<div class="file-op-note is-warning">Agent 当前只能写入文本内容；Word / Excel / PPT 的内容级编辑请在右侧用 OnlyOffice 完成。</div>'
      : ''
    return `${officeWarning}<div class="file-op-preview">
      <div class="file-op-preview-head">
        <span>${op.kind === 'write' ? 'Agent 写入内容' : '读取内容'}</span>
        <span>${lines.length} 行 · ${esc(fmtSize(size))}${omitted ? ' · 仅显示开头' : ''}</span>
      </div>
      <pre>${esc(shown)}${omitted ? '\n…' : ''}</pre>
    </div>`
  }
  return ''
}

function fileOperationCardHtml(trace) {
  const op = fileOperationInfo(trace)
  if (!op) return ''
  const badge = fileBadgeLabel(op.name)
  const canOpen = op.status !== 'running' && op.kind !== 'delete' && Boolean(op.fileId || op.path)
  const duration = op.status === 'done' && op.durationMs > 0 ? ` · ${formatElapsed(op.durationMs)}` : ''
  const actionText = op.kind === 'write'
    ? (op.created ? '新建文件' : op.status === 'done' ? '修改文件' : '写入文件')
    : op.copy.action
  return `<div class="file-op-card is-${op.status} is-${op.kind}" data-file-op-kind="${op.kind}">
    <div class="file-op-head">
      <span class="file-op-badge is-${badge.tone}">${badge.label}</span>
      <div class="file-op-main">
        <span class="file-op-kicker">Agent 文件操作</span>
        <strong>${esc(op.name)}</strong>
        <span class="file-op-sub">${esc(actionText)}${duration}</span>
      </div>
      <span class="file-op-state"><span class="file-op-dot"></span>${esc(op.statusLabel)}</span>
    </div>
    ${fileOperationPreviewHtml(op)}
    <div class="file-op-foot">
      <span class="file-op-path" title="${esc(op.path || op.name)}">${esc(op.path || op.name)}</span>
      ${op.status === 'error' ? `<span class="file-op-error">${esc(oneLinePreview(op.errorText, 60))}</span>` : ''}
      ${canOpen ? `<button class="file-op-open" type="button" data-file-op-open="${esc(op.fileId)}" data-file-op-path="${esc(op.path)}">在右侧预览</button>` : ''}
    </div>
  </div>`
}

function fileOpsPanelHtml(tools) {
  const cards = (Array.isArray(tools) ? tools : [])
    .map((trace) => fileOperationCardHtml(trace))
    .filter(Boolean)
  if (cards.length === 0) return ''
  return `<div class="file-op-stack">${cards.slice(-4).join('')}</div>`
}

async function openFileOperationPreview(button) {
  if (!button || button.disabled) return
  let fileId = String(button.dataset.fileOpOpen || '').trim()
  const path = String(button.dataset.fileOpPath || '').trim()
  button.disabled = true
  try {
    if (!fileId || !state.files.some((file) => file.id === fileId)) await loadWorkspaceFiles()
    if (fileId && !state.files.some((file) => file.id === fileId)) fileId = ''
    if (!fileId && path) {
      const match = state.files.find((file) => file.relPath === path || file.name === path || baseFileName(file.relPath) === path)
      fileId = match?.id || ''
    }
    if (!fileId) {
      banner('文件列表还没有同步完成，请稍后再试。', 'bad')
      return
    }
    await openWorkspaceFile(fileId)
  } catch (err) {
    banner(`打开文件失败：${err.message}`, 'bad')
  } finally {
    button.disabled = false
  }
}

/**
 * 插件保存成功后，先把当前云端版本记为水位，再关闭旧编辑器并切回查看态。
 * 旧编辑器关闭时会再次触发 OnlyOffice 保存回调；refresh-guard 让旧 version 的回调
 * 被丢弃，避免同一份内容重复写回把 updated_at 再抬一次。
 */
function refreshWorkspaceAfterPluginSave(file, data) {
  void (async () => {
    try {
      await api(`/api/workspace/office/${encodeURIComponent(file.id)}/refresh-guard`, {
        method: 'POST',
      })
      await loadWorkspaceFiles()
      const latest = state.files.find((item) => item.id === file.id)
      if (!latest) {
        closeWorkspaceFile()
        banner('文件已不存在，无法刷新预览', 'bad')
        return
      }
      const updatedAt = Number(data.updatedAt) || latest.updatedAt
      const size = Number(data.size) || latest.size
      banner(
        `已保存《${latest.name}》到云空间（${workspaceFileDate(updatedAt)}，${fmtSize(size)}），已切换到查看态。`,
      )
      await openWorkspaceFile(latest.id, { mode: 'view' })
    } catch (err) {
      banner(`已保存成功，但刷新预览失败：${err.message}`, 'bad')
    }
  })()
}

function refreshWorkspaceAfterFileOperation(op) {
  if (!op || !['write', 'edit', 'insert', 'format', 'comment', 'rename', 'delete'].includes(op.kind)) return
  void (async () => {
    try {
      finishStreamingFilePreview()
      await loadWorkspaceFiles()
      const activeId = state.filePreview?.id
      if (op.kind === 'delete' && activeId && activeId === op.fileId) {
        closeWorkspaceFile()
        return
      }
      if (op.fileId && activeId && activeId === op.fileId) {
        if (onlyOfficeMode === 'edit') {
          const latest = state.files.find((file) => file.id === op.fileId)
          const cloudMeta = latest
            ? `（${workspaceFileDate(latest.updatedAt)}，${fmtSize(latest.size)}）`
            : ''
          showFilePaneSyncNotice(
            op.fileId,
            `文档已在云端更新${cloudMeta}。当前编辑器仍显示打开时的版本；未保存的修改不会自动合并。请先保存或撤销，再刷新到云端版本。`,
          )
          return
        }
        await openWorkspaceFile(op.fileId)
      }
    } catch {
      // 文件列表刷新失败不影响对话继续；下一次手动刷新会重新读取。
    }
  })()
}

function fileActivitySnippet(activity) {
  if (!activity) return ''
  if (activity.kind === 'rename') {
    return `${oneLinePreview(activity.from || '—', 70)} → ${oneLinePreview(activity.to || '—', 70)}`
  }
  if (activity.kind === 'delete') return '文件已移入回收目录，列表同步刷新中'
  if (activity.kind === 'edit' && activity.status !== 'error') {
    return `已局部修改 ${activity.changes || 0} 处片段，其余内容未变`
  }
  if (activity.status === 'error') return oneLinePreview(activity.errorText || '文件操作失败', 180)
  const text = String(activity.text || '')
  if (!text) {
    if (activity.status === 'running') return 'Agent 正在生成文件内容…'
    if (activity.status === 'done') return '操作已完成'
    return '等待文件操作'
  }
  const lines = text.split(/\r?\n/)
  const nonEmpty = lines.filter((line) => line.trim())
  const tail = nonEmpty.slice(-2).join('  /  ') || text
  return oneLinePreview(tail, 220)
}

function renderFileDock() {
  const dock = $('#file-dock')
  if (!dock) return
  const activity = state.fileActivity
  if (
    !activity ||
    state.fileDockClosed ||
    state.fileDockSettled ||
    state.fileDockPreviewSuppressed
  ) {
    dock.hidden = true
    dock.innerHTML = ''
    return
  }
  const badge = fileBadgeLabel(activity.name)
  const canOpen = activity.status !== 'running' && activity.kind !== 'delete' && Boolean(activity.fileId || activity.path)
  const lineCount = String(activity.text || '').split(/\r?\n/).length
  const size = String(activity.text || '')
    ? (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(String(activity.text)).length : String(activity.text).length)
    : 0
  const duration = activity.status === 'done' && activity.durationMs > 0 ? ` · ${formatElapsed(activity.durationMs)}` : ''
  const actionText = activity.kind === 'write'
    ? (activity.created ? '新建文件' : activity.status === 'done' ? '修改文件' : '写入文件')
    : activity.copy?.action || '文件操作'
  const detail = activity.kind === 'write' || activity.kind === 'read'
    ? `${lineCount} 行${size ? ` · ${fmtSize(size)}` : ''}${duration}`
    : activity.kind === 'edit'
      ? `局部修改 ${activity.changes || 0} 处${duration}`
      : activity.kind === 'rename'
        ? `名称变更${duration}`
        : activity.kind === 'delete'
          ? '已删除'
          : `文件发送${duration}`
  dock.hidden = false
  dock.className = `file-dock is-${activity.status} is-${activity.kind}`
  dock.innerHTML = `<div class="file-dock-card" data-file-dock-open role="button" tabindex="0" title="打开文件预览">
    <span class="file-dock-badge is-${badge.tone}">${badge.label}</span>
    <div class="file-dock-main">
      <div class="file-dock-title-row">
        <strong>${esc(activity.name)}</strong>
        <span class="file-dock-status"><span class="file-dock-dot"></span>${esc(activity.statusLabel)}</span>
        <span class="file-dock-step">Agent 文件操作 · 第 ${activity.step || 1} 步</span>
      </div>
      <div class="file-dock-sub">${esc(actionText)}${activity.path ? ` · ${esc(activity.path)}` : ''}</div>
      <div class="file-dock-snippet">${esc(fileActivitySnippet(activity))}</div>
    </div>
    <div class="file-dock-actions">
      <span class="file-dock-detail">${esc(detail)}</span>
      ${canOpen ? '<button class="file-dock-open" type="button" data-file-dock-open>打开预览</button>' : `<span class="file-dock-wait">${activity.status === 'running' ? '完成后可预览' : ''}</span>`}
      <button class="file-dock-close" type="button" data-file-dock-close title="关闭文件操作卡片" aria-label="关闭文件操作卡片">×</button>
    </div>
    <span class="file-dock-progress"><span></span></span>
  </div>`
}

function settleFileDock() {
  if (!state.fileActivity) return
  state.fileDockSettled = true
  renderFileDock()
}

function suppressFileDockForPreview() {
  state.fileDockPreviewSuppressed = true
  renderFileDock()
}

function restoreFileDockAfterPreview() {
  if (!state.fileActivity) return
  state.fileDockPreviewSuppressed = false
  // 关闭预览时只恢复仍在执行的文件操作卡；已完成的卡片保持收起状态。
  if (!state.fileDockClosed && state.fileActivity.status === 'running') state.fileDockSettled = false
  renderFileDock()
}

function updateFileActivity(trace) {
  const op = fileOperationInfo(trace)
  if (!op) return
  const previous = state.fileActivity
  const traceId = String(trace?.id || '')
  const sameTrace = Boolean(previous && traceId && previous.traceId === traceId)
  const same = previous && (
    (op.fileId && previous.fileId === op.fileId) ||
    (op.path && previous.path === op.path) ||
    (!op.fileId && !op.path && previous.name === op.name)
  )
  state.fileActivity = {
    ...op,
    name: op.name || previous?.name || '文件',
    path: op.path || previous?.path || '',
    traceId,
    step: sameTrace ? previous.step : same ? Number(previous.step || 1) + 1 : 1,
    startedAt: same ? previous.startedAt : Date.now(),
    text: op.kind === 'delete' ? '' : (op.text || (same ? previous.text : '')),
    updatedAt: Date.now(),
  }
  state.fileDockClosed = false
  state.fileDockSettled = false
  renderFileDock()
}

function clearFileActivity() {
  state.fileActivity = null
  state.fileDockClosed = false
  state.fileDockSettled = false
  state.fileDockPreviewSuppressed = false
  renderFileDock()
}

async function openFileDockPreview() {
  const activity = state.fileActivity
  if (!activity) return
  if (activity.status === 'running' && !activity.fileId) {
    banner('Agent 还在写入文件，完成后就能打开预览', 'warn')
    return
  }
  let fileId = String(activity.fileId || '').trim()
  const path = String(activity.path || '').trim()
  try {
    if (!fileId || !state.files.some((file) => file.id === fileId)) await loadWorkspaceFiles()
    if (fileId && !state.files.some((file) => file.id === fileId)) fileId = ''
    if (!fileId && path) {
      const match = state.files.find((file) => file.relPath === path || file.name === path || baseFileName(file.relPath) === path)
      fileId = match?.id || ''
    }
    if (!fileId) {
      banner('文件列表还没有同步完成，请稍后再试。', 'bad')
      return
    }
    await openWorkspaceFile(fileId, { split: true })
  } catch (err) {
    banner(`打开文件失败：${err.message}`, 'bad')
  }
}

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return
  const close = event.target.closest('[data-file-dock-close]')
  if (close) {
    event.preventDefault()
    event.stopPropagation()
    state.fileDockClosed = true
    renderFileDock()
    return
  }
  const open = event.target.closest('[data-file-dock-open]')
  if (!open) return
  event.preventDefault()
  event.stopPropagation()
  void openFileDockPreview()
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  if (!(event.target instanceof HTMLElement)) return
  const card = event.target.closest('.file-dock-card[data-file-dock-open]')
  if (!card || event.target.closest('button')) return
  event.preventDefault()
  void openFileDockPreview()
})

document.addEventListener('mouseup', (event) => {
  if (!(event.target instanceof Element) || !event.target.closest('#file-pane-body')) return
  // 等浏览器先完成 selection 更新，再显示“引用选中内容”。
  window.setTimeout(refreshPreviewSelection, 0)
})

document.addEventListener('keyup', (event) => {
  if (!(event.target instanceof Element) || !event.target.closest('#file-pane-body')) return
  window.setTimeout(refreshPreviewSelection, 0)
})

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return
  const button = event.target.closest('#file-selection-action')
  if (!button) return
  event.preventDefault()
  quotePreviewSelection()
})

/** 工具调用收成一张可折叠面板：默认只留标题，执行中再加一行当前工具。 */
function toolPanelHtml(tools, { active = false, expanded = false } = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return ''
  const preview = active
    ? latestToolPreview(tools)
    : tools
        .map((tool) =>
          tool.durationMs > 0 ? `${tool.name} ${formatElapsed(tool.durationMs)}` : tool.name,
        )
        .join(' · ')
  const totalMs = tools.reduce((sum, tool) => sum + (Number(tool.durationMs) || 0), 0)
  const statusText = `${tools.length} 个${totalMs > 0 ? ` · ${formatElapsed(totalMs)}` : ''}`
  return `<div class="tool-panel${active ? ' is-active' : ''}${expanded ? '' : ' is-collapsed'}" data-tool-panel>
    <button class="tool-head" type="button" aria-expanded="${expanded ? 'true' : 'false'}">
      <span class="tool-dot"></span>
      <strong class="tool-title">${active ? '工具调用中…' : '工具调用记录'}</strong>
      <span class="tool-status">${esc(statusText)}</span>
      <span class="tool-chevron">⌄</span>
    </button>
    ${preview ? `<div class="tool-peek">${esc(preview)}</div>` : ''}
    <div class="tool-body">${tools.map((trace) => toolDetailHtml(trace)).join('')}</div>
  </div>`
}

/** 历史里的思考过程默认收起，只保留标题和可展开的完整内容。 */
function thinkPanelHtml(reasoning) {
  return `<div class="think-panel is-collapsed">
    <button class="think-head" type="button" aria-expanded="false">
      <span class="think-icon">✦</span>
      <span class="think-title">已深度思考</span>
      <span class="think-chevron">⌄</span>
    </button>
    <div class="think-body">${esc(reasoning)}</div>
  </div>`
}

function channelTag(channel) {
  if (channel === 'dingtalk') return '<span class="channel-tag">钉钉</span>'
  return ''
}

function clarifyInlineNote() {
  return `<div class="clarify-inline-note"><span class="clarify-mark" aria-hidden="true">?</span><span>需要先确认方向，请选择或补充。</span></div>`
}

function historyMetaText(meta) {
  if (!meta) return ''
  if (typeof meta === 'string' || typeof meta === 'number') return String(meta)
  if (typeof meta === 'object') {
    return [meta.modelName, meta.autoSelected ? '自动选择' : '']
      .filter(Boolean)
      .join(' · ')
  }
  return ''
}

function historyAiBubble(text, meta, rich, options = {}) {
  const reasoning = String(rich?.reasoning || '').trim()
  const tools = Array.isArray(rich?.toolCalls) ? rich.toolCalls : []
  const channel = channelTag(rich?.channel)
  const clarify = rich?.clarify && typeof rich.clarify === 'object' ? rich.clarify : null
  const metaText = historyMetaText(meta)
  const body = clarify && options.pendingClarify
    ? clarifyInlineNote()
    : `<div class="answer-text">${renderAnswer(text, { omitCodeBlocks: writtenFileContentBlocks(tools) })}</div>`
  return `${reasoning ? thinkPanelHtml(reasoning) : ''}
    ${tools.length > 0 ? toolPanelHtml(tools) : ''}
    ${body}
    ${metaText || channel ? `<span class="meta">${channel}${metaText ? esc(metaText) : ''}</span>` : ''}`
}

/** AI 没有足够方向时给出的结构化问题 + 可点击方向 + 自定义补充入口。 */
function clarifyPanelHtml(clarify, options = {}) {
  if (!clarify || typeof clarify !== 'object') return ''
  const question = String(clarify.question || '').trim()
  const optionsList = Array.isArray(clarify.options) ? clarify.options.slice(0, 4) : []
  if (!question || optionsList.length < 2) return ''
  const allowCustom = clarify.allowCustom !== false
  const docked = options.docked === true
  const step = Math.max(0, Math.trunc(Number(options.step) || 0))
  const previous = String(options.previous || '').trim()
  const exitable = options.exitable === true
  const stepLine =
    step > 0
      ? `<div class="clarify-stepline">
          <span class="clarify-step">第 ${step} 步</span>
          ${previous ? `<span class="clarify-prev">上一步：${esc(oneLinePreview(previous, 24))}</span>` : ''}
          ${exitable ? '<button class="clarify-exit" type="button" data-clarify-exit>退出引导</button>' : ''}
        </div>`
      : ''
  return `<div class="clarify-card${docked ? ' is-docked' : ''}" role="group" aria-label="需要你确认方向">
    ${stepLine}
    <div class="clarify-head"><span class="clarify-mark" aria-hidden="true">?</span><span>需要你确认方向</span></div>
    <div class="clarify-question">${esc(question)}</div>
    <div class="clarify-options">
      ${optionsList.map((option) => {
        const label = String(option?.label || '').trim()
        const description = String(option?.description || '').trim()
        if (!label) return ''
        return `<button class="clarify-option" type="button" data-clarify-answer="${esc(label)}">
          <span class="clarify-option-label">${esc(label)}</span>
          ${description ? `<span class="clarify-option-desc">${esc(description)}</span>` : ''}
        </button>`
      }).join('')}
    </div>
    <div class="clarify-auto" id="clarify-auto" hidden></div>
    ${
      allowCustom
        ? docked
          ? '<div class="clarify-hint">也可以直接在下方输入框补充自己的方向。</div>'
          : `<div class="clarify-custom">
              <input class="clarify-input" type="text" maxlength="200" placeholder="也可以直接补充你的方向…" aria-label="补充你的方向">
              <button class="clarify-send" type="button">发送</button>
            </div>`
        : ''
    }
  </div>`
}

/** 多页澄清的中间消息只作为 Agent 上下文，不进入聊天消息流。 */
function isHiddenClarifyStep(message) {
  if (!message?.meta) return false
  if (message.role === 'user') return Boolean(message.meta.clarifyFlowId)
  return message.role === 'assistant' && Boolean(message.meta.clarify)
}

function newClarifyFlowId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `cf_${crypto.randomUUID()}`
  }
  return `cf_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

/** 当前底部导引流程；历史刷新时用消息 meta 里的 flowId / step 续上同一个流程。 */
function ensureClarifyFlow(meta) {
  const incomingId = String(meta?.clarifyFlowId || '').trim()
  const incomingStep = Number(meta?.clarifyStep)
  const step =
    Number.isFinite(incomingStep) && incomingStep > 0 ? Math.min(20, Math.trunc(incomingStep)) : 1
  if (state.clarifyFlow && (!incomingId || state.clarifyFlow.id === incomingId)) {
    if (step > state.clarifyFlow.step) state.clarifyFlow.step = step
    return state.clarifyFlow
  }
  if (state.clarifyFlow) {
    stopClarifyAuto(state.clarifyFlow)
    if (state.clarifyFlow.controller) state.clarifyFlow.controller.abort()
  }
  state.clarifyFlow = {
    id: incomingId || newClarifyFlowId(),
    step,
    answers: [],
    busy: false,
    controller: null,
    sessionId: state.sessionId,
    modelId: state.selected || null,
    reasoningEffort: state.reasoningEffort || null,
    turn: null,
    autoTimer: 0,
    autoTick: 0,
    autoDeadline: 0,
    autoSelectMs: CLARIFY_AUTO_SELECT_MS,
    autoOptionLabel: '',
    lastAuto: false,
  }
  return state.clarifyFlow
}

/** 最后一条消息仍是 AI 的方向确认时，刷新后继续在底部输入区等待回答。 */
function trailingPendingClarify(messages) {
  if (!Array.isArray(messages)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') return null
    if (message?.role === 'assistant') {
      return message.meta?.clarify && typeof message.meta.clarify === 'object' ? message : null
    }
  }
  return null
}

function stopClarifyAuto(flow = state.clarifyFlow) {
  if (!flow) return
  if (flow.autoTimer) window.clearTimeout(flow.autoTimer)
  if (flow.autoTick) window.clearInterval(flow.autoTick)
  flow.autoTimer = 0
  flow.autoTick = 0
  flow.autoDeadline = 0
  const hint = $('#clarify-auto')
  if (hint) {
    hint.hidden = true
    hint.textContent = ''
  }
}

function formatClarifyAutoWait(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒` : `${seconds} 秒`
}

function updateClarifyAutoHint(flow = state.clarifyFlow) {
  const hint = $('#clarify-auto')
  if (!hint) return
  if (!flow?.autoDeadline) {
    hint.hidden = true
    return
  }
  const remaining = Math.max(0, Math.ceil((flow.autoDeadline - Date.now()) / 1000))
  hint.hidden = false
  hint.textContent = remaining > 0
    ? `${formatClarifyAutoWait(flow.autoDeadline - Date.now())}后自动选择：${flow.autoOptionLabel || '第一个方向'}`
    : '等待超时，正在自动选择…'
}

/** 用户迟迟不选时，等待一段时间后自动采用第一个方向，避免流程一直悬着。 */
function startClarifyAutoSelect(flow = state.clarifyFlow) {
  const clarify = state.pendingClarify
  if (!flow || !clarify || flow.busy) return
  const optionsList = Array.isArray(clarify.options) ? clarify.options : []
  const first = optionsList.map((option) => String(option?.label || '').trim()).find(Boolean)
  if (!first) return
  stopClarifyAuto(flow)
  flow.autoSelectMs = Number(flow.autoSelectMs) > 0 ? flow.autoSelectMs : CLARIFY_AUTO_SELECT_MS
  flow.autoOptionLabel = first
  flow.autoDeadline = Date.now() + flow.autoSelectMs
  flow.autoTimer = window.setTimeout(() => {
    flow.autoTimer = 0
    if (state.clarifyFlow !== flow || !state.pendingClarify || flow.busy) return
    const runtime = runtimeFor(flow.sessionId ?? state.sessionId)
    if (runtime.sending) {
      startClarifyAutoSelect(flow)
      return
    }
    stopClarifyAuto(flow)
    banner(`已等待 ${formatClarifyAutoWait(flow.autoSelectMs)}，自动选择：${first}`)
    advanceClarifyFlow(first, { auto: true })
  }, flow.autoSelectMs)
  flow.autoTick = window.setInterval(() => updateClarifyAutoHint(flow), 1000)
  updateClarifyAutoHint(flow)
}

function hideClarifyDockView() {
  const dock = $('#clarify-dock')
  if (!dock) return
  dock.hidden = true
  dock.innerHTML = ''
}

/** 方向选项直接渲染进当前 AI 气泡；底部不再出现独立的引导浮层。 */
function showClarifyDock(clarify, options = {}) {
  const flow = ensureClarifyFlow(options.flowMeta)
  const step = Number(options.step)
  if (Number.isFinite(step) && step > 0) flow.step = Math.max(flow.step, Math.trunc(step))
  const previous = flow.answers.length
    ? flow.answers[flow.answers.length - 1].answer
    : String(options.previous || '').trim()
  if (!clarifyPanelHtml(clarify, { docked: false, step: flow.step, previous, exitable: true })) return
  let turn = flow.turn?.node?.isConnected ? flow.turn : null
  if (!turn) {
    turn = createAiTurn({ append: true })
    flow.turn = turn
  }
  hideClarifyDockView()
  const input = $('#input')
  if (input) input.placeholder = '也可以直接输入你的回答或补充，Enter 发送…'
  turn.showClarifyPrompt(clarify, { step: flow.step, previous, auto: options.auto })
}

function showClarifyBusy(flow, answer, options = {}) {
  stopClarifyAuto(flow)
  hideClarifyDockView()
  const turn = flow.turn?.node?.isConnected ? flow.turn : null
  if (turn?.waitForReply) {
    turn.waitForReply(options.auto ? '等待超时，已自动选择，等待回复中…' : '等待回复中…')
  }
  const input = $('#input')
  if (input) input.placeholder = '正在等待回复…'
}

function clearClarifyDock(options = {}) {
  stopClarifyAuto(state.clarifyFlow)
  state.clarifyFlow?.turn?.clearClarifyPrompt?.()
  if (options.abort && state.clarifyFlow?.controller) state.clarifyFlow.controller.abort()
  state.pendingClarify = null
  state.clarifyFlow = null
  hideClarifyDockView()
  const input = $('#input')
  if (input) input.placeholder = DEFAULT_INPUT_PLACEHOLDER
}

function bindClarifyPanel(node) {
  for (const card of node.querySelectorAll('.clarify-card')) {
    if (card.dataset.bound === 'true') continue
    card.dataset.bound = 'true'
    const submit = (value) => {
      const text = String(value || '').trim()
      if (!text) return
      advanceClarifyFlow(text)
    }
    for (const option of card.querySelectorAll('.clarify-option')) {
      option.addEventListener('click', () => submit(option.dataset.clarifyAnswer || option.textContent))
    }
    const input = card.querySelector('.clarify-input')
    const sendButton = card.querySelector('.clarify-send')
    if (input && sendButton) {
      sendButton.addEventListener('click', () => submit(input.value))
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault()
          submit(input.value)
        }
      })
    }
    const exit = card.querySelector('[data-clarify-exit]')
    if (exit) {
      exit.addEventListener('click', () => {
        clearClarifyDock()
        banner('已退出这次引导，之后可以直接发消息继续', 'warn')
      })
    }
  }
}

/** 选择方向或补充内容：隐藏续跑 Agent，不新增用户气泡。 */
function advanceClarifyFlow(answer, options = {}) {
  const text = String(answer || '').trim()
  const clarify = state.pendingClarify
  if (!text || !clarify) return
  const flow = ensureClarifyFlow()
  if (flow.busy) return
  stopClarifyAuto(flow)
  flow.sessionId = flow.sessionId || state.sessionId
  flow.modelId = flow.modelId || state.selected || null
  flow.reasoningEffort = flow.reasoningEffort || state.reasoningEffort || null
  flow.answers.push({ question: String(clarify.question || ''), answer: text })
  flow.busy = true
  flow.lastAuto = options.auto === true
  if (flow.sessionId) {
    markSessionActive(flow.sessionId)
    renderSessions()
  }
  showClarifyBusy(flow, text, options)
  void runClarifyStep(flow, text, clarify)
}

/** 把一页答案作为隐藏续跑发给 Agent，下一页仍回到同一个 AI 气泡内的引导区。 */
async function runClarifyStep(flow, answer, answeredClarify) {
  const runtime = runtimeFor(flow.sessionId ?? state.sessionId)
  if (runtime.sending) return
  const controller = new AbortController()
  flow.controller = controller
  runtime.controller = controller
  runtime.sending = true
  renderSessions()
  renderQueueState()
  updateSendState()
  const targetSessionId = flow.sessionId ?? state.sessionId
  const nextStep = flow.step + 1
  const startedAt = Date.now()
  const selectionAt = new Date(startedAt).toISOString()
  let turn = null
  if (targetSessionId === state.sessionId || targetSessionId === null) {
    if (flow.turn?.node?.isConnected) {
      turn = flow.turn
      turn.reset({
        createdAt: selectionAt,
        waitingText: flow.lastAuto ? '等待超时，已自动选择，等待回复中…' : '等待回复中…',
      })
    } else {
      turn = createAiTurn({ append: true, createdAt: selectionAt })
      flow.turn = turn
      turn.waitForReply(flow.lastAuto ? '等待超时，已自动选择，等待回复中…' : '等待回复中…')
    }
    runtime.turn = turn
    scrollThreadToBottomInstant()
  }
  const turnStartedLive = Boolean(turn)
  const buffered = { reasoning: '', content: '', tools: [], toolResults: [], done: null, clarify: null, messageId: '' }
  let streamError = null
  let sawDone = false
  let messageId = ''
  try {
    await streamChat(
      {
        modelId: flow.modelId,
        reasoningEffort: flow.reasoningEffort,
        text: answer,
        sessionId: targetSessionId,
        spaceKind: state.spaceKind,
        clarifyFlowId: flow.id,
        clarifyStep: nextStep,
        activeFile: activePreviewFilePayload(),
      },
      (event, data) => {
        if (event === 'meta') {
          messageId = String(data.messageId || '')
          if (messageId) {
            state.localLiveMessageIds.add(messageId)
            state.historyMessageIds.add(messageId)
            if (turn) {
              turn.node.dataset.messageId = messageId
              state.liveTurns.set(messageId, {
                turn,
                sessionId: data.sessionId || runtime.sessionId,
                messageId,
                hydrated: true,
              })
              refreshMessageActions(turn.node)
            }
          }
          runtime.runId = data.runId || runtime.runId
          if (data.runId) beginParentAgentTurn(data.runId)
          runtime.messageId = messageId
          if (data.sessionId) {
            migrateRuntime(runtime, data.sessionId)
            flow.sessionId = data.sessionId
            if (state.sessionId === data.sessionId) {
              state.sessionId = data.sessionId
              persistChatLocation()
              if ($('#chat-title').textContent === '新对话') {
                $('#chat-title').textContent = '方向确认'
              }
            }
          }
        } else if (event === 'reasoning') {
          buffered.reasoning += String(data.text || '')
          if (turn) turn.reasoning(String(data.text || ''))
        } else if (event === 'delta') {
          buffered.content += String(data.text || '')
          if (turn) turn.content(String(data.text || ''))
        } else if (event === 'tool') {
          buffered.tools.push(data)
          if (turn) turn.tool(data)
        } else if (event === 'tool_result') {
          buffered.toolResults.push(data)
          if (turn) turn.toolResult(data)
        } else if (event === 'agent') {
          updateAgentEvent(data)
        } else if (event === 'clarify') {
          buffered.clarify = data.clarify || buffered.clarify
        } else if (event === 'done') {
          sawDone = true
          buffered.done = data
          if (data.clarify) buffered.clarify = data.clarify
          if (data.sessionId) {
            migrateRuntime(runtime, data.sessionId)
            flow.sessionId = data.sessionId
            if (state.sessionId === data.sessionId) {
              state.sessionId = data.sessionId
              persistChatLocation()
            }
          }
        } else if (event === 'error') {
          const err = new Error(data.message || '模型调用失败')
          err.code = data.code
          streamError = err
        }
      },
      controller.signal,
    )
    if (controller.signal.aborted) throw new DOMException('已停止', 'AbortError')
    if (streamError) throw streamError
    if (!sawDone) throw new Error('回答流意外中断，请重试')

    const userMessageId = String(buffered.done?.userMessageId || '')
    if (userMessageId) state.historyMessageIds.add(userMessageId)

    if (buffered.clarify) {
      flow.busy = false
      flow.step = nextStep
      state.pendingClarify = buffered.clarify
      state.clarifyFlow = flow
      if (turn) {
        const doneData = buffered.done || { text: buffered.content }
        const questionText = String(
          doneData.text || buffered.clarify.question || buffered.content || '',
        )
        if (messageId) {
          turn.node.dataset.messageId = messageId
          turn.node.chatMessage = {
            id: messageId,
            role: 'assistant',
            text: questionText,
            createdAt: doneData.createdAt || new Date().toISOString(),
          }
          state.historyMessageIds.add(messageId)
          setMessageTime(turn.node, doneData.createdAt)
          refreshMessageActions(turn.node)
        }
        turn.finish({ ...doneData, text: questionText, clarify: null })
        if (messageId) state.liveTurns.delete(messageId)
      }
      showClarifyDock(buffered.clarify, { step: nextStep, auto: true })
      loadSessions()
      return
    }

    flow.busy = false
    flow.controller = null
    runtime.sending = false
    runtime.controller = null
    runtime.runId = null
    state.clarifyFlow = null
    state.pendingClarify = null
    clearClarifyDock()
    if (!turn && runtime.sessionId === state.sessionId) {
      turn = createAiTurn({ append: true, createdAt: selectionAt })
      runtime.turn = turn
    }
    if (turn && messageId) {
      turn.node.dataset.messageId = messageId
      turn.node.chatMessage = {
        id: messageId,
        role: 'assistant',
        text: String(buffered.done?.text || buffered.content || ''),
        createdAt: buffered.done?.createdAt || new Date().toISOString(),
      }
      setMessageTime(turn.node, buffered.done?.createdAt)
      refreshMessageActions(turn.node)
    }
    if (turn && !turnStartedLive) {
      if (buffered.reasoning.trim()) turn.reasoning(buffered.reasoning)
      for (const event of buffered.tools) turn.tool(event)
      for (const event of buffered.toolResults) turn.toolResult(event)
    }
    if (turn) turn.finish(buffered.done || { text: buffered.content })
    if (messageId) state.liveTurns.delete(messageId)
    if (messageId) {
      state.historyMessageIds.add(messageId)
      state.localLiveMessageIds.delete(messageId)
    }
    loadSessions()
    renderQueueState()
    updateSendState()
  } catch (err) {
    const aborted = controller.signal.aborted
    if (turn) {
      if (aborted) turn.stop()
      else turn.fail(`引导续跑失败：${err.message}`)
    }
    if (state.clarifyFlow === flow) {
      flow.busy = false
      flow.controller = null
      if (flow.answers.length > 0) flow.answers.pop()
      if (aborted) {
        showClarifyDock(answeredClarify, { step: flow.step })
        banner('已停止这次引导，你可以重新选择或补充', 'warn')
      } else {
        showClarifyDock(answeredClarify, { step: flow.step })
        banner(`引导续跑失败：${err.message}`, 'warn')
      }
    }
  } finally {
    runtime.sending = false
    runtime.controller = null
    if (runtime.turn === turn) runtime.turn = null
    if (messageId) {
      const live = state.liveTurns.get(messageId)
      if (live?.turn === turn) state.liveTurns.delete(messageId)
    }
    if (messageId && runtime.messageId === messageId) runtime.messageId = null
    if (messageId) state.localLiveMessageIds.delete(messageId)
    renderSessions()
    updateSendState()
    renderQueueState()
    if (runtime.queue.length > 0) {
      void drainQueue(runtime)
    } else if (state.sessionId === runtime.sessionId || runtime.sessionId === null) {
      $('#input').focus()
    }
  }
}

function bindToolToggles(node) {
  for (const button of node.querySelectorAll('.tool-head, .think-head')) {
    if (button.dataset.bound === 'true') continue
    button.dataset.bound = 'true'
    button.addEventListener('click', () => {
      const panel = button.closest('.tool-panel, .tool-card, .think-panel')
      if (!panel) return
      const collapsed = panel.classList.toggle('is-collapsed')
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
    })
  }
}

function myDisplayName() {
  return String(state.me?.person?.name || $('#user-name')?.textContent || '我').trim() || '我'
}

function formatMessageStamp(value) {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) return null
  const now = new Date()
  const pad = (number) => String(number).padStart(2, '0')
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const isSameDay = (left, right) =>
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  let short = hhmm
  if (!isSameDay(date, now)) {
    short = isSameDay(date, yesterday)
      ? `昨天 ${hhmm}`
      : date.getFullYear() === now.getFullYear()
        ? `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`
        : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`
  }
  const full = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`
  return { iso: date.toISOString(), short, full }
}

function setMessageTime(node, value) {
  const time = node?.querySelector('.msg-time')
  const stamp = formatMessageStamp(value)
  if (!time || !stamp) return
  time.dateTime = stamp.iso
  time.title = stamp.full
  time.textContent = stamp.short
}

const MESSAGE_ACTION_ICONS = {
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5h4L19 9a2.2 2.2 0 0 0-3.1-3.1L5.5 16.4v3.1Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m13.5 6.5 3.1 3.1" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  recall:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 5 11l4 4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M5 11h8.2A5.8 5.8 0 0 1 19 16.8" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  delete:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2M8 7l1 12h6l1-12M10 10v6M14 10v6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
}

function messageFooterMarkup(role) {
  const actions =
    role === 'me'
      ? `<button type="button" class="msg-action" data-message-act="edit" title="编辑后重发" aria-label="编辑后重发">${MESSAGE_ACTION_ICONS.edit}</button>
         <button type="button" class="msg-action" data-message-act="recall" title="撤回" aria-label="撤回">${MESSAGE_ACTION_ICONS.recall}</button>
         <button type="button" class="msg-action is-danger" data-message-act="delete" title="删除" aria-label="删除">${MESSAGE_ACTION_ICONS.delete}</button>`
      : `<button type="button" class="msg-action is-danger" data-message-act="delete" title="删除回答" aria-label="删除回答">${MESSAGE_ACTION_ICONS.delete}</button>`
  const actionsBlock = `<div class="msg-actions" role="group" aria-label="消息操作" hidden>${actions}</div>`
  const time = '<time class="msg-time"></time>'
  const blocks =
    role === 'me'
      ? `${actionsBlock}${time}`
      : `${time}${actionsBlock}`
  return `<div class="msg-footer">
    ${blocks}
  </div>`
}

function refreshMessageActions(node) {
  const actions = node?.querySelector('.msg-actions')
  if (!actions) return
  actions.hidden = !node.dataset.messageId
}

function sessionReplyBusy() {
  const runtime = currentRuntime()
  if (runtime?.sending) return true
  if (
    Array.from(state.liveTurns.values()).some((entry) => entry.sessionId === state.sessionId)
  ) {
    return true
  }
  return Array.from(state.activeRunSnapshots.values()).some(
    (run) => run.sessionId === state.sessionId && run.status === 'running',
  )
}

function syncMessageActionAvailability() {
  const thread = $('#thread')
  if (thread) thread.dataset.replyBusy = sessionReplyBusy() ? 'true' : 'false'
}

function appendMessage(role, text, meta, attachments, rich, options = {}) {
  setEmptyVisible(false)
  const node = document.createElement('div')
  node.className = `msg ${role === 'me' ? 'me' : 'ai'}`
  if (options.messageId) {
    node.dataset.messageId = String(options.messageId)
    node.chatMessage = {
      id: String(options.messageId),
      role: role === 'me' ? 'user' : 'assistant',
      text: String(text || ''),
      createdAt: options.createdAt || new Date().toISOString(),
    }
  }
  const files = attachments && attachments.length ? `<div class="bubble-files">${attachmentChips(attachments)}</div>` : ''
  const meName = myDisplayName()
  const channel = channelTag(options.channel)
  const footer = messageFooterMarkup(role === 'me' ? 'me' : 'ai')
  node.innerHTML =
    role === 'me'
      ? `<div class="msg-body"><div class="bubble">${esc(text)}${files}</div>${footer}</div>
        <div class="who-me"><span class="who-name">${esc(meName)}</span>${channel}${avatarMarkup(meName, meAvatarUrl(), 'who-badge me')}</div>`
      : `${aiWhoMarkup()}<div class="msg-body"><div class="bubble ai-turn">${historyAiBubble(text, meta, rich || {}, options)}</div>${footer}</div>`
  const thread = $('#thread')
  if (options.prepend) {
    const firstMessage = thread.querySelector('.msg')
    thread.insertBefore(node, firstMessage || null)
  } else {
    thread.appendChild(node)
  }
  setMessageTime(node, options.createdAt)
  refreshMessageActions(node)
  bindToolToggles(node)
  if (options.scroll !== false) {
    if (threadScrollPinned) node.scrollIntoView({ block: 'end', behavior: 'smooth' })
    else markThreadNewContent()
  }
  queueScrollBottomButtonUpdate()
  return node
}

/** 创建一条可实时更新的 AI 回答：思考过程 + 工具卡片 + 最终答案。 */
function createAiTurn(options = {}) {
  const append = options.append !== false
  if (append) setEmptyVisible(false)
  const node = document.createElement('div')
  node.className = 'msg ai'
  node.innerHTML = `${aiWhoMarkup()}<div class="msg-body"><div class="bubble ai-turn">
    <div class="think-panel is-collapsed" hidden>
      <button class="think-head" type="button" aria-expanded="false">
        <span class="think-icon">✦</span><span class="think-title">正在思考…</span><span class="think-chevron">⌄</span>
      </button>
      <div class="think-peek" hidden></div>
      <div class="think-body"></div>
    </div>
    <div class="tool-slot" hidden></div>
    <div class="ai-status"><span class="ai-status-dot"></span><span class="ai-status-text">正在思考中…</span></div>
    <div class="ai-waiting" hidden><span class="ai-waiting-dot"></span><span class="ai-waiting-text">等待回复中…</span></div>
    <div class="clarify-slot" hidden></div>
    <div class="answer-text"></div>
    <span class="meta" hidden></span>
  </div>${messageFooterMarkup('ai')}</div>`
  setMessageTime(node, options.createdAt || Date.now())
  refreshMessageActions(node)
  if (append) {
    $('#thread').appendChild(node)
    bindToolToggles(node)
    scrollThreadToBottomInstant()
  }
  const think = node.querySelector('.think-panel')
  const thinkTitle = node.querySelector('.think-title')
  const thinkPeek = node.querySelector('.think-peek')
  const thinkBody = node.querySelector('.think-body')
  const toolPanel = node.querySelector('.tool-slot')
  const status = node.querySelector('.ai-status')
  const statusText = node.querySelector('.ai-status-text')
  const answer = node.querySelector('.answer-text')
  const metaLine = node.querySelector('.meta')
  const clarifySlot = node.querySelector('.clarify-slot')
  const waiting = node.querySelector('.ai-waiting')
  const waitingText = node.querySelector('.ai-waiting-text')
  let startedAt = Date.now()
  let firstAnswerAt = 0
  let rawAnswer = ''
  let answerRenderQueued = false
  let scrollQueued = false
  let renderGeneration = 0
  const toolTraces = []
  /** 当前回合按 tool_call index 累积的参数；只用于右侧预览，不写入工具轨迹。 */
  const streamToolDrafts = new Map()

  const scroll = () => {
    // 后台会话的节点不在当前消息流里，不能因为它的增量把当前页面滚到底部。
    if (!node.isConnected) return
    if (!threadScrollPinned) {
      markThreadNewContent()
      return
    }
    if (scrollQueued) return
    scrollQueued = true
    requestAnimationFrame(() => {
      scrollQueued = false
      // 用户可能在上滚已经打断了上一帧的跟随；这一帧也要重新确认。
      if (!threadScrollPinned) {
        markThreadNewContent()
        return
      }
      scrollThreadToBottomInstant()
    })
  }
  // 最后一条内容常常在 end 事件之后才完成排版，补一帧确保工具面板不被输入区遮住。
  const finalScroll = () => {
    if (!threadScrollPinned) {
      markThreadNewContent()
      return
    }
    scroll()
    setTimeout(() => {
      if (node.isConnected && threadScrollPinned) scrollThreadToBottomInstant()
    }, 120)
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
    think.classList.remove('is-active')
    thinkPeek.hidden = true
    think.querySelector('.think-head').setAttribute('aria-expanded', 'false')
    if (done) {
      const thinkingMs = (firstAnswerAt || Date.now()) - startedAt
      thinkTitle.textContent = `已深度思考 · ${formatElapsed(thinkingMs)}`
    }
  }
  const renderToolPanel = (active) => {
    if (toolTraces.length === 0) {
      toolPanel.hidden = true
      return
    }
    const current = toolPanel.querySelector('.tool-panel')
    const wasExpanded = current ? !current.classList.contains('is-collapsed') : false
    toolPanel.hidden = false
    toolPanel.innerHTML = toolPanelHtml(toolTraces, { active, expanded: wasExpanded })
    bindToolToggles(node)
    scroll()
  }
  /**
   * 实时事件有可能丢失（例如页面刚从后台恢复、SSE 重连或工具事件先于气泡创建）。
   * done 事件带着完整的 reasoning / toolCalls 快照，这里按快照补齐并合并，保证
   * 用户仍能看到“已深度思考”和可展开的工具调用记录。
   */
  const mergeDoneDetails = (data) => {
    const doneReasoning = String(data?.reasoning || '').trim()
    if (doneReasoning && think.hidden) {
      think.hidden = false
      think.classList.add('is-active')
      thinkBody.textContent = doneReasoning
      thinkTitle.textContent = '正在思考中…'
    }
    const calls = Array.isArray(data?.toolCalls) ? data.toolCalls : []
    for (const item of calls) {
      const id = String(item?.id || '').trim()
      if (!id) continue
      const trace = {
        id,
        name: item.name || '工具调用',
        toolId: item.toolId || '',
        args: item.args ?? {},
        status: item.status === 'error' ? 'error' : 'done',
        summary: item.summary || '',
        durationMs: Number(item.durationMs) || 0,
      }
      const existing = toolTraces.find((entry) => entry.id === id)
      if (existing) {
        existing.name = trace.name || existing.name
        existing.toolId = trace.toolId || existing.toolId
        existing.status = trace.status
        existing.summary = trace.summary || existing.summary
        existing.durationMs = trace.durationMs || existing.durationMs
      } else {
        toolTraces.push(trace)
      }
    }
    if (toolTraces.length > 0 && toolPanel.hidden) {
      renderToolPanel(toolTraces.some((item) => item.status === 'running'))
    }
    const lastFileTrace = [...toolTraces].reverse().find((entry) => FILE_OPERATION_TOOLS.has(entry.toolId))
    if (lastFileTrace) updateFileActivity(lastFileTrace)
  }
  // 流式阶段也按 Markdown 渲染；每帧最多重排一次，避免逐 token 抖动。
  const renderStreamingAnswer = () => {
    if (answerRenderQueued) return
    answerRenderQueued = true
    const generation = renderGeneration
    requestAnimationFrame(() => {
      answerRenderQueued = false
      if (generation !== renderGeneration) return
      answer.innerHTML = renderAnswer(rawAnswer, { omitCodeBlocks: writtenFileContentBlocks(toolTraces) })
      scroll()
    })
  }
  let turn = null
  const hideWaiting = () => {
    waiting.hidden = true
  }
  const showWaiting = (text = '等待回复中…') => {
    clarifySlot.hidden = true
    clarifySlot.innerHTML = ''
    answer.hidden = true
    setStatus('正在思考中…')
    waiting.hidden = false
    waitingText.textContent = text
    scroll()
  }
  const showClarifyPrompt = (clarify, options = {}) => {
    const flow = state.clarifyFlow || ensureClarifyFlow()
    flow.turn = turn
    const step = Number.isFinite(Number(options.step)) && Number(options.step) > 0
      ? Math.trunc(Number(options.step))
      : Number(flow?.step) || 1
    const previous = String(options.previous || '').trim()
    const content = clarifyPanelHtml(clarify, {
      docked: false,
      step,
      previous,
      exitable: true,
    })
    if (!content) return
    setStatus('')
    hideWaiting()
    collapseThink(true)
    if (toolTraces.length > 0) {
      toolPanel.innerHTML = toolPanelHtml(toolTraces, { active: false, expanded: false })
      toolPanel.hidden = false
      bindToolToggles(node)
    }
    rawAnswer = ''
    answer.innerHTML = ''
    answer.hidden = true
    answer.classList.remove('is-clarify-note', 'is-error')
    clarifySlot.innerHTML = content
    clarifySlot.hidden = false
    bindClarifyPanel(clarifySlot)
    state.pendingClarify = clarify
    if (state.clarifyFlow) state.clarifyFlow.turn = turn
    if (options.auto) startClarifyAutoSelect(state.clarifyFlow)
    finalScroll()
  }

  turn = {
    node,
    /** 在当前气泡内渲染方向选项，不再使用底部浮层。 */
    showClarifyPrompt(clarify, options = {}) {
      showClarifyPrompt(clarify, options)
      return this
    },
    /** 选项已提交后，在当前气泡显示“正在思考中 / 等待回复中”。 */
    waitForReply(text = '等待回复中…') {
      showWaiting(text)
      return this
    },
    clearClarifyPrompt() {
      clarifySlot.hidden = true
      clarifySlot.innerHTML = ''
      return this
    },
    /** 引导续跑时复用同一条 AI 气泡，清空上一问的内容但保留节点位置。 */
    reset(options = {}) {
      renderGeneration += 1
      startedAt = Date.now()
      firstAnswerAt = 0
      rawAnswer = ''
      answer.innerHTML = ''
      answer.hidden = true
      answer.classList.remove('is-clarify-note', 'is-error')
      think.hidden = true
      think.classList.remove('is-active')
      think.classList.add('is-collapsed')
      thinkTitle.textContent = '正在思考中…'
      thinkPeek.hidden = true
      thinkBody.textContent = ''
      toolTraces.length = 0
      streamToolDrafts.clear()
      finishStreamingFilePreview()
      toolPanel.innerHTML = ''
      toolPanel.hidden = true
      clarifySlot.innerHTML = ''
      clarifySlot.hidden = true
      metaLine.hidden = true
      metaLine.textContent = ''
      showWaiting(options.waitingText || '等待回复中…')
      delete node.dataset.messageId
      node.chatMessage = null
      setMessageTime(node, options.createdAt || Date.now())
      refreshMessageActions(node)
      scrollThreadToBottomInstant()
    },
    appendToThread() {
      if (node.isConnected) return
      setEmptyVisible(false)
      $('#thread').appendChild(node)
      bindToolToggles(node)
      scrollThreadToBottomInstant()
    },
    hydrate(snapshot) {
      if (!snapshot) return
      if (snapshot.reasoning) this.reasoning(snapshot.reasoning)
      if (snapshot.text) this.content(snapshot.text)
      for (const trace of snapshot.toolCalls || []) {
        this.tool(trace)
        if (trace.status !== 'running') {
          this.toolResult({
            id: trace.id,
            status: trace.status,
            summary: trace.summary,
            durationMs: trace.durationMs,
          })
        }
      }
      if (snapshot.status === 'error') this.fail(snapshot.error || '回答失败')
      else if (snapshot.status === 'stopped') this.stop()
    },
    reasoning(text) {
      if (!text) return
      think.hidden = false
      think.classList.add('is-active')
      thinkBody.textContent += text
      thinkTitle.textContent = '正在思考中…'
      setStatus('')
      if (think.classList.contains('is-collapsed')) {
        const peek = oneLinePreview(thinkBody.textContent)
        thinkPeek.textContent = peek
        thinkPeek.hidden = !peek
      }
      thinkBody.scrollTop = thinkBody.scrollHeight
      scroll()
    },
    content(text) {
      if (!text) return
      if (!firstAnswerAt) firstAnswerAt = Date.now()
      if (!rawAnswer) setStatus('')
      hideWaiting()
      clarifySlot.hidden = true
      clarifySlot.innerHTML = ''
      collapseThink(true)
      answer.hidden = false
      answer.classList.remove('is-clarify-note')
      rawAnswer += text
      renderStreamingAnswer()
    },
    tool(event) {
      const trace = { id: event.id, name: event.name, toolId: event.toolId, args: event.args, status: 'running', summary: '', durationMs: 0 }
      toolTraces.push(trace)
      setStatus('')
      updateFileActivity(trace)
      const op = fileOperationInfo(trace)
      if (op) {
        if (trace.toolId === 'office.replace' || trace.toolId === 'office.insert') {
          applyStreamingOfficePreview(trace.args?.fileId, op.path, trace.args?.elementId, op.text)
        } else {
          applyStreamingFilePreview(op.path, op.text)
        }
      }
      renderToolPanel(true)
    },
    /** 模型生成 workspace.write 参数时，同步更新右侧草稿和吊顶卡。 */
    toolDelta(event) {
      const index = Number(event?.index)
      if (!Number.isFinite(index)) return
      const draft = streamToolDrafts.get(index) || { id: '', name: '', raw: '' }
      if (event.name) draft.name = String(event.name)
      if (event.id) draft.id = String(event.id)
      const argumentsDelta = event.argsDelta || event.argumentsDelta
      if (argumentsDelta) draft.raw += String(argumentsDelta)
      streamToolDrafts.set(index, draft)
      if (isOfficeReplaceToolName(draft.name)) {
        const args = partialOfficeReplaceArgs(draft.raw)
        if (args.newText) applyStreamingOfficePreview(args.fileId, args.path, args.elementId, args.newText)
        return
      }
      if (isOfficeInsertToolName(draft.name)) {
        const args = partialOfficeInsertArgs(draft.raw)
        if (args.text) applyStreamingOfficePreview(args.fileId, args.path, args.elementId, args.text)
        return
      }
      if (!isWorkspaceWriteToolName(draft.name)) return
      const args = partialWorkspaceWriteArgs(draft.raw)
      if (!args.path && !args.text) return
      applyStreamingFilePreview(args.path, args.text)
      // 有 call id 才更新吊顶卡：tool 事件到达时按同一个 id 合并，避免多算一步。
      if (draft.id) {
        updateFileActivity({
          id: draft.id,
          name: draft.name,
          toolId: 'workspace.write',
          args: { path: args.path, text: args.text },
          status: 'running',
          summary: '',
          durationMs: 0,
        })
      }
    },
    toolResult(event) {
      const trace = toolTraces.find((item) => item.id === event.id)
      if (!trace) return
      trace.status = event.status
      trace.summary = event.summary
      trace.durationMs = event.durationMs
      setStatus('')
      updateFileActivity(trace)
      renderToolPanel(toolTraces.some((item) => item.status === 'running'))
      // 最后一个工具完成后收起吊顶卡；最终回答仍会保留在消息里。
      if (trace.status === 'done' && !toolTraces.some((item) => item.status === 'running')) {
        settleFileDock()
      }
      const op = fileOperationInfo(trace)
      if (op && op.status === 'done') {
        // 等右侧草稿把最后一段揭示完，再刷新真实文件，避免预览在收尾时跳一下。
        finishStreamingFilePreview(() => refreshWorkspaceAfterFileOperation(op))
      } else if (op) {
        finishStreamingFilePreview()
      }
    },
    clarify(clarify) {
      showClarifyPrompt(clarify)
    },
    finish(data) {
      setStatus('')
      if (data?.createdAt) setMessageTime(node, data.createdAt)
      refreshMessageActions(node)
      mergeDoneDetails(data)
      collapseThink(true)
      if (toolTraces.length > 0) {
        const current = toolPanel.querySelector('.tool-panel')
        const wasExpanded = current ? !current.classList.contains('is-collapsed') : false
        toolPanel.innerHTML = toolPanelHtml(toolTraces, { active: false, expanded: wasExpanded })
        toolPanel.hidden = false
        bindToolToggles(node)
      }
      if (data?.clarify) {
        if (state.clarifyFlow) state.clarifyFlow.turn = turn
        showClarifyPrompt(data.clarify)
      } else {
        hideWaiting()
        clarifySlot.hidden = true
        clarifySlot.innerHTML = ''
        const finalText = String(data?.text || '').trim()
        if (finalText) rawAnswer = finalText
        answer.hidden = false
        answer.classList.remove('is-clarify-note')
        if (rawAnswer) answer.innerHTML = renderAnswer(rawAnswer, { omitCodeBlocks: writtenFileContentBlocks(toolTraces) })
        else if (!answer.textContent) answer.textContent = '（没有返回内容）'
      }
      const citations = data.citations && data.citations.length ? ` · 引用 ${data.citations.length} 条` : ''
      const thinking = think.hidden ? '' : ` · 思考 ${formatElapsed((firstAnswerAt || Date.now()) - startedAt)}`
      metaLine.hidden = false
      metaLine.innerHTML = `${channelTag(data.channel)}${esc(`${data.modelName || ''}${data.autoSelected ? ' · 自动选择' : ''}${thinking}${citations}`)}`
      // 固定模型的会话发生故障转移时，后端已写回接替模型；气泡同步为实际接替模型。
      if (!data.autoSelected && data.fallbackFromModelId && data.modelId) {
        setSelected(data.modelId, { persist: false })
      }
      if (data.fallbackFromModelId) void refreshModelCatalog()
      finalScroll()
      if (node.isConnected) settleFileDock()
      if (data?.clarify) startClarifyAutoSelect(state.clarifyFlow)
    },
    fail(message, meta) {
      setStatus('')
      hideWaiting()
      clarifySlot.hidden = true
      clarifySlot.innerHTML = ''
      collapseThink(true)
      answer.hidden = false
      answer.classList.remove('is-clarify-note')
      if (!answer.textContent) answer.textContent = message || '回答失败'
      answer.classList.add('is-error')
      if (meta) {
        metaLine.hidden = false
        metaLine.textContent = meta
      }
      if (node.isConnected) settleFileDock()
      scroll()
    },
    stop() {
      setStatus('')
      hideWaiting()
      clarifySlot.hidden = true
      clarifySlot.innerHTML = ''
      collapseThink(true)
      answer.hidden = false
      answer.classList.remove('is-clarify-note')
      if (!rawAnswer) answer.textContent = '已停止生成'
      metaLine.hidden = false
      metaLine.textContent = '已停止生成'
      if (node.isConnected) settleFileDock()
      scroll()
    },
  }
  return turn
}

function appendTyping() {
  setEmptyVisible(false)
  const node = document.createElement('div')
  node.className = 'msg ai'
  node.innerHTML = `${aiWhoMarkup()}<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>`
  $('#thread').appendChild(node)
  scrollThreadToBottomInstant()
  return node
}

function renderDenied(err) {
  $('#thread').innerHTML = `<div class="chat-denied">
    <strong>${esc(err.message)}</strong>
    <span class="mono">${esc(err.code || '')}${err.traceId ? ` · traceId ${esc(err.traceId)}` : ''}</span>
    <span class="mono">换一个账号登录，或让管理员在控制台里给你的角色授这个权限。</span>
  </div>`
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
  const input = $('#input')
  const sendButton = $('#send')
  if (!input || !sendButton) return
  const text = input.value.trim()
  const clarifyBusy = Boolean(state.clarifyFlow?.busy)
  const runtime = currentRuntime()
  const streaming = Boolean(runtime.sending)
  const hasContent = Boolean(text || state.attachments.length > 0)
  const queueSend = $('#queue-send')

  // 回复中做两个按钮的互换：右侧主按钮变暂停，左侧队列发送按钮出现。
  // 输入框保持可编辑，Enter 仍按 send() 走排队发送。
  if (streaming) {
    if (queueSend) {
      queueSend.hidden = false
      queueSend.disabled = clarifyBusy || state.models.length === 0 || !hasContent
    }
    if (sendButton.dataset.mode !== 'pause') {
      sendButton.dataset.mode = 'pause'
      sendButton.classList.add('is-stop')
      sendButton.title = '暂停当前回复'
      sendButton.setAttribute('aria-label', '暂停当前回复')
      sendButton.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.6" height="14" rx="1.2" fill="currentColor"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.2" fill="currentColor"/></svg>'
    }
    sendButton.disabled = false
    syncMessageActionAvailability()
    return
  }

  if (queueSend) queueSend.hidden = true
  if (sendButton.dataset.mode !== 'send') {
    sendButton.dataset.mode = 'send'
    sendButton.classList.remove('is-stop')
    sendButton.title = '发送'
    sendButton.setAttribute('aria-label', '发送')
    sendButton.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5 20 4l-7.4 16-2.1-6.3-6.5-2.2Z" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>'
  }
  sendButton.disabled = clarifyBusy || state.models.length === 0 || !hasContent
  syncMessageActionAvailability()
}

/** 只在真的出现排队消息时提示；只有一条正在回复的消息时不占输入区。 */
function renderQueueState() {
  // 会话切换后主按钮必须跟着当前会话的 sending 状态走：
  // A 会话回复中切到 B，B 的按钮应恢复发送；切回 A 再变回暂停。
  updateSendState()
  const bar = $('#queue-bar')
  if (!bar) return
  const runtime = currentRuntime()
  const queued = runtime.queue.length
  bar.hidden = queued === 0
  if (bar.hidden) return
  const text = runtime.sending
    ? `正在回复，后面还有 ${queued} 条排队`
    : `有 ${queued} 条消息等待发送`
  const label = $('#queue-text')
  if (label) label.textContent = text
  const stop = $('#queue-stop')
  if (stop) {
    stop.textContent = '停止当前回复并发送'
    stop.disabled = !runtime.sending
  }
}

function stopCurrentReply() {
  const runtime = currentRuntime()
  if (!runtime.sending || !runtime.controller) return
  // 先通知服务端取消后台回合；只断浏览器连接不会再中止模型。
  if (runtime.runId) {
    void api(`/api/chat/runs/${encodeURIComponent(runtime.runId)}/cancel${qs()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => {})
  }
  runtime.controller.abort()
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
    if (response.status === 401) {
      redirectToLogin()
      return waitForLoginRedirect()
    }
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
  // 引导式澄清还开着时，底部输入框里的内容也算当前这一步的回答；
  // 直接续跑同一个澄清流程，不落成普通用户消息。
  if (state.clarifyFlow && state.pendingClarify && state.attachments.length === 0) {
    if (state.clarifyFlow.busy) return
    input.value = ''
    input.style.height = '44px'
    updateSendState()
    advanceClarifyFlow(text)
    return
  }
  // 只要用户真正发了消息（包括带附件），底部澄清就完成使命。
  clearClarifyDock()

  // 编辑后重发：先回退到被编辑消息之前，再按正常发送走一遍，
  // 避免旧提问和旧回答继续留在模型上下文里。
  if (state.messageEdit) {
    const edit = state.messageEdit
    if (state.sessionId !== edit.sessionId) {
      cancelMessageEdit({ clearInput: true, silent: true })
      banner('会话已切换，编辑已取消', 'warn')
      return
    }
    if (sessionReplyBusy()) {
      banner('回复结束后再发送编辑后的消息', 'warn')
      return
    }
    try {
      const result = await deleteMessageApi(edit.id, 'after')
      removeDeletedMessageNodes(result.deletedIds)
      state.messageEdit = null
      renderMessageEditBar()
    } catch (err) {
      banner(`替换原消息失败：${err.message}`, 'bad')
      return
    }
  }

  if (state.sessionId) {
    markSessionActive(state.sessionId)
    renderSessions()
  }

  const modelId = state.selected || null
  const pending = state.attachments.slice()
  const attachmentMeta = pending.map((file) => ({
    name: file.name,
    size: file.size,
    type: file.type,
  }))

  const runtime = currentRuntime()
  const item = {
    text,
    modelId,
    reasoningEffort: state.reasoningEffort || null,
    pending,
    attachmentMeta,
    sessionId: state.sessionId,
    runtimeKey: runtime.key,
    createdAt: Date.now(),
    node: null,
  }

  // 打断模式：新消息优先。只丢当前会话尚未发送的旧排队项，并中止当前会话回复；
  // 其它会话的回复不受影响。
  if (runtime.sending && state.chatSendMode === 'interrupt') {
    const dropped = runtime.queue.splice(0)
    for (const queued of dropped) {
      queued.node?.remove()
      for (const file of queued.pending) {
        if (file.previewUrl) URL.revokeObjectURL(file.previewUrl)
      }
    }
    stopCurrentReply()
  }

  runtime.queue.push(item)
  input.value = ''
  input.style.height = '44px'
  item.node = appendMessage('me', text, undefined, attachmentMeta, undefined, { createdAt: item.createdAt })
  scrollThreadToBottomInstant()

  state.attachments = []
  renderAttachments()
  for (const file of pending) {
    if (file.previewUrl) URL.revokeObjectURL(file.previewUrl)
  }

  renderQueueState()
  void drainQueue(runtime)
}

/** 依次消费某个会话的排队消息；各会话独立，互不阻塞。 */
async function drainQueue(runtime = currentRuntime()) {
  if (runtime.sending) return
  const item = runtime.queue.shift()
  if (!item) {
    renderQueueState()
    return
  }

  runtime.sending = true
  renderSessions()
  const controller = new AbortController()
  runtime.controller = controller
  runtime.runId = null
  runtime.messageId = null
  renderQueueState()
  updateSendState()

  // 队列里的消息可能在等待期间已被切走；回到该会话时才重新挂回消息流。
  const visibleAtStart = runtime.sessionId ? runtime.sessionId === state.sessionId : state.sessionId === null
  if (item.node && !item.node.isConnected && visibleAtStart) {
    $('#thread').appendChild(item.node)
    setEmptyVisible(false)
    scrollThreadToBottomInstant()
  }
  let turn = createAiTurn({ append: visibleAtStart })
  runtime.turn = turn
  let streamError = null
  let sawDone = false
  let messageId = ''

  try {
    const attachments = await buildAttachmentPayload(item.pending)
    if (controller.signal.aborted) throw new DOMException('已停止', 'AbortError')
    await streamChat(
      {
        modelId: item.modelId,
        reasoningEffort: item.reasoningEffort,
        text: item.text,
        attachments,
        sessionId: item.sessionId,
        spaceKind: state.spaceKind,
        // 右侧正在预览的文件：让模型知道「这个文件」指谁；面板没开就不传。
        activeFile: activePreviewFilePayload(),
      },
      (event, data) => {
        const isCurrentRun = runtime.sessionId ? runtime.sessionId === state.sessionId : state.sessionId === null
        if (event === 'meta') {
          messageId = String(data.messageId || '')
          runtime.messageId = messageId
          runtime.runId = data.runId || null
          if (data.runId) beginParentAgentTurn(data.runId)
          const userMessageId = String(data.userMessageId || '')
          if (userMessageId && item.node) {
            item.node.dataset.messageId = userMessageId
            item.node.chatMessage = {
              id: userMessageId,
              role: 'user',
              text: item.text,
              createdAt: new Date(item.createdAt).toISOString(),
            }
            refreshMessageActions(item.node)
            state.historyMessageIds.add(userMessageId)
          }
          if (messageId) {
            state.localLiveMessageIds.add(messageId)
            // EventSource 可能先于 meta 到达并已经建好实时节点；复用它，
            // 删掉 POST 刚建的占位节点，避免一个回答两个气泡或增量画到隐藏节点。
            const existingLive = state.liveTurns.get(messageId)
            if (existingLive?.turn && existingLive.turn !== turn) {
              if (turn.node.isConnected) turn.node.remove()
              turn = existingLive.turn
              runtime.turn = turn
              existingLive.hydrated = true
            } else {
              state.liveTurns.set(messageId, {
                turn,
                sessionId: data.sessionId || runtime.sessionId,
                messageId,
                hydrated: true,
              })
            }
          }
          if (data.sessionId) {
            if (runtime.sessionId && runtime.sessionId !== data.sessionId) {
              // 服务端可能为旧空会话补了新 id；以服务端为准迁移运行时。
            }
            migrateRuntime(runtime, data.sessionId)
            item.sessionId = data.sessionId
            for (const queued of runtime.queue) {
              if (!queued.sessionId) queued.sessionId = data.sessionId
            }
            if (!state.sessions.some((session) => session.id === data.sessionId)) {
              // 新会话第一次回复时还没进左侧列表，先拉一次，运行中的绿点才有落点。
              void loadSessions()
            }
            if (state.sessionId === null || state.sessionId === data.sessionId) {
              state.sessionId = data.sessionId
              persistChatLocation()
            }
            if (isCurrentRun && $('#chat-title').textContent === '新对话') {
              $('#chat-title').textContent = (item.text || attachments[0]?.name || '新对话').slice(0, 24)
            }
            markSessionActive(data.sessionId)
            renderSessions()
          }
          if (!isCurrentRun && turn.node.isConnected) {
            // 发送瞬间还在当前会话，meta 回来前已经切走；保留在后台，不删节点。
          }
        } else if (
          event === 'reasoning' ||
          event === 'delta' ||
          event === 'tool' ||
          event === 'tool_delta' ||
          event === 'tool_result'
        ) {
          /**
           * POST 流负责本次发送的实时渲染。EventSource 在 setupChatEvents
           * 里会跳过当前会话正在 POST 的同一轮，避免重复；这里不能再因为
           * EventSource 已连接就不画，否则两处互相让路，气泡会一直停在
           * “正在思考中…”，刷新后才从历史消息恢复。
           */
          if (event === 'reasoning') turn.reasoning(data.text)
          else if (event === 'delta') turn.content(data.text)
          else if (event === 'tool') turn.tool(data)
          else if (event === 'tool_delta') turn.toolDelta(data)
          else turn.toolResult(data)
        } else if (event === 'agent') {
          updateAgentEvent(data)
        } else if (event === 'clarify') {
          turn.clarify(data.clarify)
        } else if (event === 'done') {
          sawDone = true
          const id = String(data.messageId || messageId || '')
          const liveEntry = id ? state.liveTurns.get(id) : null
          if (liveEntry?.turn && liveEntry.turn !== turn) {
            // EventSource 已经建好并渲染了实时节点：收编它，删掉 POST 的空占位。
            if (turn.node.isConnected) turn.node.remove()
            turn = liveEntry.turn
            runtime.turn = turn
          } else if (id && state.historyMessageIds.has(id) && !liveEntry) {
            // EventSource 已先收到最终消息并完成渲染，POST 只做收尾，不再画第二个气泡。
            if (turn.node.isConnected) turn.node.remove()
            turn = liveEntry?.turn || turn
          }
          if (id) {
            state.historyMessageIds.add(id)
            state.activeRunSnapshots.delete(id)
            state.localLiveMessageIds.delete(id)
            state.liveTurns.delete(id)
            if (turn.node) {
              turn.node.dataset.messageId = id
              turn.node.chatMessage = {
                id,
                role: 'assistant',
                text: String(data.text || ''),
                createdAt: data.createdAt || new Date().toISOString(),
              }
              setMessageTime(turn.node, data.createdAt)
              refreshMessageActions(turn.node)
            }
          }
          if (data.sessionId) {
            migrateRuntime(runtime, data.sessionId)
            if (state.sessionId === null || state.sessionId === data.sessionId) {
              state.sessionId = data.sessionId
              persistChatLocation()
            }
          }
          turn.finish(data)
          syncMessageActionAvailability()
          if (isCurrentRun || runtime.sessionId === state.sessionId) {
            notifySessionRead(runtime.sessionId)
          }
          loadSessions()
          void loadWorkspaceFiles()
        } else if (event === 'error') {
          const err = new Error(data.message || '模型调用失败')
          err.code = data.code
          err.traceId = data.traceId
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
      if (messageId) {
        state.liveTurns.delete(messageId)
        state.activeRunSnapshots.delete(messageId)
      }
    } else {
      turn.fail(`${err.message}${err.code ? `\n（${err.code}）` : ''}`, err.traceId ? `traceId ${err.traceId}` : '请求失败')
      if (messageId) state.localLiveMessageIds.delete(messageId)
    }
  } finally {
    runtime.sending = false
    runtime.controller = null
    runtime.runId = null
    if (runtime.turn === turn) runtime.turn = null
    if (messageId) state.localLiveMessageIds.delete(messageId)
    renderSessions()
    updateSendState()
    renderQueueState()
    if (runtime.queue.length > 0) {
      void drainQueue(runtime)
    } else if (
      (runtime.sessionId && runtime.sessionId === state.sessionId) ||
      (!runtime.sessionId && state.sessionId === null)
    ) {
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

function setSidebarCollapsed(collapsed, options = {}) {
  const isCollapsed = Boolean(collapsed)
  document.body.classList.toggle('is-side-collapsed', isCollapsed)
  const button = $('#side-toggle')
  if (button) {
    button.setAttribute('aria-expanded', String(!isCollapsed))
    button.setAttribute('aria-label', isCollapsed ? '展开侧边栏' : '收起侧边栏')
    button.title = isCollapsed ? '展开侧边栏' : '收起侧边栏'
  }
  if (options.persist !== false) {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, isCollapsed ? '1' : '0')
    } catch {
      /* 本地存储不可用时只影响记忆，不影响折叠 */
    }
  }
  syncSideSectionSplit()
}

function initSidebarToggle() {
  let collapsed = false
  try {
    collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    collapsed = false
  }
  setSidebarCollapsed(collapsed, { persist: false })
  const button = $('#side-toggle')
  if (!button || button.dataset.bound === '1') return
  button.dataset.bound = '1'
  button.addEventListener('click', () => {
    setSidebarCollapsed(!document.body.classList.contains('is-side-collapsed'))
  })
}

function readSideSectionRatio() {
  try {
    const saved = Number(localStorage.getItem(SIDE_SECTION_RATIO_KEY))
    if (Number.isFinite(saved) && saved >= 0.2 && saved <= 0.8) return saved
  } catch {
    /* 本地存储不可用时使用默认比例 */
  }
  return 0.5
}

function applySideSectionRatio(ratio, options = {}) {
  const side = $('#chat-side')
  if (!side) return
  const value = Math.max(0.2, Math.min(0.8, Number(ratio) || 0.5))
  side.style.setProperty('--side-sessions-grow', String(value))
  side.style.setProperty('--side-files-grow', String(1 - value))
  const resizer = $('#side-split-resizer')
  if (resizer) resizer.setAttribute('aria-valuenow', String(Math.round(value * 100)))
  if (options.persist !== false) {
    try {
      localStorage.setItem(SIDE_SECTION_RATIO_KEY, String(value))
    } catch {
      /* 本地存储不可用时只影响记忆，不影响本次拖动 */
    }
  }
}

function syncSideSectionSplit() {
  const side = $('#chat-side')
  const sessions = $('#side-sessions')
  const files = $('#side-files')
  const resizer = $('#side-split-resizer')
  if (!side || !sessions || !files || !resizer) return
  const show = !side.hidden && !sessions.hidden && !files.hidden && !document.body.classList.contains('is-side-collapsed')
  side.classList.toggle('is-side-sections-resizable', show)
  resizer.hidden = !show
  if (show) applySideSectionRatio(readSideSectionRatio(), { persist: false })
}

function bindSideSectionResizer() {
  const resizer = $('#side-split-resizer')
  if (!resizer || resizer.dataset.bound === '1') return
  resizer.dataset.bound = '1'
  let drag = null

  const finishDrag = (pointerId) => {
    if (!drag || (pointerId != null && pointerId !== drag.pointerId)) return
    const ratio = Number.parseFloat(
      $('#chat-side')?.style.getPropertyValue('--side-sessions-grow') || '0.5',
    )
    if (Number.isFinite(ratio)) applySideSectionRatio(ratio)
    drag = null
    document.body.classList.remove('is-resizing-side')
  }

  resizer.addEventListener('pointerdown', (event) => {
    if (resizer.hidden || document.body.classList.contains('is-side-collapsed')) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const sessions = $('#side-sessions')
    const files = $('#side-files')
    if (!sessions || !files) return
    const sessionsHeight = sessions.getBoundingClientRect().height
    const filesHeight = files.getBoundingClientRect().height
    const total = sessionsHeight + filesHeight
    if (total <= 0) return
    drag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startSessions: sessionsHeight,
      total,
    }
    resizer.setPointerCapture?.(event.pointerId)
    document.body.classList.add('is-resizing-side')
    event.preventDefault()
  })

  resizer.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const minHeight = Math.min(96, drag.total * 0.2)
    const nextSessions = Math.max(
      minHeight,
      Math.min(drag.total - minHeight, drag.startSessions + event.clientY - drag.startY),
    )
    applySideSectionRatio(nextSessions / drag.total, { persist: false })
    event.preventDefault()
  })

  resizer.addEventListener('pointerup', (event) => finishDrag(event.pointerId))
  resizer.addEventListener('pointercancel', (event) => finishDrag(event.pointerId))
  resizer.addEventListener('lostpointercapture', (event) => finishDrag(event.pointerId))

  resizer.addEventListener('keydown', (event) => {
    if (resizer.hidden || document.body.classList.contains('is-side-collapsed')) return
    let next = readSideSectionRatio()
    if (event.key === 'ArrowUp') next -= 0.02
    else if (event.key === 'ArrowDown') next += 0.02
    else if (event.key === 'Home') next = 0.2
    else if (event.key === 'End') next = 0.8
    else return
    event.preventDefault()
    applySideSectionRatio(next)
  })
}

function fileSplitContentWidth(main) {
  const rect = main.getBoundingClientRect()
  const styles = getComputedStyle(main)
  const padLeft = Number.parseFloat(styles.paddingLeft) || 0
  const padRight = Number.parseFloat(styles.paddingRight) || 0
  return {
    rect,
    padLeft,
    contentWidth: Math.max(1, rect.width - padLeft - padRight),
  }
}

/** 右栏最小 440（列表 200 + 详情）、对话最小 360；文件模式沿用原来的 284/320。 */
function splitBounds(teamMode, contentWidth) {
  const minRail = teamMode ? 440 : 284
  const minChat = teamMode ? 360 : 320
  const minRatio = Math.min(0.5, minRail / contentWidth)
  const maxRatio = Math.max(minRatio, 1 - minChat / contentWidth)
  return { minRatio, maxRatio }
}

function applySplitRatio(ratio, options = {}) {
  const main = $('.chat-main')
  if (!main) return
  const teamMode = Boolean(options.team)
  const varName = teamMode ? '--team-split' : '--file-split'
  const fallback = teamMode ? 0.56 : 0.5
  const geometry = fileSplitContentWidth(main)
  let value = Number(ratio)
  if (!Number.isFinite(value) || value <= 0) value = fallback
  if (geometry.contentWidth > 1) {
    const bounds = splitBounds(teamMode, geometry.contentWidth)
    value = Math.max(bounds.minRatio, Math.min(bounds.maxRatio, value))
  }
  main.style.setProperty(varName, `${(value * 100).toFixed(2)}%`)
  const resizer = $('#file-split-resizer')
  if (resizer) resizer.setAttribute('aria-valuenow', String(Math.round(value * 100)))
  if (options.persist !== false) {
    try {
      localStorage.setItem(teamMode ? TEAM_SPLIT_RATIO_KEY : FILE_SPLIT_RATIO_KEY, String(value))
    } catch {
      /* 忽略本地存储失败 */
    }
  }
}

function applyFileSplitRatio(ratio, options = {}) {
  applySplitRatio(ratio, { ...options, team: false })
}

function applyTeamSplitRatio(ratio, options = {}) {
  applySplitRatio(ratio, { ...options, team: true })
}

function restoreFileSplitRatio() {
  let ratio = 0.5
  try {
    const saved = Number(localStorage.getItem(FILE_SPLIT_RATIO_KEY))
    if (Number.isFinite(saved) && saved >= 0.2 && saved <= 0.8) ratio = saved
  } catch {
    ratio = 0.5
  }
  applyFileSplitRatio(ratio, { persist: false })
}

/** 团队栏宽度也记住：默认对话 56% / 团队 44% */
function restoreTeamSplitRatio() {
  let ratio = 0.56
  try {
    const saved = Number(localStorage.getItem(TEAM_SPLIT_RATIO_KEY))
    if (Number.isFinite(saved) && saved >= 0.25 && saved <= 0.75) ratio = saved
  } catch {
    ratio = 0.56
  }
  applyTeamSplitRatio(ratio, { persist: false })
}

/** 团队栏内部的列表/预览分界线：像左侧对话/文件一样可拖，宽度记在本地。 */
function applyTeamListWidth(width, options = {}) {
  const split = $('#team-split')
  if (!split) return
  const total = split.getBoundingClientRect().width || 0
  const min = 128
  const max = total > 1 ? Math.max(min, total - 260) : 480
  let value = Number(width)
  if (!Number.isFinite(value) || value <= 0) value = 196
  value = Math.round(Math.max(min, Math.min(max, value)))
  split.style.setProperty('--team-list-width', `${value}px`)
  const resizer = $('#team-list-resizer')
  if (resizer) {
    resizer.setAttribute('aria-valuenow', String(value))
    resizer.setAttribute('aria-valuemin', String(min))
    resizer.setAttribute('aria-valuemax', String(Math.round(max)))
  }
  if (options.persist !== false) {
    try {
      localStorage.setItem(TEAM_LIST_WIDTH_KEY, String(value))
    } catch {
      /* 忽略本地存储失败 */
    }
  }
}

function restoreTeamListWidth() {
  let width = 196
  try {
    const saved = Number(localStorage.getItem(TEAM_LIST_WIDTH_KEY))
    if (Number.isFinite(saved) && saved >= 120 && saved <= 480) width = saved
  } catch {
    width = 196
  }
  applyTeamListWidth(width, { persist: false })
}

function bindTeamListResizer() {
  const resizer = $('#team-list-resizer')
  if (!resizer || resizer.dataset.bound === '1') return
  resizer.dataset.bound = '1'
  let drag = null

  const finish = (pointerId) => {
    if (!drag || (pointerId != null && pointerId !== drag.pointerId)) return
    applyTeamListWidth(drag.lastWidth)
    drag = null
    document.body.classList.remove('is-resizing-team-list')
  }

  resizer.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const list = $('#team-list')
    if (!list) return
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: list.getBoundingClientRect().width,
      lastWidth: list.getBoundingClientRect().width,
    }
    resizer.setPointerCapture?.(event.pointerId)
    document.body.classList.add('is-resizing-team-list')
    event.preventDefault()
  })

  resizer.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    drag.lastWidth = drag.startWidth + event.clientX - drag.startX
    applyTeamListWidth(drag.lastWidth, { persist: false })
    event.preventDefault()
  })

  resizer.addEventListener('pointerup', (event) => finish(event.pointerId))
  resizer.addEventListener('pointercancel', (event) => finish(event.pointerId))
  resizer.addEventListener('lostpointercapture', (event) => finish(event.pointerId))

  resizer.addEventListener('keydown', (event) => {
    const list = $('#team-list')
    if (!list) return
    const step = event.shiftKey ? 32 : 12
    let next = list.getBoundingClientRect().width
    if (event.key === 'ArrowLeft') next -= step
    else if (event.key === 'ArrowRight') next += step
    else if (event.key === 'Home') next = 128
    else if (event.key === 'End') next = 420
    else return
    event.preventDefault()
    applyTeamListWidth(next)
  })

  window.addEventListener('resize', () => {
    const list = $('#team-list')
    if (list) applyTeamListWidth(list.getBoundingClientRect().width, { persist: false })
  })
}

/** 当前分栏是不是团队模式（团队独占或团队+文件并排） */
function isTeamSplitMode(main) {
  return Boolean(main?.classList.contains('is-team-only') || main?.classList.contains('is-team-file'))
}

function bindFileSplitResizer() {
  const resizer = $('#file-split-resizer')
  if (!resizer || resizer.dataset.bound === '1') return
  resizer.dataset.bound = '1'
  let drag = null

  const finishDrag = (pointerId) => {
    if (!drag || (pointerId != null && pointerId !== drag.pointerId)) return
    const main = $('.chat-main')
    const varName = drag.team ? '--team-split' : '--file-split'
    const ratio = Number.parseFloat(main?.style.getPropertyValue(varName) || '') / 100
    if (Number.isFinite(ratio)) applySplitRatio(ratio, { team: drag.team })
    drag = null
    document.body.classList.remove('is-resizing-split')
  }

  resizer.addEventListener('pointerdown', (event) => {
    const main = $('.chat-main')
    if (!main?.classList.contains('is-workbench-open')) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const geometry = fileSplitContentWidth(main)
    drag = { pointerId: event.pointerId, ...geometry, team: isTeamSplitMode(main) }
    resizer.setPointerCapture?.(event.pointerId)
    document.body.classList.add('is-resizing-split')
    event.preventDefault()
  })

  resizer.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const x = event.clientX - drag.rect.left - drag.padLeft
    const bounds = splitBounds(drag.team, drag.contentWidth)
    const ratio = Math.max(bounds.minRatio, Math.min(bounds.maxRatio, x / drag.contentWidth))
    applySplitRatio(ratio, { team: drag.team, persist: false })
    event.preventDefault()
  })

  resizer.addEventListener('pointerup', (event) => finishDrag(event.pointerId))
  resizer.addEventListener('pointercancel', (event) => finishDrag(event.pointerId))
  resizer.addEventListener('lostpointercapture', (event) => finishDrag(event.pointerId))

  resizer.addEventListener('keydown', (event) => {
    const main = $('.chat-main')
    if (!main?.classList.contains('is-workbench-open')) return
    const team = isTeamSplitMode(main)
    const varName = team ? '--team-split' : '--file-split'
    const current = Number.parseFloat(main.style.getPropertyValue(varName) || '') / 100
    let next = Number.isFinite(current) && current > 0 ? current : (team ? 0.56 : 0.5)
    if (event.key === 'ArrowLeft') next -= 0.02
    else if (event.key === 'ArrowRight') next += 0.02
    else if (event.key === 'Home') next = team ? 0.36 : 0.3
    else if (event.key === 'End') next = team ? 0.7 : 0.7
    else return
    event.preventDefault()
    applySplitRatio(next, { team })
  })

  // 窗口变窄时按新宽度重新夹一次，避免对话区被压没
  window.addEventListener('resize', () => {
    const main = $('.chat-main')
    if (!main?.classList.contains('is-workbench-open')) return
    const team = isTeamSplitMode(main)
    const varName = team ? '--team-split' : '--file-split'
    const current = Number.parseFloat(main.style.getPropertyValue(varName) || '') / 100
    if (Number.isFinite(current) && current > 0) {
      applySplitRatio(current, { team, persist: false })
    }
  })
}

async function boot() {
  const as = currentAs()
  $('#login-form').addEventListener('submit', doLogin)

  // 登录页右侧扫码入口由 setupLoginSso() 按公司已配置的渠道动态展示。

  for (const button of $('#mode-switch').querySelectorAll('[data-mode]')) {
    button.addEventListener('click', () => setChatMode(button.dataset.mode))
  }
  initSidebarToggle()
  bindFileSplitResizer()
  restoreTeamSplitRatio()
  bindTeamListResizer()
  restoreTeamListWidth()
  bindSideSectionResizer()
  bindWorkspaceFilePane()
  bindWorkbenchTabs()
  bindSpacePicker()
  setChatMode('chat')
  syncSideSectionSplit()

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
    await loadActiveRuns()
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

  // 用户一上滚就立即解除贴底，不等 scroll 事件，避免流式增量抢先滚回底部。
  const threadEl = $('#thread')
  threadEl.addEventListener('wheel', (event) => {
    if (event.deltaY < 0) unpinThreadFromBottom()
  }, { passive: true })
  let touchStartY = 0
  threadEl.addEventListener('touchstart', (event) => {
    touchStartY = event.touches[0]?.clientY || 0
  }, { passive: true })
  threadEl.addEventListener('touchmove', (event) => {
    const y = event.touches[0]?.clientY || 0
    if (touchStartY && y - touchStartY > 6) unpinThreadFromBottom()
  }, { passive: true })
  document.addEventListener('keydown', (event) => {
    const target = event.target
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return
    if (event.key === 'PageUp' || event.key === 'Home' || event.key === 'ArrowUp') {
      unpinThreadFromBottom()
    }
  })
  $('#send').addEventListener('click', () => {
    // 回复中主按钮是暂停；不在回复时才是发送。
    if (currentRuntime().sending) stopCurrentReply()
    else send()
  })
  $('#queue-stop').addEventListener('click', stopCurrentReply)
  $('#queue-send').addEventListener('click', () => send())
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
    if (open) {
      $('#think-menu').hidden = true
      $('#think-chip').setAttribute('aria-expanded', 'false')
    }
    $('#model-chip').setAttribute('aria-expanded', open ? 'true' : 'false')
  })
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#model-chip') && !event.target.closest('#model-menu')) {
      $('#model-menu').hidden = true
      $('#model-chip').setAttribute('aria-expanded', 'false')
    }
  })

  // 思考档位：只有模型开放思考选项时才出现
  $('#think-chip').addEventListener('click', () => {
    const menu = $('#think-menu')
    const open = menu.hidden
    menu.hidden = !open
    if (open) {
      $('#model-menu').hidden = true
      $('#model-chip').setAttribute('aria-expanded', 'false')
    }
    $('#think-chip').setAttribute('aria-expanded', open ? 'true' : 'false')
  })
  $('#think-menu').addEventListener('click', (event) => {
    const button = event.target.closest('[data-think]')
    if (button) setThinkingEffort(button.dataset.think)
  })
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#think-wrap')) {
      $('#think-menu').hidden = true
      $('#think-chip').setAttribute('aria-expanded', 'false')
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
      downloadWorkspaceFile(file).catch((err) => banner(err.message, 'bad'))
    }
  })
  $('#message-menu').addEventListener('click', (event) => {
    const action = event.target.closest('[data-message-act]')
    if (!action || action.disabled) return
    const id = $('#message-menu').dataset.message
    const node = Array.from($('#thread').querySelectorAll('.msg[data-message-id]')).find(
      (item) => item.dataset.messageId === id,
    )
    const message = node?.chatMessage || null
    hideMessageMenu()
    if (!message) return
    handleMessageAction(action.dataset.messageAct, message)
  })
  $('#message-edit-cancel').addEventListener('click', () => cancelMessageEdit({ clearInput: true }))
  $('#thread').addEventListener('click', (event) => {
    const action = event.target.closest('.msg-actions [data-message-act]')
    if (!action || action.disabled) return
    const node = action.closest('.msg')
    const message = node?.chatMessage || null
    if (!message) return
    event.preventDefault()
    event.stopPropagation()
    hideMessageMenu()
    handleMessageAction(action.dataset.messageAct, message)
  })
  $('#thread').addEventListener('contextmenu', (event) => {
    const node = event.target.closest('.msg')
    if (!node || !node.dataset.messageId) return
    event.preventDefault()
    showMessageMenu(node, event.clientX, event.clientY)
  })
  $('#thread').addEventListener('scroll', hideMessageMenu, { passive: true })
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#session-menu') && !event.target.closest('.side-session-more')) hideSessionMenu()
    if (!event.target.closest('#file-menu') && !event.target.closest('.side-file-more')) hideFileMenu()
    if (!event.target.closest('#message-menu')) hideMessageMenu()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideSessionMenu()
      hideFileMenu()
      hideSpaceMenu()
      hideQuota()
      hideMessageMenu()
    }
  })
  window.addEventListener('resize', () => {
    hideSessionMenu()
    hideFileMenu()
    hideSpaceMenu()
    hideQuota()
    hideMessageMenu()
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
bindWorkspaceKindSwitch()
boot()
