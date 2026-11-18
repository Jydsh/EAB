-- 0068_kb_pipeline.sql
-- 目的：知识库全流程升级（上传/解析/清洗/切片/索引/召回测试）。
--
-- 边界：
-- 1. 只加列/新表，不改旧表已有语义；已有文档默认 pipeline_stage='indexed'，行为不变。
-- 2. kb_chunk_embeddings 重建为 (chunk_id, model_id) 复合主键，允许同一 chunk 存多个模型向量。
-- 3. 测试记录只存摘要，按 expires_at 清理；正文仍在 kb_chunks。
-- 4. 迁移在一个事务内执行，失败回滚，不留半截 schema。

ALTER TABLE kb_collections ADD COLUMN clean_mode TEXT NOT NULL DEFAULT 'rules';
ALTER TABLE kb_collections ADD COLUMN clean_model_id TEXT;
ALTER TABLE kb_collections ADD COLUMN ocr_model_id TEXT;
ALTER TABLE kb_collections ADD COLUMN rerank_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE kb_collections ADD COLUMN rerank_model_id TEXT;
ALTER TABLE kb_collections ADD COLUMN chunk_size INTEGER NOT NULL DEFAULT 500;
ALTER TABLE kb_collections ADD COLUMN chunk_overlap INTEGER NOT NULL DEFAULT 80;
ALTER TABLE kb_collections ADD COLUMN vector_backend TEXT NOT NULL DEFAULT 'local';
ALTER TABLE kb_collections ADD COLUMN vector_connection_id TEXT;
ALTER TABLE kb_collections ADD COLUMN pipeline_config_json TEXT;

ALTER TABLE kb_docs ADD COLUMN original_path TEXT;
ALTER TABLE kb_docs ADD COLUMN raw_text TEXT;
ALTER TABLE kb_docs ADD COLUMN clean_text TEXT;
ALTER TABLE kb_docs ADD COLUMN parse_meta_json TEXT;
ALTER TABLE kb_docs ADD COLUMN pipeline_stage TEXT NOT NULL DEFAULT 'indexed';
ALTER TABLE kb_docs ADD COLUMN pipeline_error TEXT;
ALTER TABLE kb_docs ADD COLUMN clean_mode TEXT;
ALTER TABLE kb_docs ADD COLUMN clean_model_id TEXT;
ALTER TABLE kb_docs ADD COLUMN ocr_model_id TEXT;
ALTER TABLE kb_docs ADD COLUMN page_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kb_docs ADD COLUMN content_hash TEXT;
ALTER TABLE kb_docs ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE kb_chunks ADD COLUMN heading TEXT;
ALTER TABLE kb_chunks ADD COLUMN page_no INTEGER;
ALTER TABLE kb_chunks ADD COLUMN meta_json TEXT;
ALTER TABLE kb_chunks ADD COLUMN char_count INTEGER;
ALTER TABLE kb_chunks ADD COLUMN content_hash TEXT;

CREATE TABLE IF NOT EXISTS kb_ingest_jobs (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  doc_id        TEXT,
  stage         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  locked_at     INTEGER,
  heartbeat_at  INTEGER,
  locked_by     TEXT,
  error         TEXT,
  meta_json     TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_ingest_jobs_company_status
  ON kb_ingest_jobs (company_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_kb_ingest_jobs_doc
  ON kb_ingest_jobs (doc_id, stage);

CREATE TABLE IF NOT EXISTS kb_test_cases (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  collection_id   TEXT NOT NULL,
  name            TEXT NOT NULL,
  query           TEXT NOT NULL,
  expect_doc_ids  TEXT,
  expect_chunk_ids TEXT,
  tags            TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kb_test_cases_collection
  ON kb_test_cases (company_id, collection_id, enabled);

CREATE TABLE IF NOT EXISTS kb_test_runs (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  case_id       TEXT,
  query         TEXT NOT NULL,
  config_json   TEXT,
  result_json   TEXT,
  hit_count     INTEGER NOT NULL DEFAULT 0,
  top1_hit      INTEGER NOT NULL DEFAULT 0,
  recall_at_k   REAL,
  mrr           REAL,
  latency_ms    INTEGER,
  model_label   TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_test_runs_collection
  ON kb_test_runs (company_id, collection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_test_runs_expiry
  ON kb_test_runs (expires_at);

-- 向量旁表重建：从单模型主键改为 (chunk_id, model_id) 复合主键。
CREATE TABLE IF NOT EXISTS kb_chunk_embeddings_v2 (
  chunk_id      TEXT NOT NULL REFERENCES kb_chunks(id) ON DELETE CASCADE,
  model_id      TEXT NOT NULL,
  company_id    TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  doc_id        TEXT NOT NULL,
  dim           INTEGER NOT NULL,
  vector        BLOB NOT NULL,
  norm          REAL NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (chunk_id, model_id)
);
INSERT INTO kb_chunk_embeddings_v2
  (chunk_id, model_id, company_id, collection_id, doc_id, dim, vector, norm, created_at)
SELECT chunk_id, model_id, company_id, collection_id, doc_id, dim, vector, norm, created_at
  FROM kb_chunk_embeddings;
DROP TABLE kb_chunk_embeddings;
ALTER TABLE kb_chunk_embeddings_v2 RENAME TO kb_chunk_embeddings;
CREATE INDEX IF NOT EXISTS idx_kb_chunk_embeddings_company_collection
  ON kb_chunk_embeddings (company_id, collection_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunk_embeddings_doc
  ON kb_chunk_embeddings (doc_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunk_embeddings_model
  ON kb_chunk_embeddings (model_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunk_embeddings_chunk
  ON kb_chunk_embeddings (chunk_id);
