/**
 * A2A 远端 Agent 注册表与出站派遣。
 *
 * 边界：
 * - Peer 是公司级配置，按 `company_id` 隔离；模型只能选已登记 Peer，不能传任意 URL；
 * - Agent Card 同步成功才把 Peer 放进可用目录；同步失败保留旧卡，只降级健康状态；
 * - `allowed_skills_json` 非空时，委派必须显式指定其中一个技能，避免远端卡扩大公司授权范围；
 * - 远端任务只落映射、摘要和产物引用，不复制远端历史或附件正文；
 * - 连续 3 次网络/协议失败熔断 60 秒；远端返回 failed/rejected 属于任务结果，不熔断。
 */
import { EC, EabError, SC, ulid } from '@eab/domain'
import { appendAudit, type Db } from '@eab/storage'
import { deleteSecret, resolveSecret, secretConfigured, storeSecret } from './secrets.js'
import {
  a2aCardUrl,
  cancelA2ATask,
  fetchA2AAgentCard,
  getA2ATask,
  normalizeA2AEndpoint,
  sendA2AMessage,
  summarizeA2ATask,
  type A2AAgentCard,
  type A2ACardSkill,
  type A2ASendResult,
  type A2ATask,
  type A2ATaskState,
  type A2ATarget,
} from './a2a-client.js'

export type A2AHealth = 'healthy' | 'degraded' | 'offline' | 'unknown'
export type A2AAuthType = 'none' | 'bearer'

export interface A2AActor {
  readonly subject: {
    readonly companyId: string
    readonly userId: string
    readonly scopes: ReadonlySet<string>
    readonly roles?: readonly string[]
  }
}

export interface A2APeerConfig {
  readonly id: string
  readonly companyId: string
  readonly name: string
  readonly endpoint: string
  readonly cardUrl: string
  readonly authType: A2AAuthType
  readonly secretRef: string
  readonly allowedSkills: readonly string[]
  readonly card: Record<string, unknown>
  readonly skills: readonly A2ACardSkill[]
  readonly enabled: boolean
  readonly health: A2AHealth
  readonly lastSyncAt: number | null
  readonly lastError: string
  readonly failureCount: number
  readonly cooldownUntil: number | null
  readonly createdBy: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface A2APeerView extends A2APeerConfig {
  readonly secretConfigured: boolean
  readonly cooldownActive: boolean
  readonly effectiveSkills: readonly string[]
}

export interface A2APeerInput {
  name?: unknown
  endpoint?: unknown
  cardUrl?: unknown
  authType?: unknown
  secret?: unknown
  secretRef?: unknown
  clearSecret?: unknown
  allowedSkills?: unknown
  enabled?: unknown
}

export interface A2ASyncOutcome {
  readonly ok: boolean
  readonly skillCount: number
  readonly error: string
}

export interface A2AArtifactRef {
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly size: number
  readonly checksum: string
  readonly source: 'a2a'
  readonly uri: string
  readonly preview?: string
}

export interface A2ADelegationResult {
  readonly delegationId: string
  readonly peerId: string
  readonly peerName: string
  readonly status: A2ATaskState
  readonly remoteTaskId: string
  readonly contextId: string
  readonly traceId: string
  readonly text: string
  readonly artifacts: readonly A2AArtifactRef[]
  readonly error?: string
  readonly hint?: string
}

export interface A2ATaskRecord {
  readonly id: string
  readonly companyId: string
  readonly userId: string
  readonly peerId: string
  readonly peerName: string
  readonly remoteTaskId: string
  readonly remoteContextId: string
  readonly contextId: string
  readonly traceId: string
  readonly skillId: string
  readonly state: A2ATaskState
  readonly resultText: string
  readonly error: string
  readonly artifacts: readonly A2AArtifactRef[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly finishedAt: number | null
}

interface A2APeerRow {
  id: string
  company_id: string
  name: string
  endpoint: string
  card_url: string
  auth_type: string
  secret_ref: string
  allowed_skills_json: string
  card_json: string
  card_skills_json: string
  enabled: number
  health: string
  last_sync_at: number | null
  last_error: string
  failure_count: number
  cooldown_until: number | null
  created_by: string
  created_at: number
  updated_at: number
}

interface A2ATaskRow {
  id: string
  company_id: string
  user_id: string
  peer_id: string
  peer_name: string
  remote_task_id: string
  remote_context_id: string
  context_id: string
  trace_id: string
  skill_id: string
  state: string
  prompt: string
  result_text: string
  error: string
  artifacts_json: string
  created_at: number
  updated_at: number
  finished_at: number | null
}

const HEALTH_VALUES = new Set<A2AHealth>(['healthy', 'degraded', 'offline', 'unknown'])
const AUTH_VALUES = new Set<A2AAuthType>(['none', 'bearer'])
const TERMINAL_STATES = new Set<A2ATaskState>(['completed', 'canceled', 'failed', 'rejected'])
const WAITING_STATES = new Set<A2ATaskState>(['input-required', 'auth-required'])
const FAILURE_LIMIT = 3
const COOLDOWN_MS = 60_000
const MAX_PROMPT_CHARS = 4_000
const MAX_RESULT_TEXT = 8_000

/** 迁移未跑完或嵌入式测试只建部分表时，A2A 目录按空处理。 */
function missingA2ATable(error: unknown): boolean {
  return /no such table: a2a_(peers|tasks)/i.test(error instanceof Error ? error.message : String(error))
}

function jsonValue(value: string | null | undefined, fallback: unknown): unknown {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function textOf(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))]
}

