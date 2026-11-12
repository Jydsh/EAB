-- 0045_chat_session_unread.sql
-- 目的：会话列表按最后阅读时间显示未读红点，刷新/重新登录后仍能区分。
ALTER TABLE chat_sessions ADD COLUMN last_read_at INTEGER;
-- 已有会话视为在最后一次消息时已读过，避免升级后所有历史会话同时出现红点。
UPDATE chat_sessions SET last_read_at = COALESCE(last_message_at, updated_at);
