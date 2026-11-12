import { describe, expect, it } from 'vitest'
import { channelDeptEntityId, mapRemoteOrg } from '../src/map-org.js'
import type { RemoteOrg } from '../src/types.js'

const base = {
  companyId: 'c1',
  provider: 'mock' as const,
  root: { id: 'd_root', path: '/c1/', depth: 1 },
}

describe('mapRemoteOrg：部门树', () => {
  it('按父链重建路径与层级（不抄渠道给的层级字段）', () => {
    const remote: RemoteOrg = {
      depts: [
        { channelDeptId: 'rd', parentChannelDeptId: '0', name: '研发中心', order: 1 },
        { channelDeptId: 'be', parentChannelDeptId: 'rd', name: '后端组', order: 1 },
        { channelDeptId: 'deep', parentChannelDeptId: 'be', name: '基础平台小组', order: 1 },
      ],
      users: [],
    }

    const plan = mapRemoteOrg(remote, base)
    const byChannel = new Map(plan.depts.map((row) => [row.channelDeptId, row]))

    expect(byChannel.get('rd')?.path).toBe('/c1/d_mock_rd/')
    expect(byChannel.get('rd')?.parentId).toBe('d_root')
    expect(byChannel.get('rd')?.depth).toBe(2)
    expect(byChannel.get('be')?.path).toBe('/c1/d_mock_rd/d_mock_be/')
    expect(byChannel.get('be')?.depth).toBe(3)
    expect(byChannel.get('deep')?.path).toBe('/c1/d_mock_rd/d_mock_be/d_mock_deep/')
    expect(byChannel.get('deep')?.depth).toBe(4)
  })

  it('渠道自己的根部门（飞书 0）不建行，它的子部门直接挂到公司根', () => {
    const remote: RemoteOrg = {
      depts: [
        { channelDeptId: '0', parentChannelDeptId: '0', name: '公司根', order: 0 },
        { channelDeptId: 'rd', parentChannelDeptId: '0', name: '研发中心', order: 1 },
      ],
      users: [],
    }

    const plan = mapRemoteOrg(remote, { ...base, rootChannelDeptIds: ['0'] })
    expect(plan.depts.map((row) => row.channelDeptId)).toEqual(['rd'])
    expect(plan.depts[0]?.parentId).toBe('d_root')
    expect(plan.depts[0]?.path).toBe('/c1/d_mock_rd/')
  })

  it('groupChannelRoot 时把飞书根建成公司下的渠道分组节点，成员跟着进入该节点', () => {
    const remote: RemoteOrg = {
      depts: [
        { channelDeptId: '0', parentChannelDeptId: '0', name: '根部门', order: 0 },
        { channelDeptId: 'rd', parentChannelDeptId: '0', name: '研发中心', order: 1 },
      ],
      users: [
        {
          channelUserId: 'ou_1',
          name: '飞书成员',
          channelDeptIds: ['0'],
          status: 'active',
        },
      ],
    }

    const plan = mapRemoteOrg(remote, {
      ...base,
      rootChannelDeptIds: ['0'],
      groupChannelRoot: true,
      channelRootName: '飞书 · 测试企业',
    })
    const byChannel = new Map(plan.depts.map((row) => [row.channelDeptId, row]))

    expect(byChannel.get('0')?.id).toBe('d_mock_0')
    expect(byChannel.get('0')?.name).toBe('飞书 · 测试企业')
    expect(byChannel.get('0')?.parentId).toBe('d_root')
    expect(byChannel.get('0')?.path).toBe('/c1/d_mock_0/')
    expect(byChannel.get('rd')?.parentId).toBe('d_mock_0')
    expect(byChannel.get('rd')?.path).toBe('/c1/d_mock_0/d_mock_rd/')
    expect(plan.users[0]?.deptId).toBe('d_mock_0')
    expect(plan.users[0]?.deptPath).toBe('/c1/d_mock_0/')
    expect(plan.unassignedUsers).toEqual([])
  })

  it('钉钉根部门 1 不在返回里时，子部门挂公司根且不记 orphan', () => {
    const remote: RemoteOrg = {
      depts: [
        { channelDeptId: '100', parentChannelDeptId: '1', name: '研发中心', order: 1 },
        { channelDeptId: '101', parentChannelDeptId: '1', name: '市场部', order: 2 },
        { channelDeptId: '200', parentChannelDeptId: '100', name: '平台组', order: 1 },
      ],
      users: [],
    }

    const plan = mapRemoteOrg(remote, { ...base, rootChannelDeptIds: ['1'] })
    expect(plan.orphans).toEqual([])
    expect(plan.depts.map((row) => row.channelDeptId)).toEqual(['100', '200', '101'])
    expect(plan.depts[0]?.parentId).toBe('d_root')
    expect(plan.depts[0]?.path).toBe('/c1/d_mock_100/')
  })

  it('兄弟部门按 order 再按名称排序，保证每次结果一致', () => {
    const remote: RemoteOrg = {
      depts: [
        { channelDeptId: 'b', parentChannelDeptId: '0', name: 'Dept B', order: 2 },
        { channelDeptId: 'a', parentChannelDeptId: '0', name: 'Dept A', order: 1 },
        { channelDeptId: 'c', parentChannelDeptId: '0', name: 'Dept C', order: 1 },
      ],
      users: [],
    }

    const plan = mapRemoteOrg(remote, base)
    expect(plan.depts.map((row) => row.channelDeptId)).toEqual(['a', 'c', 'b'])
  })

  it('父部门不在返回里 → 挂到公司根并记 orphan（不猜层级）', () => {
    const remote: RemoteOrg = {
      depts: [
        { channelDeptId: 'ghost-child', parentChannelDeptId: 'not-visible', name: '市场部', order: 1 },
      ],
      users: [],
    }

    const plan = mapRemoteOrg(remote, base)
    expect(plan.depts[0]?.parentId).toBe('d_root')
    expect(plan.depts[0]?.path).toBe('/c1/d_mock_ghost-child/')
    expect(plan.depts[0]?.orphan).toBe(true)
    expect(plan.orphans).toEqual([
      { channelDeptId: 'ghost-child', parentChannelDeptId: 'not-visible', name: '市场部' },
    ])
  })

  it('重复部门 ID 直接失败，不做"取最后一个"这种猜测', () => {
    const remote: RemoteOrg = {
      depts: [
        { channelDeptId: 'rd', parentChannelDeptId: '0', name: '研发中心', order: 1 },
        { channelDeptId: 'rd', parentChannelDeptId: '0', name: '研发中心（重复）', order: 1 },
      ],
      users: [],
    }
    expect(() => mapRemoteOrg(remote, base)).toThrow(/重复的部门 ID/)
  })

  it('部门关系成环直接失败，不生成半棵树', () => {
    const remote: RemoteOrg = {
      depts: [
        { channelDeptId: 'a', parentChannelDeptId: 'b', name: 'A', order: 1 },
        { channelDeptId: 'b', parentChannelDeptId: 'a', name: 'B', order: 1 },
      ],
      users: [],
    }
    expect(() => mapRemoteOrg(remote, base)).toThrow(/环/)
  })

  it('ID 派生稳定且可重复（幂等的前提）', () => {
    const remote: RemoteOrg = {
      depts: [{ channelDeptId: 'od/wierd id', parentChannelDeptId: '0', name: '怪 ID', order: 1 }],
      users: [],
    }
    expect(channelDeptEntityId('mock', 'od/wierd id')).toBe('d_mock_od_wierd_id')
    expect(mapRemoteOrg(remote, base).depts[0]?.id).toBe('d_mock_od_wierd_id')
  })
})

