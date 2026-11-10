/**
 * 平台新增能力的可复跑冒烟（v2026.11.07）
 *
 * 覆盖：控制台登录、成员导出、临时授权 allow/deny、记忆分层、SSE、
 *      渠道身份绑定、Webhook 事件去重。
 *
 * 运行前先 `pnpm dev`，再 `node scripts/smoke-platform.mjs`。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const BASE = process.env.EAB_BASE ?? 'http://127.0.0.1:8787'
const results = []
let failed = 0

function check(name, condition, extra = '') {
  results.push({ name, ok: Boolean(condition), extra })
  if (!condition) failed += 1
  console.log(`${condition ? '✓' : '✗'} ${name}${extra ? ` · ${extra}` : ''}`)
}

async function request(pathname, options = {}) {
  const response = await fetch(`${BASE}${pathname}`, options)
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* CSV 等非 JSON 响应 */
  }
  return { status: response.status, json, text, headers: response.headers }
}

function credentials() {
  const file = path.join(ROOT, '.eab-dev', 'admin-credentials.txt')
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^(username|password)=(.+)$/)
    if (match) out[match[1]] = match[2]
  }
  return out
}

const admin = credentials()
const login = await request('/api/console/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(admin),
})
check('超管登录', login.status === 200, `HTTP ${login.status}`)
const cookie = login.headers.get('set-cookie')?.split(';')[0]
check('拿到控制台会话 Cookie', Boolean(cookie))

const consoleHeaders = { cookie, 'x-eab-console': '1' }
const jsonHeaders = { ...consoleHeaders, 'content-type': 'application/json' }
const employeeHeaders = { 'content-type': 'application/json' }

// 1. 成员清单导出
const exportRes = await request('/api/console/members/export', { headers: consoleHeaders })
check('成员清单导出', exportRes.status === 200 && exportRes.text.includes('工号'), `HTTP ${exportRes.status}`)
check('导出是附件', (exportRes.headers.get('content-disposition') ?? '').includes('attachment'))

// 2. 临时授权：deny chat:use 立即 403，撤销后恢复
const deny = await request('/api/console/members/u_zw/overrides', {
  method: 'POST',
  headers: jsonHeaders,
  body: JSON.stringify({ scope: 'chat:use', effect: 'deny', reason: '冒烟测试', expiresInHours: 2 }),
})
check('创建临时拒绝', deny.status === 201, `HTTP ${deny.status}`)
const denyId = deny.json?.data?.id

const deniedChat = await request('/api/chat/messages?as=u_zw', {
  method: 'POST',
  headers: employeeHeaders,
  body: JSON.stringify({ text: '冒烟：这条应被临时授权拒绝' }),
})
check('拒绝生效（403）', deniedChat.status === 403 && deniedChat.json?.code === 'EAB_FORBIDDEN', deniedChat.json?.code)

const revoke = await request(`/api/console/members/u_zw/overrides/${denyId}`, { method: 'DELETE', headers: consoleHeaders })
check('撤销临时授权', revoke.status === 200, `HTTP ${revoke.status}`)

const resumed = await request('/api/chat/messages?as=u_zw', {
  method: 'POST',
  headers: employeeHeaders,
  body: JSON.stringify({ text: '冒烟：撤销后可以继续对话' }),
})
check('撤销后对话恢复', resumed.status === 200, `HTTP ${resumed.status}`)

// 3. SSE
const sse = await request('/api/chat/messages?as=u_zw', {
  method: 'POST',
  headers: employeeHeaders,
  body: JSON.stringify({ text: '冒烟：SSE', stream: true }),
})
check('SSE 状态与类型', sse.status === 200 && (sse.headers.get('content-type') ?? '').includes('text/event-stream'))
check('SSE 有 delta 与 done', sse.text.includes('event: delta') && sse.text.includes('event: done'))

// 4. 记忆：待确认 → 确认 → 进入列表 → 删除
const memory = await request('/api/memories?as=u_zw', {
  method: 'POST',
  headers: employeeHeaders,
  body: JSON.stringify({ content: '冒烟测试记忆：汇报用一页纸', scopeType: 'user' }),
})
check('创建记忆', memory.status === 201 && memory.json?.data?.confirmed === false)
const memoryId = memory.json?.data?.id
const confirm = await request(`/api/memories/${memoryId}/confirm?as=u_zw`, {
  method: 'POST',
  headers: employeeHeaders,
  body: '{}',
})
check('确认记忆', confirm.status === 200 && confirm.json?.data?.confirmed === true)
const memoryList = await request('/api/memories?as=u_zw')
check('列表里已确认', memoryList.json?.data?.memories?.some((item) => item.id === memoryId && item.confirmed))
const memoryDelete = await request(`/api/memories/${memoryId}?as=u_zw`, { method: 'DELETE' })
check('删除记忆', memoryDelete.status === 200)

// 5. 渠道身份绑定
const externalId = `staff-smoke-${Date.now()}`
const bind = await request('/api/console/channel-identities', {
  method: 'POST',
  headers: jsonHeaders,
  body: JSON.stringify({ provider: 'dingtalk', externalId, userId: 'u_zw' }),
})
check('绑定外部账号', bind.status === 201 && bind.json?.data?.userId === 'u_zw', `HTTP ${bind.status}`)
const identityList = await request('/api/console/channel-identities', { headers: consoleHeaders })
const boundRow = identityList.json?.data?.items?.find((item) => (item.external_id ?? item.externalId) === externalId)
check('绑定出现在列表', Boolean(boundRow))
const unbind = await request(`/api/console/channel-identities/${boundRow?.id}`, {
  method: 'DELETE',
  headers: consoleHeaders,
})
check('解除绑定', unbind.status === 200, `HTTP ${unbind.status}`)

// 6. Webhook 去重
const channels = await request('/api/console/channels', { headers: consoleHeaders })
const dingtalk = channels.json?.data?.channels?.find((item) => item.provider === 'dingtalk')
check('回调令牌已生成', Boolean(dingtalk?.callbackToken))
const eventBody = { msgId: `msg-smoke-${Date.now()}`, senderStaffId: externalId, text: { content: '冒烟' } }
const first = await request(`/api/channel/webhooks/dingtalk?token=${encodeURIComponent(dingtalk.callbackToken)}`, {
  method: 'POST',
  headers: employeeHeaders,
  body: JSON.stringify(eventBody),
})
check('Webhook 首次接收', first.status === 200 && first.json?.data?.received === true, `HTTP ${first.status}`)
const second = await request(`/api/channel/webhooks/dingtalk?token=${encodeURIComponent(dingtalk.callbackToken)}`, {
  method: 'POST',
  headers: employeeHeaders,
  body: JSON.stringify(eventBody),
})
check('Webhook 重推判重', second.status === 200 && second.json?.data?.duplicate === true)

// 7. 运维端点
for (const endpoint of ['/api/health', '/healthz', '/readyz', '/metrics']) {
  const res = await request(endpoint)
  check(`运维端点 ${endpoint}`, res.status === 200, `HTTP ${res.status}`)
}

console.log('')
if (failed === 0) {
  console.log(`全部符合预期（${results.length} 条）`)
} else {
  console.log(`失败 ${failed} 条 / 共 ${results.length} 条`)
  process.exitCode = 1
}
