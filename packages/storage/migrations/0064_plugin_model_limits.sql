-- 0064_plugin_model_limits.sql
-- 目的：DSH 插件模型由插件运行时注入，但管理员仍需要覆盖它的上下文窗口与单次输出上限。
-- 边界：NULL 表示沿用插件声明的默认值；插件停用/卸载后配置保留，恢复后继续生效。
ALTER TABLE plugin_model_settings ADD COLUMN max_context INTEGER;
ALTER TABLE plugin_model_settings ADD COLUMN max_output_tokens INTEGER;
