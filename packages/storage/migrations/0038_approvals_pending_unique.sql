-- 同一个审批人、同一个动作、同一个资源，只能存在一条 pending。
-- 已通过、已拒绝、已过期的历史记录不阻塞新申请。
CREATE UNIQUE INDEX IF NOT EXISTS uq_approvals_pending_resource
  ON approvals(company_id, requester_user_id, action, resource_id)
  WHERE status = 'pending';
