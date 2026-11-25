-- 0096_memory_os.sql
-- 目的：让长期记忆从“一段文本”升级为可区分类型、可处理冲突、可混合召回的 Memory OS。
--
-- 边界：
-- 1. 历史记忆没有类型，统一回填为 fact，避免把未知内容误当偏好或决策。
-- 2. conflict_with 只指向同公司、同范围、同类型的一条旧记忆；用户确认新记忆后才软删除旧记忆。
-- 3. embedding 存 float32 BLOB；没有向量模型时保持 NULL，召回退回词面匹配，不阻断对话。
ALTER TABLE memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'fact';
ALTER TABLE memories ADD COLUMN conflict_with TEXT;
ALTER TABLE memories ADD COLUMN embedding BLOB;
ALTER TABLE memories ADD COLUMN embedding_model TEXT;
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories (company_id, scope_type, scope_id, memory_type, deleted_at);
