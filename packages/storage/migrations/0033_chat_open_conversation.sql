-- 记住员工与机器人的钉钉单聊会话 ID。
--
-- 入站消息（Stream）payload 里带 `conversationId`，就是该单聊的
-- openConversationId；此前没有落库，导致出站文件只能走「应用工作通知」。
ALTER TABLE chat_sessions ADD COLUMN open_conversation_id TEXT;
