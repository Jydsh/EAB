import { describe, expect, it } from 'vitest'
import { decide } from '@eab/authz'
import { EC, SC } from '@eab/domain'
import {
  adminOnlyKb,
  companyKb,
  noAclKb,
  ownDeptKb,
  ownFile,
  peerFile,
  privateKb,
  ref,
  siblingDeptKb,
  subject,
} from './fixtures.js'

const member = subject()
const peer = subject({ userId: 'u2' })
const deptAdmin = subject({ roles: ['dept_admin'] })
const companyAdmin = subject({ roles: ['company_admin'], deptId: 'd1', deptPath: '/c1/' })
const superAdmin = subject({ roles: ['super_admin'] })
const auditor = subject({ roles: ['auditor'] })
const disabled = subject({ status: 'disabled' })

describe('PDP 基本判定', () => {
  it('普通员工可以发起对话（功能级，无资源上下文）', () => {
    const d = decide(member, SC.CHAT_USE)
    expect(d.result).toBe('allow')
    expect(d.result === 'allow' && d.matchedBy).toBe('role-inherited')
  })

  it('普通员工不能安装插件', () => {
    const d = decide(member, SC.PLUGIN_INSTALL)
    expect(d.result).toBe('deny')
    if (d.result === 'deny') {
      expect(d.code).toBe(EC.FORBIDDEN)
      expect(d.matchedBy).toBe('missing-scope')
    }
  })

  it('禁用账号一律拒绝（连功能级也不行）', () => {
    const d = decide(disabled, SC.CHAT_USE)
    expect(d.result).toBe('deny')
    if (d.result === 'deny') expect(d.code).toBe(EC.AUTH_REQUIRED)
  })
})

describe('数据范围（最难的部分）', () => {
  it('自己的文件可以读', () => {
    const d = decide(member, SC.WORKSPACE_READ, ownFile)
    expect(d.result).toBe('allow')
    expect(d.result === 'allow' && d.matchedBy).toBe('owner')
  })

  it('同事的文件不能读（N-01 的单元级版本）', () => {
    const d = decide(member, SC.WORKSPACE_READ, peerFile)
    expect(d.result).toBe('deny')
    if (d.result === 'deny') expect(d.code).toBe(EC.SCOPE_DENIED)
  })

  it('本部门知识库可见（可见范围配了本部门）', () => {
    const d = decide(member, SC.KB_READ, ownDeptKb)
    expect(d.result).toBe('allow')
    expect(d.result === 'allow' && d.matchedBy).toBe('kb-collection-acl')
  })

  it('他部门知识库不可见（N-01 核心场景）', () => {
    const d = decide(member, SC.KB_READ, siblingDeptKb)
    expect(d.result).toBe('deny')
    if (d.result === 'deny') expect(d.matchedBy).toBe('kb-collection-denied')
  })

  it('公司级知识库配"全员可见"后，普通员工可读', () => {
    const d = decide(member, SC.KB_READ, companyKb)
    expect(d.result).toBe('allow')
    expect(d.result === 'allow' && d.matchedBy).toBe('kb-collection-acl')
  })

  it('知识库配"仅某些角色"时，只有命中角色的人可读', () => {
    expect(decide(deptAdmin, SC.KB_READ, adminOnlyKb).result).toBe('allow')
    expect(decide(member, SC.KB_READ, adminOnlyKb).result).toBe('deny')
  })

  it('个人知识库只有本人可读', () => {
    expect(decide(member, SC.KB_READ, privateKb).result).toBe('allow')
    expect(decide(peer, SC.KB_READ, privateKb).result).toBe('deny')
  })

  it('未配置可见范围的知识资源：拒绝（不猜成"全员可见"）', () => {
    const d = decide(member, SC.KB_READ, noAclKb)
    expect(d.result).toBe('deny')
    if (d.result === 'deny') expect(d.matchedBy).toBe('kb-acl-missing')
  })

  it('部门管理员读兄弟部门知识库仍需授权（不再靠"上级部门"自动放行）', () => {
    const d = decide(deptAdmin, SC.KB_READ, siblingDeptKb)
    expect(d.result).toBe('deny')
  })

  it('部门管理员不可读兄弟部门知识', () => {
    const d = decide(deptAdmin, SC.KB_READ, siblingDeptKb)
    expect(d.result).toBe('deny')
  })

  it('机密资源仅知识库管理员可读', () => {
    const d = decide(member, SC.KB_READ, { ...ownDeptKb, classification: 'confidential' })
    expect(d.result).toBe('deny')
    if (d.result === 'deny') expect(d.matchedBy).toBe('classification')
  })

  it('跨公司一律拒绝，超管也不例外（MVP 单公司）', () => {
    const d = decide(superAdmin, SC.KB_READ, { ...ownDeptKb, companyId: 'c2' })
    expect(d.result).toBe('deny')
    if (d.result === 'deny') expect(d.matchedBy).toBe('company-mismatch')
  })

  it('审计员可看本公司审计，但不可写', () => {
    const auditRef = ref({ kind: 'audit', id: 'a1', scopeType: 'company', scopeId: 'c1', ownerId: undefined })
    expect(decide(auditor, SC.AUDIT_READ, auditRef).result).toBe('allow')
    expect(decide(auditor, SC.AUDIT_EXPORT, auditRef).result).toBe('require-approval')
    expect(decide(auditor, SC.AUTHZ_ROLE_MANAGE).result).toBe('deny')
  })
})

