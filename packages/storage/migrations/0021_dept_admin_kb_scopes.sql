-- 0021: 部门负责人可以管理本部门知识库
--
-- 内置 dept_admin 的角色定义已补 KB_ADMIN / KB_DELETE，但旧库里角色是复制出来的，
-- role_scopes 不会跟着代码变。这里给所有现存 dept_admin 角色补两个权限点。
-- 数据范围仍是 dept：只能管本部门（含下级）的知识库。

INSERT OR IGNORE INTO role_scopes (role_id, scope)
SELECT r.id, 'kb:admin'
  FROM roles r
 WHERE r.code = 'dept_admin' AND r.deleted_at IS NULL;

INSERT OR IGNORE INTO role_scopes (role_id, scope)
SELECT r.id, 'kb:delete'
  FROM roles r
 WHERE r.code = 'dept_admin' AND r.deleted_at IS NULL;
