import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { listServerDirectories } from '../src/directory-browser.js'

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'eab-directory-browser-'))
  mkdirSync(join(home, 'alpha'))
  mkdirSync(join(home, 'zeta'))
  writeFileSync(join(home, 'note.txt'), 'x')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('服务器目录浏览', () => {
  it('只列出子目录，并返回当前路径与上级目录', () => {
    const listing = listServerDirectories(home)
    expect(listing.path).toBe(resolve(home))
    expect(listing.parent).toBe(resolve(home, '..'))
    expect(listing.entries.map((item) => item.name)).toEqual(['alpha', 'zeta'])
    expect(listing.entries.some((item) => item.name === 'note.txt')).toBe(false)
  })

  it('空路径返回服务器磁盘根', () => {
    const listing = listServerDirectories('')
    expect(listing.path).toBe('')
    expect(listing.parent).toBeNull()
    expect(listing.roots.length).toBeGreaterThan(0)
    expect(listing.entries).toEqual([])
  })

  it('拒绝相对路径和文件路径', () => {
    expect(() => listServerDirectories('relative\\path')).toThrow('绝对路径')
    expect(() => listServerDirectories(join(home, 'note.txt'))).toThrow('不是目录')
  })
})
