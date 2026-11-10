import { describe, expect, it } from 'vitest'
import { P, predicateToSql } from '@eab/authz'

describe('谓词 → SQL', () => {
  it('eq 走占位符', () => {
    const compiled = predicateToSql(P.eq('company_id', 'c1'))
    expect(compiled.sql).toBe('company_id = ?')
    expect(compiled.params).toEqual(['c1'])
  })

  it('in 展开为多个占位符', () => {
    const compiled = predicateToSql(P.in('scope_id', ['d1', 'd2']))
    expect(compiled.sql).toBe('scope_id IN (?, ?)')
    expect(compiled.params).toEqual(['d1', 'd2'])
  })

  it('空 in 退化为恒假（绝不能是恒真）', () => {
    const compiled = predicateToSql(P.in('scope_id', []))
    expect(compiled.sql).toBe('0 = 1')
    expect(compiled.params).toEqual([])
  })

  it('prefix 转义 % _ \\，避免部门路径被放大', () => {
    const compiled = predicateToSql(P.prefix('dept_path', '/c1/d_10/'))
    expect(compiled.sql).toContain("LIKE ? ESCAPE '\\'")
    expect(compiled.params).toEqual(['/c1/d\\_10/%'])
  })

  it('and / or 递归加括号', () => {
    const compiled = predicateToSql(
      P.and(P.eq('company_id', 'c1'), P.or(P.eq('scope_type', 'user'), P.eq('scope_type', 'dept'))),
    )
    expect(compiled.sql).toBe('(company_id = ?) AND ((scope_type = ?) OR (scope_type = ?))')
    expect(compiled.params).toEqual(['c1', 'user', 'dept'])
  })

  it('布尔值转 0/1', () => {
    const compiled = predicateToSql(P.eq('is_active', true))
    expect(compiled.params).toEqual([1])
  })

  it('拒绝注入式字段名', () => {
    expect(() => predicateToSql(P.eq("company_id = 'x' OR 1", 'c1'))).toThrow()
    expect(() => predicateToSql(P.eq('company id', 'c1'))).toThrow()
  })

  it('字段白名单之外一律拒绝', () => {
    const options = { allowedFields: ['company_id', 'dept_path'] }
    expect(() => predicateToSql(P.eq('owner_user_id', 'u1'), options)).toThrow()
    expect(() => predicateToSql(P.eq('company_id', 'c1'), options)).not.toThrow()
  })

  it('谓词化简：空 and 为真、空 or 为假', () => {
    expect(predicateToSql(P.and()).sql).toBe('1 = 1')
    expect(predicateToSql(P.or()).sql).toBe('0 = 1')
  })
})
