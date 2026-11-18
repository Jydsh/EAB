-- 角色级后台页面权限：成员绑定角色后自动获得角色的后台访问范围。
-- 个人 console_page_permissions 继续保留，作为角色之外的单独补充。
CREATE TABLE IF NOT EXISTS console_role_page_permissions (
  company_id TEXT NOT NULL REFERENCES companies(id),
  role_id    TEXT NOT NULL REFERENCES roles(id),
  page       TEXT NOT NULL,
  can_view   INTEGER NOT NULL DEFAULT 0,
  can_create INTEGER NOT NULL DEFAULT 0,
  can_edit   INTEGER NOT NULL DEFAULT 0,
  can_delete INTEGER NOT NULL DEFAULT 0,
  can_manage INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (company_id, role_id, page)
);

CREATE INDEX IF NOT EXISTS idx_console_role_page_permissions_role
  ON console_role_page_permissions (company_id, role_id);
