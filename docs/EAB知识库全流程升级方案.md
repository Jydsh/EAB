# EAB 知识库全流程升级方案

> 状态：2026-11-18 方案定稿；P0 已落地并验收，P1（模型清洗 / 图片 OCR / 扫描 PDF OCR）已落地。
> 范围：`packages/server/src/routes/console.ts`、`packages/server/public/app.js`、`packages/server/public/app.css`、`packages/server/src/kb-vector.ts`、`packages/server/src/routes/chat.ts`、`packages/storage/migrations`、`packages/server/src/database-*`。
> 目标：把当前“纯文本上传 + 固定 800 字硬切 + 本地余弦”的文本知识库，升级为可追踪、可回退、可测试的文件知识库流水线；开发机不依赖 PG/Redis 也能完整使用，生产环境可按管理后台的数据连接接入 Qdrant / pgvector。

---

## 0. 实施进度（2026-11-18）

| 能力 | 状态 | 已验证范围 |
|---|---|---|
| 上传落盘 + `kb_ingest_jobs` 流水线 + 阶段 UI | 已完成 | Markdown / DOCX / XLSX / PPTX / PDF 真实上传并 `indexed`；上传弹窗、详情、重跑、切片预览已在浏览器验收 |
| Dify 式四步文档浮层 | 已完成 | 解析 / 清洗 / 切片 / 索引一次只展示一步，支持上一步、下一步与点步骤直达；默认跟随实时阶段，手动查看后停止跟随；每步按需加载预览，可只重跑当前步骤；每步显示预计 / 实际耗时，顶部显示全程耗时 |
| 大文件稳定清洗 + 耗时预估 | 已完成 | 小批次 + 并发 3 + 动态文档预算 4~20 分钟；单批失败保留原文，整篇失败回退规则清洗；5.1 万字符文档实测 244.5 秒、223 切片、无 `pipeline_error` |
| 运行中进度与剩余时间 | 已完成 | 清洗按批次写 `pipeline_progress`，四步浮层显示“已清洗 N% / 预计还需 X”；完成后写回 `pipeline_timings_json` |
| 规则清洗 | 已完成 | 页码、重复空行清理；数字 / 日期 / 金额保留 |
| 模型清洗 `kb.clean` | 已完成 | 绑定 `Qwen3.8-27B-FP8` 后实测清洗成功；块标记缺失时逐块补洗；空块按模型判断整块丢弃；失败回退规则清洗并写 warning |
| 图片 OCR `kb.ocr` | 已完成 | 上传 PNG 实测 OCR 为“设备台账 OCR 验收 / 交换机管理地址 192.168.50.10 / 日期 2026-11-18”，`pageCount=1`、`chunks=1` |
| 扫描 PDF OCR | 代码已接 | `pdfjs-dist` 渲染 + `@napi-rs/canvas` 已能用真实 PDF 渲染 PNG；空文本页调用 `kb.ocr`；尚未做端到端扫描 PDF 文件验收 |
| Dify 式召回测试 / 用例 / 记录按天清理 | 已完成 | 新增共享检索核心，管理端可调 mode/topK/阈值/rerank；单次运行、用例 CRUD 与运行、Top1/Recall@K/MRR、测试记录过期清理、embedding 模型对比已在真实知识库验收；批量运行、检索模式并排与 rerank A/B 待做 |
| Qdrant / pgvector 数据连接 | 待实施 | 规划迁移 `0073`，驱动与热连接未做 |



---

## 1. 结论先行

本轮按以下口径实施，后续不再反复改方向：

| 决策 | 落地口径 |
|---|---|
| 文件范围 | `pdf / docx / xlsx / pptx / txt / md / markdown / csv / json / html / htm / png / jpg / jpeg / webp`；老式 `.doc / .xls / .ppt` 首版提示“另存为新格式”，不静默失败 |
| 扫描件 | 首版支持扫描 PDF 与图片 OCR；依赖 `pdfjs-dist` 渲染 + `@napi-rs/canvas` + `kb.ocr` 多模态模型；缺依赖或缺模型时进入 `needs_config`，给出明确配置提示，不把空文本当成功 |
| 清洗 | 默认走规则清洗；可选模型清洗；`auto` 模式优先解析 `kb.clean` 用途路由，没有模型就自动退回规则清洗 |
| 切片 | 统一结构感知切片器，默认约 500 tokens、重叠 80 tokens；表格按行组切并重复表头；保留标题路径、页码、工作表、行范围 |
| 检索测试 | Dify 式可调参数：query、模式、topK、rerank、阈值、关键词命中门槛；返回每一级的分数、耗时和命中片段 |
| 测试用例 | 可保存 query + 期望文档/片段 + 标签；支持批量跑、通过率、recall@k、MRR |
| 模型对比 | embedding 模型对比已落地：列出 `kb_chunk_embeddings` 中已有向量的模型逐个跑同一 query；rerank A/B 与检索模式并排待实施 |
| 测试记录 | 默认保留 30 天，可在知识库设置里改为 1–365 天；后台按天清理，清理后只保留审计摘要，不保留命中正文 |
| 向量库 | 默认本地 SQLite；`Qdrant` 作为新数据连接类型；`pgvector` 复用 PostgreSQL 连接并检测 `vector` 扩展；连接后启用外部向量检索，未连接或不可用时自动降级到本地向量 → 关键词检索 |
| 配置来源 | 运行时以管理后台「连接与平台 → 数据连接」的配置为准，不用环境变量覆盖知识库向量后端；连接变更后热生效，不需要重启服务 |
| 降级原则 | 任何外部向量库故障都不得让对话或上传失败；上传先落本地，外部索引失败只记为 `degraded` 并异步重试 |

**“重排序”在本文中统一指检索阶段的 rerank**，不是把切片顺序打乱重排。

---

## 2. 现状核对（改造前）

以下都是当前代码的事实，不是推测：

