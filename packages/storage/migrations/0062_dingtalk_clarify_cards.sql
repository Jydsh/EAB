-- 0062_dingtalk_clarify_cards.sql
-- 目的：把钉钉答题卡的题组状态落库，服务重启后旧卡的“上一题/下一题/提交”仍然可用。
--
-- 设计边界：
-- 1. 卡片已经发到聊天里，重启后客户端仍会回调原来的 outTrackId；进程内 Map 不能作为唯一来源。
-- 2. 只存卡片回调需要的状态（题目、选项、当前页、逐题草稿）；不存聊天正文，避免重复。
-- 3. 同一张卡翻页/填写时覆盖更新；旧卡超过保留期由应用侧清理。
CREATE TABLE IF NOT EXISTS dingtalk_clarify_cards (
  out_track_id  TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  state_json    TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dingtalk_clarify_cards_company_session
  ON dingtalk_clarify_cards (company_id, session_id, updated_at);
