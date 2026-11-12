import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchChannelOrg, fetchDingTalkTenant } from '../src/providers.js'

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('真实通讯录 provider', () => {
  it('飞书：token → 部门 → 按部门拉成员并去重', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('tenant_access_token')) return json({ code: 0, tenant_access_token: 't' })
      if (url.includes('/contact/v3/departments')) {
        return json({
          code: 0,
          data: {
            items: [{ department_id: 'd1', parent_department_id: '0', name: '研发中心', order: 1 }],
            has_more: false,
          },
        })
      }
      if (url.includes('/users/find_by_department')) {
        return json({
          code: 0,
          data: {
            items: [
              {
                open_id: 'u1',
                union_id: 'un1',
                name: '孙悦',
                job_title: '知识库运营',
                employee_no: 'E001',
                department_ids: ['d1'],
                status: { is_activated: true },
              },
            ],
            has_more: false,
          },
        })
      }
      throw new Error(`未预期的请求：${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const org = await fetchChannelOrg('feishu', { provider: 'feishu', appId: 'app', appSecret: 'secret' })
    expect(org.depts).toHaveLength(1)
    expect(org.depts[0]).toMatchObject({ channelDeptId: 'd1', parentChannelDeptId: '0', name: '研发中心' })
    expect(org.users).toHaveLength(1)
    expect(org.users[0]).toMatchObject({
      channelUserId: 'u1',
      name: '孙悦',
      status: 'active',
      channelDeptIds: ['d1'],
    })
  })

  it('飞书：根部门名称是空字符串时补成可映射的根部门，不阻断同步', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('tenant_access_token')) return json({ code: 0, tenant_access_token: 't' })
      if (url.includes('/contact/v3/departments')) {
        return json({
          code: 0,
          data: {
            items: [
              { department_id: '0', parent_department_id: '0', name: '', order: 0 },
              { department_id: 'd1', parent_department_id: '0', name: '研发中心', order: 1 },
            ],
            has_more: false,
          },
        })
      }
      if (url.includes('/users/find_by_department')) {
        return json({ code: 0, data: { items: [], has_more: false } })
      }
      throw new Error(`未预期的请求：${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const org = await fetchChannelOrg('feishu', { provider: 'feishu', appId: 'app', appSecret: 'secret' })
    expect(org.depts).toHaveLength(2)
    expect(org.depts[0]).toMatchObject({ channelDeptId: '0', name: '根部门' })
    expect(org.depts[1]).toMatchObject({ channelDeptId: 'd1', name: '研发中心' })
  })

  it('企业微信：无凭证时明确报错，不发请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchChannelOrg('wecom', { provider: 'wecom', corpId: '', appSecret: '' })).rejects.toThrow(
      '缺少企业 ID',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('钉钉：读取企业根部门名，并拉部门树与成员', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/v1.0/oauth2/accessToken')) return json({ accessToken: 't' })
      if (url.includes('/topapi/v2/department/get')) {
        return json({ errcode: 0, result: { name: '甲科技' } })
      }
      if (url.includes('/topapi/v2/department/listsub')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { dept_id?: number }
        if (Number(body.dept_id) === 1) {
          return json({ errcode: 0, result: [{ dept_id: 2, parent_id: 1, name: '研发部' }] })
        }
        return json({ errcode: 0, result: [] })
      }
      if (url.includes('/topapi/v2/user/list')) {
        return json({
          errcode: 0,
          result: {
            list: [{ userid: 'u1', unionid: 'un1', name: '张伟', dept_id_list: [2], active: true }],
            has_more: false,
          },
        })
      }
      throw new Error(`未预期的请求：${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const cfg = { provider: 'dingtalk' as const, appId: 'key', appSecret: 'secret', corpId: 'corp' }
    await expect(fetchDingTalkTenant(cfg)).resolves.toEqual({ tenantId: 'corp', name: '甲科技' })
    const org = await fetchChannelOrg('dingtalk', cfg)
    expect(org.depts).toHaveLength(1)
    expect(org.depts[0]).toMatchObject({ channelDeptId: '2', parentChannelDeptId: '1', name: '研发部' })
    expect(org.users).toHaveLength(1)
    expect(org.users[0]).toMatchObject({ channelUserId: 'u1', name: '张伟', channelDeptIds: ['2'] })
  })
})