1. 管理端上传只接受 `.txt / .md / .markdown / .csv / .json / .log / .html`，浏览器 `file.text()` 读纯文本，5MB 上限；`POST /api/console/kb/collections/:id/docs` 只接收 `{ title, content, classification }`，写 `source_type='manual'`、`mime='text/plain'`、`status='indexed'`，原始文件不落盘。
2. 服务端没有 PDF 文本提取、图片 OCR；`pdfjs-dist` 只用于静态 viewer 资源。Office 解析只有 Agent 工具用的预览版 `readDocxOutline` / `readXlsxOutline` / `readPptxOutline`，有 500 元素 / 200 单元格 / 200 段落上限，不能直接当全量入库解析器。
3. 切片只有 `chunkKbContent()`：按 `\n{2,}` 分段，每段 ≤800 字直接成片，超过则固定 800 字符硬切；无重叠、无标题层级、无表格保护、无页码/段落元数据。`console.ts` 与 `kb-external.ts` 至少有三处重复实现。
4. 没有清洗、没有 OCR、没有“原始/清洗后/切片”三份预览；上传后文本直接切片入库。
5. 向量化已有 `kb_chunk_embeddings`、`kb_index_jobs`、`kb.embed`，按文档批量 embedding；`kb_collections.embedding_model_id` 列存在，但管理界面没有入口。
6. 检索 `retrieveKb` 已有关键词（中文 bigram，最多 300 候选）→ 向量（同模型分组，余弦 top20）→ RRF 融合 → 可选 `kb.rerank`（top20→top4）；权限先裁 collection ACL 与密级再算向量；`retrieval_mode` 字段基本未被读取，所有库实际走 hybrid。
7. 管理端只有 `POST /api/console/kb/collections/:id/test` 测 Dify/generic 外部源连通性，没有本地召回的 API/UI，不能像 Dify 那样调 topK、模式、阈值、rerank。
8. `searchChunkVectors` 是全表扫描 + 内存余弦，`LIMIT 20000`；超过 2 万切片会截断候选，当前没有向量库抽象层。
9. `database_connections.kind` 只有 `postgres / mysql / sqlite / redis`，是 CHECK 约束；数据连接注册表目前“只配置、不改运行时后端选择”，也没有 Qdrant 或 pgvector 能力检测。
10. 开发机当前不连 PG/Redis，知识库必须继续可用的本地路径；生产服务器才按管理后台配置启用外部能力。

---

## 3. 总体架构

```
管理端上传（multipart）
  ↓
原始文件落盘 + 校验/去重 + kb_docs(pipeline_stage=uploaded)
  ↓
解析器（按 MIME/扩展名选择）
  ├─ 文本类：txt/md/csv/json/html → 纯文本 + 段落
  ├─ OOXML：docx/xlsx/pptx → 文本 + 标题/表格/页码/工作表
  ├─ PDF：文本层优先；扫描页渲染成图 → kb.ocr
  └─ 图片：直接 → kb.ocr
  ↓
规则清洗（默认）→ 可选 kb.clean 模型清洗（保留 raw/clean 两份 + diff）
  ↓
结构感知切片（标题/段落/句子/表格行组；带 page/heading/sheet/row）
  ↓
本地向量索引（kb_chunk_embeddings，始终写）
  ↓
可选外部向量镜像（Qdrant / pgvector；失败不阻塞）
  ↓
检索测试 / 对话检索
  ├─ 关键词 bigram
  ├─ 向量：外部优先 → 本地兜底 → 关键词兜底
  ├─ RRF 融合
  └─ 可选 rerank
```

### 3.1 组件边界

| 组件 | 职责 |
|---|---|
| `kb-ingest.ts` | 上传落盘、文件校验、去重、创建流水线任务 |
| `kb-parsers/*` | 按类型解析成统一 `KbBlock[]`，不调用大模型 |
| `kb-cleaner.ts` | 规则清洗 + 模型清洗 + 数字/日期校验 + diff |
| `kb-splitter.ts` | 统一切片器，所有入口共用，不再各自实现 800 字硬切 |
| `kb-pipeline.ts` | 任务领取、阶段推进、失败重试、状态查询 |
| `kb-vector.ts` | 本地向量索引/检索；调用外部 `VectorStore` 适配器 |
| `vector-store/*` | `LocalVectorStore` / `QdrantVectorStore` / `PgVectorStore` 统一接口 |
| `kb-retrieval.ts` | 可复用的检索核心，对话与测试台共用，返回中间分数 |
| `kb-test.ts` | 测试运行、用例、模型对比、保留期清理 |

> 对话检索与测试台必须共用 `kb-retrieval.ts`，不允许测试台另写一套近似逻辑，否则测试结果不能代表线上效果。

---

## 4. 数据模型与迁移

P0 已应用 `0068_kb_pipeline.sql`；`0069`–`0071` 已被其他功能占用；召回测试保留期已应用 `0072_kb_test_retention.sql`，向量库迁移从 `0073` 开始。

### 4.1 `0068_kb_pipeline.sql`（已应用）

#### `kb_collections` 增加列

| 列 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `clean_mode` | TEXT | `rules` | `none / rules / model / auto` |
| `clean_model_id` | TEXT | NULL | 显式清洗模型；为空时 `auto` 走 `kb.clean` 路由 |
| `ocr_model_id` | TEXT | NULL | 显式 OCR 模型；为空时走 `kb.ocr` 路由 |
| `rerank_enabled` | INTEGER | 1 | 库级开关；无 rerank 模型时自动失效 |
| `rerank_model_id` | TEXT | NULL | 为空走 `kb.rerank` 路由 |
| `chunk_size` | INTEGER | 500 | token 估算上限，范围 150–1500 |
| `chunk_overlap` | INTEGER | 80 | token 估算重叠，范围 0–300，且小于 chunk_size |
| `vector_backend` | TEXT | `local` | `local / qdrant / pgvector` |
| `vector_connection_id` | TEXT | NULL | 指向 `database_connections.id`；`local` 时为空 |
| `pipeline_config_json` | TEXT | NULL | 解析器选项、OCR DPI、页数上限等非敏感配置 |

#### `kb_docs` 增加列

| 列 | 类型 | 说明 |
|---|---|---|
| `original_path` | TEXT | 相对数据根的路径；不存用户原始文件名，避免路径穿越 |
| `raw_text` | TEXT | 解析后的原始文本（可空，详细块在 sidecar） |
| `clean_text` | TEXT | 清洗后文本（可空） |
| `parse_meta_json` | TEXT | 页数、工作表、标题树、OCR 页数、解析器版本 |
| `pipeline_stage` | TEXT | `uploaded / parsing / parsed / cleaning / cleaned / chunking / chunked / indexing / indexed / failed / needs_config` |
| `pipeline_error` | TEXT | 当前阶段错误，给页面直接展示 |
| `clean_mode` | TEXT | 本篇实际使用的清洗模式 |
| `clean_model_id` | TEXT | 本篇实际使用的清洗模型 |
| `ocr_model_id` | TEXT | 本篇实际使用的 OCR 模型 |
| `page_count` | INTEGER | PDF/图片页数；非分页文档为 0 |
| `content_hash` | TEXT | 原始文件内容 SHA-256；用于去重和幂等 |
| `version` | INTEGER | 同一文档重跑次数；默认 1 |

保留现有 `checksum / status / chunk_count / index_error / indexed_at / index_model_id`，不删除旧字段；`status` 作为粗粒度投影，`pipeline_stage` 为真实阶段。

#### `kb_chunks` 增加列

| 列 | 类型 | 说明 |
|---|---|---|
| `heading` | TEXT | 最近标题路径，如“第三章 > 3.2 报销” |
| `page_no` | INTEGER | PDF/图片页码；从 1 开始 |
| `meta_json` | TEXT | `{headingPath, pageNo, sheetName, rowRange, blockType}` |
| `char_count` | INTEGER | 字符数 |
| `content_hash` | TEXT | 切片内容哈希，用于幂等和 diff |

