/**
 * 内容生成（AGT-19 多模态内容工具 v1）。
 *
 * 独立于对话主链路：只做「文字 → 图片」，结果落进个人云空间，
 * 不复用聊天上下文，也不把图片写进消息历史。
 * 模型选择走用途路由 `image.default`，供应商协议是 OpenAI 兼容的 /images/generations。
 */
import type { FastifyInstance } from 'fastify'
import { EC, EabError, SC, ulid } from '@eab/domain'
import type { ServerDeps } from '../deps.js'
import { ok, requireScope } from '../http.js'
import { resolveActor, type RequestActor } from '../session.js'
import { callImageGeneration } from '../llm.js'
import { resolveModelForPurpose } from '../model-registry.js'
import { saveUserWorkspaceFile, type SavedWorkspaceFile } from './workspace.js'

export interface GeneratedImageAsset {
  readonly file: SavedWorkspaceFile
  readonly downloadUrl: string
  readonly modelKey: string
  readonly revisedPrompt?: string
}

function extensionFor(mime: string): string {
  if (mime === 'image/jpeg') return '.jpg'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'image/gif') return '.gif'
  return '.png'
}

/** 文字生成图片并存入个人云空间；接口与内置工具共用这一条路径。 */
export async function generateImageToWorkspace(
  deps: ServerDeps,
  actor: RequestActor,
  input: { prompt: string; size?: string; channel?: string; traceId?: string | null },
): Promise<GeneratedImageAsset> {
  const model = resolveModelForPurpose(deps.db, actor.subject.companyId, 'image.default')
  if (!model) {
    throw new EabError(EC.VALIDATION, '还没有可用的图片生成模型', {
      hint: '请在控制台模型页接入 OpenAI 兼容的 /images/generations 端点，并把「图片生成」用途路由到它',
    })
  }
  const result = await callImageGeneration(
    deps.db,
    deps.config.dbPath,
    actor.subject.companyId,
    model.id,
    input.prompt,
    { size: input.size },
  )
  const stamp = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const name = `生成图片-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}-${ulid().slice(-6).toLowerCase()}${extensionFor(result.mime)}`
  const file = saveUserWorkspaceFile(deps, actor, {
    relPath: name,
    buffer: result.image,
    mime: result.mime,
    channel: input.channel ?? 'agent',
    traceId: input.traceId ?? null,
  })
  return {
    file,
    downloadUrl: `/api/workspace/files/${file.id}/download`,
    modelKey: result.modelKey,
    revisedPrompt: result.revisedPrompt,
  }
}

export function registerContentRoutes(app: FastifyInstance, deps: ServerDeps): void {
  /** 独立内容接口：不进入 /api/chat，避免图片生成污染对话上下文。 */
  app.post<{ Body: { prompt?: string; size?: string } }>('/api/content/images', async (req) => {
    const actor = resolveActor(deps.db, deps.config, req)
    requireScope(actor.subject, SC.WORKSPACE_WRITE)
    const body = req.body ?? {}
    const prompt = String(body.prompt ?? '').trim()
    if (!prompt) throw new EabError(EC.VALIDATION, '请填写图片描述')
    const asset = await generateImageToWorkspace(deps, actor, {
      prompt,
      size: body.size,
      channel: 'web',
      traceId: String(req.id),
    })
    return ok({
      file: asset.file,
      downloadUrl: asset.downloadUrl,
      modelKey: asset.modelKey,
      revisedPrompt: asset.revisedPrompt,
    })
  })
}
