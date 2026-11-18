/**
 * 管理后台页面注册表（服务端唯一事实来源）。
 *
 * 为什么单独放一份：
 * - 前端 `public/app.js` 的 PAGES/DOMAINS 是渲染用的；
 * - 服务端接口守卫、成员权限配置、对话页入口判断都需要同一套 page key；
 * - 两边如果各写一份，新增页面时很容易出现“页面能打开、接口没守卫”或反过来的漏洞。
 *
 * 这里的 key 必须与前端 PAGES 的 key 完全一致。`console-access.test.ts` 会做一致性校验。
 */
import { SC, type Scope } from '@eab/domain'

export type ConsolePageKey =
  | 'overview'
  | 'org'
  | 'departments'
  | 'roles'
  | 'approvalPolicies'
  | 'access'
  | 'kb'
  | 'models'
  | 'tools'
  | 'channels'
  | 'databases'
  | 'documents'
  | 'company'
  | 'usage'
  | 'quota'
  | 'audit'
  | 'tasks'
  | 'approvals'
  | 'system'
  | 'extra'
  | 'skills'

/** 页面级写动作。可见（view）单独存在，不放在这里。 */
export type ConsoleWriteAction = 'create' | 'edit' | 'delete'

export interface ConsolePageWriteActions {
  readonly create: boolean
  readonly edit: boolean
  readonly delete: boolean
}

export interface ConsolePageActionMeta {
  readonly id: ConsoleWriteAction
  /** 勾选框文案。不同页面的同一个动作含义不同，例如审计页的 edit 实际是“导出”。 */
  readonly label: string
}

/** 页内二级分区（页面里的 tab / 分段），权限按“页面 + 分区”分别保存。 */
export interface ConsolePageSectionMeta {
  readonly key: string
  readonly title: string
  readonly actions: readonly ConsolePageActionMeta[]
  /** 纯“能力开关”型分区不暴露只读的“可见”，避免出现勾了也看不到内容的空权限。 */
  readonly hideView?: boolean
}

export interface ConsolePageMeta {
  readonly key: ConsolePageKey
  readonly title: string
  readonly domain: string
}

export interface ConsoleDomainMeta {
  readonly id: string
  readonly title: string
  readonly pages: readonly ConsolePageKey[]
}

export const CONSOLE_DOMAINS: readonly ConsoleDomainMeta[] = [
  { id: 'overview', title: '概览', pages: ['overview'] },
  { id: 'org', title: '组织与权限', pages: ['org', 'departments', 'roles', 'approvalPolicies', 'access'] },
  { id: 'knowledge', title: '知识与模型', pages: ['kb', 'models', 'tools'] },
  { id: 'platform', title: '连接与平台', pages: ['channels', 'databases', 'documents', 'company', 'system'] },
  { id: 'plugins', title: '插件管理', pages: ['extra'] },
  { id: 'skills', title: '技能管理', pages: ['skills'] },
  { id: 'ops', title: '运营与审计', pages: ['usage', 'quota', 'audit', 'tasks', 'approvals'] },
]

export const CONSOLE_PAGES: readonly ConsolePageMeta[] = [
  { key: 'overview', title: '概览', domain: 'overview' },
  { key: 'org', title: '成员管理', domain: 'org' },
  { key: 'departments', title: '部门管理', domain: 'org' },
  { key: 'roles', title: '角色管理', domain: 'org' },
  { key: 'approvalPolicies', title: '权限审批', domain: 'org' },
  { key: 'access', title: '权限矩阵', domain: 'org' },
  { key: 'kb', title: '知识库', domain: 'knowledge' },
  { key: 'models', title: '模型接入', domain: 'knowledge' },
  { key: 'tools', title: '工具', domain: 'knowledge' },
  { key: 'channels', title: '渠道', domain: 'platform' },
  { key: 'databases', title: '数据连接', domain: 'platform' },
  { key: 'documents', title: '在线文档', domain: 'platform' },
  { key: 'company', title: '公司设置', domain: 'platform' },
  { key: 'system', title: '系统', domain: 'platform' },
  { key: 'usage', title: '用量', domain: 'ops' },
  { key: 'quota', title: '额度', domain: 'ops' },
  { key: 'audit', title: '审计', domain: 'ops' },
  { key: 'tasks', title: '任务中心', domain: 'ops' },
  { key: 'approvals', title: '审批', domain: 'ops' },
  { key: 'extra', title: '插件', domain: 'plugins' },
  { key: 'skills', title: '技能', domain: 'skills' },
]