function healthOf(value: string): A2AHealth {
  return HEALTH_VALUES.has(value as A2AHealth) ? value as A2AHealth : 'unknown'
}

function authOf(value: string): A2AAuthType {
  return AUTH_VALUES.has(value as A2AAuthType) ? value as A2AAuthType : 'none'
}

function skillList(value: string | null): A2ACardSkill[] {
  const parsed = jsonValue(value, [])
  if (!Array.isArray(parsed)) return []
  return parsed
    .map((item): A2ACardSkill | null => {
      const skill = recordOf(item)
      if (!skill) return null
      const id = textOf(skill.id).trim()
      if (!id) return null
      return {
        id,
        name: textOf(skill.name) || id,
        description: textOf(skill.description),
        tags: stringList(skill.tags),
        examples: stringList(skill.examples),
        inputModes: stringList(skill.inputModes),
        outputModes: stringList(skill.outputModes),
      }
    })
    .filter((skill): skill is A2ACardSkill => skill !== null)
}

function artifactList(value: string | null): A2AArtifactRef[] {
  const parsed = jsonValue(value, [])
  if (!Array.isArray(parsed)) return []
  return parsed
    .map((item): A2AArtifactRef | null => {
      const artifact = recordOf(item)
      if (!artifact) return null
      const id = textOf(artifact.id).trim()
      const uri = textOf(artifact.uri).trim()
      if (!id || !uri) return null
      return {
        id,
        name: textOf(artifact.name) || id,
        mimeType: textOf(artifact.mimeType),
        size: Number.isFinite(Number(artifact.size)) ? Math.max(0, Math.floor(Number(artifact.size))) : 0,
        checksum: textOf(artifact.checksum),
        source: 'a2a',
        uri,
        preview: textOf(artifact.preview) || undefined,
      }
    })
    .filter((artifact): artifact is A2AArtifactRef => artifact !== null)
}

