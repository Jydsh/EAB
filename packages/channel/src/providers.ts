/**
 * 真实通讯录 provider：飞书 / 钉钉 / 企业微信。
 *
 * 只负责把三家 API 的差异消化成统一 RemoteOrg；部门映射、落库、差异报告都在
 * map-org / apply 两层，provider 里不碰数据库。
 *
 * 凭证来自 channel_configs（app_id / corp_id）与 secrets.json（secret_ref），
 * 明文不落库、不进日志。
 */
import type { ChannelConfig, RemoteDept, RemoteOrg, RemoteUser } from './types.js'

interface FeishuDeptItem {
  department_id?: string
  parent_department_id?: string
  name?: string
  order?: number | string
}

interface FeishuUserItem {
  open_id?: string
  union_id?: string
  name?: string
  job_title?: string
  employee_no?: string
  mobile?: string
  department_ids?: string[]
  status?: { is_resigned?: boolean; is_activated?: boolean }
}

interface DingDeptItem {
  dept_id?: number | string
  parent_id?: number | string
  name?: string
}

interface DingUserItem {
  userid?: string
  unionid?: string
  name?: string
  title?: string
  job_number?: string
  mobile?: string
  avatar?: string
  dept_id_list?: Array<number | string>
  /** 列表接口只给“是不是某个部门的负责人”，具体哪个部门要再查用户详情 */
  leader?: boolean
  /** 钉钉用户详情里的人：这个人是哪些部门的负责人/组长 */
  leader_in_dept?: Array<{ dept_id?: number | string; leader?: boolean }>
  active?: boolean
}

interface WecomDeptItem {
  id?: number | string
  parentid?: number | string
  name?: string
  order?: number | string
}

interface WecomUserItem {
  userid?: string
  name?: string
  mobile?: string
  department?: Array<number | string>
  position?: string
  status?: number
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) throw new Error(`渠道凭证缺少${label}`)
  return value
}

/**
 * 钉钉端点可被本地联调覆盖（EAB_DINGTALK_API / EAB_DINGTALK_OAPI）。
 * 默认直连官方；仅允许 https，或本机 http，避免把 AppSecret 发到任意地址。
 */
function dingTalkEndpoint(envName: string, fallback: string): string {
  const raw = process.env[envName]?.trim()
  if (!raw) return fallback
  const url = new URL(raw)
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`${envName} 只允许 https，或本机 http`)
  }
  return url.origin
}

const DINGTALK_API = dingTalkEndpoint('EAB_DINGTALK_API', 'https://api.dingtalk.com')
const DINGTALK_OAPI = dingTalkEndpoint('EAB_DINGTALK_OAPI', 'https://oapi.dingtalk.com')

async function requestJson(url: string | URL, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`渠道返回了非 JSON 响应（HTTP ${res.status}）`)
  }
  if (!res.ok) {
    const payload = (body && typeof body === 'object' ? body : {}) as {
      code?: unknown
      errcode?: unknown
      msg?: unknown
      message?: unknown
    }
    const code = payload.code ?? payload.errcode
    const message = String(payload.msg ?? payload.message ?? '').trim()
    throw new Error(
      `渠道接口 HTTP ${res.status}${code !== undefined ? `（${String(code)}）` : ''}${
        message ? `：${message}` : ''
      }`,
    )
  }
  return body
}

async function feishuToken(cfg: ChannelConfig): Promise<string> {
  const body = (await requestJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      app_id: requireValue(cfg.appId, 'App ID'),
      app_secret: requireValue(cfg.appSecret, 'App Secret'),
    }),
  })) as { code?: number; msg?: string; tenant_access_token?: string }
  if (body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`飞书取 token 失败 ${body.code ?? ''}：${body.msg ?? '未知错误'}`)
  }
  return body.tenant_access_token
}

async function dingTalkToken(cfg: ChannelConfig): Promise<string> {
  const body = (await requestJson(`${DINGTALK_API}/v1.0/oauth2/accessToken`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      appKey: requireValue(cfg.appId, 'AppKey'),
      appSecret: requireValue(cfg.appSecret, 'AppSecret'),
    }),
  })) as { accessToken?: string; message?: string }
  if (!body.accessToken) throw new Error(`钉钉取 token 失败：${body.message ?? '未知错误'}`)
  return body.accessToken
}

