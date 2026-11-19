-- 0079_console_member_section.sql
-- 「成员管理」原先只有「后台访问」分区，新增成员、编辑成员资料与角色分配没有可授权的动作。
-- 这里把整页 org 上已有的写权限回填到 org:members，避免升级后原本能编辑成员的角色/成员失去能力。
-- 只回填写权限；没有整页写权限的账号仍只能在成员列表里配置「后台访问」。

INSERT OR IGNORE INTO console_role_page_permissions
  (company_id, role_id, page, can_view, can_create, can_edit, can_delete, can_manage, updated_by, updated_at)
SELECT company_id,
       role_id,
       'org:members',
       1,
       can_create,
       can_edit,
       can_delete,
       can_manage,
       updated_by,
       updated_at
  FROM console_role_page_permissions
 WHERE page = 'org'
   AND (can_create = 1 OR can_edit = 1 OR can_delete = 1);

INSERT OR IGNORE INTO console_page_permissions
  (company_id, user_id, page, can_view, can_create, can_edit, can_delete, can_manage, updated_by, updated_at)
SELECT company_id,
       user_id,
       'org:members',
       1,
       can_create,
       can_edit,
       can_delete,
       can_manage,
       updated_by,
       updated_at
  FROM console_page_permissions
 WHERE page = 'org'
   AND (can_create = 1 OR can_edit = 1 OR can_delete = 1);
