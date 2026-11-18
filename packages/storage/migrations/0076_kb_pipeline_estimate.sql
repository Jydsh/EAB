-- 知识库流水线进度与耗时：为四步浮层提供“正在做哪一步、已做多少、预计还要多久”。
-- 只加列，不改旧数据语义；历史文档默认无进度、无耗时记录。
ALTER TABLE kb_docs ADD COLUMN pipeline_progress REAL NOT NULL DEFAULT 0;
ALTER TABLE kb_docs ADD COLUMN pipeline_stage_started_at INTEGER;
ALTER TABLE kb_docs ADD COLUMN pipeline_timings_json TEXT NOT NULL DEFAULT '{}';
