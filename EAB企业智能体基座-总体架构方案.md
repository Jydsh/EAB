# EAB 企业智能体基座 — 总体架构方案与需求规格

> **版本**：v2026.11.07（日期版本号，与根 `package.json` 的 `version` 一致）
> **项目代号**：EAB（Enterprise Agent Base）
> **文档性质**：架构决策 + 需求规格 + 工程规范，是开发的**唯一上游依据**。代码实现与本文件冲突时，以本文件为准；本文件有错时，先改本文件再改代码。
> **本次修订**：2026-11-07，在第一版架构草稿基础上补齐「架构再设计分析与决策记录（ADR）」「需求规格说明书（FR/NFR/用例/验收）」「领域模型与数据字典」「接口契约」「工程结构与任务分解」。
> **阶段**：架构与需求已定稿（第一章 ADR），基座（M0 切片 A+B）已实现；**模型能力/用途路由与知识库向量化（P0/P1）已落地并通过类型检查、迁移与单测**；决策/语音/视频已留端点与用途位，尚未实现调用。后续按第 20 章路线推进。

**阅读指引**

| 你的角色 | 建议先读 |
|---|---|
| 决策者 | 0 定位、1 架构再设计、20 分期路线、22 待拍板事项 |
| 架构/开发 | 1–13 章（架构主体）、15 数据字典、16 接口契约、18 工程结构 |
| 需求确认 | 14 章（用例 + FR 编号表 + NFR + 验收标准） |
| 运维 | 13 部署运维、19 测试与安全验证 |
| 未来接手者 | 全篇，重点看 ADR 与「明确不做」 |

---

## 目录

- 0. 定位：企业受控 Agent 运行时
- 1. 架构再设计：备选方案对比与决策记录（ADR）
- 2. 产品形态与端
- 3. 总体分层架构与进程模型
- 4. 技术选型（含"明确不用什么"）
- 5. 磁盘工作区规范
- 6. 身份、组织与登录
- 7. 权限模型（三层混合 + 谓词下推）
- 8. 渠道接入（飞书 / 钉钉 / 企微）
- 9. 插件体系（进程隔离 + 能力令牌）
- 10. 知识库（同库向量 + ACL 双检）
- 11. Agent 运行时（Turn 状态机 + 工具鉴权）
- 12. 客户端与协议
- 13. 部署、运维与可观测
- 14. 需求规格说明书（用例 / FR / NFR / 验收）
- 15. 领域模型与数据字典
- 16. 接口契约（HTTP / SSE / WS / 插件 SDK）
- 17. 关键流程时序
- 18. 工程结构与开发规范
- 19. 测试与安全验证策略
- 20. 分期路线与任务分解
- 21. 风险登记册
- 22. 需要拍板的事项（附推荐）
- 附录 A 术语表 / 附录 B 参考与对标

---

## 0. 定位：企业受控 Agent 运行时

### 0.1 一句话定义

**EAB 是一个可单机部署、长期驻留、能被企业 IT 接管的企业级 Agent 运行时。**
组织、身份、权限、数据隔离是它的**原生内核**；插件、Agent、知识库、多渠道、多端都是长在这套鉴权与审计骨架上的能力。

它不是"给 AI 加个登录框"，也不是"给 DSH 套一层壳"，而是**换掉地基**：把"谁能用、能对什么数据做什么动作"变成第一等公民，模型和工具只是被管制的执行者。

### 0.2 与 DSH 的差异

| 维度 | DSH（现状） | EAB（本项目） |
|---|---|---|
| 身份 | 无原生身份，userId 透传 | 原生身份 + 三渠道 OAuth + OIDC + 组织树同步 |
| 权限 | 无 RBAC，插件拿到全量上下文 | RBAC(功能) + ABAC(属性) + ReBAC(关系) 三层，单一 PDP |
| 数据 | 全局共享工作区 | 公司/部门/用户三级磁盘分区 + 统一 `ResourceRef` 抽象 |
| 插件 | 自由安装，超级权限，同进程 | 安装需审批，能力需声明，**默认进程外**，能力令牌 + 双重校验 |
| 渠道 | IM 桥接（外部插件补齐），senderId 易丢失 | 飞书/钉钉/企微 原生连接器 + 签名后构造的事件信封 + 绑定表 |
| 端 | 桌面为主 | Web 控制台 + 员工端 + 移动端 + 访客门户 |
| 存储 | 本地 SQLite | SQLite 单机 / PostgreSQL 企业双模式（同一套 schema 抽象） |
| 可恢复性 | 会话内存态 | Turn 持久化状态机，审批/工具中断后可恢复 |
| 审计 | 无 | append-only + 哈希链，可做合规取证 |

### 0.3 范围边界（做什么 / 不做什么）

**做（本期范围内）**

1. 私有化部署：单机（Windows/Linux）或单机 + 外置 PG/对象存储，一条命令安装、可服务化常驻。
2. 身份与组织：本地账号、飞书/钉钉/企微扫码登录、OIDC；部门树、成员、离职回收同步。
3. 受控 Agent：多轮对话、工具调用、流式输出、审批中断与恢复。
4. 插件体系：npm / github / file / tgz 安装源，能力声明、审批、进程隔离、能力令牌。
5. 知识库：公司/部门/个人三级，入库管线、ACL 感知检索、引用溯源、制度问答模板。
6. 渠道机器人：三渠道消息接入、senderId 鉴权、群聊域映射、卡片审批。
7. 管理与审计：组织/角色/权限矩阵、插件审批、模型与渠道配置、审计查询、配额。
8. 四端：管理控制台、员工端、移动端壳、访客门户。

**不做（明确排除，防止范围漂移）**

| 排除项 | 原因 |
|---|---|
| 低代码流程编排引擎（BPM / 表单 / 审批流设计器） | 与权限内核正交，用现成系统（JeecgBoot/宜搭）更划算；EAB 只提供审批**能力**不是审批**平台** |
| 通用 RPA / 桌面操控 | 可做成后续插件，不进内核 |
| 模型训练 / 微调 / 评测平台 | 只做模型**接入与路由** |
| 面向外部客户的 SaaS 计费与运营后台 | 多租户 schema 预留，但本期不做计费 |
| IM 替代品（自建聊天、通讯录 UI 全套） | 复用渠道，不做第二套 IM |
| DSH 插件 100% 兼容 | 见 ADR-14，只保证已知插件可用 |
| 无限扩展的高并发集群 | 单机优先，多实例只做"能横向加"，不做分布式调度 |

### 0.4 核心原则（代码层强制，不靠约定）

| 编号 | 原则 | 落地方式 |
|---|---|---|
| P1 | **权限在内核，不在插件** | 任何能力调用必经 PDP，插件没有旁路 |
| P2 | **唯一入口** | 文件必须过 `WorkspaceResolver`，数据必须过带 `ScopeFilter` 的 Repository，禁止裸路径/裸查询 |
| P3 | **默认拒绝** | 未显式授权一律 deny；新插件零能力 |
| P4 | **谓词下推** | 列表类查询必须在 SQL 层带权限谓词，**禁止"先查全量再内存过滤"** |
| P5 | **四段式插件管控** | 声明 → 审批 → 令牌 → 运行时校验，缺一不可上线 |
| P6 | **一切可审计** | 谁、何时、对什么资源、做了什么、结果如何，写审计流 |
| P7 | **状态可恢复** | 长流程（审批、工具执行）落库，进程重启不丢、可续跑 |
| P8 | **单机可跑、可平滑变大** | 默认单机；多实例时靠"会话粘滞 + 单写者锁"过渡，不做分布式重构 |

---

## 1. 架构再设计：备选方案对比与决策记录（ADR）

### 1.1 第一版架构没回答的三个问题

第一版画了漂亮的分层图，但真正决定工程成败的是下面三件事，它都没有给出答案：

1. **进程边界在哪？** 插件、文档解析、embedding 是跑在主进程里，还是独立进程？跑在主进程 → 一个插件死循环拖垮全服务；跑独立 → 谁来做 RPC、谁来做超时与配额。
2. **权限怎么落到 SQL？** 只写"PDP 决策"是不够的。列表页、检索、审计查询都是"按条件取一堆数据"，如果决策发生在取数之后，性能和正确性双输（先查后滤既慢又会漏）。
3. **插件隔离做到什么程度？** 第一版把"进程级沙箱"放到 V2，这对一个号称"企业基座、可装第三方插件"的产品是**顺序错误**：卖点就是隔离，不能等。

### 1.2 候选方案对比

| 维度 | A 模块化单体（自研，推荐） | B 微服务 | C 嵌入式内核（做成 SDK） | D 开源平台二开（Dify/FastGPT/JeecgBoot） |
|---|---|---|---|---|
| 部署成本 | 单进程 + N 个 worker，一条命令 | 需网关/注册中心/多容器，运维重 | 最低（被宿主自带） | 中（原平台已在跑） |
| 权限改造难度 | 低（从第一天就在内核） | 中（鉴权要跨服务传播 subject 与 traceId） | 低 | **高**（侵入原平台数据模型，升级会冲突） |
| 插件隔离 | 进程外 worker，天然隔离 | 天然隔离，但调度复杂 | 取决于宿主 | 一般做不到（平台插件模型固定） |
| 迭代速度（单人 + AI） | 快 | 慢（跨服务联调） | 快，但**没有产品形态** | 最快出 Demo，之后越改越慢 |
| 多租户 | schema 预留，单库足够 | 天然 | 跟随宿主 | 平台自带但不匹配企业组织模型 |
| 长期可维护 | 高（自己掌握契约） | 高但成本高 | 中（受宿主生命周期约束） | **低**（上游升级 = 大修） |
| 适配你的场景 | ★★★★★ | ★★★ | ★★★ | ★★ |

结论：

- **B 微服务**：本项目是"装到一台服务器长期跑"的产品，不是互联网 SaaS。微服务的收益（独立扩容）在单机形态下换不到，成本（分布式一致性、跨服务鉴权传播）立刻要付。**否决**，但保留"未来可横向拆"的模块边界（见 3.4）。
- **C 嵌入式内核**：适合"被别的系统集成"，但你要的是**能独立安装运行的服务**。**不作为主形态**，但作为**能力保留**：内核包（`core-*`）不依赖 HTTP、不依赖进程，只暴露库接口，`server` 只是装配壳。这样将来要给 JeecgBoot/钉钉应用做"内嵌 AI 基座"时，直接复用内核，不重写。
- **D 开源平台二开**：Dify/FastGPT 是工作流 + 应用编排导向，权限是"工作空间 + 成员角色"级别，**没有部门树、没有数据域、没有工具级 scope、没有插件能力审批**。要加就得改它的数据模型和中间件，上游每升一版都在还债。**否决**（但知识库解析、RAG 管线可以外接，见第 10 章）。
- **A 模块化单体**：**选定**。单进程主控 + 进程外 worker + 清晰包边界 + 分层依赖单向。野心放在"内核契约稳定"，不放在"服务拆得多"。

### 1.3 选定方案的形态

```
EAB = 1 个主控进程（eabd）+ N 个执行进程（eab-worker）+ 1 套 Web 前端 + 1 个 CLI
      内核能力以库形式沉淀（core-*），server 只做装配与暴露
```

这套形态同时满足：单机零运维、插件崩溃不拖垮主进程、内核可被复用、未来能横向拆服务。

### 1.4 架构决策记录（ADR）

> 格式：决策 / 理由 / 代价 / 什么情况下需要回滚。后续开发遇到争议，先回来查这张表；要改就新增一条 ADR 并注明取代关系，不要偷偷改代码。

#### ADR-01 进程模型：主控单实例 + 执行进程池

- **决策**：`eabd` 持有 HTTP/WS、认证、PDP、Turn 引擎、工具注册、插件宿主、渠道连接器；插件执行、文档解析、embedding、批量导入、高危工具放 `eab-worker`（独立 Node 进程，stdin/stdout JSON-RPC 或 loopback TCP）。
- **理由**：① 插件是第三方代码，必须能被杀掉；② 解析大 PDF、embedding 批处理会阻塞事件循环，主控一卡全站卡；③ worker 可独立限 CPU/内存/超时；④ 崩溃只影响单个能力。
- **代价**：多一层 RPC 与序列化；调试要跨进程（用 traceId 串起来）；worker 需要健康检查与重启熔断。
- **回滚条件**：只有"插件全部为内部可信代码"才考虑进程内，且必须写明风险。

#### ADR-02 不自研模型/知识库平台，只做"受控编排层"

- **决策**：不基于 Dify/FastGPT 二开；不自己做训练、标注、评测。模型接入做 Provider 适配器，知识库做 Provider 适配器（可外接火山/阿里/Dify 知识库 API）。
- **理由**：这些领域别人跑得比我们快；EAB 的差异化在**权限骨架**，不在 RAG 算法。
- **代价**：RAG 效果上限受外部 provider 约束；需要维护多 provider 适配。

#### ADR-03 权限 = RBAC + ABAC + ReBAC，单一决策入口 + 谓词下推

- **决策**：功能权限用 RBAC（scope 字符串）；数据范围用 ABAC（部门物化路径、归属、密级）；资源级关系用 ReBAC（owner / dept_member / project_member / chat_member）。三者统一进 `PDP.decide(subject, action, resource)`；列表查询用 `buildScopeFilter(subject, action)` **下推为 SQL 谓词**。
- **理由**：纯 RBAC 表达不了"本部门及下级"和"这个文件的共享人"；纯 ABAC 规则会爆炸；纯 ReBAC 对功能权限过度设计。混合是唯一能同时覆盖"能做什么"和"能对哪些数据做"的方案。
- **代价**：规则要可解释（每次决策能打印命中哪条规则）；缓存失效要精细。
- **红线**：`buildScopeFilter` 返回空（表示"无限制"）必须在类型上不可能——返回 `Never` 类型或抛异常，杜绝"忘了加过滤"。

#### ADR-04 存储：SQLite 默认，PostgreSQL 可选，schema 从第一天带租户列

- **决策**：驱动用 Node 内置 **`node:sqlite`**（WAL、`synchronous=NORMAL`、`busy_timeout`、`foreign_keys=ON`），查询走**手写 SQL + 参数绑定**，权限过滤由自研谓词 AST 编译成 SQL 谓词（`predicateToSql`）；PostgreSQL 走同一套表结构与同一套谓词编译（换 `?` 为 `$n`）。所有业务表第一列逻辑上必有 `company_id`（历史/审计类也带），软删除统一 `deleted_at`，时间统一 UTC 存（INTEGER 毫秒）、前端本地化显示。迁移用**手写 SQL 迁移文件 + 单一日志表（`_migrations`）**，不用 ORM 自动同步。
- **理由**：单机零运维是产品承诺；但企业客户一旦上规模必须能切 PG，schema 分叉会带来长期痛苦。
- **为什么不用 better-sqlite3 + Kysely**（2026-11-07 实现阶段修订）：`node:sqlite` 免原生编译，Windows 上省掉 node-gyp / VS Build Tools 一整条坑，"一条命令装到任何机器"的承诺才守得住；而 Kysely 官方没有 `node:sqlite` dialect，要用 Kysely 就得回到 better-sqlite3。另外我们的权限过滤已经是"谓词 AST → SQL"，查询构建器的类型推导帮不上忙，反而多一层依赖。**驱动隔离在 `packages/storage/src/db.ts` 单文件**，将来换 better-sqlite3 / libsql / Kysely 只改这一处。
- **代价**：手写 SQL 的字段名拼错不会被类型系统拦住（用"迁移即测试 + 字段白名单"兜）；SQLite 单写者，需要写队列；`node:sqlite` 仍是实验特性（有 ExperimentalWarning），升级 Node 大版本要回归一次。
- **回滚条件**：单表行数 > 500 万或并发写 > 50/s，切 PG（见 NFR 性能阈值）；`node:sqlite` API 出现不兼容变更且无法隔离，切 better-sqlite3。

#### ADR-05 向量与权限元数据同库（sqlite-vec 优先）

- **决策**：MVP 用 `sqlite-vec` 扩展，把向量和 chunk 的 ACL 标签放在**同一个 SQLite 文件**里；规模阈值后再切 `pgvector` 或 Qdrant。
- **理由**：双库（LanceDB + SQLite）最大的坑是**一致性**：删文档、改权限、换部门时，向量库和元数据库会不同步，出现"人已经没权限了但还能召回"。同库可以用一个事务解决。另外 ACL 过滤与向量检索能在一次查询里做，减少召回后再过滤导致的召回不足。
- **代价**：sqlite-vec 的 ANN 能力弱于专用库；百万级 chunk 需要分区（按 company/dept 建多张 vec 表）。
- **回滚条件**：单租户 chunk > 50 万且检索 P95 > 300ms，切 pgvector/Qdrant。

#### ADR-06 传输：HTTP + SSE 为主链路，WS 只做推送

- **决策**：对话主链路 `POST /conversations/:id/turns` → `text/event-stream` 流式返回；WebSocket 只承担服务端主动推送（审批待办、通知、在线状态、跨端同步）。不把 ACP 作为核心协议，只做可选适配层。
- **理由**：SSE 在企业代理、移动网络、断线重连场景比 WS 稳，且天然"一问一答"可幂等；WS 长连接在企微/内网代理下容易被掐。审批这类"服务端主动、可能离线"的场景才需要 WS/长轮询。
- **代价**：双通道要维护；断点续传需要事件序号。

#### ADR-07 Turn 持久化状态机，支持中断恢复

- **决策**：`conversation / turn / step / tool_call / approval` 五类实体全部落库；turn 有明确状态机（见 11.1），每次状态迁移写 journal；进程重启后扫描"非终态 turn"做 resume 或标记 `interrupted`。
- **理由**：审批可能挂几十分钟，人可能离线；工具可能跑几分钟；进程可能被重启或崩溃。内存态会话在这些场景下**必然丢工作**，而企业用户无法接受"审批完发现对话没了"。
- **代价**：状态机要严格，迁移不合法要拒绝；写库频率上升（用批量/节流）。

#### ADR-08 插件默认进程外 + 能力令牌 + 双重校验

- **决策**：每个插件一个 worker 进程；插件调用宿主能力走 RPC，宿主按**能力令牌**校验；校验条件是 **`插件被授予的能力 ∩ 当前用户的能力`**，两者都通过才执行。
- **理由**：① 进程外才叫隔离；② 只校验插件权限会形成"权限放大器"——插件有 `kb:read`，就能替任何用户读任何部门知识；③ 令牌绑定到"插件实例 + 安装记录 + 授权快照"，插件升级时能力变化必须重新审批。
- **代价**：进程池管理、冷启动延迟（用预热与空闲复用）；RPC 契约要版本化。

#### ADR-09 模型网关必须做流式错误归因

- **决策**：Provider 适配层区分三种终态：`finish`（正常）、`provider_error`（上游错误，含"HTTP 200 但 SSE 里塞 error / 空 chunk / 提前断流"）、`client_cancel`。**上游错误绝不允许落成正常 finish**，必须触发重试/降级链并记录真实原因。
- **理由**：这是踩过的坑——很多宿主把 provider 错误归一化成 finish 事件而不抛异常，导致容灾/换模型永不触发，用户看到"回答突然截断"却查不到原因。
- **代价**：要逐家 provider 写解析规则；要保存原始流片段用于排查（脱敏后）。

#### ADR-10 渠道统一事件信封 + 幂等键

- **决策**：所有渠道消息先归一为 `InboundEvent { eventId, channel, receivedAt, sender, content, verified }`；`eventId` 入去重表（主键），重复事件直接 ack 丢弃；senderId **只在签名校验通过后从事件体取**，绝不从消息正文解析。
- **理由**：三个渠道都会重推（超时重试、断线补推）；群聊/转发场景正文里可能伪造 `@某人` 或身份串；验证过的信封是唯一可信源。
- **代价**：去重表要清理窗口；不同渠道 eventId 语义不同，需要统一生成规则。

#### ADR-11 单公司本地部署（2026-11-08 修订）

- **决策**：产品形态是**一套实例只服务一家公司、一个组织架构**。公司由「钉钉扫码绑定组织」接入；控制台不提供新建第二家公司的入口，`GET /api/console/companies` 只返回配置里的唯一公司，旧的多公司账号不能登录员工页。schema 继续保留 `company_id` 并强制带 company 维度查询，方便未来升级，但产品不再暴露多公司切换。
- **两个入口分端口**：员工对话 `8787`（`EAB_PORT`）只注册 `/chat`、`/api/chat`、`/api/auth` 等员工面；管理控制台 `8788`（`EAB_ADMIN_PORT`）只注册 `/admin`、`/api/console` 等管理面。两个端口共用同一个库与审计，但通过 `surface guard` 互相 404，防止员工端口暴露管理接口、管理端口暴露员工对话；两个端口配置相同会直接启动失败。
- **理由**：本地部署客户只需要一套“自己的企业智能体”，多公司会立刻带来跨租户运维、计费、数据迁移、独立备份四座大山；但**不带 company 维度的 schema 后期迁移代价极高**。所以“逻辑上保留租户列、产品上单公司”。
- **许可**：源码可见但**不允许商用**，商业用途需单独书面授权（见根目录 `LICENSE`）。
- **代价**：一部分代码要传 companyId 但永远相等，显得冗余——接受；旧的 `c2` 演示数据成为不可登录的残留，删除唯一公司后回到空库再重新绑定。

#### ADR-12 审计与运行日志分离

- **决策**：`audit_logs` 是业务事实（append-only，带 `prev_hash` 形成哈希链，可按天归档，不可 UPDATE/DELETE）；运行日志（pino JSON）走文件/标准输出，带 `traceId`、可轮转、可丢弃。两者不共表、不共用采样策略。
- **理由**：审计要能取证、要能回答"谁在什么时候读了什么"，不能被日志轮转清掉；运行日志要能高频写、能被采样。混在一起两边都做不好。
- **代价**：双写开销；哈希链校验需要单独工具（`eab audit verify`）。

#### ADR-13 前端由"能力清单"驱动，不做前端权限判断

- **决策**：登录后 `GET /me/capabilities` 返回 `{ scopes: [], menus: [], featureFlags: {} }`，前端据此渲染菜单与按钮；**每个接口在后端独立再校验一次**。前端隐藏只是体验，不是安全边界。
- **理由**：前端判断必然被绕过；但前端也需要"知道该显示什么"，所以由后端下发能力清单，而不是前端硬编码角色。
- **代价**：新增功能要同步维护菜单注册表。

#### ADR-14 插件 API 版本化，DSH 只做适配不承诺兼容

- **决策**：清单必须声明 `eabApiVersion`（如 `1.0`）；宿主维护"兼容窗口"（当前大版本 + 上一大版本）。DSH 插件通过 `DSHCompatAdapter` 转换事件语义，**只保证已明确测试过的插件可用**，文档里写清楚。
- **理由**：DSH 内部契约不公开、不稳定，承诺 100% 兼容等于把上游的不稳定变成自己的技术债。
- **代价**：插件作者需要按 EAB SDK 重写一部分。

---

## 2. 产品形态与端

```
                  ┌───────────────────────────────────────┐
                  │      EAB 内核（主控进程 eabd）           │
                  │      + 执行进程池 eab-worker × N        │
                  └───────────────────────────────────────┘
     ┌────────────┬────────────┬────────────┬────────────┬──────────────┐
  Web 控制台    员工端 Web     移动端 App    访客门户     渠道连接器      CLI
 （管理/配置）  （对话/工作区） （一键登录）  （受限功能） （飞书/钉钉/企微）（运维）
```

| 端 | 使用者 | 身份来源 | 主要能力 | 关键约束 |
|---|---|---|---|---|
| Web 控制台 | 超管 / 公司管理员 / 部门管理员 / 审计员 | 本地登录 或 渠道扫码（需管理角色） | 组织树、角色矩阵、插件审批、知识库、渠道配置、模型配置、审计查询、配额 | 仅内网/白名单 IP；所有写操作留审计；高危操作二次确认 |
| 员工端 Web | 普通员工 | 渠道扫码 / 本地账号 | 对话、我的工作区（文件/会话/记忆）、我的权限页 | 默认 `self` 域；只能看自己 |
| 移动端 App | 普通员工 | 企业应用内 JSAPI 一键登录 | 同上 + 推送 | 只在本企业应用容器内可用；Token 存安全存储 |
| 访客门户 | 外部访客 | 邀请码 / 一次性链接 | 白名单功能（如公开制度问答、指定表单） | 独立限流、独立审计、不可触达 `/admin/*` 与组织数据 |
| 渠道机器人 | 企业 IM 用户 | 渠道签名事件 + 绑定表 | 对话、卡片审批、通知 | senderId 校验失败即拒；群聊不借权限 |

**统一约束**：所有端共用一个内核、一套鉴权、一个审计口径；端之间只在"展示与交互"上不同。

---

## 3. 总体分层架构与进程模型

### 3.1 逻辑分层

```
┌─────────────────────────────────────────────────────────────────────┐
│  接入层 Access                                                        │
│  · Fastify HTTP  · SSE 流  · WS 推送  · Session/JWT  · 限流            │
│  · 请求审计  · CORS/租户识别  · 幂等键  · 参数校验(zod)                │
├─────────────────────────────────────────────────────────────────────┤
│  身份与权限层 Identity & Permission                                    │
│  · Auth Providers（local / feishu / dingtalk / wecom / oidc）         │
│  · IdentityRegistry（subject 构造，只从已验证会话/绑定来）              │
│  · OrgSync（部门树 / 成员 / 岗位 / 离职回收）                          │
│  · Authz：RBAC + ABAC + ReBAC → PDP.decide() / buildScopeFilter()     │
│  · Approval（require-approval 的挂起、通知、恢复）                     │
├─────────────────────────────────────────────────────────────────────┤
│  Agent 运行时层 Agent Runtime                                         │
│  · Turn 状态机  · 上下文装配器（按数据域裁剪 + token 预算）             │
│  · 工具注册表（ToolDescriptor）  · 工具鉴权钩子                        │
│  · 模型网关（Provider 适配 / 路由 / 容错 / 配额）                      │
│  · 事件总线（turn/*、tool/*、approval/*、plugin/*）                    │
├─────────────────────────────────────────────────────────────────────┤
│  能力层 Capabilities                                                  │
│  · 插件宿主（安装/审批/进程池/能力令牌/RPC）                            │
│  · 知识库（入库管线 / ACL 检索 / 引用回链）                            │
│  · 工作区文件系统（公司/部门/用户三级 + Resolver + 配额）               │
│  · 记忆 / 通知 / 调度（延迟任务、重试、定时同步）                       │
├─────────────────────────────────────────────────────────────────────┤
│  资源层 Resources                                                     │
│  · SQLite(WAL) / PostgreSQL  · sqlite-vec / pgvector / Qdrant          │
│  · 本地磁盘 / 对象存储(S3/MinIO)  · 运行日志 / 审计流                   │
├─────────────────────────────────────────────────────────────────────┤
│  横切面 Cross-cutting（每层都要用的）                                  │
│  · 配置(热加载) · 密钥管理 · traceId 传播 · 配额计量 · 审计埋点         │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 进程模型（第一版没画的部分）

```
        ┌──────────────────────── eabd（主控，单实例） ────────────────────────┐
        │  HTTP/SSE 网关 · WS 推送 · 认证 · Subject 构造 · PDP                │
        │  Turn 引擎 · 上下文装配 · 工具注册 · 审批服务                       │
        │  插件宿主（管理侧：安装/审批/令牌签发）· 渠道连接器 · 调度器         │
        └───────┬──────────────────────────────────────┬──────────────────────┘
                │ RPC（UDS / loopback TCP，JSON-RPC）    │ Kysely / fs
        ┌───────▼──────────────┐              ┌────────▼─────────────┐
        │ eab-worker #1..N     │              │ SQLite / PostgreSQL   │
        │ · 插件进程（每插件1个）│              │ 工作区磁盘/对象存储     │
        │ · 文档解析/embedding  │              │ 审计流 / 日志文件      │
        │ · 高危工具/长任务      │              └───────────────────────┘
        └──────────────────────┘
```

**进程职责分工**

| 进程 | 必须做的事 | 绝不能做的事 |
|---|---|---|
| `eabd` | 鉴权、决策、状态机、编排、写库、审计 | 跑第三方代码、跑阻塞型重活（大文件解析、embedding） |
| `eab-worker` | 执行被派发的具体任务（插件 hook/tool、解析、向量化） | 直连数据库、直连工作区磁盘、自行构造 subject |
| 前端 | 渲染、交互、SSE 消费 | 任何权限判断作为安全依据 |

**worker 生命周期**：懒启动 → 预热 → 空闲 5 分钟回收 → 崩溃重启（连续 3 次失败进入 `broken` 状态并告警，不再自动重试，等人工介入）。每个 worker 有 CPU/内存/单次调用超时/每分钟调用数四项配额。

### 3.3 一次对话的端到端路径（12 步，每个模块的落点）

```
1  客户端 POST /conversations/:id/turns（带 Idempotency-Key）
2  接入层：认证 → 解析 JWT/会话 → 得到 userId/deviceId → traceId 生成
3  身份层：构造 Subject（userId, companyId, deptId, roles, dataScope, channelType）
          —— 只从已验证会话与绑定表构造，绝不从请求体读
4  运行时：会话级串行锁（同会话并发回合排队，避免上下文错乱）
5  运行时：Turn 落库 created → 上下文装配器按"数据域 + token 预算"取素材
6  运行时：按 Subject 裁剪工具清单（无权工具不出现在模型可见列表里）
7  模型网关：流式请求，SSE 增量推给客户端（附带事件序号）
8  模型输出 tool_call → 工具注册表查 ToolDescriptor（requiredScope/risk/审批策略）
9  权限层：PDP.decide(subject, 'agent:tool:invoke', toolRef)
          allow → 派发 worker 执行（带超时/配额）
          deny  → 返回结构化拒答给模型（模型改口，会话不断）
          require-approval → 生成审批记录，推卡片，Turn 进入 awaiting_approval
10 结果回填 → 上下文 → 继续模型流（或结束）
11 Turn 终态落库（completed/failed/cancelled），用量与耗时计量
12 审计 + 指标 + 通知（全程同一 traceId）
```

### 3.4 模块依赖规则（谁可以依赖谁）

```
web-admin / web-app / mobile        →  只能依赖 shared-types（HTTP 契约），禁止 import server/core 实现
server（Fastify 装配）              →  依赖 core-*、plugin-sdk（仅类型）
worker                              →  依赖 plugin-sdk、core-plugin-proto（RPC 契约），禁止依赖 core-storage
core-runtime                        →  core-authz、core-domain、core-storage(接口)
core-authz                          →  core-domain（纯计算，无 IO）
core-domain                         →  无依赖（领域模型、scope 常量、错误码）
```

**规则**：分层单向依赖，**不允许循环**；`core-domain` 与 `core-authz` 必须保持"可单元测试、无 IO"。违反者在 CI 里报错（用 `dependency-cruiser` 或自写检查）。

---

## 4. 技术选型（含"明确不用什么"）

### 4.1 选定

| 模块 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript 5.x，`strict: true` | 与 DSH 插件生态同栈；类型是权限边界的最后一道防线 |
| 运行时 | Node.js **≥ 22.5**（`node:sqlite` 内置；实测 22.23.2） | 跨 Linux/Windows 一致；原生 `fetch`、`AbortSignal`、内置 SQLite，免原生编译 |
| 包管理 | pnpm + workspace 单仓多包 | 插件安装协议直接用 pnpm 生态；软链即开发模式 |
| HTTP | Fastify 5 + zod（type provider） | 低开销、schema 校验内建、SSE 原生支持 |
| 流式 | SSE（`text/event-stream`） | 企业代理/移动网络友好，可带 `id:` 做断点续传 |
| 推送 | WebSocket（仅通知/审批/在线） | 服务端主动、低频、可降级为长轮询 |
| 数据库 | SQLite（`node:sqlite`, WAL，内置零编译）→ PostgreSQL | 单机零运维，企业可平滑切换；免原生编译（ADR-04 修订） |
| 查询/迁移 | 手写 SQL + 参数绑定 + 谓词 AST 编译；**不用 ORM/Kysely** | 权限过滤本来就是"谓词 AST → SQL"，多一层查询构建器帮不上忙 |
| 向量 | `sqlite-vec` → `pgvector` / Qdrant 适配器 | 与 ACL 元数据同库，避免双写不一致（ADR-05） |
| 前端 | React 19 + Vite + TanStack Router/Query + Tailwind + shadcn/ui | 控制台与员工端同一套组件，多端复用 |
| 移动端 | Capacitor（阶段一），React Native（阶段二） | 先快后精 |
| 进程托管 | systemd（Linux）/ winsw（Windows） | 长期运行、开机自启、崩溃重启 |
| 日志 | pino（JSON + 轮转） | 结构化、低开销、traceId 串联 |
| 指标 | prom-client（可选 `/metrics`） | 企业内网 Prometheus 可选接入 |
| 测试 | vitest（单测）+ Fastify `inject`（接口）+ 模拟渠道（集成） | 不依赖真实企业 IM 也能跑全链路 |
| 校验 | zod（请求/配置/插件清单） | 配置错误要在启动时炸，不要运行到一半才炸 |
| 代码质量 | eslint + prettier + dependency-cruiser | 分层依赖与循环依赖强制检查 |

### 4.2 明确不用（以及为什么）

| 不用 | 原因 |
|---|---|
| Prisma / TypeORM 重型 ORM | 多方言 + 多租户谓词注入 + 迁移审计，ORM 反而添乱 |
| Kysely（本期） | 官方没有 `node:sqlite` dialect，用它就得回到 `better-sqlite3`（Windows 上要装 VS Build Tools）；谓词下推我们自己已有 AST，收益不足。切 PG 时再评估 |
| Redis（MVP 阶段） | 单机不需要；并发锁、去重、队列都能用 SQLite 表实现；引入 Redis 等于多一个必须运维的组件 |
| Kubernetes | 产品承诺是"装到一台机器上长期跑"，不是云原生交付 |
| GraphQL | 权限下推和审计埋点在 GraphQL 上更难做准；REST + SSE 更直白 |
| 纯 WS 做对话主通道 | 代理/移动网络/断线场景不稳；SSE 更好恢复 |
| 自研 IM / 自研富文本编辑器 | 复用渠道与现成编辑器，别造第二套 |
| 前端自研状态机做权限 | 见 ADR-13，能力清单下发 |
| Dify/FastGPT 作为内核 | 见 ADR-02，只做外接 provider |
| Electron 桌面端（本期） | 与"单机服务 + Web 端"重复；后续可作为"通道适配器"插件 |

---

## 5. 磁盘工作区规范

### 5.1 根目录与目录树

根目录由配置指定（`storage.home`），默认：
- Linux：`/var/lib/eab`
- Windows：`%PROGRAMDATA%\EAB`
- 开发：仓库内 `./.eab-dev`（与生产隔离，见 9.12）

```
{EAB_HOME}/
├── eab.config.json                 # 主配置（密钥字段只存引用，不存明文）
├── eab.config.local.json           # 本地覆盖（.gitignore）
├── plugins/                        # 已装插件
│   └── plugin.lock.json            # 版本锁 + 来源 + 哈希 + 授权快照
├── data/
│   ├── system.db                   # 全局：用户/组织/角色/权限/审计/渠道绑定/插件/配额
│   ├── system.db-wal / -shm
│   └── companies/
│       └── {companyId}-{slug}/
│           ├── company.json
│           ├── knowledge/          # 公司级知识库原始文件
│           │   ├── policies/       # 制度（制度问答模板专用）
│           │   └── general/
│           ├── departments/
│           │   └── {deptId}-{slug}/
│           │       ├── dept.json
│           │       ├── knowledge/
│           │       └── users/
│           │           └── {userId}-{slug}/
│           │               ├── user.json
│           │               ├── workspace/      # 唯一可写区域
│           │               │   ├── files/
│           │               │   ├── artifacts/       # 生成物（图片、文档、报告）
│           │               │   ├── conversations/   # 会话导出/附件
│           │               │   ├── memory/          # 个人记忆
│           │               │   └── uploads/         # 用户上传原件
│           │               └── archive/        # 离职/冻结后的只读归档
├── tmp/                            # 临时文件（与 workspace 严格分离，按天清理）
├── backups/                        # 本地备份输出
└── logs/                           # 运行日志（可轮转、可删）
```

### 5.2 硬性约束（代码层强制）

| 编号 | 约束 | 实现要求 |
|---|---|---|
| WS-1 | 任何文件读写先调 `WorkspaceResolver.resolve(subject, ref)` | 返回 `FileHandle { rootId, companyId, scopeType, scopeId, relativePath, realPath, readonly }`，或抛 `AccessDeniedError` |
| WS-2 | 禁止裸路径拼接 | 全仓禁止出现 `path.join(basePath, userInput)`；CI 用正则拦截 `path.join(` + 变量 的可疑写法 |
| WS-3 | 路径穿越防护 | `relativePath` 必须规范化；拒绝 `..`、绝对路径、盘符、`\\?\`、UNC、Windows ADS（`file.txt:stream`）、保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）；**拒绝符号链接与硬链接**（防越界） |
| WS-4 | 插件不拿 basePath | 插件只能通过 `ctx.fs.read(handleRef)` 这类 API，句柄由宿主生成 |
| WS-5 | 用户 Agent 默认工作目录 = 自己的 `workspace/` | 越界需 `workspace:write` + `dataScope ≥ dept` + 目标部门与用户同链 |
| WS-6 | 目录名 `{id}-{slug}` | 重命名不影响引用，slug 只做人眼可读；slug 清洗为 `[a-z0-9-]`，长度 ≤ 40 |
| WS-7 | 配额前置检查 | 写前查 `quota` 表；默认个人 5GB、部门 50GB、公司 500GB（可配）；超限返回结构化错误 |
| WS-8 | Windows 长路径 | 超过 240 字符自动加 `\\?\` 前缀；大小写不敏感比较；ACL 继承由安装脚本显式设置 |

### 5.3 可见性递进（对应"有的用户能看到部门所有人，依次类推"）

| 角色 / dataScope | 能看到 | 对应 `buildScopeFilter` 输出 |
|---|---|---|
| `member` / `self` | 只有自己：自己 workspace、自己的会话与记忆 | `user_id = :userId` |
| `project_member` / `self+` | 自己 + 被加入的项目组共享区 | `user_id = :userId OR scope_id IN (:projectIds)` |
| `dept_admin` / `dept` | 本部门全部成员、部门知识库、部门共享文件 | `dept_path LIKE :deptPathPrefix` |
| `company_admin` / `dept_tree` | 本公司所有部门树、成员、公司知识库 | `company_id = :companyId` |
| `auditor` / `company` | 全公司**只读**审计、日志、配置快照（不含密钥） | `company_id = :companyId`（仅读动作） |
| `super_admin` / `global` | 跨公司运维（MVP 单公司，保留） | `1=1`（仅运维动作，且强制审计+二次确认） |
| `guest` / `self` | 仅被显式授予的功能页，不触达组织数据 | `user_id = :userId AND feature IN (:granted)` |

> 关键：`dept` 用**物化路径前缀**（`dept_path` 形如 `/c1/d10/d23/`）做范围判断，移动部门时批量更新子树 path，避免递归查询。

---

## 6. 身份、组织与登录

### 6.1 登录方式（四种，统一抽象）

```ts
interface AuthProvider {
  id: 'local' | 'feishu' | 'dingtalk' | 'wecom' | 'oidc'
  // 生成授权入口
  authorizeUrl(state: AuthState): string
  // 用 code / 凭证换身份
  exchange(input: ExchangeInput): Promise<ExternalIdentity>
  // 可选：组织同步
  syncOrg?(): Promise<{ departments: DeptNode[]; users: OrgUser[] }>
  // 机器人
  bot?: BotConnector
}
```

| Provider | 登录方式 | 说明 |
|---|---|---|
| `local` | 用户名密码（仅管理员与内网）/ 邀请码 | MVP 必做，保证无渠道审批时也能跑通全链路 |
| `feishu` | 网页扫码 OAuth + 移动端 `requestAuthCode` | 事件用长连接（WS），免公网 IP |
| `dingtalk` | 扫码 `getAuthCode` | 机器人用 Stream 长连接，免公网回调 |
| `wecom` | 扫码 OAuth2（`snsapi_privateinfo`） | 不支持长连接，需公网回调或内网穿透 |
| `oidc` | 标准 OIDC（企业统一身份/Azure AD/Keycloak） | 大企业常见，**必须有**，比三个 IM 更通用 |

### 6.2 外部身份 → 本地用户（绑定策略）

```
外部身份到达（ExternalIdentity { provider, externalUserId, unionId?, email?, mobile?, name? })
  ↓
