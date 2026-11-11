import { describe, expect, it } from 'vitest'
import type { RequestActor } from '../src/session.js'
import type { ChatToolSpec } from '../src/routes/tools.js'
import { buildSystemPrompt } from '../src/routes/chat.js'

const actor = {
  person: {
    companyName: '测试公司',
    name: '测试用户',
    deptName: '测试部门',
  },
} as unknown as RequestActor

const cloudTools = [
  {
    type: 'function',
    function: {
      name: 'workspace_list',
      description: '列出云空间文件',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tool_search',
      description: '搜索工具',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
] as unknown as ChatToolSpec[]

function prompt(spaceKind: 'cloud' | 'none', spaceLabel: string, chatTools = cloudTools): string {
  return buildSystemPrompt({
    actor,
    chatTools,
    memories: [],
    hits: [],
    hasAttachments: false,
    spaceKind,
    spaceLabel,
  })
}

describe('对话系统提示的文件空间边界', () => {
  it('云空间是默认空间，本轮不暴露本地磁盘工具', () => {
    const text = prompt('cloud', '云空间')
    expect(text).toContain('云空间是默认空间，用户没有单独选择也可以使用')
    expect(text).toContain('本轮只允许使用云空间工具（workspace_ 开头），不存在本地空间工具')
    expect(text).toContain('网页端没有本地文件能力')
    expect(text).toContain('当前在云空间，query 只能写云空间文件/容量相关能力')
    expect(text).not.toContain('本地空间（必须选择）')
  })

  it('没有选择空间时明确说明文件工具全部不可用', () => {
    const text = prompt('none', '未选择文件空间')
    expect(text).toContain('当前未选择文件空间')
    expect(text).toContain('本轮没有任何文件读写工具')
    expect(text).toContain('tool_search 不会返回文件读写工具')
    expect(text).toContain('云空间（可直接使用）')
    expect(text).not.toContain('本地空间（必须选择）')
  })
})
