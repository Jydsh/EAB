import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { strToU8, zipSync } from 'fflate'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { editUserWorkspaceFile } from '../src/routes/workspace.js'
import { executeTool } from '../src/routes/tools.js'

function makeDocx(text: string): Buffer {
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
      ),
      'word/_rels/document.xml.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
      ),
      'word/document.xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`,
      ),
    }),
  )
}

function testDeps(buffer: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'eab-version-tool-'))
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.exec('PRAGMA foreign_keys = OFF')
  const userDir = join(dir, 'workspaces', 'c1', 'user-u1')
  mkdirSync(userDir, { recursive: true })
  const relPath = '版本工具验收.docx'
  writeFileSync(join(userDir, relPath), buffer)
  db.prepare(
    `INSERT INTO workspace_files (id, company_id, scope_type, scope_id, owner_user_id, rel_path, name, size, created_at, updated_at)
     VALUES ('f1', 'c1', 'user', 'u1', 'u1', ?, ?, ?, 1, 1)`,
  ).run(relPath, relPath, buffer.length)
  const config = { dbPath: join(dir, 'eab.db'), dataDir: dir } as ServerConfig
  const deps = { db, config, companyId: 'c1', migrations: [], consoleToken: '' } as ServerDeps
  const actor = {
    subject: {
      companyId: 'c1',
      userId: 'u1',
      status: 'active',
      deptId: 'd1',
      deptPath: '/d1',
      deptChain: [],
      roles: [],
      scopes: new Set([SC.AGENT_TOOL_INVOKE, SC.WORKSPACE_READ, SC.WORKSPACE_WRITE]),
    },
    person: {
      id: 'u1',
      name: '测试员工',
      title: null,
      deptId: 'd1',
      deptPath: '/d1',
      deptName: '测试部门',
      companyId: 'c1',
      companyName: '测试公司',
    },
  }
  return { dir, db, deps, actor, relPath }
}

const waitTick = () => new Promise((resolve) => setTimeout(resolve, 8))

describe('office.versions 工具', () => {
  it('列出、手动快照并恢复到旧内容', async () => {
    const v1 = makeDocx('v1')
    const { dir, deps, actor, relPath } = testDeps(v1)
    const actorArg = actor as unknown as Parameters<typeof executeTool>[1]
    const filePath = join(dir, 'workspaces', 'c1', 'user-u1', relPath)
    try {
      const empty = (await executeTool(deps, actorArg, 'office.versions', {
        fileId: 'f1',
        action: 'list',
      })) as Record<string, unknown>
      expect(empty).toMatchObject({ fileId: 'f1', count: 0, wrote: false })

      const first = (await executeTool(deps, actorArg, 'office.versions', {
        fileId: 'f1',
        action: 'snapshot',
      })) as Record<string, unknown>
      expect(first).toMatchObject({ created: true, version: 1, wrote: true })
      const firstVersionId = String(first.versionId)

      await waitTick()
      editUserWorkspaceFile(deps, actorArg, 'f1', makeDocx('v2'), { source: 'test.write' })
      const listed = (await executeTool(deps, actorArg, 'office.versions', {
        fileId: 'f1',
        action: 'list',
      })) as { count: number; versions: Array<{ id: string; version: number }> }
      expect(listed.count).toBe(1)
      expect(listed.versions[0].id).toBe(firstVersionId)

      const restored = (await executeTool(deps, actorArg, 'office.versions', {
        fileId: 'f1',
        action: 'restore',
        versionId: firstVersionId,
      })) as Record<string, unknown>
      expect(restored).toMatchObject({ fileId: 'f1', restoredVersion: { id: firstVersionId }, wrote: true })
      expect(restored.snapshot).toBeTruthy()
      expect(readFileSync(filePath).equals(v1)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restore 不传 versionId 时拒绝且不写文件', async () => {
    const { dir, deps, actor, relPath } = testDeps(makeDocx('keep'))
    const actorArg = actor as unknown as Parameters<typeof executeTool>[1]
    const before = readFileSync(join(dir, 'workspaces', 'c1', 'user-u1', relPath))
    try {
      await expect(
        executeTool(deps, actorArg, 'office.versions', { fileId: 'f1', action: 'restore' }),
      ).rejects.toThrow(/versionId/)
      expect(readFileSync(join(dir, 'workspaces', 'c1', 'user-u1', relPath))).toEqual(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
