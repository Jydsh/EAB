import { afterEach, describe, expect, it } from 'vitest'
import { EC } from '@eab/domain'
import { migrate, openDatabase, type Db } from '@eab/storage'
import {
  claimApprovedToolApproval,
  ensureToolApproval,
  requiresToolApproval,
  requiresToolApprovalForArgs,
  toolApprovalPolicy,
  toolArgsDigest,
  toolRisk,
  type ToolApprovalRequest,
} from '../src/tool-approval.js'

const dbs: Db[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

function testDb(): Db {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  // 审批表对 companies/users 有外键；单测只验证审批语义，不铺完整组织数据。
  db.exec('PRAGMA foreign_keys = OFF')
  dbs.push(db)
  return db
}

const subject = { companyId: 'c1', userId: 'u1' }

describe('工具风险分级', () => {
  it('命令执行、不可逆和高风险写入需要审批，普通写入不需要', () => {
    expect(toolRisk({ id: 'project.exec' })).toBe('exec')
    expect(toolRisk({ id: 'workspace.delete', concurrency: 'write' })).toBe('irreversible')
    expect(toolRisk({ id: 'admin.password.reset', dangerous: true })).toBe('irreversible')
    expect(toolRisk({ id: 'office.rewrite', concurrency: 'write' })).toBe('write')
    expect(toolRisk({ id: 'workspace.write', concurrency: 'write' })).toBe('write')
    expect(toolRisk({ id: 'workspace.read', concurrency: 'read' })).toBe('read')

    expect(requiresToolApproval({ id: 'project.exec' })).toBe(true)
    expect(requiresToolApproval({ id: 'workspace.delete' })).toBe(true)
    expect(requiresToolApproval({ id: 'office.rewrite' })).toBe(true)
    expect(requiresToolApproval({ id: 'workspace.write', concurrency: 'write' })).toBe(false)
    expect(toolApprovalPolicy({ id: 'workspace.read', concurrency: 'read' })).toBe('never')

    expect(requiresToolApprovalForArgs({ id: 'project.job', risk: 'exec' }, { action: 'output' })).toBe(false)
    expect(requiresToolApprovalForArgs({ id: 'project.job', risk: 'exec' }, { action: 'kill' })).toBe(true)
    expect(requiresToolApprovalForArgs({ id: 'office.versions', risk: 'write' }, { action: 'list' })).toBe(false)
    expect(requiresToolApprovalForArgs({ id: 'office.versions', risk: 'write' }, { action: 'restore' })).toBe(true)
    expect(requiresToolApprovalForArgs({ id: 'workspace.folder', approval: 'always' }, { action: 'create' })).toBe(false)
    expect(requiresToolApprovalForArgs({ id: 'workspace.folder', approval: 'always' }, { action: 'delete' })).toBe(true)
  })
})

describe('工具审批门禁', () => {
  it('defer 会生成参数绑定的待办，同一参数复用同一张待办', async () => {
    const db = testDb()
    const tool = { id: 'project.exec', name: '执行项目命令', risk: 'exec', approval: 'always' } as const
    const args = { command: 'node -v' }

    const first = await ensureToolApproval(db, subject, tool, args, { mode: 'defer' }).catch((error) => error)
    expect(first.code).toBe(EC.APPROVAL_REQUIRED)
    const firstId = first.details.approvalId as string
    expect(firstId).toBeTruthy()

    const second = await ensureToolApproval(db, subject, tool, args, { mode: 'defer' }).catch((error) => error)
    expect(second.code).toBe(EC.APPROVAL_REQUIRED)
    expect(second.details.approvalId).toBe(firstId)

    const row = db.prepare('SELECT action, resource_id, payload_json, status FROM approvals WHERE id = ?').get(firstId) as {
      action: string
      resource_id: string
      payload_json: string
      status: string
    }
    expect(row.action).toBe('tool:project.exec')
    expect(row.resource_id).toBe(toolArgsDigest(args))
    expect(row.status).toBe('pending')
    expect(row.payload_json).toContain('command=node -v')
    expect(row.payload_json).not.toContain('"command"')
  })

  it('不同参数生成不同待办，审批不能跨参数复用', async () => {
    const db = testDb()
    const tool = { id: 'project.exec', name: '执行项目命令', risk: 'exec', approval: 'always' } as const
    const first = await ensureToolApproval(db, subject, tool, { command: 'node -v' }, { mode: 'defer' }).catch((error) => error)
    const second = await ensureToolApproval(db, subject, tool, { command: 'pnpm test' }, { mode: 'defer' }).catch((error) => error)
    expect(first.details.approvalId).not.toBe(second.details.approvalId)

    const firstId = first.details.approvalId as string
    db.prepare("UPDATE approvals SET status = 'approved', decided_by = 'admin', decided_at = ? WHERE id = ?")
      .run(Date.now(), firstId)
    expect(claimApprovedToolApproval(db, subject, 'project.exec', toolArgsDigest({ command: 'pnpm test' }), firstId)).toBe(false)
  })

  it('同一张已通过审批只能核销一次', () => {
    const db = testDb()
    const argsHash = toolArgsDigest({ command: 'node -v' })
    const id = 'approval-once'
    const now = Date.now()
    db.prepare(
      `INSERT INTO approvals (id, company_id, requester_user_id, action, resource_type, resource_id, payload_json, status, created_at, expires_at)
       VALUES (?, 'c1', 'u1', 'tool:project.exec', 'tool', ?, '{}', 'approved', ?, ?)`,
    ).run(id, argsHash, now, now + 60_000)

    expect(claimApprovedToolApproval(db, subject, 'project.exec', argsHash, id, now)).toBe(true)
    expect(claimApprovedToolApproval(db, subject, 'project.exec', argsHash, id, now)).toBe(false)
    const row = db.prepare('SELECT used_at FROM approvals WHERE id = ?').get(id) as { used_at: number | null }
    expect(row.used_at).toBeTruthy()
  })

  it('wait 模式在管理员通过后自动核销并继续', async () => {
    const db = testDb()
    const tool = { id: 'project.exec', name: '执行项目命令', risk: 'exec', approval: 'always' } as const
    let request: ToolApprovalRequest | undefined
    await ensureToolApproval(db, subject, tool, { command: 'node -v' }, {
      mode: 'wait',
      onPending: (pending) => {
        request = pending
        setTimeout(() => {
          db.prepare("UPDATE approvals SET status = 'approved', decided_by = 'admin', decided_at = ? WHERE id = ?")
            .run(Date.now(), pending.approvalId)
        }, 50).unref?.()
      },
    })
    expect(request?.approvalId).toBeTruthy()
    const row = db.prepare('SELECT status, used_at FROM approvals WHERE id = ?').get(request!.approvalId) as {
      status: string
      used_at: number | null
    }
    expect(row.status).toBe('approved')
    expect(row.used_at).toBeTruthy()
  })

  it('wait 模式没有可送达审批人时立即失败，保留待办而不空等', async () => {
    const db = testDb()
    const tool = { id: 'project.exec', name: '执行项目命令', risk: 'exec', approval: 'always' } as const
    const startedAt = Date.now()
    const error = await ensureToolApproval(db, subject, tool, { command: 'node -v' }, {
      mode: 'wait',
      onPending: () => false,
    }).catch((failure) => failure)
    expect(error.code).toBe(EC.APPROVAL_REQUIRED)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    const row = db.prepare('SELECT status FROM approvals WHERE id = ?').get(error.details.approvalId) as { status: string }
    expect(row.status).toBe('pending')
  })

  it('wait 模式被拒绝时抛 FORBIDDEN，不执行工具', async () => {
    const db = testDb()
    const tool = { id: 'project.exec', name: '执行项目命令', risk: 'exec', approval: 'always' } as const
    const result = await ensureToolApproval(db, subject, tool, { command: 'node -v' }, {
      mode: 'wait',
      onPending: (pending) => {
        setTimeout(() => {
          db.prepare("UPDATE approvals SET status = 'rejected', reason = '不允许', decided_by = 'admin', decided_at = ? WHERE id = ?")
            .run(Date.now(), pending.approvalId)
        }, 50).unref?.()
      },
    }).catch((error) => error)
    expect(result.code).toBe(EC.FORBIDDEN)
    expect(String(result.message)).toContain('不允许')
  })
})
