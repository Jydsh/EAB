-- 0106: 项目工作空间（对齐豆包工作「项目」）
--
-- 口径：
-- - 项目记录所属桌面设备；root_path 是桌面客户端电脑上的路径，服务端不能直接访问；
-- - 项目保存指令与云端资源引用，项目内新建会话自动继承；
-- - 会话区分 chat（对话）与 task（工作任务），仅在项目空间内使用。

ALTER TABLE user_local_spaces ADD COLUMN device_id TEXT;
ALTER TABLE user_local_spaces ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE user_local_spaces ADD COLUMN cloud_refs_json TEXT NOT NULL DEFAULT '[]';

-- 同一路径可以在不同电脑上分别成为项目；同一设备同一路径仍只允许一个未删除项目。
DROP INDEX IF EXISTS uq_user_local_spaces_root;
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_local_spaces_device_root
  ON user_local_spaces (company_id, user_id, COALESCE(device_id, ''), root_realpath)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_local_spaces_device
  ON user_local_spaces (company_id, user_id, device_id, deleted_at);

ALTER TABLE chat_sessions ADD COLUMN project_mode TEXT NOT NULL DEFAULT 'chat';
CREATE INDEX IF NOT EXISTS idx_chat_sessions_project_mode
  ON chat_sessions (company_id, user_id, space_kind, space_id, project_mode);
