-- 模型级 token 预算：上下文窗口与单次输出上限。
-- 旧模型保留 NULL/默认值；max_context 为空时不做上下文压缩。
ALTER TABLE models ADD COLUMN max_output_tokens INTEGER;

-- 1 = 上下文超过 max_context 时压缩较早历史；0 = 只按原逻辑截取最近消息。
ALTER TABLE models ADD COLUMN context_compression INTEGER NOT NULL DEFAULT 1;
