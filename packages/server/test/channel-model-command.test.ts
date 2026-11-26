import { describe, expect, it } from 'vitest'
import {
  matchChannelModels,
  planChannelModelCommand,
  planChannelModelPicker,
  planChannelModelSelection,
  type ChannelModelOption,
} from '../src/channel-model-command.js'

const models: ChannelModelOption[] = [
  { id: 'plugin:mrrp:route', name: 'MRRP 智能路由' },
  { id: 'plugin:our-free-model:mimo-v2.6-flash-free', name: 'MiMo V2.6 Flash' },
  { id: 'plugin:our-free-model:mimo-v2.6-pro-free', name: 'MiMo V2.6 Pro' },
  { id: 'deepseek-v4-flash', name: 'Deepseek V4 Flash' },
]

const secretModel: ChannelModelOption = { id: 'plugin:secret:top-secret', name: 'Top Secret Model' }

describe('渠道机器人对话内模型切换', () => {
  it('/model 只列出传入的可见模型，不暴露未传入模型', () => {
    const result = planChannelModelCommand('/model', models, null)
    expect(result?.kind).toBe('list')
    expect(result?.text).toContain('可用模型（4）')
    expect(result?.text).toContain('MiMo V2.6 Flash')
    expect(result?.text).not.toContain(secretModel.name)
    expect(result?.text).toContain('当前模型：自动选择')
  })

  it('会话里残留的不可见模型 ID 不会出现在列表标题里', () => {
    const result = planChannelModelCommand('/model', models, secretModel.id)
    expect(result?.text).toContain('当前模型：当前模型不可用')
    expect(result?.text).not.toContain(secretModel.id)
  })

  it('中文自然语言和 /model 前缀都能匹配到唯一模型', () => {
    const natural = planChannelModelCommand('切换到 Deepseek V4 Flash', models, null)
    expect(natural?.kind).toBe('switch')
    expect(natural?.modelId).toBe('deepseek-v4-flash')

    const slash = planChannelModelCommand('/model deepseek', models, null)
    expect(slash?.kind).toBe('switch')
    expect(slash?.modelId).toBe('deepseek-v4-flash')

    const useModel = planChannelModelCommand('使用 MiMo V2.6 Pro 模型', models, null)
    expect(useModel?.kind).toBe('switch')
    expect(useModel?.modelId).toBe('plugin:our-free-model:mimo-v2.6-pro-free')
  })

  it('“换另外一个模型”在多个候选时只列列表，不替用户猜模型', () => {
    const result = planChannelModelCommand('换另外一个模型', models, 'deepseek-v4-flash')
    expect(result?.kind).toBe('list')
    expect(result?.modelId).toBeUndefined()
    expect(result?.text).toContain('当前模型：Deepseek V4 Flash')
    expect(result?.text).toContain('可用模型（4）')
  })

  it('“换另外一个模型”只有一个其他候选时直接切换', () => {
    const pair: ChannelModelOption[] = [
      { id: 'deepseek-v4-flash', name: 'Deepseek V4 Flash' },
      { id: 'plugin:our-free-model:mimo-v2.6-pro-free', name: 'MiMo V2.6 Pro' },
    ]
    const result = planChannelModelCommand('换另外一个模型', pair, 'deepseek-v4-flash')
    expect(result?.kind).toBe('switch')
    expect(result?.modelId).toBe('plugin:our-free-model:mimo-v2.6-pro-free')
    expect(result?.text).toContain('MiMo V2.6 Pro')
  })

  it('“切到”等自然切换说法能命中模型', () => {
    expect(planChannelModelCommand('切到 Deepseek V4 Flash', models, null)).toMatchObject({
      kind: 'switch',
      modelId: 'deepseek-v4-flash',
    })
    expect(planChannelModelCommand('模型换成 MiMo V2.6 Pro', models, null)).toMatchObject({
      kind: 'switch',
      modelId: 'plugin:our-free-model:mimo-v2.6-pro-free',
    })
    expect(planChannelModelCommand('有哪些模型', models, null)).toMatchObject({
      kind: 'list',
    })
    expect(planChannelModelCommand('现在有那些模型', models, null)).toMatchObject({
      kind: 'list',
    })
    expect(planChannelModelCommand('我想切换模型', models, null)).toMatchObject({
      kind: 'list',
    })
    expect(
      planChannelModelCommand('现在有那些模型，用引导模型弄出来我点击后切换', models, null),
    ).toMatchObject({ kind: 'list' })
  })

  it('普通“改用/换成”句子不会被误判为模型命令', () => {
    expect(planChannelModelCommand('改用这个方案', models, 'deepseek-v4-flash')).toBeNull()
    expect(planChannelModelCommand('换成明天的计划', models, 'deepseek-v4-flash')).toBeNull()
  })

  it('匹配到多个时要求补全名称，不直接猜', () => {
    const result = planChannelModelCommand('/model MiMo', models, null)
    expect(result?.kind).toBe('ambiguous')
    expect(result?.modelId).toBeUndefined()
    expect(result?.text).toContain('找到多个匹配')
  })

  it('无权限或不存在统一按未找到处理，且不列其他模型名', () => {
    const result = planChannelModelCommand('/model Top Secret', models, null)
    expect(result?.kind).toBe('not-found')
    expect(result?.modelId).toBeUndefined()
    expect(result?.text).toBe('没有找到你有权限使用的模型「Top Secret」。发送 /model 查看当前可用模型。')
    expect(result?.text).not.toContain(secretModel.name)
  })

  it('/auto 清空固定模型，普通消息不误判为命令', () => {
    const auto = planChannelModelCommand('/auto', models, 'deepseek-v4-flash')
    expect(auto?.kind).toBe('auto')
    expect(auto?.modelId).toBeNull()

    expect(planChannelModelCommand('你好，帮我查一下制度', models, 'deepseek-v4-flash')).toBeNull()
  })

  it('名称与 ID 的精确匹配优先于模糊匹配', () => {
    const matches = matchChannelModels(models, 'plugin:our-free-model:mimo-v2.6-flash-free')
    expect(matches).toHaveLength(1)
    expect(matches[0].name).toBe('MiMo V2.6 Flash')
  })

  it('模型引导选项只匹配唯一可见模型，并兼容“当前使用”后缀', () => {
    expect(planChannelModelSelection('请选择要切换的模型', 'Deepseek V4 Flash', models)).toEqual({
      modelId: 'deepseek-v4-flash',
      modelName: 'Deepseek V4 Flash',
    })
    expect(
      planChannelModelSelection('你想用哪个模型？', 'MiMo V2.6 Flash（当前使用）', models),
    ).toEqual({
      modelId: 'plugin:our-free-model:mimo-v2.6-flash-free',
      modelName: 'MiMo V2.6 Flash',
    })
  })

  it('模型引导选项支持自动选择，且不会把无关选项当模型', () => {
    expect(planChannelModelSelection('请选择模型', '自动选择', models)).toEqual({
      modelId: null,
      modelName: '自动选择',
    })
    expect(planChannelModelSelection('请选择模型', '再看看', models)).toBeNull()
    expect(planChannelModelSelection('请选择处理方式', 'Deepseek V4 Flash', models)).toBeNull()
    expect(planChannelModelSelection('请选择模型', 'MiMo', models)).toBeNull()
  })

  it('带厂商前缀的模型名（如 Qwen/Qwen3.5-4B）也能唯一命中', () => {
    const qwenModels: ChannelModelOption[] = [
      { id: 'Qwen/Qwen3-8B', name: 'Qwen/Qwen3-8B' },
      { id: 'Qwen/Qwen3.5-4B', name: 'Qwen/Qwen3.5-4B' },
    ]
    expect(planChannelModelSelection('请选择模型', 'Qwen/Qwen3.5-4B（当前使用）', qwenModels)).toEqual({
      modelId: 'Qwen/Qwen3.5-4B',
      modelName: 'Qwen/Qwen3.5-4B',
    })
  })

  it('模型引导卡按可见模型全量展示，3 个模型时保留自动选择', () => {
    const picker = planChannelModelPicker(
      [
        { id: 'plugin:our-free-model:kilo-auto%2Ffree', name: 'Kilo Auto Free' },
        { id: 'Qwen/Qwen3-8B', name: 'Qwen/Qwen3-8B' },
        { id: 'Qwen/Qwen3.5-4B', name: 'Qwen/Qwen3.5-4B' },
      ],
      'Qwen/Qwen3-8B',
    )
    expect(picker?.omitted).toBe(0)
    expect(picker?.question).toBe('要切换到哪个模型？')
    expect(picker?.options.map((option) => option.label)).toEqual([
      'Kilo Auto Free',
      'Qwen/Qwen3-8B（当前使用）',
      'Qwen/Qwen3.5-4B',
      '自动选择',
    ])
    expect(picker?.options[0].id).not.toBe('option-auto')
    expect(picker?.options[3].id).toBe('option-auto')
  })

  it('模型超过 4 个时不再截断，全量返回当前可见模型', () => {
    const picker = planChannelModelPicker(models, null)
    expect(picker?.omitted).toBe(0)
    expect(picker?.options).toHaveLength(4)
    expect(picker?.options.some((option) => option.id === 'option-auto')).toBe(false)

    const many = [...models, secretModel]
    const all = planChannelModelPicker(many, null)
    expect(all?.omitted).toBe(0)
    expect(all?.options).toHaveLength(5)
    expect(all?.question).not.toContain('/model')
    expect(all?.options.at(-1)?.label).toBe(secretModel.name)
  })

  it('异常大的模型目录仍有 24 个防御上限，超出部分提示用 /model 切换', () => {
    const huge = Array.from({ length: 26 }, (_, index) => ({
      id: `model-${index + 1}`,
      name: `模型 ${index + 1}`,
    }))
    const picker = planChannelModelPicker(huge, null)
    expect(picker?.options).toHaveLength(24)
    expect(picker?.omitted).toBe(2)
    expect(picker?.question).toContain('/model')
  })

  it('模型卡不会重复同一个模型，空列表不建卡', () => {
    const duplicate = planChannelModelPicker(
      [models[1], { ...models[1] }, models[2]],
      null,
    )
    expect(duplicate?.options.map((option) => option.label)).toEqual([
      'MiMo V2.6 Flash',
      'MiMo V2.6 Pro',
      '自动选择',
    ])
    expect(planChannelModelPicker([], null)).toBeNull()
  })
})
