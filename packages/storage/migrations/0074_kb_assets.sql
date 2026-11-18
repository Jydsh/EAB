-- 0074_kb_assets.sql
-- 目的：知识库文档图片资产（独立图片、DOCX/PPTX/XLSX/PDF 内嵌图片、扫描页渲染图）。
--
-- 边界：
-- 1. 只新增表，不改已有 kb_docs/kb_chunks 语义；旧文档没有图片资产时行为不变。
-- 2. 图片文件落在文档目录 assets/ 下，数据库保存相对路径；正文仍由 kb_chunks 提供。
-- 3. 图片 OCR / 视觉摘要写回 caption / ocr_text，切片通过 chunk.meta.imageAssetId 回链。
-- 4. 同一文档内按 content_hash 去重，重复引用复用同一条资产。

CREATE TABLE IF NOT EXISTS kb_doc_assets (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  doc_id        TEXT NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'document_image', -- document_image | page_render | standalone
  source_name   TEXT,
  relative_path TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  width         INTEGER,
  height        INTEGER,
  page_no       INTEGER,
  ordinal       INTEGER NOT NULL DEFAULT 0,
  caption       TEXT,
  ocr_text      TEXT,
  model_id      TEXT,
  content_hash  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_doc_assets_doc ON kb_doc_assets (company_id, doc_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_kb_doc_assets_collection ON kb_doc_assets (company_id, collection_id);
CREATE INDEX IF NOT EXISTS idx_kb_doc_assets_hash ON kb_doc_assets (doc_id, content_hash);
