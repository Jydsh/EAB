/**
 * 成员后台接口守卫的路径映射。
 *
 * 原则：
 * - 平台超管 / 服务令牌不受页面权限限制；
 * - 成员后台会话必须命中一条规则；规则只声明页面或系统二级页，守卫按「可见」放行该页全部功能；
 * - 规则里的 actions 仅保留接口语义，用于错误提示和旧数据兼容，不参与是否放行的判断；
 * - 没有映射的 `/api/console/*` 默认拒绝，避免新增接口忘了加守卫；
 * - 平台专属接口即使成员有对应页面可见权限也拒绝，仅限改超管密码、公司开通、钉钉开通等平台全局操作。
 */
import type { ConsolePageKey } from './console-pages.js'

export type ConsoleApiAction = 'view' | 'create' | 'edit' | 'delete'

export interface ConsoleApiRule {
  readonly pages: readonly ConsolePageKey[]
  /** 页内分区的精确权限键；未填表示整页。 */
  readonly section?: string
  /** 读接口可被多个分区共用时，命中任一分区即可。 */
  readonly sections?: readonly string[]
  /** 同一接口覆盖多个页面时，按页面指定分区；未列出的页面按整页判断。 */
  readonly sectionPages?: Partial<Record<ConsolePageKey, readonly string[]>>
  readonly actions: readonly ConsoleApiAction[]
  readonly platformOnly?: boolean
}

const P = (...pages: ConsolePageKey[]): ConsolePageKey[] => pages

const PLATFORM_ONLY: readonly RegExp[] = [
  /^\/api\/console\/password$/,
  /^\/api\/console\/companies\/check-admin-account$/,
  /^\/api\/console\/companies\/onboard-dingtalk$/,
  /^\/api\/console\/dingtalk\/onboard(?:\/|$)/,
]

/** 无需页面权限的引导接口：登录、退出、看自己是谁、看权限、公司列表。 */
const BOOTSTRAP: readonly RegExp[] = [
  /^\/api\/console\/login$/,
  /^\/api\/console\/member\/login$/,
  /^\/api\/console\/logout$/,
  /^\/api\/console\/session$/,
  /^\/api\/console\/account$/,
  /^\/api\/console\/access$/,
]

/** 只是探测/查询/导出，不改业务数据的 POST。 */
const READ_ONLY_POST =
  /\/query$|\/test$|\/verify$|\/check$|\/export$|\/preview$|\/refresh$|\/stress-test$/
/** 明确是删除/解绑/卸载/取消的 POST。 */
const DELETE_POST = /\/uninstall$|\/unbind$|\/cancel$|\/revoke$|\/remove$|\/delete$|\/clear$/
/** 对已有对象做状态或配置修改的 POST。 */
const EDIT_POST =
  /\/roles$|\/bulk-roles$|\/password$|\/state$|\/pause$|\/resume$|\/decide$|\/decision$|\/policy$|\/sync$|\/retry$|\/reindex$|\/bind$|\/mock-scan$|\/review$|\/requestable$|\/reveal$|\/run$|\/apply$|\/start$/

function actionFor(method: string, path: string): readonly ConsoleApiAction[] {
  const upper = method.toUpperCase()
  if (upper === 'GET' || upper === 'HEAD') {
    // 审计导出是读接口，但泄露面大，沿用“导出”动作，不跟普通查看共用。
    if (/^\/api\/console\/audit\/export$/.test(path)) return ['edit']
    return ['view']
  }
  if (upper === 'DELETE') {
    // 吊销某个成员的登录会话是安全操作，归到“编辑”，不占用“删除成员”的权限。
    if (/^\/api\/console\/members\/[^/]+\/sessions$/.test(path)) return ['edit']
    return ['delete']
  }
  if (upper === 'PUT' || upper === 'PATCH') return ['edit']
  if (upper === 'POST') {
    if (READ_ONLY_POST.test(path)) return ['view']
    // 取消后台 Agent 运行属于运维动作，不删除任何记录，归到“编辑”。
    if (/^\/api\/console\/agent-runs\/[^/]+\/cancel$/.test(path)) return ['edit']
    // 启动动画片源上传属于配置动作，不单列为“新增”。
    if (/^\/api\/console\/boot\/assets$/.test(path)) return ['edit']
    // 渠道绑定/开通是在建立新绑定，归到“新增”，不能算成编辑。
    if (/^\/api\/console\/channels\/[^/]+\/bind$/.test(path)) return ['create']
    if (/^\/api\/console\/channels\/[^/]+\/onboard(?:\/|$)/.test(path)) return ['create']
    if (DELETE_POST.test(path)) return ['delete']
    if (EDIT_POST.test(path)) return ['edit']
    // 渠道配置保存：POST /api/console/channels/:provider。
    if (/^\/api\/console\/channels\/[^/]+$/.test(path)) return ['edit']
    // 审批策略保存是 upsert，新增和编辑都算命中。
    if (/^\/api\/console\/permission-policies$/.test(path)) return ['create', 'edit']
    return ['create']
  }
  return ['view']
}

