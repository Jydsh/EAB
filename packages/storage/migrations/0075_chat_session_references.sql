-- 会话级常驻引用：用户从侧栏拖入的文件/文件夹/对话，在点 × 删除前每轮都生效。
-- 只存稳定引用（云空间 ID/路径、对话 ID），不存正文、dataUrl 或本地临时文件。
ALTER TABLE chat_sessions ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]';
