import { describe, expect, it } from 'vitest'
import { decideTeamFormation } from '../src/agent-team-formation.js'

function decide(text: string, activeFile?: { id: string; relPath?: string }) {
  return decideTeamFormation({ text, activeFile })
}

describe('团队复杂度门禁', () => {
  it('单步问答不强制编队', () => {
    const decision = decide('如何实现登录鉴权？')
    expect(decision.force).toBe(false)
    expect(decision.reason).toBe('single_step_question')
  })

  it('单文件局部修改不强制编队', () => {
    const decision = decide('帮我把这份周报的错别字改一下')
    expect(decision.force).toBe(false)
    expect(decision.reason).toBe('single_file_operation')
  })

  it('当前文件上下文同样按单文件豁免', () => {
    const decision = decide('把第二段改得更简洁', { id: 'f1', relPath: 'docs/report.md' })
    expect(decision.force).toBe(false)
    expect(decision.reason).toBe('single_file_operation')
  })

  it('单点修复不强制编队', () => {
    const decision = decide('修复登录按钮点击没反应的 bug')
    expect(decision.force).toBe(false)
    expect(decision.reason).toBe('single_point_change')
  })

  it('只有顺序依赖的分析写报告不硬拆', () => {
    const decision = decide('帮我分析这份数据并写一份报告')
    expect(decision.force).toBe(false)
    expect(decision.reason).toBe('ambiguous_model_choice')
  })

  it('端到端多模块任务强制编队并限制 2–4 个', () => {
    const decision = decide('开发一个完整的 TODO 应用：前端页面、后端 API、数据库迁移，最后跑测试')
    expect(decision.force).toBe(true)
    expect(decision.reason).toBe('complex_multi_slice')
    expect(decision.minAgents).toBe(2)
    expect(decision.maxAgents).toBe(4)
    expect(decision.signals).toContain('端到端交付')
  })

  it('带问号的完整任务仍按任务处理，不降级成单步问答', () => {
    const decision = decide('开发一个完整系统：前端页面、后端 API、数据库迁移，最后跑测试？')
    expect(decision.force).toBe(true)
    expect(decision.reason).toBe('complex_multi_slice')
  })

  it('用户点名多个员工时按团队请求编队', () => {
    const decision = decide('派 3 个员工分别调研竞品、整理资料、写报告')
    expect(decision.force).toBe(true)
    expect(decision.reason).toBe('explicit_team_request')
    expect(decision.signals).toContain('显式编队人数=3')
  })

  it('整个项目/所有文件的批量改造仍会强制编队', () => {
    const decision = decide('把整个项目所有文件里的错误都修复，并跑测试')
    expect(decision.force).toBe(true)
    expect(decision.reason).toBe('complex_multi_slice')
    expect(decision.signals).toContain('端到端交付')
    expect(decision.signals).toContain('多文件/批量处理')
  })

  it('子 Agent 通知不触发编队', () => {
    const decision = decide('【后台子 Agent 完成通知】阿码已完成接口实现，请汇总')
    expect(decision.force).toBe(false)
    expect(decision.reason).toBe('internal_message')
  })
})