describe('审批策略', () => {
  it('安装插件需要公司管理员审批', () => {
    const pluginRef = ref({ kind: 'plugin', id: 'p1', scopeType: 'company', scopeId: 'c1', ownerId: undefined })
    const d = decide(companyAdmin, SC.PLUGIN_INSTALL, pluginRef)
    expect(d.result).toBe('require-approval')
    if (d.result === 'require-approval') expect(d.approverRole).toBe('company_admin')
  })

  it('高危工具调用需要部门管理员审批', () => {
    const risky = { ...ownFile, risk: 'high' as const }
    const d = decide(member, SC.AGENT_TOOL_INVOKE, risky)
    expect(d.result).toBe('require-approval')
    if (d.result === 'require-approval') expect(d.approverRole).toBe('dept_admin')
  })

  it('低危工具调用直接放行', () => {
    const safe = { ...ownFile, risk: 'low' as const }
    expect(decide(member, SC.AGENT_TOOL_INVOKE, safe).result).toBe('allow')
  })
})

describe('显式覆盖（重写规则优先级）', () => {
  it('显式拒绝压过角色授权', () => {
    const d = decide(member, SC.CHAT_USE, undefined, {
      overrides: [{ effect: 'deny', scope: SC.CHAT_USE }],
    })
    expect(d.result).toBe('deny')
    if (d.result === 'deny') expect(d.matchedBy).toBe('override-deny')
  })

  it('显式允许可授予角色没有的能力', () => {
    const d = decide(member, SC.PLUGIN_INSTALL, undefined, {
      overrides: [{ effect: 'allow', scope: SC.PLUGIN_INSTALL, userId: 'u1' }],
    })
    expect(d.result).toBe('allow')
    expect(d.result === 'allow' && d.matchedBy).toBe('override-allow')
  })

  it('覆盖规则按用户隔离', () => {
    const d = decide(member, SC.PLUGIN_INSTALL, undefined, {
      overrides: [{ effect: 'allow', scope: SC.PLUGIN_INSTALL, userId: 'u2' }],
    })
    expect(d.result).toBe('deny')
  })

  it('过期覆盖自动失效', () => {
    const d = decide(member, SC.PLUGIN_INSTALL, undefined, {
      overrides: [{ effect: 'allow', scope: SC.PLUGIN_INSTALL, expiresAt: Date.now() - 1000 }],
    })
    expect(d.result).toBe('deny')
  })
})