1 查 user_identities(provider, external_user_id) 命中 → 直接取本地用户
2 未命中：按 unionId / email / mobile 找本地候选（唯一匹配才自动绑定）
3 仍无候选：
   - 策略 A（默认）：拒绝，返回"未开通账号"提示 + 申请入口
   - 策略 B：创建 pending 用户，管理员审批后激活
   - 策略 C（访客）：创建 guest，仅白名单功能
4 绑定关系写入 user_identities，后续同 provider 固定走命中
```

**红线**：绑定关系只允许"管理员确认"或"唯一匹配自动绑定"；**邮箱/手机唯一匹配冲突时必须拒绝**，不做"猜一个"。

### 6.3 用户生命周期状态机

```
invited ──激活──> active ──离职同步──> disabled ──归档期满──> archived
   │                 │                    │
   └──超时未激活──> expired            重新入职──> active（复用原 user_id 与工作区）
```

| 状态 | 对话 | 工具 | 工作区 | 数据可见 |
|---|---|---|---|---|
| `active` | 可用 | 可用 | 读写 | 按角色 |
| `disabled` | **拒绝** | **全部禁止** | **只读** | 仅审计可见 |
| `archived` | 拒绝 | 禁止 | 归档包（可下载） | 仅管理员审批后导出 |
| `guest` | 仅白名单功能 | 无 | 独立沙箱 | 仅自己被授予内容 |

**离职处理（关键安全点）**：渠道事件到达 → 立即置 `disabled`（**不等次日全量同步**）→ 吊销所有 session（`sessions.revoked_at`）→ 取消该用户会话锁与在途 turn（标记 `cancelled`）→ 工作区转只读。**不删数据**（保留期默认 90 天，可配）。

### 6.4 组织同步

| 项 | 设计 |
|---|---|
| 全量同步 | 每日定时（默认 02:00）+ 控制台手动触发；单次同步写 `org_sync_runs` 记录（耗时、新增、变更、失败项） |
| 增量同步 | 渠道事件（成员入职/离职/部门变更/角色变更）；无事件能力的渠道靠高频轮询（15 分钟） |
| 幂等 | 以 `channel_dept_id` / `channel_user_id` 为幂等键；重复事件不产生重复记录 |
| 冲突 | **渠道为准**（channel is source of truth）；本地只补充 `花名/工号/岗位/办公地点` 等渠道没有的字段，且标记来源 |
| 部门树 | 存 `parent_id` + `path`（物化路径）+ `order_no`；渠道部门 ID 与本地 ID 双向映射 |
| 失败处理 | 单部门失败不阻断整体；失败项进重试队列（指数退避，最多 5 次） |
| 规模预期 | 1000 员工 / 200 部门，全量同步 < 60s（见 NFR-P-05） |

### 6.5 会话与令牌

| 项 | 设计 |
|---|---|
| Web 会话 | `refresh` token 放 `httpOnly + Secure + SameSite=Lax` Cookie；`access` token 15 分钟，前端内存持有 |
| App 会话 | `access` + `refresh` 双 token，存系统安全存储（iOS Keychain / Android Keystore） |
| 刷新 | `POST /auth/refresh`，refresh 轮换（旧 token 立即失效，防重放） |
| 吊销 | `sessions` 表带 `revoked_at`；管理员可"踢下线"；离职自动全量吊销 |
| 设备管理 | `session.device_fingerprint` + `last_seen_ip`，控制台可查看与吊销 |
| 渠道机器人 | **不复用用户 session**：机器人侧每次消息都重新按 senderId 构造 subject（无状态、毫秒级） |

### 6.6 群聊与群身份（易漏的越权点）

| 场景 | 规则 |
|---|---|
| 群里 @机器人 | subject = **发送者个人**（个人角色 + 个人 dataScope）；群只作为"上下文域"提供历史，**不提权** |
| 群绑定部门/项目 | `chat_bindings(chat_id → scope_type, scope_id)`；绑定后群内可访问该 scope 的共享知识（仍受个人权限 ∩ 群域约束） |
| 未绑定群 | 只回"当前群未开通，请联系管理员绑定"，不做任何检索 |
| 群内审批卡片 | 点击人必须是**被授权审批的角色**，且与发起人同公司；卡片回调同样校验签名 |
| 转发/引用消息 | 正文里的身份字符串一律不信，只信事件信封 |

---

## 7. 权限模型（三层混合 + 谓词下推）

### 7.1 三层职责划分

| 层 | 回答的问题 | 表达形式 | 例子 |
|---|---|---|---|
| **RBAC**（功能） | "你能不能做这类动作" | `scope` 字符串：`资源:动作[:限定]` | `chat:use`、`plugin:install`、`kb:write` |
| **ABAC**（数据范围） | "在哪个范围内做" | `dataScope` + 属性（`companyId`、`deptPath`、`classification`） | 只能操作 `dept_path LIKE '/c1/d10/%'` 且 `classification <= internal` |
| **ReBAC**（资源关系） | "你对这个具体资源是什么关系" | 关系闭包：`owner` / `dept_member` / `project_member` / `chat_member` / `granted` | 这份文件是"我上传的"或"共享给我所在项目组" |

**三者是 AND 关系**：功能允许 + 范围允许 + 关系允许 → allow。

### 7.2 核心数据结构

```ts
interface Subject {
  userId: string
  companyId: string
  deptId: string
  deptPath: string[]          // ['c1','d10','d23']，前缀匹配用
  roles: string[]
  scopes: Set<Scope>          // 角色展开后的功能权限（含显式 allow/deny 覆盖）
  dataScope: 'self' | 'dept' | 'dept_tree' | 'company' | 'global'
  channelType: 'web' | 'feishu' | 'dingtalk' | 'wecom' | 'app' | 'portal'
  status: 'active' | 'disabled' | ...
}

interface ResourceRef {
  type: 'file' | 'conversation' | 'kb_chunk' | 'kb_doc' | 'plugin' | 'user' | 'dept' | 'approval' | ...
  id: string
  scopeType: 'company' | 'dept' | 'user' | 'project' | 'chat'
  scopeId: string
  ownerId?: string
  classification?: 'public' | 'internal' | 'confidential'
  companyId: string
}

type Decision =
  | { result: 'allow'; matchedBy: string }                  // matchedBy 用于解释"为什么允许"
  | { result: 'deny'; reason: string; matchedBy: string }
  | { result: 'require-approval'; approverRole: string; approvalPolicyId: string }
```

### 7.3 Scope 目录（资源:动作[:限定]）

> 命名规则：全部小写；`:` 分隔；第三段只在需要细分时出现；**新增 scope 必须同时在本文档登记**，否则 CI 报未登记 scope。

| 分组 | Scope | 说明 |
|---|---|---|
| 对话 | `chat:use` | 发起对话 |
| | `chat:history:read` | 读自己/授权范围内的会话历史 |
| | `chat:history:delete` | 删除会话（软删） |
| | `chat:export` | 导出会话（含审计） |
| 工具 | `agent:tool:list` | 查看可用工具清单 |
| | `agent:tool:invoke` | 调用工具（还需工具自身 requiredScope） |
| | `agent:tool:register` | 注册工具（插件用） |
| 插件 | `plugin:list` / `plugin:install` / `plugin:uninstall` / `plugin:configure` / `plugin:approve` | 安装、卸载、配置、审批分开授权 |
| 知识库 | `kb:read` / `kb:write` / `kb:admin` / `kb:delete` | 写=入库，admin=建库/改权限 |
| 工作区 | `workspace:read` / `workspace:write` / `workspace:share` | share = 把个人文件共享到部门/项目 |
| 组织 | `org:member:read` / `org:member:manage` / `org:dept:read` / `org:dept:manage` / `org:sync:run` | 结合 dataScope 生效 |
| 角色权限 | `authz:role:read` / `authz:role:manage` / `authz:grant` | grant = 改用户角色/覆盖规则 |
| 渠道 | `channel:manage` / `channel:bind` / `channel:send` | manage=配置密钥，send=主动发消息 |
| 模型 | `model:read` / `model:manage` / `model:use` | manage=改 provider/密钥；use=选模型 |
| 审批 | `approval:read` / `approval:decide` | decide=做审批决定 |
| 审计 | `audit:read` / `audit:export` | 只读；export 需二次确认 |
| 运维 | `service:status` / `service:control` / `system:backup` / `system:restore` | 高危，需二次确认 + 审计 |
| 记忆 | `memory:read` / `memory:write` / `memory:admin` | admin=跨用户清理 |
| 访客 | `portal:use` / `portal:admin` | 访客门户 |

### 7.4 内置角色（7 个，不可删，只可改 scope 与 dataScope）

| code | 名称 | 关键 scope | dataScope | 说明 |
|---|---|---|---|---|
| `super_admin` | 平台超管 | 全部 | `global` | 仅运维用途；所有动作强制审计 + 高危二次确认 |
| `company_admin` | 公司管理员 | `org:*:manage`、`plugin:approve`、`kb:admin`、`audit:read`、`channel:manage`、`model:manage` | `dept_tree` | 公司的实际负责人 |
| `dept_admin` | 部门管理员 | `org:member:read`、`org:dept:read`、`kb:write`、`workspace:share` | `dept` | 管本部门 |
| `kb_admin` | 知识库管理员 | `kb:*` | 按绑定范围 | 可只对某几个库有权限（资源级） |
| `auditor` | 审计员 | `audit:read`、`audit:export`、`service:status` | `company` | **只读**，不可改任何配置 |
| `member` | 普通员工 | `chat:use`、`chat:history:read`、`workspace:read/write`、`agent:tool:list/invoke`、`kb:read` | `self` | 默认角色 |
| `guest` | 外部访客 | `portal:use`（+ 显式授予的少数功能） | `self` | 独立入口、独立限流 |

### 7.5 决策算法（PDP）

```ts
decide(subject, action, resource?): Decision {
  // 0 前置
  if (subject.status !== 'active') return deny('账号不可用')
  if (!subject.scopes.has(action) && !hasImpliedScope(action)) return deny('无功能权限')

  // 1 显式拒绝优先（overrides 表里 deny 的项）
  if (matchOverride(deny, subject, action, resource)) return deny('被显式拒绝')

  // 2 显式允许（overrides 里的 allow，可用于临时授权/例外）
  if (matchOverride(allow, ...)) return allow('显式授权')

  // 3 无资源上下文：功能级判定即可放行（列表类动作走 buildScopeFilter）
  if (!resource) return allow('角色继承')

  // 4 资源级：范围 + 关系
  if (!inDataScope(subject, resource)) return deny('超出数据范围')
  if (!hasRelation(subject, resource)) return deny('无资源关系')
  if (resource.classification === 'confidential' && !subject.scopes.has('kb:admin')) {
    return deny('密级不足')
  }

  // 5 审批策略（高危动作）
  const policy = approvalPolicy(action, resource)
  if (policy) return requireApproval(policy)

  return allow('角色继承')
}
```

**优先级**：`显式拒绝` > `显式允许` > `资源级判定` > `角色继承` > `默认拒绝`。
**可解释性**：每次决策都返回 `matchedBy`，审计与调试时能回答"为什么放行/为什么拒"。

#### 7.5.1 知识类资源的例外分支（2026-11-07 定稿）

知识类（`kb_doc` / `kb_chunk`）的**读**权限不看部门数据范围，改看"知识库可见范围"（见 7.6.1）：

```ts
// 步骤 4 之前插入，与 buildScopeFilter 共用同一个 isCollectionVisible
if (action === 'kb:read' && isKnowledgeKind(resource.kind)) {
  if (!resource.collectionAcl) return deny('kb-acl-missing')      // 没配 = 拒绝，不猜
  if (!isCollectionVisible(resource.collectionAcl, subject)) return deny('kb-collection-denied')
  // 通过后仍要过密级与审批（confidential 需 kb:admin）
}
```

**为什么单独开一条分支**：部门范围只能表达"我的部门/我的下级"，但企业配知识库的常见口径是"全员可见 / 仅管理层 / 仅研发中心"，这是运营配置，不是组织树的副产品。硬塞进部门范围会出现两个矛盾：公司级知识对普通员工不可见（错），或配了"仅管理层"却被部门管理员绕过（更错）。

**写/删/管理不适用这条**：`kb:write`、`kb:delete`、`kb:admin` 仍走组织数据范围（公司管理员可治理未公开的知识库），否则运营会被 ACL 卡死。读写口径不同是刻意的，已在测试里固定。

### 7.6 谓词下推（本设计最关键的工程约束）

```ts
// 每个数据访问方法都必须显式接收 scopeFilter，类型系统强制
type ScopedQuery<T> = { where: T; scope: ScopeFilter }   // scope 不可省略、不可为 null

buildScopeFilter(subject, action): ScopeFilter
// 返回 { kind: 'eq' | 'prefix' | 'in' | 'and'... } 的谓词树，由 predicateToSql 编译为 SQL（全参数绑定）
```

**反例（禁止）**：

```ts
const list = await repo.listConversations()          // ❌ 没有 scope
const all = await repo.list(); const visible = all.filter(isMine)  // ❌ 先查全量
const where = { companyId: req.body.companyId }      // ❌ 从请求体取租户
```

**正例**：

```ts
const list = await repo.listConversations({ scope: buildScopeFilter(subject, 'chat:history:read') })
```

**实现要点**：
1. `buildScopeFilter` 永远返回非空谓词；`member` 也会得到 `user_id = ?`，不存在"无限制"分支。
2. 谓词由查询构建器拼装，**禁止字符串拼接 SQL**（防注入，也便于审计打印）。
3. 每个 Repository 的列表方法签名里 `scope` 是必填字段（TS 类型强制，编译不过就写不出来）。
4. 跨表 JOIN 时，**每张表都要带各自作用域谓词**（例如"部门成员的会话"：会话表按 company，用户表按 dept_path）。
5. `super_admin` 的 `global` 也返回显式 `1=1`，并强制打 `scope=global` 审计标记——不是"跳过校验"。

#### 7.6.1 知识库可见范围（collection 级 ACL）

**粒度**：权限配在"知识库（collection）"上，文档与切片继承。单篇文档 override 留 V1——企业里逐篇授权既难维护也难向员工解释。

| 模式 | 含义 | 典型用法 |
|---|---|---|
| `all` | 公司全员可见 | 公司级制度、员工手册 |
| `roles` | 仅指定角色可见（命中任一） | "仅管理层"、"仅 HR" |
| `depts` | 仅指定部门**及其下级**可见 | "仅研发中心"（前端组自动包含） |
| `private` | 仅所有者可见 | 个人知识库、临时资料 |

**谓词形态**（读操作）：

```sql
WHERE company_id = ?                                   -- 永远打底
  AND collection_id IN (?, ?, ...)                     -- 主体可见的知识库集合
  AND classification IN ('public','internal')          -- 非 kb:admin 看不到机密
