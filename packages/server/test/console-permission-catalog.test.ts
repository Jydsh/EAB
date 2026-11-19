import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CONSOLE_DOMAINS,
  CONSOLE_PAGES,
  CONSOLE_PAGE_SECTIONS,
} from '../src/console-pages.js'
import { consolePermissionCatalog } from '../src/console-permissions.js'
import { consoleApiRuleFor } from '../src/console-api-access.js'

function frontendSystemSectionKeys(): string[] {
  const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const block = appJs.match(/const SYSTEM_SECTIONS = \[([\s\S]*?)\n\]/)
  if (!block) throw new Error('未找到前端 SYSTEM_SECTIONS')
  return [...block[1].matchAll(/\{ key: '([^']+)'/g)].map((match) => match[1])
}

function frontendPageKeys(): string[] {
  const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const block = appJs.match(/const PAGES = \{([\s\S]*?)\n\}/)
  if (!block) throw new Error('未找到前端 PAGES')
  return [...block[1].matchAll(/^\s{2}([A-Za-z0-9_]+): \{/gm)].map((match) => match[1])
}

describe('后台权限目录', () => {
  it('前端每个后台页面都必须在服务端页面注册表登记', () => {
    const frontendPages = frontendPageKeys().sort()
    const registryPages = CONSOLE_PAGES.map((page) => page.key).sort()
    expect(frontendPages).toEqual(registryPages)
  })

  it('系统二级导航与服务端页内分区注册表保持一致', () => {
    const registryKeys = (CONSOLE_PAGE_SECTIONS.system ?? []).map((section) => section.key)
    expect(frontendSystemSectionKeys()).toEqual(registryKeys)
  })

  it('角色和成员权限页能拿到全部页面、分区与 domains', () => {
    const catalog = consolePermissionCatalog()
    expect(catalog.pages.map((page) => page.page)).toEqual(CONSOLE_PAGES.map((page) => page.key))
    expect(catalog.domains.map((domain) => domain.id)).toEqual(CONSOLE_DOMAINS.map((domain) => domain.id))

    const systemPage = catalog.pages.find((page) => page.page === 'system')
    expect(systemPage?.sections.map((section) => section.key)).toEqual(
      (CONSOLE_PAGE_SECTIONS.system ?? []).map((section) => section.key),
    )
    expect(systemPage?.sections.find((section) => section.key === 'update')).toMatchObject({
      title: '系统更新',
      hideView: false,
    })

    const orgPage = catalog.pages.find((page) => page.page === 'org')
    expect(orgPage?.sections).toEqual([])
    expect(catalog.pages.find((page) => page.page === 'channels')?.sections).toEqual([])
    expect(catalog.pages.find((page) => page.page === 'models')?.sections).toEqual([])
  })

  it('系统更新的查看、检查、执行都只要求二级页可见', () => {
    expect(consoleApiRuleFor('GET', '/api/console/update')).toMatchObject({
      pages: ['system'],
      section: 'update',
      actions: ['view'],
    })
    expect(consoleApiRuleFor('GET', '/api/console/update/result')).toMatchObject({
      pages: ['system'],
      section: 'update',
      actions: ['view'],
    })
    expect(consoleApiRuleFor('POST', '/api/console/update/check')).toMatchObject({
      pages: ['system'],
      section: 'update',
      actions: ['view'],
    })
    expect(consoleApiRuleFor('POST', '/api/console/update/apply')).toMatchObject({
      pages: ['system'],
      section: 'update',
      actions: ['view'],
    })
    expect(consoleApiRuleFor('POST', '/api/console/update/check')?.platformOnly).toBeUndefined()
    expect(consoleApiRuleFor('POST', '/api/console/update/apply')?.platformOnly).toBeUndefined()
  })

  it('成员读写与角色分配都只按成员管理页可见', () => {
    expect(consoleApiRuleFor('GET', '/api/console/members')).toMatchObject({
      pages: ['org'],
      actions: ['view'],
    })
    expect(consoleApiRuleFor('GET', '/api/console/members/export')).toMatchObject({
      pages: ['org'],
      actions: ['view'],
    })
    expect(consoleApiRuleFor('POST', '/api/console/members')).toMatchObject({
      pages: ['org'],
      actions: ['create'],
    })
    expect(consoleApiRuleFor('PUT', '/api/console/members/u_demo')).toMatchObject({
      pages: ['org'],
      actions: ['edit'],
    })
    expect(consoleApiRuleFor('DELETE', '/api/console/members/u_demo')).toMatchObject({
      pages: ['org'],
      actions: ['delete'],
    })
    expect(consoleApiRuleFor('POST', '/api/console/members/u_demo/roles')).toMatchObject({
      pages: ['org', 'roles'],
      actions: ['edit'],
    })
    expect(consoleApiRuleFor('GET', '/api/console/member-console-permissions/u_demo')).toMatchObject({
      pages: ['org'],
      actions: ['view'],
    })
  })

  it('每个页面都归属且只归属一个已登记业务域', () => {
    for (const page of CONSOLE_PAGES) {
      const owners = CONSOLE_DOMAINS.filter((domain) => domain.pages.includes(page.key))
      expect(owners, `页面 ${page.key} 未登记业务域`).toHaveLength(1)
      expect(owners[0]?.id).toBe(page.domain)
    }
    for (const domain of CONSOLE_DOMAINS) {
      for (const page of domain.pages) {
        expect(CONSOLE_PAGES.some((item) => item.key === page), `业务域 ${domain.id} 引用了不存在的页面 ${page}`).toBe(true)
      }
    }
  })
})
