/**
 * 成员后台接口守卫的路径映射。
 *
 * 原则：
 * - 平台超管 / 服务令牌不受页面权限限制；
 * - 成员后台会话必须命中一条规则，读接口要求 view，新增/编辑/删除分别要求对应动作；
 * - 一个接口同时具备两种语义（例如额度 PUT 是新增或编辑）时，命中任一动作即放行；
 * - 没有映射的 `/api/console/*` 默认拒绝，避免新增接口忘了加守卫；
 * - 平台专属接口即使成员有对应页面写权限也拒绝（改超管密码、建公司、备份、更新等）。
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
  /^\/api\/console\/backups(?:\/|$)/,
  /^\/api\/console\/backup-jobs(?:\/|$)/,
  /^\/api\/console\/runtime-backups?(?:\/|$)/,
  /^\/api\/console\/update\/(?:check|apply)$/,
  /^\/api\/console\/settings\/(?:network|storage|data-dir)(?:\/|$)/,
  /^\/api\/console\/system\/pick-directory(?:\/|$)/,
  /^\/api\/console\/boot\/assets(?:\/|$)/,
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

  // 版本更新：查版本所有后台成员可读，执行更新平台专属。
  if (/^\/api\/console\/update/.test(path)) {
    if (method.toUpperCase() === 'GET') return null
    return { pages: [], actions, platformOnly: true }
  }

  if (/^\/api\/console\/overview$/.test(path)) return { pages: P('overview'), actions }
  // 成员权限配置本身是「成员管理 → 后台访问」分区的独立能力，不再只限平台管理员。
  // 读接口也要求“配置后台访问”，避免只勾“可见”就能读取他人的完整权限。
  if (/^\/api\/console\/member-console-permissions(?:\/|$)/.test(path)) {
    return { pages: P('org'), section: 'memberAccess', actions: ['edit'] }
  }
  if (/^\/api\/console\/members(?:\/|$)/.test(path)) return { pages: P('org'), actions }
  if (/^\/api\/console\/departments(?:\/|$)/.test(path)) return { pages: P('departments'), actions }

  if (/^\/api\/console\/roles(?:\/|$)/.test(path)) {
    // 成员管理页也要读角色列表；写角色只认「角色管理」的对应动作。
    if (actions.length === 1 && actions[0] === 'view') return { pages: P('org', 'roles'), actions }
    return { pages: P('roles'), actions }
  }
  if (/^\/api\/console\/scopes(?:\/|$)/.test(path)) {
    return { pages: P('org', 'roles', 'tools'), actions }
  }
  if (/^\/api\/console\/permission-policies(?:\/|$)/.test(path)) {
    return { pages: P('approvalPolicies'), actions }
  }
  if (/^\/api\/console\/tools(?:\/|$)/.test(path)) return { pages: P('tools'), actions }
  if (/^\/api\/console\/workspace-quotas(?:\/|$)/.test(path)) {
    return { pages: P('quota', 'roles', 'org'), actions }
  }

  if (/^\/api\/console\/kb(?:\/|$)/.test(path)) return { pages: P('kb'), actions }

  // 模型页三个页内分区。读接口会被多个分区共用，写接口按分区精确判断。
  if (/^\/api\/console\/providers(?:\/|$)/.test(path)) {
    if (actions.length === 1 && actions[0] === 'view') {
      return { pages: P('models'), sections: ['providers', 'catalog', 'routes'], actions }
    }
    return { pages: P('models'), section: 'providers', actions }
  }
  if (/^\/api\/console\/models(?:\/|$)/.test(path)) {
    if (actions.length === 1 && actions[0] === 'view') {
      return { pages: P('models'), sections: ['providers', 'catalog', 'routes'], actions }
    }
    return { pages: P('models'), section: 'catalog', actions }
  }
  if (/^\/api\/console\/model-routes(?:\/|$)/.test(path)) {
    if (actions.length === 1 && actions[0] === 'view') {
      return { pages: P('models'), sections: ['providers', 'catalog', 'routes'], actions }
    }
    return { pages: P('models'), section: 'routes', actions }
  }
  if (/^\/api\/console\/(?:model-kinds|model-stress-tests|plugin-channels)(?:\/|$)/.test(path)) {
    if (actions.length === 1 && actions[0] === 'view') {
      return { pages: P('models'), sections: ['providers', 'catalog', 'routes'], actions }
    }
    return { pages: P('models'), section: 'providers', actions }
  }

  // 渠道页五个页内分区：企业绑定、渠道接入、通讯录同步、同步记录、外部身份。
  if (/^\/api\/console\/channel-identities(?:\/|$)/.test(path)) {
    return { pages: P('channels'), section: 'identities', actions }
  }
  if (/^\/api\/console\/channels\/[^/]+\/bind$/.test(path)) {
    return { pages: P('channels'), section: 'binding', actions }
  }
  if (/^\/api\/console\/channels\/[^/]+\/onboard(?:\/|$)/.test(path)) {
    return { pages: P('channels'), section: 'binding', actions }
  }
  if (/^\/api\/console\/channels\/[^/]+\/unbind$/.test(path)) {
    return { pages: P('channels'), section: 'binding', actions }
  }
  if (/^\/api\/console\/channels\/[^/]+\/sync$/.test(path)) {
    return { pages: P('channels'), section: 'sync', actions }
  }
  if (/^\/api\/console\/channels\/[^/]+\/org$/.test(path)) {
    return { pages: P('channels'), section: 'sync', actions }
  }
  if (/^\/api\/console\/channels\/[^/]+\/test$/.test(path)) {
    return { pages: P('channels'), section: 'config', actions }
  }
  if (/^\/api\/console\/channels\/[^/]+$/.test(path)) {
    return { pages: P('channels'), section: 'config', actions }
  }
  if (/^\/api\/console\/channels(?:\/|$)/.test(path)) {
    return { pages: P('channels'), actions }
  }

  if (/^\/api\/console\/databases(?:\/|$)/.test(path)) return { pages: P('databases'), actions }
  if (/^\/api\/console\/onlyoffice(?:\/|$)/.test(path)) return { pages: P('documents'), actions }

  if (/^\/api\/console\/company\/boot(?:\/|$)/.test(path)) {
    return { pages: P('system'), section: 'boot', actions }
  }
  if (/^\/api\/console\/company(?:\/|$)/.test(path)) return { pages: P('company'), actions }

  // 系统页六个页内分区。
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
