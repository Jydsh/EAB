-- 0042_user_chat_send_mode.sql
-- 目的：每个员工自己选择「正在回复时再发消息」的处理方式：排队或打断。
-- 影响表：users 增加 chat_send_mode，默认 queue，保持现有排队行为。
-- 可在线执行：是（ALTER TABLE ADD COLUMN，SQLite 常量默认值）

ALTER TABLE users ADD COLUMN chat_send_mode TEXT NOT NULL DEFAULT 'queue';
