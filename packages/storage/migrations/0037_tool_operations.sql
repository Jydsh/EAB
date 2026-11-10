-- 工具外部副作用的幂等记录。
-- 只记录显式启用幂等的工具（钉钉发送、文件改名/删除、定时任务创建/删除、密码重置）。
-- status:
--   running    正在执行，其他同键请求不应重复执行
--   succeeded  已成功，同键请求直接返回 result_json
--   failed     已失败，同键请求可以重试
CREATE TABLE IF NOT EXISTS tool_operations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_operations_key
  ON tool_operations(company_id, user_id, tool_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_tool_operations_expiry
  ON tool_operations(expires_at);
