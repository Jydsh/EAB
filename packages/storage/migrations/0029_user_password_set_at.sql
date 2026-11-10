-- 记录「密码是本人/管理员明确设置过」的时间；钉钉同步用户首次设置密码时不要求旧密码。
ALTER TABLE users ADD COLUMN password_set_at INTEGER;
