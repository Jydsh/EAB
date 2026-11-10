-- 0020: 把已同步的钉钉身份补进 channel_identities
--
-- 背景：通讯录同步只写 user_identities，而钉钉机器人回调只读 channel_identities，
-- 两表没打通 → 同步进来的员工在机器人对话里认不出来。这里做一次性回填；
-- 新同步的人由 apply.ts 在写入时同步登记，不需要再跑迁移。
--
-- 只补当前不存在的映射：唯一索引 (provider, external_id) WHERE revoked_at IS NULL
-- 决定了同一个钉钉 UserID 只能属于一个人，已有映射绝不覆盖。

INSERT INTO channel_identities (id, company_id, provider, external_id, user_id, created_at)
SELECT
  'ci_dt_' || lower(hex(randomblob(8))),
  u.company_id,
  ui.provider,
  ui.external_user_id,
  ui.user_id,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM user_identities ui
JOIN users u ON u.id = ui.user_id
WHERE ui.provider = 'dingtalk'
  AND ui.external_user_id IS NOT NULL
  AND ui.external_user_id <> ''
  AND u.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
      FROM channel_identities ci
     WHERE ci.provider = ui.provider
       AND ci.external_id = ui.external_user_id
       AND ci.revoked_at IS NULL
  );
