-- AGT-17：多实例运行协调。
--
-- 只有显式开启多实例（EAB_MULTI_INSTANCE=1）且没有可用的 Redis 时，
-- 服务端才把这个表当作跨进程锁/计数/去重的共享层。
-- 它不是业务账本，过期行由各实例顺手清理。

CREATE TABLE IF NOT EXISTS runtime_coordination (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_coordination_expires
  ON runtime_coordination(expires_at);
