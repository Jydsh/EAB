-- 0047_database_connections.sql
-- 目的：控制台「连接与平台 > 数据库」管理外部数据库连接。
--
-- 设计边界：
-- 1. 连接配置按公司隔离，只存地址/库名/账号与密钥引用，不存明文密码；
-- 2. 密码写入同目录 secrets.json，数据库只保留 secret_ref；
-- 3. status / last_tested_at / latency_ms 是最近一次探测结果的投影，
--    探测本身不改变连接配置，失败只记录原因，不阻塞控制台其它页面。
CREATE TABLE IF NOT EXISTS database_connections (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('postgres', 'mysql', 'sqlite', 'redis')),
  host            TEXT,
  port            INTEGER,
  database_name   TEXT,
  username        TEXT,
  file_path       TEXT,
  ssl             INTEGER NOT NULL DEFAULT 0,
  secret_ref      TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'untested' CHECK (status IN ('untested', 'ok', 'error')),
  status_detail   TEXT,
  last_error      TEXT,
  last_tested_at  INTEGER,
  latency_ms      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_database_connections_name
  ON database_connections (company_id, name);
CREATE INDEX IF NOT EXISTS idx_database_connections_company
  ON database_connections (company_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_database_connections_status
  ON database_connections (company_id, status, updated_at DESC);
