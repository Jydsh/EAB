import { describe, expect, it } from 'vitest'
import { isWithinRoot, normalizeRelativePath, safeJoin, toSlug } from '@eab/workspace'

const UNSAFE: Array<[string, string]> = [
  ['../etc/passwd', '上级目录'],
  ['a/../../b', '中层穿越'],
  ['/abs/path', '绝对路径'],
  ['C:\\Windows\\System32', '盘符'],
  ['c:relative', '盘符相对'],
  ['\\\\server\\share\\x', 'UNC'],
  ['//server/share/x', 'UNC 正斜杠'],
  ['file:///etc/passwd', '协议前缀'],
  ['a/%2e%2e/b', 'URL 编码穿越'],
  ['..%2f..%2fetc', '编码斜杠穿越'],
  ['CON', 'Windows 保留名'],
  ['con.txt', '保留名带扩展名'],
  ['dir/PRN/', '子目录里的保留名'],
  ['COM1.log', '串口保留名'],
  ['a.txt:stream', '目录流 ADS'],
  ['trailing./x', '段以点结尾'],
  ['a /b', '段首空格'],
  ['nul\u0000byte', '控制字符'],
  ['', '空路径'],
  ['x'.repeat(130), '单段过长'],
  ['abcdefghij/'.repeat(30), '路径过长'],
]

const SAFE: Array<[string, string]> = [
  ['files/report.pdf', '普通相对路径'],
  ['a/b/c.txt', '多级'],
  ['./a/b.txt', '点前缀'],
  ['中文/文档.pdf', '中文路径'],
  ['a//b.txt', '重复斜杠折叠'],
  ['dir/.hidden', '隐藏文件'],
  ['A-B_c.txt', '常见字符集'],
  ['a\\b.txt', '反斜杠统一'],
]

describe('normalizeRelativePath', () => {
  for (const [input, why] of UNSAFE) {
    it(`拒绝：${why}`, () => {
      expect(() => normalizeRelativePath(input)).toThrow()
    })
  }

  for (const [input, why] of SAFE) {
    it(`接受：${why}`, () => {
      const normalized = normalizeRelativePath(input)
      expect(normalized).not.toContain('..')
      expect(normalized.startsWith('/')).toBe(false)
    })
  }

  it('规范化结果统一为正斜杠且无点段', () => {
    expect(normalizeRelativePath('./a//b.txt')).toBe('a/b.txt')
    expect(normalizeRelativePath('a\\b\\c.txt')).toBe('a/b/c.txt')
  })
})

describe('safeJoin / isWithinRoot', () => {
  const root = 'D:/EAB/workspace/u1'

  it('正常拼接', () => {
    const target = safeJoin(root, 'files/a.txt')
    expect(isWithinRoot(root, target)).toBe(true)
    expect(target.toLowerCase()).toContain('u1')
  })

  it('拒绝穿越（双保险：normalize 已拦住，join 再拦一次）', () => {
    expect(() => safeJoin(root, '../../other-company/file.txt')).toThrow()
  })

  it('拒绝绝对路径', () => {
    expect(() => safeJoin(root, '/etc/passwd')).toThrow()
  })

  it('isWithinRoot 识别越界', () => {
    expect(isWithinRoot('D:/EAB/workspace/u1', 'D:/EAB/workspace/u2/a.txt')).toBe(false)
    expect(isWithinRoot('D:/EAB/workspace/u1', 'D:/EAB/workspace/u1/a.txt')).toBe(true)
  })
})

describe('toSlug', () => {
  it('清洗成目录安全字符', () => {
    expect(toSlug('HR 人力资源部')).toBe('hr')
    expect(toSlug('研发部/前端组')).toBe('x')
    expect(toSlug('A_B C')).toBe('a-b-c')
    expect(toSlug('', 'unknown')).toBe('unknown')
  })

  it('长度受限', () => {
    expect(toSlug('a'.repeat(80)).length).toBeLessThanOrEqual(40)
  })
})
