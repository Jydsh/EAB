-- 会话级模型偏好：NULL = 自动选择；非空可以是原生模型 ID，也可以是 plugin: 虚拟模型 ID。
-- 不建立到 models 表的外键，插件模型不落库。
ALTER TABLE chat_sessions ADD COLUMN model_id TEXT;
