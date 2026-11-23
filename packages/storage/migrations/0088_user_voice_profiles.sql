-- 0088_user_voice_profiles.sql
-- 目的：每位员工自己的语音回复开关、内置音色和专属声音描述；网页与钉钉共用。
-- 影响表：新建 user_voice_profiles
-- 可在线执行：是（小表，幂等）

CREATE TABLE IF NOT EXISTS user_voice_profiles (
  company_id   TEXT NOT NULL REFERENCES companies(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  voice        TEXT NOT NULL DEFAULT 'S0',
  instructions TEXT NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 1,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (company_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_voice_profiles_company
  ON user_voice_profiles (company_id, updated_at DESC);
