/**
 * 技能接口。
 *
 * - `/api/my/skills`：员工个人技能安装、启停、卸载、风险详情。
 * - `/api/skills`：当前员工可用技能（公司级 + 个人级，已启用且重扫通过）。
 * - `/api/console/skills/*`：服务器侧控制台，负责公司级安装、启停、卸载和审计。
 *
 * 安装入口只接受浏览器文件夹上传；服务端路径安装只对控制台开放。
 * 所有入口都先经过 `skills.ts` 的静态扫描；高风险包不会写入 skills/ 目录。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { EC, EabError, SC } from '@eab/domain'
import { isConsoleRequest } from '../console-auth.js'
import type { ServerDeps } from '../deps.js'
import { ok, requireScope } from '../http.js'
import { resolveActor } from '../session.js'
import {
  companySkillPolicy,
  ensureSkillInstallApproval,
  installSkillPackage,
  listQuarantineEntries,
  listSkillArtifacts,
  listSkillAuditDegraded,
  loadAdminPersonalSkills,
  loadCompanySkills,
  loadPersonalSkills,
  loadSkillsForActor,
  previewSkillInstall,
  reviewQuarantineEntry,
  setCompanySkillEnabled,
  setCompanySkillPolicy,
  setPersonalSkillEnabled,
  skillAuditHealth,
  uninstallCompanySkill,
  uninstallPersonalSkill,
  type SkillRecord,
} from '../skills.js'
import { stageSkillFromArchive, stageSkillFromGithub } from '../skill-network.js'

function ensureConsole(req: FastifyRequest, deps: ServerDeps): void {
  if (!isConsoleRequest(req, deps.config)) throw new EabError(EC.AUTH_REQUIRED, '需要控制台会话（请先在 /admin 登录）')
}

function serializeSkill(skill: SkillRecord, withPath = false) {
  return {
    id: skill.id,
    name: skill.name,
    version: skill.version,
    description: skill.description,
    author: skill.author,
    level: skill.level,
    scopes: skill.scopes,
    triggers: skill.triggers,
    tools: skill.tools,
    risk: skill.risk,
    findings: skill.findings,
    valid: skill.valid,
    error: skill.error,
    enabled: skill.enabled,
    scope: skill.scope,
    checksum: skill.checksum,
    references: skill.references,
    dir: withPath ? skill.dir : undefined,
    install: {
      source: skill.source,
      sourceRef: skill.sourceRef,
      installedAt: skill.installedAt,
      updatedAt: skill.updatedAt,
    },
  }
}

/** 浏览器只能给文件副本；落到临时目录交给安装器扫描，安装后立即删除。 */
function stageBrowserSkillUpload(filesRaw: unknown): { dir: string; label: string; fileCount: number; bytes: number } {
  if (!Array.isArray(filesRaw) || filesRaw.length === 0) throw new EabError(EC.VALIDATION, '请选择技能文件夹后再安装')
  const entries: Array<{ segments: string[]; buf: Buffer }> = []
  let total = 0
  for (const item of filesRaw as Array<{ path?: unknown; data?: unknown }>) {
    const rawPath = String(item?.path ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
    const segments = rawPath.split('/').filter(Boolean)
    if (segments.length === 0 || segments.some((part) => part === '.' || part === '..')) {
      throw new EabError(EC.VALIDATION, '技能包里有非法文件路径')
    }
    const data = String(item?.data ?? '')
    if (!data) throw new EabError(EC.VALIDATION, `文件 ${rawPath} 没有内容`)
    const buf = Buffer.from(data, 'base64')
    if (buf.length === 0) throw new EabError(EC.VALIDATION, `文件 ${rawPath} 是空文件，不能作为技能包`)
    if (buf.length > 512 * 1024) throw new EabError(EC.VALIDATION, `文件 ${rawPath} 超过 512KB`)
    total += buf.length
    if (total > 4 * 1024 * 1024) throw new EabError(EC.VALIDATION, '技能包总大小超过 4MB')
    entries.push({ segments, buf })
  }
  if (entries.length > 200) throw new EabError(EC.VALIDATION, '技能包文件超过 200 个')
  const firsts = new Set(entries.map((entry) => entry.segments[0]))
  const hasRootManifest = entries.some((entry) => entry.segments.length === 1 && entry.segments[0] === 'skill.json')
  const stripRoot = !hasRootManifest && firsts.size === 1
  const label = stripRoot ? [...firsts][0] : entries[0]?.segments[0] ?? '浏览器上传'
  const dir = mkdtempSync(join(tmpdir(), 'eab-skill-upload-'))
  try {
    for (const entry of entries) {
      const segments = stripRoot ? entry.segments.slice(1) : entry.segments
      if (segments.length === 0) continue
      const abs = resolve(dir, ...segments)
      if (!abs.startsWith(`${dir}${sep}`)) throw new EabError(EC.VALIDATION, '技能包里有越界路径')
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, entry.buf)
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
  return { dir, label, fileCount: entries.length, bytes: total }
}

type SkillInstallBody = {
  source?: unknown
  path?: unknown
  repo?: unknown
  ref?: unknown
  subdir?: unknown
  url?: unknown
  files?: unknown
  overwrite?: unknown
}

interface StagedSkillInstallSource {
  readonly dir: string
  readonly source: 'server-path' | 'browser-dir' | 'git' | 'http'
  readonly sourceRef: string
  readonly label: string
  readonly fileCount?: number
  readonly bytes?: number
  readonly cleanup: () => void
}

const SKILL_SOURCE_ALIASES: Record<string, StagedSkillInstallSource['source']> = {
  'server-path': 'server-path',
  'local-path': 'server-path',
  path: 'server-path',
  'browser-dir': 'browser-dir',
  browser: 'browser-dir',
  github: 'git',
  git: 'git',
  url: 'http',
  http: 'http',
  archive: 'http',
}

/** 统一解析安装来源；网络来源先下载解包到临时目录，本地/浏览器来源保持原路径。 */
async function stageSkillInstallSource(
  body: SkillInstallBody,
  mode: 'console' | 'personal',
): Promise<StagedSkillInstallSource> {
  const raw = String(body.source ?? '').trim().toLowerCase()
  let source: StagedSkillInstallSource['source']
  if (raw) {
    source = SKILL_SOURCE_ALIASES[raw] ?? (raw as StagedSkillInstallSource['source'])
  } else if (typeof body.repo === 'string' && body.repo.trim()) {
    source = 'git'
  } else if (typeof body.url === 'string' && body.url.trim()) {
    source = 'http'
  } else if (typeof body.path === 'string' && body.path.trim()) {
    source = 'server-path'
  } else {
    source = mode === 'personal' ? 'browser-dir' : 'server-path'
  }

  if (mode === 'console' && source === 'browser-dir') {
    throw new EabError(EC.VALIDATION, '控制台公司级安装不支持浏览器文件夹上传；请使用 GitHub、压缩包 URL 或服务器目录')
  }
  if (mode === 'personal' && source === 'server-path') {
    throw new EabError(EC.VALIDATION, '员工个人安装不支持服务器路径；请使用浏览器文件夹上传、GitHub 或压缩包 URL')
  }

  if (source === 'server-path') {
    const sourcePath = String(body.path ?? '').trim()
    if (!sourcePath) throw new EabError(EC.VALIDATION, '请提供服务端技能目录 path')
    return {
      dir: sourcePath,
      source: 'server-path',
      sourceRef: sourcePath,
      label: sourcePath,
      cleanup: () => {},
    }
  }

  if (source === 'browser-dir') {
    const staged = stageBrowserSkillUpload(body.files)
    return {
      dir: staged.dir,
      source: 'browser-dir',
      sourceRef: staged.label,
      label: staged.label,
      fileCount: staged.fileCount,
      bytes: staged.bytes,
      cleanup: () => rmSync(staged.dir, { recursive: true, force: true }),
    }
  }

  if (source === 'git') {
    const staged = await stageSkillFromGithub({
      repo: String(body.repo ?? ''),
      ref: String(body.ref ?? ''),
      subdir: String(body.subdir ?? ''),
    })
    return {
      dir: staged.dir,
      source: 'git',
      sourceRef: staged.sourceRef,
      label: staged.label,
      cleanup: staged.cleanup,
    }
  }

  if (source === 'http') {
    const url = String(body.url ?? '').trim()
    if (!url) throw new EabError(EC.VALIDATION, '请填写技能压缩包 URL')
    const staged = await stageSkillFromArchive({ url })
    return {
      dir: staged.dir,
      source: 'http',
      sourceRef: staged.sourceRef,
      label: staged.label,
      cleanup: staged.cleanup,
    }
  }

  throw new EabError(EC.VALIDATION, `不支持的技能安装来源：${raw || '未填写'}`)
}

function skillPermissions(scopes: ReadonlySet<string>) {
  return {
    list: scopes.has(SC.SKILL_LIST),
    use: scopes.has(SC.SKILL_USE),
    install: scopes.has(SC.SKILL_INSTALL),
    configure: scopes.has(SC.SKILL_CONFIGURE),
    uninstall: scopes.has(SC.SKILL_UNINSTALL),
    approve: scopes.has(SC.SKILL_APPROVE),
  }
}

export function registerSkillRoutes(app: FastifyInstance, deps: ServerDeps): void {
  /* ---------------- 员工个人技能 ---------------- */

  app.get('/api/my/skills', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.SKILL_LIST)
    const skills = loadPersonalSkills(deps.db, subject.companyId, subject.userId)
    return ok({
      companyId: subject.companyId,
      permissions: skillPermissions(subject.scopes),
      skills: skills.map((skill) => serializeSkill(skill)),
      stats: {
        installed: skills.length,
        enabled: skills.filter((skill) => skill.enabled).length,
        valid: skills.filter((skill) => skill.valid).length,
        blocked: skills.filter((skill) => !skill.valid).length,
      },
      hint: '这里只显示你本人安装的技能。技能不执行任意脚本；安装与每次加载都会做静态安全扫描和 checksum 校验，高风险包会被拦截并写入 .quarantine 记录。',
    })
  })

  app.post('/api/my/skills/install', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.SKILL_INSTALL)
    const body = (req.body ?? {}) as SkillInstallBody
    const staged = await stageSkillInstallSource(body, 'personal')
    try {
      const overwrite = body.overwrite === true
      const baseOptions = {
        companyId: subject.companyId,
        installedBy: subject.userId,
        scope: 'user' as const,
        userId: subject.userId,
        overwrite,
        source: staged.source,
        sourceRef: staged.sourceRef,
      }
      let approvalId: string | undefined
      let approvedChecksum: string | undefined
      if (companySkillPolicy(deps.db, subject.companyId).requirePersonalInstallApproval) {
        const preview = previewSkillInstall(deps.db, staged.dir, baseOptions)
        if (preview.alreadyInstalled && !overwrite) {
          throw new EabError(EC.CONFLICT, `技能已存在：${preview.skillId}；如需覆盖请显式选择覆盖`)
        }
        const approval = ensureSkillInstallApproval(deps.db, {
          companyId: subject.companyId,
          requesterUserId: subject.userId,
          scope: 'user',
          skillId: preview.skillId,
          skillName: preview.name,
          version: preview.version,
          checksum: preview.checksum,
          overwrite,
          sourceRef: staged.sourceRef,
        })
        if (approval.status !== 'approved') {
          throw new EabError(
            EC.APPROVAL_REQUIRED,
            `个人技能安装按公司策略需要管理员审批（审批单 ${approval.approvalId}）。管理员在控制台「审批」页通过后，重新提交同一技能来源即可继续安装。`,
            {
              details: {
                approvalId: approval.approvalId,
                skillId: preview.skillId,
                checksum: preview.checksum,
                scope: 'user',
              },
            },
          )
        }
        approvalId = approval.approvalId
        approvedChecksum = preview.checksum
      }
      const result = installSkillPackage(deps.db, staged.dir, {
        ...baseOptions,
        expectedChecksum: approvedChecksum,
        approvalId,
      })
      return ok({
        skill: serializeSkill(result.skill),
        replaced: result.replaced,
        fileCount: staged.fileCount ?? null,
        bytes: staged.bytes ?? null,
        approvalId: approvalId ?? null,
      })
    } finally {
      staged.cleanup()
    }
  })

  app.post<{ Params: { id: string } }>('/api/my/skills/:id/state', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.SKILL_CONFIGURE)
    const enabled = (req.body as { enabled?: boolean } | null)?.enabled !== false
    setPersonalSkillEnabled(deps.db, {
      companyId: subject.companyId,
      userId: subject.userId,
      skillId: req.params.id,
      enabled,
      actorId: subject.userId,
    })
    const skill = loadPersonalSkills(deps.db, subject.companyId, subject.userId).find((item) => item.id === req.params.id)
    return ok({ id: req.params.id, enabled, skill: skill ? serializeSkill(skill) : null })
  })

  app.delete<{ Params: { id: string } }>('/api/my/skills/:id', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.SKILL_UNINSTALL)
    uninstallPersonalSkill(deps.db, {
      companyId: subject.companyId,
      userId: subject.userId,
      skillId: req.params.id,
      actorId: subject.userId,
    })
    return ok({ id: req.params.id, uninstalled: true })
  })

  /** 当前员工真正可用的技能：公司启用 + 本人启用，已重扫且 checksum 一致。 */
  app.get('/api/skills', async (req) => {
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.SKILL_LIST)
    const skills = loadSkillsForActor(deps.db, subject.companyId, subject.userId)
    return ok({
      skills: skills.map((skill) => serializeSkill(skill)),
      enabled: skills.filter((skill) => skill.enabled && skill.valid).length,
      permissions: skillPermissions(subject.scopes),
    })
  })

  /* ---------------- 服务器侧控制台：公司级技能 ---------------- */

  app.get('/api/console/skills', async (req) => {
    ensureConsole(req, deps)
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.SKILL_LIST)
    const artifacts = listSkillArtifacts(deps.db)
    const companySkills = loadCompanySkills(deps.db, subject.companyId)
    const companyById = new Map(companySkills.map((skill) => [skill.id, skill]))
    const adminPersonalSkills = loadAdminPersonalSkills(deps.db, subject.companyId)
    const personalUsers = new Set(adminPersonalSkills.map((item) => item.userId))
    const events = deps.db
      .prepare('SELECT * FROM skill_events WHERE company_id = ? ORDER BY at DESC LIMIT 40')
      .all(subject.companyId) as Array<Record<string, unknown>>
    return ok({
      companyId: subject.companyId,
      permissions: skillPermissions(subject.scopes),
      policy: {
        ...companySkillPolicy(deps.db, subject.companyId),
        hint: '公司总开关关闭后，员工聊天不会注入任何技能；已安装列表仍可查看。个人安装审批开启后，个人技能包也需要管理员审批。',
      },
      skills: artifacts.map((skill) => {
        const installed = companyById.get(skill.id)
        return {
          ...serializeSkill(installed ?? skill, true),
          companyInstalled: Boolean(installed),
          companyEnabled: installed?.enabled ?? false,
        }
      }),
      /** 个人技能：按员工归属只读展示，不进入上面的公司安装列表，也不允许控制台操作。 */
      personalSkills: adminPersonalSkills.map((item) => {
        const serialized = serializeSkill(item.skill, false)
        const installedAt = item.installedAt
        const updatedAt = item.updatedAt
        return {
          key: item.key,
          userId: item.userId,
          userName: item.userName,
          ...serialized,
          installedAt,
          updatedAt,
          install: { ...serialized.install, installedAt, updatedAt },
        }
      }),
      stats: {
        personalInstalled: adminPersonalSkills.length,
        personalEnabled: adminPersonalSkills.filter((item) => item.skill.valid && item.skill.enabled).length,
        personalUsers: personalUsers.size,
      },
      quarantine: listQuarantineEntries(20),
      audit: {
        ...skillAuditHealth(deps.db),
        degraded: listSkillAuditDegraded(deps.db, 20),
      },
      events: events.map((event) => ({
        id: event.id,
        skillId: event.skill_id,
        event: event.event,
        userId: event.user_id,
        actorId: event.actor_id,
        detail: event.detail ? JSON.parse(String(event.detail)) : null,
        at: event.at,
      })),
      hint: '技能由服务器侧控制台安装。安装前会扫描 skill.json、SKILL.md、references 与页面文件；命中破坏命令、代码执行、凭证读取、外发、提权、持久化、提示词注入或越权 scope 时拒绝安装，并写入 skills/.quarantine。',
    })
  })

  app.post('/api/console/skills/install', async (req) => {
    ensureConsole(req, deps)
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.SKILL_INSTALL)
    const body = (req.body ?? {}) as SkillInstallBody
    const staged = await stageSkillInstallSource(body, 'console')
    try {
      const overwrite = body.overwrite === true
      const baseOptions = {
        companyId: subject.companyId,
        installedBy: subject.userId,
        scope: 'company' as const,
        overwrite,
        source: staged.source,
        sourceRef: staged.sourceRef,
      }
      const preview = previewSkillInstall(deps.db, staged.dir, baseOptions)
      if (preview.alreadyInstalled && !overwrite) {
        throw new EabError(EC.CONFLICT, `技能已存在：${preview.skillId}；如需覆盖请显式选择覆盖`)
      }
      const approval = ensureSkillInstallApproval(deps.db, {
        companyId: subject.companyId,
        requesterUserId: subject.userId,
        scope: 'company',
        skillId: preview.skillId,
        skillName: preview.name,
        version: preview.version,
        checksum: preview.checksum,
        overwrite,
        sourcePath: staged.source === 'server-path' ? staged.dir : null,
        sourceRef: staged.sourceRef,
      })
      if (approval.status !== 'approved') {
        throw new EabError(
          EC.APPROVAL_REQUIRED,
          `公司级技能安装需要管理员审批（审批单 ${approval.approvalId}）。管理员在控制台「审批」页通过后，重新提交同一技能来源即可继续安装。`,
          {
            details: {
              approvalId: approval.approvalId,
              skillId: preview.skillId,
              checksum: preview.checksum,
              scope: 'company',
            },
          },
        )
      }
      const result = installSkillPackage(deps.db, staged.dir, {
        ...baseOptions,
        expectedChecksum: preview.checksum,
        approvalId: approval.approvalId,
      })
      return ok({
        skill: serializeSkill(result.skill, true),
        replaced: result.replaced,
        approvalId: approval.approvalId,
      })
    } finally {
      staged.cleanup()
    }
  })

  /** S6.5 隔离记录：只读元数据，不读取隔离包正文。 */
  app.get('/api/console/skills/quarantine', async (req) => {
    ensureConsole(req, deps)
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.SKILL_LIST)
    const entries = listQuarantineEntries(100)
    return ok({
      count: entries.length,
      entries,
      hint: '只展示隔离元数据；危险包原文不进入数据库，也不通过接口回传。',
    })
  })

  /** S6.5 管理员复核/删除隔离元数据；不提供“还原执行”，因为危险包正文未保留。 */
  app.post<{ Body: { file?: unknown; action?: unknown; note?: unknown } }>(
    '/api/console/skills/quarantine/review',
    async (req) => {
      ensureConsole(req, deps)
      const { subject } = resolveActor(deps.db, deps.config, req)
      requireScope(subject, SC.SKILL_APPROVE)
      const body = (req.body ?? {}) as { file?: unknown; action?: unknown; note?: unknown }
      const file = typeof body.file === 'string' ? body.file : ''
      const action = body.action === 'delete' ? 'delete' : body.action === 'acknowledge' ? 'acknowledge' : null
      if (!file || !action) throw new EabError(EC.VALIDATION, 'file 和 action（acknowledge/delete）必填')
      const note = typeof body.note === 'string' ? body.note : null
      const result = reviewQuarantineEntry(deps.db, {
        companyId: subject.companyId,
        actorId: subject.userId,
        file,
        action,
        note,
      })
      return ok({
        ...result,
        hint:
          result.action === 'delete'
            ? '隔离元数据已删除；危险包正文从未保留，不能从此处还原执行。如需该技能，请重新提供完整包并重新扫描。'
            : '已标记为人工复核完成；隔离记录仍保留，供审计追查。',
      })
    },
  )

  /** S6.4 公司级技能总开关 + S7.2 个人安装审批策略。 */
  app.post('/api/console/skills/policy', async (req) => {
    ensureConsole(req, deps)
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.SKILL_CONFIGURE)
    const body = (req.body ?? {}) as { enabled?: unknown; requirePersonalInstallApproval?: unknown }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      throw new EabError(EC.VALIDATION, 'enabled 必须是布尔值')
    }
    if (body.requirePersonalInstallApproval !== undefined && typeof body.requirePersonalInstallApproval !== 'boolean') {
      throw new EabError(EC.VALIDATION, 'requirePersonalInstallApproval 必须是布尔值')
    }
    if (body.enabled === undefined && body.requirePersonalInstallApproval === undefined) {
      throw new EabError(EC.VALIDATION, '至少提供 enabled 或 requirePersonalInstallApproval')
    }
    const policy = setCompanySkillPolicy(deps.db, {
      companyId: subject.companyId,
      enabled: body.enabled as boolean | undefined,
      requirePersonalInstallApproval: body.requirePersonalInstallApproval as boolean | undefined,
      actorId: subject.userId,
    })
    return ok({
      ...policy,
      hint: policy.enabled ? '公司技能已启用，聊天会按安装与启用状态注入技能。' : '公司技能已停用，聊天不会注入任何技能。',
    })
  })

  app.post<{ Params: { id: string } }>('/api/console/skills/:id/state', async (req) => {
    ensureConsole(req, deps)
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.SKILL_CONFIGURE)
    const enabled = (req.body as { enabled?: boolean } | null)?.enabled !== false
    setCompanySkillEnabled(deps.db, {
      companyId: subject.companyId,
      skillId: req.params.id,
      enabled,
      actorId: subject.userId,
    })
    return ok({ id: req.params.id, enabled })
  })

  app.delete<{ Params: { id: string } }>('/api/console/skills/:id', async (req) => {
    ensureConsole(req, deps)
    const { subject } = resolveActor(deps.db, deps.config, req)
    requireScope(subject, SC.SKILL_UNINSTALL)
    uninstallCompanySkill(deps.db, {
      companyId: subject.companyId,
      skillId: req.params.id,
      actorId: subject.userId,
    })
    return ok({ id: req.params.id, uninstalled: true })
  })
}
