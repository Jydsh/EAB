-- 0066_agent_team_lifecycle.sql
-- 目的：把子 Agent 从“进程内临时窗口”变成有生命周期、有岗位、有归属的团队节点。
--
-- 设计边界：
-- 1. 不改变旧 status 约束：注销用 retired_at 表示，worker 行和消息先保留，
--    避免 SQLite 修改 CHECK 约束，也避免 2 分钟空闲把评审上下文直接删掉。
-- 2. role 是岗位，不是模型：producer / critic / researcher / builder / worker。
-- 3. parent_key 只表达组织归属；评审关系仍由任务链表达，critic 不与 producer 互为父子。
-- 4. pinned 的岗位不会被空闲清理自动注销，适合正在评审链里的 critic 或长任务主持位。
ALTER TABLE agent_workers ADD COLUMN role TEXT NOT NULL DEFAULT 'worker';
ALTER TABLE agent_workers ADD COLUMN parent_key TEXT;
ALTER TABLE agent_workers ADD COLUMN depth INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_workers ADD COLUMN acceptance TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_workers ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_workers ADD COLUMN retired_at INTEGER;
ALTER TABLE agent_workers ADD COLUMN retire_reason TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_agent_workers_team_lifecycle
  ON agent_workers (team_id, retired_at, idx);
CREATE INDEX IF NOT EXISTS idx_agent_workers_team_parent
  ON agent_workers (team_id, parent_key, idx);
