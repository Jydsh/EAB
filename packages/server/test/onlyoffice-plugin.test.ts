import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const html = readFileSync(
  new URL('../public/onlyoffice-plugin/index.html', import.meta.url),
  'utf8',
)
const script = readFileSync(
  new URL('../public/onlyoffice-plugin/plugin.js', import.meta.url),
  'utf8',
)
const chat = readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8')

describe('OnlyOffice 插件页契约', () => {
  it('提供 cell 工作表面板并加载最新脚本', () => {
    expect(html).toContain('id="cell-section"')
    expect(html).toContain('id="cell-summary"')
    expect(html).toContain('id="cell-replace-value"')
    expect(html).toContain('id="cell-replace"')
    expect(html).toContain('WORKSHEET')
    expect(html).toContain('plugin.js?v=20261114h')
  })

  it('提供 slide 面板与幻灯片读取、定位入口', () => {
    expect(html).toContain('id="slide-section"')
    expect(html).toContain('id="slide-summary"')
    expect(html).toContain('id="slide-read"')
    expect(html).toContain('PRESENTATION')
    expect(script).toContain('function readPresentation()')
    expect(script).toContain('function locateSlideText()')
    expect(script).toContain('Api.GetPresentation()')
    expect(script).toContain('GetAllSlides()')
    expect(script).toContain('slide.Select()')
  })

  it('按 documentType 分流 word、cell 和 slide', () => {
    expect(script).toContain("context.documentType === 'cell'")
    expect(script).toContain("context.documentType === 'slide'")
    expect(script).toContain('function applyEditorMode()')
    expect(script).toContain(
      "readButton.textContent = isCell ? '读取工作表' : isSlide ? '读取幻灯片' : '读取文档结构'",
    )
    expect(script).toContain('Api.GetActiveSheet()')
    expect(script).toContain('A1:F12')
    expect(script).toContain('selectedCellAddress')
    expect(script).toContain('range.SetValue(')
    expect(script).toContain("if (documentType === 'cell')")
    expect(script).toContain("if (documentType === 'slide')")
  })

  it('保存成功后通知顶层页面并切回查看态', () => {
    expect(script).toContain("type: 'eab:onlyoffice:saved'")
    expect(script).toContain('documentSaved = true')
    expect(script).toContain('documentDirty = true')
    expect(script).toContain('window.Asc.plugin.callCommand(command, false, true')
    expect(script).toContain("data.state === 'no_changes' && documentDirty")
    expect(chat).toContain("messageType !== 'eab:onlyoffice:saved'")
    expect(chat).toContain('refreshWorkspaceAfterPluginSave')
    expect(chat).toContain('/refresh-guard`')
  })
})
