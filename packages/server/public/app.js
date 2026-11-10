/* EAB 控制台前端（无构建步骤：直接读盘，改完刷新即可） */

const ROLE_LABEL = {
  super_admin: '平台超管',
  company_admin: '公司管理员',
  company_sub_admin: '企业级子管理员',
  dept_admin: '部门管理员',
  kb_admin: '知识库管理员',
  auditor: '审计员',
  member: '普通员工',
  guest: '外部访客',
}

const MODE_LABEL = {
  all: '全员可见',
  roles: '仅指定角色',
  depts: '仅指定部门',
  private: '仅本人',
}

const CLS_LABEL = {
  public: '公开',
  internal: '内部',
  confidential: '机密',
}

const DATA_SCOPE_LABEL = {
  self: '仅本人',
  dept: '本部门',
  dept_tree: '本部门及下级',
  company: '全公司',
  global: '平台全局',
}

const SCOPE_GROUP_LABEL = {
  chat: '对话',
  agent: '智能体工具',
  plugin: '插件',
  kb: '知识库',
  workspace: '工作区',
  org: '组织架构',
  authz: '角色与授权',
  channel: '渠道',
  model: '模型',
  approval: '审批',
  audit: '审计',
  service: '服务',
}

const STATUS_LABEL = { active: '在职', disabled: '已停用', departed: '已离职', pending: '待绑定' }

const urlCompany = new URLSearchParams(location.search).get('company')

const state = {
  /** 管理范围（公司），不是"我是谁"——控制台不登录组织成员 */
  company: urlCompany,
  companies: [],
  me: null,
  page: 'overview',
  /** 当前业务域（顶部一级导航）；页面列表由 DOMAINS 决定 */
  domain: 'overview',
  /** 复杂页面的页内分组：一次只展开一组，避免所有配置挤在一屏 */
  modelsSection: 'catalog',
  systemSection: 'runtime',
  quotaScope: 'company',
  quotaMonth: '',
  deptFilter: null,
  includeSubdepts: false,
  collapsed: new Set(),
  kb: null,
  selectedCollection: null,
  selectedRole: null,
  /** 角色详情当前页签：permissions / members */
  roleTab: 'permissions',
  /** 角色列表：渲染左侧导航「角色管理」子菜单 */
  roles: null,
  /** 插件页：当前选中的插件、详情标签、当前页面 */
  pluginData: null,
  pluginSelected: null,
  pluginTab: 'overview',
  pluginPageKey: null,
}

const PAGES = {
  overview: { title: '概览', sub: '配置进度与运行状态', render: () => loadOverview() },
  org: { title: '成员管理', sub: '成员列表、角色授权与部门筛选', render: () => loadOrg() },
  departments: { title: '部门管理', sub: '部门结构、负责人、下级与成员', render: () => loadDepartments() },
  roles: { title: '角色管理', sub: '角色权限、数据范围与成员配置', render: () => loadRoles() },
  access: { title: '权限矩阵', sub: '成员 × 知识库可见性核对', render: () => loadMatrix() },
  kb: { title: '知识库', sub: '知识库、可见范围与文档', render: () => loadKb() },
  models: { title: '模型接入', sub: '模型目录、用途路由与供应商端点', render: () => loadModels() },
  tools: { title: '工具', sub: '智能体可调用的工具与审批要求', render: () => loadTools() },
  channels: { title: '渠道', sub: '飞书 / 钉钉 / 企业微信接入', render: () => loadSync() },
  company: { title: '公司资料', sub: '公司标识、状态与绑定关系', render: () => loadCompanyProfile() },
  usage: { title: '用量', sub: '对话请求与 token 消耗（按天 / 按人）', render: () => loadUsage() },
  quota: { title: '额度', sub: '公司 / 部门 / 成员三级月度上限', render: () => loadQuota() },
  audit: { title: '审计', sub: '追加写入、哈希链可校验的操作记录', render: () => loadAudit() },
  approvals: { title: '审批', sub: '高危动作的待办与决定', render: () => loadApprovals() },
  system: { title: '系统', sub: '运行状态、公司设置与数据运维', render: () => loadSys() },
  extra: { title: '插件', sub: '安装、启停、页面与工具', render: () => loadPlugins() },
}


const $ = (sel) => document.querySelector(sel)

/**
 * 复杂页面的页内分组导航。
 * 只负责“当前看哪一组”和按钮状态，不重绘内容；页面数据与事件仍由各页自己管理。
 */
function mountSectionNav(root, key, fallback, onChange) {
  const buttons = [...root.querySelectorAll('[data-section-target]')]
  const panels = [...root.querySelectorAll('[data-section-panel]')]
  if (!buttons.length || !panels.length) return
  const activate = (value) => {
    const target = buttons.some((button) => button.dataset.sectionTarget === value) ? value : fallback
    for (const button of buttons) {
      const active = button.dataset.sectionTarget === target
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-selected', active ? 'true' : 'false')
    }
    for (const panel of panels) panel.hidden = panel.dataset.sectionPanel !== target
    onChange?.(target)
  }
  for (const button of buttons) {
    button.addEventListener('click', () => activate(button.dataset.sectionTarget))
  }
  activate(key || fallback)
}

function sectionNavHtml(items, active) {
  return `<nav class="section-nav" role="tablist" aria-label="页面功能区">
    ${items
      .map(
        (item) => `<button type="button" role="tab" data-section-target="${esc(item.key)}"
          class="${active === item.key ? 'is-active' : ''}${item.attention ? ' is-attention' : ''}"
          aria-selected="${active === item.key ? 'true' : 'false'}">
          <strong>${esc(item.label)}</strong>
          ${item.meta ? `<span>${esc(item.meta)}</span>` : ''}
        </button>`,
      )
      .join('')}
  </nav>`
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  })
}

/** 把长说明收成小角标；完整文案挂在 data-tip，由统一浮层按需展示。 */
function hintBadge(label, tip, ariaLabel, extraClass = '') {
  const cls = extraClass ? `hint-badge ${extraClass}` : 'hint-badge'
  return `<span class="${cls}" data-tip="${esc(tip)}" tabindex="0" aria-label="${esc(ariaLabel || label)}">${esc(label)}</span>`
}

/** 独立一行的角标：用于表单说明、弹窗提示等原本占一整段的文案。 */
function hintNote(label, tip, ariaLabel) {
  return `<div class="hint-note">${hintBadge(label, tip, ariaLabel)}</div>`
}

/** 模型表格的统一图标操作；图标本身不带文字，名称挂在浮层与 aria-label。 */
function modelActionIcon(name) {
  const paths = {
    test: '<path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/><path d="M7 7h10v3a5 5 0 0 1-10 0V7Z"/><path d="M12 15v5"/>',
    discover: '<circle cx="10.5" cy="10.5" r="4.5"/><path d="m14 14 4 4"/><path d="M10.5 8.5v4M8.5 10.5h4"/>',
    edit: '<path d="M4 20h4l10-10-4-4L4 16v4Z"/><path d="m13 5 4 4"/>',
    toggle: '<path d="M12 3v9"/><path d="M6.5 6.5a8 8 0 1 0 11 0"/>',
    delete: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>',
    stress: '<path d="M4 17a8 8 0 0 1 16 0"/><path d="m12 17 4-5"/><circle cx="12" cy="17" r="1.2"/>',
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name] || ''}</svg>`
}

/** 控制台角标浮层：只绑定一次，后续页面重绘不需要重新挂监听。 */
function bindHintTips() {
  if (document.body.dataset.hintTipBound === '1') return
  document.body.dataset.hintTipBound = '1'
  const tip = document.createElement('div')
  tip.className = 'hint-tip'
  tip.id = 'admin-hint-tip'
  tip.setAttribute('role', 'tooltip')
  document.body.appendChild(tip)
  let current = null
  const hide = () => {
    if (current) current.removeAttribute('aria-describedby')
    current = null
    tip.classList.remove('is-visible')
  }
  const show = (target) => {
    const text = target?.dataset?.tip
    if (!text) return
    if (current && current !== target) current.removeAttribute('aria-describedby')
    current = target
    target.setAttribute('aria-describedby', tip.id)
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
  const targetOf = (event) => event.target?.closest?.('[data-tip]')
  document.addEventListener('pointerover', (event) => {
    const target = targetOf(event)
    if (target) show(target)
  })
  document.addEventListener('pointerout', (event) => {
    const target = targetOf(event)
    if (target && !target.contains(event.relatedTarget)) hide()
  })
  document.addEventListener('focusin', (event) => {
    const target = targetOf(event)
    if (target) show(target)
  })
  document.addEventListener('focusout', (event) => {
    const target = targetOf(event)
    if (target && !target.contains(event.relatedTarget)) hide()
  })
  window.addEventListener('scroll', hide, true)
  window.addEventListener('resize', hide)
  // 页面重绘或弹窗关闭时，原角标可能已被移除；此时收起浮层，避免留下幽灵提示。
  new MutationObserver(() => {
    if (current && !current.isConnected) hide()
  }).observe(document.body, { childList: true, subtree: true })
}

function qs(path) {
  if (!state.company) return ''
  const sep = String(path ?? '').includes('?') ? '&' : '?'
  return `${sep}company=${encodeURIComponent(state.company)}`
}

async function parseResponse(res) {
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok || !body || body.ok === false) {
    const err = body && body.ok === false ? body : { code: 'EAB_INTERNAL', message: `HTTP ${res.status}` }
    err.status = res.status
    throw err
  }
  return body.data
}

async function api(path) {
  const res = await fetch(path + qs(path), {
    headers: { accept: 'application/json', 'x-eab-console': '1' },
  })
  return parseResponse(res)
}

/** 显式指定公司读取（组织页需要同时拉多家公司） */
async function apiForCompany(path, companyId) {
  const sep = String(path ?? '').includes('?') ? '&' : '?'
  const url = `${path}${sep}company=${encodeURIComponent(companyId)}`
  const res = await fetch(url, { headers: { accept: 'application/json', 'x-eab-console': '1' } })
  return parseResponse(res)
}

async function apiPost(path, body) {
  const res = await fetch(path + qs(path), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-eab-console': '1' },
    body: JSON.stringify(body ?? {}),
  })
  return parseResponse(res)
}

async function apiSend(method, path, body) {
  const headers = { accept: 'application/json', 'x-eab-console': '1' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(path + qs(path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return parseResponse(res)
}

function renderDenied(container, err) {
  container.innerHTML = `
    <div class="denied">
      <h2>${esc(err.message || '请求被拒绝')}</h2>
      <span class="code">${esc(err.code || 'EAB_INTERNAL')}${err.status ? ` · HTTP ${err.status}` : ''}</span>
      <div class="muted">${esc(err.hint || '这是 PDP 的判定结果——当前身份不具备该动作所需的权限。')}</div>
      ${err.details ? `<div class="sql-box" style="margin-top:10px">${esc(JSON.stringify(err.details, null, 2))}</div>` : ''}
      ${err.traceId ? `<div class="muted" style="margin-top:8px;font-size:12px">traceId: <code>${esc(err.traceId)}</code></div>` : ''}
    </div>`
}

function renderLoading(container, text = '加载中…') {
  container.innerHTML = `<div class="loading">${esc(text)}</div>`
}

/* ---------------- 管理范围（公司） ---------------- */

async function loadCompanies() {
  const data = await api('/api/console/companies')
  state.companies = data.companies
  if (!state.company || !state.companies.some((c) => c.id === state.company)) {
    state.company = data.defaultCompanyId || (state.companies[0] ? state.companies[0].id : null)
  }

  renderCompanyPicker()

  const url = new URL(location.href)
  if (state.company) url.searchParams.set('company', state.company)
  history.replaceState(null, '', url.toString())
}

function closeCompanyPicker() {
  const menu = $('#company-picker-menu')
  const button = $('#company-picker-btn')
  if (menu) menu.hidden = true
  if (button) button.setAttribute('aria-expanded', 'false')
}

function renderCompanyPicker() {
  const picker = $('#company-picker')
  if (!picker) return
  const current = companyMeta()

  /**
   * 单公司本地部署：没有“切换管理范围”。
   * 只显示这家公司本身，像一个身份牌，而不是一个可选多家公司的下拉。
   */
  if (state.companies.length <= 1) {
    const empty = state.companies.length === 0
    const only = state.companies[0] ?? current
    picker.innerHTML = `
      <span class="company-picker-kicker">当前公司</span>
      <div class="company-single${empty ? ' is-empty' : ''}" aria-label="当前公司">
        <span class="company-single-name">
          <strong>${esc(empty ? '未接入公司' : only?.name ?? '未接入公司')}</strong>
          ${empty ? '' : `<code>${esc(only?.id ?? '')}</code>`}
        </span>
        <span class="company-single-tag${empty ? ' is-waiting' : ''}">${empty ? '待创建' : '唯一组织'}</span>
      </div>`
    picker.onclick = null
    return
  }

  const options = state.companies
    .map((company) => {
      const users = Number(company.counts?.users ?? 0)
      const depts = Number(company.counts?.depts ?? 0)
      const active = company.id === state.company
      return `<button class="company-option${active ? ' is-active' : ''}" type="button" role="option" aria-selected="${active}" data-company="${esc(company.id)}">
        <span class="company-option-main"><strong>${esc(company.name)}</strong><code>${esc(company.id)}</code></span>
        <span class="company-option-meta">${users} 成员 · ${depts} 部门</span>
        ${active ? '<span class="company-option-check">当前</span>' : ''}
      </button>`
    })
    .join('')

  picker.innerHTML = `
    <span class="company-picker-kicker">当前公司</span>
    <div class="company-picker-control">
      <button class="company-picker-btn" id="company-picker-btn" type="button" aria-haspopup="listbox" aria-expanded="false">
        <span class="company-picker-current">
          <strong>${esc(current?.name ?? '选择公司')}</strong>
          <code>${esc(current?.id ?? '')}</code>
        </span>
        <span class="company-picker-chevron">▾</span>
      </button>
      <div class="company-picker-menu" id="company-picker-menu" role="listbox" aria-label="切换管理公司" hidden>
        <div class="company-picker-menu-head">切换管理范围</div>
        ${options || '<div class="company-picker-empty">没有可选公司</div>'}
        ${hintBadge('切换说明', '切换后，当前页的权限、模型、知识库与设置都会按新公司重新加载。')}
      </div>
    </div>
    <span class="company-picker-hint">此页所有配置按这家公司隔离</span>`

  const pickerHandler = (event) => {
    const option = event.target.closest('[data-company]')
    if (option) {
      event.preventDefault()
      closeCompanyPicker()
      applyCompany(option.dataset.company)
      return
    }
    if (event.target.closest('#company-picker-btn')) {
      event.preventDefault()
      const menu = $('#company-picker-menu')
      const button = $('#company-picker-btn')
      if (!menu || !button) return
      const open = menu.hidden
      menu.hidden = !open
      button.setAttribute('aria-expanded', String(open))
      return
    }
    if (!event.target.closest('.company-picker-control')) closeCompanyPicker()
  }
  picker.onclick = pickerHandler
}

async function applyCompany(companyId) {
  if (!companyId || companyId === state.company) return
  switchCompany(companyId)
  state.selectedCollection = null
  state.kb = null
  state.collapsed.clear()
  renderCompanyPicker()
  try {
    await loadMe()
  } catch {
    /* 顶栏切公司不应被身份刷新失败挡住 */
  }
  await PAGES[state.page].render()
}

async function loadMe() {
  const me = await api('/api/me')
  state.me = me
  const nameEl = $('#id-name')
  if (nameEl) nameEl.textContent = me.company ? me.company.name : '管理范围'
  const subEl = $('#id-sub')
  if (subEl) subEl.textContent = me.company ? `服务器侧 · ${me.company.id} · 全公司` : '服务器侧配置'

  const foot = $('#nav-tail')
  if (foot) foot.textContent = ''

  const caps = $('#caps')
  if (caps) {
    const shown = me.capabilities.slice(0, 10)
    const rest = me.capabilities.length - shown.length
    caps.innerHTML =
      shown.map((cap) => `<span class="chip" title="${esc(cap.scope)}">${esc(cap.label)}</span>`).join('') +
      (rest > 0 ? `<span class="chip accent" title="共 ${me.capabilities.length} 项能力">+${rest} 项</span>` : '')
  }
}

/* ---------------- 组织树 ---------------- */

function treePathsWithChildren(node, out = []) {
  if (!node) return out
  if (Array.isArray(node.children) && node.children.length > 0) out.push(node.path)
  for (const child of node.children || []) treePathsWithChildren(child, out)
  return out
}

function renderTree(node, depth, container, failed) {
  if (failed) {
    container.innerHTML = `<div class="banner danger" style="margin:0;flex-direction:column;align-items:flex-start;gap:4px">
      <strong>${esc(failed.message)}</strong>
      <span class="mono">${esc(failed.code)}</span>
    </div>`
    return
  }
  if (!node) {
    container.innerHTML = '<div class="empty">暂无部门</div>'
    return
  }
  const hasKids = Array.isArray(node.children) && node.children.length > 0
  const folded = state.collapsed.has(node.path)
  const total = Number(node.subtreeMemberCount ?? node.memberCount ?? 0)
  const currentCompany = depth === 0 && node.companyId === state.company
  const row = document.createElement('div')
  row.className = `tree-row dept-row${state.deptFilter === node.path ? ' is-active' : ''}${currentCompany ? ' is-current-company' : ''}`
  row.style.paddingLeft = `${10 + depth * 16}px`
  const childCount = node.children?.length ?? 0
  const manager = node.managerName ? `负责人 ${node.managerName}` : '未设置负责人'
  row.innerHTML = `
    <span class="caret ${hasKids ? '' : 'leaf'} ${folded ? 'folded' : ''}">${hasKids ? '▸' : '·'}</span>
    <span class="tree-avatar" aria-hidden="true">${esc(String(node.name || '部').slice(0, 1))}</span>
    <span class="tree-body">
      <span class="tree-name">${esc(node.name)}${currentCompany ? '<span class="tree-current">当前</span>' : ''}</span>
      <span class="tree-sub">${esc(manager)}${hasKids ? ` · ${childCount} 个下级` : ''}</span>
    </span>
    <span class="count" title="直属 ${node.memberCount} 人 · 含下级 ${total} 人"><strong>${total}</strong><span>人</span></span>`

  row.dataset.path = node.path
  row.addEventListener('click', (event) => {
    activateDept(node, { toggle: !event.target.closest('.count') })
  })
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    activateDept(node, { toggle: false })
    showDeptMenu(node, event.clientX, event.clientY)
  })

  container.appendChild(row)
  if (!folded) {
    for (const child of node.children) renderTree(child, depth + 1, container, null)
  }
}

let rootNodes = []

function repaintTree() {
  const container = $('#tree')
  if (!container) return
  container.innerHTML = ''
  for (const node of rootNodes) renderTree(node, 0, container, null)
}

function activateDept(node, { toggle = false } = {}) {
  // 多公司树：点到哪家公司，就把后续成员查询切到哪家
  if (node.companyId && node.companyId !== state.company) {
    switchCompany(node.companyId)
  }
  // 点什么都先筛这个部门：叶子部门也要有反应，否则点了像是"没坏但没生效"
  state.deptFilter = node.path
  // 有下级就顺带展开/收起（点人数只筛不折叠，避免"想看人却把树收没了"）
  if (toggle && Array.isArray(node.children) && node.children.length > 0) {
    if (state.collapsed.has(node.path)) state.collapsed.delete(node.path)
    else state.collapsed.add(node.path)
  }
  repaintTree()
  if (state.page === 'departments') {
    renderDeptDetail(node)
    return
  }
  const list = $('#org-members')
  if (list) loadMembers(list)
}

let deptMenu = null

function hideDeptMenu() {
  if (deptMenu) {
    deptMenu.remove()
    deptMenu = null
  }
}

function showDeptMenu(node, x, y) {
  hideDeptMenu()
  if (!node) return
  const isRoot = isRootDept(node)
  const el = document.createElement('div')
  el.className = 'ctx-menu dept-menu'
  el.id = 'dept-menu'
  el.innerHTML = `
    <div class="ctx-menu-head">${esc(node.name)}</div>
    <button type="button" data-dept-act="edit">编辑部门</button>
    ${isRoot ? '' : '<button type="button" data-dept-act="delete" class="danger">删除部门</button>'}`
  document.body.appendChild(el)
  const width = 188
  const height = isRoot ? 112 : 148
  el.style.left = `${Math.min(x, window.innerWidth - width - 8)}px`
  el.style.top = `${Math.min(y, window.innerHeight - height - 8)}px`
  deptMenu = el
  el.addEventListener('click', (event) => {
    const action = event.target.closest('[data-dept-act]')?.dataset.deptAct
    if (!action) return
    hideDeptMenu()
    if (action === 'edit') openDeptEdit(node)
    if (action === 'delete') deleteDept(node)
  })
}

async function refreshOrgRoots() {
  // 组织页同时展示所有公司：每家一个公司根节点，下面挂各自部门树
  const roots = []
  const names = {}
  let deptTotal = 0
  for (const company of state.companies) {
    const data = await apiForCompany('/api/org/tree', company.id)
    const node = data.root
    if (!node) continue
    node.companyId = company.id
    const walk = (item) => {
      if (!item) return
      item.companyId = company.id
      if (item.path) names[item.path] = item.name
      for (const child of item.children || []) walk(child)
    }
    walk(node)
    roots.push(node)
    deptTotal += Number(data.total ?? 0)
  }
  rootNodes = roots
  state.deptNames = names
  return { roots, deptTotal }
}

async function loadTree() {
  const container = $('#tree')
  if (!container) return
  container.innerHTML = ''
  try {
    const { roots, deptTotal } = await refreshOrgRoots()
    const count = $('#dept-count')
    if (count) count.textContent = `${roots.length} 家公司 · ${deptTotal} 个部门`
    for (const node of roots) renderTree(node, 0, container, null)
  } catch (err) {
    const count = $('#dept-count')
    if (count) count.textContent = ''
    renderTree(null, 0, container, err)
  }
}

/* ---------------- 知识库 ---------------- */

function aclText(acl) {
  if (!acl.valid) return '配置无效（已按不可见处理）'
  if (acl.mode === 'all') return '全公司'
  if (acl.mode === 'roles') return (acl.roles || []).map((r) => ROLE_LABEL[r] || r).join('、') || '（空角色列表）'
  if (acl.mode === 'depts') return (acl.deptPaths || []).join('、') || '（空部门列表）'
  if (acl.mode === 'private') return acl.ownerUserId ? `所有者 ${acl.ownerUserId}` : '（缺所有者）'
  return acl.mode
}

async function loadKb() {
  const view = $('#view')
  renderLoading(view)
  setSide(`<div class="side-head">知识库</div><div class="side-note muted">加载中…</div>`)
  try {
    const data = await api('/api/kb/collections')
    let consoleData = null
    try {
      consoleData = await api('/api/console/kb/collections')
    } catch {
      consoleData = null
    }
    if (consoleData?.collections) {
      const meta = new Map(consoleData.collections.map((item) => [item.id, item]))
      data.collections = data.collections.map((item) => {
        const source = meta.get(item.id)
        return source
          ? {
              ...item,
              sourceKind: source.sourceKind,
              sourceLabel: source.sourceLabel,
              sourceConfig: source.sourceConfig,
              sourceSecretConfigured: source.sourceSecretConfigured,
            }
          : item
      })
    }
    state.kb = data
    renderKbSide(data)
    view.innerHTML = `<div id="kb-docs"><section class="panel"><div class="empty">从左侧选择一个知识库，或新建一个</div></section></div>`

    const keep =
      state.selectedCollection && data.collections.some((c) => c.id === state.selectedCollection)
        ? state.selectedCollection
        : null
    if (keep) loadDocs(keep)
    else if (data.collections.length > 0) {
      state.selectedCollection = data.collections[0].id
      renderKbSide(data)
      loadDocs(data.collections[0].id)
    }
  } catch (err) {
    setSide('', true)
    renderDenied(view, err)
  }
}

function renderKbSide(data) {
  const items = data.collections
    .map((item) => {
      const active = state.selectedCollection === item.id ? ' is-active' : ''
      const kind = item.sourceKind || 'local'
      const source = kind === 'local' ? '' : ` · 外部/${item.sourceLabel || kind}`
      return `<div class="side-item${active}" data-collection="${esc(item.id)}" data-kind="${esc(kind)}">
        <button class="side-item-main" type="button" data-kb-open>
          <strong>${esc(item.name)}</strong>
          <span class="side-item-sub">${esc(MODE_LABEL[item.acl.mode] || item.acl.mode)} · ${item.docCount} 篇文档${esc(source)}</span>
        </button>
        <button class="side-item-more" type="button" data-kb-more title="更多操作">⋯</button>
      </div>`
    })
    .join('')

  setSide(`
    <div class="side-head">知识库 <span class="muted">${data.collections.length}</span></div>
    <button class="btn primary side-add" type="button" id="kb-new">新建知识库</button>
    <div class="side-list">${items || '<div class="side-note">还没有知识库，点上方新建</div>'}</div>`)

  $('#kb-new')?.addEventListener('click', () => openKbModal(null))

  for (const item of document.querySelectorAll('.side-item[data-collection]')) {
    const select = () => {
      state.selectedCollection = item.dataset.collection
      for (const row of document.querySelectorAll('.side-item[data-collection]')) {
        row.classList.toggle('is-active', row.dataset.collection === state.selectedCollection)
      }
      loadDocs(state.selectedCollection)
    }
    item.querySelector('[data-kb-open]')?.addEventListener('click', select)
    item.querySelector('[data-kb-more]')?.addEventListener('click', (event) => {
      event.stopPropagation()
      const rect = event.currentTarget.getBoundingClientRect()
      showKbMenu(item.dataset.collection, rect.right, rect.bottom + 4)
    })
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      showKbMenu(item.dataset.collection, event.clientX, event.clientY)
    })
  }
}

function kbCollection(id) {
  return (state.kb?.collections ?? []).find((item) => item.id === id) || null
}

let kbMenu = null

function hideKbMenu() {
  if (kbMenu) {
    kbMenu.remove()
    kbMenu = null
  }
}

function showKbMenu(collectionId, x, y) {
  hideKbMenu()
  const collection = kbCollection(collectionId)
  if (!collection) return
  const el = document.createElement('div')
  el.className = 'ctx-menu kb-menu'
  el.id = 'kb-menu'
  el.innerHTML = `
    <div class="ctx-menu-head">${esc(collection.name)}</div>
    <button type="button" data-kb-act="edit">编辑 / 可见范围</button>
    <button type="button" data-kb-act="rename">重命名</button>
    <button type="button" data-kb-act="delete" class="danger">删除知识库</button>`
  document.body.appendChild(el)
  const width = 188
  const height = 148
  el.style.left = `${Math.min(x, window.innerWidth - width - 8)}px`
  el.style.top = `${Math.min(y, window.innerHeight - height - 8)}px`
  kbMenu = el
  el.addEventListener('click', (event) => {
    const action = event.target.closest('[data-kb-act]')?.dataset.kbAct
    if (!action) return
    hideKbMenu()
    if (action === 'edit') openKbModal(collection)
    if (action === 'rename') renameKb(collection)
    if (action === 'delete') removeKb(collection)
  })
}

async function renameKb(collection) {
  const next = prompt('重命名知识库', collection.name)
  if (next === null) return
  const name = next.trim()
  if (!name || name === collection.name) return
  try {
    await apiSend('PATCH', `/api/console/kb/collections/${encodeURIComponent(collection.id)}`, { name })
    await loadKb()
  } catch (err) {
    alert(err.message || '重命名失败')
  }
}

async function removeKb(collection) {
  const extra = collection.sourceKind && collection.sourceKind !== 'local' ? `外部来源：${collection.sourceLabel || collection.sourceKind}` : ''
  const ok = await confirmCard({
    title: '删除知识库？',
    message: `「${collection.name}」及其文档、切片会一并从检索中移除。`,
    detail: extra,
    confirmText: '删除知识库',
  })
  if (!ok) return
  try {
    await apiSend('DELETE', `/api/console/kb/collections/${encodeURIComponent(collection.id)}`)
    if (state.selectedCollection === collection.id) state.selectedCollection = null
    await loadKb()
  } catch (err) {
    alert(err.message || '删除失败')
  }
}

function flattenDepartments(node, out = []) {
  if (!node) return out
  for (const child of node.children ?? []) {
    out.push({ path: child.path, name: child.name, depth: child.depth ?? 1 })
    flattenDepartments(child, out)
  }
  return out
}

function kbSourceConfig(collection) {
  const raw = collection?.sourceConfig
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

function kbSourceFieldsHtml(kind, config, secretConfigured) {
  if (kind === 'dify') {
    return `<label class="field"><span>Dify API 地址</span><input id="kb-src-base" value="${esc(config.baseUrl || 'https://api.dify.ai/v1')}" placeholder="https://api.dify.ai/v1" /></label>
      <label class="field"><span>datasetId</span><input id="kb-src-dataset" value="${esc(config.datasetId || '')}" placeholder="Dify 知识库 ID" /></label>
      <label class="field"><span>API Key</span><input id="kb-src-secret" type="password" placeholder="${secretConfigured ? '已保存，留空不修改' : 'dataset 检索权限的 API Key'}" autocomplete="new-password" /></label>
      ${hintNote('来源说明', 'Dify 走在线检索；文档由 Dify 管理，EAB 内只读展示。')}`
  }
  if (kind === 'obsidian') {
    return `<label class="field"><span>Vault 目录（服务器本地路径）</span><input id="kb-src-vault" value="${esc(config.vaultPath || '')}" placeholder="例如 D:\\Notes\\MyVault" /></label>
      <label class="field"><span>导入密级</span><select id="kb-src-cls">
        <option value="public"${config.classification === 'public' ? ' selected' : ''}>公开</option>
        <option value="internal"${config.classification !== 'public' && config.classification !== 'confidential' ? ' selected' : ''}>内部</option>
        <option value="confidential"${config.classification === 'confidential' ? ' selected' : ''}>机密</option>
      </select></label>
      ${hintNote('同步说明', '保存后点“同步 Vault”把 Markdown 导入 EAB；导入后的文档可以点击编辑、删除，检索走本地切片。')}`
  }
  if (kind === 'generic') {
    return `<label class="field"><span>检索接口地址</span><input id="kb-src-endpoint" value="${esc(config.endpoint || '')}" placeholder="https://example.com/api/search" /></label>
      <label class="field"><span>请求方法</span><select id="kb-src-method">
        <option value="POST"${config.method !== 'GET' ? ' selected' : ''}>POST</option>
        <option value="GET"${config.method === 'GET' ? ' selected' : ''}>GET</option>
      </select></label>
      <label class="field"><span>Token / API Key（可选）</span><input id="kb-src-secret" type="password" placeholder="${secretConfigured ? '已保存，留空不修改' : '会以 Bearer 方式发送'}" autocomplete="new-password" /></label>
      <div class="source-grid">
        <label class="field"><span>入参字段</span><input id="kb-src-query-field" value="${esc(config.queryField || 'query')}" /></label>
        <label class="field"><span>条数字段</span><input id="kb-src-topk-field" value="${esc(config.topKField || 'top_k')}" /></label>
        <label class="field"><span>结果路径</span><input id="kb-src-results-path" value="${esc(config.resultsPath || 'results')}" placeholder="results 或 data.items" /></label>
        <label class="field"><span>标题字段</span><input id="kb-src-title-field" value="${esc(config.titleField || 'title')}" /></label>
        <label class="field"><span>正文字段</span><input id="kb-src-text-field" value="${esc(config.textField || 'text')}" /></label>
      </div>
      ${hintNote('接口说明', '适配 Confluence / Notion 代理、RAGFlow、火山知识库等自定义 REST 接口；返回数组元素至少包含正文字段。')}`
  }
  return hintNote('本地知识库', '文档在 EAB 内新增、编辑、删除，走本地切片检索。')
}

function bindKbSourceFields(overlay, collection) {
  const select = overlay.querySelector('#kb-source-kind')
  const host = overlay.querySelector('#kb-source-fields')
  const config = kbSourceConfig(collection)
  const render = () => {
    host.innerHTML = kbSourceFieldsHtml(select.value, config, Boolean(collection?.sourceSecretConfigured))
  }
  select.addEventListener('change', render)
  render()
}

function readKbSource(overlay) {
  const kind = overlay.querySelector('#kb-source-kind').value
  const value = (id) => overlay.querySelector(`#${id}`)?.value.trim() || ''
  if (kind === 'dify') {
    return {
      sourceKind: kind,
      sourceConfig: { baseUrl: value('kb-src-base'), datasetId: value('kb-src-dataset') },
      sourceSecret: value('kb-src-secret'),
    }
  }
  if (kind === 'obsidian') {
    return {
      sourceKind: kind,
      sourceConfig: { vaultPath: value('kb-src-vault'), classification: overlay.querySelector('#kb-src-cls').value },
      sourceSecret: '',
    }
  }
  if (kind === 'generic') {
    return {
      sourceKind: kind,
      sourceConfig: {
        endpoint: value('kb-src-endpoint'),
        method: overlay.querySelector('#kb-src-method').value,
        queryField: value('kb-src-query-field') || 'query',
        topKField: value('kb-src-topk-field') || 'top_k',
        resultsPath: value('kb-src-results-path') || 'results',
        titleField: value('kb-src-title-field') || 'title',
        textField: value('kb-src-text-field') || 'text',
      },
      sourceSecret: value('kb-src-secret'),
    }
  }
  return { sourceKind: 'local', sourceConfig: {}, sourceSecret: '' }
}

async function openKbModal(collection) {
  const roleData = await api('/api/console/roles')
  let depts = []
  try {
    depts = flattenDepartments((await api('/api/org/tree')).root)
  } catch {
    depts = []
  }
  const aclMode = collection?.acl.mode ?? 'all'
  const selectedRoles = new Set(collection?.acl.roles ?? [])
  const selectedDepts = new Set(collection?.acl.deptPaths ?? [])
  const overlay = modelModal(`
    <div class="modal-head"><h3>${collection ? '编辑知识库' : '新建知识库'}</h3><button class="modal-x" type="button">×</button></div>
    <div class="field-stack">
      <label class="field"><span>名称</span><input id="kb-name" value="${esc(collection?.name ?? '')}" placeholder="例如 公司制度、产品资料" /></label>
      <label class="field"><span>说明</span><textarea id="kb-desc" rows="2" placeholder="这个库放什么内容">${esc(collection?.description ?? '')}</textarea></label>
      <label class="field"><span>数据来源</span>
        <select id="kb-source-kind">
          <option value="local"${(collection?.sourceKind ?? 'local') === 'local' ? ' selected' : ''}>本地知识库（EAB 内维护）</option>
          <option value="dify"${collection?.sourceKind === 'dify' ? ' selected' : ''}>Dify 知识库（在线检索）</option>
          <option value="obsidian"${collection?.sourceKind === 'obsidian' ? ' selected' : ''}>Obsidian Vault（导入 Markdown）</option>
          <option value="generic"${collection?.sourceKind === 'generic' ? ' selected' : ''}>通用 HTTP 知识库（自定义 REST）</option>
        </select>
      </label>
      <div class="source-fields" id="kb-source-fields"></div>
      <div class="field"><span>可见范围</span>
        <div class="segmented" id="kb-mode">
          <button type="button" data-mode="all" class="${aclMode === 'all' ? 'active' : ''}">全公司</button>
          <button type="button" data-mode="roles" class="${aclMode === 'roles' ? 'active' : ''}">指定角色</button>
          <button type="button" data-mode="depts" class="${aclMode === 'depts' ? 'active' : ''}">指定部门</button>
        </div>
      </div>
      <div class="acl-block" id="kb-role-block">
        <div class="acl-title">可选角色</div>
        <div class="check-grid">
          ${roleData.roles
            .map(
              (role) => `<label class="check"><input type="checkbox" data-kb-role="${esc(role.code)}"${
                selectedRoles.has(role.code) ? ' checked' : ''
              } /><span>${esc(ROLE_LABEL[role.code] || role.name)}</span></label>`,
            )
            .join('')}
        </div>
      </div>
      <div class="acl-block" id="kb-dept-block">
        <div class="acl-title">可选部门（含下级）</div>
        <div class="check-grid dept-check-grid">
          ${
            depts
              .map(
                (dept) => `<label class="check"><input type="checkbox" data-kb-dept="${esc(dept.path)}"${
                  selectedDepts.has(dept.path) ? ' checked' : ''
                } /><span>${'　'.repeat(Math.max(0, Number(dept.depth) - 1))}${esc(dept.name)}</span></label>`,
              )
              .join('') || '<span class="muted">还没有部门</span>'
          }
        </div>
      </div>
    </div>
    <div class="modal-state" id="kb-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="kb-save">保存</button>
      <button class="btn ghost" type="button" id="kb-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#kb-cancel').addEventListener('click', close)
  bindKbSourceFields(overlay, collection)

  let mode = aclMode
  const syncMode = () => {
    for (const button of overlay.querySelectorAll('#kb-mode button')) {
      button.classList.toggle('active', button.dataset.mode === mode)
    }
    overlay.querySelector('#kb-role-block').classList.toggle('is-hidden', mode !== 'roles')
    overlay.querySelector('#kb-dept-block').classList.toggle('is-hidden', mode !== 'depts')
  }
  overlay.querySelectorAll('#kb-mode button').forEach((button) => {
    button.addEventListener('click', () => {
      mode = button.dataset.mode
      syncMode()
    })
  })
  syncMode()

  overlay.querySelector('#kb-save').addEventListener('click', async () => {
    const stateEl = overlay.querySelector('#kb-state')
    stateEl.textContent = '保存中…'
    const body = {
      name: overlay.querySelector('#kb-name').value.trim(),
      description: overlay.querySelector('#kb-desc').value.trim(),
      aclMode: mode,
      roles: [...overlay.querySelectorAll('[data-kb-role]:checked')].map((el) => el.dataset.kbRole),
      deptPaths: [...overlay.querySelectorAll('[data-kb-dept]:checked')].map((el) => el.dataset.kbDept),
      ...readKbSource(overlay),
    }
    try {
      if (collection) await apiSend('PATCH', `/api/console/kb/collections/${encodeURIComponent(collection.id)}`, body)
      else {
        const created = await apiPost('/api/console/kb/collections', body)
        state.selectedCollection = created.collection.id
      }
      close()
      loadKb()
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '保存失败'
    }
  })
}

function openKbDocModal(collectionId, mode) {
  const overlay = modelModal(`
    <div class="modal-head"><h3>添加文档</h3><button class="modal-x" type="button">×</button></div>
    <div class="field-stack">
      <label class="field"><span>从文件导入（txt / md / csv / json）</span><input id="doc-file" type="file" accept=".txt,.md,.markdown,.csv,.json,.log,.html" /></label>
      <label class="field"><span>标题</span><input id="doc-title" placeholder="例如 员工考勤管理办法" /></label>
      <label class="field"><span>正文</span><textarea id="doc-content" rows="9" placeholder="粘贴文本，或者选上面的文件自动读入；保存后按段落切片入库"></textarea></label>
      <label class="field"><span>密级</span>
        <select id="doc-cls">
          <option value="public">公开</option>
          <option value="internal" selected>内部</option>
          <option value="confidential">机密</option>
        </select>
      </label>
    </div>
    <div class="modal-state" id="doc-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="doc-save">保存并入库</button>
      <button class="btn ghost" type="button" id="doc-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#doc-cancel').addEventListener('click', close)
  overlay.querySelector('#doc-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) {
      alert('文本文件请控制在 5 MB 以内')
      event.target.value = ''
      return
    }
    try {
      const text = await file.text()
      overlay.querySelector('#doc-content').value = text
      if (!overlay.querySelector('#doc-title').value.trim()) {
        overlay.querySelector('#doc-title').value = file.name.replace(/\.[^.]+$/, '')
      }
    } catch {
      alert('读取文件失败，换个纯文本文件试试')
    }
  })
  overlay.querySelector('#doc-save').addEventListener('click', async () => {
    const stateEl = overlay.querySelector('#doc-state')
    stateEl.textContent = '入库中…'
    try {
      await apiPost(`/api/console/kb/collections/${encodeURIComponent(collectionId)}/docs`, {
        title: overlay.querySelector('#doc-title').value.trim(),
        content: overlay.querySelector('#doc-content').value.trim(),
        classification: overlay.querySelector('#doc-cls').value,
      })
      close()
      loadKb()
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '入库失败'
    }
  })
}

async function openKbDocEdit(docId) {
  let data
  try {
    data = await api(`/api/console/kb/docs/${encodeURIComponent(docId)}`)
  } catch (err) {
    alert(err.message || '文档读取失败')
    return
  }
  const doc = data.doc
  const overlay = modelModal(`
    <div class="modal-head"><h3>编辑文档</h3><button class="modal-x" type="button">×</button></div>
    <div class="field-stack">
      <label class="field"><span>标题</span><input id="doc-title" value="${esc(doc.title)}" /></label>
      <label class="field"><span>正文</span><textarea id="doc-content" rows="12">${esc(doc.content || '')}</textarea></label>
      <label class="field"><span>密级</span>
        <select id="doc-cls">
          <option value="public"${doc.classification === 'public' ? ' selected' : ''}>公开</option>
          <option value="internal"${doc.classification === 'internal' ? ' selected' : ''}>内部</option>
          <option value="confidential"${doc.classification === 'confidential' ? ' selected' : ''}>机密</option>
        </select>
      </label>
      ${hintNote('保存说明', '保存后会重新切片。')}
      <div class="hint">当前 ${doc.chunkCount} 个切片 · 来源：${esc(doc.sourceKind || 'local')}</div>
    </div>
    <div class="modal-state" id="doc-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="doc-save">保存修改</button>
      <button class="btn danger" type="button" id="doc-delete">删除文档</button>
      <button class="btn ghost" type="button" id="doc-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#doc-cancel').addEventListener('click', close)
  overlay.querySelector('#doc-save').addEventListener('click', async () => {
    const stateEl = overlay.querySelector('#doc-state')
    stateEl.textContent = '保存中…'
    try {
      await apiSend('PATCH', `/api/console/kb/docs/${encodeURIComponent(doc.id)}`, {
        title: overlay.querySelector('#doc-title').value.trim(),
        content: overlay.querySelector('#doc-content').value,
        classification: overlay.querySelector('#doc-cls').value,
      })
      close()
      loadDocs(doc.collectionId)
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '保存失败'
    }
  })
  overlay.querySelector('#doc-delete').addEventListener('click', async () => {
    const ok = await confirmCard({
      title: '删除文档？',
      message: `「${doc.title}」删除后不再参与检索。`,
      confirmText: '删除文档',
    })
    if (!ok) return
    try {
      await apiSend('DELETE', `/api/console/kb/docs/${encodeURIComponent(doc.id)}`)
      close()
      loadDocs(doc.collectionId)
    } catch (err) {
      alert(err.message || '删除失败')
    }
  })
}

async function loadDocs(collectionId) {
  const host = $('#kb-docs')
  if (!host) return
  renderLoading(host, '加载文档…')
  try {
    const data = await api(`/api/console/kb/collections/${encodeURIComponent(collectionId)}/docs`)
    const collection = state.kb?.collections?.find((item) => item.id === collectionId)
    const sourceKind = data.collection.sourceKind || collection?.sourceKind || 'local'
    const sourceLabel = data.collection.sourceLabel || collection?.sourceLabel || sourceKind
    const external = Boolean(data.external)
    const totalChunks = data.docs.reduce((sum, doc) => sum + Number(doc.chunkCount || 0), 0)
    const vector = data.vector ?? { chunks: 0, vectors: 0, dim: 0, modelIds: [] }
    const indexCell = (doc) => {
      if (external) return `<span class="pill">外部托管</span>`
      if (doc.status === 'pending') return '<span class="pill warn">待索引</span>'
      if (doc.status === 'indexing') return '<span class="pill warn">向量化中…</span>'
      if (doc.status === 'failed') {
        return `<span class="pill danger" title="${esc(doc.indexError || '')}">索引失败</span>`
      }
      if (doc.status === 'indexed' || doc.status === 'completed') {
        if (doc.indexError) {
          return `<span class="pill warn" title="${esc(doc.indexError)}">已入库 · 仅关键词</span>`
        }
        return '<span class="pill ok">已索引</span>'
      }
      return `<span class="pill warn">${esc(doc.status)}</span>`
    }
    const docs = data.docs
      .map(
        (doc) => `<tr${external ? '' : ` class="click-row" data-doc="${esc(doc.id)}"`}>
          <td class="name-cell"><strong>${esc(doc.title)}</strong><div class="desc">${doc.chunkCount} ${
            external ? '字' : '个切片'
          }</div></td>
          <td><span class="pill">${external ? '外部' : esc(CLS_LABEL[doc.classification] || doc.classification)}</span></td>
          <td>${indexCell(doc)}${doc.indexError && doc.status !== 'failed' ? `<div class="desc kb-index-error">${esc(doc.indexError)}</div>` : ''}</td>
        </tr>`,
      )
      .join('')

    const sourceBadge =
      sourceKind === 'local'
        ? ''
        : `<span class="pill source-pill">${esc(sourceLabel)}</span>`
    const docsHint = external
      ? `上游知识库返回的文档，EAB 内只读。文档由 ${sourceLabel} 上游管理；检索通过 kb.search 在线调用。${
          data.docs.length === 0 ? '当前没有返回文档，请检查 API Key 是否有 dataset:read 权限。' : ''
        }`
      : sourceKind === 'obsidian'
        ? 'Obsidian 文档已导入为本地切片，可直接点击编辑；上游新增文件请点“同步 Vault”。'
        : '点击任意一行可编辑内容、密级与索引状态。'

    host.innerHTML = `
      <section class="panel kb-summary-panel">
        <div class="panel-head">
          <div>
            <h2>${esc(data.collection.name)} ${sourceBadge}</h2>
            <span class="hint">${esc(MODE_LABEL[data.collection.aclMode] || data.collection.aclMode)} · ${
              collection?.docCount ?? data.docs.length
            } 篇文档${external ? '' : ` · ${totalChunks} 个切片`}</span>
          </div>
          <div class="head-actions">
            ${
              sourceKind !== 'local'
                ? '<button class="btn" type="button" id="kb-test">测试连接</button>'
                : ''
            }
            ${
              sourceKind === 'obsidian'
                ? '<button class="btn" type="button" id="kb-sync">同步 Vault</button>'
                : ''
            }
            <button class="btn" type="button" id="kb-edit">编辑 / 可见范围</button>
            ${external ? '' : '<button class="btn" type="button" id="kb-reindex">重建索引</button>'}
            ${external ? '' : '<button class="btn primary" type="button" id="kb-add-doc">添加文档</button>'}
          </div>
        </div>
        <div class="modal-state" id="kb-source-state"></div>
        ${
          external
            ? ''
            : `<div class="kb-vector-bar ${vector.vectors ? 'is-on' : ''}">
                <div class="kb-vector-copy">
                  <strong>${vector.vectors ? '混合检索已启用' : '当前仅关键词检索'}</strong>
                  <span>${
                    vector.vectors
                      ? `${vector.vectors} 个切片已向量化 · ${vector.dim} 维${
                          vector.modelIds?.length ? ` · ${esc(vector.modelIds.join(' / '))}` : ''
                        }`
                      : '未配置向量模型或尚未索引；上传和问答仍可用，不会阻断。'
                  }</span>
                </div>
                <div class="kb-vector-stats">
                  <div><strong>${totalChunks}</strong><span>切片</span></div>
                  <div><strong>${vector.vectors || 0}</strong><span>向量</span></div>
                </div>
              </div>`
        }
      </section>

      <section class="panel kb-doc-panel">
        <div class="panel-head">
          <div><h2>文档</h2>${hintBadge(external ? '来源说明' : '文档说明', docsHint)}</div>
          <span class="pill">${data.docs.length} 篇</span>
        </div>
        <table class="data">
          <thead><tr><th>文档</th><th>密级</th><th>索引状态</th></tr></thead>
          <tbody>${docs || `<tr><td colspan="3" class="empty">${
            external ? '上游还没有返回文档' : '还没有文档，点上方添加文档'
          }</td></tr>`}</tbody>
        </table>
      </section>`

    host.querySelector('#kb-edit')?.addEventListener('click', () => {
      if (collection) openKbModal(collection)
    })
    host.querySelector('#kb-add-doc')?.addEventListener('click', () => openKbDocModal(collectionId, data.collection.aclMode))
    host.querySelector('#kb-test')?.addEventListener('click', async (event) => {
      const stateEl = host.querySelector('#kb-source-state')
      event.currentTarget.disabled = true
      stateEl.className = 'modal-state'
      stateEl.textContent = '测试连接中…'
      try {
        const result = await apiPost(`/api/console/kb/collections/${encodeURIComponent(collectionId)}/test`, {})
        stateEl.className = `modal-state ${result.ok ? 'good' : 'bad'}`
        stateEl.textContent = result.message || (result.ok ? '连接成功' : '连接失败')
      } catch (err) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = err.message || '测试失败'
      } finally {
        event.currentTarget.disabled = false
      }
    })
    host.querySelector('#kb-sync')?.addEventListener('click', async (event) => {
      const stateEl = host.querySelector('#kb-source-state')
      event.currentTarget.disabled = true
      stateEl.className = 'modal-state'
      stateEl.textContent = '同步 Vault 中…'
      try {
        const result = await apiPost(`/api/console/kb/collections/${encodeURIComponent(collectionId)}/sync`, {})
        stateEl.className = 'modal-state good'
        stateEl.textContent = `同步完成：${result.files} 个文件，新增 ${result.created}，更新 ${result.updated}，跳过 ${result.skipped}`
        await loadKb()
      } catch (err) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = err.message || '同步失败'
      } finally {
        event.currentTarget.disabled = false
      }
    })
    host.querySelector('#kb-reindex')?.addEventListener('click', async (event) => {
      const stateEl = host.querySelector('#kb-source-state')
      const button = event.currentTarget
      button.disabled = true
      stateEl.className = 'modal-state'
      stateEl.textContent = '提交索引任务…'
      try {
        await apiPost(`/api/console/kb/collections/${encodeURIComponent(collectionId)}/reindex`, {})
        for (let attempt = 0; attempt < 80; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1500))
          const status = await api(
            `/api/console/kb/collections/${encodeURIComponent(collectionId)}/index-status`,
          )
          const job = status.job
          if (!job) break
          if (job.status === 'failed' || job.status === 'done') {
            stateEl.className = `modal-state ${job.status === 'failed' ? 'bad' : 'good'}`
            stateEl.textContent =
              job.status === 'failed'
                ? `索引失败：${job.done}/${job.total} 成功${job.error ? ` · ${job.error}` : ''}`
                : `索引完成：${job.done}/${job.total} 篇文档，${status.vector?.vectors ?? 0} 个向量`
            await loadDocs(collectionId)
            return
          }
          stateEl.textContent = `向量化中 ${job.done}/${job.total}…`
        }
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '索引任务超时，稍后可在索引状态里查看结果'
      } catch (err) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = err.message || '重建索引失败'
      } finally {
        button.disabled = false
      }
    })
    for (const row of host.querySelectorAll('[data-doc]')) {
      row.addEventListener('click', () => openKbDocEdit(row.dataset.doc))
    }
  } catch (err) {
    renderDenied(host, err)
  }
}

/* ---------------- 组织页：成员管理 / 部门管理 ---------------- */

async function loadOrg() {
  const view = $('#view')
  setSide('', true)
  view.innerHTML = `<div id="org-members"><section class="panel"><div class="panel-head"><h2>成员</h2></div><div class="loading">加载中…</div></section></div>`
  try {
    await refreshOrgRoots()
    const currentRoot = currentCompanyRoot()
    const paths = new Set(deptNodes(currentRoot).map((node) => node.path))
    if (!state.deptFilter || !paths.has(state.deptFilter)) {
      state.deptFilter = currentRoot?.path ?? null
    }
    await loadMembers($('#org-members'))
  } catch (err) {
    renderDenied(view, err)
  }
}

async function loadDepartments() {
  const view = $('#view')
  setSide('', true)
  renderLoading(view)
  try {
    view.innerHTML = `
      <div class="dept-board">
        <section class="panel dept-tree-card">
          <div class="panel-head">
            <div><h2>部门结构</h2><span class="hint" id="dept-count">—</span></div>
            <div class="panel-actions">
              <button class="btn sm ghost" type="button" data-tree-expand>全部展开</button>
              <button class="btn sm ghost" type="button" data-tree-collapse>全部收起</button>
              <button class="btn sm primary" type="button" id="dept-new">＋ 新建部门</button>
            </div>
          </div>
          <div class="hint-note" style="margin:0 18px 12px">${hintBadge('人数口径', '点部门查看详情；右键可编辑或删除。人数口径为含下级部门的成员数，与成员管理页选「含下级」一致。')}</div>
          <div class="tree dept-tree" id="tree"></div>
        </section>
        <section class="dept-detail" id="dept-detail"></section>
      </div>`
    await loadTree()
    const currentRoot = currentCompanyRoot()
    const paths = new Set(deptNodes(currentRoot).map((node) => node.path))
    if (!state.deptFilter || !paths.has(state.deptFilter)) {
      state.deptFilter = currentRoot?.path ?? null
    }
    repaintTree()
    view.querySelector('#dept-new')?.addEventListener('click', () => openDeptCreate(state.deptFilter))
    renderDeptDetail(orgSelectedDept())
  } catch (err) {
    renderDenied(view, err)
  }
}

function renderDeptDetail(node) {
  const host = $('#dept-detail')
  if (!host) return
  if (!node) {
    host.innerHTML = `<section class="panel"><div class="empty">当前公司还没有部门数据</div></section>`
    return
  }
  const root = currentCompanyRoot()
  const all = deptNodes(root)
  const parent = all.find((item) => item.children?.some((child) => child.id === node.id))
  const children = node.children || []
  const isRoot = isRootDept(node)
  const direct = Number(node.memberCount ?? 0)
  const total = Number(node.subtreeMemberCount ?? direct)
  host.innerHTML = `
    <section class="panel dept-detail-card">
      <div class="panel-head">
        <div>
          <h2>${esc(node.name)}</h2>
          <span class="hint">${isRoot ? '公司根部门' : parent ? `上级 · ${esc(parent.name)}` : '部门'}</span>
        </div>
        <div class="panel-actions">
          ${isRoot ? '' : `<button class="btn sm danger" type="button" data-dept-detail-delete>删除</button>`}
          <button class="btn sm" type="button" data-dept-detail-edit>编辑部门</button>
        </div>
      </div>
      <div class="dept-detail-stats">
        <div><strong>${direct}</strong><span>直属成员</span></div>
        <div><strong>${total}</strong><span>含下级成员</span></div>
        <div><strong>${children.length}</strong><span>下级部门</span></div>
        <div><strong>${esc(node.managerName || '未设置')}</strong><span>负责人 <button class="link-btn accent dept-manager-link" type="button" data-dept-detail-manager>${node.managerName ? '更换' : '去设置'}</button></span></div>
      </div>
      <div class="dept-detail-path mono">${esc(node.path)}</div>
      <div class="dept-detail-section">
        <div class="dept-detail-section-head">下级部门 <span class="muted">${children.length}</span></div>
        ${
          children.length
            ? `<div class="dept-child-list">${children
                .map(
                  (child) =>
                    `<button class="dept-child" type="button" data-dept-child="${esc(child.path)}">
                      <span class="dept-child-name">${esc(child.name)}</span>
                      <span class="dept-child-meta">${Number(child.subtreeMemberCount ?? child.memberCount ?? 0)} 人 · ${child.children?.length ?? 0} 个下级</span>
                    </button>`,
                )
                .join('')}</div>`
            : '<div class="muted dept-detail-empty">没有下级部门</div>'
        }
      </div>
      <div class="dept-detail-actions">
        <button class="btn sm ghost" type="button" data-dept-view-members>查看该部门成员</button>
      </div>
    </section>`
  host.querySelector('[data-dept-detail-edit]')?.addEventListener('click', () => openDeptEdit(node))
  host.querySelector('[data-dept-detail-manager]')?.addEventListener('click', () => openDeptEdit(node, { focusManager: true }))
  host.querySelector('[data-dept-detail-delete]')?.addEventListener('click', () => deleteDept(node))
  host.querySelector('[data-dept-view-members]')?.addEventListener('click', () => {
    state.deptFilter = node.path
    state.includeSubdepts = true
    navigate('org')
  })
  host.querySelectorAll('[data-dept-child]').forEach((button) => {
    button.addEventListener('click', () => {
      const child = all.find((item) => item.path === button.dataset.deptChild)
      if (!child) return
      state.deptFilter = child.path
      repaintTree()
      renderDeptDetail(child)
    })
  })
}

/** 部门树增删改后，按当前页面刷新右侧内容 */
function refreshOrgAfterTreeChange() {
  if (state.page === 'departments') {
    renderDeptDetail(orgSelectedDept())
    return
  }
  const list = $('#org-members')
  if (list) loadMembers(list)
}

async function loadMembers(container) {
  const host = container || $('#view')
  if (!state.deptFilter) {
    host.innerHTML = `<section class="panel"><div class="panel-head"><h2>成员</h2></div><div class="empty">这个公司还没有可显示的部门，请先在「部门管理」中创建部门</div></section>`
    return
  }
  renderLoading(host)
  try {
    const data = await api('/api/org/members')
    const companyRoot = `/${state.company}/`
    const members = data.members.filter((m) => {
      if (state.deptFilter === companyRoot) return true
      return state.includeSubdepts ? m.deptPath.startsWith(state.deptFilter) : m.deptPath === state.deptFilter
    })
    const rows = members
      .map(
        (m) => `<tr>
        <td class="name-cell"><strong>${esc(m.name)}</strong><div class="desc">${esc(m.title || '—')}</div>${
          m.externalUserId ? `<div class="desc mono">钉钉 UserID：${esc(m.externalUserId)}</div>` : ''
        }</td>
        <td>${esc(m.deptName)}<div class="desc mono">${esc(m.deptPath)}</div></td>
        <td>${(m.roles || []).map((r) => `<span class="chip accent">${esc(ROLE_LABEL[r.code] || r.code)}</span>`).join(' ')}</td>
        <td><span class="pill ${m.status === 'active' ? 'ok' : m.status === 'disabled' ? 'warn' : 'danger'}">${esc(
          STATUS_LABEL[m.status] || m.status,
        )}</span></td>
        <td><div class="row-actions member-actions">
          <button class="row-action primary" type="button" data-member-roles="${esc(m.id)}" title="配置角色与权限">配置权限</button>
          <button class="row-action" type="button" data-member-edit="${esc(m.id)}" title="编辑成员资料">编辑</button>
          <button class="row-action icon" type="button" data-member-more="${esc(m.id)}" title="更多操作" aria-haspopup="true">⋯</button>
        </div></td>
      </tr>`,
      )
      .join('')

    const roleCounts = new Map()
    members.forEach((m) => {
      ;(m.roles || []).forEach((r) => {
        roleCounts.set(r.code, (roleCounts.get(r.code) || 0) + 1)
      })
    })
    const roleChips = [...roleCounts.entries()]
      .map(([code, count]) => `<span class="chip accent">${esc(ROLE_LABEL[code] || code)} · ${count} 人</span>`)
      .join(' ')

    host.innerHTML = `
      <section class="panel">
        <div class="panel-head">
          <div><h2>${esc(deptLabel(state.deptFilter))} · 成员</h2><span class="hint">${members.length} 人</span></div>
          <div class="panel-actions">
            <label class="inline-field"><span>部门</span><select id="org-dept-filter">${deptSelectOptions(
              state.deptFilter,
            )}</select></label>
            <label class="switch"><input type="checkbox" id="org-subdepts"${
              state.includeSubdepts ? ' checked' : ''
            } /><span>含下级</span></label>
            <button class="btn sm ghost" type="button" id="member-export">导出名单</button>
            <button class="btn sm ghost" type="button" id="member-bulk">批量授权</button>
            <button class="btn sm primary" type="button" id="member-new">＋ 新建成员</button>
          </div>
        </div>
        <div class="table-scroll">
          <table class="data member-table">
            <thead><tr><th>姓名</th><th>部门</th><th>角色</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="5" class="empty">该部门下没有直属成员</td></tr>'}</tbody>
          </table>
        </div>
      </section>
      <section class="panel" id="dept-policy">
        <div class="panel-head"><div><h2>部门权限概览</h2><span class="hint">${esc(deptLabel(state.deptFilter))}</span></div></div>
        <div class="mini-list">
          <div class="mini-row"><span>本部门角色分布</span><div>${roleChips || '<span class="muted">没有成员</span>'}</div></div>
          <div class="mini-row"><span>命中的知识库范围</span><div id="dept-acl" class="muted">加载中…</div></div>
        </div>
      </section>`

    api('/api/kb/collections')
      .then((kb) => {
        const box = host.querySelector('#dept-acl')
        if (!box) return
        const hit = (kb.collections || []).filter((c) =>
          (c.acl?.deptPaths || []).some((p) => p.startsWith(state.deptFilter)),
        )
        box.innerHTML = hit.length
          ? hit
              .map(
                (c) =>
                  `<div style="padding:4px 0">${esc(c.name)} <span class="desc mono">${esc(c.acl.mode)} · ${esc(
                    (c.acl.deptPaths || []).join(', '),
                  )}</span> <span class="chip accent">对该部门生效</span></div>`,
              )
              .join('')
          : '<span class="muted">这个部门没有被任何知识库的部门 ACL 命中</span>'
      })
      .catch((err) => {
        const box = host.querySelector('#dept-acl')
        if (box) box.textContent = `读取知识库失败：${err.message}`
      })

    const deptSelect = host.querySelector('#org-dept-filter')
    if (deptSelect) {
      deptSelect.addEventListener('change', () => {
        const option = deptSelect.selectedOptions[0]
        state.deptFilter = option?.dataset.path || null
        loadMembers(host)
      })
    }
    const subToggle = host.querySelector('#org-subdepts')
    if (subToggle) {
      subToggle.addEventListener('change', () => {
        state.includeSubdepts = subToggle.checked
        loadMembers(host)
      })
    }
    host.querySelectorAll('[data-member-roles]').forEach((button) => {
      button.addEventListener('click', () => {
        const member = data.members.find((item) => item.id === button.dataset.memberRoles)
        if (member) openMemberRoles(member)
      })
    })
    host.querySelectorAll('[data-member-quota]').forEach((button) => {
      button.addEventListener('click', () => {
        const member = data.members.find((item) => item.id === button.dataset.memberQuota)
        if (member) openMemberQuota(member, host)
      })
    })
    host.querySelectorAll('[data-member-override]').forEach((button) => {
      button.addEventListener('click', () => {
        const member = data.members.find((item) => item.id === button.dataset.memberOverride)
        if (member) openOverrideModal(member)
      })
    })
    host.querySelectorAll('[data-member-edit]').forEach((button) => {
      button.addEventListener('click', () => {
        const member = data.members.find((item) => item.id === button.dataset.memberEdit)
        if (member) openMemberEdit(member)
      })
    })
    host.querySelectorAll('[data-member-password]').forEach((button) => {
      button.addEventListener('click', () => {
        const member = data.members.find((item) => item.id === button.dataset.memberPassword)
        if (member) openMemberPassword(member)
      })
    })
    host.querySelectorAll('[data-member-more]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        const member = data.members.find((item) => item.id === button.dataset.memberMore)
        if (!member) return
        const rect = button.getBoundingClientRect()
        showMemberMenu(member, host, rect.right, rect.bottom + 4)
      })
    })
    host.querySelectorAll('[data-member-toggle]').forEach((button) => {
      button.addEventListener('click', async () => {
        const member = data.members.find((item) => item.id === button.dataset.memberToggle)
        if (member) await toggleMemberStatus(member, host)
      })
    })
    host.querySelectorAll('[data-member-delete]').forEach((button) => {
      button.addEventListener('click', async () => {
        const member = data.members.find((item) => item.id === button.dataset.memberDelete)
        if (member) await deleteMember(member, host)
      })
    })
    const newMember = host.querySelector('#member-new')
    if (newMember) newMember.addEventListener('click', () => openMemberCreate(state.deptFilter))
    const bulk = host.querySelector('#member-bulk')
    if (bulk) bulk.addEventListener('click', () => openBulkGrant(members))
    const exportBtn = host.querySelector('#member-export')
    if (exportBtn) exportBtn.addEventListener('click', () => downloadConsoleFile('/api/console/members/export', '成员清单.csv'))
  } catch (err) {
    renderDenied(host, err)
  }
}

let memberMenu = null

function hideMemberMenu() {
  if (memberMenu) {
    memberMenu.remove()
    memberMenu = null
  }
}

function showMemberMenu(member, host, x, y) {
  hideMemberMenu()
  hideDeptMenu()
  hideKbMenu()
  if (!member) return
  const disabled = member.status === 'disabled'
  const el = document.createElement('div')
  el.className = 'ctx-menu member-menu'
  el.id = 'member-menu'
  el.innerHTML = `
    <div class="ctx-menu-head">${esc(member.name)} · 成员操作</div>
    <button type="button" data-member-act="quota">存储配额</button>
    <button type="button" data-member-act="override">临时授权</button>
    <button type="button" data-member-act="password">重置密码</button>
    <button type="button" data-member-act="toggle" class="${disabled ? 'accent' : ''}">${disabled ? '启用成员' : '停用成员'}</button>
    <button type="button" data-member-act="delete" class="danger">删除成员</button>`
  document.body.appendChild(el)
  const width = 188
  const height = 238
  el.style.left = `${Math.min(x, window.innerWidth - width - 8)}px`
  el.style.top = `${Math.min(y, window.innerHeight - height - 8)}px`
  memberMenu = el
  el.addEventListener('click', (event) => {
    const action = event.target.closest('[data-member-act]')?.dataset.memberAct
    if (!action) return
    hideMemberMenu()
    if (action === 'quota') openMemberQuota(member, host)
    if (action === 'override') openOverrideModal(member)
    if (action === 'password') openMemberPassword(member)
    if (action === 'toggle') toggleMemberStatus(member, host)
    if (action === 'delete') deleteMember(member, host)
  })
}

async function toggleMemberStatus(member, host) {
  const next = member.status === 'disabled' ? 'active' : 'disabled'
  if (next === 'disabled') {
    const ok = await confirmCard({
      title: '停用成员？',
      message: `停用「${member.name}」后，该成员的登录会话会立即失效。`,
      confirmText: '停用成员',
      tone: 'warning',
    })
    if (!ok) return
  }
  try {
    await apiSend('PATCH', `/api/console/members/${encodeURIComponent(member.id)}`, { status: next })
    loadMembers(host)
  } catch (err) {
    alert(err.message || '操作失败')
  }
}

async function deleteMember(member, host) {
  const ok = await confirmCard({
    title: '删除成员？',
    message: `删除「${member.name}」会做软删除（数据保留、可审计），登录会话立即失效。`,
    confirmText: '删除成员',
  })
  if (!ok) return
  try {
    await apiSend('DELETE', `/api/console/members/${encodeURIComponent(member.id)}`)
    loadMembers(host)
    loadTree()
  } catch (err) {
    alert(err.message || '删除失败')
  }
}

async function openMemberQuota(member, host) {  let data
  try {
    data = await api(`/api/console/workspace-quotas?userId=${encodeURIComponent(member.id)}`)
  } catch (err) {
    alert(err.message || '读取存储配额失败')
    return
  }
  const mb = 1024 * 1024
  const defaults = data.defaults || {}
  const policy = data.policy || null
  const effective = data.effective || {}
  const sourceLabel =
    effective.source === 'user' ? '单独配置' : effective.source === 'role' ? '角色配置' : '默认配置'
  const roleText = (effective.roleCodes || []).length ? `（${effective.roleCodes.join(' / ')}）` : ''
  const defaultLimitMb = Math.round((Number(defaults.limitBytes) || 0) / mb)
  const defaultFileMb = Math.round((Number(defaults.fileLimitBytes) || 0) / mb)
  const limitValue = policy ? String(Number(policy.limitBytes) / mb) : ''
  const fileValue = policy ? String(Number(policy.fileLimitBytes) / mb) : ''

  const overlay = modelModal(`
    <div class="modal-head"><h3>存储配额 · ${esc(member.name)}</h3><button class="modal-x" type="button">×</button></div>
    <div class="member-sum"><strong>${esc(member.deptName || '—')}</strong><span>${esc(member.title || '未设置职务')}</span></div>
    <div class="mini-list" style="margin-bottom:14px">
      <div class="mini-row"><span>当前生效</span><div><strong>${esc(formatStorageBytes(effective.limitBytes))}</strong> · 单文件 ${esc(
        formatStorageBytes(effective.fileLimitBytes),
      )}<span class="desc"> · ${esc(sourceLabel)}${esc(roleText)}</span></div></div>
    </div>
    <div class="modal-section-title">单独配置个人工作区 ${hintBadge('填写说明', '个人容量优先于角色配置；留空表示跟随角色 / 默认。保存后立即生效。容量和单文件上限要一起填；两项都留空等于恢复跟随角色 / 默认。')}</div>
    <div class="form-grid">
      <label><span>个人容量（MB）</span><input id="mq-limit" type="number" min="1" step="0.1" value="${esc(
        limitValue,
      )}" placeholder="默认 ${defaultLimitMb} MB" /></label>
      <label><span>单文件上限（MB）</span><input id="mq-file" type="number" min="1" step="0.1" value="${esc(
        fileValue,
      )}" placeholder="默认 ${defaultFileMb} MB" /></label>
    </div>
    <div class="modal-state" id="mq-state"></div>
    <div class="modal-actions">
      <button class="btn ghost" type="button" id="mq-reset">恢复默认</button>
      <button class="btn primary" type="button" id="mq-save">保存</button>
    </div>`)

  const close = () => overlay.remove()
  const stateEl = overlay.querySelector('#mq-state')
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#mq-reset').addEventListener('click', async () => {
    stateEl.className = 'modal-state muted'
    stateEl.textContent = '正在恢复…'
    try {
      await apiSend('DELETE', `/api/console/workspace-quotas/user/${encodeURIComponent(member.id)}`)
      close()
      loadMembers(host)
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '恢复失败'
    }
  })
  overlay.querySelector('#mq-save').addEventListener('click', async () => {
    const limitRaw = overlay.querySelector('#mq-limit').value.trim()
    const fileRaw = overlay.querySelector('#mq-file').value.trim()
    if (!limitRaw && !fileRaw) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '两项都为空时，请直接点「恢复默认」'
      return
    }
    if (!limitRaw || !fileRaw) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '容量和单文件上限要一起填'
      return
    }
    const limitMb = Number(limitRaw)
    const fileMb = Number(fileRaw)
    if (!Number.isFinite(limitMb) || !Number.isFinite(fileMb) || limitMb <= 0 || fileMb <= 0) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '请填写大于 0 的数字'
      return
    }
    if (fileMb > limitMb) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '单文件上限不能大于个人容量'
      return
    }
    stateEl.className = 'modal-state muted'
    stateEl.textContent = '正在保存…'
    try {
      await apiSend('PUT', '/api/console/workspace-quotas', {
        scopeType: 'user',
        scopeId: member.id,
        limitBytes: Math.round(limitMb * mb),
        fileLimitBytes: Math.round(fileMb * mb),
      })
      close()
      loadMembers(host)
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '保存失败'
    }
  })
}

function formatStorageBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (value >= 1024 * 1024) {
    const mb = value / 1024 / 1024
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
  }
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

async function openMemberRoles(member) {
  let roleData
  try {
    roleData = await api('/api/console/roles')
  } catch (err) {
    alert(err.message || '读取角色失败')
    return
  }
  const current = new Set((member.roles || []).map((role) => role.code))
  const overlay = modelModal(`
    <div class="modal-head"><h3>配置成员权限 · ${esc(member.name)}</h3><button class="modal-x" type="button">×</button></div>
    <div class="member-sum"><strong>${esc(member.deptName)}</strong><span>${esc(member.title || '未设置职务')}</span></div>
    <div class="modal-section-title">授予角色 ${hintBadge('角色说明', '一个成员可以同时拥有多个角色；保存后立即生效。')}</div>
    <div class="scope-groups">
      <div class="scope-group">
        ${roleData.roles
          .map(
            (role) => `<label class="scope-check"><input type="checkbox" data-assign="${esc(role.code)}"${
              current.has(role.code) ? ' checked' : ''
            } /> ${esc(ROLE_LABEL[role.code] || role.name)}
              <span class="muted">（${esc(DATA_SCOPE_LABEL[role.dataScope] || role.dataScope)}）</span></label>`,
          )
          .join('')}
      </div>
    </div>
    <div class="modal-state" id="a-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="a-save">保存</button>
      <button class="btn ghost" type="button" id="a-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#a-cancel').addEventListener('click', close)
  overlay.querySelector('#a-save').addEventListener('click', async () => {
    const stateEl = overlay.querySelector('#a-state')
    const roles = [...overlay.querySelectorAll('[data-assign]:checked')].map((el) => el.dataset.assign)
    if (roles.length === 0) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '至少保留一个角色'
      return
    }
    stateEl.textContent = '保存中…'
    try {
      await apiPost(`/api/console/members/${encodeURIComponent(member.id)}/roles`, { roles })
      close()
      loadMembers($('#org-members'))
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '保存失败'
    }
  })
}

function deptNodes(node, list = []) {
  if (!node) return list
  list.push(node)
  for (const child of node.children || []) deptNodes(child, list)
  return list
}

function currentCompanyRoot() {
  return rootNodes.find((node) => node.companyId === state.company) ?? rootNodes[0] ?? null
}

function isRootDept(node) {
  if (!node) return false
  if (Number(node.depth ?? 0) === 0) return true
  return /^\/[^/]+\/?$/.test(String(node.path || ''))
}

function deptSelectOptions(selectedPath, root = currentCompanyRoot()) {
  return deptNodes(root)
    .map(
      (node) =>
        `<option value="${esc(node.id)}" data-path="${esc(node.path)}"${node.path === selectedPath ? ' selected' : ''}>${'　'.repeat(Math.max(0, Number(node.depth || 0)))}${esc(node.name)}</option>`,
    )
    .join('')
}

async function roleCheckboxes(current = []) {
  const roleData = await api('/api/console/roles')
  const set = new Set(current)
  return roleData.roles
    .map(
      (role) =>
        `<label class="scope-check"><input type="checkbox" data-role-code="${esc(role.code)}"${set.has(role.code) ? ' checked' : ''} /> ${esc(ROLE_LABEL[role.code] || role.name)}</label>`,
    )
    .join('')
}

function openDeptCreate(parentPath) {
  const root = currentCompanyRoot()
  const parent = deptNodes(root).find((node) => node.path === parentPath) || root
  const overlay = modelModal(`
    <div class="modal-head"><h3>新建部门</h3><button class="modal-x" type="button">×</button></div>
    <div class="form-grid">
      <label class="field"><span>部门名称</span><input id="d-name" placeholder="例如 财务部" /></label>
      <label class="field"><span>上级部门</span><select id="d-parent">${deptSelectOptions(parent.path)}</select></label>
    </div>
    <div class="modal-state" id="d-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="d-save">创建</button>
      <button class="btn ghost" type="button" id="d-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#d-cancel').addEventListener('click', close)
  overlay.querySelector('#d-save').addEventListener('click', async () => {
    const name = overlay.querySelector('#d-name').value.trim()
    const parentId = overlay.querySelector('#d-parent').value
    const stateEl = overlay.querySelector('#d-state')
    if (!name) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '部门名称不能为空'
      return
    }
    stateEl.textContent = '创建中…'
    try {
      await apiPost('/api/console/departments', { name, parentId })
      close()
      state.deptFilter = parent.path
      await loadTree()
      refreshOrgAfterTreeChange()
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '创建失败'
    }
  })
}

/** 组织页的部门编辑 / 删除入口已收进树节点的右键菜单 */

function orgSelectedDept() {
  const root = currentCompanyRoot()
  return deptNodes(root).find((node) => node.path === state.deptFilter) ?? root
}

async function openDeptEdit(node, { focusManager = false } = {}) {
  if (!node) return
  let members = []
  try {
    const data = await api('/api/org/members')
    members = (data.members || []).filter((member) => String(member.deptPath || '').startsWith(node.path))
  } catch {
    members = []
  }
  const root = currentCompanyRoot()
  const isRoot = isRootDept(node)
  const segments = node.path.split('/').filter(Boolean)
  const parentPath = segments.length > 1 ? `/${segments.slice(0, -1).join('/')}/` : ''
  // 不能把部门挂到自己的下级：候选上级要排除自身及整棵子树
  const parentOptions = isRoot
    ? '<option value="">（根部门不能移动）</option>'
    : deptNodes(root)
        .filter((candidate) => !candidate.path.startsWith(node.path))
        .map(
          (candidate) =>
            `<option value="${esc(candidate.id)}"${candidate.path === parentPath ? ' selected' : ''}>${'　'.repeat(
              Math.max(0, Number(candidate.depth || 0)),
            )}${esc(candidate.name)}</option>`,
        )
        .join('')
  const managerCandidates = [
    { id: '', name: '不设负责人', title: '' },
    ...members.map((member) => ({ id: String(member.id), name: member.name, title: member.title || '' })),
  ]
  if (node.managerUserId && !managerCandidates.some((candidate) => candidate.id === String(node.managerUserId))) {
    managerCandidates.push({ id: String(node.managerUserId), name: node.managerName || '当前负责人', title: '' })
  }
  const selectedManager =
    managerCandidates.find((candidate) => candidate.id === String(node.managerUserId || '')) ?? managerCandidates[0]
  const overlay = modelModal(`
    <div class="modal-head"><h3>编辑部门</h3><button class="modal-x" type="button">×</button></div>
    <div class="form-grid">
      <label class="field"><span>部门名称</span><input id="de-name" value="${esc(node.name)}" /></label>
      <label class="field"><span>上级部门</span><select id="de-parent"${isRoot ? ' disabled' : ''}>${parentOptions}</select></label>
      <label class="field dept-manager-field"><span>部门负责人 ${hintBadge('负责人说明', '负责人从上一次同步（或手工建）的成员里选；移动部门会同时更新下级部门与成员路径。')}</span>
        <div class="search-select" data-manager-select>
          <input id="de-manager-search" class="search-select-input" type="text" role="combobox" aria-expanded="false" aria-controls="de-manager-list" aria-autocomplete="list" autocomplete="off" placeholder="搜索姓名或岗位" value="${esc(selectedManager.name)}" />
          <input type="hidden" id="de-manager" value="${esc(selectedManager.id)}" />
          <span class="search-select-caret" aria-hidden="true"></span>
          <div class="search-select-list" id="de-manager-list" role="listbox" hidden>
            ${managerCandidates
              .map(
                (candidate, index) =>
                  `<button type="button" class="search-select-option${candidate.id === selectedManager.id ? ' is-selected' : ''}" id="de-manager-opt-${index}" role="option" data-value="${esc(candidate.id)}" aria-selected="${candidate.id === selectedManager.id}"><span>${esc(candidate.name)}</span>${candidate.title ? `<small>${esc(candidate.title)}</small>` : ''}</button>`,
              )
              .join('')}
            <div class="search-select-empty" hidden>没有匹配的成员</div>
          </div>
        </div>
      </label>
    </div>
    <div class="modal-state" id="de-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="de-save">保存</button>
      <button class="btn ghost" type="button" id="de-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#de-cancel').addEventListener('click', close)

  const managerSelect = overlay.querySelector('[data-manager-select]')
  const managerSearch = overlay.querySelector('#de-manager-search')
  const managerList = overlay.querySelector('#de-manager-list')
  const managerValue = overlay.querySelector('#de-manager')
  const managerOptions = [...managerList.querySelectorAll('.search-select-option')]
  const managerEmpty = managerList.querySelector('.search-select-empty')
  let managerActive = -1
  const managerLabel = () =>
    managerOptions.find((option) => option.dataset.value === managerValue.value)?.querySelector('span')?.textContent ||
    '不设负责人'
  const paintManagerActive = () => {
    managerOptions.forEach((option, index) => option.classList.toggle('is-active', index === managerActive))
    if (managerActive >= 0) managerOptions[managerActive]?.scrollIntoView({ block: 'nearest' })
  }
  const filterManagerOptions = () => {
    const query = managerSearch.value.trim().toLowerCase()
    let visible = 0
    managerOptions.forEach((option) => {
      const matched = !query || option.textContent.toLowerCase().includes(query)
      option.hidden = !matched
      if (matched) visible += 1
    })
    managerEmpty.hidden = visible > 0
    managerActive =
      managerOptions.findIndex((option) => !option.hidden && option.classList.contains('is-selected'))
    if (managerActive < 0) managerActive = managerOptions.findIndex((option) => !option.hidden)
    paintManagerActive()
  }
  const openManager = (showAll = false) => {
    managerList.hidden = false
    managerSearch.setAttribute('aria-expanded', 'true')
    if (showAll) {
      managerOptions.forEach((option) => {
        option.hidden = false
      })
      managerEmpty.hidden = true
      managerActive = managerOptions.findIndex((option) => option.classList.contains('is-selected'))
      if (managerActive < 0) managerActive = 0
      paintManagerActive()
      return
    }
    filterManagerOptions()
  }
  const closeManager = (restore = true) => {
    managerList.hidden = true
    managerSearch.setAttribute('aria-expanded', 'false')
    if (restore) managerSearch.value = managerLabel()
    managerActive = -1
    paintManagerActive()
  }
  const chooseManager = (option) => {
    managerValue.value = option.dataset.value
    managerOptions.forEach((candidate) => {
      const selected = candidate === option
      candidate.classList.toggle('is-selected', selected)
      candidate.setAttribute('aria-selected', selected ? 'true' : 'false')
    })
    managerSearch.value = option.querySelector('span')?.textContent || ''
    closeManager(false)
    managerSearch.focus()
  }
  const moveManagerActive = (step) => {
    if (managerList.hidden) openManager(true)
    const visibleOptions = managerOptions.filter((option) => !option.hidden)
    if (!visibleOptions.length) return
    const currentVisible = visibleOptions.findIndex((option) => option === managerOptions[managerActive])
    const nextVisible = currentVisible < 0 ? 0 : (currentVisible + step + visibleOptions.length) % visibleOptions.length
    managerActive = managerOptions.indexOf(visibleOptions[nextVisible])
    paintManagerActive()
  }
  managerSearch.addEventListener('focus', () => {
    openManager(true)
    managerSearch.select()
  })
  managerSearch.addEventListener('click', () => {
    openManager(true)
    managerSearch.select()
  })
  managerSearch.addEventListener('input', () => openManager())
  managerList.addEventListener('pointerdown', (event) => event.preventDefault())
  managerOptions.forEach((option) => option.addEventListener('click', () => chooseManager(option)))
  managerSearch.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveManagerActive(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Enter' && !managerList.hidden) {
      event.preventDefault()
      const option = managerOptions[managerActive]
      if (option && !option.hidden) chooseManager(option)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeManager()
    }
  })
  managerSearch.addEventListener('blur', () => {
    setTimeout(() => {
      if (!managerSelect.contains(document.activeElement)) closeManager()
    }, 0)
  })
  overlay.addEventListener('pointerdown', (event) => {
    if (!managerSelect.contains(event.target)) closeManager()
  })
  if (focusManager) {
    managerSearch.focus()
    openManager(true)
  }
  overlay.querySelector('#de-save').addEventListener('click', async () => {
    const name = overlay.querySelector('#de-name').value.trim()
    const parentId = overlay.querySelector('#de-parent').value
    const managerSelect = overlay.querySelector('#de-manager')
    const managerUserId = managerSelect.value || null
    const stateEl = overlay.querySelector('#de-state')
    if (!name) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '部门名称不能为空'
      return
    }
    stateEl.className = 'modal-state'
    stateEl.textContent = '保存中…'
    try {
      await apiSend('PATCH', `/api/console/departments/${encodeURIComponent(node.id)}`, {
        name,
        ...(parentId ? { parentId } : {}),
        // 服务端把 undefined 当"清空负责人"，所以这里永远显式传值
        managerUserId,
      })
      close()
      await loadTree()
      enterDeptPathAfterMove(node, parentId)
      refreshOrgAfterTreeChange()
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '保存失败'
    }
  })
}

/** 部门改名/移动后，路径变了；把选中项切到新路径，避免右栏还停在旧路径 */
function enterDeptPathAfterMove(node, parentId) {
  const root = currentCompanyRoot()
  const nodes = deptNodes(root)
  const moved = nodes.find((item) => item.id === node.id)
  if (moved) {
    state.deptFilter = moved.path
    repaintTree()
    return
  }
  const parent = nodes.find((item) => item.id === parentId)
  if (parent) {
    state.deptFilter = parent.path
    repaintTree()
  }
}

async function deleteDept(node) {
  if (!node) return
  const ok = await confirmCard({
    title: '删除部门？',
    message: `「${node.name}」下有成员或子部门时服务端会拒绝，需要先移走。`,
    confirmText: '删除部门',
  })
  if (!ok) return
  try {
    await apiSend('DELETE', `/api/console/departments/${encodeURIComponent(node.id)}`)
    const segments = node.path.split('/').filter(Boolean)
    const parentPath = segments.length > 1 ? `/${segments.slice(0, -1).join('/')}/` : node.path
    state.deptFilter = parentPath
    await loadTree()
    repaintTree()
    refreshOrgAfterTreeChange()
  } catch (err) {
    alert(err.message || '删除失败')
  }
}

async function openMemberCreate(deptPath) {
  const rolesHtml = await roleCheckboxes(['member'])
  const overlay = modelModal(`
    <div class="modal-head"><h3>新建成员</h3><button class="modal-x" type="button">×</button></div>
    <div class="form-grid">
      <label class="field"><span>姓名</span><input id="m-name" placeholder="例如 张伟" /></label>
      <label class="field"><span>工号（登录账号）</span><input id="m-no" class="mono" placeholder="留空自动生成，例如 U_ZW" /></label>
      <label class="field"><span>部门</span><select id="m-dept">${deptSelectOptions(deptPath)}</select></label>
      <label class="field"><span>岗位</span><input id="m-title" placeholder="例如 后端工程师" /></label>
      <label class="field"><span>邮箱</span><input id="m-email" type="email" placeholder="选填" /></label>
      <label class="field"><span>手机号</span><input id="m-mobile" placeholder="选填" /></label>
      <label class="field"><span>初始密码</span><input id="m-password" type="password" placeholder="至少 8 位；留空则暂不能登录" /></label>
    </div>
    <div class="modal-section-title">角色 ${hintBadge('角色说明', '创建成员时可以同时勾选多个角色；也可以先不选，之后再配置。')}</div>
    <div class="scope-groups"><div class="scope-group">${rolesHtml}</div></div>
    <div class="modal-state" id="m-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="m-save">创建</button>
      <button class="btn ghost" type="button" id="m-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#m-cancel').addEventListener('click', close)
  overlay.querySelector('#m-save').addEventListener('click', async () => {
    const stateEl = overlay.querySelector('#m-state')
    const body = {
      name: overlay.querySelector('#m-name').value.trim(),
      employeeNo: overlay.querySelector('#m-no').value.trim(),
      deptId: overlay.querySelector('#m-dept').value,
      title: overlay.querySelector('#m-title').value.trim(),
      email: overlay.querySelector('#m-email').value.trim(),
      mobile: overlay.querySelector('#m-mobile').value.trim(),
      password: overlay.querySelector('#m-password').value,
      roles: [...overlay.querySelectorAll('[data-role-code]:checked')].map((el) => el.dataset.roleCode),
    }
    if (!body.name) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '姓名不能为空'
      return
    }
    stateEl.textContent = '创建中…'
    try {
      await apiPost('/api/console/members', body)
      close()
      loadMembers($('#org-members'))
      loadTree()
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '创建失败'
    }
  })
}

async function openOverrideModal(member) {
  let scopeData
  let current
  try {
    ;[scopeData, current] = await Promise.all([
      api('/api/console/scopes'),
      api(`/api/console/members/${encodeURIComponent(member.id)}/overrides`),
    ])
  } catch (err) {
    alert(err.message || '读取权限点失败')
    return
  }
  const existing = (current.overrides || [])
    .map(
      (item) => `<div class="mini-row"><span><span class="chip ${item.effect === 'allow' ? 'accent' : ''}">${
        item.effect === 'allow' ? '允许' : '拒绝'
      }</span> ${esc(scopeData.labels[item.scope] || item.scope)}
        <span class="desc mono">${esc(item.scope)}</span></span>
        <span>${item.expiresAt ? esc(fmtTime(new Date(item.expiresAt).getTime())) : '长期'}${
          item.expired ? ' · 已过期' : ''
        } <button class="link-btn danger-link" type="button" data-revoke-override="${esc(item.id)}">撤销</button></span></div>`,
    )
    .join('')
  const overlay = modelModal(`
    <div class="modal-head"><h3>临时授权 / 例外 · ${esc(member.name)}</h3><button class="modal-x" type="button">×</button></div>
    ${hintNote('授权规则', '拒绝优先于角色授权；允许可以补上角色没有的单个权限点。到期自动失效，变更写审计。')}
    <div class="modal-section-title">已有例外 <span>${(current.overrides || []).length} 条</span></div>
    <div class="mini-list">${existing || '<span class="hint">还没有临时授权</span>'}</div>
    <div class="modal-section-title">新增一条</div>
    <div class="field-stack">
      <label class="field"><span>权限点</span><select id="ov-scope">${scopeData.scopes
        .map((scope) => `<option value="${esc(scope)}">${esc(scopeData.labels[scope] || scope)} · ${esc(scope)}</option>`)
        .join('')}</select></label>
      <div class="form-cols">
        <label class="field"><span>效果</span><select id="ov-effect"><option value="allow">允许</option><option value="deny">拒绝</option></select></label>
        <label class="field"><span>有效期（小时）</span><input id="ov-hours" type="number" min="1" max="8760" placeholder="留空=长期" /></label>
      </div>
      <label class="field"><span>原因</span><input id="ov-reason" placeholder="例如 项目临时需要审计导出" /></label>
    </div>
    <div class="modal-state" id="ov-state"></div>
    <div class="modal-actions"><button class="btn primary" type="button" id="ov-save">添加</button><button class="btn ghost" type="button" id="ov-cancel">关闭</button></div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#ov-cancel').addEventListener('click', close)
  overlay.querySelectorAll('[data-revoke-override]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        await api(`/api/console/members/${encodeURIComponent(member.id)}/overrides/${encodeURIComponent(button.dataset.revokeOverride)}`, { method: 'DELETE' })
        close()
        openOverrideModal(member)
      } catch (err) {
        button.disabled = false
        alert(err.message || '撤销失败')
      }
    })
  })
  overlay.querySelector('#ov-save').addEventListener('click', async () => {
    const stateEl = overlay.querySelector('#ov-state')
    const hoursValue = overlay.querySelector('#ov-hours').value.trim()
    stateEl.textContent = '保存中…'
    try {
      await apiPost(`/api/console/members/${encodeURIComponent(member.id)}/overrides`, {
        scope: overlay.querySelector('#ov-scope').value,
        effect: overlay.querySelector('#ov-effect').value,
        reason: overlay.querySelector('#ov-reason').value.trim() || undefined,
        expiresInHours: hoursValue ? Number(hoursValue) : undefined,
      })
      close()
      openOverrideModal(member)
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '保存失败'
    }
  })
}

function openMemberEdit(member) {
  const overlay = modelModal(`
    <div class="modal-head"><h3>编辑成员 · ${esc(member.name)}</h3><button class="modal-x" type="button">×</button></div>
    <div class="form-grid">
      <label class="field"><span>姓名</span><input id="e-name" value="${esc(member.name)}" /></label>
      <label class="field"><span>工号</span><input class="mono" value="${esc(member.employeeNo || '—')}" disabled /></label>
      <label class="field"><span>钉钉 UserID</span><input class="mono" value="${esc(member.externalUserId || '—')}" disabled /></label>
      <label class="field"><span>部门</span><select id="e-dept">${deptSelectOptions(member.deptPath)}</select></label>
      <label class="field"><span>岗位</span><input id="e-title" value="${esc(member.title || '')}" /></label>
      <label class="field"><span>邮箱</span><input id="e-email" type="email" value="${esc(member.email || '')}" /></label>
      <label class="field"><span>手机号</span><input id="e-mobile" value="${esc(member.mobile || '')}" /></label>
    </div>
    <div class="modal-state" id="e-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="e-save">保存</button>
      <button class="btn ghost" type="button" id="e-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#e-cancel').addEventListener('click', close)
  overlay.querySelector('#e-save').addEventListener('click', async () => {
    const stateEl = overlay.querySelector('#e-state')
    try {
      await apiSend('PATCH', `/api/console/members/${encodeURIComponent(member.id)}`, {
        name: overlay.querySelector('#e-name').value.trim(),
        deptId: overlay.querySelector('#e-dept').value,
        title: overlay.querySelector('#e-title').value.trim(),
        email: overlay.querySelector('#e-email').value.trim(),
        mobile: overlay.querySelector('#e-mobile').value.trim(),
      })
      close()
      loadMembers($('#org-members'))
      loadTree()
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '保存失败'
    }
  })
}

function openMemberPassword(member) {
  const overlay = modelModal(`
    <div class="modal-head"><h3>重置密码 · ${esc(member.name)}</h3><button class="modal-x" type="button">×</button></div>
    <label class="field"><span>新密码</span><input id="p-password" type="password" placeholder="至少 8 位" /></label>
    <div class="banner warn" style="margin-top:10px"><strong>重置后该成员所有登录会话立即失效，需要重新登录。</strong></div>
    <div class="modal-state" id="p-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="p-save">重置</button>
      <button class="btn ghost" type="button" id="p-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#p-cancel').addEventListener('click', close)
  overlay.querySelector('#p-save').addEventListener('click', async () => {
    const password = overlay.querySelector('#p-password').value
    const stateEl = overlay.querySelector('#p-state')
    if (password.length < 8) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '密码至少 8 位'
      return
    }
    try {
      await apiPost(`/api/console/members/${encodeURIComponent(member.id)}/password`, { password })
      close()
      alert('已重置，该成员需要重新登录。')
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '重置失败'
    }
  })
}

async function openBulkGrant(members) {
  const rolesHtml = await roleCheckboxes([])
  const overlay = modelModal(`
    <div class="modal-head"><h3>批量授权</h3><button class="modal-x" type="button">×</button></div>
    ${hintNote('批量说明', '给当前列表里的人一次性追加角色，不覆盖已有角色。')}
    <div class="modal-section-title">成员 <span>${members.length} 人</span></div>
    <label class="scope-check"><input type="checkbox" id="bg-all" /> 全选</label>
    <div class="scope-groups"><div class="scope-group" style="max-height:220px;overflow:auto">
      ${members
        .map(
          (m) =>
            `<label class="scope-check"><input type="checkbox" data-bg-user="${esc(m.id)}" /> ${esc(m.name)} <span class="muted">${esc(m.deptName)}</span></label>`,
        )
        .join('')}
    </div></div>
    <div class="modal-section-title">追加角色</div>
    <div class="scope-groups"><div class="scope-group">${rolesHtml}</div></div>
    <div class="modal-state" id="bg-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="bg-save">授权</button>
      <button class="btn ghost" type="button" id="bg-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#bg-cancel').addEventListener('click', close)
  overlay.querySelector('#bg-all').addEventListener('change', (event) => {
    for (const box of overlay.querySelectorAll('[data-bg-user]')) box.checked = event.target.checked
  })
  overlay.querySelector('#bg-save').addEventListener('click', async () => {
    const userIds = [...overlay.querySelectorAll('[data-bg-user]:checked')].map((el) => el.dataset.bgUser)
    const roles = [...overlay.querySelectorAll('[data-role-code]:checked')].map((el) => el.dataset.roleCode)
    const stateEl = overlay.querySelector('#bg-state')
    if (userIds.length === 0 || roles.length === 0) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '至少要选一个成员和一个角色'
      return
    }
    try {
      const result = await apiSend('POST', '/api/console/members/bulk-roles', { userIds, roles })
      close()
      alert(`已为 ${result.users} 名成员追加 ${roles.join('、')}`)
      loadMembers($('#org-members'))
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '授权失败'
    }
  })
}

function deptLabel(path) {
  const cache = state.deptNames || {}
  return cache[path] || path
}

/** 同步历史的时间：当天只显示时分秒，跨天带日期，避免一串 00:06:50 分不清哪天 */
function fmtTime(ts) {
  if (!ts) return '—'
  const date = new Date(ts)
  const today = new Date()
  const sameDay =
    date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  return sameDay ? date.toLocaleTimeString() : date.toLocaleString()
}

/* ---------------- 概览 ---------------- */

async function loadOverview() {
  const view = $('#view')
  const me = state.me
  const [health, org, kb, roles, providers, models, channels, plugins] = await Promise.all([
    api('/api/health').catch(() => null),
    api('/api/org/tree').catch(() => null),
    api('/api/kb/collections').catch(() => null),
    api('/api/console/roles').catch(() => null),
    api('/api/console/providers').catch(() => null),
    api('/api/console/models').catch(() => null),
    api('/api/console/channels').catch(() => null),
    api('/api/console/plugins').catch(() => null),
  ])

  const deptCount = org?.total ?? 0
  const memberCount = Number(org?.root?.subtreeMemberCount ?? org?.root?.memberCount ?? 0)
  const kbCount = kb?.collections?.length ?? 0
  const providerCount = providers?.providers?.length ?? 0
  const modelCount = models?.models?.length ?? 0
  const channelList = channels?.channels ?? []
  const configuredChannels = channelList.filter((item) => item.appId || item.webhookUrl).length
  const pluginCount = plugins?.stats?.installed ?? 0
  const roleCount = roles?.roles?.length ?? 0

  const tasks = [
    { key: 'org', title: '组织架构', meta: `${deptCount} 个部门 · ${memberCount} 名成员`, done: deptCount > 0, action: '管理组织' },
    { key: 'roles', title: '成员与角色权限', meta: `${roleCount} 个角色 · 在组织页给成员授权`, done: roleCount > 0, action: '检查权限' },
    { key: 'kb', title: '知识库', meta: `${kbCount} 个知识库 · 配置可见范围与文档`, done: kbCount > 0, action: '管理知识库' },
    { key: 'models', title: '模型接入', meta: `${providerCount} 个供应商 · ${modelCount} 个模型`, done: modelCount > 0, action: '接入模型' },
    { key: 'channels', title: '渠道接入', meta: `${configuredChannels} / 3 已配置`, done: configuredChannels === 3, action: '配置渠道' },
    { key: 'extra', title: '插件', meta: `${pluginCount} 个已安装`, done: pluginCount > 0, action: '插件管理' },
  ]

  const orderedTasks = [...tasks].sort((a, b) => Number(a.done) - Number(b.done))
  const quickLinks = [
    { key: 'org', title: '组织与成员', meta: `${memberCount} 名成员` },
    { key: 'models', title: '模型接入', meta: `${modelCount} 个模型` },
    { key: 'kb', title: '知识库与 RAG', meta: `${kbCount} 个库` },
    { key: 'channels', title: '渠道绑定', meta: `${configuredChannels} / 3 已配置` },
  ]

  view.innerHTML = `
    <div class="stats overview-stats">
      <div class="stat"><div class="stat-label">服务状态</div><div class="stat-value">${health ? '运行中' : '异常'}<span class="stat-unit">${health ? `v${esc(health.version)}` : ''}</span></div></div>
      <div class="stat"><div class="stat-label">组织规模</div><div class="stat-value">${memberCount}<span class="stat-unit">成员 · ${deptCount} 部门</span></div></div>
      <div class="stat"><div class="stat-label">知识与模型</div><div class="stat-value">${kbCount}<span class="stat-unit">库 · ${modelCount} 模型</span></div></div>
      <div class="stat"><div class="stat-label">接入完成度</div><div class="stat-value">${configuredChannels}<span class="stat-unit">/ 3 渠道 · ${pluginCount} 插件</span></div></div>
    </div>

    <div class="overview-grid">
      <section class="panel overview-tasks">
        <div class="panel-head">
          <div><h2>配置进度</h2>${hintBadge('进度说明', '先处理未完成的项，已完成的会保持安静。')}</div>
          <span class="pill ${tasks.filter((task) => task.done).length === tasks.length ? 'ok' : 'warn'}">${
            tasks.filter((task) => task.done).length
          } / ${tasks.length} 已完成</span>
        </div>
        <div class="setup-list">
          ${orderedTasks
            .map(
              (task) => `<div class="setup-row${task.done ? ' is-done' : ''}">
                <span class="setup-state ${task.done ? 'done' : ''}">${task.done ? '已配置' : '待配置'}</span>
                <div class="setup-main"><strong>${esc(task.title)}</strong><span>${esc(task.meta)}</span></div>
                <button class="btn sm${task.done ? '' : ' primary'}" type="button" data-go="${task.key}">${esc(task.action)}</button>
              </div>`,
            )
            .join('')}
        </div>
      </section>

      <aside class="overview-side">
        <section class="panel">
          <div class="panel-head">
            <div><h2>快捷入口</h2>${hintBadge('入口说明', '直接进入最常改的四块配置：组织与成员、模型、知识库、渠道。')}</div>
          </div>
          <div class="quick-grid">
            ${quickLinks
              .map(
                (item) => `<button class="quick-link" type="button" data-go="${item.key}">
                  <span>${esc(item.title)}</span>
                  <small>${esc(item.meta)}</small>
                  <i aria-hidden="true">→</i>
                </button>`,
              )
              .join('')}
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><div><h2>运行信息</h2>${hintBadge('范围说明', '展示当前服务版本与这个控制台的管理范围；数据范围固定为全公司。')}</div></div>
          <div class="kv-grid">
            <div><span>公司</span><strong>${esc(me?.company?.name ?? '—')}</strong></div>
            <div><span>公司 ID</span><strong class="mono">${esc(me?.company?.id ?? '—')}</strong></div>
            <div><span>控制台账号</span><strong>服务器超级管理员</strong></div>
            <div><span>数据范围</span><strong>全公司</strong></div>
            <div><span>健康检查</span><strong>${health ? `正常 · v${esc(health.version)}` : '不可用'}</strong></div>
            <div><span>已知能力项</span><strong>${me ? me.capabilities.length : 0} 项</strong></div>
          </div>
        </section>
      </aside>
    </div>`

  setSide('', true)
  setPageActions('')
  for (const button of document.querySelectorAll('[data-go]')) {
    button.addEventListener('click', () => navigate(button.dataset.go))
  }
}

/* ---------------- 权限矩阵（核对配置，不是员工查看） ---------------- */

/* ---------------- 角色与权限 ---------------- */

function companyMeta(id = state.company) {
  return state.companies.find((company) => company.id === id) ?? null
}

function switchCompany(companyId) {
  state.company = companyId
  state.selectedRole = null
  state.deptFilter = null
  const url = new URL(location.href)
  url.searchParams.set('company', companyId)
  history.replaceState(null, '', url.toString())
  renderCompanyPicker()
}

function roleRailSubmenuHtml(roles) {
  if (!Array.isArray(roles)) {
    return `<div class="org-rail-sub"><div class="org-rail-sub-empty">角色加载中…</div></div>`
  }
  if (!roles.length) {
    return `<div class="org-rail-sub"><div class="org-rail-sub-empty">暂无角色</div></div>`
  }
  return `<div class="org-rail-sub">
    ${roles
      .map(
        (role) => `<button class="org-role-item${state.selectedRole === role.code ? ' is-active' : ''}" type="button" data-role="${esc(
          role.code,
        )}">
          <span class="org-role-name">${esc(ROLE_LABEL[role.code] || role.name)}</span>
          <span class="org-role-meta">${role.members} 人</span>
        </button>`,
      )
      .join('')}
  </div>`
}

function openRoleCreateModal() {
  const overlay = modelModal(`
    <div class="modal-head"><h3>新建自定义角色</h3><button class="modal-x" type="button">×</button></div>
    <div class="field-stack">
      <label class="field"><span>角色名称</span><input id="nr-name" placeholder="例如 财务审核员" /></label>
      <label class="field"><span>角色标识</span><input id="nr-code" class="mono" placeholder="finance_reviewer（小写字母、数字、下划线）" /></label>
      <label class="field"><span>数据范围</span><select id="nr-scope">
        <option value="self">仅本人</option>
        <option value="dept" selected>本部门及下级</option>
        <option value="company">全公司</option>
      </select></label>
      ${hintNote('创建说明', '创建后立即进入权限编辑，勾选这个角色能做什么；成员授权在组织架构页完成。')}
    </div>
    <div class="modal-state" id="nr-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="nr-save">创建角色</button>
      <button class="btn ghost" type="button" id="nr-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#nr-cancel').addEventListener('click', close)
  overlay.querySelector('#nr-save').addEventListener('click', async () => {
    const name = overlay.querySelector('#nr-name').value.trim()
    const code = overlay.querySelector('#nr-code').value.trim().toLowerCase()
    const dataScope = overlay.querySelector('#nr-scope').value
    const msg = overlay.querySelector('#nr-state')
    if (!name || !code) {
      msg.textContent = '角色名称和标识都要填'
      msg.className = 'modal-state bad'
      return
    }
    try {
      const result = await apiPost('/api/console/roles', { code, name, dataScope, scopes: [] })
      close()
      state.selectedRole = result.code
      loadRoles()
    } catch (err) {
      msg.textContent = err.message || '创建失败'
      msg.className = 'modal-state bad'
    }
  })
}

async function deleteRoleCascade(role, messageHost) {
  if (!role) return
  const ok = await confirmCard({
    title: '删除角色？',
    message: `删除「${role.name}」后，该角色下所有成员的绑定会自动解除，操作不可撤销。`,
    detail: '删除后无法恢复，请确认该角色已不再需要。',
    confirmText: '删除角色',
  })
  if (!ok) return
  if (messageHost) messageHost.textContent = '删除中…'
  try {
    const result = await apiSend('DELETE', `/api/console/roles/${encodeURIComponent(role.code)}`)
    state.selectedRole = null
    await loadRoles()
    if (result?.unboundMembers) {
      // 让操作者知道这次删除实际解除了多少条授权
      setTimeout(() => {
        const host = $('#role-member-msg') || $('#role-msg')
        if (host) host.textContent = `已删除角色，解除 ${result.unboundMembers} 个成员绑定`
      }, 0)
    }
  } catch (err) {
    if (messageHost) messageHost.textContent = err.message || '删除失败'
    else window.alert(err.message || '删除失败')
  }
}

function setRoleMemberMessage(text) {
  const host = $('#role-member-msg')
  if (host) host.textContent = text
}

async function removeRoleMember(role, member, currentIds, messageHost) {
  const ok = await confirmCard({
    title: '移除成员？',
    message: `将「${member.name}」从角色「${role.name}」中移除。`,
    detail: '该成员的其他角色不受影响；移除后仍可在角色成员页重新添加。',
    confirmText: '移除成员',
    tone: 'warning',
  })
  if (!ok) return
  if (messageHost) messageHost.textContent = '移除中…'
  const userIds = [...currentIds].filter((id) => id !== member.id)
  try {
    const result = await apiPost(`/api/console/roles/${encodeURIComponent(role.code)}/members`, { userIds })
    await loadRoles()
    setRoleMemberMessage(result.removed ? '已移除 1 人' : '没有变更')
  } catch (err) {
    if (messageHost) messageHost.textContent = err.message || '移除失败'
    else window.alert(err.message || '移除失败')
  }
}

function memberPickerUnboundCount(node, membersByPath, boundIds) {
  const direct = (membersByPath.get(node.path) || []).filter((member) => !boundIds.has(member.id)).length
  return (node.children || []).reduce(
    (total, child) => total + memberPickerUnboundCount(child, membersByPath, boundIds),
    direct,
  )
}

function renderMemberPickerDept(node, membersByPath, boundIds) {
  const members = membersByPath.get(node.path) || []
  const children = node.children || []
  if (!members.length && !children.length) return ''
  const unboundCount = memberPickerUnboundCount(node, membersByPath, boundIds)
  const rows = members
    .map((member) => {
      const bound = boundIds.has(member.id)
      return `<label class="member-picker-member${bound ? ' is-bound' : ''}">
        <input type="checkbox" data-picker-member="${esc(member.id)}"${bound ? ' checked disabled' : ''} />
        <span class="member-picker-avatar">${esc(String(member.name || '?').slice(0, 1))}</span>
        <span class="member-picker-main">
          <strong>${esc(member.name)}</strong>
          <small>${esc(member.title || '成员')}</small>
        </span>
        ${bound ? '<span class="member-picker-tag">已在角色</span>' : ''}
      </label>`
    })
    .join('')
  return `<div class="member-picker-dept" data-picker-dept="${esc(node.path)}">
    <div class="member-picker-dept-head">
      <label>
        <input type="checkbox" data-picker-dept-check="${esc(node.path)}"${unboundCount ? '' : ' disabled'} />
        <span class="member-picker-dept-name">${esc(node.name)}</span>
      </label>
      <span class="member-picker-dept-meta">${
        unboundCount ? `可添加 ${unboundCount} 人` : '已全部绑定'
      }</span>
    </div>
    ${rows ? `<div class="member-picker-members">${rows}</div>` : ''}
    ${children.map((child) => renderMemberPickerDept(child, membersByPath, boundIds)).join('')}
  </div>`
}

async function openRoleMemberPicker(role, allMembers, boundIds) {
  let treeRoot
  try {
    treeRoot = (await api('/api/org/tree')).root
  } catch (err) {
    window.alert(err.message || '部门组织架构加载失败')
    return
  }
  const membersByPath = new Map()
  for (const member of allMembers) {
    const path = member.deptPath || '/c1/'
    if (!membersByPath.has(path)) membersByPath.set(path, [])
    membersByPath.get(path).push(member)
  }
  const overlay = modelModal(`
    <div class="modal-head">
      <div>
        <h3>添加成员 · ${esc(role.name)}</h3>
        ${hintBadge('多选说明', '按部门组织架构多选；部门行可全选该部门及下级成员。')}
      </div>
      <button class="modal-x" type="button">×</button>
    </div>
    <div class="member-picker-body" id="member-picker-body">
      ${renderMemberPickerDept(treeRoot, membersByPath, boundIds) || '<div class="empty">当前公司还没有成员</div>'}
    </div>
    <div class="modal-state" id="member-picker-state"></div>
    <div class="modal-actions member-picker-actions">
      <span class="member-picker-count" id="member-picker-count">已选 0 人</span>
      <button class="btn ghost" type="button" id="member-picker-cancel">取消</button>
      <button class="btn primary" type="button" id="member-picker-add" disabled>添加成员</button>
    </div>
  `)
  overlay.querySelector('.modal').classList.add('member-picker-modal')
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x')?.addEventListener('click', close)
  overlay.querySelector('#member-picker-cancel')?.addEventListener('click', close)

  const addButton = overlay.querySelector('#member-picker-add')
  const countLabel = overlay.querySelector('#member-picker-count')
  const stateLabel = overlay.querySelector('#member-picker-state')
  const deptChecks = [...overlay.querySelectorAll('[data-picker-dept-check]')]
  const memberChecks = [...overlay.querySelectorAll('[data-picker-member]:not(:disabled)')]

  const selectedIds = () => memberChecks.filter((input) => input.checked).map((input) => input.dataset.pickerMember)
  const syncDeptChecks = () => {
    for (const check of deptChecks) {
      const group = check.closest('.member-picker-dept')
      const members = [...group.querySelectorAll('[data-picker-member]:not(:disabled)')]
      if (!members.length) {
        check.checked = false
        check.indeterminate = false
        continue
      }
      const selected = members.filter((input) => input.checked).length
      check.checked = selected === members.length
      check.indeterminate = selected > 0 && selected < members.length
    }
  }
  const updateFooter = () => {
    const count = selectedIds().length
    if (countLabel) countLabel.textContent = `已选 ${count} 人`
    if (addButton) {
      addButton.disabled = count === 0
      addButton.textContent = count ? `添加 ${count} 人` : '添加成员'
    }
  }
  for (const check of deptChecks) {
    check.addEventListener('change', () => {
      const group = check.closest('.member-picker-dept')
      group.querySelectorAll('[data-picker-member]:not(:disabled)').forEach((input) => {
        input.checked = check.checked
      })
      syncDeptChecks()
      updateFooter()
    })
  }
  for (const input of memberChecks) {
    input.addEventListener('change', () => {
      syncDeptChecks()
      updateFooter()
    })
  }
  syncDeptChecks()
  updateFooter()

  addButton?.addEventListener('click', async () => {
    const ids = selectedIds()
    if (!ids.length) return
    addButton.disabled = true
    addButton.textContent = '添加中…'
    if (stateLabel) stateLabel.textContent = ''
    try {
      const userIds = [...new Set([...boundIds, ...ids])]
      const result = await apiPost(`/api/console/roles/${encodeURIComponent(role.code)}/members`, { userIds })
      close()
      await loadRoles()
      setRoleMemberMessage(`已添加 ${result.added} 人`)
    } catch (err) {
      if (stateLabel) stateLabel.textContent = err.message || '添加失败'
      addButton.disabled = false
      addButton.textContent = `添加 ${ids.length} 人`
    }
  })
}

function renderRoleEditor(role, allScopes = [], meta = {}) {
  const view = $('#view')
  const labels = meta.labels || {}
  const scopeGroups = meta.groups || {}
  const allMembers = Array.isArray(meta.members) ? meta.members : []
  const roleMemberIds = new Set(
    allMembers.filter((member) => (member.roles || []).some((item) => item.code === role.code)).map((member) => member.id),
  )
  const boundMembers = allMembers.filter((member) => roleMemberIds.has(member.id))
  const groups = {}
  const selected = new Set(role.scopes)
  const activeRoleTab = state.roleTab === 'members' ? 'members' : 'permissions'
  for (const scope of allScopes.length ? allScopes : role.scopes) {
    const prefix = scopeGroups[scope] || scope.split(':')[0] || 'other'
    groups[prefix] = groups[prefix] || []
    groups[prefix].push(scope)
  }

  view.innerHTML = `
    <div class="role-detail-tabs" role="tablist" aria-label="角色详情">
      <button class="role-detail-back" type="button" id="role-back">← 角色管理</button>
      <button class="role-detail-tab${activeRoleTab === 'permissions' ? ' is-active' : ''}" type="button" role="tab" aria-selected="${
        activeRoleTab === 'permissions'
      }" data-role-tab="permissions">角色权限</button>
      <button class="role-detail-tab${activeRoleTab === 'members' ? ' is-active' : ''}" type="button" role="tab" aria-selected="${
        activeRoleTab === 'members'
      }" data-role-tab="members">角色成员 <span class="role-tab-count">${boundMembers.length}</span></button>
    </div>
    <section class="panel" data-role-pane="permissions"${activeRoleTab === 'permissions' ? '' : ' hidden'}>
      <div class="panel-head">
        <h2>${esc(companyMeta()?.name || '')} · ${esc(ROLE_LABEL[role.code] || role.name)} <span class="mono muted">${esc(role.code)}</span></h2>
        ${hintBadge('角色说明', role.builtin ? '内置角色：改权限点会立即影响该角色下所有人。' : '自定义角色：只影响被授予该角色的成员。')}
      </div>
      <div class="form-grid">
        <label>角色名<input id="role-name" value="${esc(role.name)}" /></label>
        <label>数据范围
          <select id="role-scope">
            ${['self', 'dept', 'company', 'global']
              .map(
                (scope) =>
                  `<option value="${scope}"${scope === role.dataScope ? ' selected' : ''}>${esc(
                    DATA_SCOPE_LABEL[scope] || scope,
                  )}</option>`,
              )
              .join('')}
          </select>
        </label>
        <label><span class="field-label">个人工作区容量（MB）${hintBadge('?', '存储配额作用于该角色的所有成员；成员单独配置优先。容量和单文件上限要一起填，两项都留空表示跟随默认。', '存储配额说明', 'icon-only')}</span><input id="role-quota-limit" type="number" min="1" step="0.1" value="${esc(
          role.quota ? String(Number(role.quota.limitBytes) / (1024 * 1024)) : '',
        )}" placeholder="默认 ${esc(
          String(Math.round(Number(meta.quotaDefaults?.limitBytes) / (1024 * 1024))),
        )} MB" /></label>
        <label><span class="field-label">单文件上限（MB）${hintBadge('?', '存储配额作用于该角色的所有成员；成员单独配置优先。容量和单文件上限要一起填，两项都留空表示跟随默认。', '存储配额说明', 'icon-only')}</span><input id="role-quota-file" type="number" min="1" step="0.1" value="${esc(
          role.quota ? String(Number(role.quota.fileLimitBytes) / (1024 * 1024)) : '',
        )}" placeholder="默认 ${esc(
          String(Math.round(Number(meta.quotaDefaults?.fileLimitBytes) / (1024 * 1024))),
        )} MB" /></label>
      </div>
      <div class="scope-groups" id="scope-groups">
        ${Object.entries(groups)
          .map(
            ([prefix, list]) => `<div class="scope-group">
              <div class="scope-group-head mono">${esc(SCOPE_GROUP_LABEL[prefix] || prefix)}</div>
              ${list
                .map(
                  (scope) => `<label class="scope-check" title="${esc(scope)}"><input type="checkbox" data-scope="${esc(scope)}"${
                    selected.has(scope) ? ' checked' : ''
                  } /> ${esc(labels[scope] || scope)}</label>`,
                )
                .join('')}
            </div>`,
          )
          .join('')}
      </div>
      <div class="panel-actions">
        <button class="btn primary" type="button" id="save-role">保存角色</button>
        ${
          role.builtin
            ? '<button class="btn ghost danger-text" type="button" id="delete-role" disabled title="内置角色不可删除">删除角色</button>'
            : '<button class="btn ghost danger-text" type="button" id="delete-role">删除角色</button>'
        }
        <span class="muted" id="role-msg"></span>
      </div>
    </section>
    <section class="panel role-member-panel" data-role-pane="members"${activeRoleTab === 'members' ? '' : ' hidden'}>
      <div class="panel-head">
        <div>
          <h2>角色成员</h2>
          ${hintBadge('成员说明', '这里只显示已绑定成员；点「添加成员」从部门组织架构中多选。角色成员与成员角色共用同一份授权数据：这里添加/移除后，成员管理页立即同步；在成员管理页改角色，这里也会同步。')}
        </div>
        <div class="panel-actions">
          <button class="btn sm primary" type="button" id="role-member-add">＋ 添加成员</button>
          <span class="muted" id="role-member-msg"></span>
        </div>
      </div>
      <div class="role-member-toolbar">
        <span class="role-member-count">已绑定 <strong id="role-member-count">${boundMembers.length}</strong> 人</span>
      </div>
      <div class="role-member-list" id="role-member-list">
        ${
          boundMembers
            .map((member) => {
              const otherRoles = (member.roles || [])
                .filter((item) => item.code !== role.code)
                .map((item) => ROLE_LABEL[item.code] || item.name || item.code)
              return `<div class="role-member-row is-bound" data-role-bound="${esc(member.id)}">
                <span class="role-member-avatar">${esc(String(member.name || '?').slice(0, 1))}</span>
                <span class="role-member-main">
                  <strong>${esc(member.name)}</strong>
                  <small>${esc(member.title || '成员')} · ${esc(member.deptName || '未分配部门')}</small>
                </span>
                <span class="role-member-other">${
                  otherRoles.length ? `另有 ${esc(otherRoles.slice(0, 2).join('、'))}${otherRoles.length > 2 ? '…' : ''}` : ''
                }</span>
                <button class="btn sm ghost danger-text role-member-remove" type="button" data-role-member-remove="${esc(member.id)}">移除</button>
              </div>`
            })
            .join('') ||
          '<div class="empty role-member-empty">该角色还没有成员，点右上角「添加成员」从部门组织架构中选择。</div>'
        }
      </div>
    </section>`

  const setRoleTab = (tab) => {
    state.roleTab = tab === 'members' ? 'members' : 'permissions'
    for (const button of view.querySelectorAll('[data-role-tab]')) {
      const active = button.dataset.roleTab === state.roleTab
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-selected', active ? 'true' : 'false')
    }
    for (const pane of view.querySelectorAll('[data-role-pane]')) {
      pane.hidden = pane.dataset.rolePane !== state.roleTab
    }
  }
  view.querySelectorAll('[data-role-tab]').forEach((button) => {
    button.addEventListener('click', () => setRoleTab(button.dataset.roleTab))
  })
  view.querySelector('#role-back')?.addEventListener('click', () => {
    state.selectedRole = null
    state.roleTab = 'permissions'
    loadRoles()
  })

  const save = $('#save-role')
  save.addEventListener('click', async () => {
    const msg = $('#role-msg')
    const scopes = [...document.querySelectorAll('[data-scope]:checked')].map((el) => el.dataset.scope)
    const quotaLimitRaw = $('#role-quota-limit').value.trim()
    const quotaFileRaw = $('#role-quota-file').value.trim()
    if ((!quotaLimitRaw && quotaFileRaw) || (quotaLimitRaw && !quotaFileRaw)) {
      msg.textContent = '容量和单文件上限要一起填，或两项都留空'
      return
    }
    if (quotaLimitRaw && quotaFileRaw) {
      const limitMb = Number(quotaLimitRaw)
      const fileMb = Number(quotaFileRaw)
      if (!Number.isFinite(limitMb) || !Number.isFinite(fileMb) || limitMb <= 0 || fileMb <= 0) {
        msg.textContent = '存储配额请填写大于 0 的数字'
        return
      }
      if (fileMb > limitMb) {
        msg.textContent = '单文件上限不能大于个人容量'
        return
      }
    }
    msg.textContent = '保存中…'
    try {
      await apiSend('PUT', `/api/console/roles/${encodeURIComponent(role.code)}`, {
        name: $('#role-name').value.trim(),
        dataScope: $('#role-scope').value,
        scopes,
      })
      if (quotaLimitRaw && quotaFileRaw) {
        const mb = 1024 * 1024
        await apiSend('PUT', '/api/console/workspace-quotas', {
          scopeType: 'role',
          scopeId: role.code,
          limitBytes: Math.round(Number(quotaLimitRaw) * mb),
          fileLimitBytes: Math.round(Number(quotaFileRaw) * mb),
        })
      } else {
        await apiSend('DELETE', `/api/console/workspace-quotas/role/${encodeURIComponent(role.code)}`)
      }
      msg.textContent = '已保存'
      loadRoles()
    } catch (err) {
      msg.textContent = err.message || '保存失败'
    }
  })
  view.querySelectorAll('[data-role-member-remove]').forEach((button) => {
    const member = allMembers.find((item) => item.id === button.dataset.roleMemberRemove)
    button.addEventListener('click', () => {
      if (member) removeRoleMember(role, member, roleMemberIds, view.querySelector('#role-member-msg'))
    })
  })
  view.querySelector('#role-member-add')?.addEventListener('click', () => {
    openRoleMemberPicker(role, allMembers, roleMemberIds)
  })
  $('#delete-role')?.addEventListener('click', () => {
    deleteRoleCascade(role, $('#role-msg'))
  })
}

async function loadRoles() {
  const view = $('#view')
  renderLoading(view)
  // 角色列表已移入左侧导航「角色管理」的子菜单，页内不再保留二级栏
  setSide('', true)
  try {
    const [data, scopeData, membersData] = await Promise.all([
      api('/api/console/roles'),
      api('/api/console/scopes'),
      api('/api/org/members').catch(() => ({ members: [] })),
    ])
    const allMembers = membersData?.members ?? []
    // 角色列表的人数按「当前公司仍在职/未删除的成员」重算，避免把已删除成员算进去
    for (const role of data.roles) {
      role.members = allMembers.filter((member) => (member.roles || []).some((item) => item.code === role.code)).length
    }
    state.roles = data.roles
    renderNavRail()
    const selected = data.roles.find((role) => role.code === state.selectedRole)
    if (!selected) {
      view.innerHTML = `
        <div class="permission-flow">
          <div class="flow-step"><span>1</span><strong>角色</strong><p>定义能做什么：权限点 + 数据范围</p></div>
          <div class="flow-arrow">→</div>
          <div class="flow-step"><span>2</span><strong>部门</strong><p>定义管理到哪：本人 / 本部门 / 全公司</p></div>
          <div class="flow-arrow">→</div>
          <div class="flow-step"><span>3</span><strong>成员</strong><p>把角色授予人，可多角色叠加</p></div>
        </div>
        <section class="panel">
          <div class="panel-head"><div><h2>角色清单</h2>${hintBadge('角色说明', '点左侧角色编辑；成员直接在角色页勾选，和成员管理双向同步。')}</div>
          <button class="btn" type="button" id="role-goto-org">去成员管理</button></div>
          <table class="data">
            <thead><tr><th>角色</th><th>数据范围</th><th>权限点</th><th>成员</th><th>存储配额</th></tr></thead>
            <tbody>
              ${data.roles
                .map(
                  (role) => `<tr class="clickable" data-role-row="${esc(role.code)}">
                    <td><strong>${esc(ROLE_LABEL[role.code] || role.name)}</strong><div class="desc mono">${esc(role.code)}</div></td>
                    <td>${esc(DATA_SCOPE_LABEL[role.dataScope] || role.dataScope)}</td>
                    <td>${role.scopes.length} 项</td>
                    <td>${role.members} 人</td>
                    <td>${
                      role.quota
                        ? `${esc(formatStorageBytes(role.quota.limitBytes))} · 单文件 ${esc(
                            formatStorageBytes(role.quota.fileLimitBytes),
                          )}`
                        : '<span class="muted">默认</span>'
                    }</td>
                  </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </section>`
      $('#role-goto-org')?.addEventListener('click', () => navigate('org'))
      view.querySelectorAll('[data-role-row]').forEach((row) => {
        row.addEventListener('click', () => {
          state.selectedRole = row.dataset.roleRow
          loadRoles()
        })
      })
      setPageActions(
        '<button class="btn primary" type="button" id="role-new-top">添加角色</button><button class="btn ghost danger-text" type="button" id="role-delete-top" disabled title="先选择一个角色">删除角色</button>',
      )
      $('#role-new-top')?.addEventListener('click', () => openRoleCreateModal())
      return
    }
    renderRoleEditor(selected, scopeData.scopes, {
      ...scopeData,
      quotaDefaults: data.quotaDefaults,
      members: allMembers,
    })
    setPageActions(
      `<button class="btn ghost" type="button" id="role-matrix">权限矩阵</button><button class="btn" type="button" id="role-new-top">添加角色</button><button class="btn ghost danger-text" type="button" id="role-delete-top"${
        selected.builtin ? ' disabled title="内置角色不可删除"' : ''
      }>删除角色</button>`,
    )
    $('#role-new-top')?.addEventListener('click', () => openRoleCreateModal())
    $('#role-matrix')?.addEventListener('click', () => navigate('access'))
    $('#role-delete-top')?.addEventListener('click', () => deleteRoleCascade(selected, null))
  } catch (err) {
    renderDenied(view, err)
  }
}

/* ---------------- 模型接入 ---------------- */

const MODEL_CAPABILITY_OPTIONS = [
  { key: 'chat', label: '对话', hint: '通用文本问答' },
  { key: 'reasoning', label: '推理', hint: '多步推理、长思考' },
  { key: 'decision', label: '决策', hint: '路由、判定、选择' },
  { key: 'vision', label: '图片识别', hint: '读取图片内容' },
  { key: 'multimodal', label: '多模态', hint: '文本 + 图片联合输入' },
  { key: 'code', label: '代码', hint: '代码生成与审查' },
  { key: 'tool', label: '工具调用', hint: 'function calling' },
  { key: 'embedding', label: '向量', hint: 'embedding / 检索' },
  { key: 'rerank', label: '重排', hint: 'rerank / 检索结果重排' },
  { key: 'audio', label: '语音', hint: '转写、合成、语音问答' },
  { key: 'video', label: '视频', hint: '视频理解与抽帧' },
  { key: 'long_context', label: '长文本', hint: '超长上下文' },
  { key: 'fast', label: '快速', hint: '低延迟短任务' },
]

const MODEL_CAPABILITY_KEYS = new Set(MODEL_CAPABILITY_OPTIONS.map((item) => item.key))
const MODEL_CAPABILITY_ALIASES = {
  image: 'vision',
  visual: 'vision',
  reranker: 'rerank',
  reranking: 'rerank',
  'multi_modal': 'multimodal',
  multimodal_input: 'multimodal',
  think: 'reasoning',
  thinking: 'reasoning',
  r1: 'reasoning',
  function_calling: 'tool',
  tools: 'tool',
  embed: 'embedding',
  long_context: 'long_context',
  'long_context_window': 'long_context',
  longcontext: 'long_context',
  longtext: 'long_context',
  speech: 'audio',
  asr: 'audio',
  tts: 'audio',
  video_understanding: 'video',
  '图片': 'vision',
  '图片识别': 'vision',
  '视觉': 'vision',
  '多模态': 'multimodal',
  '推理': 'reasoning',
  '决策': 'decision',
  '对话': 'chat',
  '代码': 'code',
  '工具调用': 'tool',
  '向量': 'embedding',
  '语音': 'audio',
  '视频': 'video',
  '长文本': 'long_context',
  '快速': 'fast',
}

function normalizeModelTags(tags = []) {
  const keys = []
  const extras = []
  for (const raw of tags || []) {
    const value = String(raw || '').trim()
    if (!value) continue
    const normalized = value.toLowerCase().replace(/[-\s]+/g, '_')
    const key = MODEL_CAPABILITY_ALIASES[normalized] || normalized
    if (MODEL_CAPABILITY_KEYS.has(key)) {
      if (!keys.includes(key)) keys.push(key)
    } else if (!extras.includes(value)) {
      extras.push(value)
    }
  }
  return { keys, extras }
}

function modelCapabilitySummary(tags = []) {
  const { keys, extras } = normalizeModelTags(tags)
  const known = keys
    .map((key) => MODEL_CAPABILITY_OPTIONS.find((item) => item.key === key))
    .filter(Boolean)
  return {
    keys,
    extras,
    labels: [...known.map((item) => item.label), ...extras],
  }
}

function modelTypeOf(tags = []) {
  const caps = modelCapabilitySummary(tags)
  const keys = caps.keys
  const labels = []
  if (keys.includes('embedding')) labels.push('向量')
  if (keys.includes('rerank')) labels.push('重排')
  if (keys.includes('vision') || keys.includes('multimodal')) labels.push('多模态')
  if (keys.includes('decision')) labels.push('决策')
  else if (keys.includes('reasoning')) labels.push('推理')
  if (keys.includes('code')) labels.push('代码')
  if (keys.includes('audio')) labels.push('语音')
  if (keys.includes('video')) labels.push('视频')
  if (labels.length === 0 && keys.includes('chat')) labels.push('对话')
  if (labels.length === 0 && caps.extras.length) labels.push('自定义')
  if (labels.length === 0) return { label: '未标注', tone: 'is-muted' }
  const first = keys.includes('embedding') || keys.includes('rerank')
    ? 'is-embedding'
    : keys.includes('vision') || keys.includes('multimodal')
      ? 'is-vision'
      : keys.includes('decision') || keys.includes('reasoning')
        ? 'is-decision'
        : keys.includes('code')
          ? 'is-code'
          : keys.includes('audio') || keys.includes('video')
            ? 'is-audio'
            : 'is-chat'
  return { label: labels.slice(0, 2).join(' · '), tone: first }
}

function modelSupportsRoutePurpose(model, purpose) {
  const capabilities = model?.capabilities?.length ? model.capabilities : model?.tags || []
  const endpointKind = model?.endpointKind || 'chat'
  if (purpose === 'chat.default') return capabilities.includes('chat') && endpointKind === 'chat'
  if (purpose === 'chat.vision') {
    return (capabilities.includes('vision') || capabilities.includes('multimodal')) && endpointKind === 'chat'
  }
  if (purpose === 'router.intent') {
    return (
      (capabilities.includes('decision') ||
        capabilities.includes('reasoning') ||
        capabilities.includes('chat')) &&
      endpointKind === 'chat'
    )
  }
  if (purpose === 'kb.embed') return capabilities.includes('embedding') || endpointKind === 'embeddings'
  if (purpose === 'kb.rerank') return endpointKind === 'rerank'
  if (purpose === 'asr.default') return endpointKind === 'asr'
  if (purpose === 'tts.default') return endpointKind === 'tts'
  if (purpose === 'video.analyze') return endpointKind === 'video' || capabilities.includes('video')
  return false
}

function capabilityChipTone(key) {
  if (key === 'vision' || key === 'multimodal') return 'is-vision'
  if (key === 'decision' || key === 'reasoning') return 'is-decision'
  if (key === 'embedding' || key === 'rerank') return 'is-embedding'
  if (key === 'code') return 'is-code'
  if (key === 'audio' || key === 'video') return 'is-audio'
  return ''
}

function capabilityChipsHtml(tags = [], limit = 3) {
  const caps = modelCapabilitySummary(tags)
  if (caps.labels.length === 0) return '<span class="models-cap-empty">点击设置能力</span>'
  const shown = caps.labels.slice(0, limit)
  const knownItems = caps.keys
    .map((key) => MODEL_CAPABILITY_OPTIONS.find((item) => item.key === key))
    .filter(Boolean)
  return (
    shown
      .map((label, index) => {
        const tone = capabilityChipTone(knownItems[index]?.key)
        return `<span class="models-cap-chip ${tone}">${esc(label)}</span>`
      })
      .join('') + (caps.labels.length > limit ? `<span class="models-cap-more">+${caps.labels.length - limit}</span>` : '')
  )
}

function modelFormType(tags = []) {
  const keys = modelCapabilitySummary(tags).keys
  if (keys.includes('rerank')) return 'rerank'
  if (keys.includes('embedding')) return 'embedding'
  if (keys.includes('vision') || keys.includes('multimodal')) return 'vision'
  if (keys.includes('video')) return 'video'
  if (keys.includes('audio')) return 'audio'
  if (keys.includes('decision') || keys.includes('reasoning')) return 'decision'
  if (keys.includes('chat')) return 'chat'
  return 'custom'
}

function capabilityOptionsHtml(tags = []) {
  const caps = normalizeModelTags(tags)
  return (
    MODEL_CAPABILITY_OPTIONS.map(
      (item) => `<label class="models-cap-option ${caps.keys.includes(item.key) ? 'is-on' : ''}">
        <input type="checkbox" data-cap-key="${item.key}"${caps.keys.includes(item.key) ? ' checked' : ''} />
        <span><strong>${esc(item.label)}</strong><small>${esc(item.hint)}</small></span>
      </label>`,
    ).join('') +
    caps.extras
      .map(
        (value) => `<label class="models-cap-option is-on">
          <input type="checkbox" data-cap-extra="${esc(value)}" checked />
          <span><strong>${esc(value)}</strong><small>自定义标签</small></span>
        </label>`,
      )
      .join('')
  )
}

function confirmCard({
  title = '确认操作',
  message = '',
  detail = '',
  confirmText = '确定',
  cancelText = '取消',
  tone = 'danger',
  requireText = '',
  requireHint = '',
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay confirm-overlay'
    const toneClass = tone === 'warning' ? ' is-warning' : tone === 'brand' ? ' is-brand' : ' is-danger'
    const icon =
      tone === 'warning'
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4m0 3h.01M10.29 3.86 1.82 17a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m-9 0 1 13h8l1-13M10 11v5m4-5v5"/></svg>'
    overlay.innerHTML = `<div class="confirm-card${toneClass}" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div class="confirm-head">
        <span class="confirm-icon">${icon}</span>
        <div class="confirm-copy">
          <h3 id="confirm-title">${esc(title)}</h3>
          <p class="confirm-message">${esc(message)}</p>
          ${detail ? `<div class="confirm-detail">${esc(detail)}</div>` : ''}
          ${
            requireText
              ? `<label class="confirm-field"><span>${esc(requireHint || `请输入「${requireText}」确认`)}</span><input data-confirm-input autocomplete="off" placeholder="${esc(requireText)}" /></label>`
              : ''
          }
        </div>
      </div>
      <div class="confirm-actions">
        <button class="btn ghost" type="button" data-confirm-cancel>${esc(cancelText)}</button>
        <button class="btn ${tone === 'warning' ? 'confirm-warning' : tone === 'brand' ? 'primary' : 'danger'}" type="button" data-confirm-ok${requireText ? ' disabled' : ''}>${esc(confirmText)}</button>
      </div>
    </div>`
    document.body.appendChild(overlay)
    const finish = (value) => {
      document.removeEventListener('keydown', onKey)
      overlay.remove()
      resolve(value)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      }
    }
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finish(false)
    })
    overlay.querySelector('[data-confirm-cancel]').addEventListener('click', () => finish(false))
    const okButton = overlay.querySelector('[data-confirm-ok]')
    okButton.addEventListener('click', () => finish(true))
    const input = overlay.querySelector('[data-confirm-input]')
    if (input) {
      const sync = () => {
        okButton.disabled = input.value.trim() !== requireText
      }
      input.addEventListener('input', sync)
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !okButton.disabled) {
          event.preventDefault()
          finish(true)
        }
      })
      sync()
    }
    document.addEventListener('keydown', onKey)
    ;(input || overlay.querySelector('[data-confirm-cancel]')).focus()
  })
}

function modelModal(html) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `<div class="modal">${html}</div>`
  document.body.appendChild(overlay)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove()
  })
  return overlay
}

function fieldInfo(text) {
  return hintBadge('i', text, text, 'icon-only')
}

async function openProviderModal(provider) {
  const kinds = await api('/api/console/model-kinds')
  const cloudKinds = kinds.kinds.filter((item) => !['ollama', 'vllm', 'lmstudio', 'demo'].includes(item.kind))
  const localKinds = kinds.kinds.filter((item) => ['ollama', 'vllm', 'lmstudio'].includes(item.kind))
  const option = (item) =>
    `<option value="${item.kind}" data-base="${esc(item.defaultBaseUrl)}"${
      provider && provider.kind === item.kind ? ' selected' : ''
    }>${esc(item.label)}</option>`
  const overlay = modelModal(`
    <div class="modal-head"><h3>${provider ? '编辑供应商' : '添加供应商'}</h3><button class="modal-x" type="button">×</button></div>
    ${hintNote('接入说明', '任意 OpenAI 兼容、Anthropic、Gemini、Azure 或本地推理服务都能接入；保存后会尝试读取 /models，读不到也能手动添加模型。密钥只写入服务器 .eab-dev/secrets.json 或环境变量，不写数据库、不在页面回显；本地 Ollama / vLLM / LM Studio 一般不需要密钥。')}
    <div class="field-stack">
      <label class="field"><span>供应商类型</span><select id="p-kind">
        <optgroup label="云端厂商">${cloudKinds.map(option).join('')}</optgroup>
        <optgroup label="本地模型">${localKinds.map(option).join('')}</optgroup>
      </select></label>
      <label class="field"><span>显示名称</span><input id="p-name" value="${esc(provider?.name ?? '')}" placeholder="例如 DeepSeek 主力 / 本地 Qwen" /></label>
      <label class="field"><span>Base URL</span><input id="p-base" class="mono" value="${esc(provider?.baseUrl ?? '')}" placeholder="选择类型后自动填入，本地模型不要填公网地址" /></label>
      <label class="field"><span>API Key ${provider ? '（留空则不修改）' : ''}</span><input id="p-key" type="password" autocomplete="off" placeholder="直接粘贴密钥，保存到服务器本地密钥文件，不回显" /></label>
      <label class="field"><span>密钥引用名（可选）</span><input id="p-env" class="mono" value="${esc(provider?.apiKeyEnv ?? '')}" placeholder="例如 DEEPSEEK_API_KEY；留空自动生成" /></label>
    </div>
    <div class="modal-state" id="p-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="p-save">保存</button>
      <button class="btn ghost" type="button" id="p-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#p-cancel').addEventListener('click', close)
  const kind = overlay.querySelector('#p-kind')
  const base = overlay.querySelector('#p-base')
  kind.addEventListener('change', () => {
    const preset = kind.selectedOptions[0]?.dataset.base || ''
    if (preset) base.value = preset
  })
  overlay.querySelector('#p-save').addEventListener('click', async () => {
    const stateEl = overlay.querySelector('#p-state')
    stateEl.textContent = '保存中…'
    try {
      const body = {
        kind: kind.value,
        name: overlay.querySelector('#p-name').value.trim(),
        baseUrl: base.value.trim(),
        apiKey: overlay.querySelector('#p-key').value.trim(),
        apiKeyEnv: overlay.querySelector('#p-env').value.trim(),
      }
      const saved = provider
        ? await apiSend('PATCH', `/api/console/providers/${encodeURIComponent(provider.id)}`, body)
        : await apiPost('/api/console/providers', body)
      close()
      await loadModels()
      const savedProvider = saved?.provider ?? provider
      if (savedProvider && (savedProvider.kind !== 'demo' || savedProvider.baseUrl)) {
        await discoverProviderModels(savedProvider)
      }
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '保存失败'
    }
  })
}

async function discoverProviderModels(provider) {
  const msg = $('#provider-test-msg')
  if (msg) msg.textContent = `正在读取「${provider.name}」的模型清单…`
  try {
    const data = await api(`/api/console/providers/${encodeURIComponent(provider.id)}/models`)
    if (msg) msg.textContent = data.models.length ? data.message : `✗ ${data.message}`
    if (!data.models.length) return
    openModelImportModal(provider, data)
  } catch (err) {
    if (msg) msg.textContent = `✗ 模型清单检测失败：${err.message || '未知错误'}`
    else alert(`模型清单检测失败：${err.message || '未知错误'}`)
  }
}

function openModelImportModal(provider, data) {
  const importTypes = {
    chat: { label: '对话', caps: ['chat'], endpoint: 'chat', api: 'POST /chat/completions' },
    decision: { label: '决策 / 推理', caps: ['chat', 'reasoning', 'decision'], endpoint: 'chat', api: 'POST /chat/completions' },
    vision: { label: '多模态', caps: ['chat', 'vision', 'multimodal'], endpoint: 'chat', api: 'POST /chat/completions' },
    embedding: { label: '向量', caps: ['embedding'], endpoint: 'embeddings', api: 'POST /embeddings' },
    rerank: { label: '重排序', caps: ['rerank'], endpoint: 'rerank', api: 'POST /rerank' },
    asr: { label: '语音转写', caps: ['audio'], endpoint: 'asr', api: 'POST /audio/transcriptions' },
    tts: { label: '语音合成', caps: ['audio'], endpoint: 'tts', api: 'POST /audio/speech' },
    video: { label: '视频理解', caps: ['video'], endpoint: 'video', api: 'POST /video/analyze' },
  }
  const suggestionOf = (model) => {
    const suggested = model.suggested || {}
    const endpoint = suggested.endpointKind || 'chat'
    const type =
      endpoint === 'asr'
        ? 'asr'
        : endpoint === 'tts'
          ? 'tts'
          : importTypes[suggested.modelType]
            ? suggested.modelType
            : endpoint === 'embeddings'
              ? 'embedding'
              : endpoint === 'rerank'
                ? 'rerank'
                : endpoint === 'video'
                  ? 'video'
                  : 'chat'
    return {
      type,
      label: suggested.label || importTypes[type].label,
      endpoint,
      api: suggested.api?.path || importTypes[type].api.replace(/^POST /, ''),
      confidence: suggested.confidence || 'low',
      basis: suggested.basis || '按模型名推断',
    }
  }

  const overlay = modelModal(`
    <div class="modal-head"><h3>发现 ${data.models.length} 个模型</h3><button class="modal-x" type="button">×</button></div>
    <div class="hint">来源：<span class="mono">${esc(data.baseUrl)}/models</span> · 勾选后加入「${esc(
      provider.name,
    )}」</div>
    ${hintNote('导入说明', '类型是按模型名推断的，不是协议探测，可逐条修改；点保存后才会写入模型列表。')}
    <div class="model-import-toolbar">
      <span class="muted" id="imp-count"></span>
      <button class="link-btn" type="button" id="imp-all">全选</button>
      <button class="link-btn" type="button" id="imp-none">全不选</button>
    </div>
    <div class="model-import-list">
      ${data.models
        .map((model, index) => {
          const suggested = suggestionOf(model)
          return `<div class="model-import-row">
            <input type="checkbox" id="imp-row-${index}" data-import-key="${esc(model.id)}" checked />
            <label class="model-import-main" for="imp-row-${index}">
              <strong class="mono">${esc(model.id)}</strong>
              <small>${model.label ? `${esc(model.label)} · ` : ''}${esc(suggested.label)} · ${esc(suggested.basis)}</small>
            </label>
            <div class="model-import-side">
              <select data-import-type="${index}" data-import-key="${esc(model.id)}" aria-label="${esc(model.id)} 的类型">
                ${Object.entries(importTypes)
                  .map(
                    ([value, meta]) =>
                      `<option value="${value}"${value === suggested.type ? ' selected' : ''}>${esc(meta.label)}</option>`,
                  )
                  .join('')}
              </select>
              <small class="mono" data-import-api="${index}">POST ${esc(suggested.api)}</small>
            </div>
          </div>`
        })
        .join('')}
    </div>
    <div class="modal-state" id="imp-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="imp-save">加入模型列表</button>
      <button class="btn ghost" type="button" id="imp-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#imp-cancel').addEventListener('click', close)

  const checks = [...overlay.querySelectorAll('[data-import-key][type="checkbox"]')]
  const typeSelects = [...overlay.querySelectorAll('[data-import-type]')]
  const save = overlay.querySelector('#imp-save')
  const count = overlay.querySelector('#imp-count')
  const update = () => {
    const selected = checks.filter((input) => input.checked).length
    count.textContent = `已选 ${selected} / 共 ${checks.length}`
    save.disabled = selected === 0
  }
  for (const input of checks) input.addEventListener('change', update)
  for (const select of typeSelects) {
    select.addEventListener('change', () => {
      const index = select.dataset.importType
      const api = overlay.querySelector(`[data-import-api="${index}"]`)
      const meta = importTypes[select.value]
      if (api && meta) api.textContent = `POST ${meta.api.replace(/^POST /, '')}`
    })
  }
  overlay.querySelector('#imp-all').addEventListener('click', () => {
    for (const input of checks) input.checked = true
    update()
  })
  overlay.querySelector('#imp-none').addEventListener('click', () => {
    for (const input of checks) input.checked = false
    update()
  })
  update()

  save.addEventListener('click', async () => {
    const stateEl = overlay.querySelector('#imp-state')
    const keys = checks.filter((input) => input.checked).map((input) => input.dataset.importKey)
    const models = keys.map((modelKey) => {
      const select = typeSelects.find((item) => item.dataset.importKey === modelKey)
      const meta = importTypes[select?.value] || importTypes.chat
      return { modelKey, capabilities: meta.caps, endpointKind: meta.endpoint }
    })
    stateEl.className = 'modal-state'
    stateEl.textContent = '写入中…'
    try {
      const result = await apiPost(`/api/console/providers/${encodeURIComponent(provider.id)}/models/import`, {
        models,
      })
      close()
      await loadModels()
      const msg = $('#provider-test-msg')
      if (msg) msg.textContent = `✓ ${result.message}`
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '写入失败'
    }
  })
}

async function openModelModal(model, providers, roles) {
  const activeProviders = providers.filter((item) => item.status === 'active')
  if (activeProviders.length === 0) {
    alert('先添加一个供应商，再添加模型')
    return
  }
  const initialTags = model?.tags || []
  const initialRoleCodes = model ? model.roles || [] : roles.map((role) => role.code)
  const overlay = modelModal(`
    <div class="modal-head">
      <div class="models-modal-title">
        <h3>${model ? '编辑模型' : '添加模型'}</h3>
      </div>
      <button class="modal-x" type="button">×</button>
    </div>
    <div class="models-modal-body">
      <section class="models-form-section">
        <div class="models-form-section-head">
          <strong>基础信息</strong>
          ${fieldInfo('模型在目录里怎么显示，以及由哪个供应商提供。')}
        </div>
        <div class="form-cols">
          <label class="field"><span>显示名</span><input id="m-name" value="${esc(model?.name ?? '')}" placeholder="例如 DeepSeek V3 / 本地 Qwen2.5" /></label>
          <label class="field"><span>供应商</span><select id="m-provider">
            ${activeProviders
              .map(
                (item) =>
                  `<option value="${item.id}"${model && model.providerId === item.id ? ' selected' : ''}>${esc(
                    item.name,
                  )} · ${esc(item.kindLabel)}</option>`,
              )
              .join('')}
          </select></label>
        </div>
        <div class="form-cols">
          <label class="field"><span>模型标识</span><input id="m-key" class="mono" value="${esc(model?.modelKey ?? '')}" placeholder="例如 deepseek-chat / qwen2.5:7b" /></label>
          <label class="field"><span>优先级 ${fieldInfo('数字越小越优先被「自动选择」使用。')}</span><input id="m-priority" type="number" value="${model?.priority ?? 10}" /></label>
        </div>
      </section>
      <section class="models-form-section">
        <div class="models-form-section-head">
          <strong>调用方式</strong>
          ${fieldInfo('类型决定默认能力，端点类型决定服务端用哪个协议调用；切换类型会自动带出推荐端点。')}
        </div>
        <div class="form-cols">
          <label class="field"><span>模型类型 <span class="hint-badge icon-only" id="m-type-hint" tabindex="0" data-tip="模型类型说明" aria-label="模型类型说明">i</span></span><select id="m-type">
            <option value="chat">对话模型</option>
            <option value="decision">决策 / 推理模型</option>
            <option value="vision">多模态 / 视觉模型</option>
            <option value="embedding">向量模型</option>
            <option value="rerank">重排序模型</option>
            <option value="audio">语音模型（ASR / TTS）</option>
            <option value="video">视频理解模型</option>
            <option value="custom">自定义能力</option>
          </select></label>
          <label class="field"><span>端点类型 ${fieldInfo('决定服务端用哪个协议调用；语音要区分 ASR 与 TTS。')}</span><select id="m-endpoint">
            <option value="chat">对话 / chat completions</option>
            <option value="embeddings">向量 / embeddings</option>
            <option value="rerank">重排 / rerank</option>
            <option value="asr">语音转写 / ASR</option>
            <option value="tts">语音合成 / TTS</option>
            <option value="video">视频理解 / video</option>
          </select></label>
        </div>
        <div class="models-type-preview-field">
          <span>列表里会显示为</span>
          <div class="models-type-preview">
            <span class="models-type-badge" id="m-type-preview"></span>
            <div class="models-preview-chips" id="m-preview-chips"></div>
          </div>
        </div>
        <label class="field" id="m-dim-field" hidden><span>向量维度 <em>仅向量模型</em> ${fieldInfo('用于核对入库与查询是否同一模型；留空由模型返回决定。')}</span><input id="m-dim" type="number" min="1" value="${model?.embeddingDim ?? ''}" placeholder="例如 1024" /></label>
      </section>
      <section class="models-form-section">
        <div class="models-form-section-head">
          <strong>上下文与输出</strong>
          ${fieldInfo('按模型真实窗口填写；留空不会启用 token 预算压缩。')}
        </div>
        <div class="form-cols">
          <label class="field"><span>上下文上限 <em>tokens</em> ${fieldInfo('模型的最大上下文窗口；留空则不启用 token 预算压缩。')}</span><input id="m-context" type="number" min="1" value="${model?.maxContext ?? ''}" placeholder="例如 32768" /></label>
          <label class="field"><span>输出上限 <em>tokens</em> ${fieldInfo('单次回答最多生成多少 token；必须小于上下文上限。')}</span><input id="m-output" type="number" min="1" value="${model?.maxOutputTokens ?? ''}" placeholder="留空默认 4096" /></label>
        </div>
        <div class="field models-compress-field">
          <label class="check"><input id="m-compress" type="checkbox"${model ? (model.contextCompression !== false ? ' checked' : '') : ' checked'} /><span>上下文超限时自动压缩较早历史 ${fieldInfo('只在填写上下文上限后生效；较早对话会压成摘要，最近消息保留原文，不会额外调用模型。')}</span></label>
        </div>
      </section>
      <section class="models-form-section models-cap-section">
        <div class="models-cap-section-head">
          <div><span>能力 / 擅长场景 ${fieldInfo('可多选；勾选即决定顶部类型、筛选和图片可用性。')}</span></div>
          <div class="models-multi-actions">
            <button class="models-inline-btn" type="button" id="m-cap-all">全选</button>
            <button class="models-cap-clear" type="button" id="m-cap-clear">清空</button>
          </div>
        </div>
        <div class="models-cap-grid">${capabilityOptionsHtml(initialTags)}</div>
        <div class="models-cap-note" id="m-cap-note"></div>
      </section>
      <section class="models-form-section">
        <div class="models-form-section-head">
          <strong>可见角色</strong>
          ${fieldInfo('只勾选允许使用该模型的角色；全不选时任何成员都不能使用。')}
          <div class="models-multi-actions">
            <button class="models-inline-btn" type="button" id="m-role-all">全选</button>
            <button class="models-inline-btn is-muted" type="button" id="m-role-clear">全不选</button>
          </div>
        </div>
        <div class="check-grid models-role-grid">
          ${roles
            .map(
              (role) =>
                `<label class="check"><input type="checkbox" data-mrole="${esc(role.code)}"${
                  initialRoleCodes.includes(role.code) ? ' checked' : ''
                } /><span>${esc(ROLE_LABEL[role.code] || role.name)}</span></label>`,
            )
            .join('')}
        </div>
        <div class="models-role-state" id="m-role-state"></div>
      </section>
    </div>
    <div class="modal-state" id="m-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="m-save">保存模型</button>
      <button class="btn ghost" type="button" id="m-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  const type = overlay.querySelector('#m-type')
  const typeHint = overlay.querySelector('#m-type-hint')
  const endpoint = overlay.querySelector('#m-endpoint')
  type.value = modelFormType(initialTags)
  const defaultEndpoint = (tags) => {
    if (tags.includes('rerank')) return 'rerank'
    if (tags.includes('embedding')) return 'embeddings'
    if (tags.includes('video')) return 'video'
    if (tags.includes('audio')) return model?.endpointKind === 'asr' || model?.endpointKind === 'tts' ? model.endpointKind : 'asr'
    return 'chat'
  }
  endpoint.value = model?.endpointKind && model.endpointKind !== 'audio' ? model.endpointKind : defaultEndpoint(initialTags)
  const dimField = overlay.querySelector('#m-dim-field')
  const roleInputs = [...overlay.querySelectorAll('[data-mrole]')]
  const roleState = overlay.querySelector('#m-role-state')
  const syncDimField = () => {
    dimField.hidden = endpoint.value !== 'embeddings'
  }
  const syncRoleState = () => {
    const count = roleInputs.filter((input) => input.checked).length
    roleState.className = `models-role-state${count === 0 ? ' is-empty' : ''}`
    roleState.textContent =
      count === 0
        ? '未选择任何角色：保存后这个模型不会出现在任何成员的工作台。'
        : `已授权 ${count} 个角色：只有这些角色的成员能看到并使用这个模型。`
  }
  const typeHints = {
    chat: '通用文本问答，最基础的接入类型。',
    decision: '会自动勾选对话、推理、决策；适合路由判定与多步分析。',
    vision: '会自动勾选对话、图片识别、多模态；支持工作台图片输入。',
    embedding: '只做向量化，不参与对话生成；端点类型会自动切到 embeddings。',
    rerank: '重排序模型用于知识库检索后的二次排序；端点类型会自动切到 rerank，请求发往 POST /rerank。',
    audio: '语音链路：ASR 负责把语音转文字，TTS 负责把回答合成语音；务必在「端点类型」里选准。',
    video: '视频理解：异步抽帧、音轨转写与画面描述；端点类型会自动切到 video。',
    custom: '只按下面勾选的能力工作，不套用预设。',
  }
  const presetByType = {
    chat: ['chat'],
    decision: ['chat', 'reasoning', 'decision'],
    vision: ['chat', 'vision', 'multimodal'],
    embedding: ['embedding'],
    rerank: ['rerank'],
    audio: ['audio'],
    video: ['video'],
  }
  const readTags = () => {
    const tags = [...overlay.querySelectorAll('[data-cap-key]:checked')].map((el) => el.dataset.capKey)
    const extras = [...overlay.querySelectorAll('[data-cap-extra]:checked')].map((el) => el.dataset.capExtra)
    return [...tags, ...extras]
  }
  const setChecked = (keys) => {
    for (const input of overlay.querySelectorAll('[data-cap-key]')) {
      input.checked = keys.includes(input.dataset.capKey)
      input.closest('.models-cap-option')?.classList.toggle('is-on', input.checked)
    }
    for (const input of overlay.querySelectorAll('[data-cap-extra]')) {
      input.checked = false
      input.closest('.models-cap-option')?.classList.remove('is-on')
    }
  }
  const syncPreview = () => {
    const tags = readTags()
    const info = modelTypeOf(tags)
    const preview = overlay.querySelector('#m-type-preview')
    preview.className = `models-type-badge ${info.tone}`
    preview.textContent = info.label
    overlay.querySelector('#m-preview-chips').innerHTML = capabilityChipsHtml(tags, 4)
    const hasVision = tags.includes('vision') || tags.includes('multimodal')
    const note = overlay.querySelector('#m-cap-note')
    note.className = `models-cap-note ${hasVision ? 'is-ready' : ''}`
    note.innerHTML = hasVision
      ? '<strong>图片识别已开启</strong><span>员工工作台可以直接上传或粘贴图片，服务端会按图片内容送入模型。</span>'
      : '<strong>未开启图片识别</strong><span>带图片的消息不会发给这个模型；需要图片能力时请勾选「图片识别 / 多模态」。</span>'
    const hintText = typeHints[type.value] || typeHints.custom
    typeHint.dataset.tip = hintText
    typeHint.setAttribute('aria-label', hintText)
  }
  for (const input of overlay.querySelectorAll('.models-cap-grid input')) {
    input.addEventListener('change', () => {
      input.closest('.models-cap-option')?.classList.toggle('is-on', input.checked)
      syncPreview()
    })
  }
  type.addEventListener('change', () => {
    const preset = presetByType[type.value]
    if (preset) setChecked(preset)
    if (type.value === 'embedding') endpoint.value = 'embeddings'
    else if (type.value === 'rerank') endpoint.value = 'rerank'
    else if (type.value === 'video') endpoint.value = 'video'
    else if (type.value === 'audio') endpoint.value = endpoint.value === 'tts' ? 'tts' : 'asr'
    else if (['chat', 'decision', 'vision'].includes(type.value)) endpoint.value = 'chat'
    syncPreview()
    syncDimField()
  })
  endpoint.addEventListener('change', syncDimField)
  for (const input of roleInputs) input.addEventListener('change', syncRoleState)
  const setAllRoles = (checked) => {
    for (const input of roleInputs) input.checked = checked
    syncRoleState()
  }
  overlay.querySelector('#m-role-all').addEventListener('click', () => setAllRoles(true))
  overlay.querySelector('#m-role-clear').addEventListener('click', () => setAllRoles(false))
  overlay.querySelector('#m-cap-all').addEventListener('click', () => {
    for (const input of overlay.querySelectorAll('.models-cap-grid input')) {
      input.checked = true
      input.closest('.models-cap-option')?.classList.add('is-on')
    }
    syncPreview()
  })
  overlay.querySelector('#m-cap-clear').addEventListener('click', () => {
    setChecked([])
    syncPreview()
  })
  syncPreview()
  syncDimField()
  syncRoleState()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#m-cancel').addEventListener('click', close)
  overlay.querySelector('#m-save').addEventListener('click', async () => {
    const stateEl = overlay.querySelector('#m-state')
    stateEl.textContent = '保存中…'
    const body = {
      name: overlay.querySelector('#m-name').value.trim(),
      providerId: overlay.querySelector('#m-provider').value,
      modelKey: overlay.querySelector('#m-key').value.trim(),
      priority: Number(overlay.querySelector('#m-priority').value),
      tags: readTags(),
      capabilities: readTags(),
      endpointKind: endpoint.value,
      embeddingDim: overlay.querySelector('#m-dim').value ? Number(overlay.querySelector('#m-dim').value) : null,
      maxContext: overlay.querySelector('#m-context').value ? Number(overlay.querySelector('#m-context').value) : null,
      maxOutputTokens: overlay.querySelector('#m-output').value ? Number(overlay.querySelector('#m-output').value) : null,
      contextCompression: overlay.querySelector('#m-compress').checked,
      roles: [...overlay.querySelectorAll('[data-mrole]:checked')].map((el) => el.dataset.mrole),
    }
    try {
      if (model) await apiSend('PATCH', `/api/console/models/${encodeURIComponent(model.id)}`, body)
      else await apiPost('/api/console/models', body)
      close()
      loadModels()
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '保存失败'
    }
  })
}

let modelCapabilityPopover = null

function closeModelCapabilityPopover() {
  if (!modelCapabilityPopover) return
  modelCapabilityPopover.__cleanup?.()
  modelCapabilityPopover.remove()
  modelCapabilityPopover = null
}

function openModelCapabilityPopover(trigger, model, onSave) {
  closeModelCapabilityPopover()
  const popover = document.createElement('div')
  popover.className = 'models-cap-popover'
  popover.innerHTML = `
    <div class="models-cap-pop-head">
      <div><strong>能力 / 擅长场景</strong><span>${esc(model.name)}</span></div>
      <button class="models-cap-clear" type="button" id="cap-clear">清空</button>
    </div>
    <div class="models-cap-grid is-compact">${capabilityOptionsHtml(model.tags)}</div>
    <div class="models-cap-pop-foot">
      <span class="muted" id="cap-msg">勾选后保存，列表类型会立即更新</span>
      <div><button class="btn ghost" type="button" id="cap-cancel">取消</button><button class="btn primary" type="button" id="cap-save">保存</button></div>
    </div>`
  document.body.appendChild(popover)
  modelCapabilityPopover = popover
  const rect = trigger.getBoundingClientRect()
  const width = popover.offsetWidth
  const height = popover.offsetHeight
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
  const top =
    rect.bottom + height + 8 <= window.innerHeight
      ? rect.bottom + 8
      : Math.max(12, rect.top - height - 8)
  popover.style.left = `${left}px`
  popover.style.top = `${top}px`
  const readTags = () => {
    const tags = [...popover.querySelectorAll('[data-cap-key]:checked')].map((el) => el.dataset.capKey)
    const extras = [...popover.querySelectorAll('[data-cap-extra]:checked')].map((el) => el.dataset.capExtra)
    return [...tags, ...extras]
  }
  const setChecked = (keys) => {
    for (const input of popover.querySelectorAll('[data-cap-key]')) {
      input.checked = keys.includes(input.dataset.capKey)
      input.closest('.models-cap-option')?.classList.toggle('is-on', input.checked)
    }
    for (const input of popover.querySelectorAll('[data-cap-extra]')) {
      input.checked = false
      input.closest('.models-cap-option')?.classList.remove('is-on')
    }
  }
  for (const input of popover.querySelectorAll('input')) {
    input.addEventListener('change', () => {
      input.closest('.models-cap-option')?.classList.toggle('is-on', input.checked)
    })
  }
  popover.querySelector('#cap-clear').addEventListener('click', () => setChecked([]))
  popover.querySelector('#cap-cancel').addEventListener('click', closeModelCapabilityPopover)
  popover.querySelector('#cap-save').addEventListener('click', async () => {
    const msg = popover.querySelector('#cap-msg')
    const save = popover.querySelector('#cap-save')
    const tags = readTags()
    save.disabled = true
    msg.textContent = '保存中…'
    try {
      await onSave(tags)
      closeModelCapabilityPopover()
    } catch (err) {
      msg.className = 'models-cap-error'
      msg.textContent = err.message || '保存失败'
      save.disabled = false
    }
  })
  const onOutside = (event) => {
    if (popover.contains(event.target) || trigger.contains(event.target)) return
    closeModelCapabilityPopover()
  }
  const onKey = (event) => {
    if (event.key === 'Escape') closeModelCapabilityPopover()
  }
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('keydown', onKey)
  }, 0)
  popover.__cleanup = () => {
    document.removeEventListener('mousedown', onOutside)
    document.removeEventListener('keydown', onKey)
  }
}

function formatStressDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
}

function openModelStressModal(model, trigger) {
  const canRun =
    model.enabled &&
    model.providerStatus === 'active' &&
    (model.endpointKind ?? 'chat') === 'chat' &&
    model.providerKind !== 'demo'
  let timer = null
  let jobId = ''
  let running = false
  const overlay = modelModal(`
    <div class="modal-head">
      <div class="models-modal-title">
        <h3>模型压测 ${fieldInfo('直接调用真实模型，不经过在线对话闸门；用来判断这个模型端点自己的并发能力。')}</h3>
        <p>只发测试请求，不写会话和消息；结果只保留在当前服务进程里。</p>
      </div>
      <button class="modal-x" type="button">×</button>
    </div>
    <div class="models-modal-body stress-modal-body">
      <div class="stress-model-card">
        <div class="stress-model-main">
          <span class="models-provider-pill">${esc(model.providerName)}</span>
          <strong>${esc(model.name)}</strong>
          <span class="mono">${esc(model.modelKey)}</span>
        </div>
        <span class="pill ${canRun ? 'ok' : 'warn'}">${canRun ? '可压测' : '当前不可压测'}</span>
      </div>
      ${
        canRun
          ? ''
          : `<p class="stress-blocked">这个模型需要先启用、供应商处于启用状态，且类型为对话模型；演示回声没有真实上游。</p>`
      }
      <div class="stress-form-grid">
        <label class="field"><span>并发数 ${fieldInfo('同时发出的请求数；越高越能压出模型吞吐上限，也越占用算力。')}</span><input id="st-concurrency" type="number" min="1" max="20" value="3" ${canRun ? '' : 'disabled'} /></label>
        <label class="field"><span>总请求数 ${fieldInfo('本次一共发多少条请求；单次压测上限 100 条。')}</span><input id="st-requests" type="number" min="1" max="100" value="10" ${canRun ? '' : 'disabled'} /></label>
      </div>
      <div class="stress-presets" aria-label="压测档位">
        <button class="stress-preset" type="button" data-stress-preset="2,6">轻量 2 × 6</button>
        <button class="stress-preset is-active" type="button" data-stress-preset="3,10">标准 3 × 10</button>
        <button class="stress-preset" type="button" data-stress-preset="8,24">高压 8 × 24</button>
      </div>
      <label class="field"><span>测试提示词 ${fieldInfo('每条请求都发同一句短提示词，避免提示词长度影响延迟对比。')}</span><input id="st-prompt" value="请只回复 OK。" maxlength="2000" ${canRun ? '' : 'disabled'} /></label>
      ${hintNote('压测说明', '压测会消耗真实 token 和模型算力，建议在低峰执行；关闭弹窗不会终止已经开始的压测。')}
      <div class="stress-run" id="st-run">
        <div class="stress-run-head">
          <strong id="st-status" aria-live="polite">尚未开始</strong>
          <span id="st-progress-text">0 / 0</span>
        </div>
        <div class="stress-progress-track" id="st-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="压测进度"><div class="stress-progress-fill" id="st-progress-fill"></div></div>
        <div class="stress-metrics">
          <div class="stress-metric"><span>成功 / 失败</span><strong id="st-success">—</strong><small>按已完成请求统计</small></div>
          <div class="stress-metric"><span>成功率</span><strong id="st-rate">—</strong><small>成功数 ÷ 已请求数</small></div>
          <div class="stress-metric"><span>p50</span><strong id="st-p50">—</strong><small>一半请求快于此</small></div>
          <div class="stress-metric"><span>p95</span><strong id="st-p95">—</strong><small>95% 请求快于此</small></div>
          <div class="stress-metric"><span>吞吐</span><strong id="st-rps">—</strong><small>条 / 秒</small></div>
          <div class="stress-metric"><span>总耗时</span><strong id="st-total">—</strong><small>从开始到结束</small></div>
        </div>
        <div class="stress-error-list" id="st-errors"></div>
      </div>
      <div class="modal-state" id="st-state" aria-live="polite"></div>
    </div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="st-run-btn"${canRun ? '' : ' disabled'}>开始压测</button>
      <button class="btn ghost" type="button" id="st-close">关闭</button>
    </div>`)
  const close = () => {
    if (timer) clearTimeout(timer)
    document.removeEventListener('keydown', onKey)
    overlay.remove()
    trigger?.focus?.()
  }
  const setBusy = (busy) => {
    running = busy
    for (const input of overlay.querySelectorAll('#st-concurrency, #st-requests, #st-prompt')) {
      input.disabled = busy || !canRun
    }
    for (const preset of overlay.querySelectorAll('[data-stress-preset]')) preset.disabled = busy || !canRun
    const runButton = overlay.querySelector('#st-run-btn')
    if (runButton) {
      runButton.disabled = busy || !canRun
      runButton.textContent = busy ? '压测中…' : jobId ? '重新压测' : '开始压测'
    }
  }
  const syncPresetActive = () => {
    const concurrency = Number(overlay.querySelector('#st-concurrency')?.value)
    const requests = Number(overlay.querySelector('#st-requests')?.value)
    for (const preset of overlay.querySelectorAll('[data-stress-preset]')) {
      preset.classList.toggle('is-active', preset.dataset.stressPreset === `${concurrency},${requests}`)
    }
  }
  const fill = (concurrency, requests) => {
    const concurrencyInput = overlay.querySelector('#st-concurrency')
    const requestsInput = overlay.querySelector('#st-requests')
    if (concurrencyInput) concurrencyInput.value = String(concurrency)
    if (requestsInput) requestsInput.value = String(requests)
    syncPresetActive()
  }
  for (const input of overlay.querySelectorAll('#st-concurrency, #st-requests')) {
    input.addEventListener('input', syncPresetActive)
  }
  for (const preset of overlay.querySelectorAll('[data-stress-preset]')) {
    preset.addEventListener('click', () => {
      if (running) return
      const [concurrency, requests] = preset.dataset.stressPreset.split(',').map(Number)
      fill(concurrency, requests)
    })
  }
  const render = (data) => {
    const completed = Number(data.completed || 0)
    const total = Number(data.total || 0)
    const percent = total ? Math.min(100, Math.max(0, (completed / total) * 100)) : 0
    const status = overlay.querySelector('#st-status')
    const statusText = data.running
      ? '压测中'
      : data.failed === 0
        ? '检测通过'
        : data.success === 0
          ? '连接失败'
          : '部分失败'
    status.textContent = statusText
    status.className = data.running ? 'is-running' : data.failed === 0 ? 'is-ok' : 'is-bad'
    overlay.querySelector('#st-progress-text').textContent = `${completed} / ${total}`
    overlay.querySelector('#st-progress-fill').style.width = `${percent}%`
    overlay.querySelector('#st-progress').setAttribute('aria-valuenow', String(Math.round(percent)))
    overlay.querySelector('#st-success').textContent = `${data.success} / ${data.failed}`
    overlay.querySelector('#st-rate').textContent = `${(Number(data.successRate || 0) * 100).toFixed(1)}%`
    overlay.querySelector('#st-p50').textContent = formatStressDuration(Number(data.latencyMs?.p50 || 0))
    overlay.querySelector('#st-p95').textContent = formatStressDuration(Number(data.latencyMs?.p95 || 0))
    overlay.querySelector('#st-rps').textContent = Number(data.throughputRps || 0).toFixed(2)
    overlay.querySelector('#st-total').textContent = formatStressDuration(Number(data.elapsedMs || 0))
    const errors = Array.isArray(data.errors) ? data.errors : []
    const errorList = overlay.querySelector('#st-errors')
    if (errors.length) {
      errorList.innerHTML = errors
        .map(
          (item) =>
            `<div class="stress-error-item"><span>第 ${Number(item.index) + 1} 次</span><strong>${esc(item.code || 'ERROR')}</strong><p>${esc(item.message || '调用失败')}</p><small>${formatStressDuration(Number(item.durationMs || 0))}</small></div>`,
        )
        .join('')
    } else if (!data.running && data.failed === 0) {
      errorList.innerHTML = '<p class="stress-success-note">全部请求成功，端点响应正常。</p>'
    } else {
      errorList.innerHTML = ''
    }
    const runBox = overlay.querySelector('#st-run')
    runBox.classList.toggle('is-running', Boolean(data.running))
    runBox.classList.toggle('is-ok', !data.running && data.failed === 0)
    runBox.classList.toggle('is-bad', !data.running && data.failed > 0)
  }
  const poll = async () => {
    if (!jobId) return
    try {
      const data = await api(`/api/console/model-stress-tests/${encodeURIComponent(jobId)}`)
      render(data)
      if (data.running) {
        timer = setTimeout(poll, 900)
      } else {
        timer = null
        setBusy(false)
        overlay.querySelector('#st-state').textContent = ''
      }
    } catch (err) {
      timer = null
      setBusy(false)
      overlay.querySelector('#st-state').textContent = err.message || '读取压测进度失败'
    }
  }
  const start = async () => {
    if (!canRun || running) return
    const concurrency = Math.min(20, Math.max(1, Math.trunc(Number(overlay.querySelector('#st-concurrency').value) || 3)))
    const requests = Math.min(100, Math.max(1, Math.trunc(Number(overlay.querySelector('#st-requests').value) || 10)))
    const prompt = overlay.querySelector('#st-prompt').value.trim() || '请只回复 OK。'
    setBusy(true)
    jobId = ''
    overlay.querySelector('#st-state').textContent = ''
    overlay.querySelector('#st-status').textContent = '准备请求…'
    overlay.querySelector('#st-status').className = 'is-running'
    overlay.querySelector('#st-progress-text').textContent = `0 / ${requests}`
    overlay.querySelector('#st-progress-fill').style.width = '0%'
    overlay.querySelector('#st-progress').setAttribute('aria-valuenow', '0')
    try {
      const data = await apiPost(`/api/console/models/${encodeURIComponent(model.id)}/stress-test`, {
        concurrency,
        requests,
        prompt,
      })
      jobId = data.jobId
      overlay.querySelector('#st-status').textContent = `正在跑 ${data.concurrency} 并发 × ${data.total} 次…`
      timer = setTimeout(poll, 600)
    } catch (err) {
      setBusy(false)
      overlay.querySelector('#st-state').textContent = err.message || '压测启动失败'
      overlay.querySelector('#st-status').textContent = '未开始'
      overlay.querySelector('#st-status').className = ''
    }
  }
  overlay.querySelector('#st-run-btn')?.addEventListener('click', start)
  overlay.querySelector('#st-close')?.addEventListener('click', close)
  overlay.querySelector('.modal-x')?.addEventListener('click', close)
  const onKey = (event) => {
    if (event.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  setTimeout(() => overlay.querySelector(canRun ? '#st-run-btn' : '#st-close')?.focus(), 0)
}

async function loadModels() {
  const view = $('#view')
  renderLoading(view)
  closeModelCapabilityPopover()
  setSide('', true)
  try {
    const [providerData, modelData, routeData] = await Promise.all([
      api('/api/console/providers'),
      api('/api/console/models'),
      api('/api/console/model-routes').catch(() => ({ routes: [] })),
    ])
    const providers = providerData.providers
    const models = modelData.models
    const roles = modelData.roles || []
    const enabledModels = models.filter((model) => model.enabled)
    const visionModels = models.filter((model) => {
      const caps = modelCapabilitySummary(model.tags)
      return caps.keys.includes('vision') || caps.keys.includes('multimodal')
    })
    const autoModel = enabledModels[0] || models[0] || null
    state.modelsFilter = state.modelsFilter || 'all'
    state.modelsSearch = state.modelsSearch || ''
    // 页头不再放“添加供应商 / 添加模型”：两个动作分别落在对应的功能区里，避免同一页出现重复入口。
    setPageActions('')

    const providerRows =
      providers
        .map(
          (provider) => `<tr>
            <td>
              <div class="models-provider-cell">
                <span class="models-provider-mark">${esc((provider.name || '?').slice(0, 1).toUpperCase())}</span>
                <div><strong>${esc(provider.name)}</strong><div class="desc">${esc(provider.kindLabel)}</div></div>
              </div>
            </td>
            <td class="mono models-endpoint">${esc(provider.baseUrl || '—')}</td>
            <td>${
              provider.apiKeyEnv
                ? `<span class="pill ${provider.keyPresent ? 'ok' : 'warn'}">${esc(provider.apiKeyEnv)} ${
                    provider.keyPresent ? '已注入' : '未注入'
                  }</span>`
                : '<span class="muted">不需要</span>'
            }</td>
            <td><span class="models-count">${provider.models}</span></td>
            <td><span class="pill ${provider.status === 'active' ? 'ok' : 'warn'}">${
              provider.status === 'active' ? '启用' : '停用'
            }</span></td>
            <td class="model-actions">
              <button class="btn sm model-action-btn" type="button" data-test="${esc(provider.id)}" data-tip="测试连接：用当前凭证请求一次供应商端点。" aria-label="测试连接">${modelActionIcon('test')}</button>
              ${
                provider.kind === 'demo' && !provider.baseUrl
                  ? ''
                  : `<button class="btn sm model-action-btn" type="button" data-discover-provider="${esc(provider.id)}" data-tip="检测模型：读取 /models 清单并导入。" aria-label="检测模型">${modelActionIcon('discover')}</button>`
              }
              <button class="btn sm model-action-btn" type="button" data-edit-provider="${esc(provider.id)}" data-tip="编辑供应商。" aria-label="编辑供应商">${modelActionIcon('edit')}</button>
              <button class="btn sm model-action-btn" type="button" data-toggle-provider="${esc(provider.id)}" data-tip="${provider.status === 'active' ? '停用供应商。' : '启用供应商。'}" aria-label="${provider.status === 'active' ? '停用供应商' : '启用供应商'}">${modelActionIcon('toggle')}</button>
              <button class="btn sm model-action-btn is-danger" type="button" data-del-provider="${esc(provider.id)}" data-tip="删除供应商及其下模型。" aria-label="删除供应商">${modelActionIcon('delete')}</button>
            </td>
          </tr>`,
        )
        .join('') || '<tr><td colspan="6" class="empty">还没有供应商，先接入一个端点</td></tr>'

    const routeItems = routeData?.routes ?? []
    const boundRouteCount = routeItems.filter((item) => item.boundModelId).length
    const routeRows = routeItems
      .map((item) => {
        const eligible = models.filter((model) => modelSupportsRoutePurpose(model, item.purpose))
        if (item.boundModelId && !eligible.some((model) => model.id === item.boundModelId)) {
          const bound = models.find((model) => model.id === item.boundModelId)
          if (bound) eligible.push(bound)
        }
        const options = eligible.length
          ? eligible
              .map(
                (model) =>
                  `<option value="${esc(model.id)}"${item.boundModelId === model.id ? ' selected' : ''}>${esc(
                    model.name,
                  )}${model.endpointKind ? ` · ${esc(model.endpointKind)}` : ''}</option>`,
              )
              .join('')
          : '<option value="" selected>没有匹配该用途的模型</option>'
        const selectHtml = eligible.length
          ? `<select data-route-purpose="${esc(item.purpose)}">
            <option value="">自动选择</option>
            ${options}
          </select>`
          : `<select data-route-purpose="${esc(item.purpose)}" disabled>${options}</select>`
        const stateText = item.boundModelId
          ? '已绑定'
          : item.effectiveModelId
            ? `自动：${item.effectiveModelName}`
            : '未配置 · 降级'
        const tone = item.boundModelId ? 'is-bound' : item.effectiveModelId ? 'is-fallback' : 'is-empty'
        return `<div class="models-route-row ${tone}" data-route-row="${esc(item.purpose)}">
          <div class="models-route-copy">
            <strong>${esc(item.label)}</strong>
            <span>${esc(item.hint)}</span>
            <code>${esc(item.purpose)}</code>
          </div>
          ${selectHtml}
          <span class="models-route-state">${esc(stateText)}</span>
        </div>`
      })
      .join('')

    const providerPanel = `
      <section class="panel models-panel" data-section-panel="providers">
        <div class="models-panel-head">
          <div>
            <h2>供应商与端点</h2>
            ${hintBadge('端点说明', '接入端点后会自动读取模型清单；读不到也可以手动添加模型。密钥只保存在服务端，不会回到浏览器。')}
          </div>
          <div class="models-panel-actions">
            <span class="models-panel-note">${providers.length} 个端点 · ${providers.filter((item) => item.status === 'active').length} 个启用</span>
            <button class="btn primary" type="button" id="add-provider">添加供应商</button>
          </div>
        </div>
        <div class="models-table-scroll">
          <table class="data models-provider-table">
            <thead><tr><th>供应商</th><th>端点</th><th>密钥</th><th>模型</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>${providerRows}</tbody>
          </table>
        </div>
        <div class="models-test-line" id="provider-test-msg"></div>
      </section>`

    const routePanel = `
      <section class="panel models-panel models-route-panel" data-section-panel="routes">
        <div class="models-panel-head">
          <div>
            <h2>用途路由 <span class="models-panel-count">${boundRouteCount}/${routeItems.length}</span></h2>
            ${hintBadge('路由说明', '把「这次要做什么」绑定到具体模型；留空则按能力和优先级自动挑。变更立即生效，未配置的用途会降级但不阻断现有对话。')}
          </div>
          <span class="models-panel-note">${routeItems.length ? '绑定后立即生效' : '迁移后可用'}</span>
        </div>
        <div class="models-route-list">${routeRows || '<div class="empty">还没有可路由的用途</div>'}</div>
      </section>`

    const catalogPanel = `
      <section class="panel models-panel models-catalog-panel" data-section-panel="catalog">
        <div class="models-panel-head">
          <div>
            <h2>模型目录 <span class="models-panel-count" id="model-count">${models.length}</span></h2>
            ${hintBadge('能力说明', '按能力管理模型：点击「能力」可直接勾选，保存后立即生效。')}
          </div>
          <div class="models-tools">
            <label class="models-search"><span aria-hidden="true">⌕</span><input id="model-search" type="search" value="${esc(state.modelsSearch)}" placeholder="搜索模型、标识或供应商" autocomplete="off" /></label>
            <button class="btn primary" type="button" id="add-model"${providers.length ? '' : ' disabled'}>添加模型</button>
          </div>
        </div>
        <div class="models-filter-bar" id="model-filter"></div>
        <div class="models-table-scroll models-catalog-scroll">
          <table class="data models-table">
            <thead><tr><th>模型</th><th>供应商</th><th>类型</th><th>上下文 / 输出</th><th>能力 / 擅长场景</th><th>可见角色</th><th>状态</th><th>操作</th></tr></thead>
            <tbody id="model-rows"></tbody>
          </table>
        </div>
      </section>`

    view.innerHTML = `
      <div class="models-overview">
        <div class="models-overview-copy">
          <span class="models-eyebrow">MODEL ROUTER</span>
          <strong>模型与路由，按任务分开管理 ${hintBadge('使用顺序', '先确认模型目录，再按任务绑定用途路由，最后核对供应商端点；密钥只保留在服务端。')}</strong>
        </div>
        <div class="models-summary">
          <div class="models-summary-card"><span>供应商</span><strong id="stat-providers">${providers.length}</strong><small>个端点</small></div>
          <div class="models-summary-card"><span>可用模型</span><strong id="stat-enabled">${enabledModels.length}</strong><small>/ ${models.length} 个 · 自动选择 ${esc(autoModel?.name || '—')}</small></div>
          <div class="models-summary-card ${visionModels.length ? 'is-highlight' : ''}"><span>图片识别</span><strong id="stat-vision">${visionModels.length}</strong><small id="stat-vision-note">${visionModels.length ? '工作台可直接粘贴图片' : '尚未标记视觉模型'}</small></div>
          <div class="models-summary-card"><span>模型类型</span><strong id="stat-type">${new Set(models.map((model) => modelTypeOf(model.tags).label)).size}</strong><small>按能力自动归类</small></div>
        </div>
      </div>

      ${sectionNavHtml(
        [
          { key: 'catalog', label: '模型目录', meta: `${models.length} 个模型` },
          {
            key: 'routes',
            label: '用途路由',
            meta: `${boundRouteCount}/${routeItems.length} 已绑定`,
            attention: boundRouteCount < routeItems.length,
          },
          { key: 'providers', label: '供应商与端点', meta: `${providers.length} 个端点` },
        ],
        state.modelsSection || 'catalog',
      )}
      <div class="section-panels">
        ${catalogPanel}
        ${routePanel}
        ${providerPanel}
      </div>`

    mountSectionNav(view, state.modelsSection, 'catalog', (key) => {
      state.modelsSection = key
    })

    const byId = new Map(providers.map((item) => [item.id, item]))
    const modelById = new Map(models.map((item) => [item.id, item]))
    const modelFilters = [
      { key: 'all', label: '全部' },
      { key: 'chat', label: '对话' },
      { key: 'decision', label: '决策 / 推理' },
      { key: 'vision', label: '多模态 / 视觉' },
      { key: 'embedding', label: '向量' },
      { key: 'code', label: '代码' },
      { key: 'audio', label: '语音' },
      { key: 'video', label: '视频' },
    ]
    const modelMatchesFilter = (model, filter) => {
      if (filter === 'all') return true
      const caps = modelCapabilitySummary(model.tags).keys
      if (filter === 'decision') return caps.includes('decision') || caps.includes('reasoning')
      if (filter === 'vision') return caps.includes('vision') || caps.includes('multimodal')
      return caps.includes(filter)
    }
    const tokenLimitLabel = (value) => {
      if (!value) return '—'
      return value >= 1024 ? `${Number((value / 1024).toFixed(1))}K` : String(value)
    }
    const modelRowHtml = (model) => {
      const caps = modelCapabilitySummary(model.tags)
      const type = modelTypeOf(model.tags)
      const roleChips = model.roles.length
        ? model.roles.length === roles.length
          ? '<span class="chip accent">全部角色</span>'
          : model.roles
              .slice(0, 2)
              .map((code) => `<span class="chip accent">${esc(ROLE_LABEL[code] || code)}</span>`)
              .join('') +
            (model.roles.length > 2 ? `<span class="models-role-more">+${model.roles.length - 2}</span>` : '')
        : '<span class="muted">未授权角色</span>'
      return `<tr data-model-row="${esc(model.id)}">
        <td>
          <div class="models-model-cell">
            <strong>${esc(model.name)}</strong>
            <span class="mono models-model-key">${esc(model.modelKey)}</span>
          </div>
        </td>
        <td>
          <span class="models-provider-pill">${esc(model.providerName)}</span>
          <div class="desc">${esc(model.providerKind)} · 优先级 ${model.priority}</div>
        </td>
        <td><span class="models-type-badge ${type.tone}">${esc(type.label)}</span></td>
        <td class="models-limits-cell">
          <span class="mono">${tokenLimitLabel(model.maxContext)}</span>
          <div class="desc">输出 ${model.maxOutputTokens ? tokenLimitLabel(model.maxOutputTokens) : '默认 4K'}</div>
        </td>
        <td>
          <button class="models-cap-trigger" type="button" data-cap-model="${esc(model.id)}" title="点击设置能力 / 擅长场景">
            ${capabilityChipsHtml(model.tags, 3)}
          </button>
        </td>
        <td class="models-roles-cell">${roleChips}</td>
        <td><span class="pill ${model.enabled ? 'ok' : 'warn'}">${model.enabled ? '启用' : '停用'}</span></td>
        <td class="model-actions">
          ${
            (model.endpointKind ?? 'chat') === 'chat'
              ? `<button class="btn sm model-action-btn" type="button" data-stress-model="${esc(model.id)}" data-tip="压测：直接调用真实模型，检查端点并发能力。" aria-label="压测">${modelActionIcon('stress')}</button>`
              : ''
          }
          <button class="btn sm model-action-btn" type="button" data-edit-model="${esc(model.id)}" data-tip="编辑模型。" aria-label="编辑模型">${modelActionIcon('edit')}</button>
          <button class="btn sm model-action-btn" type="button" data-toggle-model="${esc(model.id)}" data-tip="${model.enabled ? '停用模型。' : '启用模型。'}" aria-label="${model.enabled ? '停用模型' : '启用模型'}">${modelActionIcon('toggle')}</button>
          <button class="btn sm model-action-btn is-danger" type="button" data-del-model="${esc(model.id)}" data-tip="删除模型。" aria-label="删除模型">${modelActionIcon('delete')}</button>
        </td>
      </tr>`
    }
    const renderFilterChips = () => {
      const filterHtml = modelFilters
        .map((filter) => {
          const count = models.filter((model) => modelMatchesFilter(model, filter.key)).length
          return `<button class="models-filter ${state.modelsFilter === filter.key ? 'is-active' : ''}" type="button" data-model-filter="${filter.key}">
            ${filter.label}<span>${count}</span>
          </button>`
        })
        .join('')
      const filterBar = view.querySelector('#model-filter')
      if (filterBar) filterBar.innerHTML = filterHtml
    }
    const renderModelRows = () => {
      const rows = view.querySelector('#model-rows')
      if (!rows) return
      const query = String(state.modelsSearch || '').trim().toLowerCase()
      const visible = models.filter((model) => {
        if (!modelMatchesFilter(model, state.modelsFilter)) return false
        if (!query) return true
        const haystack = `${model.name} ${model.modelKey} ${model.providerName} ${modelCapabilitySummary(model.tags).labels.join(' ')}`.toLowerCase()
        return haystack.includes(query)
      })
      rows.innerHTML =
        visible.map(modelRowHtml).join('') ||
        `<tr><td colspan="8" class="empty models-empty">
          <strong>${query || state.modelsFilter !== 'all' ? '没有匹配的模型' : '还没有模型'}</strong>
          <span>${query || state.modelsFilter !== 'all' ? '换个关键词或筛选条件试试。' : '先添加一个模型；任意模型都可以接入，能力标签决定它能做什么。'}</span>
          ${
            query || state.modelsFilter !== 'all'
              ? '<button class="btn" type="button" data-clear-model-filter>清除筛选</button>'
              : providers.length
                ? '<button class="btn primary" type="button" data-empty-add-model>添加模型</button>'
                : ''
          }
        </td></tr>`
      const count = view.querySelector('#model-count')
      if (count) count.textContent = `${visible.length} / ${models.length}`
    }
    const updateModelStats = () => {
      const enabled = models.filter((model) => model.enabled).length
      const visual = models.filter((model) => {
        const caps = modelCapabilitySummary(model.tags).keys
        return caps.includes('vision') || caps.includes('multimodal')
      }).length
      view.querySelector('#stat-enabled')?.replaceChildren(document.createTextNode(String(enabled)))
      view.querySelector('#stat-vision')?.replaceChildren(document.createTextNode(String(visual)))
      const visionNote = view.querySelector('#stat-vision-note')
      if (visionNote) visionNote.textContent = visual ? '工作台可直接粘贴图片' : '尚未标记视觉模型'
      view.querySelector('#stat-type')?.replaceChildren(
        document.createTextNode(String(new Set(models.map((model) => modelTypeOf(model.tags).label)).size)),
      )
      const visualCard = view.querySelector('#stat-vision')?.closest('.models-summary-card')
      visualCard?.classList.toggle('is-highlight', visual > 0)
    }
    renderFilterChips()
    renderModelRows()

    view.querySelector('#add-provider')?.addEventListener('click', () => openProviderModal(null))
    view.querySelector('#add-model')?.addEventListener('click', () => openModelModal(null, providers, modelData.roles))
    for (const select of view.querySelectorAll('[data-route-purpose]')) {
      select.addEventListener('change', async () => {
        const row = select.closest('[data-route-row]')
        const stateEl = row?.querySelector('.models-route-state')
        if (stateEl) stateEl.textContent = '保存中…'
        try {
          const result = await apiSend('PUT', `/api/console/model-routes/${encodeURIComponent(select.dataset.routePurpose)}`, {
            modelId: select.value || null,
          })
          if (stateEl) {
            stateEl.textContent = result.boundModelId
              ? '已绑定'
              : result.effectiveModelName
                ? `自动：${result.effectiveModelName}`
                : '未配置 · 降级'
          }
        } catch (err) {
          if (stateEl) stateEl.textContent = '保存失败'
          alert(err.message || '用途路由保存失败')
        }
      })
    }
    view.querySelector('#model-search')?.addEventListener('input', (event) => {
      state.modelsSearch = event.target.value
      renderModelRows()
    })
    view.onclick = async (event) => {
      const filterButton = event.target.closest('[data-model-filter]')
      if (filterButton) {
        state.modelsFilter = filterButton.dataset.modelFilter
        renderFilterChips()
        renderModelRows()
        return
      }
      const clearFilter = event.target.closest('[data-clear-model-filter]')
      if (clearFilter) {
        state.modelsFilter = 'all'
        state.modelsSearch = ''
        const search = view.querySelector('#model-search')
        if (search) search.value = ''
        renderFilterChips()
        renderModelRows()
        return
      }
      if (event.target.closest('[data-empty-add-model]')) {
        openModelModal(null, providers, modelData.roles)
        return
      }
      const capButton = event.target.closest('[data-cap-model]')
      if (capButton) {
        const model = modelById.get(capButton.dataset.capModel)
        if (!model) return
        openModelCapabilityPopover(capButton, model, async (tags) => {
          await apiSend('PATCH', `/api/console/models/${encodeURIComponent(model.id)}`, { tags })
          model.tags = tags
          renderFilterChips()
          renderModelRows()
          updateModelStats()
        })
        return
      }
      const stressButton = event.target.closest('[data-stress-model]')
      if (stressButton) {
        const model = modelById.get(stressButton.dataset.stressModel)
        if (model) openModelStressModal(model, stressButton)
        return
      }
      const editButton = event.target.closest('[data-edit-model]')
      if (editButton) {
        openModelModal(modelById.get(editButton.dataset.editModel), providers, modelData.roles)
        return
      }
      const toggleButton = event.target.closest('[data-toggle-model]')
      if (toggleButton) {
        const model = modelById.get(toggleButton.dataset.toggleModel)
        if (!model) return
        try {
          await apiSend('PATCH', `/api/console/models/${encodeURIComponent(model.id)}`, { enabled: !model.enabled })
          loadModels()
        } catch (err) {
          alert(err.message || '保存失败')
        }
        return
      }
      const deleteButton = event.target.closest('[data-del-model]')
      if (deleteButton) {
        const model = modelById.get(deleteButton.dataset.delModel)
        if (!model) return
        const ok = await confirmCard({
          title: '删除模型？',
          message: `删除后「${model.name}」将不能再用于对话。`,
          confirmText: '删除模型',
        })
        if (!ok) return
        try {
          await apiSend('DELETE', `/api/console/models/${encodeURIComponent(model.id)}`)
          loadModels()
        } catch (err) {
          alert(err.message || '删除失败')
        }
      }
    }

    view.querySelectorAll('[data-edit-provider]').forEach((button) => {
      button.addEventListener('click', () => openProviderModal(byId.get(button.dataset.editProvider)))
    })
    view.querySelectorAll('[data-test]').forEach((button) => {
      button.addEventListener('click', async () => {
        const msg = $('#provider-test-msg')
        if (msg) msg.textContent = '测试中…'
        try {
          const result = await apiPost(`/api/console/providers/${encodeURIComponent(button.dataset.test)}/test`)
          if (msg) msg.textContent = `${result.ok ? '✓' : '✗'} ${result.message}`
        } catch (err) {
          if (msg) msg.textContent = err.message || '测试失败'
        }
      })
    })
    view.querySelectorAll('[data-discover-provider]').forEach((button) => {
      button.addEventListener('click', () => discoverProviderModels(byId.get(button.dataset.discoverProvider)))
    })
    view.querySelectorAll('[data-toggle-provider]').forEach((button) => {
      button.addEventListener('click', async () => {
        const provider = byId.get(button.dataset.toggleProvider)
        await apiSend('PATCH', `/api/console/providers/${encodeURIComponent(provider.id)}`, {
          status: provider.status === 'active' ? 'disabled' : 'active',
        })
        loadModels()
      })
    })
    view.querySelectorAll('[data-del-provider]').forEach((button) => {
      button.addEventListener('click', async () => {
        const ok = await confirmCard({
          title: '删除供应商？',
          message: '如果这个供应商下面还有模型，服务端会拒绝删除。',
          confirmText: '删除供应商',
        })
        if (!ok) return
        try {
          await apiSend('DELETE', `/api/console/providers/${encodeURIComponent(button.dataset.delProvider)}`)
          loadModels()
        } catch (err) {
          alert(err.message || '删除失败')
        }
      })
    })
  } catch (err) {
    renderDenied(view, err)
  }
}

async function loadMatrix() {
  const view = $('#view')
  renderLoading(view)
  try {
    const data = await api('/api/dev/kb-matrix')
    const head = `<tr><th>成员</th>${data.collections.map((c) => `<th>${esc(c.name)}</th>`).join('')}</tr>`
    const body = data.personas
      .map((person) => {
        const cells = data.collections
          .map((collection) =>
            person.visibleIds.includes(collection.id)
              ? '<td class="cell-yes">✓</td>'
              : '<td class="cell-no">—</td>',
          )
          .join('')
        const score = person.blocked
          ? '<span class="badge deny">缺 kb:read</span>'
          : `<span class="matrix-score">${person.visibleCount} / ${data.collections.length}</span>`
        return `<tr><td class="name-cell"><strong>${esc(person.name)} ${score}</strong><div class="desc">${esc(
          person.deptName,
        )} · ${(person.roles || []).map((r) => ROLE_LABEL[r] || r).join('/')}</div></td>${cells}</tr>`
      })
      .join('')

    view.innerHTML = `
      <div class="panel">
        <div class="panel-head">
          <h2>知识库可见性核对</h2>
          ${hintBadge('核对说明', '按同一套 ACL 把每个成员重算一遍，用来核对配置结果。')}
        </div>
        <div class="matrix-wrap"><table class="data matrix"><thead>${head}</thead><tbody>${body}</tbody></table></div>
        <div class="legend"><span class="cell-yes">✓</span> 可见 <span class="cell-no">—</span> 不可见 ${hintBadge('图例说明', '同行「缺 kb:read」表示该身份连检索权限都没有，一个库也进不来。')}</div>
      </div>`

    const me = state.me
    setSide(`
      <div class="side-head">本页用途 ${hintBadge('用途说明', '把成员、角色与知识库可见范围放在一张表里核对，不再挨个点开猜。')}</div>
      <div class="side-head">配置顺序 ${hintBadge('配置顺序', '先在「角色权限」给角色配权限点，再到「知识库」设可见范围，最后回这里核对结果。')}</div>
      <div class="side-head">图例</div>
      <div class="legend-box">
        <div><span class="cell-yes">✓</span> 该成员可读</div>
        <div><span class="cell-no">—</span> 不可读</div>
        <div><span class="pill danger">缺 kb:read</span> 没有知识库读取权限</div>
      </div>
      <div class="side-foot">${esc(me && me.company ? me.company.name : '—')} ${hintBadge('核对范围', '仅服务器侧核对使用，成员看不到这张矩阵。')}</div>`)
  } catch (err) {
    setSide('', true)
    if (err.status === 404) {
      view.innerHTML = `
        <section class="panel">
          <div class="panel-head">
            <div><h2>权限矩阵当前未开放 ${hintBadge('未开放原因', '该页调用开发态核对接口；当前部署没有开启开发身份（devAuth）。')}</h2></div>
          </div>
          <div class="muted" style="padding:0 2px">日常授权请以「角色权限」和「知识库 · 可见范围」为准。</div>
        </section>`
      return
    }
    renderDenied(view, err)
  }
}

/* ---------------- 系统 ---------------- */

async function loadSys() {
  const view = $('#view')
  renderLoading(view)
  setSide('', true)
  try {
    const health = await api('/api/health')
    const settings = await api('/api/console/settings').catch(() => null)
    const update = await api('/api/console/update').catch(() => null)
    const concurrency = await api('/api/console/concurrency').catch(() => null)
    const agentRuns = await api('/api/console/agent-runs?limit=50').catch(() => null)
    const cap = concurrency?.chat ?? null
    const toolStats = concurrency?.tools ?? null
    const pluginStats = concurrency?.plugins ?? null
    const toolRows = (() => {
      const rows = new Map()
      for (const row of toolStats?.keys ?? []) {
        rows.set(row.key, { toolId: row.key, active: row.active, queued: row.queued, runs: 0, failures: 0, avgDurationMs: 0 })
      }
      for (const metric of toolStats?.byTool ?? []) {
        const row = rows.get(metric.toolId) ?? { toolId: metric.toolId, active: 0, queued: 0 }
        rows.set(metric.toolId, {
          ...row,
          runs: metric.runs,
          failures: metric.failures,
          avgDurationMs: metric.avgDurationMs,
        })
      }
      return [...rows.values()].sort((a, b) => b.active + b.queued - (a.active + a.queued))
    })()
    const network = settings?.network ?? {
      host: health.host ?? '127.0.0.1',
      chatPort: health.chatPort ?? 8787,
      adminPort: health.adminPort ?? 8788,
      allowRemoteConsole: Boolean(health.allowRemoteConsole),
      envLocked: { host: false, chatPort: false, adminPort: false, allowRemoteConsole: false },
      localAddresses: [],
    }
    const locked = network.envLocked ?? {}
    const retentionDays = settings?.retentionDays ?? 90
    const auditRetentionDays = settings?.auditRetentionDays ?? 180
    const logs = settings?.logs ?? {}
    const storageRows = settings?.storage?.rows ?? []
    const storagePending = settings?.storage?.pendingMigrations ?? []
    const cleanupText = settings?.lastCleanupAt
      ? new Date(settings.lastCleanupAt).toLocaleString('zh-CN')
      : '还没有清理记录'
    view.innerHTML = `
      ${sectionNavHtml(
        [
          { key: 'runtime', label: '运行与准入', meta: '服务状态 · 安全边界' },
          { key: 'concurrency', label: '并发与队列', meta: '对话 · 模型 · 工具 · 插件' },
          { key: 'agents', label: 'Agent 运行树', meta: '父任务 · 子 Agent · 工具轨迹' },
          { key: 'company', label: '公司设置', meta: '名称 · 启停 · 删除' },
          { key: 'data', label: '数据与运维', meta: '目录 · 日志 · 备份' },
        ],
        state.systemSection || 'runtime',
      )}
      <div class="section-panels">
      <section class="panel" data-section-panel="runtime">
        <div class="panel-head"><div><h2>运行状态</h2>${hintBadge('运行说明', '本机服务与版本；网络设置保存后即时生效，监听地址与端口会自动切换，不用重启服务。')}${hintBadge('部署说明', '这是只给部署方看的运行视图；组织成员不会进入控制台。监听地址与端口可在「网络与访问入口」保存，环境变量优先。')}</div></div>
        <div class="kv-grid">
          <div><span>服务</span><strong>正常运行</strong></div>
          <div><span>版本</span><strong class="mono">v${esc(health.version)}</strong></div>
          <div><span>运行时长</span><strong>${Math.floor(Number(health.uptimeSec) / 60)} 分 ${Number(health.uptimeSec) % 60} 秒</strong></div>
          <div><span>监听地址</span><strong class="mono">${esc(network.host)}:${esc(String(network.chatPort))}</strong></div>
          <div><span>当前公司</span><strong>${esc(state.me?.company?.name ?? '—')}</strong></div>
          <div><span>开发身份切换</span><strong>${health.devAuth ? '<span class="pill warn">开启</span>' : '<span class="pill ok">关闭</span>'}</strong></div>
        </div>
      </section>
      <section class="panel" data-section-panel="concurrency">
        <div class="panel-head">
          <div><h2>并发与队列</h2>${hintBadge('并发说明', '对话 / 模型 / 工具 / 插件四级闸门；数字是当前进程的实时值。')}</div>
          <div class="panel-actions">
            <span class="pill ${(cap?.queued ?? 0) + (toolStats?.queued ?? 0) + (pluginStats?.queued ?? 0) > 0 ? 'warn' : 'ok'}">
              ${(cap?.queued ?? 0) + (toolStats?.queued ?? 0) + (pluginStats?.queued ?? 0) > 0 ? '有请求排队' : '当前无排队'}
            </span>
            <button class="btn sm ghost" type="button" id="concurrency-refresh">刷新</button>
          </div>
        </div>
        <div class="kv-grid kv-2">
          <div><span>对话在生成</span><strong>${cap?.active ?? 0} / ${cap?.limits?.maxConcurrent ?? 8}<span class="desc" style="display:block;font-weight:400">公司上限 ${cap?.limits?.companyMaxConcurrent ?? 8} · 模型上限 ${cap?.limits?.modelMaxConcurrent ?? 4}</span></strong></div>
          <div><span>对话排队</span><strong>${cap?.queued ?? 0}<span class="desc" style="display:block;font-weight:400">队列上限 ${cap?.limits?.queueLimit ?? 100}</span></strong></div>
          <div><span>工具在执行 / 排队</span><strong>${toolStats?.active ?? 0} / ${toolStats?.queued ?? 0}<span class="desc" style="display:block;font-weight:400">单工具上限 ${toolStats?.limits?.maxConcurrent ?? 8}</span></strong></div>
          <div><span>插件工具在执行 / 排队</span><strong>${pluginStats?.active ?? 0} / ${pluginStats?.queued ?? 0}<span class="desc" style="display:block;font-weight:400">单插件上限 ${pluginStats?.limits?.maxConcurrent ?? 4}</span></strong></div>
          <div><span>工具执行次数</span><strong>${fmtNum(toolStats?.runs ?? 0)}<span class="desc" style="display:block;font-weight:400">失败 ${fmtNum(toolStats?.failures ?? 0)}</span></strong></div>
          <div><span>SQLITE_BUSY</span><strong>${fmtNum(concurrency?.sqlite?.busyTotal ?? 0)}<span class="desc" style="display:block;font-weight:400">写事务抢锁次数</span></strong></div>
        </div>
        <div class="table-scroll" style="margin-top:14px">
          <table class="data">
            <thead><tr><th>模型</th><th>正在生成</th><th>排队</th></tr></thead>
            <tbody>
              ${(cap?.models ?? []).length
                ? (cap?.models ?? []).map((row) => `<tr><td class="mono">${esc(row.modelId)}</td><td>${row.active}</td><td>${row.queued}</td></tr>`).join('')
                : '<tr><td colspan="3" class="muted">当前没有正在生成的模型</td></tr>'}
            </tbody>
          </table>
        </div>
        <div class="table-scroll" style="margin-top:12px">
          <table class="data">
            <thead><tr><th>工具</th><th>正在执行</th><th>排队</th><th>累计次数</th><th>失败</th><th>平均耗时</th></tr></thead>
            <tbody>
              ${toolRows.length
                ? toolRows.map((row) => `<tr><td class="mono">${esc(row.toolId)}</td><td>${row.active}</td><td>${row.queued}</td><td>${fmtNum(row.runs)}</td><td>${fmtNum(row.failures)}</td><td>${row.avgDurationMs} ms</td></tr>`).join('')
                : '<tr><td colspan="6" class="muted">还没有工具执行记录</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
      <section class="panel" data-section-panel="agents">
        <div class="panel-head">
          <div><h2>Agent 运行树</h2>${hintBadge('运行树说明', '父任务和 agent.spawn 派生的子 Agent；点开「步骤」看每个子 Agent 的工具轨迹。')}</div>
          <div class="panel-actions">
            <span class="pill ${(agentRuns?.active ?? 0) > 0 ? 'warn' : 'ok'}">${(agentRuns?.active ?? 0) > 0 ? `运行中 ${agentRuns.active}` : '无运行中任务'}</span>
            <button class="btn sm ghost" type="button" id="agents-refresh">刷新</button>
          </div>
        </div>
        <div class="table-scroll">
          <table class="data">
            <thead><tr><th>任务 / Agent</th><th>模型</th><th>状态</th><th>耗时</th><th>步骤</th><th>工具轨迹</th></tr></thead>
            <tbody>
              ${(agentRuns?.runs ?? []).length
                ? (agentRuns.runs).map((row) => {
                  const duration = Math.max(0, Math.round(((row.endedAt ?? Date.now()) - row.startedAt) / 1000))
                  const statusClass = row.status === 'succeeded' ? 'ok' : row.status === 'failed' ? 'warn' : row.status === 'cancelled' ? 'warn' : 'warn'
                  const statusText = row.status === 'succeeded' ? '成功' : row.status === 'failed' ? '失败' : row.status === 'cancelled' ? '已取消' : '运行中'
                  const steps = row.steps ?? []
                  return `<tr>
                    <td><span style="padding-left:${row.depth * 16}px">${row.depth ? '↳ ' : ''}${esc(row.title ?? row.agentId)}</span><div class="desc">${esc(row.id.slice(0, 8))} · ${esc(row.agentId)}</div></td>
                    <td class="mono">${esc(row.modelId ?? '—')}</td>
                    <td><span class="pill ${statusClass}">${statusText}</span></td>
                    <td>${duration} 秒</td>
                    <td>${steps.length}</td>
                    <td>${steps.length ? `<details><summary>${steps.length} 步</summary><div style="margin-top:6px">${steps.map((step) => `<div style="margin-bottom:6px">${step.seq + 1}. ${esc(step.name ?? step.toolId ?? step.kind)} · ${esc(step.status)} · ${step.durationMs} ms${step.resultSummary ? `<div class="desc">${esc(step.resultSummary)}</div>` : ''}</div>`).join('')}</div></details>` : '<span class="muted">暂无步骤</span>'}</td>
                  </tr>`
                }).join('')
                : '<tr><td colspan="6" class="muted">还没有 Agent 运行记录；发起一次对话后这里会出现根任务和子 Agent</td></tr>'}
            </tbody>
          </table>
        </div>
        ${hintNote('隔离说明', '子 Agent 使用独立 runId 和独立会话锁；父任务取消会级联取消子任务。共享云空间文件仍由 P0-1 的资源锁串行化。')}
      </section>
      <section class="panel" data-section-panel="runtime">
        <div class="panel-head">
          <div><h2>网络与访问入口</h2>${hintBadge('端口说明', '局域网开关切换即生效；监听地址与端口保存后自动重建监听，不用重启服务。本机访问填 127.0.0.1；局域网访问填 0.0.0.0，并确认服务器防火墙已放行两个端口。环境变量 EAB_HOST / EAB_PORT / EAB_ADMIN_PORT 优先于这里。')}</div>
          <span class="pill ${network.allowRemoteConsole ? 'warn' : 'ok'}" id="net-access-pill">${network.allowRemoteConsole ? '允许局域网登录控制台' : '控制台仅本机登录'}</span>
        </div>
        <div class="kv-grid kv-2">
          <div><span>当前监听地址</span><strong class="mono">${esc(network.host)}:${esc(String(network.chatPort))}</strong></div>
          <div><span>员工对话</span><strong class="mono">http://${esc(network.host)}:${esc(String(network.chatPort))}/chat</strong></div>
          <div><span>管理控制台</span><strong class="mono">http://${esc(network.host)}:${esc(String(network.adminPort))}/admin</strong></div>
          <div><span>本机局域网 IP</span><strong class="mono">${esc((network.localAddresses || []).join(' / ') || '未检测到')}</strong></div>
        </div>
        <div class="net-access">
          <div class="net-access-copy">
            <span class="net-access-kicker">控制台访问范围</span>
            <strong id="net-access-title">${network.allowRemoteConsole ? '局域网内可登录控制台' : '仅服务器本机能登录控制台'}</strong>
            <span class="net-access-state" id="net-access-state">${locked.allowRemoteConsole ? '由 EAB_CONSOLE_ALLOW_REMOTE 固定，需改环境变量' : '切换后立即生效'}</span>
          </div>
          <label class="net-switch${locked.allowRemoteConsole ? ' is-locked' : ''}">
            <input id="net-remote" type="checkbox"${network.allowRemoteConsole ? ' checked' : ''} ${locked.allowRemoteConsole ? 'disabled' : ''} />
            <span class="net-switch-track"><span class="net-switch-thumb"></span></span>
            <span class="net-switch-text">允许局域网登录</span>
          </label>
        </div>
        <div class="net-listen-head">
          <strong>监听地址与端口</strong>
          <span>保存后自动切换监听，不用重启</span>
        </div>
        <div class="form-grid net-form">
          <label class="field"><span>监听地址</span>
            <input id="net-host" value="${esc(network.host)}" placeholder="127.0.0.1 或 0.0.0.0" ${locked.host ? 'disabled' : ''} />
          </label>
          <label class="field"><span>员工对话端口</span>
            <input id="net-chat-port" type="number" min="1" max="65535" value="${esc(String(network.chatPort))}" ${locked.chatPort ? 'disabled' : ''} />
          </label>
          <label class="field"><span>管理控制台端口</span>
            <input id="net-admin-port" type="number" min="1" max="65535" value="${esc(String(network.adminPort))}" ${locked.adminPort ? 'disabled' : ''} />
          </label>
          <div class="panel-actions net-actions">
            <button class="btn sm primary" type="button" id="net-save" ${locked.host && locked.chatPort && locked.adminPort ? 'disabled' : ''}>保存并切换</button>
          </div>
        </div>
        <div class="inline-note" id="net-state" style="margin-top:10px"></div>
      </section>
      <section class="panel" data-section-panel="data">
        <div class="panel-head">
          <div><h2>版本更新</h2>${hintBadge('更新说明', '从 GitHub Release 检测新版本；确认后由更新器替换代码并重启。命令行方式：eab update（检测） / eab update --apply（确认更新）。更新会先备份当前代码；数据目录 .eab-dev 不会被替换。')}</div>
          <span class="pill ${update?.hasUpdate ? 'warn' : 'ok'}">${update?.hasUpdate ? '发现新版本' : update?.latest ? '已是最新' : '尚未检查'}</span>
        </div>
        <div class="kv-grid kv-2">
          <div><span>当前版本</span><strong class="mono">v${esc(update?.current ?? health.version ?? '—')}</strong></div>
          <div><span>最新版本</span><strong class="mono">${esc(update?.latest ? `v${update.latest}` : '尚未检查')}</strong></div>
          <div><span>上次检查</span><strong>${esc(update?.checkedAt ? new Date(update.checkedAt).toLocaleString('zh-CN') : '—')}</strong></div>
          <div><span>更新来源</span><strong class="mono">GitHub · Jydsh/EAB</strong></div>
        </div>
        ${update?.error ? `<div class="inline-note bad-text" style="margin-top:10px">${esc(update.error)}</div>` : ''}
        <div class="panel-actions" style="margin-top:12px">
          <button class="btn sm ghost" type="button" id="update-check">检查更新</button>
          <button class="btn sm primary" type="button" id="update-apply" ${update?.hasUpdate && update?.sourceUrl ? '' : 'disabled'}>一键更新</button>
          <button class="btn sm ghost" type="button" id="update-copy">复制命令</button>
        </div>
        <div class="inline-note" id="update-state" style="margin-top:10px"></div>
      </section>
      <section class="panel" data-section-panel="company">
        <div class="panel-head"><div><h2>公司信息</h2>${hintBadge('公司范围', '单公司实例：只此一家，ID 固定；改名会同步根部门与成员部门显示。')}</div></div>
        <div class="form-grid" style="align-items:end">
          <label class="field"><span>公司名称</span><input id="company-name-input" value="${esc(state.companies[0]?.name ?? '')}" maxlength="80" /></label>
          <div class="panel-actions" style="align-self:end">
            <button class="btn sm primary" type="button" id="company-rename">保存名称</button>
            <button class="btn sm ghost" type="button" id="company-toggle">${state.companies[0]?.status === 'suspended' ? '恢复启用' : '停用公司'}</button>
            <button class="btn sm ghost danger" type="button" id="company-delete">删除公司</button>
          </div>
        </div>
      </section>
      <section class="panel" data-section-panel="runtime">
        <div class="panel-head"><div><h2>准入与安全</h2>${hintBadge('准入说明', '控制台不是员工入口，只有服务器本机或部署方账号能进；远程访问需部署侧显式开启。')}</div></div>
        <div class="kv-grid">
          <div><span>登录账号</span><strong class="mono">admin</strong></div>
          <div><span>登录方式</span><strong>超级管理员账号 + 密码</strong></div>
          <div><span>网络限制</span><strong>默认仅 127.0.0.1</strong></div>
          <div><span>管理员凭据</span><strong class="mono">.eab-dev/admin-credentials.txt</strong></div>
          <div><span>模型密钥</span><strong class="mono">.eab-dev/secrets.json</strong></div>
          <div><span>远程访问</span><strong>需部署侧显式开启</strong></div>
        </div>
      </section>
      <section class="panel" data-section-panel="data">
        <div class="panel-head">
          <div><h2>存储位置</h2>${hintBadge('路径规则', '每个分类都可以单独指定绝对路径；没单独配置时跟随总存储位置。保存后重启，启动时先把旧目录复制到新目录并校验，成功后才切换，旧目录保留。目标目录已有数据时不会自动覆盖。')}</div>
          <span class="pill ${storagePending.length > 0 ? 'warn' : 'ok'}">${storagePending.length > 0 ? '待重启迁移' : '可在控制台调整'}</span>
        </div>
        <div class="storage-rows" id="storage-rows">
          ${storageRows.map((row) => `
            <div class="storage-row" data-storage-key="${esc(row.key)}">
              <div class="storage-meta">
                <span class="storage-label">${esc(row.label)}</span>
                <span class="pill ${row.source === '独立配置' ? 'accent' : ''}">${row.locked ? '由环境变量固定' : esc(row.source)}</span>
              </div>
              <div class="storage-current">
                <span class="desc">当前</span>
                <strong class="mono">${esc(row.path || '—')}</strong>
                ${row.key === 'database' ? '<span class="desc">eab.db、密钥与管理凭据所在目录</span>' : ''}
                ${row.key === 'dataDir' && settings?.dbPath ? `<span class="desc">数据库 ${esc(settings.dbPath)}</span>` : ''}
              </div>
              <div class="storage-edit">
                <input id="storage-input-${esc(row.key)}" placeholder="新绝对路径，例如 E:\\EABData\\${esc(row.key === 'dataDir' ? '' : row.key)}" ${row.locked ? 'disabled' : ''} />
                <button class="btn sm primary" type="button" data-storage-save ${row.locked ? 'disabled' : ''}>保存</button>
                <button class="btn sm ghost" type="button" data-storage-reset ${row.locked ? 'disabled' : ''}>${row.key === 'dataDir' ? '恢复部署默认' : '跟随总位置'}</button>
              </div>
            </div>`).join('')}
        </div>
        <div class="inline-note" id="storage-state" style="margin-top:10px">${storagePending.length > 0 ? `待迁移：${storagePending.map((job) => `${esc(job.from)} → ${esc(job.to)}`).join('；')}` : '所有分类当前都按上面的路径生效'}</div>
      </section>
      <section class="panel" data-section-panel="data">
        <div class="panel-head">
          <div><h2>日志与审计保留</h2>${hintBadge('清理说明', '同步记录、渠道事件、登录失败、插件事件按日志保留天数清理；审计按独立天数，只从最老一端连续删除，被删段最后一行会留作链锚点，所以清理本身不会造成断链。后台每 6 小时检查一次。')}</div>
          <span class="pill">日志 ${retentionDays > 0 ? `${retentionDays} 天` : '永久'} · 审计 ${auditRetentionDays > 0 ? `${auditRetentionDays} 天` : '永久'}</span>
        </div>
        <div class="kv-grid">
          <div><span>同步记录</span><strong>${fmtNum(logs.syncRuns ?? 0)} 条<span class="desc">差异 ${fmtNum(logs.syncDiffs ?? 0)} 条</span></strong></div>
          <div><span>渠道事件</span><strong>${fmtNum(logs.channelEvents ?? 0)} 条</strong></div>
          <div><span>登录失败计数</span><strong>${fmtNum(logs.loginAttempts ?? 0)} 条</strong></div>
          <div><span>插件 / 扫码事件</span><strong>${fmtNum((logs.pluginEvents ?? 0) + (logs.onboardAttempts ?? 0))} 条</strong></div>
          <div><span>上次清理</span><strong>${esc(cleanupText)}</strong></div>
          <div><span>审计日志</span><strong>${fmtNum(logs.auditLogs ?? 0)} 条 ${hintBadge('审计保留', auditRetentionDays > 0 ? `超过 ${auditRetentionDays} 天自动清理；只删最老一段，保留链锚点，不会因清理断链。` : '审计日志永久保留，不自动清理。')}</strong></div>
        </div>
        <div class="form-grid" style="align-items:end;margin-top:14px">
          <label class="field"><span>日志保留天数（0 = 永久保留）</span>
            <input id="retention-input" type="number" min="0" max="3650" value="${retentionDays}" />
          </label>
          <label class="field"><span>审计保留天数（0 = 永久保留）</span>
            <input id="audit-retention-input" type="number" min="0" max="3650" value="${auditRetentionDays}" />
          </label>
          <div class="panel-actions" style="align-self:end">
            <button class="btn sm primary" type="button" id="retention-save">保存策略</button>
            <button class="btn sm ghost" type="button" id="retention-run">立即清理一次</button>
          </div>
        </div>
        <div class="inline-note" id="retention-state" style="margin-top:10px"></div>
      </section>
      <section class="panel" data-section-panel="runtime">
        <div class="panel-head"><div><h2>配置边界</h2>${hintBadge('边界说明', '哪些东西在这里配，哪些不在这里配；进程托管、日志级别、环境变量与防火墙属于部署侧。')}</div></div>
        <div class="mini-list">
          <div class="mini-row"><span>在这里配置</span><div><span class="chip accent">组织与成员</span><span class="chip accent">角色权限</span><span class="chip accent">知识库</span><span class="chip accent">模型供应商</span><span class="chip accent">渠道凭证</span><span class="chip accent">插件</span></div></div>
          <div class="mini-row"><span>不在这里配置</span><div><span class="chip">进程托管</span><span class="chip">日志级别</span><span class="chip">环境变量 EAB_DB</span><span class="chip">防火墙</span></div></div>
        </div>
      </section>
      </div>`
    view.querySelector('.section-panels')?.insertAdjacentHTML(
      'beforeend',
      `<section class="panel" data-section-panel="data">
        <div class="panel-head"><div><h2>平台与运维</h2>${hintBadge('运维说明', '数据库备份；渠道绑定已统一到「连接与平台 → 渠道 → 企业一键绑定」。')}</div>
          <div class="panel-actions">
            <button class="btn sm ghost" type="button" id="backup-now">立即备份</button>
          </div>
        </div>
        <div id="backup-list" class="mini-list"><div class="mini-row"><span>备份</span><div class="muted">加载中…</div></div></div>
      </section>`,
    )
    mountSectionNav(view, state.systemSection, 'runtime', (key) => {
      state.systemSection = key
    })
    const concurrencyRefresh = $('#concurrency-refresh')
    if (concurrencyRefresh) {
      concurrencyRefresh.addEventListener('click', () => PAGES.system.render())
    }
    const agentsRefresh = $('#agents-refresh')
    if (agentsRefresh) {
      agentsRefresh.addEventListener('click', () => PAGES.system.render())
    }
    const companyOnboard = $('#company-onboard')
    if (companyOnboard) companyOnboard.remove()

    const companyRename = $('#company-rename')
    if (companyRename) {
      companyRename.addEventListener('click', async () => {
        const name = String($('#company-name-input')?.value ?? '').trim()
        if (!name) return alert('公司名称不能为空')
        try {
          await apiSend('PATCH', `/api/console/companies/${encodeURIComponent(state.company)}`, { name })
          await loadMe()
          await loadCompanies()
          PAGES.system.render()
        } catch (err) {
          alert(err.message)
        }
      })
    }
    const companyToggle = $('#company-toggle')
    if (companyToggle) {
      companyToggle.addEventListener('click', async () => {
        const current = state.companies[0]?.status === 'suspended'
        const next = current ? 'active' : 'suspended'
        if (next === 'suspended') {
          const ok = await confirmCard({
            title: '停用公司？',
            message: '停用后所有员工将立即无法登录；控制台仍可恢复。',
            confirmText: '停用公司',
            tone: 'warning',
          })
          if (!ok) return
        }
        try {
          await apiSend('PATCH', `/api/console/companies/${encodeURIComponent(state.company)}`, { status: next })
          await loadCompanies()
          PAGES.system.render()
        } catch (err) {
          alert(err.message)
        }
      })
    }
    const companyDelete = $('#company-delete')
    if (companyDelete) {
      companyDelete.addEventListener('click', async () => {
        const name = state.companies[0]?.name ?? ''
        const ok = await confirmCard({
          title: '删除公司？',
          message: `删除「${name}」会清空全部数据，且不可恢复。`,
          detail: '包括部门、成员、角色、知识库、模型、渠道、会话和审计数据。',
          requireText: name,
          requireHint: `请输入公司名称「${name}」确认`,
          confirmText: '删除公司',
        })
        if (!ok) return
        try {
          await apiSend('DELETE', `/api/console/companies/${encodeURIComponent(state.company)}`)
          alert('公司及其全部数据已删除。可以到「连接与平台 → 渠道」用「钉钉扫码绑定」重新接入一家公司。')
          location.reload()
        } catch (err) {
          alert(err.message)
        }
      })
    }
    const backupNow = $('#backup-now')
    if (backupNow) {
      backupNow.addEventListener('click', async () => {
        try {
          const result = await apiPost('/api/console/backups', {})
          alert(`备份完成：${result.file}（${(result.size / 1024 / 1024).toFixed(1)} MB）`)
          refreshBackups()
        } catch (err) {
          alert(err.message)
        }
      })
    }
    async function refreshBackups() {
      const box = $('#backup-list')
      if (!box) return
      try {
        const data = await api('/api/console/backups')
        box.innerHTML = data.items.length
          ? data.items
              .slice(0, 6)
              .map(
                (item) =>
                  `<div class="mini-row backup-row">
                    <span class="mono backup-name">${esc(item.name)}</span>
                    <div class="backup-meta">
                      <span class="backup-stamp">${(item.size / 1024 / 1024).toFixed(2)} MB · ${esc(new Date(item.createdAt).toLocaleString())}</span>
                      <div class="backup-actions">
                        <button class="btn sm ghost" type="button" data-reveal-backup="${esc(item.name)}" title="在服务器所在电脑上打开该备份所在目录">打开文件位置</button>
                        <button class="btn sm ghost danger" type="button" data-del-backup="${esc(item.name)}">删除</button>
                      </div>
                    </div>
                  </div>`,
              )
              .join('')
          : '<div class="mini-row"><span>备份</span><div class="muted">还没有备份。点「立即备份」生成一个 SQLite 快照。</div></div>'
        for (const button of box.querySelectorAll('[data-reveal-backup]')) {
          button.addEventListener('click', async () => {
            button.disabled = true
            try {
              const result = await apiPost(`/api/console/backups/${encodeURIComponent(button.dataset.revealBackup)}/reveal`, {})
              if (!result.opened) alert(`无法自动打开资源管理器；备份在服务器上的路径：\n${result.file}`)
            } catch (err) {
              alert(err.message)
            } finally {
              button.disabled = false
            }
          })
        }
        for (const button of box.querySelectorAll('[data-del-backup]')) {
          button.addEventListener('click', async () => {
            const name = button.dataset.delBackup
            if (!confirm(`删除备份 ${name}？删除后无法恢复。`)) return
            button.disabled = true
            try {
              await apiSend('DELETE', `/api/console/backups/${encodeURIComponent(name)}`)
              refreshBackups()
            } catch (err) {
              alert(err.message)
              button.disabled = false
            }
          })
        }
      } catch (err) {
        box.innerHTML = `<div class="mini-row"><span>备份</span><div class="muted">读取失败：${esc(err.message)}</div></div>`
      }
    }
    const retentionSave = $('#retention-save')
    if (retentionSave) {
      const note = $('#retention-state')
      const setNote = (text, bad = false) => {
        if (!note) return
        note.textContent = text
        note.classList.toggle('bad-text', bad)
      }
      retentionSave.addEventListener('click', async () => {
        const days = Number($('#retention-input')?.value)
        const auditDays = Number($('#audit-retention-input')?.value)
        for (const [label, value] of [
          ['日志保留天数', days],
          ['审计保留天数', auditDays],
        ]) {
          if (!Number.isInteger(value) || value < 0 || (value > 0 && value < 7) || value > 3650) {
            return setNote(`${label}只能填 0（永久）或 7–3650`, true)
          }
        }
        retentionSave.disabled = true
        try {
          await apiSend('PUT', '/api/console/settings/retention', { days, auditDays })
          const policy = [
            days > 0 ? `日志超过 ${days} 天` : '日志永久保留',
            auditDays > 0 ? `审计超过 ${auditDays} 天` : '审计永久保留',
          ]
          setNote(`已保存：${policy.join('；')}（后台每 6 小时检查一次）`)
        } catch (err) {
          setNote(err.message, true)
        } finally {
          retentionSave.disabled = false
        }
      })
    }
    const retentionRun = $('#retention-run')
    if (retentionRun) {
      retentionRun.addEventListener('click', async () => {
        const note = $('#retention-state')
        retentionRun.disabled = true
        if (note) note.textContent = '清理中…'
        try {
          const result = await apiPost('/api/console/settings/retention/run', {})
          if (result.skipped) {
            if (note) note.textContent = '当前日志与审计都设为永久保留（0 天），没有需要清理的记录'
          } else {
            const labels = {
              syncDiffs: '同步差异',
              syncRuns: '同步记录',
              channelEvents: '渠道事件',
              loginAttempts: '登录失败',
              pluginEvents: '插件事件',
              onboardAttempts: '扫码尝试',
              auditLogs: '审计记录',
            }
            const detail = Object.entries(result.deleted ?? {})
              .filter(([, n]) => Number(n) > 0)
              .map(([key, n]) => `${labels[key] || key} ${n}`)
              .join('、')
            if (note) note.textContent = result.total ? `已清理 ${result.total} 条：${detail}` : '没有超过保留期的记录，无需清理'
          }
          const input = $('#retention-input')
          if (input && result.days > 0) input.value = result.days
          const auditInput = $('#audit-retention-input')
          if (auditInput && result.audit?.days > 0) auditInput.value = result.audit.days
        } catch (err) {
          if (note) {
            note.textContent = err.message
            note.classList.add('bad-text')
          }
        } finally {
          retentionRun.disabled = false
        }
      })
    }
    const dataDirSave = $('#data-dir-save')
    if (dataDirSave) {
      const note = $('#data-dir-state')
      const setNote = (text, bad = false) => {
        if (!note) return
        note.textContent = text
        note.classList.toggle('bad-text', bad)
      }
      dataDirSave.addEventListener('click', async () => {
        const path = String($('#data-dir-input')?.value ?? '').trim()
        if (!path) return setNote('先填写要迁移到的绝对路径，例如 D:\\EABData', true)
        dataDirSave.disabled = true
        try {
          const result = await apiSend('PUT', '/api/console/settings/data-dir', { path })
          if (result.changed) {
            setNote(`已保存到 ${result.dataDir}；重启服务后生效，启动时会把现有数据库搬过去`)
          } else {
            setNote('数据目录没有变化')
          }
        } catch (err) {
          setNote(err.message, true)
        } finally {
          dataDirSave.disabled = false
        }
      })
    }
    const dataDirReset = $('#data-dir-reset')
    if (dataDirReset) {
      dataDirReset.addEventListener('click', async () => {
        const note = $('#data-dir-state')
        dataDirReset.disabled = true
        try {
          const result = await apiSend('PUT', '/api/console/settings/data-dir', { reset: true })
          if (note) note.textContent = result.changed ? '已恢复为部署目录 .eab-dev；重启服务后生效' : '当前已经是部署目录'
        } catch (err) {
          if (note) {
            note.textContent = err.message
            note.classList.add('bad-text')
          }
        } finally {
          dataDirReset.disabled = false
        }
      })
    }
    const storageRowsEl = $('#storage-rows')
    if (storageRowsEl) {
      storageRowsEl.addEventListener('click', async (event) => {
        const btn = event.target.closest('[data-storage-save], [data-storage-reset]')
        if (!btn) return
        const row = btn.closest('.storage-row')
        const key = row?.dataset.storageKey
        if (!key) return
        const input = row.querySelector('input')
        const reset = btn.hasAttribute('data-storage-reset')
        const path = reset ? null : String(input?.value ?? '').trim()
        if (!reset && !path) {
          const note = $('#storage-state')
          if (note) {
            note.textContent = '先填写新的绝对路径，例如 E:\\EABData\\workspaces'
            note.classList.add('bad-text')
          }
          return
        }
        const note = $('#storage-state')
        const buttons = row.querySelectorAll('button, input')
        buttons.forEach((item) => { item.disabled = true })
        try {
          const result = await apiSend('PUT', '/api/console/settings/storage', { key, path, reset })
          if (note) {
            note.textContent = result.changed ? result.hint : '路径没有变化'
            note.classList.toggle('bad-text', false)
          }
          if (input) input.value = ''
        } catch (err) {
          if (note) {
            note.textContent = err.message
            note.classList.add('bad-text')
          }
        } finally {
          buttons.forEach((item) => { item.disabled = false })
        }
      })
    }
    const netSave = $('#net-save')
    if (netSave) {
      const note = $('#net-state')
      const setNetNote = (text, bad = false) => {
        if (!note) return
        note.textContent = text
        note.classList.toggle('bad-text', bad)
      }
      const setAccessUi = (allowed) => {
        const pill = $('#net-access-pill')
        const title = $('#net-access-title')
        const accessState = $('#net-access-state')
        if (pill) {
          pill.textContent = allowed ? '允许局域网登录控制台' : '控制台仅本机登录'
          pill.classList.toggle('warn', allowed)
          pill.classList.toggle('ok', !allowed)
        }
        if (title) title.textContent = allowed ? '局域网内可登录控制台' : '仅服务器本机能登录控制台'
        if (accessState) accessState.textContent = '切换后立即生效'
      }
      const netRemote = $('#net-remote')
      if (netRemote && !netRemote.disabled) {
        let previous = netRemote.checked
        netRemote.addEventListener('change', async () => {
          const target = netRemote.checked
          netRemote.disabled = true
          setNetNote(target ? '正在打开局域网登录…' : '正在关闭局域网登录…')
          try {
            const result = await apiSend('PUT', '/api/console/settings/network', {
              allowRemoteConsole: target,
            })
            const allowed = Boolean(result.network?.allowRemoteConsole ?? target)
            setAccessUi(allowed)
            setNetNote(result.hint || '已立即生效')
            previous = allowed
          } catch (err) {
            netRemote.checked = previous
            setAccessUi(previous)
            setNetNote(err.message, true)
          } finally {
            netRemote.disabled = false
          }
        })
      }
      const targetAdminUrl = (network) => {
        const url = new URL(location.href)
        const host = String(network?.host ?? '')
        if (host && host !== '0.0.0.0' && host !== '::') url.hostname = host
        if (network?.adminPort) url.port = String(network.adminPort)
        return url
      }
      netSave.addEventListener('click', async () => {
        const host = String($('#net-host')?.value ?? '').trim()
        const chatPort = Number($('#net-chat-port')?.value)
        const adminPort = Number($('#net-admin-port')?.value)
        if (!host) {
          setNetNote('监听地址不能为空', true)
          return
        }
        if (!Number.isInteger(chatPort) || !Number.isInteger(adminPort) || chatPort === adminPort) {
          setNetNote('两个端口都必须是 1–65535 的整数，且不能相同', true)
          return
        }
        netSave.disabled = true
        setNetNote('正在保存并切换监听…')
        try {
          const result = await apiSend('PUT', '/api/console/settings/network', {
            host,
            chatPort,
            adminPort,
          })
          if (result.switching && result.network) {
            const target = targetAdminUrl(result.network)
            setNetNote('监听正在切换，正在确认新地址…')
            let reachable = false
            for (let i = 0; i < 8; i += 1) {
              await new Promise((resolve) => setTimeout(resolve, 500))
              try {
                await fetch(`${target.origin}/api/health?t=${Date.now()}`, {
                  mode: 'no-cors',
                  cache: 'no-store',
                })
                reachable = true
                break
              } catch {
                // 新端口还没起来时继续等，最多 4 秒。
              }
            }
            if (!reachable) {
              setNetNote('监听切换失败，已保留原监听；请查看服务日志', true)
              netSave.disabled = false
              return
            }
            if (target.origin !== location.origin) {
              location.assign(target.toString())
              return
            }
            setNetNote('监听已切换，无需重启')
            netSave.disabled = false
            return
          }
          setAccessUi(Boolean(result.network?.allowRemoteConsole ?? netRemote?.checked))
          setNetNote(result.hint || '网络设置没有变化')
          netSave.disabled = false
        } catch (err) {
          setNetNote(err.message, true)
          netSave.disabled = false
        }
      })
    }

    let updateNow = update
    const updateNote = $('#update-state')
    const setUpdateNote = (text, bad = false) => {
      if (!updateNote) return
      updateNote.textContent = text
      updateNote.classList.toggle('bad-text', bad)
    }
    const refreshUpdateView = () => {
      const applyButton = $('#update-apply')
      if (applyButton) applyButton.disabled = !(updateNow?.hasUpdate && updateNow?.sourceUrl)
      const pill = document.querySelector('[data-section-panel="data"] .panel-head .pill')
      if (pill) {
        pill.textContent = updateNow?.hasUpdate ? '发现新版本' : updateNow?.latest ? '已是最新' : '尚未检查'
        pill.className = `pill ${updateNow?.hasUpdate ? 'warn' : 'ok'}`
      }
    }
    const updateCheck = $('#update-check')
    if (updateCheck) {
      updateCheck.addEventListener('click', async () => {
        updateCheck.disabled = true
        setUpdateNote('正在检查 GitHub Release…')
        try {
          updateNow = await apiPost('/api/console/update/check', {})
          refreshUpdateView()
          setUpdateNote(
            updateNow.error
              ? updateNow.error
              : updateNow.hasUpdate
                ? `发现新版本 v${updateNow.latest}，可以一键更新或执行 eab update --apply`
                : `当前已是最新版本 v${updateNow.current}`,
            Boolean(updateNow.error),
          )
        } catch (err) {
          setUpdateNote(err.message, true)
        } finally {
          updateCheck.disabled = false
        }
      })
    }
    const updateApply = $('#update-apply')
    if (updateApply) {
      updateApply.addEventListener('click', async () => {
        if (!updateNow?.hasUpdate) return
        const confirmed = await confirmCard({
          title: `更新到 v${updateNow.latest}？`,
          message: '更新会下载 GitHub Release 源码包、备份当前代码并替换；服务随后自动重启。',
          detail: '数据目录 .eab-dev 不会被替换。更新期间页面会短暂断开。',
          confirmText: '开始更新',
          tone: 'warning',
        })
        if (!confirmed) return
        updateApply.disabled = true
        setUpdateNote('正在启动更新器，服务即将重启…')
        try {
          await apiPost('/api/console/update/apply', {})
          setUpdateNote('更新器已启动，服务正在重启；稍后刷新页面查看新版本。')
        } catch (err) {
          setUpdateNote(err.message, true)
          updateApply.disabled = false
        }
      })
    }
    const updateCopy = $('#update-copy')
    if (updateCopy) {
      updateCopy.addEventListener('click', async () => {
        const command = 'eab update --apply'
        try {
          await navigator.clipboard.writeText(command)
          setUpdateNote(`已复制：${command}`)
        } catch {
          setUpdateNote(`请手动执行：${command}`)
        }
      })
    }
    refreshUpdateView()

    refreshBackups()
  } catch (err) {
    renderDenied(view, err)
  }
}

/* ---------------- 钉钉一键开通公司 ---------------- */

/**
 * 用户口径：不要先手工建公司再填绑定配置。这里一次提交就完成
 * 「建公司 + 绑定钉钉 + 拉通讯录落库」，公司名默认直接用钉钉企业名。
 */
function openDingTalkOnboard(onDone) {
  const overlay = modelModal(`
    <div class="modal-head"><h3>钉钉扫码绑定</h3><button class="modal-x" type="button">×</button></div>
    ${hintNote('扫码说明', '用手机钉钉扫码，钉钉官方会创建/连接机器人并补齐机器人权限；扫完 EAB 自动把部门与成员同步到当前唯一公司，并让「EAB · 公司名」机器人开始接收私聊。通讯录权限如果钉钉没自动给，会在这里给出一次性批量开通入口。')}
    <div class="onboard-qr">
      <div class="onboard-qr-visual">
        <div class="onboard-qr-frame"><img id="od-qr" alt="钉钉扫码开通二维码" /></div>
        <div class="onboard-qr-status" id="od-state">正在生成二维码…</div>
        <div class="onboard-permission" id="od-permission" hidden></div>
        <div class="onboard-qr-actions">
          <button class="btn ghost sm" type="button" id="od-refresh">刷新二维码</button>
          <a class="link-btn" id="od-open" href="#" target="_blank" rel="noreferrer">在浏览器打开扫码页</a>
        </div>
      </div>
      <ol class="onboard-steps">
        <li><strong>手机钉钉扫码</strong><span>扫完后在手机上点「立即连接」。</span></li>
        <li><strong>确认企业与机器人</strong><span>优先点已有机器人的「立即连接」；选「创建新机器人」时，钉钉会新建应用，通讯录权限可能还要补一次。</span></li>
        <li><strong>回到这里等结果</strong><span>页面会自动轮询，成功后同步到本实例的唯一公司。</span></li>
      </ol>
    </div>
    <details class="onboard-manual">
      <summary>扫码不方便？改用手工填 AppKey / AppSecret / CorpId</summary>
      <div class="form-grid" style="margin-top:10px">
        <label class="field"><span>钉钉 AppKey（Client ID）</span><input id="od-appid" class="mono" placeholder="dingxxxxxxxx" /></label>
        <label class="field"><span>钉钉 AppSecret</span><input id="od-secret" class="mono" type="password" placeholder="只保存引用，不回显" /></label>
        <label class="field"><span>企业 CorpId</span><input id="od-corp" class="mono" placeholder="dingxxxxxxxx" /></label>
        <label class="field"><span>公司名称（可空）</span><input id="od-name" placeholder="默认用钉钉企业名" /></label>
        <label class="field"><span>slug（可空）</span><input id="od-slug" class="mono" placeholder="默认自动生成" /></label>
      </div>
      ${hintNote('权限说明', '手工方式要求应用已开通部门、成员、部门成员读权限，且发布过新版本。扫码方式会由钉钉自动补齐权限。')}
      <div class="modal-actions" style="justify-content:flex-start">
        <button class="btn" type="button" id="od-save">手工开通并同步</button>
      </div>
    </details>
    <div class="modal-actions">
      <button class="btn ghost" type="button" id="od-cancel">取消</button>
    </div>`)
  const stateEl = overlay.querySelector('#od-state')
  const qrImg = overlay.querySelector('#od-qr')
  const qrFrame = overlay.querySelector('.onboard-qr-frame')
  const qrActions = overlay.querySelector('.onboard-qr-actions')
  const permissionEl = overlay.querySelector('#od-permission')
  const openLink = overlay.querySelector('#od-open')
  const refreshBtn = overlay.querySelector('#od-refresh')
  let attemptId = ''
  let intervalSec = 2
  let timer = 0
  let stopped = false
  let busy = false

  const stop = () => {
    stopped = true
    if (timer) clearInterval(timer)
    timer = 0
  }
  const close = () => {
    stop()
    overlay.remove()
  }
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#od-cancel').addEventListener('click', close)

  const showPermission = (result) => {
    stop()
    // 已经扫过码了，二维码不再需要；隐藏后把整栏让给权限说明，避免弹窗被撑出滚动条
    qrFrame.hidden = true
    qrActions.hidden = true
    stateEl.className = 'onboard-qr-status warn'
    stateEl.textContent = result.message || '机器人已建好，但钉钉还没给通讯录读取权限。'
    const scopes = result.requiredScopes || []
    permissionEl.innerHTML = `
      <strong>还差 ${scopes.length} 个通讯录权限</strong>
      <p>钉钉扫码会自动补机器人的权限；通讯录读取属于企业内部应用权限，需要企业管理员确认一次。点下面的按钮会一次打开全部通讯录权限，勾选后「批量申请」即可，不用一个个搜。</p>
      <div class="onboard-permission-links">
        <a class="btn primary sm" href="${esc(result.batchApplyUrl || result.applyUrls?.[scopes[0]] || '#')}" target="_blank" rel="noreferrer">一次打开全部通讯录权限</a>
        <a class="btn ghost sm" href="${esc(result.versionUrl || 'https://open-dev.dingtalk.com/fe/ai')}" target="_blank" rel="noreferrer">去发布新版本</a>
      </div>
      <p class="onboard-permission-scopes">需要勾选：${scopes.map((scope) => `<code>${esc(scope)}</code>`).join('、')}</p>
      <button class="btn primary sm" type="button" id="od-recheck">我已开通并发布，继续同步</button>`
    permissionEl.hidden = false
    permissionEl.querySelector('#od-recheck').addEventListener('click', () => {
      permissionEl.hidden = true
      stopped = false
      stateEl.className = 'onboard-qr-status'
      stateEl.textContent = '正在重新检查权限并同步…'
      void poll()
    })
  }

  const poll = async () => {
    if (stopped || busy || !attemptId) return
    busy = true
    try {
      const result = await apiPost('/api/console/dingtalk/onboard/status', { attemptId })
      if (result.status === 'success') {
        stop()
        close()
        if (result.existing) {
          alert(`已把扫码得到的机器人接到「${result.company?.name || '现有公司'}」。`)
        } else {
          alert(
            `已开通「${result.company.name}」：${result.sync?.departments ?? 0} 个部门 / ${result.sync?.members ?? 0} 名成员，机器人已连接。`,
          )
        }
        if (typeof onDone === 'function') {
          onDone(result)
        } else {
          location.href = `/admin?company=${encodeURIComponent(result.company?.id || '')}&goto=org`
        }
        return
      }
      if (result.status === 'needs_permission') {
        showPermission(result)
        return
      }
      if (result.status === 'expired') {
        stop()
        stateEl.className = 'onboard-qr-status bad'
        stateEl.textContent = '二维码已过期，请点「刷新二维码」重新生成。'
        refreshBtn.disabled = false
        return
      }
      if (result.status === 'fail') {
        stop()
        stateEl.className = 'onboard-qr-status bad'
        stateEl.textContent = result.message || '钉钉侧连接失败，请刷新二维码重试。'
        refreshBtn.disabled = false
        return
      }
      stateEl.className = 'onboard-qr-status'
      stateEl.textContent = '等待手机扫码并在钉钉里点「立即连接」…'
    } catch (err) {
      stop()
      stateEl.className = 'onboard-qr-status bad'
      stateEl.textContent = `${err.message}${err.code ? `（${err.code}）` : ''}`
      refreshBtn.disabled = false
    } finally {
      busy = false
    }
  }

  const start = async () => {
    stopped = false
    busy = false
    if (timer) clearInterval(timer)
    refreshBtn.disabled = true
    stateEl.className = 'onboard-qr-status'
    stateEl.textContent = '正在生成二维码…'
    try {
      const started = await apiPost('/api/console/dingtalk/onboard/start', {})
      attemptId = started.attemptId
      intervalSec = Math.max(1, Number(started.interval) || 2)
      qrImg.src = started.qrSvg
      qrImg.hidden = false
      openLink.href = started.qrUrl
      stateEl.textContent = `请用手机钉钉扫码（${Math.round(started.expiresIn / 60)} 分钟内有效）`
      refreshBtn.disabled = false
      timer = setInterval(poll, intervalSec * 1000)
    } catch (err) {
      stateEl.className = 'onboard-qr-status bad'
      stateEl.textContent = `${err.message}${err.code ? `（${err.code}）` : ''}`
      refreshBtn.disabled = false
    }
  }

  refreshBtn.addEventListener('click', start)
  start()

  overlay.querySelector('#od-save').addEventListener('click', async () => {
    const body = {
      appId: overlay.querySelector('#od-appid').value.trim(),
      appSecret: overlay.querySelector('#od-secret').value.trim(),
      corpId: overlay.querySelector('#od-corp').value.trim(),
      companyName: overlay.querySelector('#od-name').value.trim(),
      slug: overlay.querySelector('#od-slug').value.trim().toLowerCase(),
    }
    if (!body.appId || !body.appSecret || !body.corpId) {
      stateEl.className = 'onboard-qr-status bad'
      stateEl.textContent = 'AppKey、AppSecret、CorpId 都要填'
      return
    }
    stop()
    stateEl.className = 'onboard-qr-status'
    stateEl.textContent = '正在校验凭证并拉取钉钉通讯录…'
    overlay.querySelector('#od-save').disabled = true
    try {
      const result = await apiPost('/api/console/companies/onboard-dingtalk', body)
      close()
      alert(`已开通「${result.company.name}」：${result.sync.departments} 个部门 / ${result.sync.members} 名成员`)
      if (typeof onDone === 'function') {
        onDone(result)
      } else {
        location.href = `/admin?company=${encodeURIComponent(result.company.id)}&goto=org`
      }
    } catch (err) {
      stateEl.className = 'onboard-qr-status bad'
      stateEl.textContent = `${err.message}${err.code ? `（${err.code}）` : ''}`
      overlay.querySelector('#od-save').disabled = false
    }
  })
}

/**
 * 空库首次部署：控制台还进不去任何业务页，先把“创建唯一公司”做成主内容，
 * 避免用户卡在空白的组织树 / 系统页上。
 */
function renderFirstCompany() {
  const view = $('#view')
  if (!view) return
  const title = $('#page-title')
  const sub = $('#page-sub')
  const kicker = $('#page-kicker')
  if (title) title.textContent = '首次部署'
  if (sub) sub.textContent = '空库启动：先创建唯一公司，再接入组织与模型'
  if (kicker) kicker.textContent = 'FIRST SETUP'
  setSide('', true)

  view.innerHTML = `
    <section class="panel first-run-panel">
      <div class="panel-head">
        <div>
          <h2>开始使用 EAB</h2>
          ${hintBadge('空库说明', '这是空库部署；创建第一家公司后，组织、模型与渠道配置才有归属。')}
        </div>
        <div class="head-actions"><span class="pill">单公司实例</span></div>
      </div>
      <div class="first-run-body">
        <div class="first-run-mark" aria-hidden="true">EAB</div>
        <div class="first-run-copy">
          <span class="first-run-kicker">STEP 01</span>
          <h3>先创建一家公司</h3>
          <p>服务器刚部署时数据库里没有任何公司。创建后，这家公司就是本实例唯一的管理范围；公司总部根部门、内置角色与权限骨架会自动建好。</p>
          <div class="first-run-actions">
            <button class="btn primary" type="button" id="first-company-create">创建第一家公司</button>
            ${hintBadge('接入说明', '创建后可在「连接与平台 → 渠道」用钉钉扫码接入真实组织。')}
          </div>
        </div>
      </div>
      <div class="first-run-steps">
        <div class="first-run-step"><span>01</span><strong>创建公司</strong><p>定义本实例唯一组织，生成公司总部与角色骨架。</p></div>
        <div class="first-run-step"><span>02</span><strong>接入组织</strong><p>在渠道页扫码绑定钉钉，同步部门和成员。</p></div>
        <div class="first-run-step"><span>03</span><strong>配置模型</strong><p>接入本地或云端模型，再开始对话与压测。</p></div>
      </div>
    </section>`

  view.querySelector('#first-company-create')?.addEventListener('click', openCompanyCreate)
}

function openCompanyCreate() {
  const overlay = modelModal(`
    <div class="modal-head company-create-head">
      <div class="company-create-title">
        <span class="company-create-eyebrow">STEP 01 · 初始化</span>
        <h3>创建第一家公司</h3>
      </div>
      <span class="company-create-scope">单公司实例</span>
      <button class="modal-x" type="button">×</button>
    </div>
    <div class="company-create-lead">
      <span class="company-create-lead-dot"></span>
      ${hintBadge('范围说明', '这一家公司就是本实例唯一的管理范围，创建后自动生成组织骨架。公司 ID 使用服务器配置值，不会出现第二家公司。需要换组织请先在「系统 → 公司信息」删除。')}
    </div>
    <section class="company-create-section">
      <div class="company-create-section-head">
        <span class="company-create-step">01</span>
        <div class="company-create-section-title">
          <h4>公司信息 ${hintBadge('显示说明', '员工端与顶栏都会显示这家公司。')}</h4>
        </div>
        <span class="company-create-required">必填</span>
      </div>
      <div class="form-grid company-create-grid">
        <label class="field"><span>公司名称 ${fieldInfo('创建后可在「系统 → 公司信息」改名，根部门和顶栏会一起同步。')}</span><input id="c-name" placeholder="例如 居易科技" maxlength="80" /></label>
        <label class="field"><span>公司标识（slug） ${fieldInfo('留空自动生成；用于内部标识和自动管理员账号前缀，创建后不建议修改。')}</span><input id="c-slug" class="mono" placeholder="留空自动生成" maxlength="40" /></label>
      </div>
    </section>
    <section class="company-create-section">
      <div class="company-create-section-head">
        <span class="company-create-step">02</span>
        <div class="company-create-section-title">
          <h4>初始管理员 ${hintBadge('添加说明', '可以稍后在「组织与权限」里再添加；不建管理员也能先完成公司初始化。')}</h4>
        </div>
        <span class="company-create-optional">可选</span>
      </div>
      <div class="form-grid company-create-grid">
        <label class="field"><span>管理员姓名 ${fieldInfo('填了姓名才会创建管理员账号；留空则只建公司。')}</span><input id="c-admin" placeholder="选填；填了就同时建公司管理员" maxlength="40" /></label>
        <label class="field"><span>管理员账号 ${fieldInfo('留空自动生成。手填后会实时检测工号、邮箱、手机号是否已被占用。')}</span><input id="c-account" class="mono" placeholder="留空自动生成" maxlength="40" aria-describedby="c-account-status" /><small class="field-hint" id="c-account-status" aria-live="polite"></small></label>
        <label class="field"><span>管理员初始密码 ${fieldInfo('填了管理员姓名则至少 8 位；仅用于首次创建管理员，之后可在成员详情里重置。')}</span><input id="c-password" type="password" autocomplete="new-password" placeholder="填了管理员姓名则至少 8 位" /></label>
      </div>
    </section>
    <div class="company-create-extra">
      <label class="check company-create-check">
        <input id="c-bind-dt" type="checkbox" />
        <span>创建后去渠道页绑定钉钉并同步通讯录</span>
      </label>
      <span class="company-create-extra-note">可选</span>
      ${fieldInfo('勾选后创建完成会跳到渠道页并打开钉钉绑定；不会自动创建成员，只发起绑定流程。')}
    </div>
    <div class="company-create-autogen">
      <span>创建后自动生成</span>
      <b>公司总部</b>
      <b>8 个内置角色</b>
      ${fieldInfo('公司总部根部门和内置角色权限会一次建好；钉钉同步会在此基础上追加部门与成员。')}
    </div>
    <div class="modal-state" id="c-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="c-save">创建公司</button>
      <button class="btn ghost" type="button" id="c-cancel">取消</button>
    </div>`)
  overlay.querySelector('.modal')?.classList.add('company-create-modal')
  const stateEl = overlay.querySelector('#c-state')
  const save = overlay.querySelector('#c-save')
  const accountInput = overlay.querySelector('#c-account')
  const adminInput = overlay.querySelector('#c-admin')
  const accountStatus = overlay.querySelector('#c-account-status')
  const ACCOUNT_HINT = ''
  let accountCheckTimer = null
  let accountCheckSeq = 0
  let verifiedAccount = ''

  function setAccountStatus(text, tone = '') {
    if (!accountStatus) return
    accountStatus.className = `field-hint${tone ? ` ${tone}` : ''}`
    accountStatus.textContent = text
  }

  function resetAccountStatus() {
    verifiedAccount = ''
    setAccountStatus(ACCOUNT_HINT)
    accountInput?.setAttribute('aria-invalid', 'false')
    if (save) save.disabled = false
  }

  async function checkAdminAccount() {
    const seq = ++accountCheckSeq
    if (!accountInput || !adminInput) return true
    const account = accountInput.value.trim()
    const adminName = adminInput.value.trim()
    if (!adminName || !account) {
      resetAccountStatus()
      return true
    }
    setAccountStatus('正在检测账号是否已被占用…', 'is-checking')
    try {
      const result = await apiPost('/api/console/companies/check-admin-account', { account })
      if (seq !== accountCheckSeq) return false
      if (!result.available) {
        verifiedAccount = ''
        accountInput.setAttribute('aria-invalid', 'true')
        setAccountStatus(
          `账号已被${result.ownerName ? `成员「${result.ownerName}」` : '已有成员'}占用，请换一个`,
          'is-bad',
        )
        save.disabled = true
        return false
      }
      verifiedAccount = account
      accountInput.setAttribute('aria-invalid', 'false')
      setAccountStatus('账号可用', 'is-ok')
      save.disabled = false
      return true
    } catch {
      if (seq !== accountCheckSeq) return false
      verifiedAccount = ''
      accountInput.setAttribute('aria-invalid', 'false')
      setAccountStatus('暂时无法检测账号；提交时服务器会再校验', 'is-checking')
      save.disabled = false
      return true
    }
  }

  function scheduleAccountCheck() {
    verifiedAccount = ''
    if (save) save.disabled = false
    if (accountCheckTimer) clearTimeout(accountCheckTimer)
    accountCheckTimer = setTimeout(() => {
      accountCheckTimer = null
      void checkAdminAccount()
    }, 400)
  }

  function checkAccountNow() {
    if (accountCheckTimer) {
      clearTimeout(accountCheckTimer)
      accountCheckTimer = null
    }
    void checkAdminAccount()
  }

  function close() {
    if (accountCheckTimer) {
      clearTimeout(accountCheckTimer)
      accountCheckTimer = null
    }
    accountCheckSeq += 1
    document.removeEventListener('keydown', onKey)
    overlay.remove()
  }
  const onKey = (event) => {
    if (event.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#c-cancel').addEventListener('click', close)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  accountInput?.addEventListener('input', scheduleAccountCheck)
  adminInput?.addEventListener('input', scheduleAccountCheck)
  accountInput?.addEventListener('blur', checkAccountNow)
  adminInput?.addEventListener('blur', checkAccountNow)
  overlay.querySelector('#c-name')?.focus()

  overlay.querySelector('#c-save').addEventListener('click', async () => {
    const body = {
      name: overlay.querySelector('#c-name').value.trim(),
      slug: overlay.querySelector('#c-slug').value.trim(),
      adminName: overlay.querySelector('#c-admin').value.trim(),
      adminAccount: overlay.querySelector('#c-account').value.trim(),
      adminPassword: overlay.querySelector('#c-password').value,
    }
    if (!body.name) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '公司名称不能为空'
      overlay.querySelector('#c-name')?.focus()
      return
    }
    if (body.adminName && body.adminPassword.length < 8) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '填了管理员姓名时，初始密码至少 8 位'
      overlay.querySelector('#c-password')?.focus()
      return
    }
    if (accountCheckTimer) {
      clearTimeout(accountCheckTimer)
      accountCheckTimer = null
    }
    if (body.adminName && body.adminAccount && verifiedAccount !== body.adminAccount) {
      const available = await checkAdminAccount()
      if (!available) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '管理员账号已被占用，请换一个'
        accountInput?.focus()
        return
      }
    }
    save.disabled = true
    stateEl.className = 'modal-state'
    stateEl.textContent = '正在创建公司…'
    try {
      const result = await apiPost('/api/console/companies', body)
      const bindDingtalk = Boolean(overlay.querySelector('#c-bind-dt')?.checked)
      close()
      const query = new URLSearchParams({ company: result.id, goto: 'overview' })
      if (bindDingtalk) {
        query.set('goto', 'channels')
        query.set('open', 'dingtalk')
      }
      location.href = `/admin?${query.toString()}`
    } catch (err) {
      save.disabled = false
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '创建失败'
      if (err.code === 'EAB_VALIDATION' && /账号/.test(err.message || '')) {
        setAccountStatus(err.message, 'is-bad')
        accountInput?.setAttribute('aria-invalid', 'true')
        accountInput?.focus()
      }
    }
  })
}

async function downloadConsoleFile(path, filename) {
  const res = await fetch(path + qs(path), { headers: { 'x-eab-console': '1' } })
  if (!res.ok) throw new Error(`导出失败 HTTP ${res.status}`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

async function loadTools() {
  const view = $('#view')
  renderLoading(view)
  setSide('', true)
  try {
    const data = await api('/api/tools')
    const rows = data.tools
      .map(
        (tool) => `<tr>
          <td><strong>${esc(tool.name)}</strong><div class="desc mono">${esc(tool.id)}</div></td>
          <td class="tool-desc"><div class="tool-desc-text" title="${esc(tool.description)}">${esc(tool.description)}</div></td>
          <td>${tool.source === 'plugin' ? '<span class="pill">插件</span>' : '<span class="pill ok">内置</span>'} ${tool.dangerous ? '<span class="pill warn">需审批</span>' : ''}</td>
          <td>${tool.available ? '<span class="pill ok">当前可用</span>' : '<span class="pill">无权限</span>'}</td>
          <td class="tool-actions"><button class="link-btn accent" type="button" data-tool-test="${esc(tool.id)}"${tool.available ? '' : ' disabled'}>试运行</button></td>
        </tr>`,
      )
      .join('')
    const builtinCount = data.tools.filter((tool) => tool.source !== 'plugin').length
    const pluginCount = data.tools.length - builtinCount
    view.innerHTML = `
      <section class="panel">
        <div class="panel-head"><div><h2>工具注册表</h2><span class="hint">${builtinCount} 个内置工具 + ${pluginCount} 个插件工具</span>${hintBadge('工具说明', '插件工具随插件安装 / 停用动态出现；没有权限的工具会在当前身份列标记为不可用。')}</div></div>
        <table class="data">
          <thead><tr><th>工具</th><th>说明</th><th>来源 / 风险</th><th>当前身份</th><th>操作</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>调用规则</h2></div>
        <div class="mini-list">
          <div class="mini-row"><span>鉴权</span><div>每个工具声明所需 scope；没有 scope 直接 403，不进入执行。插件工具统一要求 agent:tool:invoke。</div></div>
          <div class="mini-row"><span>插件</span><div>插件工具由插件 host 注册；公司/员工停用或卸载插件后，下一次对话立即看不到、也调不到。</div></div>
          <div class="mini-row"><span>高危</span><div>带「需审批」的工具第一次调用会生成审批待办，管理员在「审批」页通过后，带 approvalId 再调。</div></div>
          <div class="mini-row"><span>审计</span><div>每次调用写审计（tool.invoke.&lt;id&gt;），参数与结果摘要可追溯。</div></div>
        </div>
      </section>`
    for (const button of view.querySelectorAll('[data-tool-test]')) {
      button.addEventListener('click', async () => {
        const id = button.dataset.toolTest
        const tool = data.tools.find((item) => item.id === id)
        const inputFields = tool.source === 'plugin' ? (tool.input?.properties ?? {}) : (tool.input ?? {})
        const raw = prompt(`给「${tool.name}」传参数（JSON 对象）`, Object.keys(inputFields).length ? JSON.stringify(Object.fromEntries(Object.keys(inputFields).map((key) => [key, ''])), null, 2) : '{}')
        if (raw === null) return
        let args = {}
        try {
          args = raw.trim() ? JSON.parse(raw) : {}
        } catch {
          alert('参数不是合法 JSON')
          return
        }
        try {
          const result = await apiPost(`/api/tools/${encodeURIComponent(id)}/invoke`, { args })
          alert(`调用成功：\n${JSON.stringify(result.result, null, 2).slice(0, 1200)}`)
        } catch (err) {
          if (err.code === 'EAB_APPROVAL_REQUIRED') {
            alert(`${err.message}\n审批单：${err.details?.approvalId ?? ''}\n到「审批」页通过后再带 approvalId 调用。`)
          } else {
            alert(err.message)
          }
        }
      })
    }
  } catch (err) {
    renderDenied(view, err)
  }
}

async function loadUsage(days = 30) {
  const view = $('#view')
  renderLoading(view)
  setSide(`
    <div class="side-head usage-side-head"><span class="side-title">统计窗口</span>${hintBadge('数据来源', '数据来自 usage_daily：每轮对话按用户按天累加请求、prompt、completion token。')}</div>
    <div class="side-list">
      ${[7, 30, 90]
        .map((item) => `<button class="side-item${days === item ? ' is-active' : ''}" type="button" data-usage-days="${item}">最近 ${item} 天</button>`)
        .join('')}
    </div>`)
  for (const button of document.querySelectorAll('[data-usage-days]')) {
    button.addEventListener('click', () => loadUsage(Number(button.dataset.usageDays)))
  }
  try {
    const data = await api(`/api/console/usage?days=${days}`)
    const rows = data.items
      .map(
        (item) => `<tr>
          <td class="mono">${esc(item.day)}</td>
          <td>${esc(item.userName)}<div class="desc mono">${esc(item.userId)}</div></td>
          <td class="num">${item.requests}</td>
          <td class="num">${item.promptTokens}</td>
          <td class="num">${item.completionTokens}</td>
        </tr>`,
      )
      .join('')
    view.innerHTML = `
      <section class="panel">
        <div class="panel-head"><div><h2>最近 ${days} 天</h2>${hintBadge('统计口径', '按人和按天聚合；只统计当前管理范围内的对话请求。')}</div></div>
        <div class="kv-grid">
          <div><span>对话请求</span><strong>${data.totals.requests}</strong></div>
          <div><span>Prompt tokens</span><strong>${data.totals.promptTokens}</strong></div>
          <div><span>Completion tokens</span><strong>${data.totals.completionTokens}</strong></div>
          <div><span>合计 tokens</span><strong>${data.totals.promptTokens + data.totals.completionTokens}</strong></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>明细</h2><span class="hint">${data.items.length} 条</span></div>
        <table class="data">
          <thead><tr><th>日期</th><th>成员</th><th class="num">请求</th><th class="num">Prompt</th><th class="num">Completion</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="empty">还没有对话用量。到 /chat 用员工账号发一条消息就会出现在这里。</td></tr>'}</tbody>
        </table>
      </section>`
  } catch (err) {
    renderDenied(view, err)
  }
}

/* ---------------- 公司资料 ---------------- */

const fmtNum = (value) => Number(value ?? 0).toLocaleString('zh-CN')

function fmtDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', { hour12: false })
}

/**
 * 长列表统一用「服务端分页 + 限高内滚」：
 * 页面本身不再被几千行记录拉长，表格里自己滚，翻页只换数据。
 */
function pagerHtml(total, page, size) {
  const totalPages = Math.max(1, Math.ceil(Number(total) / size))
  if (totalPages <= 1) return ''
  const current = Math.min(Math.max(page, 0), totalPages - 1)
  return `<div class="pager">
    <span class="pager-info">共 ${Number(total)} 条 · 第 ${current + 1}/${totalPages} 页</span>
    <div class="pager-actions">
      <button class="btn sm ghost" type="button" data-page="${current - 1}" ${current === 0 ? 'disabled' : ''}>上一页</button>
      <button class="btn sm ghost" type="button" data-page="${current + 1}" ${current >= totalPages - 1 ? 'disabled' : ''}>下一页</button>
    </div>
  </div>`
}

function bindPager(container, onPage) {
  for (const button of container.querySelectorAll('[data-page]')) {
    button.addEventListener('click', () => {
      const page = Number(button.dataset.page)
      if (Number.isFinite(page) && page >= 0) onPage(page)
    })
  }
}

const CHANNEL_PROVIDER_LABEL = { dingtalk: '钉钉', feishu: '飞书', wecom: '企业微信' }
const CHANNEL_STATUS_LABEL = {
  bound: '已绑定',
  syncing: '同步中',
  unbind: '未绑定',
  unbound: '未绑定',
  unconfigured: '未配置',
  error: '异常',
}

const ASSISTANT_AVATAR_MAX_BYTES = 1024 * 1024

function assistantAvatarPreview(name, url) {
  const label = String(name || 'AI').trim() || 'AI'
  const initial = esc(label.length <= 2 ? label : label.slice(0, 1))
  return `${url ? `<img class="assistant-avatar-img" src="${esc(url)}" alt="">` : ''}<span class="assistant-avatar-letter">${initial}</span>`
}

function assistantAvatarBytes(dataUrl) {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return Number.POSITIVE_INFINITY
  return Math.floor(((dataUrl.length - comma - 1) * 3) / 4)
}

function loadAssistantImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法读取这张图片，请换一张 PNG / JPEG / WebP'))
    image.src = url
  })
}

/**
 * 头像统一裁成 1:1、512px 再上传：
 * 后台弹窗里看到的预览和员工工作台里的最终效果保持一致，也避免把几 MB 原图塞进请求体。
 */
async function prepareAssistantAvatar(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('头像只支持 PNG / JPEG / WebP 图片')
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error('原图超过 8 MB，请先压缩后再上传')
  }
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await loadAssistantImage(objectUrl)
    const side = Math.min(image.naturalWidth, image.naturalHeight)
    if (!side) throw new Error('图片尺寸无效')
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 512
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器不支持图片处理')
    context.drawImage(
      image,
      Math.max(0, (image.naturalWidth - side) / 2),
      Math.max(0, (image.naturalHeight - side) / 2),
      side,
      side,
      0,
      0,
      512,
      512,
    )
    let dataUrl = canvas.toDataURL('image/webp', 0.9)
    if (!dataUrl.startsWith('data:image/webp')) dataUrl = canvas.toDataURL('image/png')
    if (assistantAvatarBytes(dataUrl) > ASSISTANT_AVATAR_MAX_BYTES) {
      context.fillStyle = '#fff'
      context.fillRect(0, 0, 512, 512)
      context.drawImage(
        image,
        Math.max(0, (image.naturalWidth - side) / 2),
        Math.max(0, (image.naturalHeight - side) / 2),
        side,
        side,
        0,
        0,
        512,
        512,
      )
      dataUrl = canvas.toDataURL('image/jpeg', 0.86)
    }
    if (assistantAvatarBytes(dataUrl) > ASSISTANT_AVATAR_MAX_BYTES) {
      throw new Error('压缩后仍超过 1 MB，请换一张更简单的图片')
    }
    return dataUrl
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function bindAssistantEditor(initial) {
  const nameInput = $('#assistant-name')
  const preview = $('#assistant-avatar-preview')
  const fileInput = $('#assistant-avatar-file')
  const removeButton = $('#assistant-avatar-remove')
  const saveButton = $('#assistant-save')
  const stateEl = $('#assistant-save-state')
  if (!nameInput || !preview || !fileInput || !removeButton || !saveButton || !stateEl) return

  let avatarUrl = initial.avatarUrl || ''
  let pendingDataUrl = ''
  let pendingRemove = false

  const setState = (text, tone = '') => {
    stateEl.className = `pill ${tone}`.trim()
    stateEl.textContent = text
  }

  const refresh = () => {
    preview.innerHTML = assistantAvatarPreview(nameInput.value, avatarUrl)
    preview.classList.toggle('has-photo', Boolean(avatarUrl))
    const image = preview.querySelector('.assistant-avatar-img')
    if (image) {
      image.addEventListener('error', () => {
        avatarUrl = ''
        refresh()
      })
    }
  }

  nameInput.addEventListener('input', () => {
    refresh()
    setState('待保存', 'warn')
  })

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    if (!file) return
    setState('处理图片中…', 'warn')
    try {
      pendingDataUrl = await prepareAssistantAvatar(file)
      pendingRemove = false
      avatarUrl = pendingDataUrl
      refresh()
      setState('新头像待保存', 'warn')
    } catch (error) {
      setState(error.message || '图片处理失败', 'danger')
    } finally {
      fileInput.value = ''
    }
  })

  removeButton.addEventListener('click', () => {
    pendingDataUrl = ''
    pendingRemove = true
    avatarUrl = ''
    refresh()
    setState('头像待恢复默认', 'warn')
  })

  saveButton.addEventListener('click', async () => {
    const name = nameInput.value.trim()
    if (!name) {
      setState('助手名称不能为空', 'danger')
      nameInput.focus()
      return
    }
    saveButton.disabled = true
    setState('保存中…', 'warn')
    try {
      const payload = { name }
      if (pendingDataUrl) payload.avatarDataUrl = pendingDataUrl
      else if (pendingRemove) payload.removeAvatar = true
      const result = await apiSend('PUT', '/api/console/company/assistant', payload)
      const saved = result.assistant || {}
      nameInput.value = saved.name || name
      avatarUrl = saved.avatarUrl || ''
      pendingDataUrl = ''
      pendingRemove = false
      refresh()
      setState('已保存', 'ok')
    } catch (error) {
      setState(error.message || '保存失败', 'danger')
    } finally {
      saveButton.disabled = false
    }
  })

  refresh()
}

async function loadCompanyProfile() {
  const view = $('#view')
  renderLoading(view)
  setSide('', true)
  try {
    const data = await api('/api/console/company')
    const company = data.company
    const counts = data.counts
    const active = company.status === 'active'
    const channelRows = data.channels
      .map(
        (channel) => `<tr>
          <td><strong>${esc(CHANNEL_PROVIDER_LABEL[channel.provider] || channel.provider)}</strong>
            <div class="desc mono">${esc(channel.provider)}</div></td>
          <td><span class="pill ${channel.status === 'bound' ? 'ok' : channel.status === 'error' ? 'danger' : 'warn'}">${esc(
            CHANNEL_STATUS_LABEL[channel.status] || channel.status,
          )}</span></td>
          <td>${esc(channel.tenantName || '—')}<div class="desc mono">${esc(channel.tenantId || channel.corpId || '')}</div></td>
          <td>${channel.enabled ? '已启用' : '未启用'}</td>
          <td>${esc(fmtDateTime(channel.lastSyncedAt))}</td>
        </tr>`,
      )
      .join('')
    const assistant = data.assistant || { name: 'AI', avatarUrl: '' }

    view.innerHTML = `
      <section class="panel">
        <div class="panel-head">
          <div><h2>${esc(company.name)}</h2><span class="hint mono">${esc(company.slug)} · ${esc(company.id)}</span>${hintBadge(
            active ? '状态说明' : '停用说明',
            active ? '成员可以正常登录对话；停用后成员登录会被拒绝，控制台仍可管理。' : '成员登录会被拒绝；重新启用后立即恢复。',
          )}</div>
          <div class="company-head-actions">
            <span class="pill ${active ? 'ok' : 'danger'}">${active ? '在营' : '已停用'}</span>
            <button class="btn sm primary" type="button" id="company-rename">重命名</button>
            <button class="btn sm ghost" type="button" id="company-refresh">刷新</button>
          </div>
        </div>
        <div class="kv-grid kv-2">
          <div><span>公司名称</span><strong>${esc(company.name)}</strong></div>
          <div><span>公司标识（slug）</span><strong class="mono">${esc(company.slug)}</strong></div>
          <div><span>创建时间</span><strong>${esc(fmtDateTime(company.createdAt))}</strong></div>
          <div><span>组织根节点</span><strong>${esc(company.rootDeptName || '—')}</strong></div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div><h2>助手身份</h2>${hintBadge(
            '展示位置',
            '显示在员工工作台 AI 消息左侧：头像在上，名字在下方。不配置时使用默认「AI」。',
          )}</div>
          <span class="pill" id="assistant-save-state">未修改</span>
        </div>
        <div class="assistant-editor">
          <div class="assistant-avatar" id="assistant-avatar-preview">
            ${assistantAvatarPreview(assistant.name, assistant.avatarUrl)}
          </div>
          <div class="assistant-fields">
            <label class="field">
              <span>助手名称 <em>最多 40 个字</em></span>
              <input id="assistant-name" maxlength="40" value="${esc(assistant.name)}" autocomplete="off" />
            </label>
            <div class="assistant-actions">
              <div class="assistant-media-actions">
                <label class="btn sm ghost assistant-upload">上传图片
                  <input id="assistant-avatar-file" type="file" accept="image/png,image/jpeg,image/webp" hidden />
                </label>
                <button class="btn sm ghost" type="button" id="assistant-avatar-remove">恢复默认头像</button>
                ${hintBadge('头像要求', '建议正方形 1:1，选择后会自动裁切并压到 512px；单张不超过 1 MB。头像只保存在本机数据目录。')}
              </div>
              <button class="btn sm primary assistant-save" type="button" id="assistant-save">保存</button>
            </div>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><div><h2>规模</h2>${hintBadge('统计说明', '来自当前库，实时统计；成员包含在职与停用，部门包含根节点以下全部层级。')}</div></div>
        <div class="stats">
          <div class="stat"><div class="stat-label">成员</div><div class="stat-value">${fmtNum(counts.members)}<span class="stat-unit">在职 ${fmtNum(counts.activeMembers)}</span></div></div>
          <div class="stat"><div class="stat-label">部门</div><div class="stat-value">${fmtNum(counts.departments)}</div></div>
          <div class="stat"><div class="stat-label">知识库</div><div class="stat-value">${fmtNum(counts.collections)}</div></div>
          <div class="stat"><div class="stat-label">对话会话</div><div class="stat-value">${fmtNum(counts.chatSessions)}</div></div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><div><h2>渠道绑定</h2>${hintBadge('渠道说明', '一个渠道一行；绑定与解绑统一在「连接与平台 → 渠道 → 企业一键绑定」操作。')}</div>
          <button class="btn sm ghost" type="button" id="company-goto-channel">去渠道页</button></div>
        <table class="data">
          <thead><tr><th>渠道</th><th>状态</th><th>组织 / 租户</th><th>启用</th><th>最近同步</th></tr></thead>
          <tbody>${channelRows || '<tr><td colspan="5" class="empty">还没有绑定任何渠道</td></tr>'}</tbody>
        </table>
      </section>

      <section class="panel">
        <div class="panel-head"><div><h2>危险操作</h2><span class="hint">不可撤销，执行前请确认已导出需要保留的数据</span></div></div>
        <div class="setup-list">
          <div class="setup-row">
            <span class="setup-state ${active ? '' : 'done'}">${active ? '在营' : '已停用'}</span>
            <div class="setup-main"><strong>${active ? '停用公司' : '启用公司'}</strong><span>${
              active ? '停用后成员无法登录，数据保留；可随时启用。' : '启用后成员立即恢复登录。'
            }</span></div>
            <button class="btn sm ${active ? 'ghost' : 'primary'}" type="button" id="company-toggle">${active ? '停用' : '启用'}</button>
          </div>
          <div class="setup-row">
            <span class="setup-state">危险</span>
            <div class="setup-main"><strong>彻底删除公司</strong><span>删除该公司的全部成员、部门、会话、知识库与配置，回到空库。需要输入公司名称确认。</span></div>
            <button class="btn sm danger" type="button" id="company-delete">删除</button>
          </div>
        </div>
      </section>`

    setPageActions('')

    $('#company-refresh')?.addEventListener('click', () => loadCompanyProfile())
    $('#company-goto-channel')?.addEventListener('click', () => navigate('channels'))
    $('#company-rename')?.addEventListener('click', () => openCompanyRename(company))
    $('#company-toggle')?.addEventListener('click', () => toggleCompanyStatus(company))
    $('#company-delete')?.addEventListener('click', () => deleteCompany(company))
    bindAssistantEditor(assistant)
  } catch (err) {
    renderDenied(view, err)
  }
}

function openCompanyRename(company) {
  const overlay = modelModal(`
    <div class="modal-head"><h3>重命名公司</h3><button class="modal-x" type="button">×</button></div>
    <div class="field-stack">
      <label class="field"><span>公司名称</span><input id="co-name" value="${esc(company.name)}" maxlength="80" /></label>
      ${hintNote('改名说明', '改名会同步组织树根节点与成员部门显示，不需要重新同步通讯录。')}
    </div>
    <div class="modal-state" id="co-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="co-save">保存</button>
      <button class="btn ghost" type="button" id="co-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#co-cancel').addEventListener('click', close)
  overlay.querySelector('#co-save').addEventListener('click', async () => {
    const name = overlay.querySelector('#co-name').value.trim()
    const stateEl = overlay.querySelector('#co-state')
    if (!name) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '公司名称不能为空'
      return
    }
    stateEl.className = 'modal-state'
    stateEl.textContent = '保存中…'
    try {
      await apiSend('PATCH', `/api/console/companies/${encodeURIComponent(company.id)}`, { name })
      close()
      await loadCompanies()
      loadCompanyProfile()
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '保存失败'
    }
  })
}

async function toggleCompanyStatus(company) {
  const next = company.status === 'active' ? 'suspended' : 'active'
  if (next === 'suspended') {
    const ok = await confirmCard({
      title: '停用公司？',
      message: `停用「${company.name}」后，所有成员立即无法登录对话，数据保留。`,
      confirmText: '停用公司',
      tone: 'warning',
    })
    if (!ok) return
  }
  try {
    await apiSend('PATCH', `/api/console/companies/${encodeURIComponent(company.id)}`, { status: next })
    loadCompanyProfile()
  } catch (err) {
    alert(err.message || '操作失败')
  }
}

async function deleteCompany(company) {
  const ok = await confirmCard({
    title: '删除公司？',
    message: `彻底删除「${company.name}」会清空全部数据，且不可恢复。`,
    detail: '包括部门、成员、角色、知识库、模型、渠道、会话和审计数据。',
    requireText: company.name,
    requireHint: `请输入公司名称「${company.name}」确认`,
    confirmText: '删除公司',
  })
  if (!ok) return
  try {
    await apiSend('DELETE', `/api/console/companies/${encodeURIComponent(company.id)}`)
    alert('公司已删除。请在控制台用「钉钉扫码绑定组织」重新接入。')
    location.replace('/admin')
  } catch (err) {
    alert(err.message || '删除失败')
  }
}

/* ---------------- 额度与用量治理 ---------------- */

const QUOTA_SCOPE_LABEL = { company: '公司', dept: '部门', user: '成员' }

function quotaUsageCell(usage, quota) {
  const reqLimit = quota?.requests ?? null
  const tokenLimit = quota?.tokens ?? null
  const ratios = []
  if (reqLimit) ratios.push(usage.requests / reqLimit)
  if (tokenLimit) ratios.push(usage.totalTokens / tokenLimit)
  if (ratios.length === 0) {
    return { text: '', pct: 0, cls: 'none', pill: '' }
  }
  const ratio = Math.max(...ratios)
  const pct = Math.round(ratio * 100)
  const cls = ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'warn' : 'ok'
  const pill =
    ratio >= 1
      ? '<span class="pill danger">已超额</span>'
      : ratio >= 0.8
        ? '<span class="pill warn">接近上限</span>'
        : '<span class="pill ok">正常</span>'
  return { text: `${pct}%`, pct: Math.min(pct, 100), cls, pill }
}

function quotaLimitText(quota) {
  if (!quota) return '<span class="muted">未设上限</span>'
  const req = quota.requests === null ? '请求不限' : `请求 ${fmtNum(quota.requests)} 次/月`
  const tokens = quota.tokens === null ? 'token 不限' : `token ${fmtNum(quota.tokens)}/月`
  const mode = quota.mode === 'soft' ? '<span class="chip">软限制</span>' : '<span class="chip accent">硬限制</span>'
  return `<div class="quota-limit-line">${req}</div><div class="quota-limit-line">${tokens} ${mode}</div>`
}

function quotaBar(cell) {
  if (cell.cls === 'none') return '<span class="muted">—</span>'
  return `<div class="quota-bar"><span class="quota-fill ${cell.cls}" style="width:${cell.pct}%"></span></div>`
}

function quotaUsageCellHtml(cell) {
  if (cell.cls === 'none') return '<span class="muted">—</span>'
  return `<div class="quota-usage">${quotaBar(cell)}<div class="quota-usage-meta"><span class="desc">${cell.text}</span>${cell.pill}</div></div>`
}

async function loadQuota(month = state.quotaMonth || '') {
  const view = $('#view')
  renderLoading(view)
  const scope = state.quotaScope
  setSide('', true)
  setPageActions(`
    <div class="segmented">
      ${['company', 'dept', 'user']
        .map(
          (item) =>
            `<button class="${scope === item ? 'active' : ''}" type="button" data-quota-scope="${item}">${QUOTA_SCOPE_LABEL[item]}额度${item === 'dept' ? '（含下级）' : ''}</button>`,
        )
        .join('')}
    </div>`)
  for (const button of document.querySelectorAll('[data-quota-scope]')) {
    button.addEventListener('click', () => {
      state.quotaScope = button.dataset.quotaScope
      loadQuota(month)
    })
  }
  try {
    const query = month ? `?month=${encodeURIComponent(month)}` : ''
    const data = await api(`/api/console/quotas${query}`)
    state.quotaMonth = data.month
    const totals = data.totals
    const header = `
      <section class="panel">
        <div class="panel-head">
          <div><h2>${esc(data.month)} · 额度与用量</h2><span class="hint">${esc(data.company.name)}</span>${hintBadge('判定顺序', '额度按成员 → 部门 → 公司逐级判定；成员额度优先，部门额度覆盖整棵子树。')}</div>
          <div class="panel-actions">
            <label class="field-inline"><span>月份</span><input type="month" id="quota-month" value="${esc(data.month)}" /></label>
          </div>
        </div>
        <div class="stats">
          <div class="stat"><div class="stat-label">本月请求</div><div class="stat-value">${fmtNum(totals.requests)}</div></div>
          <div class="stat"><div class="stat-label">本月 token</div><div class="stat-value">${fmtNum(totals.totalTokens)}<span class="stat-unit">prompt ${fmtNum(totals.promptTokens)}</span></div></div>
          <div class="stat"><div class="stat-label">已设额度</div><div class="stat-value">${fmtNum(
            data.departments.filter((item) => item.quota).length + (data.company.quota ? 1 : 0) + data.members.filter((item) => item.quota).length,
          )}<span class="stat-unit">条</span></div></div>
          <div class="stat"><div class="stat-label">公司上限</div><div class="stat-value">${data.company.quota ? `${fmtNum(data.company.quota.requests ?? 0)}<span class="stat-unit">次/月</span>` : '不限'}</div></div>
        </div>
      </section>`

    let table = ''
    if (scope === 'company') {
      const usage = data.company.usage
      const cell = quotaUsageCell(usage, data.company.quota)
      table = `
        <section class="panel">
          <div class="panel-head"><div><h2>公司月度额度</h2>${hintBadge('额度规则', '所有成员共享同一个上限；达到上限后本月新的对话请求会被拦截。')}</div>
            <button class="btn sm ghost" type="button" data-quota-edit="company" data-scope-id="${esc(data.company.id)}" data-scope-name="${esc(data.company.name)}">设置额度</button></div>
          <div class="table-wrap"><table class="data quota-table">
            <thead><tr><th>范围</th><th class="num">请求</th><th class="num">token</th><th>上限</th><th>使用率</th></tr></thead>
            <tbody><tr>
              <td><strong>${esc(data.company.name)}</strong><div class="desc">全公司</div></td>
              <td class="num">${fmtNum(usage.requests)}</td>
              <td class="num">${fmtNum(usage.totalTokens)}</td>
              <td>${quotaLimitText(data.company.quota)}</td>
              <td>${quotaUsageCellHtml(cell)}</td>
            </tr></tbody>
          </table></div>
        </section>`
    } else if (scope === 'dept') {
      const rows = data.departments
        .map((dept) => {
          const cell = quotaUsageCell(dept.usage, dept.quota)
          return `<tr>
            <td><strong>${esc(dept.name)}</strong><div class="desc mono">${esc(dept.path)}</div></td>
            <td class="num">${fmtNum(dept.members)}</td>
            <td class="num">${fmtNum(dept.usage.requests)}</td>
            <td class="num">${fmtNum(dept.usage.totalTokens)}</td>
            <td>${quotaLimitText(dept.quota)}</td>
            <td>${quotaUsageCellHtml(cell)}</td>
            <td><div class="row-actions">
              <button class="link-btn" type="button" data-quota-edit="dept" data-scope-id="${esc(dept.id)}" data-scope-name="${esc(dept.name)}">设置</button>
              ${dept.quota ? `<button class="link-btn danger-link" type="button" data-quota-clear="dept" data-scope-id="${esc(dept.id)}">清除</button>` : ''}
            </div></td>
          </tr>`
        })
        .join('')
      table = `
        <section class="panel">
          <div class="panel-head"><div><h2>部门额度</h2>${hintBadge('额度规则', '部门额度覆盖整棵子树，下级的用量也算在这里。')}</div></div>
          <div class="table-wrap"><table class="data quota-table wide">
            <thead><tr><th>部门</th><th class="num">成员</th><th class="num">请求</th><th class="num">token</th><th>上限</th><th>使用率</th><th>操作</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="7" class="empty">还没有部门</td></tr>'}</tbody>
          </table></div>
        </section>`
    } else {
      const rows = data.members
        .map((member) => {
          const cell = quotaUsageCell(member.usage, member.quota)
          return `<tr>
            <td><strong>${esc(member.name)}</strong><div class="desc mono">${esc(member.id)}</div></td>
            <td>${esc(member.deptName)}</td>
            <td><span class="pill ${member.status === 'active' ? 'ok' : 'warn'}">${esc(STATUS_LABEL[member.status] || member.status)}</span></td>
            <td class="num">${fmtNum(member.usage.requests)}</td>
            <td class="num">${fmtNum(member.usage.totalTokens)}</td>
            <td>${quotaLimitText(member.quota)}</td>
            <td>${quotaUsageCellHtml(cell)}</td>
            <td><div class="row-actions">
              <button class="link-btn" type="button" data-quota-edit="user" data-scope-id="${esc(member.id)}" data-scope-name="${esc(member.name)}">设置</button>
              ${member.quota ? `<button class="link-btn danger-link" type="button" data-quota-clear="user" data-scope-id="${esc(member.id)}">清除</button>` : ''}
            </div></td>
          </tr>`
        })
        .join('')
      table = `
        <section class="panel">
          <div class="panel-head"><div><h2>成员额度</h2>${hintBadge('额度规则', '成员额度优先级最高：个人用完即拦，不影响同部门其他人。')}</div></div>
          <div class="table-wrap"><table class="data quota-table wide">
            <thead><tr><th>成员</th><th>部门</th><th>状态</th><th class="num">请求</th><th class="num">token</th><th>上限</th><th>使用率</th><th>操作</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="8" class="empty">还没有成员</td></tr>'}</tbody>
          </table></div>
        </section>`
    }

    view.innerHTML = header + table
    $('#quota-month')?.addEventListener('change', (event) => loadQuota(event.target.value))

    const scopeRows =
      scope === 'company'
        ? [{ scopeType: 'company', scopeId: data.company.id, name: data.company.name, quota: data.company.quota }]
        : scope === 'dept'
          ? data.departments.map((dept) => ({ scopeType: 'dept', scopeId: dept.id, name: dept.name, quota: dept.quota }))
          : data.members.map((member) => ({ scopeType: 'user', scopeId: member.id, name: member.name, quota: member.quota }))

    for (const button of view.querySelectorAll('[data-quota-edit]')) {
      button.addEventListener('click', () => {
        const row = scopeRows.find(
          (item) => item.scopeType === button.dataset.quotaEdit && item.scopeId === button.dataset.scopeId,
        )
        if (row) openQuotaEdit(row)
      })
    }
    for (const button of view.querySelectorAll('[data-quota-clear]')) {
      button.addEventListener('click', async () => {
        const ok = await confirmCard({
          title: '清除额度？',
          message: '清除后该范围不再受月度上限约束。',
          confirmText: '清除额度',
          tone: 'warning',
        })
        if (!ok) return
        try {
          await apiSend(
            'DELETE',
            `/api/console/quotas/${button.dataset.quotaClear}/${encodeURIComponent(button.dataset.scopeId)}`,
          )
          loadQuota(state.quotaMonth)
        } catch (err) {
          alert(err.message || '清除失败')
        }
      })
    }
  } catch (err) {
    renderDenied(view, err)
  }
}

function openQuotaEdit(row) {
  const quota = row.quota
  const label = QUOTA_SCOPE_LABEL[row.scopeType]
  const overlay = modelModal(`
    <div class="modal-head"><h3>${label}额度 · ${esc(row.name)}</h3><button class="modal-x" type="button">×</button></div>
    <div class="field-stack">
      <label class="field"><span>每月请求上限（留空 = 不限）</span><input id="q-requests" type="number" min="0" step="1" value="${quota?.requests ?? ''}" placeholder="例如 2000" /></label>
      <label class="field"><span>每月 token 上限（留空 = 不限）</span><input id="q-tokens" type="number" min="0" step="1" value="${quota?.tokens ?? ''}" placeholder="例如 500000" /></label>
      <label class="field"><span>超限处理</span><select id="q-mode">
        <option value="hard"${quota?.mode !== 'soft' ? ' selected' : ''}>硬限制：用尽即拒绝对话</option>
        <option value="soft"${quota?.mode === 'soft' ? ' selected' : ''}>软限制：只记录不拦截</option>
      </select></label>
      ${hintNote('判定说明', `${label === '部门' ? '部门额度覆盖整棵子树；' : ''}至少填一个上限。判定顺序为成员 → 部门 → 公司。`)}
    </div>
    <div class="modal-state" id="q-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="q-save">保存</button>
      <button class="btn ghost" type="button" id="q-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#q-cancel').addEventListener('click', close)
  overlay.querySelector('#q-save').addEventListener('click', async () => {
    const requestsRaw = overlay.querySelector('#q-requests').value.trim()
    const tokensRaw = overlay.querySelector('#q-tokens').value.trim()
    const mode = overlay.querySelector('#q-mode').value
    const stateEl = overlay.querySelector('#q-state')
    const requests = requestsRaw === '' ? null : Number(requestsRaw)
    const tokens = tokensRaw === '' ? null : Number(tokensRaw)
    if (requests === null && tokens === null) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '请求数和 token 至少要设一个上限'
      return
    }
    if ((requests !== null && (!Number.isInteger(requests) || requests < 0)) || (tokens !== null && (!Number.isInteger(tokens) || tokens < 0))) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '上限需要是 0 或正整数'
      return
    }
    stateEl.className = 'modal-state'
    stateEl.textContent = '保存中…'
    try {
      await apiSend('PUT', `/api/console/quotas/${row.scopeType}/${encodeURIComponent(row.scopeId)}`, {
        monthlyRequests: requests,
        monthlyTokens: tokens,
        mode,
        enabled: true,
      })
      close()
      loadQuota(state.quotaMonth)
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '保存失败'
    }
  })
}

async function loadAudit(action = '', page = 0) {
  const view = $('#view')
  renderLoading(view)
  setSide(`
    <div class="side-head audit-side-head"><span class="side-title">审计</span>${hintBadge('审计说明', '审计表 append-only + 哈希链；导出行为本身也会写一条审计。')}</div>
    <div class="side-list">
      <button class="side-item ${action ? '' : 'is-active'}" type="button" id="audit-all">全部操作</button>
      <button class="side-item ${action === 'org.member' ? 'is-active' : ''}" type="button" data-audit-action="org.member">成员变更</button>
      <button class="side-item ${action === 'org.dept' ? 'is-active' : ''}" type="button" data-audit-action="org.dept">部门变更</button>
      <button class="side-item ${action === 'chat' ? 'is-active' : ''}" type="button" data-audit-action="chat">对话</button>
      <button class="side-item ${action === 'auth' ? 'is-active' : ''}" type="button" data-audit-action="auth">登录</button>
      <button class="side-item ${action === 'plugin' ? 'is-active' : ''}" type="button" data-audit-action="plugin">插件</button>
    </div>`)
  $('#audit-all')?.addEventListener('click', () => loadAudit(''))
  for (const button of document.querySelectorAll('[data-audit-action]')) {
    button.addEventListener('click', () => loadAudit(button.dataset.auditAction))
  }
  try {
    const AUDIT_PAGE_SIZE = 30
    const data = await api(`/api/console/audit?limit=${AUDIT_PAGE_SIZE}&offset=${page * AUDIT_PAGE_SIZE}${action ? `&action=${encodeURIComponent(action)}` : ''}`)
    const rows = data.items
      .map(
        (item) => `<tr>
          <td class="mono">#${item.seq}</td>
          <td><span class="chip">${esc(item.action)}</span><div class="desc">${esc(item.resourceType || '')} ${esc(item.resourceId || '')}</div></td>
          <td>${esc(item.actorUserId || '—')}</td>
          <td><span class="pill ${item.result === 'success' ? 'ok' : 'warn'}">${esc(item.result)}</span></td>
          <td class="mono">${esc(item.ip || '—')}</td>
          <td class="mono desc">${esc(item.createdAt)}</td>
        </tr>`,
      )
      .join('')
    view.innerHTML = `
      <section class="panel">
        <div class="panel-head">
          <div><h2>操作记录</h2><span class="hint">${data.total} 条${action ? ` · 过滤 ${esc(action)}` : ''}</span></div>
          <div class="panel-actions">
            <button class="btn sm ghost" type="button" id="audit-verify">校验哈希链</button>
            <button class="btn sm ghost" type="button" id="audit-csv">导出 CSV</button>
            <button class="btn sm ghost" type="button" id="audit-json">导出 JSON</button>
          </div>
        </div>
        <div id="audit-verify-result"></div>
        <div class="table-scroll">
          <table class="data">
            <thead><tr><th>序号</th><th>动作</th><th>操作者</th><th>结果</th><th>IP</th><th>时间</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="6" class="empty">没有记录</td></tr>'}</tbody>
          </table>
        </div>
        ${pagerHtml(data.total, page, AUDIT_PAGE_SIZE)}
        <div class="hint" style="padding:12px 2px 0">共 ${data.total} 条，每页 ${AUDIT_PAGE_SIZE} 条 ${hintBadge('导出说明', '导出包含最近 10 万条；更早的记录不会写入导出文件。')}</div>
      </section>`
    bindPager(view, (next) => loadAudit(action, next))
    $('#audit-verify')?.addEventListener('click', async () => {
      const box = $('#audit-verify-result')
      try {
        const result = await api('/api/console/audit/verify')
        box.innerHTML = `<div class="banner ${result.ok ? '' : 'danger'}"><strong>${result.ok ? '哈希链完整' : '哈希链断裂'}</strong><span>检查 ${result.checked ?? '—'} 条${result.pruned ? ` · 已清理到 #${result.pruned}` : ''}${result.brokenAt ? ` · 首个异常 #${result.brokenAt}` : ''}</span></div>`
      } catch (err) {
        box.innerHTML = `<div class="banner danger"><strong>校验失败</strong><span>${esc(err.message)}</span></div>`
      }
    })
    $('#audit-csv')?.addEventListener('click', () => downloadConsoleFile('/api/console/audit/export?format=csv', 'audit.csv').catch((err) => alert(err.message)))
    $('#audit-json')?.addEventListener('click', () => downloadConsoleFile('/api/console/audit/export?format=json', 'audit.json').catch((err) => alert(err.message)))
  } catch (err) {
    renderDenied(view, err)
  }
}

async function loadApprovals() {
  const view = $('#view')
  renderLoading(view)
  setSide('', true)
  try {
    const data = await api('/api/console/approvals?status=all')
    const rows = data.items
      .map(
        (item) => `<tr>
          <td>${esc(item.requesterName)}<div class="desc mono">${esc(item.requesterUserId)}</div></td>
          <td><span class="chip accent">${esc(item.action)}</span><div class="desc">${esc(item.resourceType)} ${esc(item.resourceId || '')}</div></td>
          <td><span class="pill ${item.status === 'pending' ? 'warn' : item.status === 'approved' ? 'ok' : 'danger'}">${esc(item.status)}</span></td>
          <td class="mono desc">${esc(item.createdAt)}</td>
          <td>${
            item.status === 'pending'
              ? `<div class="row-actions"><button class="link-btn accent" type="button" data-approve="${esc(item.id)}">通过</button><button class="link-btn danger-link" type="button" data-reject="${esc(item.id)}">拒绝</button></div>`
              : `<span class="muted">${esc(item.decidedBy || '—')}</span>`
          }</td>
        </tr>`,
      )
      .join('')
    view.innerHTML = `
      <section class="panel">
        <div class="panel-head"><div><h2>审批</h2>${hintBadge('审批说明', '高危动作需要先申请，再由控制台决定；通过或拒绝都会写审计。')}</div></div>
        <table class="data">
          <thead><tr><th>申请人</th><th>动作</th><th>状态</th><th>提交时间</th><th>操作</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="empty">没有审批记录。插件高危能力、跨部门导出等动作会在这里生成待办。</td></tr>'}</tbody>
        </table>
      </section>`
    for (const button of view.querySelectorAll('[data-approve], [data-reject]')) {
      button.addEventListener('click', async () => {
        const id = button.dataset.approve || button.dataset.reject
        const decision = button.dataset.approve ? 'approved' : 'rejected'
        try {
          await apiPost(`/api/console/approvals/${encodeURIComponent(id)}/decide`, { decision })
          loadApprovals()
        } catch (err) {
          alert(err.message)
        }
      })
    }
  } catch (err) {
    renderDenied(view, err)
  }
}

/* ---------------- 组织同步 ---------------- */

const STAT_LABEL = {
  deptsCreated: '新建部门',
  deptsRenamed: '部门改名',
  deptsMoved: '部门移动',
  deptsMissing: '部门缺失',
  deptsRecycled: '部门回收',
  deptsRestored: '部门恢复',
  usersCreated: '新建成员',
  usersUpdated: '成员变更',
  usersDeparted: '成员离职',
  usersMissing: '成员缺失',
  usersDisabled: '成员禁用',
  usersRestored: '成员恢复',
  identitiesCreated: '渠道身份(pending)',
  unchanged: '无变化',
  orphans: '孤儿部门',
  unassignedUsers: '无部门成员',
}

const ACTION_LABEL = {
  'dept.create': '新建部门',
  'dept.rename': '部门改名',
  'dept.move': '部门移动',
  'dept.restore': '部门恢复',
  'dept.missing': '部门缺失',
  'dept.recycle': '部门回收',
  'user.create': '新建成员',
  'user.update': '成员变更',
  'user.depart': '成员离职',
  'user.missing': '成员缺失',
  'user.disable': '成员禁用',
  'user.restore': '成员恢复',
  'identity.create': '生成渠道身份',
}

function statChips(stats) {
  if (!stats) return '<span class="muted">—</span>'
  const chips = Object.entries(STAT_LABEL)
    .filter(([key]) => Number(stats[key] ?? 0) > 0)
    .map(([key, label]) => `<span class="chip">${esc(label)} <strong>${Number(stats[key])}</strong></span>`)
  return chips.join(' ') || '<span class="muted">无变化</span>'
}

async function loadSync() {
  const view = $('#view')
  renderLoading(view)
  setSide('', true)
  try {
    const [channels, runs, bindings] = await Promise.all([
      api('/api/console/channels'),
      api('/api/org/sync-runs?limit=10&offset=0').catch(() => ({ runs: [], total: 0 })),
      api('/api/channel/bindings').catch(() => ({ bindings: [], devAuth: false })),
    ])
    renderSync(channels, runs, bindings)
    if (new URLSearchParams(location.search).get('open') === 'dingtalk') {
      openDingTalkOnboard()
      const url = new URL(location.href)
      url.searchParams.delete('open')
      url.searchParams.delete('goto')
      history.replaceState(null, '', url.toString())
    }
  } catch (err) {
    renderDenied(view, err)
  }
}

function channelConfigCard(item, options = {}) {
  const bound = Boolean(options.bound ?? item.bound)
  const secondary = Boolean(options.secondary)
  const hasCredentials = Boolean(item.appId && item.appSecretConfigured)
  const hasWebhook = Boolean(item.webhookUrl)
  const configured = hasCredentials || hasWebhook
  const topState = bound ? '已绑定' : hasCredentials ? '凭证已配置' : hasWebhook ? '仅配置了 Webhook' : '待配置'
  const badges = [
    item.appId
      ? `<span class="pill ok">应用凭证</span>`
      : `<span class="pill">应用凭证未配置</span>`,
    item.appSecretConfigured
      ? `<span class="pill ok">密钥已保存</span>`
      : `<span class="pill warn">密钥未配置</span>`,
    item.webhookUrl
      ? `<span class="pill ok">Webhook</span>`
      : `<span class="pill">Webhook 未配置</span>`,
  ].join('')
  const callback = item.callbackToken
    ? `<div class="callback-row"><span>回调地址</span><code>${esc(item.callbackPath)}?token=${esc(
        item.callbackToken.slice(0, 8),
      )}…</code><button class="link-btn" type="button" data-copy-callback="${esc(item.provider)}">复制完整地址</button></div>`
    : ''
  return `<div class="channel-config${bound ? ' is-bound' : ''}${secondary ? ' is-secondary' : ''}">
    <div class="channel-config-head">
      <div><strong>${esc(item.label)}</strong>${hintBadge(
        '接入说明',
        bound
          ? '已完成企业绑定，机器人可以直接收发消息。'
          : hasCredentials
            ? '应用凭证已保存，可拉取真实通讯录并接收事件回调。'
            : '还没有填写应用凭证，无法拉取通讯录。',
      )}</div>
      <span class="pill ${bound || configured ? 'ok' : 'warn'}">${topState}</span>
    </div>
    <div class="channel-flags">${badges}</div>
    <dl class="channel-fields">
      <div><dt>App ID</dt><dd>${esc(item.appId || '—')}</dd></div>
      <div><dt>Agent ID</dt><dd>${esc(item.agentId || '—')}</dd></div>
      <div><dt>企业 ID</dt><dd>${esc(item.corpId || '—')}</dd></div>
      <div><dt>Webhook</dt><dd class="mono">${esc(item.webhookUrl ? `${item.webhookUrl.slice(0, 42)}…` : '—')}</dd></div>
    </dl>
    ${callback}
    <div class="channel-config-actions">
      <button class="btn" type="button" data-config-channel="${esc(item.provider)}">${configured ? '修改配置' : '配置接入'}</button>
      <button class="btn ghost" type="button" data-test-channel="${esc(item.provider)}">测试连接</button>
      <span class="channel-test" id="ch-test-${esc(item.provider)}"></span>
    </div>
  </div>`
}

function bindingCard(item, channel) {
  const demoBinding = item.bound && String(item.tenantName || item.tenantId || '').includes('演示')
  const ready = Boolean(channel?.appId && channel?.appSecretConfigured)
  const badge = demoBinding
    ? '<span class="badge warn">演示绑定</span>'
    : item.bound
      ? '<span class="badge ok">已绑定</span>'
      : '<span class="badge deny">未绑定</span>'
  const meta = item.bound
    ? `${esc(item.tenantName || item.tenantId)}<div class="desc">绑定时间 ${esc(
        new Date(item.boundAt).toLocaleString(),
      )}${item.lastSyncedAt ? ` · 上次同步 ${esc(new Date(item.lastSyncedAt).toLocaleString())}` : ''}${
        demoBinding
          ? item.provider === 'dingtalk'
            ? ' · 演示租户，绑定真实企业会被替换'
            : ' · 演示租户，可解除后重新绑定'
          : ''
      }</div>`
    : hintBadge('绑定方式', item.hint || '未绑定；完成企业授权后同步组织与成员。')
  let actions = ''
  if (item.bound && demoBinding) {
    actions =
      item.provider === 'dingtalk'
        ? `<button class="btn sm primary" data-bind-dingtalk>钉钉扫码绑定</button><button class="btn sm" data-unbind="${esc(
            item.provider,
          )}">解除演示绑定</button>`
        : `<button class="btn sm" data-unbind="${esc(item.provider)}">解除演示绑定</button>`
  } else if (item.bound) {
    actions = `${
      item.provider === 'dingtalk'
        ? `<button class="btn sm primary" data-bind-dingtalk>钉钉扫码绑定</button>`
        : ''
    }<button class="btn sm" data-unbind="${esc(item.provider)}">解绑</button>`
  } else if (item.provider === 'dingtalk') {
    actions = `<button class="btn sm primary" data-bind-dingtalk>钉钉扫码绑定</button>`
  } else if (ready) {
    actions = `<button class="btn sm primary" data-bind="${esc(item.provider)}">扫码绑定</button>`
  } else {
    actions = `<button class="btn sm" data-config-channel="${esc(item.provider)}">先配置接入</button>`
  }

  return `<div class="channel-card${item.bound ? ' is-bound' : ''}${demoBinding ? ' is-demo' : ''}">
      <div class="channel-top"><strong>${esc(item.label)}</strong>${badge}</div>
      <div class="channel-meta muted">${meta}</div>
      <div class="channel-actions">${actions}</div>
    </div>`
}

function renderSync(channels, data, bindings) {
  const view = $('#view')
  const list = channels?.channels ?? []
  const channelByProvider = new Map(list.map((item) => [item.provider, item]))
  const bindingList = bindings?.bindings ?? []
  const boundChannels = list.filter((item) => Boolean(item.bound))
  const unboundChannels = list.filter((item) => !item.bound)
  const bindingChannels = [...bindingList].sort((a, b) => Number(Boolean(b.bound)) - Number(Boolean(a.bound)))
  const primaryChannels = boundChannels.length ? boundChannels : list
  const secondaryChannels = boundChannels.length ? unboundChannels : []

  const SYNC_PAGE_SIZE = 10
  const syncVisible = () => list.some((item) => item.appSecretConfigured)
  const runRow = (run) => `<tr class="clickable" data-run="${esc(run.id)}">
        <td class="name-cell"><strong>${esc(fmtTime(run.startedAt))}</strong>
          <div class="desc mono">${esc(run.provider)} · ${esc(run.mode)}</div></td>
        <td><span class="badge ${run.status === 'ok' ? 'ok' : 'deny'}">${esc(run.status)}</span></td>
        <td>${statChips(run.stats)}</td>
        <td class="num">${run.diffCount} 条</td>
      </tr>`
  const runs = (data?.runs ?? []).filter(syncVisible).map(runRow).join('')
  const syncTotal = Number(data?.total ?? (data?.runs ?? []).length)

  const readyChannels = list.filter(
    (item) => item.appSecretConfigured && (item.provider === 'wecom' ? item.corpId : item.appId),
  )

  const paneBinding = `
    <section class="panel channel-pane" id="ch-binding" data-pane="binding">
      <div class="panel-head">
        <div><h2>企业一键绑定</h2>${hintBadge('绑定说明', '钉钉扫码一次完成绑定与首次同步；飞书 / 企微后续接入。钉钉扫码绑定后会自动拉取部门树与成员；重复绑定同一企业会原地更新并重跑同步。')}</div>
        ${hintBadge('租户规则', '一个租户只归一家公司；绑定关系与同步结果都会写审计。')}
      </div>
      ${
        bindingList.length
          ? `<div class="channel-binding-grid">${bindingChannels
              .map((item) => bindingCard(item, channelByProvider.get(item.provider)))
              .join('')}</div>`
          : '<div class="inline-note">没有读到绑定状态。点右上角「刷新状态」重试，或检查控制台会话。</div>'
      }
      <div class="inline-note" id="binding-state" style="margin-top:10px"></div>
    </section>`

  const paneConfig = `
    <section class="panel channel-pane" id="ch-config" data-pane="config" hidden>
      <div class="panel-head">
        <div><h2>渠道接入</h2>${hintBadge('展示说明', '已绑定的企业优先显示；未绑定渠道收在下方，避免抢占视线。')}</div>
      </div>
      <div class="channel-tier-head">
        <div>
          <strong>${boundChannels.length ? '已绑定渠道' : '渠道配置'}</strong>
          <span>${
            boundChannels.length
              ? `当前有 ${boundChannels.length} 个渠道完成企业绑定，机器人可以直接收发消息。`
              : '还没有完成企业绑定的渠道，先配置凭证并完成绑定。'
          }</span>
        </div>
        <span class="pill ${boundChannels.length ? 'ok' : 'warn'}">${
          boundChannels.length ? `${boundChannels.length} 个已绑定` : '0 个已绑定'
        }</span>
      </div>
      <div class="channel-config-grid channel-config-grid-primary">${primaryChannels
        .map((item) => channelConfigCard(item, { bound: Boolean(item.bound) }))
        .join('')}</div>
      ${
        secondaryChannels.length
          ? `<details class="channel-secondary">
              <summary>
                <div><strong>其他渠道</strong>${hintBadge('收纳说明', '未绑定渠道收在下方；配置凭证后可接入，不占用主视线。')}</div>
                <span class="channel-more-count">${secondaryChannels.length} 个待接入 <span class="channel-more-chevron" aria-hidden="true">⌄</span></span>
              </summary>
              <div class="channel-config-grid channel-config-grid-secondary">${secondaryChannels
                .map((item) => channelConfigCard(item, { bound: false, secondary: true }))
                .join('')}</div>
            </details>`
          : ''
      }
      <div class="inline-note" id="channel-state"></div>
    </section>`

  const paneSync = `
    <section class="panel channel-pane" id="ch-sync" data-pane="sync" hidden>
      <div class="panel-head">
        <div><h2>通讯录同步</h2>${hintBadge('同步说明', '从渠道 API 真实拉取部门与成员，按差异写回组织架构；不会删除外部系统里已有的数据。')}</div>
        <span class="pill">真实 API</span>
      </div>
      <div class="sync-actions">
        ${
          readyChannels.length
            ? readyChannels
                .map(
                  (item) =>
                    `<button class="btn primary" type="button" data-sync-channel="${esc(item.provider)}">同步${esc(item.label)}通讯录</button>`,
                )
                .join('')
            : '<span class="hint">先在「渠道接入」里保存应用凭证，才能从飞书 / 钉钉 / 企业微信拉取通讯录。</span>'
        }
      </div>
      <div id="sync-result"></div>
    </section>`

  const paneHistory = `
    <section class="panel channel-pane" id="ch-history" data-pane="history" hidden>
      <div class="panel-head"><div><h2>同步记录</h2>${hintBadge('记录说明', '点一行查看差异；表格内滚动，翻页只换数据。')}</div>
        <span class="pill" id="sync-history-count">共 ${syncTotal} 条</span></div>
      <div class="table-scroll">
        <table class="data">
          <thead><tr><th>时间 / 渠道</th><th>状态</th><th>统计</th><th>差异</th></tr></thead>
          <tbody id="sync-history-body">${runs || '<tr><td colspan="4" class="empty">还没有同步记录</td></tr>'}</tbody>
        </table>
      </div>
      <div id="sync-history-pager">${pagerHtml(syncTotal, 0, SYNC_PAGE_SIZE)}</div>
      <div id="sync-detail"></div>
    </section>`

  const paneIdentity = `
    <section class="panel channel-pane" id="ch-identities" data-pane="identities" hidden>
      <div class="panel-head">
        <div><h2>外部账号绑定</h2>${hintBadge('身份说明', '飞书 open_id / 钉钉 staffId / 企微 UserId 绑定到 EAB 成员；未绑定不触发检索。钉钉私聊与网页共用同一份会话；解除绑定后两边都不再保留。')}</div>
        <button class="btn sm primary" type="button" id="ident-new">＋ 新增绑定</button>
      </div>
      <div id="ident-list"><span class="hint">加载中…</span></div>
    </section>`

  const pendingBindings = bindingList.filter((item) => !item.bound).length
  view.innerHTML = `
    <div class="channel-shell">
      <nav class="channel-tabs" role="tablist" aria-label="渠道分区">
        <button class="channel-tab is-active" type="button" role="tab" aria-selected="true" data-channel-tab="binding">
          <span>企业绑定</span>${pendingBindings ? `<em class="warn">${pendingBindings} 待绑</em>` : '<em class="ok">已就绪</em>'}
        </button>
        <button class="channel-tab" type="button" role="tab" aria-selected="false" data-channel-tab="config">
          <span>渠道接入</span><em>${boundChannels.length}/${list.length} 已绑</em>
        </button>
        <button class="channel-tab" type="button" role="tab" aria-selected="false" data-channel-tab="sync"><span>通讯录同步</span></button>
        <button class="channel-tab" type="button" role="tab" aria-selected="false" data-channel-tab="history">
          <span>同步记录</span><em>${syncTotal}</em>
        </button>
        <button class="channel-tab" type="button" role="tab" aria-selected="false" data-channel-tab="identities"><span>外部身份</span></button>
      </nav>
      <div class="channel-main">
        ${paneBinding}
        ${paneConfig}
        ${paneSync}
        ${paneHistory}
        ${paneIdentity}
      </div>
    </div>`


  const switchChannelTab = (tab) => {
    for (const button of view.querySelectorAll('[data-channel-tab]')) {
      const active = button.dataset.channelTab === tab
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-selected', active ? 'true' : 'false')
    }
    for (const pane of view.querySelectorAll('.channel-pane')) {
      pane.hidden = pane.dataset.pane !== tab
    }
  }
  for (const button of view.querySelectorAll('[data-channel-tab]')) {
    button.addEventListener('click', () => switchChannelTab(button.dataset.channelTab))
  }

  const bindHistoryRows = () => {
    for (const tr of view.querySelectorAll('#sync-history-body tr.clickable')) {
      tr.addEventListener('click', () => loadSyncRun(tr.getAttribute('data-run')))
    }
  }
  const paintHistory = async (page) => {
    const body = view.querySelector('#sync-history-body')
    const pager = view.querySelector('#sync-history-pager')
    const count = view.querySelector('#sync-history-count')
    if (!body || !pager) return
    body.innerHTML = '<tr><td colspan="4" class="empty">加载中…</td></tr>'
    try {
      const data = await api(`/api/org/sync-runs?limit=${SYNC_PAGE_SIZE}&offset=${page * SYNC_PAGE_SIZE}`)
      const rows = (data.runs ?? []).filter(syncVisible)
      body.innerHTML = rows.length
        ? rows.map(runRow).join('')
        : '<tr><td colspan="4" class="empty">没有更多记录</td></tr>'
      if (count) count.textContent = `共 ${data.total ?? rows.length} 条`
      pager.innerHTML = pagerHtml(data.total ?? rows.length, page, SYNC_PAGE_SIZE)
      bindHistoryRows()
      bindPager(pager, (next) => paintHistory(next))
    } catch (err) {
      body.innerHTML = `<tr><td colspan="4" class="empty">${esc(err.message)}</td></tr>`
    }
  }
  bindHistoryRows()
  bindPager(view.querySelector('#sync-history-pager'), (next) => paintHistory(next))

  view.querySelector('#ident-new')?.addEventListener('click', () => openIdentityModal())
  loadIdentities(view)

  for (const button of view.querySelectorAll('[data-config-channel]')) {
    button.addEventListener('click', () => openChannelModal(list.find((item) => item.provider === button.dataset.configChannel)))
  }
  for (const button of view.querySelectorAll('[data-test-channel]')) {
    button.addEventListener('click', async () => {
      const box = view.querySelector(`#ch-test-${button.dataset.testChannel}`)
      button.disabled = true
      if (box) box.textContent = '发送中…'
      try {
        const result = await apiPost(`/api/console/channels/${button.dataset.testChannel}/test`, {
          text: `EAB 渠道测试 · ${new Date().toLocaleString('zh-CN')}`,
        })
        if (box) box.innerHTML = `<span class="${result.ok ? 'ok-text' : 'bad-text'}">${esc(result.message)}</span>`
      } catch (err) {
        if (box) box.innerHTML = `<span class="bad-text">${esc(err.message)}</span>`
      } finally {
        button.disabled = false
      }
    })
  }
  for (const button of view.querySelectorAll('[data-copy-callback]')) {
    button.addEventListener('click', async () => {
      const item = list.find((entry) => entry.provider === button.dataset.copyCallback)
      if (!item) return
      const url = `${location.origin}${item.callbackPath}?token=${item.callbackToken}`
      try {
        await navigator.clipboard.writeText(url)
        button.textContent = '已复制'
      } catch {
        prompt('复制回调地址', url)
      }
    })
  }

  for (const button of view.querySelectorAll('button[data-bind]')) {
    button.addEventListener('click', () => startBind(button.dataset.bind, bindings))
  }
  for (const button of view.querySelectorAll('button[data-bind-dingtalk]')) {
    button.addEventListener('click', () =>
      openDingTalkOnboard(async () => {
        await loadSync()
        switchChannelTab('binding')
      }),
    )
  }
  for (const button of view.querySelectorAll('button[data-unbind]')) {
    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        await apiPost('/api/channel/unbind', { provider: button.dataset.unbind })
        await loadSync()
      } catch (err) {
        button.disabled = false
        renderDenied($('#sync-result') || view, err)
      }
    })
  }

  for (const button of view.querySelectorAll('button[data-sync-channel]')) {
    button.addEventListener('click', async () => {
      const channel = button.dataset.syncChannel
      const result = $('#sync-result')
      result.innerHTML = '<div class="loading">正在从渠道拉取通讯录…</div>'
      for (const other of view.querySelectorAll('button[data-sync-channel]')) other.disabled = true
      try {
        const outcome = await apiPost(`/api/console/channels/${channel}/sync`, {})
        const mobileHint =
          outcome.mobileCount === 0
            ? '<div class="inline-note is-warn">本次没有同步到手机号。若使用钉钉，请在开发者后台「权限管理 → 通讯录管理」勾选「企业员工手机号信息」并发布版本，然后再同步一次。</div>'
            : ''
        result.innerHTML = `
          <div class="panel" style="margin:0;box-shadow:none">
            <div class="panel-head"><div><h2>同步完成 · ${esc(outcome.provider)}</h2><span class="hint">${outcome.departments} 个部门 · ${outcome.members} 名成员 · ${outcome.mobileCount ?? 0} 个手机号 · ${outcome.diffCount} 条差异</span></div></div>
            <div class="chip-row">${statChips(outcome.stats)}</div>
            ${mobileHint}
            ${outcome.diffs.length ? syncDiffTable(outcome.diffs) : '<div class="inline-note">本次没有任何写入（幂等）</div>'}
          </div>`
      } catch (err) {
        result.innerHTML = ''
        renderDenied(result, err)
      } finally {
        for (const other of view.querySelectorAll('button[data-sync-channel]')) other.disabled = false
      }
    })
  }
  for (const anchor of view.querySelectorAll('[data-anchor]')) {
    anchor.addEventListener('click', () => {
      const target = document.getElementById(anchor.dataset.anchor)
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }
}

async function loadIdentities(view, page = 0) {
  const host = view.querySelector('#ident-list')
  if (!host) return
  const size = 10
  host.innerHTML = '<span class="hint">加载中…</span>'
  try {
    const data = await api(`/api/console/channel-identities?limit=${size}&offset=${page * size}`)
    const items = data.items || []
    const total = Number(data.total ?? items.length)
    if (!total) {
      host.innerHTML = '<span class="hint">还没有绑定。员工先在 /chat 登录，拿到自己的渠道账号 ID 后在这里绑定。</span>'
      return
    }
    if (!items.length && page > 0) return loadIdentities(view, page - 1)
    host.innerHTML = `
      <div class="table-scroll">
        <table class="data"><thead><tr><th>渠道</th><th>外部账号</th><th>成员</th><th>绑定时间</th><th>操作</th></tr></thead>
        <tbody>${items
          .map(
            (item) => `<tr>
              <td>${esc(item.provider)}</td>
              <td class="mono">${esc(item.external_id)}</td>
              <td>${esc(item.user_name)} <span class="desc mono">${esc(item.employee_no || item.user_id)}</span></td>
              <td>${esc(fmtTime(item.created_at))}</td>
              <td><button class="link-btn danger-link" type="button" data-unbind-ident="${esc(item.id)}">解除</button></td>
            </tr>`,
          )
          .join('')}</tbody></table>
      </div>
      ${pagerHtml(total, page, size)}`
    bindPager(host, (next) => loadIdentities(view, next))
    for (const button of host.querySelectorAll('[data-unbind-ident]')) {
      button.addEventListener('click', async () => {
        const ok = await confirmCard({
          title: '解除身份绑定？',
          message: '解除后，这个渠道账号发消息不会再以该成员身份处理。',
          confirmText: '解除绑定',
          tone: 'warning',
        })
        if (!ok) return
        button.disabled = true
        try {
          await api(`/api/console/channel-identities/${encodeURIComponent(button.dataset.unbindIdent)}${qs()}`, { method: 'DELETE' })
          await loadIdentities(view, page)
        } catch (err) {
          button.disabled = false
          alert(err.message || '解除失败')
        }
      })
    }
  } catch (err) {
    host.innerHTML = `<span class="bad-text">${esc(err.message)}</span>`
  }
}

async function openIdentityModal() {
  let members = []
  try {
    const data = await api('/api/org/members')
    members = data.members || []
  } catch (err) {
    alert(err.message || '读取成员失败')
    return
  }
  const overlay = modelModal(`
    <div class="modal-head"><h3>绑定渠道账号</h3><button class="modal-x" type="button">×</button></div>
    <div class="field-stack">
      <label class="field"><span>渠道</span><select id="ident-provider">
        <option value="feishu">飞书</option><option value="dingtalk">钉钉</option><option value="wecom">企业微信</option>
      </select></label>
      <label class="field"><span>外部账号 ID</span><input id="ident-external" class="mono" placeholder="飞书 open_id / 钉钉 staffId / 企微 UserId" /></label>
      <label class="field"><span>对应成员</span><select id="ident-user">${members
        .map((member) => `<option value="${esc(member.id)}">${esc(member.name)} · ${esc(member.deptName)}</option>`)
        .join('')}</select></label>
      ${hintNote('绑定规则', '一个外部账号只能绑定一个成员；重复绑定会报错，避免身份串号。')}
    </div>
    <div class="modal-state" id="ident-state"></div>
    <div class="modal-actions"><button class="btn primary" type="button" id="ident-save">保存绑定</button><button class="btn ghost" type="button" id="ident-cancel">取消</button></div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#ident-cancel').addEventListener('click', close)
  overlay.querySelector('#ident-save').addEventListener('click', async () => {
    const stateEl = overlay.querySelector('#ident-state')
    const provider = overlay.querySelector('#ident-provider').value
    const externalId = overlay.querySelector('#ident-external').value.trim()
    const userId = overlay.querySelector('#ident-user').value
    if (!externalId) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = '外部账号 ID 不能为空'
      return
    }
    stateEl.textContent = '保存中…'
    try {
      await apiPost('/api/console/channel-identities', { provider, externalId, userId })
      close()
      loadSync()
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '绑定失败'
    }
  })
}

async function openChannelModal(item) {
  if (!item) return
  const copyMap = {
    feishu: { app: 'App ID', secret: 'App Secret', agent: '机器人 App ID（可选）', corp: '企业自定义 ID（可选）' },
    dingtalk: { app: 'App Key / Client ID', secret: 'App Secret', agent: '机器人编码 AgentId', corp: '企业 CorpId' },
    wecom: { app: '企业 ID（CorpId）', secret: '应用 Secret', agent: '应用 AgentId', corp: '通讯录 Secret 所属 CorpId（可选）' },
  }
  const labels = copyMap[item.provider] ?? copyMap.feishu
  const overlay = modelModal(`
    <div class="modal-head"><h3>配置 ${esc(item.label)}</h3><button class="modal-x" type="button">×</button></div>
    <div class="field-stack">
      <div class="form-cols">
        <label class="field"><span>${esc(labels.app)}</span><input id="ch-app" value="${esc(item.appId)}" placeholder="企业应用后台复制" /></label>
        <label class="field"><span>${esc(labels.agent)}</span><input id="ch-agent" value="${esc(item.agentId)}" placeholder="可选" /></label>
      </div>
      <label class="field"><span>${esc(labels.secret)}</span><input id="ch-secret" type="password" autocomplete="off" placeholder="${
        item.appSecretConfigured ? '已保存，留空不修改' : '粘贴应用密钥'
      }" /></label>
      <label class="field"><span>${esc(labels.corp)}</span><input id="ch-corp" value="${esc(item.corpId)}" placeholder="可选" /></label>
      <div class="field-divider"><span>群机器人 Webhook（用于连通性测试与通知）</span></div>
      <label class="field"><span>Webhook 地址</span><input id="ch-webhook" class="mono" value="${esc(item.webhookUrl)}" placeholder="https://…（在群机器人设置里复制）" /></label>
      <label class="field"><span>Webhook 签名密钥</span><input id="ch-webhook-secret" type="password" autocomplete="off" placeholder="${
        item.webhookSecretConfigured ? '已保存，留空不修改' : '飞书/钉钉机器人开启了签名才需要'
      }" /></label>
      <label class="switch"><input type="checkbox" id="ch-enabled"${item.enabled ? ' checked' : ''} /><span>启用该渠道</span></label>
      ${
        item.callbackToken
          ? `<div class="hint">回调地址：<code>${esc(location.origin + item.callbackPath)}?token=${esc(
              item.callbackToken,
            )}</code></div>`
          : hintNote('回调说明', '保存后生成回调地址与回调 token。')
      }
      ${hintNote('凭证说明', '应用凭证用于后续通讯录同步与事件回调；Webhook 用于群通知和立即验证连通性。密钥保存到服务器本地，不写数据库。')}
    </div>
    <div class="modal-state" id="ch-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="ch-save">保存配置</button>
      <button class="btn ghost" type="button" id="ch-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#ch-cancel').addEventListener('click', close)
  overlay.querySelector('#ch-save').addEventListener('click', async () => {
    const stateEl = overlay.querySelector('#ch-state')
    stateEl.textContent = '保存中…'
    try {
      await apiPost(`/api/console/channels/${item.provider}`, {
        appId: overlay.querySelector('#ch-app').value.trim(),
        agentId: overlay.querySelector('#ch-agent').value.trim(),
        corpId: overlay.querySelector('#ch-corp').value.trim(),
        appSecret: overlay.querySelector('#ch-secret').value.trim(),
        webhookUrl: overlay.querySelector('#ch-webhook').value.trim(),
        webhookSecret: overlay.querySelector('#ch-webhook-secret').value.trim(),
        enabled: overlay.querySelector('#ch-enabled').checked,
      })
      close()
      loadSync()
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '保存失败'
    }
  })
}

function syncDiffTable(diffs) {
  const rows = diffs
    .map((diff) => {
      const before = diff.before ? JSON.stringify(diff.before) : '—'
      const after = diff.after ? JSON.stringify(diff.after) : '—'
      return `<tr>
        <td><span class="chip">${esc(ACTION_LABEL[diff.action] || diff.action)}</span></td>
        <td class="mono">${esc(diff.entityId || '—')}</td>
        <td class="mono desc">${esc(before)}</td>
        <td class="mono desc">${esc(after)}</td>
      </tr>`
    })
    .join('')
  return `<table class="data docs-table diff-table">
      <thead><tr><th>动作</th><th>对象</th><th>之前</th><th>之后</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`
}

async function loadSyncRun(runId) {
  const detail = $('#sync-detail')
  if (!detail) return
  renderLoading(detail, '加载差异…')
  try {
    const data = await api(`/api/org/sync-runs/${encodeURIComponent(runId)}`)
    detail.innerHTML = `
      <div class="panel">
        <div class="panel-head">
          <h2>同步差异</h2>
          <span class="hint">${esc(data.run.provider)} · ${esc(data.run.mode)} · ${data.diffs.length} 条</span>
        </div>
        ${data.diffs.length ? syncDiffTable(data.diffs) : '<div class="inline-note">这次同步没有产生写入差异。</div>'}
      </div>`
  } catch (err) {
    renderDenied(detail, err)
  }
}

/* ---------------- 渠道扫码绑定（模态） ---------------- */

let bindPollTimer = null

function closeBindModal() {
  if (bindPollTimer) {
    clearInterval(bindPollTimer)
    bindPollTimer = null
  }
  const overlay = document.querySelector('.modal-overlay')
  if (overlay) overlay.remove()
}

async function startBind(provider, bindings) {
  try {
    const session = await apiPost('/api/channel/bind/start', { provider })
    openBindModal(session, bindings)
  } catch (err) {
    const target = $('#sync-result') || $('#view')
    renderDenied(target, err)
  }
}

function openDingTalkBind(channel, bindings, organization = null) {
  const demoChannel = Boolean(
    channel?.tenantId &&
      (String(channel.tenantId).startsWith('demo-') || String(channel.tenantName ?? '').includes('演示')),
  )
  const replaceable =
    demoChannel ||
    (Number(organization?.dingtalkDepartments ?? 0) === 0 &&
      (Number(organization?.departments ?? 0) > 1 || Number(organization?.members ?? 0) > 0))
  const replaceDefault = replaceable ? ' checked' : ''
  const overlay = modelModal(`
    <div class="modal-head"><h3>钉钉 · 一键绑定并同步</h3><button class="modal-x" type="button">×</button></div>
    <div class="bind-guide">
      <strong>绑定前确认</strong>
      <span>已在钉钉开发者后台创建「企业内部应用」，并开通「通讯录部门信息读权限 qyapi_get_department_list」与「通讯录成员信息读权限 qyapi_get_member」；只开 qyapi_manage_addresslist 不够。</span>
      <span>EAB 只读取部门树与成员，不会向钉钉写入或修改任何组织数据。</span>
      ${
        demoChannel
          ? '<span style="color:#8a5a00">当前是演示绑定；填真实企业三项后会替换演示租户，并立即同步真实通讯录。</span>'
          : ''
      }
    </div>
    <div class="field-stack" style="margin-top:14px">
      <label class="field"><span>AppKey <em>企业内部应用 Client ID</em></span><input id="dt-app" value="${esc(
        demoChannel ? '' : channel?.appId || '',
      )}" placeholder="dingxxxxxx" autocomplete="off" /></label>
      <label class="field"><span>AppSecret <em>只保存引用，不回显</em></span><input id="dt-secret" type="password" autocomplete="off" placeholder="${
        channel?.appSecretConfigured && !demoChannel ? '已保存，留空不修改' : '粘贴真实 AppSecret'
      }" /></label>
      <label class="field"><span>企业 CorpId <em>用于确认租户归属</em></span><input id="dt-corp" value="${esc(
        demoChannel ? '' : channel?.corpId || '',
      )}" placeholder="dingxxxxxxxx" autocomplete="off" /></label>
    </div>
    ${
      replaceable
        ? `<label class="install-check bind-check" style="margin:12px 20px 0">
            <input id="dt-replace" type="checkbox"${replaceDefault} />
            <span><strong>${demoChannel ? '用钉钉通讯录替换演示组织' : '用钉钉通讯录替换现有组织'}</strong><small>替换会归档现有部门与成员（不物理删除，保留根部门）；不勾选则只追加钉钉组织</small></span>
          </label>`
        : ''
    }
    <div class="hint-note" style="margin:10px 20px 0">${hintBadge('同步说明', '绑定成功后会立即拉取一次通讯录，并把结果写进当前公司的组织架构；已存在的数据只做差异更新，不会重复创建。')}</div>
    <div class="modal-state" id="dt-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="dt-submit">${demoChannel ? '替换演示租户并同步' : '绑定并同步'}</button>
      <button class="btn ghost" type="button" id="dt-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#dt-cancel').addEventListener('click', close)
  const submit = overlay.querySelector('#dt-submit')
  submit.addEventListener('click', async () => {
    const stateEl = overlay.querySelector('#dt-state')
    const appId = overlay.querySelector('#dt-app').value.trim()
    const appSecret = overlay.querySelector('#dt-secret').value.trim()
    const corpId = overlay.querySelector('#dt-corp').value.trim()
    if (!appId || !corpId) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = 'AppKey 和 CorpId 都要填'
      return
    }
    if (!appSecret && (!channel?.appSecretConfigured || demoChannel)) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = demoChannel ? '替换演示绑定需要填真实 AppSecret' : '第一次绑定需要填 AppSecret'
      return
    }
    submit.disabled = true
    stateEl.className = 'modal-state'
    stateEl.textContent = '正在验证钉钉应用、读取企业通讯录…'
    try {
      const result = await apiPost('/api/console/channels/dingtalk/bind', {
        appId,
        appSecret,
        corpId,
        replaceDemo: replaceable ? overlay.querySelector('#dt-replace')?.checked === true : false,
      })
      stateEl.className = 'modal-state ok'
      stateEl.textContent = `绑定成功：${result.binding.tenantName} · ${result.sync.departments} 个部门 / ${result.sync.members} 名成员${
        result.sync.archived?.departments || result.sync.archived?.members
          ? ` · 已归档演示数据 ${result.sync.archived.departments} 个部门 / ${result.sync.archived.members} 人`
          : ''
      }`
      setTimeout(() => {
        close()
        loadSync()
      }, 1200)
    } catch (err) {
      stateEl.className = 'modal-state bad'
      const urls = err?.details?.applyUrls ?? {}
      const labels = {
        qyapi_get_department_list: '开通「部门信息读」权限',
        qyapi_get_member: '开通「成员信息读」权限',
        qyapi_get_department_member: '开通「部门成员读」权限',
      }
      const versionUrl = err?.details?.versionUrl
      const versionLink = versionUrl
        ? `<a class="btn" href="${esc(versionUrl)}" target="_blank" rel="noopener">去发布新版本</a>`
        : ''
      const links = Object.entries(urls)
        .map(
          ([key, url]) =>
            `<a class="btn ghost" href="${esc(url)}" target="_blank" rel="noopener">${esc(
              labels[key] ?? `开通「${key}」权限`,
            )}</a>`,
        )
        .join('')
      stateEl.innerHTML =
        `<div>${esc(err.message || '绑定失败')}</div>` +
        (err.hint ? `<div class="bind-error-hint">${esc(err.hint)}</div>` : '') +
        (versionLink || links ? `<div class="bind-error-actions">${versionLink}${links}</div>` : '')
      submit.disabled = false
    }
  })
}

function openBindModal(session, bindings) {
  closeBindModal()
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h3>${esc(session.providerLabel)} · 扫码绑定企业</h3>
        <button class="modal-x" type="button" aria-label="关闭">×</button>
      </div>
      <div class="qr-box">
        ${
          session.qr && session.qr.imageUrl
            ? `<img src="${esc(session.qr.imageUrl)}" alt="二维码" />`
            : `<div class="qr-placeholder">
                 <span class="qr-brand">${esc(session.providerLabel)}</span>
                 <span class="muted">模拟渠道：真实接入后这里显示渠道返回的二维码图片</span>
                 <code class="qr-content">${esc(session.qr ? session.qr.content : '')}</code>
               </div>`
        }
      </div>
      <div class="modal-state" id="bind-state">等待管理员用${esc(session.providerLabel)}扫码授权…（5 分钟内有效）</div>
      <div class="modal-actions">
        ${
          bindings && bindings.devAuth
            ? '<button class="btn primary" type="button" id="mock-scan">模拟扫码（开发预览）</button>'
            : ''
        }
        <button class="btn" type="button" id="bind-cancel">取消</button>
      </div>
    </div>`
  document.body.appendChild(overlay)

  const setState = (text, tone) => {
    const el = overlay.querySelector('#bind-state')
    if (!el) return
    el.textContent = text
    el.className = `modal-state${tone ? ` ${tone}` : ''}`
  }

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeBindModal()
  })
  overlay.querySelector('.modal-x').addEventListener('click', closeBindModal)
  overlay.querySelector('#bind-cancel').addEventListener('click', async () => {
    try {
      await apiPost(`/api/channel/bind/${session.sessionId}/cancel`, {})
    } catch {
      /* 取消失败也让用户关掉弹窗 */
    }
    closeBindModal()
    loadSync()
  })

  const scan = overlay.querySelector('#mock-scan')
  if (scan) {
    scan.addEventListener('click', async () => {
      scan.disabled = true
      setState('已扫码，正在换租户凭证…')
      try {
        const res = await apiPost(`/api/channel/bind/${session.sessionId}/mock-scan`, {})
        setState(`绑定成功：${res.session.tenantName}`, 'ok')
        setTimeout(() => {
          closeBindModal()
          loadSync()
        }, 900)
      } catch (err) {
        setState(err.message || '绑定失败', 'bad')
        scan.disabled = false
      }
    })
  }

  bindPollTimer = setInterval(async () => {
    try {
      const current = await api(`/api/channel/bind/${session.sessionId}`)
      if (current.status === 'authorized') {
        setState(`绑定成功：${current.tenantName || current.tenantId}`, 'ok')
        closeBindModal()
        loadSync()
      } else if (current.status === 'expired') {
        setState('二维码已过期，请关掉重试', 'bad')
        clearInterval(bindPollTimer)
        bindPollTimer = null
      } else if (current.status === 'cancelled') {
        closeBindModal()
      }
    } catch {
      /* 轮询失败不打断，下一轮再试 */
    }
  }, 1500)
}

/* ---------------- 插件（服务器侧生命周期管理器，对齐 DSH 的安装/列表/启用/更新/卸载） ---------------- */

const PLUGIN_STAGE_LABEL = {
  discovered: '已发现（部署侧放置）',
  installed: '已安装',
  disabled: '已安装 · 当前公司停用',
  enabled: '已安装 · 当前公司启用',
  invalid: '清单不合法',
  removed: '已卸载',
}

const PLUGIN_EVENT_LABEL = {
  install: '安装',
  update: '更新',
  enable: '启用',
  disable: '停用',
  uninstall: '卸载',
}

const PLUGIN_SOURCE_LABEL = {
  'local-dir': '本地目录',
  npm: 'npm · 镜像',
  github: 'GitHub',
  disk: '磁盘发现',
}

function parseNpmSourceRef(ref) {
  if (!ref || !String(ref).startsWith('npm:')) return null
  const rest = String(ref).slice(4)
  const queryAt = rest.indexOf('?')
  const base = queryAt >= 0 ? rest.slice(0, queryAt) : rest
  const params = new URLSearchParams(queryAt >= 0 ? rest.slice(queryAt + 1) : '')
  const at = base.lastIndexOf('@')
  const packageName = at > 0 ? base.slice(0, at) : base
  const version = at > 0 ? base.slice(at + 1) : ''
  return { packageName, version, registry: params.get('registry') || '' }
}

function parseGithubSourceRef(ref) {
  if (!ref || !String(ref).startsWith('github:')) return null
  const rest = String(ref).slice(7)
  const queryAt = rest.indexOf('?')
  const base = queryAt >= 0 ? rest.slice(0, queryAt) : rest
  const params = new URLSearchParams(queryAt >= 0 ? rest.slice(queryAt + 1) : '')
  const hashAt = base.indexOf('#')
  return {
    repo: hashAt >= 0 ? base.slice(0, hashAt) : base,
    ref: hashAt >= 0 ? base.slice(hashAt + 1) : '',
    subdir: params.get('dir') || '',
  }
}

function fmtPluginTime(ms) {
  if (!ms) return '—'
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function pluginPill(plugin) {
  if (!plugin.valid) return '<span class="pill danger">清单不合法</span>'
  if (!plugin.install) return `<span class="pill">${plugin.enabled ? '已发现 · 启用' : '已发现 · 停用'}</span>`
  if (plugin.enabled) return '<span class="pill ok">已安装 · 启用</span>'
  return '<span class="pill warn">已安装 · 停用</span>'
}

function pluginCard(plugin) {
  const keywords = plugin.keywords?.length
    ? plugin.keywords.map((item) => `<span class="chip">${esc(item)}</span>`).join('')
    : '<span class="muted">没有标签</span>'
  const scopes = plugin.scopes.length
    ? plugin.scopes.map((scope) => `<span class="chip" title="${esc(scope)}">${esc(scope)}</span>`).join('')
    : '<span class="muted">未声明权限</span>'
  const pages = plugin.pages
    .map(
      (page) =>
        `<button class="btn sm" type="button" data-plugin="${esc(plugin.id)}" data-page-file="${esc(page.file)}" data-page-title="${esc(page.title)}"${plugin.valid && plugin.enabled ? '' : ' disabled'}>打开「${esc(page.title)}」</button>`,
    )
    .join(' ')
  const toggle = plugin.valid
    ? `<button class="btn sm ${plugin.enabled ? '' : 'primary'}" type="button" data-toggle-plugin="${esc(plugin.id)}" data-next="${plugin.enabled ? 'false' : 'true'}">${plugin.enabled ? '停用（本司）' : '启用（本司）'}</button>`
    : ''
  const update = plugin.install
    ? `<button class="btn sm" type="button" data-plugin-update="${esc(plugin.id)}">更新…</button>`
    : ''
  const uninstall = plugin.valid
    ? `<button class="btn sm danger" type="button" data-plugin-uninstall="${esc(plugin.id)}">卸载…</button>`
    : ''
  const source = plugin.install
    ? `<div class="plugin-source-ref"><span class="plugin-source-label">${esc(PLUGIN_SOURCE_LABEL[plugin.install.source] || plugin.install.source)}</span><span class="mono" title="${esc(plugin.install.sourceRef || plugin.install.source)}">${esc(plugin.install.sourceRef || plugin.install.source)}</span></div>`
    : '<strong class="muted">部署侧放进 plugins/，尚未登记安装</strong>'
  const origin = plugin.install
    ? `${esc(fmtPluginTime(plugin.install.installedAt))} · ${esc(plugin.install.installedBy || '未知操作人')}`
    : '—'
  const initial = (plugin.name || plugin.id || '?').trim().slice(0, 1).toUpperCase()

  return `<section class="panel plugin-card" id="plugin-${esc(plugin.id)}">
    <div class="panel-head plugin-card-head">
      <div class="plugin-title">
        <div class="plugin-avatar">${esc(initial)}</div>
        <div class="plugin-title-text">
          <h2>${esc(plugin.name)}</h2>
          <div class="plugin-subline">
            <span class="mono">${esc(plugin.id)}@${esc(plugin.version)}</span>
          </div>
        </div>
      </div>
      ${pluginPill(plugin)}
    </div>
    <div class="legend" style="margin-top:0">${esc(plugin.description || '（没有写描述）')}</div>
    <div class="plugin-actions" style="margin-top:8px">${keywords}</div>
    <div class="kv" style="margin-top:10px">
      <div><span>作者 / 许可</span><strong>${esc(plugin.author || '未填写')}${plugin.license ? ` · ${esc(plugin.license)}` : ''}</strong></div>
      <div><span>安装来源</span>${source}</div>
      <div><span>安装记录</span><strong>${origin}</strong></div>
      <div><span>清单指纹</span><strong class="mono">${esc(plugin.checksum || '—')}</strong></div>
      <div><span>声明权限</span><strong class="caps-inline">${scopes}</strong></div>
      <div><span>贡献页面</span><strong>${plugin.pages.length ? pages : '无'}</strong></div>
    </div>
    ${plugin.valid ? '' : `<div class="banner danger" style="margin-top:10px"><strong>${esc(plugin.error || '清单不合法')}</strong><span>修好 plugin.json 后点「更新…」重新安装</span></div>`}
    <div class="plugin-actions">${toggle}${update}${uninstall}</div>
  </section>`
}

function catalogCard(entry) {
  const installed = entry.installed
  const pill = !installed
    ? '<span class="pill">未安装</span>'
    : entry.updateAvailable
      ? `<span class="pill warn">可更新 ${esc(entry.installedVersion || '')} → ${esc(entry.version)}</span>`
      : `<span class="pill ok">已安装 ${esc(entry.version)}</span>`
  const tags = entry.tags.length ? entry.tags.map((tag) => `<span class="chip">${esc(tag)}</span>`).join('') : ''
  const source = entry.sourcePath
    ? `<span class="mono muted">${esc(entry.sourcePath)}</span>`
    : '<span class="muted">没有声明 sourcePath，只能手动填目录</span>'
  const action = entry.updateAvailable
    ? `<button class="btn sm primary" type="button" data-catalog-install="${esc(entry.id)}">更新到 ${esc(entry.version)}</button>`
    : installed
      ? '<button class="btn sm" type="button" disabled>已是该版本</button>'
      : `<button class="btn sm primary" type="button" data-catalog-install="${esc(entry.id)}">安装</button>`
  return `<section class="panel plugin-card" id="catalog-${esc(entry.id)}">
    <div class="panel-head">
      <h2>${esc(entry.name)} <span class="muted mono" style="font-size:12px">${esc(entry.id)}@${esc(entry.version)}</span></h2>
      ${pill}
    </div>
    <div class="legend" style="margin-top:0">${esc(entry.description || '（没有写描述）')}</div>
    <div class="plugin-actions" style="margin-top:8px">${tags}</div>
    <div class="kv" style="margin-top:10px">
      <div><span>作者</span><strong>${esc(entry.author || '未填写')}</strong></div>
      <div><span>安装来源</span>${source}</div>
    </div>
    <div class="plugin-actions">${action}</div>
  </section>`
}

function pluginEventDetail(event) {
  const raw = event.detail
  let detail = null
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      detail = JSON.parse(raw)
    } catch {
      detail = null
    }
  }
  if (!detail) return esc((raw || '—').slice(0, 120))
  const bits = []
  if (detail.from && detail.to && detail.from === detail.to) {
    bits.push(`<span class="mono">${esc(detail.from)}</span>`, '同版本重装')
  } else if (detail.from) {
    bits.push(`<span class="mono">${esc(detail.from)} → ${esc(detail.to || '—')}</span>`)
  } else if (detail.to) {
    bits.push('安装', `<span class="mono">${esc(detail.to)}</span>`)
  }
  if (detail.version) bits.push(`<span class="mono">v${esc(detail.version)}</span>`)
  if (detail.source) {
    const source = String(detail.source)
    const label = PLUGIN_SOURCE_LABEL[source]
    bits.push(esc(label || (/^[A-Za-z]:[\\/]/.test(source) || source.startsWith('/') ? '本地目录' : source)))
  } else if (detail.sourceRef) {
    const ref = String(detail.sourceRef)
    bits.push(ref.startsWith('npm:') ? 'npm' : ref.startsWith('github:') ? 'GitHub' : '本地目录')
  }
  if (detail.shared) bits.push('共享目录保留')
  if (detail.trashPath) bits.push('<span class="muted">已移入回收站</span>')
  if (!bits.length && detail.reason) bits.push(esc(detail.reason))
  return bits.length ? `<div class="plugin-event-detail">${bits.join('<span class="muted">·</span>')}</div>` : '<span class="muted">—</span>'
}

function pluginEventRows(events) {
  if (!events.length) return '<tr><td colspan="5" class="muted">还没有生命周期操作记录</td></tr>'
  return events
    .map(
      (event) => `<tr>
        <td class="mono">${esc(fmtPluginTime(event.at))}</td>
        <td class="mono">${esc(event.pluginId)}</td>
        <td><span class="pill">${esc(PLUGIN_EVENT_LABEL[event.event] || event.event)}</span></td>
        <td>${esc(event.actorId || '—')}${event.companyId ? ` <span class="muted">· ${event.companyId === state.pluginData?.companyId ? '本司' : esc(event.companyId)}</span>` : ''}</td>
        <td>${pluginEventDetail(event)}</td>
      </tr>`,
    )
    .join('')
}

async function openPluginInstall(prefill = {}) {
  const data = state.pluginData
  if (!data) return
  const existing = prefill.id ? data.plugins.find((plugin) => plugin.id === prefill.id) : null
  const npmPrefill = parseNpmSourceRef(existing?.install?.sourceRef)
  const githubPrefill = parseGithubSourceRef(existing?.install?.sourceRef)
  const registries = data.installer.registries?.length
    ? data.installer.registries
    : [{ id: 'npm', label: 'npm 官方', url: 'https://registry.npmjs.org', hint: '海外直连' }]
  const defaultRegistry = registries.find((item) => item.id === 'npmmirror')?.url || registries[0].url
  const prefillRegistry = npmPrefill?.registry || defaultRegistry
  const registryIsPreset = registries.some((item) => item.url === prefillRegistry)
  let source = prefill.source
    || (existing?.install?.source === 'npm' ? 'npm' : existing?.install?.source === 'github' ? 'github' : 'local-dir')
  const localPrefill = prefill.sourcePath || (existing?.install?.source === 'local-dir' ? existing.install.sourceRef : '') || ''

  const registryOptions = registries
    .map(
      (item) =>
        `<option value="${esc(item.url)}" data-hint="${esc(item.hint)}"${item.url === prefillRegistry ? ' selected' : ''}>${esc(item.label)} · ${esc(item.url)}</option>`,
    )
    .join('')

  const companyName = state.companies?.find((item) => item.id === data.companyId)?.name || data.companyId || '当前公司'
  const overlay = modelModal(`
    <div class="modal-head install-modal-head">
      <div>
        <span class="install-eyebrow">PLUGIN INSTALLER</span>
        <h3>${existing ? '更新插件' : '安装插件'}</h3>
        <p class="install-sub">安装到「${esc(companyName)}」 · 本地目录 / npm 国内镜像 / GitHub 三种来源</p>
      </div>
      <button class="modal-x" type="button">×</button>
    </div>

    <div class="install-scope-bar">
      <span class="install-scope-dot"></span>
      <span>安装登记只记在当前公司名下；其他公司看不到，也不会共用启停状态。</span>
    </div>

    <div class="install-source-tabs" role="tablist" aria-label="安装来源">
      <button class="install-source-tab" type="button" data-install-source="local-dir">
        <span class="install-source-icon">⌂</span>
        <span><strong>本地目录</strong><small>服务器上已有包</small></span>
      </button>
      <button class="install-source-tab" type="button" data-install-source="npm">
        <span class="install-source-icon">◈</span>
        <span><strong>npm / 镜像</strong><small>registry + 国内镜像</small></span>
      </button>
      <button class="install-source-tab" type="button" data-install-source="github">
        <span class="install-source-icon">◐</span>
        <span><strong>GitHub</strong><small>仓库 + 分支 / 标签</small></span>
      </button>
    </div>

    <div class="install-panel" data-install-panel="local-dir">
      <label class="install-field">插件包目录（服务器绝对路径）
        <input id="pg-local-src" value="${esc(localPrefill)}" placeholder="例如 D:/dsh/dsh-mrrp 或 D:/AI kaifa/EAB/plugins/eab-plugin-oncall" />
        <span class="install-field-hint">支持 EAB 插件（plugin.json）和 DSH 插件（package.json 带 dsh 段，含 bundle.patch / client 入口）。目录名不必等于插件 id。</span>
      </label>
    </div>

    <div class="install-panel" data-install-panel="npm">
      <div class="install-grid">
        <label class="install-field install-span-2">npm 包名
          <input id="pg-npm-name" value="${esc(npmPrefill?.packageName || '')}" placeholder="eab-plugin-oncall 或 @scope/eab-plugin-x" />
          <span class="install-field-hint">包里必须带 plugin.json；只取内容，不执行 npm install。</span>
        </label>
        <label class="install-field">版本 / 标签
          <input id="pg-npm-version" value="${esc(npmPrefill?.version || '')}" placeholder="留空 = latest；也可填 1.2.3 / beta" />
        </label>
      </div>
      <label class="install-field">镜像源
        <select id="pg-npm-registry">
          ${registryOptions}
          <option value="custom"${registryIsPreset ? '' : ' selected'}>自定义 registry…</option>
        </select>
      </label>
      <label class="install-field is-hidden" id="pg-custom-registry-wrap">自定义 registry 地址
        <input id="pg-custom-registry" value="${esc(registryIsPreset ? '' : prefillRegistry)}" placeholder="https://registry.example.com" />
      </label>
      <div class="install-registry-hint" id="pg-registry-hint"></div>
    </div>

    <div class="install-panel" data-install-panel="github">
      <div class="install-grid">
        <label class="install-field install-span-2">GitHub 仓库
          <input id="pg-github-repo" value="${esc(githubPrefill?.repo || '')}" placeholder="owner/repo，例如 xmanrui/dsh-im" />
          <span class="install-field-hint">公开仓库可直接装；私有仓库暂不支持匿名下载。</span>
        </label>
        <label class="install-field">分支 / 标签
          <input id="pg-github-ref" value="${esc(githubPrefill?.ref || '')}" placeholder="留空 = 默认分支；也可填 v1.0.0" />
        </label>
        <label class="install-field">仓库内子目录
          <input id="pg-github-subdir" value="${esc(githubPrefill?.subdir || '')}" placeholder="可选，例如 packages/my-plugin" />
        </label>
      </div>
    </div>

    ${existing ? `<div class="install-existing">
      <span class="pill ok">已装 ${esc(existing.id)}@${esc(existing.version)}</span>
      <span>更新会保留首次安装时间，只改版本 / 来源 / 指纹；旧目录移到 <span class="mono">plugins/.trash</span>。</span>
    </div>` : ''}

    <div class="install-options">
      <label class="install-check">
        <input type="checkbox" id="pg-overwrite"${existing ? ' checked' : ''} />
        <span><strong>覆盖更新</strong><small>仅本司已安装且没有其他公司在用时才能覆盖；旧目录移到 plugins/.trash</small></span>
      </label>
      <label class="install-check">
        <input type="checkbox" id="pg-enable" checked />
        <span><strong>安装后对当前公司启用</strong><small>只影响当前公司，可随时停用</small></span>
      </label>
    </div>

    <div class="install-flow">
      <span>① 取包</span><i>→</i><span>② 解包到临时区</span><i>→</i><span>③ 校验清单 / id / 页面</span><i>→</i><span>④ 落 plugins/&lt;id&gt;</span><i>→</i><span>⑤ 登记版本 / 来源 / 指纹</span>
    </div>
    <div class="install-note" id="pg-note"></div>
    <div class="modal-state" id="pg-state"></div>
    <div class="modal-actions">
      <button class="btn primary" type="button" id="pg-save">${existing ? '更新' : '安装'}</button>
      <button class="btn ghost" type="button" id="pg-cancel">取消</button>
    </div>`)

  overlay.querySelector('.modal').classList.add('plugin-install-modal')
  const close = () => overlay.remove()
  const tabs = Array.from(overlay.querySelectorAll('[data-install-source]'))
  const panels = Array.from(overlay.querySelectorAll('[data-install-panel]'))
  const noteEl = overlay.querySelector('#pg-note')
  const stateEl = overlay.querySelector('#pg-state')
  const saveBtn = overlay.querySelector('#pg-save')
  const registrySelect = overlay.querySelector('#pg-npm-registry')
  const customWrap = overlay.querySelector('#pg-custom-registry-wrap')
  const customInput = overlay.querySelector('#pg-custom-registry')
  const registryHint = overlay.querySelector('#pg-registry-hint')

  const sourceNotes = {
    'local-dir': '本地目录：直接复制到 plugins/<id>，先落暂存区二次校验；适合离线或内网部署。',
    npm: 'npm / 镜像：从 registry 拉 tarball 后解包校验；不执行 npm install、prepare 或任何生命周期脚本。',
    github: 'GitHub：下载仓库 tarball 后解包；仓库里必须有 plugin.json，源码构建产物需随仓库一起提交。',
  }

  const syncRegistryHint = () => {
    const selected = registrySelect.value
    const preset = registries.find((item) => item.url === selected)
    customWrap.classList.toggle('is-hidden', selected !== 'custom')
    registryHint.textContent = selected === 'custom'
      ? '自定义 registry 需兼容 npm registry API（GET /<package> 返回 dist.tarball）。'
      : `${preset?.label || 'registry'}：${preset?.hint || ''}`
  }

  const syncSource = (next) => {
    source = next
    for (const tab of tabs) {
      const active = tab.dataset.installSource === next
      tab.classList.toggle('is-active', active)
      tab.setAttribute('aria-selected', active ? 'true' : 'false')
    }
    for (const panel of panels) panel.classList.toggle('is-hidden', panel.dataset.installPanel !== next)
    noteEl.textContent = sourceNotes[next] || ''
    stateEl.className = 'modal-state'
    stateEl.textContent = ''
  }

  registrySelect.addEventListener('change', syncRegistryHint)
  for (const tab of tabs) tab.addEventListener('click', () => syncSource(tab.dataset.installSource))
  syncRegistryHint()
  syncSource(source)

  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#pg-cancel').addEventListener('click', close)
  saveBtn.addEventListener('click', async () => {
    const body = {
      source,
      overwrite: overlay.querySelector('#pg-overwrite').checked,
      enable: overlay.querySelector('#pg-enable').checked,
    }
    if (source === 'local-dir') {
      body.sourcePath = overlay.querySelector('#pg-local-src').value.trim()
      if (!body.sourcePath) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '请填服务器上的插件包目录'
        return
      }
    } else if (source === 'npm') {
      body.packageName = overlay.querySelector('#pg-npm-name').value.trim()
      body.version = overlay.querySelector('#pg-npm-version').value.trim()
      body.registry = registrySelect.value === 'custom' ? customInput.value.trim() : registrySelect.value
      if (!body.packageName) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '请填 npm 包名'
        return
      }
      if (registrySelect.value === 'custom' && !body.registry) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '请填自定义 registry 地址'
        return
      }
    } else {
      body.repo = overlay.querySelector('#pg-github-repo').value.trim()
      body.ref = overlay.querySelector('#pg-github-ref').value.trim()
      body.subdir = overlay.querySelector('#pg-github-subdir').value.trim()
      if (!body.repo) {
        stateEl.className = 'modal-state bad'
        stateEl.textContent = '请填 GitHub 仓库（owner/repo）'
        return
      }
    }

    stateEl.className = 'modal-state'
    stateEl.textContent = source === 'npm'
      ? '正在从 npm 拉取 tarball 并解包（不执行安装脚本）…'
      : source === 'github'
        ? '正在从 GitHub 下载仓库 tarball 并解包…'
        : '安装中：复制 → 校验 → 登记…'
    saveBtn.disabled = true
    try {
      await apiPost('/api/console/plugins/install', body)
      stateEl.className = 'modal-state good'
      stateEl.textContent = '安装完成，正在刷新插件列表…'
      await loadPlugins()
      close()
    } catch (err) {
      saveBtn.disabled = false
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '安装失败'
    }
  })
}

function openPluginUninstall(plugin) {
  const companyName = state.companies?.find((item) => item.id === state.pluginData?.companyId)?.name || state.pluginData?.companyId || '当前公司'
  const overlay = modelModal(`
    <div class="modal-head"><h3>从「${esc(companyName)}」卸载 ${esc(plugin.name)}</h3><button class="modal-x" type="button">×</button></div>
    <div class="legend" style="margin-top:0">
      卸载只解除 <strong>当前公司</strong> 的安装与启停记录，不影响其他公司。
      如果当前公司是最后一家使用它的公司，<span class="mono">plugins/${esc(plugin.id)}</span> 会移到
      <span class="mono">plugins/.trash/</span>（可恢复）；否则共享目录保留。
    </div>
    <div class="modal-state" id="pu-state"></div>
    <div class="modal-actions">
      <button class="btn danger" type="button" id="pu-save">确认卸载</button>
      <button class="btn ghost" type="button" id="pu-cancel">取消</button>
    </div>`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#pu-cancel').addEventListener('click', close)
  overlay.querySelector('#pu-save').addEventListener('click', async () => {
    const stateEl = overlay.querySelector('#pu-state')
    stateEl.textContent = '卸载中…'
    try {
      await apiPost(`/api/console/plugins/${encodeURIComponent(plugin.id)}/uninstall`, {})
      close()
      await loadPlugins()
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err.message || '卸载失败'
    }
  })
}

function pluginHostOf(data, id) {
  return (data.hosts || []).find((host) => host.id === id) || null
}

function pluginPageUrl(data, plugin, page) {
  const version = encodeURIComponent(plugin.version || '')
  const company = encodeURIComponent(data.companyId || '')
  if ((page.kind || 'html') === 'dsh-client') {
    return `/plugin-host.html?id=${encodeURIComponent(plugin.id)}&entry=${encodeURIComponent(page.file)}&company=${company}&version=${version}&title=${encodeURIComponent(page.title)}`
  }
  return `/plugins/assets/${encodeURIComponent(plugin.id)}/${page.file}${qs()}`
}

function pluginFormatBadge(plugin) {
  return plugin.format === 'dsh'
    ? '<span class="plugin-format-badge dsh">DSH</span>'
    : '<span class="plugin-format-badge">EAB</span>'
}

function pluginStatusPill(plugin, host) {
  if (!plugin.valid) return '<span class="pill danger">清单不合法</span>'
  if (!plugin.enabled) return '<span class="pill warn">已停用</span>'
  if (host && host.error) return '<span class="pill warn">启用 · host 异常</span>'
  if (host) return '<span class="pill ok">运行中</span>'
  if (plugin.install && plugin.install.removedAt) return '<span class="pill">已卸载</span>'
  if (!plugin.install) return '<span class="pill">已发现</span>'
  return '<span class="pill ok">已启用</span>'
}

function pluginRailItem(plugin, selected) {
  const initial = (plugin.name || plugin.id || '?').trim().slice(0, 1).toUpperCase()
  const sub = plugin.format === 'dsh'
    ? `DSH · ${plugin.dsh?.hasHost ? 'host+client' : 'client'}`
    : `EAB · ${plugin.pages.length} 页`
  return `<button class="plugin-rail-item${selected ? ' is-active' : ''}" type="button" data-select-plugin="${esc(plugin.id)}">
    <span class="plugin-rail-avatar">${esc(initial)}</span>
    <span class="plugin-rail-text">
      <strong>${esc(plugin.name)}</strong>
      <small><span class="mono">${esc(plugin.version)}</span> · ${esc(sub)}</small>
    </span>
    <span class="plugin-rail-dot ${!plugin.valid ? 'bad' : plugin.enabled ? 'ok' : 'warn'}" title="${plugin.valid ? (plugin.enabled ? '启用' : '停用') : '清单不合法'}"></span>
  </button>`
}

function pluginCatalogRailItem(entry) {
  return `<button class="plugin-rail-item is-muted" type="button" data-catalog-open="${esc(entry.id)}">
    <span class="plugin-rail-avatar ghost">+</span>
    <span class="plugin-rail-text">
      <strong>${esc(entry.name)}</strong>
      <small>${entry.installed ? `可更新 → ${esc(entry.version)}` : `可安装 ${esc(entry.version)}`}</small>
    </span>
    <span class="plugin-rail-dot ${entry.updateAvailable ? 'warn' : ''}"></span>
  </button>`
}

function pluginOverviewBody(data, plugin, host) {
  const dsh = plugin.dsh
  const pages = plugin.pages.length
    ? plugin.pages
        .map(
          (page) =>
            `<button class="btn sm" type="button" data-open-page="${esc(page.id)}"${plugin.valid && plugin.enabled ? '' : ' disabled'}>打开「${esc(page.title)}」</button>`,
        )
        .join(' ')
    : '<span class="muted">这个插件没有贡献页面</span>'
  const injects = dsh?.clientInject?.length
    ? dsh.clientInject.map((item) => `<span class="chip mono">${esc(item.replace('@deepseek-ai/dsh-client-', ''))}</span>`).join('')
    : '<span class="muted">未声明 client.inject</span>'
  const protocol = plugin.format === 'dsh'
    ? `<div><span>DSH 包名</span><strong class="mono">${esc(dsh?.packageName || plugin.id)}</strong></div>
      <div><span>宿主版本要求</span><strong>${esc(dsh?.compatibility?.dsh || '未声明')}</strong></div>
      <div><span>profile</span><strong>${esc(dsh?.compatibility?.profiles?.join(' / ') || '未声明')}</strong></div>
      <div><span>host 入口</span><strong class="mono">${esc(dsh?.hostEntry || '—（纯 client 插件）')}</strong></div>
      <div><span>client 入口</span><strong class="mono">${esc(dsh?.clientEntry || '—')}</strong></div>
      <div><span>bundle patch</span><strong class="mono">${esc(dsh?.bundlePatch || '—')}</strong></div>
      <div><span>host 运行</span><strong>${host ? (host.error ? `异常：${esc(host.error)}` : `已运行 · ${host.routes.length} 条通道`) : '未加载'}</strong></div>`
    : `<div><span>清单格式</span><strong>EAB plugin.json</strong></div>
      <div><span>声明权限</span><strong class="caps-inline">${plugin.scopes.length ? plugin.scopes.map((scope) => `<span class="chip" title="${esc(scope)}">${esc(scope)}</span>`).join('') : '<span class="muted">未声明</span>'}</strong></div>`
  const source = plugin.install
    ? `<div class="plugin-source-ref"><span>${esc(PLUGIN_SOURCE_LABEL[plugin.install.source] || plugin.install.source)}</span><span class="mono" title="${esc(plugin.install.sourceRef || plugin.install.source)}">${esc(plugin.install.sourceRef || plugin.install.source)}</span></div>`
    : '<strong class="muted">部署侧放进 plugins/，尚未登记安装</strong>'
  const installAt = plugin.install
    ? `${esc(fmtPluginTime(plugin.install.installedAt))} · ${esc(plugin.install.installedBy || '未知操作人')}`
    : '—'

  return `<div class="plugin-overview">
    <div class="plugin-block">
      <h3>清单与协议</h3>
      <div class="kv plugin-kv">
        <div><span>作者 / 许可</span><strong>${esc(plugin.author || '未填写')}${plugin.license ? ` · ${esc(plugin.license)}` : ''}</strong></div>
        <div><span>关键词</span><strong>${plugin.keywords.length ? plugin.keywords.map((item) => `<span class="chip">${esc(item)}</span>`).join('') : '<span class="muted">没有标签</span>'}</strong></div>
        ${protocol}
      </div>
      ${plugin.format === 'dsh' ? `<div class="plugin-inject-row"><span>client.inject</span><div>${injects}</div></div>` : ''}
    </div>
    <div class="plugin-block">
      <h3>安装与来源</h3>
      <div class="kv plugin-kv">
        <div><span>安装来源</span>${source}</div>
        <div><span>安装记录</span><strong>${installAt}</strong></div>
        <div><span>清单指纹</span><strong class="mono">${esc(plugin.checksum || '—')}</strong></div>
        <div><span>启停归属</span><strong>${plugin.personal ? '个人安装' : '当前公司'}</strong></div>
      </div>
      <div class="plugin-page-list"><span>贡献页面</span><div>${pages}</div></div>
    </div>
  </div>
  ${plugin.valid ? '' : `<div class="banner danger" style="margin-top:12px"><strong>${esc(plugin.error || '清单不合法')}</strong><span>修好清单后点「更新…」重新安装，或直接卸载。</span></div>`}`
}

function pluginPagesBody(data, plugin) {
  if (!plugin.valid) return `<div class="banner danger"><strong>清单不合法，页面不可用</strong><span>${esc(plugin.error || '')}</span></div>`
  if (!plugin.enabled) {
    return `<div class="plugin-page-blocked"><strong>当前公司已停用这个插件</strong><span>启用后页面才能加载，插件的 RPC 通道也只在启用时运行。</span>
      <button class="btn primary sm" type="button" data-enable-plugin="${esc(plugin.id)}">启用（本司）</button></div>`
  }
  if (!plugin.pages.length) return '<div class="empty plugin-empty-inline">这个插件没有贡献页面（只提供 host 能力或工具）。</div>'
  const activeKey = state.pluginPageKey && plugin.pages.some((page) => page.id === state.pluginPageKey)
    ? state.pluginPageKey
    : plugin.pages[0].id
  const page = plugin.pages.find((item) => item.id === activeKey) || plugin.pages[0]
  const src = pluginPageUrl(data, plugin, page)
  const switchButtons = plugin.pages.length > 1
    ? `<div class="plugin-page-switch">${plugin.pages
        .map(
          (item) =>
            `<button class="plugin-page-tab${item.id === page.id ? ' is-active' : ''}" type="button" data-open-page="${esc(item.id)}">${esc(item.title)}</button>`,
        )
        .join('')}</div>`
    : ''
  return `${switchButtons}
    <div class="plugin-frame"><iframe data-plugin-frame src="${esc(src)}" title="${esc(page.title)}" sandbox="allow-same-origin allow-scripts allow-forms"></iframe></div>`
}

function pluginVersionsBody(data, plugin) {
  const install = plugin.install
  const installed = install ? fmtPluginTime(install.installedAt) : '—'
  const updated = install?.updatedAt ? fmtPluginTime(install.updatedAt) : '—'
  const registry = install?.sourceRef || install?.source || '—'
  return `<div class="plugin-version-current">
      <div><span class="plugin-version-label">当前版本</span><strong class="mono">${esc(plugin.version)}</strong></div>
      <div class="plugin-version-actions">
        <button class="btn sm" type="button" data-update-plugin="${esc(plugin.id)}"${plugin.format === 'dsh' ? '' : ''}>更新…</button>
      </div>
    </div>
    <div class="kv plugin-kv">
      <div><span>安装版本</span><strong class="mono">${esc(install?.version || plugin.version)}</span></div>
      <div><span>清单指纹</span><strong class="mono">${esc(plugin.checksum || install?.checksum || '—')}</strong></div>
      <div><span>首次安装</span><strong>${esc(installed)}</strong></div>
      <div><span>最后更新</span><strong>${esc(updated)}</strong></div>
      <div><span>来源</span><strong class="mono">${esc(registry)}</strong></div>
      <div><span>安装范围</span><strong>${plugin.personal ? '个人' : '当前公司'}</strong></div>
    </div>
    ${hintNote('更新说明', '更新只改版本 / 来源 / 指纹，保留首次安装时间；旧目录移到 plugins/.trash。同版本也可重装（覆盖更新）。')}`
}

function pluginSettingsBody(data, plugin, host) {
  const hostLogs = host?.logs?.length ? esc(host.logs.slice(-8).join('\n')) : '（暂无宿主日志）'
  const routes = host?.routes?.length
    ? host.routes.map((route) => `<span class="chip mono">${esc(route)}</span>`).join('')
    : '<span class="muted">没有挂载 RPC 通道</span>'
  const dshSettings = plugin.format === 'dsh'
    ? `<div class="plugin-setting-row">
        <div><strong>宿主运行状态</strong><span>host 侧 apply() 是否跑通、注册了哪些 RPC 通道；插件页面通过它们读写自己的数据。</span></div>
        <span class="pill ${host && !host.error ? 'ok' : 'warn'}">${host && !host.error ? '运行中' : host?.error ? '异常' : '未加载'}</span>
      </div>
      <div class="plugin-host-detail">
        <div class="plugin-host-routes">${routes}</div>
        ${host?.error ? `<div class="banner danger"><strong>${esc(host.error)}</strong><span>检查 host 入口、依赖或插件日志；修好后重新启停或更新插件。</span></div>` : ''}
        <pre class="plugin-host-log">${hostLogs}</pre>
        <div class="plugin-actions"><button class="btn sm" type="button" data-reload-host>刷新宿主状态</button></div>
      </div>`
    : `<div class="plugin-setting-row"><div><strong>页面运行方式</strong><span>EAB 原生插件页面：静态 HTML + iframe 沙箱，可自行调用 EAB 的 HTTP API。</span></div><span class="pill">HTML</span></div>`

  return `<div class="plugin-setting-row">
      <div><strong>当前公司启用</strong><span>启停只记在「${esc(data.companyId)}」名下；停用后页面与宿主通道一起下线。</span></div>
      <button class="btn ${plugin.enabled ? 'sm' : 'primary sm'}" type="button" data-toggle-plugin="${esc(plugin.id)}" data-next="${plugin.enabled ? 'false' : 'true'}">${plugin.enabled ? '停用（本司）' : '启用（本司）'}</button>
    </div>
    ${dshSettings}
    <div class="plugin-danger-zone">
      <div><strong>卸载</strong><span>解除当前公司的安装与启停记录；最后一家公司卸载时目录移入 plugins/.trash。</span></div>
      <button class="btn danger sm" type="button" data-uninstall-plugin="${esc(plugin.id)}">卸载…</button>
    </div>`
}

function pluginLogsBody(data, plugin) {
  const events = (data.events || []).filter((event) => event.pluginId === plugin.id)
  return `<table class="data plugin-events-table">
    <thead><tr><th>时间</th><th>动作</th><th>操作人</th><th>详情</th></tr></thead>
    <tbody>${events.length
      ? events
          .map(
            (event) => `<tr>
        <td class="mono">${esc(fmtPluginTime(event.at))}</td>
        <td><span class="pill">${esc(PLUGIN_EVENT_LABEL[event.event] || event.event)}</span></td>
        <td>${esc(event.actorId || '—')}</td>
        <td>${pluginEventDetail(event)}</td>
      </tr>`,
          )
          .join('')
      : '<tr><td colspan="4" class="muted">这个插件还没有生命周期记录</td></tr>'}</tbody>
  </table>`
}

function pluginDetailHtml(data, plugin) {
  const host = pluginHostOf(data, plugin.id)
  const tab = state.pluginTab || 'overview'
  const tabs = [
    ['overview', '概览', ''],
    ['pages', `页面${plugin.pages.length ? ` <span class="plugin-tab-count">${plugin.pages.length}</span>` : ''}`, ''],
    ['versions', '版本', ''],
    ['settings', '设置', ''],
    ['logs', `生命周期${(data.events || []).filter((event) => event.pluginId === plugin.id).length ? ` <span class="plugin-tab-count">${(data.events || []).filter((event) => event.pluginId === plugin.id).length}</span>` : ''}`, ''],
  ]
  const tabBar = tabs
    .map(
      ([key, label]) =>
        `<button class="plugin-tab${tab === key ? ' is-active' : ''}" type="button" data-plugin-tab="${key}">${label}</button>`,
    )
    .join('')
  let body = pluginOverviewBody(data, plugin, host)
  if (tab === 'pages') body = pluginPagesBody(data, plugin)
  else if (tab === 'versions') body = pluginVersionsBody(data, plugin)
  else if (tab === 'settings') body = pluginSettingsBody(data, plugin, host)
  else if (tab === 'logs') body = pluginLogsBody(data, plugin)
  const initial = (plugin.name || plugin.id || '?').trim().slice(0, 1).toUpperCase()

  return `<section class="panel plugin-detail">
    <div class="plugin-detail-head">
      <div class="plugin-title">
        <div class="plugin-avatar">${esc(initial)}</div>
        <div class="plugin-title-text">
          <div class="plugin-title-row"><h2>${esc(plugin.name)}</h2>${pluginFormatBadge(plugin)}${pluginStatusPill(plugin, host)}</div>
          <div class="plugin-subline"><span class="mono">${esc(plugin.id)}@${esc(plugin.version)}</span>${plugin.format === 'dsh' ? `<span class="muted">· DSH 插件协议</span>` : ''}</div>
        </div>
      </div>
      <div class="plugin-detail-actions">
        <button class="btn ghost sm" type="button" data-close-plugin>收起</button>
        <button class="btn sm" type="button" data-toggle-plugin="${esc(plugin.id)}" data-next="${plugin.enabled ? 'false' : 'true'}">${plugin.enabled ? '停用' : '启用'}</button>
        <button class="btn sm" type="button" data-update-plugin="${esc(plugin.id)}">更新…</button>
        <button class="btn ghost sm" type="button" data-uninstall-plugin="${esc(plugin.id)}">卸载…</button>
      </div>
    </div>
    <div class="plugin-tabs">${tabBar}</div>
    <div id="plugin-tab-body">${body}</div>
  </section>`
}

function pluginWelcomeHtml(data) {
  const hosts = (data.hosts || []).filter((host) => !host.error).length
  const hasPlugins = data.plugins.length > 0
  return `<section class="panel plugin-welcome">
    <div class="plugin-welcome-mark">P</div>
    <span class="install-eyebrow">PLUGIN WORKSPACE</span>
    <h2>${hasPlugins ? '从左侧选择一个插件' : '当前公司还没有安装插件'}</h2>
    <div class="hint-note" style="justify-content:center">${hintBadge(
      hasPlugins ? '工作区说明' : '安装来源',
      hasPlugins ? '点击左侧插件，右侧会展开它的概览、页面、版本、设置和生命周期记录。' : '可以安装本地目录、npm 国内镜像、GitHub 仓库里的 EAB 插件，或直接装 D 盘里的 DSH 插件。',
    )}</div>    <div class="plugin-welcome-stats">
      <div><strong>${data.stats.installed}</strong><span>已安装</span></div>
      <div><strong>${data.stats.enabled}</strong><span>启用</span></div>
      <div><strong>${hosts}</strong><span>host 运行</span></div>
    </div>
    <div class="plugin-welcome-actions">
      <button class="btn primary" type="button" data-install-plugin>安装插件…</button>
      <button class="btn ghost" type="button" data-reload-plugins>重新扫描</button>
    </div>
  </section>`
}

function pluginCatalogHtml(data) {
  const entries = data.catalog.plugins.filter((entry) => !entry.installed || entry.updateAvailable)
  const cards = entries.length
    ? entries
        .map(
          (entry) => `<article class="plugin-catalog-card">
        <div class="plugin-catalog-head"><strong>${esc(entry.name)}</strong><span class="pill ${entry.updateAvailable ? 'warn' : ''}">${entry.updateAvailable ? `可更新 ${esc(entry.version)}` : `可安装 ${esc(entry.version)}`}</span></div>
        <div class="mono muted">${esc(entry.id)}@${esc(entry.version)}</div>
        <p>${esc(entry.description || '（没有写描述）')}</p>
        <div class="plugin-actions">${(entry.tags || []).map((tag) => `<span class="chip">${esc(tag)}</span>`).join('')}<button class="btn primary sm" type="button" data-catalog-install="${esc(entry.id)}">${entry.updateAvailable ? '更新' : '安装'}</button></div>
      </article>`,
        )
        .join('')
    : '<div class="empty plugin-empty-inline">插件源里没有当前公司可安装或可更新的条目。</div>'
  return `<section class="panel plugin-catalog">
    <div class="panel-head"><h2>插件源</h2><span class="hint">${entries.length} 个可装 / 可更新 · <span class="mono">${esc(data.catalog.path)}</span></span></div>
    <div class="legend" style="margin-top:0">${data.catalog.error ? esc(data.catalog.error) : hintBadge('来源说明', '本地目录、npm 国内镜像、GitHub 三种来源安装后走同一条校验与登记链路；DSH 插件按 package.json 的 files 白名单复制。')}</div>
    <div class="plugin-catalog-grid">${cards}</div>
  </section>`
}

function pluginRailHtml(data) {
  const companyName = state.companies?.find((item) => item.id === data.companyId)?.name || data.companyId || '当前公司'
  const selected = state.pluginSelected
  const installed = data.plugins
    .map((plugin) => pluginRailItem(plugin, plugin.id === selected))
    .join('')
  const available = data.catalog.plugins.filter((entry) => !entry.installed || entry.updateAvailable)
  const catalog = available.map(pluginCatalogRailItem).join('')
  const hosts = (data.hosts || []).filter((host) => !host.error).length
  return `<div class="plugin-scope-block">
      <div class="plugin-scope-kicker">
        <span class="plugin-scope-eyebrow">当前公司</span>
        ${hintBadge('归属说明', '安装 / 启停 / 卸载只记在本司名下。')}
      </div>
      <strong>${esc(companyName)}</strong>
    </div>
    <div class="plugin-rail-metrics">
      <div><strong>${data.stats.installed}</strong><span>已装</span></div>
      <div><strong>${data.stats.enabled}</strong><span>启用</span></div>
      <div><strong>${hosts}</strong><span>host</span></div>
    </div>
    <div class="plugin-rail-actions">
      <button class="btn primary sm" type="button" data-install-plugin>安装插件…</button>
      <button class="btn ghost sm" type="button" data-reload-plugins>刷新</button>
    </div>
    <div class="side-head">已安装 <span class="muted">${data.plugins.length}</span></div>
    <div class="side-list plugin-rail-list">${installed || '<div class="side-note">当前公司还没有安装插件</div>'}</div>
    <div class="side-head">可安装 / 可更新 <span class="muted">${available.length}</span></div>
    <div class="side-list plugin-rail-list">${catalog || '<div class="side-note">没有新的可安装条目</div>'}</div>`
}

function bindPluginTabs() {
  for (const button of document.querySelectorAll('[data-plugin-tab]')) {
    button.addEventListener('click', () => {
      state.pluginTab = button.dataset.pluginTab
      renderPluginView()
    })
  }
  for (const button of document.querySelectorAll('[data-close-plugin]')) {
    button.addEventListener('click', () => {
      state.pluginSelected = null
      state.pluginTab = 'overview'
      state.pluginPageKey = null
      renderPluginSide()
      renderPluginView()
    })
  }
  for (const button of document.querySelectorAll('[data-open-page]')) {
    button.addEventListener('click', () => {
      state.pluginPageKey = button.dataset.openPage
      state.pluginTab = 'pages'
      renderPluginView()
    })
  }
  for (const button of document.querySelectorAll('[data-enable-plugin]')) {
    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        await apiPost(`/api/plugins/${encodeURIComponent(button.dataset.enablePlugin)}/state`, { enabled: true })
        await loadPlugins()
      } catch (err) {
        button.disabled = false
        renderDenied($('#view'), err)
      }
    })
  }
  const reloadHost = document.querySelector('[data-reload-host]')
  if (reloadHost) {
    reloadHost.addEventListener('click', () => loadPlugins())
  }
  for (const button of document.querySelectorAll('[data-install-plugin]')) {
    button.addEventListener('click', () => openPluginInstall())
  }
  for (const button of document.querySelectorAll('[data-reload-plugins]')) {
    button.addEventListener('click', () => loadPlugins())
  }
  for (const button of document.querySelectorAll('[data-select-plugin]')) {
    button.addEventListener('click', () => {
      state.pluginSelected = button.dataset.selectPlugin
      state.pluginTab = 'overview'
      state.pluginPageKey = null
      renderPluginSide()
      renderPluginView()
    })
  }
  for (const button of document.querySelectorAll('[data-catalog-open]')) {
    button.addEventListener('click', () => {
      const entry = state.pluginData?.catalog.plugins.find((item) => item.id === button.dataset.catalogOpen)
      if (entry) openPluginInstall({ id: entry.id, sourcePath: entry.sourcePath || '' })
    })
  }
  for (const button of document.querySelectorAll('[data-catalog-install]')) {
    button.addEventListener('click', () => {
      const entry = state.pluginData?.catalog.plugins.find((item) => item.id === button.dataset.catalogInstall)
      if (entry) openPluginInstall({ id: entry.id, sourcePath: entry.sourcePath || '' })
    })
  }
  for (const button of document.querySelectorAll('[data-update-plugin]')) {
    button.addEventListener('click', () => {
      const plugin = state.pluginData?.plugins.find((item) => item.id === button.dataset.updatePlugin)
      if (plugin) openPluginInstall({ id: plugin.id, sourcePath: plugin.install?.sourceRef || '' })
    })
  }
  for (const button of document.querySelectorAll('[data-uninstall-plugin]')) {
    button.addEventListener('click', () => {
      const plugin = state.pluginData?.plugins.find((item) => item.id === button.dataset.uninstallPlugin)
      if (plugin) openPluginUninstall(plugin)
    })
  }
  for (const button of document.querySelectorAll('[data-toggle-plugin]')) {
    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        await apiPost(`/api/plugins/${encodeURIComponent(button.dataset.togglePlugin)}/state`, {
          enabled: button.dataset.next === 'true',
        })
        await loadPlugins()
      } catch (err) {
        button.disabled = false
        renderDenied($('#view'), err)
      }
    })
  }
}

function renderPluginSide() {
  const data = state.pluginData
  if (!data) return
  // 插件列表直接落在全站左侧栏（nav-rail），不再占页内 page-rail
  renderNavRail()
}

function renderPluginView() {
  const data = state.pluginData
  if (!data) return
  const view = $('#view')
  const plugin = state.pluginSelected
    ? data.plugins.find((item) => item.id === state.pluginSelected) || null
    : null
  // 详情只在点击插件后出现；默认/收起时是选择提示，不再把详情和全量生命周期铺在页面上
  view.innerHTML = plugin ? pluginDetailHtml(data, plugin) : pluginWelcomeHtml(data)
  bindPluginTabs()
}

async function loadPlugins() {
  const view = $('#view')
  renderLoading(view)
  setSide('', true)
  try {
    const data = await api('/api/console/plugins')
    state.pluginData = data
    // 默认不选中任何插件：详情由左侧列表点击后出现
    if (state.pluginSelected && !data.plugins.some((item) => item.id === state.pluginSelected)) {
      state.pluginSelected = null
    }
    if (!state.pluginSelected) {
      state.pluginTab = 'overview'
      state.pluginPageKey = null
    }
    renderPluginSide()
    renderPluginView()
  } catch (err) {
    state.pluginData = null
    renderNavRail()
    renderDenied(view, err)
  }
}


/* ---------------- 导航 ---------------- */

/**
 * 一级：业务域；二级：域内页面。
 * 页面清单集中在这里，新页面只加一条，不用再同时改 index.html 与 CSS。
 * 之前是"顶部悬停出二级"，得把鼠标停在某个分组上才知道有哪些页；现在二级常驻左侧。
 */
const DOMAINS = [
  { id: 'overview', label: '概览', kicker: 'OVERVIEW', pages: ['overview'] },
  { id: 'org', label: '组织与权限', kicker: 'ORGANIZATION & ACCESS', pages: ['org', 'departments', 'roles', 'access'] },
  { id: 'knowledge', label: '知识与模型', kicker: 'KNOWLEDGE & MODELS', pages: ['kb', 'models', 'tools'] },
  { id: 'platform', label: '连接与平台', kicker: 'PLATFORMS', pages: ['channels', 'company', 'system'] },
  { id: 'plugins', label: '插件管理', kicker: 'PLUGIN ECOSYSTEM', pages: ['extra'] },
  { id: 'ops', label: '运营与审计', kicker: 'OPERATIONS', pages: ['usage', 'quota', 'audit', 'approvals'] },
]

const PAGE_DOMAIN = DOMAINS.reduce((map, domain) => {
  for (const page of domain.pages) map[page] = domain.id
  return map
}, {})

/** 记住每个业务域最后停在哪一页：再点回顶部时不用重新找 */
const lastPageByDomain = new Map()

function domainOf(page) {
  return DOMAINS.find((domain) => domain.id === PAGE_DOMAIN[page]) ?? DOMAINS[0]
}

/** 页内选择器（组织树 / 知识库列表 / 角色列表）落在 page-rail，不是全站二级导航 */
const $side = () => document.getElementById('page-rail')

function setSide(html, empty = false) {
  const rail = $side()
  const body = document.getElementById('page-body')
  if (!rail || !body) return
  const blank = empty || !String(html ?? '').trim()
  rail.innerHTML = blank ? '' : html
  body.classList.toggle('no-rail', blank)
}

/** 左侧二级导航：普通域是页面列表；插件域改渲染插件概览与插件列表 */
function renderNavRail() {
  const rail = document.getElementById('nav-rail')
  if (!rail) return
  // 插件管理域只有一页，左侧改成插件概览 + 插件列表，避免“域→唯一页面”的重复导航
  if (state.page === 'extra') {
    rail.classList.add('plugin-mode')
    if (state.pluginData) {
      rail.innerHTML = pluginRailHtml(state.pluginData)
    } else {
      rail.innerHTML = `<div class="side-note muted">插件加载中…</div>`
    }
    return
  }
  rail.classList.remove('plugin-mode')
  const domain = domainOf(state.page)
  if (domain.id === 'org') {
    const orgPages = [
      ['org', '成员管理', '成员列表与角色授权'],
      ['departments', '部门管理', '部门结构、负责人与下级'],
      ['roles', '角色管理', '角色权限与成员配置'],
    ]
    const activePage = state.page === 'access' ? 'roles' : state.page
    rail.classList.add('org-rail-mode')
    rail.innerHTML = `<nav class="org-rail-nav" aria-label="组织与权限分类">
      ${orgPages
        .map(([page, label, sub]) => {
          const isRoles = page === 'roles'
          const isOpen = isRoles && state.page === 'roles'
          return `<button class="org-rail-item${page === activePage ? ' is-active' : ''}${isRoles ? ' has-sub' : ''}" type="button" data-page="${page}">
            <span class="org-rail-copy"><strong>${label}</strong><small>${sub}</small></span>
            ${isRoles ? '<span class="org-rail-caret" aria-hidden="true">⌄</span>' : ''}
          </button>
          ${isOpen ? roleRailSubmenuHtml(state.roles) : ''}`
        })
        .join('')}
    </nav>`
    return
  }
  rail.classList.remove('org-rail-mode')
  rail.innerHTML = `
    ${domain.pages
      .map((page) => {
        const meta = PAGES[page]
        if (!meta) return ''
        const active = page === state.page ? ' is-active' : ''
        return `<button class="nav-rail-item${active}" type="button" data-page="${page}">
          <span class="nav-rail-label">${esc(meta.title)}</span>
          <span class="nav-rail-sub">${esc(meta.sub)}</span>
        </button>`
      })
      .join('')}`
}

function setPageActions(html) {
  const slot = document.querySelector('#page-actions')
  if (slot) slot.innerHTML = html ?? ''
  slot?.closest('.page-head')?.classList.toggle('has-actions', Boolean(String(html ?? '').trim()))
}

function navigate(page) {
  if (!state.companies.length) {
    renderFirstCompany()
    return
  }
  if (!PAGES[page]) return
  state.page = page
  state.domain = PAGE_DOMAIN[page] ?? 'overview'
  lastPageByDomain.set(state.domain, page)
  const meta = PAGES[page]
  const domain = domainOf(page)
  $('#page-title').textContent = meta.title
  $('#page-sub').textContent = meta.sub
  const kicker = $('#page-kicker')
  if (kicker) kicker.textContent = domain.kicker
  setPageActions('')
  for (const button of document.querySelectorAll('.nav-primary[data-domain]')) {
    button.classList.toggle('is-active', button.dataset.domain === state.domain)
  }
  // 插件域：左侧栏承载插件概览与列表，内容区不再保留页内 rail，右侧视图铺满
  const workspace = document.querySelector('.workspace')
  workspace?.classList.toggle('is-plugin-domain', state.domain === 'plugins')
  // 概览域只有一页，左侧二级导航没有可切换项；收起侧栏，让概览卡片铺满内容区
  workspace?.classList.toggle('no-side', state.domain === 'overview')
  // 所有页面统一不显示大标题/副标题；page-head 只作为页面操作的右侧工具条保留。
  const pageHead = document.querySelector('.page-head')
  pageHead?.classList.remove('is-hidden')
  pageHead?.classList.add('is-headingless')
  renderNavRail()
  state.deptFilter = null
  meta.render()
}

async function refresh() {
  await loadMe()
  navigate(state.page)
}

async function logoutConsole() {
  try {
    await apiPost('/api/console/logout', {})
  } catch {
    /* 口令已经失效也没关系，直接回门口 */
  }
  location.replace('/admin')
}

async function loadAccountPanel() {
  const meta = $('#account-meta')
  if (!meta) return
  try {
    const acc = await api('/api/console/account')
    state.account = acc
    $('#account-user').textContent = acc.user || 'admin'
    const remain = acc.expiresAt ? Math.max(0, Math.round((new Date(acc.expiresAt).getTime() - Date.now()) / 3600000)) : null
    meta.innerHTML = `
      <div><span>身份</span><strong>${esc(acc.displayName || '超级管理员')} · ${esc(acc.role || '服务器侧')}</strong></div>
      <div><span>登录来源</span><strong class="mono">${esc(acc.ip || '本机')}</strong></div>
      <div><span>密码托管</span><strong>${acc.passwordSource === 'env' ? '环境变量' : '本地文件'}</strong></div>
      ${remain === null ? '' : `<div><span>会话剩余</span><strong>约 ${remain} 小时</strong></div>`}`
    const pwButton = $('#account-password')
    if (pwButton) {
      const envManaged = acc.passwordSource === 'env'
      pwButton.disabled = envManaged
      pwButton.title = envManaged ? '密码由环境变量 EAB_ADMIN_PASSWORD 管理，控制台内不能改' : ''
      pwButton.querySelector('small').textContent = envManaged ? '由环境变量管理，需改部署配置' : '更新控制台登录口令'
    }
  } catch (err) {
    meta.textContent = err?.message || '账号信息读取失败'
  }
}

function openPasswordModal() {
  const envManaged = state.account?.passwordSource === 'env'
  const overlay = modelModal(`
    <div class="modal-head"><h3>修改控制台密码</h3><button class="modal-x" type="button">×</button></div>
    ${
      envManaged
        ? `${hintNote('环境变量管理', '当前密码由环境变量 EAB_ADMIN_PASSWORD 管理，控制台内不能修改。请改部署环境变量后重启服务。')}
           <div class="modal-actions"><button class="btn ghost" type="button" id="pw-close">关闭</button></div>`
        : `<div class="field-stack">
             <label class="field"><span>当前密码</span><input id="pw-current" type="password" autocomplete="current-password" /></label>
             <label class="field"><span>新密码（8–72 位）</span><input id="pw-new" type="password" autocomplete="new-password" /></label>
             <label class="field"><span>再输一遍新密码</span><input id="pw-confirm" type="password" autocomplete="new-password" /></label>
           </div>
           ${hintNote('生效说明', '改完后其它设备上的控制台会话立即失效，当前会话保留；新密码会写入 .eab-dev/admin-credentials.txt。')}
           <div class="modal-state" id="pw-state"></div>
           <div class="modal-actions">
             <button class="btn primary" type="button" id="pw-save">更新密码</button>
             <button class="btn ghost" type="button" id="pw-cancel">取消</button>
           </div>`
    }`)
  const close = () => overlay.remove()
  overlay.querySelector('.modal-x').addEventListener('click', close)
  overlay.querySelector('#pw-close')?.addEventListener('click', close)
  overlay.querySelector('#pw-cancel')?.addEventListener('click', close)
  const save = overlay.querySelector('#pw-save')
  if (!save) return
  save.addEventListener('click', async () => {
    const current = overlay.querySelector('#pw-current').value
    const next = overlay.querySelector('#pw-new').value
    const confirmValue = overlay.querySelector('#pw-confirm').value
    const stateEl = overlay.querySelector('#pw-state')
    const bad = (text) => {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = text
    }
    if (!current) return bad('先输入当前密码')
    if (next.length < 8 || next.length > 72) return bad('新密码需要 8–72 位')
    if (next === current) return bad('新密码不能和当前密码相同')
    if (next !== confirmValue) return bad('两次输入的新密码不一致')
    stateEl.className = 'modal-state'
    stateEl.textContent = '更新中…'
    save.disabled = true
    try {
      const result = await apiPost('/api/console/password', { currentPassword: current, newPassword: next })
      stateEl.className = 'modal-state good'
      stateEl.textContent =
        result.revokedSessions > 0 ? `密码已更新，其它 ${result.revokedSessions} 个会话已失效` : '密码已更新'
      save.textContent = '完成'
      save.disabled = false
      save.addEventListener('click', close, { once: true })
      overlay.querySelector('#pw-cancel').hidden = true
    } catch (err) {
      stateEl.className = 'modal-state bad'
      stateEl.textContent = err?.message || '更新失败'
      save.disabled = false
    }
  })
}

function setupAccount() {
  const toggle = $('#account-toggle')
  const pop = $('#account-pop')
  if (!toggle || !pop) return
  const setOpen = (open) => {
    pop.hidden = !open
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
  }
  toggle.addEventListener('click', async (event) => {
    event.stopPropagation()
    const opening = pop.hidden
    setOpen(opening)
    if (opening) loadAccountPanel()
  })
  pop.addEventListener('click', (event) => {
    event.stopPropagation()
    const action = event.target.closest('[data-account-action]')
    if (!action) return
    const name = action.dataset.accountAction
    setOpen(false)
    if (name === 'logout') logoutConsole()
    if (name === 'password') openPasswordModal()
  })
  document.addEventListener('click', (event) => {
    if (pop.hidden) return
    if (pop.contains(event.target) || toggle.contains(event.target)) return
    setOpen(false)
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !pop.hidden) setOpen(false)
  })
}

async function boot() {
  const initialPage = new URLSearchParams(location.search).get('goto')
  if (initialPage && PAGES[initialPage]) {
    state.page = initialPage
    state.domain = PAGE_DOMAIN[initialPage] ?? 'overview'
  }
  try {
    const health = await api('/api/health')
    $('#health-dot').classList.add('ok')
    $('#health-dot').title = `服务正常 · v${health.version}`
    $('#health-text').textContent = `v${health.version}`
  } catch {
    $('#health-dot').classList.add('bad')
    $('#health-text').textContent = '服务异常'
  }

  try {
    await loadCompanies()
  } catch (err) {
    renderDenied($('#view'), err)
    return
  }

  /**
   * 空库部署：先渲染“创建第一家公司”，不要继续 loadMe ——
   * 此时 resolveActor 找不到公司，会直接抛错，页面就卡成空白/拒绝页。
   */
  const needsFirstCompany = state.companies.length === 0
  setupAccount()
  if (needsFirstCompany) renderFirstCompany()

  // 顶部：只切业务域。点同一个域时回到该域上次停留的页面。
  $('#topnav').addEventListener('click', (event) => {
    const target = event.target.closest('[data-domain]')
    if (!target) return
    const domain = DOMAINS.find((item) => item.id === target.dataset.domain)
    if (!domain) return
    const page = lastPageByDomain.get(domain.id) ?? domain.pages[0]
    if (page) navigate(page)
  })

  // 左侧二级导航：切当前域内的页面
  $('#nav-rail').addEventListener('click', (event) => {
    const roleTarget = event.target.closest('[data-role]')
    if (roleTarget) {
      state.selectedRole = roleTarget.dataset.role
      state.roleTab = 'permissions'
      if (state.page === 'roles') loadRoles()
      else navigate('roles')
      return
    }
    const target = event.target.closest('[data-page]')
    if (!target) return
    // 点「角色管理」父项回到角色总览；清除当前选中的角色，避免继续停留在详情页
    if (target.dataset.page === 'roles') {
      state.selectedRole = null
      state.roleTab = 'permissions'
    }
    navigate(target.dataset.page)
  })

  document.addEventListener('click', (event) => {
    if (!event.target.closest('#company-picker')) closeCompanyPicker()
    if (kbMenu && !event.target.closest('#kb-menu') && !event.target.closest('[data-kb-more]')) hideKbMenu()
    if (deptMenu && !event.target.closest('#dept-menu')) hideDeptMenu()
    if (memberMenu && !event.target.closest('#member-menu') && !event.target.closest('[data-member-more]')) hideMemberMenu()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideKbMenu()
      hideDeptMenu()
      hideMemberMenu()
    }
  })
  window.addEventListener('resize', () => {
    hideKbMenu()
    hideDeptMenu()
    hideMemberMenu()
  })

  // 组织树在子导航里渲染（子导航不属于 #view），所以监听放到 document 上
  document.addEventListener('click', (event) => {
    const expand = event.target.closest('[data-tree-expand]')
    if (expand) {
      state.collapsed.clear()
      repaintTree()
      return
    }
    const collapse = event.target.closest('[data-tree-collapse]')
    if (collapse) {
      for (const node of rootNodes) {
        for (const path of treePathsWithChildren(node, [])) state.collapsed.add(path)
      }
      repaintTree()
    }
  })

  if (needsFirstCompany) return
  await refresh()
}

bindHintTips()
boot()
