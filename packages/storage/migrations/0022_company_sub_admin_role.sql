-- 0022: 企业级子管理员（模型权限可下放）
--
-- 用户口径：模型权限归企业负责人，企业负责人可以授给“企业级子管理员”（一般是开发部门）。
-- 新建公司会从 BUILTIN_ROLES 复制；这个迁移给已经存在的公司补一个角色副本。
-- 数据范围是 company，但权限只到模型/插件/组织只读，不是完整 company_admin。

INSERT INTO roles (id, company_id, code, name, data_scope, builtin, created_at)
SELECT
  'r_sub_' || c.id,
  c.id,
  'company_sub_admin',
  '企业级子管理员',
  'company',
  1,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM companies c
WHERE c.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM roles r
     WHERE r.company_id = c.id
       AND r.code = 'company_sub_admin'
       AND r.deleted_at IS NULL
  );

INSERT OR IGNORE INTO role_scopes (role_id, scope)
SELECT sub.id, ca_scope.scope
FROM roles sub
JOIN roles ca ON ca.company_id = sub.company_id AND ca.code = 'company_admin' AND ca.deleted_at IS NULL
JOIN role_scopes ca_scope ON ca_scope.role_id = ca.id
WHERE sub.code = 'company_sub_admin'
  AND sub.deleted_at IS NULL
  AND ca_scope.scope IN (
    'chat:use',
    'chat:history:read',
    'chat:history:delete',
    'workspace:read',
    'workspace:write',
    'workspace:share',
    'agent:tool:list',
    'agent:tool:invoke',
    'kb:read',
    'memory:read',
    'memory:write',
    'approval:read',
    'model:use',
    'model:read',
    'model:manage',
    'org:member:read',
    'org:dept:read',
    'plugin:list',
    'plugin:install',
    'plugin:uninstall',
    'plugin:configure',
    'channel:send'
  );