/**
 * 返回 null 表示该请求不需要成员页面权限（引导接口）。
 * 返回 rule 表示需要；platformOnly 的 rule 只给平台超管。
 */
export function consoleApiRuleFor(method: string, path: string): ConsoleApiRule | null {
  if (BOOTSTRAP.some((pattern) => pattern.test(path))) return null
  const actions = actionFor(method, path)

  // 平台专属：先于普通页面规则判断，成员即使有页面写权限也不能调。
  if (PLATFORM_ONLY.some((pattern) => pattern.test(path))) {
    return { pages: [], actions, platformOnly: true }
  }

  // 建公司 / 删公司 / 公司开通：GET 公司列表是引导，其余平台专属。
  if (/^\/api\/console\/companies(?:\/|$)/.test(path)) {
    if (method.toUpperCase() === 'GET' && /^\/api\/console\/companies$/.test(path)) return null
    return { pages: [], actions, platformOnly: true }
  }

  // 版本更新：只授权「系统更新」二级页可见；可见即可查看、检查并执行一键更新。
  if (/^\/api\/console\/update\/check$/.test(path)) {
    return { pages: P('system'), section: 'update', actions: ['view'] }
  }
  if (/^\/api\/console\/update\/apply$/.test(path)) {
    return { pages: P('system'), section: 'update', actions: ['view'] }
  }
  if (/^\/api\/console\/update/.test(path)) {
    if (method.toUpperCase() === 'GET') return { pages: P('system'), section: 'update', actions }
    return { pages: [], actions, platformOnly: true }
  }

  if (/^\/api\/console\/overview$/.test(path)) return { pages: P('overview'), actions }
  // 成员权限配置属于「成员管理」页；页面可见即可读取和保存。
  if (/^\/api\/console\/member-console-permissions(?:\/|$)/.test(path)) {
    return { pages: P('org'), actions: ['view'] }
  }
  // 成员资料、角色分配都属于「成员管理」页；页面可见即可使用。
  if (/^\/api\/console\/members\/(?:bulk-roles|[^/]+\/roles)$/.test(path)) {
    return { pages: P('org', 'roles'), actions: ['edit'] }
  }
  if (/^\/api\/console\/members(?:\/|$)/.test(path)) {
    if (method.toUpperCase() === 'GET') return { pages: P('org'), actions: ['view'] }
    if (method.toUpperCase() === 'POST' && path === '/api/console/members') {
      return { pages: P('org'), actions: ['create'] }
    }
    if (method.toUpperCase() === 'DELETE' && /^\/api\/console\/members\/[^/]+$/.test(path)) {
      return { pages: P('org'), actions: ['delete'] }
    }
    return { pages: P('org'), actions: ['edit'] }
  }
  if (/^\/api\/console\/departments(?:\/|$)/.test(path)) return { pages: P('departments'), actions }

  if (/^\/api\/console\/roles(?:\/|$)/.test(path)) {
    // 成员管理页也要读角色列表；写角色只认「角色管理」的对应动作。
    if (actions.length === 1 && actions[0] === 'view') return { pages: P('org', 'roles'), actions }
    return { pages: P('roles'), actions }
  }
  // 角色详情的「可用工具」需要读同一份工具目录；只有角色管理权限、
  // 没有工具页权限的成员也应能加载，否则页签会因目录 403 而整块不可用。
  if (/^\/api\/console\/tools\/access$/.test(path) && actions.length === 1 && actions[0] === 'view') {
    return { pages: P('tools', 'roles'), actions }
  }
  if (/^\/api\/console\/scopes(?:\/|$)/.test(path)) {
    return { pages: P('org', 'roles', 'tools'), actions }
  }
  if (/^\/api\/console\/(?:permission-policies|permission-requests)(?:\/|$)/.test(path)) {
    return { pages: P('approvalPolicies'), actions }
  }
  if (/^\/api\/console\/tools(?:\/|$)/.test(path)) return { pages: P('tools'), actions }
  if (/^\/api\/console\/workspace-quotas(?:\/|$)/.test(path)) {
    return { pages: P('quota', 'roles', 'org'), actions }
  }

  if (/^\/api\/console\/kb(?:\/|$)/.test(path)) return { pages: P('kb'), actions }

  // 模型接入是整页权限；页面可见即可使用供应商、模型目录和用途路由。
  if (/^\/api\/console\/(?:providers|models|model-routes)(?:\/|$)/.test(path)) {
    return { pages: P('models'), actions }
  }
  if (/^\/api\/console\/(?:model-kinds|model-stress-tests|plugin-channels)(?:\/|$)/.test(path)) {
    return { pages: P('models'), actions }
  }

  // 渠道页是整页权限；页面可见即可绑企业、配渠道、同步通讯录和管理外部身份。
  if (/^\/api\/console\/(?:channel-identities|channels)(?:\/|$)/.test(path)) {
    return { pages: P('channels'), actions }
  }

  if (/^\/api\/console\/databases(?:\/|$)/.test(path)) return { pages: P('databases'), actions }
  if (/^\/api\/console\/onlyoffice(?:\/|$)/.test(path)) return { pages: P('documents'), actions }

  if (/^\/api\/console\/company\/boot(?:\/|$)/.test(path)) {
    return { pages: P('system'), section: 'boot', actions }
  }
  if (/^\/api\/console\/company(?:\/|$)/.test(path)) return { pages: P('company'), actions }

  // 系统页七个二级页；每页只配「可见」。备份、目录、设置属于「系统与运维」。
  if (/^\/api\/console\/(?:backups|backup-jobs|runtime-backups?)(?:\/|$)/.test(path)) {
    return { pages: P('system'), section: 'data', actions }
  }
  // 搜索与浏览器连接已经迁到「数据连接」页，读写都随该页可见权限；
  // 其它系统设置仍留在「系统 → 系统与运维」。
  if (/^\/api\/console\/settings\/web-services(?:\/|$)/.test(path)) {
    return { pages: P('databases'), actions }
  }
  if (/^\/api\/console\/settings\/(?:web-search|browser-network)(?:\/|$)/.test(path)) {
    return { pages: P('databases'), actions }
  }
  if (/^\/api\/console\/(?:settings|system|backends)(?:\/|$)/.test(path)) {
    return { pages: P('system'), section: 'data', actions }
  }
  if (/^\/api\/console\/concurrency(?:\/|$)/.test(path)) {
    return { pages: P('system'), section: 'concurrency', actions }
  }
  if (/^\/api\/console\/tool-metrics(?:\/|$)/.test(path)) {
    return { pages: P('system'), section: 'concurrency', actions }
  }
  if (/^\/api\/console\/agent-runs(?:\/|$)/.test(path)) {
    return { pages: P('system'), section: 'agents', actions }
  }
  // MCP Server 与 A2A Peer / 入站端点都放在「Agent 管理」页，按该二级页可见放行。
  if (/^\/api\/console\/(?:mcp|a2a)(?:\/|$)/.test(path)) {
    return { pages: P('system'), section: 'agents', actions }
  }
  if (/^\/api\/console\/jobs(?:\/|$)/.test(path)) {
    // 概览/模型页会读后台任务进度；任务中心是主要归属，系统页的后台作业分区也要能读。
    return {
      pages: P('tasks', 'models', 'overview', 'system'),
      sectionPages: { system: ['jobs'] },
      actions,
    }
  }
  if (/^\/api\/console\/boot(?:\/|$)/.test(path)) {
    return { pages: P('system'), section: 'boot', actions }
  }

  if (/^\/api\/console\/plugins(?:\/|$)/.test(path)) return { pages: P('extra'), actions }
  if (/^\/api\/console\/skills(?:\/|$)/.test(path)) return { pages: P('skills'), actions }
  if (/^\/api\/console\/usage(?:\/|$)/.test(path)) return { pages: P('usage'), actions }
  if (/^\/api\/console\/quotas(?:\/|$)/.test(path)) return { pages: P('quota'), actions }
  if (/^\/api\/console\/audit(?:\/|$)/.test(path)) return { pages: P('audit'), actions }

  if (/^\/api\/console\/schedules(?:\/|$)/.test(path)) return { pages: P('tasks'), actions }
  if (/^\/api\/console\/(?:task-graphs|task-graph-runs)(?:\/|$)/.test(path)) {
    return { pages: P('tasks'), actions }
  }
  if (/^\/api\/console\/approval-workflows(?:\/|$)/.test(path)) return { pages: P('approvalPolicies'), actions }
  if (/^\/api\/console\/approvals(?:\/|$)/.test(path)) return { pages: P('approvals'), actions }

  // 未映射的 console 接口默认拒绝。
  return { pages: [], actions }
}

export function ruleAllowsPage(
  rule: ConsoleApiRule,
  allowed: (page: ConsolePageKey, action: ConsoleApiAction, section?: string) => boolean,
): boolean {
  return rule.pages.some((page) => {
    const sections = rule.sectionPages?.[page]
      ?? rule.sections
      ?? (rule.section ? [rule.section] : [undefined])
    return rule.actions.some((action) => sections.some((section) => allowed(page, action, section)))
  })
}

export function consoleApiActionLabel(action: ConsoleApiAction): string {
  switch (action) {
    case 'view':
      return '可见'
    case 'create':
      return '新增'
    case 'edit':
      return '编辑'
    case 'delete':
      return '删除'
  }
}
