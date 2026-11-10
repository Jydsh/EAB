-- 机器人以用户身份发文件时，记录一条“待回声”标记。
-- 钉钉 convFile/conversations/files/send 以操作人 unionId 发出，机器人会再收到一条
-- 同会话、同文件名的 file 入站消息；如果没有标记，就会被当成用户上传，重复存进个人云空间。
CREATE TABLE IF NOT EXISTS robot_user_file_sends (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  file_id TEXT,
  space_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  matched_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_robot_user_file_sends_match
  ON robot_user_file_sends(company_id, user_id, conversation_id, status, created_at);
