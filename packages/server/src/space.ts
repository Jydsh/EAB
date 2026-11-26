/** 对话本轮的文件空间。云空间默认可用；none 表示纯对话；local 表示用户指定的本地项目目录。 */
export type ActiveSpace =
  /** channel 只用于区分同一云空间在不同入口的交付方式，不改变工具可见性。 */
  | { kind: 'cloud'; channel?: 'dingtalk-a2ui' | 'dingtalk-file' }
  | { kind: 'none' }
  /**
   * 本地项目空间必须由当前员工在桌面端创建。root 是项目目录的显示路径；
   * deviceId 非空时，真实文件操作要经过该桌面设备的文件桥。
   */
  | {
      kind: 'local'
      id: string
      name: string
      root: string
      mode: 'read_write' | 'read_only'
      allowSensitive: boolean
      deviceId: string | null
      instructions: string
      cloudRefs: string[]
    }
