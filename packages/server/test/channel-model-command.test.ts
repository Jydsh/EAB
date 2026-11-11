import { describe, expect, it } from 'vitest'
import { matchChannelModels, planChannelModelCommand, type ChannelModelOption } from '../src/channel-model-command.js'

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
})