async function wecomToken(cfg: ChannelConfig): Promise<string> {
  const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken')
  url.searchParams.set('corpid', requireValue(cfg.corpId ?? cfg.appId, '企业 ID'))
  url.searchParams.set('corpsecret', requireValue(cfg.appSecret, '应用 Secret'))
  const body = (await requestJson(url)) as { errcode?: number; errmsg?: string; access_token?: string }
  if (body.errcode !== 0 || !body.access_token) {
    throw new Error(`企业微信取 token 失败 ${body.errcode ?? ''}：${body.errmsg ?? '未知错误'}`)
  }
  return body.access_token
}

async function fetchFeishuOrg(cfg: ChannelConfig): Promise<RemoteOrg> {
  const token = await feishuToken(cfg)
  const depts: RemoteDept[] = []
  let pageToken = ''
  for (let page = 0; page < 50; page += 1) {
    const url = new URL('https://open.feishu.cn/open-apis/contact/v3/departments')
    url.searchParams.set('department_id', '0')
    url.searchParams.set('fetch_child', 'true')
    url.searchParams.set('page_size', '50')
    url.searchParams.set('user_id_type', 'open_id')
    url.searchParams.set('department_id_type', 'open_department_id')
    if (pageToken) url.searchParams.set('page_token', pageToken)
    const body = (await requestJson(url, { headers: { authorization: `Bearer ${token}` } })) as {
      code?: number
      msg?: string
      data?: { items?: FeishuDeptItem[]; has_more?: boolean; page_token?: string }
    }
    if (body.code !== 0) throw new Error(`飞书通讯录部门读取失败 ${body.code}：${body.msg ?? ''}`)
    for (const item of body.data?.items ?? []) {
      const id = String(item.department_id ?? '')
      if (!id) continue
      depts.push({
        channelDeptId: id,
        parentChannelDeptId: String(item.parent_department_id ?? '0') === '0' ? '0' : String(item.parent_department_id),
        // 飞书根部门 `0` 的平台返回名称是空字符串；它不会建成 EAB 部门行，但 mapRemoteOrg
        // 会先校验名称，不能把空名称当成普通部门传给映射层。
        name: String(item.name ?? '').trim() || (id === '0' ? '根部门' : '未命名部门'),
        order: Number(item.order ?? 0),
      })
    }
    if (!body.data?.has_more || !body.data.page_token) break
    pageToken = body.data.page_token
  }

  const users = new Map<string, { user: RemoteUser; deptIds: string[] }>()
  const deptIds = ['0', ...depts.map((dept) => dept.channelDeptId)]
  for (const deptId of deptIds) {
    let userPageToken = ''
    for (let page = 0; page < 20; page += 1) {
      const url = new URL('https://open.feishu.cn/open-apis/contact/v3/users/find_by_department')
      url.searchParams.set('department_id', deptId)
      url.searchParams.set('page_size', '50')
      url.searchParams.set('user_id_type', 'open_id')
      url.searchParams.set('department_id_type', 'open_department_id')
      if (userPageToken) url.searchParams.set('page_token', userPageToken)
      const body = (await requestJson(url, { headers: { authorization: `Bearer ${token}` } })) as {
        code?: number
        msg?: string
        data?: { items?: FeishuUserItem[]; has_more?: boolean; page_token?: string }
      }
      if (body.code !== 0) throw new Error(`飞书通讯录成员读取失败 ${body.code}：${body.msg ?? ''}`)
      for (const item of body.data?.items ?? []) {
        const id = String(item.open_id ?? '')
        if (!id) continue
        const previous = users.get(id)
        const nextDeptIds = (item.department_ids ?? []).map(String)
        if (!nextDeptIds.includes(deptId) && deptId !== '0') nextDeptIds.push(deptId)
        const merged = previous
          ? [...new Set([...previous.deptIds, ...nextDeptIds])]
          : nextDeptIds
        users.set(id, {
          deptIds: merged,
          user: {
            channelUserId: id,
            unionId: item.union_id ? String(item.union_id) : undefined,
            name: String(item.name ?? '未命名成员'),
            title: item.job_title ? String(item.job_title) : undefined,
            employeeNo: item.employee_no ? String(item.employee_no) : undefined,
            mobile: item.mobile ? String(item.mobile) : undefined,
            channelDeptIds: merged,
            status:
              item.status?.is_resigned || item.status?.is_activated === false ? 'departed' : 'active',
          },
        })
      }
      if (!body.data?.has_more || !body.data.page_token) break
      userPageToken = body.data.page_token
    }
  }

  return { depts, users: [...users.values()].map((entry) => entry.user) }
}

