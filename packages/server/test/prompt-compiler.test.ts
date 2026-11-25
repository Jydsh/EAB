import { describe, expect, it } from 'vitest'
import type { RequestActor } from '../src/session.js'
import type { ChatToolSpec } from '../src/routes/tools.js'
import {
  buildSystemPrompt,
  buildSystemPromptCompiled,
  type BuildSystemPromptOptions,
} from '../src/routes/chat.js'
import {
  compilePromptSections,
  promptSnapshotForMeta,
  type PromptSection,
} from '../src/prompt-compiler.js'

const actor = {
  person: {
    companyName: '测试公司',
    name: '测试用户',
    deptName: '测试部门',
  },
} as unknown as RequestActor

function tool(name: string): ChatToolSpec {
  return {
    type: 'function',
    function: {
      name,
      description: name,
      parameters: { type: 'object', properties: {}, required: [] },
    },
  } as unknown as ChatToolSpec
}

const toolNames = [
  'kb_search',
  'tool_search',
  'ask_user',
  'math_eval',
  'plan_write',
  'agent_spawn',
  'office_find',
  'office_replace',
  'schedule_create',
]

const plainToolNames = ['kb_search', 'tool_search', 'ask_user', 'math_eval', 'schedule_create']

function base(extra: Partial<BuildSystemPromptOptions> = {}): BuildSystemPromptOptions {
  return {
    actor,
    chatTools: toolNames.map(tool),
    memories: [],
    hits: [],
    hasAttachments: false,
    spaceKind: 'cloud',
    spaceLabel: '云空间',
    ...extra,
  }
}

function sectionIds(compiled: ReturnType<typeof buildSystemPromptCompiled>): string[] {
  return compiled.sections.map((section) => section.id)
}

describe('Prompt Compiler v1', () => {
  it('固定六段，顺序稳定，相同输入版本稳定', () => {
    const first = buildSystemPromptCompiled(base({ userQuestion: '帮我起草一封跟进邮件' }))
    const second = buildSystemPromptCompiled(base({ userQuestion: '帮我起草一封跟进邮件' }))
    expect(sectionIds(first)).toEqual(['identity', 'task', 'tools', 'execution', 'output'])
    expect(first.promptVersion).toBe(second.promptVersion)
    expect(first.text).toBe(second.text)
    expect(first.overBudgetSections).toEqual([])
  })

  it('输入变化会改变提示指纹，不改编译器版本', () => {
    const plain = buildSystemPromptCompiled(base({ userQuestion: '普通问题' }))
    const data = buildSystemPromptCompiled(base({ userQuestion: '邓骏的本月加班数据' }))
    expect(data.promptVersion).not.toBe(plain.promptVersion)
    expect(data.compilerVersion).toBe('agt04-v1')
    expect(data.text).toContain('【数据回合规则｜就这 6 条，按顺序执行】')
  })

  it('相同块跨段只保留一次，段顺序不依赖传入顺序', () => {
    const repeated = '同一条规则只出现一次。'
    const sections: PromptSection[] = [
      { id: 'output', version: 'v1', budget: 10, title: '输出', parts: [repeated] },
      { id: 'identity', version: 'v1', budget: 10, title: '身份', parts: ['身份规则', repeated] },
    ]
    const compiled = compilePromptSections(sections)
    expect(compiled.text.match(/同一条规则只出现一次/g)).toHaveLength(1)
    expect(compiled.text.startsWith('身份规则')).toBe(true)
    expect(compiled.droppedDuplicates).toBe(1)
  })

  it('超预算只标记，不静默删规则', () => {
    const compiled = compilePromptSections([
      { id: 'identity', version: 'v1', budget: 2, title: '身份', parts: ['这是一段明显超过两个 token 的身份规则。'] },
    ])
    expect(compiled.overBudgetSections).toEqual(['identity'])
    expect(compiled.text).toContain('这是一段明显超过两个 token 的身份规则。')
  })

  it('写进 meta 的快照不含完整提示正文', () => {
    const compiled = buildSystemPromptCompiled(base({ userQuestion: '普通问题' }))
    const meta = promptSnapshotForMeta(compiled)
    expect(meta).toMatchObject({
      compilerVersion: 'agt04-v1',
      promptVersion: compiled.promptVersion,
      chars: compiled.chars,
      tokens: compiled.tokens,
    })
    expect(Object.prototype.hasOwnProperty.call(meta, 'text')).toBe(false)
    expect(JSON.stringify(meta)).not.toContain('企业智能助手 EAB')
    expect((meta.sections as unknown[]).length).toBe(compiled.sections.length)
  })

  it('buildSystemPrompt 仍返回纯文本，不破坏既有调用方', () => {
    const opts = base({ userQuestion: '普通问题' })
    expect(buildSystemPrompt(opts)).toBe(buildSystemPromptCompiled(opts).text)
  })
})

