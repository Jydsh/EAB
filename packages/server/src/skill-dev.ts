/**
 * 技能自开发（EAB 技能包自举）：
 * - 在员工云空间里生成一个可编辑的技能骨架（skill.json + SKILL.md）；
 * - 把工作区目录直接安装成本人的个人技能，安装后下一轮对话立即加载，不需要浏览器上传或重启服务；
 * - 改 SKILL.md 后再次安装即热更新，技能目录和 checksum 同步刷新。
 *
 * 技能不执行脚本，只提供清单和说明；安装仍走 skills.ts 的静态安全扫描。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EC, EabError, SC } from '@eab/domain'
import type { Db } from '@eab/storage'
import { installSkillPackage, type SkillInstallResult, type SkillRecord } from './skills.js'

/** 员工工作区里放自开发技能的默认目录，和普通文件一样可以被 workspace 工具编辑。 */
export const SKILL_DEV_DIR = '.eab-skills'

const SKILL_ID_PATTERN = /^[a-z][a-z0-9-]{1,40}$/

export function normalizeSkillDevId(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[/@]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41)
    .replace(/-+$/, '')
  const id = /^[a-z]/.test(raw) ? raw : `s-${raw}`.slice(0, 41)
  if (!id || !SKILL_ID_PATTERN.test(id)) {
    throw new EabError(EC.VALIDATION, `技能 id 不合法：${String(value ?? '')}；要求小写字母开头，只含 a-z 0-9 -，2-41 位`)
  }
  return id
}

export interface SkillDevScaffoldOptions {
  /** 技能包目录（绝对路径，通常是 userScopeDir/.eab-skills/<id>） */
  readonly dir: string
  readonly skillId: string
  readonly title: string
  readonly description?: string
  readonly triggers?: readonly string[]
  /** 已存在时是否允许重置为模板；默认 false，避免覆盖 Agent 已经写好的说明 */
  readonly overwrite?: boolean
}

export interface SkillDevScaffoldResult {
  readonly dir: string
  readonly skillId: string
  readonly files: string[]
  readonly created: boolean
}

function assertDirEmptyOrAllowed(dir: string, overwrite: boolean): boolean {
  if (!existsSync(dir)) return true
  if (!statSync(dir).isDirectory()) {
    throw new EabError(EC.VALIDATION, `技能源码路径不是目录：${dir}`)
  }
  const manifestPath = join(dir, 'skill.json')
  if (existsSync(manifestPath) && !overwrite) {
    throw new EabError(EC.CONFLICT, `技能源码目录已存在：${dir}`, {
      hint: '继续用 workspace.edit 改现有 SKILL.md；确需重置为模板时传 overwrite=true。',
    })
  }
  return false
}

