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
import { checkForUpdate, getCachedUpdateStatus, startUpdate } from '../update.js'

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
    const result = startUpdate(status.latest, status.sourceUrl, status.sourceDigest)
    audit(deps, req, 'ops.update.apply', {
      from: status.current,
      to: status.latest,
      sourceUrl: status.sourceUrl,
      sourceDigest: status.sourceDigest,
      command: result.command,
      updaterPid: result.pid,
    })
    // 先让接口返回，再关闭服务；更新器会等待端口释放后替换文件并重启。
    // 等待 1.2 秒，确保浏览器先收到 accepted 响应，而不是被进程退出截断。
    setTimeout(() => deps.shutdown?.(), 1200)
    return ok({
      accepted: true,
      version: status.latest,
      command: result.command,
      updaterPid: result.pid,
      restarting: true,
    })
  })
}
