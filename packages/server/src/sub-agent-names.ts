/**
 * 子 Agent 团队面板显示名。
 *
 * 前 12 个岗位用十二生肖，第 13–22 个用十天干；超过 22 个再按「生肖·天干」
 * 组合，组合最多 120 个，仍不够时追加轮次序号，保证同一团队内不重名。
 */
export const SUB_AGENT_ZODIAC_NAMES = [
  '子鼠', '丑牛', '寅虎', '卯兔', '辰龙', '巳蛇',
  '午马', '未羊', '申猴', '酉鸡', '戌狗', '亥猪',
] as const

export const SUB_AGENT_HEAVENLY_STEMS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'] as const

export const SUB_AGENT_NAME_POOL = [...SUB_AGENT_ZODIAC_NAMES, ...SUB_AGENT_HEAVENLY_STEMS] as const

export function subAgentDisplayName(index: number): string {
  const slot = Math.max(0, Math.floor(index) - 1)
  if (slot < SUB_AGENT_NAME_POOL.length) return SUB_AGENT_NAME_POOL[slot]!
  const comboSlot = slot - SUB_AGENT_NAME_POOL.length
  const zodiac = SUB_AGENT_ZODIAC_NAMES[comboSlot % SUB_AGENT_ZODIAC_NAMES.length]!
  const stem = SUB_AGENT_HEAVENLY_STEMS[Math.floor(comboSlot / SUB_AGENT_ZODIAC_NAMES.length) % SUB_AGENT_HEAVENLY_STEMS.length]!
  const round = Math.floor(comboSlot / (SUB_AGENT_ZODIAC_NAMES.length * SUB_AGENT_HEAVENLY_STEMS.length))
  return round === 0 ? `${zodiac}·${stem}` : `${zodiac}·${stem}·${round + 1}`
}