/**
 * 钉钉企业身份探测：用企业应用的 AppKey/AppSecret 换 token，再读根部门（dept_id=1）名称。
 * 绑定前先跑一遍，既验证凭证与通讯录权限，也拿到展示用的企业名。
 */
export async function fetchDingTalkTenant(cfg: ChannelConfig): Promise<{ tenantId: string; name: string }> {
  const token = await dingTalkToken(cfg)
  const url = new URL('/topapi/v2/department/get', DINGTALK_OAPI)
  url.searchParams.set('access_token', token)
  const body = (await requestJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dept_id: 1, language: 'zh_CN' }),
  })) as { errcode?: number; errmsg?: string; result?: { name?: string } }
  if (body.errcode !== 0 && body.errcode !== undefined) {
    throw new Error(`钉钉读取企业根部门失败 ${String(body.errcode)}：${String(body.errmsg ?? '')}`)
  }
  const tenantId = requireValue(cfg.corpId, '企业 CorpId')
  const name = String(body.result?.name ?? '').trim()
  return { tenantId, name: name || tenantId }
}

async function fetchDingTalkOrg(cfg: ChannelConfig): Promise<RemoteOrg> {
  const token = await dingTalkToken(cfg)
  const base = DINGTALK_OAPI
  const post = async (path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const url = new URL(path, base)
    url.searchParams.set('access_token', token)
    const body = (await requestJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })) as Record<string, unknown>
    if (body.errcode !== 0 && body.errcode !== undefined) {
      throw new Error(`钉钉接口 ${path} 失败 ${String(body.errcode)}：${String(body.errmsg ?? '')}`)
    }
    return body
  }

  const depts: RemoteDept[] = []
  const walk = async (parentId: string, depth: number): Promise<void> => {
    if (depth > 10) return
    const body = await post('/topapi/v2/department/listsub', { dept_id: Number(parentId) })
    const items = (body.result ?? []) as DingDeptItem[]
    for (const item of items) {
      const id = String(item.dept_id ?? '')
      if (!id) continue
      depts.push({
        channelDeptId: id,
        parentChannelDeptId: String(item.parent_id ?? parentId),
        name: String(item.name ?? '未命名部门'),
        order: depts.length,
      })
      await walk(id, depth + 1)
    }
  }
  await walk('1', 0)

  const users = new Map<string, RemoteUser>()
  /** 用户列表接口不带 leader_in_dept，只有详情接口带；只对 leader=true 的人补查一次 */
  const leaderDeptCache = new Map<string, string[]>()
  for (const deptId of ['1', ...depts.map((dept) => dept.channelDeptId)]) {
    let cursor = 0
    for (let page = 0; page < 20; page += 1) {
      const body = await post('/topapi/v2/user/list', { dept_id: Number(deptId), cursor, size: 100, language: 'zh_CN' })
      const result = (body.result ?? {}) as { list?: DingUserItem[]; has_more?: boolean; next_cursor?: number }
      for (const item of result.list ?? []) {
        const id = String(item.userid ?? '')
        if (!id) continue
        const previous = users.get(id)
        let leaderInDept = item.leader_in_dept ?? []
        let detailMobile: string | undefined
        let detailAvatar: string | undefined
        if (item.leader === true && !leaderDeptCache.has(id)) {
          const detail = (await post('/topapi/v2/user/get', { userid: id, language: 'zh_CN' })) as {
            result?: DingUserItem
          }
          leaderInDept = detail.result?.leader_in_dept ?? []
          detailMobile = detail.result?.mobile ? String(detail.result.mobile) : undefined
          detailAvatar = detail.result?.avatar ? String(detail.result.avatar) : undefined
          leaderDeptCache.set(
            id,
            leaderInDept
              .filter((leader) => leader?.leader === true && leader.dept_id !== undefined)
              .map((leader) => String(leader.dept_id)),
          )
        }
        const nextDeptIds = (item.dept_id_list ?? []).map(String)
        if (!nextDeptIds.includes(deptId) && deptId !== '1') nextDeptIds.push(deptId)
        const leaderDeptIds = leaderDeptCache.has(id)
          ? leaderDeptCache.get(id)!
          : leaderInDept
              .filter((leader) => leader?.leader === true && leader.dept_id !== undefined)
              .map((leader) => String(leader.dept_id))
        users.set(id, {
          channelUserId: id,
          unionId: item.unionid ? String(item.unionid) : undefined,
          name: String(item.name ?? '未命名成员'),
          title: item.title ? String(item.title) : undefined,
          employeeNo: item.job_number ? String(item.job_number) : undefined,
          mobile: item.mobile
            ? String(item.mobile)
            : detailMobile ?? previous?.mobile,
          avatar: item.avatar
            ? String(item.avatar)
            : detailAvatar ?? previous?.avatar,
          channelDeptIds: previous
            ? [...new Set([...previous.channelDeptIds, ...nextDeptIds])]
            : nextDeptIds,
          leaderDeptIds: previous
            ? [...new Set([...(previous.leaderDeptIds ?? []), ...leaderDeptIds])]
            : leaderDeptIds,
          status: item.active === false ? 'departed' : 'active',
        })
      }
      if (!result.has_more) break
      cursor = Number(result.next_cursor ?? 0)
    }
  }

  return { depts, users: [...users.values()] }
}