`token_count` 继续保留，改为估算值。

#### `kb_ingest_jobs`（新表）

```sql
kb_ingest_jobs(
  id, company_id, collection_id, doc_id,
  stage,                    -- parse / clean / chunk / index
  status,                   -- pending / running / done / failed / cancelled / needs_config
  attempts, max_attempts,
  locked_at, heartbeat_at, locked_by,
  error, meta_json,
  created_at, updated_at
)
```

- 一个文档同一时间最多一个 `running` 任务；`locked_by` 用进程实例 ID，`heartbeat_at` 超时 5 分钟视为失锁，可被重新领取。
- 进程内 worker 轮询；重启后从 `pending / running(失锁)` 继续，不依赖 Redis。
- 外部向量写入失败不改变 `kb_docs.pipeline_stage=indexed`，另记 `degraded` 状态；详见第 10 节。

#### `kb_chunk_embeddings` 改成多模型表

现状 `chunk_id` 是主键，只能存一个模型。为了支持“同一库对比 embedding 模型”，重建为：

```sql
kb_chunk_embeddings(
  chunk_id, model_id, company_id, collection_id, doc_id,
  dim, vector BLOB, norm, created_at,
  PRIMARY KEY (chunk_id, model_id)
)
```

迁移步骤（SQLite）：

1. 建 `kb_chunk_embeddings_new`，复合主键；
2. 从旧表复制全部行；
3. 删除旧表，重命名新表；
4. 重建 `(company_id, collection_id, model_id)`、`(doc_id, model_id)` 索引。

兼容读取：旧数据只有当前模型一行，迁移后行为不变；新索引可按多个模型写入。`kb-index-status` 返回的 `modelIds` 从单值改为数组。

#### `kb_test_cases`（新表）

```sql
kb_test_cases(
  id, company_id, collection_id,
  name, query, expect_doc_ids, expect_chunk_ids,
  tags, enabled,
  created_by, created_at, updated_at, deleted_at
)
```

期望文档/片段存 JSON 数组；不存大段正文。

#### `kb_test_runs`（新表）

```sql
kb_test_runs(
  id, company_id, collection_id, case_id,
  query, config_json, result_json,
  hit_count, top1_hit, recall_at_k, mrr,
  latency_ms, model_label,
  created_at, expires_at
)
```

- `result_json` 只存测试结果摘要：排名、chunkId、docId、标题、页码、分数、命中片段（每段最多 800 字）；完整正文仍在 `kb_chunks`。
- `expires_at = created_at + retentionDays`。
- 清理：启动时跑一次，之后每 6 小时跑一次；硬删除过期行；当前不写清理日志正文，审计事件待补。
- 默认保留 30 天，范围 1–365；配置存 `companies.settings_json.kb.testRetentionDays`，按公司生效。

### 4.2 `0073_database_connections_vector.sql`（待实施）

`database_connections.kind` 是 CHECK 约束，SQLite 不能直接改 CHECK，需要重建表：

```sql
database_connections(
  ...原字段...,
  kind TEXT CHECK (kind IN ('postgres','mysql','sqlite','redis','qdrant')),
  options_json TEXT,          -- Qdrant collection 前缀、TLS 选项等非敏感配置
  vector_capability TEXT      -- 'none' / 'pgvector' / 'qdrant'，探测后回填
)
```

- 不新增 `pgvector` 类型：pgvector 是 PostgreSQL 的扩展，复用 `kind='postgres'` 的连接；探测时执行 `SELECT extversion FROM pg_extension WHERE extname='vector'`，成功则 `vector_capability='pgvector'`，失败则保持 `none` 并在 `status_detail` 写“PG 可用，未安装 pgvector 扩展”。
- `qdrant` 使用 `host / port / ssl / secret_ref / options_json`；`secret_ref` 存 API Key，页面只返回 `passwordConfigured`，不回显。
- 连接表重建时保留原有行、索引和 `secret_ref`；不删除任何密码。
- 迁移后现有 PostgreSQL / MySQL / SQLite / Redis 行为不变；新增的 `vector_capability` 只作为知识库选择依据，不改变 EAB 审计/会话后端。

### 4.3 `0076_kb_pipeline_estimate.sql`（已应用）

```sql
ALTER TABLE kb_docs ADD COLUMN pipeline_progress REAL NOT NULL DEFAULT 0;
ALTER TABLE kb_docs ADD COLUMN pipeline_stage_started_at INTEGER;
ALTER TABLE kb_docs ADD COLUMN pipeline_timings_json TEXT NOT NULL DEFAULT '{}';
```

- `pipeline_progress`：当前步骤的批次进度，0~1，仅清洗阶段实时写入。
- `pipeline_stage_started_at`：当前步骤开始时间（毫秒），用于没有批次进度时按“预估 - 已用时”兜底。
- `pipeline_timings_json`：各步骤实际耗时（毫秒），重跑只覆盖当前步骤，状态接口转成秒返回给 UI。

---

## 5. 上传与落盘

### 5.1 接口

新增 multipart 上传：

```
POST /api/console/kb/collections/:id/docs/upload
Content-Type: multipart/form-data
fields:
  files[]            （可多文件，最多 20 个）
  title?             （单文件时可覆盖标题）
  classification     （默认 internal）
  cleanMode          （none / rules / model / auto）
  cleanModelId?
  ocrModelId?
  chunkSize?
  chunkOverlap?
  autoStart          （默认 true）
```

返回：

```json
{
  "documents": [
    {
      "id": "doc_...",
      "title": "员工手册.pdf",
      "mime": "application/pdf",
      "sizeBytes": 1234567,
      "pipelineStage": "uploaded",
      "jobId": "job_..."
    }
  ],
  "duplicates": [
    { "checksum": "...", "existingDocId": "doc_...", "title": "员工手册.pdf" }
  ]
}
```

不改变旧的 JSON 建文档接口，旧接口继续可用于纯文本手工录入；新入口走文件上传。

### 5.2 落盘规则

- 根目录：`<config.dataDir>/knowledge/<companyId>/<collectionId>/<docId>/`
- 文件名：`original.<ext>`，扩展名由服务端白名单决定，不使用用户上传的文件名。
- sidecar：
  - `parsed.json`：`KbBlock[]` + `parseMeta`
  - `clean.txt`：清洗后全文
  - `chunks.json`：切片预览（可选，便于导出/重建）
- DB 只存相对路径 `original_path`；读取时用 `resolve` 拼接并校验必须在根目录内。

### 5.3 校验与限制

