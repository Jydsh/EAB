/**
 * 桌面文件桥。
 *
 * 服务端不直接访问桌面客户端电脑的磁盘：桌面端用登录态向服务端注册一个稳定的设备 id，
 * 然后长轮询领取文件任务，在本机执行后回传结果。这样服务端即使部署在另一台服务器，
 * 项目仍然指向“安装桌面端的那台电脑”的目录。
 *
 * 安全边界：
 * - 任务只能派给同一公司、同一员工、同一设备；
 * - 每个任务有超时，桌面端离线时立即失败，不无限挂起；
 * - 真正的路径校验在桌面端执行，服务端只保存展示用路径与设备归属。
 */
import { randomUUID } from 'node:crypto'
import { EC, EabError } from '@eab/domain'

export type DesktopFileOp =
  | 'describeRoot'
  | 'list'
  | 'read'
  | 'search'
  | 'write'
  | 'edit'
  | 'delete'

export type DesktopJobOp = DesktopFileOp | 'browser'

export interface DesktopFileJob {
  id: string
  /** file=本地项目文件；browser=桌面右侧浏览器 */
  kind?: 'file' | 'browser'
  op: DesktopJobOp
  projectId: string
  args: Record<string, unknown>
  createdAt: number
}

export interface DesktopBrowserTabInfo {
  pageId: string
  title: string
  url: string
  favicon?: string
  active?: boolean
}

export interface DesktopBrowserTabsSnapshot {
  sessionId: string
  activePageId: string
  tabs: DesktopBrowserTabInfo[]
  updatedAt: number
}

export interface DesktopJobErrorPayload {
  status?: 'not_found' | 'forbidden' | 'validation' | 'conflict' | 'internal'
  message?: string
  hint?: string
}

export interface DesktopJobResult {
  ok: boolean
  result?: unknown
  error?: DesktopJobErrorPayload
}

interface DeviceState {
  key: string
  companyId: string
  userId: string
  deviceId: string
  name: string
  platform: string
  lastSeenAt: number
  browserTabsBySession: Map<string, DesktopBrowserTabsSnapshot>
  pending: DesktopFileJob[]
  waiter: ((job: DesktopFileJob | null) => void) | null
  waiterTimer: NodeJS.Timeout | null
}

interface InflightJob {
  job: DesktopFileJob
  key: string
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer: NodeJS.Timeout
}

const DEVICE_ONLINE_WINDOW_MS = 45_000
const POLL_HOLD_MS = 20_000
const DEFAULT_JOB_TIMEOUT_MS = 30_000

function bridgeKey(companyId: string, userId: string, deviceId: string): string {
  return `${companyId}:${userId}:${deviceId}`
}

function normalizeDeviceId(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(text)) {
    throw new EabError(EC.VALIDATION, '桌面设备标识无效')
  }
  return text
}

export class DesktopBridgeHub {
  private readonly devices = new Map<string, DeviceState>()
  private readonly inflight = new Map<string, InflightJob>()

  /** 桌面端启动时调用；同一设备重复注册只刷新时间。 */
  register(
    companyId: string,
    userId: string,
    input: { deviceId: string; name?: string; platform?: string },
  ): { deviceId: string; name: string; online: boolean } {
    const deviceId = normalizeDeviceId(input.deviceId)
    const key = bridgeKey(companyId, userId, deviceId)
    const previous = this.devices.get(key)
    const device: DeviceState = previous ?? {
      key,
      companyId,
      userId,
      deviceId,
      name: '',
      platform: '',
      lastSeenAt: 0,
      browserTabsBySession: new Map(),
      pending: [],
      waiter: null,
      waiterTimer: null,
    }
    device.name = String(input.name ?? '').trim().slice(0, 80) || device.name || '本机桌面端'
    device.platform = String(input.platform ?? '').trim().slice(0, 20) || device.platform || 'unknown'
    device.lastSeenAt = Date.now()
    this.devices.set(key, device)
    return { deviceId, name: device.name, online: true }
  }

  status(companyId: string, userId: string, deviceId: string): {
    deviceId: string
    online: boolean
    name: string
    lastSeenAt: number
  } {
    const key = bridgeKey(companyId, userId, normalizeDeviceId(deviceId))
    const device = this.devices.get(key)
    const online = Boolean(device && Date.now() - device.lastSeenAt < DEVICE_ONLINE_WINDOW_MS)
    return {
      deviceId: String(deviceId),
      online,
      name: device?.name ?? '',
      lastSeenAt: device?.lastSeenAt ?? 0,
    }
  }

  isOnline(companyId: string, userId: string, deviceId: string | null | undefined): boolean {
    if (!deviceId) return false
    try {
      return this.status(companyId, userId, deviceId).online
    } catch {
      return false
    }
  }

