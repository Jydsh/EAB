-- 0018_auth_login_states.sql
-- 目的：钉钉扫码登录的 state 落库，保证回调只能兑换自己发起的登录
-- 影响：新建 auth_login_states；不修改现有表
-- 关键约定：
--   * state 一次性消费；过期 / 已消费 / 公司不匹配都拒绝
--   * 只存 state 与公司、回跳路径，不存 code / token / 用户信息
--   * 一家公司可以有多个待扫会话，但每个 state 全局唯一

CREATE TABLE IF NOT EXISTS auth_login_states (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  state         TEXT NOT NULL,
  redirect_path TEXT NOT NULL DEFAULT '/chat',
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  consumed_at   INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_login_states_state
  ON auth_login_states (state);

CREATE INDEX IF NOT EXISTS idx_auth_login_states_company
  ON auth_login_states (company_id, provider, created_at);