```

`collection_id IN (...)` 由 `resolveVisibleCollections(subject, loadKbCollectionAcls(companyId))` 算出：把"该公司全部知识库的 ACL"逐条判定，得到 ID 集合。知识库数量是几十级，这个计算放在进程内缓存（变更即失效），然后**一次 SQL 谓词**完成过滤，不需要 join 也不需要内存二次过滤。

**三条硬约束**：

1. **fail-closed**：配置缺失、`acl_mode` 非法、`private` 没写所有者 → 该知识库对所有人不可见；`collections` 上下文没传上来 → 过滤器直接是空集（`reason` 带 `kb-acl`）。绝不因为"没配置"而全放行。
2. **读写分离**：可见范围只管读；写/删仍走组织范围（见 7.5.1），否则公司管理员无法治理一个"仅研发中心可见"的库。
3. **列表 == 单条**：`buildScopeFilter` 与 `decide` 共用 `isCollectionVisible`，storage 侧有一条断言"SQL 查出来的列表 == 逐条 decide 的结果"，防口径漂移。

**数据表**（详见 15 章）：`kb_collections` 存 `acl_mode` / `acl_roles`（JSON 数组）/ `acl_dept_paths`（JSON 数组，物化路径）；`kb_docs`、`kb_chunks` 冗余 `collection_id` 使谓词可下推。

### 7.7 缓存与失效

| 项 | 设计 |
|---|---|
| Subject 缓存 | 登录后算一次，缓存 5 分钟（内存 LRU）；带 `version` 号 |
| 失效触发 | 角色变更 / 部门调整 / 离职 / 权限矩阵保存 / 插件授权变更 → 广播 `subject:invalidate(userId)`，版本号自增 |
| 策略缓存 | `role_scopes` 与 `overrides` 进程内缓存，变更时整体失效（数据量小，简单粗暴更可靠） |
| 禁止 | **禁止把"允许/拒绝结果"按 user+action 长缓存**（资源维度太多，且容易失效不及时） |

### 7.8 审批（require-approval）适用场景

| 动作 | 审批人 | 超时策略 |
|---|---|---|
| `agent:tool:invoke` 且 `risk >= high`（如外发邮件、写外部系统、删文件） | 部门管理员 | 30 分钟未决 → 自动拒绝，turn 结束并提示 |
| `plugin:install` / `plugin:approve` | 公司管理员 | 24 小时未决 → 保持 pending，但插件不可用 |
| `audit:export` / `system:restore` | 公司管理员 + 二次口令确认 | 立即，无超时 |
| `workspace:share` 到公司级 | 部门管理员 | 24 小时 |
| 超出用户配额的大额调用（如 > 50 万 token/次） | 部门管理员 | 30 分钟 |

### 7.9 负向测试清单（每次改动权限代码必须全绿）

| 编号 | 越权场景 | 期望 |
|---|---|---|
| N-01 | 部门 A 成员读部门 B 用户的工作区文件 | `403 SCOPE_DENIED`，且**审计里记录拒绝** |
| N-02 | 请求体带 `companyId=其他公司` | 忽略请求体，按 subject 的 company 处理 |
| N-03 | `member` 调 `/admin/*` | 403 |
| N-04 | 知识库检索不传 filter / 传空 filter | 服务端拒绝（不是默认全量） |
| N-05 | 插件有 `kb:read`，替 `member` 用户检索公司级机密库 | 拒绝（插件权限 ∩ 用户权限） |
| N-06 | 离职用户用旧 token 发消息 | 401（session 已吊销） |
| N-07 | 群聊里伪造 `@某某` 让机器人以他人身份执行 | 仍按事件信封的 senderId 处理 |
| N-08 | 插件通过 `fs` 句柄传 `../../other-company` | 拒绝（路径穿越拦截） |
| N-09 | 审批卡片被非审批人点击 | 拒绝并记录"越权审批尝试" |
| N-10 | 导出审计后被删除审计行 | 不可能（append-only + 哈希链校验失败告警） |

### 7.10 权限实现常见反模式（写进 Code Review 检查表）

1. 在 controller 里判断 `if (user.role === 'admin')` —— 应走 `hasScope`。
2. 在 service 里过滤数组 —— 应下推到 SQL。
3. 把角色名当权限用 —— 角色可改，scope 才稳定。
4. 前端隐藏按钮当作已鉴权 —— 后端必须独立校验。
5. 用 `try/catch` 吞掉 `AccessDeniedError` —— 拒绝必须让上层感知，不能当"没数据"。
6. 权限错误返回 404 而不是 403 混用 —— 统一 403 + 错误码；仅"资源存在性本身敏感"时用 404（并写明原因）。

---

## 8. 渠道接入（飞书 / 钉钉 / 企微）

### 8.1 统一事件信封

```ts
interface InboundEvent {
  eventId: string                      // 幂等键：`${channel}:${rawEventId}` 或 hash(原始体)
  channel: 'feishu' | 'dingtalk' | 'wecom' | 'web'
  receivedAt: number
  sender: {
    channelUserId: string              // 渠道侧 ID（open_id / userid / senderId）
    unionId?: string
    chatId?: string
    chatType: 'p2p' | 'group'
  }
  content: {
    text?: string
    attachments?: Array<{ kind: 'image'|'file'|'audio'|'video'; url?: string; fileKey?: string; name?: string; size?: number }>
    mentions?: Array<{ channelUserId: string; name?: string }>   // 仅用于展示，不参与鉴权
    raw: unknown                       // 原始事件体，落审计用（脱敏）
  }
  verified: true                       // 只有签名/长连接身份校验通过才构造
}
```

### 8.2 三渠道差异表

| 项 | 飞书 | 钉钉 | 企业微信 |
|---|---|---|---|
| 机器人收消息 | 长连接（WS，免公网） | Stream 模式长连接（免公网） | **回调 URL + 加解密**（需公网/内网穿透） |
| 事件验签 | 长连接身份 + 事件体签名 | Stream 协议自带 | 签名（`msg_signature`）+ AES 解密 |
| 扫码登录 | 网页 OAuth / 移动端 `requestAuthCode` | `getAuthCode` | OAuth2 `snsapi_privateinfo` |
| 通讯录权限 | `contact:user.base:readonly` 等 | 通讯录读权限 | 通讯录同步 secret |
| 消息长度 | 单条有上限（富文本建议走卡片） | 单条有上限 | 文本 2048 字节级别 |
| 卡片能力 | 交互卡片（按钮回传） | AI 卡片 / ActionCard | 模板卡片（按钮回传） |
| 审批卡片 | 可发交互卡片 | 可发 AI 卡片 | 模板卡片 |
| 主动推送 | 可（需 bot 权限） | 可 | 可（应用消息） |
| 特殊风险 | 事件重推 | 事件重推 | 回调必须公网、IP 白名单 |

> ⚠️ 三渠道的**通讯录读权限**需要企业管理员在开放平台勾选并审批，是本项目第一个外部前置条件，MVP-0 期间就要并行推进申请。

### 8.3 消息处理链路

```
渠道事件到达
  ↓ 验签/解密（失败直接 401，不构造信封）
  ↓ 构造 InboundEvent → channel_events 去重（主键 eventId）
  ↓ 命中绑定表 channel_bindings(channel, channel_user_id) → subject
    未命中 → 引导绑定（发一次性绑定码 / 提示联系管理员），不自动建号
  ↓ 频控：per sender 10 条/分钟、per chat 30 条/分钟，超限回"操作过于频繁"
  ↓ AgentRuntime.handle(subject, event)
  ↓ 输出分片（长文本按渠道上限切分，富文本降级为卡片/纯文本）
  ↓ 回发 + 审计
```

### 8.4 可靠性设计

| 项 | 策略 |
|---|---|
| 去重 | `channel_events` 主键去重；窗口保留 24h（定时清理）；重复事件立即 ack |
| 失败重试 | 发送失败进 `outbound_queue`，指数退避最多 5 次；超限标 `dead` 并告警 |
| 断线 | 长连接断开自动重连（指数退避）；重连后拉取最近的会话消息兜底（避免漏消息） |
| 顺序 | 同一 `chatId` 的消息串行处理（避免同一会话并发回合） |
| 限流 | 渠道侧限流（各渠道 API 配额不同）；本地做令牌桶，不硬撞 |
| 长任务 | 超过 10 秒的处理先回"正在处理"，完成后主动推送结果（渠道消息有时效） |
| 附件 | 下载到 `uploads/` 并登记 `file_refs`；大小上限默认 50MB；解析走 worker |

### 8.5 未绑定与访客策略（默认拒绝 + 引导）

```
未绑定用户发消息
  ↓ 回复："你现在还没有访问权限。1) 点击链接绑定账号 2) 联系管理员开通"
  ↓ 记录一次 `channel_unbound_attempts`（用于批量开通）
  ↓ 不执行任何检索、不读任何知识库、不消耗模型 token
```

### 8.6 组织架构同步（三渠道统一引擎）

#### 8.6.1 绑定企业：管理员扫码授权，一个租户只属一家公司（2026-11-07 定稿）

**口径（用户原话）**："同步钉钉，飞书，企业微信都是把公司隔离的使用扫码连接钉钉，飞书企业微信的方式去绑定对应的企业，同步公司组织架构。"

拆成六条可执行规则：

| # | 规则 | 落地位置 |
|---|---|---|
| 1 | **一家 EAB 公司 = 每家渠道的一个企业租户**。同一家公司可以同时绑飞书、钉钉、企微，但同一渠道只能绑一个租户 | `channel_configs` 一行一 `(company_id, provider)` |
| 2 | **绑定 = 管理员授权并确认租户**：飞书 / 企微走扫码授权；钉钉走「企业内部应用凭据一次性提交」的一键绑定（见 8.6.2），服务端仍以换到的 `tenant_id` 做唯一性校验 | `channel_bind_sessions` + `POST /api/channel/bind/start`；钉钉 `POST /api/console/channels/dingtalk/bind` |
| 3 | **一个渠道租户全局只能属一家公司**（`provider + tenant_id` 唯一），跨公司撞车在写库处直接 `EAB_CONFLICT` | 唯一索引 `uq_channel_configs_tenant` |
| 4 | **没绑定不许同步**：`org-sync` 先查 `tenant_id`，没有就 409「还没有绑定飞书企业」，hint 指向「渠道绑定」 | `routes/org-sync.ts` 前置校验 |
| 5 | **解绑只停同步，不删组织数据**：清 `tenant_*`、`status='unbound'`、`sync_mode='off'`；部门/成员是本公司资产，知识库 ACL 还引用着 dept path | `POST /api/channel/unbind` |
| 6 | **会话状态机可见可重试**：`pending → scanned → authorized`，异常 `expired / cancelled / failed`，TTL 5 分钟，页面轮询推进 | `GET /api/channel/bind/:sessionId` |

为什么飞书 / 企微仍不让管理员手填密钥：手填必然出现"把 A 公司的应用配进 B 公司"，而扫码拿到的是**租户身份**，能在写入处做隔离校验。钉钉是例外：企业内部应用必须先有 AppKey/AppSecret，扫码不能替代应用凭据，所以改成"一次提交凭据 + 服务端探测租户 + 立即同步"，并用 `corpId` 唯一索引兜底，见 8.6.2。

为什么"解绑不删数据"：组织数据是本公司资产（还有知识库的部门可见范围以 dept path 为锚点）。解绑的语义是"停止这条同步通道"，不是"把这家公司的组织抹掉"；真要清组织是另一个动作，且要显式确认。

**真渠道差异（只影响"换租户"那一步，后面完全复用）**

| 渠道 | 扫码授权 | 换到的租户标识 | 通讯录接口 |
|---|---|---|---|
| 飞书 | 扫码登录 / 应用授权码 | `tenant_key`（tenant_id） | `contact/v3/departments` + `contact/v3/users` |
| 钉钉 | 企业内部应用凭据（一键绑定，见 8.6.2） | `corpId` | `/topapi/v2/department/listsub` + `/topapi/v2/user/list` |
| 企微 | 扫码授权 / 服务商授权码 | `corpid` | `/cgi-bin/department/list` + `/cgi-bin/user/list` |

#### 8.6.2 钉钉一键绑定（2026-11-08 落地）

钉钉之外的两家仍走扫码；钉钉改成「企业内部应用凭据 + 一次提交」的一键绑定，原因是企业内部应用本来就需要管理员在开发者后台创建并授予通讯录权限，扫码只多一层设备码，不能省掉 AppSecret。

| 步骤 | 服务端动作 | 失败语义 |
|---|---|---|
| 1 | 校验 `appId / corpId`，`appSecret` 取本次新值或已存 `secret_ref` | 缺字段 `EAB_VALIDATION` |
| 2 | `POST /v1.0/oauth2/accessToken` 换 token，`POST /topapi/v2/department/get` 读根部门名 | 凭证错/无权限 → `EAB_UPSTREAM`，hint 指向 `qyapi_get_department_list` + `qyapi_get_member`（只开 `qyapi_manage_addresslist` 不够） |
| 3 | `listsub` 递归部门树 + `user/list` 分页拉成员，空结果拒绝绑定 | 空通讯录 → `EAB_UPSTREAM`，防"全公司判缺失" |
| 4 | `provider='dingtalk' + tenant_id=corpId` 跨公司唯一校验，再校验本公司是否已绑另一租户 | 撞车 → `EAB_CONFLICT` |
| 5 | 写 `channel_configs`：`status='bound'`、`sync_mode='daily'`、`bound_at/bound_by_user_id`；明文只进 `secrets.json` | 唯一索引兜底 |
| 6 | `mapRemoteOrg(rootChannelDeptIds:['1'])` + `applyOrgSync(recycleAfter:2)`，一次完成首次同步 | 单部门失败不阻断；空 plan 拒绝 |
| 7 | 写审计 `channel.dingtalk.bind`，返回 `tenantName / departments / members / runId / diffs` | — |

**权限错误识别**：钉钉返回 `errcode=60011` 时，`errmsg/submsg` 会点名缺哪个 scope（例如 `qyapi_get_department_list`）并给申请链接；这类错误不要当凭证错误反复重填，直接按链接开通权限后重试。

**根部门映射修正**：钉钉 `dept_id=1` 是企业根，`listsub` 不返回它；映射时先把父 ID 命中 `rootChannelDeptIds` 视为公司根，再判孤儿。否则所有一级部门都会被误记 `orphan`（本地 mock 首次联调已复现并修复）。

**接口与界面**：`POST /api/console/channels/dingtalk/bind`；控制台「渠道」页顶部「企业一键绑定」面板，钉钉未绑定时显示「一键绑定并同步」，已绑定显示「重新同步 / 解绑」。重复绑定同一租户是幂等差异更新（本地 mock 二次同步 `unchanged=6`、`created=0`）。`GET /api/console/channels` 同时返回 `organization {departments, channelDepartments, members, source}`，`source=local` 表示当前组织还不是渠道同步来的。

**替换演示/手工组织**：绑定请求可带 `replaceDemo: true`。服务端在同步前记录组织计数，只有当 `channelDepartments=0` 且已有部门或成员时才允许替换；先 `applyOrgSync` 写入钉钉组织，再归档原有非钉钉数据（`users` 与 `departments` 写 `deleted_at`，不物理删除，根部门保留），结果计入 `sync.archived {departments, members}` 与审计 `detail.archived`。前端在演示绑定或当前公司没有钉钉同步部门时显示「用钉钉通讯录替换现有组织」勾选项，默认勾选；不勾选则只追加。这样已经解绑、只剩演示组织数据的公司也能用真实钉钉通讯录接管，而不是把真实组织追加在演示数据旁边。

**本地联调**：`EAB_DINGTALK_API` / `EAB_DINGTALK_OAPI` 可覆盖官方端点，仅允许 https 或本机 http；`.eab-dev/tmp/mock-dingtalk.mjs` 提供 3 部门 / 3 成员的 mock。

**为什么不能"拉一遍通讯录直接写库"**

**为什么不能"拉一遍通讯录直接写库"**

1. 部门 ID 每家都不一样，根的表示还不同（空父 / `0` / `1`）；部门会改名、会移动，人会换部门、会离职。
2. 渠道 API 有分页、限流和返回上限（企微 `user/list` 必须按 `department_id` 拉），全量要自己拼。
3. 三家都会"偶发丢数据"：通讯录权限正在审批、应用未发布、部门未授权可见，这时候拉回来就是"全公司只剩 3 个人"。按"上游没有再删"处理会误删真实用户。
4. 事件有丢、有重、有乱序，事件只能当"提示"，最终仍以全量快照为准。

**一个引擎 + 三个 provider**

```ts
interface OrgProvider {
  readonly id: 'feishu' | 'dingtalk' | 'wecom'
  // 连通性自检：失败要说人话（缺哪个 secret、哪个通讯录权限没批）
  verify(cfg: ChannelConfig): Promise<{ ok: boolean; message: string }>
  // 分页拉全量；分页/按部门拉的差异由 provider 内部消化
  fetchOrg(cfg: ChannelConfig): Promise<RemoteOrg>
}

interface RemoteDept {
  channelDeptId: string            // 渠道侧部门 ID，统一转成 string
  parentChannelDeptId: string | null
  name: string
  order?: number
}

interface RemoteUser {
  channelUserId: string            // open_id / userid / senderId
  unionId?: string                 // 同一人跨应用收敛用
  name: string
  title?: string
  channelDeptIds: string[]         // 可能在多个部门（兼职/多部门）
  status: 'active' | 'departed'
  employeeNo?: string
}
```

**映射是纯函数（不碰网络，喂假数据就能单测）**

```
RemoteOrg ──mapOrgTree──▶ { depts, users, identities }   // 全部是待写库的行
```

| # | 规则 | 理由 |
|---|---|---|
| 1 | **部门 path 由父链重建**，不抄渠道的"层级/排序"字段；父不存在（未授权可见）→ 该子树整体挂根并记 `orphan` 差异，不猜 | 渠道返回的层级常与真实组织不一致，path 是我们自己的唯一事实 |
| 2 | **部门身份 = `(company_id, channel, channel_dept_id)`**，不是名字 | 名字会改；三家外部 ID 都是数字，会撞号，所以必须有 `channel` 列（见 15.4 的 0003 变更） |
| 3 | **渠道账号写 `user_identities`**（`provider` + `external_user_id`），同一人跨应用靠 `union_id` 收敛；`users` 只维护"人" | 一个人三个渠道各一个 ID，不能变成三个人 |
| 4 | **首见即建、再见面更新、上游消失不立即删**：加 `missing_at`，连续 2 次全量（默认间隔 24h）都缺失才标 `recycled` 并撤权 | 权限审批中/应用临时失效会"看起来全没了"，单次缺失只记差异 |
| 5 | **部门移动 = 子树批量重写 path**（与 KB-05 同一条逻辑），完成后广播 `org:invalidate` | 否则 subject 缓存与 `kb_collections.acl_dept_paths` 的锚点会指向旧路径 |
| 6 | **离职即失效**：`status='departed'` 立刻 `subject:invalidate(companyId, userId)`，会话保留只读 | 权限收回要即时，历史不能跟着删 |
| 7 | **幂等**：同一份输入跑两次，第二次 diff 必须为空 | 定时任务重复触发、手工重跑是常态 |

**同步模式**

| 模式 | 触发 | 用途 |
|---|---|---|
| 全量 | 手动 / 每日定时 / 首次接入 | 校准；唯一可信来源 |
| 增量 | 渠道事件（成员变更、部门变更） | 加速，几分钟内生效 |
| 校准 | 全量结果 vs 库里现状 | 只出报告，不直接删人 |

**同步报告（可回看，不靠翻日志）**

`org_sync_runs` 每次一行：`provider / mode / started_at / finished_at / status / stats`。`stats` 至少含
`deptsCreated / deptsRenamed / deptsMoved / usersCreated / usersDeparted / orphans / errors[]`。
控制台「系统」页直接读这张表，不另做日志检索。

**落地顺序（建议，先证明映射对，再接网络）**

0. ✅ 扫码绑定骨架：会话表 + 租户唯一索引 + 三渠道卡片 + 模拟扫码（真渠道只换"换租户"一步）—— 已落地：`0004_channel_bind.sql` + `routes/channel.ts` + 控制台「渠道绑定」区
1. ✅ 映射纯函数 + 测试（喂假数据，不依赖任何渠道）—— 已落地：`packages/channel/src/map-org.ts` + 12 条用例
2. ✅ 钉钉 provider + 一键绑定（2026-11-08）—— 已落地：`fetchDingTalkTenant` / `fetchChannelOrg('dingtalk')` + `POST /api/console/channels/dingtalk/bind` + 控制台「企业一键绑定」面板；本地 mock 端到端跑通 3 部门 / 3 成员、二次同步幂等、跨公司 `corpId` 冲突 409
3. ✅ 同步报告 + 控制台「组织同步」按钮与结果表 —— 已落地：`apply.ts` 写 `org_sync_runs` / `org_sync_diffs`，控制台第五个 tab 可跑 `mockFeishuOrg(1/2/3)` 三份快照并回看差异
4. ⬜ 飞书 / 企微扫码绑定与回调（钉钉 Stream、企微回调 + 加解密仍需公网入口）

> 当前进度口径：0、1、2（仅钉钉）、3 已完成；飞书 / 企微的真扫码与回调未开始。接真渠道时只补 `fetchOrg` 与验签/事件层，`apply.ts` 的落库语义不动；同步按钮在绑定企业后才可点。真实钉钉租户仍需用户提供 AppKey / AppSecret / CorpId 才能做官方端点验收。

---

## 9. 插件体系（进程隔离 + 能力令牌）

### 9.1 设计目标

1. **能装第三方插件，并且敢装**——隔离与授权是卖点，不是补丁。
2. **装和跑分离**——安装是一次性管理动作（要审批），运行时是高频动作（要低延迟）。
3. **能热更、能回滚**——插件坏了不能拖垮服务，卸载要干净。
4. **开发体验对齐 DSH**——本地软链、热重载、沙盒数据目录。

### 9.2 插件包结构

```
eab-plugin-xxx/
├── eab-plugin.json          # 清单（必须）
├── dist/index.js            # 入口（bundle 后的单文件，禁止依赖宿主内部路径）
├── README.md
└── package.json             # npm 元数据（发布用）
```

### 9.3 清单 schema（`eab-plugin.json`）

```json
{
  "name": "eab-plugin-ding-card",
  "version": "1.0.0",
  "description": "钉钉 AI 卡片同步",
  "eabApiVersion": "1.0",
  "eab": {
    "bundle": { "entry": "./dist/index.js", "runtime": "node", "minNode": "20" },
    "config": {
      "type": "object",
      "properties": {
        "cardTemplateId": { "type": "string", "title": "卡片模板 ID" },
        "syncIntervalSec": { "type": "number", "default": 30 }
      },
      "required": ["cardTemplateId"]
    }
  },
  "capabilities": {
    "required": ["channel:send", "agent:tool:register"],
    "optional": ["kb:read", "workspace:read"]
  },
  "tools": [
    {
      "name": "sendDingCard",
      "description": "发送一张钉钉 AI 卡片",
      "inputSchema": { "type": "object", "properties": { "title": { "type": "string" } }, "required": ["title"] },
      "requiredScope": "channel:send",
      "risk": "medium",
      "dataEffect": "external-side-effect",
      "timeoutMs": 10000,
      "idempotent": false,
      "approval": { "when": "risk>=high" }
    }
  ],
  "hooks": ["turn/start", "tool/call", "turn/end"],
  "dsh": { "bundle": { "entry": "./dist/index.js" } }
}
```

**校验规则**（加载期强校验，任一项不通过即拒绝安装）：
1. `name` 匹配 `^(eab|dsh)-plugin-[a-z0-9-]+$`；`version` 合法 semver。
2. `eabApiVersion` 必须落在宿主兼容窗口内，否则拒绝。
3. `capabilities.required` 里的每个 scope 必须在 7.3 的 scope 目录中存在（未登记 = 拒绝）。
4. `tools[].requiredScope` 必须 ⊆ `capabilities`（不许声明了工具却不申请权限）。
5. `eab.config` 必须是合法 JSON Schema（宿主据此生成配置表单与校验）。
6. 入口文件存在且能 `import` 成功（安装期试加载一次，失败即拒绝）。

### 9.4 安装源与安装流程

| 前缀 | 示例 | 用途 |
|---|---|---|
| 省略 / `npm:` | `eab-plugin-x`、`npm:@scope/eab-plugin-x@1.2.0` | 私有/公共 npm |
| `github:` | `github:owner/repo#v1.2.0` | 直接装仓库（需已构建 dist，见风险 R-06） |
| `file:` | `file:/home/jy/plugins/demo` | 本地开发调试（软链，热重载） |
| `tgz:` | `https://x.com/p.tgz` | 离线/内网分发 |

> **当前实现（v2026.11.07）**：已落地「本地目录 / npm（含国内镜像）/ GitHub」三种来源；`tgz` 直链仍是设计稿。三源共用解包、清单校验、暂存与落库链路，**只取包内容，不执行 `npm install`、生命周期脚本或仓库构建脚本**。

```
resolve(源)
  → 下载/软链到 plugins/.staging/{name}@{version}
  → 解析并校验 eab-plugin.json（9.3 六条）
  → 计算内容哈希（sha256）与来源签名（可选，企业私有源可强制）
  → 白名单校验（配置了 allowedSources 时非白名单直接拒）
  → 列出 capabilities 给管理员（required 不可裁剪；optional 可逐项裁剪）
  → 管理员审批（记录 approver / 时间 / 裁剪结果）
  → 写 plugin.lock.json（name, version, source, hash, grantedCapabilities, approvedBy）
  → 移动到 plugins/{name}@{version}/ 并切换 current 软链
  → 启动 worker → 健康检查（init 成功）→ 状态 installed/enabled
失败任一步 → 回滚到上一个 current，清理 staging，状态 failed（不污染生产）
```

**没有审批，插件不能上线**。这是与 DSH 最大的差别，也是这个产品能卖给企业的理由。

### 9.5 插件生命周期状态机

```
resolving → validated → pending-approval → approved → installed → enabled ⇄ disabled
                                                        │
                                                        └→ broken（连续崩溃）→ 人工处理
任一阶段失败 → failed（保留原因，可重试）
卸载：enabled/disabled/broken → uninstalling → uninstalled（保留 lock 历史记录）
```

| 状态 | 是否可被调用 | 说明 |
|---|---|---|
| `pending-approval` | 否 | 已下载，未授权，UI 显示待审批 |
| `enabled` | 是 | 工具与 hook 生效 |
| `disabled` | 否 | 保留配置与授权，可随时重启 |
| `broken` | 否 | 连续崩溃熔断，需人工 `eab plugin repair` |

### 9.6 运行隔离（ADR-08 落地）

| 项 | 设计 |
|---|---|
| 进程模型 | 每插件 1 个 worker 子进程（同插件多实例可共享，但默认单实例串行） |
| 通信 | stdio JSON-RPC（LSP 风格），单条消息限 1MB，超限断开 |
| 能力访问 | 插件**不持有** fs/网络/DB；所有访问走 `ctx.*` → RPC → 宿主校验 → 代执行 |
| 资源配额 | CPU（nice/优先级）、内存上限（默认 256MB，超限杀进程）、单次调用超时（工具默认 10s，hook 默认 5s）、每分钟调用上限 |
| 崩溃处理 | 记录 exit code + stderr 末尾 200 行；30 秒内重启；连续 3 次失败 → `broken` 并告警 |
| 冷启动 | 首次调用懒启动；常用插件在服务启动后预热；空闲 5 分钟回收 |
| 日志 | 插件 stdout 被宿主接管，按 `pluginId + traceId` 打标，禁止直接写用户可见输出 |

### 9.7 能力令牌与双重校验（最容易做错的地方）

```
插件调用 ctx.kb.search(query, scopeRef)
  ↓ worker 侧：只用「令牌」调用，不携带自造 subject
  ↓ 宿主 RPC 入口：校验令牌
      ① 令牌签名有效、未过期（绑定 pluginInstanceId + installId + 授权快照版本）
      ② 请求能力 ∈ 令牌里的 grantedCapabilities
  ↓ 宿主再校验「用户维度」
      ③ 从 turn 上下文取当前 subject（**由宿主持有，不由插件传入**）
      ④ 用 subject 的 scope + dataScope 再走一次 PDP
  ↓ 两者都通过 → 执行；任一失败 → 返回结构化拒绝（不抛给用户看堆栈）
```

**为什么必须双重**：只有插件权限 → 插件成为"权限放大器"（有 `kb:read` 就能替任何人读全公司）；只有用户权限 → 插件能做它不该做的事（比如偷读用户看不到的会话）。两者取交集才是正确边界。

**令牌不变量**：
- 令牌**不能**由插件自己构造或延长；只能由宿主在 `plugin.init` 时下发，且绑定 installId。
- 插件升级/授权裁剪 → 旧令牌立即失效，worker 重启。
- 令牌**不落磁盘**，只在进程内存；吊销靠重启。

### 9.8 宿主 SDK（插件能看到的全部）

```ts
interface EabPluginContext {
  plugin: { id: string; version: string; installId: string }
  log: { debug(msg: string, meta?: object): void; info(...): void; warn(...): void; error(...): void }

  tools: {
    register(descriptor: ToolDescriptor, handler: (input: unknown, call: ToolCallContext) => Promise<unknown>): void
    unregister(name: string): void
  }
  hooks: {
    on(event: EabEventName, handler: (payload: unknown) => Promise<void> | void): void
  }
  // 所有能力都是「被代理」的，权限由宿主判定
  fs: {
    read(handle: FileHandleRef): Promise<Buffer>
    write(handle: FileHandleRef, data: Buffer): Promise<void>
    list(handle: FileHandleRef): Promise<FileEntry[]>
  }
  kb: {
    search(collection: CollectionRef, query: string, topK?: number): Promise<Chunk[]>
  }
  channel: {
    send(target: ChannelTarget, payload: OutboundMessage): Promise<void>
  }
  store: {
    get<T>(key: string): Promise<T | null>   // 插件私有 KV（按 installId 隔离）
    set<T>(key: string, value: T): Promise<void>
  }
  config: Record<string, unknown>            // 管理员在配置表单里填的值（只读）
}
```

**明确不给**：`child_process`、裸 `fs` 模块、裸 `http` 出网（需 `net:outbound` 能力且域名白名单）、数据库连接、其他插件的私 store、宿主内部配置与密钥。

### 9.9 工具注册与命名冲突

- 工具全名 = `{pluginName}.{toolName}`（例：`eab-plugin-ding-card.sendDingCard`），模型看到的是短名（同名时用全名消歧）。
- 同名冲突：后装插件不能覆盖先装插件的工具；冲突时拒绝注册并在审批页提示。
- 内置工具（宿主自带，如 `workspace.read`、`kb.search`）占用 `eab.*` 命名空间，插件不可占用。
- 工具清单给模型时，**只列 subject 有权调用的**（见 11.5），减少幻觉调用与无谓拒答。

### 9.10 版本、锁与回滚

| 项 | 设计 |
|---|---|
| 锁文件 | `plugin.lock.json` 记录 name/version/source/hash/granted/approvedBy/installedAt |
| 升级 | `eab plugin update <name>[@version]` → 走完整审批（能力变化必须重新审批；仅版本号变化且能力不变可"自动通过"策略，可配） |
| 回滚 | `eab plugin rollback <name>` 切回上一个版本目录（保留最近 3 个版本） |
| 兼容 | `eabApiVersion` 落在窗口内才允许安装；宿主大版本升级时给插件作者 6 个月迁移期 |
| 卸载 | 停 worker → 删 current 软链 → 保留历史与配置（可 `--purge` 彻底删） |

### 9.11 与 DSH 插件的关系（ADR-14）

- 识别 `dsh.bundle` 字段 → 走 `DSHCompatAdapter`：把 DSH 的 `turn/*`、`tool/*` 事件名与 payload 映射到 EAB 事件总线；DSH 的 `ctx` 接口用 shim 包一层。
- **只保证已实测的插件可用**（当前目标：`dsh-mrrp`、`dsh-ding-card`、`engramory`），其余标记"尽力兼容，未验证"。
- DSH 插件默认按"不可信第三方"处理：仍需审批、仍在 worker 里跑。

### 9.12 开发者体验

| 命令 | 作用 |
|---|---|
| `eab plugin init <name>` | 生成 TS 脚手架（清单 + 示例工具 + hook + 测试） |
| `eab plugin link ./my-plugin` | 软链到 `plugins/`，文件变化热重载（调用 resume 而非重启进程，能 resume 就 resume） |
| `eab plugin dev` | 起一个**独立 dev 数据目录**（`.eab-dev`），权限全开但数据隔离，不污染生产 |
| `eab plugin test` | 在沙盒 worker 内跑单测（模拟 ctx，断言工具输入输出） |
| `eab plugin pack` | 打包 tgz + 计算哈希 + 生成发布清单 |
| `eab plugin logs <name>` | 看插件日志（按 traceId 过滤） |

---

## 10. 知识库（同库向量 + ACL 双检）

### 10.1 目标与边界

- **目标**：知识按"知识库（collection）"组织，可见性由 collection ACL 决定（全员 / 角色 / 部门 / 个人，见 7.6.1），检索**永远不跨权限**，回答**必须带出处**。
- **不做**：训练、标注、复杂 RAG 编排（多跳、图检索）、自动爬取。可外接云端知识库 provider。

### 10.2 Provider 接口

```ts
interface KbProvider {
  ensureCollection(ref: CollectionRef): Promise<void>
  upsertDocs(docs: KbDocInput[]): Promise<void>
  deleteDocs(ids: string[]): Promise<void>
  updateAcl(filter: { scopeType: ScopeType; scopeId: string }, patch: AclPatch): Promise<void>
  query(input: {
    text: string
    vector: number[]
    acl: AclFilter            // 必填，宿主构造，不允许上层传空
    topK: number
    minScore?: number
  }): Promise<Chunk[]>
  stats(ref: CollectionRef): Promise<{ docs: number; chunks: number; bytes: number }>
}
```

| 实现 | 场景 | 备注 |
|---|---|---|
| `SqliteVecKb` | 单机默认 | 向量与 chunk 同库（ADR-05），ACL 过滤在 SQL 里做 |
| `PgVectorKb` | 企业 PG 模式 | `vector` + `jsonb` ACL + 索引 |
| `QdrantKb` | 数据量大 | payload filter；需要显式同步元数据（双写风险，需补偿任务） |
| `RemoteKb` | 外接 Dify/RAGFlow/火山 | 通过 API；**ACL 由 EAB 侧做二次过滤**（外部库不保证隔离）。已实现 `dify` / `generic` 在线检索与 `obsidian` 本地导入，见 `packages/server/src/kb-external.ts` |

### 10.3 入库管线

```
上传/同步文档
  ↓ 1 落盘（经 WorkspaceResolver）+ 登记 kb_docs（status=uploaded, content_hash）
  ↓ 2 解析（worker）：PDF/Word/Excel/PPT/Markdown/图片OCR → 纯文本 + 结构（标题层级）
  ↓ 3 切分：按标题层级 + 语义边界（默认 512 token，重叠 64），保留 parent 标题路径
  ↓ 4 向量化（worker，批量，失败重试）
  ↓ 5 写入：chunk + 向量 + ACL 标签（同一事务）
  ↓ 6 状态 indexed；失败 → failed（保留已成功 chunk，可续跑）
```

**幂等**：以 `(docId, content_hash)` 为幂等键；同一内容重复上传不产生重复 chunk；内容变化 → 旧 chunk 全删 + 新写入（同事务），并写 `kb_doc_versions`。

**ACL 标签（每个 chunk 必带）**：

```json
{
  "companyId": "c1",
  "collectionId": "col_policies",
  "classification": "internal",
  "sourceDocId": "doc_123",
  "sourcePath": "companies/c1-acme/knowledge/policies/考勤制度.pdf",
  "page": 12,
  "chunkIndex": 3,
  "deptPath": "/c1/d10/d23/"
}
```

说明：`collectionId` 是过滤依据（`collection_id IN (...)`）；`classification` 决定密级；`deptPath` 只作来源标注与"部门移动后重写"的锚点，**不再作为可见性判据**（可见性一律由 collection ACL 决定，避免两套口径打架）。

### 10.4 检索链路（双检 + 分区）

```
query
  ↓ 1 宿主构造 AclFilter（由 subject + 可见知识库集合决定，**调用方不能传**）
  ↓ 2 解析可见知识库：`resolveVisibleCollections(subject, loadKbCollectionAcls(companyId))`（进程内缓存）
  ↓ 3 Provider 层带 filter 检索（`collection_id IN (...)` + 密级 → SQL 谓词 / payload filter）
  ↓ 4 **后置复检**：对返回 chunk 逐条再做一次 PDP（防 provider 实现漏过滤、防缓存脏数据）
  ↓ 5 去重（同文档相邻 chunk 合并）+ 可选 rerank
  ↓ 6 组装上下文：带 `[来源:文件 第N页]` 标记，token 预算内裁剪
  ↓ 7 答案生成后校验引用：回答中至少 1 个引用；无引用 → 降级为"未在知识库中找到依据"
```

**为什么要后置复检**：Provider 是插件化的（甚至外接第三方），不能把隔离正确性托付给它。复检成本低（几十条），收益是"不会因为一个 provider bug 泄漏全公司文档"。

### 10.5 权限变更后的处理

| 变更 | 处理 |
|---|---|
| 部门移动（子树） | 批量更新该子树所有 chunk 的 `deptPath`（按 `scopeId` 前缀匹配），异步任务 + 断点续跑 |
| 文档权限收窄 | `updateAcl` 直接改 chunk 标签（同库可事务；外部 provider 需重写） |
| 用户离职 | 无需改 chunk（按 subject 实时判定），但其个人库转只读 |
| 删除文档 | 事务删 chunk + 向量 + 标记 `kb_docs.deleted_at`；外部 provider 走补偿任务 |

### 10.6 分区的规模策略

| chunk 总量 | 方案 |
|---|---|
| < 20 万 | 单表 + 单 vec 表，靠 SQL 过滤 |
| 20–100 万 | 按 company 分表；部门维度靠 `deptPath` 前缀索引 |
| > 100 万 | 切 pgvector（分区表）或 Qdrant（collection per company） |

阈值写进配置，超阈值时启动告警并给出迁移建议，不自动迁移（数据迁移必须人工确认）。

### 10.7 制度问答模板

- 固定检索范围：`companies/{c}/knowledge/policies/`
- 系统提示固定：只答制度问题、必须引用条款、找不到就说不确定并给出咨询入口
- 输出结构：`结论 → 条款依据 → 适用范围 → 例外情况 → 来源`
- 可配置"必须引用 ≥ 2 条"（避免单条断章取义）

### 10.8 质量保障

| 项 | 做法 |
|---|---|
| 评测集 | 每公司维护 20–50 条"问题 + 期望文档"；每次改切分/模型跑一次回归 |
| 召回监控 | 记录 top1 命中率、无结果率、平均引用数；异常告警 |
| 灰度 | 新切分策略先在某部门库试跑，对比旧策略 |

### 10.9 知识库可见范围的配置口径（给运营看的）

| 场景 | 怎么配 | 结果 |
|---|---|---|
| 员工手册、公司制度 | `all` | 全公司含访客之外的员工可读，密级仍可设 `internal` |
| 薪酬绩效制度 | `roles: [company_admin, dept_admin]` | 只有管理层可读，普通员工检索不到 |
| 研发规范 | `depts: ['/c1/d10/']` | 研发部及其子部门可读，市场部检索不到 |
| 部门内部资料 | `depts: ['/c1/d20/']` | 仅该部门子树可读 |
| 领导个人笔记 | `private`（owner=某用户） | 仅本人可读 |
| 机密（并购、审计底稿） | 任意可见范围 + `classification=confidential` | 额外要求 `kb:admin`，双重门槛 |

两条容易踩的坑：

1. **给"子部门"授权不会让上级部门可见**（方向不能反）。要给整个中心开放，授权父部门的路径。
2. **改可见范围立即生效**，不需要重跑入库；但检索结果缓存（若启用）要一起失效——`kb_acls:invalidate(companyId)` 与 `subject:invalidate` 走同一条广播。

### 10.10 当前已落地实现

**数据表**（迁移 `0030_model_routes_and_kb_vectors.sql`）：

- `kb_collections.embedding_model_id`：可按库绑定不同 embedding 模型；为空时用用途路由 `kb.embed`。
- `kb_collections.retrieval_mode`：默认 `hybrid`，为后续切纯关键词/纯向量留位。
- `kb_docs.index_error / indexed_at / index_model_id`：单篇文档的索引失败原因、完成时间、使用的向量模型。
- `kb_chunk_embeddings(chunk_id PK, company_id, collection_id, doc_id, model_id, dim, vector BLOB, norm)`：向量旁表，float32 小端 BLOB，`chunk_id` 外键级联删除。
- `kb_index_jobs`：后台索引任务，状态 `pending → running → done | failed`，记录 `total/done/failed/error`。

**索引管线**（`packages/server/src/kb-vector.ts`）：

1. 取库的向量模型：显式 `embedding_model_id` → 否则 `resolveModelForPurpose('kb.embed')`；都没有则**不建任务**，直接返回"未配置"，文本入库和关键词检索继续可用。
2. 按 32 条一批（上限 64）调 embedding；数量或维度不一致直接判失败，不写半截向量。
3. 单篇文档一个事务：先删旧向量，再插新向量，最后把 `kb_docs.status` 置 `indexed`、写 `indexed_at / index_model_id`。
4. 任何失败写 `index_error` 并把状态置 `failed`，**不抛给上传接口**；上传成功与否不受向量化影响。
5. `POST /api/console/kb/collections/:id/reindex` 触发后台任务；`GET /.../index-status` 查进度与向量统计。手工建/改文档、Obsidian 同步后都会 best-effort 触发，没配模型只记提示。

**检索（`retrieveKb`）**：

1. 先按 `subject` + collection ACL 裁可见库，再做关键词与向量两路召回，**权限过滤先于检索**。
2. 关键词路沿用中文 bigram 打分，取 top20；向量路按库的 `embedding_model_id` 分组，每组问题向量与该组切片向量必须同 `model_id`，内存余弦取 top20 后合并。
3. 两路用 RRF（`1/(60+rank+1)`）合并；配置了 `kb.rerank` 时取前 20 条交给 `/rerank`，按返回的 `relevance_score` 重排后取 top4；重排失败自动保留 RRF 顺序，不让对话报错。
4. 向量调用失败只告警并回退关键词，绝不打断对话；回答提示词要求按 `[1]` 编号引用，`meta.citations` 带 `docId/chunkId/collectionId/score/source/reranked`。

**重排序适配器（`callRerank`）**：

- 请求 `POST {BaseURL}/rerank`，先按 Cohere / Jina / SiliconFlow / vLLM / Xinference 形态发 `{model, query, documents[], top_n, return_documents}`；返回 4xx 或响应无结果时，再按 HuggingFace TEI 形态发 `{query, texts[], truncate}` 重试一次。
- 响应兼容 `results[{index, relevance_score}]`、`results[{index, score}]` 与顶层数组，按分数降序；index 越界或分数非法的条目丢弃。
- Anthropic / Gemini / Azure OpenAI 没有标准 rerank，调用时直接给明确错误；demo 供应商同理。
- 单条候选直接返回，不消耗 rerank 调用；失败只写 `console.warn`，保留 RRF 结果。

**当前边界（明确未做）**：

- 向量以 BLOB 存 SQLite，检索在内存算余弦，适合单机十万级以内；超过 20 万切片应切 pgvector / Qdrant，迁移必须人工确认。
- ASR / TTS / video 仍只有端点类型与用途路由位，尚无调用适配器；`router.intent` 同样未接判定器。
- 未做 PDF/Word 解析 worker，当前入库仍是文本切片；解析器接入后再补"解析 → 切分 → 向量化"的异步队列。
- 未做按 collection 选择向量模型的界面，列已留、API 未暴露。

---


## 11. Agent 运行时（Turn 状态机 + 工具鉴权）

### 11.1 Turn 状态机（ADR-07 落地）

```
created → assembling → streaming ⇄ tool_pending
                              │        ├→ tool_running → streaming
                              │        └→ awaiting_approval → (approved) tool_running
                              │                             → (rejected/timeout) streaming(拒答)
                              └→ completed | failed | cancelled | interrupted
```

| 状态 | 含义 | 可迁移到 |
|---|---|---|
| `created` | 已受理，未装配上下文 | `assembling` |
| `assembling` | 取素材、裁工具 | `streaming` / `failed` |
| `streaming` | 模型流式输出中 | `tool_pending` / `completed` / `failed` / `cancelled` |
| `tool_pending` | 模型给出 tool_call，待决策 | `tool_running` / `awaiting_approval` / `streaming`(deny 回填) |
| `awaiting_approval` | 已生成审批，等人 | `tool_running`(通过) / `streaming`(拒绝/超时) |
| `tool_running` | worker 执行中 | `streaming`(结果回填) / `failed`(超时/崩溃) |
| `interrupted` | 进程重启时发现未完成 | 人工/自动重试 → `streaming`；或 `failed` |

**恢复策略**：启动时扫描非终态 turn：
- `awaiting_approval` → 保留，等待审批（最长的挂起场景，必须能活过重启）
- `tool_running` → 工具不是幂等的就标 `interrupted` 并提示用户重试；幂等的可重放
- `streaming` → 标 `interrupted`，前端提示"上一条回复中断，是否重试"

### 11.2 数据模型分层

```
conversation    会话（归属 user + scope；可共享到项目/群）
  └── turn      一次用户输入到结束（状态机主体，含用量、耗时、错误）
        └── step    一次模型调用或一次工具执行（可多 step）
              └── tool_call  工具调用详情（入参、出参、耗时、审批、结果）
```

### 11.3 上下文装配器

```ts
interface ContextSource {
  id: string
  requiredScope: Scope                 // 取这份素材需要什么权限
  budget: { maxTokens: number; priority: number }
  load(subject, turn): Promise<ContextPiece[]>
}
```

| 源 | requiredScope | 说明 |
|---|---|---|
| 系统提示（按场景模板） | 无 | 场景决定（通用/制度问答/数据分析） |
| 会话历史 | `chat:history:read` | 按 token 预算倒序裁剪；超长做摘要 |
| 用户记忆 | `memory:read` | 只取自己；部门记忆需 `dept` 域 |
| 工作区文件索引 | `workspace:read` | 只列文件名/摘要，按需读正文 |
| 知识库检索 | `kb:read` | 走 10.4 双检 |
| 组织目录（部门/成员） | `org:member:read` | 仅管理员类角色注入；普通员工不注入 |
| 工具清单 | `agent:tool:list` | 已按权限裁剪 |

**预算分配**（默认）：系统提示 10% → 会话历史 40% → 知识库 30% → 文件与记忆 20%（可配置）。超预算按 `priority` 裁剪，**裁剪记录写进 turn 元数据**（便于解释"为什么模型没看到那份文件"）。

### 11.4 工具描述符（ToolDescriptor）

```ts
interface ToolDescriptor {
  name: string                        // 全局唯一（插件工具带命名空间）
  title: string
  description: string                 // 给模型看的说明，要写清"什么时候该用"
  inputSchema: JSONSchema
  outputSchema?: JSONSchema
  requiredScope: Scope                // 工具自身要求的功能权限
  dataEffect: 'read' | 'write' | 'external-side-effect'
  risk: 'low' | 'medium' | 'high'
  idempotent: boolean
  timeoutMs: number
  approval?: { when: 'always' | 'risk>=high' | 'outside-scope'; approverRole?: string }
  audit: 'none' | 'summary' | 'full'  // full=记录完整入参出参（默认 summary）
  resourceHints?: (input) => ResourceRef[]   // 用到的资源，用于提前鉴权
}
```

### 11.5 工具清单裁剪（减少幻觉与无效拒答）

```
turn 装配时：
  candidates = ToolRegistry.all()
  visible = candidates.filter(t => PDP.decide(subject, t.requiredScope, t.resource).result !== 'deny')
  模型只看到 visible
调用时：
  再做一次 PDP（防"模型编造工具名"或"权限在回合中途被回收"）
```

**为什么要裁剪两次**：只裁清单不校验调用 → 模型可能伪造工具名绕过；只校验调用不裁清单 → 模型老调它没有的工具，用户体验差且浪费 token。

### 11.6 拒答与降级（结构化，不是异常）

```json
{
  "ok": false,
  "code": "EAB_SCOPE_DENIED",
  "message": "当前账号无权访问该部门知识库",
  "details": { "requiredScope": "kb:read", "resource": { "type": "kb_collection", "scopeId": "d31" } },
  "hint": "如需访问，请联系部门管理员为你开通"
}
```

- 给模型的是**结构化结果**（含 code 与 hint），让它能"换个说法/换条路"而不是直接崩。
- 给用户的是**人话 + 可行动下一步**（找谁、怎么申请），不说"403 Forbidden"。
- 审计里同时记录"拒绝事件"（这是最有价值的审计数据之一）。

### 11.7 审批流（挂起 → 通知 → 恢复）

```
工具需要审批
  ↓ approvals 落库（status=pending, turn_id, tool_call_id, 申请理由, 风险等级, 过期时间）
  ↓ turn 进入 awaiting_approval，SSE 推 approval.required 给前端
  ↓ 同时推 IM 卡片（部门管理员） + 控制台待办
  ↓ 审批人点击 → 校验（是否审批人、是否同公司、卡片签名）→ decisions 落库
  ↓ 通过：签发一次性"审批凭据"（绑定 tool_call_id，60 秒内有效）→ turn 恢复执行
  ↓ 拒绝/超时：turn 恢复，把拒绝原因作为工具结果回填给模型 → 模型给出替代方案
```

**要点**：审批凭据是**一次性、绑定具体调用**的，不能"批一次以后都放行"（除非策略明确写"本会话内同类工具免审"，这是可配的，但默认关闭）。

### 11.8 流式与容错（ADR-09 落地）

**SSE 事件类型**：

| 事件 | 说明 |
|---|---|
| `turn.start` | `{ turnId, seq }` |
| `delta` | `{ text }` 增量文本 |
| `tool.call` | `{ toolName, input, callId }`（可选，前端展示"正在查资料"） |
| `tool.result` | `{ callId, ok, summary }` |
| `approval.required` | `{ approvalId, toolName, reason, expiresAt }` |
| `error` | `{ code, message, retryable }` |
| `turn.end` | `{ status, usage, durationMs }` |

**错误归因（三终态，不许混）**：

| 终态 | 触发条件 | 处理 |
|---|---|---|
| `finish` | 收到正常结束标记 + 有内容 | 正常落库 |
| `provider_error` | HTTP 非 2xx / SSE 中出现 error 事件 / 流被提前关闭但无结束标记 / 只有空 chunk | **判为失败**，进重试或降级链，落 `turn.error_detail`；**绝不允许当 finish 落库** |
| `client_cancel` | 客户端断开或用户点停止 | `cancelled`，保留已生成部分 |

**重试与降级**：同 provider 重试 1 次（网络类错误）→ 换备用 provider（配置了 fallback chain）→ 全部失败给用户"模型服务暂不可用"。首 token 超时默认 30s，整体超时默认 120s（可配）。

### 11.9 用量与配额

| 维度 | 计量 | 超限策略 |
|---|---|---|
| 用户 | 每日 token 上限（默认 50 万）、每分钟请求数 | 超限 → 结构化拒答 + 提示次日恢复/申请提额 |
| 部门 | 每月 token 上限（可配） | 超限 → 部门内全部用户降级到"小模型"或拒答（策略可配） |
| 公司 | 总预算（对接财务口径） | 超限 → 告警 + 只保留已授权关键应用 |
| 工具 | 每工具每分钟调用数、单次超时 | 超限 → 拒绝并记录 |

配额计量写 `usage_records`（user, dept, company, provider, model, input/output tokens, cost 估算, turn_id），按天聚合到 `usage_daily` 供报表。

### 11.10 模型接入与用途路由

```ts
interface ModelRoute {
  purpose: 'chat.default' | 'chat.vision' | 'router.intent' | 'kb.embed'
    | 'kb.rerank' | 'asr.default' | 'tts.default' | 'video.analyze'
  modelId: string
}
```

**四层口径**：Provider（端点 + 协议 + 密钥引用）→ Model（能力声明）→ ModelRoute（用途 → 模型）→ Adapter（按 `endpoint_kind` 分发）。`tags` 继续用于界面展示，运行时读 `capabilities`，缺省从 `tags` 回填，旧模型不失效。

- **能力与端点**：13 项能力（含 `embedding` / `rerank` / `audio` / `video`）与 6 种端点类型 `chat / embeddings / rerank / asr / tts / video`。
- **适配器现状**：`chat`（OpenAI 兼容 SSE + Anthropic / Gemini / Azure）、`embeddings`（OpenAI 兼容 / Azure / Gemini）、`rerank`（Cohere/Jina/SiliconFlow/vLLM/TEI 形态）已实现；`asr / tts / video` 只留端点类型与调用位。
- **路由规则**（按优先级）：显式 `model_routes` > 能力 + 优先级自动挑 > 返回 `null`（调用方降级，不报错）。
- **绑定校验**：向量用途只认 `embedding` / `endpoint_kind=embeddings`；重排只认 `endpoint_kind=rerank`；ASR/TTS 只认 `asr` / `tts`，避免音频对话模型被误当转写模型。
- **密钥隔离**：密钥按公司存 `secrets` 表（加密后存，密钥来自环境变量或机器密钥文件），**永不返回给前端**，日志脱敏。
- **流式错误归因**见 11.8，这是路由能否真正容灾的前提。

**重排序模型怎么配**：

1. 供应商填提供 rerank 的 Base URL（如 SiliconFlow `https://api.siliconflow.cn/v1`、Jina `https://api.jina.ai/v1`、Cohere `https://api.cohere.com/v2`、本地 TEI `http://host:8080`）。
2. 添加模型，类型选「重排序模型」，端点类型自动为 `rerank`；模型标识填服务商给出的 rerank 模型名（如 `BAAI/bge-reranker-v2-m3`）。
3. 到「用途路由」把「检索重排」绑定到它；不绑也可以按 `endpoint_kind=rerank` 自动挑。
4. 不需要重建索引；重排发生在每次检索的 RRF 之后，只对候选文本做二次打分，不改向量表。
5. 想关掉重排，把「检索重排」解绑或停用该模型即可，检索立刻退回 RRF 顺序。

**模型分类与接口如何确定**：

`GET {BaseURL}/models` 只保证返回模型 ID（部分供应商附带 owner/display_name），**不返回能力、输入模态或接口类型**，所以不存在“读清单就精确知道接口”的通用协议。EAB 的做法是两层：

- **导入时按名称推断**：`inferModelProfile()` 用 `rerank / embedding / whisper / tts / video / vision / router` 等特征给出建议类型、能力、端点与接口路径，并标 `high / medium / low` 置信度；导入弹窗逐条显示，允许改成正确类型再写入。
- **运行时按声明调用**：真正决定接口的是模型行上的 `endpoint_kind`，不是名称。名称推断错了，在模型编辑弹窗改「端点类型」即可，不需要改代码。
- **未知名称不猜死**：没命中特征时按普通对话模型处理（置信度 `low`），避免把未知模型误配成 embeddings/rerank。

常见接口对照：

| 类型 | 方法 + 路径（以 Base URL 为根） | 请求体 | 响应 |
|---|---|---|---|
| 对话 | `POST /chat/completions` | `{model, messages[]}` | `choices[{message}]` |
| 向量 | `POST /embeddings` | `{model, input[]}` | `data[{index, embedding[]}]` |
| 重排 | `POST /rerank` | `{model, query, documents[], top_n}` | `results[{index, relevance_score}]` |
| 语音转写 | `POST /audio/transcriptions` | multipart `file + model` | `{text}` |
| 语音合成 | `POST /audio/speech` | `{model, input, voice}` | 音频二进制 |
| 视频理解 | `POST /video/analyze`（EAB 自定义管线） | `{model, frames[], prompt}` | `{text}` |

> 注意：OpenAI 官方、Anthropic、Gemini、Azure OpenAI 都没有标准 rerank 接口；把它们的对话模型标成 `rerank` 会在调用时得到明确的“没有 /rerank”错误，而不是静默返回空结果。

**决策 / 语音 / 视频（已留位，未实现调用）**：

| 链路 | 用途 | 口径 |
|---|---|---|
| 决策模型 | `router.intent / router.model / router.tool` | 温度 0、超时 3–5s、JSON + schema、失败重试 1 次、规则兜底；未配置保持现状 |
| 语音 | `asr.default / tts.default` | 入站 ASR、出站 TTS 两条独立链路；长音频走 `ai_jobs`；V1 不做实时双向语音 |
| 视频 | `video.analyze` | 临时存储 → ffmpeg 探参数 → 抽关键帧 → 音轨 ASR → 视觉描述 → 文本汇总 → 结果落 `ai_jobs.result_json` |

**已落地控制台接口**：`GET /api/console/model-routes` 返回 8 个用途的绑定与当前生效模型（`source: route | fallback | none`）；`PUT /api/console/model-routes/:purpose` 绑定/解绑，能力不匹配返回 400，且校验失败不清掉原绑定。`GET /api/console/providers/:id/models` 的每个模型带 `suggested{modelType,label,capabilities,endpointKind,confidence,basis,api}`；`POST .../models/import` 接受 `models: [{modelKey, capabilities, endpointKind}]`，把推断结果或人工改写的类型直接写入 `models.capabilities / endpoint_kind`。


### 11.11 并发控制

| 层级 | 策略 |
|---|---|
| 会话 | 同一 conversation 同一时刻只允许 1 个 turn 执行（排队，最多 3 个等待，超出拒绝） |
| 用户 | 同一用户并发 turn ≤ 2（防跑飞） |
| 全局 | 全局并发 turn 上限（默认 CPU 核数 × 2），超出排队 |
| 工具 | 单 turn 内工具调用串行（除显式声明 `parallelSafe`） |
| worker | 每 worker 单任务，池大小可配 |

### 11.12 记忆

| 层 | 内容 | 写入权限 | 检索范围 |
|---|---|---|---|
| `session` | 当前会话摘要 | 自动 | 本会话 |
| `user` | 用户长期偏好/事实（"我负责考勤"） | 用户确认后写（**不允许模型静默写**） | 本人 |
| `dept` | 部门共享知识摘要 | `dept_admin` | 本部门 |
| `company` | 公司通用事实 | `company_admin` | 全公司 |

**红线**：模型不能直接把"用户说的话"写进长期记忆并长期生效——必须经过"用户确认"或"管理员操作"，否则会出现"记忆污染"与"跨会话权限残留"。

---

## 12. 客户端与协议

### 12.1 协议选择（ADR-06 落地）

| 用途 | 协议 |
|---|---|
| 增删改查 | HTTP REST（JSON），统一响应信封 |
| 对话流式 | `POST .../turns` 返回 `text/event-stream`，带 `id:` 序号 |
| 服务端推送（审批/通知/在线） | WebSocket `/ws`，或长轮询降级 |
| 文件上传 | `multipart/form-data` + 分片（大文件） |
| 健康检查 | `GET /healthz`（存活）、`GET /readyz`（依赖就绪） |

### 12.2 能力清单驱动 UI（ADR-13）

```json
// GET /me/capabilities
{
  "scopes": ["chat:use", "workspace:read", "workspace:write", "kb:read"],
  "dataScope": "self",
  "menus": ["chat", "workspace", "my-permissions"],
  "features": { "kb.search": true, "admin.plugins": false, "approval.decide": false },
  "limits": { "dailyTokens": 500000, "usedTokens": 12000 }
}
```

前端只读这份清单渲染；**每个接口后端独立校验**。菜单注册表放后端（新增功能改一处）。

### 12.3 幂等与断线

| 项 | 设计 |
|---|---|
| 幂等键 | 客户端为每个 `POST turn` 生成 `Idempotency-Key`；服务端 24h 内同键返回同一 turn（防重复提交/网络重试） |
| SSE 续传 | 每条事件带 `id: {turnId}:{seq}`；客户端断线后带 `Last-Event-ID` 重连，服务端从 seq+1 补发（缓冲最近 200 条） |
| 前端重连 | 指数退避（1s/2s/5s/10s），超过 3 次提示"网络异常" |
| 会话锁 | 前端同一会话禁用并发发送（UI 层面），后端仍有串行锁兜底 |

### 12.4 四端差异

| 端 | 登录 | Token 存放 | 特殊能力 | 特殊约束 |
|---|---|---|---|---|
| Web 控制台 | 本地账号 / 渠道扫码（需管理角色） | httpOnly Cookie | 组织树、插件审批、审计 | 内网/白名单 IP；写操作二次确认 |
| 员工端 Web | 渠道扫码 / 本地账号 | httpOnly Cookie | 工作区、文件预览 | 只 `self` 域 |
| 移动端 | 企业应用 JSAPI（`requestAuthCode` / `getAuthCode`） | Keychain / Keystore | 推送、拍照上传 | 文件选择受限，长文本编辑降级 |
| 访客门户 | 邀请码 / 一次性链接 | 短期 Cookie | 白名单问答 | 独立限流、独立审计、无组织数据 |

### 12.5 移动端路线

- **阶段一（Capacitor）**：复用员工端 Web；通过渠道 JSAPI 拿 code 换 EAB token；推送用渠道消息或极光/厂商推送（按客户环境定）。周期约 2 周。
- **阶段二（React Native）**：原生列表/输入/离线缓存/推送体验；共享 `shared-types` 与 API 契约。周期 6–8 周。
- **登录链路（统一）**：`App → 渠道 SDK 取 code → POST /auth/channels/{c}/exchange → EAB 双 token → 按 capabilities 渲染`。

### 12.6 管理控制台：信息架构与视觉规范（2026-11-08 定稿）

> 本节回答一件事：**控制台长什么样、功能怎么分类、哪些开源能力直接复用**。之前控制台是"五个平铺 tab + 左侧常驻组织树"，能跑但不像产品：组织树挤在左边跟任何页面无关、渠道绑定藏在"组织同步"页里、视觉没有层级。本节把它定成规范，然后按 S1–S4 分步实现。

#### 12.6.1 参考 DeepSeek Harness（DSH）的结论

DSH（`github.com/deepseek-ai/deepseek-harness`，MIT）是官方开源的 Agent Harness，前端在 `apps/web`：

| 观察 | 事实（读仓库得知） | 我们抄什么 / 不抄什么 |
|---|---|---|
| 技术栈 | Vite + React 18 构建，产物由 CLI 静态服务 | **抄分层**：构建产物 + 静态服务；**暂不抄 React**：M0 页面还不够复杂，引框架会让每改一屏都要构建（见 18.1.1 差异说明）。等页面出现表单编辑、权限矩阵编辑、图表时再切 Vite + React 18 + Radix 原语 |
| UI 是插件 | `dsh-client-ui-theme` / `-primitives` / `-slots` / `-dockkit` 四个包 | **抄思想**：主题是变量层、组件是原语层、页面只做组合。我们落成 `tokens → primitives → page` 三层 CSS/JS 约定（12.6.3） |
| 导航 | 设置（模型/插件）、工作区选择、会话；按"任务"而不是"数据表"分组 | **抄分类法**：一级导航按**业务域**分组，每组只放该域的页面，不把表名当页面 |
| 桌面端 | Electron 只做宿主，UI 尽量沿用上游，改动以 patch 形式存档 | **抄边界**：宿主不魔改 UI；我们的控制台也只做"壳 + 页面"，业务全在接口层 |

结论一句话：**DSH 值得抄的是"主题/原语/槽位"的分层和"按业务域分组"的导航，不是它的 React 代码**。

#### 12.6.2 功能分类（顶部一级导航 + 每页自带子导航）

布局固定为四层：**顶栏 `topbar`（品牌 + 当前公司选择器 + 健康点 + 退出）→ 一级导航 `primary-nav`（业务域）→ 二级导航 `nav-flyout`（悬停一级项时展开该域的页面列表）→ `workspace`（本页子导航 `subnav` + 内容区 `page`）**。

公司选择器固定在顶栏：始终显示“当前公司 · 名称 · ID”，点开可切换；切换后当前页按新公司重新加载，URL 同步 `?company=`，角色、模型、知识库、渠道、用量、审计等页面都以这家公司为范围。组织架构页左侧仍并列展示所有公司，当前公司根节点带「当前」标记。

| 一级导航（顶栏常驻） | 二级导航（悬停展开） | 本页子导航（左栏） | 谁能看 |
|---|---|---|---|
| 概览 | — | 当前身份（姓名/部门/数据范围/渠道）+ 快捷进入 | 全部登录身份 |
| 组织与权限 | 组织架构 / 角色权限 / 权限矩阵 | 组织架构=部门树；角色权限=角色列表；权限矩阵=图例 | `org:dept:read` / `perm:read` 类 |
| 知识与模型 | 知识库 / 模型接入 / 工具 | 知识库=库列表；模型接入=供应商与模型；工具=工具表 | `kb:read` / `model:manage` / `tool:read` |
| 连接与平台 | 渠道 / 插件 / 系统 | 渠道=绑定与同步；插件=插件清单；系统=小节锚点 | `channel:manage` / `plugin:list` / 登录身份 |
| 运营与审计 | 用量 / 审计 / 审批 | 用量=按天/按人；审计=哈希链校验；审批=待办与决定 | `usage:read` / `audit:read` / `approval:read` |

硬约束：

1. **一级导航只按业务域**，最多 5 个；同一业务域的页面放进二级悬停菜单，不把表名当一级项。
2. **二级导航只在悬停/键盘聚焦一级项时出现**，不常驻占一行；面板覆盖内容区，不挤压页面。
3. **子导航只属于当前页**，不做全站常驻的部门树 —— 知识库页左边挂组织树会让人以为库是按部门筛的。组织树只出现在「组织架构」页；知识库的左栏是**库列表**。
4. **选中态唯一**：一级是 `.nav-group.is-active`（或直接项的 `.nav-primary.is-active`），二级是唯一的 `.nav-sub.is-active`，子导航是唯一的 `.side-item.is-active`，不能出现“两个都亮”。
5. **公司上下文始终可见**：顶栏选择器不能隐藏；页面内不再重复放公司下拉。切公司只改范围，不改变控制台操作员身份。
6. **数字必须自洽**：子导航里的「N 人」和点进去内容区的行数同一口径 —— 服务端 `subtreeMemberCount` 按成员 `dept_path` 前缀统计（**含下级**），不能用各部门直属人数相加，否则上游回收过部门后会少数。

#### 12.6.3 视觉规范（tokens → primitives → page）

**令牌（`app.css` 顶部 `:root`，唯一改色入口）**

| 类别 | 令牌 | 取值（浅色） | 用途 |
|---|---|---|---|
| 品牌 | `--brand` / `--brand-ink` | `#0f6b5c` / `#ffffff` | 主按钮、选中态、logo |
| 面 | `--bg` / `--surface` / `--surface-2` | `#f6f8f8` / `#ffffff` / `#f1f5f4` | 页面底 / 卡片 / 次级块 |
| 线 | `--line` / `--line-strong` | `#e3e9e7` / `#cfd8d5` | 分隔线、卡片描边 |
| 字 | `--ink` / `--ink-2` / `--muted` | `#15201d` / `#40504b` / `#77857f` | 标题 / 正文 / 辅助 |
| 状态 | `--ok` / `--warn` / `--danger` / `--info` | `#0f7b4f` / `#a56a00` / `#b42318` / `#1d5fa8` | 徽标、差异、错误 |
| 尺度 | `--r-sm/md/lg` = `6/10/14px`；间距 4 的倍数；字号 12/13/15/20/28 | | 全站统一，禁止页面里写魔法值 |

**原语（只允许用这些组合页面）**：`.btn`（primary / ghost / danger / sm）、`.stat`（数字 + 标签）、`.pill`（状态徽标）、`.table`（粘性表头）、`.kv`（键值对，`.kv.single` 单列）、`.empty`（空态 + 下一步动作）、`.banner`（info/warn/danger）、`.modal`、`.checklist`（勾选式要点）、**`.topbar` + `.company-picker` + `.primary-nav` + `.nav-group` + `.nav-flyout` + `.nav-sub`**（顶栏公司选择与一级/二级导航）、**`.subnav` + `.side-list` + `.side-item`（`.is-active`）**（每页子导航）、`.split`（左右两栏）。

**规则**：① 一屏只有一个主行动按钮；② 危险动作（解绑、删除）用 ghost + 二次确认；③ 空态必须写"下一步做什么"，不写"暂无数据"；④ 表格里的状态列用 `.pill`，不用彩色文字；⑤ 数字右对齐、等宽字体；⑥ 任何权限拒绝都渲染成 `.banner danger` + traceId，不弹 toast。

#### 12.6.4 复用开源清单（先复用"设计"，不用"框架"）

| 需求 | 复用什么 | 许可 | 怎么用 |
|---|---|---|---|
| 设计令牌 | 自建（参考 DSH theme 的分层思路） | — | `:root` 变量，浅色为主，预留 `[data-theme="dark"]` |
| 图标 | **Lucide** 图标 SVG（抄单个 path，不引整包） | ISC | 内联 `<svg>`，避免 CDN 依赖（部署机可能没外网） |
| 表格/差异视图 | 手写；后续需要虚拟滚动再评估 **TanStack Table** | MIT | 现在 M0 数据量 < 100 行，不引 |
| 组件原语 | 现在手写；上 React 后引 **Radix UI Primitives** | MIT | 只在上 React 时引，避免两套语义 |
| 富文本/文档 | 暂不需要 | — | 等员工端做消息渲染再说 |
| 状态管理 | 现在 `state` 对象 + 重绘；上 React 后用 **Zustand** | MIT | 页面级状态，不引 Redux |
| 图表 | 后续概览页要趋势图时用 **uPlot**（体积小） | MIT | 只在概览页按需加载 |
| 主题切换 | `[data-theme]` + 本地存储 | — | 与 DSH 的 theme 插件同思路：主题只改令牌 |

#### 12.6.5 分步实现（每步都要能截图验证）

| 步 | 内容 | 验收 |
|---|---|---|
| **S1**（已完成） | 导航重构：一级导航按业务域分组；组织树移入「组织」页；渠道绑定 + 组织同步合成「渠道」页；新增「概览」页；令牌/原语落地 | 六个页面都能进、都能截图；老功能不丢 |
| **S1.5**（已完成） | 布局改为**顶部一级导航 + 每页自带子导航 + 内容区**：概览=身份与快捷入口、组织=部门树、知识库=库列表（点库换文档）、矩阵=说明与图例、渠道=小节 + 渠道状态、系统=小节锚点；`.subnav` 切换时整块换掉 | 六个页面的子导航各不相同且都可用；`node --check`、`pnpm verify`、50 条冒烟全绿 |
| S2 | 每个页面做"一屏一主行动"：渠道页做成"状态卡 + 时间线"；空态/加载/拒绝统一；概览补趋势图 | 截图对比 S1 明显更像产品 |
| S3 | 员工端（对话）页面骨架 + 能力清单驱动（12.2） | 能在页面上发起一次对话（假模型） |
| S4 | 上 Vite + React 18 + Radix（仅当 S2 之后页面开始需要复杂表单时） | 构建产物由 server 静态服务 |

※ S3 的工作台骨架（`/chat`）已提前落地，见 12.7；模型仍是演示回声。

### 12.7 两端形态：员工工作台 vs 管理控制台

这一节是产品边界，比页面长什么样更重要 —— 它决定了"谁能进哪个入口、看到什么"。

#### 12.7.1 一句话定义

**部署好的 EAB 本身没有员工账号体系。** 管理控制台是服务器侧的工具：部署完成后由拿到**超级管理员账号 + 密码**的人打开、绑定企业（钉钉 / 飞书 / 企微扫码授权）、同步组织架构、按组织与角色配权限。它**不登录任何组织成员**，进去之后是"控制台操作员"，不是某个员工。默认只允许在**服务器本机**登录（远程要显式开 `EAB_CONSOLE_ALLOW_REMOTE=1`）。员工侧只有一个入口 —— **工作台 `/chat`**：从钉钉机器人、网页、手机端登录后进对话页，选模型问问题，或者用"自动"让系统按权限挑一个。

**员工永远不会看到控制台和组织架构页。** `/`（根路径）不再落到控制台，一律 302 到 `/chat`；控制台在 `/admin`，没登录只出"管理员账号 + 密码"的门（不是员工登录）。员工侧界面里也没有"管理控制台"入口 —— 他要做的只有对话。

#### 12.7.2 两端对照

| 维度 | 员工工作台（`/chat`） | 管理控制台（`/admin`） |
|---|---|---|
| 入口 | 钉钉机器人 / 网页 / 手机端 | 服务器部署后由管理员打开 |
| 身份从哪来 | 渠道账号登录 → 落到组织里已有成员 | **超级管理员账号 + 密码**（`EAB_ADMIN_USER` / `EAB_ADMIN_PASSWORD`）；未配密码时自动生成并落盘 `.eab-dev/admin-credentials.txt`，默认只允许服务器本机 |
| 首屏 | 对话（空态给三个示例问题），左侧是账号与可用模型 | 概览（服务状态 / 已绑定渠道 / 最近差异 / 能力项） |
| 导航 | **左侧账号栏**（头像/姓名/公司·部门/角色、可用模型、退出登录）+ 顶栏只放会话标题与状态；**没有控制台入口** | 顶栏当前公司选择 + 一级导航（悬停展开二级）+ 每页自带子导航（12.6.2） |
| 能做什么 | `chat:use` + `model:use`，且模型对本人角色可见 | 组织、渠道、权限、知识库、系统各自的 `*_read/*_manage` |
| 不该出现 | 组织树、权限开关、同步按钮、其他同事的数据 | 对话记录正文（管理员可查审计，但不在页面里明文列） |

#### 12.7.3 模型的可见性与自动选择

| 关卡 | 规则 | 落在哪 |
|---|---|---|
| 功能闸 1 | 没有 `chat:use` → 连对话入口都不给，页面直接显示拒绝态（含所需 scope） | `/api/chat/messages`、`/api/chat/models` |
| 功能闸 2 | 没有 `model:use` → 不给任何模型 | 同上 |
| 模型闸 | 每个模型有"允许角色"清单：空 = 所有能对话的身份；非空 = 只对这些角色出现 | `models` 表（`roles` 列），控制台「模型接入」页可改 |
| 自动模式 | 在**可用集合**里取 `priority` 最大的那个；下拉第一项显示"自动（X）" | 同上 |
| 越权选择 | 手动指定一个自己无权用的模型 → 403，且区分"模型不存在"和"存在但无权"（后者不能让用户以为模型被删了） | 同上 |

这条"两层过滤"是刻意的：**功能权限**决定"能不能用模型这件事"，**模型可见角色**决定"能用哪几个"。只做前者会把所有模型暴露给所有人；只做后者会让没有对话权限的账号也能调接口。

#### 12.7.4 当前实现到什么程度（不要夸大）

| 项 | 现状 | 差什么 |
|---|---|---|
| 工作台页面 | `/chat` 已可打开：左侧账号栏（姓名/公司·部门/角色、可用模型列表、退出登录；**没有控制台入口**）、右侧消息流、输入框（附件 + 模型选择 + 发送）、空态示例、拒绝态；**未登录时是一张登录卡，不显示任何成员信息** | 会话历史持久化（刷新即清空）、消息级操作（重试/复制/引用知识库）、附件落盘、PDF/Word/Excel 解析与知识库摄取（见 12.7.7） |
| 模型 | 已改为读 `models` 表（`models JOIN model_providers`，只取启用且供应商 active 的行）；控制台「模型接入」可增删改供应商与模型；开发模式库为空时回落 3 个演示模型 | 真调用厂商适配器、密钥加密托管、额度与计费 |
| 身份 | 仍走 `devAuth` 的 `?as=`（开发预览），与 12.7.1 的"渠道登录"不是一回事 | T-09 登录与会话、钉钉机器人回调、网页/手机端登录态 |
| 权限 | 已按 `chat:use` / `model:use` / 角色可见性判；控制台可改角色权限点、数据范围与成员授权 | 部门级成员管理接口、自定义角色的新建/删除 |
| 组织绑定 | 三渠道扫码绑定 + 同步已跑通（模拟扫码） | 真 provider（验签、事件接收、增量同步） |

#### 12.7.5 未决项（与 12.7.1 直接冲突，需要拍板）

1. **控制台怎么进？** 已按"**唯一超级管理员账号 + 密码 + 本机限制**"落地：`/admin` 先出账号密码门，账号由 `EAB_ADMIN_USER`（默认 `admin`）决定，密码取 `EAB_ADMIN_PASSWORD`；未配置时启动进程生成一次并写入 `.eab-dev/admin-credentials.txt`，之后**重启沿用同一密码**。会话在进程内存里（httpOnly cookie `eab_console_sid`，8 小时），只接受 loopback 来源（`127.0.0.1` / `::1`），远程必须显式设 `EAB_CONSOLE_ALLOW_REMOTE=1`。进去是**控制台操作员**，不登录任何组织成员，也不继承某个人的角色。剩下要定的不是"要不要账号"，而是：多管理员 / 轮换、登录失败限速与审计、多实例共享会话。~~(a) 首个绑定渠道的人自动成为管理员~~（与"不登录组织成员"冲突，不采用）；(b) 内网限制已作为默认行为落地。
2. **员工从钉钉机器人进来时，第一次要不要建号？** 建议：渠道 open_id 能对上组织成员就直接用；对不上就落 `pending`，管理员在控制台认领，而不是自动建人。
3. **"自动选模型"依据什么？** 现在只看优先级；后续建议按问题类型（代码 / 长文档 / 一般问答）+ 模型能力标签匹配，且保留"手动覆盖"。

#### 12.7.6 工作台版面（对照 DeepSeek / 豆包 / 千问 网页版）

用户的否决很具体："模型选择应该放在发送框的位置，上传图片、文件都要参考现在的网页版对话设计；右上角不要显示人员信息，可以做侧边栏去显示用户信息，没有登录要显示登录。" 这一版按这三条重排，参照的是几个成熟网页对话产品的**共同形态**，不是自己发明：

| 参照 | 它们的做法 | 本版对应 |
|---|---|---|
| DeepSeek 网页版 | 输入框是一张卡片，发送键在右下；模型/联网等开关贴着输入区，不占顶栏 | 输入框卡片内：左下"图片/文件/模型"，右下圆形发送 |
| 豆包网页版 | 左侧是会话与账号，右侧对话；空态给示例问题 | 左侧账号栏 + 右侧对话，空态保留三个示例 |
| 千问网页版 | 模型选择是输入框旁边的小胶囊，点开才展开列表 | `#model-chip` 胶囊 + 向上弹出的 `#model-menu` |
| 三者共同 | **顶栏只放会话级信息，不放"我是谁"**；账号信息在侧栏 | 顶栏只剩"新对话"标题 + "演示回声"状态；右上角没有身份下拉 |

具体落在三处：

1. **身份从头到尾不在顶栏**：`/chat` 的顶栏只有会话标题与一个状态 pill。姓名、职务、公司·部门、角色、可用模型、退出登录全在左侧账号栏 —— **员工侧没有"管理控制台"入口**，管理面在 `/admin`，是服务器侧的另一条入口（12.8）。开发预览的"换个人"不再对外暴露，登录页不列成员、不提供选人登录；`?as=` 默认关闭，仅本机自动化测试显式设 `EAB_DEV_AUTH=1` 时可用。
2. **模型选择进入输入区**：`#model-chip` 显示"自动（深度推理）"这类当前值，点开是向上弹的模型列表（含"自动选择"与每个模型的说明）。左侧账号栏的模型列表与它是同一份状态，点哪边都会同步 —— 避免"两个地方各选一个"。
3. **未登录是一张登录卡**：`/chat` 不带登录态时，页面只渲染登录卡（有企业扫码时**扫码为主视觉**，账号密码为次级模式，点顶部「账号密码」平滑切换），**不列任何成员、不提供“直接选人登录”**，也不请求 `/api/me`。登录态失效同样回到登录卡，而不是"显示默认那个人" —— 后者正是多租户下最容易泄露别家信息的路。

#### 12.7.7 附件（图片 / 文件）：这一版认什么、不认什么

界面按网页对话产品的习惯做：选图后出缩略图、选文件后出文件名与大小，可在发送前逐个移除；输入区支持 `Ctrl+V` 粘贴截图/图片、拖拽文件，单条最多 4 个、单个不超过 10MB（前端拦截，后端再校验一次）。附件条标注「文本可读 / 图片可读 / 仅附件」，让用户在发送前就知道模型能不能读。

**这一版已经把可读内容送进模型**：`POST /api/chat/messages` 收 `attachments: [{ name, size, type, text?, dataUrl? }]`。文本类文件由前端读出正文（单个截到 12,000 字）放进 `text`，后端拼成 `【附件：文件名】正文` 附在用户消息里；图片由前端转成 `data:image/png|jpeg|webp|gif;base64,...` 放进 `dataUrl`，后端组装成 OpenAI 兼容的 `content: [{ type:'text' }, { type:'image_url' }]` 多模态消息，模型直接看图回答。实测当前 vLLM `Qwen3.8-27B-FP8` 支持 `image_url` 输入。

体积与落库边界：聊天路由单独把 `bodyLimit` 放到 60MB（工作区上传路由 80MB，避免全局限制误伤 50MB 文件），图片 dataURL 单项上限 14,000,000 字符；`meta_json` 只落 `name/size/type/chars/hasImage/readable`，不落正文和 base64，避免库和 SSE 被撑大。图片目前不落对象存储，历史会话只回显附件名与大小，不会把旧图重新发给模型。

PDF、Word、Excel 暂不解析正文（`packages/server` 没有对应解析库），会在提示里明确写「暂时无法读取正文，请转成文本或截图」。演示供应商仍不处理附件内容；真实模型才读。**只有附件、没有文字的消息也允许发送**（`text` 可以为空，但两者不能同时为空），超过 4 个附件回 400。


### 12.8 两个入口：管理控制台（服务器侧） / 员工工作台

这一节解决一个很容易被做混的问题：**控制台不是员工页面，员工也不登录控制台。**
EAB 部署在服务器上之后，只有两种人碰它：配置这家公司的人（管理员）、和这家公司的员工（对话用户）。
所以只有两套入口，**没有第三层"运维入口"** —— 早期那版 `/platform` 是多余的，已删除。

| 入口 | 谁 | 地址 | 身份怎么证明 | 能做什么 | 绝不能看到 |
|---|---|---|---|---|---|
| **管理控制台** | 服务器侧配权限的人（开发 / 部署后的运维，不是组织里的某个成员） | `GET http://127.0.0.1:8788/admin`（先出管理员登录页；员工端口 8787 不提供） | **超级管理员账号 + 密码**（默认 `admin` + 自动生成密码，落盘 `.eab-dev/admin-credentials.txt`）；会话是 httpOnly cookie；脚本可用 `x-eab-console-token` 服务令牌 + `x-eab-console: 1` | 管理**唯一这家公司**的组织/成员/角色与权限点/数据范围、知识库与 ACL、模型供应商与模型目录、渠道扫码绑定、插件启停、公司重命名/停用/删除 | 部署参数（库路径/端口/日志级别）、员工对话正文 |
| **员工工作台** | 公司里的成员 | `GET http://127.0.0.1:8787/chat` + 钉钉机器人 / 手机端 | 渠道登录 → 组织成员（本期开发预览用 `?as=`，T-09 换真登录） | 对话、选自己有权限的模型、用"自动"按权限挑模型 | 任何管理页、任何别的成员的数据 |

两条硬约束：

1. **控制台不是"员工登录"，是服务器侧的唯一管理员入口。** 账号密码只给开发/运维；进去之后是"控制台操作员"，不是组织里的王芳/张伟：不继承任何人的角色，也不在成员统计里出现；右上角只显示唯一公司身份牌，不显示谁的账号。默认只接受本机来源，远程必须部署侧显式开 `EAB_CONSOLE_ALLOW_REMOTE=1`。
2. **入口不混用，而且分端口。** 员工端口 `8787` 的 `/` 302 到 `/chat`，`/admin`、`/app.js`、`/app.css`、`/api/console` 一律 404；管理端口 `8788` 的 `/` 302 到 `/admin`，`/chat`、`/chat.html`、`/chat.js`、`/chat.css`、`/api/chat`、`/api/auth` 等员工面一律 404。`/admin` 没会话只出管理员登录页，员工看不到组织/权限页面；员工侧导航里没有"管理控制台"。控制台登录后同一个浏览器再开员工端口，仍然是员工身份（控制台请求必须显式带 `x-eab-console: 1`，员工接口不带）。
3. **部署参数只走环境变量。** 端口、库路径、日志级别、devAuth、管理员账号密码都不进界面、不从请求读；`/api/health` 只回答版本与存活。要改这些只能改环境变量并重启，不做"看着能改其实改不了"的假开关。

> 现状（不夸大）：控制台这一版能管"唯一这家公司里的组织、角色权限点、成员授权、知识库 ACL、模型供应商与模型目录、渠道绑定、插件启停、公司重命名/停用/删除"，**不提供切换公司，也不提供新建公司**；新建第二家会 409，组织接入只能走「钉钉扫码绑定组织」。**给公司配额度 / 日志级别** 还没有可写入口，仍属于部署侧（环境变量 + 重启）。管理员登录已做本机限制与 8 小时内存会话，但**还没有失败限速、失败审计、多管理员与轮换**；会话不跨进程，多实例部署需要换成共享会话存储。

#### 12.8.1 登录准入（已实现，可直接照做）

| 环节 | 规则 | 代码位置 |
|---|---|---|
| 账号 | `EAB_ADMIN_USER`，缺省 `admin`；不是组织成员，也不参与成员统计 | `config.ts` / `main.ts` |
| 密码 | 优先 `EAB_ADMIN_PASSWORD`；没有则生成 12 字符随机密码，写入 `.eab-dev/admin-credentials.txt`，**重启沿用** | `main.ts` |
| 来源限制 | 只接受 `127.0.0.1` / `::1` / `::ffff:127.0.0.1`；其他来源返回 403"控制台只允许在服务器本机登录"；要远程必须 `EAB_CONSOLE_ALLOW_REMOTE=1` | `console-auth.ts` |
| 会话 | 登录成功写 httpOnly cookie `eab_console_sid`，进程内存 Map，8 小时过期；`POST /api/console/logout` 清会话 | `console-auth.ts` / `routes/console.ts` |
| 页面门 | `/admin` 只看会话：没有会话就出 `admin-gate.html`，有会话才出控制台页面 | `app.ts` |
| 数据接口 | 必须带 `x-eab-console: 1`，且（会话有效 或 服务令牌相等）；只有 cookie 不带这个头 → 401，避免控制台会话被员工接口误认 | `console-auth.ts` / `session.ts` |
| 脚本 / 自动化 | `EAB_CONSOLE_TOKEN` + `x-eab-console-token` 仍然可用，但**只能调接口，不能开页面** | 同上 |

#### 12.8.2 角色 / 部门 / 用户三级权限

三级不是三套互不相干的开关，而是**逐层收窄**：

| 层级 | 管什么 | 落在哪 | 控制台入口 |
|---|---|---|---|
| **公司角色** | 能做什么动作（权限点）+ 能看到谁的数据（数据范围 `self` / `dept` / `dept_tree` / `company` / `global`） | `roles` + `role_scopes` | 「角色与权限」页：左侧角色列表，右侧改名、改数据范围、按前缀勾权限点 |
| **部门** | 组织树层级 + 知识库的部门 ACL（`acl_dept_paths`）；部门管理者的可见范围由角色的 `data_scope='dept'` 决定 | `depts`（`path` 物化路径）+ `kb_collections.acl_dept_paths` | 「组织架构」页看树与成员；「知识库」页看库级 ACL |
| **成员（用户）** | 这个人被授予哪些角色；多角色取并集，数据范围取**最宽**的那个 | `user_roles` + `authz_overrides` | 「组织架构」成员行的「改角色」弹窗（整组替换） |

生效顺序：`成员被授予的角色 → 角色权限点并集 → 角色数据范围取最宽 → 覆盖项（authz_overrides）→ PDP 判定`。所以：
- 给一个人加 `kb_admin` 不会自动给他 `chat:use`，除非那个角色本身有；
- 一个 `member` + 一个 `company_admin`，数据范围是**全公司**，不是"本人"；
- 知识库还有第二层：即使角色有 `kb:read`，库的 `acl_dept_paths` 不含他的部门路径，仍然读不到 —— 两层同时生效。

接口（都在 `/api/console` 下，需控制台会话 + `x-eab-console: 1`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/roles` | 当前公司的角色、数据范围、权限点、成员数 |
| PUT | `/roles/:code` | 改 `name` / `dataScope`（限 5 种）/ 整组替换 `role_scopes`；未知权限点 400 |
| GET | `/scopes` | 权限点全集（前端按前缀分组） |
| POST | `/members/:userId/roles` | 整组替换这个人的角色；未知角色 400，至少保留一个 |
| GET | `/members`（复用 `/api/org/members`） | 成员列表带当前角色 |

还没做的：**新建/删除自定义角色**（现在只能改 7 个内置角色）、**部门级成员管理接口**（部门管理者改本部门成员）、**角色删除时对已授权成员的迁移策略**。

#### 12.8.3 模型接入（对齐 DSH，支持厂商与本地模型）

参考 DSH 的"provider + model 两层"：**供应商**描述"哪个端点、什么协议、密钥从哪来"，**模型**描述"对外叫什么、内部 model_key 是什么、哪些角色能看到、优先级多少"。两层都按公司隔离（`company_id`），A 公司配的模型不会出现在 B 公司。

供应商类型（`PROVIDER_KINDS`，14 种，各带默认 Base URL 与协议）：

| 类别 | 类型 |
|---|---|
| 云厂商 | `openai` / `deepseek` / `qwen`（阿里云百炼 compatible-mode）/ `zhipu` / `moonshot` / `azure_openai` / `anthropic` / `gemini` |
| 兼容端点 | `openai_compatible`（任意 OpenAI 协议网关）/ `custom` |
| 本地模型 | `ollama`（`http://127.0.0.1:11434/v1`）/ `vllm`（`:8000/v1`）/ `lmstudio`（`:1234/v1`） |
| 演示 | `demo`（回声，不调真厂商） |

**密钥不落库**：`model_providers.api_key_env` 只存**环境变量名**（如 `DEEPSEEK_API_KEY`），控制台显示"已注入 / 未注入"，密钥本身由部署侧注入环境变量。理由：库文件常被复制/备份，把明文密钥写进 SQLite 是长期风险；要做界面录入必须同时做加密与密钥轮换，属于后续 `@eab/secrets`。

接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/model-kinds` | 14 种供应商类型 + 默认 Base URL + 协议 |
| GET / POST | `/providers` | 列 / 建供应商（`kind`、`name`、`baseUrl`、`apiKeyEnv`、`status`） |
| PATCH / DELETE | `/providers/:id` | 改 / 软删（唯一索引 `(company_id,name)`，不撞名） |
| POST | `/providers/:id/test` | 仅对 OpenAI 协议做 `GET {baseUrl}/models` 探测（6 秒超时），其他协议提示"请直接建模型" |
| GET / POST | `/models` | 列 / 建模型（`name`、`modelKey`、`providerId`、`roles[]`、`priority`、`enabled`） |
| PATCH / DELETE | `/models/:id` | 改 / 软删 |

**对话链路已切到这张表**：`GET /api/chat/models` 与 `POST /api/chat/messages` 都从 `models JOIN model_providers` 读（只取 `models.enabled=1` 且供应商 `status='active'`），再按当前身份的角色过滤"可见角色"；开发模式库为空时才回落到 3 个演示模型。**回答仍是演示回声**，还没有按 `provider.kind` 分发到 OpenAI / Anthropic / Gemini 适配器 —— 这是下一阶段（V1）的真调用链路。

#### 12.8.4 组织页的左右联动（已实现）

左树是"选择器"，右表是"结果"，不再一进页面就把全员列出来：

- 进页面时右侧只显示一张空态："先点左侧部门，右侧只显示该部门（含下级）的成员"；
- 点某个部门：右侧标题变成 `成员 · <部门名>`，筛选条件是 `deptPath.startsWith(选中路径)`，所以**含下级**；同时点带下级的部门会展开/收起，点"N 人"只筛不折叠；
- 有筛选时提供"清除部门筛选"，清掉后回到空态（不是回到全员）；
- 每行成员有「改角色」按钮，打开弹窗整组替换 `user_roles`，保存后立即重载当前部门成员；
- 成员表下面还有一块**「部门权限」只读概览**：本部门角色分布 + 命中的知识库部门 ACL（`acl_dept_paths` 前缀匹配），把"部门这一层管什么"直接摆在页面上，改角色/改库仍分别去「角色与权限」「知识库」。写接口（新建部门、改部门负责人、停用成员）还没做，列在 12.8.2 的待办里。

### 12.9 插件体系（对齐 DSH 的插件生命周期，按 EAB 的部署形态落地）

先把 DSH 的做法读明白，再决定 EAB 抄哪一段、不抄哪一段。DSH 的插件机制不是"一个插件页面"，而是一整套**包 → 声明 → 加载 → 运行 → 更新 → 卸载**的闭环：

| DSH 的环节 | DSH 的具体做法 | 能抄的判断 |
|---|---|---|
| 安装形态 | 插件是 npm 包（`.tgz` 或源码目录），`dsh plugin --profile <desktop\|web> add <包>` 转发给该 profile 的 pnpm；`update <name>` 在同一 spec 上重解析；`link:` 装工程目录用于开发 | 安装必须是**服务器侧动作**，但 EAB 不执行 pnpm，避免把供应链执行权放进控制台 |
| 声明位置 | profile 的 `package.json` 记 `dependencies` 版本，`dsh.profile.bundles` 列加载哪些 bundle；`cordis.patch.yml` 的 `insert: [{id, name, config}]` 往内核插插件并给配置 | EAB 抄"声明与加载分离"：`plugin.json` 声明贡献，`plugin_states` 决定这家公司用不用 |
| 清单字段 | `dsh.bundle.patch`、`dsh.client.inject`、`dsh.client.platform`、`dsh.compatibility.dsh`、`dsh.compatibility.profiles`、`exports`、`keywords` 含 `dsh-plugin`、`files` 白名单、`engines.node` | EAB 保留**兼容性、作者、许可、关键词、贡献页面、权限声明**；不引入 profile（EAB 单进程多公司） |
| 生效方式 | 安装/更新后**必须重启宿主**；内核 `apply()` 走 Cordis 生命周期（`store.load → installRpc → start → registerAdapter → effect dispose → provide client`） | EAB 每次请求重新扫盘，安装后**立即生效**，不需要重启；代价是没有常驻实例与后端路由 |
| 运行时管理 | 插件经 `ctx.connection.rpc.call` 走 `POST /api/<id>` 管理通道；UI 用 `__ModuleLoader__.load` 打包进宿主，靠 slots / settings / locale 注入 | EAB 用同一套 HTTP API + iframe 页面槽位；页面拿不到主控制台 DOM，数据受同一套 scope 约束 |
| 版本与生态 | GitHub Releases 分发 `<name>-<version>.tgz`；读 `api.github.com/repos/<owner>/<repo>/releases/latest` 检查更新（失败回退 `releases.atom`）；按版本号是否变化决定 `add` 还是 `update` | EAB 先做**本地插件源 + 版本/来源/指纹 + 更新提示**；在线仓库与签名校验留到有真实分发需求再做 |
| 运行数据 | `~/.dsh/integrations/<plugin>/profiles/<profile>/`（配置 + 按天日志），旧共享配置首次启动复制一份 | EAB 的插件是纯页面，不落运行数据；要写数据只能走 EAB API 的既有表 |
| 明确不做 | DSH 不提供 `plugins.detail.actions` 挂载，避免"打开"按钮泄漏到别的插件页 | EAB 同样把"打开页面"只放在插件自己的卡片上 |

EAB 的结论：**抄生命周期与治理，不抄 pnpm / profile / 热加载**。

#### 12.9.1 插件契约

```
plugins/
├── catalog.json                 # 插件源（货架）：id / version / sourcePath / tags
├── eab-plugin-oncall/           # 一个插件 = 一个目录，目录名必须等于清单 id
│   ├── plugin.json
│   └── page.html                # pages[].file 指向的文件，不许 ../ 或反斜杠逃逸
└── .trash/                      # 卸载不删除：移到这里，可人工恢复
```

`plugin.json` 的完整字段（除 `id` / `name` / `version` / `pages` 外都可选）：

```json
{
  "id": "eab-plugin-oncall",
  "name": "值班表",
  "version": "0.1.0",
  "description": "按部门挑人排每周值班表",
  "author": "EAB 内置示例",
  "license": "MIT",
  "homepage": "",
  "keywords": ["值班", "组织架构"],
  "compatibility": { "eab": ">=2026.11.0" },
  "scopes": ["org:member:read"],
  "pages": [{ "id": "oncall", "title": "值班表", "file": "page.html" }]
}
```

校验规则（任一不满足 → `valid=false` + 原因，不崩服务、不半加载）：

- `id` 必须满足 `^[a-z][a-z0-9-]{1,40}$`；安装时以清单 `id` 作为 `plugins/<id>` 目标目录名，所以 npm 包名 / GitHub 仓库名不必等于 id；磁盘直接发现的目录仍要求目录名等于 id；
- `name` / `version` 必填；`pages[].id/title/file` 必填且不许重复；
- `pages[].file` 不许 `..`、不许以 `/` 开头、不许含 `\`，文件必须真实存在；
- `scopes` 只允许申请 `SC` 全集里已经存在的权限码；
- `compatibility.eab` 只支持 `>=x.y.z`，不满足当前版本（根 `package.json` 的 `version`）直接判不合法；
- 清单 + 页面内容算一个 16 位 SHA-256 指纹，用来判断"磁盘上的包换了没"。

#### 12.9.2 生命周期状态机

| 状态 | 触发 | 存在哪里 | 界面上怎么显示 |
|---|---|---|---|
| `discovered` | 部署侧手工把目录放进 `plugins/` | 磁盘 + 没有任何公司的 `plugin_company_installs` 记录 | 已发现（部署侧放置） |
| `installed` | 控制台「安装插件…」成功 | `plugin_company_installs`（本公司）+ `plugin_installs`（服务器制品）+ 磁盘 | 已安装（仅本公司可见） |
| `enabled` / `disabled` | 控制台「启用（本司）/ 停用（本司）」 | `plugin_states(company_id, plugin_id)` | 已安装 · 本司启用 / 停用 |
| `invalid` | 清单校验失败 | 磁盘 + 无有效记录 | 清单不合法 + 原因 |
| `uninstalled` | 控制台「卸载…」 | 解除当前公司的 `plugin_company_installs`；`plugin_states` 只清当前公司；目录只在**最后一家公司卸载时**移到 `plugins/.trash/` | 当前公司列表消失；其他公司不受影响，审计里留痕 |

**别家公司已安装的插件不会进入当前公司的列表**：`loadPlugins(db, companyId)` 先按 `plugin_company_installs` 过滤，再叠加本公司的 `plugin_states`；同一份代码目录可以被多家公司共用，但安装归属、启停、卸载和生命周期记录各自独立。

安装动作的入口（`installPluginPackage` / `installPluginFromNpm` / `installPluginFromGithub`）：

1. **解析来源**：本地目录直接校验；npm 先取 `GET {registry}/<encoded-package>` 元数据、读 `dist-tags` 与 `versions[x].dist.tarball`、下载 tarball；GitHub 先按 `owner/repo` 取默认分支（失败回落 `main`，再试 `master`），从 `codeload` 下载 `tar.gz`；
2. **安全解包**：下载只允许 https（本机 `localhost` 例外），拒绝带账号密码/hash 的 registry；`tar -tzf` 逐条拒绝绝对路径、盘符、`..`、反斜杠；解压后 `lstat` 拒绝符号链接；5000 文件 / 60MB、下载包 30MB、registry JSON 8MB 上限；
3. **找插件根与 id**：本地目录根上找 `plugin.json`；npm 包找唯一 `plugin.json`；GitHub 在根目录向下最多 2 层找，或按用户填的「仓库内子目录」精确定位；`manifestIdOf()` 从清单读出 `id`，并以它作为 `plugins/<id>` 的目标目录名（npm scoped 包名、仓库名都不再要求等于 id）；
4. 统计文件数与体积，上限 **300 个文件 / 20MB**；
5. 先解析来源清单（不合法直接拒绝）；
6. 复制到 `plugins/.staging-<id>-<timestamp>`，**在暂存区再校验一次**；
7. 目标目录已存在时按归属处理：**当前公司已安装** → 必须显式「覆盖」才能更新，且有其他公司在用时拒绝单独覆盖；**当前公司没装、别家公司已装** → 指纹相同就只登记本公司的安装归属、不动物理目录，指纹不同则报冲突；**磁盘上没人认领** → 指纹相同直接认领，不同则拒绝；
8. 写 `plugin_installs`（版本、来源、来源路径/`sourceRef`、指纹、安装人、安装时间、更新时间）与 `plugin_company_installs`（公司 + 安装人 + 本公司安装/更新时间）；
9. 写 `plugin_events` 一条带 `company_id` 的 `install` 或 `update`；
10. 任一步失败：清掉暂存区和临时解包目录；如果旧目录已移走且新目录没落地，自动把旧目录移回来。

`source` 取值：`local-dir` / `npm` / `github`（磁盘发现为 `disk`）。`sourceRef` 形如 `npm:eab-plugin-x@1.2.0?registry=https%3A%2F%2Fregistry.npmmirror.com`、`github:owner/repo#main?dir=packages/plugin`。**npm 与 GitHub 只取包内容，不执行 `npm install`、`prepare`、仓库脚本或源码构建。**

卸载动作（`uninstallPluginPackage`）：校验 id → 校验当前公司是否安装（别家公司安装时拒绝）→ 只清当前公司的 `plugin_states` → 当前公司的 `plugin_company_installs.removed_at` 记时间 → 写 `uninstall` 事件 → **没有其他公司还在使用时**才把目录移到 `.trash/` 并把 `plugin_installs.removed_at` 记时间。**不物理删除**，运维可以手工捞回。

#### 12.9.3 数据表（迁移 `0007_plugin_lifecycle.sql` + `0017_plugin_company_install.sql`）

| 表 | 主键 / 索引 | 存什么 | 不存什么 |
|---|---|---|---|
| `plugin_installs` | `plugin_id` 主键 | 服务器制品登记：版本、来源、来源路径、指纹、安装人、安装/更新时间、卸载时间 | 不复制清单正文，避免库和磁盘两份事实打架；不表示某家公司是否可用 |
| `plugin_company_installs`（0017） | `(company_id, plugin_id)` 主键；`(plugin_id, removed_at)` 索引 | 哪家公司装了、安装人、本公司安装/更新时间、解除时间 | 不重复存版本/指纹；版本来自 `plugin_installs` |
| `plugin_events` | 自增 id；`at DESC`、`(plugin_id, at DESC)` | 安装 / 更新 / 启用 / 停用 / 卸载、操作人、公司、详情 | 不存页面内容、不存密钥 |
| `plugin_states`（0005） | `(company_id, plugin_id)` | 这家公司启不启用这个插件 | 不存全局开关 |

边界：**插件代码在磁盘共享，安装归属、启停、卸载和事件都按公司隔离；一家公司卸载只解除自己的记录，最后一家公司卸载才移入回收站。** 控制器读取 `plugin_events` 时，只保留“事件公司=当前公司”或“事件插件属于当前公司已安装插件”的记录；这样本司能看到自己插件的历史平台事件，又不会看到别家公司装了哪些插件。

#### 12.9.4 接口

| 方法 | 路径 | 谁能调 | 说明 |
|---|---|---|---|
| GET | `/api/plugins` | 有 `plugin:list` 的员工/管理员 | 本公司的插件清单 + 启停；**不返回安装来源、服务器路径** |
| POST | `/api/plugins/:id/state` | 有 `plugin:configure` | 按当前主体公司启用/停用 |
| GET | `/plugins/assets/:id/:file` | 有 `plugin:list` | 插件页面资源；未启用 / 越界 / 不存在都 404 |
| GET | `/api/console/plugins` | 仅控制台会话（`x-eab-console: 1` + 登录） | 插件管理器：本公司已安装清单 + 可安装/可更新条目 + 最近事件（含本公司与平台事件）+ 安装根目录/上限；返回 `companyId` |
| POST | `/api/console/plugins/install` | 仅控制台会话 | `{ source:'local-dir'\|'npm'\|'github', sourcePath?, packageName?, version?, registry?, repo?, ref?, subdir?, overwrite?, enable? }`；安装登记到当前公司；三源共用暂存校验、落库与审计 |
| POST | `/api/console/plugins/:id/uninstall` | 仅控制台会话 | 只解除当前公司的安装与启停；还有别家公司使用则保留共享目录，最后一家才移到 `.trash`、记审计 |
| GET | `/api/console/plugins/events` | 仅控制台会话 | 生命周期流水（默认 30 条，最多 100） |

控制台接口都先过 `isConsoleRequest`（必须带 `x-eab-console: 1` 且会话有效），**组织成员即使有插件权限也进不来**；员工侧 `/api/plugins` 永远看不到服务器路径与安装来源。

#### 12.9.5 插件源（本地生态）

`plugins/catalog.json` 是部署侧维护的"货架"，控制台只读：

```json
{
  "schema": 1,
  "plugins": [
    {
      "id": "eab-plugin-oncall",
      "name": "值班表",
      "version": "0.1.0",
      "description": "按部门挑人排每周值班表",
      "author": "EAB 内置示例",
      "tags": ["值班", "组织架构"],
      "sourcePath": "D:/AI kaifa/EAB/plugins/eab-plugin-oncall"
    }
  ]
}
```

- 控制台把 catalog 条目和磁盘清单对照，显示 **未安装 / 已安装同版本 / 可更新（旧版本 → 新版本）**；
- 点"安装 / 更新"只是把 `sourcePath` 填进安装弹窗，仍然走同一套校验，不从 URL 下载；
- 插件源为空或 JSON 坏了只显示错误，不影响已安装插件；
- 这就是 EAB 的"插件生态"最小闭环：**有货架、有版本、有来源、有更新提示、有安装记录**；在线市场 / 代码签名 / 远程 registry 未做。

#### 12.9.6 控制台界面（本轮落地）

插件页从"部署侧放包、控制台只启停"升级为**插件管理器**：

- 顶部统计：磁盘发现 / 登记安装 / 本司启用 / 清单不合法 / 插件源条目；
- 安装面板：插件根目录、300 文件 / 20MB 上限、`安装插件…`（三来源 Tab：本地目录 / npm 与国内镜像 / GitHub）、`重新扫描`；
- 已安装 / 已发现卡片：状态 pill、作者与许可、关键词、安装来源、安装记录、清单指纹、声明权限、贡献页面；操作 = `打开「页面」` / `停用（本司）` / `启用（本司）` / `更新…` / `卸载…`；
- 插件源卡片：未装 / 已装 / 可更新，一键把 sourcePath 带进安装弹窗；
- 生命周期记录表：时间 / 插件 / 动作 / 操作人 / 公司 / 详情；
- 左侧子导航：已安装列表、插件源列表、生命周期说明；安装来源与服务器路径**只在控制台出现**。

随仓库带演示插件 `plugins/eab-plugin-oncall`（值班表）：声明 `org:member:read`，页面通过 `/api/org/members` 取组织成员、按部门排 7 天班——证明插件真能读基座数据，而不是空壳卡片。如果它已被卸载，目录在 `plugins/.trash/` 下，可用安装弹窗的「本地目录」重新装回。

#### 12.9.7 明确没做的（防止被当成已有）

- **不执行安装脚本**：不跑 `npm install`、`prepare`、`postinstall`、`pnpm` 或 `git clone`，也不做仓库源码构建；npm 与 GitHub 只下载 tarball、解包、校验、复制；
- **不装依赖**：插件不能声明 npm 依赖，页面只能用浏览器原生能力 + EAB HTTP API；
- **不做插件后端路由**（自定义 `/api/plugin-x/*`）：插件要数据只能调基座既有 API；
- **不做进程外隔离**（子进程 / 容器）：插件是 iframe 页面，不是可执行后端；
- **不做热加载常驻实例**：安装后立即可见是因为每次请求重新扫盘，不是热替换一个运行中的进程；
- **不做私有源凭据 / 在线市场 / 代码签名**：当前只支持匿名公开 npm 包与公开 GitHub 仓库；私有 registry token、私有仓库 token、在线市场与签名校验都未实现；
- **不做插件按公司安装**：安装是服务器级，启停才是公司级；同一台服务器上所有公司看到同一份插件清单。

#### 12.9.8 验收口径

- `pnpm typecheck` 0 错误；
- `pnpm test` 166 条通过；
- `node scripts/smoke-http.mjs` **50 条**全绿（新增：无会话访问 `/api/console/plugins` → 401、有会话 → 200 且统计/安装根目录/插件源齐全、`/api/console/plugins/events` 可读）；
- 手工端到端：从 `catalog.json` 安装 → 出现安装记录与 `install` 事件 → 启用 → 停用 → 更新（旧目录进 `.trash`）→ 卸载（列表消失、审计留痕）；
- 浏览器实测：插件管理器、安装弹窗、插件源、生命周期记录表均正常渲染；
- 员工侧 `GET /api/plugins` 不出现 `install` / `sourceRef` / 服务器路径。

### 12.10 单公司本地部署（2026-11-08 产品口径）

**当前产品只做单公司本地部署：一套实例只绑定一家公司、一个组织架构。** 控制台不再提供“切换管理范围”，也不允许新建第二家公司；组织由「钉钉扫码绑定组织」接入。员工对话与管理控制台分两个端口：`8787`（员工）与 `8788`（管理）。

落地要点：

| 面 | 当前行为 |
|---|---|
| 身份 | `resolveActor` 用配置的唯一公司做 `assertSingleCompany`；不属于这家公司的旧账号在登录与每个请求上都被拒绝 |
| 控制台公司接口 | `GET /api/console/companies` 只查配置里的唯一公司，返回 `singleCompany: true`，忽略 `?company=` |
| 新建公司 | `POST /api/console/companies` 直接 409；扫码开通在库里已有公司时也拒绝建第二家，公司 ID 固定用配置值 |
| 前端顶栏 | 单公司时渲染 `.company-single` 身份牌，不出“切换管理范围”下拉 |
| 公司管理 | 支持重命名、停用/恢复、彻底删除（删除时按 `company_id` 清理全部业务表）；停用后员工不能登录，控制台仍可恢复 |
| 端口边界 | `buildApp(deps, surface)` 两个实例共用库；`surface guard` 让员工端口 404 管理接口、管理端口 404 员工对话与 `/api/auth` |

以下 12.10.1–12.10.5 是 2026-11-08 之前的多公司设计记录，保留下来解释为什么 schema 仍保留 `company_id`；**这些多公司入口在当前产品中不再启用。**

#### 12.10.1 历史：多公司线为什么原来是断的

早期实现里"公司"是**进程配置**：`config.companyId`（`EAB_COMPANY_ID`，默认 `c1`）被直接写进每条 SQL 与每个鉴权判断。单公司部署看不出问题，一旦同一台服务器上有第二家企业：

- 甲公司的管理员打开组织页，查询语句仍然 `WHERE company_id = 'c1'`，所以看起来"正常"；
- 乙公司的员工 `?as=` 进来，查到的还是 `c1` 的组织，接口却认为"他有 `org:dept:read`" —— **权限对、数据错**，比直接拒绝更危险；
- 渠道绑定、插件启停、知识库 ACL 全都复制同一份错误。

还有一处隐患在鉴权内核：`buildScopeFilter` 对 `dataScope='global'` 直接返回 `P.TRUE`（SQL 里的 `1 = 1`）。单公司时这是"超管不被部门范围限制"，多公司时就是**一次查询把别家的知识库和组织一起捞出来**。

#### 12.10.2 历史：公司从人身上取，不从进程配置取

> 这一小节描述的是多公司阶段的做法。当前单公司产品改为**配置决定唯一公司，身份再断言必须属于这家公司**；`subject.companyId` 仍参与查询，但不再允许是别家公司。

| 原来 | 现在 |
|---|---|
| `deps.companyId` 参与所有查询与鉴权 | **`subject.companyId`**（即 `person.companyId`）参与查询与鉴权 |
| `EAB_COMPANY_ID` 是"这台机器是哪家公司" | 降级为**单公司部署的默认公司**：只在"请求没带身份、需要一个兜底人"时用 |
| `?as=<userId>` 查人先按公司过滤 | 成员 id 全局唯一，**先查人、再由人给出公司**；按公司过滤反而会把真实的越权伪装成"查无此人" |
| `dataScope='global'` → `1 = 1` | 超管在**本公司内**不受部门限制，仍然带 `company_id` 谓词；reason 记为 `global-scope:company` 便于审计 |

一句话：**身份决定租户，配置只决定默认值。**

#### 12.10.3 隔离落在哪五处

| 面 | 隔离键 | 现状 |
|---|---|---|
| 组织 | `departments.company_id` / `users.company_id` | 已改：组织树、成员列表按主体公司查；「N 人」仍按 `dept_path` 前缀同口径统计 |
| 知识库 | `kb_collections.company_id` + collection 级 ACL | 已改：列表、单库、文档、权限矩阵都按主体公司 |
| 渠道 | `channel_configs.company_id` + `(provider, tenant_id)` 唯一 | 已改：绑定/解绑/绑定会话全部按主体公司；`(provider, tenant_id)` 仍全局唯一，**一个渠道租户只能属于一家公司** |
| 插件 | `plugin_states(company_id, plugin_id)` | 已改：插件清单、启停、页面资源都按主体公司；同一插件 A 公司开、B 公司关 |
| 跨公司管理 | ~~公司选择器（管理员登录后切换）~~ | **当前已移除**：单公司实例只显示一家，不再接受 `?company=` 切换；管理员也不能新建第二家 |

#### 12.10.4 历史：多公司演示（当前默认不再生成第二家）

多公司阶段用 `ensureSecondCompany` 增量补乙软件，用于验证隔离。**当前 `main.ts` 已移除这个调用；默认 `EAB_DEV_AUTH=0` 连第一家演示公司都不生成。** 旧库里残留的 `c2` 乙软件（3 人）保留为不可登录、不进控制台的残留数据，直到被彻底删除。

| | 甲科技 `c1` | 乙软件 `c2` |
|---|---|---|
| 成员 | 12 人（含飞书同步生成的 5 人） | 3 人（赵倩 公司管理员 / 钱磊 产品 / 孙浩 交付） |
| 部门 | 12 个（含同步出来的 6 个） | 3 个（乙软件 / 产品部 / 交付部） |
| 知识库 | 6 个 | 2 个（乙软件员工手册 / 交付规范） |
| 渠道 | 飞书 + 钉钉已绑定（演示租户） | 企业微信已绑定（演示租户），飞书/钉钉未绑 |
| 插件 | 值班表已启用 | 值班表未启用 |

可验证的三条（`scripts/smoke-http.mjs` 里是断言，不只是状态码）：

1. `/api/org/tree?as=u2_admin` 只返回 **3 个部门**，根节点叫「乙软件」；
2. `/api/kb/collections?as=u2_dev` 里**不出现**甲科技的库，`as=u_zw` 里**不出现**乙软件的库；
3. `/api/me?as=u2_dev` 的 `company.id` 是 `c2`；控制台切 `company=c2` 能看到乙软件的规模与租户。

#### 12.10.5 历史遗留与当前已补

- **控制台新建公司**：已改为单公司 409，只允许「钉钉扫码绑定组织」。
- **渠道租户自动建公司**：扫码绑定固定绑到配置的唯一公司；库里已有公司时拒绝建第二家。
- **公司重命名 / 停用 / 删除**：已补控制台「公司信息」面板与 `PATCH` / `DELETE /api/console/companies/:id`。删除会按 `company_id` 清理全部业务表，删完回到空库可重新绑定。
- **公司级模型目录与配额**：仍没有 per-company 配额；单公司下就是这套实例的全局配置。
- **跨公司审计**：已无跨公司视图；审计随唯一公司存，删除公司时一并删除。

---

---

## 13. 部署、运维与可观测

### 13.1 三种部署形态

| 形态 | 适用 | 组成 |
|---|---|---|
| 裸机服务 | 单台 Windows/Linux 服务器 | `eabd` + worker（systemd/winsw 托管）+ 本地 SQLite + 本地磁盘 |
| Docker Compose | 有容器规范的企业 | `eabd` 容器 + `postgres` + 可选 `qdrant`/`minio` |
| 开发模式 | 开发机 | `pnpm dev`：watch 编译 + 本地 SQLite + `.eab-dev` 数据目录 |

### 13.2 安装

```bash
npm i -g @eab/cli
eab init                      # 交互式生成 eab.config.json + 数据目录 + 初始超管
eab serve                     # 前台运行（调试）
eab service install           # 注册系统服务（Linux systemd / Windows winsw）
eab service start
```

**启动自检（启动即失败，不要带病运行）**：配置 schema 校验 → 数据目录可写 → 数据库迁移待执行检测 → 密钥是否齐全 → 端口占用 → 插件 lock 一致性 → 渠道连接器配置完整性。任一项失败给出**可执行的修复建议**并退出码非 0。

### 13.3 配置

```jsonc
// eab.config.json
{
  "server": { "host": "0.0.0.0", "port": 8787, "trustProxy": true, "cors": ["https://eab.corp.local"] },
  "storage": { "home": "C:\\ProgramData\\EAB", "db": "sqlite", "quota": { "user": "5GB", "dept": "50GB", "company": "500GB" } },
  "auth": { "local": { "enabled": true }, "feishu": { "enabled": false, "appId": "", "appSecretRef": "env:EAB_FEISHU_SECRET" } },
  "models": { "default": "openai-compatible/gpt-4o-mini", "fallback": ["ark/doubao-pro"] },
  "kb": { "provider": "sqlite-vec", "chunkSize": 512, "overlap": 64 },
  "plugins": { "allowedSources": ["npm:", "github:", "file:"] },
  "security": { "sessionTtlMin": 15, "refreshTtlDays": 7, "requireApprovalForHighRisk": true }
}
```

**优先级**：环境变量 > `eab.config.local.json` > `eab.config.json` > 内置默认。
**密钥**：配置里只写 `xxxRef`（`env:` / `file:` / `vault:`），**禁止明文**；启动时解析，解析失败即启动失败。

### 13.4 数据目录与日志保留（控制台可配）

当前实现把两项部署参数收进控制台「系统」页，落在部署根目录 `.eab-dev/console-settings.json`（引导文件固定在部署目录，因为数据目录决定库路径，必须在开库前读到）：

```jsonc
{
  "dataDir": null,              // null = 用部署目录 .eab-dev；可填其它盘绝对路径
  "logRetentionDays": 90,       // 0 = 永久保留；有效范围 7–3650
  "lastCleanupAt": "...",
  "lastCleanupStats": { "syncRuns": 0, "channelEvents": 0 }
}
```

**数据目录解析优先级**：`EAB_DB`（显式库文件，锁定目录，控制台只读）> `console-settings.json` 的 `dataDir` > 部署目录 `.eab-dev`。

**首次切换的搬迁规则**（`resolveStorage`，开库前执行）：目标目录没有 `eab.db` 且原目录有库时，把 `eab.db`、`eab.db-wal`、`eab.db-shm`、`secrets.json`、`admin-credentials.txt`、`demo-accounts.txt`、`backups/` 复制到新目录，**不删源目录**，避免"切目录等于丢数据"；控制台保存前会 `mkdir` 并写探针校验可写。运行期不移动库文件，保存后需重启生效。

**日志保留**（`runRetention`，启动 30 秒后首跑 + 每 6 小时检查）：

| 清理对象 | 时间字段 |
|---|---|
| `org_sync_diffs`（跟随 run 一起删） | 所属 run 的 `started_at` |
| `org_sync_runs` | `started_at` |
| `channel_events` | `received_at` |
| `login_attempts` | `updated_at` |
| `plugin_events` | `at` |
| `dingtalk_onboard_attempts` | `expires_at` |

**刻意不清理**：`audit_logs`（append-only 哈希链，删一条即断链，保留策略由合规决定）；用户对话、知识库、工作区文件（业务数据，只做目录搬迁，不做到期删除）。

**控制台长列表**统一「服务端分页 + 表格限高内滚」：同步记录/外部身份每页 10 条、审计每页 30 条，表头 sticky，`overflow` 只发生在表格容器内，页面本身不被记录数量拉长；分页器只在超过 1 页时出现。

### 13.5 升级与迁移

```
eab upgrade
  ↓ 1 预检：版本兼容性（插件 eabApiVersion）、磁盘空间、数据库版本
  ↓ 2 全量备份（见 13.6）→ 生成备份点 ID
  ↓ 3 停服务（优雅关闭：等待在途 turn 落库，最多 30s）
  ↓ 4 执行迁移（SQL 迁移文件按序执行，失败即回滚到备份点）
  ↓ 5 启动 + 自检 + 冒烟（内置 10 条健康探针）
  ↓ 6 成功则清理旧备份（保留最近 3 个）；失败自动回滚并输出原因
```

**规则**：迁移只前进不后退（不写 down 迁移），回滚靠"恢复备份点"。**每次迁移必须先在备份数据上演练一次**。

### 13.6 备份与恢复

| 项 | 设计 |
|---|---|
| 内容 | `data/`（含 SQLite 与工作区文件）+ `plugins/plugin.lock.json` + 配置（脱敏后）+ 审计流 |
| 方式 | `eab backup --to <path>`：SQLite 用 `VACUUM INTO` 保证一致性；文件用增量清单 |
| 频率 | 每日自动 + 变更前自动（升级/迁移前） |
| 保留 | 最近 7 日 + 最近 4 周 + 最近 3 月（可配） |
| 恢复 | `eab restore --from <backup>`：先校验哈希清单，再恢复到空目录，最后自检 |
| 演练 | **每月一次恢复演练**（脚本化），记录 RTO 实测值 |
| 目标 | RPO ≤ 24h（每日备份）/ RTO ≤ 30min（单机 10 万文件内） |

### 13.7 可观测性

| 项 | 设计 |
|---|---|
| 日志字段 | `ts, level, traceId, turnId, userId(哈希), companyId, module, msg, err.code, durationMs` |
| traceId | 每个 HTTP 请求生成；渠道消息用 `eventId` 派生；跨 worker 通过 RPC 头传递 |
| 指标 | `eab_turn_total{status}`、`eab_turn_duration_ms`、`eab_tool_calls_total{tool,ok}`、`eab_pdp_deny_total`、`eab_plugin_worker_restarts`、`eab_kb_query_ms`、`eab_queue_depth` |
| 健康 | `/healthz`（进程活着）、`/readyz`（DB/磁盘/worker 池/渠道连接就绪） |
| 告警 | 连续 3 次 provider_error、worker 崩溃 3 次、磁盘 > 85%、备份失败、审计链校验失败 → 通知管理员（IM + 控制台） |
| 慢查询 | SQLite `> 100ms` 的查询记录（含语句摘要、行数）；超过阈值告警 |

### 13.8 Windows 专项

| 项 | 做法 |
|---|---|
| 服务托管 | winsw（XML 配置 + `-WindowStyle Hidden`），服务账户用专用低权账号 |
| 目录权限 | 安装时显式设置 `%PROGRAMDATA%\EAB` 的 ACL（仅服务账户 + 管理员） |
| 长路径 | 统一 `\\?\` 处理；路径长度校验 |
| 杀软误杀 | 文档说明需将 `EAB_HOME` 与可执行文件加白；插件 worker 是子进程，避免被当脚本拦截 |
| 路径大小写 | 所有路径比较用规范化后的小写（仅在 Windows 生效） |
| 文件锁 | 覆盖/删除前先检测占用；升级前确保 worker 全部退出 |

---

## 14. 需求规格说明书

> 本章是**可验收的需求清单**。开发时按 FR 编号建任务、按验收要点写测试；任何"没写进这张表"的功能，都不算本期范围。
> 优先级：**P0** = 不做就不能上线；**P1** = 首版必须有但可后置；**P2** = 锦上添花。
> 阶段：**M0** = MVP-0 内核骨架；**M1** = 渠道接入；**M2** = 知识与多端；**V1** = 加固。

### 14.1 术语

| 术语 | 含义 |
|---|---|
| Subject | 已认证的主体：用户 + 公司 + 部门 + 角色 + 数据域 + 渠道 |
| Scope | 功能权限字符串，`资源:动作[:限定]` |
| dataScope | 数据可见范围枚举：self / dept / dept_tree / company / global |
| ResourceRef | 资源引用：类型 + ID + 归属 scope + 所有者 + 密级 |
| PDP | 策略决策点，唯一鉴权入口 |
| ScopeFilter | 由 subject 推导出的 SQL 谓词，强制下推 |
| Turn | 一次"用户提问 → 结束"的完整回合（状态机主体） |
| Worker | 执行进程，跑插件与重活 |
| 能力令牌 | 宿主签发给插件实例的授权凭据 |
| 绑定 | 渠道身份（senderId）↔ 本地用户的映射 |

### 14.2 角色画像

| 角色 | 典型人 | 核心诉求 | 最怕什么 |
|---|---|---|---|
| 平台超管 | IT 运维 | 装得上、跑得稳、能看日志、能恢复 | 出问题查不到原因、升级炸了 |
| 公司管理员 | 信息化负责人 | 组织能同步、权限能配、插件能管、能审计 | 权限配错导致数据泄漏 |
| 部门管理员 | 部门主管 | 能管本部门知识、能审批高危操作 | 天天被无关审批打扰 |
| 知识库管理员 | 行政/HR/技术文档负责人 | 文档能入库、能改权限、能看命中率 | 传了文档检索不到 |
| 普通员工 | 全员 | 问一句话就有答案、能传文件、能看到自己的东西 | 答错、答不出、被拒但不知道找谁 |
| 审计员 | 合规/内审 | 能查"谁在什么时候读了什么"、能导出 | 审计被删改 |
| 外部访客 | 客户/供应商 | 能问指定问题 | 看到内部数据 |

### 14.3 用例清单

| 编号 | 用例 | 参与者 | 前置 | 主流程 | 异常/分支 | 验收 |
|---|---|---|---|---|---|---|
| UC-01 | 本地登录并进入员工端 | 员工 | 已有账号 | 输入账号密码 → 校验 → 下发 token → 拉取 capabilities → 渲染菜单 | 密码错 5 次锁定 10 分钟；账号 disabled 提示联系管理员 | 登录后只看到自己有权限的菜单；无权限接口返回 403 |
| UC-02 | 渠道扫码登录 | 员工 | 渠道已配置 + 已绑定 | 点扫码 → 渠道授权 → 回跳带 code → 换 ExternalIdentity → 命中绑定 → 下发 token | 未绑定 → 引导页；渠道通讯录无此部门 → 拒绝并提示 | 不新建重复账号；同一渠道再次登录直接命中 |
| UC-03 | 组织全量同步 | 公司管理员 | 渠道通讯录权限已批 | 手动触发 → 拉部门树/成员 → 差异计算 → 落库 → 输出同步报告 | 单部门失败不阻断；网络中断可续跑 | 1000 人同步 < 60s；重复同步不产生重复记录 |
| UC-04 | 员工离职自动回收 | 系统 | 渠道推送离职事件 | 置 disabled → 吊销 session → 取消在途 turn → 工作区转只读 → 审计 | 事件丢失 → 次日全量同步兜底回收 | 离职后 1 分钟内旧 token 失效；工作区仍可导出 |
| UC-05 | 员工对话（含工具调用） | 员工 | 已登录 | 发送问题 → 流式回答 → 需要时调工具（有权直接调）→ 结果回填 → 完成 | 无权工具 → 结构化拒答 + 引导；模型报错 → 重试/降级 | 首 token < 2s（不含模型）；拒绝不中断会话 |
| UC-06 | 高危工具触发审批 | 员工 / 部门管理员 | 工具 risk=high | 员工请求 → 生成审批 → IM 卡片 + 控制台待办 → 管理员通过 → 继续执行 | 30 分钟超时自动拒绝；非审批人点击被拒并记录 | 审批通过后 turn 自动恢复，不需用户重发 |
| UC-07 | 上传文件并让 Agent 处理 | 员工 | 有 workspace:write | 上传 → 落盘（Resolver）→ 登记 → 解析（worker）→ 对话中引用 | 超配额 → 结构化提示；格式不支持 → 提示可转格式 | 文件只能落在自己 workspace；越界被拦截 |
| UC-08 | 部门知识库入库与检索 | kb_admin / 员工 | 有 kb:write / kb:read | 上传文档 → 解析切分 → 向量化 → 带 ACL 入库 → 员工提问 → 双检检索 → 带引用回答 | 解析失败重试；检索无结果 → 明说没有依据 | 跨部门检索召回为 0（负向测试覆盖） |
| UC-09 | 制度问答（应用模板） | 员工 | 有 kb:read | 问制度问题 → 只检索 policies → 回答带条款引用 | 无匹配 → 提示咨询入口 | 引用必须可点击回溯到原文件页 |
| UC-10 | 插件安装与审批 | 公司管理员 | 有 plugin:install/approve | 输入安装源 → 解析清单 → 展示能力 → 审批（可裁剪 optional）→ 落锁 → 启动 worker | 清单非法/来源非白名单 → 拒绝并说明；启动失败 → 回滚 | 未审批插件不产生任何工具；审批记录可查 |
| UC-11 | 插件调用宿主能力 | 插件 | 已 enabled | 插件 ctx.kb.search → 令牌校验 → 用户权限校验 → 执行 → 返回 | 令牌过期 / 越权 → 结构化拒绝，worker 不崩 | 插件无法替无权限用户读知识（负向测试覆盖） |
| UC-12 | 群聊里 @机器人提问 | 员工（群成员） | 群已绑定部门 | @机器人 提问 → 事件信封 → 按发送者身份处理 → 回复到群 | 群未绑定 → 提示；发送者未绑定 → 引导 | 不借用群权限；@他人不影响身份 |
| UC-13 | 管理员调整权限矩阵 | 公司管理员 | 有 authz:role:manage | 改角色 scope / 改用户角色 → 保存 → 缓存失效 → 即时生效 | 误删关键 scope → 二次确认；变更写审计 | 变更后 5 秒内生效；无缓存脏读 |
| UC-14 | 审计查询与导出 | 审计员 | 有 audit:read | 按人/时间/动作/资源筛选 → 列表 → 详情 → 导出（二次确认） | 导出超阈值 → 分批；导出行为本身写审计 | 审计不可改不可删；哈希链校验通过 |
| UC-15 | 服务安装与自启 | 平台超管 | 有服务器权限 | `eab init` → `eab service install` → 启动 → 重启机器自动恢复 | 配置非法 → 启动失败并给出修复建议 | 断电重启后服务自动拉起，健康检查通过 |
| UC-16 | 备份与恢复演练 | 平台超管 | — | `eab backup` → 恢复到新目录 → 自检 → 冒烟 | 备份损坏 → 校验失败不恢复 | 恢复后数据一致（抽样比对）；RTO 达标 |
| UC-17 | 访客使用受限功能 | 外部访客 | 持邀请码 | 进门户 → 验证 → 只用白名单功能 → 独立审计 | 尝试访问 /admin → 403；超频 → 限流 | 访客拿不到任何组织/文件数据 |
| UC-18 | 移动端一键登录 | 员工 | 企业 App 内打开 | 打开 App → JSAPI 取 code → 换 token → 进入 | token 过期 → 静默刷新；刷新失败 → 重新授权 | 首次进入无需输密码；退出后 token 清除 |

### 14.4 功能需求（FR）

#### 14.4.1 身份与登录（AUTH）

| 编号 | 需求 | 优先级 | 阶段 | 验收要点 |
|---|---|---|---|---|
| AUTH-01 | 本地账号登录（用户名+密码），密码用 Argon2id 加盐哈希 | P0 | M0 | 库中无明文；连错 5 次锁定 10 分钟 |
| AUTH-02 | 双 token（access 15min / refresh 7d），refresh 轮换且旧 token 立即失效 | P0 | M0 | 重放旧 refresh 被拒；并发刷新只有一个成功 |
| AUTH-03 | Web 用 httpOnly+Secure+SameSite Cookie 存 refresh | P0 | M0 | JS 读不到 refresh；跨站请求被 SameSite 拦 |
| AUTH-04 | 渠道扫码登录（飞书/钉钉/企微）统一 `authorizeUrl → code → ExternalIdentity` 抽象 | P1 | M1 | 三渠道接口形状一致；新增渠道不改上层 |
| AUTH-05 | OIDC 标准登录（企业统一身份） | P1 | M1 | 支持 discovery、id_token 校验、JWKS 轮换 |
| AUTH-06 | 外部身份绑定策略：唯一匹配自动绑，冲突拒绝，其余待管理员审批 | P0 | M0 | 冲突场景返回明确错误，不猜 |
| AUTH-07 | 会话管理：列表、吊销单个/全部、设备指纹、最近 IP | P1 | M1 | 踢下线后旧 token 立即 401 |
| AUTH-08 | 首次登录强制改密 + 初始超管密码只打印一次（不落日志） | P0 | M0 | 日志中搜不到初始密码 |

#### 14.4.2 组织（ORG）

| 编号 | 需求 | 优先级 | 阶段 | 验收要点 |
|---|---|---|---|---|
| ORG-01 | 部门树（parent_id + 物化 path + 排序），支持移动子树 | P0 | M0 | 移动后 path 批量更新；按 path 前缀查询正确 |
| ORG-02 | 成员管理：增删改、部门归属、岗位、工号、状态 | P0 | M0 | 变更写审计；离职不删数据 |
| ORG-03 | 渠道组织全量同步（定时 + 手动），输出同步报告 | P1 | M1 | 幂等；失败项可重试；报告含新增/变更/失败 |
| ORG-04 | 渠道增量同步（事件驱动）+ 定时兜底 | P1 | M1 | 事件丢失后 15 分钟内被兜底修正 |
| ORG-05 | 离职即时回收：disabled → 吊销 session → 取消在途 turn → 工作区只读 | P0 | M1 | 1 分钟内生效；不删数据 |
| ORG-06 | 群/项目域映射（chat_bindings / project 成员） | P1 | M2 | 未绑定群不做任何检索 |
| ORG-07 | 组织数据导出（成员清单 CSV）与权限校验 | P2 | M2 | 导出需 `org:member:read` + 审计 |

#### 14.4.3 权限（PERM）

| 编号 | 需求 | 优先级 | 阶段 | 验收要点 |
|---|---|---|---|---|
| PERM-01 | Scope 目录登记机制：代码常量 + 文档登记 + CI 校验未登记 scope | P0 | M0 | 新增未登记 scope 时 CI 失败 |
| PERM-02 | 7 个内置角色 + 可自定义角色；角色 → scope 列表 | P0 | M0 | 内置角色不可删；改动需审计 |
| PERM-03 | PDP 单一入口：`decide(subject, action, resource)`，返回 allow/deny/require-approval + matchedBy | P0 | M0 | 每次决策可解释；同输入同输出 |
| PERM-04 | 谓词下推：`buildScopeFilter` 强制非空，Repository 方法签名强制携带 | P0 | M0 | 类型层面无法写出"无 scope 的列表查询" |
| PERM-05 | 显式 allow/deny 覆盖（临时授权 / 例外），带过期时间 | P1 | M2 | 过期自动失效；变更审计 |
| PERM-06 | Subject 缓存与失效广播（5 分钟 TTL + 变更即失效） | P0 | M0 | 改角色后 5 秒内生效 |
| PERM-07 | 审批策略：高危动作 require-approval，一次性凭据绑定具体调用 | P0 | M0 | 凭据不能复用；超时自动拒绝 |
| PERM-08 | 负向测试套件（N-01 ~ N-10）纳入 CI | P0 | M0 | 全绿才能合并 |

#### 14.4.4 工作区（WS）

| 编号 | 需求 | 优先级 | 阶段 | 验收要点 |
|---|---|---|---|---|
| WS-01 | `WorkspaceResolver.resolve` 返回 FileHandle，越界抛 AccessDenied | P0 | M0 | 路径穿越/符号链接/绝对路径全部拦截 |
| WS-02 | 三级目录自动创建与归属校验（公司/部门/用户） | P0 | M0 | 目录名 `{id}-{slug}`；重命名不断引用 |
| WS-03 | 文件上传/下载/列表/删除（软删到回收区）/重命名 | P0 | M0 | 单文件默认上限 50MB；超限结构化错误 |
| WS-04 | 配额检查（个人/部门/公司），写前校验 | P1 | M1 | 超限写入被拒且提示剩余额度与申请入口 |
| WS-05 | 共享：个人文件共享到部门/项目（需审批，视策略） | P1 | M2 | 共享后权限正确；撤销即时生效 |
| WS-06 | 离职归档：工作区转只读 + 生成归档包 | P1 | M2 | 归档包可按申请导出 |
| WS-07 | 临时目录与工作区严格分离，按天清理 | P0 | M0 | tmp 不清空不影响用户文件 |

#### 14.4.5 会话与 Agent（CHAT）

| 编号 | 需求 | 优先级 | 阶段 | 验收要点 |
|---|---|---|---|---|
| CHAT-01 | 会话 CRUD（新建/列表/重命名/软删/导出） | P0 | M0 | 列表受 ScopeFilter；软删不物理删 |
| CHAT-02 | 流式对话（SSE，含 seq 与断点续传） | P0 | M0 | 断线重连带 Last-Event-ID 可续 |
| CHAT-03 | Turn 状态机落库，重启后可恢复/标记中断 | P0 | M0 | 杀进程重启后 awaiting_approval 的 turn 仍在 |
| CHAT-04 | 上下文装配器：来源声明 requiredScope + token 预算 | P0 | M0 | 裁剪结果写 turn 元数据，可解释 |
| CHAT-05 | 会话级串行锁 + 用户级并发上限 | P0 | M0 | 同会话并发第二个请求排队或拒绝，不交错 |
| CHAT-06 | 模型路由（多 provider + 能力标签 + fallback） | P1 | M1 | 主 provider 故障自动切备用，用户无感 |
| CHAT-07 | 流式错误归因（finish / provider_error / client_cancel 严格区分） | P0 | M0 | 上游 200 但空流 → 判失败，不落正常 finish |
| CHAT-08 | 用量与配额（用户/部门/公司），超限结构化拒答 | P1 | M1 | 用量可查、按天聚合 |
| CHAT-09 | 记忆分层（session/user/dept/company），写入需确认 | P2 | M2 | 模型不能静默写长期记忆 |
| CHAT-10 | 会话导出（Markdown/JSON）带审计 | P2 | M2 | 导出需 `chat:export` |

#### 14.4.6 工具（TOOL）

| 编号 | 需求 | 优先级 | 阶段 | 验收要点 |
|---|---|---|---|---|
| TOOL-01 | 工具注册表 + ToolDescriptor（scope/risk/dataEffect/idempotent/timeout） | P0 | M0 | 描述符缺字段拒绝注册 |
| TOOL-02 | 工具清单按 subject 裁剪（模型只看可见的） | P0 | M0 | 无权工具不出现在模型上下文 |
| TOOL-03 | 调用时二次鉴权（防伪造工具名/中途权限回收） | P0 | M0 | 伪造工具名 → 结构化拒绝 |
| TOOL-04 | 结构化拒答（code + message + hint）回填给模型 | P0 | M0 | 拒答不中断会话；用户看到人话+下一步 |
| TOOL-05 | 内置工具集：workspace 读写、kb 检索、组织目录查询、时间/计算 | P0 | M0 | 每个工具都有 requiredScope 与测试 |
| TOOL-06 | 工具执行超时/崩溃处理（worker 侧） | P0 | M0 | 超时返回结构化错误；worker 崩溃不影响主控 |

#### 14.4.7 插件（PLG）

| 编号 | 需求 | 优先级 | 阶段 | 验收要点 |
|---|---|---|---|---|
| PLG-01 | 清单解析与六项校验（命名/版本/API 窗口/scope 合法/工具⊆能力/入口可加载） | P0 | M0 | 任一项不通过拒绝安装并说明原因 |
| PLG-02 | 安装源：npm / github / file（`tgz` 待补） | P0 | M0 | 当前本地目录、npm（含国内镜像）、GitHub 三源可装；`tgz` 直链未实现 |
| PLG-03 | 审批流：展示能力 → 裁剪 optional → 记录审批人 | P0 | M0 | 未审批不可用；裁剪项生效 |
| PLG-04 | 插件进程隔离（每插件 worker，stdio JSON-RPC） | P0 | M0 | 插件死循环只影响自己；主控仍健康 |
| PLG-05 | 能力令牌 + 双重校验（插件权限 ∩ 用户权限） | P0 | M0 | 负向用例 N-05 通过 |
| PLG-06 | 生命周期状态机 + 熔断（连续 3 次崩溃 → broken） | P0 | M0 | 状态可查；broken 不再自动重启 |
| PLG-07 | 升级/回滚（保留最近 3 版；能力变化必须重审） | P1 | M1 | 升级不改能力可自动通过（策略可配） |
| PLG-08 | 开发体验：init / link（热重载）/ dev（独立数据目录）/ test / pack | P1 | M1 | link 后改代码 3 秒内生效 |
| PLG-09 | DSH 兼容适配层（只保证已实测的 3 个插件） | P2 | V1 | 三个目标插件可加载并跑通主流程 |

#### 14.4.8 知识库（KB）

| 编号 | 需求 | 优先级 | 阶段 | 验收要点 |
|---|---|---|---|---|
| KB-01 | 知识库创建（公司/部门/个人）、文档上传、删除、列表 | P1 | M2 | 建库需 `kb:admin`；跨域创建被拒 |
| KB-01a | **知识库可见范围配置**：`all` / `roles` / `depts`（含下级）/ `private`，保存即生效 | P0 | **M0（读侧内核已完成）** | 改配置后检索结果立即变化；未配置的库不可见 |
| KB-01b | 可见范围与密级组合：`confidential` 额外要求 `kb:admin` | P0 | M0（内核已完成） | 全公司可见 + 机密 → 普通员工仍检索不到 |
| KB-02 | 入库管线（解析→切分→向量化→带 collection_id 写库），状态可查可续跑 | P1 | M2 | 幂等（同内容重复上传不重复入库） |
| KB-03 | 检索双检（Provider filter + 后置 PDP 复检） | P1 | M2 | 传空 filter 被拒；跨知识库召回为 0 |
| KB-04 | 引用回链（chunk → 文档 → 原文件路径 + 页码，可点击） | P1 | M2 | 回答无引用时降级为"无依据" |
| KB-05 | 部门移动后的处理：批量重写 `kb_collections.acl_dept_paths` 里的子树路径，并同步 chunk 的 `dept_path` 标注 | P1 | M2 | 移动后可见性立即符合新组织；可断点续跑 |
| KB-06 | 制度问答模板（限定 policies 目录 + 强制引用） | P1 | M2 | 引用 ≥ 1 条；无依据时给咨询入口 |
| KB-07 | 外部 Provider 适配（Dify/RAGFlow/火山） | P2 | V1 | 外部库仍做 EAB 侧后置复检；当前已落地 Dify、通用 HTTP、Obsidian 导入三条路径 |
| KB-08 | 检索质量监控（top1 命中率、无结果率）+ 评测集回归 | P2 | V1 | 每次改切分/模型跑回归并出报告 |

#### 14.4.9 渠道（CHN）

| 编号 | 需求 | 优先级 | 阶段 | 验收要点 |
|---|---|---|---|---|
| CHN-01 | 统一事件信封 + 验签后构造（`verified` 标记） | P0 | M1 | 未验签不构造信封 |
| CHN-02 | 事件幂等去重（eventId 主键，24h 窗口） | P0 | M1 | 重推事件不重复响应 |
| CHN-03 | senderId 绑定表鉴权；未绑定走引导（不自动建号） | P0 | M1 | 未绑定不消耗 token、不检索 |
| CHN-04 | 飞书长连接（免公网）+ 钉钉 Stream + 企微回调加解密 | P1 | M1 | 三渠道至少各跑通一条消息往返 |
| CHN-05 | 消息分片与富文本降级（长文本切分、卡片优先） | P1 | M1 | 超长不丢内容；卡片失败降级文本 |
| CHN-06 | 频控（per sender / per chat）+ 发送失败重试队列 | P1 | M1 | 超频提示；死信告警 |
| CHN-07 | 群聊域映射（群绑定部门/项目，个人身份不借群权） | P1 | M2 | 群里 @他人 不影响身份 |
| CHN-08 | IM 审批卡片（按钮回传、签名校验、非审批人拒绝） | P1 | M1 | 审批 60 秒内可完成 |
| CHN-09 | 主动推送（通知/告警/长任务完成） | P2 | M2 | 推送失败进重试队列 |
| CHN-10 | 组织架构全量同步（部门树 + 成员 + 渠道身份），三家统一引擎 | P0 | M1 | 至少一家跑通；重复执行 diff 为空 |
| CHN-11 | 组织增量 + 每日校准 + 离职回收（连续两次缺失才删，离职即时失效） | P0 | M1 | 上游删人 5 分钟内无权限；抖动不误删 |
| CHN-12 | 同步报告（新增/改名/移动/离职/孤儿/异常，可回看） | P1 | M1 | 每次同步有可读报告，不靠翻日志 |

#### 14.4.10 管理与控制台（ADM）

| 编号 | 需求 | 优先级 | 阶段 | 验收要点 |
|---|---|---|---|---|
| ADM-01 | 组织树可视化（部门/成员/状态），支持搜索 | P0 | M0 | 1000 人内加载 < 2s |
| ADM-02 | 角色权限矩阵编辑（scope 勾选 + dataScope 选择） | P0 | M0 | 保存即生效；危险 scope 二次确认 |
| ADM-03 | 用户角色分配与临时授权（带过期） | P0 | M0 | 变更审计；过期自愈 |
| ADM-04 | 插件管理（安装/审批/启停/卸载/日志） | P0 | M0 | 能力清单可见可裁剪 |
| ADM-05 | 知识库管理（建库/上传/权限/统计） | P1 | M2 | 权限改动即时生效 |
| ADM-06 | 渠道与模型配置（连接测试、密钥脱敏显示） | P0 | M1 | 密钥永不回显明文 |
| ADM-07 | 我的权限页（员工可见自己能做什么、属于哪个部门） | P1 | M1 | 与后端 capabilities 一致 |
| ADM-08 | 配额与用量看板（用户/部门/公司） | P2 | V1 | 数据与 usage_daily 一致 |

#### 14.4.11 运维与审计（OPS）

| 编号 | 需求 | 优先级 | 阶段 | 验收要点 |
|---|---|---|---|---|
| OPS-01 | 审计流 append-only + 哈希链（prev_hash） | P0 | M0 | 篡改可检测；`eab audit verify` 通过 |
| OPS-02 | 审计查询（人/时间/动作/资源/结果）与分页 | P0 | M0 | 10 万条内查询 < 1s（带索引） |
| OPS-03 | 审计导出（CSV/JSON，二次确认，导出行为本身审计） | P1 | M1 | 导出文件带完整性校验 |
| OPS-04 | 健康检查 `/healthz` `/readyz` + 启动自检（失败即退出） | P0 | M0 | 配置错时启动失败并给出修复建议 |
| OPS-05 | 结构化日志 + traceId 贯穿（HTTP→turn→worker→插件） | P0 | M0 | 一个 traceId 能串起全链路 |
| OPS-06 | 备份/恢复/恢复演练脚本 | P1 | M1 | 恢复后抽样比对一致；RTO 达标 |
| OPS-07 | 升级流程（预检→备份→迁移→自检→失败回滚） | P1 | V1 | 迁移失败自动回滚到备份点 |
| OPS-08 | 指标暴露（可选 `/metrics`）+ 关键告警 | P2 | V1 | 告警能到 IM 与控制台 |

#### 14.4.12 CLI（CLI）

| 编号 | 需求 | 优先级 | 阶段 | 验收要点 |
|---|---|---|---|---|
| CLI-01 | `eab init` 初始化（目录/配置/初始超管/自检） | P0 | M0 | 重复执行安全（幂等，不覆盖已有配置） |
| CLI-02 | `eab serve` 前台运行；`eab service install/start/stop` 服务化 | P0 | M0 | Windows/Linux 均可；重启机器自启 |
| CLI-03 | `eab plugin add/link/update/rollback/remove/list/logs` | P0 | M0 | 与 ADM-04 行为一致 |
| CLI-04 | `eab backup/restore/audit verify/user create` | P1 | M1 | 命令有 `--help` 与示例 |
| CLI-05 | `eab doctor` 一键诊断（配置/DB/磁盘/worker/渠道/插件） | P2 | V1 | 输出可执行的修复建议 |

#### 14.4.13 访客门户与移动端（PTL / MOB）

| 编号 | 需求 | 优先级 | 阶段 | 验收要点 |
|---|---|---|---|---|
| PTL-01 | 独立入口与独立会话（不共享员工端 token） | P1 | M2 | 访客 token 无法访问任何员工接口 |
| PTL-02 | 白名单功能（按配置开启，如制度问答/工单查询） | P1 | M2 | 未开启功能接口 404/403 |
| PTL-03 | 独立限流与独立审计 | P1 | M2 | 访客行为单独可查 |
| PTL-04 | 邀请码/一次性链接（有效期 + 使用次数） | P1 | M2 | 过期/超次数失效 |
| MOB-01 | 移动端壳（Capacitor）+ 渠道 JSAPI 一键登录 | P1 | M2 | 首次进入免密 |
| MOB-02 | 移动端适配（列表/输入/文件预览/长文降级） | P1 | M2 | 常见机型可用 |
| MOB-03 | 推送（审批待办/长任务完成） | P2 | V1 | 推送失败有兜底（下次进入拉取） |

### 14.5 非功能需求（NFR）

#### 14.5.1 性能

| 编号 | 指标 | 目标 | 度量方式 |
|---|---|---|---|
| NFR-P-01 | 权限决策耗时 | P95 < 1ms（进程内） | 单测基准 |
| NFR-P-02 | 带 ScopeFilter 的列表查询（1 万行内） | P95 < 150ms | 压测 |
| NFR-P-03 | 首 token 延迟（不含模型推理） | P95 < 500ms | 埋点 |
| NFR-P-04 | 知识库检索（10 万 chunk） | P95 < 300ms | 压测 |
| NFR-P-05 | 组织全量同步（1000 人/200 部门） | < 60s | 集成测试 |
| NFR-P-06 | 并发对话 | 50 并发会话不劣化（队列可控） | 压测 |
| NFR-P-07 | 内存占用（空闲） | < 300MB（主控，不含 worker） | 监控 |
| NFR-P-08 | 单机文件规模 | 支持 50 万文件索引（列表分页可用） | 压测 |

#### 14.5.2 安全

| 编号 | 要求 | 验证方式 |
|---|---|---|
| NFR-S-01 | 100% 负向用例拦截（N-01~N-10） | CI 自动化 |
| NFR-S-02 | 密钥零明文：配置只存引用，DB 加密，日志脱敏 | 代码扫描 + 日志抽样 |
| NFR-S-03 | 密码 Argon2id；会话 token 随机 256bit；refresh 轮换 | 代码审查 |
| NFR-S-04 | 上传文件不执行：解析在 worker、按 MIME 校验、扩展名白名单 | 集成测试（上传伪造 exe） |
| NFR-S-05 | 路径穿越/符号链接/UNC 拦截 | 单测覆盖 20+ 变体 |
| NFR-S-06 | 审计不可改：append-only + 哈希链 | 篡改检测测试 |
| NFR-S-07 | 渠道事件必须验签；未验签不构造信封 | 伪造签名测试 |
| NFR-S-08 | 插件无裸 fs/进程/网络；出网需白名单能力 | 插件 SDK 审计 |
| NFR-S-09 | 依赖漏洞扫描（`pnpm audit`）不高于 medium | CI |
| NFR-S-10 | 管理端写操作二次确认 + 全量审计 | 手工 + 自动化 |

#### 14.5.3 可用性与可靠性

| 编号 | 要求 | 目标 |
|---|---|---|
| NFR-A-01 | 单机 7×24 连续运行 | 30 天无崩溃（内存无泄漏） |
| NFR-A-02 | 进程崩溃自动重启 | < 5s 恢复服务 |
| NFR-A-03 | 在途 turn 不丢 | 重启后 awaiting_approval 保留；streaming 标中断可重试 |
| NFR-A-04 | 备份 RPO / 恢复 RTO | RPO ≤ 24h；RTO ≤ 30min（10 万文件） |
| NFR-A-05 | 渠道断线恢复 | 自动重连 < 30s；不丢消息（拉取兜底） |
| NFR-A-06 | 数据库损坏检测 | 启动自检 + 每日 `integrity_check` |

#### 14.5.4 可维护性与可扩展性

| 编号 | 要求 |
|---|---|
| NFR-M-01 | 分层依赖单向、无循环（CI 检查） |
| NFR-M-02 | `core-domain`、`core-authz` 单测覆盖率 ≥ 90%，无 IO |
| NFR-M-03 | 新增一个内置工具 ≤ 1 个文件 + 注册一行 |
| NFR-M-04 | 新增一个渠道适配器不改上层（只实现接口） |
| NFR-M-05 | 新增一张表只加迁移文件 + repository，不改框架 |
| NFR-M-06 | 所有对外接口有 zod schema 与错误码约定 |

#### 14.5.5 兼容性

| 编号 | 要求 |
|---|---|
| NFR-C-01 | Windows 10/11 + Windows Server 2019+；Ubuntu 20.04+ / Debian 11+ |
| NFR-C-02 | Node ≥ 22.5（`node:sqlite`）、pnpm 可用；Windows / Linux 双平台 |
| NFR-C-03 | 浏览器：Chrome/Edge 最新两个大版本；移动端 iOS 14+/Android 10+ |
| NFR-C-04 | 企业代理环境可用（SSE 不依赖长连接） |
| NFR-C-05 | PostgreSQL 14+ 兼容 |

#### 14.5.6 合规与数据

| 编号 | 要求 |
|---|---|
| NFR-D-01 | 个人信息最小化：只存必要字段；敏感字段（手机/邮箱）可配脱敏展示 |
| NFR-D-02 | 账号删除支持：申请 → 管理员审批 → 导出 + 清除（审计保留） |
| NFR-D-03 | 数据留存策略可配（会话/记忆/审计分别配置） |
| NFR-D-04 | 所有跨域数据访问可追溯（审计包含 resource + scope） |
| NFR-D-05 | 导出/备份文件加密（可选密码） |

#### 14.5.7 可观测性

| 编号 | 要求 |
|---|---|
| NFR-O-01 | 每个请求/消息有 traceId；跨进程传递 |
| NFR-O-02 | 关键路径有指标（turn/tool/pdp/kb/plugin/queue） |
| NFR-O-03 | 慢查询记录（> 100ms）含语句摘要与行数 |
| NFR-O-04 | 告警阈值可配，支持 IM 通知 |

### 14.6 验收标准与完成定义（DoD）

**一个 FR 算"完成"必须同时满足**：

1. 代码合并到主干，通过 lint / 类型检查 / 单测 / 集成测试。
2. 该 FR 涉及的**负向用例**已覆盖（越权、非法输入、超限、并发）。
3. 有审计埋点（涉及资源访问的必须有）。
4. 有结构化错误码（不抛裸异常、不返回 500 给用户看）。
5. 文档同步：本文档对应章节更新，新增 scope/表/接口已登记。
6. 跨平台验证：Windows 与 Linux 至少各跑一次冒烟。
7. 重启验证：涉及状态的 FR，必须验证"杀进程重启后行为正确"。

**整体 MVP-0 验收（发布门槛）**：

| 编号 | 验收项 | 判定 |
|---|---|---|
| AC-01 | 全新机器一条命令装完，`eab serve` 可访问 | 通过/不通过 |
| AC-02 | 创建公司/部门/用户，三级目录自动生成且权限正确 | 通过/不通过 |
| AC-03 | 员工登录 → 对话（含流式）→ 工具调用 → 审计可查 | 通过/不通过 |
| AC-04 | 越权用例 N-01~N-10 全绿 | 通过/不通过 |
| AC-05 | 装一个插件（file: 与 npm: 各一），审批后工具可调 | 通过/不通过 |
| AC-06 | 杀掉主进程重启，在途审批 turn 仍可继续 | 通过/不通过 |
| AC-07 | 备份 → 恢复到新目录 → 数据一致 | 通过/不通过 |
| AC-08 | Windows 与 Linux 均能注册服务并开机自启 | 通过/不通过 |

### 14.7 明确不做（需求层面的非目标）

- 不做可视化工作流编排（拖拽节点、条件分支、循环）。
- 不做表单/审批单据的自定义设计器。
- 不做实时协作编辑（多人同时编辑同一文档）。
- 不做全文检索的复杂语法（只做自然语言 + 关键词）。
- 不做跨公司数据共享与联邦检索。
- 不做插件的市场化计费与结算。
- 不做"AI 自动写代码并部署"的自治能力（Agent 只做被授权的动作）。

---

## 15. 领域模型与数据字典

> 约定：所有业务表带 `company_id`（ADR-11）；时间统一 UTC（`*_at` 为 ISO 或整数毫秒，全库统一用一种，**选定整数毫秒**）；软删统一 `deleted_at`；主键统一 `TEXT`（ULID，字典序即时间序，便于分页与索引）。
> SQLite 与 PostgreSQL 字段类型映射：`TEXT` 双向通用；`INTEGER`↔`BIGINT`；`REAL`↔`DOUBLE PRECISION`；JSON 用 `TEXT`（SQLite）↔`JSONB`（PG），由存储层的 JSON 编解码函数统一（`canonicalJson` 负责键排序，保证哈希/比对稳定）。

### 15.1 身份与组织

**companies**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | 公司 ID |
| name / slug | TEXT | 名称、目录用 slug |
| status | TEXT | active / archived |
| settings_json | TEXT | 公司级配置快照（配额、默认模型等） |
| created_at / deleted_at | INTEGER | |

**departments**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| company_id | TEXT IDX | |
| parent_id | TEXT NULL | 根部门为 NULL |
| name | TEXT | |
| path | TEXT IDX | 物化路径 `/c1/d10/d23/`，**范围判断核心** |
| depth | INTEGER | 层级，便于限制 |
| order_no | INTEGER | 排序 |
| channel_dept_id | TEXT NULL IDX | 渠道部门 ID（幂等键之一） |
| channel | TEXT NULL | 该部门来自哪个渠道（feishu/dingtalk/wecom）；**三家外部 ID 都是数字，会撞号，唯一键必须带它** |
| missing_at | INTEGER NULL | 首次在同步结果中缺失的时间（连续两次缺失才回收，防抖动误删） |
| manager_user_id | TEXT NULL | 部门负责人 |
| created_at / deleted_at | INTEGER | |

索引：`(company_id, path)`、`(company_id, channel, channel_dept_id)` 唯一。

> 口径修正：`0001_init.sql` 当前建的是 `(company_id, channel_dept_id)` 唯一索引（单渠道先行时可用），
> 接入第二家渠道前必须由 `0003_org_sync.sql` 补 `channel` 列并重建索引，否则飞书的部门 ID 与钉钉撞号会写不进去。

**users**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| company_id | TEXT IDX | |
| dept_id | TEXT IDX | 主部门 |
| name / employee_no / title / email / mobile / avatar | TEXT | 敏感字段可脱敏展示 |
| status | TEXT | invited / active / disabled / archived / expired / **departed**（同步判定离职） |
| missing_at | INTEGER NULL | 首次在同步结果中缺失的时间 |
| recycled_at | INTEGER NULL | 连续两次缺失后回收的时间（权限即时收回，历史保留只读） |
| data_scope_override | TEXT NULL | 覆盖角色默认 dataScope（少见，需审计） |
| created_at / updated_at / disabled_at / deleted_at | INTEGER | |

**user_identities**（渠道绑定，等价于 `channel_bindings`）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| user_id | TEXT IDX | |
| provider | TEXT | local / feishu / dingtalk / wecom / oidc |
| external_user_id | TEXT | open_id / userid / sub |
| union_id | TEXT NULL | 跨应用唯一（飞书/微信） |
| bound_at / bound_by | INTEGER / TEXT | 谁绑的（自动/管理员） |
| status | TEXT | active / revoked |

唯一索引：`(provider, external_user_id)`。

**roles / role_scopes / user_roles**

| 表 | 关键字段 |
|---|---|
| `roles` | id, company_id, code, name, builtin(bool), data_scope, created_at |
| `role_scopes` | role_id, scope（多行） |
| `user_roles` | user_id, role_id, granted_by, granted_at, expires_at(NULL) |

**authz_overrides**（显式 allow/deny，PERM-05）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| company_id / user_id | TEXT | 作用对象 |
| effect | TEXT | allow / deny |
| scope | TEXT | 目标 scope |
| resource_type / resource_id | TEXT NULL | 为空=功能级覆盖；有值=资源级 |
| reason | TEXT | 必填（审计要求） |
| expires_at | INTEGER NULL | 到期自动失效 |
| created_by / created_at | TEXT / INTEGER | |

**sessions**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| user_id | TEXT IDX | |
| refresh_hash | TEXT | refresh token 的哈希（不存明文） |
| device_fingerprint / user_agent / last_ip | TEXT | |
| created_at / last_seen_at / revoked_at | INTEGER | |

### 15.2 运行时

**conversations**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| company_id / owner_user_id | TEXT IDX | |
| scope_type / scope_id | TEXT | user / dept / project / chat |
| title | TEXT | |
| channel | TEXT | web / app / feishu / dingtalk / wecom |
| pinned / archived | INTEGER bool | |
| created_at / updated_at / deleted_at | INTEGER | |

**turns**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| conversation_id | TEXT IDX | |
| seq | INTEGER | 会话内序号 |
| status | TEXT IDX | created/assembling/streaming/tool_pending/tool_running/awaiting_approval/completed/failed/cancelled/interrupted |
| idempotency_key | TEXT NULL | `(conversation_id, idempotency_key)` 唯一 |
| model / provider | TEXT | 实际使用的模型 |
| input_tokens / output_tokens / cost_estimate | INTEGER / REAL | |
| context_meta_json | TEXT | 装配了哪些源、裁剪了什么（可解释） |
| error_code / error_detail | TEXT NULL | provider_error 必须记录 |
| started_at / ended_at / duration_ms | INTEGER | |

**turn_steps**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| turn_id | TEXT IDX | |
| kind | TEXT | model / tool / approval_wait |
| attempt | INTEGER | 重试次数 |
| payload_json / result_json | TEXT | 脱敏后 |
| started_at / ended_at | INTEGER | |

**tool_calls**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| turn_id / step_id | TEXT IDX | |
| tool_name / plugin_id | TEXT | 插件工具带命名空间 |
| input_json / output_json | TEXT | 按 `audit` 级别决定是否完整记录 |
| required_scope | TEXT | 快照（便于事后审计） |
| decision | TEXT | allow / deny / require-approval |
| decision_reason | TEXT | matchedBy |
| status | TEXT | pending/running/success/failed/denied/timeout/approved-rejected |
| duration_ms | INTEGER | |

**approvals**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| company_id / requester_user_id | TEXT | |
| turn_id / tool_call_id | TEXT | 绑定具体调用 |
| action | TEXT | 审批的动作（工具名或动作码） |
| risk | TEXT | low / medium / high |
| reason | TEXT | 申请理由（模型生成的执行说明） |
| approver_role / approver_user_id | TEXT NULL | 指定/实际审批人 |
| status | TEXT IDX | pending / approved / rejected / expired |
| expires_at | INTEGER | |
| decided_at / decided_by / decide_note | | |
| credential_hash | TEXT NULL | 一次性凭据哈希（60s 有效） |

**memories**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| company_id / scope_type / scope_id | | session / user / dept / company |
| content / tags | TEXT | |
| confidence | REAL | |
| confirmed_by | TEXT NULL | 用户确认或管理员操作（**未确认不得长期生效**） |
| created_at / expires_at / deleted_at | INTEGER | |

**usage_records / usage_daily**

| 表 | 关键字段 |
|---|---|
| `usage_records` | id, company_id, user_id, dept_id, turn_id, provider, model, input_tokens, output_tokens, cost_estimate, created_at |
| `usage_daily` | company_id, dept_id, user_id, date, input_tokens, output_tokens, cost, turns（聚合表，定时任务维护） |

### 15.3 插件

**plugin_installs**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | installId（令牌绑定） |
| company_id | TEXT | |
| name / version | TEXT | |
| source | TEXT | npm:/github:/file:/tgz: |
| content_hash | TEXT | sha256 |
| manifest_json | TEXT | 清单快照 |
| granted_capabilities_json | TEXT | 审批后的实际授权（可能被裁剪） |
| status | TEXT IDX | pending-approval/installed/enabled/disabled/broken/failed/uninstalled |
| approved_by / approved_at | TEXT / INTEGER | |
| prev_version | TEXT NULL | 回滚用 |
| created_at / updated_at | INTEGER | |

唯一索引：`(company_id, name, version)`；`current` 用单独字段或 `status=enabled` 约束保证同名只一个启用。

> 实现版（迁移 `0007` + `0017`）把"服务器制品"和"公司安装归属"拆成两张表：`plugin_installs(plugin_id)` 记版本 / 来源 / 指纹 / 是否还在磁盘，`plugin_company_installs(company_id, plugin_id)` 记哪家公司装了、谁装的、何时解除。这样同一份代码目录可以被多家公司共用，而安装、启停、卸载、事件分别按公司隔离。

**plugin_runtime_status**

| 字段 | 说明 |
|---|---|
| plugin_install_id PK | |
| pid / started_at / last_heartbeat_at | 进程状态 |
| restart_count / consecutive_failures | 熔断依据 |
| last_error | 崩溃原因（末 200 行 stderr 摘要） |

**plugin_kv**：`(install_id, key) PK, value_json` —— 插件私有存储，按 install 隔离。

### 15.4 知识库

**kb_collections**（原 `kb_bases`，2026-11-07 改名并加入可见范围）

| 字段 | 说明 |
|---|---|
| id PK, company_id | |
| name / description | 知识库名称与用途说明（控制台展示） |
| acl_mode | `all` / `roles` / `depts` / `private`（见 7.6.1） |
| acl_roles | JSON 数组：角色码，`mode=roles` 时生效 |
| acl_dept_paths | JSON 数组：部门物化路径，含下级，`mode=depts` 时生效 |
| owner_user_id | `mode=private` 时的所有者 |
| provider / config_json | provider: sqlite-vec / pgvector / qdrant / remote；外部连接配置（密钥用引用） |
| owner_dept_path / created_by | |
| status / created_at / updated_at / deleted_at | |

**kb_docs**

| 字段 | 说明 |
|---|---|
| id PK, company_id, collection_id IDX | 所属知识库（可见性继承） |
| title / source_type / source_uri | source_uri 经 Resolver 存相对路径 |
| mime / size_bytes / page_count | |
| checksum | 幂等键（同文档同内容不重复入库） |
| dept_path / scope_type / scope_id / owner_user_id | 管理范围（写/删用，不参与读可见性判定） |
| classification | `public` / `internal` / `confidential`（**NOT NULL，默认 internal**） |
| status | pending / indexing / indexed / failed / deleted |
| chunk_count / error | 入库进度与失败原因 |
| created_at / updated_at / deleted_at | |

索引：`(company_id, collection_id)`、`(company_id, checksum)`、`(company_id, status)`。

**kb_doc_versions**：`(doc_id, checksum) PK, version, created_at` —— 内容变化历史。

**kb_chunks**

| 字段 | 说明 |
|---|---|
| id PK, company_id, doc_id IDX | |
| collection_id IDX | 冗余所属知识库：让"可见知识库集合"直接编译成 `collection_id IN (...)`，不用 join |
| ordinal / text / token_count | |
| dept_path | 只作来源标注与部门移动后的重写锚点 |
| classification | 密级（NOT NULL，默认 internal） |
| source_page / heading_path | 页码与标题层级（引用回链用） |
| embedding | 向量（sqlite-vec / pgvector），单独列或同列 |
| created_at | |

索引：`(company_id, collection_id)`、`(doc_id, ordinal)`、向量索引。

**kb_jobs**：`id, doc_id, kind(parse/embed/reindex), status, attempts, last_error, created_at, updated_at` —— 后台任务表（MVP 用表驱动队列，不引入 Redis）。

### 15.5 渠道

**channel_events**（幂等）

| 字段 | 说明 |
|---|---|
| event_id PK | `${channel}:${rawId}` 或内容哈希 |
| channel / received_at | |
| sender_external_id / chat_id | |
| handled_status | done / skipped / failed |
| expires_at | 24h 后清理 |

**chat_bindings**：`chat_id PK, channel, scope_type, scope_id, bound_by, bound_at`。

**channel_configs**（渠道接入配置，三家各一行）

| 字段 | 说明 |
|---|---|
| id PK / company_id | |
| provider | feishu / dingtalk / wecom |
| enabled / status | 是否启用；status 记录状态：`unconfigured / bound / unbound / ok / missing_scope / bad_secret / unreachable`（`bound` = 已扫码绑定企业，`ok` = 绑定且最近一次同步成功） |
| app_id / agent_id / corp_id | 各家的应用标识（不同家字段不同，多余字段留空） |
| secret_ref | 只存引用，明文进 `secrets` 表加密 |
| **tenant_id / tenant_name** | 扫码授权换到的企业租户标识与名字（飞书 `tenant_key` / 钉钉 `corpId` / 企微 `corpid`）。**`(provider, tenant_id)` 全局唯一** —— 一个租户只能绑一家 EAB 公司 |
| **bound_at / bound_by_user_id** | 谁、什么时候扫码绑定的（绑定留痕，追责与换绑都要） |
| sync_mode | full / incremental / off（组织同步是否开启；解绑后置 `off`） |
| last_sync_run_id / last_synced_at | 指向 `org_sync_runs` |
| created_at / updated_at | |

**channel_bind_sessions**（扫码绑定会话，0004 新增）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | `bnd_xxx` |
| company_id / provider | TEXT | 发起绑定的公司与渠道 |
| state | TEXT | 随机串，回填到二维码内容里做防伪，唯一 |
| status | TEXT | `pending / scanned / authorized / expired / cancelled / failed` |
| qr_content / qr_image_url | TEXT | 二维码内容与图片（真渠道是渠道返回的链接，模拟渠道是 `eab://channel/bind?…`） |
| tenant_id / tenant_name | TEXT | 授权后换到的租户 |
| error_message | TEXT | 失败原因（授权被拒、权限不足等） |
| created_by_user_id / created_at / expires_at / authorized_at | | TTL 默认 5 分钟 |

索引：`state` 唯一；`(company_id, provider, created_at DESC)` 查最近会话。

> 为什么绑定要单独一张会话表：扫码是"真人在渠道 App 点确认"，服务端只能发码 → 等 → 拿租户。中间态必须可查可重试，否则页面只能靠刷新猜。真渠道只是把"模拟扫码"换成"渠道回调/轮询到授权码后换租户"，后面的写绑定逻辑完全复用。

**outbound_queue**：`id PK, channel, target_json, payload_json, status(pending/sent/dead), attempts, next_retry_at, last_error`。

**unbound_attempts**：`id, channel, external_id, name_guess, first_at, count` —— 用于批量开通。

### 15.6 审计与系统

**audit_logs**（append-only，**禁止 UPDATE/DELETE**）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| seq | INTEGER | 单调递增，哈希链顺序 |
| company_id / actor_user_id | TEXT | 主体 |
| action | TEXT | scope 或动作码（如 `plugin.install`、`tool.invoke`） |
| resource_type / resource_id / resource_scope | TEXT | 对象 |
| result | TEXT | allow / deny / success / failure |
| detail_json | TEXT | 脱敏后的入参摘要、耗时、错误码 |
| trace_id / ip / channel | TEXT | |
| prev_hash / hash | TEXT | 哈希链：`hash = sha256(prev_hash + 规范化(本条字段))` |
| created_at | INTEGER IDX | |

索引：`(company_id, created_at)`、`(actor_user_id, created_at)`、`(action, created_at)`、`(seq)` 唯一。

**org_sync_runs**：`id PK, company_id, provider, mode(full/incremental), status, started_at, ended_at, stats_json, error_json`。
索引 `(company_id, provider, started_at DESC)`。`stats_json` 至少含
`deptsCreated / deptsRenamed / deptsMoved / usersCreated / usersUpdated / usersDeparted / orphans / errors[]`。

**org_sync_diffs**（报告明细，默认保留 30 天）：`id PK, run_id IDX, item_type(dept/user/identity), action(create/rename/move/depart/orphan/error), entity_id, before_json, after_json, created_at`。
控制台「系统」页读 runs 出摘要，点开某一次再读 diffs 看明细 —— 不需要另做日志检索。

**secrets**：`id, company_id, name, cipher_text, key_ref, created_at, rotated_at` —— 加密存，密钥来自环境变量或机器密钥文件。

**system_meta**：`key PK, value` —— schema 版本、实例 ID、初始化标记等。

**quotas**：`id, company_id, scope_type(user/dept/company), scope_id, bytes_limit, bytes_used, tokens_limit_month, updated_at`。

### 15.7 迁移与索引约定

1. 迁移文件命名：`0001_init.sql`、`0002_add_turn_status.sql`，**只前进不后退**；文件内容必须幂等安全（`IF NOT EXISTS`）。
2. 每个迁移文件头写"目的 / 影响表 / 是否可在线执行 / 预计耗时"。
3. 大表加索引用 `CREATE INDEX CONCURRENTLY`（PG）或分批重建（SQLite），避免启动阻塞。
4. 所有 `TEXT` 时间字段禁用（统一 `INTEGER` 毫秒）。
5. 单表超过 500 万行（`audit_logs` 最先到）→ 按季度分表或归档到 `audit_archive/`，查询走联合视图。

---

## 16. 接口契约

### 16.1 统一约定

**响应信封**

```json
{ "ok": true, "data": { }, "traceId": "..." }
{ "ok": false, "code": "EAB_SCOPE_DENIED", "message": "人话说明", "details": { }, "hint": "可行动建议", "traceId": "..." }
```

**错误码**

| 码 | HTTP | 含义 | 用户可见 |
|---|---|---|---|
| `EAB_AUTH_REQUIRED` | 401 | 未登录 / token 失效 | "请重新登录" |
| `EAB_FORBIDDEN` | 403 | 有登录但无该功能权限 | "你没有这个功能的权限" |
| `EAB_SCOPE_DENIED` | 403 | 数据范围不允许（资源级） | "你无权访问该部门/文件" + 找谁 |
| `EAB_APPROVAL_REQUIRED` | 202 | 需要审批，已生成待办 | "已提交审批，等待 XX 审批" |
| `EAB_NOT_FOUND` | 404 | 资源不存在 | — |
| `EAB_CONFLICT` | 409 | 状态冲突（并发、幂等冲突） | "操作正在进行，请稍后" |
| `EAB_VALIDATION` | 400 | 参数校验失败 | 指出哪个字段 |
| `EAB_QUOTA_EXCEEDED` | 429 | 配额/限流超限 | "额度已用完，可申请提额" |
| `EAB_RATE_LIMITED` | 429 | 频率超限 | "操作过于频繁" |
| `EAB_UPSTREAM` | 502 | 模型/渠道上游失败 | "服务暂时不可用，已自动重试" |
| `EAB_INTERNAL` | 500 | 未预期错误（不暴露细节） | "系统异常，已记录（traceId）" |

**通用请求头**：`Authorization: Bearer <access>`（或 Cookie）、`X-Request-Id`（可选，否则服务端生成）、`Idempotency-Key`（写操作可选）。

### 16.2 认证

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | `/auth/login` | 公开 | 本地账号登录：`{username, password}` → `{accessToken, refreshCookie, user}` |
| POST | `/auth/refresh` | 公开（凭 refresh） | 轮换 refresh，返回新 access |
| POST | `/auth/logout` | 登录 | 吊销当前 session |
| GET | `/auth/channels` | 公开 | 返回已启用的渠道与授权入口 |
| GET | `/auth/channels/:channel/authorize` | 公开 | 302 到渠道授权页（带 state） |
| POST | `/auth/channels/:channel/exchange` | 公开 | `{code, state}` → token 或"未绑定"错误 |
| GET | `/auth/oidc/authorize` / `POST /auth/oidc/callback` | 公开 | OIDC 登录 |
| GET | `/me` | 登录 | 当前用户 + 部门 + 角色 |
| GET | `/me/capabilities` | 登录 | 见 12.2（前端渲染唯一依据） |
| GET | `/me/sessions` | 登录 | 我的登录设备 |
| DELETE | `/me/sessions/:id` | 登录 | 踢掉某设备 |

### 16.3 会话与对话

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/conversations` | `chat:history:read` | 列表（带 ScopeFilter、分页、搜索） |
| POST | `/conversations` | `chat:use` | 新建 `{title?, scopeType?}` |
| PATCH | `/conversations/:id` | `chat:history:read` | 重命名 / 置顶 / 归档 |
| DELETE | `/conversations/:id` | `chat:history:delete` | 软删 |
| GET | `/conversations/:id/turns` | `chat:history:read` | 回合列表（分页，倒序） |
| POST | `/conversations/:id/turns` | `chat:use` | **SSE 流式**，`{text, attachments?, model?, idempotencyKey}` |
| GET | `/turns/:id` | `chat:history:read` | 回合详情（含 step/tool_call/审批） |
| POST | `/turns/:id/cancel` | `chat:use` | 取消（client_cancel） |
| POST | `/turns/:id/retry` | `chat:use` | 重试（interrupted/failed） |
| GET | `/approvals` | `approval:read` | 待我审批 / 我发起的 |
| POST | `/approvals/:id/decide` | `approval:decide` | `{decision: 'approve'|'reject', note?}` |

**SSE 响应示例**

```
event: turn.start
id: t_1:1
data: {"turnId":"t_1","seq":1}

event: delta
id: t_1:2
data: {"text":"根据《考勤制度》"}

event: tool.call
id: t_1:9
data: {"callId":"c_1","toolName":"kb.search","input":{"q":"年假"}}

event: approval.required
id: t_1:12
data: {"approvalId":"a_1","toolName":"channel.send","expiresAt":1762500000000}

event: turn.end
id: t_1:30
data: {"status":"completed","usage":{"input":1200,"output":340},"durationMs":8200}
```

### 16.4 工作区

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/workspace/files` | `workspace:read` | 列表（按 ScopeFilter；返回 handleRef 而非真实路径） |
| POST | `/workspace/files` | `workspace:write` | 上传（multipart；返回 fileId + handleRef） |
| GET | `/workspace/files/:id/content` | `workspace:read` | 下载/预览（Content-Disposition） |
| PATCH | `/workspace/files/:id` | `workspace:write` | 重命名 |
| DELETE | `/workspace/files/:id` | `workspace:write` | 软删到回收区 |
| GET | `/workspace/usage` | `workspace:read` | 我的配额与用量 |

### 16.5 知识库

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/kb/bases` | `kb:read` | 我可访问的库（ScopeFilter） |
| POST | `/kb/bases` | `kb:admin` | 建库 `{scopeType, scopeId, name}` |
| POST | `/kb/bases/:id/docs` | `kb:write` | 上传文档 |
| GET | `/kb/bases/:id/docs` | `kb:read` | 文档列表（含状态与失败原因） |
| DELETE | `/kb/bases/:id/docs/:docId` | `kb:delete` | 删除（事务删 chunk + 向量） |
| POST | `/kb/bases/:id/query` | `kb:read` | 检索 `{query, topK}`（**filter 由服务端构造**） |
| GET | `/kb/stats` | `kb:read` | 文档数/块数/命中率 |

### 16.6 管理与运维

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/admin/org/tree` | `org:dept:read` + dataScope | 部门树（含成员数） |
| GET | `/admin/org/members` | `org:member:read` | 成员列表（ScopeFilter） |
| POST | `/admin/org/members` | `org:member:manage` | 新增/邀请 |
| PATCH | `/admin/org/members/:id` | `org:member:manage` | 改部门/岗位/状态 |
| POST | `/admin/org/sync` | `org:sync:run` | 触发同步（channel） |
| GET | `/admin/org/sync-runs` | `org:sync:run` | 同步历史与报告 |
| GET | `/admin/roles` | `authz:role:read` | 角色与 scope |
| PUT | `/admin/roles/:code` | `authz:role:manage` | 改 scope/dataScope（二次确认） |
| POST | `/admin/users/:id/roles` | `authz:grant` | 分配角色（可带 expiresAt） |
| GET | `/admin/plugins` | `plugin:list` | 插件列表与状态 |
| POST | `/admin/plugins/install` | `plugin:install` | `{source}` → 解析并进入待审批 |
| POST | `/admin/plugins/:id/approve` | `plugin:approve` | `{grantedCapabilities}` |
| POST | `/admin/plugins/:id/:action` | `plugin:configure` | enable/disable/uninstall/rollback |
| GET | `/admin/channels` | `channel:manage` | 渠道配置与连接状态 |
| PUT | `/admin/channels/:channel` | `channel:manage` | 更新配置（密钥用引用；可"测试连接"） |
| GET | `/admin/models` / `PUT /admin/models/:id` | `model:read` / `model:manage` | 模型 provider 配置 |
| GET | `/admin/audit` | `audit:read` | 审计查询（多条件） |
| GET | `/admin/audit/export` | `audit:export` | 导出（二次确认） |
| GET | `/admin/usage` | `audit:read` | 用量与配额 |
| GET | `/healthz` / `/readyz` | 公开（内网） | 健康检查 |
| GET | `/metrics` | 配置开启 | Prometheus |

### 16.7 插件宿主 RPC（进程间，非 HTTP）

| 方向 | 方法 | 说明 |
|---|---|---|
| Host→Plugin | `plugin.init` | 下发 `{installId, config, token, apiVersion}` |
| Host→Plugin | `plugin.activate` / `plugin.deactivate` | 启停（配置变更时） |
| Host→Plugin | `tool.invoke` | `{callId, name, input, subject摘要, timeoutMs}` |
| Host→Plugin | `hook.handle` | `{event, payload}` |
| Host→Plugin | `plugin.dispose` | 卸载前清理 |
| Plugin→Host | `ctx.request` | `{capability, method, params}`（承载 fs/kb/channel/store） |
| Plugin→Host | `tools.register` / `tools.unregister` | 注册工具描述符 |
| Plugin→Host | `hooks.on` | 声明订阅 |
| Plugin→Host | `log.emit` | 结构化日志（宿主打标） |
| Plugin→Host | `health.ping` | 心跳（宿主据此判断存活） |

**协议约束**：单条消息 ≤ 1MB；请求必须有 `id`，响应 `{id, result|error}`；超时由宿主判定并杀进程；**worker 不得直接打开数据库或文件系统**（用 `ctx.request` 代执行）。

### 16.8 配置 schema（关键字段）

见 13.3 示例。补充两条硬性要求：
1. 所有密钥字段必须形如 `"*Ref": "env:XXX" | "file:path" | "vault:key"`，启动时解析失败即拒绝启动。
2. 所有涉及路径的配置必须校验"可写 + 在允许根目录内"，不允许把 `storage.home` 指到根目录/系统目录。

---

## 17. 关键流程时序

### 17.1 本地登录 → 进入员工端

```
Browser          eabd                    DB
  │ POST /auth/login │                     │
  ├─────────────────►│ 校验密码(Argon2id)   │
  │                  ├────────────────────►│
  │                  │◄────────────────────┤
  │                  │ 建 session(哈希refresh)│
  │                  ├────────────────────►│
  │◄── access + Set-Cookie(refresh) ───────┤
  │ GET /me/capabilities                    │
  ├─────────────────►│ 构造 Subject(查角色/部门)│
  │                  ├────────────────────►│
  │◄── scopes/menus/dataScope ─────────────┤
  │ 渲染菜单（只显示授权项）                  │
```

### 17.2 渠道消息 → 受控对话

```
IM 用户 → 渠道后端 → （长连接/回调）→ ChannelConnector
                                       │ 验签/解密（失败 401）
                                       ▼
                            构造 InboundEvent（verified）
                                       │ channel_events 去重
                                       ▼
                         查 user_identities → subject
                         未命中 → 引导绑定（不检索/不耗 token）
                                       ▼
                             频控 → AgentRuntime.handle
                                       ▼
        上下文装配（ScopeFilter 取会话/记忆/文件索引/知识）
                                       ▼
                    工具清单裁剪（PDP）→ 模型流
                                       ▼
                   输出分片 → 渠道 API → 审计
```

### 17.3 工具调用与审批（含重启恢复）

```
模型 → tool_call
  ▼
ToolRegistry 查描述符 → PDP.decide
  ├─ allow → worker 执行 → 回填 → 继续流
  ├─ deny  → 结构化结果回填 → 模型改口
  └─ require-approval
        ▼ approvals(pending) 落库；turn → awaiting_approval
        ▼ SSE approval.required + IM 卡片 + 控制台待办
        ▼ 审批人点击（校验：角色/同公司/卡片签名）
        ├─ approve → 签发一次性凭据(60s) → turn → tool_running
        └─ reject / 超时 → 结果回填"被拒绝/超时" → 模型给替代方案

【进程重启时】启动扫描 awaiting_approval → 保留；tool_running → 幂等则重放，否则标 interrupted
```

### 17.4 插件安装

```
POST /admin/plugins/install {source}
  ▼ resolve → 下载到 staging → 解析清单 → 六项校验
  ▼ 计算 hash → 来源白名单 → 读 capabilities
  ▼ 返回能力清单给管理员（required 不可裁 / optional 可裁）
POST /admin/plugins/:id/approve {grantedCapabilities}
  ▼ 写 plugin_installs + lock → 启动 worker → plugin.init
  ▼ 成功 enabled；失败回滚（删目录、恢复 prev）→ failed（原因可见）
```

### 17.5 知识入库与检索

```
上传 → Resolver 落盘 → kb_docs(uploaded)
  ▼ worker: parse → chunk(带 heading/ACL) → embed → 事务写 chunk+向量 → indexed
检索 → 宿主构造 AclFilter（分区：公司/部门链/个人/项目）
  ▼ Provider 带 filter 检索 → 后置 PDP 复检 → 去重/rerank
  ▼ 拼上下文（带来源标记）→ 模型 → 校验引用 → 回答
```

### 17.6 离职回收

```
渠道事件(离职) → 校验 → users.status=disabled
  ▼ 吊销 sessions → 取消在途 turn(cancelled)
  ▼ 工作区只读 → 审计（action=user.disabled, 来源=channel）
  ▼ 次日全量同步兜底（防事件丢失）
```

---

## 18. 工程结构与开发规范

### 18.1 仓库结构（pnpm workspace 单仓多包）

```
eab/
├── package.json                 # workspace 根
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .dependency-cruiser.cjs      # 分层依赖检查
├── packages/
│   ├── domain/                  # 领域模型、scope 常量、错误码、ULID（无 IO，可单测）
│   ├── authz/                   # PDP、scope 过滤、角色模板（无 IO）
│   ├── storage/                 # 连接封装（node:sqlite）、迁移执行器、审计哈希链、repository（含 scope 参数）
│   ├── workspace/               # WorkspaceResolver、路径安全、配额
│   ├── runtime/                 # Turn 状态机、上下文装配、工具注册
│   ├── model-gateway/           # Provider 适配、路由、流式错误归因
│   ├── kb/                      # Provider 接口 + sqlite-vec 实现 + 入库管线
│   ├── channel/                 # 事件信封 + 三渠道适配 + 幂等 + 分片
│   ├── plugin-host/             # 安装/审批/进程池/令牌/RPC
│   ├── plugin-sdk/              # 插件作者用的 ctx 类型与工具函数（发布到 npm）
│   ├── plugin-proto/            # 宿主↔worker 的 RPC 契约与校验
│   ├── server/                  # Fastify 装配、路由、SSE、WS（唯一暴露 HTTP 的包）
│   ├── worker/                  # worker 入口：插件执行、解析、embedding
│   ├── cli/                     # eab 命令
│   └── shared-types/            # 前后端共享的 DTO 与错误码（仅类型，无实现）
├── apps/
│   ├── web-admin/               # 管理控制台
│   ├── web-app/                 # 员工端
│   └── web-portal/              # 访客门户
├── plugins/                     # 官方示例插件（非内置）
├── deploy/
│   ├── systemd/eab.service
│   ├── windows/eab-service.xml
│   └── docker/{Dockerfile,docker-compose.yml}
├── docs/                        # 本文件 + 接口文档 + ADR 增补
└── scripts/                     # 备份、恢复、诊断、基准
```

**包命名**：`@eab/domain`、`@eab/authz`……对外发布的只有 `@eab/cli` 与 `@eab/plugin-sdk`。

#### 18.1.1 已落地目录（v2026.11.07 实况）

```
eab/
├── package.json / pnpm-workspace.yaml / tsconfig.base.json / vitest.config.ts
├── EAB企业智能体基座-总体架构方案.md
├── packages/
│   ├── domain/ authz/ workspace/ storage/     # 已实现，含 7 个迁移（到 0007_plugin_lifecycle.sql）
│   ├── channel/                               # 已实现：组织同步内核 + 钉钉 provider（24 个用例）
│   │   └── src/{types,map-org,apply,providers,mock,index}.ts
│   └── server/                                # 已实现：Fastify 装配 + 查询/同步/绑定/对话/插件接口 + 内嵌控制台
│       ├── src/{app,config,deps,http,main,session,dev-seed,plugins,console-auth,index}.ts
│       │   # session.ts：身份只来自库；单公司实例断言成员属于配置的唯一公司（12.10）
│       │   # dev-seed.ts：只有 EAB_DEV_AUTH=1 才造甲科技 c1 演示数据；不再补 c2
│       ├── src/routes/{system,org,org-sync,channel,kb,chat,plugins,console}.ts
│       └── public/{index.html,app.css,app.js}  # 无构建步骤；管理控制台入口 http://127.0.0.1:8788/admin
│       └── public/{chat.html,chat.css,chat.js}   # 员工工作台 http://127.0.0.1:8787/chat（12.7）；admin-gate.html 是管理员账号密码登录页（12.8）
├── plugins/catalog.json                        # 本地插件源：版本 / 来源路径 / 标签（12.9.5）\n├── plugins/eab-plugin-oncall/                  # 演示插件：值班表（plugin.json + page.html，12.9）\n├── plugins/.trash/                             # 卸载的插件移到这里，不物理删除
├── demo/kb-visibility.ts                       # 4 人 × 5 库的可视化验算脚本
├── scripts/smoke-http.mjs                      # 50 条 HTTP 断言
└── .eab-dev/                                   # 本地演示库 + admin-credentials.txt（已 gitignore）
```

**与目标结构的两处差异（有意为之）**

1. 控制台页面暂时内嵌在 `@eab/server/public`，没有单开 `apps/web-admin`。M0 的目标是"看得见、点得动"，此时上 Vite/React 会让每改一屏都要构建一次。等页面开始需要表单编辑、权限矩阵、图表时再拆出去，**接口不用动**。
2. `runtime / model-gateway / kb / plugin-*` 尚未创建。目录按里程碑建，不预铺空包 —— 空包会让"分层依赖检查"看起来通过而实际没有内容。`channel` 是本轮按 CHN-10~12 真实需求建的，不是预铺。插件加载器暂时驻在 `@eab/server/src/plugins.ts`（只做扫描与校验），等插件真需要独立后端时再抽 `@eab/plugin-sdk`。

**命令**

| 命令 | 作用 |
|---|---|
| `pnpm verify` | typecheck + 全部单测（166 用例） |
| `pnpm dev` | 同时起员工 `http://127.0.0.1:8787/chat` 与管理 `http://127.0.0.1:8788/admin`；首次自动建库 + 跑迁移；**默认不造演示数据**，设 `EAB_DEV_AUTH=1` 才生成甲科技 `c1`（不再补第二家 `c2`） |
| `pnpm demo:kb` | 知识库可见范围验算脚本（4 人 × 5 库，`decide` vs SQL 逐条对照） |
| `node scripts/smoke-http.mjs` | 对已启动的服务跑 50 条 HTTP 冒烟（含 12 条 403 负向：组织/成员/知识库/同步/渠道/绑定/对话/越权模型/插件） |

### 18.2 命名与代码规范

| 项 | 规范 |
|---|---|
| 文件 | kebab-case（`workspace-resolver.ts`） |
| 类型/接口 | PascalCase，**不加 `I` 前缀** |
| scope 常量 | 集中在 `domain/scopes.ts`，`SC.PLUGIN_INSTALL` 形式引用，禁止字符串字面量散落 |
| 错误 | 统一 `EabError(code, message, details, hint)`，禁止 `throw new Error('...')` |
| 仓储方法 | 列表类必须以 `{ scope }` 为必填参数（类型强制） |
| 时间 | 全库 `number`（毫秒）；禁止 `Date` 跨层传递 |
| ID | ULID 字符串；禁止自增整数主键 |
| 日志 | 结构化字段，禁止拼接字符串；禁止打印 token/密钥/完整文件内容 |
| 注释 | 只在"为什么"处写；"做了什么"靠命名 |

### 18.3 分层依赖检查（CI 强制）

```
domain  ← 无依赖
authz   ← domain
storage ← domain（不得 import authz 的决策逻辑，只接收 ScopeFilter 数据结构）
runtime ← domain, authz, storage(接口), model-gateway
server  ← 上述全部 + channel + plugin-host + kb + workspace
worker  ← plugin-proto, plugin-sdk（**禁止** import storage/server）
web-*   ← shared-types（**禁止** import server/runtime/storage）
```

违反（循环依赖、跨层反向依赖、web 引服务端实现）→ CI 失败。

### 18.4 提交与分支

| 项 | 规范 |
|---|---|
| 提交信息 | Conventional Commits：`feat(authz): 支持资源级显式 deny` |
| 分支 | `main` 保护；功能分支 `feat/xxx`；修 bug `fix/xxx` |
| 合并 | squash merge；PR 描述必须写"改了哪个 FR/ADR" |
| 版本 | 语义化版本；**发布前由你确认版本号**（见偏好：版本号用年月日格式时需先询问） |
| CI 关卡 | lint → typecheck → 单测 → 负向用例 → 依赖检查 → 构建 → 冒烟 |

### 18.5 开发环境约定

- 数据目录 `.eab-dev`（gitignore），与生产隔离。
- 前端 `pnpm dev`（Vite 代理到 8787）。
- 一键起：`pnpm dev`（server + worker + web 并发）。
- 测试数据种子：`pnpm seed`（1 公司 / 3 部门 / 20 用户 / 2 角色异常账号）。

---

## 19. 测试与安全验证策略

### 19.1 测试分层

| 层 | 范围 | 工具 | 目标 |
|---|---|---|---|
| 单元 | domain / authz / 路径安全 / 切分 | vitest | `core-authz` 覆盖 ≥ 90% |
| 集成 | repository + ScopeFilter、PDP 全链路、RPC | vitest + 临时 SQLite | 每个仓储方法都有 scope 用例 |
| 接口 | Fastify `inject`，含错误码 | vitest | 每个端点：正常 + 403 + 400 + 幂等 |
| 端到端 | 登录 → 对话 → 工具 → 审批 → 审计 | 脚本 + 模拟渠道 | 一条命令跑通（CI 必跑） |
| 安全 | 负向用例集 N-01~N-10 + 路径穿越变体 | vitest | 全绿才可合并 |
| 性能 | 检索、列表、并发对话 | 自写基准脚本 | 对齐 NFR-P |
| 跨平台 | Windows + Linux 冒烟 | 手工/CI runner | 发布前各一次 |

### 19.2 必须写的测试（不可省）

1. **每条 ADR 的关键约束**至少一个测试（例如 ADR-08 的双重校验、ADR-09 的错误归因）。
2. **每个 scope** 都有一条"有权限通过 / 无权限拒绝"的对偶测试。
3. **每个 Repository 列表方法** 都有"不带 scope 编译不过"的类型测试（`// @ts-expect-error`）。
4. **路径穿越** 至少 20 个变体（`..`、编码后 `..`、绝对路径、盘符、UNC、符号链接、Windows 保留名、大小写变体）。
5. **流式错误归因**：模拟上游 200 + 空流、200 + error 事件、中途断流，断言都判为 `provider_error`。
6. **重启恢复**：进程内注入"杀进程"钩子，断言 awaiting_approval 保留、streaming 标 interrupted。

### 19.3 安全验证清单（发布前逐项打勾）

| 编号 | 检查项 | 方法 |
|---|---|---|
| S-01 | 所有管理端点无权限时 403 | 自动化 |
| S-02 | 请求体中的 companyId/userId 被忽略 | 自动化（篡改测试） |
| S-03 | 知识检索空 filter 被拒 | 自动化 |
| S-04 | 插件无法获取裸 fs/进程 | 代码审查 + SDK 导出清单比对 |
| S-05 | 日志中无 token/密钥/完整文件内容 | 日志正则扫描 |
| S-06 | 上传文件类型校验（伪造扩展名） | 手工/自动化 |
| S-07 | 审计哈希链完整 | `eab audit verify` |
| S-08 | 依赖漏洞 | `pnpm audit` |
| S-09 | 默认配置安全（无默认密码、无 0.0.0.0+无鉴权） | 启动自检 |
| S-10 | 渠道签名伪造被拒 | 自动化 |

### 19.4 数据一致性与迁移测试

- 每个迁移文件在"空库"与"有数据的老库快照"上各跑一次。
- 迁移前后做抽样一致性校验（行数 + 关键字段哈希）。
- 备份恢复后跑冒烟（不是只比文件存在）。

---

## 20. 分期路线与任务分解

### 20.1 总体路线

| 阶段 | 周期估算 | 目标 | 出口条件 |
|---|---|---|---|
| **M0 内核骨架** | 3–4 周 | 一条完整垂直切片：登录 → 对话 → 工具 → 审计；权限骨架与负向测试就位 | AC-01~AC-06 全绿 |
| **M1 渠道与运维** | +3 周 | 三渠道接入、组织同步、离职回收、备份恢复、模型路由 | 至少一个真实渠道端到端可用；AC-07/AC-08 通过 |
| **M2 知识多端** | +3 周 | 知识库入库与双检检索、制度问答、移动端、访客门户 | 知识越权召回为 0；移动端可一键登录 |
| **V1 加固** | +3 周 | 插件进程隔离加固、审批工作流完善、PG 切换、DSH 适配、审计看板 | 可对外交付试用 |
| **V2 生态** | 持续 | 私有插件市场、开放 API、多公司、RAG 增强 | 按客户需求排期 |

> 周期是"单人 + AI 协作"的估算，不含渠道权限审批的外部等待时间（这部分要提前推动）。

### 20.2 M0 任务分解（可直接建 issue）

**切片 A：工程骨架（约 3 天）**

| 任务 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| T-01 | 初始化 pnpm workspace + tsconfig + lint + vitest + CI 骨架 | — | `pnpm test` 与 `pnpm lint` 可跑 |
| T-02 | `@eab/domain`：错误码、scope 常量、ULID、时间工具 | T-01 | 单测覆盖 |
| T-03 | `@eab/storage`：`node:sqlite` 连接封装 + 迁移执行器 + 前 11 张表（含审计触发器） | T-02 | 空库可迁移；重复执行幂等 |
| T-04 | `@eab/server`：Fastify 装配、统一响应信封、错误处理中间件、traceId | T-02 | `/healthz` 可用；错误码统一 |
| T-05 | 配置模块（schema 校验 + 密钥引用解析 + 启动自检） | T-02 | 配置错误时启动失败并给出修复建议 |
| T-06 | 日志（pino + traceId + 脱敏） | T-04 | 一个请求能串起日志 |

**切片 B：权限骨架（约 5 天，最高优先）**

| 任务 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| T-07 | `@eab/authz`：Subject 构造、角色展开、PDP 决策（含 matchedBy） | T-02 | 决策可解释；单测 ≥ 90% |
| T-08 | `buildScopeFilter` + repository 类型强制（`{ scope }` 必填） | T-07, T-03 | 类型层面无法写无 scope 查询 |
| T-09 | 本地登录 + 双 token + session 表 + capabilities 接口 | T-07, T-04 | AUTH-01/02/03 通过 |
| T-10 | 组织：部门树（物化路径）+ 成员 CRUD | T-03 | ORG-01/02 通过 |
| T-11 | 角色矩阵接口 + 缓存与失效广播 | T-07, T-09 | 改角色 5 秒内生消 |
| T-12 | 负向用例 N-01~N-10 自动化 | T-07~T-11 | 全绿 |

**切片 C：对话闭环（约 6 天）**

| 任务 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| T-13 | conversation/turn/step 表 + Turn 状态机（合法迁移校验） | T-03 | 非法迁移被拒；状态可查 |
| T-14 | 模型网关：OpenAI 兼容适配 + SSE 解析 + **错误归因** | T-06 | 三种终态区分正确（含空流用例） |
| T-15 | 上下文装配器（源 + requiredScope + token 预算） | T-07, T-14 | 裁剪结果写 turn 元数据 |
| T-16 | SSE 端点 + seq + Last-Event-ID 续传 + 幂等键 | T-14 | 断线重连可续 |
| T-17 | 会话级串行锁 + 用户级并发上限 | T-13 | 并发不交错 |
| T-18 | 前端员工端：登录 + 会话列表 + 流式对话 | T-09, T-16 | 手工可完整对话 |

**切片 D：工具与插件（约 5 天）**

| 任务 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| T-19 | ToolRegistry + ToolDescriptor 校验 + 工具清单裁剪 | T-07, T-15 | 无权工具模型看不到 |
| T-20 | 工具调用链路（PDP → 执行 → 回填 → 拒答结构化） | T-19 | TOOL-02/03/04 通过 |
| T-21 | 内置工具 3 个（时间、计算、workspace 读） | T-19 | 各有 scope 与测试 |
| T-22 | `@eab/plugin-proto` + worker 骨架 + 进程池（启停/超时/熔断） | T-04 | 插件死循环不影响主控 |
| T-23 | 安装流程（四源 + 六项校验 + 审批 + lock） | T-22, T-03 | AC-05 通过 |
| T-24 | 能力令牌 + 双重校验（含 N-05 用例） | T-22, T-07 | 越权被拒 |

**切片 E：可交付（约 4 天）**

| 任务 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| T-25 | 审计流（append-only + 哈希链）+ 查询接口 | T-03 | `eab audit verify` 通过 |
| T-26 | 审批流（pending → 卡片/待办 → 凭据 → 恢复） | T-20, T-13 | AC-06 通过 |
| T-27 | 工作区 Resolver + 路径安全 + 上传下载 | T-03 | 路径穿越 20 变体全拦 |
| T-28 | 管理控制台最小版（组织/角色/插件/审计） | T-11, T-23, T-25 | 管理员可完成全流程 |
| T-29 | CLI：init/serve/service install/plugin*/backup | T-05 | AC-01/AC-08 通过 |
| T-30 | 备份/恢复 + 恢复演练脚本 | T-03 | AC-07 通过 |
| T-31 | 端到端脚本（登录→对话→工具→审批→审计） | 全部 | CI 必跑 |
| T-32 | 跨平台冒烟（Windows + Linux） | T-29 | 各跑一次记录结果 |

