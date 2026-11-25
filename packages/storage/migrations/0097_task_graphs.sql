-- 0097_task_graphs.sql
-- AGT-16 任务图 v1：可版本化的线性 / 分支 / 人工 / 等待 / 工具 / 子 Agent 节点。
--
-- 边界：
-- 1. 定义与版本分离：草稿可反复保存，发布后冻结 definition_json；运行只读发布版本。
-- 2. 一次运行对应一个 trace_id，步骤 append-only；人工与等待都通过持久状态恢复。
-- 3. 不复用 approval_workflows：审批流只服务权限申请，任务图需要工具 / 子 Agent / 等待节点。
CREATE TABLE IF NOT EXISTS task_graphs (
  id                   TEXT PRIMARY KEY,
  company_id           TEXT NOT NULL,
  name                 TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'draft', -- draft | published | disabled
  current_version      INTEGER NOT NULL DEFAULT 0,
  draft_version_id     TEXT,
  published_version_id TEXT,
  created_by           TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_task_graphs_company
  ON task_graphs (company_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_graph_versions (
  id              TEXT PRIMARY KEY,
  graph_id        TEXT NOT NULL REFERENCES task_graphs(id),
  company_id      TEXT NOT NULL,
  version         INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft', -- draft | published | superseded
  definition_json TEXT NOT NULL,
  validation_json TEXT,
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  published_at    INTEGER,
  UNIQUE (graph_id, version)
);

CREATE INDEX IF NOT EXISTS idx_task_graph_versions_graph
  ON task_graph_versions (graph_id, version DESC);

CREATE TABLE IF NOT EXISTS task_graph_runs (
  id               TEXT PRIMARY KEY,
  trace_id         TEXT NOT NULL UNIQUE,
  company_id       TEXT NOT NULL,
  graph_id         TEXT NOT NULL REFERENCES task_graphs(id),
  graph_version    INTEGER NOT NULL,
  version_id       TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  status           TEXT NOT NULL, -- running | waiting_manual | waiting_wait | succeeded | failed | rejected | cancelled
  input_json       TEXT NOT NULL,
  variables_json   TEXT NOT NULL DEFAULT '{}',
  current_node_id  TEXT,
  waiting_json     TEXT,
  error            TEXT,
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_graph_runs_graph
  ON task_graph_runs (company_id, graph_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_graph_runs_status
  ON task_graph_runs (company_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_task_graph_runs_trace
  ON task_graph_runs (company_id, trace_id);

CREATE TABLE IF NOT EXISTS task_graph_steps (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES task_graph_runs(id),
  seq            INTEGER NOT NULL,
  node_id        TEXT NOT NULL,
  node_kind      TEXT NOT NULL,
  title          TEXT NOT NULL,
  status         TEXT NOT NULL, -- running | succeeded | waiting | failed | skipped | rejected
  input_json     TEXT,
  output_json    TEXT,
  error          TEXT,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_task_graph_steps_run
  ON task_graph_steps (run_id, seq);
