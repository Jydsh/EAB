-- 0025_usage_quotas.sql
-- 目的：按「公司 / 部门 / 成员」三级设置月度对话额度（请求数 + token），供控制台「额度与用量」页配置、对话链路拦截
-- 影响表：新建 usage_quotas
-- 可在线执行：是（只新增表与索引）
--
-- 口径：
-- 1. 一个 scope 一行，scope_id 分别是 company_id / dept_id / user_id；
-- 2. monthly_requests / monthly_tokens 为 NULL 表示该指标不限；
-- 3. mode='hard' 用尽即拒绝对话；mode='soft' 只记录不拦截（留给后续告警用）；
-- 4. 用量不复制到这张表，统一从 usage_daily 按月份聚合，避免两处口径打架。

CREATE TABLE IF NOT EXISTS usage_quotas (
  company_id       TEXT NOT NULL REFERENCES companies(id),
  scope_type       TEXT NOT NULL,
  scope_id         TEXT NOT NULL,
  monthly_requests INTEGER,
  monthly_tokens   INTEGER,
  mode             TEXT NOT NULL DEFAULT 'hard',
  enabled          INTEGER NOT NULL DEFAULT 1,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (company_id, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_usage_quotas_scope ON usage_quotas (company_id, scope_type);
