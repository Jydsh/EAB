import { describe, expect, it } from 'vitest'
import { createDesktopBridgeHub } from '../src/desktop-bridge.js'

describe('桌面浏览器标签按会话隔离', () => {
  it('只返回当前会话上报的标签，不串到其它对话', () => {
    const hub = createDesktopBridgeHub()
    hub.register('c1', 'u_test', { deviceId: 'dev_test_001', name: '测试设备', platform: 'win32' })

    hub.updateBrowserTabs('c1', 'u_test', 'dev_test_001', {
      sessionId: 'chat_a',
      activePageId: 'dp_page_a',
      tabs: [
        { pageId: 'dp_page_a', title: 'A 页面', url: 'https://a.example/' },
        { pageId: 'dp_page_a2', title: 'A 页面 2', url: 'https://a2.example/' },
      ],
    })
    hub.updateBrowserTabs('c1', 'u_test', 'dev_test_001', {
      sessionId: 'chat_b',
      activePageId: 'dp_page_b',
      tabs: [{ pageId: 'dp_page_b', title: 'B 页面', url: 'https://b.example/' }],
    })

    expect(hub.browserTabsFor('c1', 'u_test', 'dev_test_001', 'chat_a')?.tabs.map((tab) => tab.pageId))
      .toEqual(['dp_page_a', 'dp_page_a2'])
    expect(hub.browserTabsFor('c1', 'u_test', 'dev_test_001', 'chat_b')?.tabs.map((tab) => tab.pageId))
      .toEqual(['dp_page_b'])
    expect(hub.browserTabsFor('c1', 'u_test', 'dev_test_001', 'chat_missing')).toBeNull()
  })

  it('没有会话归属的旧上报不会串进任意对话', () => {
    const hub = createDesktopBridgeHub()
    hub.register('c1', 'u_test', { deviceId: 'dev_test_002' })
    hub.updateBrowserTabs('c1', 'u_test', 'dev_test_002', {
      activePageId: 'dp_legacy',
      tabs: [{ pageId: 'dp_legacy', title: '旧页面', url: 'https://legacy.example/' }],
    })

    expect(hub.browserTabsFor('c1', 'u_test', 'dev_test_002', 'chat_a')).toBeNull()
  })
})