function peerFromRow(row: A2APeerRow): A2APeerConfig {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    endpoint: row.endpoint,
    cardUrl: row.card_url,
    authType: authOf(row.auth_type),
    secretRef: row.secret_ref,
    allowedSkills: stringList(jsonValue(row.allowed_skills_json, [])),
    card: recordOf(jsonValue(row.card_json, {})) ?? {},
    skills: skillList(row.card_skills_json),
    enabled: Number(row.enabled) !== 0,
    health: healthOf(row.health),
    lastSyncAt: row.last_sync_at === null ? null : Number(row.last_sync_at),
    lastError: row.last_error,
    failureCount: Number(row.failure_count ?? 0),
    cooldownUntil: row.cooldown_until === null ? null : Number(row.cooldown_until),
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function taskFromRow(row: A2ATaskRow): A2ATaskRecord {
  return {
    id: row.id,
    companyId: row.company_id,
    userId: row.user_id,
    peerId: row.peer_id,
    peerName: row.peer_name,
    remoteTaskId: row.remote_task_id,
    remoteContextId: row.remote_context_id,
    contextId: row.context_id,
    traceId: row.trace_id,
    skillId: row.skill_id,
    state: row.state as A2ATaskState,
    resultText: row.result_text,
    error: row.error,
    artifacts: artifactList(row.artifacts_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
  }
}

export function listA2APeers(db: Db, companyId: string): A2APeerConfig[] {
  try {
    const rows = db
      .prepare('SELECT * FROM a2a_peers WHERE company_id = ? ORDER BY updated_at DESC, name ASC')
      .all(companyId) as unknown as A2APeerRow[]
    return rows.map(peerFromRow)
  } catch (error) {
    if (missingA2ATable(error)) return []
    throw error
  }
}

export function getA2APeer(db: Db, companyId: string, id: string): A2APeerConfig | null {
  try {
    const row = db
      .prepare('SELECT * FROM a2a_peers WHERE company_id = ? AND id = ?')
      .get(companyId, id) as unknown as A2APeerRow | undefined
    return row ? peerFromRow(row) : null
  } catch (error) {
    if (missingA2ATable(error)) return null
    throw error
  }
}

export function listA2APeerViews(db: Db, dbPath: string, companyId: string): A2APeerView[] {
  const now = Date.now()
  return listA2APeers(db, companyId).map((peer) => ({
    ...peer,
    secretConfigured: secretConfigured(dbPath, peer.secretRef),
    cooldownActive: peer.cooldownUntil !== null && peer.cooldownUntil > now,
    effectiveSkills: effectiveSkills(peer).map((skill) => `${skill.name}（${skill.id}）`),
  }))
}

export function getA2APeerView(db: Db, dbPath: string, companyId: string, id: string): A2APeerView {
  const peer = getA2APeer(db, companyId, id)
  if (!peer) throw new EabError(EC.NOT_FOUND, `A2A Agent 不存在：${id}`)
  const now = Date.now()
  return {
    ...peer,
    secretConfigured: secretConfigured(dbPath, peer.secretRef),
    cooldownActive: peer.cooldownUntil !== null && peer.cooldownUntil > now,
    effectiveSkills: effectiveSkills(peer).map((skill) => `${skill.name}（${skill.id}）`),
  }
}

function effectiveSkills(peer: A2APeerConfig): A2ACardSkill[] {
  const allowed = peer.allowedSkills.map((item) => item.toLowerCase())
  if (allowed.length === 0) return [...peer.skills]
  return peer.skills.filter((skill) => allowed.includes(skill.id.toLowerCase()) || allowed.includes(skill.name.toLowerCase()))
}

function peerUsable(peer: A2APeerConfig, now = Date.now()): boolean {
  return peer.enabled
    && peer.health === 'healthy'
    && !(peer.cooldownUntil !== null && peer.cooldownUntil > now)
    && effectiveSkills(peer).length > 0
}

function validateName(raw: unknown): string {
  const name = textOf(raw).trim()
  if (!name) throw new EabError(EC.VALIDATION, 'A2A Agent 名称不能为空')
  if (name.length > 80) throw new EabError(EC.VALIDATION, 'A2A Agent 名称最多 80 个字符')
  return name
}

function validateEndpoint(raw: unknown, cardUrlRaw?: unknown): { endpoint: string; cardUrl: string } {
  const endpoint = normalizeA2AEndpoint(textOf(raw))
  const rawCardUrl = textOf(cardUrlRaw).trim()
  const cardUrl = rawCardUrl ? a2aCardUrl(endpoint, rawCardUrl) : ''
  return { endpoint, cardUrl }
}

function writePeerCard(db: Db, peer: A2APeerConfig, card: A2AAgentCard, now: number): void {
  const skills = effectiveSkills({ ...peer, skills: card.skills })
  const endpoint = {
    peerId: peer.id,
    endpoint: peer.endpoint,
    cardUrl: peer.cardUrl,
    authType: peer.authType,
    protocolVersion: card.protocolVersion,
    streaming: card.capabilities.streaming,
  }
  db.prepare(`
    INSERT INTO agent_cards
      (id, company_id, agent_key, kind, name, version, description, skills_json,
       tools_json, limits_json, endpoint_json, health, enabled, created_at, updated_at)
    VALUES (?, ?, ?, 'a2a', ?, ?, ?, ?, '[]', '{}', ?, ?, ?, ?, ?)
    ON CONFLICT(company_id, agent_key) DO UPDATE SET
      name = excluded.name,
      version = excluded.version,
      description = excluded.description,
      skills_json = excluded.skills_json,
      endpoint_json = excluded.endpoint_json,
      health = excluded.health,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(
    `a2a:${peer.id}`,
    peer.companyId,
    `a2a:${peer.id}`,
    card.name || peer.name,
    card.version,
    card.description,
    JSON.stringify(skills.map((skill) => skill.name)),
    JSON.stringify(endpoint),
    peer.enabled ? 'healthy' : 'offline',
    peer.enabled ? 1 : 0,
    now,
    now,
  )
}

function setPeerCardEnabled(
  db: Db,
  companyId: string,
  peerId: string,
  enabled: boolean,
  health: A2AHealth,
  now: number,
): void {
  tryUpdatePeerCard(db, companyId, peerId, health, enabled, now)
}

function markFailure(db: Db, peer: A2APeerConfig, message: string, now = Date.now(), degraded = false): A2APeerConfig {
  const count = peer.failureCount + 1
  const cooldownUntil = count >= FAILURE_LIMIT ? now + COOLDOWN_MS : peer.cooldownUntil
  const health = count >= FAILURE_LIMIT || degraded ? 'degraded' : peer.health
  db.prepare(
    'UPDATE a2a_peers SET health = ?, last_error = ?, failure_count = ?, cooldown_until = ?, updated_at = ? WHERE company_id = ? AND id = ?',
  ).run(health, message.slice(0, 500), count, cooldownUntil, now, peer.companyId, peer.id)
  tryUpdatePeerCard(db, peer.companyId, peer.id, health === 'degraded' ? 'degraded' : peer.health, peer.enabled, now)
  return getA2APeer(db, peer.companyId, peer.id) ?? peer
}

function markSuccess(db: Db, peer: A2APeerConfig, now = Date.now()): void {
  db.prepare(
    'UPDATE a2a_peers SET health = ?, last_error = \'\', failure_count = 0, cooldown_until = NULL, updated_at = ? WHERE company_id = ? AND id = ?',
  ).run('healthy', now, peer.companyId, peer.id)
  tryUpdatePeerCard(db, peer.companyId, peer.id, 'healthy', peer.enabled, now)
}

function tryUpdatePeerCard(
  db: Db,
  companyId: string,
  peerId: string,
  health: A2AHealth,
  enabled: boolean,
  now: number,
): void {
  try {
    db.prepare(
      'UPDATE agent_cards SET health = ?, enabled = ?, updated_at = ? WHERE company_id = ? AND agent_key = ?',
    ).run(enabled ? health : 'offline', enabled ? 1 : 0, now, companyId, `a2a:${peerId}`)
  } catch {
    /* agent_cards 是旁路缓存；缺表或旧库不应阻断 Peer 主状态。 */
  }
}

function targetOf(peer: A2APeerConfig, dbPath: string, timeoutMs?: number, signal?: AbortSignal): A2ATarget {
  return {
    endpoint: peer.endpoint,
    cardUrl: peer.cardUrl,
    authType: peer.authType,
    token: resolveSecret(dbPath, peer.secretRef),
    timeoutMs,
    signal,
  }
}

/** 新建公司级 A2A Peer；写操作不自动同步，控制台路由负责随后拉卡。 */
export function createA2APeer(
  db: Db,
  dbPath: string,
  companyId: string,
  createdBy: string,
  input: A2APeerInput,
): A2APeerConfig {
  const name = validateName(input.name)
  const { endpoint, cardUrl } = validateEndpoint(input.endpoint, input.cardUrl)
  const authType = textOf(input.authType, 'none') as A2AAuthType
  if (!AUTH_VALUES.has(authType)) throw new EabError(EC.VALIDATION, 'A2A 鉴权只支持 none / bearer')
  const allowedSkills = stringList(input.allowedSkills)
  const now = Date.now()
  const id = ulid()
  let secretRef = textOf(input.secretRef).trim()
  const secret = textOf(input.secret).trim()
  if (secret) {
    if (authType !== 'bearer') throw new EabError(EC.VALIDATION, '只有 Bearer 鉴权才能配置密钥')
    secretRef = storeSecret(dbPath, secretRef, secret, 'A2A')
  }
  try {
    db.prepare(`
      INSERT INTO a2a_peers
        (id, company_id, name, endpoint, card_url, auth_type, secret_ref,
         allowed_skills_json, card_json, card_skills_json, enabled, health,
         last_sync_at, last_error, failure_count, cooldown_until,
         created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', '[]', ?, 'unknown', NULL, '', 0, NULL, ?, ?, ?)
    `).run(
      id,
      companyId,
      name,
      endpoint,
      cardUrl,
      authType,
      secretRef,
      JSON.stringify(allowedSkills),
      input.enabled === false ? 0 : 1,
      createdBy,
      now,
      now,
    )
  } catch (error) {
    if (secretRef && secret) deleteSecret(dbPath, secretRef)
    if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) {
      throw new EabError(EC.CONFLICT, `A2A Agent 名称已存在：${name}`)
    }
    throw error
  }
  return getA2APeer(db, companyId, id) as A2APeerConfig
}

/** 更新 Peer；换端点会清空旧卡，避免旧技能继续进入目录。 */
export function updateA2APeer(
  db: Db,
  dbPath: string,
  companyId: string,
  id: string,
  input: A2APeerInput,
): A2APeerConfig {
  const peer = getA2APeer(db, companyId, id)
  if (!peer) throw new EabError(EC.NOT_FOUND, `A2A Agent 不存在：${id}`)
  const name = input.name === undefined ? peer.name : validateName(input.name)
  const endpointChanged = input.endpoint !== undefined || input.cardUrl !== undefined
  const { endpoint, cardUrl } = endpointChanged
    ? validateEndpoint(input.endpoint ?? peer.endpoint, input.cardUrl ?? peer.cardUrl)
    : { endpoint: peer.endpoint, cardUrl: peer.cardUrl }
  const authType = input.authType === undefined ? peer.authType : textOf(input.authType) as A2AAuthType
  if (!AUTH_VALUES.has(authType)) throw new EabError(EC.VALIDATION, 'A2A 鉴权只支持 none / bearer')
  const allowedSkills = input.allowedSkills === undefined ? peer.allowedSkills : stringList(input.allowedSkills)
  const enabled = input.enabled === undefined ? peer.enabled : input.enabled !== false
  let secretRef = textOf(input.secretRef).trim() || peer.secretRef
  const secret = textOf(input.secret).trim()
  const clearSecret = input.clearSecret === true
  if (secret && authType !== 'bearer') throw new EabError(EC.VALIDATION, '只有 Bearer 鉴权才能配置密钥')
  if (secret) secretRef = storeSecret(dbPath, secretRef, secret, 'A2A')
  if (clearSecret && secretRef) {
    deleteSecret(dbPath, secretRef)
    secretRef = ''
  }
  if (authType === 'none') {
    if (secretRef) deleteSecret(dbPath, secretRef)
    secretRef = ''
  }
  const now = Date.now()
  try {
    db.prepare(`
      UPDATE a2a_peers SET
        name = ?, endpoint = ?, card_url = ?, auth_type = ?, secret_ref = ?,
        allowed_skills_json = ?, enabled = ?,
        card_json = CASE WHEN ? THEN '{}' ELSE card_json END,
        card_skills_json = CASE WHEN ? THEN '[]' ELSE card_skills_json END,
        health = CASE WHEN ? THEN 'offline' WHEN ? THEN 'unknown' WHEN ? THEN 'unknown' ELSE health END,
        last_error = CASE WHEN ? THEN '' ELSE last_error END,
        failure_count = CASE WHEN ? THEN 0 ELSE failure_count END,
        cooldown_until = CASE WHEN ? THEN NULL ELSE cooldown_until END,
        updated_at = ?
      WHERE company_id = ? AND id = ?
    `).run(
      name,
      endpoint,
      cardUrl,
      authType,
      secretRef,
      JSON.stringify(allowedSkills),
      enabled ? 1 : 0,
      endpointChanged ? 1 : 0,
      endpointChanged ? 1 : 0,
      enabled ? 0 : 1,
      endpointChanged ? 1 : 0,
      !peer.enabled && enabled ? 1 : 0,
      endpointChanged ? 1 : 0,
      endpointChanged ? 1 : 0,
      endpointChanged ? 1 : 0,
      now,
      companyId,
      id,
    )
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) {
      throw new EabError(EC.CONFLICT, `A2A Agent 名称已存在：${name}`)
    }
    throw error
  }
  const updated = getA2APeer(db, companyId, id) as A2APeerConfig
  setPeerCardEnabled(db, companyId, id, enabled, updated.health, now)
  if (endpointChanged) {
    try {
      db.prepare('DELETE FROM agent_cards WHERE company_id = ? AND agent_key = ?').run(companyId, `a2a:${id}`)
    } catch {
      /* 尽力清理，不阻断 Peer 主状态。 */
    }
  }
  return updated
}

export function deleteA2APeer(
  db: Db,
  dbPath: string,
  companyId: string,
  id: string,
): A2APeerConfig {
  const peer = getA2APeer(db, companyId, id)
  if (!peer) throw new EabError(EC.NOT_FOUND, `A2A Agent 不存在：${id}`)
  db.prepare('DELETE FROM a2a_peers WHERE company_id = ? AND id = ?').run(companyId, id)
  try {
    db.prepare('DELETE FROM agent_cards WHERE company_id = ? AND agent_key = ?').run(companyId, `a2a:${id}`)
  } catch {
    /* 尽力清理。 */
  }
  if (peer.secretRef) deleteSecret(dbPath, peer.secretRef)
  return peer
}

/** 拉取 Card 并刷新缓存；失败只降级，不删除旧卡和 Peer。 */
export async function syncA2APeer(
  db: Db,
  dbPath: string,
  companyId: string,
  id: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<A2ASyncOutcome> {
  const peer = getA2APeer(db, companyId, id)
  if (!peer) throw new EabError(EC.NOT_FOUND, `A2A Agent 不存在：${id}`)
  const now = Date.now()
  try {
    const card = await fetchA2AAgentCard(targetOf(peer, dbPath, options.timeoutMs, options.signal))
    const nextPeer = { ...peer, skills: card.skills }
    const skills = effectiveSkills(nextPeer)
    if (skills.length === 0) {
      throw new EabError(EC.VALIDATION, '白名单没有命中 Agent Card 中的任何技能', {
        hint: '放宽 allowedSkills，或确认远端 Card 的技能 id/名称',
      })
    }
    db.exec('BEGIN')
    try {
      db.prepare(`
        UPDATE a2a_peers SET
          card_json = ?, card_skills_json = ?, health = ?, last_sync_at = ?,
          last_error = '', failure_count = 0, cooldown_until = NULL, updated_at = ?
        WHERE company_id = ? AND id = ?
      `).run(
        JSON.stringify(card.raw),
        JSON.stringify(card.skills),
        peer.enabled ? 'healthy' : 'offline',
        now,
        now,
        companyId,
        id,
      )
      writePeerCard(db, { ...nextPeer, enabled: peer.enabled }, card, now)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { ok: true, skillCount: skills.length, error: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'A2A Agent Card 同步失败'
    markFailure(db, peer, message, now, true)
    return { ok: false, skillCount: 0, error: message }
  }
}

/** 模型可见的 Peer 摘要；不含端点、鉴权引用和完整 Card。 */
export function a2aPeerBrief(db: Db, companyId: string, now = Date.now()): string {
  const peers = listA2APeers(db, companyId).filter((peer) => peerUsable(peer, now))
  if (peers.length === 0) return ''
  const lines = peers.slice(0, 8).map((peer) => {
    const skills = effectiveSkills(peer).slice(0, 6).map((skill) => `${skill.name}(${skill.id})`).join('、')
    return `- peer=${peer.id}（${peer.name}｜A2A 远端）：${skills || '未声明技能'}`
  })
  const more = peers.length > 8 ? `\n还有 ${peers.length - 8} 个，可用 tool_search 查找。` : ''
  return [
    '【A2A 远端 Agent｜派遣参考】',
    ...lines,
    `${more}远端 Agent 用 a2a_delegate 派遣，peer 原样填上面的 id；不要用 agent_spawn 创建同名岗位，也不要把远端返回的内部推理复述给用户。`,
  ].join('\n')
}

/** 供工具目录决定是否直接下发 a2a_delegate；缺表时返回空。 */
export function hasUsableA2APeers(db: Db, companyId: string, now = Date.now()): boolean {
  return listA2APeers(db, companyId).some((peer) => peerUsable(peer, now))
}

function resolveSkill(peer: A2APeerConfig, raw: unknown): string {
  const requested = textOf(raw).trim()
  const allowed = effectiveSkills(peer)
  if (peer.allowedSkills.length > 0 && !requested) {
    throw new EabError(EC.VALIDATION, `A2A Agent「${peer.name}」配置了技能白名单，skill 必须指定`, {
      hint: `可选：${allowed.map((skill) => `${skill.name}(${skill.id})`).join('、')}`,
    })
  }
  if (!requested) return ''
  const match = allowed.find((skill) =>
    skill.id.toLowerCase() === requested.toLowerCase()
    || skill.name.toLowerCase() === requested.toLowerCase())
  if (!match) {
    throw new EabError(EC.VALIDATION, `A2A Agent「${peer.name}」没有允许的技能：${requested}`, {
      hint: `可选：${allowed.map((skill) => `${skill.name}(${skill.id})`).join('、')}`,
    })
  }
  return match.id
}

function resolvePeerForActor(db: Db, actor: A2AActor, raw: unknown): A2APeerConfig {
  const key = textOf(raw).trim()
  if (!key) throw new EabError(EC.VALIDATION, 'a2a_delegate 需要 peer')
  if (!actor.subject.scopes.has(SC.AGENT_TOOL_INVOKE)) {
    throw EabError.scopeDenied('当前身份没有调用 A2A Agent 的权限', '需要 AGENT_TOOL_INVOKE 权限')
  }
  const peerId = key.startsWith('a2a:') ? key.slice(4) : key
  const peers = listA2APeers(db, actor.subject.companyId)
  const peer = peers.find((item) => item.id === peerId)
    ?? peers.find((item) => item.name === key)
    ?? peers.find((item) => `a2a:${item.id}` === key)
  if (!peer) throw new EabError(EC.NOT_FOUND, `A2A Agent 不存在或不属于当前公司：${key}`)
  if (!peer.enabled) throw new EabError(EC.FORBIDDEN, `A2A Agent「${peer.name}」已停用`)
  if (peer.health === 'offline') throw new EabError(EC.CONFLICT, `A2A Agent「${peer.name}」当前离线`)
  if (peer.health === 'unknown') {
    throw new EabError(EC.CONFLICT, `A2A Agent「${peer.name}」还没有同步 Agent Card`, {
      hint: '请管理员在控制台同步该 Agent',
    })
  }
  if (peer.cooldownUntil !== null && peer.cooldownUntil > Date.now()) {
    throw new EabError(EC.RATE_LIMITED, `A2A Agent「${peer.name}」刚连续失败，正在熔断冷却`, {
      hint: '约 1 分钟后重试，或让管理员检查远端服务',
    })
  }
  if (effectiveSkills(peer).length === 0) {
    throw new EabError(EC.CONFLICT, `A2A Agent「${peer.name}」没有允许的技能`)
  }
  return peer
}

function taskStateOf(state: A2ATaskState): A2ATaskState {
  return state === 'input-required'
    || state === 'auth-required'
    || state === 'completed'
    || state === 'canceled'
    || state === 'failed'
    || state === 'rejected'
    || state === 'working'
    || state === 'submitted'
    ? state
    : 'unknown'
}

function updateTask(
  db: Db,
  taskId: string,
  patch: {
    state?: A2ATaskState
    remoteTaskId?: string | null
    remoteContextId?: string | null
    contextId?: string | null
    resultText?: string | null
    error?: string | null
    artifacts?: readonly A2AArtifactRef[] | null
    finished?: boolean
  },
  now = Date.now(),
): void {
  const terminal = patch.state ? TERMINAL_STATES.has(patch.state) : false
  db.prepare(`
    UPDATE a2a_tasks SET
      state = COALESCE(?, state),
      remote_task_id = COALESCE(?, remote_task_id),
      remote_context_id = COALESCE(?, remote_context_id),
      context_id = COALESCE(?, context_id),
      result_text = COALESCE(?, result_text),
      error = COALESCE(?, error),
      artifacts_json = COALESCE(?, artifacts_json),
      updated_at = ?,
      finished_at = CASE WHEN ? THEN ? ELSE finished_at END
    WHERE id = ?
  `).run(
    patch.state ?? null,
    patch.remoteTaskId ?? null,
    patch.remoteContextId ?? null,
    patch.contextId ?? null,
    patch.resultText === null || patch.resultText === undefined ? null : patch.resultText.slice(0, MAX_RESULT_TEXT),
    patch.error === null || patch.error === undefined ? null : patch.error.slice(0, 500),
    patch.artifacts ? JSON.stringify(patch.artifacts) : null,
    now,
    patch.finished || terminal ? 1 : 0,
    now,
    taskId,
  )
}

function delegationResult(
  db: Db,
  taskId: string,
  status: A2ATaskState,
  text: string,
  artifacts: readonly A2AArtifactRef[],
  error?: string,
  hint?: string,
): A2ADelegationResult {
  const row = db.prepare('SELECT * FROM a2a_tasks WHERE id = ?').get(taskId) as unknown as A2ATaskRow
  const task = taskFromRow(row)
  return {
    delegationId: task.id,
    peerId: task.peerId,
    peerName: task.peerName,
    status,
    remoteTaskId: task.remoteTaskId,
    contextId: task.contextId,
    traceId: task.traceId,
    text,
    artifacts,
    error: error || task.error || undefined,
    hint,
  }
}

async function waitForTask(input: {
  target: A2ATarget
  initial: A2ATask
  deadline: number
  signal?: AbortSignal
  onUpdate: (task: A2ATask) => void
  pollIntervalMs?: number
}): Promise<A2ATask> {
  let task = input.initial
  const interval = Math.max(100, input.pollIntervalMs ?? 1_500)
  while (!TERMINAL_STATES.has(task.status.state) && !WAITING_STATES.has(task.status.state)) {
    if (Date.now() >= input.deadline) return task
    if (input.signal?.aborted) throw new EabError(EC.CONFLICT, 'A2A 委派已取消')
    const remaining = input.deadline - Date.now()
    const target = { ...input.target, timeoutMs: Math.min(input.target.timeoutMs ?? remaining, remaining) }
    task = await getA2ATask(target, task.id)
    input.onUpdate(task)
    if (TERMINAL_STATES.has(task.status.state) || WAITING_STATES.has(task.status.state)) break
    if (Date.now() + interval >= input.deadline) return task
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        input.signal?.removeEventListener('abort', onAbort)
        resolve()
      }, interval)
      const onAbort = (): void => {
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', onAbort)
        reject(new EabError(EC.CONFLICT, 'A2A 委派已取消'))
      }
      input.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
  return task
}

/** 从主 Agent 派遣远端任务；同步等待到终态或超时。 */
export async function delegateA2ATask(input: {
  db: Db
  dbPath: string
  actor: A2AActor
  peer: unknown
  prompt: unknown
  skill?: unknown
  contextId?: unknown
  traceId?: unknown
  timeoutMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
}): Promise<A2ADelegationResult> {
  const peer = resolvePeerForActor(input.db, input.actor, input.peer)
  const prompt = textOf(input.prompt).trim()
  if (!prompt) throw new EabError(EC.VALIDATION, 'A2A 委派内容不能为空')
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new EabError(EC.VALIDATION, `A2A 委派内容最多 ${MAX_PROMPT_CHARS} 个字符`)
  }
  const skillId = resolveSkill(peer, input.skill)
  const timeoutMs = Math.min(300_000, Math.max(5_000, Math.floor(Number(input.timeoutMs) || 120_000)))
  const traceId = textOf(input.traceId).trim()
  const requestContextId = textOf(input.contextId).trim()
  const localContextId = requestContextId || `a2a-${ulid()}`
  const taskId = ulid()
  const now = Date.now()
  input.db.prepare(`
    INSERT INTO a2a_tasks
      (id, company_id, user_id, peer_id, peer_name, remote_task_id, remote_context_id,
       context_id, trace_id, skill_id, state, prompt, result_text, error, artifacts_json,
       created_at, updated_at, finished_at)
    VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?, 'submitted', ?, '', '', '[]', ?, ?, NULL)
  `).run(
    taskId,
    input.actor.subject.companyId,
    input.actor.subject.userId,
    peer.id,
    peer.name,
    localContextId,
    traceId,
    skillId,
    prompt,
    now,
    now,
  )
  appendAudit(input.db, {
    companyId: input.actor.subject.companyId,
    actorUserId: input.actor.subject.userId,
    action: 'a2a.delegate',
    resourceType: 'a2a_peer',
    resourceId: peer.id,
    result: 'success',
    detail: { delegationId: taskId, traceId, skillId },
    channel: 'chat',
  })
  const deadline = now + timeoutMs
  const target = targetOf(peer, input.dbPath, timeoutMs, input.signal)
  try {
    const sent: A2ASendResult = await sendA2AMessage({
      target,
      text: prompt,
      contextId: requestContextId || undefined,
      skillId: skillId || undefined,
      metadata: { eabTraceId: traceId, eabDelegationId: taskId },
    })
    if (sent.kind === 'message') {
      const message = sent.message
      const text = (message?.parts ?? [])
        .filter((part) => part.kind === 'text')
        .map((part) => (part.kind === 'text' ? part.text : ''))
        .join('\n')
        .trim()
        .slice(0, MAX_RESULT_TEXT)
      updateTask(input.db, taskId, {
        state: 'completed',
        contextId: message?.contextId || localContextId,
        resultText: text,
        artifacts: [],
      })
      markSuccess(input.db, peer)
      return delegationResult(input.db, taskId, 'completed', text, [])
    }
    const initial = sent.task as A2ATask
    const updateFromTask = (task: A2ATask): void => {
      const summary = summarizeA2ATask(task)
      updateTask(input.db, taskId, {
        state: taskStateOf(task.status.state),
        remoteTaskId: task.id,
        remoteContextId: task.contextId,
        contextId: task.contextId || localContextId,
        resultText: summary.resultText,
        artifacts: summary.artifacts,
        finished: TERMINAL_STATES.has(task.status.state),
      })
    }
    updateFromTask(initial)
    const task = await waitForTask({
      target,
      initial,
      deadline,
      signal: input.signal,
      pollIntervalMs: input.pollIntervalMs,
      onUpdate: updateFromTask,
    })
    const summary = summarizeA2ATask(task)
    const status = taskStateOf(task.status.state)
    updateTask(input.db, taskId, {
      state: status,
      resultText: summary.resultText,
      artifacts: summary.artifacts,
      error: status === 'failed' || status === 'rejected'
        ? (summary.statusText || '远端任务失败').slice(0, 500)
        : '',
      finished: TERMINAL_STATES.has(status),
    })
    if (TERMINAL_STATES.has(status)) markSuccess(input.db, peer)
    const hint = status === 'input-required'
      ? '远端 Agent 还在等输入；把问题交给用户，待用户补充后再用同一 contextId 委派。'
      : status === 'auth-required'
        ? '远端 Agent 需要额外授权；让用户或管理员完成授权后再继续。'
        : status === 'working' || status === 'submitted'
          ? '远端任务还在执行，可用 a2a_cancel 取消，或稍后重新委托并沿用同一 contextId。'
          : undefined
    return delegationResult(input.db, taskId, status, summary.resultText, summary.artifacts, undefined, hint)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'A2A 委派失败'
    updateTask(input.db, taskId, {
      state: input.signal?.aborted ? 'canceled' : 'failed',
      error: message,
      finished: true,
    })
    markFailure(input.db, peer, message)
    throw error instanceof EabError
      ? error
      : new EabError(EC.UPSTREAM, message, { hint: '远端 Agent 调用失败，已记录健康状态' })
  }
}

/** 按本地 delegationId 取消远端任务；已终态时直接返回记录。 */
export async function cancelA2ADelegation(input: {
  db: Db
  dbPath: string
  actor: A2AActor
  delegationId: unknown
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<A2ADelegationResult> {
  const id = textOf(input.delegationId).trim()
  if (!id) throw new EabError(EC.VALIDATION, 'a2a_cancel 需要 delegationId')
  const row = input.db
    .prepare('SELECT * FROM a2a_tasks WHERE id = ? AND company_id = ?')
    .get(id, input.actor.subject.companyId) as unknown as A2ATaskRow | undefined
  if (!row) throw new EabError(EC.NOT_FOUND, `A2A 任务不存在：${id}`)
  const task = taskFromRow(row)
  if (TERMINAL_STATES.has(task.state) || !task.remoteTaskId) {
    return delegationResult(input.db, id, task.state, task.resultText, task.artifacts, task.error || undefined)
  }
  const peer = getA2APeer(input.db, input.actor.subject.companyId, task.peerId)
  if (!peer) throw new EabError(EC.NOT_FOUND, 'A2A Agent 已被删除，无法取消远端任务')
  try {
    const canceled = await cancelA2ATask(
      targetOf(peer, input.dbPath, input.timeoutMs, input.signal),
      task.remoteTaskId,
    )
    const summary = summarizeA2ATask(canceled)
    const status = taskStateOf(canceled.status.state)
    updateTask(input.db, id, {
      state: status,
      resultText: summary.resultText,
      artifacts: summary.artifacts,
      finished: TERMINAL_STATES.has(status),
    })
    markSuccess(input.db, peer)
    return delegationResult(input.db, id, status, summary.resultText, summary.artifacts)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'A2A 取消失败'
    markFailure(input.db, peer, message)
    throw error
  }
}

/** 控制台和排查用：只读最近的本地映射。 */
export function listA2ATasks(db: Db, companyId: string, limit = 20): A2ATaskRecord[] {
  try {
    const rows = db
      .prepare('SELECT * FROM a2a_tasks WHERE company_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(companyId, Math.max(1, Math.min(100, limit))) as unknown as A2ATaskRow[]
    return rows.map(taskFromRow)
  } catch (error) {
    if (missingA2ATable(error)) return []
    throw error
  }
}