| 项 | 规则 |
|---|---|
| 单文件 | ≤ 50MB；图片 ≤ 20MB |
| 单次 | ≤ 20 个文件、总计 ≤ 200MB |
| 扩展名 + magic | 扩展名与 magic 必须同时匹配；Office 还校验 ZIP 内 `[Content_Types].xml` |
| ZIP 炸弹 | 解压总大小 ≤ 200MB、条目 ≤ 2000、单条目解压比 ≤ 100 |
| PDF | ≤ 300 页；超过提示拆分 |
| 文本编码 | UTF-8 优先；失败尝试 GB18030；仍失败报“编码无法识别” |
| 去重 | 同公司 + 同 collection + `content_hash` 相同 → 复用已有 `docId`，不重复切片 |
| 文件名 | 仅用于标题展示，HTML 转义；不参与路径 |

### 5.4 内容安全

- 上传文件只落本地数据目录，不进入工作区共享目录，避免成员通过工作台直接读取未授权原文件。
- 解析结果、清洗结果、切片预览都走知识库 ACL；未授权成员只能看到检索命中片段，不能下载原文。
- HTML 解析只提取文本，不执行脚本、不加载外部资源；去除 `script / style / iframe`。
- DOCX/XLSX/PPTX 只读 ZIP 内的 XML，不执行宏、不解析外部 OLE。

---

## 6. 解析器

统一输出：

```ts
interface KbBlock {
  id: string
  text: string
  type: 'heading' | 'paragraph' | 'list' | 'table' | 'code' | 'image'
  headingPath: string[]
  pageNo?: number
  sheetName?: string
  rowRange?: [number, number]
  meta?: Record<string, unknown>
}
```

### 6.1 文件类型路由

| 类型 | 解析器 | 输出要点 |
|---|---|---|
| `txt / md / markdown` | `parseText` | 按标题（`#`）、空行、列表切块；保留代码块 |
| `csv` | `parseCsv` | 首行表头；按行组切块，保留列名；引号/换行按 CSV 规则 |
| `json` | `parseJson` | 对象/数组转可读文本；大数组按元素分组；保留 key 路径 |
| `html / htm` | `parseHtml` | 去脚本/样式；标题、段落、列表、表格；实体解码 |
| `docx` | `parseDocx` | 段落样式识别标题；表格转行文本；页眉页脚只在首页/尾页保留一次，避免重复 |
| `xlsx` | `parseXlsx` | 每个工作表独立；读取共享字符串、单元格类型；合并单元格展开；空行折叠 |
| `pptx` | `parsePptx` | 每页标题 + 正文 + 表格；页码 = slide 序号 |
| `pdf` | `parsePdf` | 先 `getTextContent()`；每页文本过短且页面有图像 → OCR；保留页码 |
| `png/jpg/jpeg/webp` | `parseImage` | 直接 OCR；保留图片序号 |

### 6.2 PDF 与 OCR

- PDF 文本层：`pdfjs-dist` 的 `getTextContent()`，按 `transform` 坐标还原行顺序；同一页文本 < 80 字符且页面有图像时判定为扫描页。
- 扫描页：用 `@napi-rs/canvas` 以 150 DPI 渲染为 PNG；单页 ≤ 4MB；最多 300 页；每页单独调用 `kb.ocr`。
- OCR 提示词：只做文字识别与版面顺序还原；保留段落、表格行列；不总结、不翻译、不补写。
- OCR 模型：`kb_collections.ocr_model_id` → `resolveModelForPurpose('kb.ocr')` → 若都没有，文档进入 `needs_config`，`pipeline_error` 明确写“扫描件需要配置 OCR 模型”。
- `@napi-rs/canvas` 已作为服务端依赖（`^1.1.1`）安装；缺失时进入 `needs_config`，错误码 `EAB_KB_OCR_RENDERER_MISSING`，不产生半截文档。
- 图片 OCR 结果为空时判失败，不把空字符串切片入库。

### 6.3 旧格式

`.doc / .xls / .ppt` 首版不解析，直接返回：

```
老式 Office 格式暂不支持，请用 Word/Excel/PPT 另存为 .docx/.xlsx/.pptx 后重新上传
```

不静默转成空文档。

---

## 7. 清洗

### 7.1 三种模式

| 模式 | 行为 | 适用 |
|---|---|---|
| `none` | 只做编码/换行统一，不去页眉页脚 | 原文必须逐字保留的合同、审计底稿 |
| `rules` | 默认；规则清洗 | 大多数文档 |
| `model` | 规则清洗 + `kb.clean` 模型清洗 | 扫描件、排版混乱、OCR 粘连 |
| `auto` | 有 `kb.clean` 路由走 model，否则 rules | 希望自动选择模型的默认配置 |

### 7.2 规则清洗（默认）

必须保留：标题层级、列表编号、表格行列、代码块、公式行、页码锚点。

允许处理：

1. 统一换行 `\r\n → \n`，去除行尾空白、零宽字符、控制字符；
2. 连续 3 个以上空行压成 1 个空行；
3. 重复页眉/页脚/页码/水印：同一文本在 ≥ 60% 页面重复出现才删除；只出现一两次的保留，避免误删正文；
4. OCR 断行：中文行末无标点且下一行以中文开头时合并；英文连字符 `-\n` 合并；
5. 全角/半角标点、空格规范；不改变数字、日期、金额、单位；
6. 表格：保留单元格分隔，空单元格用空串，不合并不同列；
7. 代码块：不压缩缩进、不改引号。

规则清洗输出两份：`raw_text` 原样保留，`clean_text` 为规则结果；页面可切换查看。

### 7.3 模型清洗（可选）

- 输入：规则清洗后的块（每批最多 12 块 / 6000 字），带前后各一块上下文；批次按原顺序汇总，有限并发 3。
- 输出 JSON：`{ "blocks": [{ "id": "...", "text": "..." }], "notes": [] }`。
- 允许：去页眉页脚残留、修 OCR 错字、补断行、统一标点、恢复表格行。
- 禁止：总结、改写事实、增删数字/日期/金额/人名、翻译、补写原文没有的内容。
- 校验：
  - 输出块数、id 必须与输入一致；
  - 数字/日期/金额集合与原文不一致 → 该块回退规则结果；
  - 单块长度变化 > 35% → 标记 `low_confidence`，默认回退；
  - JSON 解析失败重试 1 次，仍失败则该批回退规则结果，任务继续。
- 本地推理模型等待：单批最多 120 秒、单块补洗最多 90 秒；整篇预算按字符数/块数估算为“预估清洗 × 2.5 + 60 秒”，限制在 4~20 分钟，不再固定 4 分钟。
- 本地 vLLM 的 Qwen 系列默认关闭 thinking（`chat_template_kwargs.enable_thinking=false`），避免小批量请求长时间无正文。
- 单批失败只保留该批原文，不中断其它批次；整篇模型清洗失败时回退规则清洗并继续切片/索引，不把文档判成“流水线失败”。
- 推理占满输出预算：上游只返回 `reasoning_content`、没有正文时，自动用 8192 tokens 重试一次；二次仍为空才判定失败并回退。
- 机密文档：`classification='confidential'` 默认禁止外部云模型清洗；只有模型配置标记 `local_only` 或管理员显式开启 `allowConfidentialModelClean` 才允许。
- 成本：按块计费；任务记录 `model_tokens / model_calls`，可在库设置里设单篇上限（默认 20 万 token），超限停止模型清洗并保留规则结果。

