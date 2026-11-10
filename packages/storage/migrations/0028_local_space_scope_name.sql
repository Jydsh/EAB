-- 权限点命名统一为「资源:动作」中的连字符形式，和已有 scope 保持一致。
-- 0027 已把 local_space:read / local_space:write 写入既有库；这里做一次就地改名。
UPDATE role_scopes SET scope = 'local-space:read'  WHERE scope = 'local_space:read';
UPDATE role_scopes SET scope = 'local-space:write' WHERE scope = 'local_space:write';
