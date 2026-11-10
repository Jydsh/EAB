-- 0016_kb_external_and_content.sql
-- 目的：知识库支持外部来源；文档保留可编辑正文
-- 影响表：kb_collections / kb_docs
-- 可在线执行：是（ALTER TABLE 只加列，不重写旧数据）
-- 关键约定：
--   * source_kind = local | dify | obsidian | generic；旧库默认 local，行为不变
--   * source_config / source_secret_ref 只在外部来源使用；密钥仍走 secrets.json
--   * kb_docs.content 用于控制台编辑；旧文档为空，读取时从 kb_chunks 还原

ALTER TABLE kb_collections ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'local';
ALTER TABLE kb_collections ADD COLUMN source_config TEXT;
ALTER TABLE kb_collections ADD COLUMN source_secret_ref TEXT;
ALTER TABLE kb_collections ADD COLUMN last_synced_at INTEGER;

ALTER TABLE kb_docs ADD COLUMN content TEXT;