### 7.5 大文件稳定与预计耗时

估算与进度由 `packages/server/src/kb-pipeline-estimate.ts` 统一计算，状态写入 `kb_docs.pipeline_progress / pipeline_stage_started_at / pipeline_timings_json`。

- 解析：`1.0 + 页数 × 0.5 + 图片数 × 2.8 + 字符 / 20 万` 秒。
- 清洗：批次数 = `max(ceil(块数 / 12), ceil(字符 / 6000))`；模型清洗 ≈ `5 + 批次数 × (7.6 + 批内字符 / 600 × 0.2)` 秒；规则清洗按字符量估算。
- 切片：`0.5 + 字符 / 10 万 × 0.4 + 切片数 × 0.003` 秒。
- 索引：有 embedding 模型时 `1.0 + ceil(切片数 / 32) × 0.5` 秒。
- 剩余时间：当前步骤有批次进度时按 `预估 × (1 - 进度)` 折算，再叠加后续步骤；失败/待配置不承诺剩余时间。
- 完成后写回实际耗时，四步浮层显示“预计 / 实际 / 全程耗时”；不足 1 秒显示“不到 1 秒”。
- 实测校准：README 8,485 字符 / 54 块 / 5 批，清洗 42.7 秒（预估 46 秒）；5.1 万字符 / 324 块 / 27 批，清洗 241.6 秒（预估 227 秒）、全流程 244.5 秒（预估 235 秒），223 个切片，无 `pipeline_error`。

### 7.4 “自动选择模型”

`clean_mode='auto'` 的解析顺序：

1. 库显式 `clean_model_id`；
2. `resolveModelForPurpose('kb.clean')`；
3. 若模型支持多模态且文档是图片/扫描 PDF，再看 `kb.ocr`；
4. 都没有 → `rules`，并在文档详情显示“未配置清洗模型，已使用规则清洗”。

不自动拿普通聊天模型做清洗，避免不可控成本和提示词越界。

---

## 8. 切片

### 8.1 统一切片器

```ts
interface ChunkOptions {
  maxTokens: number        // 默认 500
  overlapTokens: number    // 默认 80
  preserveTables: boolean  // 默认 true
  preserveCode: boolean    // 默认 true
}
```

流程：

1. 按 heading 分层；每个 heading 下聚合段落；
2. 段落优先在句号/问号/分号/换行处切；不把一句话从中间截断；
3. 表格整表或按行组切；每片重复表头；行组不超过 `maxTokens`；
4. 代码块整体保留，超过上限按空行切；
5. 相邻片保留 `overlapTokens` 的尾部上下文；重叠不跨越标题边界；
6. `token_count` 用估算：中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token，数字/符号按 2 字符 ≈ 1 token；不引入 tokenizer 依赖。

### 8.2 切片元数据

每个 chunk 写：

```json
{
  "headingPath": ["第三章 报销", "3.2 差旅"],
  "pageNo": 12,
  "sheetName": "差旅标准",
  "rowRange": [8, 22],
  "blockType": "table"
}
```

`heading` 列存 `第三章 报销 > 3.2 差旅`，供列表和引用展示。

### 8.3 幂等

- `chunkId = docId + ':' + ordinal + ':' + sha1(text).slice(0, 12)`；
- 重跑切片先按 `doc_id` 删除旧 chunk 与向量，再写入新 chunk；
- 内容未变时 `content_hash` 相同，跳过重切；
- 切片顺序保持原文顺序，不打乱；“重排序”只发生在检索候选阶段。

---

## 9. 向量索引

### 9.1 本地始终写

- 无论是否配置外部向量库，都先写本地 `kb_chunk_embeddings`；本地是开发机与降级路径的保证。
- 索引模型：库 `embedding_model_id` → `kb.embed` 路由；都没有则只做关键词检索，文档仍可上传/切片。
- 批量 32 条，维度/数量不一致整批判失败；单篇文档一个事务写本地向量。
- 多模型：`kb_chunk_embeddings` 复合主键允许同一 chunk 存多个模型；库设置里可列“对比模型”，索引任务按需补写，不默认全量双写（避免成本翻倍）。

### 9.2 外部镜像

- `vector_backend='qdrant'` 或 `'pgvector'` 且有可用连接时，本地写成功后异步镜像到外部。
- 外部写失败：本地保持 `indexed`，`kb_docs.pipeline_stage='indexed'`，另写 `vector_sync_status='degraded'` 与 `vector_sync_error`；后台每小时重试一次，最多 3 次，仍失败则页面显示“外部向量库同步失败，当前使用本地向量”。
- 不允许“外部写成功、本地写失败”的路径；本地是权威。

### 9.3 外部索引一致性

- 外部 payload 只放定位字段：`company_id / collection_id / doc_id / chunk_id / model_id / classification`；**不把 ACL 判定托付给外部库**。
- 检索返回后必须用本地 `kb_chunks` + `kb_docs` 校验：chunk 不存在、doc 已删除、collection 不可见 → 丢弃。
- 删除文档：先删本地，再删外部；外部删除失败进入补偿队列，补偿未完成前靠上面的本地校验兜底。
- 重建：`POST /api/console/kb/collections/:id/vector/reindex` 可全量重建外部索引；先清空外部 collection，再按本地 chunk 重放。
- 对账：`GET /.../vector/status` 比较本地向量数、外部点数、最近同步错误；不一致时给“重建”按钮。

---

## 10. 向量库接入数据连接

### 10.1 连接类型

| 类型 | 连接方式 | 探测 | 备注 |
|---|---|---|---|
| 本地 | 无 | 无 | 默认；SQLite `kb_chunk_embeddings` |
| Qdrant | 新 `kind='qdrant'` | `GET /readyz` + `GET /collections` | REST 6333；API Key 存 `secret_ref`；支持 TLS |
| pgvector | 复用 `kind='postgres'` | 原 PG 探针 + `SELECT extversion FROM pg_extension WHERE extname='vector'` | 不新增连接类型；扩展缺失时不能选为向量后端 |

### 10.2 页面

「连接与平台 → 数据连接」增加“向量数据库”分组：

- Qdrant 卡片：`:6333`，字段 名称 / 主机 / 端口 / TLS / API Key / Collection 前缀 / 启用。
- PostgreSQL 行增加能力徽标：`pgvector 可用` / `未安装 pgvector`；只有 `vector_capability='pgvector'` 且 `status='ok'` 才能被知识库选中。
- 连接测试仍走现有草稿测试/已保存测试；Qdrant 测试不写任意命令，只读健康与 collection 列表。
- 连接新增/修改/测试成功后，知识库的可用后端列表热刷新；不重启服务。

