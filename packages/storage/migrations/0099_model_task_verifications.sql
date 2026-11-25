-- 0099_model_task_verifications.sql
-- 状态：功能已于 2026-11-24 下线（数字门禁移除），迁移与历史数据保留，
--       服务端代码不再读写本表；新库仍会建表，仅作为历史归档结构。
--
-- 目的：记录"哪个模型通过了哪类任务的实测"，作为任务级模型白名单。
--
-- 关键约定：
--   * 这里不判断模型"能不能回复"，健康探测只说明端点活着；本表记录的是
--     真实任务样本上的质量结论，供数据类问题等高风险任务限定候选。
--   * 一个模型 + 一类任务只有一条当前结论；重测直接覆盖，历史证据留在 evidence。
--   * 插件模型没有 models 表记录，因此 model_id 不做外键；读取时仍会与当前
--     可见模型目录求交，模型下线或插件卸载后白名单自然失效。
--   * status=passed 且 expires_at 为空或晚于当前时间，才算当前有效。

CREATE TABLE IF NOT EXISTS model_task_verifications (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  model_id    TEXT NOT NULL,
  task_kind   TEXT NOT NULL,
  status      TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  verified_by TEXT NOT NULL DEFAULT '',
  evidence    TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_model_task_verifications_model_task
  ON model_task_verifications (company_id, model_id, task_kind);

CREATE INDEX IF NOT EXISTS idx_model_task_verifications_company_task
  ON model_task_verifications (company_id, task_kind, status, expires_at);
