import type { FastifyInstance } from 'fastify'
import { SC } from '@eab/domain'
import type { ServerDeps } from '../deps.js'
import { ok, requireScope } from '../http.js'
import { resolveActor } from '../session.js'

interface DeptRow {
  id: string
  name: string
  parent_id: string | null
  path: string
  depth: number
  order_no: number
  manager_user_id: string | null
  manager_name: string | null
  member_count: number
}

interface DeptNode {
  id: string
  name: string
  path: string
  depth: number
  orderNo: number
  /** 部门负责人（控制台部门编辑弹窗要回显） */
  managerUserId: string | null
  managerName: string | null
  /** 直属人数 */
  memberCount: number
  /** 含下级部门的人（点「N 人」筛出来的就是这个数） */
  subtreeMemberCount?: number
  children: DeptNode[]
}

interface MemberRow {
  id: string
  name: string
  title: string | null
  dept_id: string
  dept_path: string
  dept_name: string
  status: string
  employee_no: string | null
  email: string | null
  mobile: string | null
  external_user_id: string | null
}

interface MemberRoleRow {
  user_id: string
  code: string
  name: string
}

export function registerOrgRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/org/tree', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.ORG_DEPT_READ)

    const rows = deps.db
      .prepare(
        `SELECT d.id, d.name, d.parent_id, d.path, d.depth, d.order_no, d.manager_user_id,
                (SELECT name FROM users mu WHERE mu.id = d.manager_user_id) AS manager_name,
                (SELECT COUNT(*) FROM users u WHERE u.dept_id = d.id AND u.deleted_at IS NULL) AS member_count
           FROM departments d
          WHERE d.company_id = ? AND d.deleted_at IS NULL
          ORDER BY d.path`,
      )
      .all(subject.companyId) as unknown as DeptRow[]

    const nodes = new Map<string, DeptNode>()
    for (const row of rows) {
      nodes.set(row.id, {
        id: row.id,
        name: row.name,
        path: row.path,
        depth: row.depth,
        orderNo: Number(row.order_no ?? 0),
        managerUserId: row.manager_user_id,
        managerName: row.manager_name,
        memberCount: Number(row.member_count),
        children: [],
      })
    }

    let root: DeptNode | undefined
    for (const row of rows) {
      const node = nodes.get(row.id)
      if (!node) continue
      if (row.parent_id === null) {
        root = node
        continue
      }
      nodes.get(row.parent_id)?.children.push(node)
    }

    /**
     * 子树叶数。
     * 组织树上的「N 人」必须和"点进去看到的成员数"一致：点进去是按成员 `dept_path` 前缀筛的（含下级），
     * 所以这里也用同一条口径去数成员，而不是把各部门的直属人数相加 —— 一旦有成员的部门已被回收
     * （例如上游把人删了、部门只剩成员身上的历史路径），相加就会比点进去出来的行数少。
     * 直属人数留在 memberCount 里，给 tooltip 用。
     */
    const memberPaths = deps.db
      .prepare(`SELECT dept_path FROM users WHERE company_id = ? AND deleted_at IS NULL`)
      .all(subject.companyId) as unknown as { dept_path: string }[]

    const fillSubtree = (node: DeptNode): number => {
      const prefix = node.path.endsWith('/') ? node.path : `${node.path}/`
      node.subtreeMemberCount = memberPaths.filter((row) => (row.dept_path || '').startsWith(prefix)).length
      for (const child of node.children) fillSubtree(child)
      return node.subtreeMemberCount
    }
    if (root) fillSubtree(root)

    return ok({ root: root ?? null, total: rows.length })
  })

  app.get('/api/org/members', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.ORG_MEMBER_READ)

    const members = deps.db
      .prepare(
        `SELECT u.id, u.name, u.title, u.dept_id, u.dept_path, d.name AS dept_name, u.status,
                u.employee_no, u.email, u.mobile,
                (SELECT ui.external_user_id
                   FROM user_identities ui
                  WHERE ui.user_id = u.id AND ui.provider = 'dingtalk'
                  ORDER BY ui.id
                  LIMIT 1) AS external_user_id
           FROM users u
           JOIN departments d ON d.id = u.dept_id
          WHERE u.company_id = ? AND u.deleted_at IS NULL
          ORDER BY d.path, u.name`,
      )
      .all(subject.companyId) as unknown as MemberRow[]

    const roleRows = deps.db
      .prepare(
        `SELECT ur.user_id AS user_id, r.code AS code, r.name AS name
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
          ORDER BY r.code`,
      )
      .all() as unknown as MemberRoleRow[]

    const rolesByUser = new Map<string, Array<{ code: string; name: string }>>()
    for (const row of roleRows) {
      const list = rolesByUser.get(row.user_id) ?? []
      list.push({ code: row.code, name: row.name })
      rolesByUser.set(row.user_id, list)
    }

    return ok({
      members: members.map((member) => ({
        id: member.id,
        name: member.name,
        title: member.title,
        deptId: member.dept_id,
        deptPath: member.dept_path,
        deptName: member.dept_name,
        status: member.status,
        employeeNo: member.employee_no,
        email: member.email,
        mobile: member.mobile,
        /** 钉钉 UserID：企业机器人回调靠它认人，页面上也要能看见 */
        externalUserId: member.external_user_id,
        roles: rolesByUser.get(member.id) ?? [],
      })),
    })
  })
}
