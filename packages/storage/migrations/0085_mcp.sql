-- 0085_mcp.sql
-- 目的：登记公司级 MCP Server，并缓存 `tools/list` 结果，供 Agent 工具目录按需加载。
--
-- 设计边界：
-- 1. MCP 工具不写进内置 `TOOLS` 静态数组，`mcp_tools` 是独立的工具源；
-- 2. 第一版只下发 `annotations.readOnlyHint = true` 的工具，破坏性工具即使同步也不启用；
-- 3. 凭证只存 `secret_ref`，明文保存在 secrets.json，不落这张表；
-- 4. 同步失败保留旧工具，只更新 health / last_error，不清空目录；
-- 5. 熔断状态（failure_count / cooldown_until）是调用投影，不改变 Server 配置。
CREATE TABLE IF NOT EXISTS mcp_servers (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL,
  name                TEXT NOT NULL,
  transport           TEXT NOT NULL DEFAULT 'http' CHECK (transport IN ('stdio', 'sse', 'http')),
  endpoint            TEXT NOT NULL DEFAULT '',
  auth_type           TEXT NOT NULL DEFAULT 'none',
  secret_ref          TEXT NOT NULL DEFAULT '',
  allowed_tools_json  TEXT NOT NULL DEFAULT '[]',
  enabled             INTEGER NOT NULL DEFAULT 1,
  health              TEXT NOT NULL DEFAULT 'unknown' CHECK (health IN ('healthy', 'degraded', 'offline', 'unknown')),
  last_sync_at        INTEGER,
  last_error          TEXT NOT NULL DEFAULT '',
  failure_count       INTEGER NOT NULL DEFAULT 0,
  cooldown_until      INTEGER,
  created_by          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mcp_servers_name
  ON mcp_servers (company_id, name);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_company
  ON mcp_servers (company_id, enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS mcp_tools (
  id                  TEXT PRIMARY KEY,
  server_id           TEXT NOT NULL,
  company_id          TEXT NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  input_schema_json   TEXT NOT NULL DEFAULT '{}',
  annotations_json    TEXT NOT NULL DEFAULT '{}',
  enabled             INTEGER NOT NULL DEFAULT 0,
  synced_at           INTEGER NOT NULL,
  UNIQUE (server_id, name)
);

CREATE INDEX IF NOT EXISTS idx_mcp_tools_company
  ON mcp_tools (company_id, enabled, synced_at DESC);
