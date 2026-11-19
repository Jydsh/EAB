/**
 * 控制台版本更新接口。
 * 检测只读 GitHub Release；确认更新后启动独立更新器，本进程稍后退出。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { EC, EabError } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok } from '../http.js'
import { isConsoleRequest } from '../console-auth.js'
import { cancelUpdateStart, checkForUpdate, getCachedUpdateStatus, markUpdateStartFailed, readLastUpdateResult, startUpdate, waitForUpdaterStarted } from '../update.js'

function requireConsole(req: FastifyRequest, deps: ServerDeps): void {
  if (!isConsoleRequest(req, deps.config)) {
    throw new EabError(EC.AUTH_REQUIRED, '需要控制台会话（请先在 /admin 登录）')
  }
}

function audit(deps: ServerDeps, req: FastifyRequest, action: string, detail: Record<string, unknown>): void {
  appendAudit(deps.db, {
    companyId: deps.companyId,
    actorUserId: 'console-operator',
    action,
    resourceType: 'version_update',
    resourceId: 'source',
    result: 'success',
    ip: req.ip,
    channel: 'console',
    detail: detail as never,
  })
}

export function registerUpdateRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/api/console/update', async (req) => {
    requireConsole(req, deps)
    return ok(getCachedUpdateStatus())
  })

  app.get('/api/console/update/result', async (req) => {
    requireConsole(req, deps)
    return ok({ result: readLastUpdateResult() })
  })

  app.post('/api/console/update/check', async (req) => {
    requireConsole(req, deps)
    const status = await checkForUpdate(true)
    audit(deps, req, 'ops.update.check', {
      current: status.current,
      latest: status.latest,
      hasUpdate: status.hasUpdate,
      error: status.error,
    })
    return ok(status)
  })

  app.post('/api/console/update/apply', async (req) => {
    requireConsole(req, deps)
    // 没有 shutdown 的启动方式（例如被别的进程托管）无法让旧进程退出；
    // 提前报错，避免更新器在后台等 30 秒端口后静默失败。
    if (!deps.shutdown) throw new EabError(EC.VALIDATION, '当前启动方式不支持自动重启，请先执行 eab restart')
    const status = await checkForUpdate(true)
    if (status.error) throw new EabError(EC.VALIDATION, status.error)
    if (!status.hasUpdate) throw new EabError(EC.VALIDATION, `当前已是最新版本 v${status.current}`)
    if (!status.latest) throw new EabError(EC.VALIDATION, 'GitHub Release 没有可识别的版本号')
    if (!status.sourceUrl) throw new EabError(EC.VALIDATION, '该 Release 没有源码压缩包，无法一键更新')
    let result: ReturnType<typeof startUpdate>
    try {
      result = startUpdate(status.latest, status.sourceUrl, status.sourceDigest)
    } catch (error) {
      audit(deps, req, 'ops.update.apply.failed', {
        from: status.current,
        to: status.latest,
        sourceUrl: status.sourceUrl,
        error: (error as Error).message,
      })
      throw error
    }
    // spawn 的失败是异步事件；必须等更新器把 running 写进状态文件，
    // 确认子进程真的接管后才关闭当前服务，否则会留下“服务已停、没人拉起”的空窗。
    const ready = await waitForUpdaterStarted(3000, result.startedAt)
    if (!ready) {
      const cancelled = cancelUpdateStart(result.pid)
      const message = `更新器未在 3 秒内确认启动，服务未关闭${cancelled ? '，已终止未接管的更新器' : ''}；请检查 .eab-dev/updates/last-update.log`
      markUpdateStartFailed(message, cancelled ? result.pid : null)
      audit(deps, req, 'ops.update.apply.failed', {
        from: status.current,
        to: status.latest,
        sourceUrl: status.sourceUrl,
        error: message,
        updaterPid: result.pid,
        cancelled,
      })
      throw new EabError(EC.VALIDATION, message)
    }
    audit(deps, req, 'ops.update.apply', {
      from: status.current,
      to: status.latest,
      sourceUrl: status.sourceUrl,
      sourceDigest: status.sourceDigest,
      command: result.command,
      updaterPid: result.pid,
      startedAt: result.startedAt,
    })
    // 先让接口返回，再关闭服务；更新器会等待端口释放后替换文件并重启。
    // 等待 1.2 秒，确保浏览器先收到 accepted 响应，而不是被进程退出截断。
    setTimeout(() => deps.shutdown?.(), 1200)
    return ok({
      accepted: true,
      version: status.latest,
      command: result.command,
      updaterPid: result.pid,
      startedAt: result.startedAt,
      restarting: true,
    })
  })
}
