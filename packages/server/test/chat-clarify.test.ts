import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate, openDatabase } from '@eab/storage'
import { SC } from '@eab/domain'

const state = vi.hoisted(() => ({
  toolLists: [] as string[][],
  messageTexts: [] as string[],
  calls: 0,
  args: null as Record<string, unknown> | null,
}))

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>()
  return {
    ...actual,
    callModelStream: vi.fn(async (_db: unknown, _path: unknown, _company: unknown, _model: unknown, messages: Array<{ role: string; content: unknown }>, options: { tools?: Array<{ function: { name: string } }> }) => {
      state.toolLists.push((options.tools ?? []).map((tool) => tool.function.name))
      state.messageTexts.push(messages.map((message) => typeof message.content === 'string' ? message.content : '').join('\n'))
      state.calls += 1
      return {
        text: '',
        reasoning: '',
        toolCalls: [
          {
            id: `ask-${state.calls}`,
            type: 'function',
            function: {
              name: 'ask_user',
              arguments: JSON.stringify(state.args ?? {
                question: '你想先处理哪类工作？',
                options: [
                  { label: '查通讯录', description: '查部门和成员信息' },
                  { label: '整理文档', description: '整理现有资料' },
                  { label: '设置提醒', description: '创建一个定时提醒' },
                ],
                allowCustom: true,
              }),
            },
          },
        ],
        promptTokens: 1,
        completionTokens: 1,
      }
    }),
  }
})

import { runAgentTurn } from '../src/routes/chat.js'

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

