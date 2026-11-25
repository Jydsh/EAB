/**
 * 团队复杂度门禁：在模型决定要不要派子 Agent 之前，先做一次确定性分诊。
 *
 * 目标不是“凡是大任务都强制编队”，而是把强制编队限定在真正能拆成
 * 2–4 个互不依赖、可独立验收切片的任务上：
 * - 单步问答 / 解释类请求不编队；
 * - 单个文件、单点修改不编队；
 * - 只有明确的多交付物、多模块、端到端工程或用户点名要团队时才强制编队。
 *
 * 判定结果会写入 agent_runs.formation_json，作为“为什么编队/为什么没编队”的审计记录。
 * 这里只做文本与当前文件上下文的纯判定，不读数据库、不调用模型。
 */
export type TeamFormationReason =
  | 'internal_message'
  | 'single_step_question'
  | 'single_file_operation'
  | 'single_point_change'
  | 'short_or_chat'
  | 'complex_multi_slice'
  | 'explicit_team_request'
  | 'ambiguous_model_choice'

export interface TeamFormationDecision {
  /** true 表示本轮满足强制编队条件；false 表示交回主 Agent 自行判断。 */
  readonly force: boolean
  readonly reason: TeamFormationReason
  /** 给用户/控制台看的中文理由，同时会注入强制编队提示，避免模型不知道为什么被要求拆。 */
  readonly detail: string
  /** 命中的确定性信号，便于排查误判。 */
  readonly signals: readonly string[]
  readonly minAgents: number
  readonly maxAgents: number
}

export interface TeamFormationInput {
  readonly text: string
  readonly activeFile?: { id: string; relPath?: string } | null
}

const TEAM_MIN_AGENTS = 2
const TEAM_MAX_AGENTS = 4

function chineseCount(value: string): number | null {
  const map: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5 }
  if (map[value]) return map[value]!
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function explicitTeamCount(text: string): number | null {
  const match = text.match(
    /(?:派|安排|叫|让|找|拉|拍|组织)\s*(?:出)?\s*(一|两|二|三|四|五|\d+)\s*(?:个|名)?\s*(?:子\s?Agent|agent|员工|角色|人)/i,
  )
  if (!match) return null
  const count = chineseCount(match[1]!)
  if (!count || count < TEAM_MIN_AGENTS) return null
  return Math.min(TEAM_MAX_AGENTS, count)
}

function looksLikeExplicitTeamRequest(text: string): boolean {
  return (
    /(?:帮我|请|麻烦|采用|按|用|走|安排|组织).{0,32}(?:团队协作|团队分工|多\s?Agent|并行\s?Agent|分工合作)/i.test(text)
    || /(?:团队协作|团队分工|多\s?Agent|并行\s?Agent|分工合作).{0,24}(?:帮我|完成|执行|做|开发|实现|处理|推进)/i.test(text)
    || /每个\s?agent|每人(?:一个|负责)|各自负责/i.test(text)
  )
}

function looksLikeQuestion(text: string): boolean {
  const startsLikeQuestion = /^(?:请问|请?问一下|麻烦问|帮我看看|请解释|解释一下|说明一下|告诉我|如何|怎么|怎样|为什么|什么是|是什么|哪些|哪个|多少|是否|能否|能不能|可不可以|有没有|可以吗|对吗)[\s，,：:]?/i.test(text)
  if (startsLikeQuestion) return true
  if (!/[?？]\s*$/.test(text)) return false
  // 句尾问号不等于“只问不做”：以执行动词开头的完整任务（“开发一个系统？”）仍按任务处理。
  return !/^(?:帮我|请帮|请|麻烦|给我|替我|开发|实现|搭建|修复|修改|重构|设计|做|写|生成|整理|调研|分析|测试|部署|批量|把|将)/.test(text)
}

function asksForExecution(text: string): boolean {
  return /(?:帮我|请帮|请|麻烦|给我|替我|需要你|我要你|直接|立即|马上).{0,40}(?:做|实现|开发|搭建|修复|修改|改|写|生成|整理|调研|分析|对比|部署|测试|重构|设计|输出|做一份|写一份|生成一份)/.test(text)
}

function looksLikeSingleFileOperation(text: string, activeFile?: { relPath?: string } | null): boolean {
  const explicitSingle = Boolean(activeFile?.relPath)
    || /(?:这个|这份|该|当前|本)(?:文件|文档|表格|报告|周报|月报|方案|代码|脚本|PPT|演示文稿)/i.test(text)
    || /单个文件|单文件|一份文件|同一个文件/i.test(text)
    || /\.(?:md|markdown|txt|docx?|xlsx?|pptx?|pdf|csv|json|ts|tsx|js|jsx|py|sql|html|css|yaml|yml)(?=$|[\s，,。；;、）)])/i.test(text)
  if (!explicitSingle) return false
  // “这个项目 / 所有这些文件 / 整个模块”已经超出单文件局部处理，不能按单文件豁免。
  return !/(?:整个|全部|全量|所有|批量|多个|多份|整套|项目|系统|模块|目录|仓库|代码库|全站|前后端)/i.test(text)
}

function looksLikeSinglePointChange(text: string): boolean {
  const point = /bug|缺陷|报错|错误|错别字|错字|格式|排版|文案|样式|按钮|一行|一段|一处|局部|小改|微调|改一下|修一下|调一下/i.test(text)
  if (!point) return false
  return !/(?:整个|全部|全量|所有|批量|多个|多份|整套|项目|系统|模块|目录|仓库|代码库|全站|前后端)/i.test(text)
}

