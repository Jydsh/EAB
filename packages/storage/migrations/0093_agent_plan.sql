-- 0093_agent_plan.sql
-- 目的：把“复杂任务先计划、再执行”从提示词里的一句话，变成可查询、可版本化的一等对象。
--
-- 设计边界：
-- 1. 一个 plan_key 表示同一份计划的演化；每次重写生成一条新 version，旧版本和旧步骤不删。
-- 2. 一份计划最多 7 步，由写入服务强制；seq 从 1 开始。
-- 3. 步骤状态是 pending | running | done | failed | skipped；计划状态由步骤推导。
-- 4. 计划按 company + user + session 归属，员工端只能读自己会话的最新计划。
CREATE TABLE IF NOT EXISTS agent_plans (
  id            TEXT PRIMARY KEY,
  plan_key      TEXT NOT NULL,
  company_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  session_id    TEXT,
  trace_id      TEXT,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  version       INTEGER NOT NULL,
  supersedes_id TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (company_id, plan_key, version)
);

CREATE INDEX IF NOT EXISTS idx_agent_plans_session
  ON agent_plans (company_id, user_id, session_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_plans_key
  ON agent_plans (company_id, plan_key, version DESC);

CREATE TABLE IF NOT EXISTS agent_plan_steps (
  id           TEXT PRIMARY KEY,
  plan_id      TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  title        TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  owner        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  note         TEXT NOT NULL DEFAULT '',
  run_id       TEXT,
  updated_at   INTEGER NOT NULL,
  UNIQUE (plan_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_agent_plan_steps_plan
  ON agent_plan_steps (plan_id, seq);
