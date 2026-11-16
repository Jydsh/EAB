import { describe, expect, it } from 'vitest'
import {
  buildDingTalkA2UIArtifactAnnotations,
  buildDingTalkA2UICreateMessages,
  buildDingTalkA2UIUpdateMessages,
  dingTalkConversationSummary,
  DingTalkAICardStream,
  flattenMarkdownTables,
  renderDingTalkProgressCard,
} from '../src/dingtalk-card.js'

function parsed(messages: string[]): Array<Record<string, any>> {
  return messages.map((message) => JSON.parse(message) as Record<string, any>)
}

function initialData(messages: string[]): Record<string, any> {
  return parsed(messages).find((message) => message.updateDataModel?.path === '/')?.updateDataModel?.value
}

function updateValues(messages: string[]): Record<string, unknown> {
  return Object.fromEntries(
    parsed(messages)
      .filter((message) => message.updateDataModel?.path)
      .map((message) => [message.updateDataModel.path, message.updateDataModel.value]),
  )
}

function uiValues(messages: string[]): Record<string, unknown> {
  const values = updateValues(messages)
  const ui = values['/ui'] as Record<string, unknown> | undefined
  const direct = Object.fromEntries(
    Object.entries(values).filter(([path]) => path.startsWith('/ui/')),
  )
  return {
    ...Object.fromEntries(Object.entries(ui ?? {}).map(([key, value]) => [`/ui/${key}`, value])),
    ...direct,
  }
}

function componentsOf(messages: string[]): Array<Record<string, any>> {
  return parsed(messages).find((message) => message.updateComponents)?.updateComponents.components as Array<
    Record<string, any>
  >
}

function answerBlock(messages: string[], index = 0): Record<string, any> | undefined {
  const answer = updateValues(messages)['/answer'] as { blocks?: Array<Record<string, any>> } | undefined
  return answer?.blocks?.[index]
}

function finalComponentsOf(messages: string[]): Array<Record<string, any>> {
  const byId = new Map<string, Record<string, any>>()
  for (const message of parsed(messages)) {
    const list = (message.updateComponents as { components?: Array<Record<string, any>> } | undefined)?.components
    if (!Array.isArray(list)) continue
    for (const component of list) {
      if (component?.id) byId.set(String(component.id), component)
    }
  }
  return [...byId.values()]
}

