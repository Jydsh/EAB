import { describe, expect, it } from 'vitest'
import { oggOpusDurationMs } from '../src/voice-audio.js'
import { speakableReply, voiceReplyTextOf } from '../src/voice-text.js'

describe('voice audio helpers', () => {
  it('从 OGG 末页 granule 换算出毫秒时长', () => {
    // 最小可用 Ogg page：27 字节 header + 1 个 segment，payload 长度 0。
    const page = Buffer.alloc(28)
    page.write('OggS', 0, 'ascii')
    page.writeBigUInt64LE(48_000n, 6)
    page[26] = 1
    page[27] = 0
    expect(oggOpusDurationMs(page)).toBe(1000)
  })

  it('没有 granule 时返回 0，交给上层兜底', () => {
    expect(oggOpusDurationMs(Buffer.from('not ogg'))).toBe(0)
  })
})

describe('speakable reply', () => {
  it('去掉 Markdown、代码、表格和链接地址', () => {
    const text = speakableReply(
      '## 结论\n\n请看 [制度原文](https://example.com/a)。\n\n```js\nconsole.log(1)\n```\n\n| 姓名 | 部门 |\n| --- | --- |\n| 张三 | 技术部 |',
    )
    expect(text).toContain('结论')
    expect(text).toContain('制度原文')
    expect(text).not.toContain('https://example.com')
    expect(text).not.toContain('console.log')
    expect(text).not.toContain('| 姓名 |')
  })

  it('长回答截到 600 字以内，并尽量落在句末', () => {
    const text = '第一段。'.repeat(300)
    const spoken = voiceReplyTextOf(text)
    expect(spoken.length).toBeLessThanOrEqual(601)
    expect(spoken.endsWith('。')).toBe(true)
  })
})
