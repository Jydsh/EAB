/**
 * 本轮能力路由：只决定“哪些工具组值得直接下发给模型”，不执行权限判断。
 *
 * 路由是保守的：拿不准时宁可不下发，模型仍可以通过 tool_search 搜索并加载；
 * 但高频、几乎每轮都可能用到的工具继续常驻，避免每轮多一次搜索往返。
 */
export interface CapabilityRoute {
  /** Office 文档/表格/幻灯片操作 */
  office: boolean
  /** 个人云空间的文件读写、搜索、文件夹管理 */
  workspace: boolean
  /** 项目命令、脚本、测试、构建 */
  project: boolean
  /** 为 EAB 开发插件 */
  pluginDev: boolean
  /** 为 EAB 开发技能 */
  skillDev: boolean
  /** 定时提醒与周期任务 */
  schedule: boolean
  /** 人员、部门、上下级 */
  org: boolean
  /** 当前天气与天气预报 */
  weather: boolean
  /** 搜索互联网、读取公开网页 */
  web: boolean
  /** 无头浏览器打开/点击/截图 */
  browser: boolean
  /** 形成可复用的团队规则 */
  memoryRule: boolean
}

export interface CapabilityRouteOptions {
  /** 用户右侧正在预览/编辑的文件；文件类型能直接决定是否带 Office 工具 */
  activeFile?: { name?: string | null }
}

const OFFICE_TEXT =
  /(文档|表格|工作表|单元格|幻灯片|演示文稿|批注|修订|页眉|页脚|段落|字体|字号|加粗|对齐|行距|目录|docx|doc|xlsx|xlsm|xls|pptx|ppt|word|excel|office|第[一二三四五六七八九十0-9]+段)/i
/**
 * 个人云空间的直接读写意图。
 *
 * 只看“读取/打开/查看”这类动词会把“查看天气”也误判成文件任务；
 * 因此这里要求文件名/文件类型/空间名，或明确的写入、导出、改名、删除动作。
 */
const WORKSPACE_TEXT =
  /(云空间|工作区|workspace|文件|文档|附件|文件夹|目录|路径|文件名|扩展名|\.(?:md|txt|csv|tsv|json|ya?ml|log|pdf|docx?|xlsx|xlsm|pptx?)\b|保存|写入|写到|存成|另存|导出|下载|上传|编辑|修改|替换|重命名|改名)/i
const PROJECT_TEXT =
  /(运行|执行|命令|脚本|代码|编译|构建|测试|跑测试|部署|端口|进程|终端|shell|python|node\.?js|npm|pnpm|git|仓库|项目目录|接口联调)/i
const NON_PROJECT_TEXT = /(出题|测验|考试|刷题|答题|题目|试卷|测试题|试题|考题|道题)/i
const PLUGIN_DEV_TEXT = /(插件|plugin|挂件).{0,20}(开发|做|写|改|安装|页面|ui|界面|热更新)|(开发|做|写|改|安装).{0,20}(插件|plugin|挂件)/i
const SKILL_DEV_TEXT = /(技能|skill).{0,20}(开发|做|写|改|安装|制作|沉淀)|(开发|做|写|改|安装|制作|沉淀).{0,20}(技能|skill)/i
const SCHEDULE_TEXT = /(提醒|定时|每天|每日|每周|每月|每隔|几点|日程|闹钟|cron|周期任务)/i
const ORG_TEXT =
  /(通讯录|组织架构|组织关系|部门|科室|班组|小组|组长|副组长|负责人|上级|下级|领导|同事|成员|人名|姓名|工号|岗位|职务|找谁|谁是|有谁|哪些人|人员名单|联系方式|人数|多少人|几个人|几人)/i
const WEATHER_TEXT =
  /(天气|气温|温度|多少度|几度|下雨|降雨|降水|下雪|降雪|台风|大风|雾霾|空气质量|湿度|风力|冷不冷|热不热|weather|forecast)/i
const WEB_TEXT =
  /(https?:\/\/|www\.|网页|网站|浏览器|上网|联网|互联网|网上|搜一下|搜一搜|搜索一下|查资料|最新消息|最新政策|最近新闻|新闻|公告原文)/i
/**
 * 浏览器比 web.fetch 重：只有明确“渲染/点击/截图/内置浏览器”才下发。
 * “打开这个网页”也命中，因为用户可能要看动态内容；只给 web.fetch 时模型仍可通过 tool_search 加载。
 */
