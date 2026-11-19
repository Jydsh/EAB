-- 0077_model_speed_index.sql
-- 自动选模按模型读取最近真实回答的 timing/tokens；没有索引时会扫全公司消息。
CREATE INDEX IF NOT EXISTS idx_chat_messages_company_role_model_created
  ON chat_messages (company_id, role, model_id, created_at DESC);
