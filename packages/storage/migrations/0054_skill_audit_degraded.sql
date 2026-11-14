-- 0054_skill_audit_degraded.sql
-- S6.6 审计降级台账：skill_events 已写成功、但全局 audit 链双写失败时，
-- 独立记录失败动作和原因，供控制台提示与人工排查；不影响技能主操作。

CREATE TABLE IF NOT EXISTS skill_audit_degraded (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  TEXT,
  skill_id    TEXT NOT NULL,
  event       TEXT NOT NULL,
  actor_id    TEXT,
  message     TEXT NOT NULL,
  at          INTEGER NOT NULL
);
