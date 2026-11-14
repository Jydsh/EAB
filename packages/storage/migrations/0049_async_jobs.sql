-- 0049_async_jobs.sql
-- 目的：异步作业登记表（Phase 4 队列地基）。
--
-- 设计边界：
-- 1. 库是跨实例共享的权威状态，Redis 只负责「新任务即时唤醒」与领导权，
--    因此没有 Redis 也能完整运行，只是 worker 退化为按 pollMs 轮询；
-- 2. 慢操作（插件通道刷新、模型批量探测等）提交后立刻返回 jobId，
--    控制台按 jobId 回读进度，不再让 HTTP 请求干等几分钟；
-- 3. 用 lease_owner + lease_until 做「谁在跑」的租约，实例崩溃后
--    recoverStaleJobs 把过期租约的 running 作业放回 queued，避免任务永久卡住；
-- 4. payload/result 只放作业参数和摘要，不放会话正文、密钥和审计数据。
CREATE TABLE IF NOT EXISTS async_jobs (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  user_id       TEXT,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  payload_json  TEXT NOT NULL,
  result_json   TEXT,
  error         TEXT,
  progress      INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  lease_owner   TEXT,
  lease_until   INTEGER,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_async_jobs_status_created
  ON async_jobs (status, created_at);

CREATE INDEX IF NOT EXISTS idx_async_jobs_company_status
  ON async_jobs (company_id, status, created_at);
