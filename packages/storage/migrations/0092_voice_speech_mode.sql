-- 0092_voice_speech_mode.sql
-- 目的：播报时机可选——边生成边播（stream）或整段回答写完再播（whole）。
-- 影响表：user_voice_profiles 增加 speech_mode
-- 可在线执行：是（ALTER ADD COLUMN 带默认值；由迁移表保证只执行一次）

ALTER TABLE user_voice_profiles ADD COLUMN speech_mode TEXT NOT NULL DEFAULT 'stream';
