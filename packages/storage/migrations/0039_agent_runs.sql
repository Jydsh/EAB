-- 多 Agent 运行树。
-- 一次用户回合 = 一个根 run；它可以通过 agent.spawn 派生多个子 run。
-- 子 run 有独立 runId / session_id，父子只通过 parent_run_id 关联。
CREATE TABLE IF NOT EXISTS agent_runs (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  parent_run_id  TEXT,
  agent_id       TEXT NOT NULL,
  title          TEXT,
  model_id       TEXT,
  session_id     TEXT,
  status         TEXT NOT NULL DEFAULT 'running', -- running | succeeded | failed | cancelled
  budget         INTEGER,
  spent_tokens   INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_parent
  ON agent_runs (company_id, parent_run_id, started_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_recent
  ON agent_runs (company_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_session
  ON agent_runs (company_id, session_id, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_steps (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  kind            TEXT NOT NULL, -- tool | agent | model
  tool_id         TEXT,
  name            TEXT,
  status          TEXT NOT NULL,
  args_json       TEXT,
  result_summary  TEXT,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_steps_run_seq
  ON agent_steps (run_id, seq);
CREATE INDEX IF NOT EXISTS idx_agent_steps_run
  ON agent_steps (run_id, seq);
