-- 0070_console_page_actions.sql
-- 页面权限从“可见 / 管理”细化为“可见 / 新增 / 编辑 / 删除”。
-- 旧数据 can_manage=1 回填为三项动作全开，避免升级后原有管理权限缩水；
-- can_manage 保留为兼容摘要列（任一动作打开即为 1），读取以三项动作列为准。

ALTER TABLE console_page_permissions ADD COLUMN can_create INTEGER NOT NULL DEFAULT 0;
ALTER TABLE console_page_permissions ADD COLUMN can_edit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE console_page_permissions ADD COLUMN can_delete INTEGER NOT NULL DEFAULT 0;

UPDATE console_page_permissions
   SET can_create = 1,
       can_edit = 1,
       can_delete = 1
 WHERE can_manage = 1;
