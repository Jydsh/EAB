import { describe, expect, it } from 'vitest'
import { visibleModelsFor, type ModelDefinition } from '../src/routes/chat.js'

function model(id: string, roles: string[], priority: number): ModelDefinition {
  return {
    id,
    name: id,
    desc: '',
    tags: ['chat'],
    roles,
    priority,
    provider: 'test',
    providerName: '测试供应商',
    modelKey: id,
  }
}

describe('visibleModelsFor', () => {
  it('空角色表示未授权，不再默认全员可见', () => {
    const catalog = [model('empty', [], 100), model('member', ['member'], 90)]
    expect(visibleModelsFor(catalog, ['member']).map((item) => item.id)).toEqual(['member'])
  })

  it('只有命中勾选角色才可见', () => {
    const catalog = [model('dept', ['dept_admin'], 80), model('member', ['member'], 70)]
    expect(visibleModelsFor(catalog, ['member']).map((item) => item.id)).toEqual(['member'])
    expect(visibleModelsFor(catalog, ['dept_admin']).map((item) => item.id)).toEqual(['dept'])
  })

  it('可见模型按优先级从高到低排序', () => {
    const catalog = [model('low', ['member'], 10), model('high', ['member'], 99)]
    expect(visibleModelsFor(catalog, ['member']).map((item) => item.id)).toEqual(['high', 'low'])
  })
})
