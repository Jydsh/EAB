-- 0046_chat_session_mirror.sql
-- 目的：为「会话列表」建立 PostgreSQL 只读镜像。
--
-- 为什么不改 24 处会话写入 SQL：
-- 会话写入分散在网页、钉钉、飞书、定时任务和模型切换里，逐个改成异步仓储风险大。
-- 这里在 SQLite 内建一个通用 outbox：触发器把会话变化写进同一事务，后台插件再批量
-- 同步到 PG。SQLite 仍是写权威；PG 读路径追平后可用，未追平/失败自动回退。
--
-- last_assistant_at 只用于 PG 镜像计算未读红点，避免把整张 chat_messages 也镜像过去。
ALTER TABLE chat_sessions ADD COLUMN last_assistant_at INTEGER;

UPDATE chat_sessions
   SET last_assistant_at = (
     SELECT MAX(m.created_at)
       FROM chat_messages m
      WHERE m.session_id = chat_sessions.id
        AND m.role = 'assistant'
   )
 WHERE last_assistant_at IS NULL;

CREATE TABLE IF NOT EXISTS eab_pg_outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  op          TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_eab_pg_outbox_entity
  ON eab_pg_outbox (entity, entity_id, op);
CREATE INDEX IF NOT EXISTS idx_eab_pg_outbox_created
  ON eab_pg_outbox (created_at, id);

-- 新助手消息到达时更新会话的 last_assistant_at；这条 UPDATE 会继续触发下面的
-- 会话 outbox 触发器，所以不需要单独镜像 chat_messages。
CREATE TRIGGER IF NOT EXISTS trg_chat_messages_last_assistant
AFTER INSERT ON chat_messages
WHEN NEW.role = 'assistant'
BEGIN
  UPDATE chat_sessions
     SET last_assistant_at = NEW.created_at
   WHERE id = NEW.session_id
     AND (last_assistant_at IS NULL OR last_assistant_at < NEW.created_at);
END;

-- 会话的任何插入/更新（含软删、改名、已读、模型切换）都只入队，不阻塞主事务。
CREATE TRIGGER IF NOT EXISTS trg_chat_sessions_outbox_insert
AFTER INSERT ON chat_sessions
BEGIN
  INSERT OR REPLACE INTO eab_pg_outbox (entity, entity_id, op, created_at)
  VALUES ('chat_sessions', NEW.id, 'upsert', COALESCE(NEW.updated_at, NEW.created_at));
END;

CREATE TRIGGER IF NOT EXISTS trg_chat_sessions_outbox_update
AFTER UPDATE ON chat_sessions
BEGIN
  INSERT OR REPLACE INTO eab_pg_outbox (entity, entity_id, op, created_at)
  VALUES ('chat_sessions', NEW.id, 'upsert', COALESCE(NEW.updated_at, NEW.created_at));
END;

CREATE TRIGGER IF NOT EXISTS trg_chat_sessions_outbox_delete
AFTER DELETE ON chat_sessions
BEGIN
  INSERT OR REPLACE INTO eab_pg_outbox (entity, entity_id, op, created_at)
  VALUES ('chat_sessions', OLD.id, 'delete', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

-- 升级前已有会话先全量入队，PG 首次接入时由镜像插件批量补写。
INSERT OR REPLACE INTO eab_pg_outbox (entity, entity_id, op, created_at)
SELECT 'chat_sessions', id, 'upsert', COALESCE(updated_at, created_at)
  FROM chat_sessions;
