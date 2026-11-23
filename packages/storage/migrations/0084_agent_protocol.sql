-- 0084_agent_protocol.sql
-- 目的：给 Agent 团队补上协议中立的内部契约：上下文、追踪、暂停原因、任务产物和预算。
--
-- 设计边界：
-- 1. 不修改 `agent_tasks.status` 的 CHECK 约束。新增的 `phase` 与 status 正交，
--    `input_required / auth_required / rejected` 先放这里，避免重建 SQLite 表牵动旧查询。
-- 2. `artifacts_json` 只存引用元数据，文件本身仍在工作区/云空间，不复制第二份。
-- 3. `agent_artifacts` 表预留给后续按任务查询和跨协议产物；PR1 先写入任务 JSON。
-- 4. `agent_cards` 只存公司覆盖和远端 A2A 卡，内置岗位卡由代码常量提供。

ALTER TABLE agent_tasks ADD COLUMN context_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_tasks ADD COLUMN trace_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_tasks ADD COLUMN phase TEXT NOT NULL DEFAULT 'none';
ALTER TABLE agent_tasks ADD COLUMN reject_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_tasks ADD COLUMN input_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_tasks ADD COLUMN artifacts_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_tasks ADD COLUMN budget_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_tasks ADD COLUMN deadline_at INTEGER;
ALTER TABLE agent_tasks ADD COLUMN used_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN used_cost_micros INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_events ADD COLUMN context_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_events ADD COLUMN trace_id TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS agent_cards (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL,
  agent_key      TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('builtin', 'runtime', 'a2a')),
  name           TEXT NOT NULL,
  version        TEXT NOT NULL DEFAULT '1',
  description    TEXT NOT NULL DEFAULT '',
  skills_json    TEXT NOT NULL DEFAULT '[]',
  tools_json     TEXT NOT NULL DEFAULT '[]',
  limits_json    TEXT NOT NULL DEFAULT '{}',
  endpoint_json  TEXT NOT NULL DEFAULT '{}',
  health         TEXT NOT NULL DEFAULT 'healthy' CHECK (health IN ('healthy', 'degraded', 'offline', 'unknown')),
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (company_id, agent_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_cards_company
  ON agent_cards (company_id, enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_artifacts (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  team_id        TEXT NOT NULL,
  task_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  mime_type      TEXT NOT NULL DEFAULT '',
  size           INTEGER NOT NULL DEFAULT 0,
  checksum       TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL CHECK (source IN ('workspace', 'cloud', 'inline', 'mcp', 'a2a')),
  uri            TEXT NOT NULL DEFAULT '',
  preview        TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_artifacts_task
  ON agent_artifacts (team_id, task_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_trace
  ON agent_tasks (team_id, trace_id, created_at);
