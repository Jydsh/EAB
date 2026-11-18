import { describe, expect, it } from 'vitest'
import {
  engineeringVerificationGate,
  hasPassingVerification,
  shouldRequireEngineeringVerification,
  type AgentToolTrace,
} from '../src/routes/chat.js'

function trace(input: Partial<AgentToolTrace> & { toolId: string; args: Record<string, unknown>; summary: string }): AgentToolTrace {
  return {
    id: 'trace-1',
    name: input.toolId,
    status: 'done',
    durationMs: 1,
    toolId: input.toolId,
    args: input.args,
    summary: input.summary,
  }
}

describe('工程任务交付门禁', () => {
  it('资料读取/测试夹具类任务不进入工程门禁', () => {
    const prev = process.env.EAB_PROJECT_EXEC
    process.env.EAB_PROJECT_EXEC = '1'
    try {
      expect(shouldRequireEngineeringVerification(
        '读取 docs/知识库落地风险要点清单.md 并提炼 2 条要点；archive/test-fixtures 下的是测试夹具，不要读。',
      )).toBe(false)
      expect(shouldRequireEngineeringVerification('整理会议纪要并输出 3 条结论')).toBe(false)
      expect(shouldRequireEngineeringVerification(
        '修复 calc.mjs 的 mul 实现，运行 node --test calc.test.mjs 直到 exitCode=0',
      )).toBe(true)
      expect(shouldRequireEngineeringVerification('完成登录页面', '测试/构建全部通过且 exitCode=0')).toBe(true)
      // 只读任务里出现“部署/脚本/接口”等文件名或文档名，不能误判成工程任务。
      expect(shouldRequireEngineeringVerification(
        '只读检查 notes 文件夹：读取 dsh-mrrp-发布与部署备忘.txt 和 数据库选型清单.md，输出文件清单和修复建议。严禁修改、删除或创建任何文件。',
        '输出 2 个文件的问题明细，不修改任何文件。',
      )).toBe(false)
      expect(shouldRequireEngineeringVerification(
        '只看不建：检查 pages/接口说明.md 和 scripts/构建脚本说明.md，按严重度给出修改建议。不要修改任何文件。',
      )).toBe(false)
      // 只有真正要改代码/跑测试时才保留门禁。
      expect(shouldRequireEngineeringVerification(
        '只读检查后发现 bug，需要修复代码并运行测试直到 exitCode=0。',
      )).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.EAB_PROJECT_EXEC
      else process.env.EAB_PROJECT_EXEC = prev
    }
  })

  it('前台测试 exitCode=0 才算通过，安装依赖和后台执行不算', () => {
    expect(hasPassingVerification([
      trace({
        toolId: 'project.exec',
        args: { command: 'pnpm test', runInBackground: false },
        summary: JSON.stringify({ status: 'completed', exitCode: 0, stdout: 'ok' }),
      }),
    ])).toBe(true)

    expect(hasPassingVerification([
      trace({
        toolId: 'project.exec',
        args: { command: 'pnpm install', runInBackground: false },
        summary: JSON.stringify({ status: 'completed', exitCode: 0 }),
      }),
    ])).toBe(false)

    expect(hasPassingVerification([
      trace({
        toolId: 'project.exec',
        args: { command: 'pnpm test', runInBackground: true },
        summary: JSON.stringify({ status: 'running', exitCode: null, mode: 'background' }),
      }),
    ])).toBe(false)
  })

  it('后台测试的 project.job output 也能作为通过证据', () => {
    expect(hasPassingVerification([
      trace({
        toolId: 'project.job',
        args: { action: 'output', jobId: 'job-1' },
        summary: JSON.stringify({
          command: 'node --test calc.test.mjs',
          status: 'completed',
          exitCode: 0,
        }),
      }),
    ])).toBe(true)

    expect(hasPassingVerification([
      trace({
        toolId: 'project.job',
        args: { action: 'output', jobId: 'job-2' },
        summary: JSON.stringify({
          command: 'node --test calc.test.mjs',
          status: 'failed',
          exitCode: 1,
        }),
      }),
    ])).toBe(false)
  })

  it('第 5 轮自检仍未通过时继续返工，不强制收口', () => {
    const decision = engineeringVerificationGate({
      traces: [],
      verificationPrompts: 5,
    })
    expect(decision.action).toBe('continue')
    expect(decision.verificationPrompts).toBe(6)
    expect(decision.message).toContain('第 6 次自检要求')
  })

  it('连续三轮没有新的验证结果时结束本批，交回父 Agent 换思路重派', () => {
    const stalled = engineeringVerificationGate({
      traces: [],
      verificationPrompts: 7,
      stagnantRounds: 3,
    })
    expect(stalled.action).toBe('finish')

    const stillProgressing = engineeringVerificationGate({
      traces: [],
      verificationPrompts: 7,
      stagnantRounds: 2,
    })
    expect(stillProgressing.action).toBe('continue')
  })

  it('拿到真实通过证据后才允许 finish', () => {
    const decision = engineeringVerificationGate({
      traces: [
        trace({
          toolId: 'project.exec',
          args: { command: 'pnpm test', runInBackground: false },
          summary: JSON.stringify({ status: 'completed', exitCode: 0, stdout: 'ok' }),
        }),
      ],
      verificationPrompts: 9,
    })
    expect(decision.action).toBe('finish')
    expect(decision.verificationPrompts).toBe(9)
  })
})
