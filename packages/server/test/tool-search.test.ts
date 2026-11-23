import { describe, expect, it } from 'vitest'
import { openDatabase, migrate } from '@eab/storage'
import { SC } from '@eab/domain'
import { executeTool, searchToolCatalog, toolSpecsForActor, toolSpecsForAgent } from '../src/routes/tools.js'

function testEnv() {
  const db = openDatabase({ path: ':memory:' })
  migrate(db)
  const actor = {
    subject: {
      companyId: 'c1',
      userId: 'u1',
      status: 'active',
      deptId: 'd1',
      deptPath: '/d1',
      deptChain: [],
      roles: [],
      scopes: new Set(Object.values(SC)),
    },
    person: {
      id: 'u1',
      name: '测试员工',
      title: null,
      deptId: 'd1',
      deptPath: '/d1',
      deptName: '测试部门',
      companyId: 'c1',
      companyName: '测试公司',
    },
  } as any
  const deps = { db, config: { dbPath: ':memory:' }, companyId: 'c1' } as any
  return { deps, actor }
}

describe('Agent 工具按需加载', () => {
  it('首轮只带核心工具和 tool_search，文件工具按需路由，完整工具目录仍可按权限加载', () => {
    const { deps, actor } = testEnv()
    const core = toolSpecsForAgent(deps.db, actor, { kind: 'cloud' }, '今天天气怎么样？')
    const file = toolSpecsForAgent(deps.db, actor, { kind: 'cloud' }, '读取 docs/方案.md 的前两段')
    const all = toolSpecsForActor(deps.db, actor, { kind: 'cloud' })

    expect(core.some((tool) => tool.function.name === 'tool_search')).toBe(true)
    expect(core.some((tool) => tool.function.name === 'workspace_list')).toBe(false)
    expect(core.some((tool) => tool.function.name === 'workspace_read')).toBe(false)
    expect(file.some((tool) => tool.function.name === 'workspace_list')).toBe(true)
    expect(file.some((tool) => tool.function.name === 'workspace_read')).toBe(true)
    expect(core.some((tool) => tool.function.name === 'workspace_send_dingtalk')).toBe(false)
    expect(all.some((tool) => tool.function.name === 'workspace_send_dingtalk')).toBe(true)
  })

  it('业务数据问题不加载通讯录，问人/组织时才加载', () => {
    const { deps, actor } = testEnv()
    const business = toolSpecsForAgent(deps.db, actor, { kind: 'cloud' }, '重庆东环线录入了几条检查政治')
    const businessWithGroupName = toolSpecsForAgent(
      deps.db,
      actor,
      { kind: 'cloud' },
      '东环线班组最近录入了多少条检查整治记录',
    )
    const org = toolSpecsForAgent(deps.db, actor, { kind: 'cloud' }, '东环线组的组长是谁')

    expect(business.some((tool) => tool.function.name === 'org_directory')).toBe(false)
    expect(businessWithGroupName.some((tool) => tool.function.name === 'org_directory')).toBe(false)
    expect(org.some((tool) => tool.function.name === 'org_directory')).toBe(true)
  })

  it('普通问答不下发 Office 和定时工具，文档问题才按需路由', () => {
    const { deps, actor } = testEnv()
    const weather = toolSpecsForAgent(deps.db, actor, { kind: 'cloud' }, '今天天气怎么样？')
    const doc = toolSpecsForAgent(deps.db, actor, { kind: 'cloud' }, '把方案文档第二段改短一点')
    const schedule = toolSpecsForAgent(deps.db, actor, { kind: 'cloud' }, '每天九点提醒我提交日报')

    expect(weather.some((tool) => tool.function.name.startsWith('office_'))).toBe(false)
    expect(weather.some((tool) => tool.function.name === 'weather_now')).toBe(true)
    expect(weather.some((tool) => tool.function.name === 'schedule_create')).toBe(false)
    expect(weather.some((tool) => tool.function.name === 'workspace_list')).toBe(false)
    expect(doc.some((tool) => tool.function.name === 'office_replace')).toBe(true)
    expect(doc.some((tool) => tool.function.name === 'office_find')).toBe(true)
    expect(doc.some((tool) => tool.function.name === 'workspace_list')).toBe(true)
    expect(schedule.some((tool) => tool.function.name === 'schedule_create')).toBe(true)
    expect(schedule.some((tool) => tool.function.name === 'workspace_list')).toBe(false)
  })

  it('Office 工具按读取/编辑意图拆分下发', () => {
    const { deps, actor } = testEnv()
    const read = toolSpecsForAgent(deps.db, actor, { kind: 'cloud' }, '读一下这个文档的大纲')
    const edit = toolSpecsForAgent(deps.db, actor, { kind: 'cloud' }, '把方案文档第二段改短一点，并保留原格式')
    const format = toolSpecsForAgent(deps.db, actor, { kind: 'cloud' }, '把第二段标题加粗，字号改成 14')
    const uniformRewrite = toolSpecsForAgent(
      deps.db,
      actor,
      { kind: 'cloud' },
      '把第二段整段重写为“新的整段正文”，统一加粗并设为 12 号字',
    )

    expect(read.some((tool) => tool.function.name === 'office_read_outline')).toBe(true)
    expect(read.some((tool) => tool.function.name === 'office_replace')).toBe(false)
    expect(read.some((tool) => tool.function.name === 'office_format')).toBe(false)
    expect(edit.some((tool) => tool.function.name === 'office_replace')).toBe(true)
    expect(edit.some((tool) => tool.function.name === 'office_format')).toBe(false)
    expect(edit.some((tool) => tool.function.name === 'office_insert')).toBe(false)
    expect(edit.some((tool) => tool.function.name === 'office_rewrite')).toBe(false)
    expect(format.some((tool) => tool.function.name === 'office_format')).toBe(true)
    expect(uniformRewrite.some((tool) => tool.function.name === 'office_rewrite')).toBe(true)
  })

  it('单文件 Office 编辑不下发团队工具，批量/多文件仍保留编队', () => {
    const { deps, actor } = testEnv()
    const direct = toolSpecsForAgent(
      deps.db,
      actor,
      { kind: 'cloud' },
      '把右侧预览的《EAB-真实对话测试.docx》第二段正文改短，保留原有加粗和字号',
      { activeFile: { name: 'EAB-真实对话测试.docx' } },
    )
    const batch = toolSpecsForAgent(
      deps.db,
      actor,
      { kind: 'cloud' },
      '批量把云空间所有 docx 的第二段都改短',
      { activeFile: { name: 'EAB-真实对话测试.docx' } },
    )
    const allParagraphs = toolSpecsForAgent(
      deps.db,
      actor,
      { kind: 'cloud' },
      '把这份文档里所有段落的字号都改成小四',
      { activeFile: { name: 'EAB-真实对话测试.docx' } },
    )
    const twoDocs = toolSpecsForAgent(
      deps.db,
      actor,
      { kind: 'cloud' },
      '把这两个文档的第二段都改短',
      { activeFile: { name: 'EAB-真实对话测试.docx' } },
    )

    expect(direct.some((tool) => tool.function.name.startsWith('agent_'))).toBe(false)
    expect(direct.some((tool) => tool.function.name === 'office_replace')).toBe(true)
    expect(allParagraphs.some((tool) => tool.function.name.startsWith('agent_'))).toBe(false)
    expect(batch.some((tool) => tool.function.name === 'agent_spawn')).toBe(true)
    expect(twoDocs.some((tool) => tool.function.name === 'agent_spawn')).toBe(true)
  })

  it('Office 编辑轮的顶层工具 schema 保持在 11.3 KB 以内', () => {
    const { deps, actor } = testEnv()
    const specs = toolSpecsForAgent(
      deps.db,
      actor,
      { kind: 'cloud' },
      '把右侧预览的“EAB-Office端到端测试2.docx”第二段正文改短，旧文本“这是第二段正文，包含加粗和字号”替换为“已缩短”，保留原格式，不要改动第一段。',
    )
    const chars = specs.reduce((sum, spec) => sum + JSON.stringify(spec).length, 0)
    expect(chars).toBeLessThan(11_300)
  })

  it('插件和技能开发自动带文件读写工具', () => {
    const { deps, actor } = testEnv()
    const plugin = toolSpecsForAgent(deps.db, actor, { kind: 'cloud' }, '给自己开发一个插件页面')
    const skill = toolSpecsForAgent(deps.db, actor, { kind: 'cloud' }, '把检查整治流程沉淀成技能')

    expect(plugin.some((tool) => tool.function.name === 'workspace_read')).toBe(true)
    expect(plugin.some((tool) => tool.function.name === 'workspace_edit')).toBe(true)
    expect(skill.some((tool) => tool.function.name === 'workspace_read')).toBe(true)
  })

  it('网页问题首轮下发搜索和读取网页，普通问答不带', () => {
    const { deps, actor } = testEnv()
    const link = toolSpecsForAgent(deps.db, actor, { kind: 'cloud' }, '帮我总结 https://example.com/a')
    const search = toolSpecsForAgent(deps.db, actor, { kind: 'cloud' }, '联网搜一下重庆两江新区最新规划')
    const weather = toolSpecsForAgent(deps.db, actor, { kind: 'cloud' }, '今天天气怎么样？')
    const browser = toolSpecsForAgent(deps.db, actor, { kind: 'cloud' }, '用内置浏览器打开网页并截图')

    expect(link.some((tool) => tool.function.name === 'web_fetch')).toBe(true)
    expect(link.some((tool) => tool.function.name === 'web_search')).toBe(true)
    expect(search.some((tool) => tool.function.name === 'web_search')).toBe(true)
    expect(browser.some((tool) => tool.function.name === 'browser')).toBe(true)
    expect(weather.some((tool) => tool.function.name === 'web_search')).toBe(false)
    expect(weather.some((tool) => tool.function.name === 'web_fetch')).toBe(false)
    expect(weather.some((tool) => tool.function.name === 'browser')).toBe(false)
  })

  it('按中文场景搜索能命中文件发送、定时任务和计算工具', async () => {
    const { deps, actor } = testEnv()
    const send = (await executeTool(deps, actor, 'tool.search', { query: '把文件发到钉钉' })) as {
      tools: Array<{ functionName: string }>
    }
    const sendImage = (await executeTool(deps, actor, 'tool.search', { query: '把图片发给我' })) as {
      tools: Array<{ functionName: string }>
    }
    const schedule = (await executeTool(deps, actor, 'tool.search', { query: '查看我的定时任务' })) as {
      tools: Array<{ functionName: string }>
    }
    const math = (await executeTool(deps, actor, 'tool.search', { query: '计算' })) as {
      tools: Array<{ functionName: string }>
    }
    const weather = (await executeTool(deps, actor, 'tool.search', { query: '查一下重庆天气' })) as {
      tools: Array<{ functionName: string }>
    }
    const web = (await executeTool(deps, actor, 'tool.search', { query: '帮我总结这个网页链接' })) as {
      tools: Array<{ functionName: string }>
    }
    const browser = (await executeTool(deps, actor, 'tool.search', { query: '用浏览器打开网页截图' })) as {
      tools: Array<{ functionName: string }>
    }

    expect(send.tools.some((tool) => tool.functionName === 'workspace_send_dingtalk')).toBe(true)
    expect(sendImage.tools.some((tool) => tool.functionName === 'workspace_send_dingtalk')).toBe(true)
    expect(schedule.tools.some((tool) => tool.functionName === 'schedule_list')).toBe(true)
    expect(math.tools.some((tool) => tool.functionName === 'math_eval')).toBe(true)
    expect(weather.tools.some((tool) => tool.functionName === 'weather_now')).toBe(true)
    expect(web.tools.some((tool) => tool.functionName === 'web_fetch')).toBe(true)
    expect(browser.tools.some((tool) => tool.functionName === 'browser')).toBe(true)
  })

  it('搜索结果只返回当前员工和当前空间可用的工具', () => {
    const { deps, actor } = testEnv()
    const noneSearch = searchToolCatalog(deps.db, actor, { kind: 'none' }, '发送文件到钉钉')
    expect(noneSearch.tools.some((tool) => tool.functionName === 'workspace_send_dingtalk')).toBe(false)
    const noScopeActor = { ...actor, subject: { ...actor.subject, scopes: new Set([SC.CHAT_USE]) } }
    const noScope = searchToolCatalog(deps.db, noScopeActor as any, { kind: 'cloud' }, '发送文件到钉钉')
    expect(noScope.tools.length).toBe(0)
  })

  it('项目命令未启用时，目录和搜索都不应给出 project_exec', () => {
    const { deps, actor } = testEnv()
    const previous = process.env.EAB_PROJECT_EXEC
    delete process.env.EAB_PROJECT_EXEC
    try {
      const specs = toolSpecsForActor(deps.db, actor, { kind: 'cloud' })
      expect(specs.some((tool) => tool.function.name === 'project_exec')).toBe(false)
      const search = searchToolCatalog(deps.db, actor, { kind: 'cloud' }, 'project_exec 执行 python 脚本', 12)
      expect(search.tools.some((tool) => tool.functionName === 'project_exec')).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.EAB_PROJECT_EXEC
      else process.env.EAB_PROJECT_EXEC = previous
    }
  })
})
