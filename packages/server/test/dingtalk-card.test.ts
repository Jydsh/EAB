import { describe, expect, it } from 'vitest'
import {
  buildDingTalkA2UIArtifactAnnotations,
  buildDingTalkA2UICreateMessages,
  buildDingTalkA2UIUpdateMessages,
  dingTalkConversationSummary,
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
  return Object.fromEntries(
    Object.entries(updateValues(messages)).filter(([path]) => path.startsWith('/ui/')),
  )
}

function componentsOf(messages: string[]): Array<Record<string, any>> {
  return parsed(messages).find((message) => message.updateComponents)?.updateComponents.components as Array<
    Record<string, any>
  >
}

function finalComponentsOf(messages: string[]): Array<Record<string, any>> {
  return parsed(messages)
    .filter((message) => message.updateComponents)
    .at(-1)?.updateComponents.components as Array<Record<string, any>>
}

describe('钉钉 A2UI 卡片可见性与底色', () => {
  it('把 answer 组件标为 artifact，供钉钉生成会话列表正文', () => {
    expect(buildDingTalkA2UIArtifactAnnotations('s')).toEqual([
      { surfaceId: 's', componentId: 'answer', type: 'artifact' },
    ])
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

  it('真正调用工具后显示工具面板与工具链路预览，结束后保留两个折叠面板', () => {
    const tooling = updatesOfTooling()
    expect(uiValues(tooling)).toMatchObject({
      '/ui/showThinking': false,
      '/ui/showThinkingPreview': false,
      '/ui/showTools': true,
      '/ui/showToolsPreview': true,
    })
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
    expect(updateValues(final)['/tools/text']).toContain('完成 · 320ms')
    expect(updateValues(final)['/tools/text']).toContain('结果：找到 3 个部门')
    const components = finalComponentsOf(final)
    expect(components.find((component) => component.id === 'thinkingPanel')?.title).toBe('✦ 已深度思考')
    expect(components.find((component) => component.id === 'toolPanel')?.title).toBe('🛠️ 工具调用记录')
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
    expect(updateValues(final)['/answer/text']).toBe('答案')
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
    expect(updateValues(messages)).toEqual({
      '/answer/text': '你好，世界',
    })
    expect(messages.some((message) => 'updateComponents' in JSON.parse(message))).toBe(false)
  })

  it('正文流式时把 14px 原生 loading 图标放在同一行末尾，收口后移除', () => {
    const streaming = buildDingTalkA2UIUpdateMessages(
      's',
      { answer: '答案', reasoning: '', tools: [], thinkingDone: true },
      true,
    )
    expect(updateValues(streaming)).toMatchObject({
      '/answer/text': '答案',
      '/ui/showAnswerSpinner': true,
    })

    const final = buildDingTalkA2UIUpdateMessages(
      's',
      { answer: '答案', reasoning: '', tools: [], thinkingDone: true },
      false,
    )
    expect(updateValues(final)).toMatchObject({
      '/answer/text': '答案',
      '/ui/showAnswerSpinner': false,
    })
  })

  it('正文为空时不注入任何占位内容', () => {
    const messages = buildDingTalkA2UIUpdateMessages(
      's',
      { answer: '', reasoning: '正在分析', tools: [], thinkingDone: false },
      true,
    )
    expect(updateValues(messages)['/answer/text']).toBe('')
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
    expect(root).toMatchObject({ component: 'Card', backgroundColor: '#FFFFFFFF' })
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
      children: ['answer', 'answerSpinner'],
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
    expect(
      renderDingTalkProgressCard({ answer: '', reasoning: '', tool: '', tools: ['org.directory'], thinkingDone: true }),
    ).toContain('**🛠️ 工具调用中…**')
    expect(
      renderDingTalkProgressCard({ answer: '', reasoning: '', tool: '', tools: ['org.directory'], thinkingDone: true }),
    ).not.toContain('思考中')
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