#### 20.2.1 当前实现进度（v2026.11.07，M0 基座 + 可运行控制台 + 组织同步模拟链路）

已完成（`pnpm typecheck` 与 `pnpm test` 均通过，15 个测试文件 / 166 个用例）：

| 包 | 内容 | 测试 |
|---|---|---|
| 根骨架 | pnpm workspace、tsconfig base/strict、vitest、`.gitignore`、`onlyBuiltDependencies=esbuild` | — |
| `@eab/domain` | 46 个 scope（常量 + 注册表双登记，漏登记编译失败）、scope 隐含闭包、11 个错误码 + HTTP 映射 + 响应信封、ULID、部门物化路径、**知识库可见范围（4 种模式）** | 29 |
| `@eab/authz` | 7 内置角色、Subject 构造（校验 deptPath 前缀）、谓词 AST（三值化简）、11 类实体列画像（含 deptMode 上/下）、`buildScopeFilter`（含 kb ACL 谓词）、PDP（override → scope → 知识库 ACL / 数据范围 → 密级 → 审批）、`predicateToSql`（字段白名单 + 全参数绑定 + LIKE 转义） | 54 |
| `@eab/workspace` | 路径规范化与穿越防护（`..`、绝对路径、盘符、UNC、scheme、URL 编码穿越、保留设备名、ADS、结尾点、控制字符、长度）、`safeJoin` + `isWithinRoot` 双保险、`toSlug` | 36 |
| `@eab/storage` | `node:sqlite` 连接（WAL/外键/busy_timeout）、事务、迁移执行器（每文件一事务、幂等）、`0001_init.sql`（11 表 + 索引 + 审计不可改触发器）、`0002_kb.sql`（知识库 3 表）、`0003_org_sync.sql`（组织同步 3 表 + departments/users 缺失计数列 + 渠道唯一索引重建）、`0004_channel_bind.sql`（渠道绑定 4 列 + 租户唯一索引 + `channel_bind_sessions` 会话表）、`0005_plugin.sql`（`plugin_states`：按企业存插件启停）、`0006_models.sql`（模型供应商 / 模型目录，密钥只存环境变量名）、`0007_plugin_lifecycle.sql`（`plugin_installs` 安装记录 + `plugin_events` 生命周期审计）、`0017_plugin_company_install.sql`（`plugin_company_installs`：按公司登记插件安装归属，老记录回填给第一家）、审计哈希链（`EAB-GENESIS` 起点、`sha256(prev|canonicalJson)`、断链检测）、`loadKbCollectionAcls`（JSON 解析 + 坏配置 fail-closed） | 23 |
| `@eab/channel` | `OrgProvider` 渠道抽象（`verify` + `fetchOrg`）、`mapRemoteOrg` 纯函数（父链重建 path、渠道根不建行、孤儿挂根、兄弟排序、环检测、多部门取主部门）、`applyOrgSync`（幂等 upsert、rename/move/restore 检测、缺失计数 + 连续 2 次才回收、同步报告 + 差异明细、回写渠道配置且不覆盖绑定状态）、`rebuildDeptPaths`（移动后子树 path 与成员 dept_path 一次收敛）、`fetchDingTalkTenant` + 钉钉/飞书/企微 provider、`mockFeishuOrg(1/2/3)` 三份通讯录快照 | 24 |
| `@eab/server` | Fastify 装配（统一信封、错误处理、`x-trace-id`、版本头）、`loadConfig`（只读环境变量、非法值启动失败、库路径锚定仓库根）、身份解析（**超级管理员账号 + 密码** → 控制台操作员，不登录组织成员；员工 `?as=` 开发预览）、只读接口 `/api/health` `/api/me` `/api/org/tree` `/api/org/members` `/api/kb/collections` `/api/kb/docs` `/api/dev/personas` `/api/dev/kb-matrix`、同步接口 `/api/org/sync-runs` `/api/org/sync-runs/:runId` `/api/dev/org-sync`（**未绑定飞书租户 → 409**）、**渠道绑定接口** `/api/channel/bindings` `/api/channel/bind/start` `/api/channel/bind/:sessionId` `/api/channel/bind/:sessionId/cancel` `/api/channel/bind/:sessionId/mock-scan` `/api/channel/unbind`、内嵌控制台（**顶栏单公司身份牌（无多公司切换）+ 一级导航（悬停展开二级页面）+ 每页自带子导航**：概览 / 组织与权限 / 知识与模型 / 连接与平台 / 运营与审计；令牌+原语三层，无构建步骤；入口在 **`/admin`：先过**管理员账号密码登录页**（默认 `admin` + 自动生成密码，仅本机；`EAB_CONSOLE_TOKEN` 只给脚本）→ 控制台操作员（不登录组织成员）**；员工端口 `/` 302 到 `/chat`，管理端口 `/` 302 到 `/admin`；配套 `/api/console/login` `/api/console/logout` `/api/console/companies`，控制台请求带 `x-eab-console: 1` 与员工身份彻底隔开；新增「角色与权限」「模型接入」两页与 `/api/console/roles` `/api/console/members/:userId/roles` `/api/console/providers` `/api/console/models`）、**员工工作台** `/chat`（左侧账号栏 + 消息流 + 输入框内的模型选择与图片/文件附件 + 未登录登录卡，12.7.6 / 12.7.7）与对话接口 `/api/chat/models` `/api/chat/messages`（`chat:use` + `model:use` + 模型可见角色两层过滤，自动按优先级选模型；附件收名称/大小/文本正文/图片 dataURL，并组装多模态消息）、**插件接口** `/api/plugins` `/api/plugins/:id/state` `/plugins/assets/:id/:file`（清单校验、按企业启停、iframe 沙箱页面）与**服务器侧插件管理器** `/api/console/plugins` `/api/console/plugins/install` `/api/console/plugins/:id/uninstall` `/api/console/plugins/events`（本地目录安装、暂存校验、版本/来源/指纹、`.trash` 卸载、生命周期审计，12.9）、**单公司本地部署**（一套实例只服务配置里的唯一公司；`assertSingleCompany` 拒绝旧多公司账号，控制台只回唯一公司、不提供新建第二家；员工 8787 / 管理 8788 双端口 surface guard） | 50 条 HTTP 冒烟 |

