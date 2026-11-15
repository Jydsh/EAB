import type { Db } from '@eab/storage'
import type { DingTalkClarifyCardStore, DingTalkClarifyState } from './dingtalk-card.js'

/**
 * 钉钉答题卡状态落库。服务重启后旧卡仍带着原 outTrackId 回调，
 * 必须能从数据库恢复题目、当前页和已填草稿，不能只依赖进程内 Map。
 */
export function createDingTalkClarifyCardStore(
  db: Db,
  companyId: string,
): DingTalkClarifyCardStore {
  const loadStatement = db.prepare(
    `SELECT state_json
       FROM dingtalk_clarify_cards
      WHERE out_track_id = ? AND company_id = ?
      LIMIT 1`,
  )
  const saveStatement = db.prepare(
    `INSERT INTO dingtalk_clarify_cards (out_track_id, company_id, session_id, state_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(out_track_id) DO UPDATE SET
       company_id = excluded.company_id,
       session_id = excluded.session_id,
       state_json = excluded.state_json,
       updated_at = excluded.updated_at`,
  )
  const purgeStatement = db.prepare(
    `DELETE FROM dingtalk_clarify_cards
      WHERE company_id = ? AND updated_at < ?`,
  )

  return {
    load(outTrackId: string): DingTalkClarifyState | null {
      const row = loadStatement.get(outTrackId, companyId) as { state_json?: unknown } | undefined
      if (!row || typeof row.state_json !== 'string') return null
      try {
        const parsed = JSON.parse(row.state_json) as DingTalkClarifyState
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    },
    save(outTrackId: string, state: DingTalkClarifyState): void {
      const now = Date.now()
      saveStatement.run(
        outTrackId,
        companyId,
        String(state.sessionId ?? ''),
        JSON.stringify(state),
        now,
      )
      // 答题卡是短生命周期数据，顺手清掉 30 天前的旧记录，避免表无限增长。
      purgeStatement.run(companyId, now - 30 * 24 * 60 * 60 * 1000)
    },
  }
}