async function fetchWecomOrg(cfg: ChannelConfig): Promise<RemoteOrg> {
  const token = await wecomToken(cfg)
  const get = async (path: string, params: Record<string, string>): Promise<Record<string, unknown>> => {
    const url = new URL(path, 'https://qyapi.weixin.qq.com')
    url.searchParams.set('access_token', token)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    const body = (await requestJson(url)) as Record<string, unknown>
    if (body.errcode !== 0 && body.errcode !== undefined) {
      throw new Error(`企业微信接口 ${path} 失败 ${String(body.errcode)}：${String(body.errmsg ?? '')}`)
    }
    return body
  }

  const body = await get('/cgi-bin/department/list', {})
  const depts: RemoteDept[] = []
  for (const item of (body.department ?? []) as WecomDeptItem[]) {
    const id = String(item.id ?? '')
    if (!id || id === '1') continue
    depts.push({
      channelDeptId: id,
      parentChannelDeptId: String(item.parentid ?? '1'),
      name: String(item.name ?? '未命名部门'),
      order: Number(item.order ?? 0),
    })
  }

  const users = new Map<string, RemoteUser>()
  const userBody = await get('/cgi-bin/user/list', { department_id: '1', fetch_child: '1' })
  for (const item of (userBody.userlist ?? []) as WecomUserItem[]) {
    const id = String(item.userid ?? '')
    if (!id) continue
    users.set(id, {
      channelUserId: id,
      name: String(item.name ?? '未命名成员'),
      title: item.position ? String(item.position) : undefined,
      mobile: item.mobile ? String(item.mobile) : undefined,
      channelDeptIds: (item.department ?? []).map(String),
      status: item.status === 1 ? 'active' : 'departed',
    })
  }

  return { depts, users: [...users.values()] }
}

export async function fetchChannelOrg(provider: string, cfg: ChannelConfig): Promise<RemoteOrg> {
  if (provider === 'feishu') return fetchFeishuOrg(cfg)
  if (provider === 'dingtalk') return fetchDingTalkOrg(cfg)
  if (provider === 'wecom') return fetchWecomOrg(cfg)
  throw new Error(`不支持的渠道：${provider}`)
}
