-- 0002_kb.sql
-- 目的：知识库（collection）与文档/切片，含"可见范围"配置
-- 影响表：新建 kb_collections / kb_docs / kb_chunks
-- 可在线执行：是（空表）
-- 关键约定：
--   * 可见性配在知识库(collection)层，文档继承。单篇 override 留 V1。
--   * kb_docs / kb_chunks 冗余 collection_id，使"可见知识库集合"能编译成 collection_id IN (...)
--     一次 SQL 谓词，不需要 join 或内存二次过滤。
--   * classification 非空且默认 internal：列表过滤与 PDP 判定都靠它，不能是 NULL。

CREATE TABLE IF NOT EXISTS kb_collections (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  name            TEXT NOT NULL,
  description     TEXT,
  acl_mode        TEXT NOT NULL DEFAULT 'depts',   -- all | roles | depts | private
  acl_roles       TEXT,                            -- JSON 数组：角色码
  acl_dept_paths  TEXT,                            -- JSON 数组：部门物化路径，含下级
  owner_user_id   TEXT,                            -- mode=private 时的所有者
  owner_dept_path TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kb_collections_company ON kb_collections (company_id, status);

CREATE TABLE IF NOT EXISTS kb_docs (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies(id),
  collection_id  TEXT NOT NULL REFERENCES kb_collections(id),
  title          TEXT NOT NULL,
  source_type    TEXT,                    -- upload | url | api
  source_uri     TEXT,
  mime           TEXT,
  size_bytes     INTEGER,
  checksum       TEXT,
  dept_path      TEXT,
  scope_type     TEXT,
  scope_id       TEXT,
  owner_user_id  TEXT,
  classification TEXT NOT NULL DEFAULT 'internal',
  status         TEXT NOT NULL DEFAULT 'pending',   -- pending | indexing | indexed | failed | deleted
  chunk_count    INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kb_docs_company_collection ON kb_docs (company_id, collection_id);
CREATE INDEX IF NOT EXISTS idx_kb_docs_checksum ON kb_docs (company_id, checksum);
CREATE INDEX IF NOT EXISTS idx_kb_docs_status ON kb_docs (company_id, status);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL,
  doc_id         TEXT NOT NULL REFERENCES kb_docs(id),
  collection_id  TEXT NOT NULL,
  ordinal        INTEGER NOT NULL,
  text           TEXT NOT NULL,
  token_count    INTEGER,
  dept_path      TEXT,
  classification TEXT NOT NULL DEFAULT 'internal',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_company_collection ON kb_chunks (company_id, collection_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks (doc_id, ordinal);
