import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import type { RequestActor } from '../src/session.js'
import {
  confirmWorkspaceGuiFallback,
  getWorkspaceGuiFallback,
  prepareWorkspaceGuiFallback,
  reportWorkspaceGuiFallback,
} from '../src/routes/workspace.js'
import { executeTool } from '../src/routes/tools.js'

function testDeps(name: string, ext = 'docx') {
  const dir = mkdtempSync(join(tmpdir(), 'eab-gui-fallback-'))
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.exec('PRAGMA foreign_keys = OFF')
  const userDir = join(dir, 'workspaces', 'c1', 'user-u1')
  mkdirSync(userDir, { recursive: true })
  const relPath = `${name}.${ext}`
  const buffer = Buffer.from('keep')
  writeFileSync(join(userDir, relPath), buffer)
  db.prepare(
    `INSERT INTO workspace_files (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, created_at, updated_at)
     VALUES ('f1', 'c1', 'user', 'u1', 'u1', ?, ?, ?, 1, 1)`,
  ).run(relPath, relPath, buffer.length)
  const config = { dbPath: join(dir, 'eab.db'), dataDir: dir } as ServerConfig
  const deps = { db, config, companyId: 'c1', migrations: [], consoleToken: '' } as ServerDeps
  const actor: RequestActor = {
    subject: {
      companyId: 'c1',
      userId: 'u1',
      status: 'active',
      deptId: 'd1',
      deptPath: '/d1',
      deptChain: [],
      roles: [],
      scopes: new Set([SC.AGENT_TOOL_INVOKE, SC.WORKSPACE_READ, SC.WORKSPACE_WRITE]),
      dataScope: 'self',
      channelType: 'web',
      projectIds: [],
    },
    person: {
      id: 'u1',
      name: '测试员工',
      title: null,
      avatar: null,
      deptId: 'd1',
      deptPath: '/d1',
      deptName: '测试部门',
      companyId: 'c1',
      companyName: '测试公司',
    },
  }
  return { dir, db, deps, actor, relPath, filePath: join(userDir, relPath), buffer }
}

function audits(db: ReturnType<typeof openDatabase>) {
  return db
    .prepare("SELECT action, result, detail_json FROM audit_logs WHERE action = 'workspace.file.agent_gui' ORDER BY seq")
    .all() as Array<{ action: string; result: string; detail_json: string }>
}

function guiRows(db: ReturnType<typeof openDatabase>) {
  return db.prepare('SELECT * FROM workspace_gui_fallbacks ORDER BY created_at').all() as Array<{
    id: string
    status: string
    attempts: number
    gui_action: string
  }>
}