### 10.3 知识库设置

知识库设置新增“向量后端”：

```
向量后端：本地 SQLite（默认） / Qdrant / pgvector
连接：<仅列出启用且可用的连接>
Collection 前缀：eab_
```

- `vector_backend='qdrant'` 时必须选一个 `vector_connection_id`；否则保存被拒绝。
- `vector_backend='pgvector'` 时只列 `vector_capability='pgvector'` 的 PostgreSQL 连接。
- `vector_backend='local'` 时不显示连接选择。
- 读取运行时配置直接查 `database_connections`，不读环境变量；环境变量只用于 EAB 自身数据库/Redis 后端，不覆盖这里。

### 10.4 降级链

```
外部向量（选中且健康）
  ↓ 失败/超时/未配置
本地向量（有 embedding 模型且已索引）
  ↓ 失败/无向量
关键词检索（始终可用）
```

- 健康检查缓存 30 秒；外部超时 3 秒，失败只写一次告警，不阻塞请求。
- 上传/索引阶段外部失败不改变文档可用性；检索阶段外部失败自动降级。
- 页面显示当前实际使用的后端：`本次检索使用：本地（外部 Qdrant 超时）`。
- 没有连接时所有功能仍可用，只是没有外部加速/大规模能力；不出现“知识库不可用”。

### 10.5 Qdrant 细节

- collection 命名：`eab_<companyHash8>_<collectionId>`；避免公司间碰撞。
- point id：`sha1(chunkId)` 转 UUID v5 形式；payload 存原始 `chunk_id`。
- payload 索引：`company_id`、`collection_id`、`model_id`、`doc_id`。
- 检索 filter：`company_id` + `collection_ids` + `model_id`；`classification` 作为附加条件，但最终以本地 PDP 复检为准。
- 维度：由 embedding 模型 `embedding_dim` 决定；同一 collection 切模型时新建 collection 或清空重建，不能混维度。
- 删除：按 `doc_id` / `chunk_id` payload 过滤删除；补偿任务重试。

### 10.6 pgvector 细节

- 使用现有 PostgreSQL 连接（`pg` 可选依赖）。
- 表按 `(company, collection, model, dim)` 建：`kb_vec_<hash>`，列 `chunk_id TEXT PRIMARY KEY, doc_id, collection_id, model_id, embedding vector(<dim>), norm`。
- 建表时 `CREATE EXTENSION IF NOT EXISTS vector` 需要权限；无权限则测试失败并提示“请让 DBA 安装/授权 pgvector”。
- 索引：数据量 < 10 万用 `ivfflat`（lists 按 sqrt(n)），> 10 万用 `hnsw`；建索引失败不阻塞写入，但检索退化为精确扫描并告警。
- 检索 SQL 使用 `embedding <=> $1` 余弦距离，按 collection/model 过滤，topK 取外部结果后回本地复检。
- 连接断开/超时 → 降级本地；外部表不存在 → 自动尝试建表，失败则降级。

---

## 11. 检索与召回测试

### 11.1 共用检索核心

`kb-retrieval.ts` 返回：

```ts
interface RetrievalResult {
  query: string
  mode: 'keyword' | 'vector' | 'hybrid'
  config: { topK: number; minVectorScore: number; keywordMinHits: number; rerank: boolean }
  stages: {
    keyword?: { count: number; ms: number }
    vector?: { count: number; ms: number; modelId: string; backend: 'local' | 'qdrant' | 'pgvector' }
    fusion?: { count: number; ms: number }
    rerank?: { count: number; ms: number; modelId: string }
  }
  hits: Array<{
    rank: number
    chunkId: string
    docId: string
    collectionId: string
    title: string
    text: string
    highlight: string[]          // 命中的 query 词/片段
    heading?: string
    pageNo?: number
    sheetName?: string
    scores: { keyword?: number; vector?: number; rrf?: number; rerank?: number }
    matchedTerms: string[]
  }>
  metrics: { hitCount: number; noResult: boolean; topScore: number }
}
```

- `mode` 可由库默认或测试台覆盖；线上对话默认 `hybrid`。
- `topK` 默认 4，测试台可 1–50；`minVectorScore` 0–1；`keywordMinHits` 1–10。
- `rerank` 开启但无模型时，不报错，stages 里写 `skipped: 'no_model'`。
- 问答引用仍走现有 `meta.citations`；额外带 `pageNo / heading / backend`。

### 11.2 管理端召回测试 UI

知识库详情页新增 tab：**召回测试**。

布局：

```
左：测试参数                 右：结果
[query 文本域]               [命中 3 条 · 42ms]
模式：关键词/向量/混合        1. 员工手册.pdf · 第12页 · 0.82
TopK：4                      “...年假申请需提前 3 个工作日...”
Rerank：开/关 + 模型          关键词 0.61 · 向量 0.78 · RRF 0.82
向量阈值：0.35                [高亮命中词]
关键词命中：2                ...
[运行测试]                   [保存为用例]
[批量用例] [模型对比]
```

结果区必须显示每一级的分数和耗时，方便判断“是召回没召到，还是 rerank 排错了”。

### 11.3 测试用例

- 保存：query、期望 docIds/chunkIds、标签、备注。
- 批量运行：勾选用例 → 跑当前配置 → 输出：
  - `hit@k`：期望文档是否出现在前 k；
  - `recall@k`：期望片段命中比例；
  - `MRR`：第一个正确结果排名的倒数；
  - `noResultRate`；
  - 总耗时与每条耗时。
- 用例不自动删除；只清理测试运行记录。用例正文很小，长期保留不会造成大占用。
- 用例可导入/导出 JSON（P2）。

### 11.4 模型对比

当前已落地 **embedding 模型对比**：页面列出 `kb_chunk_embeddings` 中该库已有向量的 `modelId`，逐个用同一 query / mode / topK / 阈值 / rerank 跑一次，并排显示 Top1、Recall@K、MRR、命中数、耗时；每次对比结果照常写 `kb_test_runs`，同样受保留期清理。没有其他模型向量时明确提示“该知识库还没有可对比的向量模型索引”，不偷偷用别的向量。

待实施：**rerank 模型 A/B 并排**、**关键词 / 向量 / 混合三种模式并排**、**批量用例一键跑全量**。

对比结果并排显示，不覆盖单次测试结果；可保存为 `kb_test_runs`，同样受保留期清理。

### 11.5 保留期清理

- 设置项：系统 → 系统与运维 →「日志、审计与数据保留」→「知识库测试记录保留天数」，默认 30，范围 1–365；保存后同步到所有知识库并重算已有记录的过期时间。
- 清理任务：
  - 启动时执行一次；
  - 每 6 小时执行；
  - 删除 `expires_at < now` 的 `kb_test_runs`；
  - 当前删除过期记录，不在清理日志中写 query 和命中正文；审计事件待补。
