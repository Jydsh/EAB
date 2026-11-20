import { describe, expect, it } from 'vitest'
import { isSingleFileOfficeEdit, officeToolIdsForQuery, routeCapabilities } from '../src/capability-route.js'

describe('本轮能力路由', () => {
  it('普通问答不加载 Office、文件、项目、定时和开发工具', () => {
    const route = routeCapabilities('今天天气怎么样？')
    expect(route).toMatchObject({
      office: false,
      workspace: false,
      project: false,
      pluginDev: false,
      skillDev: false,
      schedule: false,
      org: false,
      memoryRule: false,
    })
  })

  it('单文件 Office 编辑直接执行，多文件/批量才保留团队编排', () => {
    expect(
      isSingleFileOfficeEdit(
        '把右侧预览的《EAB-真实对话测试.docx》第二段正文改短，保留原有加粗和字号',
        { activeFile: { name: 'EAB-真实对话测试.docx' } },
      ),
    ).toBe(true)
    expect(isSingleFileOfficeEdit('把这份文档第二段改短', { activeFile: { name: '方案.docx' } })).toBe(true)
    expect(
      isSingleFileOfficeEdit('把这份文档里所有段落的字号都改成小四', { activeFile: { name: '方案.docx' } }),
    ).toBe(true)
    expect(
      isSingleFileOfficeEdit('把这份文档的每个段落都改短', { activeFile: { name: '方案.docx' } }),
    ).toBe(true)
    expect(
      isSingleFileOfficeEdit('把这两个文档的第二段都改短', { activeFile: { name: '方案.docx' } }),
    ).toBe(false)
    expect(
      isSingleFileOfficeEdit('把 A.docx 和 B.docx 的第二段都改短', { activeFile: { name: 'A.docx' } }),
    ).toBe(false)
    expect(
      isSingleFileOfficeEdit(
        '批量把云空间所有 docx 的第二段都改短',
        { activeFile: { name: 'EAB-真实对话测试.docx' } },
      ),
    ).toBe(false)
  })

  it('文档问题同时打开 Office 和文件读写工具', () => {
    const route = routeCapabilities('把方案文档第二段改短一点，并保留原格式')
    expect(route.office).toBe(true)
    expect(route.workspace).toBe(true)
    expect(route.project).toBe(false)
    expect(route.schedule).toBe(false)
  })

  it('Office 工具按读取、编辑、批注、版本和导出拆分', () => {
    const read = officeToolIdsForQuery('读一下这个文档的大纲，第二段讲了什么')
    expect(read).toEqual(['office.read_outline', 'office.read_range', 'office.find'])

    const edit = officeToolIdsForQuery('把方案文档第二段改短一点，并保留原格式')
    expect(edit).toContain('office.replace')
    expect(edit).not.toContain('office.format')
    expect(edit).not.toContain('office.insert')
    expect(edit).not.toContain('office.comment')
    expect(edit).not.toContain('office.export')

    const preserveRuns = officeToolIdsForQuery('把第二段正文改短，保留原有加粗和字号，不要改动第一段和第三段')
    expect(preserveRuns).toContain('office.replace')
    expect(preserveRuns).not.toContain('office.format')

    const preserveThenChange = officeToolIdsForQuery('保留原有加粗，把字号改成 12')
    expect(preserveThenChange).toContain('office.format')

    const format = officeToolIdsForQuery('把第二段标题加粗，字号改成 14')
    expect(format).toContain('office.format')

    const uniformRewrite = officeToolIdsForQuery('把第二段整段重写为“新的整段正文”，统一加粗并设为 12 号字')
    expect(uniformRewrite).toContain('office.rewrite')
    expect(officeToolIdsForQuery('把第二段整段重写为“新的整段正文”，但保留原有加粗和字号')).not.toContain('office.rewrite')
    expect(officeToolIdsForQuery('把第二段整段重写为“新的整段正文”')).not.toContain('office.rewrite')

    const comment = officeToolIdsForQuery('给第三段加一条批注，并回复已有评论')
    expect(comment).toContain('office.comment')
    expect(comment).not.toContain('office.replace')

    const version = officeToolIdsForQuery('看一下修订记录，回滚到上一版')
    expect(version).toContain('office.revisions')
    expect(version).toContain('office.versions')
    expect(version).not.toContain('office.format')

    const exportFile = officeToolIdsForQuery('把这份文档导出成 PDF')
    expect(exportFile).toContain('office.export')
    expect(exportFile).not.toContain('office.insert')
  })

  it('文档里的“不要改动”不会被当成长期记忆规则', () => {
    expect(routeCapabilities('把第二段改短，不要改动第一段和第三段').memoryRule).toBe(false)
    expect(routeCapabilities('以后都按这个格式写').memoryRule).toBe(true)
  })

  it('右侧预览的文件也会触发文件工具', () => {
    expect(routeCapabilities('看一下这个表', { activeFile: { name: '月度报表.xlsx' } }).office).toBe(true)
    expect(routeCapabilities('看一下这个表', { activeFile: { name: '月度报表.xlsx' } }).workspace).toBe(true)
  })

  it('明确的文件路径和读写动作命中文件工具', () => {
    expect(routeCapabilities('读取 docs/方案.md 的前两段').workspace).toBe(true)
    expect(routeCapabilities('把结果导出成 csv').workspace).toBe(true)
    expect(routeCapabilities('查看今天天气').workspace).toBe(false)
  })

  it('工程/定时/插件开发/组织问题分别命中对应工具组', () => {
    expect(routeCapabilities('跑一下测试并修复代码').project).toBe(true)
    expect(routeCapabilities('每天九点提醒我提交日报').schedule).toBe(true)
    expect(routeCapabilities('给 EAB 开发一个插件页面').pluginDev).toBe(true)
    expect(routeCapabilities('给 EAB 开发一个插件页面').workspace).toBe(true)
    expect(routeCapabilities('把这套流程沉淀成技能').skillDev).toBe(true)
    expect(routeCapabilities('把这套流程沉淀成技能').workspace).toBe(true)
    expect(routeCapabilities('东环线组的组长是谁').org).toBe(true)
    expect(routeCapabilities('以后都按这个格式写').memoryRule).toBe(true)
  })

  it('业务数据问题里出现组织名称，不会被误判成通讯录查询', () => {
    expect(routeCapabilities('东环线班组最近录入了多少条检查整治记录').org).toBe(false)
  })

  it('出题、测验不会被当作工程测试去加载项目命令工具', () => {
    expect(routeCapabilities('帮我出 10 道测试题，考一下信息系统管理').project).toBe(false)
  })
})
