-- 0030_model_routes_and_kb_vectors.sql
-- 目的：为"决策 / 语音 / 视频 / 向量"模型提前留出运行时接入位；知识库支持向量化与混合检索
-- 影响表：models（加列）、model_routes（新表）、kb_collections（加列）、
--         kb_docs（加列）、kb_chunk_embeddings（新表）、kb_index_jobs（新表）
-- 可在线执行：是（只加列 / 新建空表；旧数据不重写）
-- 关键约定：
--   * tags 继续保留给界面展示；运行时能力以 capabilities 为准，旧模型缺 capabilities 时由服务端按 tags 回填。
--   * endpoint_kind 描述"这个模型用什么协议调用"，不是"模型类型"：chat / embeddings / rerank / asr / tts / video。
--   * model_routes 把"用途"和"模型"解耦：一个模型可以承担多个用途，一个用途也可以有多个候补。
--   * 向量不塞进 kb_chunks：单独一张 kb_chunk_embeddings，换 embedding 模型时可整表重建，不影响文本切片。
--   * 没有配置向量模型时，kb_chunk_embeddings 为空，检索继续走关键词，不阻断上传和问答。

ALTER TABLE models ADD COLUMN capabilities TEXT;
ALTER TABLE models ADD COLUMN endpoint_kind TEXT;
ALTER TABLE models ADD COLUMN input_modalities TEXT;
ALTER TABLE models ADD COLUMN output_modalities TEXT;
ALTER TABLE models ADD COLUMN max_context INTEGER;
ALTER TABLE models ADD COLUMN embedding_dim INTEGER;
ALTER TABLE models ADD COLUMN config_json TEXT;

CREATE TABLE IF NOT EXISTS model_routes (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  purpose     TEXT NOT NULL,                       -- chat.default / chat.vision / kb.embed / kb.rerank /
                                                   -- asr.default / tts.default / video.analyze / router.intent
  model_id    TEXT NOT NULL REFERENCES models(id),
  priority    INTEGER NOT NULL DEFAULT 10,
  enabled     INTEGER NOT NULL DEFAULT 1,
  config_json TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_model_routes_company_purpose
  ON model_routes (company_id, purpose, enabled, priority);
CREATE UNIQUE INDEX IF NOT EXISTS uq_model_routes_company_purpose_model
  ON model_routes (company_id, purpose, model_id) WHERE deleted_at IS NULL;

-- 知识库可以单独指定 embedding 模型；为空时走 model_routes 的 kb.embed
ALTER TABLE kb_collections ADD COLUMN embedding_model_id TEXT;
ALTER TABLE kb_collections ADD COLUMN retrieval_mode TEXT NOT NULL DEFAULT 'hybrid';

-- 索引状态与失败原因：页面要能看见"这篇为什么没进向量库"
ALTER TABLE kb_docs ADD COLUMN index_error TEXT;
ALTER TABLE kb_docs ADD COLUMN indexed_at INTEGER;
ALTER TABLE kb_docs ADD COLUMN index_model_id TEXT;

CREATE TABLE IF NOT EXISTS kb_chunk_embeddings (
  chunk_id      TEXT PRIMARY KEY REFERENCES kb_chunks(id) ON DELETE CASCADE,
  company_id    TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  doc_id        TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  dim           INTEGER NOT NULL,
  vector        BLOB NOT NULL,                     -- float32 little-endian，长度 = dim * 4
  norm          REAL NOT NULL,                     -- 预先算好，检索时只做点积 / 模长
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_chunk_embeddings_company_collection
  ON kb_chunk_embeddings (company_id, collection_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunk_embeddings_doc
  ON kb_chunk_embeddings (doc_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunk_embeddings_model
  ON kb_chunk_embeddings (model_id);

CREATE TABLE IF NOT EXISTS kb_index_jobs (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  doc_id        TEXT,
  model_id      TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | failed | cancelled
  total         INTEGER NOT NULL DEFAULT 0,
  done          INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_index_jobs_company_status
  ON kb_index_jobs (company_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_kb_index_jobs_collection
  ON kb_index_jobs (collection_id, status);
