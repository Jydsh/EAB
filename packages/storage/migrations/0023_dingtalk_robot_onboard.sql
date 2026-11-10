-- 0023: 钉钉扫码建机器人（设备码流程）
--
-- 用户口径：绑组织架构时给一个二维码，扫码后自动建好机器人并补齐权限，
-- 不要一个权限一个权限地配。扫码结果直接带 client_id/client_secret/corp_id/
-- agent_id/robot_code/unified_app_id，因此把机器人字段落到 channel_configs，
-- 并把一次扫码尝试落库，服务重启后仍能续查。

ALTER TABLE channel_configs ADD COLUMN robot_code TEXT;
ALTER TABLE channel_configs ADD COLUMN robot_mode TEXT;
ALTER TABLE channel_configs ADD COLUMN unified_app_id TEXT;
ALTER TABLE channel_configs ADD COLUMN bot_bound_at INTEGER;
ALTER TABLE channel_configs ADD COLUMN bot_bound_by_user_id TEXT;

CREATE TABLE IF NOT EXISTS dingtalk_onboard_attempts (
  id             TEXT PRIMARY KEY,
  nonce          TEXT,
  device_code    TEXT NOT NULL UNIQUE,
  user_code      TEXT,
  qr_url         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'waiting',
  interval_sec   INTEGER NOT NULL DEFAULT 2,
  expires_at     INTEGER NOT NULL,
  client_id      TEXT,
  client_secret_ref TEXT,
  corp_id        TEXT,
  tenant_name    TEXT,
  agent_id       TEXT,
  robot_code     TEXT,
  unified_app_id TEXT,
  scanner_user_id TEXT,
  company_id     TEXT,
  error          TEXT,
  result_json    TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dingtalk_onboard_attempts_status
  ON dingtalk_onboard_attempts (status, expires_at);
