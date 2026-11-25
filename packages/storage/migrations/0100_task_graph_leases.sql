-- 0100_task_graph_leases.sql
-- 任务图 v1.1：运行租约、崩溃恢复和跨进程取消。
--
-- 背景：
--   * v1 的 running 只存在内存锁，进程崩溃后运行会永久卡住；
--   * 多实例下人工审批/等待恢复没有数据库级 claim，可能重复推进；
--   * cancel 只改状态，其他实例上的在途执行不知道已经取消。
--
-- 约定：
--   * lease_owner 是执行实例标识；lease_until 是租约截止时间；
--   * 执行期间心跳续租，进程消失后租约到期，由恢复扫描标记失败；
--   * cancel_requested_at 是跨实例取消标记，执行端在节点边界检查。
ALTER TABLE task_graph_runs ADD COLUMN lease_owner TEXT;
ALTER TABLE task_graph_runs ADD COLUMN lease_until INTEGER;
ALTER TABLE task_graph_runs ADD COLUMN cancel_requested_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_task_graph_runs_lease
  ON task_graph_runs (company_id, status, lease_until);
