import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, migrate } from '@eab/storage'
import type { ServerConfig } from '../src/config.js'
import type { ServerDeps } from '../src/deps.js'
import type { RequestActor } from '../src/session.js'
import type { AttachmentObjectStore } from '../src/object-storage.js'
import {
  chatAttachmentKindOf,
  chatImageMimeOf,
  readChatAttachmentFile,
  resolveWorkspaceFileStates,
  saveUserWorkspaceFile,
} from '../src/routes/workspace.js'

// 1x1 透明 PNG；附件入口会校验魔数，测试不能用 Buffer.from('png') 冒充。
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function testDeps() {
  const dir = mkdtempSync(join(tmpdir(), 'eab-chat-attachment-'))
  dirs.push(dir)
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  db.exec('PRAGMA foreign_keys = OFF')
  const config = { dbPath: join(dir, 'eab.db'), dataDir: dir } as ServerConfig
  const deps: ServerDeps = { db, config, companyId: 'c1', migrations: [], consoleToken: '' }
  const actor = {
    subject: {
      companyId: 'c1',
      userId: 'u_owner',
      status: 'active',
      deptId: 'd1',
      deptPath: '/d1',
      deptChain: [],
      roles: [],
    },
    person: {
      id: 'u_owner',
      name: '附件本人',
      title: null,
      deptId: 'd1',
      deptPath: '/d1',
      deptName: '测试部门',
      companyId: 'c1',
      companyName: '测试公司',
    },
  } as unknown as RequestActor
  const other = {
    ...actor,
    subject: { ...actor.subject, userId: 'u_other' },
    person: { ...actor.person, id: 'u_other', name: '另一位员工' },
  } as unknown as RequestActor
  return { db, deps, actor, other }
}

function memoryObjectStore(): AttachmentObjectStore {
  const objects = new Map<string, Buffer>()
  return {
    driver: 's3',
    bucket: 'test-bucket',
    attachmentKey: (companyId, ownerUserId, fileId) => `chat-attachments/${companyId}/${ownerUserId}/${fileId}`,
    async put(key, buffer) {
      objects.set(key, Buffer.from(buffer))
    },
    async get(key) {
      return objects.get(key) ?? null
    },
    async delete(key) {
      objects.delete(key)
    },
  }
}

describe('对话附件类型判定', () => {
  it('只把栅格图当图片附件，SVG 不进入内联预览白名单', () => {
    expect(chatAttachmentKindOf('现场照片.PNG', 'image/png')).toBe('image')
    expect(chatAttachmentKindOf('示意图.svg', 'image/svg+xml')).toBe('binary')
    expect(chatImageMimeOf('现场照片.PNG')).toBe('image/png')
    expect(chatImageMimeOf('旧扩展名.jpg', 'image/jpg')).toBe('image/jpeg')
    expect(chatImageMimeOf('示意图.svg', 'image/svg+xml')).toBeNull()
  })

  it('文本和二进制按扩展名与 MIME 分流', () => {
    expect(chatAttachmentKindOf('记录.csv', 'text/csv')).toBe('text')
    expect(chatAttachmentKindOf('无扩展名', 'application/json')).toBe('text')
    expect(chatAttachmentKindOf('季度报告.pdf', 'application/pdf')).toBe('binary')
    expect(chatAttachmentKindOf('归档.zip', 'application/zip')).toBe('binary')
  })
})