export const CONSOLE_PAGE_KEYS: readonly ConsolePageKey[] = CONSOLE_PAGES.map((page) => page.key)

const PAGE_SET = new Set<string>(CONSOLE_PAGE_KEYS)

export function isConsolePageKey(value: string): value is ConsolePageKey {
  return PAGE_SET.has(value)
}

/**
 * 每个页面实际允许哪些写动作。
 *
 * 只读页（概览、权限矩阵、用量）没有写动作；有列表增删改的页面按实际按钮给到三项；
 * “审计”“系统”这类页面没有新增/删除，只保留一个能表达原有能力的动作。
 */
export const CONSOLE_PAGE_ACTIONS: Record<ConsolePageKey, readonly ConsolePageActionMeta[]> = {
  overview: [],
  org: [
    { id: 'create', label: '新增' },
    { id: 'edit', label: '编辑' },
    { id: 'delete', label: '删除' },
  ],
  departments: [
    { id: 'create', label: '新增' },
    { id: 'edit', label: '编辑' },
    { id: 'delete', label: '删除' },
  ],
  roles: [
    { id: 'create', label: '新增' },
    { id: 'edit', label: '编辑' },
    { id: 'delete', label: '删除' },
  ],
  approvalPolicies: [
    { id: 'create', label: '新增策略' },
    { id: 'edit', label: '编辑策略' },
  ],
  access: [],
  kb: [
    { id: 'create', label: '新增' },
    { id: 'edit', label: '编辑' },
    { id: 'delete', label: '删除' },
  ],
  models: [
    { id: 'create', label: '新增' },
    { id: 'edit', label: '编辑' },
    { id: 'delete', label: '删除' },
  ],
  tools: [{ id: 'edit', label: '配置' }],
  channels: [
    { id: 'create', label: '新增绑定' },
    { id: 'edit', label: '配置' },
    { id: 'delete', label: '解绑' },
  ],
  databases: [
    { id: 'create', label: '新增' },
    { id: 'edit', label: '编辑' },
    { id: 'delete', label: '删除' },
  ],
  documents: [{ id: 'edit', label: '配置' }],
  company: [{ id: 'edit', label: '编辑' }],
  usage: [],
  quota: [
    { id: 'edit', label: '设置' },
    { id: 'delete', label: '清除' },
  ],
  audit: [{ id: 'edit', label: '导出' }],
  tasks: [
    { id: 'edit', label: '启停' },
    { id: 'delete', label: '取消' },
  ],
  approvals: [{ id: 'edit', label: '审批' }],
  system: [{ id: 'edit', label: '配置/执行' }],
  extra: [
    { id: 'create', label: '安装' },
    { id: 'edit', label: '启停/更新' },
    { id: 'delete', label: '卸载' },
  ],
  skills: [
    { id: 'create', label: '安装' },
    { id: 'edit', label: '启停/策略' },
    { id: 'delete', label: '卸载' },
  ],
}

export function consolePageActionMetas(page: ConsolePageKey): readonly ConsolePageActionMeta[] {
  return CONSOLE_PAGE_ACTIONS[page] ?? []
}

/**
 * 页内二级分区。只有页面内确实用 tab / 分段切换内容时才登记；
 * 分区 key 必须与前端 `data-section-target` / `data-channel-tab` / `data-role-tab` 一致。
 */