本版**已完成**的验收项：T-01、T-02、T-03、T-07、T-08、T-25（审计链，含 `verifyAuditChain`）、T-27（路径安全 20+ 变体）、7.6.1 知识库可见范围（读侧内核），**T-04 / T-05 / T-06 的"能跑"版本**（服务起在 `http://127.0.0.1:8787`，50 条 HTTP 冒烟含 12 条负向 403 全绿），**CHN-10 全量同步 / CHN-12 同步报告的"模拟渠道版本"**（用 `mockFeishuOrg` 的三份快照把"首次建组织 → 改名移动离职 → 上游消失 → 回收"整条链路跑一遍并回看差异明细），**CHN-13 扫码绑定企业的骨架**（会话状态机 + 租户跨公司唯一 + 绑定后才允许同步 + 解绑不删组织数据，模拟扫码走通），以及 **12.6 控制台信息架构 S1 + S1.5**（顶部一级导航按业务域分组、每页自带子导航（组织=部门树 / 知识库=库列表 / 渠道=小节+渠道状态 / 矩阵=说明图例 / 系统=小节锚点）、渠道绑定与同步合成一页、概览页、令牌/原语层落地；六个页面均已在浏览器目视验证，树上「N 人」改为按 `dept_path` 前缀统计以保证与筛出行数同口径）。

