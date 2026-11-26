/**
 * 项目文件操作的统一入口。
 *
 * 新项目绑定桌面设备，所有文件操作经 desktopBridge 派给客户端电脑执行；
 * 未绑定设备的历史项目继续使用服务端本机目录，保持兼容。
 */
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { EC, EabError } from '@eab/domain'
import type { ServerDeps } from './deps.js'
import type { LocalProject } from './local-project.js'
import {
  isSensitiveLocalPath,
  listLocalProjectEntries,
  localProjectRelPath,
  resolveLocalProjectPath,
} from './local-project.js'
import { readTextFileRange, searchWorkspaceText, type TextRangeResult, type TextSearchResult } from './workspace-text.js'
import { applyWorkspaceTextEdits, buildWorkspaceEditDiff, type WorkspaceEditDiff, type WorkspaceTextEdit } from './routes/workspace.js'

function bridge(deps: ServerDeps) {
  if (!deps.desktopBridge) {
    throw new EabError(EC.CONFLICT, '服务端未启用桌面文件桥')
  }
  return deps.desktopBridge
}

function bridgeFailure(message: string): never {
  throw new EabError(EC.CONFLICT, message, {
    hint: '请保持安装 EAB 桌面端的电脑开机并打开应用；项目的本地路径只存在于那台电脑。',
  })
}

function assertBridgeProject(project: LocalProject, companyId: string, userId: string): string {
  if (!project.deviceId) bridgeFailure('当前项目没有绑定桌面设备')
  if (!companyId || !userId) bridgeFailure('当前账号状态无效')
  return project.deviceId
}

/** 创建项目时在客户端校验目录；返回值是该电脑上的真实路径。 */
export async function describeDesktopRoot(
  deps: ServerDeps,
  companyId: string,
  userId: string,
  deviceId: string,
  rootPath: string,
): Promise<{ rootPath: string; rootRealPath: string; name: string }> {
  const data = await bridge(deps).call<{ rootPath: string; rootRealPath: string; name: string }>(
    companyId,
    userId,
    deviceId,
    'describeRoot',
    '',
    { path: rootPath },
    20_000,
  )
  if (!data?.rootRealPath) throw new EabError(EC.VALIDATION, '桌面端没有返回有效项目目录')
  return data
}

export async function listProjectEntries(
  deps: ServerDeps,
  project: LocalProject,
  companyId: string,
  userId: string,
  rawPath: unknown,
  options: { depth?: number; limit?: number } = {},
): Promise<{ path: string; entries: unknown[]; truncated: boolean; total: number }> {
  if (!project.deviceId) return listLocalProjectEntries(project, rawPath, options)
  return bridge(deps).call(
    companyId,
    userId,
    assertBridgeProject(project, companyId, userId),
    'list',
    project.id,
    {
      path: String(rawPath ?? ''),
      depth: options.depth,
      limit: options.limit,
      allowSensitive: project.allowSensitive,
    },
    20_000,
  )
}

export async function readProjectText(
  deps: ServerDeps,
  project: LocalProject,
  companyId: string,
  userId: string,
  rawPath: unknown,
  options: { offset?: number; limit?: number } = {},
): Promise<TextRangeResult & { path: string }> {
  if (project.deviceId) {
    const data = await bridge(deps).call<TextRangeResult & { path: string }>(
      companyId,
      userId,
      assertBridgeProject(project, companyId, userId),
      'read',
      project.id,
      {
        path: String(rawPath ?? ''),
        offset: options.offset,
        limit: options.limit,
        allowSensitive: project.allowSensitive,
      },
      30_000,
    )
    if (!data?.path) throw new EabError(EC.INTERNAL, '桌面端读取结果缺少路径')
    return data
  }
  const target = resolveLocalProjectPath(project, rawPath)
  if (!existsSync(target)) throw new EabError(EC.NOT_FOUND, `项目文件不存在：${String(rawPath ?? '')}`)
  if (!statSync(target).isFile()) throw new EabError(EC.VALIDATION, 'project.read 只能读取文件')
  const range = readTextFileRange(target, options)
  return { ...range, path: localProjectRelPath(project, target) }
}

export async function searchProjectText(
  deps: ServerDeps,
  project: LocalProject,
  companyId: string,
  userId: string,
  rawPath: unknown,
  options: {
    query: string
    maxResults?: number
    regex?: boolean
    caseSensitive?: boolean
    skipPath?: (relPath: string) => boolean
  },
): Promise<TextSearchResult & { project: string }> {
  if (project.deviceId) {
    const data = await bridge(deps).call<TextSearchResult>(
      companyId,
      userId,
      assertBridgeProject(project, companyId, userId),
      'search',
      project.id,
      {
        path: String(rawPath ?? ''),
        query: options.query,
        maxResults: options.maxResults,
        regex: options.regex,
        caseSensitive: options.caseSensitive,
        allowSensitive: project.allowSensitive,
      },
      60_000,
    )
    return { ...data, project: project.name } as TextSearchResult & { project: string }
  }
  const target = resolveLocalProjectPath(project, rawPath ?? '')
  if (!existsSync(target)) throw new EabError(EC.NOT_FOUND, `项目路径不存在：${String(rawPath ?? '')}`)
  const search = searchWorkspaceText(project.rootRealPath, target, {
    ...options,
    skipPath: options.skipPath ?? ((relPath) => isSensitiveLocalPath(relPath)),
  })
  return { ...search, project: project.name } as TextSearchResult & { project: string }
}

