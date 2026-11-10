-- 0004_channel_bind.sql
-- 目的：渠道"扫码绑定企业"的表与列（钉钉 / 飞书 / 企业微信）
-- 影响表：channel_configs（加 tenant_id / tenant_name / bound_at / bound_by_user_id + 租户唯一索引）、新建 channel_bind_sessions
-- 可在线执行：是（加列 + 建表 + 建索引）
--
-- 为什么绑定要落"会话表"而不是一个接口搞定：
--   扫码是真人在渠道 App 里点确认，服务端只能"发码 → 轮询/回调 → 拿授权码 → 换租户"。
--   中间态（等待扫码 / 已扫待确认 / 过期 / 取消）必须可见可重试，否则页面只能靠刷新猜。
--
-- 为什么 tenant_id 要跨公司唯一：
--   一家公司的飞书租户只能绑到 EAB 里的一家公司。两个 EAB 公司绑同一个租户 = 组织数据互串，
--   这是数据隔离问题，不是配置问题，所以用唯一索引在写入处直接挡住（uq_channel_configs_tenant）。
--
-- 为什么解绑不删组织数据：
--   部门/成员是本公司资产（还有知识库 ACL 引用了 dept path）。解绑只是停止同步、清掉租户凭证引用。

ALTER TABLE channel_configs ADD COLUMN tenant_id TEXT;
ALTER TABLE channel_configs ADD COLUMN tenant_name TEXT;
ALTER TABLE channel_configs ADD COLUMN bound_at INTEGER;
ALTER TABLE channel_configs ADD COLUMN bound_by_user_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_configs_tenant
  ON channel_configs (provider, tenant_id)
  WHERE tenant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS channel_bind_sessions (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL REFERENCES companies(id),
  provider           TEXT NOT NULL,
  state              TEXT NOT NULL,
  status             TEXT NOT NULL,
  qr_content         TEXT,
  qr_image_url       TEXT,
  tenant_id          TEXT,
  tenant_name        TEXT,
  error_message      TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  authorized_at      INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_bind_sessions_state
  ON channel_bind_sessions (state);

CREATE INDEX IF NOT EXISTS idx_channel_bind_sessions_company
  ON channel_bind_sessions (company_id, provider, created_at DESC);
