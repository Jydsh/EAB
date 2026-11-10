/**
 * HTTP 冒烟脚本：验证控制台的服务端真的按权限返回。
 * 用法：先 `pnpm dev`，另开一个终端 `node scripts/smoke-http.mjs`
 */
const BASE = process.env.EAB_BASE ?? 'http://127.0.0.1:8787'

/**
 * 控制台登录：读 .eab-dev/admin-credentials.txt 里的超级管理员账号密码，
 * 走 /api/console/login 换会话 cookie；拿不到就跳过"控制台接口"的断言。
 * 也支持显式设置 EAB_CONSOLE_TOKEN 时直接用服务令牌。
 */
let consoleHeaders = null
try {
  const { readFileSync } = await import('node:fs')
  let username = ''
  let password = ''
  try {
    const text = readFileSync(new URL('../.eab-dev/admin-credentials.txt', import.meta.url), 'utf8')
    username = (text.match(/^username=(.+)$/m) ?? [])[1]?.trim() ?? ''
    password = (text.match(/^password=(.+)$/m) ?? [])[1]?.trim() ?? ''
  } catch {
    username = ''
  }
  if (username && password) {
    const res = await fetch(`${BASE}/api/console/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (res.ok) {
      const setCookie = res.headers.get('set-cookie') ?? ''
      consoleHeaders = { cookie: setCookie.split(';')[0], 'x-eab-console': '1' }
    }
  }
  if (!consoleHeaders && process.env.EAB_CONSOLE_TOKEN) {
    consoleHeaders = { 'x-eab-console-token': process.env.EAB_CONSOLE_TOKEN, 'x-eab-console': '1' }
  }
} catch {
  consoleHeaders = null
}

const cases = [
  { path: '/api/health', expect: 200, note: '健康检查' },
  { path: '/api/dev/personas', expect: 200, note: '身份列表' },
  { path: '/api/org/tree?as=u_wf', expect: 200, note: '公司管理员看组织树' },
  { path: '/api/org/tree?as=u_zw', expect: 403, note: '普通员工看组织树 → 应 403' },
  { path: '/api/org/members?as=u_lj', expect: 200, note: '部门管理员看成员' },
  { path: '/api/org/members?as=u_cm', expect: 403, note: '普通员工看成员 → 应 403' },
  { path: '/api/kb/collections?as=u_zw', expect: 200, note: '前端工程师看知识库' },
  { path: '/api/kb/collections?as=u_wf', expect: 200, note: '公司管理员看知识库' },
  { path: '/api/kb/collections?as=u_wm', expect: 403, note: '审计员无 kb:read → 应 403' },
  { path: '/api/kb/docs?as=u_zw&collectionId=kb_rd', expect: 200, note: '研发规范（本部门）→ 可读' },
  { path: '/api/kb/docs?as=u_cm&collectionId=kb_rd', expect: 403, note: '市场部读研发规范 → 应 403' },
  { path: '/api/kb/docs?as=u_zw&collectionId=kb_mgmt', expect: 403, note: '普通员工读薪酬库 → 应 403' },
  { path: '/api/dev/kb-matrix', expect: 200, note: '视野矩阵' },
  { path: '/api/org/sync-runs?as=u_wf', expect: 200, note: '公司管理员看同步历史' },
  { path: '/api/org/sync-runs?as=u_zw', expect: 403, note: '普通员工看同步历史 → 应 403' },
  { path: '/api/channel/bindings?as=u_wf', expect: 200, note: '公司管理员看渠道绑定状态' },
  { path: '/api/channel/bindings?as=u_zw', expect: 403, note: '普通员工看渠道绑定 → 应 403' },
  {
    path: '/api/channel/bind/start?as=u_zw',
    expect: 403,
    method: 'POST',
    body: { provider: 'feishu' },
    note: '普通员工发起扫码绑定 → 应 403',
  },
  {
    path: '/api/dev/org-sync?as=u_zw',
    expect: 403,
    method: 'POST',
    body: { step: 1 },
    note: '普通员工触发同步 → 应 403',
  },
  { path: '/chat', expect: 200, note: '员工工作台页面' },
  { path: '/api/chat/models?as=u_zw', expect: 200, note: '普通员工可用模型（至少一个）' },
  { path: '/api/chat/models?as=u_wf', expect: 200, note: '公司管理员可用模型（至少一个）' },
  {
    path: '/api/chat/messages?as=u_zw',
    expect: 200,
    method: 'POST',
    body: { text: '冒烟：普通员工自动选模型' },
    note: '普通员工发消息 → 自动选模型',
  },
  {
    path: '/api/chat/messages?as=u_zw',
    expect: 403,
    method: 'POST',
    body: { text: '冒烟：越权用推理模型', modelId: 'model_reason' },
    note: '普通员工手动选无权限模型 → 应 403',
  },
  {
    path: '/api/chat/messages?as=u_wm',
    expect: 403,
    method: 'POST',
    body: { text: '冒烟：审计员没有 chat:use' },
    note: '审计员对话 → 应 403',
  },
  {
    path: '/api/chat/messages?as=u_zw',
    expect: 200,
    method: 'POST',
    body: {
      text: '',
      attachments: [{ name: '页面稿.png', size: 20480, type: 'image/png' }],
    },
    note: '只有附件、没有文字也能发（附件只带名字与大小）',
    check: (body) => (body.data?.message?.text ?? '').includes('页面稿.png') || '回复里没提到附件名',
  },
  {
    path: '/api/chat/messages?as=u_zw',
    expect: 400,
    method: 'POST',
    body: {
      text: '冒烟：附件太多',
      attachments: [
        { name: 'a.txt', size: 1 },
        { name: 'b.txt', size: 1 },
        { name: 'c.txt', size: 1 },
        { name: 'd.txt', size: 1 },
        { name: 'e.txt', size: 1 },
      ],
    },
    note: '超过 4 个附件 → 应 400',
  },
  { path: '/api/plugins?as=u_wf', expect: 200, note: '公司管理员看插件清单' },
  { path: '/api/plugins?as=u_zw', expect: 403, note: '普通员工看插件 → 应 403' },
  // 多公司（一个平台托多家企业）：同一套接口，换个人就该换一家公司的数据
  {
    path: '/api/org/tree?as=u2_admin',
    expect: 200,
    note: '乙软件的人只看乙软件的组织树',
    check: (body) =>
      (body.data?.root?.name === '乙软件' && body.data?.total === 3) || '返回的不是乙软件的组织树',
  },
  {
    path: '/api/kb/collections?as=u2_dev',
    expect: 200,
    note: '乙软件成员的可见知识库里不应出现甲科技的库',
    check: (body) => {
      const names = (body.data?.collections ?? []).map((c) => c.name)
      return !names.some((name) => name.includes('王芳') || name.includes('薪酬')) || '串到了甲科技的知识库'
    },
  },
  {
    path: '/api/kb/collections?as=u_zw',
    expect: 200,
    note: '甲科技成员的可见知识库里不应出现乙软件的库',
    check: (body) => {
      const names = (body.data?.collections ?? []).map((c) => c.name)
      return !names.some((name) => name.includes('乙软件') || name.includes('交付规范')) || '串到了乙软件的知识库'
    },
  },
  {
    path: '/api/me?as=u2_dev',
    expect: 200,
    note: '身份里的公司取自成员本人',
    check: (body) => body.data?.company?.id === 'c2' || '公司不是 c2',
  },
  {
    path: '/',
    expect: 302,
    manual: true,
    note: '员工入口不落到控制台，改送对话页',
    checkRedirect: (location) => location === '/chat' || '期望 302 到 /chat',
  },
  {
    path: '/?as=u_zw',
    expect: 302,
    manual: true,
    note: '带身份进根路径也送对话页（并保留身份）',
    checkRedirect: (location) => location === '/chat?as=u_zw' || '期望 302 到 /chat?as=u_zw',
  },
  { path: '/admin', expect: 200, note: '控制台先出管理员登录页：不登录组织成员' },
  { path: '/platform', expect: 404, note: '多余的运维入口已下线' },
  { path: '/api/console/companies', expect: 401, note: '没有控制台会话看不了公司清单' },
  {
    path: '/api/console/companies',
    expect: consoleHeaders ? 200 : 401,
    headers: consoleHeaders ?? undefined,
    note: '控制台登录后可以列公司（管理范围选择器）',
    check: (body) => (consoleHeaders ? body.data?.companies?.length >= 2 || '公司清单少于 2 家' : true),
  },
  {
    path: '/api/console/roles',
    expect: consoleHeaders ? 200 : 401,
    headers: consoleHeaders ?? undefined,
    note: '角色与权限：7 个内置角色与权限点',
    check: (body) => (consoleHeaders ? body.data?.roles?.length >= 7 || '角色数量不足' : true),
  },
  {
    path: '/api/console/providers',
    expect: consoleHeaders ? 200 : 401,
    headers: consoleHeaders ?? undefined,
    note: '模型接入：供应商清单（含厂商类型）',
    check: (body) => (consoleHeaders ? body.data?.providers?.length >= 1 || '没有供应商' : true),
  },
  {
    path: '/api/console/models',
    expect: consoleHeaders ? 200 : 401,
    headers: consoleHeaders ?? undefined,
    note: '模型接入：模型目录来自 models 表',
    check: (body) =>
      consoleHeaders
        ? body.data?.models?.length >= 1 && body.data.models.some((model) => model.enabled) || '没有启用的模型'
        : true,
  },
  {
    path: '/api/console/plugins',
    expect: 401,
    note: '插件管理器只给控制台：没有会话不能安装/卸载',
  },
  {
    path: '/api/console/plugins',
    expect: consoleHeaders ? 200 : 401,
    headers: consoleHeaders ?? undefined,
    note: '插件生命周期：已发现 / 已登记安装 / 插件源 / 安装根目录',
    check: (body) =>
      consoleHeaders
        ? (body.data?.stats?.discovered >= 1 &&
            Boolean(body.data?.installer?.root) &&
            body.data?.catalog?.plugins?.length >= 1) ||
          '插件管理器缺少统计 / 安装根目录 / 插件源'
        : true,
  },
  {
    path: '/api/console/plugins/events',
    expect: consoleHeaders ? 200 : 401,
    headers: consoleHeaders ?? undefined,
    note: '插件生命周期审计：安装 / 更新 / 启停 / 卸载记录可查',
    check: (body) => (consoleHeaders ? Array.isArray(body.data?.events) || 'events 不是数组' : true),
  },
  {
    path: '/api/org/tree',
    expect: consoleHeaders ? 200 : 401,
    headers: consoleHeaders ?? undefined,
    note: '控制台操作员默认管理甲科技',
    check: (body) => (consoleHeaders ? body.data?.total >= 10 || '甲科技部门数不对' : true),
  },
  {
    path: '/api/org/tree?company=c2',
    expect: consoleHeaders ? 200 : 401,
    headers: consoleHeaders ?? undefined,
    note: '控制台切到乙软件后只看到乙软件的组织',
    check: (body) => (consoleHeaders ? body.data?.total === 3 || '乙软件部门数不是 3' : true),
  },
  {
    path: '/api/me',
    expect: consoleHeaders ? 200 : 401,
    headers: consoleHeaders ?? undefined,
    note: '控制台身份是操作员，不是组织里的某个人',
    check: (body) => (consoleHeaders ? body.data?.person?.id === 'console-operator' || '控制台身份不是操作员' : true),
  },
  {
    path: '/api/console/scopes',
    expect: consoleHeaders ? 200 : 401,
    headers: consoleHeaders ?? undefined,
    note: '权限点带中文标签与危险标记，页面不用显示原始 scope 串',
    check: (body) =>
      consoleHeaders
        ? Boolean(body.data?.labels?.['kb:read']) && Boolean(body.data?.groups) || '缺少标签或分组'
        : true,
  },
  {
    path: '/api/console/kb/collections/kb_hr/docs',
    expect: consoleHeaders ? 200 : 401,
    headers: consoleHeaders ?? undefined,
    note: '控制台能看知识库文档列表，不被员工侧 ACL 拦住',
    check: (body) =>
      consoleHeaders ? body.data?.docs?.length === 1 || '人力内部资料应有 1 篇文档' : true,
  },
]

function summarize(path, body) {
  if (!body || typeof body !== 'object') return ''
  if (body.ok === false) return `${body.code} ${body.message}`
  const data = body.data ?? {}
  if (Array.isArray(data.collections) && Array.isArray(data.personas)) {
    return `矩阵 ${data.personas.length} 人 × ${data.collections.length} 个知识库`
  }
  if (Array.isArray(data.runs)) return `同步记录 ${data.runs.length} 条`
  if (Array.isArray(data.bindings)) {
    return `渠道 ${data.bindings.length} 个，已绑定 ${data.bindings.filter((b) => b.bound).length} 个`
  }
  if (Array.isArray(data.collections)) {
    return `知识库 ${data.collections.length} 个，可见 ${data.collections.filter((c) => c.visible).length} 个`
  }
  if (Array.isArray(data.members)) return `成员 ${data.members.length} 人`
  if (Array.isArray(data.models)) return `模型 ${data.models.length} 个，自动=${data.autoModelId ?? '无'}`
  if (data.message && data.message.modelName) {
    return `${data.message.modelName}${data.message.autoSelected ? '（自动）' : ''}`
  }
  if (Array.isArray(data.personas)) return `身份 ${data.personas.length} 个`
  if (data.root) return `组织树 ${data.total} 个部门`
  if (Array.isArray(data.docs)) return `文档 ${data.docs.length} 篇`
  if (Array.isArray(data.plugins)) {
    return `插件 ${data.plugins.length} 个，启用 ${data.plugins.filter((p) => p.enabled).length} 个`
  }
  if (data.version) return `v${data.version}`
  return ''
}

let failures = 0

for (const item of cases) {
  const init = { headers: { accept: 'application/json', ...(item.headers ?? {}) }, method: item.method ?? 'GET' }
  if (item.manual) init.redirect = 'manual'
  if (item.body) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(item.body)
  }
  const res = await fetch(BASE + item.path, init)
  const text = await res.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  const statusPass = res.status === item.expect
  const redirectResult = statusPass && item.checkRedirect ? item.checkRedirect(res.headers.get('location')) : true
  const checkResult = statusPass && item.check ? item.check(parsed) : true
  const pass = statusPass && redirectResult === true && checkResult === true
  if (!pass) failures += 1
  const summary = summarize(item.path, parsed)
  const tag = pass ? '✓' : '✗'
  const extra =
    redirectResult !== true
      ? ` · 断言失败：${redirectResult}`
      : checkResult !== true
        ? ` · 断言失败：${checkResult}`
        : ''
  console.log(`${tag} ${String(res.status).padEnd(3)} ${item.path.padEnd(46)} ${item.note}${summary ? ` · ${summary}` : ''}${extra}`)
}

console.log('')
console.log(failures === 0 ? '全部符合预期' : `${failures} 条不符合预期`)
process.exit(failures === 0 ? 0 : 1)
