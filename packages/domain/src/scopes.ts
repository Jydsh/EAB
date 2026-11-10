/**
 * Scope 目录（功能权限的唯一事实来源）。
 *
 * 规则：
 * 1. 所有 scope 必须在这里登记，registry 是穷尽的 Record<Scope, ...>，
 *    少登记一个编译就失败——这是"新增 scope 必须登记"的代码级保证。
 * 2. 业务代码禁止写 scope 字符串字面量，一律引用 SC.*（CI 可加正则拦截）。
 * 3. `implies` 表示"持有该 scope 即隐含具备被列出的 scope"。
 */

export const SC = {
  // 对话
  CHAT_USE: 'chat:use',
  CHAT_HISTORY_READ: 'chat:history:read',
  CHAT_HISTORY_DELETE: 'chat:history:delete',
  CHAT_EXPORT: 'chat:export',

  // 工具
  AGENT_TOOL_LIST: 'agent:tool:list',
  AGENT_TOOL_INVOKE: 'agent:tool:invoke',
  AGENT_TOOL_REGISTER: 'agent:tool:register',

  // 插件
  PLUGIN_LIST: 'plugin:list',
  PLUGIN_INSTALL: 'plugin:install',
  PLUGIN_UNINSTALL: 'plugin:uninstall',
  PLUGIN_CONFIGURE: 'plugin:configure',
  PLUGIN_APPROVE: 'plugin:approve',

  // 知识库
  KB_READ: 'kb:read',
  KB_WRITE: 'kb:write',
  KB_ADMIN: 'kb:admin',
  KB_DELETE: 'kb:delete',

  // 工作区
  WORKSPACE_READ: 'workspace:read',
  WORKSPACE_WRITE: 'workspace:write',
  WORKSPACE_SHARE: 'workspace:share',

  // 本地空间（用户本机目录，独立于服务端工作区）
  LOCAL_SPACE_READ: 'local-space:read',
  LOCAL_SPACE_WRITE: 'local-space:write',

  // 组织
  ORG_MEMBER_READ: 'org:member:read',
  ORG_MEMBER_MANAGE: 'org:member:manage',
  ORG_DEPT_READ: 'org:dept:read',
  ORG_DEPT_MANAGE: 'org:dept:manage',
  ORG_SYNC_RUN: 'org:sync:run',

  // 角色与授权
  AUTHZ_ROLE_READ: 'authz:role:read',
  AUTHZ_ROLE_MANAGE: 'authz:role:manage',
  AUTHZ_GRANT: 'authz:grant',

  // 渠道
  CHANNEL_MANAGE: 'channel:manage',
  CHANNEL_BIND: 'channel:bind',
  CHANNEL_SEND: 'channel:send',

  // 定时任务
  SCHEDULE_READ: 'schedule:read',
  SCHEDULE_WRITE: 'schedule:write',

  // 模型
  MODEL_READ: 'model:read',
  MODEL_MANAGE: 'model:manage',
  MODEL_USE: 'model:use',

  // 审批
  APPROVAL_READ: 'approval:read',
  APPROVAL_DECIDE: 'approval:decide',

  // 审计
  AUDIT_READ: 'audit:read',
  AUDIT_EXPORT: 'audit:export',

  // 运维
  SERVICE_STATUS: 'service:status',
  SERVICE_CONTROL: 'service:control',
  SYSTEM_BACKUP: 'system:backup',
  SYSTEM_RESTORE: 'system:restore',

  // 记忆
  MEMORY_READ: 'memory:read',
  MEMORY_WRITE: 'memory:write',
  MEMORY_ADMIN: 'memory:admin',

  // 访客
  PORTAL_USE: 'portal:use',
  PORTAL_ADMIN: 'portal:admin',
} as const

export type Scope = (typeof SC)[keyof typeof SC]

export interface ScopeMeta {
  /** 分组，用于控制台按组渲染 */
  readonly group: string
  readonly label: string
  /** 持有本 scope 即隐含具备的 scope */
  readonly implies?: readonly Scope[]
  /** 高危：变更时需要二次确认 + 强制审计 */
  readonly dangerous?: boolean
}

