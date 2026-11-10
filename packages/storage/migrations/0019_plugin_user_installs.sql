-- 0019_plugin_user_installs.sql
-- 目的：插件从“只有公司级安装”扩成“公司级 + 个人级”两层
--   plugin_installs           服务器上的插件制品（版本 / 来源 / 指纹）
--   plugin_company_installs   公司级安装：管理员装，公司内可见
--   plugin_user_installs      个人级安装：员工自己装，只有本人可见
-- 边界：插件代码目录仍共享 plugins/<id>/，隔离的是安装归属、启停与卸载
--   * 同一插件可以被公司装，也可以被多个员工各自装
--   * 个人卸载只解除本人，不影响公司级安装和其他员工

CREATE TABLE IF NOT EXISTS plugin_user_installs (
  company_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  plugin_id    TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  installed_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  removed_at   INTEGER,
  PRIMARY KEY (company_id, user_id, plugin_id)
);

CREATE INDEX IF NOT EXISTS idx_plugin_user_installs_plugin
  ON plugin_user_installs (plugin_id, removed_at);

CREATE INDEX IF NOT EXISTS idx_plugin_user_installs_user
  ON plugin_user_installs (company_id, user_id, removed_at);