- 页面在“测试记录”里显示“最近清理时间 / 下次清理时间 / 当前保留天数”。

---

## 12. 权限与安全

1. **ACL 不变**：仍按 collection ACL + 密级做前置过滤；外部向量库返回后必须本地复检。
2. **原文不越权**：上传的原始文件只存数据目录，只有 `kb:read` 且 collection 可见的成员能通过文档详情下载；检索命中只返回片段，不返回整篇原文。
3. **清洗模型边界**：机密文档默认不允许外部云模型清洗；模型调用记录 `model_id / tokens / 耗时`，不记录正文到审计。
4. **路径安全**：所有落盘路径由服务端生成，读取时校验 `resolve(path)` 在知识库根内；拒绝 `..`、绝对路径、符号链接逃逸。
5. **文件安全**：扩展名 + magic + ZIP 结构三重校验；不执行宏、不解析外部 OLE、不渲染 HTML 脚本。
6. **审计**：上传、重跑、清洗模型调用、切片编辑、召回测试、重建向量、清理记录都写 `appendAudit`；审计不写正文、密码、API Key。

---

## 13. 管理端页面改造

### 13.1 知识库详情

新增三个 tab：

| tab | 内容 |
|---|---|
| 文档 | 现有列表 + 阶段徽标 + 失败原因 + “重跑解析/清洗/切片/索引” |
| 召回测试 | 参数、结果、用例、批量、对比、历史 |
| 设置 | 清洗模式/模型、OCR 模型、切片参数、rerank、向量后端、测试保留天数 |

文档行增加：

```
员工手册.pdf   PDF · 12页   已索引   清洗：规则   切片 86   [查看] [重跑] [删除]
```

文档详情改为 Dify 式四步浮层，不再一屏铺开全部信息：

1. 固定头部：文档名、版本、页数/切片数、总状态、降级标记。
2. 四步轨道：解析 → 清洗 → 切片 → 索引，每步显示编号和状态（未开始 / 处理中 / 已完成 / 已降级 / 失败），可点击直达。
3. 中间只渲染当前步骤：
   - 解析：页数、原始字符、解析状态、原始文本预览；
   - 清洗：清洗方式与模型、原始/清洗后字符、变化比例、清洗前后并排预览、降级原因；
   - 切片：切片数量、平均 tokens、前 50 条切片；
   - 索引：关键词切片数、向量条数、文档版本、索引流向与失败原因。
4. 固定底部：上一步 / 下一步 / 完成 / 关闭，以及“重跑当前步骤”。
5. 打开时按状态落到最需要看的一步：有降级 → 清洗；失败 → 失败步骤；已索引 → 索引；运行中 → 当前阶段。
6. 运行中每 1.8 秒轮询进度并自动跟随；用户点步骤或上一步/下一步后停止跟随，并提供“回到当前步骤”；任务结束后停在用户正在看的步骤。
7. 预览按需请求，不在打开弹窗时一次性读取原文、清洗文和全部切片。
8. 文档清单服务端分页：底部显示总篇数、每页 10/20/50 条和页码；删掉最后一页最后一条时，后端自动回退到仍存在的上一页。

### 13.2 上传弹窗

- 替换现有“只选 txt”的文件选择器；支持拖拽、多文件、文件类型/大小提示。
- 每个文件可单独设置清洗模式；默认继承库设置。
- “高级选项”折叠：清洗模型、OCR 模型、切片大小/重叠、分类。
- 上传后不阻塞在弹窗：关闭弹窗，文档列表出现“解析中”并轮询阶段。
- 失败行展示 `pipeline_error` 和“重试”按钮；`needs_config` 展示配置入口链接。

### 13.3 数据连接页

- 驱动条增加 Qdrant `:6333` 与“向量数据库”分组。
- 表格增加“能力”列：`pgvector 可用 / 未安装 / Qdrant`。
- 新增/编辑弹窗按类型切换字段；Qdrant 的 API Key 输入与现有密码字段一致，保存后只显示“已配置”。
- 测试结果写 `status_detail`，例如 `Qdrant 1.12 · 12 collections`、`PostgreSQL 18.7 · pgvector 0.8.0`。

### 13.4 空状态与错误文案

- 没有向量连接：知识库设置显示“未连接外部向量库，使用本地 SQLite；可继续使用关键词/本地向量检索。”
- Qdrant 超时：测试页显示“外部向量库超时，本次已降级到本地向量。”
- 扫描件缺 OCR：文档行显示“需要配置 OCR 模型”，按钮直达模型用途路由。
- 旧格式：上传前直接拒绝，不进入队列。

---

## 14. API 清单

### 14.1 上传与流水线

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/console/kb/collections/:id/docs?page=&pageSize=` | 文档分页列表，返回 `pagination` 与全库 `totalChunks`；`pageSize` 支持 1–50，后台默认 10 |
| POST | `/api/console/kb/collections/:id/docs/upload` | multipart 上传，创建文档 + 流水线任务 |
| GET | `/api/console/kb/docs/:docId/pipeline` | 阶段、错误、任务、页数、模型 |
| POST | `/api/console/kb/docs/:docId/pipeline/retry` | 从指定阶段重跑 `{ stage }` |
| GET | `/api/console/kb/docs/:docId/preview?kind=raw\|clean\|chunks` | 预览三份内容 |
| PATCH | `/api/console/kb/docs/:docId/chunks/:chunkId` | 手工修正切片文本（写审计） |
| GET | `/api/console/kb/docs/:docId/original` | 下载原文（ACL 校验） |

### 14.2 检索测试

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/console/kb/collections/:id/retrieval-test` | 单次测试，body 含 query/mode/topK/rerank/minVectorScore/keywordMinHits |
| POST | `/api/console/kb/collections/:id/retrieval-test/batch` | 批量用例 |
| POST | `/api/console/kb/collections/:id/retrieval-test/compare` | 模型/模式对比 |
| GET | `/api/console/kb/collections/:id/test-cases` | 用例列表 |
| POST | `/api/console/kb/collections/:id/test-cases` | 新建用例 |
| PATCH | `/api/console/kb/collections/:id/test-cases/:caseId` | 更新/停用 |
| DELETE | `/api/console/kb/collections/:id/test-cases/:caseId` | 删除用例 |
| GET | `/api/console/kb/collections/:id/test-runs` | 测试记录 |
| DELETE | `/api/console/kb/collections/:id/test-runs/:runId` | 手动删除 |
| GET/PATCH | `/api/console/kb/collections/:id/test-settings` | 保留天数 |

