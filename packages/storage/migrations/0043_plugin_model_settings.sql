-- 0043_plugin_model_settings.sql
-- 目的：插件模型是运行时注入的虚拟模型，不落 models 表；这里只持久化管理员为它
--       配置的可见角色。默认只授权普通员工 member，避免插件模型一注入就对全部角色可见。
-- 边界：插件被停用/卸载后不删配置；插件恢复后沿用管理员上次保存的角色。
--       roles_json 为空数组表示任何角色都不可见，由控制台显式保存。

CREATE TABLE IF NOT EXISTS plugin_model_settings (
  company_id  TEXT NOT NULL,
  model_id    TEXT NOT NULL,
  roles_json  TEXT NOT NULL DEFAULT '["member"]',
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (company_id, model_id)
);
