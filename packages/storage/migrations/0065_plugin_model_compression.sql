-- 0065_plugin_model_compression.sql
-- 目的：普通模型可以开启「上下文超限时自动压缩较早历史」，DSH 插件模型也需要同样的开关。
-- 边界：NULL 表示沿用插件声明；插件停用/卸载后配置保留，恢复后继续生效。
ALTER TABLE plugin_model_settings ADD COLUMN context_compression INTEGER;
