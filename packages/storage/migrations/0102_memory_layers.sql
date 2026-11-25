-- Memory OS v2：结构化事实槽位 + 有效期 + 重要性 + 记忆来源。
-- 只做增量列，不重建 memories，旧数据保持可用；新列全部可空，读取时回退到 content。
ALTER TABLE memories ADD COLUMN subject TEXT;
ALTER TABLE memories ADD COLUMN predicate TEXT;
ALTER TABLE memories ADD COLUMN object_text TEXT;
ALTER TABLE memories ADD COLUMN fact_key TEXT;
ALTER TABLE memories ADD COLUMN confidence REAL;
ALTER TABLE memories ADD COLUMN source_message_id TEXT;
ALTER TABLE memories ADD COLUMN valid_from INTEGER;
ALTER TABLE memories ADD COLUMN valid_to INTEGER;
ALTER TABLE memories ADD COLUMN last_access_at INTEGER;
ALTER TABLE memories ADD COLUMN importance REAL;
ALTER TABLE memories ADD COLUMN sensitivity TEXT;
ALTER TABLE memories ADD COLUMN extraction_source TEXT;
ALTER TABLE memories ADD COLUMN event_at INTEGER;
ALTER TABLE memories ADD COLUMN salience REAL;

-- 同一范围同一 fact_key 只允许一条有效事实；确认新事实时把旧事实 valid_to 置为当前时间。
CREATE INDEX IF NOT EXISTS idx_memories_fact_key
  ON memories (company_id, scope_type, scope_id, fact_key, valid_to);

-- 画像卡和长期记忆召回都要过滤 deleted_at / valid_to。
CREATE INDEX IF NOT EXISTS idx_memories_validity
  ON memories (company_id, deleted_at, valid_to, confirmed);
