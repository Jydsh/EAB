-- 0069_chat_memory_fts.sql
-- 目的：为个人对话历史建立中文子串全文索引，支持跨会话/超出最近窗口的历史回忆。
-- 说明：FTS5 external content 表只保存索引，正文仍以 chat_messages 为准；
-- 触发器保证网页、钉钉、飞书等任何写入路径都会同步索引。
CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
  text,
  content='chat_messages',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ai
AFTER INSERT ON chat_messages
BEGIN
  INSERT INTO chat_messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ad
AFTER DELETE ON chat_messages
BEGIN
  INSERT INTO chat_messages_fts(chat_messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS chat_messages_fts_au
AFTER UPDATE OF text ON chat_messages
BEGIN
  INSERT INTO chat_messages_fts(chat_messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO chat_messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- 回填已有历史；重建命令对 external content 表会重新读取 chat_messages。
INSERT INTO chat_messages_fts(chat_messages_fts) VALUES ('rebuild');
