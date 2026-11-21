-- 同一审批节点支持多名审批人（指定角色会签）：
-- 同一 step_no 可有多条步骤，但同一审批人仍只能出现一次。
DROP INDEX IF EXISTS uq_permission_step_request_no;

CREATE UNIQUE INDEX IF NOT EXISTS uq_permission_step_request_approver
  ON permission_approval_steps (request_id, step_no, approver_user_id);
