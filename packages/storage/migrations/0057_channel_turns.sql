-- 0057_channel_turns.sql
-- 目的：把渠道机器人「正在处理中的一轮」落库，服务重启后可以续跑或明确收口。
--
-- 设计边界：
-- 1. 原始入站 payload 必须保留：钉钉 Stream 在本地进程重启后不会重推已 ACK 的消息，
--    没有 payload 就无法知道用户在问什么、属于哪个会话。
-- 2. 卡片 outTrackId 必须保留：A2UI 卡片已经投递到聊天里，重启后要复用同一张卡，
--    不能每条恢复都新建一张卡。
-- 3. user_message_id / assistant_message_id 固定下来：恢复时不再重复插用户消息，
--     assistant 消息可以原地更新，网页端历史不会出现两遍同一提问。
-- 4. agent_turn_id 固定下来：同一轮内工具调用的幂等键不变，已成功的工具不会因为
--    重启恢复而重复产生副作用。
-- 5. status：running=进程内正在跑；recovering=某个实例正在接手；completed/failed=已收口。
CREATE TABLE IF NOT EXISTS channel_turns (
  id                   TEXT PRIMARY KEY,
  company_id           TEXT NOT NULL,
  provider             TEXT NOT NULL,
  external_id          TEXT NOT NULL,
  user_id              TEXT NOT NULL,
  session_id           TEXT NOT NULL,
  event_key            TEXT NOT NULL,
  payload_json         TEXT NOT NULL,
  user_message_id      TEXT,
  assistant_message_id TEXT,
  card_instance_id     TEXT,
  card_kind            TEXT,
  agent_turn_id        TEXT,
  status               TEXT NOT NULL CHECK (status IN ('running', 'recovering', 'completed', 'failed')),
  attempts             INTEGER NOT NULL DEFAULT 0,
  progress_json        TEXT,
  last_error           TEXT,
  started_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  finished_at          INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_turns_provider_event
  ON channel_turns (provider, event_key);
CREATE INDEX IF NOT EXISTS idx_channel_turns_recoverable
  ON channel_turns (provider, status, started_at);
CREATE INDEX IF NOT EXISTS idx_channel_turns_company_session
  ON channel_turns (company_id, session_id, started_at);