describe('S15 GUI 兜底', () => {
  it('只登记白名单动作，准备阶段不碰文件', () => {
    const { dir, deps, actor, filePath, buffer } = testDeps('打印验收')
    try {
      const prepared = prepareWorkspaceGuiFallback(deps, { actor, channel: 'web', traceId: 't1' }, {
        fileId: 'f1',
        action: 'print',
      })
      expect(prepared).toMatchObject({
        fileId: 'f1',
        guiAction: 'print',
        status: 'prepared',
        mode: 'view',
        attempts: 0,
        requiresUserConfirmation: true,
        canReport: false,
      })
      expect(prepared.steps.length).toBeGreaterThan(0)
      expect(guiRows(deps.db)).toHaveLength(1)
      expect(audits(deps.db)).toHaveLength(1)
      const preparedAudit = JSON.parse(audits(deps.db)[0].detail_json)
      expect(preparedAudit).toMatchObject({ phase: 'prepared', guiAction: 'print', mode: 'view' })
      expect(readFileSync(filePath).equals(buffer)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('拒绝白名单外动作与非法对话框，且不落记录', () => {
    const { dir, deps, actor } = testDeps('白名单拒绝', 'xlsx')
    try {
      expect(() =>
        prepareWorkspaceGuiFallback(deps, { actor }, { fileId: 'f1', action: 'click_anywhere' }),
      ).toThrow(/白名单/)
      expect(() =>
        prepareWorkspaceGuiFallback(deps, { actor }, { fileId: 'f1', action: 'dialog', dialog: 'save_as' }),
      ).toThrow(/白名单/)
      expect(() =>
        prepareWorkspaceGuiFallback(deps, { actor }, { fileId: 'f1', action: 'dialog', dialog: 'page_setup' }),
      ).toThrow(/docx/)
      expect(guiRows(deps.db)).toHaveLength(0)
      expect(audits(deps.db)).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('必须由用户确认后才能上报，成功后同一记录不能再确认', () => {
    const { dir, deps, actor } = testDeps('确认与成功')
    try {
      const prepared = prepareWorkspaceGuiFallback(deps, { actor }, { fileId: 'f1', action: 'export', format: 'pdf' })
      expect(() =>
        reportWorkspaceGuiFallback(deps, { actor }, 'f1', prepared.fallbackId, 'success'),
      ).toThrow(/确认/)
      const confirmed = confirmWorkspaceGuiFallback(deps, { actor }, 'f1', prepared.fallbackId)
      expect(confirmed.status).toBe('confirmed')
      expect(confirmed.canReport).toBe(true)
      const succeeded = reportWorkspaceGuiFallback(deps, { actor }, 'f1', prepared.fallbackId, 'success')
      expect(succeeded).toMatchObject({ status: 'succeeded', attempts: 1 })
      expect(() => confirmWorkspaceGuiFallback(deps, { actor }, 'f1', prepared.fallbackId)).toThrow(/succeeded/)
      expect(() =>
        reportWorkspaceGuiFallback(deps, { actor }, 'f1', prepared.fallbackId, 'failure', '再次失败'),
      ).toThrow(/结束/)
      expect(audits(deps.db).map((row) => JSON.parse(row.detail_json).phase)).toEqual([
        'prepared',
        'confirmed',
        'succeeded',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('失败一次即停：同一条记录不能再确认或上报，审计为 failure', () => {
    const { dir, deps, actor } = testDeps('失败停止')
    try {
      const prepared = prepareWorkspaceGuiFallback(deps, { actor }, {
        fileId: 'f1',
        action: 'macro',
      })
      confirmWorkspaceGuiFallback(deps, { actor }, 'f1', prepared.fallbackId)
      expect(() =>
        reportWorkspaceGuiFallback(deps, { actor }, 'f1', prepared.fallbackId, 'failure', ''),
      ).toThrow(/原因/)
      const failed = reportWorkspaceGuiFallback(deps, { actor }, 'f1', prepared.fallbackId, 'failure', '宏被安全策略拦截')
      expect(failed).toMatchObject({ status: 'failed', attempts: 1 })
      expect(() => confirmWorkspaceGuiFallback(deps, { actor }, 'f1', prepared.fallbackId)).toThrow(/failed/)
      expect(() =>
        reportWorkspaceGuiFallback(deps, { actor }, 'f1', prepared.fallbackId, 'success'),
      ).toThrow(/结束/)
      const last = audits(deps.db).at(-1)
      if (!last) throw new Error('缺少失败审计')
      expect(last.result).toBe('failure')
      expect(JSON.parse(last.detail_json)).toMatchObject({ phase: 'failed', reason: '宏被安全策略拦截' })
      const status = getWorkspaceGuiFallback(deps, { actor }, 'f1', prepared.fallbackId)
      expect(status.status).toBe('failed')
      expect(guiRows(deps.db)[0].attempts).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Agent 工具只能 prepare/status/report，不能 confirm，也不能在确认前上报', async () => {
    const { dir, deps, actor } = testDeps('工具拒绝确认')
    const actorArg = actor as unknown as Parameters<typeof executeTool>[1]
    try {
      const prepared = (await executeTool(deps, actorArg, 'office.gui', {
        action: 'prepare',
        fileId: 'f1',
        guiAction: 'dialog',
        dialog: 'header_footer',
      })) as Record<string, unknown>
      expect(prepared).toMatchObject({
        status: 'prepared',
        requiresUserConfirmation: true,
        agentCanConfirm: false,
        wrote: false,
      })
      const fallbackId = String(prepared.fallbackId)
      await expect(
        executeTool(deps, actorArg, 'office.gui', {
          action: 'confirm',
          fileId: 'f1',
          fallbackId,
        }),
      ).rejects.toThrow(/action/)
      await expect(
        executeTool(deps, actorArg, 'office.gui', {
          action: 'report',
          fileId: 'f1',
          fallbackId,
          result: 'success',
        }),
      ).rejects.toThrow(/确认/)
      const status = (await executeTool(deps, actorArg, 'office.gui', {
        action: 'status',
        fallbackId,
      })) as Record<string, unknown>
      expect(status).toMatchObject({ fallbackId, status: 'prepared', agentCanConfirm: false })
      expect(guiRows(deps.db)).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