export const CONSOLE_PAGE_SECTIONS: Partial<Record<ConsolePageKey, readonly ConsolePageSectionMeta[]>> = {
  /**
   * 成员管理里的“后台访问”是给成员配置页面权限的能力，本身也必须可授权。
   * 单独放分区，避免把“编辑成员资料”与“改别人的后台权限”混成同一个勾选。
   */
  org: [
    { key: 'memberAccess', title: '后台访问', hideView: true, actions: [{ id: 'edit', label: '配置后台访问' }] },
  ],
  channels: [
    {
      key: 'binding',
      title: '企业绑定',
      actions: [
        { id: 'create', label: '开通/绑定' },
        { id: 'delete', label: '解绑' },
      ],
    },
    { key: 'config', title: '渠道接入', actions: [{ id: 'edit', label: '配置' }] },
    { key: 'sync', title: '通讯录同步', actions: [{ id: 'edit', label: '立即同步' }] },
    { key: 'history', title: '同步记录', actions: [] },
    {
      key: 'identities',
      title: '外部身份',
      actions: [
        { id: 'create', label: '新增绑定' },
        { id: 'edit', label: '编辑' },
        { id: 'delete', label: '解绑' },
      ],
    },
  ],
  models: [
    {
      key: 'providers',
      title: '供应商与端点',
      actions: [
        { id: 'create', label: '新增供应商' },
        { id: 'edit', label: '编辑' },
        { id: 'delete', label: '删除' },
      ],
    },
    { key: 'catalog', title: '模型目录', actions: [{ id: 'create', label: '新增模型' }, { id: 'edit', label: '编辑模型' }, { id: 'delete', label: '删除模型' }] },
    { key: 'routes', title: '用途路由', actions: [{ id: 'edit', label: '绑定路由' }] },
  ],
  system: [
    { key: 'runtime', title: '运行与准入', actions: [{ id: 'edit', label: '修改运行设置' }] },
    { key: 'concurrency', title: '并发与队列', actions: [{ id: 'edit', label: '修改并发配置' }] },
    { key: 'agents', title: 'Agent 管理', actions: [{ id: 'edit', label: '管理运行' }] },
    {
      key: 'jobs',
      title: '后台作业',
      actions: [
        { id: 'edit', label: '重试' },
        { id: 'delete', label: '取消' },
      ],
    },
    {
      key: 'boot',
      title: '启动动画',
      actions: [
        { id: 'edit', label: '配置片源' },
        { id: 'delete', label: '删除片源' },
      ],
    },
    { key: 'data', title: '系统与运维', actions: [{ id: 'edit', label: '配置/备份/恢复' }] },
  ],
}

export function consolePageSections(page: ConsolePageKey): readonly ConsolePageSectionMeta[] {
  return CONSOLE_PAGE_SECTIONS[page] ?? []
}

export function consolePageSectionActionMetas(
  page: ConsolePageKey,
  section: string,
): readonly ConsolePageActionMeta[] {
  return consolePageSections(page).find((item) => item.key === section)?.actions ?? []
}

export function isConsolePageSectionAllowed(
  page: ConsolePageKey,
  section: string,
  action: ConsoleWriteAction,
): boolean {
  return consolePageSectionActionMetas(page, section).some((meta) => meta.id === action)
}

/** 复合权限键：`page` 表示整页，`page:section` 表示页内某个分区。 */
export function consolePermissionPageKey(page: ConsolePageKey, section?: string | null): string {
  return section ? `${page}:${section}` : page
}

export interface ParsedConsolePermissionPage {
  readonly page: ConsolePageKey
  readonly section?: string
}

export function parseConsolePermissionPageKey(value: string): ParsedConsolePermissionPage | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  const colon = raw.indexOf(':')
  if (colon < 0) return isConsolePageKey(raw) ? { page: raw } : null
  const page = raw.slice(0, colon)
  const section = raw.slice(colon + 1)
  if (!isConsolePageKey(page) || !section) return null
  if (!consolePageSections(page).some((item) => item.key === section)) return null
  return { page, section }
}

export function isConsolePermissionPageKey(value: string): boolean {
  return parseConsolePermissionPageKey(value) !== null
}

export function consolePermissionLabel(page: ConsolePageKey, section?: string): string {
  const pageTitle = CONSOLE_PAGES.find((item) => item.key === page)?.title ?? page
  if (!section) return pageTitle
  const sectionTitle = consolePageSections(page).find((item) => item.key === section)?.title ?? section
  return `${pageTitle} · ${sectionTitle}`
}

export function isConsolePageActionAllowed(page: ConsolePageKey, action: ConsoleWriteAction): boolean {
  return consolePageActionMetas(page).some((meta) => meta.id === action)
}

function normalizeWriteActions(actions: boolean | ConsolePageWriteActions): ConsolePageWriteActions {
  if (typeof actions === 'boolean') {
    return { create: actions, edit: actions, delete: actions }
  }
  return {
    create: actions.create === true,
    edit: actions.edit === true,
    delete: actions.delete === true,
  }
}

/**
 * 页面权限对应到员工 scope。
 *
 * 为什么需要这层映射：
 * 后台不少页面复用了员工侧共享接口（`/api/org/tree`、`/api/org/members`、`/api/kb/collections`、
 * `/api/tools` 等），这些接口按角色 scope 判断。普通成员只有 `member` 角色，
 * 即使给了他“成员管理”页面权限，`/api/org/*` 仍会被 scope 拒绝。
 *
 * 因此只在“成员后台会话”里，把页面权限翻译成对应的员工 scope；成员正常对话时
 * 不会拿到这些额外 scope。真实角色原有的 allow/deny 仍然生效，这里只做加法。
 */
