-- 0051_skills.sql
-- 技能体系：与插件同级，但技能只加载说明、引用和声明式工具，不执行任意脚本。
--   skill_installs         服务器上的技能制品（版本 / 指纹 / 风险等级 / 来源）
--   skill_company_installs 公司级安装：管理员装，公司内可见
--   skill_user_installs    个人级安装：员工自己装，只有本人可见
-- 边界：技能目录共享 skills/<id>/，隔离的是安装归属、启停、卸载和风险结论。

CREATE TABLE IF NOT EXISTS skill_installs (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  author        TEXT NOT NULL DEFAULT '',
  level         TEXT NOT NULL DEFAULT 'L0',
  risk_level    TEXT NOT NULL DEFAULT 'low',
  risk_json     TEXT NOT NULL DEFAULT '[]',
  checksum      TEXT NOT NULL,
  dir           TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'catalog',
  source_ref    TEXT,
  installed_at  INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  removed_at    INTEGER
);

CREATE TABLE IF NOT EXISTS skill_company_installs (
  company_id   TEXT NOT NULL,
  skill_id     TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  installed_by TEXT,
  installed_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  removed_at   INTEGER,
  PRIMARY KEY (company_id, skill_id)
);

CREATE TABLE IF NOT EXISTS skill_user_installs (
  company_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  skill_id     TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  installed_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  removed_at   INTEGER,
  PRIMARY KEY (company_id, user_id, skill_id)
);

CREATE TABLE IF NOT EXISTS skill_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id    TEXT NOT NULL,
  company_id  TEXT,
  user_id     TEXT,
  event       TEXT NOT NULL,
  actor_id    TEXT,
  detail      TEXT,
  at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_events_skill
  ON skill_events (skill_id, at);

CREATE INDEX IF NOT EXISTS idx_skill_events_company
  ON skill_events (company_id, at);

CREATE INDEX IF NOT EXISTS idx_skill_user_installs_user
  ON skill_user_installs (company_id, user_id, removed_at);
