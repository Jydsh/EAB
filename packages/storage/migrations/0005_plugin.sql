-- 0005_plugin.sql
-- 目的：插件启停状态（插件包本身是磁盘目录，由部署侧放进 plugins/，这里只存"这家企业启用了哪些"）
-- 影响：新建 plugin_states
--
-- 为什么不把插件清单存库：
--   插件是代码，代码在磁盘上；库里存一份清单会立刻和磁盘不一致（删目录、换版本）。
--   库只保留"人做的决定" —— 启用 / 停用 / 谁在什么时候改的。
--
-- 为什么按 (company_id, plugin_id) 唯一：
--   同一个插件，A 公司可能有权限、B 公司没有；启停是租户域的决定，不是全局开关。

CREATE TABLE IF NOT EXISTS plugin_states (
  company_id  TEXT NOT NULL REFERENCES companies(id),
  plugin_id   TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (company_id, plugin_id)
);
