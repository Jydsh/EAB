/**
 * 谓词 → SQL 片段。
 *
 * 安全约束：
 * 1. 字段名只允许 `snake_case` 形态（正则），且可再传 allowedFields 做白名单——杜绝拼接注入。
 * 2. 所有值一律走参数占位符（?），不做字符串插值。
 * 3. LIKE 的 `%` / `_` / `\` 必须转义，否则部门路径里出现下划线会导致范围放大。
 */
import { EC, EabError } from '@eab/domain'
import type { Predicate, PredicateValue } from './predicate.js'

export interface CompiledSql {
  readonly sql: string
  readonly params: readonly unknown[]
}

export interface CompileOptions {
  /** 允许出现的字段白名单（由各表的 schema 提供） */
  readonly allowedFields?: readonly string[]
}

const FIELD_PATTERN = /^[a-z][a-z0-9_]*$/

function assertField(field: string, options: CompileOptions): void {
  if (!FIELD_PATTERN.test(field)) {
    throw new EabError(EC.INTERNAL, `非法字段名: ${field}`, { details: { field } })
  }
  if (options.allowedFields && !options.allowedFields.includes(field)) {
    throw new EabError(EC.INTERNAL, `字段不在白名单内: ${field}`, { details: { field } })
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

function toParam(value: PredicateValue): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}

export function predicateToSql(predicate: Predicate, options: CompileOptions = {}): CompiledSql {
  switch (predicate.kind) {
    case 'true':
      return { sql: '1 = 1', params: [] }
    case 'false':
      return { sql: '0 = 1', params: [] }
    case 'eq': {
      assertField(predicate.field, options)
      return { sql: `${predicate.field} = ?`, params: [toParam(predicate.value)] }
    }
    case 'in': {
      assertField(predicate.field, options)
      if (predicate.values.length === 0) return { sql: '0 = 1', params: [] }
      const placeholders = predicate.values.map(() => '?').join(', ')
      return {
        sql: `${predicate.field} IN (${placeholders})`,
        params: predicate.values.map(toParam),
      }
    }
    case 'prefix': {
      assertField(predicate.field, options)
      return {
        sql: `${predicate.field} LIKE ? ESCAPE '\\'`,
        params: [`${escapeLike(predicate.value)}%`],
      }
    }
    case 'and':
    case 'or': {
      if (predicate.items.length === 0) {
        return predicate.kind === 'and'
          ? { sql: '1 = 1', params: [] }
          : { sql: '0 = 1', params: [] }
      }
      const joiner = predicate.kind === 'and' ? ' AND ' : ' OR '
      const parts: string[] = []
      const params: unknown[] = []
      for (const item of predicate.items) {
        const compiled = predicateToSql(item, options)
        parts.push(`(${compiled.sql})`)
        params.push(...compiled.params)
      }
      return { sql: parts.join(joiner), params }
    }
    default: {
      const never: never = predicate
      throw new EabError(EC.INTERNAL, `未支持的谓词类型: ${JSON.stringify(never)}`)
    }
  }
}
