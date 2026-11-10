/**
 * 权限谓词 AST。
 *
 * 设计意图：权限过滤不能停留在"内存里 filter 数组"，必须先变成可下推到数据库的表达式。
 * 这个 AST 是"唯一中间表示"——同一份谓词既能编译成 SQL（生产），也能在内存里求值（测试/内存仓储）。
 * 好处：测试验证的过滤逻辑与生产跑的过滤逻辑是同一份，不会出现"测试过了线上漏"。
 */

export type PredicateValue = string | number | boolean

export type Predicate =
  | { readonly kind: 'true' }
  | { readonly kind: 'false' }
  | { readonly kind: 'eq'; readonly field: string; readonly value: PredicateValue }
  | { readonly kind: 'in'; readonly field: string; readonly values: readonly PredicateValue[] }
  /** 前缀匹配（部门物化路径这类层级字段用） */
  | { readonly kind: 'prefix'; readonly field: string; readonly value: string }
  | { readonly kind: 'and'; readonly items: readonly Predicate[] }
  | { readonly kind: 'or'; readonly items: readonly Predicate[] }

export const P = {
  TRUE: { kind: 'true' } as Predicate,
  FALSE: { kind: 'false' } as Predicate,

  eq(field: string, value: PredicateValue): Predicate {
    return { kind: 'eq', field, value }
  },

  in(field: string, values: readonly PredicateValue[]): Predicate {
    // 空集合等价于恒假：绝不能返回 TRUE（那是"无过滤"的意思，会漏数据）
    if (values.length === 0) return { kind: 'false' }
    return { kind: 'in', field, values }
  },

  prefix(field: string, value: string): Predicate {
    return { kind: 'prefix', field, value }
  },

  and(...items: readonly Predicate[]): Predicate {
    const flattened: Predicate[] = []
    for (const item of items) {
      if (item.kind === 'false') return { kind: 'false' }
      if (item.kind === 'true') continue
      if (item.kind === 'and') flattened.push(...item.items)
      else flattened.push(item)
    }
    if (flattened.length === 0) return { kind: 'true' }
    if (flattened.length === 1) return flattened[0] as Predicate
    return { kind: 'and', items: flattened }
  },

  or(...items: readonly Predicate[]): Predicate {
    const flattened: Predicate[] = []
    for (const item of items) {
      if (item.kind === 'true') return { kind: 'true' }
      if (item.kind === 'false') continue
      if (item.kind === 'or') flattened.push(...item.items)
      else flattened.push(item)
    }
    if (flattened.length === 0) return { kind: 'false' }
    if (flattened.length === 1) return flattened[0] as Predicate
    return { kind: 'or', items: flattened }
  },
}

export type Row = Record<string, unknown>

/**
 * 内存求值器。
 * 用于单测、内存仓储与"后置复检"（知识库 Provider 返回后再验一次权限）。
 */
export function evaluatePredicate(predicate: Predicate, row: Row): boolean {
  switch (predicate.kind) {
    case 'true':
      return true
    case 'false':
      return false
    case 'eq':
      return normalizeValue(row[predicate.field]) === normalizeValue(predicate.value)
    case 'in':
      return predicate.values.some((v) => normalizeValue(v) === normalizeValue(row[predicate.field]))
    case 'prefix': {
      const actual = row[predicate.field]
      return typeof actual === 'string' && actual.startsWith(predicate.value)
    }
    case 'and':
      return predicate.items.every((item) => evaluatePredicate(item, row))
    case 'or':
      return predicate.items.some((item) => evaluatePredicate(item, row))
    default: {
      // 穷尽性检查：新增 kind 时必须在这里加上分支
      const never: never = predicate
      throw new TypeError(`未支持的谓词类型: ${JSON.stringify(never)}`)
    }
  }
}

function normalizeValue(value: unknown): string | number | boolean | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value
  return String(value)
}

/** 列出谓词里引用到的字段（用于 SQL 编译时的字段白名单校验） */
export function predicateFields(predicate: Predicate): string[] {
  switch (predicate.kind) {
    case 'true':
    case 'false':
      return []
    case 'eq':
    case 'prefix':
      return [predicate.field]
    case 'in':
      return [predicate.field]
    case 'and':
    case 'or':
      return predicate.items.flatMap(predicateFields)
    default: {
      const never: never = predicate
      throw new TypeError(`未支持的谓词类型: ${JSON.stringify(never)}`)
    }
  }
}