### 14.3 向量

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/console/kb/collections/:id/vector/status` | 本地/外部点数、后端、最近错误、可用连接 |
| POST | `/api/console/kb/collections/:id/vector/reindex` | 重建外部索引 |
| POST | `/api/console/kb/collections/:id/vector/verify` | 对账（本地 vs 外部） |

### 14.4 数据连接

沿用现有 `/api/console/databases`，扩展：

- `GET` 返回 `drivers` 含 `qdrant`，连接视图含 `vectorCapability`。
- `POST/PATCH` 接受 `kind='qdrant'`、`options.collectionPrefix`、`tls`。
- `POST /:id/test` 对 Qdrant 执行健康/collections 探测；对 PostgreSQL 额外检测 pgvector 扩展。

---

## 15. 验收矩阵

| # | 场景 | 必须观察到 |
|---|---|---|
| 1 | 上传带文本层的 PDF | `uploaded → parsing → parsed → cleaning → cleaned → chunking → chunked → indexed`；页数、页码正确 |
| 2 | 上传扫描 PDF（已配 OCR） | 每页 OCR 文本进入切片；`pageNo` 正确；无空页被当成功 |
| 3 | 上传扫描 PDF（未配 OCR） | 文档 `needs_config`，错误明确指向 OCR 模型；不产生空切片 |
| 4 | 上传 docx/xlsx/pptx | 标题/表格/工作表/幻灯片页码保留；表格切片重复表头 |
| 5 | 上传图片 | OCR 文本入库；空结果判失败 |
| 6 | 上传 `.doc` | 明确提示另存为 `.docx`，不进入队列 |
| 7 | 规则清洗 | 页眉页脚/页码删除；正文数字、日期、金额不变；raw/clean 两份可看 |
| 8 | 模型清洗 | 输出块 id 对齐；数字变化回退；JSON 失败回退；机密文档默认拒绝外部模型 |
| 9 | 切片 | 默认 500/80；标题边界不跨；表格行组带表头；chunk 元数据完整 |
| 10 | 单次召回测试 | topK/模式/阈值/rerank 可调；结果含 keyword/vector/rrf/rerank 分数与耗时 |
| 11 | 批量用例 | recall@k、MRR、top1 命中、无结果率正确 |
| 12 | 模型对比 | rerank A/B 并排；embedding 模型无索引时提示补建，不伪造结果 |
| 13 | 测试记录清理 | 设置 1 天，隔天记录被删；审计只记条数 |
| 14 | Qdrant 连接 | 测试成功；索引后外部点数增加；检索 backend=qdrant |
| 15 | Qdrant 断开 | 检索自动降级本地，结果仍返回；页面显示降级原因 |
| 16 | pgvector 连接 | 检测扩展；建表/写入/检索成功 |
| 17 | pgvector 扩展缺失 | 连接仍可用但不可选为向量后端；提示安装/授权 |
| 18 | ACL | 机密库/无权 collection 检索不到；外部向量返回后被本地复检丢弃 |
| 19 | 无 PG/Redis 开发机 | 上传/切片/本地向量/关键词检索全部可用 |
| 20 | 服务重启 | `pending` 任务继续；`running` 失锁任务重新领取；无半截文档 |

---

## 16. 分期实施

### P0：可用的文件知识库（先做）

1. 迁移 `0067`（不含测试表可拆到 P1，但建议一次建好）；
2. 上传 multipart + 落盘 + 校验 + 去重；
3. `parseText / parsePdf / parseDocx / parseXlsx / parsePptx`，先不做 OCR；
4. 规则清洗 + 统一 `kb-splitter`；
5. `kb_ingest_jobs` + 进程内 worker + 阶段 API；
6. 文档列表阶段徽标 + 三份预览 + 重试；
7. 本地向量索引兼容多模型表；
8. 验收 1、4、6、7、9、19、20。

### P1：清洗模型 + OCR + 测试台

1. `kb.ocr`、`kb.clean` 用途位与模型路由；
2. 扫描 PDF 渲染 + 图片 OCR（`@napi-rs/canvas` 可选依赖）；
3. 模型清洗 + diff + 数字校验 + 机密策略；
4. `kb-retrieval.ts` 抽取，对话与测试台共用；
5. 召回测试 UI、用例、批量、rerank 模型对比；
6. 测试记录表 + 保留天数 + 清理任务；
7. 验收 2、3、5、8、10、11、12、13。

### P2：外部向量库

1. `0068` 数据连接迁移；
2. Qdrant 驱动 + 探针 + 页面；
3. pgvector 能力检测 + 适配器；
4. 知识库向量后端设置 + 降级链；
5. 外部镜像、删除补偿、对账/重建；
6. 验收 14、15、16、17、18。

> P0 不依赖 P1/P2；P1 不依赖外部向量库；P2 可在 P0/P1 完成后独立上线。任何阶段都不能让开发机失去“纯本地可用”的路径。

---

## 17. 风险与取舍

| 风险 | 处理 |
|---|---|
| 扫描 PDF 渲染依赖原生库，Windows/Linux 安装不一致 | `@napi-rs/canvas` 作为可选依赖；缺失时 `needs_config`，不静默失败；发布包做双平台安装检查 |
| 模型清洗改写事实 | 数字/日期/金额校验 + 长度阈值 + 默认回退 + 机密禁用外部模型 |
| 外部向量库双写不一致 | 本地权威、外部镜像、检索后本地复检、删除补偿、对账重建 |
| Qdrant 维度/collection 混用 | collection 按公司+库命名；切模型必须重建；写入前校验维度 |
| pgvector 扩展/权限缺失 | 探针检测 + 明确提示；不可选为后端；自动降级本地 |
| 测试记录占空间 | 默认 30 天、可配 1–365 天、每日硬删、只存摘要 |
| 多模型向量成本翻倍 | 默认只索引主模型；对比模型按需补建，不默认双写 |
| 切片质量下降 | 统一切片器 + 预览 + 手工修正 + 用例回归；上线前用现有文档做 20 条回归 |
| 任务表与旧 `kb_index_jobs` 重叠 | `kb_ingest_jobs` 管全流程，`kb_index_jobs` 只做向量子任务；页面以 `pipeline_stage` 为准，避免两套状态打架 |

---

## 18. 与现有文档/代码的衔接

- 本文是知识库升级的详细设计；架构文档第 10 章保留总体口径，并在 10.11 增加“本轮升级方案”索引。
- `docs/database-connections.md` 已增加“向量数据库连接（方案已定稿，待实施）”章节，并明确当前能力仍以第 1–7 节为准，不把规划写成已落地。
- 数据库迁移从 `0067` 开始；不修改已应用的 `0030` / `0047`，新表/新列通过新迁移前向兼容。
- 现有 `retrieveKb` 的 ACL、RRF、rerank 行为保持不变；新增的测试台只是把同一核心的参数和中间结果暴露出来。
- 现有 `kb.search` 工具继续走 `retrieveKb`；升级后自动获得页码/标题/外部后端信息，不改变工具入参。

---

## 19. 本轮不写入代码的范围

本文只定稿方案，不改代码、不执行迁移。下一步按 P0 第 1 项开始：先加 `0067_kb_pipeline.sql`、统一 `kb-splitter` 与上传/流水线骨架，再逐项接 UI 和验收。
