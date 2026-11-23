-- 0089_user_voice_presets.sql
-- 目的：内置音色只保留一个系统默认，员工可以保存多段“专属声音描述”，
--       并选择其中一段作为自己的默认回复音色。网页与钉钉共用。
-- 影响表：user_voice_profiles 增加 active_voice_id；新建 user_voice_presets
-- 可在线执行：是（小表，幂等；旧描述会迁移成一条声音方案）

ALTER TABLE user_voice_profiles
  ADD COLUMN active_voice_id TEXT NOT NULL DEFAULT 'default';

CREATE TABLE IF NOT EXISTS user_voice_presets (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  instructions TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_voice_presets_owner
  ON user_voice_presets (company_id, user_id, updated_at DESC);

-- 把旧版“个人描述”折叠成一条声音方案，避免升级后丢失员工已保存的描述。
INSERT INTO user_voice_presets (id, company_id, user_id, name, instructions, created_at, updated_at)
SELECT 'vp_' || lower(hex(randomblob(12))), company_id, user_id, '我的声音', trim(instructions), updated_at, updated_at
  FROM user_voice_profiles
 WHERE trim(instructions) <> ''
   AND active_voice_id = 'default';

UPDATE user_voice_profiles
   SET active_voice_id = (
         SELECT p.id
           FROM user_voice_presets p
          WHERE p.company_id = user_voice_profiles.company_id
            AND p.user_id = user_voice_profiles.user_id
          LIMIT 1
       ),
       instructions = ''
 WHERE active_voice_id = 'default'
   AND trim(instructions) <> '';
