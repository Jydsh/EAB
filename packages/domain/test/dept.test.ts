import { describe, expect, it } from 'vitest'
import { buildDeptPath, deptChainOf, isPathWithin, normalizeDeptPath } from '@eab/domain'

describe('部门物化路径', () => {
  it('拼装与规范化', () => {
    expect(buildDeptPath('c1', ['d10', 'd23'])).toBe('/c1/d10/d23/')
    expect(normalizeDeptPath('c1/d10')).toBe('/c1/d10/')
    expect(normalizeDeptPath('/c1/d10/')).toBe('/c1/d10/')
    // 空段属于脏数据，直接拒绝而不是"帮忙修好"（避免路径语义被悄悄改写）
    expect(() => normalizeDeptPath('//c1//d10//')).toThrow()
  })

  it('祖先链含自身', () => {
    expect(deptChainOf('/c1/d10/d23/')).toEqual(['/c1/', '/c1/d10/', '/c1/d10/d23/'])
    expect(deptChainOf('/c1/')).toEqual(['/c1/'])
  })

  it('包含关系（前缀语义）', () => {
    expect(isPathWithin('/c1/d10/d23/', '/c1/d10/')).toBe(true)
    expect(isPathWithin('/c1/d10/', '/c1/d10/')).toBe(true)
    expect(isPathWithin('/c1/d10/', '/c1/d10/d23/')).toBe(false)
    // 关键：/c1/d10/ 不能误匹配 /c1/d100/
    expect(isPathWithin('/c1/d100/', '/c1/d10/')).toBe(false)
  })

  it('拒绝非法段', () => {
    expect(() => buildDeptPath('c1', ['d/10'])).toThrow()
    expect(() => buildDeptPath('', ['d10'])).toThrow()
    expect(() => normalizeDeptPath('')).toThrow()
    expect(() => normalizeDeptPath('c1//d10')).toThrow()
  })
})
