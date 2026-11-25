import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { splitStreamRelease } from '../src/routes/chat.js'

describe('chat stream release', () => {
  it('把批量回放的长正文切成稳定的小段', () => {
    const text = '结'.repeat(1553)
    const parts = splitStreamRelease(text, 60)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((part) => Array.from(part).length <= 60)).toBe(true)
    expect(parts.join('')).toBe(text)
  })

  it('短正文不额外拆分', () => {
    expect(splitStreamRelease('已查到 18 条记录。', 60)).toEqual(['已查到 18 条记录。'])
  })

  it('门禁/工具失败压住的正文也从 60 字节拍回放，而不是一次 send', () => {
    const source = readFileSync(new URL('../src/routes/chat.ts', import.meta.url), 'utf8')
    const publish = source.slice(source.indexOf('publishHeldContent = async'), source.indexOf('const candidateProfile'))
    expect(publish).toContain('releaseContentProgressively(chunk, publishEvent, true)')
    expect(publish).not.toContain('releaseContentProgressively(chunk, publishEvent, holdForGate)')
  })

  it('长正文按总量反推段大小，整段回放保持在几秒量级', () => {
    const source = readFileSync(new URL('../src/routes/chat.ts', import.meta.url), 'utf8')
    const release = source.slice(source.indexOf('releaseContentProgressively = async'), source.indexOf('const failedModelIds'))
    expect(release).toContain('Array.from(full).length / 120')
    expect(release).toContain('sleepForStreamRelease(55)')
  })

  it('前端按已揭示前缀渲染正文，不直接铺满 rawAnswer', () => {
    const source = readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8')
    expect(source).toContain('let shownAnswerLength = 0')
    expect(source).toContain('chars.slice(0, shownAnswerLength).join')
    expect(source).toContain('shownAnswerLength < finalLength')
  })

  it('整段正文一次性到达时按逐字节奏揭示，正常 token 流不受影响', () => {
    const source = readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8')
    expect(source).toContain('let batchReveal = false')
    expect(source).toContain('if (batchReveal)')
    expect(source).toContain('shownAnswerLength += Math.min(backlog, 4)')
    expect(source).toContain('Array.from(text).length > 120')
  })

  it('收尾正文被替换时从 0 重播，不把终稿瞬间铺满', () => {
    const source = readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8')
    expect(source).toContain("finalText.trim() !== rawAnswer.trim()")
    expect(source).toContain("finalText.trim() !== revealed.trim()")
    expect(source).toContain('answer.innerHTML = \'\'')
  })
})
