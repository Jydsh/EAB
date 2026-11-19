-- 0078_console_system_update_section.sql
-- 「系统更新」从「系统与运维」里的附属内容拆成独立二级页后，需要独立的后台页面权限。
-- 旧权限只有 system:data：这里按“原可见或可管理即保留”回填 system:update，
-- 避免升级后已有角色/成员突然失去系统更新页；之后可在角色或成员「后台权限」中单独取消。
-- 只回填可见权限，检查更新与一键更新默认不授权，需在角色或成员「后台权限」中单独配置。

INSERT OR IGNORE INTO console_role_page_permissions
  (company_id, role_id, page, can_view, can_create, can_edit, can_delete, can_manage, updated_by, updated_at)
SELECT company_id,
       role_id,
       'system:update',
       1,
       0,
       0,
       0,
       0,
       updated_by,
       updated_at
  FROM console_role_page_permissions
 WHERE page = 'system:data'
   AND (can_view = 1 OR can_create = 1 OR can_edit = 1 OR can_delete = 1 OR can_manage = 1);

INSERT OR IGNORE INTO console_page_permissions
  (company_id, user_id, page, can_view, can_create, can_edit, can_delete, can_manage, updated_by, updated_at)
SELECT company_id,
       user_id,
       'system:update',
       1,
       0,
       0,
       0,
       0,
       updated_by,
       updated_at
  FROM console_page_permissions
 WHERE page = 'system:data'
   AND (can_view = 1 OR can_create = 1 OR can_edit = 1 OR can_delete = 1 OR can_manage = 1);