export const SCOPE_REGISTRY: Record<Scope, ScopeMeta> = {
  [SC.CHAT_USE]: { group: '对话', label: '发起对话' },
  [SC.CHAT_HISTORY_READ]: { group: '对话', label: '查看会话历史' },
  [SC.CHAT_HISTORY_DELETE]: { group: '对话', label: '删除会话', dangerous: true },
  [SC.CHAT_EXPORT]: { group: '对话', label: '导出会话', dangerous: true },

  [SC.AGENT_TOOL_LIST]: { group: '工具', label: '查看工具清单' },
  [SC.AGENT_TOOL_INVOKE]: { group: '工具', label: '调用工具' },
  [SC.AGENT_TOOL_REGISTER]: { group: '工具', label: '注册工具（插件用）', dangerous: true },

  [SC.PLUGIN_LIST]: { group: '插件', label: '查看插件' },
  [SC.PLUGIN_INSTALL]: { group: '插件', label: '安装插件', dangerous: true },
  [SC.PLUGIN_UNINSTALL]: { group: '插件', label: '卸载插件', dangerous: true },
  [SC.PLUGIN_CONFIGURE]: { group: '插件', label: '配置插件' },
  [SC.PLUGIN_APPROVE]: { group: '插件', label: '审批插件', implies: [SC.PLUGIN_LIST], dangerous: true },

  [SC.KB_READ]: { group: '知识库', label: '检索知识库' },
  [SC.KB_WRITE]: { group: '知识库', label: '入库文档', implies: [SC.KB_READ] },
  [SC.KB_ADMIN]: { group: '知识库', label: '管理知识库', implies: [SC.KB_WRITE, SC.KB_READ] },
  [SC.KB_DELETE]: { group: '知识库', label: '删除文档', dangerous: true },

  [SC.WORKSPACE_READ]: { group: '工作区', label: '读取文件' },
  [SC.WORKSPACE_WRITE]: { group: '工作区', label: '写入文件', implies: [SC.WORKSPACE_READ] },
  [SC.WORKSPACE_SHARE]: { group: '工作区', label: '共享文件', dangerous: true },

  [SC.LOCAL_SPACE_READ]: { group: '本地空间', label: '读取本地目录' },
  [SC.LOCAL_SPACE_WRITE]: {
    group: '本地空间',
    label: '写入本地目录',
    implies: [SC.LOCAL_SPACE_READ],
    dangerous: true,
  },

  [SC.ORG_MEMBER_READ]: { group: '组织', label: '查看成员' },
  [SC.ORG_MEMBER_MANAGE]: { group: '组织', label: '管理成员', implies: [SC.ORG_MEMBER_READ], dangerous: true },
  [SC.ORG_DEPT_READ]: { group: '组织', label: '查看部门' },
  [SC.ORG_DEPT_MANAGE]: { group: '组织', label: '管理部门', implies: [SC.ORG_DEPT_READ], dangerous: true },
  [SC.ORG_SYNC_RUN]: { group: '组织', label: '触发组织同步' },

  [SC.AUTHZ_ROLE_READ]: { group: '权限', label: '查看角色' },
  [SC.AUTHZ_ROLE_MANAGE]: { group: '权限', label: '修改角色', implies: [SC.AUTHZ_ROLE_READ], dangerous: true },
  [SC.AUTHZ_GRANT]: { group: '权限', label: '分配权限', implies: [SC.AUTHZ_ROLE_READ], dangerous: true },

  [SC.CHANNEL_MANAGE]: { group: '渠道', label: '管理渠道', dangerous: true },
  [SC.CHANNEL_BIND]: { group: '渠道', label: '绑定渠道身份' },
  [SC.CHANNEL_SEND]: { group: '渠道', label: '主动发消息' },

  [SC.SCHEDULE_READ]: { group: '定时任务', label: '查看定时任务' },
  [SC.SCHEDULE_WRITE]: {
    group: '定时任务',
    label: '创建/取消定时任务',
    implies: [SC.SCHEDULE_READ],
    dangerous: true,
  },

  [SC.MODEL_READ]: { group: '模型', label: '查看模型配置' },
  [SC.MODEL_MANAGE]: { group: '模型', label: '修改模型配置', implies: [SC.MODEL_READ], dangerous: true },
  [SC.MODEL_USE]: { group: '模型', label: '使用模型' },

  [SC.APPROVAL_READ]: { group: '审批', label: '查看审批' },
  [SC.APPROVAL_DECIDE]: { group: '审批', label: '审批决定', implies: [SC.APPROVAL_READ], dangerous: true },

  [SC.AUDIT_READ]: { group: '审计', label: '查询审计' },
  [SC.AUDIT_EXPORT]: { group: '审计', label: '导出审计', implies: [SC.AUDIT_READ], dangerous: true },

  [SC.SERVICE_STATUS]: { group: '运维', label: '查看服务状态' },
  [SC.SERVICE_CONTROL]: { group: '运维', label: '控制服务', dangerous: true },
  [SC.SYSTEM_BACKUP]: { group: '运维', label: '执行备份' },
  [SC.SYSTEM_RESTORE]: { group: '运维', label: '执行恢复', dangerous: true },

  [SC.MEMORY_READ]: { group: '记忆', label: '读取记忆' },
  [SC.MEMORY_WRITE]: { group: '记忆', label: '写入记忆', implies: [SC.MEMORY_READ] },
  [SC.MEMORY_ADMIN]: { group: '记忆', label: '管理记忆', implies: [SC.MEMORY_READ], dangerous: true },

  [SC.PORTAL_USE]: { group: '访客', label: '使用访客门户' },
  [SC.PORTAL_ADMIN]: { group: '访客', label: '管理访客门户', implies: [SC.PORTAL_USE], dangerous: true },
}

