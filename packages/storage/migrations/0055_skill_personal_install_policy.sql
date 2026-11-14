-- 0055_skill_personal_install_policy.sql
-- 个人技能安装是否也需要管理员审批。默认关闭，保持既有个人安装体验；
-- 开启后，个人安装只创建待审批单，管理员通过后重新提交同一技能包才会落盘。

ALTER TABLE skill_company_policy
  ADD COLUMN require_personal_install_approval INTEGER NOT NULL DEFAULT 0;
