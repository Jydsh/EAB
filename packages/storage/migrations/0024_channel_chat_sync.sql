-- 0024_channel_chat_sync.sql
-- 目的：同一位员工在钉钉私聊与网页工作台共用一份会话，网页列表能看到钉钉来源。
-- 说明：external_id 是渠道里的发送者 ID（钉钉 staffId / userId），只用于定位固定会话。
ALTER TABLE chat_sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'web';
ALTER TABLE chat_sessions ADD COLUMN external_id TEXT;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_source
  ON chat_sessions (company_id, user_id, source, last_message_at);

-- 同一员工、同一渠道账号只保留一个未删除的固定会话；
-- 网页删除后 deleted_at 置位，下一条钉钉消息会重新建一个干净会话。
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_sessions_channel_active
  ON chat_sessions (company_id, user_id, source, external_id)
  WHERE external_id IS NOT NULL AND deleted_at IS NULL;
