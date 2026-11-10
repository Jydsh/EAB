-- 0007_plugin_lifecycle.sql
-- 目的：把插件从“磁盘目录 + 每家公司启停”补成可运维的生命周期
--   plugin_installs：这台服务器上装过什么（版本、来源、指纹、安装人、是否还在磁盘上）
--   plugin_events：安装 / 更新 / 启用 / 停用 / 卸载的审计流水
-- 影响：新建 plugin_installs、plugin_events
--
-- 边界：
--   插件代码仍在磁盘（plugins/<id>/），库里只记“谁在什么时候做了什么决定”，
--   不复制清单正文，避免库和磁盘两份事实互相打架。
--   安装是服务器侧动作，按公司隔离的只是“启用/停用”（仍在 plugin_states）。

CREATE TABLE IF NOT EXISTS plugin_installs (
  plugin_id    TEXT PRIMARY KEY,
  version      TEXT NOT NULL,
  source       TEXT NOT NULL,
  source_ref   TEXT,
  checksum     TEXT,
  installed_by TEXT,
  installed_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  removed_at   INTEGER
);

CREATE TABLE IF NOT EXISTS plugin_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id  TEXT NOT NULL,
  company_id TEXT,
  event      TEXT NOT NULL,
  actor_id   TEXT,
  detail     TEXT,
  at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plugin_events_time ON plugin_events (at DESC);
CREATE INDEX IF NOT EXISTS idx_plugin_events_plugin ON plugin_events (plugin_id, at DESC);