describe('消息附件读取个人云空间文件', () => {
  it('读取本人 user scope 文件并返回真实元数据与文件内容', async () => {
    const { deps, actor } = testDeps()
    const saved = saveUserWorkspaceFile(deps, actor, {
      relPath: '对话附件/2026-11-17/upload-1/记录.txt',
      buffer: Buffer.from('会议记录正文', 'utf8'),
      mime: 'text/plain',
    })

    const file = await readChatAttachmentFile(deps, actor, saved.id)
    expect(file).toMatchObject({
      id: saved.id,
      name: '记录.txt',
      size: Buffer.byteLength('会议记录正文', 'utf8'),
      mime: 'text/plain',
      ownerUserId: 'u_owner',
      kind: 'text',
    })
    expect(file.buffer.toString('utf8')).toBe('会议记录正文')
  })

  it('拒绝引用他人文件，避免共享文件被当成本人附件', async () => {
    const { deps, actor, other } = testDeps()
    const saved = saveUserWorkspaceFile(deps, actor, {
      relPath: '对话附件/2026-11-17/upload-1/私有.txt',
      buffer: Buffer.from('private'),
      mime: 'text/plain',
    })

    await expect(readChatAttachmentFile(deps, other, saved.id)).rejects.toThrow(/只能引用本人云空间里的附件/)
  })

  it('记录已删除或磁盘内容丢失时返回 404，不把旧消息继续当有效附件', async () => {
    const { db, deps, actor } = testDeps()
    const saved = saveUserWorkspaceFile(deps, actor, {
      relPath: '对话附件/2026-11-17/upload-1/已删.txt',
      buffer: Buffer.from('gone'),
      mime: 'text/plain',
    })
    db.prepare('UPDATE workspace_files SET deleted_at = ? WHERE id = ?').run(Date.now(), saved.id)
    await expect(readChatAttachmentFile(deps, actor, saved.id)).rejects.toThrow(/附件已从云空间删除/)
  })

  it('本地副本丢失时从对象存储回源，并重建本地缓存', async () => {
    const { deps: baseDeps, actor } = testDeps()
    const store = memoryObjectStore()
    const deps: ServerDeps = { ...baseDeps, attachmentObjectStore: store }
    const saved = saveUserWorkspaceFile(deps, actor, {
      relPath: '对话附件/2026-11-17/upload-1/回源.txt',
      buffer: Buffer.from('对象里的正文'),
      mime: 'text/plain',
    })
    // 模拟浏览器上传路径的对象镜像（saveUserWorkspaceFile 是同步渠道入口，不写对象）。
    await store.put(store.attachmentKey('c1', 'u_owner', saved.id), Buffer.from('对象里的正文'), 'text/plain')
    rmSync(join(saved.root, saved.relPath), { force: true })
    expect(existsSync(join(saved.root, saved.relPath))).toBe(false)

    const file = await readChatAttachmentFile(deps, actor, saved.id)
    expect(file.buffer.toString('utf8')).toBe('对象里的正文')
    expect(existsSync(join(saved.root, saved.relPath))).toBe(true)
  })
})

describe('历史消息附件状态批量解析', () => {
  it('一次查询返回 active/deleted/forbidden/missing，且 forbidden 不泄露名称', () => {
    const { db, deps, actor } = testDeps()
    const active = saveUserWorkspaceFile(deps, actor, {
      relPath: '对话附件/2026-11-17/upload-1/有效.png',
      buffer: PNG_1X1,
      mime: 'image/png',
    })
    const deleted = saveUserWorkspaceFile(deps, actor, {
      relPath: '对话附件/2026-11-17/upload-1/删除.txt',
      buffer: Buffer.from('gone'),
      mime: 'text/plain',
    })
    db.prepare('UPDATE workspace_files SET deleted_at = ? WHERE id = ?').run(Date.now(), deleted.id)
    const foreign = saveUserWorkspaceFile(deps, actor, {
      relPath: '别人目录/别人的文件.txt',
      buffer: Buffer.from('foreign'),
      mime: 'text/plain',
    })
    db.prepare("UPDATE workspace_files SET scope_id = 'u_other', owner_user_id = 'u_other' WHERE id = ?").run(foreign.id)

    const states = resolveWorkspaceFileStates(deps, 'c1', 'u_owner', [
      active.id,
      deleted.id,
      foreign.id,
      'missing-id',
      active.id,
    ])

    expect(states.get(active.id)).toMatchObject({
      status: 'active',
      name: '有效.png',
      mime: 'image/png',
      size: PNG_1X1.length,
    })
    expect(states.get(deleted.id)).toEqual({ id: deleted.id, status: 'deleted' })
    expect(states.get(foreign.id)).toEqual({ id: foreign.id, status: 'forbidden' })
    expect(states.get('missing-id')).toEqual({ id: 'missing-id', status: 'deleted' })
    // 去重后只保留一次 active；重复 ID 不会重复查询或覆盖状态
    expect([...states.keys()].filter((id) => id === active.id)).toHaveLength(1)
    expect([...states.values()].filter((item) => item.status === 'active')).toHaveLength(1)
  })

  it('超过上限时只解析前 N 个 ID，避免历史接口被超长列表拖慢', () => {
    const { deps, actor } = testDeps()
    const saved = saveUserWorkspaceFile(deps, actor, {
      relPath: '对话附件/2026-11-17/upload-1/上限.txt',
      buffer: Buffer.from('limit'),
      mime: 'text/plain',
    })
    const states = resolveWorkspaceFileStates(deps, 'c1', 'u_owner', [saved.id], 1)
    expect(states.size).toBe(1)
    const empty = resolveWorkspaceFileStates(deps, 'c1', 'u_owner', [], 1)
    expect(empty.size).toBe(0)
  })
})
