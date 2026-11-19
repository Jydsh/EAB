import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { countTextLines, isTextEditableFile, readTextFileRange, searchWorkspaceText } from '../src/workspace-text.js'

const dir = mkdtempSync(join(tmpdir(), 'eab-workspace-text-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('工作区文本按行读取', () => {
  it('按行返回中段，并保留原始 CRLF', () => {
    const file = join(dir, 'sample.ts')
    writeFileSync(file, 'line1\r\nline2\r\nline3\r\nline4\r\n')
    const range = readTextFileRange(file, { offset: 2, limit: 2 })
    expect(range.text).toBe('line2\r\nline3\r\n')
    expect(range.startLine).toBe(2)
    expect(range.endLine).toBe(3)
    expect(range.totalLines).toBe(4)
    expect(range.truncated).toBe(true)
  })

  it('读取末尾没有换行的最后一行', () => {
    const file = join(dir, 'tail.txt')
    writeFileSync(file, 'a\nb\nc')
    const range = readTextFileRange(file, { offset: 3, limit: 10 })
    expect(range.text).toBe('c')
    expect(range.endLine).toBe(3)
    expect(range.totalLines).toBe(3)
    expect(range.truncated).toBe(false)
  })

  it('起始行超过总行数时明确报错', () => {
    const file = join(dir, 'short.txt')
    writeFileSync(file, 'only\n')
    expect(() => readTextFileRange(file, { offset: 5, limit: 10 })).toThrow(/offset 5 超出文件总行数 1/)
  })

  it('输出达到 50 KB 字节上限时提前截止并给出 nextOffset', () => {
    const file = join(dir, 'wide.txt')
    writeFileSync(file, Array.from({ length: 40 }, () => 'x'.repeat(2_000)).join('\n'))
    const range = readTextFileRange(file, { limit: 40, maxOutputBytes: 10_000 })
    expect(range.truncatedByBytes).toBe(true)
    expect(range.truncated).toBe(true)
    expect(range.endLine).toBeLessThan(40)
    expect(range.nextOffset).toBe(range.endLine + 1)
    expect(Buffer.byteLength(range.text, 'utf8')).toBeLessThanOrEqual(10_000)
  })

  it('单行超过 2000 字符时截断并计数', () => {
    const file = join(dir, 'long-line.txt')
    writeFileSync(file, `${'a'.repeat(2_500)}\nnext\n`)
    const range = readTextFileRange(file, { limit: 2, maxLineChars: 2_000 })
    expect(range.longLines).toBe(1)
    expect(range.text).toContain('本行已截断')
    expect(range.text).toContain('next')
  })

  it('行数统计兼容空文件和末尾换行', () => {
    expect(countTextLines('')).toBe(0)
    expect(countTextLines('a\n')).toBe(1)
    expect(countTextLines('a\nb')).toBe(2)
  })
})

describe('工作区文本检索', () => {
  it('递归返回 path:line，且跳过 node_modules', () => {
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'src', 'app.ts'), 'const name = "张辉权"\nexport default name\n')
    writeFileSync(join(dir, 'node_modules', 'dep.js'), 'const name = "张辉权"\n')
    const result = searchWorkspaceText(dir, dir, { query: '张辉权' })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].path).toBe('src/app.ts')
    expect(result.matches[0].line).toBe(1)
    expect(result.matches[0].text).toContain('张辉权')
    expect(result.filesScanned).toBeGreaterThan(0)
  })

  it('支持正则和大小写敏感', () => {
    const file = join(dir, 'case.txt')
    writeFileSync(file, 'Alpha\nbeta\nALPHA\n')
    const insensitive = searchWorkspaceText(dir, file, { query: '^alpha$', regex: true })
    expect(insensitive.matches.map((item) => item.line)).toEqual([1, 3])
    const sensitive = searchWorkspaceText(dir, file, { query: '^Alpha$', regex: true, caseSensitive: true })
    expect(sensitive.matches.map((item) => item.line)).toEqual([1])
  })

  it('普通搜索默认不区分大小写并限制结果数量', () => {
    const file = join(dir, 'many.txt')
    writeFileSync(file, Array.from({ length: 10 }, () => 'Needle').join('\n'))
    const result = searchWorkspaceText(dir, file, { query: 'needle', maxResults: 3 })
    expect(result.matches).toHaveLength(3)
    expect(result.total).toBe(10)
    expect(result.truncated).toBe(true)
  })

  it('文件名查询也返回 nameMatches，并忽略文件名中的空格差异', () => {
    const file = join(dir, '检查整治_近半个月_343条.csv')
    writeFileSync(file, 'station,issue\nA,占道\n')
    const result = searchWorkspaceText(dir, dir, { query: '检查整治_近半个月_343 条.csv' })
    expect(result.total).toBe(0)
    expect(result.nameMatches).toEqual([
      { path: '检查整治_近半个月_343条.csv', name: '检查整治_近半个月_343条.csv' },
    ])
  })
})

describe('文本文件类型识别', () => {
  it('覆盖常见代码文件与扩展名缺失的构建文件', () => {
    expect(isTextEditableFile('src/main.go')).toBe(true)
    expect(isTextEditableFile('src/lib.rs')).toBe(true)
    expect(isTextEditableFile('src/App.java')).toBe(true)
    expect(isTextEditableFile('Dockerfile')).toBe(true)
    expect(isTextEditableFile('Makefile')).toBe(true)
    expect(isTextEditableFile('.env.local')).toBe(true)
    expect(isTextEditableFile('a.pdf')).toBe(false)
  })
})
