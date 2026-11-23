-- A2A 入站：公司级受限能力卡、共享令牌和入站任务。
-- 第一版只暴露 eab.answer：外部只能调用公司模型做无工具问答，
-- 不读取工作区、知识库、记忆或内部 Agent 工具；任务只落最终文本和用量。
CREATE TABLE IF NOT EXISTS a2a_inbound (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 0,
  token_ref        TEXT,
  allowed_skills_json TEXT NOT NULL DEFAULT '["eab.answer"]',
  model_id         TEXT,
  public_base_url  TEXT,
  created_by       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_a2a_inbound_company
  ON a2a_inbound (company_id);

CREATE TABLE IF NOT EXISTS a2a_inbound_tasks (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL,
  context_id     TEXT NOT NULL,
  trace_id       TEXT NOT NULL,
  skill_id       TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN (
    'submitted', 'working', 'completed', 'failed', 'canceled', 'rejected'
  )),
  prompt         TEXT NOT NULL,
  result_text    TEXT,
  error          TEXT,
  prompt_tokens  INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  finished_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_a2a_inbound_tasks_recent
  ON a2a_inbound_tasks (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_a2a_inbound_tasks_trace
  ON a2a_inbound_tasks (company_id, trace_id);
CREATE INDEX IF NOT EXISTS idx_a2a_inbound_tasks_context
  ON a2a_inbound_tasks (company_id, context_id, created_at DESC);
