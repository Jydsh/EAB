import { describe, expect, it } from 'vitest'
import { inboundFileAttachments } from '../src/dingtalk-bot.js'

describe('钉钉文件消息解析', () => {
  it('file 消息带 downloadCode 和 fileName', () => {
    const files = inboundFileAttachments({
      msgtype: 'file',
      content: { downloadCode: 'code-1', fileName: '%E6%8A%A5%E8%A1%A8.xlsx' },
    })
    expect(files).toEqual([{ downloadCode: 'code-1', fileName: '报表.xlsx' }])
  })

  it('richText 里的 file 项也能识别，并按 downloadCode 去重', () => {
    const files = inboundFileAttachments({
      msgtype: 'richText',
      content: {
        richText: [
          { type: 'file', downloadCode: 'code-1', fileName: 'a.pdf' },
          { type: 'picture', downloadCode: 'img-1' },
          { type: 'file', downloadCode: 'code-1', fileName: 'a.pdf' },
        ],
      },
    })
    expect(files).toEqual([{ downloadCode: 'code-1', fileName: 'a.pdf' }])
  })
})
