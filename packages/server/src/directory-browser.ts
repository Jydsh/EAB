/**
 * 控制台「服务器目录浏览」只读接口的实现。
 *
 * 只列出目录，不读取文件内容；目录是否可写、是否为空仍由存储保存接口校验。
 * 远程管理后台访问的是服务器文件系统，而不是浏览器所在电脑的文件系统。
 */
import { readdirSync, statSync } from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { EC, EabError } from '@eab/domain'

export type DirectoryEntry = { name: string; path: string }
export type DirectoryListing = {
  path: string
  parent: string | null
  roots: DirectoryEntry[]
  entries: DirectoryEntry[]
  truncated: boolean
  total: number
}

const MAX_ENTRIES = 600

function roots(): DirectoryEntry[] {
  if (process.platform !== 'win32') return [{ name: '/', path: '/' }]
  const found: DirectoryEntry[] = []
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`
    try {
      if (statSync(drive).isDirectory()) found.push({ name: `${drive.slice(0, 2)}`, path: drive })
    } catch {
      // 未挂载/不可访问的盘符跳过
    }
  }
  return found
}

function parentDirectory(target: string): string | null {
  const normalized = target.replace(/[\\/]+$/, '')
  if (!normalized) return null
  const parent = dirname(normalized)
  if (!parent || parent === normalized) return null
  return parent
}

/** 列出服务器上的目录；input 为空时只返回可用磁盘根。 */
export function listServerDirectories(input: string): DirectoryListing {
  const raw = String(input ?? '').trim()
  if (raw.includes('\0')) throw new EabError(EC.VALIDATION, '目录路径包含非法字符')
  const rootsList = roots()
  if (!raw) {
    return { path: '', parent: null, roots: rootsList, entries: [], truncated: false, total: 0 }
  }
  if (!isAbsolute(raw)) {
    throw new EabError(EC.VALIDATION, '目录必须是服务器上的绝对路径')
  }

  const target = resolve(raw)
  let stat: Stats
  try {
    stat = statSync(target)
  } catch {
    throw new EabError(EC.VALIDATION, '目录不存在或无法访问')
  }
  if (!stat.isDirectory()) throw new EabError(EC.VALIDATION, '所选路径不是目录')

  let dirents: Dirent[]
  try {
    dirents = readdirSync(target, { withFileTypes: true })
  } catch {
    throw new EabError(EC.VALIDATION, '目录无法读取，请检查服务器权限')
  }

  const entries = dirents
    .filter((item) => item.isDirectory())
    .map((item) => ({ name: item.name, path: resolve(target, item.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

  return {
    path: target,
    parent: parentDirectory(target),
    roots: rootsList,
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: entries.length > MAX_ENTRIES,
    total: entries.length,
  }
}
