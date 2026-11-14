-- 0053_skill_company_policy.sql
-- 公司级技能总开关。默认开启；关闭后聊天提示词不再注入任何技能，
-- 但个人已安装列表仍可查看，便于恢复与审计。

CREATE TABLE IF NOT EXISTS skill_company_policy (
  company_id  TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT,
  updated_at  INTEGER NOT NULL
);
