-- 定时任务：用户自建的「到点执行一段自然语言任务」。
--
-- 设计要点：
-- 1. 任务归属到公司 + 创建人，成员只能看/改自己的任务；
-- 2. `payload_json` 保存规则，调度器只解析规则、不把时间语义交给模型；
-- 3. `schedule_runs` 按 (schedule_id, scheduled_for) 唯一，保证同一时刻最多执行一次；
-- 4. 执行结果落库到 chat_messages，同时按 channel 推回钉钉单聊（默认）。
CREATE TABLE IF NOT EXISTS user_schedules (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  session_id    TEXT,
  title         TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  mode          TEXT NOT NULL,              -- once | daily | weekly | interval
  payload_json  TEXT NOT NULL,              -- { at?, time?, days?, intervalMinutes? }
  timezone      TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  channel       TEXT NOT NULL DEFAULT 'dingtalk', -- dingtalk | web
  status        TEXT NOT NULL DEFAULT 'active',   -- active | paused | running | done | error
  next_run_at   INTEGER NOT NULL,
  last_run_at   INTEGER,
  last_error    TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_schedules_due
  ON user_schedules (status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_user_schedules_owner
  ON user_schedules (company_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS schedule_runs (
  id            TEXT PRIMARY KEY,
  schedule_id   TEXT NOT NULL,
  company_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  scheduled_for INTEGER NOT NULL,
  status        TEXT NOT NULL,              -- running | success | error
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  error         TEXT,
  result_text   TEXT,
  channel       TEXT,
  delivery      TEXT,                       -- sent | failed | skipped
  delivery_error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_schedule_runs_occurrence
  ON schedule_runs (schedule_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_schedule_runs_owner
  ON schedule_runs (company_id, user_id, started_at DESC);

-- 现有公司的内置角色不会跟着 BUILTIN_ROLES 自动更新，这里补权限点。
-- 普通员工也应能创建自己的定时任务；管理岗随着已有 MEMBER_SCOPES 一并获得。
INSERT OR IGNORE INTO role_scopes (role_id, scope)
SELECT r.id, 'schedule:read'
  FROM roles r
 WHERE r.deleted_at IS NULL
   AND r.code IN ('super_admin', 'company_admin', 'company_sub_admin', 'dept_admin', 'kb_admin', 'member');
INSERT OR IGNORE INTO role_scopes (role_id, scope)
SELECT r.id, 'schedule:write'
  FROM roles r
 WHERE r.deleted_at IS NULL
   AND r.code IN ('super_admin', 'company_admin', 'company_sub_admin', 'dept_admin', 'kb_admin', 'member');