const BROWSER_TEXT =
  /(内置浏览器|浏览器|网页截图|页面截图|页面快照|网页快照|动态网页|需要渲染|渲染后|打开[^。；;]{0,6}(?:页面|网页|链接)|点击[^。；;]{0,6}(?:页面|网页|链接|按钮)|点开[^。；;]{0,6}(?:页面|网页|链接|按钮)|登录后(?:页面|网页)|browser|screenshot|snapshot)/i
const MEMORY_RULE_TEXT =
  /(以后|今后|从今以后|统一|始终|一律|都按|记住|规则|标准|规范)|(?:不要|别再)[^。；;]{0,12}(?:再|以后|下次|每次|都|统一|一律)/i
const BUSINESS_TEXT =
  /(检查|整治|台账|记录|录入|统计|数量|几条|多少条|明细|报表|工单|数据|接口|汇总|填报)/i

function officeFile(name: string): boolean {
  return /\.(docx?|xlsx|xlsm|xls|pptx|ppt)$/i.test(name)
}

/** Office 基础读取工具：任何文档问题都先给“看结构、读范围、找内容”。 */
const OFFICE_BASE_TOOL_IDS = [
  'office.read_outline',
  'office.read_range',
  'office.find',
] as const

/**
 * 按问题拆 Office 工具组。
 *
 * 早期任何文档问题都下发 11 个 Office 工具，单轮 schema 约 2 万字符；
 * 但“读大纲”不需要替换/插入，“加批注”不需要表格格式。
 * 这里只保留基础读取，再按动词叠加一组编辑/输出工具；拿不准时仍由 tool_search 兜底。
 */