describe('钉钉 A2UI 卡片可见性与底色', () => {
  it('把回答正文段标为 artifact，供钉钉生成会话列表正文', () => {
    expect(buildDingTalkA2UIArtifactAnnotations('s')).toEqual(
      Array.from({ length: 24 }, (_, index) => ({
        surfaceId: 's',
        componentId: `answerText${index}`,
        type: 'artifact',
      })),
    )
  })

  it('首帧即使还没拿到推理内容，也显示“正在思考中”和一行占位摘要', () => {
    const data = initialData(
      buildDingTalkA2UICreateMessages('s', {
        answer: '',
        reasoning: '',
        tools: [],
        thinkingDone: false,
      }),
    )
    expect(data.ui).toMatchObject({
      showThinking: true,
      showThinkingPreview: true,
      showThinkingHeader: true,
      thinkingExpanded: false,
      showTools: false,
    })
    expect(data.thinking.preview).toBe('正在分析你的问题…')
    expect(data.thinking.header).toBe('✦ 思考中 · 正在分析你的问题…')
    const components = componentsOf(
      buildDingTalkA2UICreateMessages('s', { answer: '', reasoning: '', tools: [], thinkingDone: false }),
    )
    expect(components.find((component) => component.id === 'thinkingHeader')).toMatchObject({
      component: 'Text',
      text: { path: '/thinking/header' },
      maxLine: 1,
      weight: 1,
      variant: 'body',
    })
    expect(components.find((component) => component.id === 'thinkingBody')).toMatchObject({
      component: 'Markdown',
      content: { path: '/thinking/text' },
      visible: { path: '/ui/thinkingExpanded' },
    })
    expect(components.find((component) => component.id === 'thinkingPanel')).toBeUndefined()
  })

  it('思考阶段只显示思考面板，标题下带流式预览，不用“等待工具调用”占位', () => {
    const data = initialData(
      buildDingTalkA2UICreateMessages('s', {
        answer: '',
        reasoning: '先确认用户身份，再查部门',
        tools: [],
        thinkingDone: false,
      }),
    )
    expect(data.ui).toMatchObject({
      showThinking: true,
      showThinkingPreview: true,
      showTools: false,
      showToolsPreview: false,
    })
    expect(data.thinking.text).toContain('先确认用户身份')
    expect(data.thinking.preview).toContain('先确认用户身份')
    expect(data.thinking.header).toContain('✦ 思考中 · 先确认用户身份')
    expect(data.tools.text).toBe('')
  })

  it('思考结束后保留首句预览，并把标题切成“已思考 X.Xs”', () => {
    const messages = buildDingTalkA2UIUpdateMessages(
      's',
      {
        answer: '答案',
        reasoning: '先确认用户身份，再查部门。\n第二段不应出现在预览里。',
        tools: [],
        thinkingDone: true,
        thinkingMs: 3200,
      },
      true,
    )
    expect(uiValues(messages)).toMatchObject({
      '/ui/showThinking': true,
      '/ui/showThinkingPreview': true,
      '/ui/showTools': false,
      '/ui/showToolsPreview': false,
    })
    expect(updateValues(messages)['/thinking/preview']).toBe('先确认用户身份，再查部门。')
    expect(updateValues(messages)['/thinking/header']).toBe(
      '✦ 已思考 3.2s · 先确认用户身份，再查部门。',
    )
    const thinkingHeader = finalComponentsOf(messages).find((component) => component.id === 'thinkingHeader')
    expect(thinkingHeader?.textEffect).toBeUndefined()
  })

  it('真正调用工具后仍显示“思考中”标题和思考摘要，工具结束后工具面板保留数量与耗时', () => {
    const tooling = updatesOfTooling()
    expect(uiValues(tooling)).toMatchObject({
      '/ui/showThinking': true,
      '/ui/showThinkingPreview': true,
      '/ui/showTools': true,
      '/ui/showToolsPreview': true,
    })
    expect(updateValues(tooling)['/thinking/preview']).toContain('查一下')
    expect(updateValues(tooling)['/tools/text']).toContain('org.directory')
    expect(updateValues(tooling)['/tools/text']).toContain('参数：')
    expect(updateValues(tooling)['/tools/preview']).toContain('org.directory')

    const final = buildDingTalkA2UIUpdateMessages(
      's',
      {
        answer: '答案',
        reasoning: '查一下',
        tools: ['org.directory'],
        thinkingDone: true,
        thinkingMs: 1200,
        toolDetails: [
          {
            id: '1-1',
            name: 'org.directory',
            toolId: 'org.directory',
            args: { query: '部门' },
            status: 'done',
            summary: '找到 3 个部门',
            durationMs: 320,
          },
        ],
      },
      false,
    )
    expect(uiValues(final)).toMatchObject({
      '/ui/showThinking': true,
      '/ui/showThinkingPreview': true,
      '/ui/showTools': true,
      '/ui/showToolsPreview': true,
    })
    expect(updateValues(final)['/thinking/preview']).toBe('查一下')
    expect(updateValues(final)['/thinking/header']).toBe('✦ 已思考 1.2s · 查一下')
    expect(updateValues(final)['/tools/preview']).toBe('org.directory · 320ms')
    expect(updateValues(final)['/tools/header']).toBe('• 工具 · org.directory · 320ms')
    expect(updateValues(final)['/tools/text']).toContain('**org.directory** · 320ms')
    expect(updateValues(final)['/tools/text']).not.toContain('参数：')
    expect(updateValues(final)['/tools/text']).not.toContain('结果：找到 3 个部门')
    const finalHeaders = finalComponentsOf(final)
    expect(finalHeaders.find((component) => component.id === 'thinkingHeader')?.textEffect).toBeUndefined()
    expect(finalHeaders.find((component) => component.id === 'toolHeader')?.textEffect).toBeUndefined()
  })

  it('工具详情还没到时仍保持正在思考，并给工具面板补一行工具名', () => {
    const tooling = buildDingTalkA2UIUpdateMessages(
      's',
      { answer: '', reasoning: '查一下', tools: ['org.directory'], thinkingDone: false },
      true,
    )
    expect(uiValues(tooling)).toMatchObject({
      '/ui/showThinking': true,
      '/ui/showThinkingPreview': true,
      '/ui/showTools': true,
      '/ui/showToolsPreview': true,
    })
    expect(updateValues(tooling)['/thinking/preview']).toContain('查一下')
    expect(updateValues(tooling)['/tools/preview']).toBe('org.directory · 执行中')
    expect(updateValues(tooling)['/tools/header']).toBe('• 工具调用中 · org.directory · 执行中')
    expect(updateValues(tooling)['/tools/text']).toContain('org.directory')
  })

  it('没有工具调用时完成后不显示工具面板', () => {
    const final = buildDingTalkA2UIUpdateMessages(
      's',
      { answer: '答案', reasoning: '想过一下', tools: [], thinkingDone: true, thinkingMs: 800 },
      false,
    )
    expect(uiValues(final)).toMatchObject({
      '/ui/showThinking': true,
      '/ui/showThinkingPreview': true,
      '/ui/showTools': false,
      '/ui/showToolsPreview': false,
    })
    expect(updateValues(final)['/thinking/preview']).toBe('想过一下')
    expect(updateValues(final)['/thinking/header']).toBe('✦ 已思考 0.8s · 想过一下')
    expect(answerBlock(final)?.text).toBe('答案')
  })

  it('钉盘附件挂到 File 组件，行点击用 previewUrl 打开预览', () => {
    const state = {
      answer: '文件已发送',
      reasoning: '',
      tools: [],
      thinkingDone: true,
      attachments: [
        {
          fileName: '安全防护记录本.docx',
          url: 'https://preview.example/file',
          previewUrl: 'https://preview.example/file',
          size: 15968,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          description: '钉盘在线预览',
        },
      ],
    }
    const messages = buildDingTalkA2UIUpdateMessages('s', state, false)
    expect(updateValues(messages)['/attachments']).toHaveLength(1)
    expect(uiValues(messages)).toMatchObject({
      '/ui/showAttachments': true,
      '/ui/showAttachment0': true,
      '/ui/showAttachment1': false,
      '/ui/showAttachment2': false,
    })
    const components = componentsOf(buildDingTalkA2UICreateMessages('s', state))
    const file = components.find((component) => component.id === 'attachment0')
    expect(file).toMatchObject({
      component: 'File',
      fileName: { path: '/attachments/0/fileName' },
      url: { path: '/attachments/0/url' },
      previewUrl: { path: '/attachments/0/previewUrl' },
      size: { path: '/attachments/0/size' },
    })
  })

  it('已有上一帧时只发送变化的字段，不重复下发组件树', () => {
    const previous = { answer: '你好', reasoning: '想过一下', tools: [], thinkingDone: true }
    const messages = buildDingTalkA2UIUpdateMessages(
      's',
      { ...previous, answer: '你好，世界' },
      true,
      previous,
    )
    const answer = updateValues(messages)['/answer'] as { blocks: Array<Record<string, any>> }
    expect(answer.blocks[0]?.text).toBe('你好，世界')
    expect(Object.keys(updateValues(messages))).toEqual(['/answer'])
    expect(messages.some((message) => 'updateComponents' in JSON.parse(message))).toBe(false)
  })

  it('普通业务表保留全部列，不因手机宽度被截成三列', () => {
    const answer = [
      '| 检查人 | 站名 | 位置 | 问题 | 类别 | 处理人 |',
      '|---|---|---|---|---|---|',
      '| 邓骏 | 银花 | 信息机房·照明 | 平板灯故障 | 功能异常 | 李杰 |',
    ].join('\n')
    const messages = buildDingTalkA2UIUpdateMessages(
      's',
      { answer, reasoning: '', tools: [], thinkingDone: true },
      false,
    )
    const blocks = (updateValues(messages)['/answer'] as { blocks: Array<Record<string, any>> }).blocks
    expect(blocks[0]?.table?.meta?.map((column: any) => column.colName)).toEqual([
      '检查人',
      '站名',
      '位置',
      '问题',
      '类别',
      '处理人',
    ])
  })

  it('多部门多表回答不会被块上限降级成纯文本', () => {
    const answer = Array.from({ length: 9 }, (_, index) =>
      [
        `## 第 ${index + 1} 组`,
        '',
        '| 检查人 | 站名 |',
        '|---|---|',
        '| 张三 | 银花 |',
      ].join('\n'),
    ).join('\n\n')
    const messages = buildDingTalkA2UIUpdateMessages(
      's',
      { answer, reasoning: '', tools: [], thinkingDone: true },
      false,
    )
    const blocks = (updateValues(messages)['/answer'] as { blocks: Array<Record<string, any>> }).blocks
    const tables = blocks.filter((block) => block.table?.meta?.length > 0)
    expect(tables).toHaveLength(9)
    expect(tables.at(-1)?.table?.meta?.map((column: any) => column.colName)).toEqual(['检查人', '站名'])
  })

  it('正文流式时不追加光标或 loading GIF 组件', () => {
    const streaming = buildDingTalkA2UIUpdateMessages(
      's',
      { answer: '答案', reasoning: '', tools: [], thinkingDone: true },
      true,
    )
    expect(answerBlock(streaming)?.text).toBe('答案')
    expect(uiValues(streaming)).not.toHaveProperty('/ui/showAnswerSpinner')

    const final = buildDingTalkA2UIUpdateMessages(
      's',
      { answer: '答案', reasoning: '', tools: [], thinkingDone: true },
      false,
    )
    expect(answerBlock(final)?.text).toBe('答案')
  })

  it('正文为空时不注入任何占位内容', () => {
    const messages = buildDingTalkA2UIUpdateMessages(
      's',
      { answer: '', reasoning: '正在分析', tools: [], thinkingDone: false },
      true,
    )
    expect(answerBlock(messages)?.text).toBe('')
  })

  it('思考结束或工具状态变化时只重发头部组件，不重建整张折叠面板', () => {
    const previous = { answer: '', reasoning: '先确认身份', tools: [], thinkingDone: false }
    const messages = buildDingTalkA2UIUpdateMessages(
      's',
      { answer: '答案', reasoning: '先确认身份', tools: ['org.directory'], thinkingDone: true },
      true,
      previous,
    )
    const components = finalComponentsOf(messages)
    expect(components.find((component) => component.id === 'thinkingHeader')).toBeDefined()
    expect(components.find((component) => component.id === 'toolHeader')).toBeDefined()
    expect(components.find((component) => component.id === 'thinkingPanel')).toBeUndefined()
    expect(components.find((component) => component.id === 'toolPanel')).toBeUndefined()
  })

  it('根卡片显式白色，思考和工具入口是 Row + Text + 独立箭头的严格单行头部', () => {
    const data = initialData(
      buildDingTalkA2UICreateMessages('s', { answer: '', reasoning: '', tools: [] }),
    )
    const components = componentsOf(
      buildDingTalkA2UICreateMessages('s', { answer: '', reasoning: '', tools: [] }),
    )
    const root = components.find((component) => component.id === 'root')!
    const thinkingHeader = components.find((component) => component.id === 'thinkingHeader')!
    const thinkingBody = components.find((component) => component.id === 'thinkingBody')!
    const toolHeader = components.find((component) => component.id === 'toolHeader')!
    const toolBody = components.find((component) => component.id === 'toolBody')!
    expect(root).toMatchObject({ component: 'Card', backgroundColorToken: 'common_bg_color' })
    expect(root.child).toBe('rootColumn')
    expect(data.thinking.header).toBe('✦ 思考中 · 正在分析你的问题…')
    // 收起态只保留一个 Text：标题、首句和箭头都在 /thinking/header 里，
    // 不能再有 CollapsiblePanel 标题 + 独立预览两个节点。
    expect(thinkingHeader).toMatchObject({
      component: 'Text',
      text: { path: '/thinking/header' },
      maxLine: 1,
      weight: 1,
      variant: 'body',
      onLinkClick: {
        event: {
          name: 'eab_panel_toggle',
          context: { action: 'panel_toggle', panel: 'thinking' },
        },
      },
    })
    expect(thinkingHeader.textEffect).toBe('shimmer')
    expect(thinkingBody).toMatchObject({
      component: 'Markdown',
      content: { path: '/thinking/text' },
      visible: { path: '/ui/thinkingExpanded' },
    })
    expect(data.ui.thinkingExpanded).toBe(false)
    expect(toolHeader).toMatchObject({
      component: 'Text',
      text: { path: '/tools/header' },
      maxLine: 1,
      onLinkClick: {
        event: {
          name: 'eab_panel_toggle',
          context: { action: 'panel_toggle', panel: 'tools' },
        },
      },
    })
    expect(toolHeader.textEffect).toBeUndefined()
    expect(toolBody).toMatchObject({
      component: 'Markdown',
      content: { path: '/tools/text' },
      visible: { path: '/ui/toolsExpanded' },
    })
    expect(components.find((component) => component.id === 'answerSpinner')).toBeUndefined()
    expect(components.find((component) => component.id === 'answerRow')).toMatchObject({
      component: 'Row',
      align: 'end',
      children: ['answerBlocks'],
    })
  })

  it('工具执行中头部流光，工具结束后切回“工具”并停止', () => {
    const running = {
      answer: '',
      reasoning: '正在查询组织架构…',
      tools: ['org.search'],
      thinkingDone: false,
      toolDetails: [{ id: 'tool-1', name: 'org.search', status: 'running' as const }],
    }
    const runningComponents = componentsOf(buildDingTalkA2UICreateMessages('s-running', running))
    const runningTool = runningComponents.find((component) => component.id === 'toolHeader')!
    expect(runningTool).toMatchObject({
      text: { path: '/tools/header' },
      textEffect: 'shimmer',
    })

    const done = {
      ...running,
      tools: ['org.search'],
      thinkingDone: true,
      thinkingMs: 3200,
      toolDetails: [{ id: 'tool-1', name: 'org.search', status: 'done' as const, durationMs: 128 }],
    }
    const messages = buildDingTalkA2UIUpdateMessages('s-running', done, false, running)
    expect(updateValues(messages)['/thinking/header']).toBe(
      '✦ 已思考 3.2s · 正在查询组织架构…',
    )
    expect(updateValues(messages)['/tools/header']).toBe('• 工具 · org.search · 128ms')
    const finalComponents = finalComponentsOf(messages)
    const finalTool = finalComponents.find((component) => component.id === 'toolHeader')!
    const finalThinking = finalComponents.find((component) => component.id === 'thinkingHeader')!
    expect(finalTool.textEffect).toBeUndefined()
    expect(finalThinking.textEffect).toBeUndefined()
  })

  it('旧模板卡显示流式预览，工具执行期间不退回“已深度思考”', () => {
    expect(renderDingTalkProgressCard({ answer: '', reasoning: '', tool: '', thinkingDone: false })).toBe(
      '**✦ 正在思考中…**\n\n> 正在分析你的问题…',
    )
    const thinking = renderDingTalkProgressCard({
      answer: '',
      reasoning: '先确认用户身份，再查部门',
      tool: '',
      thinkingDone: false,
    })
    expect(thinking).toContain('**✦ 正在思考中…**')
    expect(thinking).toContain('> 先确认用户身份')
    expect(
      renderDingTalkProgressCard({ answer: '', reasoning: '想过一下', tool: '', thinkingDone: true }),
    ).toBe('**✦ 已深度思考**')
    const tooling = renderDingTalkProgressCard({
      answer: '',
      reasoning: '先查部门',
      tool: '',
      tools: ['org.directory'],
      thinkingDone: false,
    })
    expect(tooling).toContain('**✦ 正在思考中…**')
    expect(tooling).toContain('> 先查部门')
    expect(tooling).toContain('**🛠️ 工具调用中…**')
    expect(tooling).toContain('org.directory')
    const done = renderDingTalkProgressCard({
      answer: '',
      reasoning: '',
      tool: '',
      tools: ['org.directory'],
      thinkingDone: true,
    })
    expect(done).toContain('**✦ 已深度思考**')
    expect(done).toContain('**🛠️ 工具调用中…**')
    expect(done).toContain('org.directory')
    expect(done).not.toContain('正在思考')
  })

  it('宽表格拆成竖排列表，手机端不再把更新时间列裁掉', () => {
    const markdown = [
      '有内容了 ✅ 云空间里目前有 2 个文件：',
      '',
      '| 文件 | 大小 | 更新时间 |',
      '|---|---|---|',
      '| `notes/工作记忆.md` | 1.9 KB | 今天 17:35 |',
      '| `notes/对话记录-20251109.md` | 1.4 KB | 昨天 |',
    ].join('\n')
    const flattened = flattenMarkdownTables(markdown)
    expect(flattened).toContain('**文件**')
    expect(flattened).toContain('- `notes/工作记忆.md` · 大小：1.9 KB · 更新时间：今天 17:35')
    expect(flattened).toContain('- `notes/对话记录-20251109.md` · 大小：1.4 KB · 更新时间：昨天')
    expect(flattened).not.toContain('| --- |')
  })

  it('手机宽度能放下的短表格保持 Markdown 表格', () => {
    const weather = [
      '| 时间 | 雨概率 | 预计降水 |',
      '|---|---|---|',
      '| 23:00-00:00 | 30% | 0.1mm |',
      '| 03:00 | 48% | 0.2mm |',
    ].join('\n')
    expect(flattenMarkdownTables(weather)).toBe(weather)
  })

  it('两列表格保持原样，代码块里的竖线不参与拆分', () => {
    const twoColumns = '| 项目 | 内容 |\n|---|---|\n| 岗位 | 技术员 |'
    expect(flattenMarkdownTables(twoColumns)).toBe(twoColumns)
    const fenced = '```\n| a | b | c |\n|---|---|---|\n```'
    expect(flattenMarkdownTables(fenced)).toBe(fenced)
  })

  it('A2UI 回答正文里的表格走原生 Table，保留真表格和可滚动列', () => {
    const markdown = [
      '你当前共有 1 个文件：',
      '',
      '| # | 文件名 | 路径 | 大小 | 更新时间 |',
      '|---|---|---|---|---|',
      '| 1 | `工作记忆.md` | `notes/工作记忆.md` | 1.9 KB | 2026-11-10 17:35 |',
    ].join('\n')
    const messages = buildDingTalkA2UIUpdateMessages(
      's',
      { answer: markdown, reasoning: '', tools: [], thinkingDone: true },
      true,
    )
    const blocks = (updateValues(messages)['/answer'] as { blocks: Array<Record<string, any>> }).blocks
    expect(blocks[0]?.text).toBe('你当前共有 1 个文件：')
    expect(blocks[1]?.table).toEqual({
      meta: [
        { colKey: 'c0', colName: '文件', type: 'text' },
        { colKey: 'c1', colName: '大小', type: 'text' },
        { colKey: 'c2', colName: '更新时间', type: 'text' },
      ],
      data: [
        {
          c0: '工作记忆.md（notes/工作记忆.md）',
          c1: '1.9 KB',
          c2: '2026-11-10 17:35',
        },
      ],
    })
    const components = componentsOf(buildDingTalkA2UICreateMessages('s', { answer: markdown, reasoning: '', tools: [] }))
    expect(components.find((component) => component.id === 'answerTable1')).toMatchObject({
      component: 'Table',
      data: { path: '/answer/blocks/1/table' },
      scrollAreaWidth: 320,
      visible: { path: '/ui/showAnswerTable1' },
    })
  })

  it('会话列表摘要由机器人回复正文生成，不带品牌前缀，并去掉 Markdown 标记', () => {
    const summary = dingTalkConversationSummary('  现在是 **2026年11月9日 11:36**（周一中午）。 ')
    expect(summary).toBe('现在是 2026年11月9日 11:36（周一中午）。')
    expect(summary).not.toContain('思考')
    expect(summary).not.toContain('**')
    expect(summary.startsWith('EAB')).toBe(false)
    expect(dingTalkConversationSummary('')).toBe('EAB 企业智能助手')
    expect(dingTalkConversationSummary('一'.repeat(80)).endsWith('…')).toBe(true)
  })

  it('澄清请求生成整行可点击选项，卡片带回 sessionId 和选项标识', () => {
    const messages = buildDingTalkA2UIUpdateMessages(
      's',
      {
        answer: '你想先做哪件事？\n\n也可以直接回复你自己的方向。',
        reasoning: '',
        tools: [],
        thinkingDone: true,
        clarify: {
          sessionId: 'chat_test',
          question: '你想先做哪件事？',
          allowCustom: true,
          options: [
            { id: 'option-1', label: '查公司部门', description: '按组织架构查' },
            { id: 'option-2', label: '查检查整治', description: '看近期台账' },
          ],
        },
      },
      false,
    )
    expect(updateValues(messages)['/clarify']).toMatchObject({
      sessionId: 'chat_test',
      badge: '需要你确认方向',
      hint: '**请选择一个方向继续**，也可以直接回复你自己的方向',
      options: [
        { id: 'option-1', label: '查公司部门', description: '按组织架构查' },
        { id: 'option-2', label: '查检查整治', description: '看近期台账' },
      ],
    })
    expect(uiValues(messages)).toMatchObject({
      '/ui/showClarify': true,
      '/ui/showClarifyOption0': true,
      '/ui/showClarifyOption1': true,
      '/ui/showClarifyOption2': false,
      '/ui/showClarifyDesc0': true,
    })
    const components = finalComponentsOf(messages)
    expect(components.find((component) => component.id === 'clarifyBadge')).toMatchObject({
      component: 'Tag',
      text: { path: '/clarify/badge' },
      theme: 'warning',
    })
    expect(components.find((component) => component.id === 'clarifyHint')).toMatchObject({
      component: 'Markdown',
      content: { path: '/clarify/hint' },
    })
    const option = components.find((component) => component.id === 'clarifyOptionCard0')
    expect(option).toMatchObject({
      component: 'Row',
      padding: 12,
      cornerRadius: 12,
      backgroundColor: '#141F7A4D',
      borderWidth: 1,
      visible: { path: '/ui/showClarifyOption0' },
      action: {
        event: {
          name: 'eab_clarify_select',
          context: {
            action: 'clarify_select',
            sessionId: 'chat_test',
            optionId: 'option-1',
            optionLabel: '查公司部门',
          },
        },
      },
    })
    expect(components.find((component) => component.id === 'clarifyOptionCard1')).toMatchObject({
      backgroundColor: '#0A1F7A4D',
      action: { event: { context: { optionId: 'option-2', optionLabel: '查检查整治' } } },
    })
    expect(components.find((component) => component.id === 'clarifyOptionLabel0')).toMatchObject({
      component: 'Text',
      text: { path: '/clarify/options/0/label' },
    })
    expect(components.find((component) => component.id === 'clarifyOptionDesc0')).toMatchObject({
      component: 'Text',
      variant: 'caption',
      text: { path: '/clarify/options/0/description' },
    })
    expect(components.find((component) => component.id === 'clarifyOptionArrow0')).toMatchObject({
      component: 'Text',
      text: '›',
    })
  })

  it('题组卡的正文不再重复渲染当前题干，题干只由澄清区展示', () => {
    const question = '第 1 题 · 判断题（安全）\n\n检修作业中，发现设备出现异常，应立即停止作业并报告。'
    const messages = buildDingTalkA2UIUpdateMessages(
      's',
      {
        answer: question,
        reasoning: '',
        tools: [],
        thinkingDone: true,
        clarify: {
          sessionId: 'chat_test',
          question,
          kind: 'single',
          options: [
            { id: 'option-1', label: '正确' },
            { id: 'option-2', label: '错误' },
          ],
          index: 0,
          questions: [
            { id: 'q1', question, kind: 'single', options: [
              { id: 'option-1', label: '正确' },
              { id: 'option-2', label: '错误' },
            ] },
            { id: 'q2', question: '第 2 题 · 选择题\n\n红灯表示什么？', kind: 'single', options: [
              { id: 'option-1', label: '停车' },
              { id: 'option-2', label: '通行' },
            ] },
          ],
        },
      },
      false,
    )

    const answerBlocks = updateValues(messages)['/answer'] as { blocks: Array<Record<string, any>> }
    expect(answerBlocks.blocks[0]?.text).toBe('')
    expect(uiValues(messages)).toMatchObject({
      '/ui/showAnswerText0': false,
      '/ui/showAnswerUnit0': false,
    })
    expect(updateValues(messages)['/clarify']).toMatchObject({
      question,
      progress: '第 1 / 2 题',
      total: 2,
      index: 0,
      badge: '请选择答案',
    })
  })

  it('带澄清选项的卡片收口后仍保持 PROCESSING，下一次点击才能续用同一张卡', async () => {
    const requests: Array<{ url: string; body: Record<string, any> }> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
      requests.push({ url, body })
      const response = url.includes('/v1.0/oauth2/accessToken')
        ? { accessToken: 'test-token', expireIn: 7200 }
        : { success: true }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(response),
      } as Response
    }) as typeof fetch

    try {
      const card = new DingTalkAICardStream('clarify-finish-app', 'secret', 'user-1', 'robot-1')
      expect(
        await card.start(
          { answer: '', reasoning: '正在分析…', tools: [], thinkingDone: false },
          'EAB 企业智能助手',
        ),
      ).toBe(true)
      requests.length = 0
      const ok = await card.finish(
        {
          answer: '你想先做哪件事？',
          reasoning: '分析完成',
          tools: [],
          thinkingDone: true,
          clarify: {
            sessionId: 'chat_test',
            question: '你想先做哪件事？',
            allowCustom: true,
            options: [{ id: 'option-1', label: '查公司部门', description: '按组织架构查' }],
            flowId: 'cf_test',
            step: 1,
            messageId: 'msg_assistant',
          },
        },
        '你想先做哪件事？',
      )
      expect(ok).toBe(true)
      const update = requests.filter((request) => request.url.endsWith('/v1.0/card/ai/instances/update')).at(-1)
      expect(update?.body.flowStatus).toBe('PROCESSING')
      expect(update?.body.flowStatus).not.toBe('FINISH')
      expect(
        requests.some(
          (request) =>
            request.url.endsWith('/v1.0/card/ai/instances/update') &&
            ['FINISH', 'FINISHED', 'COMPLETED', 'DONE'].includes(String(request.body.flowStatus)),
        ),
      ).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('网页已作答时把同一张澄清卡真正收口成完成态', async () => {
    const requests: Array<{ url: string; body: Record<string, any> }> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
      requests.push({ url, body })
      const response = url.includes('/v1.0/oauth2/accessToken')
        ? { accessToken: 'test-token', expireIn: 7200 }
        : { success: true }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(response),
      } as Response
    }) as typeof fetch

    try {
      const card = new DingTalkAICardStream('web-sync-app', 'secret', 'user-1', 'robot-1')
      await card.start(
        { answer: '', reasoning: '正在分析…', tools: [], thinkingDone: false },
        'EAB 企业智能助手',
      )
      requests.length = 0
      await card.finish({
        answer: '你想先做哪件事？',
        reasoning: '分析完成',
        tools: [],
        thinkingDone: true,
        clarify: {
          sessionId: 'chat_test',
          question: '你想先做哪件事？',
          allowCustom: true,
          options: [{ id: 'option-1', label: '查公司部门' }],
          flowId: 'cf_test',
          step: 1,
          messageId: 'msg_assistant',
        },
      })
      requests.length = 0
      const cardId = card.providerMessageIds[0]
      expect(
        await card.completeClarify(cardId, {
          answer: '✅ 已在网页工作台作答',
          reasoning: '',
          tools: [],
          thinkingDone: true,
          clarify: null,
        }),
      ).toBe(true)
      const update = requests.find((request) => request.url.endsWith('/v1.0/card/ai/instances/update'))
      expect(update?.body.flowStatus).toBe('FINISH')
      expect(update?.body.flowStatus).not.toBe('PROCESSING')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('单次流式刷新失败后保留卡片并继续收口，正文不残留光标', async () => {
    const requests: Array<{ url: string; body: Record<string, any> }> = []
    let updateAttempts = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
      requests.push({ url, body })
      const response = url.includes('/v1.0/oauth2/accessToken')
        ? { accessToken: 'test-token', expireIn: 7200 }
        : { success: true }
      if (url.endsWith('/v1.0/card/ai/instances/update')) {
        updateAttempts += 1
        if (updateAttempts === 1) throw new Error('temporary network error')
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(response),
      } as Response
    }) as typeof fetch

    try {
      const card = new DingTalkAICardStream('retry-finish-app', 'secret', 'user-1', 'robot-1')
      expect(
        await card.start(
          { answer: '', reasoning: '正在分析…', tools: [], thinkingDone: false },
          'EAB 企业智能助手',
        ),
      ).toBe(true)
      requests.length = 0
      card.update({ answer: '答', reasoning: '', tools: [], thinkingDone: true })
      // 等第一次刷新失败并把最新状态放回队列。
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(updateAttempts).toBeGreaterThanOrEqual(2)
      expect(await card.finish({ answer: '答', reasoning: '', tools: [], thinkingDone: true }, '答')).toBe(true)

      const updateBodies = requests
        .filter((request) => request.url.endsWith('/v1.0/card/ai/instances/update'))
        .flatMap((request) => request.body.a2uiMessages ?? [])
        .map((message: string) => JSON.parse(message) as Record<string, any>)
      const answer = updateBodies.find((message) => message.updateDataModel?.path === '/answer')?.updateDataModel
        ?.value as { blocks?: Array<Record<string, any>> } | undefined
      expect(answer?.blocks?.[0]?.text).toBe('答')
      expect(JSON.stringify(answer)).not.toMatch(/[▍▏]/)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('澄清卡片组件树每个子节点只有一个父节点，避免 A2UI 结构校验失败', () => {
    const state = {
      answer: '你想先做哪件事？',
      reasoning: '',
      tools: [],
      thinkingDone: true,
      clarify: {
        sessionId: 'chat_test',
        question: '你想先做哪件事？',
        allowCustom: true,
        options: [
          { id: 'option-1', label: '查公司部门', description: '按组织架构查' },
          { id: 'option-2', label: '查检查整治', description: '看近期台账' },
        ],
      },
    }
    const messages = [
      ...buildDingTalkA2UICreateMessages('s', state),
      ...buildDingTalkA2UIUpdateMessages('s', state, false),
    ]
    const components = finalComponentsOf(messages)
    const ids = new Set(components.map((component) => String(component.id)))
    const parentCount = new Map<string, number>()
    for (const component of components) {
      const children = [
        ...(Array.isArray(component.children) ? component.children : []),
        ...(component.child ? [component.child] : []),
      ]
      for (const child of children) {
        expect(ids.has(String(child)), `${component.id} 引用了不存在的子节点 ${child}`).toBe(true)
        parentCount.set(String(child), (parentCount.get(String(child)) ?? 0) + 1)
      }
    }
    for (const [id, count] of parentCount) {
      expect(count, `${id} 被多个父节点引用`).toBe(1)
    }
  })

  it('点击澄清选项后复用原卡片 outTrackId 更新，不创建第二条卡片', async () => {
    const requests: Array<{ url: string; body: Record<string, any> }> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
      requests.push({ url, body })
      const response = url.includes('/v1.0/oauth2/accessToken')
        ? { accessToken: 'test-token', expireIn: 7200 }
        : { success: true }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(response),
      } as Response
    }) as typeof fetch

    try {
      const card = new DingTalkAICardStream('resume-test-app', 'secret', 'user-1', 'robot-1')
      const ok = await card.resume('eab_a2ui_existing', {
        answer: '',
        reasoning: '已收到你的选择，正在继续…',
        tools: [],
        thinkingDone: false,
      })
      expect(ok).toBe(true)

      const update = requests.find((request) => request.url.endsWith('/v1.0/card/ai/instances/update'))
      expect(update).toBeTruthy()
      expect(update?.body.outTrackId).toBe('eab_a2ui_existing')
      expect(update?.body.flowStatus).toBe('PROCESSING')
      const messages = parsed(update?.body.a2uiMessages ?? [])
      expect(messages.some((message) => message.updateDataModel?.path === '/clarify')).toBe(true)
      expect(
        messages.find((message) => message.updateDataModel?.path === '/ui/showClarify')
          ?.updateDataModel?.value,
      ).toBe(false)
      expect(requests.some((request) => request.url.includes('createAndDeliver'))).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('终态整包被 400 拒绝时降级为纯数据终态，finish 仍成功不再回退文字', async () => {
    const requests: Array<{ url: string; body: Record<string, any> }> = []
    let updateAttempts = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
      requests.push({ url, body })
      if (url.includes('/v1.0/oauth2/accessToken')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ accessToken: 'fallback-token', expireIn: 7200 }),
        } as Response
      }
      if (url.endsWith('/v1.0/card/ai/instances/update')) {
        updateAttempts += 1
        // 真机日志：终态帧带 updateComponents 时被 400，错误文案却指向 flowStatus。
        if (updateAttempts === 1) {
          return {
            ok: false,
            status: 400,
            text: async () =>
              JSON.stringify({ code: 'InvalidflowStatus', message: 'Specified parameter flowStatus is not valid.' }),
          } as Response
        }
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true }),
      } as Response
    }) as typeof fetch

    try {
      const card = new DingTalkAICardStream('final-fallback-app', 'secret', 'user-1', 'robot-1')
      expect(
        await card.start(
          { answer: '', reasoning: '正在分析…', tools: [], thinkingDone: false },
          'EAB 企业智能助手',
        ),
      ).toBe(true)
      requests.length = 0
      updateAttempts = 0
      expect(
        await card.finish(
          { answer: '管理员信息没有找到。', reasoning: '先查通讯录', tools: [], thinkingDone: true, thinkingMs: 800 },
          '管理员信息没有找到。',
        ),
      ).toBe(true)
      const updates = requests.filter((request) => request.url.endsWith('/v1.0/card/ai/instances/update'))
      expect(updates).toHaveLength(2)
      expect(updates[1]?.body.flowStatus).toBe('FINISH')
      const messages = parsed(updates[1]?.body.a2uiMessages ?? [])
      expect(messages.some((message) => 'updateComponents' in message)).toBe(false)
      expect(
        messages.find((message) => message.updateDataModel?.path === '/answer')
          ?.updateDataModel?.value,
      ).toMatchObject({ blocks: expect.any(Array) })
    } finally {
      globalThis.fetch = realFetch
    }
  })


  it('切换思考/工具面板只更新一条展开数据，不重建组件树', async () => {
    const requests: Array<{ url: string; body: Record<string, any> }> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
      requests.push({ url, body })
      const response = url.includes('/v1.0/oauth2/accessToken')
        ? { accessToken: 'panel-toggle-token', expireIn: 7200 }
        : { success: true }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(response),
      } as Response
    }) as typeof fetch
    try {
      const card = new DingTalkAICardStream('panel-toggle-app', 'secret', 'user-1', 'robot-1')
      expect(await card.togglePanel('eab_a2ui_demo', 'thinking', true)).toBe(true)
      const update = requests.find((request) => request.url.endsWith('/v1.0/card/ai/instances/update'))
      expect(update?.body.outTrackId).toBe('eab_a2ui_demo')
      expect(update?.body.flowStatus).toBe('FINISH')
      const messages = parsed(update?.body.a2uiMessages ?? [])
      expect(messages).toHaveLength(1)
      expect(messages[0]?.updateDataModel).toMatchObject({
        surfaceId: 'eab_a2ui_surface_demo',
        path: '/ui/thinkingExpanded',
        value: true,
      })
      expect(messages.some((message) => 'updateComponents' in message)).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('续用失败后尽力收口旧卡，不让它一直停在处理中', async () => {
    const requests: Array<{ url: string; body: Record<string, any> }> = []
    let updateAttempts = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>
      requests.push({ url, body })
      if (url.includes('/v1.0/oauth2/accessToken')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ accessToken: 'test-token', expireIn: 7200 }),
        } as Response
      }
      if (url.endsWith('/v1.0/card/ai/instances/update')) {
        updateAttempts += 1
        if (updateAttempts === 1) throw new Error('temporary network error')
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true }),
      } as Response
    }) as typeof fetch

    try {
      const card = new DingTalkAICardStream('resume-fail-app', 'secret', 'user-1', 'robot-1')
      expect(
        await card.resume('eab_a2ui_existing', {
          answer: '',
          reasoning: '正在继续…',
          tools: [],
          thinkingDone: false,
        }),
      ).toBe(false)
      expect(
        await card.closeAfterResumeFailure('eab_a2ui_existing', '这一轮已转到新消息继续'),
      ).toBe(true)

      const update = requests
        .filter((request) => request.url.endsWith('/v1.0/card/ai/instances/update'))
        .at(-1)
      expect(update?.body.outTrackId).toBe('eab_a2ui_existing')
      expect(update?.body.flowStatus).toBe('FAILED')
      expect(JSON.stringify(update?.body)).toContain('这一轮已转到新消息继续')
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

function updatesOfTooling(): string[] {
  return buildDingTalkA2UIUpdateMessages(
    's',
    {
      answer: '',
      reasoning: '查一下',
      tools: ['org.directory'],
      thinkingDone: false,
      toolDetails: [
        {
          id: '1-1',
          name: 'org.directory',
          toolId: 'org.directory',
          args: { query: '部门' },
          status: 'running',
          summary: '',
          durationMs: 0,
        },
      ],
    },
    true,
  )
}

describe('钉钉 A2UI 多选与填空澄清', () => {
  function clarifyMessages(clarify: Record<string, unknown>) {
    return buildDingTalkA2UIUpdateMessages(
      's',
      {
        answer: String(clarify.question || ''),
        reasoning: '',
        tools: [],
        thinkingDone: true,
        clarify: {
          sessionId: 'chat_test',
          question: '',
          options: [],
          allowCustom: true,
          ...clarify,
        },
      },
      false,
    )
  }

  it('多选渲染为 ChoicePicker + 提交按钮，不显示单选行', () => {
    const messages = clarifyMessages({
      kind: 'multiple',
      question: '以下哪些必须完成？',
      options: [
        { id: 'option-1', label: '办理作业票' },
        { id: 'option-2', label: '安全预想' },
        { id: 'option-3', label: '挂设接地线' },
      ],
    })
    expect(updateValues(messages)['/clarify']).toMatchObject({
      kind: 'multiple',
      selected: [],
      options: [{ id: 'option-1' }, { id: 'option-2' }, { id: 'option-3' }],
    })
    expect(uiValues(messages)).toMatchObject({
      '/ui/showClarifyMultiple': true,
      '/ui/showClarifySingle': false,
      '/ui/showClarifyText': false,
      '/ui/showClarifySubmit': true,
      '/ui/showClarifyOption0': false,
    })
    const components = finalComponentsOf(messages)
    expect(components.find((component) => component.id === 'clarifyPicker')).toMatchObject({
      component: 'ChoicePicker',
      variant: 'multipleSelection',
      displayStyle: 'checkbox',
      visible: { path: '/ui/showClarifyMultiple' },
      value: { path: '/clarify/selected' },
      options: [
        { label: '办理作业票', value: 'option-1' },
        { label: '安全预想', value: 'option-2' },
        { label: '挂设接地线', value: 'option-3' },
      ],
    })
    expect(components.find((component) => component.id === 'clarifySubmit')).toMatchObject({
      component: 'Button',
      visible: { path: '/ui/showClarifySubmit' },
      action: {
        event: {
          name: 'eab_clarify_submit',
          context: {
            action: 'clarify_multi',
            sessionId: 'chat_test',
            selected: { path: '/clarify/selected' },
          },
        },
      },
    })
    expect(components.find((component) => component.id === 'clarifySubmitLabel')).toMatchObject({
      component: 'Text',
      text: '提交多选',
    })
  })

  it('填空渲染为 TextField + 提交按钮，context 带回文本路径', () => {
    const messages = clarifyMessages({
      kind: 'text',
      question: '请填写你的工号',
      placeholder: '例如 021724',
      options: [],
    })
    expect(updateValues(messages)['/clarify']).toMatchObject({
      kind: 'text',
      placeholder: '例如 021724',
      selected: [],
      text: '',
    })
    expect(uiValues(messages)).toMatchObject({
      '/ui/showClarifyText': true,
      '/ui/showClarifyMultiple': false,
      '/ui/showClarifySingle': false,
      '/ui/showClarifySubmit': true,
    })
    const components = finalComponentsOf(messages)
    expect(components.find((component) => component.id === 'clarifyTextField_0_1')).toMatchObject({
      component: 'TextField',
      variant: 'shortText',
      visible: { path: '/ui/showClarifyText' },
      label: '你的答案',
      placeholder: { path: '/clarify/placeholder' },
      value: { path: '/clarify/text' },
    })
    expect(components.find((component) => component.id === 'clarifySubmit')).toMatchObject({
      action: {
        event: {
          name: 'eab_clarify_submit',
          context: {
            action: 'clarify_text',
            text: { path: '/clarify/text' },
          },
        },
      },
    })
    expect(components.find((component) => component.id === 'clarifySubmitLabel')).toMatchObject({
      component: 'Text',
      text: '提交答案',
    })
  })

  it('填空题按题干里的每个横线渲染独立输入框', () => {
    const question = '第10题·填空题（制度）检修作业的基本安全原则是：\n\n“先 ______、再 ______、后作业”'
    const messages = clarifyMessages({
      kind: 'text',
      question,
      placeholder: '请填写答案',
      options: [],
    })
    expect(updateValues(messages)['/clarify']).toMatchObject({
      kind: 'text',
      displayQuestion: '第10题·填空题（制度）检修作业的基本安全原则是：\n\n“先 〔空1〕、再 〔空2〕、后作业”',
      blanks: ['', ''],
    })
    expect(uiValues(messages)).toMatchObject({
      '/ui/showClarifyBlanks': true,
      '/ui/showClarifyText': false,
      '/ui/showClarifySubmit': true,
    })
    const components = finalComponentsOf(messages)
    expect(components.find((component) => component.id === 'clarifyBlanks')).toMatchObject({
      component: 'Column',
      children: ['clarifyBlank_0_1_0', 'clarifyBlank_0_1_1'],
      visible: { path: '/ui/showClarifyBlanks' },
    })
    expect(components.find((component) => component.id === 'clarifyBlank_0_1_0')).toMatchObject({
      component: 'TextField',
      label: '第 1 空',
      value: { path: '/clarify/blanks/0' },
    })
    expect(components.find((component) => component.id === 'clarifyBlank_0_1_1')).toMatchObject({
      component: 'TextField',
      label: '第 2 空',
      value: { path: '/clarify/blanks/1' },
    })
    expect(components.find((component) => component.id === 'clarifySubmit')).toMatchObject({
      action: {
        event: {
          name: 'eab_clarify_submit',
          context: {
            action: 'clarify_text',
            blanks: { path: '/clarify/blanks' },
          },
        },
      },
    })
  })


  it('题组翻页时输入框按页换组件 ID，只回填当前题的答案', () => {
    const questions = [
      { id: 'q1', question: '第一题：先 ______、再 ______', kind: 'text', options: [] },
      { id: 'q2', question: '第二题：______', kind: 'text', options: [] },
    ]
    const first = clarifyMessages({
      questions,
      index: 0,
      answers: { 1: { selected: [], text: '停电、验电', blanks: ['停电', '验电'] } },
    })
    const second = clarifyMessages({ questions, index: 1 })
    const firstComponents = finalComponentsOf(first)
    const secondComponents = finalComponentsOf(second)
    expect(firstComponents.find((component) => component.id === 'clarifyBlanks')).toMatchObject({
      children: ['clarifyBlank_0_1_0', 'clarifyBlank_0_1_1'],
    })
    expect(secondComponents.find((component) => component.id === 'clarifyBlanks')).toMatchObject({
      children: ['clarifyBlank_1_1_0'],
    })
    expect(updateValues(second)['/clarify']).toMatchObject({ blanks: [''] })
    expect(secondComponents.find((component) => component.id === 'clarifyBlank_1_1_0')).toMatchObject({
      value: { path: '/clarify/blanks/0' },
    })
  })


  it('题组按当前页取题、回填草稿，并渲染上一题/下一题', () => {
    const questions = [
      { id: 'q1', question: '判断题', kind: 'single', options: [
        { id: 'option-1', label: '正确' },
        { id: 'option-2', label: '错误' },
      ] },
      { id: 'q2', question: '多选题', kind: 'multiple', options: [
        { id: 'option-1', label: '办理作业票' },
        { id: 'option-2', label: '安全预想' },
      ] },
      { id: 'q3', question: '填空题', kind: 'text', options: [], placeholder: '请输入编号' },
    ]
    const messages = clarifyMessages({
      questions,
      index: 1,
      answers: {
        1: { selected: ['正确'], text: '' },
        2: { selected: ['办理作业票'], text: '' },
      },
    })
    expect(updateValues(messages)['/clarify']).toMatchObject({
      kind: 'multiple',
      question: '多选题',
      total: 3,
      index: 1,
      progress: '第 2 / 3 题',
      selected: ['办理作业票'],
    })
    expect(uiValues(messages)).toMatchObject({
      '/ui/showClarifyMultiple': true,
      '/ui/showClarifyNav': true,
      '/ui/showClarifyPrev': true,
      '/ui/showClarifyNext': true,
      '/ui/showClarifySubmit': false,
    })
    const components = finalComponentsOf(messages)
    expect(components.find((component) => component.id === 'clarifyPrev')).toMatchObject({
      action: { event: { name: 'eab_clarify_nav', context: { direction: 'prev', index: 1 } } },
    })
    expect(components.find((component) => component.id === 'clarifyNext')).toMatchObject({
      action: { event: { name: 'eab_clarify_nav', context: { direction: 'next', index: 1 } } },
    })
    expect(components.find((component) => component.id === 'clarifyQuestion')).toMatchObject({
      component: 'Markdown',
      content: { path: '/clarify/displayQuestion' },
      visible: { path: '/ui/showClarify' },
    })
  })

  it('题组单选当前页的已选项带“✓ 已选”标记，未选项不变', () => {
    const questions = [
      { id: 'q1', question: '单选题', kind: 'single', options: [
        { id: 'option-1', label: '正确', description: '符合规程' },
        { id: 'option-2', label: '错误', description: '不符合规程' },
      ] },
      { id: 'q2', question: '第二题', kind: 'single', options: [
        { id: 'option-1', label: '甲' },
        { id: 'option-2', label: '乙' },
      ] },
    ]
    const messages = clarifyMessages({
      questions,
      index: 0,
      answers: { 1: { selected: ['option-1'], text: '' } },
    })
    expect(updateValues(messages)['/clarify']).toMatchObject({
      options: [
        { id: 'option-1', label: '正确', description: '✓ 已选 · 符合规程' },
        { id: 'option-2', label: '错误', description: '不符合规程' },
      ],
    })
  })

  it('题组最后一页只显示“提交全部”，并阻止继续下一题', () => {
    const questions = [
      { id: 'q1', question: '第一题', kind: 'single', options: [
        { id: 'option-1', label: 'A' },
        { id: 'option-2', label: 'B' },
      ] },
      { id: 'q2', question: '第二题', kind: 'text', options: [] },
    ]
    const messages = clarifyMessages({
      questions,
      index: 1,
      answers: {
        1: { selected: ['A'], text: '' },
        2: { selected: [], text: '已填写' },
      },
    })
    expect(updateValues(messages)['/clarify']).toMatchObject({
      kind: 'text',
      total: 2,
      index: 1,
      canNext: false,
      isLast: true,
      text: '已填写',
    })
    expect(uiValues(messages)).toMatchObject({
      '/ui/showClarifySubmit': true,
      '/ui/showClarifyPrev': true,
      '/ui/showClarifyNext': false,
    })
    const components = finalComponentsOf(messages)
    expect(components.find((component) => component.id === 'clarifySubmitLabel')).toMatchObject({
      text: '提交全部',
    })
  })

  it('题组单选点选项走翻页动作：非末页下一题，末页只记选中', () => {
    const questions = [
      { id: 'q1', question: '第一题', kind: 'single', options: [
        { id: 'option-1', label: 'A' },
        { id: 'option-2', label: 'B' },
      ] },
      { id: 'q2', question: '第二题', kind: 'single', options: [
        { id: 'option-1', label: 'C' },
        { id: 'option-2', label: 'D' },
      ] },
    ]
    const first = clarifyMessages({ questions, index: 0 })
    expect(finalComponentsOf(first).find((component) => component.id === 'clarifyOptionCard0')).toMatchObject({
      action: { event: { name: 'eab_clarify_nav', context: {
        direction: 'next',
        index: 0,
        optionId: 'option-1',
        optionLabel: 'A',
      } } },
    })
    const last = clarifyMessages({ questions, index: 1 })
    expect(finalComponentsOf(last).find((component) => component.id === 'clarifyOptionCard0')).toMatchObject({
      action: { event: { name: 'eab_clarify_nav', context: {
        direction: 'pick',
        index: 1,
        optionId: 'option-1',
        optionLabel: 'C',
      } } },
    })
  })
})
