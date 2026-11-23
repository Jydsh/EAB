-- 0086_a2a.sql
-- 目的：登记公司级 A2A 远端 Agent，并保存 EAB 侧发起的远端任务映射。
--
-- 设计边界：
-- 1. 远端 Agent 必须由公司显式登记，第一版只支持 HTTP(S) JSON-RPC；
-- 2. `allowed_skills_json` 是公司允许出站的技能白名单，空数组表示不限制；
-- 3. `card_json` 缓存最近一次成功拉取的 Agent Card，同步失败保留旧卡；
-- 4. `a2a_tasks` 只存任务映射、摘要和产物引用，不复制远端正文和文件；
-- 5. 鉴权只存 `secret_ref`，明文在 secrets.json，不落这张表。
CREATE TABLE IF NOT EXISTS a2a_peers (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL,
  name                TEXT NOT NULL,
  endpoint            TEXT NOT NULL,
  card_url            TEXT NOT NULL DEFAULT '',
  auth_type           TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer')),
  secret_ref          TEXT NOT NULL DEFAULT '',
  allowed_skills_json TEXT NOT NULL DEFAULT '[]',
  card_json           TEXT NOT NULL DEFAULT '{}',
  card_skills_json    TEXT NOT NULL DEFAULT '[]',
  enabled             INTEGER NOT NULL DEFAULT 1,
  health              TEXT NOT NULL DEFAULT 'unknown' CHECK (health IN ('healthy', 'degraded', 'offline', 'unknown')),
  last_sync_at        INTEGER,
  last_error          TEXT NOT NULL DEFAULT '',
  failure_count       INTEGER NOT NULL DEFAULT 0,
  cooldown_until      INTEGER,
  created_by          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_a2a_peers_name
  ON a2a_peers (company_id, name);

CREATE INDEX IF NOT EXISTS idx_a2a_peers_company
  ON a2a_peers (company_id, enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS a2a_tasks (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL,
  user_id              TEXT NOT NULL,
  peer_id             TEXT NOT NULL,
  peer_name           TEXT NOT NULL DEFAULT '',
  remote_task_id      TEXT NOT NULL DEFAULT '',
  remote_context_id   TEXT NOT NULL DEFAULT '',
  context_id          TEXT NOT NULL DEFAULT '',
  trace_id            TEXT NOT NULL DEFAULT '',
  skill_id            TEXT NOT NULL DEFAULT '',
  state               TEXT NOT NULL DEFAULT 'submitted'
                      CHECK (state IN ('submitted', 'working', 'input-required',
                                       'auth-required', 'completed', 'canceled',
                                       'failed', 'rejected', 'unknown')),
  prompt              TEXT NOT NULL,
  result_text         TEXT NOT NULL DEFAULT '',
  error               TEXT NOT NULL DEFAULT '',
  artifacts_json      TEXT NOT NULL DEFAULT '[]',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  finished_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_a2a_tasks_company
  ON a2a_tasks (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_a2a_tasks_trace
  ON a2a_tasks (company_id, trace_id, created_at);

CREATE INDEX IF NOT EXISTS idx_a2a_tasks_remote
  ON a2a_tasks (company_id, peer_id, remote_task_id);
