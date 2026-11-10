/**
 * 控制台「运行设置」接口：日志保留天数 + 数据目录。
 *
 * 两个设置都写在部署目录的 `.eab-dev/console-settings.json`：
 * - 保留天数立即生效（后台定时清理读同一份文件）；
 * - 数据目录要重启才生效，启动时由 main.ts 负责搬迁，运行中不动库文件。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { EC, EabError } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok } from '../http.js'
import { isConsoleRequest } from '../console-auth.js'
import { runRetention } from '../retention.js'
import { readConsoleSettings, writeConsoleSettings } from '../settings.js'

function requireConsole(req: FastifyRequest, deps: ServerDeps): void {
  if (!isConsoleRequest(req, deps.config)) {
    throw new EabError(EC.AUTH_REQUIRED, '需要控制台会话（请先在 /admin 登录）')
  }
}

function count(db: ServerDeps['db'], sql: string): number {
  return Number((db.prepare(sql).get() as { n: number }).n)
}

function localAddresses(): string[] {
  const found = new Set<string>()
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (!item.address || item.internal || item.family !== 'IPv4') continue
      found.add(item.address)
    }
  }
  return [...found].sort()
}

function validHost(value: string): boolean {
  if (!value || value.length > 253 || /\s/.test(value)) return false
  if (value === 'localhost' || value === '0.0.0.0' || value === '::' || value === '::1') return true
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255)
  }
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)
}

function readPort(value: unknown, label: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new EabError(EC.VALIDATION, `${label}必须是 1–65535 的整数`)
  }
  return port
}

function audit(deps: ServerDeps, req: FastifyRequest, action: string, detail: Record<string, unknown>): void {
  appendAudit(deps.db, {
    companyId: deps.companyId,
    actorUserId: 'console-operator',
    action,
    resourceType: 'console_settings',
    resourceId: 'runtime',
    result: 'success',
    ip: req.ip,
    channel: 'console',
    detail: detail as never,
  })
}

export function registerSettingsRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/console/settings', async (req) => {
    requireConsole(req, deps)
    const settings = readConsoleSettings()
    let dbSizeBytes = 0
    try {
      dbSizeBytes = statSync(deps.config.dbPath).size
    } catch {
      dbSizeBytes = 0
    }
    return ok({
      dataDir: deps.config.dataDir ?? '',
      dbPath: deps.config.dbPath,
      dbSizeBytes,
      envLocked: Boolean(deps.config.dataDirEnvLocked),
      retentionDays: settings.logRetentionDays,
      lastCleanupAt: settings.lastCleanupAt,
      lastCleanupStats: settings.lastCleanupStats,
      network: {
        host: deps.config.host,
        chatPort: deps.config.port,
        adminPort: deps.config.adminPort,
        allowRemoteConsole: deps.config.allowRemoteConsole,
        envLocked: deps.config.networkEnvLocked ?? {
          host: false,
          chatPort: false,
          adminPort: false,
          allowRemoteConsole: false,
        },
        localAddresses: localAddresses(),
      },
      logs: {
        syncRuns: count(deps.db, 'SELECT COUNT(*) AS n FROM org_sync_runs'),
        syncDiffs: count(deps.db, 'SELECT COUNT(*) AS n FROM org_sync_diffs'),
        channelEvents: count(deps.db, 'SELECT COUNT(*) AS n FROM channel_events'),
        loginAttempts: count(deps.db, 'SELECT COUNT(*) AS n FROM login_attempts'),
        pluginEvents: count(deps.db, 'SELECT COUNT(*) AS n FROM plugin_events'),
        onboardAttempts: count(deps.db, 'SELECT COUNT(*) AS n FROM dingtalk_onboard_attempts'),
        auditLogs: count(deps.db, 'SELECT COUNT(*) AS n FROM audit_logs'),
      },
    })
  })

  app.put<{ Body: { days?: number } }>('/api/console/settings/retention', async (req) => {
    requireConsole(req, deps)
    const raw = Number(req.body?.days)
    if (!Number.isInteger(raw) || raw < 0 || (raw > 0 && raw < 7) || raw > 3650) {
      throw new EabError(EC.VALIDATION, '保留天数只能是 0（永久保留）或 7–3650 天')
    }
    const settings = writeConsoleSettings({ logRetentionDays: raw })
    audit(deps, req, 'ops.settings.retention', { days: raw })
    return ok({ retentionDays: settings.logRetentionDays, applied: true })
  })

  app.post('/api/console/settings/retention/run', async (req) => {
    requireConsole(req, deps)
    const settings = readConsoleSettings()
    const result = runRetention(deps.db, settings.logRetentionDays)
    writeConsoleSettings({ lastCleanupAt: new Date().toISOString(), lastCleanupStats: result.deleted })
    audit(deps, req, 'ops.settings.retention.run', { days: result.days, deleted: result.deleted })
    return ok(result)
  })

  app.put<{
    Body: { host?: string; chatPort?: number; adminPort?: number; allowRemoteConsole?: boolean }
  }>('/api/console/settings/network', async (req) => {
    requireConsole(req, deps)
    const locked = deps.config.networkEnvLocked ?? {
      host: false,
      chatPort: false,
      adminPort: false,
      allowRemoteConsole: false,
    }
    const body = req.body ?? {}
    const current = {
      host: deps.config.host,
      chatPort: deps.config.port,
      adminPort: deps.config.adminPort,
      allowRemoteConsole: deps.config.allowRemoteConsole,
    }
    const next = {
      host: body.host === undefined ? current.host : String(body.host).trim(),
      chatPort: body.chatPort === undefined ? current.chatPort : readPort(body.chatPort, '员工对话端口'),
      adminPort: body.adminPort === undefined ? current.adminPort : readPort(body.adminPort, '管理控制台端口'),
      allowRemoteConsole:
        body.allowRemoteConsole === undefined ? current.allowRemoteConsole : Boolean(body.allowRemoteConsole),
    }
    if (!validHost(next.host)) {
      throw new EabError(EC.VALIDATION, `监听地址不合法：${next.host}`, { hint: '本机用 127.0.0.1，局域网用 0.0.0.0' })
    }
    if (next.chatPort === next.adminPort) {
      throw new EabError(EC.VALIDATION, '员工对话端口和管理控制台端口不能相同')
    }
    for (const key of ['host', 'chatPort', 'adminPort', 'allowRemoteConsole'] as const) {
      if (locked[key] && next[key] !== current[key]) {
        throw new EabError(EC.FORBIDDEN, `${key} 已由 EAB_* 环境变量固定，控制台不能修改`, {
          hint: '去掉对应环境变量后重启，才能在这里调整网络设置',
        })
      }
    }
    const settings = writeConsoleSettings({
      host: next.host,
      chatPort: next.chatPort,
      adminPort: next.adminPort,
      allowRemoteConsole: next.allowRemoteConsole,
    })
    audit(deps, req, 'ops.settings.network', next)
    const changed =
      next.host !== current.host ||
      next.chatPort !== current.chatPort ||
      next.adminPort !== current.adminPort ||
      next.allowRemoteConsole !== current.allowRemoteConsole
    return ok({
      ...settings,
      network: next,
      changed,
      restartRequired: changed,
      hint: changed ? '重启服务后生效；局域网访问还需要放行防火墙端口' : '网络设置没有变化',
    })
  })

  app.put<{ Body: { path?: string | null; reset?: boolean } }>('/api/console/settings/data-dir', async (req) => {
    requireConsole(req, deps)
    if (deps.config.dataDirEnvLocked) {
      throw new EabError(EC.FORBIDDEN, '数据目录由环境变量 EAB_DB 固定，控制台不能改', {
        hint: '去掉 EAB_DB 后重启，才能在这里切换数据目录',
      })
    }
    const reset = Boolean(req.body?.reset)
    const input = String(req.body?.path ?? '').trim()
    if (!reset && !input) throw new EabError(EC.VALIDATION, '数据目录不能为空')
    if (!reset && !isAbsolute(input)) throw new EabError(EC.VALIDATION, '请填写绝对路径，例如 D:\\EABData')

    let dataDir: string | null = null
    if (!reset) {
      dataDir = resolve(input)
      try {
        mkdirSync(dataDir, { recursive: true })
        const probe = join(dataDir, '.eab-write-probe')
        writeFileSync(probe, 'ok', 'utf8')
        rmSync(probe, { force: true })
      } catch (err) {
        throw new EabError(EC.VALIDATION, `目录不可写：${(err as Error).message}`)
      }
    }
    const current = deps.config.dataDir ?? ''
    if (dataDir && current && resolve(current) === dataDir) {
      return ok({ dataDir: current, changed: false, restartRequired: false })
    }
    const settings = writeConsoleSettings({ dataDir })
    audit(deps, req, 'ops.settings.data_dir', { dataDir, reset })
    return ok({
      dataDir: dataDir ?? '',
      changed: true,
      restartRequired: true,
      savedAt: settings.dataDir,
      hint: reset ? '重启后回到部署目录 .eab-dev' : '重启服务后生效；启动时会把现有数据库与密钥搬过去',
    })
  })
}
