-- AGT-05：工具审批一次性核销。
-- 保留 approved 状态，控制台仍按原状态展示；used_at 记录该审批已经被哪次执行消费。
-- 同一审批通过后只能执行一次，避免一个审批被复用去执行不同参数或重复副作用。
ALTER TABLE approvals ADD COLUMN used_at INTEGER;
