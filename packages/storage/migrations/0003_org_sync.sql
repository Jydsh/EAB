-- 0003_org_sync.sql
-- 目的：为"钉钉 / 飞书 / 企微组织架构同步"补齐表与列
-- 影响表：departments（加 channel / missing_at / missing_runs，重建唯一索引）、users（加 missing_at / missing_runs / recycled_at）、
--         新建 channel_configs / org_sync_runs / org_sync_diffs
-- 可在线执行：是（加列 + 建表 + 重建索引，小库秒级）
--
-- 为什么必须动 departments 的唯一索引：
--   0001 建的是 (company_id, channel_dept_id) 唯一。三家的部门 ID 都是数字（飞书/钉钉都可能出现 "1"），
--   接入第二家后必然撞号。唯一身份必须是 (company_id, channel, channel_dept_id)。
--
-- 为什么不是"上游没了就删"：
--   通讯录权限审批中、应用临时失效时，拉回来就是"全公司只剩三个人"。
--   所以用 missing_at + missing_runs 计数：连续两次全量都缺，才标 disabled / 软删（见 8.6 规则 4）。

ALTER TABLE departments ADD COLUMN channel TEXT;
ALTER TABLE departments ADD COLUMN missing_at INTEGER;
ALTER TABLE departments ADD COLUMN missing_runs INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS uq_departments_channel;
CREATE UNIQUE INDEX IF NOT EXISTS uq_departments_channel_provider
  ON departments (company_id, channel, channel_dept_id)
  WHERE channel_dept_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_departments_channel ON departments (company_id, channel);

ALTER TABLE users ADD COLUMN missing_at INTEGER;
ALTER TABLE users ADD COLUMN missing_runs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN recycled_at INTEGER;

CREATE TABLE IF NOT EXISTS channel_configs (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL REFERENCES companies(id),
  provider         TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'unconfigured',
  app_id           TEXT,
  agent_id         TEXT,
  corp_id          TEXT,
  secret_ref       TEXT,
  sync_mode        TEXT NOT NULL DEFAULT 'off',
  last_sync_run_id TEXT,
  last_synced_at   INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_configs_company_provider
  ON channel_configs (company_id, provider);

CREATE TABLE IF NOT EXISTS org_sync_runs (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  provider    TEXT NOT NULL,
  mode        TEXT NOT NULL,
  status      TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  stats_json  TEXT,
  error_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_org_sync_runs_company_provider
  ON org_sync_runs (company_id, provider, started_at DESC);

CREATE TABLE IF NOT EXISTS org_sync_diffs (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES org_sync_runs(id),
  company_id  TEXT NOT NULL,
  item_type   TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_id   TEXT,
  before_json TEXT,
  after_json  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_sync_diffs_run ON org_sync_diffs (run_id);
CREATE INDEX IF NOT EXISTS idx_org_sync_diffs_time ON org_sync_diffs (company_id, created_at);
