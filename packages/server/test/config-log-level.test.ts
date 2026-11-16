import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('默认日志级别', () => {
  it('不配置环境变量时默认 warn，避免逐请求 2xx 日志刷屏', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).logLevel).toBe('warn')
  })

  it('仍允许用 EAB_LOG_LEVEL 临时恢复请求日志', () => {
    expect(loadConfig({ EAB_LOG_LEVEL: 'info' } as NodeJS.ProcessEnv).logLevel).toBe('info')
  })
})
