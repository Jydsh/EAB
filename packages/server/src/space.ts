/** 对话本轮的文件空间。云空间默认可用；none 表示纯对话、不暴露文件工具。 */
export type ActiveSpace =
  /** channel 只用于区分同一云空间在不同入口的交付方式，不改变工具可见性。 */
  | { kind: 'cloud'; channel?: 'dingtalk-a2ui' | 'dingtalk-file' }
  | { kind: 'none' }
