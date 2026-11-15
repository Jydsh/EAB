-- 0060_agent_team.sql
-- 目的：把「经理 + 团队」的子 Agent 登记表从进程内存搬到库，支持跨轮次、
-- 跨进程重启继续派活，并为后台任务与父 Agent 事件等待提供权威状态。
--
-- 设计边界：
-- 1. `agent_workers` 只保存身份、状态和最近一次摘要；真正的运行轨迹仍在
--    `agent_runs` / `agent_steps`，避免同一份数据两处维护。
-- 2. `agent_team_messages` 保存同一 key 的多轮对话文本，工具调用细节不落库；
--    读取时只取最近 20 条 / 约 16k 字符，和原内存实现保持一致。
-- 3. `agent_tasks` 是后台任务的状态机：queued | running | succeeded | failed |
--    cancelled。task_id 同时作为工具幂等键，避免重启后重复写文件/发消息。
-- 4. `agent_events` 是父 Agent 的事件收件箱：question / done / progress / error
--    先落库再唤醒等待者；consumed_at 为空表示父 Agent 还未取走。
CREATE TABLE IF NOT EXISTS agent_workers (
  id             TEXT PRIMARY KEY,
  team_id        TEXT NOT NULL,
  company_id     TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  key            TEXT NOT NULL,
  name           TEXT NOT NULL,
  idx            INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('running', 'idle', 'waiting')),
  run_id         TEXT NOT NULL DEFAULT '',
  model_id       TEXT NOT NULL DEFAULT '',
  model_name     TEXT NOT NULL DEFAULT '',
  last_task_at   INTEGER NOT NULL,
  last_text      TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (team_id, key)
);

CREATE INDEX IF NOT EXISTS idx_agent_workers_team
  ON agent_workers (team_id, idx);
CREATE INDEX IF NOT EXISTS idx_agent_workers_company
  ON agent_workers (company_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_team_messages (
  id             TEXT PRIMARY KEY,
  team_id        TEXT NOT NULL,
  worker_key     TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content        TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_team_messages_worker
  ON agent_team_messages (team_id, worker_key, created_at);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id             TEXT PRIMARY KEY,
  team_id        TEXT NOT NULL,
  company_id     TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  worker_key     TEXT NOT NULL,
  parent_run_id  TEXT,
  child_run_id   TEXT,
  status         TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  prompt         TEXT NOT NULL,
  result_text    TEXT,
  error          TEXT,
  model_id       TEXT,
  started_at     INTEGER,
  finished_at    INTEGER,
  /** 父 Agent 是否已经因为这条任务被唤醒；null 表示还没唤醒 */
  wake_at        INTEGER,
  wake_state     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_team_status
  ON agent_tasks (team_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_worker
  ON agent_tasks (team_id, worker_key, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_events (
  id             TEXT PRIMARY KEY,
  team_id        TEXT NOT NULL,
  company_id     TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  worker_key     TEXT NOT NULL,
  task_id        TEXT,
  kind           TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  consumed_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_events_team
  ON agent_events (team_id, consumed_at, created_at);
