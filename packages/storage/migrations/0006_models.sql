-- 0006：模型接入（供应商 + 模型目录）
--
-- 设计口径（参考 DSH 的"插件式底座 + 适配器"）：
-- 1. provider 只是"一个可调用的端点 + 一种协议 + 一把密钥的引用"，不在这里跑进程。
-- 2. 厂商走协议归类：OpenAI 兼容（DeepSeek / 通义 / 智谱 / Moonshot / vLLM / Ollama / LM Studio）、
--    Anthropic、Google Gemini、Azure OpenAI、自定义；本地模型就是 base_url 指向本机的 OpenAI 兼容服务。
-- 3. 密钥不落库：只存"环境变量名"（api_key_env），由部署侧注入；界面只显示"已注入/未注入"。
-- 4. 模型可见性仍沿用"角色清单"：roles 为空 = 公司内所有能对话的人。

CREATE TABLE IF NOT EXISTS model_providers (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  base_url    TEXT,
  api_key_env TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_model_providers_company_name
  ON model_providers (company_id, name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS models (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  provider_id TEXT NOT NULL REFERENCES model_providers(id),
  name        TEXT NOT NULL,
  model_key   TEXT NOT NULL,
  tags        TEXT,
  roles       TEXT,
  priority    INTEGER NOT NULL DEFAULT 10,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_models_company_enabled ON models (company_id, enabled);
CREATE UNIQUE INDEX IF NOT EXISTS uq_models_company_name
  ON models (company_id, name) WHERE deleted_at IS NULL;
