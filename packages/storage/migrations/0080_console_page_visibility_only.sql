-- 0080_console_page_visibility_only.sql
-- 权限模型收敛为“每页只配置可见”：org / channels / models 的旧页内分区行不再解析。
-- 为避免只配置过旧分区、没有父页面行的角色或成员丢失后台入口，
-- 这里把这些分区行的可见状态回填到父页面；旧行本身保留，仅由新读取逻辑忽略。

INSERT INTO console_page_permissions
  (company_id, user_id, page, can_view, can_create, can_edit, can_delete, can_manage, updated_by, updated_at)
SELECT company_id, user_id, 'org', 1, 0, 0, 0, 0, updated_by, updated_at
  FROM console_page_permissions
 WHERE page LIKE 'org:%'
   AND (can_view = 1 OR can_create = 1 OR can_edit = 1 OR can_delete = 1 OR can_manage = 1)
ON CONFLICT (company_id, user_id, page) DO UPDATE SET
  can_view = 1,
  updated_at = excluded.updated_at;

INSERT INTO console_role_page_permissions
  (company_id, role_id, page, can_view, can_create, can_edit, can_delete, can_manage, updated_by, updated_at)
SELECT company_id, role_id, 'org', 1, 0, 0, 0, 0, updated_by, updated_at
  FROM console_role_page_permissions
 WHERE page LIKE 'org:%'
   AND (can_view = 1 OR can_create = 1 OR can_edit = 1 OR can_delete = 1 OR can_manage = 1)
ON CONFLICT (company_id, role_id, page) DO UPDATE SET
  can_view = 1,
  updated_at = excluded.updated_at;

INSERT INTO console_page_permissions
  (company_id, user_id, page, can_view, can_create, can_edit, can_delete, can_manage, updated_by, updated_at)
SELECT company_id, user_id, 'channels', 1, 0, 0, 0, 0, updated_by, updated_at
  FROM console_page_permissions
 WHERE page LIKE 'channels:%'
   AND (can_view = 1 OR can_create = 1 OR can_edit = 1 OR can_delete = 1 OR can_manage = 1)
ON CONFLICT (company_id, user_id, page) DO UPDATE SET
  can_view = 1,
  updated_at = excluded.updated_at;

INSERT INTO console_role_page_permissions
  (company_id, role_id, page, can_view, can_create, can_edit, can_delete, can_manage, updated_by, updated_at)
SELECT company_id, role_id, 'channels', 1, 0, 0, 0, 0, updated_by, updated_at
  FROM console_role_page_permissions
 WHERE page LIKE 'channels:%'
   AND (can_view = 1 OR can_create = 1 OR can_edit = 1 OR can_delete = 1 OR can_manage = 1)
ON CONFLICT (company_id, role_id, page) DO UPDATE SET
  can_view = 1,
  updated_at = excluded.updated_at;

INSERT INTO console_page_permissions
  (company_id, user_id, page, can_view, can_create, can_edit, can_delete, can_manage, updated_by, updated_at)
SELECT company_id, user_id, 'models', 1, 0, 0, 0, 0, updated_by, updated_at
  FROM console_page_permissions
 WHERE page LIKE 'models:%'
   AND (can_view = 1 OR can_create = 1 OR can_edit = 1 OR can_delete = 1 OR can_manage = 1)
ON CONFLICT (company_id, user_id, page) DO UPDATE SET
  can_view = 1,
  updated_at = excluded.updated_at;

INSERT INTO console_role_page_permissions
  (company_id, role_id, page, can_view, can_create, can_edit, can_delete, can_manage, updated_by, updated_at)
SELECT company_id, role_id, 'models', 1, 0, 0, 0, 0, updated_by, updated_at
  FROM console_role_page_permissions
 WHERE page LIKE 'models:%'
   AND (can_view = 1 OR can_create = 1 OR can_edit = 1 OR can_delete = 1 OR can_manage = 1)
ON CONFLICT (company_id, role_id, page) DO UPDATE SET
  can_view = 1,
  updated_at = excluded.updated_at;
