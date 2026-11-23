/**
 * A2A 入站协议端点。
 *
 * - `GET /.well-known/agent.json` 只暴露启用后的受限能力卡；
 * - `POST /a2a` 处理 JSON-RPC 2.0 的 `message/send`、`tasks/get`、`tasks/cancel`；
 * - 鉴权只认 `Authorization: Bearer <控制台生成令牌>`，不支持 URL 参数或 Cookie；
 * - 第一版同步最多等 60 秒，超时返回 `working`，外部用 `tasks/get` 轮询。
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { EabError } from '@eab/domain'
import type { ServerDeps } from '../deps.js'
import {
  auditInboundTask,
  authenticateA2AInboundConfig,
  buildA2AInboundAgentCard,
  buildA2AInboundBaseUrl,
  buildInboundTaskEnvelope,
  cancelA2AInboundTask,
  getA2AInboundConfig,
  getInboundTask,
  startA2AInboundTask,
  waitForInboundTask,
  type A2AInboundTask,
} from '../a2a-inbound.js'

type RpcId = string | number | null

interface RpcRequest {
  readonly jsonrpc?: unknown
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
}

function rpcIdOf(body: RpcRequest): RpcId {
  const id = body.id
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

function rpcError(
  reply: FastifyReply,
  id: RpcId,
  code: number,
  message: string,
  statusCode = 200,
  data?: unknown,
) {
  reply.code(statusCode).type('application/json; charset=utf-8')
  return reply.send({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  })
}

function rpcResult(reply: FastifyReply, id: RpcId, result: unknown) {
  reply.type('application/json; charset=utf-8')
  return reply.send({ jsonrpc: '2.0', id, result })
}

function objectOf(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
}

function textFromMessage(message: Record<string, unknown>): string {
  const parts = Array.isArray(message.parts) ? message.parts : []
  const texts: string[] = []
  for (const part of parts) {
    const item = objectOf(part)
    if (item.kind !== 'text' && item.type !== 'text') continue
    const text = String(item.text ?? '').trim()
    if (text) texts.push(text)
  }
  return texts.join('\n')
}

function skillOf(params: Record<string, unknown>, message: Record<string, unknown>): string {
  const metadata = objectOf(params.metadata)
  const messageMetadata = objectOf(message.metadata)
  const raw = messageMetadata.skill ?? messageMetadata.skillId ?? metadata.skill ?? metadata.skillId ?? params.skill
  const value = String(raw ?? '').trim()
  return value || 'eab.answer'
}

function contextOf(params: Record<string, unknown>, message: Record<string, unknown>): string | null {
  const raw = message.contextId ?? params.contextId
  const value = String(raw ?? '').trim()
  return value || null
}

function taskIdOf(params: Record<string, unknown>): string {
  return String(params.id ?? params.taskId ?? '').trim()
}

function isEnabledInbound(cfg: ReturnType<typeof getA2AInboundConfig>): boolean {
  return cfg.enabled && cfg.effectiveSkills.length > 0
}

export function registerA2AInboundRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get('/.well-known/agent.json', async (req, reply) => {
    const cfg = getA2AInboundConfig(deps.db, deps.config, deps.companyId)
    if (!isEnabledInbound(cfg)) {
      reply.code(404).type('application/json; charset=utf-8')
      return reply.send({ ok: false, code: 'EAB_NOT_FOUND', message: 'A2A 入站未启用' })
    }
    const baseUrl = buildA2AInboundBaseUrl(req, cfg, deps.config)
    reply.header('cache-control', 'no-store').type('application/json; charset=utf-8')
    return reply.send(buildA2AInboundAgentCard(cfg, baseUrl))
  })

  app.post<{ Body: unknown }>('/a2a', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const body = objectOf(req.body) as RpcRequest
    const id = rpcIdOf(body)
    if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return rpcError(reply, id, -32600, 'Invalid JSON-RPC request')
    }
    const cfg = getA2AInboundConfig(deps.db, deps.config, deps.companyId)
    if (!isEnabledInbound(cfg)) {
      return rpcError(reply, id, -32001, 'A2A 入站未启用', 404)
    }
    if (!authenticateA2AInboundConfig(req, deps.config, cfg)) {
      return rpcError(reply, id, -32001, 'Unauthorized', 401)
    }

    const params = objectOf(body.params)
    try {
      if (body.method === 'message/send') {
        const message = objectOf(params.message)
        const prompt = textFromMessage(message)
        const skillId = skillOf(params, message)
        const contextId = contextOf(params, message)
        const started = startA2AInboundTask(deps, cfg, { skillId, prompt, contextId })
        // 长任务超过同步等待窗口时保持 working，外部按 A2A 标准轮询 tasks/get。
        const task = await waitForInboundTask(deps.db, deps.companyId, started.task.id, 60_000)
        void started.done.then(() => {
          const finalTask = getInboundTask(deps.db, cfg.companyId, started.task.id)
          if (finalTask) {
            auditTask(deps, cfg.companyId, 'a2a.inbound.message', finalTask)
          }
        }).catch(() => {})
        return rpcResult(reply, id, buildInboundTaskEnvelope(task))
      }

      if (body.method === 'tasks/get') {
        const task = getInboundTask(deps.db, cfg.companyId, taskIdOf(params))
        if (!task) return rpcError(reply, id, -32001, 'A2A 任务不存在', 200)
        return rpcResult(reply, id, buildInboundTaskEnvelope(task))
      }

      if (body.method === 'tasks/cancel') {
        const task = cancelA2AInboundTask(deps.db, cfg.companyId, taskIdOf(params))
        if (!task) return rpcError(reply, id, -32001, 'A2A 任务不存在', 200)
        auditTask(deps, cfg.companyId, 'a2a.inbound.cancel', task)
        return rpcResult(reply, id, buildInboundTaskEnvelope(task))
      }

      return rpcError(reply, id, -32601, 'Method not found')
    } catch (error) {
      if (error instanceof EabError) {
        return rpcError(reply, id, -32602, error.message)
      }
      return rpcError(reply, id, -32603, 'A2A 入站任务处理失败')
    }
  })
}

function auditTask(
  deps: ServerDeps,
  companyId: string,
  action: string,
  task: A2AInboundTask,
): void {
  auditInboundTask(deps, companyId, action, task, task.state === 'completed' ? 'success' : 'failure')
}