本版**未完成**（下一步）：

- **T-09~T-11**：登录与双 token 会话、组织/成员 CRUD、角色矩阵与知识库管理接口、缓存失效广播。当前靠 `devAuth` + `?as=<userId>` 冒充身份，`EAB_DEV_AUTH=0` 时直接 401。
- **T-12 的 HTTP 级负向用例**：目前只有 `scripts/smoke-http.mjs` 的 50 条断言，还没进 vitest；`routes/channel.ts` 的会话状态机与跨公司租户冲突、`routes/chat.ts` 的模型可见性与自动选择也还没有单测（只有手工端到端用例）。
- **repository 层**：`{ scope }` 必填的仓储签名仍只有设计，代码里没有 Repository 实体（路由直接写 SQL）。
- **组织架构同步（CHN-10~12）剩下的部分**：三家真 provider（飞书/钉钉/企微）一个都没写——验签、长连接/回调接收、分页限流、增量模式；CHN-11 的每日校准定时任务与"离职当天 `subject:invalidate` 广播"也没做。映射与落库层已经稳定，接真渠道时只补 `fetchOrg`。
- **真渠道的扫码授权**：现在 `mock-scan` 是开发预览的替身；接飞书要 app_id + 开通二维码登录/应用授权，钉钉要 app_key，企微要 corpid + 服务商授权码。换租户之后的写绑定逻辑完全复用。
- **控制台写入口不齐**：组织/知识库/渠道/插件已经能配，模型目录（provider / 模型 / 可见角色）已能配，公司重命名/停用/删除已能配；但密钥托管与额度、日志级别、备份触发仍没有页面，只能改库或环境变量。补的时候一律走管理员登录 + 二次确认，不做成员工能碰的开关。
- **单公司口径（12.10）**：控制台只显示配置里的唯一公司，不提供新建第二家；`POST /api/console/companies` 409，扫码开通在库里已有公司时也拒绝。要换组织先删除唯一公司回到空库，再「钉钉扫码绑定组织」。
- **附件正文与图片能读，但没有落盘**：界面已经能选图/选文件、粘贴、预览、随消息发送，文本正文和图片视觉输入都已进模型（12.7.7）；但没有对象存储、病毒/类型检查、历史会话图片回放与知识库摄取，PDF/Word/Excel 也还没有解析库。真正的上传通道属于 V1。
- **插件只有页面槽位**：没有插件后端路由、没有进程外隔离、没有热加载与市场/签名。下一步若要"插件能加接口"，必须先定隔离方式（进程内外）再写，否则等于把整台服务器的权限交给插件。