function trimTriggers(raw: readonly string[] | undefined, skillId: string): string[] {
  const cleaned = (raw ?? [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 20)
  return cleaned.length > 0 ? cleaned : [skillId, '整理速记', '结构化整理']
}

function skillInstructions(title: string, description: string, triggers: readonly string[], dir: string): string {
  return `# ${title}

${description}

当用户提出与这些场景相关的任务时使用本技能：${triggers.join('、')}。

## 输出结构

1. **主题**：用一句话概括这次任务或材料在讲什么。
2. **关键结论**：列出已经明确、可以直接执行的结论。
3. **待办事项**：写成“动作 + 负责人/对象 + 时间”的可执行条目。
4. **待确认**：列出信息缺口和需要用户补充的内容。

## 执行规则

- 只使用用户提供的原始内容，不补写未经确认的事实、数字或责任人。
- 信息不足时，把缺口放进「待确认」，不要猜。
- 输出使用简体中文，短句优先，结论前置。
- 不要把大段原文整段复制回来；按上面的结构提炼。

## 自开发说明

技能源码目录：\`${dir}\`

改完本文件后，Agent 再次调用 skill_dev action=install 热安装；下一轮对话会加载新版本，不需要重启服务。
`
}

function skillReadme(title: string, dir: string): string {
  return `# ${title}

这是 EAB Agent 自开发技能骨架：

- \`skill.json\`：技能清单（id、版本、等级、权限、触发词、工具）。
- \`SKILL.md\`：技能说明，Agent 通过 skill_load 按需加载。

改 \`SKILL.md\` 后调用 skill_dev action=install 热更新；不要手工复制到 skills 目录，也不要重启服务。

源码目录：\`${dir}\`
`
}

export function createSkillDevScaffold(options: SkillDevScaffoldOptions): SkillDevScaffoldResult {
  const skillId = normalizeSkillDevId(options.skillId)
  const dir = options.dir
  const created = assertDirEmptyOrAllowed(dir, Boolean(options.overwrite))
  const title = String(options.title || skillId).trim() || skillId
  const description =
    String(options.description || '').trim() ||
    '这是 Agent 在 EAB 工作区里写出来的技能：安装后下一轮对话立即可用，改完说明再安装一次即热更新。'
  const triggers = trimTriggers(options.triggers, skillId)
  mkdirSync(dir, { recursive: true })

  const manifest = {
    id: skillId,
    name: title,
    version: '0.1.0',
    description,
    author: 'EAB Agent',
    level: 'L0',
    scopes: [SC.CHAT_USE, SC.SKILL_LIST, SC.SKILL_USE],
    triggers,
    tools: [],
  }

  const files: Array<[string, string]> = [
    ['skill.json', `${JSON.stringify(manifest, null, 2)}\n`],
    ['SKILL.md', skillInstructions(title, description, triggers, dir)],
    ['README.md', skillReadme(title, dir)],
  ]
  for (const [rel, text] of files) {
    writeFileSync(join(dir, rel), text, 'utf8')
  }
  return { dir, skillId, files: files.map(([rel]) => rel), created }
}

export interface SkillDevInstallOptions {
  readonly companyId: string
  readonly userId: string
  readonly installedBy: string
  readonly dir: string
  readonly sourceRef?: string
  readonly expectedChecksum?: string
  readonly approvalId?: string
}

export function installSkillDevBundle(db: Db, options: SkillDevInstallOptions): SkillInstallResult {
  const dir = options.dir
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new EabError(EC.VALIDATION, `技能源码目录不存在：${dir}；先调用 skill_dev action=create`)
  }
  return installSkillPackage(db, dir, {
    companyId: options.companyId,
    installedBy: options.installedBy,
    scope: 'user',
    userId: options.userId,
    overwrite: true,
    source: 'workspace-dev',
    sourceRef: options.sourceRef ?? dir,
    expectedChecksum: options.expectedChecksum,
    approvalId: options.approvalId,
  })
}

export interface SkillPreviewLink {
  readonly id: string
  readonly title: string
  readonly version: string
  readonly checksum: string
  readonly level: string
  readonly risk: string
  readonly triggerCount: number
  readonly previewPath: string
}

/** 技能没有独立页面，预览地址直接打开个人技能工作台并选中该技能。 */
export function skillPreviewLink(
  skill: Pick<SkillRecord, 'id' | 'name' | 'version' | 'checksum' | 'level' | 'risk' | 'triggers'>,
  companyId: string,
): SkillPreviewLink {
  const params = new URLSearchParams({
    workspace: 'skills',
    company: companyId,
    skill: skill.id,
  })
  return {
    id: skill.id,
    title: skill.name || skill.id,
    version: skill.version,
    checksum: skill.checksum,
    level: skill.level,
    risk: skill.risk,
    triggerCount: skill.triggers.length,
    previewPath: `/chat?${params.toString()}`,
  }
}

/** 只读 skill.json 的 id，给“目录已存在但没有 skillId 参数”的更新路径兜底。 */
export function skillDevIdFromDir(dir: string): string {
  const manifestPath = join(dir, 'skill.json')
  if (!existsSync(manifestPath)) {
    throw new EabError(EC.VALIDATION, `技能源码目录里没有 skill.json：${dir}`)
  }
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as { id?: unknown }
    return normalizeSkillDevId(raw.id)
  } catch (error) {
    if (error instanceof EabError) throw error
    throw new EabError(EC.VALIDATION, `skill.json 不是合法 JSON：${dir}`)
  }
}
