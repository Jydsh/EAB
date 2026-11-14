-- 0048_tool_role_access.sql
-- 目的：工具级角色可用性配置。
--
-- 设计边界：
-- 1. 默认「所有角色可用」：没有配置行时，角色过滤直接放行；
-- 2. 只在控制台显式配置为「指定角色」时，才按 role_code 白名单收窄；
-- 3. 角色白名单是工具原有 scope 校验之外的附加限制，不替代 scope；
-- 4. 同一份配置对公司内所有插件实例生效，因此工具键使用 plugin:<pluginId>:<toolName>，
--    不使用带实例的目录 id。
CREATE TABLE IF NOT EXISTS tool_role_settings (
  company_id  TEXT NOT NULL,
  tool_id     TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('all', 'roles')),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (company_id, tool_id)
);

CREATE TABLE IF NOT EXISTS tool_role_bindings (
  company_id  TEXT NOT NULL,
  tool_id     TEXT NOT NULL,
  role_code   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (company_id, tool_id, role_code)
);

CREATE INDEX IF NOT EXISTS idx_tool_role_bindings_role
  ON tool_role_bindings (company_id, role_code);
