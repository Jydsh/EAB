import { describe, expect, it } from 'vitest'
import { chooseAutoChatModel, chooseSubAgentModel } from '../src/routes/chat.js'

const models = [
  { id: 'model_fast', name: '快速模型', capabilities: ['fast'], priority: 10, endpointKind: 'chat' },
  { id: 'model_code', name: '代码模型', capabilities: ['code', 'tool'], priority: 5, endpointKind: 'chat' },
  { id: 'model_vision', name: '视觉模型', capabilities: ['vision', 'multimodal'], priority: 8, endpointKind: 'chat' },
] as any

describe('自动选模', () => {
  it('优先选支持工具调用的模型，即使它优先级较低', () => {
    const choice = chooseAutoChatModel(models)
    expect(choice?.id).toBe('model_code')
  })

  it('没有工具模型时回退第一个可用模型', () => {
    const noTool = models.filter((model: any) => !model.capabilities.includes('tool'))
    expect(chooseAutoChatModel(noTool)?.id).toBe('model_fast')
  })
})

describe('父 Agent 自动分配子 Agent 模型', () => {
  it('按任务能力选择，而不是无脑沿用父模型', () => {
    const choice = chooseSubAgentModel({
      task: { title: '修接口', prompt: '修复登录接口的 bug，并补单元测试' },
      available: models,
      parentModelId: 'model_fast',
    })
    expect(choice.modelId).toBe('model_code')
    expect(choice.reason).toContain('code')
  })

  it('视觉任务选择视觉模型', () => {
    const choice = chooseSubAgentModel({
      task: { title: '看图', prompt: '识别这张截图里的报错' },
      available: models,
      parentModelId: 'model_code',
    })
    expect(choice.modelId).toBe('model_vision')
  })

  it('任务显式指定优先，即使不是最高评分', () => {
    const choice = chooseSubAgentModel({
      task: { title: '指定', prompt: '写总结', modelId: 'model_fast' },
      available: models,
      parentModelId: 'model_code',
    })
    expect(choice.modelId).toBe('model_fast')
    expect(choice.reason).toContain('显式')
  })

  it('没有可见模型时回退父模型', () => {
    const choice = chooseSubAgentModel({
      task: { title: '默认', prompt: '随便做点什么' },
      available: [],
      parentModelId: 'model_parent',
      parentModelName: '父模型',
    })
    expect(choice.modelId).toBe('model_parent')
    expect(choice.modelName).toBe('父模型')
  })

  it('没有能力命中时沿用父模型，而不是选一个不相关的模型', () => {
    const choice = chooseSubAgentModel({
      task: { title: '普通', prompt: '整理一下会议纪要' },
      available: models,
      parentModelId: 'model_fast',
    })
    expect(choice.modelId).toBe('model_fast')
  })

  it('同一批子任务里已经用过父模型时，自动分散到其他可用模型', () => {
    const load = new Map<string, number>([['model_fast', 1]])
    const choice = chooseSubAgentModel({
      task: { title: '普通', prompt: '整理一下会议纪要' },
      available: models,
      parentModelId: 'model_fast',
      load,
    })
    expect(choice.modelId).not.toBe('model_fast')
    expect(choice.reason).toContain('分散')
  })
})
