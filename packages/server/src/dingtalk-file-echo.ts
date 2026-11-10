/**
 * 机器人以用户身份发文件时的回声标记。
 *
 * 背景：钉钉 `convFile/conversations/files/send` 必须用操作人 unionId，文件会以
 * 用户方向出现在机器人私聊里。机器人随后会收到同一条 file 入站消息；不拦截就会
 * 被当成用户上传，重复保存到个人云空间。这里用一条短生命周期的 pending 记录做
 * 一次性匹配：同公司、同用户、同会话、同文件名，10 分钟内只消费一次。
 */
import { randomUUID } from 'node:crypto'
import type { Db } from '@eab/storage'

const MATCH_WINDOW_MS = 10 * 60_000
const PENDING_TTL_MS = 60 * 60_000
const KEEP_MS = 24 * 60 * 60_000

export interface RobotUserFileSendInput {
  readonly companyId: string
  readonly userId: string
  readonly conversationId: string
  readonly fileName: string
  readonly sizeBytes: number
}

export interface RobotUserFileSendMatch {
  readonly id: string
  readonly fileName: string
  readonly sizeBytes: number
}

export function createRobotUserFileSend(db: Db, input: RobotUserFileSendInput): string {
  const now = Date.now()
  pruneRobotUserFileSends(db, now)
  const id = `rufs_${randomUUID()}`
  db.prepare(
    `INSERT INTO robot_user_file_sends
       (id, company_id, user_id, conversation_id, file_name, size_bytes, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(id, input.companyId, input.userId, input.conversationId, input.fileName, input.sizeBytes, now, now)
  return id
}

export function markRobotUserFileSendSent(
  db: Db,
  id: string,
  params: { fileId?: string; spaceId?: string; fileName?: string },
): void {
  const now = Date.now()
  db.prepare(
    `UPDATE robot_user_file_sends
        SET status = 'sent',
            file_id = COALESCE(?, file_id),
            space_id = COALESCE(?, space_id),
            file_name = COALESCE(?, file_name),
            updated_at = ?
      WHERE id = ? AND status = 'pending'`,
  ).run(params.fileId ?? null, params.spaceId ?? null, params.fileName ?? null, now, id)
}

export function markRobotUserFileSendFailed(db: Db, id: string): void {
  const now = Date.now()
  db.prepare(
    `UPDATE robot_user_file_sends
        SET status = 'failed', updated_at = ?
      WHERE id = ? AND status = 'pending'`,
  ).run(now, id)
}

/**
 * 入站文件到达时消费一条 pending/sent 标记。消费成功返回标记，调用方必须跳过
 * 下载和保存；返回 null 表示这是用户自己发的文件，走原有保存流程。
 */
export function consumeRobotUserFileSend(
  db: Db,
  params: {
    companyId: string
    userId: string
    conversationId: string
    fileName: string
    now?: number
  },
): RobotUserFileSendMatch | null {
  const now = params.now ?? Date.now()
  const row = db
    .prepare(
      `SELECT id, file_name, size_bytes
         FROM robot_user_file_sends
        WHERE company_id = ? AND user_id = ? AND conversation_id = ?
          AND file_name = ? AND status IN ('pending', 'sent')
          AND created_at >= ?
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .get(
      params.companyId,
      params.userId,
      params.conversationId,
      params.fileName,
      now - MATCH_WINDOW_MS,
    ) as { id: string; file_name: string; size_bytes: number } | undefined
  if (!row) return null
  const changed = db
    .prepare(
      `UPDATE robot_user_file_sends
          SET status = 'matched', matched_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'sent')`,
    )
    .run(now, now, row.id) as { changes?: number } | undefined
  if (Number(changed?.changes ?? 0) === 0) return null
  return { id: row.id, fileName: row.file_name, sizeBytes: Number(row.size_bytes ?? 0) }
}

function pruneRobotUserFileSends(db: Db, now: number): void {
  try {
    db.prepare(
      `DELETE FROM robot_user_file_sends
        WHERE (status = 'pending' AND created_at < ?)
           OR (status IN ('sent', 'matched', 'failed') AND updated_at < ?)`,
    ).run(now - PENDING_TTL_MS, now - KEEP_MS)
  } catch {
    // 清理失败不影响主流程
  }
}