describe('引导式澄清', () => {
  beforeEach(() => {
    state.args = null
    state.messageTexts.length = 0
  })
  it('模型调用 ask_user 时本轮结束并返回结构化的 2–4 个方向', async () => {
    state.toolLists.length = 0
    state.calls = 0
    const { deps, actor } = testEnv()
    const events: Array<{ type: string; clarify?: unknown }> = []

    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '帮我看看' }],
      maxTokens: 16,
      emit: (event) => events.push(event),
    })

    expect(state.toolLists[0]).toContain('ask_user')
    expect(result?.text).toBe('你想先处理哪类工作？')
    expect(result?.clarify?.question).toBe('你想先处理哪类工作？')
    expect(result?.clarify?.options.map((option) => option.label)).toEqual(['查通讯录', '整理文档', '设置提醒'])
    expect(result?.clarify?.allowCustom).toBe(true)
    expect(result?.toolCalls).toEqual([])
    expect(events.filter((event) => event.type === 'clarify')).toHaveLength(1)
    expect(events.some((event) => event.type === 'tool')).toBe(false)
  })

  it('模型第一次只返回短问句时，修复调用会补成结构化澄清', async () => {
    const { callModelStream } = await import('../src/llm.js')
    const mocked = callModelStream as unknown as { mockImplementationOnce: (fn: () => unknown) => void }
    mocked.mockImplementationOnce(async () => ({
      text: '你想先做哪件事？',
      reasoning: '',
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
    }))

    const { deps, actor } = testEnv()
    const events: Array<{ type: string; clarify?: unknown }> = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '帮我看看' }],
      maxTokens: 16,
      emit: (event) => events.push(event),
    })

    expect(result?.clarify?.options).toHaveLength(3)
    expect(result?.text).toBe('你想先处理哪类工作？')
    expect(events.some((event) => event.type === 'clarify')).toBe(true)
  })

  it('修复调用仍只返回短问句时，服务端兜底也能生成可点击方向', async () => {
    const { callModelStream } = await import('../src/llm.js')
    const mocked = callModelStream as unknown as { mockImplementationOnce: (fn: () => unknown) => void }
    const textReply = async () => ({
      text: '你想先处理哪件事？',
      reasoning: '',
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
    })
    mocked.mockImplementationOnce(textReply)
    mocked.mockImplementationOnce(textReply)

    const { deps, actor } = testEnv()
    const events: Array<{ type: string; clarify?: unknown }> = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '随便给点建议' }],
      maxTokens: 16,
      emit: (event) => events.push(event),
    })

    expect(result?.clarify?.options).toHaveLength(4)
    expect(result?.text).toBe('你想先处理哪件事？')
    expect(events.some((event) => event.type === 'clarify')).toBe(true)
  })

  it('长进度汇报只把选项 A/B/C 写成正文时，服务端直接补成可点击选择卡', async () => {
    const { callModelStream } = await import('../src/llm.js')
    const mocked = callModelStream as unknown as {
      mockImplementationOnce: (fn: (...args: any[]) => unknown) => void
    }
    state.calls = 0
    const report = [
      '李鹏，关于“按人员分类看看每个人有多少条计划”的进度汇报如下：',
      '',
      '1. 当前执行状态',
      '子 Agent 正在后台处理 6458 条目标与计划记录，完成后会自动汇总。',
      '',
      '2. 我现在能做什么',
      '选项 A（推荐）：稍后再询问，我会检查任务是否已完成。',
      '选项 B：现在就尝试转发进度查询。',
      '选项 C：不触发后台操作，仅用文字说明当前情况。',
      '',
      '3. 您的选择',
      '您想怎么做？',
      '- 等我任务完成后自动汇报（推荐，不占用会话）',
      '- 现在就让我尝试转发进度查询（可能返回半成品数据）',
      '- 稍后自己再问（可以在接下来的对话里随时问我）',
      '请告诉我您的决定。',
    ].join('\n')
    mocked.mockImplementationOnce(async () => ({
      text: report,
      reasoning: '',
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
    }))

    const { deps, actor } = testEnv()
    const events: Array<{ type: string; clarify?: any }> = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '按人员分类看看每个人有多少条计划，哪些完成了，哪些未完成' }],
      maxTokens: 32,
      emit: (event) => events.push(event),
    })

    expect(result?.clarify?.question).toBe('您想怎么做？')
    expect(result?.clarify?.options.map((option) => option.label)).toEqual([
      '等我任务完成后自动汇报',
      '现在就让我尝试转发进度查询',
      '稍后自己再问',
    ])
    expect(result?.clarify?.intro).toContain('6458 条目标与计划记录')
    expect(result?.text).toBe('您想怎么做？')
    expect(events.filter((event) => event.type === 'clarify')).toHaveLength(1)
  })

  it('模型先写背景汇报再调用 ask_user 时，卡片保留背景摘要', async () => {
    const { callModelStream } = await import('../src/llm.js')
    const mocked = callModelStream as unknown as {
      mockImplementationOnce: (fn: () => unknown) => void
    }
    mocked.mockImplementationOnce(async () => ({
      text: '后台任务还在处理 6458 条记录，完成后会自动汇总。',
      reasoning: '',
      toolCalls: [
        {
          id: 'ask-with-intro',
          type: 'function',
          function: {
            name: 'ask_user',
            arguments: JSON.stringify({
              question: '您想怎么处理这个后台任务？',
              options: [
                { label: '等完成后自动汇报' },
                { label: '现在转发进度查询' },
                { label: '取消任务' },
              ],
            }),
          },
        },
      ],
      promptTokens: 1,
      completionTokens: 1,
    }))

    const { deps, actor } = testEnv()
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '任务跑到哪了' }],
      maxTokens: 16,
      emit: () => {},
    })

    expect(result?.clarify?.question).toBe('您想怎么处理这个后台任务？')
    expect(result?.clarify?.intro).toContain('6458 条记录')
    expect(result?.text).toBe('您想怎么处理这个后台任务？')
  })

  it('纯方案对比、没有邀请用户选择的正文不会误判成选择卡', async () => {
    const { callModelStream } = await import('../src/llm.js')
    const mocked = callModelStream as unknown as {
      mockImplementationOnce: (fn: (...args: any[]) => unknown) => void
    }
    state.calls = 0
    const comparison = [
      '我把两种方案对比一下：',
      '方案 A：先导入历史数据，再统一补录，优点是口径一致，缺点是耗时较长。',
      '方案 B：边导入边补录，优点是上线快，缺点是容易出现重复记录。',
      '综合来看建议采用方案 A。',
    ].join('\n')
    mocked.mockImplementationOnce(async () => ({
      text: comparison,
      reasoning: '',
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
    }))

    const { deps, actor } = testEnv()
    const events: Array<{ type: string; clarify?: any }> = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '帮我分析下这两种导入方案' }],
      maxTokens: 32,
      emit: (event) => events.push(event),
    })

    expect(result?.clarify).toBeUndefined()
    expect(events.some((event) => event.type === 'clarify')).toBe(false)
  })

  it('邀请选择后用编号列表给出候选时，也能生成选择卡', async () => {
    const { callModelStream } = await import('../src/llm.js')
    const mocked = callModelStream as unknown as {
      mockImplementationOnce: (fn: (...args: any[]) => unknown) => void
    }
    state.calls = 0
    mocked.mockImplementationOnce(async () => ({
      text: [
        '任务还在后台跑，请选择下一步：',
        '1. 等完成后自动汇报',
        '2. 现在转发进度查询',
        '3. 取消这个后台任务',
      ].join('\n'),
      reasoning: '',
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
    }))

    const { deps, actor } = testEnv()
    const events: Array<{ type: string; clarify?: any }> = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '任务跑到哪了' }],
      maxTokens: 32,
      emit: (event) => events.push(event),
    })

    expect(result?.clarify?.options.map((option) => option.label)).toEqual([
      '等完成后自动汇报',
      '现在转发进度查询',
      '取消这个后台任务',
    ])
    expect(result?.clarify?.question).toContain('请选择下一步')
    expect(events.filter((event) => event.type === 'clarify')).toHaveLength(1)
  })

  it('模型追问是哪个任务、换哪个模型时，长回复也会强制转成澄清卡', async () => {
    const { callModelStream } = await import('../src/llm.js')
    const mocked = callModelStream as unknown as {
      mockImplementationOnce: (fn: (...args: any[]) => unknown) => void
    }
    mocked.mockImplementationOnce(async () => ({
      text: [
        '本轮后台任务在 16:46 启动，目标是按人员分类统计 6458 条目标与计划记录，并核对每个人已完成和未完成的数量。',
        '目前没有收到具体的失败通知，子 Agent 的检查点还在，可能只是模型侧超时。',
        '如果是刚才按人员分类统计的那个任务，它的检查点还在，可以直接 resume；如果是别的任务，需要先确认任务 id，否则重派会覆盖原来的检查点。',
        '请告诉我：',
        '',
        '是哪个任务失败了？',
        '换哪个模型重派？',
      ].join('\n'),
      reasoning: '',
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
    }))
    mocked.mockImplementationOnce(async () => ({
      text: '',
      reasoning: '',
      toolCalls: [
        {
          id: 'ask-task-model',
          type: 'function',
          function: {
            name: 'ask_user',
            arguments: JSON.stringify({
              question: '请选择要重派的任务和模型',
              options: [
                { label: '按人员分类统计任务' },
                { label: '其他任务' },
                { label: '先不重派' },
              ],
            }),
          },
        },
      ],
      promptTokens: 1,
      completionTokens: 1,
    }))

    const { deps, actor } = testEnv()
    const events: Array<{ type: string; clarify?: any }> = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '换模型重派' }],
      maxTokens: 16,
      emit: (event) => events.push(event),
    })

    expect(result?.clarify?.question).toBe('请选择要重派的任务和模型')
    expect(result?.clarify?.options).toHaveLength(3)
    expect(events.filter((event) => event.type === 'clarify')).toHaveLength(1)
  })

  it('用户明确要可点击选项时，首轮只允许 ask_user，不再自己恢复任务', async () => {
    const { callModelStream } = await import('../src/llm.js')
    const mocked = callModelStream as unknown as {
      mockImplementationOnce: (fn: (...args: any[]) => unknown) => void
    }
    let capturedOptions: any = null
    mocked.mockImplementationOnce(async (...args: any[]) => {
      capturedOptions = args[5]
      return {
        text: '',
        reasoning: '',
        toolCalls: [
          {
            id: 'ask-by-user-request',
            type: 'function',
            function: {
              name: 'ask_user',
              arguments: JSON.stringify({
                question: '这个后台任务失败了，您想怎么处理？',
                options: [
                  { label: '继续重试' },
                  { label: '换模型重派' },
                  { label: '先停下' },
                ],
              }),
            },
          },
        ],
        promptTokens: 1,
        completionTokens: 1,
      }
    })

    const { deps, actor } = testEnv()
    const events: Array<{ type: string; clarify?: any }> = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{
        role: 'user',
        content: '这个后台任务失败了，你准备继续重试、换模型重派，还是先停下？请给我可点击的选项让我选。',
      }],
      maxTokens: 16,
      emit: (event) => events.push(event),
    })

    expect(capturedOptions?.toolChoice?.function?.name).toBe('ask_user')
    expect(result?.clarify?.options.map((option) => option.label)).toEqual([
      '继续重试',
      '换模型重派',
      '先停下',
    ])
    expect(events.filter((event) => event.type === 'clarify')).toHaveLength(1)
  })

  it('“请确认以下步骤”的编号清单不会被误判成选择卡', async () => {
    const { callModelStream } = await import('../src/llm.js')
    const mocked = callModelStream as unknown as {
      mockImplementationOnce: (fn: (...args: any[]) => unknown) => void
    }
    state.calls = 0
    mocked.mockImplementationOnce(async () => ({
      text: [
        '开始前请确认以下三步：',
        '1. 先核对源数据里的 6458 条记录',
        '2. 再按人员分类统计完成和未完成',
        '3. 最后把结果写回工作计划表',
        '确认无误后我就按这个顺序执行。',
      ].join('\n'),
      reasoning: '',
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
    }))

    const { deps, actor } = testEnv()
    const events: Array<{ type: string; clarify?: unknown }> = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '按这个流程处理工作计划' }],
      maxTokens: 32,
      emit: (event) => events.push(event),
    })

    expect(result?.clarify).toBeUndefined()
    expect(events.some((event) => event.type === 'clarify')).toBe(false)
  })

  it('模型给出的方向少于两个时退回普通回答，不执行未注册工具', async () => {
    const { callModelStream } = await import('../src/llm.js')
    const mocked = callModelStream as unknown as { mockImplementationOnce: (fn: () => unknown) => void }
    mocked.mockImplementationOnce(async () => ({
      text: '我先按默认方向处理。',
      reasoning: '',
      toolCalls: [
        {
          id: 'ask-bad',
          type: 'function',
          function: {
            name: 'ask_user',
            arguments: JSON.stringify({ question: '选一个方向？', options: [{ label: '只有一个' }] }),
          },
        },
      ],
      promptTokens: 1,
      completionTokens: 1,
    }))

    const { deps, actor } = testEnv()
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '随便做点什么' }],
      maxTokens: 16,
      emit: () => {},
    })

    expect(result?.clarify).toBeUndefined()
    expect(result?.text).toBe('我先按默认方向处理。')
    expect(result?.toolCalls).toEqual([])
  })

  it('模型用 questions 一次下发多题时，保留完整题组且不设数量上限', async () => {
    state.toolLists.length = 0
    state.calls = 0
    state.args = {
      questions: [
        { question: '判断题：可以直接离开现场吗？', kind: 'single', options: [{ label: '正确' }, { label: '错误' }] },
        { question: '多选题：哪些必须完成？', kind: 'multiple', options: [{ label: '办理作业票' }, { label: '安全预想' }, { label: '挂设接地线' }] },
        { question: '填空题：作业编号是多少？', kind: 'text', placeholder: '请输入编号' },
        { question: '第四题：是否需要复核？', kind: 'single', options: [{ label: '需要' }, { label: '不需要' }] },
        { question: '第五题：补充说明', kind: 'text' },
      ],
    }
    const { deps, actor } = testEnv()
    const events: Array<{ type: string; clarify?: unknown }> = []

    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '出一组题' }],
      maxTokens: 16,
      emit: (event) => events.push(event),
    })

    expect(result?.clarify?.questions).toHaveLength(5)
    expect(result?.clarify?.questions?.map((question) => question.kind)).toEqual([
      'single', 'multiple', 'text', 'single', 'text',
    ])
    expect(result?.clarify?.question).toBe('判断题：可以直接离开现场吗？')
    expect(result?.text).toBe('判断题：可以直接离开现场吗？')
    expect(events.filter((event) => event.type === 'clarify')).toHaveLength(1)
  })

  it('题组路由下模型先吐完整题面也不会把正文流到卡片，只下发题组卡', async () => {
    const { callModelStream } = await import('../src/llm.js')
    const mocked = callModelStream as unknown as {
      mockImplementationOnce: (fn: (...args: any[]) => unknown) => void
    }
    const fullText = '第 1 题：红灯表示什么？\n1. 停车\n2. 通行\n\n第 2 题：绿灯表示什么？\n1. 加速\n2. 按规定速度通过'
    mocked.mockImplementationOnce(async (...args: any[]) => {
      const options = args[5] as { onEvent?: (event: { type: string; text: string }) => void }
      options.onEvent?.({ type: 'content', text: fullText })
      return {
        text: fullText,
        reasoning: '',
        toolCalls: [
          {
            id: 'ask-batch-stream',
            type: 'function',
            function: {
              name: 'ask_user',
              arguments: JSON.stringify({
                questions: [
                  { question: '第 1 题：红灯表示什么？', kind: 'single', options: [{ label: '停车' }, { label: '通行' }] },
                  { question: '第 2 题：绿灯表示什么？', kind: 'single', options: [{ label: '加速' }, { label: '按规定速度通过' }] },
                ],
              }),
            },
          },
        ],
        promptTokens: 1,
        completionTokens: 1,
      }
    })

    const { deps, actor } = testEnv()
    const events: Array<{ type: string; text?: string; clarify?: unknown }> = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '出两道题考我' }],
      maxTokens: 32,
      emit: (event) => events.push(event),
    })

    expect(result?.clarify?.questions).toHaveLength(2)
    expect(events.some((event) => event.type === 'content' && event.text?.includes('第 1 题'))).toBe(false)
    expect(events.filter((event) => event.type === 'clarify')).toHaveLength(1)
  })

  it('计算题等无选项题面也会被拆成可翻页的题组卡', async () => {
    const { callModelStream } = await import('../src/llm.js')
    const mocked = callModelStream as unknown as {
      mockImplementationOnce: (fn: (...args: any[]) => unknown) => void
    }
    const mathText = [
      '一组共 6 道数学题，请依次回复每道题的答案：',
      '',
      '**第 1 题 · 计算题**',
      '计算：(120 + 30) × 4 ÷ 5 = ?',
      '',
      '**第 2 题 · 应用题**',
      '某工区有 120 名员工，其中 40% 是技术岗，技术岗中 25% 是女性。技术岗女性有多少人？',
      '',
      '**第 3 题 · 比例题**',
      '3 名员工每天完成 12 个任务，8 名员工每天完成多少个任务？',
      '',
      '**第 4 题 · 百分数题**',
      '计划完成 200 个任务，实际完成 180 个，实际比计划少百分之多少？',
      '',
      '**第 5 题 · 时间计算**',
      '从 19:52 开始，经过 3 小时 28 分钟后是什么时间？',
      '',
      '**第 6 题 · 几何题**',
      '正方形边长 15 米，面积是多少平方米？',
    ].join('\n')
    mocked.mockImplementationOnce(async () => ({
      text: mathText,
      reasoning: '',
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
    }))

    const { deps, actor } = testEnv()
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '出六道数学题测试一下' }],
      maxTokens: 32,
      emit: () => {},
    })

    expect(result?.clarify?.questions).toHaveLength(6)
    expect(result?.clarify?.questions?.every((question) => question.kind === 'text')).toBe(true)
  })

  it('模型把整组题写成正文时，强制修复为可翻页的题组卡片', async () => {
    state.toolLists.length = 0
    state.calls = 0
    state.args = {
      questions: [
        { question: '第 1 题：可以直接离开现场吗？', kind: 'single', options: [{ label: '正确' }, { label: '错误' }] },
        { question: '第 2 题：红灯表示什么？', kind: 'single', options: [{ label: '停车' }, { label: '通行' }] },
      ],
    }
    const { callModelStream } = await import('../src/llm.js')
    const mocked = callModelStream as unknown as { mockImplementationOnce: (fn: () => unknown) => void }
    mocked.mockImplementationOnce(async () => ({
      text: '好，开始！\n\n第 1 题：可以直接离开现场吗？\n1. 正确\n2. 错误\n\n第 2 题：红灯表示什么？\n1. 停车\n2. 通行',
      reasoning: '',
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
    }))

    const { deps, actor } = testEnv()
    const events: Array<{ type: string; clarify?: unknown }> = []
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '出十道题我来做' }],
      maxTokens: 32,
      emit: (event) => events.push(event),
    })

    expect(result?.clarify?.questions).toHaveLength(2)
    expect(result?.clarify?.options.map((option) => option.label)).toEqual(['正确', '错误'])
    expect(events.some((event) => event.type === 'clarify')).toBe(true)
  })

  it('强制修复仍返回正文时，服务端从纯文本题面生成题卡兜底', async () => {
    const { callModelStream } = await import('../src/llm.js')
    const mocked = callModelStream as unknown as { mockImplementationOnce: (fn: () => unknown) => void }
    const plainQuiz = async () => ({
      text: '第 1 题：红灯表示什么？\n1. 停车\n2. 通行\n\n第 2 题：绿灯表示什么？\n1. 加速\n2. 按规定速度通过',
      reasoning: '',
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
    })
    mocked.mockImplementationOnce(plainQuiz)
    mocked.mockImplementationOnce(plainQuiz)

    const { deps, actor } = testEnv()
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '出两道题考我' }],
      maxTokens: 32,
      emit: () => {},
    })

    expect(result?.clarify?.questions).toHaveLength(2)
    expect(result?.clarify?.question).toContain('红灯')
    expect(result?.clarify?.options.map((option) => option.label)).toEqual(['停车', '通行'])
    expect(result?.text).toContain('红灯')
  })

  it('模型把单题放进 questions 时，仍只按单题卡片下发', async () => {
    state.args = {
      questions: [
        { question: '第 1 题：红灯表示什么？', kind: 'single', options: [{ label: '停车' }, { label: '通行' }] },
      ],
    }
    const { deps, actor } = testEnv()
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '出一道题考我' }],
      maxTokens: 32,
      emit: () => {},
    })

    expect(state.messageTexts[0]).toContain('本轮出题路由：单题卡')
    expect(result?.clarify?.questions).toBeUndefined()
    expect(result?.clarify?.question).toContain('红灯')
    expect(result?.clarify?.options.map((option) => option.label)).toEqual(['停车', '通行'])
  })

  it('用户要求多题但顺带说“一次一题”时，仍按题组卡而不是拆成单题', async () => {
    state.args = {
      questions: [
        { question: '第 1 题：红灯表示什么？', kind: 'single', options: [{ label: '停车' }, { label: '通行' }] },
        { question: '第 2 题：绿灯表示什么？', kind: 'single', options: [{ label: '加速' }, { label: '按规定速度通过' }] },
      ],
    }
    const { deps, actor } = testEnv()
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '出2道题，一次一题来' }],
      maxTokens: 32,
      emit: () => {},
    })

    expect(state.messageTexts[0]).toContain('本轮出题路由：题组卡')
    expect(result?.clarify?.questions).toHaveLength(2)
  })

  it('用户说“不要一次一题”时仍按题组卡路由，不能误判成单题', async () => {
    state.args = {
      questions: [
        { question: '第 1 题：红灯表示什么？', kind: 'single', options: [{ label: '停车' }, { label: '通行' }] },
        { question: '第 2 题：绿灯表示什么？', kind: 'single', options: [{ label: '加速' }, { label: '按规定速度通过' }] },
      ],
    }
    const { deps, actor } = testEnv()
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [{ role: 'user', content: '出5道题，用引导模式，我要上一题下一题翻页，不要一次一题' }],
      maxTokens: 32,
      emit: () => {},
    })

    expect(state.messageTexts[0]).toContain('本轮出题路由：题组卡')
    expect(state.messageTexts[0]).not.toContain('本轮出题路由：单题卡')
    expect(result?.clarify?.questions).toHaveLength(2)
  })

  it('连续答题后用户只问“现在能引导对话吗”，仍按题组卡路由', async () => {
    state.args = {
      questions: [
        { question: '第 4 题：红灯表示什么？', kind: 'single', options: [{ label: '停车' }, { label: '通行' }] },
        { question: '第 5 题：绿灯表示什么？', kind: 'single', options: [{ label: '加速' }, { label: '按规定速度通过' }] },
      ],
    }
    const { deps, actor } = testEnv()
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [
        { role: 'user', content: '出十道题我来做' },
        { role: 'assistant', content: '第 1 题：可以直接离开现场吗？\n1. 正确\n2. 错误' },
        { role: 'user', content: '正确' },
        { role: 'assistant', content: '第 1 题 ✅ 正确。\n\n第 2 题：红灯表示什么？\n1. 停车\n2. 通行' },
        { role: 'user', content: '现在能引导对话吗' },
      ],
      maxTokens: 32,
      emit: () => {},
    })

    expect(state.messageTexts[0]).toContain('本轮出题路由：题组卡')
    expect(result?.clarify?.questions).toHaveLength(2)
  })

  it('答完一题后模型又用正文出下一题，仍改成单题卡片', async () => {
    const { callModelStream } = await import('../src/llm.js')
    const mocked = callModelStream as unknown as { mockImplementationOnce: (fn: () => unknown) => void }
    const plainNextQuestion = async () => ({
      text: '第 2 题：绿灯表示什么？\n1. 加速\n2. 按规定速度通过',
      reasoning: '',
      toolCalls: [],
      promptTokens: 1,
      completionTokens: 1,
    })
    mocked.mockImplementationOnce(plainNextQuestion)
    mocked.mockImplementationOnce(plainNextQuestion)

    const { deps, actor } = testEnv()
    const result = await runAgentTurn({
      deps,
      actor,
      modelId: 'model_test',
      messages: [
        { role: 'user', content: '出十道题我来做' },
        { role: 'assistant', content: '第 1 题：红灯表示什么？\n1. 停车\n2. 通行' },
        { role: 'user', content: '正确' },
      ],
      maxTokens: 32,
      emit: () => {},
    })

    expect(result?.clarify?.questions).toBeUndefined()
    expect(result?.clarify?.question).toContain('绿灯')
    expect(result?.clarify?.options.map((option) => option.label)).toEqual(['加速', '按规定速度通过'])
  })
})
