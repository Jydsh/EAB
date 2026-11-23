-- 0091_voice_profile_anchors.sql
-- 目的：给系统默认音色也保存一段固定参考音频，避免默认音色每次请求重新设计。
--       自定义声音方案复用 0090 已有的 anchor_* 字段；这里只补 user_voice_profiles。
-- 影响表：user_voice_profiles 增加 anchor_audio / anchor_text / anchor_model_id / anchor_updated_at
-- 可在线执行：是（小表，幂等；旧数据留空，首次使用时惰性生成）

ALTER TABLE user_voice_profiles
  ADD COLUMN anchor_audio TEXT NOT NULL DEFAULT '';

ALTER TABLE user_voice_profiles
  ADD COLUMN anchor_text TEXT NOT NULL DEFAULT '';

ALTER TABLE user_voice_profiles
  ADD COLUMN anchor_model_id TEXT NOT NULL DEFAULT '';

ALTER TABLE user_voice_profiles
  ADD COLUMN anchor_updated_at INTEGER NOT NULL DEFAULT 0;
