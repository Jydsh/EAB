-- 0013_workspace_member_share.sql
-- 目的：member 角色默认具备工作区共享能力（WS-05），已有库同步补上
INSERT OR IGNORE INTO role_scopes (role_id, scope)
SELECT id, 'workspace:share' FROM roles WHERE code = 'member';