export async function writeProjectText(
  deps: ServerDeps,
  project: LocalProject,
  companyId: string,
  userId: string,
  rawPath: string,
  text: string,
): Promise<{ path: string; size: number; created: boolean; overwritten: boolean }> {
  assertWritableTextFile(rawPath, text)
  if (project.deviceId) {
    return bridge(deps).call(
      companyId,
      userId,
      assertBridgeProject(project, companyId, userId),
      'write',
      project.id,
      {
        path: rawPath,
        text,
        mode: project.mode,
        allowSensitive: project.allowSensitive,
      },
      30_000,
    )
  }
  if (project.mode === 'read_only') throw new EabError(EC.FORBIDDEN, '当前项目是只读模式')
  const target = resolveLocalProjectPath(project, rawPath)
  if (existsSync(target) && !statSync(target).isFile()) {
    throw new EabError(EC.VALIDATION, '目标路径已经是目录')
  }
  const existed = existsSync(target)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text, 'utf8')
  return {
    path: localProjectRelPath(project, target),
    size: Buffer.byteLength(text, 'utf8'),
    created: !existed,
    overwritten: existed,
  }
}

export async function editProjectText(
  deps: ServerDeps,
  project: LocalProject,
  companyId: string,
  userId: string,
  rawPath: string,
  edits: readonly WorkspaceTextEdit[],
): Promise<{
  path: string
  size: number
  changes: number
  matchedEdits: number
  edited: true
  diff: WorkspaceEditDiff
}> {
  if (project.deviceId) {
    const data = await bridge(deps).call<{ path: string; size: number; changes: number; matchedEdits: number; edited: true }>(
      companyId,
      userId,
      assertBridgeProject(project, companyId, userId),
      'edit',
      project.id,
      {
        path: rawPath,
        edits,
        mode: project.mode,
        allowSensitive: project.allowSensitive,
      },
      30_000,
    )
    return { ...data, diff: buildWorkspaceEditDiff(edits) }
  }
  if (project.mode === 'read_only') throw new EabError(EC.FORBIDDEN, '当前项目是只读模式')
  const target = resolveLocalProjectPath(project, rawPath)
  if (!existsSync(target)) throw new EabError(EC.NOT_FOUND, '要修改的文件不存在', { hint: '新文件请先用 project.write 创建' })
  if (!statSync(target).isFile()) throw new EabError(EC.VALIDATION, 'project.edit 只能修改文件')
  const source = readFileSync(target, 'utf8')
  if (Buffer.byteLength(source, 'utf8') > 5 * 1024 * 1024) {
    throw new EabError(EC.VALIDATION, '文件超过 5 MB，暂不支持局部编辑')
  }
  const applied = applyWorkspaceTextEdits(source, edits)
  writeFileSync(target, applied.text, 'utf8')
  return {
    path: localProjectRelPath(project, target),
    size: Buffer.byteLength(applied.text, 'utf8'),
    ...applied,
    edited: true,
    diff: buildWorkspaceEditDiff(edits),
  }
}

export async function deleteProjectEntry(
  deps: ServerDeps,
  project: LocalProject,
  companyId: string,
  userId: string,
  rawPath: unknown,
): Promise<{ path: string; deleted: true; size: number }> {
  const value = String(rawPath ?? '').trim()
  if (!value) throw new EabError(EC.VALIDATION, 'path 不能为空')
  if (project.deviceId) {
    return bridge(deps).call(
      companyId,
      userId,
      assertBridgeProject(project, companyId, userId),
      'delete',
      project.id,
      {
        path: value,
        mode: project.mode,
        allowSensitive: project.allowSensitive,
      },
      30_000,
    )
  }
  if (project.mode === 'read_only') throw new EabError(EC.FORBIDDEN, '当前项目是只读模式')
  const target = resolveLocalProjectPath(project, value)
  if (!existsSync(target)) throw new EabError(EC.NOT_FOUND, `项目文件不存在：${value}`)
  const info = statSync(target)
  if (!info.isFile()) throw new EabError(EC.VALIDATION, 'project.delete 只能删除文件，目录请手动处理')
  unlinkSync(target)
  return { path: localProjectRelPath(project, target), deleted: true, size: info.size }
}

export function assertWritableTextFile(rawPath: string, text: string): void {
  const value = String(rawPath ?? '').trim()
  if (!value) throw new EabError(EC.VALIDATION, 'path 不能为空')
  if (Buffer.byteLength(text, 'utf8') > 5 * 1024 * 1024) {
    throw new EabError(EC.VALIDATION, '单文件最大 5 MB，超过时请拆分')
  }
  const ext = extname(value).toLowerCase()
  if (['.doc', '.docx', '.docm', '.xls', '.xlsx', '.xlsm', '.ppt', '.pptx', '.pptm'].includes(ext)) {
    throw new EabError(EC.VALIDATION, `project.write 不支持直接生成二进制 ${ext} 文件`, {
      hint: '请使用文本格式，或在项目里用 project.exec 运行生成脚本。',
    })
  }
}
