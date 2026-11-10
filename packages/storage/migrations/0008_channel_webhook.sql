-- 0008_channel_webhook.sql
-- 目的：渠道接入补"群机器人 Webhook / 回调令牌"配置位（飞书 / 钉钉 / 企业微信）
-- 影响表：channel_configs 加 webhook_url / webhook_secret_ref / callback_token
-- 可在线执行：是（加列）
--
-- 说明：
--   * app_id / agent_id / corp_id / secret_ref 已有，企业应用凭证继续复用；
--   * 这里补的是"不依赖公网回调也能先验证连通性"的群机器人 Webhook；
--   * 密钥只存引用（secret_ref / webhook_secret_ref），实际值由 .eab-dev/secrets.json
--     或环境变量提供，库表不落明文。

ALTER TABLE channel_configs ADD COLUMN webhook_url TEXT;
ALTER TABLE channel_configs ADD COLUMN webhook_secret_ref TEXT;
ALTER TABLE channel_configs ADD COLUMN callback_token TEXT;
