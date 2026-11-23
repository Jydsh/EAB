-- 0090_voice_preset_anchors.sql
-- 目的：给“我的声音”增加一段由声音描述稳定生成的参考音频，用于语音克隆式锚定。
--       仅靠文字描述 + seed 时，Breeze-TTS-2 每次请求仍会生成略有差异的音色；
--       把首次生成的样例作为 prompt_speech 复用，才能保证长回答分句播报时音色一致。
-- 影响表：user_voice_presets 增加 anchor_audio / anchor_text / anchor_model_id / anchor_updated_at
-- 可在线执行：是（小表，幂等；旧声音方案没有锚点时按需惰性生成）

ALTER TABLE user_voice_presets
  ADD COLUMN anchor_audio TEXT NOT NULL DEFAULT '';

ALTER TABLE user_voice_presets
  ADD COLUMN anchor_text TEXT NOT NULL DEFAULT '';

ALTER TABLE user_voice_presets
  ADD COLUMN anchor_model_id TEXT NOT NULL DEFAULT '';

ALTER TABLE user_voice_presets
  ADD COLUMN anchor_updated_at INTEGER NOT NULL DEFAULT 0;
