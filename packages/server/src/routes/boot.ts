/**
 * 启动动画配置与媒体路由。
 *
 * 公开只读：
 * - GET /boot/config.js     给登录页/工作台一个极小同步配置，避免先闪一下再换片；
 * - GET /boot/assets/:id    MP4 片源，支持 Range/206。
 *
 * 控制台：
 * - GET/PUT /api/console/boot
 * - PUT /api/console/company/boot
 * - POST /api/console/boot/assets
 */
import { createReadStream, statSync } from 'node:fs'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { EC, EabError } from '@eab/domain'
import { appendAudit } from '@eab/storage'
import type { ServerDeps } from '../deps.js'
import { ok } from '../http.js'
import { isConsoleRequest } from '../console-auth.js'
import {
  MAX_BOOT_ASSET_BYTES,
  deleteBootAsset,
  listBootAssets,
  publicBootConfig,
  readBootAsset,
  readCompanyBootSettings,
  saveBootAsset,
  saveCompanyBootSettings,
  saveGlobalBootSettings,
  type SaveBootInput,
  type SaveCompanyBootInput,
} from '../boot-animation.js'
import { readConsoleSettings } from '../settings.js'

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
    resourceType: 'boot_animation',
    resourceId: 'global',
    result: 'success',
    ip: req.ip,
    channel: 'console',
    detail: detail as never,
  })
}

function parseRange(raw: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(raw.trim())
  if (!match) return null
  const startText = match[1]
  const endText = match[2]
  if (!startText && !endText) return null
  let start: number
  let end: number
  if (!startText) {
    const suffix = Number(endText)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(startText)
    end = endText ? Number(endText) : size - 1
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= size || start > end) {
    return null
  }
  return { start, end }
}

function assetReply(req: FastifyRequest, reply: FastifyReply, assetId: string, dataDir: string | undefined, dbPath: string) {
  const found = readBootAsset(dataDir, dbPath, assetId)
  if (!found) {
    return reply.code(404).send({ ok: false, code: 'EAB_NOT_FOUND', message: '片源不存在' })
  }
  let size = 0
  try {
    size = statSync(found.path).size
  } catch {
    return reply.code(404).send({ ok: false, code: 'EAB_NOT_FOUND', message: '片源无法读取' })
  }
  reply.header('content-type', 'video/mp4')
  reply.header('accept-ranges', 'bytes')
  reply.header('cache-control', 'private, max-age=31536000, immutable')
  const range = typeof req.headers.range === 'string' ? parseRange(req.headers.range, size) : null
  if (req.headers.range && !range) {
    return reply
      .code(416)
      .header('content-range', `bytes */${size}`)
      .type('application/json; charset=utf-8')
      .send({ ok: false, code: 'EAB_RANGE', message: '请求的字节范围不合法' })
  }
  if (!range) {
    reply.header('content-length', String(size))
    return reply.send(createReadStream(found.path))
  }
  reply.code(206)
  reply.header('content-length', String(range.end - range.start + 1))
  reply.header('content-range', `bytes ${range.start}-${range.end}/${size}`)
  return reply.send(createReadStream(found.path, { start: range.start, end: range.end }))
}

function consoleBootView(deps: ServerDeps) {
  return {
    global: readConsoleSettings().bootAnimation,
    company: readCompanyBootSettings(deps.db, deps.companyId),
    companyId: deps.companyId,
    assets: listBootAssets(deps.config.dataDir, deps.config.dbPath),
  }
}

export function registerBootRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // 浏览器上传 MP4：只接受明确的 video/mp4，避免把任意二进制塞进媒体库。
  app.addContentTypeParser(
    'video/mp4',
    { parseAs: 'buffer', bodyLimit: MAX_BOOT_ASSET_BYTES + 4096 },
    (_req, body, done) => done(null, body),
  )

  app.get('/boot/config.js', async (req, reply) => {
    const raw = (req.query ?? {}) as Record<string, unknown>
    const surface = raw.surface === 'admin' ? 'admin' : 'chat'
    const config = publicBootConfig(deps.db, deps.companyId, deps.config.dataDir, deps.config.dbPath, surface)
    reply.type('application/javascript; charset=utf-8').header('cache-control', 'no-store')
    return reply.send(`window.EAB_BOOT_CONFIG = ${JSON.stringify(config)};`)
  })

  app.get<{ Params: { assetId: string } }>('/boot/assets/:assetId', async (req, reply) => {
    return assetReply(req, reply, req.params.assetId, deps.config.dataDir, deps.config.dbPath)
  })

  app.get('/api/console/boot', async (req) => {
    requireConsole(req, deps)
    return ok(consoleBootView(deps))
  })

  app.put('/api/console/boot', async (req) => {
    requireConsole(req, deps)
    const body = (req.body ?? {}) as SaveBootInput
    const global = saveGlobalBootSettings(deps.config.dataDir, deps.config.dbPath, body)
    audit(deps, req, 'boot.global.save', {
      enabled: global.enabled,
      revision: global.revision,
      adminMode: global.admin.mode,
      chatMode: global.chat.mode,
    })
    return ok({ ...consoleBootView(deps), global })
  })

  app.put('/api/console/company/boot', async (req) => {
    requireConsole(req, deps)
    const body = (req.body ?? {}) as SaveCompanyBootInput
    const company = saveCompanyBootSettings(deps.db, deps.companyId, body)
    audit(deps, req, 'boot.company.save', {
      companyId: deps.companyId,
      useGlobal: company.useGlobal,
      chatMode: company.chat.mode ?? null,
    })
    return ok({ ...consoleBootView(deps), company })
  })

  app.post('/api/console/boot/assets', async (req) => {
    requireConsole(req, deps)
    if (!Buffer.isBuffer(req.body)) {
      throw new EabError(EC.VALIDATION, '上传片源必须使用 video/mp4 请求体', {
        hint: '前端直接发送 MP4 文件二进制，不要用表单或 base64。',
      })
    }
    const asset = saveBootAsset(
      deps.config.dataDir,
      deps.config.dbPath,
      req.body,
      req.headers['x-file-name'] ?? 'EAB 启动片头',
    )
    audit(deps, req, 'boot.asset.upload', {
      assetId: asset.id,
      bytes: asset.bytes,
      durationSec: asset.durationSec,
    })
    return ok({ asset })
  })

  app.delete<{ Params: { assetId: string } }>('/api/console/boot/assets/:assetId', async (req) => {
    requireConsole(req, deps)
    const assetId = req.params.assetId
    const view = consoleBootView(deps)
    const usedBy = [
      view.global.admin.assetId === assetId ? '管理端全局' : '',
      view.global.chat.assetId === assetId ? '员工端全局' : '',
      view.company.chat.assetId === assetId ? '员工端公司覆盖' : '',
    ].filter(Boolean)
    if (usedBy.length) {
      throw new EabError(EC.CONFLICT, `片源正在被${usedBy.join('、')}使用，先切换到其它片源再删除`)
    }
    if (!deleteBootAsset(deps.config.dataDir, deps.config.dbPath, assetId)) {
      throw new EabError(EC.NOT_FOUND, '片源不存在或已删除')
    }
    audit(deps, req, 'boot.asset.delete', { assetId })
    return ok({ deleted: assetId })
  })
}