export function consoleScopesForPage(
  page: ConsolePageKey,
  writeActions: boolean | ConsolePageWriteActions,
): readonly Scope[] {
  const actions = normalizeWriteActions(writeActions)
  const canCreate = actions.create
  const canEdit = actions.edit
  const canDelete = actions.delete
  const canWrite = canCreate || canEdit || canDelete
  const view: Scope[] = []
  const writeScopes: Scope[] = []
  switch (page) {
    case 'overview':
      break
    case 'org':
      view.push(SC.ORG_MEMBER_READ, SC.ORG_DEPT_READ, SC.AUTHZ_ROLE_READ)
      // 共享组织接口只有“管理”这一个粗 scope；只在新增/编辑时授予，
      // 避免“只给删除”顺带拿到共享接口的新增和修改能力。控制台自身的删除走 /api/console/*。
      if (canCreate || canEdit) writeScopes.push(SC.ORG_MEMBER_MANAGE)
      if (canCreate || canEdit) writeScopes.push(SC.AUTHZ_GRANT)
      break
    case 'departments':
      view.push(SC.ORG_DEPT_READ)
      if (canCreate || canEdit) writeScopes.push(SC.ORG_DEPT_MANAGE)
      break
    case 'roles':
      view.push(SC.AUTHZ_ROLE_READ)
      if (canCreate || canEdit) writeScopes.push(SC.AUTHZ_ROLE_MANAGE)
      if (canCreate || canEdit) writeScopes.push(SC.AUTHZ_GRANT)
      break
    case 'approvalPolicies':
      view.push(SC.APPROVAL_READ)
      if (canCreate || canEdit) writeScopes.push(SC.APPROVAL_DECIDE)
      break
    case 'access':
      view.push(SC.ORG_MEMBER_READ, SC.ORG_DEPT_READ, SC.AUTHZ_ROLE_READ, SC.KB_READ)
      break
    case 'kb':
      view.push(SC.KB_READ)
      if (canCreate || canEdit) writeScopes.push(SC.KB_ADMIN)
      if (canDelete) writeScopes.push(SC.KB_DELETE)
      break
    case 'models':
      view.push(SC.MODEL_READ)
      if (canCreate || canEdit) writeScopes.push(SC.MODEL_MANAGE)
      break
    case 'tools':
      view.push(SC.AGENT_TOOL_LIST)
      if (canEdit) writeScopes.push(SC.AGENT_TOOL_REGISTER, SC.AUTHZ_GRANT)
      break
    case 'channels':
      // 渠道页自身走 `/api/console/channels`；这里不再用 CHANNEL_MANAGE 兜底，
      // 否则“只可见”的成员会同时拿到共享渠道接口的管理能力。
      if (canCreate || canEdit) writeScopes.push(SC.CHANNEL_BIND)
      break
    case 'databases':
    case 'documents':
    case 'company':
    case 'usage':
    case 'quota':
      break
    case 'audit':
      view.push(SC.AUDIT_READ)
      // 审计页没有写操作；“编辑”在这页表示允许导出，沿用原有 AUDIT_EXPORT 能力。
      if (canEdit) writeScopes.push(SC.AUDIT_EXPORT)
      break
    case 'tasks':
      view.push(SC.SCHEDULE_READ)
      if (canCreate || canEdit) writeScopes.push(SC.SCHEDULE_WRITE)
      break
    case 'approvals':
      view.push(SC.APPROVAL_READ)
      if (canEdit) writeScopes.push(SC.APPROVAL_DECIDE)
      break
    case 'system':
      view.push(SC.SERVICE_STATUS)
      if (canEdit) writeScopes.push(SC.SERVICE_CONTROL, SC.SYSTEM_BACKUP, SC.SYSTEM_RESTORE)
      break
    case 'extra':
      view.push(SC.PLUGIN_LIST)
      if (canCreate) writeScopes.push(SC.PLUGIN_INSTALL)
      if (canEdit) writeScopes.push(SC.PLUGIN_CONFIGURE, SC.PLUGIN_APPROVE)
      if (canDelete) writeScopes.push(SC.PLUGIN_UNINSTALL)
      break
    case 'skills':
      view.push(SC.SKILL_LIST)
      if (canCreate) writeScopes.push(SC.SKILL_INSTALL)
      if (canEdit) writeScopes.push(SC.SKILL_CONFIGURE, SC.SKILL_APPROVE)
      if (canDelete) writeScopes.push(SC.SKILL_UNINSTALL)
      break
  }
  return canWrite ? [...view, ...writeScopes] : view
}