describe('mapRemoteOrg：成员', () => {
  it('多部门成员取第一个能映射上的当主部门，其余记在 extraDeptIds', () => {
    const remote: RemoteOrg = {
      depts: [
        { channelDeptId: 'hr', parentChannelDeptId: '0', name: '人力', order: 1 },
        { channelDeptId: 'mkt', parentChannelDeptId: '0', name: '市场', order: 2 },
      ],
      users: [
        {
          channelUserId: 'u1',
          name: '苏杭',
          channelDeptIds: ['hidden', 'hr', 'mkt'],
          status: 'active',
        },
      ],
    }

    const plan = mapRemoteOrg(remote, base)
    expect(plan.users[0]?.deptId).toBe('d_mock_hr')
    expect(plan.users[0]?.deptPath).toBe('/c1/d_mock_hr/')
    expect(plan.users[0]?.extraDeptIds).toEqual(['d_mock_mkt'])
    expect(plan.unassignedUsers).toEqual([])
  })

  it('一个部门都映射不上（只在公司根里）→ 挂公司根并记 unassigned', () => {
    const remote: RemoteOrg = {
      depts: [{ channelDeptId: 'rd', parentChannelDeptId: '0', name: '研发', order: 1 }],
      users: [{ channelUserId: 'boss', name: '王芳', channelDeptIds: ['0'], status: 'active' }],
    }

    const plan = mapRemoteOrg(remote, { ...base, rootChannelDeptIds: ['0'] })
    expect(plan.users[0]?.deptId).toBe('d_root')
    expect(plan.users[0]?.deptPath).toBe('/c1/')
    expect(plan.unassignedUsers).toEqual(['boss'])
  })

  it('离职状态原样带下来，交给落库层决定怎么收权', () => {
    const remote: RemoteOrg = {
      depts: [{ channelDeptId: 'rd', parentChannelDeptId: '0', name: '研发', order: 1 }],
      users: [{ channelUserId: 'zhao', name: '赵磊', channelDeptIds: ['rd'], status: 'departed' }],
    }
    expect(mapRemoteOrg(remote, base).users[0]?.status).toBe('departed')
  })

  it('手机号归一化成纯数字，去掉 +86 与分隔符', () => {
    const remote: RemoteOrg = {
      depts: [{ channelDeptId: 'rd', parentChannelDeptId: '0', name: '研发', order: 1 }],
      users: [
        {
          channelUserId: 'u1',
          name: '苏杭',
          mobile: '+86 138-0013-8000',
          channelDeptIds: ['rd'],
          status: 'active',
        },
      ],
    }
    expect(mapRemoteOrg(remote, base).users[0]?.mobile).toBe('13800138000')
  })

  it('同一份输入跑两次结果完全一致（含顺序）', () => {
    const remote: RemoteOrg = {
      depts: [
        { channelDeptId: 'b', parentChannelDeptId: '0', name: '乙', order: 2 },
        { channelDeptId: 'a', parentChannelDeptId: '0', name: '甲', order: 1 },
      ],
      users: [
        { channelUserId: 'u2', name: '二号', channelDeptIds: ['b'], status: 'active' },
        { channelUserId: 'u1', name: '一号', channelDeptIds: ['a'], status: 'active' },
      ],
    }
    expect(mapRemoteOrg(remote, base)).toEqual(mapRemoteOrg(remote, base))
  })
})