实现期固化下来的口径（正文相应章节已同步）：

1. **功能权限缺失时给空集，不是全量**：`buildScopeFilter` 在主体不具备该 action 的 scope 时直接返回 `FALSE`（reason=`missing-scope`），避免仓储层拿着"看似合法"的过滤器去查一个用户本就无权做的动作。
2. **部门方向按实体登记**：人员/文件/部门类 `deptMode=down`（本部门 + 子孙）。PDP 与过滤器共用 `deptPathMatches`，测试里有一条"SQL 列表可见 == 逐条决策"的一致性断言防止口径漂移。
3. **知识库读由 collection ACL 决定**（7.6.1）：`all` / `roles` / `depts` / `private` 四种模式；过滤谓词是 `collection_id IN (...)`；配置缺失或 `acl_mode` 非法 → 不可见（fail-closed）；`collections` 上下文未传 → 过滤器为空集。写/删仍走组织范围。
4. **身份只能来自库里的组织数据**：`?as=` 只是"选一个已验证身份"的开发预览入口，不是鉴权本身。`resolveActor` 是唯一替换点 —— 接 OIDC / 渠道事件时只换这一个函数，路由与权限判定不动。
5. **页面不"另造一套口径"**：控制台展示的可见/不可见、SQL 命中条数，全部来自与接口同一条 `buildScopeFilter` + `loadKbCollectionAcls` 链路，前端不做二次判断。
6. **同步三条硬口径**（8.6 规则的实现版）：①同一份通讯录跑第二次必须零写入、差异为空；②上游缺失只 `missing_runs + 1`，连续 2 次才软删/禁用，重新出现则恢复并清零；③部门移动后子树 path 与成员 `dept_path` 由 `rebuildDeptPaths` 一次收敛，不在 N 处补丁里各自记得改。渠道身份先写 `pending`、`bound_by=sync:<provider>`，不自动绑到已有账号。
7. **绑定口径（8.6.1）**：公司隔离 —— 一家公司每家渠道只绑一个企业租户，一个租户全局只属一家公司（唯一索引挡跨公司撞车）；绑定只能由管理员扫码授权产生，不接受手填密钥；未绑定不允许同步（409 + hint 指向「渠道绑定」）；解绑只把 `sync_mode` 置 `off`、清租户引用，不删已同步的部门与成员（知识库可见范围还锚在 dept path 上）。
8. **组织树交互口径（多公司改造时修正）**：点**部门行**= 筛出该部门（含下级）成员，同时若有下级就展开/收起；点右侧「N 人」只筛不折叠。叶子部门点了也必须筛出人 —— 原来"点叶子什么都不发生"是 bug，不是设计。
9. **导航口径（12.6.2）**：布局是**顶部一级导航 + 每页自带子导航 + 内容区**，一级导航按业务域分组（概览 / 组织架构 / 权限矩阵 / 知识库 / 渠道与同步 / 系统），不按数据表或接口名分组；子导航只属于当前页、换页整块换掉，组织树只出现在「组织架构」页的子导航里，知识库的子导航是**库列表**。树上「N 人」按成员 `dept_path` 前缀统计（含下级），必须与点进去筛出的行数一致。插件作为第七个一级项「插件」挂在业务域末尾，不混进任何企业页。
10. **两个入口（12.8）分端口**：管理控制台 `8788/admin`（**超级管理员账号 + 密码**，默认只允许服务器本机 → 操作员，不登录组织成员；右上角只显示唯一公司身份牌）≠ 员工 `8787/chat`（只对话）。不可越界：员工端口 404 管理接口，管理端口 404 员工对话与 `/api/auth`；`/api/health` 只说版本与存活；部署参数只走环境变量，没有单独"运维入口"；管理员会话不带员工身份，控制台登录后开员工端口仍是员工（请求缺 `x-eab-console: 1`）。**入口不许合并**：`surface guard` 让两个端口互相 404。
11. **插件口径（12.9）**：插件是磁盘目录（`plugins/<id>/plugin.json`），安装/更新/卸载是**服务器侧控制台的运维动作**（本地目录 → 暂存校验 → 登记版本/来源/指纹 → `.trash` 可恢复卸载），按公司启停仍属企业域（`plugin_states`）；清单只允许声明已存在的 scope，`compatibility.eab` 不满足当前版本判不合法；坏清单不崩服务；页面一律 iframe 沙箱渲染，插件要数据只能走同一套 HTTP API，因而受同一套权限约束；员工侧永远看不到安装来源与服务器路径。
12. **多公司口径（12.10）**：**公司从人身上取，不从进程配置取**——`deps.companyId` 只是单公司部署的默认公司，参与查询与鉴权的必须是 `subject.companyId`。`dataScope='global'` 只表示"本公司内不受部门限制"，不许退化成 `1 = 1`；跨公司读业务数据如果确实需要，做成控制台里按公司逐家看的独立只读出口，而不是放开超管谓词。渠道租户 `(provider, tenant_id)` 全局唯一，一个租户只能属于一家公司。
13. **工作台版面口径（12.7.6 / 12.7.7）**：顶栏只放会话级信息，**任何"我是谁"都不出现在右上角**；账号、可用模型、退出登录在左侧栏（员工侧没有控制台入口）；模型选择在输入框里，且左侧列表与输入区胶囊共用同一份选中状态。未登录或登录态失效 → 登录卡，且**不请求 `/api/me`**，避免"默认塞给用户一个身份"。附件正文与图片视觉输入随消息进模型，但附件不落盘、历史不回放旧图；只有附件没有文字的消息允许发送，两者不能同时为空。