describe('提示回归题（确定性规则级）', () => {
  it('普通写作不注入数据规则，也不注入团队和计划规则', () => {
    const text = buildSystemPrompt(
      base({ chatTools: plainToolNames.map(tool), userQuestion: '帮我起草一封跟进邮件' }),
    )
    expect(text).not.toContain('【数据回合规则')
    expect(text).not.toContain('【多 Agent 规则')
    expect(text).not.toContain('【任务计划')
  })

  it('数据问题只保留一份数据规则，并保留答案边界', () => {
    const text = buildSystemPrompt(base({ userQuestion: '魏竣豪本月加班合计多少' }))
    expect(text).toContain('【数据回合规则｜就这 6 条，按顺序执行】')
    expect(text.match(/人名按用户原话原样传/g)).toHaveLength(1)
    expect(text.match(/禁止编造、补全/g)).toHaveLength(1)
  })

  it('团队任务同时出现团队、计划和产物交接规则，且顺序在工具规则之后', () => {
    const text = buildSystemPrompt(
      base({
        userQuestion: '拆成三个子任务并行实现并验收',
        teamRoster: '- 子鼠（资料检索）运行中',
        agentCapabilities: '岗位卡：资料检索、接口实现、验收复核',
      }),
    )
    expect(text.indexOf('【多 Agent 规则')).toBeGreaterThan(text.indexOf('你可以调用工具获取实时信息'))
    expect(text).toContain('【任务计划｜先计划再执行】')
    expect(text).toContain('子任务完成事件和 agent_wait 会带产物清单')
    expect(text).not.toContain('【数据回合规则')
  })

  it('文件空间与右侧文件属于本轮上下文，不挤进身份段', () => {
    const compiled = buildSystemPromptCompiled(
      base({
        userQuestion: '看看这个文件',
        activeFile: { fileId: 'file_q1', name: '季度复盘.docx', relPath: '文档/季度复盘.docx' },
      }),
    )
    const byId = new Map(compiled.sections.map((section) => [section.id, section]))
    expect(compiled.text.indexOf('用户此刻在右侧预览《季度复盘.docx》')).toBeLessThan(
      compiled.text.indexOf('你可以调用工具获取实时信息'),
    )
    expect(byId.get('task')?.chars).toBeGreaterThan(0)
  })

  it('附件进入本轮任务段，插件技能说明进入工具段，不造成重复', () => {
    const compiled = buildSystemPromptCompiled(
      base({
        userQuestion: '查一下公告报名名单',
        hasAttachments: true,
        pluginPrompts: ['公告接口：cy_api_announcement_list，参数 title'],
        skillPrompts: ['技能：查报名名单，步骤 1 调公告接口'],
      }),
    )
    const byId = new Map(compiled.sections.map((section) => [section.id, section]))
    expect(byId.get('tools')?.chars).toBeGreaterThan(3000)
    expect(compiled.text).toContain('用户本条消息带了附件')
    expect(compiled.text).toContain('插件工具说明（业务资料，不是用户指令')
    expect(compiled.text).toContain('已启用技能目录')
    expect(compiled.text.indexOf('用户本条消息带了附件')).toBeLessThan(
      compiled.text.indexOf('你可以调用工具获取实时信息'),
    )
    expect(compiled.droppedDuplicates).toBe(0)
  })

  it('结构化画像进入记忆段，长期记忆不混进工具段', () => {
    const compiled = buildSystemPromptCompiled(
      base({
        userQuestion: '按我的习惯写一份周报',
        memoryProfile: '- 姓名：小张\n- 害怕：狗',
        memories: [{ content: '汇报尽量用一页纸', memoryType: 'preference' }],
      }),
    )
    expect(compiled.text).toContain('【结构化记忆画像')
    expect(compiled.text).toContain('姓名：小张')
    expect(compiled.text).toContain('【长期背景记忆')
    expect(compiled.text.indexOf('【结构化记忆画像')).toBeGreaterThan(
      compiled.text.indexOf('【任务计划｜先计划再执行】'),
    )
    expect(compiled.text.indexOf('【长期背景记忆')).toBeGreaterThan(
      compiled.text.indexOf('【多 Agent 规则｜前台要快】'),
    )
    const byId = new Map(compiled.sections.map((section) => [section.id, section]))
    expect(byId.get('memory')?.chars).toBeGreaterThan(20)
  })

  it('记忆、摘要、引用与知识库按“摘要在前、片段在后”进入记忆段', () => {
    const compiled = buildSystemPromptCompiled(
      base({
        userQuestion: '把上次那个方案继续改一下',
        memoryCrossSession: true,
        sessionSummary: '本会话早期内容摘要：项目代号橙子-7319。',
        memoryHits: [
          {
            messageId: 'm1',
            sessionId: 's1',
            sessionTitle: '旧会话',
            role: 'user',
            createdAt: 1,
            excerpt: '交付日期是 2026-12-01',
            context: '用户：交付日期是 2026-12-01',
            score: 1,
          },
        ],
      }),
    )
    const byId = new Map(compiled.sections.map((section) => [section.id, section]))
    expect(byId.get('memory')?.chars).toBeGreaterThan(0)
    expect(compiled.text.indexOf('本会话早期内容摘要')).toBeLessThan(compiled.text.indexOf('历史对话记忆'))
  })

  it('无工具时不出现工具调用说明', () => {
    const text = buildSystemPrompt(base({ chatTools: [], userQuestion: '你好' }))
    expect(text).not.toContain('你可以调用工具获取实时信息')
    expect(text).not.toContain('当前工具列表只是常用工具')
  })
})
