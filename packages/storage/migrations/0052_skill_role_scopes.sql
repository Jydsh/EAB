-- 0052: 已存在的内置角色补技能权限。
-- 0001 种子只写入当时的 scope；新增 skill:* 后，已有 DB 的角色行不会自动获得，
-- 这里按内置角色 code 补齐，避免升级后普通员工和公司管理员被挡在技能入口外。

INSERT OR IGNORE INTO role_scopes (role_id, scope)
SELECT r.id, 'skill:list'
FROM roles r
WHERE r.deleted_at IS NULL
  AND r.code IN ('super_admin', 'company_admin', 'company_sub_admin', 'dept_admin', 'member');

INSERT OR IGNORE INTO role_scopes (role_id, scope)
SELECT r.id, 'skill:use'
FROM roles r
WHERE r.deleted_at IS NULL
  AND r.code IN ('super_admin', 'company_admin', 'company_sub_admin', 'dept_admin', 'member');

INSERT OR IGNORE INTO role_scopes (role_id, scope)
SELECT r.id, 'skill:install'
FROM roles r
WHERE r.deleted_at IS NULL
  AND r.code IN ('super_admin', 'company_admin', 'company_sub_admin');

INSERT OR IGNORE INTO role_scopes (role_id, scope)
SELECT r.id, 'skill:uninstall'
FROM roles r
WHERE r.deleted_at IS NULL
  AND r.code IN ('super_admin', 'company_admin', 'company_sub_admin');

INSERT OR IGNORE INTO role_scopes (role_id, scope)
SELECT r.id, 'skill:configure'
FROM roles r
WHERE r.deleted_at IS NULL
  AND r.code IN ('super_admin', 'company_admin', 'company_sub_admin');

INSERT OR IGNORE INTO role_scopes (role_id, scope)
SELECT r.id, 'skill:approve'
FROM roles r
WHERE r.deleted_at IS NULL
  AND r.code IN ('super_admin', 'company_admin');
