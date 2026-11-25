-- 0095_agent_run_formation.sql
-- 目的：记录主 Agent 为什么强制编队、为什么没有强制编队，以及实际派出了几个子 Agent。
--
-- 边界：
-- 1. formation_json 只挂在根 run（depth=0）；子 Agent run 不重复记录。
-- 2. 判定理由在模型第一次调用前写入，后续只补实际派发人数，不覆盖原因。
-- 3. 历史 run 没有该字段时为 NULL，控制台按“未记录”处理。
ALTER TABLE agent_runs ADD COLUMN formation_json TEXT;