export function officeToolIdsForQuery(query: string): string[] {
  const text = String(query || '')
  const ids = new Set<string>(OFFICE_BASE_TOOL_IDS)
  const add = (id: string, pattern: RegExp): void => {
    if (pattern.test(text)) ids.add(id)
  }

  add('office.revisions', /修订|修改记录|变更记录|改过|哪次改/i)
  add('office.versions', /版本|历史版本|回滚|恢复|快照|上一版|旧版/i)
  add('office.comment', /批注|评论|备注|回复.*批注|解决.*批注/i)
  add('office.replace', /替换|改成|改为|改短|改长|改一下|修改|删除|删掉|重写|换掉|换成/i)
  add('office.insert', /插入|新增|添加|加一行|加一列|加一段|加个|复制|移动|表格.*(?:行|列)/i)
  const commandText = text.replace(/[“"][^”"]*[”"]/g, ' ')
  const preserveText =
    /(?:保留|保持|沿用|不要改|别改)[^。；;]{0,16}?(?:原格式|原有格式|原样|格式不变|加粗|字号|字体|颜色|对齐|行距|缩进|样式)|原格式|格式(?:保持)?不变|不要改.*格式|别改.*格式/i
  const preserveFormat = preserveText.test(text)
  const changeFormat = commandText
    .split(/[。；;，,]/)
    .filter((clause) => clause.trim() && !preserveText.test(clause))
    .some(
      (clause) =>
        /格式|字体|字号|加粗|斜体|下划线|颜色|对齐|行距|缩进|样式|居中/.test(clause) &&
        /改成|改为|设为|调整为|调成|设置|应用|取消|把|将|给|加粗|斜体|下划线|标红|加红|改字体|改字号/.test(clause),
    )
  if (
    /格式|字体|字号|加粗|斜体|下划线|颜色|对齐|行距|缩进|样式/i.test(commandText) &&
    (!preserveFormat || changeFormat)
  ) {
    ids.add('office.format')
  }
  // 只有明确“整段重写 + 统一格式”才暴露专用整段重写工具；
  // “保留原有格式”的请求仍只走 office.replace，避免整段覆盖改变 run 级格式。
  if (
    WHOLE_REWRITE_TEXT.test(commandText) &&
    UNIFORM_FORMAT_TEXT.test(commandText) &&
    !preserveFormat
  ) {
    ids.add('office.rewrite')
  }
  add('office.export', /导出|下载|pdf|另存/i)
  add('office.gui', /打印|宏|页面设置|页眉|页脚|导出选项/i)
  return Array.from(ids)
}

const OFFICE_MUTATION_IDS = new Set([
  'office.replace',
  'office.insert',
  'office.format',
  'office.rewrite',
])

/** 明确要求整段覆盖重写，并且同时要统一某种格式。 */
const WHOLE_REWRITE_TEXT =
  /(?:整段|全段|整块|整句)[^。；;，,]{0,20}(?:重写|改写|覆盖|替换|改成|改为|换成)|(?:重写|改写|覆盖)[^。；;，,]{0,20}(?:整段|全段|整块)/i
const UNIFORM_FORMAT_TEXT = /统一|格式|字体|字号|加粗|斜体|下划线|颜色|对齐/i
const MULTI_FILE_TEXT =
  /(?:批量|逐份|逐个文件|逐文件|多份|多文件|多文档|多工作簿|多演示文稿|(?:所有|全部|每个|各个|多个|两个|三个|几个|这些|那些|两份|三份)[^。；;，,]{0,12}(?:文档|文件|工作簿|演示文稿|docx|xlsx|xlsm|pptx))/i

/** 多文件/批量编辑才保留团队编队；单文件里的“所有段落/每个单元格”仍算单文件。 */
export function isMultiFileOfficeEdit(query: string): boolean {
  const text = String(query || '')
  if (MULTI_FILE_TEXT.test(text)) return true
  const mentions = text.match(/\.(?:docx?|xlsx|xlsm|pptx?)\b/gi) ?? []
  return mentions.length >= 2
}

/** 单文件局部编辑直接在主回合完成，不需要团队工具；批量/多文件才保留编队。 */
export function isSingleFileOfficeEdit(
  query: string,
  options: CapabilityRouteOptions = {},
): boolean {
  const text = String(query || '').trim()
  const activeName = String(options.activeFile?.name ?? '').trim()
  const hasOfficeName = officeFile(activeName) || /\.(?:docx?|xlsx|xlsm|pptx)\b/i.test(text)
  return (
    hasOfficeName &&
    !isMultiFileOfficeEdit(text) &&
    officeToolIdsForQuery(text).some((id) => OFFICE_MUTATION_IDS.has(id))
  )
}

export function routeCapabilities(
  query: string,
  options: CapabilityRouteOptions = {},
): CapabilityRoute {
  const text = String(query || '').trim()
  const activeName = String(options.activeFile?.name ?? '').trim()
  const business = BUSINESS_TEXT.test(text)
  const office = OFFICE_TEXT.test(text) || (activeName !== '' && officeFile(activeName))
  const pluginDev = PLUGIN_DEV_TEXT.test(text)
  const skillDev = SKILL_DEV_TEXT.test(text)
  return {
    office,
    // Office/插件/技能开发都要读写云空间文件，避免模型先搜索再发现没有读写工具。
    workspace: WORKSPACE_TEXT.test(text) || office || pluginDev || skillDev || activeName !== '',
    project: PROJECT_TEXT.test(text) && !NON_PROJECT_TEXT.test(text),
    pluginDev,
    skillDev,
    schedule: SCHEDULE_TEXT.test(text),
    // 业务数据问题里常出现“东环线/工区/班组”，不能因为组织名称就带通讯录。
    org: !business && ORG_TEXT.test(text),
    weather: WEATHER_TEXT.test(text),
    web: WEB_TEXT.test(text),
    browser: BROWSER_TEXT.test(text),
    memoryRule: MEMORY_RULE_TEXT.test(text),
  }
}

/** 供测试和文档使用的工具组清单；实际工具仍按角色、空间、权限过滤。 */
export const CAPABILITY_TOOL_GROUPS = {
  workspace: [
    'workspace.list',
    'workspace.read',
    'workspace.search',
    'workspace.write',
    'workspace.edit',
    'workspace.folder',
  ],
  // 完整 Office 清单仅用于文档/测试对照；实际下发按 officeToolIdsForQuery 拆分。
  office: [
    'office.read_outline',
    'office.read_range',
    'office.find',
    'office.revisions',
    'office.replace',
    'office.rewrite',
    'office.insert',
    'office.format',
    'office.comment',
    'office.versions',
    'office.export',
    'office.gui',
  ],
  project: ['project.exec', 'project.job'],
  pluginDev: ['plugin.dev'],
  skillDev: ['skill.dev'],
  schedule: ['schedule.create'],
  org: ['org.directory'],
  weather: ['weather.now'],
  web: ['web.search', 'web.fetch'],
  browser: ['browser'],
  memoryRule: ['memory.propose'],
} as const
