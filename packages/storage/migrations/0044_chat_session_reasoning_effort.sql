-- 0044_chat_session_reasoning_effort.sql
-- 目的：把员工在对话页选择的思考档位跟随会话保存，刷新或切回历史会话时恢复。
-- 边界：NULL 表示该会话没有显式选择，发送时按当前模型的默认档位计算；
--       档位 id 由模型配置或插件声明决定，不在这里做枚举约束。

ALTER TABLE chat_sessions ADD COLUMN reasoning_effort TEXT;
