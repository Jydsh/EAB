import { describe, expect, it } from 'vitest'
import {
  artifactBrief,
  artifactManifest,
  parseAgentArtifacts,
  parseTaskBudget,
  protocolStatusOf,
  normalizeTaskPhase,
} from '../src/agent-protocol.js'

describe('agent protocol core', () => {
  it('把内部生命周期与暂停原因合成对外状态', () => {
    expect(protocolStatusOf('queued', 'none')).toBe('submitted')
    expect(protocolStatusOf('running', 'none')).toBe('working')
    expect(protocolStatusOf('running', 'input_required')).toBe('input-required')
    expect(protocolStatusOf('queued', 'auth_required')).toBe('auth-required')
    expect(protocolStatusOf('succeeded', 'none')).toBe('completed')
    expect(protocolStatusOf('failed', 'none')).toBe('failed')
    expect(protocolStatusOf('cancelled', 'none')).toBe('canceled')
    expect(protocolStatusOf('failed', 'rejected')).toBe('rejected')
  })

  it('拒绝状态优先于失败状态，未知 phase 回落到 none', () => {
    expect(protocolStatusOf('failed', 'rejected')).toBe('rejected')
    expect(normalizeTaskPhase('auth_required')).toBe('auth_required')
    expect(normalizeTaskPhase('bad')).toBe('none')
    expect(normalizeTaskPhase(null, 'input_required')).toBe('input_required')
  })

  it('预算只保留正整数，坏值不进入执行器', () => {
    expect(parseTaskBudget({
      maxTokens: 1200,
      maxCostMicros: -1,
      maxDurationMs: 30.9,
      maxRounds: '8',
    })).toEqual({ maxTokens: 1200, maxDurationMs: 30, maxRounds: 8 })
    expect(parseTaskBudget(null)).toEqual({})
    expect(parseTaskBudget('bad')).toEqual({})
  })

  it('产物引用过滤空条目并归一化字段', () => {
    const artifacts = parseAgentArtifacts([
      {
        id: 'art-1',
        name: '报告.docx',
        uri: 'workspace://report.docx',
        source: 'workspace',
        fileId: 'wf-1',
        size: 12.9,
        preview: '摘要',
      },
      { id: '', name: '空 id', uri: 'x' },
      { id: 'art-2', name: '坏来源', uri: 'y', source: 'unknown' },
      null,
    ])
    expect(artifacts).toHaveLength(2)
    expect(artifacts[0]).toMatchObject({
      id: 'art-1',
      name: '报告.docx',
      size: 12,
      source: 'workspace',
      fileId: 'wf-1',
      preview: '摘要',
    })
    expect(artifacts[1].source).toBe('workspace')
    expect(artifacts[1].mimeType).toBe('application/octet-stream')
    expect(artifacts[1].preview).toContain('坏来源')
  })

  it('父 Agent 产物清单带类型、大小、校验和、句柄和预览，且限制展开数量', () => {
    const artifacts = parseAgentArtifacts([
      {
        id: 'art-1',
        name: '巡检周报.md',
        mimeType: 'text/markdown',
        size: 2048,
        checksum: `sha256:${'a'.repeat(64)}`,
        source: 'cloud',
        uri: 'eab://workspace/file/wf1',
        fileId: 'wf1',
        preview: '本周正常',
      },
      {
        id: 'art-2',
        name: '行程单.pdf',
        mimeType: 'application/pdf',
        size: 0,
        checksum: `ref-sha256:${'b'.repeat(64)}`,
        source: 'a2a',
        uri: 'https://example.com/itinerary.pdf',
        preview: 'A2A 文件：行程单.pdf',
      },
      {
        id: 'art-3',
        name: '第三份',
        mimeType: 'text/plain',
        size: 10,
        checksum: '',
        source: 'inline',
        uri: 'mcp://third',
      },
    ])
    const brief = artifactBrief(artifacts[0])
    expect(brief).toContain('巡检周报.md')
    expect(brief).toContain('text/markdown')
    expect(brief).toContain('2.0 KB')
    expect(brief).toContain('sha256:aaaaaaaaaaaaaaaa…')
    expect(brief).toContain('fileId:wf1')
    expect(brief).toContain('预览：本周正常')

    const manifest = artifactManifest(artifacts, 2)
    expect(manifest).toContain('巡检周报.md')
    expect(manifest).toContain('A2A')
    expect(manifest).toContain('ref-sha256:bbbbbbbbbbbbbbbb…')
    expect(manifest).toContain('另有 1 个产物未展开')
    expect(manifest).not.toContain('第三份')
  })
})
