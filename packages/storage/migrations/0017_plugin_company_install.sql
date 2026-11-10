-- 0017_plugin_company_install.sql
-- 目的：把插件安装从“整台服务器一份”改成“按 EAB 公司分别登记安装”
--   plugin_installs 继续做服务器上的插件制品登记（版本 / 来源 / 指纹 / 是否在磁盘）
--   plugin_company_installs 记录“哪家公司装了它”，列表、卸载、事件都按 company_id 过滤
-- 影响：新建 plugin_company_installs；老安装记录回填给库里的第一家（没有公司时用 c1）
--
-- 边界：插件代码目录仍共享（plugins/<id>/），避免同一份页面文件复制 N 份；
-- 隔离的是“安装归属 + 启停状态 + 生命周期记录”，一家公司卸载不会影响另一家。

CREATE TABLE IF NOT EXISTS plugin_company_installs (
  company_id   TEXT NOT NULL,
  plugin_id    TEXT NOT NULL,
  installed_by TEXT,
  installed_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  removed_at   INTEGER,
  PRIMARY KEY (company_id, plugin_id)
);

CREATE INDEX IF NOT EXISTS idx_plugin_company_installs_plugin
  ON plugin_company_installs (plugin_id, removed_at);

INSERT OR IGNORE INTO plugin_company_installs
  (company_id, plugin_id, installed_by, installed_at, updated_at, removed_at)
SELECT
  COALESCE((SELECT id FROM companies ORDER BY id LIMIT 1), 'c1'),
  plugin_id, installed_by, installed_at, updated_at, removed_at
FROM plugin_installs;