function multiSliceSignals(text: string): string[] {
  const signals: string[] = []
  if (/(?:端到端|从零(?:开始)?(?:搭建|开发|实现)|完整(?:的)?[\sA-Za-z0-9_-]{0,10}(?:项目|系统|应用|功能)|从需求到上线|从设计到(?:实现|上线|交付)|全流程|整个(?:项目|系统|代码库))/i.test(text)) {
    signals.push('端到端交付')
  }
  if (/(?:两|二|三|四|五|多)\s*(?:个|项|块|条)?\s*(?:模块|功能|页面|接口|服务|方向|部分|文件|报告|文档|方案|角色|任务|子系统)/i.test(text)) {
    signals.push('多个交付切片')
  }
  if (/(?:前端|客户端|页面).{0,20}(?:后端|服务端|接口|API|数据库)|(?:后端|服务端|接口|API|数据库).{0,20}(?:前端|客户端|页面)/i.test(text)) {
    signals.push('前后端并行交付')
  }
  if (/(?:分别|各自|并行|同时进行|分头|多线)/i.test(text)) {
    signals.push('要求并行/分头推进')
  }
  if (/(?:多个|这些|全部|所有|批量)\s*(?:文件|文档|表格)|多份/i.test(text)) {
    signals.push('多文件/批量处理')
  }
  const deliverableKinds = new Set(
    (text.match(/报告|文档|PPT|表格|代码|页面|接口|测试|数据库|部署|设计稿|原型/g) ?? []).map((item) => item.toLowerCase()),
  )
  if (deliverableKinds.size >= 2 && /(?:做|写|生成|输出|交付|整理|实现|开发|搭建)/.test(text)) {
    signals.push('多个不同交付物')
  }
  if (/(?:^|\s)(?:1[.、)]|一、).{0,100}(?:2[.、)]|二、)/.test(text)) {
    signals.push('编号需求清单')
  }
  return signals
}

/**
 * 返回本轮编队判定。force=true 时调用方应把第一次工具调用锁到 agent_spawn，
 * 并要求模型派 2–4 个切片；force=false 时不要注入任何“必须编队”的提示。
 */
export function decideTeamFormation(input: TeamFormationInput): TeamFormationDecision {
  const text = String(input.text ?? '').replace(/[\t\r\n]+/g, ' ').trim()

  // 子 Agent 的完成/失败/提问通知是父 Agent 的内部调度消息，不是新的用户任务。
  if (/^【(?:后台)?子\s?Agent[^】]*】/.test(text) || text.includes('【后台子 Agent 完成通知】')) {
    return {
      force: false,
      reason: 'internal_message',
      detail: '这是子 Agent 的内部调度消息，不触发编队。',
      signals: ['内部调度消息'],
      minAgents: TEAM_MIN_AGENTS,
      maxAgents: TEAM_MAX_AGENTS,
    }
  }

  const explicitCount = explicitTeamCount(text)
  if (explicitCount || looksLikeExplicitTeamRequest(text)) {
    return {
      force: true,
      reason: 'explicit_team_request',
      detail: explicitCount
        ? `用户明确要求 ${explicitCount} 个岗位协作，按 2–4 个可独立验收切片编队。`
        : '用户明确要求团队协作/并行分工，按 2–4 个可独立验收切片编队。',
      signals: explicitCount ? [`显式编队人数=${explicitCount}`] : ['显式团队协作请求'],
      minAgents: TEAM_MIN_AGENTS,
      maxAgents: TEAM_MAX_AGENTS,
    }
  }

  if (looksLikeQuestion(text) && !asksForExecution(text)) {
    return {
      force: false,
      reason: 'single_step_question',
      detail: '这是单步问答/解释请求，不为了凑人数拆任务。',
      signals: ['问句且没有执行动作'],
      minAgents: TEAM_MIN_AGENTS,
      maxAgents: TEAM_MAX_AGENTS,
    }
  }

  if (looksLikeSingleFileOperation(text, input.activeFile)) {
    return {
      force: false,
      reason: 'single_file_operation',
      detail: '只涉及一个文件/文档的局部处理，强行编队的协调成本高于收益。',
      signals: ['单文件/单文档'],
      minAgents: TEAM_MIN_AGENTS,
      maxAgents: TEAM_MAX_AGENTS,
    }
  }

  if (looksLikeSinglePointChange(text)) {
    return {
      force: false,
      reason: 'single_point_change',
      detail: '这是单点修改/小修复，一个岗位就能闭环，不强制编队。',
      signals: ['单点修改'],
      minAgents: TEAM_MIN_AGENTS,
      maxAgents: TEAM_MAX_AGENTS,
    }
  }

  const signals = multiSliceSignals(text)
  if (signals.length > 0) {
    return {
      force: true,
      reason: 'complex_multi_slice',
      detail: `可拆成 2–4 个互不依赖、可独立验收的切片：${signals.join('、')}。`,
      signals,
      minAgents: TEAM_MIN_AGENTS,
      maxAgents: TEAM_MAX_AGENTS,
    }
  }

  // 短请求、闲聊即使带“实现/分析”等词，也不足以证明存在多个交付切片。
  if (text.length < 12) {
    return {
      force: false,
      reason: 'short_or_chat',
      detail: '请求过短，没有足够信息证明存在两个以上可独立验收的切片。',
      signals: ['短请求/闲聊'],
      minAgents: TEAM_MIN_AGENTS,
      maxAgents: TEAM_MAX_AGENTS,
    }
  }

  return {
    force: false,
    reason: 'ambiguous_model_choice',
    detail: '没有命中确定性的多切片信号，交回主 Agent 自行判断；不要为了编队硬拆。',
    signals: ['未命中多切片信号'],
    minAgents: TEAM_MIN_AGENTS,
    maxAgents: TEAM_MAX_AGENTS,
  }
}
