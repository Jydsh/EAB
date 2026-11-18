-- 知识库召回测试记录保留期：默认 30 天，允许 1–365 天。
ALTER TABLE kb_collections ADD COLUMN test_retention_days INTEGER NOT NULL DEFAULT 30;
