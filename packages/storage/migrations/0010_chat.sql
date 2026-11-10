-- 0010_chat.sql
-- 目的：会话与消息持久化（CHAT-01/03），以及按天用量（CHAT-08 的基础）
CREATE TABLE IF NOT EXISTS chat_sessions (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  title           TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_message_at INTEGER,
  deleted_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions (company_id, user_id, deleted_at, updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  session_id  TEXT NOT NULL REFERENCES chat_sessions(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL,
  text        TEXT NOT NULL,
  model_id    TEXT,
  model_name  TEXT,
  meta_json   TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, created_at);

CREATE TABLE IF NOT EXISTS usage_daily (
  company_id       TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  day              TEXT NOT NULL,
  requests         INTEGER NOT NULL DEFAULT 0,
  prompt_tokens    INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, user_id, day)
);
