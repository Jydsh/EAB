-- 0050_agent_run_suspend.sql
-- 目的：让一次对话回合可以「挂起等后台工具结果」，为对话内慢工具后台化做地基。
--
-- 设计边界：
-- 1. 只加列，不改现有状态机：status 新增取值 suspended，旧代码只认 running 的
--    sweep 不受影响（挂起 run 有心跳之外的生命周期，由 sweepSuspendedRuns 单独收尾）；
-- 2. resume_state_json 存恢复所需的循环状态（消息游标、已发生的工具调用、预算余量），
--    不放会话正文之外的敏感内容；真正的会话正文仍只存在消息表；
-- 3. pending_job_id 指向 async_jobs 里的后台工具作业，作业失败/丢失时 run 会被判定失败；
-- 4. 默认不启用：EAB_TOOL_BACKGROUND_MS 未设置时对话仍走同步工具执行，行为与升级前一致。
ALTER TABLE agent_runs ADD COLUMN pending_job_id TEXT;
ALTER TABLE agent_runs ADD COLUMN resume_state_json TEXT;
ALTER TABLE agent_runs ADD COLUMN updated_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_agent_runs_suspended
  ON agent_runs (company_id, status, started_at);