export const ALL_SCOPES: readonly Scope[] = Object.values(SC)

/**
 * 传递闭包：把"被授予的 scope 集合"展开成"实际可用的能力集合"。
 * 例：授予 kb:admin → 同时可用 kb:write / kb:read（含多层隐含）。
 * 用 BFS 而不是一层展开，避免 implies 链变长后漏权限。
 */
export function expandScopes(granted: Iterable<Scope>): Set<Scope> {
  const out = new Set<Scope>()
  const queue: Scope[] = []
  for (const scope of granted) {
    if (!out.has(scope)) {
      out.add(scope)
      queue.push(scope)
    }
  }
  while (queue.length > 0) {
    const current = queue.pop() as Scope
    for (const implied of SCOPE_REGISTRY[current]?.implies ?? []) {
      if (!out.has(implied)) {
        out.add(implied)
        queue.push(implied)
      }
    }
  }
  return out
}

/** 反查表：action -> 能授予它的 scope 列表（含自身，含传递隐含） */
const IMPLIED_BY: ReadonlyMap<Scope, ReadonlySet<Scope>> = (() => {
  const map = new Map<Scope, Set<Scope>>()
  for (const scope of ALL_SCOPES) {
    const granters = new Set<Scope>()
    for (const candidate of ALL_SCOPES) {
      if (candidate === scope) {
        granters.add(scope)
        continue
      }
      if (expandScopes([candidate]).has(scope)) granters.add(candidate)
    }
    map.set(scope, granters)
  }
  return map
})()

/** 判断 subject 持有的 scope 集合是否足以执行某个 action（考虑隐含关系） */
export function scopeAllows(
  heldScopes: ReadonlySet<Scope>,
  action: Scope,
): boolean {
  if (heldScopes.has(action)) return true
  const granters = IMPLIED_BY.get(action)
  if (!granters) return false
  for (const granter of granters) {
    if (heldScopes.has(granter)) return true
  }
  return false
}

/** 是否是已登记的合法 scope（用于插件清单校验、API 入参校验） */
export function isKnownScope(value: string): value is Scope {
  return Object.prototype.hasOwnProperty.call(SCOPE_REGISTRY, value)
}
