import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '@eab/storage'
import {
  createSkillDevScaffold,
  installSkillDevBundle,
  skillPreviewLink,
} from '../src/skill-dev.js'
import { setSkillRoot, skillRoot } from '../src/skills.js'
import { buildWorkspaceToolView } from '../src/routes/chat.js'

const originalRoot = skillRoot()
const temps: string[] = []

afterEach(() => {
  setSkillRoot(originalRoot)
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function memoryDb() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  return db
}

describe('技能自开发闭环', () => {
  it('在工作区生成 L0 技能骨架，安装为个人技能，再改 SKILL.md 热更新', () => {
    const db = memoryDb()
    const root = mkdtempSync(join(tmpdir(), 'eab-skill-dev-'))
    temps.push(root)
    setSkillRoot(join(root, 'skills'))
    const dir = join(root, 'workspace', '.eab-skills', 'eab-meeting-notes')

    const created = createSkillDevScaffold({
      dir,
      skillId: 'eab-meeting-notes',
      title: '会议速记整理',
      description: '把会议速记整理成结论和待办',
      triggers: ['会议纪要', '速记整理'],
    })
    expect(created.created).toBe(true)
    expect(created.files).toEqual(['skill.json', 'SKILL.md', 'README.md'])
    const manifest = JSON.parse(readFileSync(join(dir, 'skill.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.id).toBe('eab-meeting-notes')
    expect(manifest.level).toBe('L0')
    expect(manifest.scopes).toEqual(['chat:use', 'skill:list', 'skill:use'])
    expect(manifest.tools).toEqual([])
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('# 会议速记整理')

    const first = installSkillDevBundle(db, {
      companyId: 'c1',
      userId: 'u1',
      installedBy: 'u1',
      dir,
      sourceRef: '.eab-skills/eab-meeting-notes',
    })
    expect(first.replaced).toBe(false)
    expect(first.skill.id).toBe('eab-meeting-notes')
    expect(first.skill.level).toBe('L0')
    expect(first.skill.enabled).toBe(true)
    expect(first.skill.valid).toBe(true)
    const userInstall = db
      .prepare(
        `SELECT user_id, enabled, removed_at FROM skill_user_installs
          WHERE company_id = ? AND user_id = ? AND skill_id = ?`,
      )
      .get('c1', 'u1', 'eab-meeting-notes') as
      | { user_id: string; enabled: number; removed_at: number | null }
      | undefined
    expect(userInstall?.user_id).toBe('u1')
    expect(userInstall?.enabled).toBe(1)
    expect(userInstall?.removed_at).toBeNull()
    const installedSkill = join(root, 'skills', 'eab-meeting-notes', 'SKILL.md')
    expect(existsSync(installedSkill)).toBe(true)
    expect(readFileSync(installedSkill, 'utf8')).toContain('## 输出结构')
    const firstChecksum = first.skill.checksum
    const preview = skillPreviewLink(first.skill, 'c1')
    expect(preview.previewPath).toContain('/chat?')
    expect(preview.previewPath).toContain('workspace=skills')
    expect(preview.previewPath).toContain('skill=eab-meeting-notes')
    expect(preview.triggerCount).toBe(2)

    const edited = readFileSync(join(dir, 'SKILL.md'), 'utf8')
      .replace('## 输出结构', '## 输出结构（热更新）')
      .replace('## 执行规则', '## 执行规则（版本二）')
    writeFileSync(join(dir, 'SKILL.md'), edited, 'utf8')

    const second = installSkillDevBundle(db, {
      companyId: 'c1',
      userId: 'u1',
      installedBy: 'u1',
      dir,
      sourceRef: '.eab-skills/eab-meeting-notes',
    })
    expect(second.replaced).toBe(true)
    expect(second.skill.checksum).not.toBe(firstChecksum)
    expect(readFileSync(installedSkill, 'utf8')).toContain('## 输出结构（热更新）')
    expect(readFileSync(installedSkill, 'utf8')).toContain('## 执行规则（版本二）')
    db.close()
  })

  it('拒绝用已有目录直接重置，避免覆盖 Agent 写好的说明', () => {
    const root = mkdtempSync(join(tmpdir(), 'eab-skill-dev-conflict-'))
    temps.push(root)
    const dir = join(root, '.eab-skills', 'eab-keep')
    createSkillDevScaffold({ dir, skillId: 'eab-keep', title: '保留' })
    expect(() => createSkillDevScaffold({ dir, skillId: 'eab-keep', title: '覆盖' })).toThrow(/已存在/)
  })

  it('安装结果生成技能工具卡，能直达技能工作台', () => {
    const view = buildWorkspaceToolView('skill_dev', {
      action: 'install',
      dir: '.eab-skills/eab-notes',
      previewPath: '/chat?workspace=skills&company=c1&skill=eab-notes',
      instructionPreview: '# 速记\n\n## 输出结构',
      skill: {
        id: 'eab-notes',
        name: '速记',
        version: '0.1.0',
        checksum: 'abc123',
        level: 'L0',
        risk: 'low',
        triggers: ['速记'],
      },
    })
    expect(view).toEqual({
      kind: 'skill',
      action: 'install',
      skillId: 'eab-notes',
      title: '速记',
      version: '0.1.0',
      checksum: 'abc123',
      level: 'L0',
      risk: 'low',
      previewPath: '/chat?workspace=skills&company=c1&skill=eab-notes',
      directory: '.eab-skills/eab-notes',
      triggerCount: 1,
      instructionPreview: '# 速记\n\n## 输出结构',
    })
  })
})