  /**
   * 选出当前请求应该使用的桌面设备。
   * 优先用页面通过 x-eab-desktop-device 带来的设备；没有时选该员工最近心跳的在线设备。
   */
  resolveOnlineDevice(
    companyId: string,
    userId: string,
    preferredDeviceId?: string | null,
  ): string | null {
    if (preferredDeviceId) {
      try {
        if (this.isOnline(companyId, userId, preferredDeviceId)) return normalizeDeviceId(preferredDeviceId)
      } catch {
        // 非法设备 id 当没有偏好，继续按最近在线设备选。
      }
    }
    let latest: DeviceState | null = null
    for (const device of this.devices.values()) {
      if (device.companyId !== companyId || device.userId !== userId) continue
      if (Date.now() - device.lastSeenAt >= DEVICE_ONLINE_WINDOW_MS) continue
      if (!latest || device.lastSeenAt > latest.lastSeenAt) latest = device
    }
    return latest?.deviceId ?? null
  }

  /** 桌面端上报右侧浏览器标签页快照；只保存标题/网址，不保存页面正文。按对话分桶保存。 */
  updateBrowserTabs(
    companyId: string,
    userId: string,
    deviceId: string,
    input: { sessionId?: string; activePageId?: string; tabs?: Array<Record<string, unknown>> },
  ): void {
    const key = bridgeKey(companyId, userId, normalizeDeviceId(deviceId))
    const device = this.devices.get(key)
    if (!device) throw new EabError(EC.CONFLICT, '桌面端尚未注册，请重新打开 EAB 桌面端')
    device.lastSeenAt = Date.now()
    const sessionId = String(input.sessionId ?? '').trim().slice(0, 120)
    const tabs = Array.isArray(input.tabs) ? input.tabs : []
    const snapshot: DesktopBrowserTabsSnapshot = {
      sessionId,
      activePageId: String(input.activePageId ?? '').trim(),
      tabs: tabs
        .map((tab) => ({
          pageId: String(tab.pageId ?? '').trim(),
          title: String(tab.title ?? '').trim().slice(0, 200),
          url: String(tab.url ?? '').trim().slice(0, 2000),
          favicon: String(tab.favicon ?? '').trim().slice(0, 500),
        }))
        .filter((tab) => /^dp_[A-Za-z0-9_-]{4,80}$/.test(tab.pageId))
        .slice(0, 20),
      updatedAt: Date.now(),
    }
    // 一个设备最多保留最近 40 个对话的标签快照，避免长期在线后无限增长。
    if (!device.browserTabsBySession.has(sessionId) && device.browserTabsBySession.size >= 40) {
      const oldest = [...device.browserTabsBySession.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]
      if (oldest) device.browserTabsBySession.delete(oldest[0])
    }
    device.browserTabsBySession.set(sessionId, snapshot)
  }

  /**
   * 给系统提示/工具使用的标签页摘要；桌面端离线或未上报时返回 null。
   * 传 sessionId 时只返回该对话的标签，避免不同对话的网页互相串。
   */
  browserTabsFor(
    companyId: string,
    userId: string,
    deviceId?: string | null,
    sessionId?: string | null,
  ): DesktopBrowserTabsSnapshot | null {
    const resolved = this.resolveOnlineDevice(companyId, userId, deviceId)
    if (!resolved) return null
    const device = this.devices.get(bridgeKey(companyId, userId, resolved))
    if (!device) return null
    const targetSession = String(sessionId ?? '').trim()
    let snapshot: DesktopBrowserTabsSnapshot | undefined
    if (targetSession) {
      snapshot = device.browserTabsBySession.get(targetSession)
    } else {
      snapshot = [...device.browserTabsBySession.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    }
    if (!snapshot) return null
    if (Date.now() - snapshot.updatedAt > DEVICE_ONLINE_WINDOW_MS * 2) return null
    return snapshot
  }

  /** 桌面端每完成一轮轮询就刷新一次在线时间；没有任务时最多挂起 20 秒。 */
  async takeJob(
    companyId: string,
    userId: string,
    deviceId: string,
    holdMs = POLL_HOLD_MS,
  ): Promise<DesktopFileJob | null> {
    const key = bridgeKey(companyId, userId, normalizeDeviceId(deviceId))
    const device = this.devices.get(key)
    if (!device) throw new EabError(EC.CONFLICT, '桌面端尚未注册，请重新打开 EAB 桌面端')
    device.lastSeenAt = Date.now()
    const next = device.pending.shift()
    if (next) {
      next.args = { ...next.args }
      return next
    }
    if (device.waiter) {
      device.waiter(null)
      device.waiter = null
      if (device.waiterTimer) clearTimeout(device.waiterTimer)
      device.waiterTimer = null
    }
    return new Promise((resolve) => {
      const finish = (job: DesktopFileJob | null) => {
        if (device.waiter === finish) {
          device.waiter = null
          device.waiterTimer = null
        }
        resolve(job)
      }
      device.waiter = finish
      device.waiterTimer = setTimeout(() => finish(null), Math.max(1000, Math.min(holdMs, POLL_HOLD_MS)))
    })
  }

  /**
   * 服务端工具/接口发起任务并等待桌面回传。
   * 条件不满足时抛 409，让 Agent 知道是“桌面端没连上”，而不是路径不存在。
   */
  call<T = unknown>(
    companyId: string,
    userId: string,
    deviceId: string,
    op: DesktopJobOp,
    projectId: string,
    args: Record<string, unknown>,
    timeoutMs = DEFAULT_JOB_TIMEOUT_MS,
    kind: 'file' | 'browser' = op === 'browser' ? 'browser' : 'file',
  ): Promise<T> {
    if (!this.isOnline(companyId, userId, deviceId)) {
      throw new EabError(
        EC.CONFLICT,
        kind === 'browser'
          ? '桌面端浏览器服务未连接，请保持安装 EAB 桌面端的电脑开机并打开应用'
          : '桌面端文件服务未连接，请保持安装 EAB 桌面端的电脑开机并打开应用',
        {
          hint: kind === 'browser'
            ? '右侧浏览器运行在桌面客户端电脑上；桌面端连接后重试。'
            : '项目的本地路径在桌面客户端电脑上，服务端无法直接访问；桌面端连接后重试。',
        },
      )
    }
    const key = bridgeKey(companyId, userId, normalizeDeviceId(deviceId))
    const job: DesktopFileJob = {
      id: `dj_${randomUUID().replace(/-/g, '')}`,
      kind,
      op,
      projectId,
      args,
      createdAt: Date.now(),
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inflight.delete(job.id)
        reject(new EabError(
          EC.CONFLICT,
          kind === 'browser'
            ? '桌面端浏览器操作超时，请确认电脑没有休眠且 EAB 仍在运行'
            : '桌面端执行文件操作超时，请确认电脑没有休眠且 EAB 仍在运行',
        ))
      }, Math.max(5000, timeoutMs))
      this.inflight.set(job.id, {
        job,
        key,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      const device = this.devices.get(key)
      if (!device) {
        clearTimeout(timer)
        this.inflight.delete(job.id)
        reject(new EabError(EC.CONFLICT, '桌面端尚未注册'))
        return
      }
      if (device.waiter) {
        const waiter = device.waiter
        device.waiter = null
        if (device.waiterTimer) clearTimeout(device.waiterTimer)
        device.waiterTimer = null
        waiter(job)
      } else {
        device.pending.push(job)
      }
    })
  }

