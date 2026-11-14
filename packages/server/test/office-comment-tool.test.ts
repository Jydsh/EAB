import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { strToU8, zipSync } from 'fflate'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import { readDocxComments } from '../src/office-content.js'
import { executeTool } from '../src/routes/tools.js'

function makeDocx(): Buffer {
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
  <w:body><w:p><w:r><w:t>安全防护记录本</w:t></w:r></w:p></w:body>
</w:document>`,
      ),
    }),
  )
}

function testDeps(buffer: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'eab-comment-tool-'))
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.exec('PRAGMA foreign_keys = OFF')
  const userDir = join(dir, 'workspaces', 'c1', 'user-u1')
  mkdirSync(userDir, { recursive: true })
  const relPath = '批注验收.docx'
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

describe('office.comment 工具', () => {
  it('按 action 完成新增、回复、列表、解决和删除，并逐次写回云空间文件', async () => {
    const { dir, deps, actor, relPath } = testDeps(makeDocx())
    const actorArg = actor as unknown as Parameters<typeof executeTool>[1]
    try {
      const added = (await executeTool(deps, actorArg, 'office.comment', {
        fileId: 'f1',
        action: 'add',
        elementId: 'p1',
        text: '请核对短语范围',
        author: '工具验收',
        oldText: '安全防护',
      })) as Record<string, unknown>
      expect(added).toMatchObject({ action: 'add', commentId: 1, start: 0, end: 4, wrote: true, saved: true })
      expect(readFileSync(join(dir, 'workspaces', 'c1', 'user-u1', relPath))).toBeInstanceOf(Buffer)
      const afterAdd = readDocxComments(readFileSync(join(dir, 'workspaces', 'c1', 'user-u1', relPath)))
      expect(afterAdd.total).toBe(1)
      expect(afterAdd.comments[0]).toMatchObject({ id: 1, anchor: '安全防护', resolved: false })

      const replied = (await executeTool(deps, actorArg, 'office.comment', {
        fileId: 'f1',
        action: 'reply',
        commentId: 1,
        text: '已核对',
      })) as Record<string, unknown>
      expect(replied).toMatchObject({ action: 'reply', commentId: 2, replyId: 2, wrote: true })

      const listed = (await executeTool(deps, actorArg, 'office.comment', {
        fileId: 'f1',
        action: 'list',
      })) as Record<string, unknown>
      expect(listed).toMatchObject({ action: 'list', total: 2, unresolved: 2, wrote: false })
      expect((listed.comments as Array<Record<string, unknown>>).find((item) => item.id === 1)).toMatchObject({
        parentId: null,
        threadRootId: 1,
        replyCount: 1,
      })

      const resolved = (await executeTool(deps, actorArg, 'office.comment', {
        fileId: 'f1',
        action: 'resolve',
        commentId: 1,
      })) as Record<string, unknown>
      expect(resolved).toMatchObject({ action: 'resolve', commentId: 1, resolved: true, wrote: true })

      const deleted = (await executeTool(deps, actorArg, 'office.comment', {
        fileId: 'f1',
        action: 'delete',
        commentId: 1,
      })) as Record<string, unknown>
      expect(deleted).toMatchObject({ action: 'delete', commentId: 1, deletedIds: [1, 2], wrote: true })
      expect(readDocxComments(readFileSync(join(dir, 'workspaces', 'c1', 'user-u1', relPath))).total).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
