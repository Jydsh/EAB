-- 0058_workspace_gui_fallbacks.sql
-- 目的：OnlyOffice 原生 GUI 兜底的“准备 → 用户确认 → 结果上报”状态机
-- 影响表：新建 workspace_gui_fallbacks
-- 可在线执行：是（只新增表与索引）
-- 约定：一次兜底只允许一次尝试；失败后同一条记录不得再次确认或上报，必须重新发起

CREATE TABLE IF NOT EXISTS workspace_gui_fallbacks (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  file_id           TEXT NOT NULL REFERENCES workspace_files(id),
  user_id           TEXT NOT NULL,
  gui_action        TEXT NOT NULL,
  gui_label         TEXT NOT NULL,
  mode              TEXT NOT NULL,
  params_json       TEXT NOT NULL DEFAULT '{}',
  steps_json        TEXT NOT NULL,
  status            TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  note              TEXT,
  detail_json       TEXT,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  confirmed_at      INTEGER,
  finished_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workspace_gui_fallbacks_file
  ON workspace_gui_fallbacks (company_id, file_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_gui_fallbacks_user
  ON workspace_gui_fallbacks (company_id, user_id, status, created_at DESC);
