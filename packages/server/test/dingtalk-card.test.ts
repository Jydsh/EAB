import { describe, expect, it } from 'vitest'
import {
  buildDingTalkA2UIArtifactAnnotations,
  buildDingTalkA2UICreateMessages,
  buildDingTalkA2UIUpdateMessages,
  dingTalkConversationSummary,
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
  const ui = updateValues(messages)['/ui'] as Record<string, unknown> | undefined
  return Object.fromEntries(Object.entries(ui ?? {}).map(([key, value]) => [`/ui/${key}`, value]))
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
  return parsed(messages)
    .filter((message) => message.updateComponents)
    .at(-1)?.updateComponents.components as Array<Record<string, any>>
}

describe('钉钉 A2UI 卡片可见性与底色', () => {
  it('把回答正文段标为 artifact，供钉钉生成会话列表正文', () => {
    expect(buildDingTalkA2UIArtifactAnnotations('s')).toEqual(
      Array.from({ length: 6 }, (_, index) => ({
        surfaceId: 's',
        componentId: `answerText${index}`,
        type: 'artifact',
      })),
    )
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
    expect(data.tools.text).toBe('')
  })

  it('思考结束、正文开始后隐藏预览行，并把标题切到“已深度思考”', () => {
    const messages = buildDingTalkA2UIUpdateMessages(
      's',
      {
        answer: '答案',
        reasoning: '先确认用户身份，再查部门',
        tools: [],
        thinkingDone: true,
      },
      true,
    )
    expect(uiValues(messages)).toMatchObject({
      '/ui/showThinking': true,
      '/ui/showThinkingPreview': false,
      '/ui/showTools': false,
      '/ui/showToolsPreview': false,
    })
    expect(updateValues(messages)['/thinking/preview']).toBe('')
    const components = finalComponentsOf(messages)
    expect(components.find((component) => component.id === 'thinkingPanel')?.title).toBe('✦ 已深度思考')
  })

  it('真正调用工具后显示工具面板与工具链路预览，结束后只保留工具名和耗时', () => {
    const tooling = updatesOfTooling()
    expect(uiValues(tooling)).toMatchObject({
      '/ui/showThinking': true,
      '/ui/showThinkingPreview': false,
      '/ui/showTools': true,
      '/ui/showToolsPreview': true,
    })
    expect(updateValues(tooling)['/tools/text']).toContain('org.directory')
    expect(updateValues(tooling)['/tools/text']).toContain('参数：')
    expect(updateValues(tooling)['/tools/preview']).toContain('org.directory')
    expect(finalComponentsOf(tooling).find((component) => component.id === 'thinkingPanel')?.title).toBe(
      '✦ 已深度思考',
    )

    const final = buildDingTalkA2UIUpdateMessages(
      's',
      {
        answer: '答案',
        reasoning: '查一下',
        tools: ['org.directory'],
        thinkingDone: true,
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
      '/ui/showThinkingPreview': false,
      '/ui/showTools': true,
      '/ui/showToolsPreview': false,
    })
    expect(updateValues(final)['/tools/text']).toContain('**org.directory** · 320ms')
    expect(updateValues(final)['/tools/text']).not.toContain('参数：')
    expect(updateValues(final)['/tools/text']).not.toContain('结果：找到 3 个部门')
    const components = finalComponentsOf(final)
    expect(components.find((component) => component.id === 'thinkingPanel')?.title).toBe('✦ 已深度思考')
    expect(components.find((component) => component.id === 'toolPanel')?.title).toBe('🛠️ 工具调用记录')
  })

  it('工具详情还没到时也保留已深度思考，并给工具面板补一行工具名', () => {
    const tooling = buildDingTalkA2UIUpdateMessages(
      's',
      { answer: '', reasoning: '查一下', tools: ['org.directory'], thinkingDone: false },
      true,
    )
    expect(uiValues(tooling)).toMatchObject({
      '/ui/showThinking': true,
      '/ui/showTools': true,
      '/ui/showToolsPreview': true,
    })
    expect(updateValues(tooling)['/tools/preview']).toBe('org.directory · 执行中')
    const components = finalComponentsOf(tooling)
    expect(components.find((component) => component.id === 'thinkingPanel')?.title).toBe('✦ 已深度思考')
  })

  it('没有工具调用时完成后不显示工具面板', () => {
    const final = buildDingTalkA2UIUpdateMessages(
      's',
      { answer: '答案', reasoning: '想过一下', tools: [], thinkingDone: true },
      false,
    )
    expect(uiValues(final)).toMatchObject({
      '/ui/showThinking': true,
      '/ui/showThinkingPreview': false,
      '/ui/showTools': false,
      '/ui/showToolsPreview': false,
    })
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

  it('正文流式时把 14px 原生 loading 图标放在同一行末尾，收口后移除', () => {
    const streaming = buildDingTalkA2UIUpdateMessages(
      's',
      { answer: '答案', reasoning: '', tools: [], thinkingDone: true },
      true,
    )
    expect(answerBlock(streaming)?.text).toBe('答案')
    expect(uiValues(streaming)).toMatchObject({
      '/ui/showAnswerSpinner': true,
    })

    const final = buildDingTalkA2UIUpdateMessages(
      's',
      { answer: '答案', reasoning: '', tools: [], thinkingDone: true },
      false,
    )
    expect(answerBlock(final)?.text).toBe('答案')
    expect(uiValues(final)).toMatchObject({
      '/ui/showAnswerSpinner': false,
    })
  })

  it('正文为空时不注入任何占位内容', () => {
    const messages = buildDingTalkA2UIUpdateMessages(
      's',
      { answer: '', reasoning: '正在分析', tools: [], thinkingDone: false },
      true,
    )
    expect(answerBlock(messages)?.text).toBe('')
  })

  it('思考结束或工具状态变化时才重发折叠面板组件', () => {
    const previous = { answer: '', reasoning: '先确认身份', tools: [], thinkingDone: false }
    const messages = buildDingTalkA2UIUpdateMessages(
      's',
      { answer: '答案', reasoning: '先确认身份', tools: ['org.directory'], thinkingDone: true },
      true,
      previous,
    )
    expect(messages.some((message) => 'updateComponents' in JSON.parse(message))).toBe(true)
  })

  it('根卡片显式白色，折叠面板默认收起，预览行是面板外的独立 Text', () => {
    const components = componentsOf(
      buildDingTalkA2UICreateMessages('s', { answer: '', reasoning: '', tools: [] }),
    )
    const root = components.find((component) => component.id === 'root')!
    const thinking = components.find((component) => component.id === 'thinkingPanel')!
    const tool = components.find((component) => component.id === 'toolPanel')!
    const preview = components.find((component) => component.id === 'thinkingPreview')!
    expect(root).toMatchObject({ component: 'Card', backgroundColorToken: 'common_bg_color' })
    expect(root.child).toBe('rootColumn')
    expect(thinking.defaultExpanded).toBe(false)
    expect(tool.defaultExpanded).toBe(false)
    expect(preview).toMatchObject({
      component: 'Text',
      text: { path: '/thinking/preview' },
      maxLine: 1,
      visible: { path: '/ui/showThinkingPreview' },
    })
    expect(components.find((component) => component.id === 'answerSpinner')).toMatchObject({
      component: 'Text',
      icon: { url: 'https://aka.doubaocdn.com/s/8Q14U759NP' },
      visible: { path: '/ui/showAnswerSpinner' },
    })
    expect(components.find((component) => component.id === 'answerRow')).toMatchObject({
      component: 'Row',
      align: 'end',
      children: ['answerBlocks', 'answerSpinner'],
    })
  })

  it('旧模板卡显示流式预览，工具链路不会退回“思考中”', () => {
    expect(renderDingTalkProgressCard({ answer: '', reasoning: '', tool: '', thinkingDone: false })).toBe(
      '**✦ 正在思考…**',
    )
    const thinking = renderDingTalkProgressCard({
      answer: '',
      reasoning: '先确认用户身份，再查部门',
      tool: '',
      thinkingDone: false,
    })
    expect(thinking).toContain('**✦ 正在思考…**')
    expect(thinking).toContain('> 先确认用户身份')
    expect(
      renderDingTalkProgressCard({ answer: '', reasoning: '想过一下', tool: '', thinkingDone: true }),
    ).toBe('**✦ 已深度思考**')
    const tooling = renderDingTalkProgressCard({
      answer: '',
      reasoning: '',
      tool: '',
      tools: ['org.directory'],
      thinkingDone: true,
    })
    expect(tooling).toContain('**✦ 已深度思考**')
    expect(tooling).toContain('**🛠️ 工具调用中…**')
    expect(tooling).toContain('org.directory')
    expect(tooling).not.toContain('正在思考')
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
})

function updatesOfTooling(): string[] {
  return buildDingTalkA2UIUpdateMessages(
    's',
    {
      answer: '',
      reasoning: '查一下',
      tools: ['org.directory'],
      thinkingDone: true,
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