### 20.3 M1 / M2 / V1 关键任务（粗粒度）

**M1**
- 渠道适配器（飞书长连接 / 钉钉 Stream / 企微回调）+ 验签 + 去重 + 分片
- 组织全量/增量同步 + 离职回收 + 同步报告
- 模型路由 fallback + 用量配额 + 用量看板
- IM 审批卡片
- 备份定时任务 + 恢复演练纳入日历
- 管理端：渠道配置与连接测试、模型配置

**M2**
- kb Provider（sqlite-vec）+ 入库管线 + 双检检索 + 引用回链
- 制度问答模板
- 移动端 Capacitor 壳 + JSAPI 登录
- 访客门户（独立会话/限流/审计）
- 我的权限页

**V1**
- 插件灰度与回滚演练、worker 资源配额实测
- PostgreSQL 切换演练（含迁移脚本双跑）
- DSH 兼容适配层（3 个目标插件）
- 审计看板与告警接入
- 权限变更重索引任务
- 安全渗透自查（按 19.3 清单）

### 20.4 里程碑判定（不要用"代码写完"当完成）

| 里程碑 | 唯一判定标准 |
|---|---|
| M0 完成 | 在一台**全新 Windows 机器**与一台**全新 Linux 机器**上，按文档安装 → 走完 AC-01~AC-08 |
| M1 完成 | 真实企业租户的一个渠道里，员工能 @机器人 提问并拿到带引用的回答；离职当天权限失效 |
| M2 完成 | 部门 A 的成员问部门 B 的制度，回答"未找到依据"，审计里有拒绝记录 |
| V1 完成 | 装一个第三方插件，崩溃后主控无感；PG 切换后功能一致 |

---

## 21. 风险登记册

| 编号 | 风险 | 概率 | 影响 | 应对 | 早期信号 |
|---|---|---|---|---|---|
| R-01 | 渠道通讯录权限审批周期长，卡住 M1 | 高 | 高 | M0 阶段就提交申请；先用本地账号 + 模拟渠道跑通全链路（渠道适配器可 mock） | 管理员说"还在走流程" |
| R-02 | 企微不支持长连接，内网无公网出口 | 中 | 中 | 提供"内网代理转发"方案（一台有出口的机器做回调中转）；或先只做飞书/钉钉 | 客户网络策略禁止入站 |
| R-03 | 权限后补导致返工 | 中 | **极高** | 权限骨架排在 M0 切片 B，先于所有业务功能；负向用例进 CI | 有人提"先做功能再加权限" |
| R-04 | 插件隔离做到"进程内"图省事 | 中 | 高 | ADR-08 写死；Code Review 检查；worker 必须有独立入口 | PR 里出现 `import` 插件代码到主控 |
| R-05 | 审批挂起导致 turn 泄漏（重启后成僵尸） | 中 | 中 | 状态机 + 启动扫描 + 超时自动拒绝 | 出现"pending 很久没人处理" |
| R-06 | `github:` 源安装失败（仓库未提交 dist） | 中 | 低 | 安装器检测 `dist/entry` 是否存在，缺失时提示"用 npm 源或先构建"；文档写明 | `ERR_MODULE_NOT_FOUND` |
| R-07 | SQLite 单写者导致高并发写阻塞 | 中 | 中 | 写队列 + 批量提交；监控写等待；超阈值迁 PG | 写 P95 上升、`SQLITE_BUSY` |
| R-08 | 双库（向量 + 元数据）不一致（若选 Qdrant） | 中 | 高 | 默认同库（ADR-05）；外部 provider 必做后置复检 + 补偿任务 | 召回结果里有已删文档 |
| R-09 | 模型上游错误被当正常结束 | 高 | 高 | ADR-09 + 三类终态测试 + 保存原始流片段 | 用户反馈"回答突然截断" |
| R-10 | DSH 插件兼容投入失控 | 中 | 中 | 只承诺 3 个已测插件；其余标"尽力" | 有人要求"全部 DSH 插件都能跑" |
| R-11 | Windows 服务化踩坑（权限/杀软/长路径） | 高 | 中 | 13.7 专项清单；发布前在真实 Windows Server 验证 | 服务启动即退出、文件访问被拒 |
| R-12 | 知识切分策略不适配中文文档 | 中 | 中 | 保留切分策略可切换；每公司维护评测集 | 召回差、回答断章取义 |
| R-13 | 群聊身份/访客入口成为泄漏点 | 中 | 高 | 6.6 + 8.5 规则；负向用例覆盖 | 群里出现"机器人把别人当自己" |
| R-14 | 单机规模增长超预期（文件/审计表） | 中 | 中 | 分表/归档策略预留；500 万行阈值告警 | 审计查询变慢 |
| R-15 | 需求蔓延（不断加"顺便做个…"） | 高 | 中 | 14.7 非目标清单；新需求进 backlog 不插队 | 里程碑反复延期 |

---

## 22. 需要拍板的事项（附推荐）

### 22.1 第一版遗留的三件事

| # | 问题 | 我的推荐 | 理由 | 你若选另一条的代价 |
|---|---|---|---|---|
| Q1 | 移动端路线：Capacitor / React Native | **Capacitor 先行**（M2），RN 留到有真实反馈后 | 复用员工端 Web，2 周可用；权限与协议不用重写 | 选 RN 立刻多 6–8 周，且首版功能会滞后 |
| Q2 | 数据库：SQLite / 直接 PostgreSQL | **SQLite 默认 + PG 可选**（ADR-04） | 单机零运维是产品承诺；schema 已按多方言设计 | 直接 PG 会让"一条命令装到笔记本上"变复杂（要装库/容器） |
| Q3 | DSH 兼容优先级 | **新 SDK 为主**，只保证 3 个已测插件（ADR-14） | 不把上游不稳定变成自己的债 | 承诺 100% 兼容 = 无限期维护适配层 |

### 22.2 本次新增、也需要你确认的四件事

| # | 问题 | 我的推荐 | 影响面 |
|---|---|---|---|
| Q4 | 多公司：MVP 单公司 / 直接多租户 | **单公司 + schema 多租户**（ADR-11） | 直接多租户会引入计费、跨租户运维、独立备份四座大山 |
| Q5 | 向量库：sqlite-vec 同库 / LanceDB / Qdrant | **sqlite-vec 同库**（ADR-05） | 影响"权限变更后召回是否正确"这个核心正确性问题 |
| Q6 | 登录方式：只做三个 IM / 加 OIDC | **加 OIDC**（AUTH-05） | 大企业几乎都有统一身份；不加会每家都要定制 |
| Q7 | 插件默认执行位置：进程内 / 进程外 | **进程外**（ADR-08） | 决定"敢不敢装第三方插件"，也决定 M0 工作量（约多 3 天） |

### 22.3 需要你提供的信息（不阻塞 M0 开工）

1. **首批目标渠道**：飞书 / 钉钉 / 企微，先做哪一个？（建议按你公司实际在用的排）
2. **公司规模**：员工数、部门层级深度（影响组织同步与索引策略）
3. **模型来源**：现有可用的是哪些（自建 vLLM / 火山方舟 / OpenAI 兼容网关 / 其他），有没有 GPU 资源
4. **部署机器**：Windows Server 还是 Linux？有没有公网出口（决定企微方案）
5. **文档类型**：主要入库的是 PDF / Word / 扫描件 / 网页？扫描件占比多少（决定要不要上 OCR）
6. **首发场景**：先上"制度问答"还是"通用助手 + 文件处理"？（建议先制度问答，闭环短、可验收）

### 22.4 版本号（已定）

**已定：采用日期版本号**，本次为 **v2026.11.07**，与根 `package.json` 的 `version` 字段一致。

规则：

| 项 | 规则 |
|---|---|
| 格式 | `vYYYY.MM.DD`（文档、代码、Release 标签统一） |
| 同日多次发布 | 追加后缀 `-1`、`-2`（如 `v2026.11.07-2`），不跨日凑版本 |
| 变更时点 | 每次发布前由你确认当日版本号；日常提交不改版本号 |
| 落点 | 文档头、根 `package.json`、`eabd --version`、Release 标题四处必须一致 |
| 迁移版本 | 数据库迁移**不跟随产品版本**，用递增文件名（`0001_`、`0002_`），只前进不回退 |

### 22.5 组织架构同步开工前需要你定的三件事

| # | 问题 | 我的推荐 | 为什么必须现在定 |
|---|---|---|---|
| S1 | 先接哪一家（飞书 / 钉钉 / 企微） | **飞书先行**；公司主用钉钉就换钉钉 | 三家的鉴权、事件协议、部门/人员字段完全不同（见 8.2）。先定一家，映射层与同步报告才有验收对象；另两家以后只是各加一个 provider |
| S2 | 同步时要不要"自动绑定渠道身份" | **默认不绑**：同步只写 `user_identities` 待确认，首次登录/发消息时才置 `active` | 自动绑 = "渠道里有账号就能查公司知识库"，风险过大；不绑只多一次管理员确认 |
| S3 | 上游删人怎么处理 | **连续两次全量缺失才回收**（默认 24h 间隔），离职即时失效 | 直接按"上游没有就删"会在通讯录权限审批中/应用未发布期间误删真实员工（8.6 第 4 条） |

顺带需要的输入：三家应用的 `app_id` / `app_secret`（或先只跑 mock provider：用假数据把映射与报告跑通，再换真凭证）。

---

## 附录 A：术语与 DSH 能力对照

| DSH 概念 | EAB 对应 | 迁移注意 |
|---|---|---|
| 插件包 `dsh.bundle` | 清单 `eab.bundle` + `eabApiVersion` | 需重写清单；入口 bundle 可复用 |
| `ctx.tools.register` | `ctx.tools.register(descriptor, handler)` | 多了 requiredScope / risk / timeout |
| `turn/*`、`tool/*` 事件 | 事件总线同名语义（适配层映射） | 事件字段不完全一致，需 shim |
| 全局工作区 | 三级工作区 + Resolver | 插件里的裸路径写法必须改句柄 |
| 无鉴权上下文 | Subject + PDP | 需要声明能力，未声明的调用直接失败 |
| 自由安装 | 审批 + 令牌 | 安装流程变了，需要管理员参与 |

## 附录 B：本文件与代码的对应关系

| 章节 | 对应代码位置 |
|---|---|
| 3.2 进程模型 | `packages/server`、`packages/worker` |
| 5 工作区 | `packages/workspace` |
| 7 权限 | `packages/authz`、`packages/domain/scopes.ts` |
| 9 插件 | `packages/plugin-host`、`packages/plugin-proto`、`packages/plugin-sdk` |
| 10 知识库 | `packages/kb` |
| 11 运行时 | `packages/runtime`、`packages/model-gateway` |
| 15 数据字典 | `packages/storage/migrations/*.sql` |
| 16 接口契约 | `packages/server/src/routes/*`（实况；目标位置 `packages/shared-types`） |
| 18 工程结构 | `packages/*`、`scripts/smoke-http.mjs` |
| 20 进度 | `packages/server/public/*`（控制台）、`demo/kb-visibility.ts` |
| 14 需求 | 任务看板（按 FR 编号建 issue） |

> 本文档由人机协作编写，随开发迭代更新；任何与实现不一致之处，先改本文档再改代码。

---


## 附录 C：v2026.11.07 实现落点（与正文 FR 对照）

本附录只记录"已落地"的代码事实，避免正文与实现脱节。

### C.1 新增/扩展的服务端模块

| 文件 | 内容 |
|---|---|
| `packages/server/src/routes/auth.ts` | 员工账号密码登录、退出、`/api/auth/me`、改密；5 次失败锁 10 分钟 |
| `packages/server/src/password.ts` | scrypt 口令散列与校验 |
| `packages/server/src/employee-session.ts` | `eab_session` 会话签发/校验/吊销（7 天） |
| `packages/server/src/llm.ts` | 按 kind 分派 OpenAI 兼容 / Anthropic / Gemini / Azure，`apiKeyOf` 从 secrets.json 取密钥；demo 返回 null 由路由回声 |
| `packages/server/src/routes/chat.ts` | 9 条会话路由 + 发送消息（检索→系统提示→落库→计费→审计）；`stream:true` 走 SSE（meta/delta/done，带 seq）；会话级串行锁 |
| `packages/server/src/routes/admin.ts` | 部门/成员/公司写接口、重置密码、批量授权、成员导出 CSV、临时授权 CRUD、会话吊销、审计/用量/审批/备份 |
| `packages/server/src/routes/workspace.ts` | WS-01~07：列表/配额/写入/下载/改名移动/回收站/共享/归档；路径过 `normalizeRelativePath` + `safeJoin` |
| `packages/server/src/routes/tools.ts` | 7 个内置工具 + 高危二次确认审批（202 + approvalId） |
| `packages/server/src/routes/memory.ts` | 记忆分层：user/dept/company，写入待确认、确认后进入上下文 |
| `packages/server/src/routes/system.ts` | `/healthz` `/readyz` `/metrics` |
| `packages/server/src/session.ts` | 员工会话优先，`?as=` 仅 devAuth；读取 `permission_overrides` 的 allow/deny 传给 Subject |
| `packages/authz/src/subject.ts` | `deniedScopes` 优先剔除；最终 scopes 为 `Set` |

### C.2 新增迁移

| 迁移 | 作用 |
|---|---|
| `0011_platform` | approvals / guest_invites / memories / storage_quotas / workspace_files |
| `0012_workspace` | 工作区唯一索引、storage_path/recycled_path/archived_at、workspace_shares |
| `0013_workspace_member_share` | member 角色补 `workspace:share` |
| `0014_channel_events` | `channel_events` 事件去重表、`channel_identities` 外部账号绑定表 |
| `0015_permission_overrides` | 临时授权/例外表（allow/deny、到期、撤销） |

### C.3 渠道回调链路

1. `GET /api/console/channels` 先补齐三家 `channel_configs` 行并生成 `callback_token`（仅当为空）。
2. `POST /api/channel/webhooks/:provider?token=` 校验 token → 事件去重（event_key 唯一索引）→ 外部账号绑定查询 → 频控（每 sender 60 秒 20 条）→ 处理。
3. 钉钉回显未绑定引导；飞书返回 bound/senderId/note；企微 AES 解密未做，当前 501。
4. 身份绑定 CRUD：`GET/POST /api/console/channel-identities`、`DELETE /api/console/channel-identities/:id`。

### C.4 测试与验收

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | 0 错误 |
| `pnpm test` | 15 个测试文件 / 166 条通过 |
| `node scripts/smoke-http.mjs` | 50 条全部符合预期 |
| `node scripts/smoke-platform.mjs` | 24 条全部符合预期（导出/临时授权/记忆/SSE/绑定/去重/运维端点） |
| CLI `doctor` | 服务/库/凭据/插件/审计链/备份逐项检查 |
| 手工验收 | 超管登录后台逐页；员工 `U_ZW` 登录、发消息、附件回声、我的文件、我的权限、我的记忆；临时授权 deny 后 403、撤销恢复；回调重推 duplicate |

### C.5 仍未实现（正文 FR）

- PTL-01~04 访客门户（仅 `guest_invites` 表）
- MOB-01~03 移动端
- OPS-07 / PLG-07 在线升级与回滚（当前靠备份恢复）
- KB-02/KB-03 PDF/Word 解析与向量检索（当前纯文本 + 中文 bigram）
- CHN-04 长连接、CHN-08 IM 审批卡片、企微回调 AES 解密
- 真实厂商租户端到端（需外部凭证与公网回调地址）

使用方式见同目录 `EAB使用说明.md`。