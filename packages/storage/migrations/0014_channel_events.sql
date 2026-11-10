-- 0014_channel_events.sql
-- 目的：渠道回调的幂等去重（CHN-02）与外部身份绑定（CHN-03）
CREATE TABLE IF NOT EXISTS channel_events (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  provider     TEXT NOT NULL,
  event_key    TEXT NOT NULL,
  sender_id    TEXT,
  received_at  INTEGER NOT NULL,
  result_json  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_events_provider_key
  ON channel_events (provider, event_key);
CREATE INDEX IF NOT EXISTS idx_channel_events_company_time
  ON channel_events (company_id, received_at);

CREATE TABLE IF NOT EXISTS channel_identities (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  provider     TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_identities_external
  ON channel_identities (provider, external_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_channel_identities_user
  ON channel_identities (company_id, user_id);
