-- 定时任务事件日志（DSH 对齐的第一步）。
--
-- 定位：提醒的真相是「会话里的一条事件流」，`user_schedules` 与 `schedule_runs`
-- 只是这条事件流的可重建投影。先只把 schedule 域的事件落成 append-only 表，
-- 后续 Trajectory / 任务中心可以直接复用同一套事件读取方式。
CREATE TABLE IF NOT EXISTS schedule_events (
  id           TEXT PRIMARY KEY,
  schedule_id  TEXT NOT NULL,
  company_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  type         TEXT NOT NULL,   -- create | delete | pause | resume | fire | complete | error | delivery | recover
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedule_events_schedule
  ON schedule_events (schedule_id, created_at);
CREATE INDEX IF NOT EXISTS idx_schedule_events_owner
  ON schedule_events (company_id, user_id, created_at DESC);