  /** Agent 浏览器工具专用入口；任务不带项目 id，桌面端按 browser 任务执行。 */
  browserCall<T = unknown>(
    companyId: string,
    userId: string,
    deviceId: string,
    args: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<T> {
    return this.call<T>(companyId, userId, deviceId, 'browser', '', args, timeoutMs, 'browser')
  }

  /** 桌面端回传执行结果；任务 id 与设备必须完全匹配，防止串任务。 */
  complete(
    companyId: string,
    userId: string,
    deviceId: string,
    jobId: string,
    payload: DesktopJobResult,
  ): void {
    const key = bridgeKey(companyId, userId, normalizeDeviceId(deviceId))
    const entry = this.inflight.get(jobId)
    if (!entry) throw new EabError(EC.NOT_FOUND, '文件任务不存在或已超时')
    if (entry.key !== key) throw new EabError(EC.FORBIDDEN, '文件任务不属于当前设备')
    this.inflight.delete(jobId)
    clearTimeout(entry.timer)
    if (payload?.ok) {
      entry.resolve(payload.result ?? null)
      return
    }
    const status = payload?.error?.status
    const code = status === 'not_found'
      ? EC.NOT_FOUND
      : status === 'forbidden'
        ? EC.FORBIDDEN
        : status === 'conflict'
          ? EC.CONFLICT
          : status === 'validation'
            ? EC.VALIDATION
            : EC.INTERNAL
    entry.reject(new EabError(code, String(payload?.error?.message || '桌面端文件操作失败'), {
      hint: payload?.error?.hint ? String(payload.error.hint) : undefined,
    }))
  }

  /** 测试/进程退出清理，避免未完成 Promise 和定时器泄漏。 */
  dispose(): void {
    for (const [id, entry] of this.inflight) {
      clearTimeout(entry.timer)
      entry.reject(new EabError(EC.CONFLICT, '桌面文件桥已关闭'))
      this.inflight.delete(id)
    }
    for (const device of this.devices.values()) {
      if (device.waiter) device.waiter(null)
      if (device.waiterTimer) clearTimeout(device.waiterTimer)
    }
    this.devices.clear()
  }
}

export function createDesktopBridgeHub(): DesktopBridgeHub {
  return new DesktopBridgeHub()
}

export function assertDesktopOrigin(reqHeaders: Record<string, unknown>): void {
  const marker = String(reqHeaders['x-eab-desktop'] ?? '').trim().toLowerCase()
  if (marker !== '1' && marker !== 'true') {
    throw new EabError(EC.FORBIDDEN, '本地项目只能在 EAB 桌面端创建', {
      hint: '请打开 EAB 桌面客户端并保持登录，网页端不提供本地文件夹选择。',
    })
  }
}

export function isDesktopOrigin(reqHeaders: Record<string, unknown>): boolean {
  const marker = String(reqHeaders['x-eab-desktop'] ?? '').trim().toLowerCase()
  return marker === '1' || marker === 'true'
}
