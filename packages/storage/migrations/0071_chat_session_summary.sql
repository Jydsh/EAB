-- 会话滚动摘要：把已经滑出最近窗口的旧消息压成一段可注入的上下文。
-- 只存摘要本身，不复制消息正文；生成方可能是确定性整理（extractive）或模型压缩（model）。
CREATE TABLE IF NOT EXISTS chat_session_summaries (
  session_id          TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
  company_id          TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  summary_text        TEXT NOT NULL,
  generated_by        TEXT NOT NULL DEFAULT 'extractive',
  through_message_id  TEXT,
  through_created_at  INTEGER NOT NULL,
  source_message_count INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_session_summaries_scope
  ON chat_session_summaries (company_id, user_id, updated_at);
