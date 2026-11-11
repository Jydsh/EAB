-- 渠道统一开通：机器人凭据与组织凭据分开保存，扫码会话保留远端状态。
ALTER TABLE channel_configs ADD COLUMN bot_id TEXT;
ALTER TABLE channel_configs ADD COLUMN bot_secret_ref TEXT;
ALTER TABLE channel_configs ADD COLUMN bind_mode TEXT;
ALTER TABLE channel_configs ADD COLUMN last_sync_status TEXT;
ALTER TABLE channel_configs ADD COLUMN last_sync_error TEXT;
ALTER TABLE channel_bind_sessions ADD COLUMN meta_json TEXT;
