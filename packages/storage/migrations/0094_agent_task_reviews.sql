-- 0094_agent_task_reviews.sql
-- 目的：把独立验收员对工程任务的复核结论落库，供任务状态机、控制台追踪和后续审计共用。
--
-- 边界：
-- 1. 一条 review 对应一次验收尝试；同一 task 可以有多次 reject 后重做，历史不覆盖。
-- 2. verdict 只有 approve / reject / error；error 表示验收员本身不可用或没有提交结论，
--    同样不能把任务标记成功（fail closed）。
-- 3. evidence 保存验收员实际检查过的文件、命令或测试结果摘要，不复制完整日志。
CREATE TABLE IF NOT EXISTS agent_task_reviews (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  team_id            TEXT NOT NULL,
  task_id            TEXT NOT NULL,
  worker_key         TEXT NOT NULL,
  child_run_id       TEXT NOT NULL DEFAULT '',
  reviewer_run_id    TEXT NOT NULL,
  reviewer_model_id  TEXT NOT NULL DEFAULT '',
  verdict            TEXT NOT NULL CHECK (verdict IN ('approve', 'reject', 'error')),
  reason             TEXT NOT NULL,
  evidence_json      TEXT NOT NULL DEFAULT '[]',
  duration_ms        INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_task_reviews_task
  ON agent_task_reviews (company_id, task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_task_reviews_team
  ON agent_task_reviews (team_id, created_at DESC);
