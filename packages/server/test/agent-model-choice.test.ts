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

  it('显式指定的模型不在本轮可用列表时，不能硬派，回退到可用模型', () => {
    const choice = chooseSubAgentModel({
      task: { title: '指定失效模型', prompt: '修复登录接口的 bug', modelId: 'model_gone' },
      available: models,
      parentModelId: 'model_fast',
    })
    expect(choice.modelId).not.toBe('model_gone')
    expect(models.map((model: any) => model.id)).toContain(choice.modelId)
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

  it('能力模型已被占用时，后续子任务按负载换模型而不是全部回退父模型', () => {
    const load = new Map<string, number>([['model_code', 1]])
    const choice = chooseSubAgentModel({
      task: { title: '查制度', prompt: '检索知识库里的安全作业规程文档' },
      available: models,
      parentModelId: 'model_code',
      load,
    })
    expect(choice.modelId).not.toBe('model_code')
    expect(choice.reason).toContain('并发负载')
  })

  it('视觉任务即使父模型已被占用，也不降级到没有视觉能力的模型', () => {
    const load = new Map<string, number>([['model_vision', 1]])
    const choice = chooseSubAgentModel({
      task: { title: '看图', prompt: '识别这张截图里的报错' },
      available: models,
      parentModelId: 'model_vision',
      load,
    })
    expect(choice.modelId).toBe('model_vision')
    expect(choice.reason).toContain('不允许降级')
  })

  it('重试时排除刚失败的模型，优先换到能处理工具的模型', () => {
    const choice = chooseSubAgentModel({
      task: { title: '重试', prompt: '检索知识库文档并汇总' },
      available: models,
      parentModelId: 'model_fast',
      avoidModelId: 'model_fast',
    })
    expect(choice.modelId).toBe('model_code')
    expect(choice.reason).toContain('tool')
  })

  it('按真实可见模型目录连续分配三个子任务时，三个模型不重复', () => {
    const realModels = [
      { id: 'model_qwen8', name: 'Qwen3-8B', capabilities: ['chat'], priority: 99, endpointKind: 'chat' },
      { id: 'model_qwen35', name: 'Qwen3.5-4B', capabilities: ['chat'], priority: 100, endpointKind: 'chat' },
      { id: 'model_qwen27', name: 'Qwen3.8-27B-FP8', capabilities: ['chat', 'vision', 'multimodal', 'tool'], priority: 99, endpointKind: 'chat' },
    ] as any
    const load = new Map<string, number>()
    const tasks = [
      { title: 'A-通讯录', prompt: '查询公司所有部门及其负责人，整理成表格' },
      { title: 'B-知识库', prompt: '检索知识库里的安全作业规程，整理摘要' },
      { title: 'C-云空间', prompt: '列出云空间未删除的文件清单' },
    ]
    const chosen = tasks.map((task) => {
      const choice = chooseSubAgentModel({
        task,
        available: realModels,
        parentModelId: 'model_qwen27',
        load,
      })
      load.set(choice.modelId, (load.get(choice.modelId) ?? 0) + 1)
      return choice.modelId
    })
    expect(new Set(chosen).size).toBe(3)
  })
})
