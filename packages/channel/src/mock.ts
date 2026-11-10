/**
 * 模拟渠道（飞书通讯录形状）——没有 app_id/secret 时也能把整条链路跑通。
 *
 * 为什么先做 mock 而不是直接接飞书：
 * 映射规则（父链重建 / 孤儿处理 / 部门移动 / 缺失计数）才是容易错的地方，
 * 用三份"通讯录快照"就能把第一次、变更后、有人离职与部门消失三种情况演示完；
 * 真 provider 之后只补一个 fetchOrg，映射与落库层不用改。
 *
 * step 1：初始通讯录（含一个父部门不可见的"孤儿部门"）
 * step 2：改名 + 部门移动 + 一人离职 + 一名新人 + 多部门兼职
 * step 3：一个部门和一个成员从通讯录里消失（触发 missing 计数）
 */
import type { OrgProvider, RemoteOrg } from './types.js'

export function mockFeishuOrg(step: 1 | 2 | 3): RemoteOrg {
  const baseDepts = [
    { channelDeptId: '0', parentChannelDeptId: '0', name: '甲科技（飞书根）', order: 0 },
    { channelDeptId: 'od-rd', parentChannelDeptId: '0', name: '研发中心（飞书）', order: 1 },
    { channelDeptId: 'od-be', parentChannelDeptId: 'od-rd', name: '后端组（飞书）', order: 1 },
    { channelDeptId: 'od-fe', parentChannelDeptId: 'od-rd', name: '前端组（飞书）', order: 2 },
    { channelDeptId: 'od-mkt', parentChannelDeptId: '0', name: '市场部（飞书）', order: 2 },
    { channelDeptId: 'od-hr', parentChannelDeptId: '0', name: '人力行政中心（飞书）', order: 3 },
    { channelDeptId: 'od-hr-rc', parentChannelDeptId: 'od-hr', name: '招聘组（飞书）', order: 1 },
    // 父部门 od-new-parent 没出现在返回里（模拟"该部门没授权给我们看"）
    { channelDeptId: 'od-new', parentChannelDeptId: 'od-new-parent', name: '新业务部（飞书）', order: 4 },
  ]

  const depts = baseDepts.map((dept) => ({ ...dept }))

  if (step >= 2) {
    const mkt = depts.find((dept) => dept.channelDeptId === 'od-mkt')
    if (mkt) mkt.name = '市场与品牌部（飞书）'
    const fe = depts.find((dept) => dept.channelDeptId === 'od-fe')
    if (fe) {
      fe.parentChannelDeptId = 'od-mkt'
      fe.order = 1
    }
  }

  const step3Depts = step >= 3 ? depts.filter((dept) => dept.channelDeptId !== 'od-hr-rc') : depts

  const users = [
    {
      channelUserId: 'fs_lin',
      unionId: 'on_lin',
      name: '林晨',
      title: '前端工程师',
      employeeNo: 'FS001',
      channelDeptIds: ['od-fe'],
      status: 'active' as const,
    },
    {
      channelUserId: 'fs_zhao',
      unionId: 'on_zhao',
      name: '赵磊',
      title: '后端工程师',
      employeeNo: 'FS002',
      channelDeptIds: ['od-be'],
      status: step >= 2 ? ('departed' as const) : ('active' as const),
    },
    {
      channelUserId: 'fs_he',
      unionId: 'on_he',
      name: '何雨',
      title: '市场策划',
      employeeNo: 'FS003',
      channelDeptIds: ['od-mkt'],
      status: 'active' as const,
    },
    {
      channelUserId: 'fs_su',
      unionId: 'on_su',
      name: '苏杭',
      title: '招聘专员（兼品牌支持）',
      employeeNo: 'FS004',
      channelDeptIds: ['od-hr-rc', 'od-mkt'],
      status: 'active' as const,
    },
    {
      channelUserId: 'fs_liu',
      unionId: 'on_liu',
      name: '刘洋',
      title: '招聘实习生',
      employeeNo: 'FS005',
      channelDeptIds: ['od-hr-rc'],
      status: 'active' as const,
    },
  ]

  const stepUsers = step >= 3 ? users.filter((user) => user.channelUserId !== 'fs_su') : users
  const visibleUsers = step >= 2 ? stepUsers : stepUsers.filter((user) => user.channelUserId !== 'fs_liu')

  return { depts: step3Depts, users: visibleUsers }
}

export const mockFeishuProvider: OrgProvider = {
  id: 'feishu',
  label: '飞书（模拟通讯录）',
  async verify() {
    return { ok: true, message: '模拟渠道无需凭证' }
  },
  async fetchOrg() {
    return mockFeishuOrg(1)
  },
}
