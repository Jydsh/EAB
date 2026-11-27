# EAB 企业智能体基座 — 总体架构方案与需求规格

> **版本**：v2026.11.23.04（与根 `package.json` 的 `version` 一致；本轮文档清理不改版本号）
> **项目代号**：EAB（Enterprise Agent Base）
> **文档性质**：架构决策 + 需求规格 + 工程规范，是开发的**唯一上游依据**。代码实现与本文件冲突时，以本文件为准；本文件有错时，先改本文件再改代码。
> **本次修订**：2026-11-24，做文档漂移清理：校正模型端点/用途、工具描述符、阶段进度与附录缺口表，使正文与当前代码一致。
> **阶段**：架构与需求已定稿（第一章 ADR）；M0 内核与 M1 渠道/运维主体已实现。模型用途路由、决策（SystemOne）、语音转写/合成、图片生成、知识库 P0/P1、任务计划、任务图、多 Agent 团队协议、模型任务白名单、容器化多实例均已落地。**视频理解仍只留端点与用途位，尚未实现调用**；移动端、访客门户、企微真实回调、全量压测/SLO 仍未完成。后续按第 20 章路线推进。

**阅读指引**

| 你的角色 | 建议先读 |
|---|---|
| 决策者 | 0 定位、1 架构再设计、20 分期路线、22 待拍板事项 |
| 架构/开发 | 1–13 章（架构主体）、15 数据字典、16 接口契约、18 工程结构 |
| 需求确认 | 14 章（用例 + FR 编号表 + NFR + 验收标准） |
| 运维 | 13 部署运维、19 测试与安全验证 |
| 未来接手者 | 全篇，重点看 ADR 与「明确不做」 |

**状态标记规则（2026-11-24 起）**

- 写“设计 / 目标 / 应当 / 必须”的段落是架构规范，不代表代码已实现。
- 标“**当前实现（日期）**”的段落是代码事实，以它为准。
- 标“历史快照”的章节只用于追溯，不能当现状排期；冲突时以 `20.2.2` 和 `附录 C.6` 为准。

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
- 23. 内置浏览器工作台（2026-11-25 第一阶段）
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

- **决策**：对话主链路 `POST /conversations/:id/turns` → `text/event-stream` 流式返回；WebSocket 只承担服务端主动推送（审批待办、通知、在线状态、跨端同步）。不把 ACP 作为核心协议，只保留可选适配定位；当前无 IDE 试点，明确不实施。
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

> **当前实现（2026-11-24）**：没有独立的 `eab-worker` 包。长任务与后台恢复由主控进程内的 `job-queue.ts`、`agent-runtime.ts` 和运行租约承担；插件页面用 iframe 沙箱，插件工具经主服务统一鉴权调用。上面这张“独立 worker 进程 + 每插件一进程”的图是设计目标，不是当前代码事实；插件进程隔离仍未完成。

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
| Electron 桌面端（2026-11-26 第十轮后调整） | 作为**可选 Windows 客户端**正式推进，但不是默认入口：Web / Node 仍是零安装主形态，桌面客户端只访问已有 EAB 服务，不自带服务端。桌面端复用同一套业务 UI，增加原生 `WebContentsView` 网页标签、首次启动服务地址配置和 Windows 便携包分发；Android/iOS/浏览器继续使用 Web 右侧工作台 |

### 4.3 设计语言与动效层

**决定**：前端不追求“到处有动画”，而是建立一套可命名的动效语言。统一 token 放在 `packages/server/public/ui-motion.css`，运行时放在 `ui-motion.js`，组件通过 `data-motion="reveal spotlight beam stagger ..."` 显式选用；没有写 `data-motion` 的元素保持静止。

**为什么**：企业工作台的主要矛盾是层级、状态和操作确认，不是营销页的视觉冲击。把“高级动画”拆成 16 个词（Spotlight、Scroll Reveal、Border Beam、Magnetic Button、Scrolltelling、3D Tilt、Text Scramble、Shimmer、Parallax、Count Up、Hover Lift、Typewriter、Stagger、Marquee、Spring、Easing），设计、产品、开发才能用同一套语言评审“该不该动、动多久、怎么降级”。

**分层**：功能反馈层（100–200ms，按钮/加载/成功失败）、结构层（160–360ms，区块/列表/弹窗/运行卡）、叙事层（登录页/官网/产品故事/空状态首屏）。工作台的表格、审批、聊天正文不进入叙事层。

**硬约束**：
- 只动 `transform / opacity`，不动布局属性；微交互 100–200ms，转场 200–300ms。
- 同一屏不超过 3 个循环动画；不给所有卡片统一加 tilt/lift/beam。
- 必须有 `prefers-reduced-motion` 降级；信息不能依赖动效才能读到。
- 新页面先写“场景—主效果—辅助效果—参数—边界—验收”，写不出来就不加。

**当前实现**：`chat.html` / `index.html` 已引入 `ui-motion.css` 与 `ui-motion.js`；`app.ts` 显式放行四个静态文件。已接入 `.mem-list` 的错峰进入、`.agent-chat-panel.is-running` 的运行流光；`/ui-motion-lab.html` 作为 16 种效果的可视验收页。规范与技能见 `docs/EAB-高级UI动效规范-2026-11-24.md` 与 `eab-ui-motion`。后续 React 组件继续复用同一套 token 与 `data-motion` 语义，不另造第二套动效体系。

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

### 5.4 本地项目空间（桌面版工作区）

本地项目是“绑定到某台桌面电脑上的真实文件夹”的项目工作区，产品形态对齐豆包工作的项目：项目把对话、工作任务和产物按项目分组，一个项目对应桌面电脑上的一个文件夹。**项目只能在安装 EAB 桌面端的电脑上创建**；服务端可以部署在远端，只保存设备标识、显示路径和真实路径快照，所有文件读写都通过桌面文件桥转发到那台电脑执行。

| 维度 | 云空间（cloud） | 本地项目（local） | 纯对话（none） |
|---|---|---|---|
| 根目录 | `{EAB_HOME}/.../users/{userId}/workspace/` | 桌面电脑上用户选择的真实目录 `root_realpath` | 无 |
| 创建入口 | 网页/桌面均可 | 仅桌面端：侧栏「新建项目」或输入区项目入口 | 无 |
| 文件工具 | `workspace.*` / `office.*` | `project.list/read/search/write/edit/delete`，经桌面桥执行 | 无 |
| 命令工具 | 无 | 不开放 `project.exec`；构建/测试由用户在桌面终端手动执行 | 无 |
| 会话字段 | `chat_sessions.space_kind='cloud'` | `space_kind='local'` + `space_id=user_local_spaces.id`；`project_mode=chat/task` | `space_kind='none'` |

**项目创建与字段**
- 创建弹窗字段：项目名称、工作目录（桌面原生选择文件夹）、云端资源（可选）、项目指令（可选）。工作目录只显示桌面电脑上的本地路径，不允许网页手填。
- 对话与工作任务：项目侧栏直接挂会话，任务用图标区分，不再显示「对话 / 工作任务」分组标签；项目行可折叠/展开，并复用普通会话的重命名、删除菜单。项目主页已不再是入口，保留隐藏代码待清理。工作任务使用独立的 `project_mode='task'`，系统提示会要求先拆步骤、再执行并给出产物与验收结果；普通对话保持问答式交互。
- 云端资源本期只保存选择清单，并在系统提示里作为“项目资料清单”注入；**尚未真正读取云空间文件内容**，不能对用户宣称已经读过。

**数据与归属**
- 管理接口：`GET/POST/PATCH/DELETE /api/local-projects`；文件列表 `GET /api/local-projects/:id/files?path=&depth=&limit=`，`path` 为空表示项目根。
- 创建 `POST /api/local-projects` 必须带桌面标记 `x-eab-desktop:1`、`x-eab-desktop-device` 和 `deviceId`；服务端先确认设备在线，再通过桥让桌面端校验目录，桌面端返回真实路径后才入库。服务端不直接 `stat` 本机路径。
- 登记表 `user_local_spaces` 保存 `device_id / instructions / cloud_refs_json`；唯一键按 `(company_id, user_id, COALESCE(device_id,''), root_realpath)`，同一路径在不同电脑上可以是不同项目；每个员工最多 20 个。
- 删除项目只解除项目绑定，**不删除磁盘文件**；项目内的对话和工作任务会一并逻辑删除，桌面端同步移除本地 `projectId -> root` 绑定。
- 项目归属只按当前员工校验，子 Agent 使用父会话已校验的 `ActiveSpace`，不重新跨员工查库。

**桌面文件桥**
- Electron 主进程持久化 `desktopDeviceId`，通过 `register / jobs / result` 长轮询连接服务端；在线窗口 45 秒，单次长轮询最多 20 秒，任务默认 30 秒超时。
- 服务端与桌面端按 `companyId + userId + deviceId` 三元组隔离；任务只携带相对路径和操作参数，桌面端用自己的 `projectId -> root` 绑定表解析根目录，避免服务端或网页诱导客户端读任意文件。
- 创建流程：桌面原生选目录 → `getDesktopInfo()` 取 deviceId → POST 带设备标记与字段 → 服务端经桥 `describeRoot` 校验 → 入库 → 桌面 `bindProject(projectId, path)` → 展开左侧项目分组，等待用户点“新建对话”。
- preload 暴露 `getDesktopInfo / bindProject / unbindProject / syncProjects`；Web 端没有这些桥能力，因此不显示创建入口。

**路径与内容安全**
- 桌面端只接受绝对路径且必须是已存在、可写文件夹；拒绝盘符根、`C:\Windows`、`Program Files`、`ProgramData`、`C:\Users` 本身等危险根。
- 相对路径统一走 `safeJoin(root, rel)`；绝对路径必须 `isWithinRoot(root, value)`；存在的目标再做 `realpath` 校验，防止符号链接逃逸；新文件逐级检查已存在父目录的真实路径。
- 默认拒绝 `.env`、`.npmrc`、`.pypirc`、`.netrc`、`.git-credentials`、`id_rsa` 等私钥、`credentials.json`、`service-account*.json`、`.pem/.key/.p12/.pfx/.jks/.keystore`，以及 `.ssh` / `.aws` 目录。`project.search` 同样跳过这些文件，避免从搜索侧绕过读取闸。
- `project.write` 单文件上限 5 MB，`project.edit` 一次最多 50 处；`project.delete` 只删除文件、不递归删除目录，风险等级 `irreversible` 并逐次审批；`project.list` 跳过 `node_modules`、`.git` 等重目录的递归展开，只返回目录条目。

**部署边界**
服务端与桌面端可以不在同一台电脑：只要桌面端在线，文件操作就能转发过去。桌面端离线时项目列表仍可见，但文件读写会提示“保持安装 EAB 桌面端的电脑开机并打开应用”。服务端只保存设备与会话记录，不保存项目文件内容，也不把绝对根路径交给模型。

**命令执行开关**
桌面设备绑定的项目本期不开放命令执行（`project.exec` 返回 403）；需要装依赖、构建、测试或运行脚本时，由用户在桌面终端里手动执行。服务端本机的旧项目兼容路径仍受 `EAB_PROJECT_EXEC` 控制，默认 off。

### 5.5 桌面右侧浏览器桥（Agent 原生操作）

EAB 原有两条互不相通的浏览器路径：Web 形态是服务端 Playwright 打开页面、右侧投帧；桌面端右侧是 Electron `WebContentsView` 原生标签页，`pageId` 以 `dp_` 开头，有真实登录态、多标签和 `window.open` 新标签。Agent 的 `browser` 工具默认在服务端执行，因此看不到用户已经打开的桌面标签。

2026-11-26 第十三轮把桌面文件桥扩成**通用桌面任务桥**：同一套 `register / jobs / result` 长轮询除了文件任务，还承载 `kind='browser'` 任务，由桌面主进程直接操作右侧原生 `WebContentsView`，再把结果回传服务端。服务端不另开无头页面，也不把桌面页面复制到云端；Agent 看到的标题、URL、正文和元素就是用户右侧正在显示的那一页。

| 层 | 职责 |
|---|---|
| 服务端 | `desktop-bridge.ts` 保存标签清单、按 `companyId + userId + deviceId` 解析在线设备、下发 `browser` 任务；`routes/tools.ts` 的 `browser` 分支在命中桌面设备时改走 `browserCall`，30 秒超时；`routes/chat.ts` 把标签清单注入系统提示 |
| 桌面主进程 | `main.mjs` 维护 `WebContentsView`、标签持久化/恢复、归属校验，执行 `list/open/activate/snapshot/click/type/scroll/navigate/back/forward/reload/screenshot/close` |
| 桌面 preload | 暴露 `listTabs(userId)`、`activateTab(pageId)`、`onActivate(callback)`，不向第三方页面泄露桥能力 |
| 前端 | `chat.js` 登录后恢复真实标签和本地草稿，切换工作台时激活对应标签；聊天请求带桌面设备头，Agent 切页时前端标签栏跟随 |

**任务与设备路由**
- 浏览器任务不带 `projectId`，只带 `kind:'browser'` 和动作参数；文件任务保持原结构。两者共用任务表和 20 秒长轮询，避免再起一套控制端口。
- 服务端优先按请求头 `x-eab-desktop-device` 找设备，其次找最近在线设备。没有桌面设备时，`list` / `activate` 明确返回 409，提示该能力只支持桌面端右侧浏览器，不退化成服务端 Playwright。
- `open` / `navigate` 的 URL 仍过 `assertPublicHttpUrl`：只允许 http/https，默认只读公网；内网白名单沿用浏览器工具既有策略。`snapshot` 读取的是用户自己已经打开的页面，目前不再对页面 URL 做一次公网校验。
- `screenshot` 的 base64 由服务端落为个人云空间文件 `浏览器截图-<时间戳>.png`，不把大图塞进模型上下文。

**标签持久化与恢复**
- 主进程把标签元数据写入 `desktop-config.json` 的 `browserTabs`：`{ ownerUserId, activePageId, tabs:[{pageId,title,url,favicon}] }`，并在注册成功、标签变化、窗口关闭前上报 `POST /api/desktop/bridge/tabs`。
- 主页面 `did-start-navigation` 只**隐藏**原生视图，不销毁。这是聊天页刷新后右侧标签仍存活的关键；刷新完成后前端重新拿到同一批 `dp_*` 标签。
- 应用重启或首次 `listTabs` 时，主进程按持久化 URL 逐个恢复标签，恢复时 `broadcast:false, activate:false`，避免启动过程触发前端事件。
- 前端另有 `localStorage` 快照 `eab.chat.browserTabs.v1:<person.id>`，保存标签、`pageId`、标题、URL、favicon、未提交草稿、活动标签和工作台布局。恢复顺序是：先取主进程仍存活的真实标签，再补回空白草稿标签，最后激活原活动标签。
- 标签归属当前登录员工。换账号时 `resetBrowserTabsForOwner` 销毁旧视图并清空配置，避免上一账号的标签、登录态或页面正文泄露给下一个账号；换服务器也会清空旧标签配置。

**原生页面操作口径**
- `snapshot` 返回 `title`、`url`、`body.innerText`（最多 8000 字）和最多 80 个可见可交互元素，元素生成 `e1/e2...` ref，字段与服务端 `BrowserElement` 对齐。
- `click` 只允许链接和普通按钮，明确禁止提交表单；`type` 只允许 `input` / `textarea`，`input` 仅 `search/text/url`，单次最多 500 字；`scroll` 每次 600px；`screenshot` 用 `webContents.capturePage()`。
- 输入框缺 `type` 属性时按 `text` 处理，兼容百度等用无类型 `textarea` 做搜索框的站点；`type` 只写入值，不自动回车提交。
- Agent `activate` 会通过 `eab:browser-activate` 通知前端切换标签栏；Agent `open` 创建的新标签通过 `eab:browser-tab-open` 加入前端标签栏。

**审批与安全边界**
- `list/snapshot/screenshot/scroll/activate` 是读或定位动作，不弹审批；`open/navigate/click/type/back/forward/reload/close` 仍逐次审批，审批动作记为 `tool:browser`。
- 原生页仍只允许 http/https，拒绝 `file:` / `javascript:` / `data:` 和带账号密码 URL；`window.open` 不再一律拒绝，而是转为受控新标签，所有新页同样走 URL 校验。
- 已登录页面、内网页面的正文读取是否要额外确认，目前未定；当前策略是“用户已经打开并显示在右侧的页面，Agent 可读”，行为类动作仍逐次审批。
- 仍需补的边界：子 Agent 是否继承 `desktopDeviceId`、关闭 `EAB_BROWSER_ENABLED` 时桌面路径是否单独放行、失效 URL 恢复成空白标签后的清理策略。

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

> **当前实现（2026-11-24）**：已落地「本地目录 / npm（含国内镜像）/ GitHub」三种来源；`tgz` 直链仍是设计稿。三源共用解包、清单校验、暂存与落库链路，**只取包内容，不执行 `npm install`、生命周期脚本或仓库构建脚本**。

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

> **当前实现（2026-11-24）**：上面是隔离目标，不是已完成的运行时。当前插件是页面型插件：前端在 iframe 沙箱内渲染，插件要数据只能调基座 HTTP API，没有独立 worker 子进程、stdio JSON-RPC、CPU/内存配额与崩溃重启。`12.9.7` 已明确列出“不执行安装脚本、不装依赖、不做插件后端路由、不做进程外隔离”。插件能力治理只有 scope 校验与按公司启停，不能按 ADR-08 的完整四段式对外宣称。

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

### 10.11 2026-11 知识库全流程升级（P0/P1 已落地，P2 召回测试已落地）

本轮把知识库从“纯文本入库”升级为“文件上传 → 解析/OCR → 规则/模型清洗 → 结构切片 → 本地向量 → 可选外部向量 → 召回测试”的可追踪流水线。详细设计见 `docs/EAB知识库全流程升级方案.md`，落地口径如下：

| 维度 | 口径 |
|---|---|
| 文件 | `pdf / docx / xlsx / pptx / txt / md / csv / json / html / png / jpg / webp`；老 `.doc/.xls/.ppt` 首版提示另存；扫描 PDF 走 OCR，缺组件/模型进 `needs_config` |
| 清洗 | 默认规则清洗；可选 `kb.clean` 模型清洗；`auto` 无模型自动退回规则；机密文档默认禁止外部云模型清洗 |
| 切片 | 统一 `kb-splitter`，默认约 500 tokens / 重叠 80；表格按行组并重复表头；保留 heading/page/sheet/row 元数据 |
| 测试 | Dify 式 query / mode / topK / 阈值 / rerank；返回 keyword/vector/RRF/rerank 分数与耗时；已支持单次测试、用例 CRUD/运行、Top1/Recall@K/MRR 与 embedding 模型对比；批量运行、检索模式并排、rerank A/B 待实施 |
| 测试记录 | 默认保留 30 天，可配 1–365 天；设置位于「系统 → 系统与运维 → 日志、审计与数据保留」，保存后同步所有知识库；每 6 小时清理过期记录；记录保留命中摘要，正文截断 800 字符 |
| 向量库 | 本地 SQLite 始终可用；`Qdrant` 新增为数据连接类型；`pgvector` 复用 PostgreSQL 连接并检测扩展；外部不可用时按“外部 → 本地 → 关键词”降级 |
| 配置源 | 以管理后台「连接与平台 → 数据连接」为准，不读环境变量覆盖；连接变更热生效，不重启 |
| 任务 | 新增 `kb_ingest_jobs` 管解析/清洗/切片/索引全流程；`kb_index_jobs` 保留为向量子任务；进程内 worker 可重启恢复，不依赖 Redis |
| 迁移 | `0068_kb_pipeline.sql`（已应用）扩展 KB 表与测试表；`0069`–`0071` 已被其他功能占用，`0072_kb_test_retention.sql`（已应用）增加测试保留期，`0073_database_connections_vector.sql`（待实施）扩展连接类型与 pgvector 能力 |

**边界**：本轮方案不改现有 ACL、RRF、rerank 行为；测试台与对话检索共用同一 `kb-retrieval` 核心，不允许两套检索逻辑。外部向量库只做加速/扩容，本地仍是权威索引；索引失败不阻塞上传，检索失败不阻塞对话。

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
| 本轮用户消息 | `chat:write` | **唯一任务通道**：只有最后一条 `user` 消息是本轮问题 |
| 会话历史 | `chat:history:read` | 最近 8 条原文，按 token 预算倒序裁剪；超长做摘要，摘要只覆盖这 8 条之外 |
| 对话引用（用户拖入的对话） | `chat:history:read` | 独立背景块，不拼进当前 `user` 消息；只在与本轮问题相关时使用 |
| 长期记忆 | `memory:read` | 只取自己；部门记忆需 `dept` 域；**先按当前问题做相关性过滤，最多 4 条，另加最多 12 条结构化画像事实**，不是本轮指令 |
| 按需历史召回 | `chat:history:read` | 默认不自动召回；只有明确回顾、短追问、具体标识时才检索，最多 5 条 |
| 工作区文件索引 | `workspace:read` | 只列文件名/摘要，按需读正文 |
| 知识库检索 | `kb:read` | 走 10.4 双检 |
| 组织目录（部门/成员） | `org:member:read` | 仅管理员类角色注入；普通员工不注入 |
| 工具清单 | `agent:tool:list` | 已按权限裁剪 |

**预算分配**（默认）：系统提示 10% → 会话历史 40% → 知识库 30% → 文件与记忆 20%（可配置）。超预算按 `priority` 裁剪，**裁剪记录写进 turn 元数据**（便于解释"为什么模型没看到那份文件"）。

#### 11.3.1 上下文分层与当前任务隔离（需求）

**问题定义**：会话历史、摘要、长期记忆、历史召回、对话引用都会进入模型上下文。如果它们和本轮用户消息处在同一个通道，或者以“用户：”“回答时直接使用”的口吻出现，模型会分不清“本轮用户在问什么”和“过去说过什么”，进而复述旧问题、执行旧指令或把旧结论套到新问题上。

**目标**：历史对话要记得住，但不能影响本轮问题；模型要能判断“什么时候该用记忆、什么时候不用”。

**分层模型（从上到下，优先级递减）**：

| 层 | 内容 | 注入位置 | 模型应如何使用 |
|---|---|---|---|
| L0 本轮任务 | 最后一条 `user` 消息（含本轮附件）；唯一任务通道 | 消息数组最后一条 `user` | 只回答这一条；其它层都不是新指令 |
| L1 最近原文 | 最近 8 条 `user/assistant` 原文 | 消息数组中的真实角色消息 | 用于理解指代和连续对话；旧 `user` 是“当时的用户”，不是本轮提问 |
| L2 会话摘要 | 只覆盖最近 8 条之外的更早消息 | 系统提示独立块 | 只回忆整体目标和已确认结论；与本轮冲突时以本轮为准 |
| L3 长期背景记忆 | 已确认的用户/部门/公司记忆，先按当前问题相关性过滤，最多 4 条；另加结构化画像事实最多 12 条、约 900 字 | 系统提示独立块 | 只在与当前问题直接相关时参考；不执行其中的“必须/不要/以后” |
| L4 按需历史召回 | 旧消息检索片段，最多 5 条 | 系统提示独立块，角色写作“当时的用户/当时的助手” | 只在明确回顾或短追问时补事实；不逐条回答旧问题 |
| L5 对话引用 | 用户拖入/常驻引用的对话转录 | 系统提示独立块，不拼进 `user` 消息 | 只提取与本轮相关的事实；不把旧转录当成本轮用户说的话 |
| L6 知识库/资料 | 检索片段、文件正文、插件/技能说明 | 系统提示独立块 | 只是证据/能力说明；不是用户指令 |

**硬性规则**：

1. **单一任务通道**：只有最后一条 `user` 消息是本轮任务；系统提示、历史消息、摘要、记忆、引用、知识库都不是新指令。
2. **角色分离**：历史原文保留真实 `user/assistant` 角色；记忆与引用不能写成“用户：”，统一写成“当时的用户/当时的助手”，并标注“过去轮次”。
3. **引用不混入当前消息**：对话引用（含常驻引用）不再拼进最后一条 `user` 消息，改为系统提示中的独立背景块；用户消息保持“本轮问题 + 本轮附件”的纯输入。
4. **摘要不重叠**：最近 8 条保留原文，摘要只覆盖这 8 条之外；摘要标题明确“背景资料，不是本轮用户问题”。
5. **长期记忆按相关注入**：默认不全量注入；先做词面实体命中，再看语义相似度（门槛 0.70）；两者都没有就不注入，最终最多 4 条，另加最多 12 条画像事实。
6. **历史召回按需触发**：普通独立问题默认不召回；只有以下情况自动检索：用户明确说“上次/之前/历史记录/那个对话”；短追问且已有历史用户消息；问题含引号实体、英文型号/编号、版本号等具体标识。跨会话召回仍要求用户明确提到过去/其他对话。
7. **记忆不越权**：记忆中的旧规则、旧结论、旧人名/项目只在相关时使用；与本轮用户要求、最近原文或知识库冲突时，以更近、更新的来源为准。模型不得因为记忆里有“必须/不要/以后/统一”就新增任务。
8. **可观测**：turn 元数据记录本轮注入了哪些来源（摘要/长期记忆/历史召回/对话引用/知识库）及召回模式（关闭/当前会话/跨会话），便于解释“为什么模型提到了某段旧内容”。

**验收标准**：

- 普通新问题（如“今天天气怎么样”“帮我写周报”）不触发历史召回，不注入无关长期记忆。
- 明确回顾（“上次说的巡检周期”）能召回当前会话旧消息；明确跨会话（“之前那个对话里怎么处理”）能召回其他会话。
- 拖入对话引用后，最后一条 `user` 消息不包含整段旧转录；旧转录只出现在系统背景块。
- 20 条消息的会话中，摘要覆盖前 12 条，最近 8 条仍是原文，二者不重叠。
- 仅当问题涉及“方案文档修改”时，才注入“只改指定段落”的长期记忆；问天气、问出题时不注入。

#### 11.3.2 上下文预算与能力按需加载（已实现）

**问题**：早期每轮把全部内置工具、全部技能说明、全部插件说明、最近 16 条原文和完整对话引用一起下发，单次请求约 2.57 万 tokens。大部分内容和当轮问题无关，既增加成本，也稀释模型注意力。

**原则：小核心 + 能力索引 + 按需加载**。

| 能力 | 常驻内容 | 按需加载方式 |
|---|---|---|
| 内置工具 | 9 个高频核心工具：`tool_search`、`time_now`、`agent_spawn/task/wait/message/resume/ask_parent`、`kb_search`；其中主 Agent 会按阶段过滤 `agent_wait/ask_parent` | 个人云空间文件工具、Office、项目命令、插件开发、技能开发、定时任务、组织通讯录、团队规则按问题/文件类型动态加入；其余用 `tool_search` 命中后注入完整 schema |
| 技能 | 紧凑索引：id、名称、级别、80 字说明、6 个触发词、8 个声明工具；总量上限 4,000 字符 | 模型匹配后调用 `skill_load` 读取完整说明 |
| 插件 | 业务意图命中时整包下发工具 schema；否则只下发与当前问题词面相关的插件工具 | 未直接下发的插件工具仍留在 `tool_search` 目录；插件说明按当前问题相关性过滤，单条 800 字、总量 3,000 字符 |
| 对话引用 | 只注入摘要：总消息数、最早需求、最近 8 条、`conversationId` | 摘要不足以回答时调用 `conversation_read(conversationId, query?, limit?)`，单次最多 12 条/3,000 字符 |
| 会话历史 | 最近 8 条原文 | 更早消息由滚动摘要覆盖；摘要窗口同步为 8，避免原文与摘要之间出现空洞 |
| 长附件 | 不带批次时不下发 `batch_read/batch_analyze` | 只有本轮确实存在长附件批次时才注入这两个工具 |

**路由规则**（`capability-route.ts`）：

- 文件组：出现文件/文档/附件/文件夹/目录/路径/扩展名，或明确的写入、导出、下载、上传、编辑、替换、重命名动作；Office、插件开发、技能开发自动带上文件组，右侧预览文件也触发。只看“查看/打开”等泛动词不触发，避免“查看天气”误判。
- Office 组：先给 3 个基础读取工具 `office.read_outline/read_range/find`，再按问题叠加修订、版本、批注、替换、插入、格式、导出、GUI；不再一次下发 11 个 Office 工具。只有明确要求“改格式/加粗/调字号”才叠加 `office.format`；“保留原格式/格式保持不变/引号里的旧文本带加粗”只给 `office.replace`。文档、表格、幻灯片、段落、单元格、批注、修订、`.docx/.xlsx/.pptx`，或右侧预览的是 Office 文件时触发。
- 项目组：运行命令、脚本、代码、测试、构建、部署、端口、进程、Git 等；出题、测验、考试不触发。
- 开发组：插件/技能自开发；定时组：提醒、每天/每周、日程、cron；组织组：部门、班组、组长、上下级；记忆组：以后、今后、统一、始终、一律、都按、记住、规则、标准、规范；“不要/别再”仅在后续 12 字内出现“再/以后/下次/每次/都/统一/一律”时触发，单纯“不要改动第一段”不算长期规则。
- 业务数据问题即使出现“东环线/工区/班组”等组织名称，也不当通讯录查询。
- 空 query 是内部目录/定时任务等未知上下文，保持原文件组，避免自主任务被意外削掉读写能力。

**去重与压缩**：

- “前台任务分诊”和“多 Agent 规则”合并成一段，只保留编队、切片、沟通、等待、容量和汇报的关键约束。
- 前端父 Agent 的系统提示不再列出子 Agent 专用的 `agent_ask_parent` / `agent_consult`，也不再列出前台禁止的 `agent_wait`。
- 插件工具不再无条件全量下发：命中工单、台账、报表、数据、日程、邮件、审批、项目、文件等业务意图时整包下发，保证“查工区/班次”这类业务词搜得到；普通闲聊只保留工具名/描述/插件提示词与问题有词面重合的插件工具，其余仍可通过 `tool_search` 加载。

**可观测**：assistant 消息 `meta.contextBudget` 记录系统提示、工具 schema、历史、摘要、长期记忆、历史召回、对话引用、知识库、插件说明、技能索引各自的条数和字符数/token 估算；`contextBudget.tools.top` 额外记录本轮最大的 6 个工具 schema 名称和字符数，用于定位下一轮压缩对象。`meta.tokens.prompt` 仍是当轮所有模型调用累计，单次调用量需结合 `contextBudget` 和轮次判断。

**实测（2026-11-20，真实会话）**：

| 场景 | 改造前单次 | 改造后单次 | 变化 |
|---|---|---|---|
| 天气追问轮（1 次模型调用，2 条历史） | 25,700 tokens | 11,955 tokens | -53.5% |
| 工具 schema | 33 个核心工具，约 14,051 tokens | 19 个实际下发工具（含插件/会话工具），12,816 字符 | 显著下降 |
| 工具 schema（第二轮） | 19 个工具 / 12,816 字符 / 6,534 tokens | 15 个工具 / 9,973 字符 / 4,767 tokens | 工具 token 再降 27% |
| 工具 schema（第三轮） | 15 个工具 / 9,973 字符 / 4,767 tokens | 9 个工具 / 5,726 字符 / 2,724 tokens | 工具 token 再降 42.9% |
| Office 只读轮（不含 ask_user/技能） | 26 个工具 / 20,645 字符 | 18 个工具 / 10,867 字符 | -47.4% |
| Office 编辑轮（不含 ask_user/技能） | 26 个工具 / 20,645 字符 | 20 个工具 / 14,147 字符 | -31.5% |
| Office 真实编辑（docx，含 ask_user/技能） | 25 个工具 / 16,643 字符 / 7,646 tokens | 23 个工具 / 14,235 字符 / 6,610 tokens | 少 2 个工具，字符 -14.5%，tokens -13.5% |
| Office 编辑轮工具 schema（函数级，不含 ask_user/技能） | 19 个 / 12,129 字符 | 19 个 / 10,929 字符 | 字符 -9.9% |
| Office 真实编辑（docx，含 ask_user/技能） | 23 个工具 / 14,235 字符 / 6,610 tokens | 19 个工具 / 10,646 字符 / 4,559 tokens | 少 4 个工具，字符 -25.2%，tokens -31.0% |
| Office 真实编辑（docx，规则按工具拆分后） | 19 个 / 10,646 字符 / 4,559 tokens；系统提示 6,525 字符 / 4,610 tokens | 19 个 / 10,646 字符 / 4,559 tokens；系统提示 5,769 字符 / 4,197 tokens | 工具 schema 不变；系统提示 -756 字符（-11.6%），tokens -413（-9.0%） |
| Office 真实编辑（docx，跨 run 严格拒绝 + 空正文回退） | 19 个 / 10,646 字符 / 4,559 tokens；系统提示 5,775 字符 / 4,199 tokens（长期记忆 1 条） | 19 个 / 10,738 字符 / 4,617 tokens；系统提示 5,083 字符 / 3,771 tokens（长期记忆 0 条） | 工具 schema +92 字符（+58 tokens），来自更严格的 `oldText` 和跨 run 拒绝说明；系统提示差异主要来自长期记忆命中数不同，不单独算压缩收益 |
| 系统提示 | 8,664 字符 | 5,728 字符 | -34% |

第二轮的 4 个工具减少来自“与天气问题无关的插件工具”，`ask_user` 从 2,309 字符降到 1,774 字符、`agent_spawn` 从 2,035 字符降到 872 字符；详细编队规则和澄清规则保留在系统提示，工具描述只留参数契约。

第三轮把 6 个云空间文件工具从常驻核心改为按问题路由；普通天气轮不再携带 `workspace_list/read/search/write/edit/folder`，工具 schema 从 9,973 字符降到 5,726 字符。文件、Office、插件/技能开发仍会自动带上这组工具；未命中的场景由 `tool_search` 兜底。

第四轮把 Office 从“整组 11 个”拆成“3 个基础读取 + 按动词叠加编辑/输出”，并压缩 `ask_user` 的嵌套描述。Office 只读轮从 26 个工具 / 20,645 字符降到 18 个 / 10,867 字符，编辑轮降到 20 个 / 14,147 字符；真机文档轮 `meta.contextBudget.tools` 为 24 个工具 / 16,233 字符 / 7,408 tokens（含 `ask_user` 1,604 字符）。该轮模型因未定位到具体文件，只验证了工具路由，未实际改写文件。`ask_user` 从 1,774 字符降到 1,604 字符，仍是最大单条 schema。

第五轮补齐了两个真实编辑里暴露的误路由：`保留原格式`、`格式保持不变` 等“只保留不修改”的表达不再下发 `office.format`；引号里的旧文本即使带“加粗/字号”，也只按引用内容处理，不当作格式修改命令。`不要改动第一段` 这类文档内约束也不再触发 `memory.propose`。

真机端到端（2026-11-20，`EAB-Office端到端测试2.docx`）已跑通：子 Agent 依次执行 `office.find → office.replace → office.read_range`，没有调用 `office.format`；解压 `document.xml` 复核，第二段变为“第二段开头加粗：第二段正文已缩短，格式保持不变。”，两个 run 仍为加粗 + `sz=24`，第一段和第三段未变。父轮工具 schema 为 23 个 / 14,235 字符 / 6,610 tokens，比上一版 25 个 / 16,643 字符 / 7,646 tokens 少 2 个工具、2,408 字符、1,036 tokens。

第六轮继续压缩常驻大 schema 本身：`office_replace` 1,281→972 字符、`workspace_edit` 961→794、`workspace_read` 961→743、`agent_spawn` 872→625；同时把 `office_read_range` 814→685、`workspace_search` 813→683。工具数、参数名、必填项、枚举和路由都保持不变，只把重复的操作顺序收回到系统提示，工具描述保留触发、关键参数和失败边界。Office 编辑轮函数级 schema 从 19 个 / 12,129 字符降到 19 个 / 10,929 字符（-9.9%）。真机 `meta.contextBudget.tools` 已在第七轮复核。

第七轮用真实 docx 对话先复现了两个问题：`保留原有加粗和字号` 被误判成格式修改，额外下发 `office_format`（1,997 字符）；单文件编辑又被拆成一个只读定位子任务，父 Agent 在唤醒轮没有写入工具，却直接声称“已完成修改”。修复分两层：格式路由按逗号/分号拆句，只有同一句里同时出现格式对象和修改动作才下发 `office_format`；单文件 Office 编辑不再下发任何 `agent_*` 工具，批量/多文件才保留编队。系统提示和 `agent_spawn` 描述同时明确：单文件局部编辑在主回合完成，文件修改子任务必须包含定位、写入和复读验收。

修复后同一句真实 docx 请求的工具 schema 仍为 19 个 / 10,646 字符 / 4,559 tokens；把原来一整段 Office 规则按实际加载的工具拆开（基础定位替换、范围读取、格式、修订、批注、插入各自注入）后，系统提示从 6,525 字符 / 4,610 tokens 降到 5,769 字符 / 4,197 tokens，少 756 字符（-11.6%）、413 tokens（-9.0%）。实际链路为 `office.find → office.replace`，没有 `office_format`、没有子 Agent。

拆分后第一次真实编辑只核对了文本，解压 `document.xml` 发现第二段整段被塞进第一个加粗 run：模型省略了 `oldText`，旧实现直接把整段新文本写进第一个 run，正文错误继承了加粗。`replaceDocxText` 已改为先求新旧文本的公共前缀和后缀，只替换真正变化的中段；恢复正确历史版本后再次真实编辑，p2 正文为“第二段开头：真实 docx 对话第二轮验证，第一段和第三段不变。”，第一个 run 仍是 `w:b` + `sz=24` 的加粗前缀，第二个 run 仅 `sz=24`，p1/p3 未变，说明文本变化和 run 级格式可以同时保留。

第八轮专门处理“整段重写跨多个不同格式 run”的边界。第一版在 `office.replace` 里公开了 `formatStrategy: 'strict' | 'firstRun'`：默认拒绝跨格式替换，显式传 `firstRun` 才允许把整段统一成第一个 run 的格式。真机复测证明这个旁路不可用：用户明确要求“保留原有加粗和字号”，模型仍在 `office.replace` 里传 `oldText` 全段和 `formatStrategy=firstRun`，工具成功返回，但解压 XML 后 p2 整段继承了第一个 run 的 `w:b + sz=24`，正文被整体加粗，格式保真失败。

修复直接删除了公开的 `formatStrategy` 参数、解析逻辑和 schema 描述，`replaceDocxText` 改为始终拒绝替换范围覆盖 2 种及以上 run 格式；错误信息明确要求把 `oldText` 收窄到单个 run 内的正文本段，再分段替换。`office.replace` 的 `oldText` 描述也改为“非空目标必填”，并提示不要跨多个格式不同的 run。这样模型没有“统一格式重写”的公开捷径，整段重写只能拆成单 run 内的局部替换。

恢复正确历史快照 `v1795180626548` 后，用干净会话再次真实编辑：请求只把第二个 run 内的“真实 docx 对话第二轮验证”改为“第三轮真实验收”。实际链路为 `workspace.list → office.find → office.read_range → office.replace`；`office.replace` 参数只有 `elementId=p2`、`oldText=真实 docx 对话第二轮验证`、`newText=第三轮真实验收`、`path=EAB-真实对话测试.docx`，没有 `formatStrategy`。解压 XML 复核，p2 第一个 run 仍是 `w:b + sz=24` + “第二段开头：”，第二个 run 仅 `sz=24` + “第三轮真实验收，第一段和第三段不变。”，p1/p3 未变。

这次工具结果正确，但模型在工具成功后返回空正文，工作台只显示“已执行工具，但模型没有继续整理结果”。服务端新增 `describeCompletedToolCall`：工具成功且模型正文为空时，按 `office.replace` 的结构化结果生成“已完成替换：p2 从「旧文本」改为「新文本」，文件已保存”这类事实化完成句；无法识别的 JSON 才保留旧兜底，不编造未返回的格式保证。重启后用最后一条真实请求（“第三轮真实验收”→“第四轮真实收口”）复测，工具参数仍只含 `oldText/newText`，XML 仍是双 run 格式，工作台直接显示“已完成替换：p2 从「第二段开头：第三轮真实验收，第一段和第三段不变。」改为「第二段开头：第四轮真实收口，第一段和第三段不变。」，文件已保存。”，不再要求用户重发。

多文件边界同步精修：原先用“所有/全部/每个/各/几个/两个/三个”等宽泛词判断多文件，会把“所有段落”“每个单元格”误判成多文件并保留团队工具。现改为 `isMultiFileOfficeEdit`，只有“批量/逐份/多文件/多文档/多工作簿/多演示文稿”，或“所有/全部/每个/各个/多个/两个/三个/几个/这些/那些/两份/三份 + 文档/文件/工作簿/演示文稿/docx/xlsx/xlsm/pptx”，或正文出现至少 2 个 Office 扩展名时才判多文件。单文件里的“所有段落/每个段落”仍走主回合，单文件仍不下发 `agent_*`；批量仍保留 `agent_spawn`。

最终真机会话 `chat_eb6f1d2a-19ea-46e2-9809-cc68f119fddd` 的 `meta.contextBudget` 为：19 个工具 / 10,738 字符 / 4,617 tokens；系统提示 5,083 字符 / 3,771 tokens；长期记忆 0 条；`rounds=4`。相比上一轮 19 个 / 10,646 字符 / 4,559 tokens，工具 schema 增加 92 字符、58 tokens，来自更严格的 `oldText` 和跨 run 拒绝说明，没有新增工具。定向测试 `chat-tool-completion 3 + office-content 60 + capability-route 10 + tool-search 10` 共 83 个通过；全量回归 186 个文件 / 1,120 个用例通过，`pnpm typecheck` 通过。

第九轮把上一轮剩下的四项逐一收口。

**空正文的真正根因不是“模型在无工具收尾轮返回空”，而是工具轮次被用满后根本没有收尾轮。** 当时真实会话的 `rounds=4`：第 1 轮 `workspace.list`、第 2 轮 `office.find`、第 3 轮 `office.read_range`、第 4 轮 `office.replace`，四轮全部在调工具，`maxRounds` 到顶后循环直接退出，模型没有机会写最终总结。修复放在 `runAgentTurnBody` 的工具循环之后：当 `pendingParentQuestion` 为空、`text` 为空、且至少一个工具 `status === 'done'` 时，追加一条“【工具已执行完成】本轮不再提供任何工具”的收尾指令，再用 `tools: []` 调一次当前模型；成功返回正文时写入 `text`、`rounds += 1` 并发出 content 事件，失败才保留空正文交给 `describeCompletedToolCall` 兜底。新增 `chat-finalize-after-tools.test.ts`，用 mock 工具和 mock 模型把 `maxRounds` 压到 1，验证第一次只调工具、第二次收到收尾指令并输出完成句。真机复测同一类请求（“第四轮真实收口”→“第五轮真实收尾”），工具仍是 4 个，`rounds` 从 4 变成 5，工作台直接显示“已将……替换为……保留了原有格式，文件已保存”，不再出现空正文。

**跨格式整段重写改为独立工具 `office.rewrite`，不再恢复 `office.replace` 的格式旁路。** `replaceDocxText` 拆成公开严格包装和内部 `replaceDocxTextCore(buffer, options, allowCrossRun)`；`office.replace` 始终传 `false`，继续拒绝覆盖 2 种及以上 run 格式。新增 `rewriteDocxElementText` 只服务“用户明确要求整段重写并统一格式”：先用 `allowCrossRun=true` 做整段文本替换，再调用 `formatDocxText` 对目标段落/单元格的全部 run 应用显式格式；只支持 `paragraph` 和 `table_cell`，新文本与旧文本相同则只应用格式。能力路由新增 `office.rewrite` 到 `OFFICE_MUTATION_IDS` 和 Office 工具组，并用 `WHOLE_REWRITE_TEXT`（整段/全段/整块/整句 + 重写/改写/覆盖/改成/改为/换成）与 `UNIFORM_FORMAT_TEXT`（统一/格式/字体/字号/加粗/斜体/下划线/颜色/对齐）双命中、且不处于“保留原格式”状态时才下发；系统提示同步要求保留原有加粗字号时继续用 `office_replace` 并收窄 `oldText`。真机请求把 p2 整段重写为“整段重写验收：格式已统一，第一段和第三段不变。”并统一加粗、12 号字，实际只调 1 次 `office_rewrite`（`elementId=p2`、`bold=true`、`fontSize=12`），`applied` 为 `["bold","fontSize"]`、`runCount=2`、`replacements=1`；解压 XML 后 p1/p3 仍是 plain，p2 两个 run 都是 `w:b + sz=24`，整段格式统一且旧文本消失。该轮 `meta.contextBudget` 为 22 个工具 / 14,239 字符 / 6,122 tokens、系统提示 6,053 字符 / 4,399 tokens（长期记忆 1 条）、`rounds=2`；工具 schema 比单文件替换场景多 3,501 字符 / 1,505 tokens，来自 `office_rewrite`、`office_format` 等按能力额外加载的工具，不是核心工具回涨。

**真实双文件编辑先验证了“批量交给团队”，再验证了“两个独立子 Agent 并行”。** 第一条真实请求处理《EAB-真实对话测试.docx》和《EAB-双文件测试.docx》，系统保留团队工具并调 `agent_spawn`，但模型只派了 1 个子任务，子 Agent 串行改完两个文件，主 Agent 汇总成功。为验证真正并行，第二条请求明确要求“两个互不依赖的子任务、每个子 Agent 只改一个文档”；实际派出 `child-a` 与 `child-b` 两个岗位同时运行，前者 4 次工具、后者 9 次工具，两个文件分别落盘并各自 `office_read_range` 复读。第一个子 Agent 写出的文本完全匹配，第二个子 Agent 多写了一个空格，主 Agent 汇总时识别出差异；随后用单文件请求把《EAB-双文件测试.docx》第二段的“双文件双 Agent 并行完成。”改为严格无空格的“双文件双Agent并行完成。”并复读确认。最终两个文件 p2 都是目标文本、`bold=true`、`fontSize=12`，p1/p3 未变。

以上三轮定向测试共 6 个文件 / 104 个用例通过（`capability-route` 10 + `tool-search` 10 + `chat-system-prompt-space` 19 + `office-content` 61 + `chat-finalize-after-tools` 1 + `chat-tool-completion` 3），全量回归 187 个文件 / 1,122 个用例通过，`pnpm typecheck` 通过。临时调试脚本和文档校验目录在本轮收尾时删除；Git 已在本地提交 `3625c07`，未推送远端。

第十轮审计发现，员工聊天附件其实已经在既有链路里完成持久化，缺的是正文解析，因此没有重造上传通道。

**已有持久化链路**：前端发送前按顺序把附件上传到本人云空间 `对话附件/<YYYY-MM-DD>/<uploadId>/<sanitized-name>`，聊天请求只带 `workspaceFileId`；服务端 `readChatAttachmentFile` 只允许读本人 `user` scope 的文件，删除、磁盘丢失、他人文件分别返回 deleted / missing / forbidden；历史消息的 `meta.attachments` 只存文件 ID，打开会话时批量补当前文件状态。真机验证 PDF 与 DOCX 都落到了 `对话附件/2026-11-21/<uploadId>/`，刷新后附件卡仍能回放，数据库里的附件 meta 保留 `workspaceStatus=active`、`parseKind=pdf`、`parsePageCount=2`、`chars=142`。

**新增文档解析**：新建 `chat-attachment-document.ts`，直接复用知识库 `parseKbFile` 解析 PDF 文本层与 DOCX / XLSX / PPTX；`.xlsm` 复用 XLSX 解析。原文件上限 25 MB，单次正文上限 5,000,000 字符，超限只给警告不阻断消息；解析结果按 `fileId + updatedAt + buffer.length` 做 LRU，同一持久附件不重复拆包。`.doc` / `.xls` / `.ppt` 明确要求另存为 OOXML；扫描版 PDF 无文本层时返回 OCR 提示，文件仍可预览。解析失败统一降级为 `text: ''` 加 `parseWarning`，不影响发送。`resolveChatAttachments` 把解析正文注入模型上下文，`buildAttachmentText` 生成“已解析 N 页”标记；前端文件卡显示“已解析 N 页 / 正文已解析 / 未解析正文”。

**真机验收**：上传 2 页 PDF 后提问两个 IP 和一条操作提醒，附件卡显示“已解析 2 页”，模型准确回答交换机 `192.168.1.10`、AP `192.168.1.20` 和“改网络前先备份”；上传 DOCX 后问第二段，附件卡显示“正文已解析”，模型只回答“双文件双Agent并行完成。”。刷新页面后两条附件卡与回答仍在。

定向测试 `chat-attachment-document` 9 个 + `chat-attachment-cloud` 7 个共 16 个通过；全量回归 188 个文件 / 1,131 个用例通过；`pnpm typecheck` 通过。仍未做对象存储、病毒/类型检查、扫描版 PDF 的页面渲染 OCR。

第十一轮把这三项缺口补齐，没有改上传通道，只在入口检查、文档解析和持久化三个点加能力。

**附件类型与病毒检查**：新建 `attachment-security.ts`，入口函数 `inspectChatAttachment` 只对 `对话附件/` 生效，避免把普通云空间业务文件一刀切拦掉。直接拒绝可执行文件、脚本、快捷方式、安装包、压缩包、SVG、HTML 等主动内容；按扩展名校验真实魔数（PDF 必须是 `%PDF-`，PNG/JPEG/GIF/WEBP/BMP/TIFF 校验图片头，旧 Office 校验 OLE 头），DOCX/XLSX/XLSM/PPTX 必须是有 `[Content_Types].xml` 和对应主入口的合法 ZIP；OOXML 限 10,000 个条目、解压总量 128 MB、主结构单文件 32 MB，防压缩炸弹；任何扩展名内容命中 MZ、ELF、Mach-O、Java class、7z、RAR、GZip 都拒绝；文本出现 NUL 字节按二进制伪装拒绝；空文件、无扩展名和 EICAR 标准测试串也拒绝。检查接在浏览器上传 `/api/workspace/files`、内部同步写 `saveUserWorkspaceFile` 和读取 `readChatAttachmentFile` 三处，失败返回 `EabError(EC.VALIDATION)` 和可行动提示，不进入模型上下文。它仍是入口级兜底，不等于 ClamAV/企业病毒库扫描。

**扫描 PDF 页面 OCR**：`chat-attachment-document.ts` 新增可选 `ocrPage` 与 `ocrModelId`，把逐页回调透传给 `parseKbFile`，并把模型 ID 放进缓存键，避免同一文件先按“未配置 OCR”缓存提示后不再重试；解析结果新增 `ocrPageCount`。`routes/chat.ts` 每轮解析前用 `resolveModelForPurpose(db, companyId, 'kb.ocr')` 找视觉模型，找到后对每个扫描页渲染 PNG、调用 `ocrImageWithModel`，把 OCR 页数写进附件 meta，附件卡显示“已解析 N 页 · OCR M 页”。`kb-parsers.ts` 改为单页渲染/OCR 失败只记 `ocrFailures` 和提示块，保留其他文本页；只有整份 PDF 都没有可提取文本时才抛 `OCR_REQUIRED`，带最后一次 OCR 失败原因。混合型 PDF 不会因为一页失败而全文不可读。用白底黑字 JPEG 加手写单页 PDF 生成了无文本层夹具 `scanned-note.pdf`，验证无 OCR 时提示、有 OCR 时能读出 `EAB-2026-11-21` 且回调收到 PNG 头。

**对象存储后端**：`config.ts` 新增可选 `objectStorage`，环境变量 `EAB_S3_ENDPOINT` / `EAB_S3_BUCKET` / `EAB_S3_ACCESS_KEY` / `EAB_S3_SECRET_KEY` / `EAB_S3_REGION` / `EAB_S3_PREFIX` / `EAB_S3_FORCE_PATH_STYLE` / `EAB_S3_REQUIRED`；配了 endpoint 但缺桶或密钥会启动失败，未配 endpoint 完全保持原本地磁盘部署。新建 `object-storage.ts`，不引入 AWS SDK，自己实现 S3 SigV4 的 PUT/GET/DELETE，默认 Path-Style，20 秒超时，对象键为 `<prefix>/chat-attachments/<companyId>/<ownerUserId>/<fileId>`，默认 prefix `eab`。上传 `对话附件/` 文件先写本地再镜像对象存储，响应和审计带 `objectStorage: {driver,bucket,key,status}`；默认 `EAB_S3_REQUIRED=0` 时对象写失败保留本地并标 `failed`，设 `1` 时回滚刚写入的本地内容或恢复旧内容并返回 502，元数据不推进。`readChatAttachmentFile` 本地缺失时按 fileId 从对象存储回源并重建本地缓存；删除单文件/文件夹时异步发对象删除，失败只留孤儿对象，不影响本地软删。当前只覆盖 `对话附件/`，不是整个个人/部门/公司云空间的统一对象存储，非对话附件仍只写本地。`/api/health` 增加 `objectStorage` 摘要，只回 driver/bucket/prefix/required，不回 endpoint 与密钥。

本轮定向测试 5 个文件 / 32 个用例通过：`attachment-security` 7 个、`object-storage` 2 个、`chat-attachment-document` 11 个、`chat-attachment-cloud` 8 个、`workspace-attachment-route` 4 个，另有既有工作区测试未回退。全量回归 191 个文件 / 1,147 个用例通过，`pnpm typecheck` 通过。

**真机验收**：重启服务后 `/api/health` 已返回 `objectStorage: null`（未配置 S3 时保持本地模式）。在工作台上传单页扫描件 `scanned-note.pdf` 并问设备编号和提示语，附件 meta 写入 `parseKind=pdf`、`parsePageCount=1`、`parseOcrPageCount=1`、`chars=84`，模型准确回答 `EAB-2026-11-21` 与 `PLEASE ENTER INSPECTION RESULT`；刷新页面后附件卡显示“已解析 1 页 · OCR 1 页”，历史可回放。EICAR、MZ 改名 PDF 与 `EAB_S3_REQUIRED=1` 回滚由 `workspace-attachment-route` 四个路由用例覆盖，真实浏览器上传 EICAR 时页面停在等待态，未拿到可视提示，最终以路由用例和数据库/磁盘无留痕作为拦截证据。

仍有限制：真实 MinIO/S3 未接入验证，虚拟主机模式代码存在但未测试，对象删除是 fire-and-forget；病毒检查不含外部杀毒引擎；扫描 PDF 逐页串行调用视觉模型，未设总超时或页数上限，多页耗时与成本未验证。

#### 11.3.3 对话引用的可靠性兜底（已实现）

**问题**：对话引用只给摘要时，模型会把摘要里的相近字段当成答案。实测把一段 24 条消息的旧对话拖进新会话，问“内部代号是什么”，摘要最近 8 条只有“接口编号 ZX-88421”，真正答案 `ORION-731` 在第 6 条。模型直接答 `ZX-88421`，没有调用 `conversation_read`；在系统提示里加“摘要没有逐字出现就必须先读整段”的硬规则后，同一问句仍未触发工具。结论：提示词只能约束表达，不能保证工具行为，必须有服务端兜底。

**实现分层**：

1. **整段关键词检索**：`conversation_read` 带 `query` 时，先对整段对话逐条做原词 `LIKE` 匹配，不再只扫最近 50 条；无命中才回退到最近 50 条分词评分。这样第 6 条这类早期细节也能被读到。
2. **细节问题预读**：触发条件收紧为“出现具体字段词（编号/代号/字段/文件名/金额/日期/结论/原话/负责人/地址/电话/参数/状态/口径等）、出现‘的 X 是什么/是多少/什么时候’这类具体值问法，或问题里有引号原词”；“这个对话讲什么”“有多少条消息”这类泛问题不再预读。命中后且引用对话超过最近 8 条时，服务端从问题抽取检索词，对整段对话做 OR 匹配。
3. **预读边界**：最多处理 2 个引用对话；每个最多 4 条原文、每条最多 1,500 字、合计最多 3,000 字；读取前用 `loadSession` 校验 `company_id + user_id + deleted_at`，只能读本人对话。
4. **分页读取**：`conversation_read` 新增 `offset`。不传 `query` 时从最新一条往前跳过 `offset` 条，返回 `totalMessages`、`nextOffset`、`hasMore`，可逐页读取长对话；带 `query` 时按整段匹配和相关性排序，不做翻页，命中过多时改用更精确的 query。
5. **注入方式**：预读原文放进系统提示的参考对话块，标记为“按本轮问题预读的原文｜不是摘要”，并规定“优先用原文回答，未覆盖字段再调用 conversation_read”；摘要仍保留，用于交代对话全貌。
6. **可观测**：`meta.contextBudget.conversationReferences.detailChars` 记录预读原文长度；为 0 表示本轮没有触发预读。

**真机结果（2026-11-20）**：

| 会话 | 回答 | 是否调用 conversation_read | detailChars | 单次 prompt |
|---|---|---|---|---|
| 硬规则后仍失败 | `ZX-88421` | 否 | 无 | 13,604 tokens |
| 服务端预读后 | `ORION-731` | 否 | 83 | 13,747 tokens |

两次只差约 143 tokens，预读成本可控。预读是“按需读原文”的可靠兜底，不依赖模型主动调用工具；`conversation_read` 仍保留给预读未覆盖的追问。

**渠道一致性**：钉钉通道改用同一套紧凑技能目录（`skillCatalogTexts`），不再每轮注入单技能 6,000 字、总量 20,000 字的完整技能正文；完整步骤由 `runAgentTurn` 注入的 `skill_load` 按需加载。

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

> **当前实现（2026-11-24）**：代码里的 `ToolDef` 已补 `risk / approval` 两个字段，
> 并由 `tool-approval.ts` 统一推导风险与审批策略；`dataEffect / audit / timeoutMs / resourceHints`
> 仍是设计目标，没有逐工具落字段。高危二次确认已覆盖 `project.exec / project.job(kill) /
> workspace.delete / workspace.send_dingtalk / admin.password.reset / office.rewrite /
> office.format / office.versions(restore) / workspace.rename`，审批与工具参数哈希绑定且只能核销一次。
> `project.exec` 已有命令危险模式拦截、cwd 限定、环境清洗；AGT-05b 新增 `EAB_PROJECT_EXEC=strict`
> 的 Docker / bwrap OS 沙箱、`--network none` / `--unshare-net` 断网、只读根文件系统、能力降级、
> 资源限制和逐行命令白名单。strict 没有可用后端时 fail-closed，不回落 local；本机当前没有 Docker/bwrap，
> 因此真实容器执行验收待安装后端。控制台「工具 → 调用规则」会显示当前 mode / backend / network 和白名单状态，
> strict 未就绪时明确标记。见 `docs/EAB-P0-项目命令OS沙箱v1-2026-11-24.md`。

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
  purpose: 'chat.default' | 'chat.vision' | 'router.intent' | 'agent.model_choice'
    | 'kb.embed' | 'kb.clean' | 'kb.ocr' | 'kb.rerank'
    | 'asr.default' | 'tts.default' | 'image.default' | 'video.analyze'
  modelId: string
}
```

**四层口径**：Provider（端点 + 协议 + 密钥引用）→ Model（能力声明）→ ModelRoute（用途 → 模型）→ Adapter（按 `endpoint_kind` 分发）。`tags` 继续用于界面展示，运行时读 `capabilities`，缺省从 `tags` 回填，旧模型不失效。

- **能力与端点**：13 项能力（含 `embedding` / `rerank` / `audio` / `video`）与 8 种端点类型 `chat / systemone / embeddings / rerank / asr / tts / image / video`。
- **适配器现状**：`chat`（OpenAI 兼容 SSE + Anthropic / Gemini / Azure）、`systemone`（结构化决策）、`embeddings`（OpenAI 兼容 / Azure / Gemini）、`rerank`（Cohere/Jina/SiliconFlow/vLLM/TEI 形态）、`asr`、`tts`、`image`（OpenAI 兼容 `/images/generations`）已实现；`video` 只留端点类型与调用位，尚未实现调用。
- **路由规则**（按优先级）：显式 `model_routes` > 能力 + 优先级自动挑 > 返回 `null`（调用方降级，不报错）。**例外**：`chat.default` 未绑定时走 12.7.3 的真实回复速度自动选模，无速度样本才回到能力 + 优先级。
- **绑定校验**：向量用途只认 `embedding` / `endpoint_kind=embeddings`；重排只认 `endpoint_kind=rerank`；ASR/TTS 只认 `asr` / `tts`；图片生成只认 `endpoint_kind=image`，避免音频/对话模型被误当转写或出图模型。
- **数据类任务白名单**：数据问题不只要求“模型在线”，还要求该模型在 `model_task_verifications` 里对 `data.qa` 有“通过且未过期”的实测记录。没有白名单时明确降级提示；显式选了未实测模型直接 400；子 Agent / 任务图 / 后台恢复轮走失败关闭（AGT-18）。
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

- **导入时按名称推断**：`inferModelProfile()` 用 `rerank / embedding / whisper / tts / image / video / vision / router` 等特征给出建议类型、能力、端点与接口路径，并标 `high / medium / low` 置信度；导入弹窗逐条显示，允许改成正确类型再写入。
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
| 图片生成 | `POST /images/generations` | `{model, prompt, n, size?}` | `data[{b64_json \| url}]` |
| 视频理解 | `POST /video/analyze`（EAB 自定义管线） | `{model, frames[], prompt}` | `{text}` |

> 注意：OpenAI 官方、Anthropic、Gemini、Azure OpenAI 都没有标准 rerank 接口；把它们的对话模型标成 `rerank` 会在调用时得到明确的“没有 /rerank”错误，而不是静默返回空结果。

**决策 / 语音 / 图片（已实现调用）与视频（仍留位）**：

| 链路 | 用途 | 口径 |
|---|---|---|
| 决策模型 | `router.intent / agent.model_choice` | 温度 0、超时 3–5s、JSON + schema、失败重试 1 次、规则兜底；未配置保持现状 |
| 语音 | `asr.default / tts.default` | 入站 ASR、出站 TTS 两条独立链路；长音频走 `ai_jobs`；V1 不做实时双向语音 |
| 图片生成 | `image.default` | 独立内容接口 `POST /api/content/images` 与内置工具 `content.generate_image`；生成后存个人云空间，不进对话上下文 |
| 视频 | `video.analyze` | **仅端点与用途位**：临时存储 → ffmpeg 探参数 → 抽关键帧 → 音轨 ASR → 视觉描述 → 文本汇总 → 结果落 `ai_jobs.result_json`，运行时调用尚未实现 |

**已落地控制台接口**：`GET /api/console/model-routes` 返回 12 个用途的绑定与当前生效模型（`source: route | fallback | none`）；`PUT /api/console/model-routes/:purpose` 绑定/解绑，能力不匹配返回 400，且校验失败不清掉原绑定。`GET /api/console/providers/:id/models` 的每个模型带 `suggested{modelType,label,capabilities,endpointKind,confidence,basis,api}`；`POST .../models/import` 接受 `models: [{modelKey, capabilities, endpointKind}]`，把推断结果或人工改写的类型直接写入 `models.capabilities / endpoint_kind`。模型列表不再返回任务实测白名单字段。


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
| 工作记忆 | 当前会话摘要 + 最近 8 条原文 + 同会话 FTS5 旧消息 | 自动 | 本会话 |
| 语义画像 | 已确认的结构化事实，按 `fact_key` 生成画像卡 | 个人高置信事实自动生效；团队事实管理员确认 | 本人 / 本部门 / 全公司 |
| 情景记忆 | 带时间和事件语义的 `episode`，按半衰期衰减召回；支持聚类合并与归档 | 个人高置信情景仍待确认；已确认情景由维护任务整理 | 本人 / 本部门 / 全公司 |
| 程序记忆 | `preference` / `decision`，稳定偏好与做事口径 | 个人高置信偏好/决策自动生效；团队规则管理员确认 | 本人 / 本部门 / 全公司 |

**红线**：
- 团队/公司记忆必须经过管理员确认，模型不能静默改写共享上下文；
- 个人范围只允许自动生效 `fact / preference / decision`，且必须无冲突、达到置信度门槛（事实 ≥ 0.85，偏好/决策 ≥ 0.8）；
- 与旧记忆冲突、低置信、情景类候选仍停在待确认区，由本人决定替换或丢弃；
- 自动候选只落个人范围，`dept / company` 永远不自动写入。

**结构化事实（2026-11-24 落地）**：

- `memories` 增加 `subject / predicate / object_text / fact_key / confidence / source_message_id / valid_from / valid_to / importance / sensitivity / extraction_source` 等槽位；旧自由文本仍兼容。
- 同一 `fact_key` 在同一范围只保留一条有效事实。确认新值时旧记录写 `valid_to` 失效但不软删除，保留审计血缘。
- 画像卡最多 12 条事实、约 900 字；同一键按“个人 > 部门 > 公司”优先，只注入已确认、未过期、非敏感事实。
- 删除记忆同时写 `deleted_at` 与 `valid_to`，并清空向量，避免删除后仍被语义召回。
- 自动抽取默认 `rules`，可用 `EAB_MEMORY_AUTO_EXTRACT=off|rules|llm` 控制；含凭证、手机号、身份证等内容的文本整轮跳过。
- 自动生效默认开启，`EAB_MEMORY_AUTO_CONFIRM=off` 可退回全影子模式；只对个人 `fact / preference / decision` 生效，团队记忆始终走管理员确认。

**记忆维护与召回解释（2026-11-24 D 阶段落地）**：

- 情景聚类：同一范围、最近 60 天、相邻不超过 7 天、相似度 ≥ 0.55 的已确认情景合成 1 条 `consolidated` 合集；原始条目写 `archived_at` 保留审计，不再召回。
- 旧情景归档：超过 120 天且 `recall_count=0` 的情景自动归档，仍可在“已归档”页签查看。
- 调度：worker 首跑延迟 1 分钟，之后每 6 小时检查；20 小时内防重，管理员可手动 `POST /api/memories/maintenance/run`。
- 召回解释：每条命中记录 `score / relevance / vectorScore / keywordHits / reasons`；回答上方显示“长期记忆 · 想起了 N 条”，展开可见词面命中、语义相近、范围、时间权重和重要性。
- 召回计数：命中后写 `recall_count += 1` 与 `last_recalled_at`，用于识别真正被用过的记忆，而不是只看创建时间。

**全入口抽取与质量统计（2026-11-24 E 阶段落地）**：

- 网页、钉钉、飞书回复落库后统一调用 `extractMemoryShadow`，分别标记 `channel=web / dingtalk / feishu`；三个入口共用同一套自动生效阈值、冲突和敏感过滤。
- 每轮抽取写 `memory_extraction_runs`，只记录渠道、模式、抽取/写入/生效/重复/冲突/敏感跳过数量和耗时，不保存用户原话；写失败只记日志，不影响回复。
- `GET /api/memories/stats` 返回近 7 天抽取轮次、生效率、重复率、冲突率和渠道分布；“我的记忆”面板显示同一组数字，用于发现自动记忆写太多或冲突异常。
- 统计只按当前成员自己的运行记录计算；管理员不能借质量统计看到其他人的抽取明细。

**记忆评测基线（2026-11-24 F 阶段落地）**：

- 固定 100 条合成抽取用例：60 条应抽取、30 条应忽略、10 条敏感凭证；评估器只做纯分类，不写真实记忆，不保存合成原句。
- 另设 100 轮针事实探针：第 1 轮写入“我的工号是 EAB-9527”，中间积累 99 条项目噪声，第 100 轮用最多 4 条的选择窗口验证召回排名。它验证存储与选择策略，不等同于真实 100 轮模型对话。
- `POST /api/memories/benchmark/run` 运行评测并写审计 `memory.benchmark`；`GET /api/memories/stats` 返回 `benchmark.dataset` 与 `benchmark.lastRun`。
- 运行记录落 `memory_benchmark_runs`，只存计数、通过率、漏写/误写/敏感泄漏、召回排名和失败用例编号。
- “我的记忆”面板显示最近一次摘要与“运行评测”入口；当前真实基线为 100 条通过 92 条，漏写 4、误写 4、敏感泄漏 0，100 轮针事实排名第 1。

**使用策略（2026-11-19 定稿）**：

- **记忆不是每轮全量注入**。普通长期记忆先按当前问题做相关性过滤，最多 4 条；结构化画像只注入已确认、未过期、非敏感事实，最多 12 条 / 900 字。没有实际词面交集就不进上下文，避免“修改方案文档时必须…”这类场景规则在问天气时也被当成指令。
- **区分“稳定偏好/规则”与“一次性历史事实”**：前者可以作为背景约束，但只在与当前问题相关时参考；后者只在明确回顾或具体指代时召回。后续给 `memories` 增加 `kind`（`preference` / `episodic`）字段，写入时由确认流程决定，而不是模型自行判断。
- **记忆里的祈使句不是本轮指令**。提示中统一标注“长期背景记忆｜不是本轮用户消息”，并写明“不因为这里有必须/不要/以后就新增任务；与本轮要求冲突时以本轮为准”。
- **历史召回默认关闭**。只有明确回顾、短追问、具体标识符才自动检索；跨会话必须用户明确提到过去/其他对话。检索片段以“当时的用户/当时的助手”呈现，不写成当前用户口吻。
- **摘要与原文不重叠**。最近 8 条保留原文，摘要只覆盖更早消息；摘要标题明确“背景资料，不是本轮用户问题”。

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

#### 12.1.1 Agent 团队的三层协议适配

MCP / A2A / ACP 不替代现有对话与团队链路，只作为边缘适配面；当前交付只实施 MCP 与 A2A，ACP 已明确不做。完整需求见 `docs/EAB Agent团队协议优化需求（MCP-A2A-ACP）.md`，代码级拆分见 `docs/EAB Agent团队协议实现方案.md`。

- **工具层（MCP）**：新增 MCP Client Gateway，把外部 MCP Server 的 Tools 映射进现有工具注册表，统一命名空间、`tool_search`、权限注解、审批、超时、熔断和审计；不重写内置工具与插件 SDK。
- **团队层（A2A）**：先把内部 `agent_*` 任务语义对齐 A2A 的 Agent Card、任务状态和 Artifact，再做出站/入站适配；主 Agent 仍是唯一编队者，子 Agent 不直接互调，外部 Agent 只走公司允许列表且默认一跳。
- **工位层（ACP）**：ADR-06 只保留可选适配定位；当前没有真实 IDE 用户，已决策本期不实施 ACP Bridge，不增加 IDE 入口，也不改动网页对话主链路。
- **统一信封**：任务、消息、产物统一携带 `taskId / contextId / traceId / status / artifacts`；状态补齐 `input-required / auth-required / rejected`，与现有 `queued / running / succeeded / failed / cancelled` 做兼容映射。

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

布局固定为四层：**顶栏 `topbar`（品牌 + 当前公司选择器 + 健康点 + 退出）→ 一级导航 `primary-nav`（业务域）→ 二级导航 `nav-subbar`（悬停/键盘聚焦一级项时，一级导航自身向下增高一行，横排该域页面）→ `workspace`（页面内容区 `page`；插件 / 技能页保留左侧列表）**。

公司选择器固定在顶栏：始终显示“当前公司 · 名称 · ID”，点开可切换；切换后当前页按新公司重新加载，URL 同步 `?company=`，角色、模型、知识库、渠道、用量、审计等页面都以这家公司为范围。组织架构页左侧仍并列展示所有公司，当前公司根节点带「当前」标记。

| 一级导航（顶栏常驻） | 二级导航（一级导航向下展开一行，横排） | 页面内容 / 左栏 | 谁能看 |
|---|---|---|---|
| 概览 | — | 当前身份（姓名/部门/数据范围/渠道）+ 快捷进入 | 全部登录身份 |
| 组织与权限 | 成员管理 / 部门管理 / 角色管理 / 权限审批 | 成员管理=成员表、成员资料、角色授权与后台访问配置；部门管理=部门树与负责人；角色管理=角色与成员配置；权限审批=审批链。页面可见即可使用该页全部功能 | 页面可见权限 |
| 知识与模型 | 知识库 / 模型接入 / 工具 | 知识库=库列表与文档；模型接入=供应商与模型；工具=工具表。页面可见即可使用该页全部功能 | 页面可见权限 |
| 连接与平台 | 渠道 / 数据连接 / 在线文档 / 公司设置 | 渠道=绑定与同步；数据连接=数据库与缓存/向量库；在线文档=OnlyOffice；公司设置=身份与品牌。页面可见即可使用该页全部功能 | 页面可见权限 |
| 插件管理 | —（单页） | 左侧插件清单 + 右侧插件详情 / 安装与启停。页面可见即可使用该页全部功能 | 页面可见权限 |
| 技能管理 | —（单页） | 左侧技能清单 + 右侧技能详情。页面可见即可使用该页全部功能 | 页面可见权限 |
| 运营与审计 | 用量 / 额度 / 审计 / 任务中心 / 审批 | 用量=按天/按人；额度=配额；审计=哈希链校验；任务中心=后台任务；审批=待办与决定。页面可见即可使用该页全部功能 | 页面可见权限 |
| 系统 | 运行与准入 / 并发与队列 / Agent 管理 / 后台作业 / 启动动画 / 系统与运维 / 系统更新 | 运行状态与安全边界；并发与队列；Agent 运行树与工具轨迹；后台作业；启动片源；目录、日志、备份与系统设置；版本检测、发布说明与一键更新。每个系统二级页只配置可见，可见即可使用该页全部功能 | 页面可见权限 |

硬约束：

1. **一级导航只按业务域**，同一业务域的页面放进二级行，不把表名当一级项；插件 / 技能是独立一级项，各只有一个页面，因此没有二级行；**「系统」是一级业务域，运行与准入、并发与队列、Agent 管理、后台作业、启动动画、系统与运维、系统更新是它的二级行；每个二级页只登记一个「可见」权限，可见即可使用该二级页的全部功能，不再拆「检查更新 / 一键更新」等动作**。
2. **二级导航不是浮动卡片、也不是卡片块**：鼠标移入或键盘聚焦一级项后，`#topnav` 自身高度从 58px 动画增高，第二行 `.nav-subbar` 横排该域页面；二级项只用与一级导航一致的文字标签（同字号、同字重、透明底、当前页品牌色 + 2px 底边），不再显示说明文字。点击一级项可固定当前二级行，再次点击同一项取消固定；固定后鼠标移入其他一级项仍临时显示该域二级页面，移开后回落到固定项。点击二级项、点击导航外、Esc、滚动或缩放窗口按固定状态处理：未固定时收起，固定时保持。二级行展开会把内容区整体下移，不覆盖页面。
3. **子导航只属于当前页**，不做全站常驻的部门树 —— 知识库页左边挂组织树会让人以为库是按部门筛的。部门树只出现在「部门管理」页；知识库的左栏是**库列表**。普通业务域为单列内容区；「插件管理」「技能管理」保留左侧清单，因为它属于页面内容。
4. **选中态唯一**：一级是 `.nav-primary.is-active`（展开时再加 `.is-menu-open`），二级是唯一的 `.nav-sub-link.is-active`，页面左栏是唯一的 `.side-item.is-active`，不能出现“两个都亮”。

5. **公司上下文始终可见**：顶栏选择器不能隐藏；页面内不再重复放公司下拉。切公司只改范围，不改变控制台操作员身份。
6. **数字必须自洽**：子导航里的「N 人」和点进去内容区的行数同一口径 —— 服务端 `subtreeMemberCount` 按成员 `dept_path` 前缀统计（**含下级**），不能用各部门直属人数相加，否则上游回收过部门后会少数。
7. **后台权限只登记页面可见**：页面注册表以服务端 `CONSOLE_PAGES` 与 `CONSOLE_DOMAINS` 为唯一事实来源，系统二级页登记在 `CONSOLE_PAGE_SECTIONS`；角色和成员「后台权限」每个页面只显示一个「可见」复选框，不再显示新增 / 编辑 / 删除 / 检查更新 / 一键更新等动作。页面可见即拥有该页全部功能：后端接口守卫只校验页面或二级页可见，权限翻译按可见页授予该页所需全部 scope，现有动作列仅作为旧数据兼容保留、不再参与判断。成员管理页可见即可新增/编辑/删除成员、分配角色、配置成员后台访问；系统更新页可见即可查看版本、检查更新和一键更新。平台全局操作（创建公司、修改平台超管密码等）仍保持平台专属，不属于任何页面功能。新增页面默认不自动授权；若拆分旧页面权限且需要保留存量访问，必须同时提供一次性回填迁移，并为前端二级导航与服务端注册表增加一致性测试。

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

**原语（只允许用这些组合页面）**：`.btn`（primary / ghost / danger / sm）、`.stat`（数字 + 标签）、`.pill`（状态徽标）、`.table`（粘性表头）、`.kv`（键值对，`.kv.single` 单列）、`.empty`（空态 + 下一步动作）、`.banner`（info/warn/danger）、`.modal`、`.checklist`（勾选式要点）、**`.topbar` + `.company-picker` + `.primary-nav` + `.topnav-row` + `.nav-primary` + `.nav-subbar` + `.nav-subbar-inner` + `.nav-sub-link`**（顶栏公司选择与导航自身展开的横排纯文字二级导航）、**`.subnav` + `.side-list` + `.side-item`（`.is-active`）**（插件 / 技能页左栏）、`.split`（左右两栏）。

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
| 自动模式 | 在**对话端点**里按真实回答的「首字延迟 + 生成 tok/s」综合耗时升序，速度优先于优先级与工具能力；没有任何实测样本时才回落到工具模型 / 最近成功模型 / `priority` | `/api/chat/messages`、`/api/chat/models`、钉钉自动回复 |
| 越权选择 | 手动指定一个自己无权用的模型 → 403，且区分"模型不存在"和"存在但无权"（后者不能让用户以为模型被删了） | 同上 |

这条"两层过滤"是刻意的：**功能权限**决定"能不能用模型这件事"，**模型可见角色**决定"能用哪几个"。只做前者会把所有模型暴露给所有人；只做后者会让没有对话权限的账号也能调接口。

**自动模式按真实速度选模（不是优先级）**：每次回答已经写入 `chat_messages.meta_json.timing` 与 `.tokens`，自动选模直接复用这些真实样本，不再额外探测上游：

- **回复速度**：首字延迟 `timing.ttftMs`，取最近样本中位数；越小越快。
- **生成速度**：`tokens.completion / (timing.genMs / 1000)`，取中位数；上游没有返回 usage（例如 Qwen3.8 的 `completion=0`）时，用正文 + 推理文本估算 token，避免把这类模型误判成 0 tok/s。
- **综合排序**：`预计回复耗时 = ttftMs + 256 / tokensPerSecond × 1000`，按升序选第一个；同时兼顾"多久看到第一个字"和"每秒吐多少 token"。
- **样本窗口**：每个模型最近 20 条真实回答、最近 30 天；按模型分别取样，避免高频模型把其他模型挤出统计。
- **候选边界**：只考虑 `endpointKind='chat'`，图片消息再叠加 `vision` 硬能力；普通文本消息按用户要求**速度优先于工具能力**。没有速度样本时才回到"工具模型优先"的冷启动兜底。
- **兜底**：没有任何实测样本、全部样本过期或读取失败时，保持原来的最近成功模型 / `priority` 顺序，冷启动不会选不出模型。
- **不变的部分**：用户手动指定模型、`/model` 切换、`chat.default` / `chat.vision` 用途路由仍然优先；**Agent 团队仍由 `agent.model_choice` 的 SystemOne 决策模型分配**，不按速度改；`chooseSubAgentModel` 的能力 / 负载 / 父模型兜底逻辑保持原样。

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
3. **"自动选模型"依据什么？** 已按用户要求改为**真实速度优先**：`timing.ttftMs`（回复速度）+ `tokens.completion / genMs`（生成 token 速度）综合排序，不再按 `priority`；没有样本才回退原顺序。手动覆盖和 Agent 团队决策不变（12.7.3）。

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
2. **入口不混用，而且分端口。** 员工端口 `8787` 的 `/` 302 到 `/chat`，`/admin`、`/app.js`、`/app.css`、`/api/console` 一律 404；管理端口 `8788` 的 `/` 302 到 `/admin`，`/chat`、`/chat.html`、`/chat.js`、`/chat.css`、`/api/chat`、`/api/auth` 等员工面一律 404。`/admin` 没会话只出统一登录页（钉钉扫码或账号密码），成员登录后只看到被授权的后台页面；员工侧导航里没有"管理控制台"。控制台登录后同一个浏览器再开员工端口，仍然是员工身份（控制台请求必须显式带 `x-eab-console: 1`，员工接口不带）。
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

**思考档位按模型真实能力配置（对齐 DSH `reasoning.efforts`）**：模型 `config_json.thinking` 不再写死「精简 / 均衡 / 深思」，而是保存完整选项对象：

```json
{
  "thinking": {
    "enabled": true,
    "strategy": "effort",
    "defaultEffort": "balanced",
    "options": [
      { "id": "light", "label": "精简", "hint": "更少思考，更快回答。", "wire": "low" },
      { "id": "balanced", "label": "均衡", "hint": "平衡速度与推理深度。", "wire": "medium" },
      { "id": "deep", "label": "深思", "hint": "模型最高推理档。", "wire": "xhigh" }
    ]
  }
}
```

- `options` 最多 8 个，保持管理员自定义顺序；每项支持自定义 `id`、`label`、`hint`，以及二选一的下发方式：
  - `strategy: "effort"`：`wire` 是真正发给 OpenAI 兼容端点的 `reasoning_effort` 线值（`none/minimal/low/medium/high/xhigh/max`）；留空时按内置 ID 兜底。插件模型仍收选项 `id`，不强制改插件协议。
  - `strategy: "budget"`：`budget` 是该档位的 `max_tokens` 上限，`null` 表示不限制。
- 控制台模型弹窗提供「常用预设」（Qwen3.8 `low/medium/xhigh`、OpenAI `minimal/low/medium/high`、输出预算三档），套用后仍可逐行增删、改 ID/显示名/说明/上游值/输出预算，并单选默认档。
- 员工端只消费 `id/label/hint` 渲染菜单；服务端 `thinkingCallPlan` 把选中档位解析成 `effort`（插件用）与 `wireEffort`（OpenAI 用），再交给 `callModelStream` 下发。这样「深思」在 Qwen3.8 上可以显式发 `xhigh`，不再依赖 vLLM 把 `high` 兜底成默认档。

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
| `uninstalled` | 控制台「卸载…」 | 解除当前公司的 `plugin_company_installs`；`plugin_states` 只清当前公司；目录只在**最后一家公司/员工卸载时**直接删除，不保留回收站 | 当前公司列表消失；其他公司不受影响，审计里留痕 |

**别家公司已安装的插件不会进入当前公司的列表**：`loadPlugins(db, companyId)` 先按 `plugin_company_installs` 过滤，再叠加本公司的 `plugin_states`；同一份代码目录可以被多家公司共用，但安装归属、启停、卸载和生命周期记录各自独立。

安装动作的入口（`installPluginPackage` / `installPluginFromNpm` / `installPluginFromGithub`）：

1. **解析来源**：本地目录直接校验；npm 先取 `GET {registry}/<encoded-package>` 元数据、读 `dist-tags` 与 `versions[x].dist.tarball`、下载 tarball；GitHub 先按 `owner/repo` 取默认分支（失败回落 `main`，再试 `master`），从 `codeload` 下载 `tar.gz`；
2. **安全解包**：下载只允许 https（本机 `localhost` 例外），拒绝带账号密码/hash 的 registry；`tar -tzf` 逐条拒绝绝对路径、盘符、`..`、反斜杠；解压后 `lstat` 拒绝符号链接；不限制文件数与包体积；registry JSON 8MB；
3. **找插件根与 id**：本地目录根上找 `plugin.json`；npm 包找唯一 `plugin.json`；GitHub 在根目录向下最多 2 层找，或按用户填的「仓库内子目录」精确定位；`manifestIdOf()` 从清单读出 `id`，并以它作为 `plugins/<id>` 的目标目录名（npm scoped 包名、仓库名都不再要求等于 id）；
4. 安装只做清单、路径与符号链接健康检查，不再按文件数/体积拒绝；浏览器上传仍受平台请求体预算约束；
5. 先解析来源清单（不合法直接拒绝）；
6. 复制到 `plugins/.staging-<id>-<timestamp>`，**在暂存区再校验一次**；
7. 目标目录已存在时按归属处理：**当前公司已安装** → 必须显式「覆盖」才能更新，且有其他公司在用时拒绝单独覆盖；**当前公司没装、别家公司已装** → 指纹相同就只登记本公司的安装归属、不动物理目录，指纹不同则报冲突；**磁盘上没人认领** → 指纹相同直接认领，不同则拒绝；
8. 写 `plugin_installs`（版本、来源、来源路径/`sourceRef`、指纹、安装人、安装时间、更新时间）与 `plugin_company_installs`（公司 + 安装人 + 本公司安装/更新时间）；
9. 写 `plugin_events` 一条带 `company_id` 的 `install` 或 `update`；
10. 任一步失败：清掉暂存区和临时解包目录；如果旧目录已移走且新目录没落地，自动把旧目录移回来。

`source` 取值：`local-dir` / `npm` / `github`（磁盘发现为 `disk`）。`sourceRef` 形如 `npm:eab-plugin-x@1.2.0?registry=https%3A%2F%2Fregistry.npmmirror.com`、`github:owner/repo#main?dir=packages/plugin`。**npm 与 GitHub 只取包内容，不执行 `npm install`、`prepare`、仓库脚本或源码构建。**

卸载动作（`uninstallPluginPackage`）：校验 id → 校验当前公司是否安装（别家公司安装时拒绝）→ 只清当前公司的 `plugin_states` → 当前公司的 `plugin_company_installs.removed_at` 记时间 → 写 `uninstall` 事件 → **没有其他公司/员工还在使用时**直接删除目录并把 `plugin_installs.removed_at` 记时间。不保留回收站副本。

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
| POST | `/api/console/plugins/:id/uninstall` | 仅控制台会话 | 只解除当前公司的安装与启停；还有别家公司/员工使用则保留共享目录，最后一个归属人卸载时直接删除并记审计 |
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
- 安装面板：插件根目录、不限安装包文件数/体积（浏览器上传受平台请求体预算）、`安装插件…`（三来源 Tab：本地目录 / npm 与国内镜像 / GitHub）、`重新扫描`；
- 已安装 / 已发现卡片：状态 pill、作者与许可、关键词、安装来源、安装记录、清单指纹、声明权限、贡献页面；操作 = `打开「页面」` / `停用（本司）` / `启用（本司）` / `更新…` / `卸载…`；
- 插件源卡片：未装 / 已装 / 可更新，一键把 sourcePath 带进安装弹窗；
- 生命周期记录表：时间 / 插件 / 动作 / 操作人 / 公司 / 详情；
- 左侧子导航：已安装列表、插件源列表、生命周期说明；安装来源与服务器路径**只在控制台出现**。

随仓库带演示插件 `plugins/eab-plugin-oncall`（值班表）：声明 `org:member:read`，页面通过 `/api/org/members` 取组织成员、按部门排 7 天班——证明插件真能读基座数据，而不是空壳卡片。如果它已被卸载，目录会被直接删除，需要时用安装弹窗的「本地目录」重新装回。

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
- `pnpm test` 当前全量通过；具体文件/用例数以 20.2.2 与 AGT-20 交付文档为准（12.9 首次落地时为 166 条）；
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
| provider / config_json | 兼容保留；实际向量后端用 `vector_backend(local/qdrant/pgvector)` + `vector_connection_id` + `pipeline_config_json` |
| clean_mode / clean_model_id / ocr_model_id | 规则/模型清洗、OCR 模型；`auto` 无模型退回规则 |
| chunk_size / chunk_overlap / rerank_enabled / rerank_model_id | 切片与重排配置 |
| owner_dept_path / created_by | |
| status / created_at / updated_at / deleted_at | |

**kb_docs**

| 字段 | 说明 |
|---|---|
| id PK, company_id, collection_id IDX | 所属知识库（可见性继承） |
| title / source_type / source_uri | source_uri 经 Resolver 存相对路径 |
| original_path | 服务端生成的原始文件相对路径，不使用用户文件名 |
| raw_text / clean_text | 解析原文与清洗结果（详细块在 sidecar） |
| mime / size_bytes / page_count | |
| checksum / content_hash | 幂等键（同文档同内容不重复入库） |
| parse_meta_json | 页数、工作表、标题树、OCR 页数、解析器版本 |
| dept_path / scope_type / scope_id / owner_user_id | 管理范围（写/删用，不参与读可见性判定） |
| classification | `public` / `internal` / `confidential`（**NOT NULL，默认 internal**） |
| status | pending / indexing / indexed / failed / deleted（粗粒度投影） |
| pipeline_stage / pipeline_error | `uploaded…indexed / failed / needs_config`，页面以此为准 |
| clean_mode / clean_model_id / ocr_model_id / version | 本篇实际使用的清洗、OCR 模型与重跑版本 |
| chunk_count / error / index_error / indexed_at / index_model_id | 入库进度、失败原因与索引模型 |
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
| heading / page_no / meta_json | 标题路径、页码、工作表/行范围等结构元数据 |
| char_count / content_hash | 字符数与幂等哈希 |
| created_at | |

索引：`(company_id, collection_id)`、`(doc_id, ordinal)`。

**kb_chunk_embeddings**：`(chunk_id, model_id) PK, company_id, collection_id, doc_id, dim, vector BLOB, norm, created_at` —— 本地权威向量旁表；复合主键允许同一 chunk 存多个 embedding 模型，供模型对比与切换。外部 Qdrant / pgvector 只做镜像，检索结果必须回本地校验。

**kb_ingest_jobs**：`id, company_id, collection_id, doc_id, stage(parse/clean/chunk/index), status, attempts, locked_at, heartbeat_at, locked_by, error, meta_json, created_at, updated_at` —— 知识库全流程任务表（进程内 worker + 表驱动队列，不依赖 Redis）；`kb_index_jobs` 保留为向量子任务，页面以 `kb_docs.pipeline_stage` 为准。

**kb_test_cases**：`id, company_id, collection_id, name, query, expect_doc_ids, expect_chunk_ids, tags, enabled, created_by, created_at, updated_at, deleted_at` —— 召回测试用例。

**kb_test_runs**：`id, company_id, collection_id, case_id, query, config_json, result_json, hit_count, top1_hit, recall_at_k, mrr, latency_ms, model_label, created_at, expires_at` —— 测试记录；按公司保留天数（默认 30 天）每日硬删，只留审计摘要。

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

#### 18.1.1 已落地目录（2026-11-24 实况）

```
eab/
├── package.json / pnpm-workspace.yaml / tsconfig.json / vitest.config.ts
├── EAB企业智能体基座-总体架构方案.md
├── packages/
│   ├── domain/ authz/ workspace/ storage/ channel/   # 6 个 workspace 包
│   │   # storage/migrations：0001~0100 共 100 个 SQL 迁移
│   ├── channel/                                       # 组织同步内核 + 飞书/钉钉/企微 provider + mock
│   └── server/                                        # Fastify 装配 + 全部 HTTP 路由 + 内嵌控制台
│       ├── src/{app,config,deps,http,main,session,...}.ts
│       ├── src/agent-*.ts                             # Agent 运行时、团队、计划、产物、验收、复杂度门禁
│       ├── src/kb-*.ts                                # 解析、切片、清洗、OCR、向量、混合召回、评测
│       ├── src/plugin-*.ts / plugins.ts               # 插件扫描、清单校验、scope、工具适配
│       ├── src/{llm,model-registry,model-health,model-speed}.ts
│       ├── src/routes/*.ts                            # 28 个路由模块
│       └── public/{index.html,app.js,app.css,chat.html,chat.js,chat.css,...}
├── plugins/catalog.json + plugins/eab-plugin-oncall/  # 本地插件源与演示插件
├── scripts/{smoke-http,smoke-platform,eab,eab-update,eval-agent,eval-kb,perf,...}.mjs
├── docs/                                              # 审计、交付、专项方案
└── .eab-dev/                                          # 本地演示库、日志、管理员凭据（已 gitignore）
```

当前路由模块（`packages/server/src/routes`，28 个）：`system / auth / boot / org / org-sync / permissions / kb / chat / content / memory / workspace / plugins / skills / schedules / channel / admin / quota / settings / tools / update / a2a-inbound / console / console-access / console-a2a / console-databases / console-mcp / console-onlyoffice / console-schedules`。

**仍未创建的空包**：`@eab/worker`、`@eab/plugin-proto`、`@eab/plugin-sdk`、独立的 `@eab/kb`、`@eab/runtime`、`@eab/model-gateway`。当前实现集中在 `@eab/server`，没有预铺空包；插件的页面宿主与清单校验在 `@eab/server/src/plugins.ts`、`plugin-host.ts`。

**命令**

| 命令 | 作用 |
|---|---|
| `pnpm verify` / `pnpm typecheck` / `pnpm test` | 类型检查与全量单测；当前基线见 20.2.2 |
| `pnpm dev` | 同时起员工 `8787/chat` 与管理 `8788/admin`；默认不造演示数据，`EAB_DEV_AUTH=1` 才生成甲科技 `c1` |
| `node scripts/smoke-http.mjs` | 对已启动服务跑 HTTP 冒烟（含负向 401/403） |
| `node scripts/smoke-platform.mjs` | 平台链路冒烟（导出、临时授权、记忆、SSE、绑定、去重、运维端点） |
| `pnpm perf` / `pnpm perf:enforce` | AGT-21 压测：隔离库 + mock 上游，200 读请求 / 50 对话 / 50 工具；`perf:enforce` 不达 SLO 时非零退出 |
| `node scripts/eab.mjs update` | 命令行一键更新；`eab update <版本>` 可指定升级或降级 |
| `node scripts/eval-agent.ts` / `eval-kb.ts` | Agent 与知识库评测入口 |

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

#### 20.2.1 历史快照：v2026.11.07 的实现进度（不要再当现状读）

> 下面记录的是 2026-11-07 当时的真实状态，保留用于追溯，不代表当前能力。当前状态见 20.2.2；两处冲突时以 20.2.2 为准。

已完成（`pnpm typecheck` 与 `pnpm test` 均通过，15 个测试文件 / 166 个用例）：

| 包 | 内容 | 测试 |
|---|---|---|
| 根骨架 | pnpm workspace、tsconfig base/strict、vitest、`.gitignore`、`onlyBuiltDependencies=esbuild` | — |
| `@eab/domain` | 46 个 scope（常量 + 注册表双登记，漏登记编译失败）、scope 隐含闭包、11 个错误码 + HTTP 映射 + 响应信封、ULID、部门物化路径、**知识库可见范围（4 种模式）** | 29 |
| `@eab/authz` | 7 内置角色、Subject 构造（校验 deptPath 前缀）、谓词 AST（三值化简）、11 类实体列画像（含 deptMode 上/下）、`buildScopeFilter`（含 kb ACL 谓词）、PDP（override → scope → 知识库 ACL / 数据范围 → 密级 → 审批）、`predicateToSql`（字段白名单 + 全参数绑定 + LIKE 转义） | 54 |
| `@eab/workspace` | 路径规范化与穿越防护（`..`、绝对路径、盘符、UNC、scheme、URL 编码穿越、保留设备名、ADS、结尾点、控制字符、长度）、`safeJoin` + `isWithinRoot` 双保险、`toSlug` | 36 |
| `@eab/storage` | `node:sqlite` 连接（WAL/外键/busy_timeout）、事务、迁移执行器（每文件一事务、幂等）、`0001_init.sql`（11 表 + 索引 + 审计不可改触发器）、`0002_kb.sql`（知识库 3 表）、`0003_org_sync.sql`（组织同步 3 表 + departments/users 缺失计数列 + 渠道唯一索引重建）、`0004_channel_bind.sql`（渠道绑定 4 列 + 租户唯一索引 + `channel_bind_sessions` 会话表）、`0005_plugin.sql`（`plugin_states`：按企业存插件启停）、`0006_models.sql`（模型供应商 / 模型目录，密钥只存环境变量名）、`0007_plugin_lifecycle.sql`（`plugin_installs` 安装记录 + `plugin_events` 生命周期审计）、`0017_plugin_company_install.sql`（`plugin_company_installs`：按公司登记插件安装归属，老记录回填给第一家）、审计哈希链（`EAB-GENESIS` 起点、`sha256(prev|canonicalJson)`、断链检测）、`loadKbCollectionAcls`（JSON 解析 + 坏配置 fail-closed） | 23 |
| `@eab/channel` | `OrgProvider` 渠道抽象（`verify` + `fetchOrg`）、`mapRemoteOrg` 纯函数（父链重建 path、渠道根不建行、孤儿挂根、兄弟排序、环检测、多部门取主部门）、`applyOrgSync`（幂等 upsert、rename/move/restore 检测、缺失计数 + 连续 2 次才回收、同步报告 + 差异明细、回写渠道配置且不覆盖绑定状态）、`rebuildDeptPaths`（移动后子树 path 与成员 dept_path 一次收敛）、`fetchDingTalkTenant` + 钉钉/飞书/企微 provider、`mockFeishuOrg(1/2/3)` 三份通讯录快照 | 24 |
| `@eab/server` | Fastify 装配（统一信封、错误处理、`x-trace-id`、版本头）、`loadConfig`（只读环境变量、非法值启动失败、库路径锚定仓库根）、身份解析（**超级管理员账号 + 密码** → 控制台操作员，不登录组织成员；员工 `?as=` 开发预览）、只读接口 `/api/health` `/api/me` `/api/org/tree` `/api/org/members` `/api/kb/collections` `/api/kb/docs` `/api/dev/personas` `/api/dev/kb-matrix`、同步接口 `/api/org/sync-runs` `/api/org/sync-runs/:runId` `/api/dev/org-sync`（**未绑定飞书租户 → 409**）、**渠道绑定接口** `/api/channel/bindings` `/api/channel/bind/start` `/api/channel/bind/:sessionId` `/api/channel/bind/:sessionId/cancel` `/api/channel/bind/:sessionId/mock-scan` `/api/channel/unbind`、内嵌控制台（**顶栏单公司身份牌（无多公司切换）+ 一级导航（悬停展开二级页面）+ 每页自带子导航**：概览 / 组织与权限 / 知识与模型 / 连接与平台 / 运营与审计；令牌+原语三层，无构建步骤；入口在 **`/admin`：先过**管理员账号密码登录页**（默认 `admin` + 自动生成密码，仅本机；`EAB_CONSOLE_TOKEN` 只给脚本）→ 控制台操作员（不登录组织成员）**；员工端口 `/` 302 到 `/chat`，管理端口 `/` 302 到 `/admin`；配套 `/api/console/login` `/api/console/logout` `/api/console/companies`，控制台请求带 `x-eab-console: 1` 与员工身份彻底隔开；新增「角色与权限」「模型接入」两页与 `/api/console/roles` `/api/console/members/:userId/roles` `/api/console/providers` `/api/console/models`）、**员工工作台** `/chat`（左侧账号栏 + 消息流 + 输入框内的模型选择与图片/文件附件 + 未登录登录卡，12.7.6 / 12.7.7）与对话接口 `/api/chat/models` `/api/chat/messages`（`chat:use` + `model:use` + 模型可见角色两层过滤，自动按真实回复速度选模型，无样本才回退优先级；附件收名称/大小/文本正文/图片 dataURL，并组装多模态消息）、**插件接口** `/api/plugins` `/api/plugins/:id/state` `/plugins/assets/:id/:file`（清单校验、按企业启停、iframe 沙箱页面）与**服务器侧插件管理器** `/api/console/plugins` `/api/console/plugins/install` `/api/console/plugins/:id/uninstall` `/api/console/plugins/events`（本地目录安装、暂存校验、版本/来源/指纹、`.trash` 卸载、生命周期审计，12.9）、**单公司本地部署**（一套实例只服务配置里的唯一公司；`assertSingleCompany` 拒绝旧多公司账号，控制台只回唯一公司、不提供新建第二家；员工 8787 / 管理 8788 双端口 surface guard） | 50 条 HTTP 冒烟 |

本版**已完成**的验收项：T-01、T-02、T-03、T-07、T-08、T-25（审计链，含 `verifyAuditChain`）、T-27（路径安全 20+ 变体）、7.6.1 知识库可见范围（读侧内核），**T-04 / T-05 / T-06 的"能跑"版本**（服务起在 `http://127.0.0.1:8787`，50 条 HTTP 冒烟含 12 条负向 403 全绿），**CHN-10 全量同步 / CHN-12 同步报告的"模拟渠道版本"**（用 `mockFeishuOrg` 的三份快照把"首次建组织 → 改名移动离职 → 上游消失 → 回收"整条链路跑一遍并回看差异明细），**CHN-13 扫码绑定企业的骨架**（会话状态机 + 租户跨公司唯一 + 绑定后才允许同步 + 解绑不删组织数据，模拟扫码走通），以及 **12.6 控制台信息架构 S1 + S1.5**（顶部一级导航按业务域分组、每页自带子导航（组织=部门树 / 知识库=库列表 / 渠道=小节+渠道状态 / 矩阵=说明图例 / 系统=小节锚点）、渠道绑定与同步合成一页、概览页、令牌/原语层落地；六个页面均已在浏览器目视验证，树上「N 人」改为按 `dept_path` 前缀统计以保证与筛出行数同口径）。

本版**未完成**（下一步）：

- **T-09~T-11**：登录与双 token 会话、组织/成员 CRUD、角色矩阵与知识库管理接口、缓存失效广播。当前靠 `devAuth` + `?as=<userId>` 冒充身份，`EAB_DEV_AUTH=0` 时直接 401。
- **T-12 的 HTTP 级负向用例**：目前只有 `scripts/smoke-http.mjs` 的 50 条断言，还没进 vitest；`routes/channel.ts` 的会话状态机与跨公司租户冲突、`routes/chat.ts` 的模型可见性与自动选择也还没有单测（只有手工端到端用例）。
- **repository 层**：`{ scope }` 必填的仓储签名仍只有设计，代码里没有 Repository 实体（路由直接写 SQL）。
- **组织架构同步（CHN-10~12）剩下的部分**：三家真 provider（飞书/钉钉/企微）一个都没写——验签、长连接/回调接收、分页限流、增量模式；CHN-11 的每日校准定时任务与"离职当天 `subject:invalidate` 广播"也没做。映射与落库层已经稳定，接真渠道时只补 `fetchOrg`。
- **真渠道的扫码授权**：现在 `mock-scan` 是开发预览的替身；接飞书要 app_id + 开通二维码登录/应用授权，钉钉要 app_key，企微要 corpid + 服务商授权码。换租户之后的写绑定逻辑完全复用。
- **控制台写入口不齐**：组织/知识库/渠道/插件已经能配，模型目录（provider / 模型 / 可见角色）已能配，公司重命名/停用/删除已能配；但密钥托管与额度、日志级别、备份触发仍没有页面，只能改库或环境变量。补的时候一律走管理员登录 + 二次确认，不做成员工能碰的开关。
- **单公司口径（12.10）**：控制台只显示配置里的唯一公司，不提供新建第二家；`POST /api/console/companies` 409，扫码开通在库里已有公司时也拒绝。要换组织先删除唯一公司回到空库，再「钉钉扫码绑定组织」。
- **附件已落个人云空间并支持正文解析、扫描 OCR、安全检查和对象存储镜像**：图片、文件随消息发送时先保存到个人云空间「对话附件」目录，历史消息按 `workspaceFileId` 回放并显示 active/deleted/forbidden 状态；文本类直接读正文，图片走视觉输入，PDF / DOCX / XLSX / XLSM / PPTX 发送时用 `chat-attachment-document` 调 `kb-parsers` 解析正文，扫描页经 `kb.ocr` 路由逐页识别，解析结果按文件版本做 LRU 缓存；上传和读取前做危险类型、魔数、OOXML 结构、压缩炸弹与 EICAR 检查；配置 `EAB_S3_*` 后对话附件同步镜像对象存储并支持本地缺失回源。老式 Office、超大文件或单页 OCR 失败只降级提示，不影响文件预览与后续 Office 工具读取。
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
9. **导航口径（12.6.2）**：布局是**顶部一级导航 + 导航自身向下展开的横排二级行 + 内容区**，一级导航按业务域分组（概览 / 组织与权限 / 知识与模型 / 连接与平台 / 插件管理 / 技能管理 / 运营与审计），不按数据表或接口名分组；二级行只在悬停或键盘聚焦一级项时出现，展开时一级导航从 58px 增高并把内容区整体下移，不使用浮动卡片覆盖页面；插件 / 技能页的左侧清单属于页面内容，继续保留。组织树只出现在「部门管理」页，知识库页左栏是**库列表**。树上「N 人」按成员 `dept_path` 前缀统计（含下级），必须与点进去筛出的行数一致。
10. **两个入口（12.8）分端口**：管理控制台 `8788/admin`（**统一登录：成员可钉钉扫码或用工号/邮箱/手机号密码；平台管理员用服务器管理员账号，管理员默认全量权限且只允许本机/显式放行网络**；成员必须具备至少一个后台页面权限）≠ 员工 `8787/chat`（只对话）。不可越界：员工端口 404 管理接口，管理端口 404 员工对话与 `/api/auth`；管理端扫码走 `/api/console/member/dingtalk/*` 并使用对话端回调地址；`/api/health` 只说版本与存活；部署参数只走环境变量，没有单独"运维入口"；管理员会话不带员工身份，控制台登录后开员工端口仍是员工（请求缺 `x-eab-console: 1`）。**入口不许合并**：`surface guard` 让两个端口互相 404。
11. **插件口径（12.9）**：插件是磁盘目录（`plugins/<id>/plugin.json`），安装/更新/卸载是**服务器侧控制台的运维动作**（本地目录 → 暂存校验 → 登记版本/来源/指纹 → `.trash` 可恢复卸载），按公司启停仍属企业域（`plugin_states`）；清单只允许声明已存在的 scope，`compatibility.eab` 不满足当前版本判不合法；坏清单不崩服务；页面一律 iframe 沙箱渲染，插件要数据只能走同一套 HTTP API，因而受同一套权限约束；员工侧永远看不到安装来源与服务器路径。
12. **多公司口径（12.10）**：**公司从人身上取，不从进程配置取**——`deps.companyId` 只是单公司部署的默认公司，参与查询与鉴权的必须是 `subject.companyId`。`dataScope='global'` 只表示"本公司内不受部门限制"，不许退化成 `1 = 1`；跨公司读业务数据如果确实需要，做成控制台里按公司逐家看的独立只读出口，而不是放开超管谓词。渠道租户 `(provider, tenant_id)` 全局唯一，一个租户只能属于一家公司。
13. **工作台版面口径（12.7.6 / 12.7.7）**：顶栏只放会话级信息，**任何"我是谁"都不出现在右上角**；账号、可用模型、退出登录在左侧栏（员工侧没有控制台入口）；模型选择在输入框里，且左侧列表与输入区胶囊共用同一份选中状态。未登录或登录态失效 → 登录卡，且**不请求 `/api/me`**，避免"默认塞给用户一个身份"。附件正文与图片视觉输入随消息进模型，但附件不落盘、历史不回放旧图；只有附件没有文字的消息允许发送，两者不能同时为空。

### 20.2.2 当前状态（2026-11-24，2026-11-25 增补 AGT-21）

当前工作区版本为 `2026.11.24`，本轮 AGT-21 不改版本号。

**回归基线（2026-11-25）**：`pnpm typecheck` 通过；全量 `pnpm test`（串行）为 **252 个测试文件 / 1577 个用例全部通过**，耗时 401.3s。并行 `vitest run` 下 A2A 用例偶发 5 秒超时，单跑通过，串行脚本作为权威口径。AGT-20 的文档漂移修正仍有效；AGT-05 相关新增/扩充覆盖审批门禁、钉钉卡片投递、命令沙箱与 `project.exec` 门禁，全量基线同时纳入已有的 `prompt-compiler` 14 个用例。

**压测基线（2026-11-25）**：新增 `scripts/perf.mjs`，用隔离种子库和本地 mock 模型上游，单实例完成 200 只读请求（20 并发）、50 并发对话、50 并发工具调用。读接口错误率 0%，P95 30.6ms；对话 50/50 成功，首字 P95 6.20s，整轮 P95 6.58s，队列峰值 46，SQLITE_BUSY 0；工具 50/50 成功，P95 284.7ms；RSS 峰值 160.0MB。`pnpm perf:enforce` 退出码 0。`/metrics` 的 `eab_tool_queued` 仍读旧 `toolSemaphore`，与实际工具执行路径不一致，本轮不用于 SLO。详见 `docs/EAB-AGT-21-压测与SLO基线-2026-11-25.md`。

**审计项落地状态**

| 审计项 | 状态 | 当前落点（代码 / 交付文档） |
|---|---|---|
| AGT-01 事实账本 + 数字校验 | 已下线 | 2026-11-24 按产品决策移除；答案不再做数字核对，`models.task_verification` 白名单同步停用 |
| AGT-02 条件必带 | 已落地 | `missingConditionParams()`，插件调用前硬校验 |
| AGT-03 执行控制器 | 已落地 | `execution-controller.ts`；`EAB-P0-执行控制器与评测集-2026-11-23.md` |
| AGT-04 Prompt Compiler | 已落地 v1（字符 20% 目标待压缩） | 六段编译器、段版本、token 预算、提示指纹与消息 meta 快照；13 条提示回归；见 `EAB-P0-提示编译器v1-2026-11-24.md` |
| AGT-05 工具风险分级 + 逐次审批 | 已落地；AGT-05b strict 沙箱 v1 已落地 | `tool-approval.ts`、迁移 `0101_tool_approval_used.sql`、`chat-events.ts` 审批事件、`/api/chat/tool-approvals/:id/decide`、网页审批卡、钉钉 A2UI 工具审批卡（`tool-approval-dingtalk.ts`）；`project.exec` 命令黑名单之外新增 Docker/bwrap strict、network denied、命令白名单与 fail-closed；见 `EAB-P0-项目命令OS沙箱v1-2026-11-24.md` |
| AGT-06 评测集 v0 + 发版闸门 | 已落地 | 与 AGT-03 同一交付文档；数字门禁下线后，评测集保留条件必带与执行预算 18 例 |
| AGT-07 任务详情可观测页 | 已落地 | `EAB-P0-任务详情可观测页-2026-11-24.md`、控制台任务中心 |
| AGT-08 Plan 对象与进度 API | 已落地 | `agent-plan.ts`、迁移 `0093_agent_plan.sql`、`EAB-P1-任务计划对象与计划板-2026-11-24.md` |
| AGT-09 独立验收员门禁 | 已落地 | `agent-review.ts`、迁移 `0094_agent_task_reviews.sql` |
| AGT-10 岗位卡 allowlist + 任务预算 | 已落地 | `agent-protocol.ts`、`agent-capability-registry.ts`、`EAB-P1-岗位卡工具白名单与任务预算-2026-11-24.md` |
| AGT-11 团队复杂度门禁 | 已落地 | `EAB-P1-团队复杂度门禁-2026-11-24.md`、运行详情编队理由 |
| AGT-12 产物交接标准化 | 已落地 | `agent.publish_artifact` 的 checksum/preview/mime；`EAB-P1-产物交接标准化-2026-11-24.md` |
| AGT-13 记忆类型 + 混合召回 | 已落地 | `memory-os.ts`、迁移 `0096_memory_os.sql`、`EAB-P1-记忆OS-2026-11-24.md` |
| AGT-14 个人偏好记忆 | 已落地 | `memory.propose` 个人路径、待确认记忆 |
| AGT-15 知识库质量闭环 | 已落地 | 引用元数据、新鲜度提示、表格/图片基准 |
| AGT-16 任务图 v1 | 已落地 | `task-graph.ts`、迁移 `0097_task_graphs.sql` / `0100_task_graph_leases.sql` |
| AGT-17 Docker/Compose + 多实例 | 已落地 | Dockerfile/Compose、运行角色、健康探针、迁移 `0098_runtime_coordination.sql` |
| AGT-18 模型任务白名单 | 已下线 | 2026-11-24 按产品决策移除；网页/钉钉/飞书不再按“数据类实测”限制选模，控制台接口与按钮同步删除；迁移 `0099_model_task_verifications.sql` 仅保留历史表 |
| AGT-19 多模态内容工具 | 部分落地 | 图片生成 v1 已落地（`/api/content/images`、`content.generate_image`）；视频生成未做 |
| AGT-20 文档漂移清理 | 本轮落地 | 本文件、审计表、整改清单同步校正 |
| AGT-21 全量压测 + SLO | 部分落地（基线 v1） | `scripts/perf.mjs`、`pnpm perf`、`pnpm perf:enforce`；隔离 `.eab-dev/perf`；覆盖读接口 / 知识库读 / 50 并发对话 / 50 并发工具；见 `EAB-AGT-21-压测与SLO基线-2026-11-25.md` |

**仍未实现（不要按“已完成”对外说明）**

- `video.analyze` 只有端点、用途和设计管线，运行时调用未接。
- 移动端 Capacitor 壳、访客门户。
- 企微真实回调 AES 解密、真实厂商租户端到端。
- AGT-05b：strict 沙箱代码与白名单已落地；剩余是在装有 Docker Desktop 或 bwrap 的机器上做真实容器执行、断网和越界写入验收。
- AGT-04：提示编译器已落地，剩余“字符数下降 ≥20%”需对 `ask_user`、团队与计划长段做独立内容压缩，不在编译器里截断。
- AGT-21 只完成基线 v1：真实厂商延迟、10 万 chunk 向量检索、子 Agent 并发、双实例与阶梯加压尚未覆盖。
- 生产监控、灾难恢复演练、真实员工大样本验收。

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

**已定：采用日期版本号**，当前工作区为 **v2026.11.24**，与根 `package.json` 的 `version` 字段一致。AGT-20 文档清理与 AGT-21 压测基线均不改版本号。

规则：

| 项 | 规则 |
|---|---|
| 格式 | `vYYYY.MM.DD`（当天首个版本）或 `vYYYY.MM.DD.NN`（同日追加版本） |
| 同日序号 | `NN` 为两位数字，范围 `01`–`99`；没有序号视为 `00`，因此 `v2026.11.18` < `v2026.11.18.01` < `v2026.11.18.02` |
| 排序 | 按“年 → 月 → 日 → 同日序号”四段数字比较；跨日优先于同日序号，例如 `v2026.11.18.99` < `v2026.11.19` |
| 同日多次发布 | 追加 `.01`、`.02`，不跨日凑版本；不再使用 `-1`、`-2` 后缀 |
| 变更时点 | 每次发布前由你确认当日版本号；日常提交不改版本号 |
| 落点 | 文档头、根 `package.json`、`eabd --version`、Release 标题四处必须一致 |
| 比较实现 | 服务端 `packages/server/src/update.ts` 的 `isNewerVersion()` 与 `scripts/eab.mjs` 的 `isNewer()` 必须使用同一规则；格式不合法时不判定为更新 |
| 非 semver 说明 | `YYYY.MM.DD.NN` 是四段日期版本，不是标准三段 semver；EAB 更新器按本规则自行比较，不依赖 npm/semver 的版本优先级 |
| 迁移版本 | 数据库迁移**不跟随产品版本**，用递增文件名（`0001_`、`0002_`），只前进不回退 |

### 22.5 组织架构同步开工前需要你定的三件事

| # | 问题 | 我的推荐 | 为什么必须现在定 |
|---|---|---|---|
| S1 | 先接哪一家（飞书 / 钉钉 / 企微） | **飞书先行**；公司主用钉钉就换钉钉 | 三家的鉴权、事件协议、部门/人员字段完全不同（见 8.2）。先定一家，映射层与同步报告才有验收对象；另两家以后只是各加一个 provider |
| S2 | 同步时要不要"自动绑定渠道身份" | **默认不绑**：同步只写 `user_identities` 待确认，首次登录/发消息时才置 `active` | 自动绑 = "渠道里有账号就能查公司知识库"，风险过大；不绑只多一次管理员确认 |
| S3 | 上游删人怎么处理 | **连续两次全量缺失才回收**（默认 24h 间隔），离职即时失效 | 直接按"上游没有就删"会在通讯录权限审批中/应用未发布期间误删真实员工（8.6 第 4 条） |

顺带需要的输入：三家应用的 `app_id` / `app_secret`（或先只跑 mock provider：用假数据把映射与报告跑通，再换真凭证）。

---

## 23. 内置浏览器工作台（2026-11-25 第一阶段已落地）

### 23.1 目标与边界

右侧“网页”页签用于预览和操作真实网站，Agent 的浏览器动作直接反映在同一页面上，不额外记录操作步骤。首个真实业务目标是标标达等招投标平台：打开登录页、人工接管输入手机号/验证码、登录后按企业需求检索项目并读取招标要求。

不使用 iframe 直接嵌入目标站点：多数站点通过 `X-Frame-Options` / CSP 禁止被嵌入，且跨域后无法读取页面内容。默认形态为 Web 右侧工作台：服务端 Playwright 浏览器 + CDP screencast 实时 JPEG 帧（断流回退 HTTP 截图），标签条/工具栏/内容区全部在 8787 页面内完成，不依赖 Electron。`packages/desktop` 的 Electron `WebContentsView` 是可选 Windows 客户端，2026-11-26 起正式推进，但不替代 Web 默认入口；两条路径复用同一套 `pageId`、浏览器动作和安全策略。当前 Web 形态规则见 23.3.6，桌面分发见 23.3.7。

### 23.2 会话与接口

- 会话仍按 `${companyId}:${userId}` 隔离，每用户独立 `BrowserContext`，不同用户不共享 Cookie。
- 页面以 `pageId` 标识；Agent 的 `browser` 工具与右侧工作台操作同一页面，工具结果里的 `pageId` 就是前端关联键。
- 工作台接口：
  - `POST /api/browser/workspace/open`：同步打开 http/https 页面，返回标题、URL、正文摘录和可操作元素；供 Agent/诊断链路使用。
  - `POST /api/browser/workspace/open-fast`：工作台专用快速打开，先返回 `pageId` 和 URL，导航在后台继续，前端可在数百毫秒内开始接收加载画面。
  - `POST /api/browser/workspace/warm`：只预热 Edge 进程和当前用户的 BrowserContext，不创建页面；新建网页标签时调用，降低首次打开的冷启动等待。
  - `GET /api/browser/workspace/:pageId`：读取当前页状态与元素。
  - `GET /api/browser/workspace/:pageId/stream`：`text/event-stream` 实时画面流，服务端用 CDP `Page.startScreencast` 在页面变化时推送 JPEG 帧；只在客户端断开后停止，切换标签自动重连。
  - `GET /api/browser/workspace/:pageId/frame`：返回 `image/jpeg` 静态视口帧，带 `x-eab-tile-width/height` 和站点图标；作为实时流不可用时的兜底，不写个人云空间。
  - `POST /api/browser/workspace/:pageId/input`：人工接管，支持坐标点击、向当前焦点输入文字、白名单按键和有限幅度滚轮。
  - `POST /api/browser/workspace/:pageId/nav`：同步浏览器导航，`action` 为 `back` / `forward` / `reload` / `navigate`；`navigate` 额外带 `url`，复用与地址栏一致的安全校验和等待策略，超时或跳转失败返回 `EAB_UPSTREAM`。
  - `POST /api/browser/workspace/:pageId/nav-fast`：工作台专用快速导航，先返回当前 `pageId` 和目标 URL，后退/前进/刷新/跳转在后台执行，加载过程由实时流上屏。
  - `POST /api/browser/workspace/:pageId/close`：关闭页面。
- 鉴权复用 `CHAT_USE`，操作写 `browser.workspace.*` 审计；输入内容不写审计，避免密码/验证码落库。

### 23.3 前端行为

- 右侧工作台是一个统一的标签页容器，不再是“团队 / 网页 / 文件 / 审批”四个固定按钮：Agent 团队、审批、文件预览和多个网页标签可以同时存在，按需切换。
- 每个网页标签对应一个 `pageId`。实时画面、页面状态、坐标点击和接管输入都属于当前标签；切换标签只换画面，不关闭后端页面。
- Agent 的 `browser` 工具结果到达时，前端按 `trace.view.pageId` 复用或新建网页标签，自动切到该标签并订阅实时流；不在页面里记录 Agent 或用户的动作步骤。
- 点击画面按图片显示尺寸换算到浏览器视口坐标（当前视口 1280×800）；密码和验证码由用户在工作台输入，不进入模型上下文。
- 画面可暂停，暂停只停止取帧，不关闭页面；页面关闭或超时后状态接口返回 404，前端移除对应标签，并把焦点交给相邻标签。
- 网页标签拿到更宽的分栏（默认 44%，1440 宽下约 632px）；从网页切回团队或审批时回到团队栏宽度，避免审批表单被网页比例压窄。
- 已打开网页的顶部不再是工作台标题，而是浏览器式工具栏：后退、前进、刷新、居中地址栏、连接状态和暂停按钮。地址栏收起时只显示域名（如 `cn.bing.com`），点击后展开完整 URL 并全选，回车跳转或搜索，失焦/`Esc` 恢复域名显示。标签标题、完整 URL 和连接状态各自独立，不再挤在一条地址行里。

### 23.3.1 加号与标签页规则（2026-11-25 第二轮，部分已被 23.3.5 取代）

> 注：加号浮动菜单已在第六轮移除；本节保留第二轮设计过程，当前规则以 23.3.5 为准。

- 顶栏右侧只保留一个圆形 `+`（无文字标签），作为工作台统一入口；工作台未打开或已打开都能点它新建标签页。原“审批”按钮已移除，审批统一从加号菜单进入。工作台打开后，标签栏右侧也有一个 `+`，两者打开同一个“新建标签页”菜单。顶栏左侧的“对话 / 工作台”是个人插件工作区切换，和右侧标签工作台不是同一个东西。
- 新建菜单提供三类入口：新建网页（先建空标签，输入网址或搜索词后打开）、Agent 团队（没有子 Agent 时也能先打开空团队视图）、审批（打开权限申请 / 我的申请 / 待我审批）。
- 网页标签支持多开、切换和逐个关闭；每次点 `+` 都新建一个独立空白标签，不再复用已有草稿，和浏览器新标签页一致。同一个网址可以重复打开，每个页面有独立 `pageId`、实时帧和 Cookie 页面状态。空网页标签带一个圆点，关闭时直接移除，不请求后端。实际页面标签关闭时调用 `POST /close`，只关闭这一页。
- Agent 团队标签在没有子 Agent 且由用户手动打开时显示空态，可关闭；有子 Agent 运行时不可关闭，避免把正在执行的工作过程藏掉。
- 标签栏放不下时横向滚动，鼠标滚轮可横向滚标签；标签条按浏览器样式排布：激活标签为白底、上方两角圆角、左侧圆形图标 + 标题 + 右侧 `×`，未激活标签透明贴在条上；`+` 紧跟最后一个标签，不随标签滚动，“并排”靠最右。原“收起”按钮已移除，关闭最后一个可关闭标签后面板自动收起；有子 Agent 运行时团队标签仍不可关。
- 新建的网页空标签页给出一组描边胶囊动作：第一项是真正的“搜索或输入网址”输入框（占位“搜索或输入网址，回车打开”），输入后按回车直接打开；其后是打开 Agent 团队、打开审批、打开云空间（在右侧工作台新增“云空间”标签，独立读取 `/api/workspace/files` 并列出全部云端文件和文件夹，可进入子目录、打开文件预览、刷新重读；不自动打开最近一个文件，也不受当前会话绑定本地项目影响）。输入内容按地址栏规则判断：`http://` / `https://`、域名、IPv4、IPv6、`localhost` 视为网址；带空格、中文或不像域名的裸词视为搜索词，交给必应搜索页（`https://www.bing.com/search?q=`，国内会落到 `cn.bing.com`）显示结果。顶部原来单独一行的地址栏表单已删除，工作台不再保留 `web-url-input` / `web-open`；每个空标签各自保留已输入但未提交的内容，切换到别的空标签再切回来不会丢。这一页只是入口，不拦截已打开网页的画面点击；页面打开后由顶部浏览器工具栏的地址栏接管导航。网页画面仍是服务端浏览器投屏，鼠标点击/滚轮/输入按 1280×800 归一化转发；Agent 动作直接反映在画面上，不生成操作步骤列表。
- 标签顺序为：Agent 团队 → 审批 → 文件预览 → 网页标签（按打开顺序）。新网页标签追加在末尾，当前标签自动滚入可见区域。
- 后端页面配额随多标签上调并支持环境变量：`EAB_BROWSER_MAX_PAGES` 默认 12（全局），`EAB_BROWSER_MAX_PAGES_PER_OWNER` 默认 8（单用户），超过时返回 429 并提示先关闭不用的页面。
- 内置浏览器内网访问默认关闭；控制台「数据连接 → 内网访问」可显式开启。白名单每行一个域名或 IP，填 `*` 表示放行全部企业局域网（RFC1918、CGNAT、IPv6 ULA）；只开放 80 / 443 标准网页端口。`localhost`、环回、链路本地（含 `169.254.169.254` 云元数据）、组播和保留地址即使填 `*` 也继续拒绝；公共网站不受影响，`web.fetch` 不跟随这份浏览器白名单。

### 23.3.2 浏览器式工具栏（2026-11-25 第三轮）

- 网页打开后，标签条下方是约 42px 的浏览器工具栏：左侧后退 / 前进 / 刷新三枚线性图标，中间是居中的地址胶囊，右侧是连接状态和暂停按钮。工具栏只占一行，不再保留原来的 `WEB WORKSPACE` 标题头、页面标题行和底部地址行。
- 地址栏默认只显示 `host`（例如 `cn.bing.com`），完整 URL 放在 `title` 属性里，避免长查询串撑破分栏；点击地址栏后展开完整 URL，延时 60ms 全选，方便直接覆盖输入。`Enter` 调用导航，`Esc` 或失焦恢复域名显示。
- 地址栏同时是导航入口：输入网址按网址打开，输入裸词按搜索处理，复用新标签页的同一套地址判定规则；导航期间状态显示“正在跳转…”或“正在搜索…”，重复回车不会再发第二次请求。
- 后退、前进、刷新由后端 `back` / `forward` / `reload` 执行，完成前按钮和画面互斥，完成后标签标题、地址栏、连接状态和实时帧一起刷新；不在前端记录操作步骤。
- 暂停按钮是图标切换，暂停时显示播放图标、`aria-label` 改为“继续画面”，恢复后切回双竖线；暂停只停取帧，不关闭页面。空草稿标签和无页面标签隐藏整个工具栏，仍使用新标签页里的搜索胶囊。
- 对应后端接口 `POST /api/browser/workspace/:pageId/nav`，审计事件为 `browser.workspace.<action>`；`navigate` 记录目标 URL，`back` / `forward` / `reload` 只记录动作。

### 23.3.3 加载速度优化（2026-11-25 第四轮）

- 导航不再等 `networkidle`。`open` / `reload` / `navigate` / 前进后退统一只等 `domcontentloaded`，再给正文最多 1 秒的短探测（首个 30 字出现即放行），避免广告和长轮询把页面卡在固定 5 秒等待上。
- 新建网页标签时就调用 `POST /api/browser/workspace/warm`，提前启动 Edge 和当前用户的 BrowserContext；用户输入期间冷启动被后台吃掉，打开请求与预热共享同一个 Context Promise，不会重复启动浏览器。
- 搜索入口在 2026-11-26 按用户要求从 `https://www.so.com/s` 改为豆包桌面版一致的必应 `https://www.bing.com/search`，国内实际落到 `cn.bing.com`。网址判定规则不变，`github`、`EAB 企业智能体基座` 这类裸词仍走搜索；真机实测搜索 `EAB 企业智能体基座` 后地址栏为 `https://cn.bing.com/search?q=EAB%20%E4%BC%81%E4%B8%9A%E6%99%BA%E8%83%BD%E4%BD%93%E5%9F%BA%E5%BA%A7`，标签标题为 `EAB 企业智能体基座 - 搜索`。
- 原 360 搜索的加载速度记录保留在下面作为历史数据，不再代表当前默认入口。
- 实时帧从 1 fps 提到 600ms 一帧，标签页可见时约 1.7 fps。取帧从“预加载 Image 再赋给页面 img”改为 `fetch → Blob → objectURL`，每帧只下载一次；切页时中止旧请求，避免上一页的慢帧覆盖新页。
- 实测（本机 Edge、单用户）：标标达首页从 5.2 秒降到 1.4 秒；360 搜索从 3.7 秒降到约 1.7 秒（浏览器已预热），`reload` 约 0.6–1.1 秒，取帧 30–60ms。首次冷启动仍需约 0.7 秒预热加 2 秒左右首屏，后续搜索主要受目标站点网络影响。
- 这条链路仍是“服务端浏览器 + JPEG 帧投屏”，不等于豆包桌面版的原生窗口渲染；能优化的是导航等待、冷启动和取帧频率，不能把第三方站点本身的重资源加载变成零成本。原生化方案见 23.3.4。

### 23.3.4 豆包桌面版浏览器拆解与 EAB 原生化设计（2026-11-25 第五轮）

#### 看到的事实

- 本机豆包桌面版是 Electron / Chromium 147 多进程应用：主进程、renderer、GPU、network service、storage、audio、utility 分开运行；`Doubao.exe` 带 `--type=renderer`、`--type=gpu-process` 等标准 Chromium 参数。
- `Application/app/local_webcontents/extensions/ai-views/manifest.json` 是一个 Manifest V3 浏览器扩展，权限包括 `tabs`、`cookies`、`webRequest`、`sidePanel`、`scripting`、`declarativeNetRequest`、`webNavigation`、`bookmarks`，content script 注入 `<all_urls>`。
- 同一扩展下有 `side_panel.html` 和 `side_panel.js`，AI 对话界面运行在侧栏 WebContents 里；`route.json` 把 `/side_panel` 作为独立入口。
- 应用目录里还有 `Doubao_browser_proxy.exe`、`agent_infra.dll`、`mcp_helper.dll`、`rpa-component-extension`，说明浏览器进程、Agent 基础设施和 RPA 控制是分开的，不靠截屏识别页面。
- 豆包桌面版内置浏览器默认搜索引擎是必应（Bing），不是 360；EAB 的裸词搜索入口已按这个默认改成 `https://www.bing.com/search`。
- 结论：豆包的网页是**原生 Chromium 标签页**，页面内容由 Chromium 合成器直接上屏；扩展负责 `tabs` / `navigation` / DOM 注入，侧栏负责 AI 界面。它没有“服务端浏览器截图 → 前端轮询 JPEG”这一层。

#### EAB 现在慢在架构，不是慢在某个函数

- 服务端 Playwright 打开并持有页面，前端每 600ms 取一张 JPEG；滚动、输入、切页都要走“前端 → HTTP → Playwright → 浏览器 → JPEG → 前端”的往返。
- 站点加载仍在服务端浏览器进程里完成，第三方页面的 DNS、TLS、首屏资源一样要等；之前去掉 `networkidle`、预热 Context、提高取帧频率，只能把等待和投屏开销压低，不能变成原生渲染。
- 原生标签页没有 JPEG 编解码、没有固定轮询、没有鼠标坐标换算，滚动和视频由 Chromium 自己合成，所以体感差距不是再调几个参数能抹平的。

#### 目标架构：EAB Desktop Host + 原生网页标签

```text
┌──────────────────────── EAB Desktop Host（Electron） ───────────────────────┐
│  EAB Web UI（现有 chat.html / chat.js，复用对话、标签、审批、文件）           │
│    │ preload 白名单 IPC：open / nav / back / forward / reload / close / bounds │
│    ▼                                                                        │
│  Browser Tabs（每个网页标签一个 WebContentsView，独立 session partition）     │
│    ├─ 标签 1：WebContentsView → Chromium 原生渲染，无截图                     │
│    ├─ 标签 2：WebContentsView                                                │
│    └─ 地址栏 / 标签条仍是 EAB UI，位置由 #web-frame-shell 的 CSS 像素决定      │
│                                                                             │
│  Agent Control Bridge（本地回环 + 一次性 token）                              │
│    ▲                                                                        │
└────┼────────────────────────────────────────────────────────────────────────┘
     │ 同一套 BrowserAction：open / snapshot / click / type / scroll / nav
┌────┴─────────────────────────┐        ┌────────────────────────────────────┐
│ EAB Server                   │        │ Web-only 形态（保留）               │
│ browser 工具 / pageId / 审计  │        │ 服务端 Playwright + JPEG 帧投屏     │
└──────────────────────────────┘        └────────────────────────────────────┘
```

- 桌面宿主只做“壳 + 原生视口 + 控制桥”，不改业务 UI；EAB 仍是 Web 应用，服务端仍是唯一业务与权限入口。
- 主窗口和每个网页标签共用同一个 `session.fromPartition('persist:eab-web-<owner>')` 持久会话。这样员工在 EAB 登录一次后，右侧原生网页标签也共享 EAB 的登录态；第三方站点仍受同源策略约束，只能带自己的 Cookie，读不到 EAB 的 `eab_session`。2026-11-26 真机验收发现“主窗口 defaultSession、原生页独立分区”会导致登录后标签仍显示登录页，已统一为同一分区。
- 标签条、地址栏、连接状态继续由 `chat.js` 渲染；网页内容区域由原生 View 覆盖在 `#web-frame-shell` 的矩形上。切标签、收起工作台、拖动分栏、窗口缩放时，前端把新的 CSS 像素矩形经 IPC 传给主进程，主进程再夹取到窗口内容区。
- 桌面模式下不再请求 `/api/browser/workspace/:pageId/frame`，也不启动 600ms 取帧定时器；`<img id="web-frame">` 只作为 Web 形态的占位，不再承担桌面渲染。
- Agent 动作仍以 `pageId` 为关联键。桌面宿主在线时，服务端把 `BrowserAction` 转给本机控制桥；宿主不在线或用户使用局域网 Web 端时，回退到现有 Playwright 会话。两条路径返回同一份 `BrowserResult`，前端不需要区分。

#### 接口契约

- 渲染进程只暴露一个 `window.eabDesktop`：`open(url)`、`navigate(pageId, action, url?)`（action 为 `navigate` / `back` / `forward` / `reload`）、`setBounds(pageId, rect)`、`close(pageId)`、`show(pageId)`、`hideAll()`、`onState(cb)`、`onClosed(cb)`；事件为 `eab:browser-state`（`pageId`、`url`、`title`、`favicon`、`loading`、`canGoBack`、`canGoForward`、`error`）与 `eab:browser-closed`（`pageId`）。`diagnostics()` 只在开发态返回窗口内容区、每个原生页的 bounds/可见性/favicon，供自动化验收，打包版直接拒绝。
- 原生页 `pageId` 使用 `dp_` 前缀；每个页一个 `WebContentsView`，Session 分区为 `persist:eab-web-<owner>`。`setBounds` 的输入是窗口内容区 CSS 像素，主进程按当前 `contentView` 尺寸夹取，宽度小于 24 时隐藏。
- 主进程只接受 `http` / `https`（端口不限，便于企业内网），拒绝 `file:`、`javascript:`、`data:` 和内嵌账号密码 URL；`setWindowOpenHandler` 一律 `deny`，弹窗不进入 EAB 标签，和 Web 形态的“弹窗自动关闭”保持一致；页面内跳转也走同一套校验。
- 控制桥只绑定 `127.0.0.1`，端口随机、启动时生成一次性 token；服务端注册后按 `ownerKey` 绑定，不能跨用户复用。控制桥只接受上面那组 `BrowserAction`，不提供任意命令执行、文件读写或 shell。
- 桌面桥不可用时，`chat.js` 自动退回现有 Web 形态，不改变当前已经通过的 Playwright、JPEG、人工接管和凭据填充逻辑。

#### 分阶段落地

1. **D1：桌面壳与手动原生浏览（2026-11-25 已落地）**。新增 `packages/desktop`，Electron 主进程加载现有 EAB Chat，提供 `window.eabDesktop`；网页标签改为原生 `WebContentsView`；标签条、地址栏、前进后退刷新、关闭标签已跑通；桌面模式停止取帧。此阶段 Agent 仍走服务端浏览器，但桌面手动浏览已经不再投屏。
2. **D2：Agent 原生控制（2026-11-26 第十三轮已落地）**。没有另起 localhost 控制桥，而是把桌面文件桥扩成通用任务桥：`kind='browser'` 任务经 `register / jobs / result` 下发到 Electron 主进程，对右侧 `WebContentsView` 执行 `list/open/activate/snapshot/click/type/scroll/navigate/back/forward/reload/screenshot/close`。服务端在 `browser` 工具里按桌面设备头路由；桌面离线或没有设备时，`list/activate` 返回 409，不偷偷回退到另一个页面。详见 §5.5 与 23.3.7.5。
3. **D3：桌面交付（2026-11-26 第一版已落地）**。桌面壳不随包启动本地服务，首次启动填写已有 EAB 地址；Windows 便携包由 `pnpm desktop:build` 生成，服务端提供 `/download/desktop` 下载页；自动更新、代码签名、正式安装包和崩溃恢复待补。

#### D1 实现与验收（2026-11-25）

- 新增 `packages/desktop`：`main.mjs` 管窗口、`WebContentsView`、IPC、URL 校验和生命周期；`preload.cjs` 暴露 `window.eabDesktop`；`README.md` 记录启动方式和 D1 边界。根 `package.json` 增加 `desktop` 脚本；Electron 二进制由 `packages/desktop` 的 `postinstall` 调用官方安装脚本下载，不再依赖 workspace 构建白名单。
- 安全与生命周期：只接受 http/https，拒绝 file/javascript/data 和内嵌账号密码 URL；页面内 `will-navigate` 与地址栏共用同一套校验；窗口关闭统一清理；bounds 夹取到内容区，小于 24 像素隐藏。D1 当时 `window.open` 一律拒绝、主页面 reload 时销毁全部原生页；这两条已在 2026-11-26 第十三轮调整：`window.open` 转为受控新标签，主页面 `did-start-navigation` 只隐藏原生页、不销毁，保证刷新聊天页后右侧标签仍存活。
- 前端 `chat.js` 检测到 `window.eabDesktop.isDesktop` 后切原生分支：打开、地址栏导航、后退、前进、刷新、关闭全部走 IPC；原生页不再请求 `/api/browser/workspace/:pageId/frame`，也不启动 600ms 取帧定时器；前进/后退按钮按 `canGoBack` / `canGoForward` 禁用；主页面 reload 时标签栏从主进程 `listTabs` 与 `localStorage` 快照恢复，原生页本体不再随 reload 销毁。
- 真机验收（本机 1920×1080、125% 缩放、Electron 45.4.1 / Chromium 156.0.8078.100）：两次实测，首次打开 360 搜索 1.5–2.4s 到标题并停止加载（含 UI 约 2.0–3.0s）；地址栏跳到 `example.com` 0.23–1.33s；后退 1.6s、前进 0.22–0.24s、刷新 0.65–1.49s。原生视口 bounds 为 `807,167,588,552`，与 `#web-frame-shell` 的 CSS 矩形逐像素一致；两个原生页切换时只有当前页 `visible=true`；切到 Agent 团队后全部隐藏；关闭标签收到 `eab:browser-closed` 且 View 从诊断列表移除；整轮验收 `/frame` 请求数为 0。
- 验收产物：`.eab-dev/desktop-shell-native-page.png`（原生 `WebContentsView` 实际渲染的 `example.org` 页面）、`.eab-dev/desktop-shell-09-final.png`（EAB 外壳与标签状态）。
- 未完成：D2 控制桥、桌面页与 Agent 页 `pageId` 统一、安装包/签名/自动更新；`EAB_DESKTOP_COOKIE` 仅开发态使用，正式登录流程待定。


#### 验收口径

- 桌面模式下打开网页，浏览器面板不再出现周期性 `/frame` 请求，滚动和视频由原生视口直接渲染；同一页面在桌面壳里的首屏时间应明显低于 Web 形态的“导航 + 首帧”时间。
- 切标签、收起工作台、拖动分栏、窗口最大化后，原生视口与 `#web-frame-shell` 的矩形保持一致，不遮住标签条和地址栏。
- 关闭标签后 `WebContentsView` 被销毁；关掉最后一个网页标签，工作台按现有规则收起。
- 桌面桥断开时，前端退回 Web 形态并给出状态提示；Web 形态现有验收（工具栏、地址栏、搜索、前进后退刷新、人工接管）不能回归。
- 安全验收：原生视口不能加载 `file:` / `javascript:` / `data:`；`window.open` 转为受控新标签且新页同样只允许 http/https；桌面桥必须带 `x-eab-desktop:1` 与设备 id，跨公司/跨员工/跨设备取标签清单返回空或不匹配；第三方页面读不到 `eab_session`，也读不到 `window.eabDesktop`。

### 23.3.5 浏览器 UI 对齐豆包桌面版（2026-11-25 第六轮）

- 加号规则：顶栏 `+`、标签条 `+` 都直接新建一个“新标签页”，立即出现在标签条并展开工作台；不再弹出“网页 / Agent 团队 / 审批”的浮动选择卡。Agent 团队、审批、云空间文件改从新标签页的胶囊入口进入，和豆包“加号只开新标签”的心智一致。
- 标签条：高 50px，页签高 42px；激活页签白底、顶部 12px 圆角、细边框，未激活透明；页签内容为站点 favicon（取不到时回退灰色通用图标）+ 标题 + 关闭 `×`，`×` 默认透明，激活或悬停才显示；`+` 为 36px 圆形按钮，紧跟最后一个页签。
- 工具栏：白底 44px；左侧后退 / 前进 / 刷新为 30px 圆形悬停按钮，中间地址栏默认无边框、文字居中，聚焦才显示浅边框；右侧保留站点登录钥匙、键盘输入、暂停；原“已连接”胶囊默认隐藏，只有错误时显示红色状态。
- 网页内容区：去掉外框、圆角、阴影和 8px 边距，`#web-frame-shell` 从工具栏下缘直接铺满右侧面板；原生 `WebContentsView` bounds 随 shell 逐像素同步。
- 动作时间线已于 2026-11-26 第八轮移除，不再记录 Agent 或用户的操作步骤；工具栏不再有时钟按钮，底部只保留本站登录信息和键盘输入。
- 新标签页：最大宽度 520px、单项高 50px、纵向间距 10px，白底细边框胶囊；首项是搜索/网址输入框，其后是 Agent 团队、审批、云空间文件。
- 站点图标：桌面主进程监听 `page-favicon-updated`，只接受 http/https 或 `data:image/`，随 `eab:browser-state` 下发；导航到新页面先清空旧 favicon，避免串站。
- 边界：Web 形态是默认形态，仍使用服务端浏览器投帧，但没有常驻“人工接管”条；键盘输入只在右侧工具栏键盘按钮打开时出现。桌面原生形态没有“已连接”胶囊，也不记录操作步骤，交互以原生网页为主。Agent 团队 / 审批 / 文件仍是 EAB 特有入口，收在新标签页胶囊，不与豆包完全等同。
- 验收：原生壳点顶栏 `+` 直接得到“新标签页”，`#workbench-add-menu` 为 0；连续打开 360 搜索 / example.com 两个页面，标签条显示站点图标与标题；切到 example.com 后旧 favicon 清空并回退通用图标；Web 形态回归 `bridge=false`，加号直接新建、搜索页状态“已连接”、`pageerror` 为 0。原“动作时间线默认 hidden、点时钟后 shell 缩到 621”的验收项随 2026-11-26 功能移除作废。

### 23.3.6 Web-only 右侧工作台收口（2026-11-25 第七轮，当前口径）

- 方向演进：2026-11-25 第七轮曾按“在 8787 页面里做右侧工作台、不另做桌面程序”收口，Web 形态因此成为默认零安装入口并保留至今；2026-11-26 用户明确要求启动桌面版开发，桌面客户端重新转为正式交付，但仍只作为 Web 的可选超集访问端，不改 Web 默认路径、不做第二套业务 UI。`packages/desktop` 现在负责原生网页标签和 Windows 分发，Web 右侧 Playwright 投帧继续服务浏览器、移动端和无客户端岗位。
- 页面内结构：右侧自上而下只有标签条（50px）、工具栏（44px）、网页内容区（无外框/圆角/阴影/边距）。标签条页签高 42px，激活白底、12px 顶部圆角、细边框；`+` 直接新建“新标签页”，不再弹“网页 / Agent 团队 / 审批”选择卡。
- EAB 次级入口：Agent 团队、审批、云空间不删除，收进新标签页的三枚胶囊；主浏览器画面不再出现 `TASK PLAN`、`AGENT TEAM`、`并排` 等常驻结构。用户要进入这些入口时，仍然是从标签页内点胶囊，而不是挤在工具栏。
- 底部收口：`#web-pane-foot` 默认整体隐藏。只有站点登录信息、键盘输入两者之一展开时才显示；`#web-takeover` 不再常驻，文案由“人工接管”改为“键盘输入”，由工具栏键盘按钮 `#web-control-toggle` 控制。键盘按钮只在 Web 分支出现，原生分支隐藏；无页面、草稿标签、原生页都收起键盘面板。
- 交互：键盘按钮点击后展开键盘输入面板并聚焦输入框；再次点击收起；切换标签、新建草稿、关闭最后标签都会把 `browserControlOpen` 重置为 `false`，不会把上一个页面的键盘状态带到新页面。工具栏 `aria-expanded` 与激活态同步。
- 不记录操作步骤：2026-11-26 按用户要求删除浏览器动作时间线。前端不再维护 `browserTimelines` / `browserTimelineOpen`，不渲染“动作时间线”抽屉和计数徽标，也不再调用 `pushBrowserAction`；`#web-timeline-toggle`、`#web-timeline`、`#web-timeline-count`、`#web-timeline-badge` 均从 DOM 移除，服务端没有新增持久化。Agent 和用户的操作只反映在实时画面上，不生成可回放的操作步骤。
- Web 站点图标：`captureBrowserPageFrame()` 从页面 `link[rel~=icon]` / `apple-touch-icon` 读取绝对 `href`，只接受 `http:`、`https:` 或 `data:image/`；`GET /api/browser/workspace/:pageId/frame` 通过 `x-eab-favicon`（URL 编码）下发，`chat.js` 用 `safeTabFavicon()` 校验后写入标签；取不到时回退灰色通用地球图标，不把任意协议塞给 `<img>`。
- 内容区自适应铺满：`chat.js` 取帧时把 `#web-frame-shell` 的 `clientWidth/clientHeight` 作为 `w/h` 查询参数；服务端按该宽高比重设 Playwright 视口（默认宽 1280、高不超过 2000，必要时等比缩宽），前端 `.web-frame` 改为 `width:100%; height:100%; object-fit:contain`。这样网页按面板比例重排后铺满内容区，不裁切、不拉伸；分屏或底部面板展开改变高度后，下一帧自动跟随。真机实测 shell `758×776`、帧 `1280×1310`、图片渲染 `758×776`，上下不再留白。
- 鼠标交互：`#web-frame` 不再使用 `crosshair`（用户看到的是十字/加号），改为普通箭头；单击画面直接按坐标发送给 Playwright，不需要先点什么按钮进入“可点击”状态。点击入口由 `#web-frame` 的内联 `onclick` 调用 `window.eabFrameClick(event)`，避免标签切换/画面重渲染后 `addEventListener` 监听丢失。坐标换算按 `object-fit: contain` 的实际内容框计算，先扣掉上下/左右黑边再映射到浏览器视口，避免画面比例变化后点击偏移。
- 实时画面从轮询改为 CDP screencast（2026-11-26 第九轮）：每个活动页面由服务端开一路 `Page.startScreencast`，只在画面变化时推 JPEG；`GET /api/browser/workspace/:pageId/stream` 用 SSE 把帧发给前端，`chat.js` 直接写 `data:image/jpeg;base64,...` 到 `<img>`，不再每帧创建/释放 blob。服务端按引用计数管理 CDP 会话，最后一个订阅者离开或页面关闭即 `stopScreencast` + `detach`。断流、非 Chromium 或 CDP 不可用时自动退回 `/frame` 200ms 轮询；暂停画面时停止订阅，继续时重连。
- 工作台打开/导航改为“先返回、后加载”：`open-fast` 先返回 `pageId`，`nav-fast` 先返回目标 URL，`page.goto` / `goBack` / `goForward` / `reload` 在后台执行；完整快照仍由 Agent 的同步 `open` / `nav` 返回，不影响工具语义。
- 实测（本机 758×776 面板、`example.com`）：暖态 `open-fast` 响应 253ms，从回车到首帧 116–415ms；服务刚重启、浏览器进程冷启动时首帧约 650ms。滚动时 CDP 帧间隔约 20–60ms，接近本地浏览器，而原 600ms 轮询在页面变化后最多要等 600ms 才更新。
- 性能边界：Web 形态仍是服务端 Playwright + JPEG 帧轮询，帧率约 1–2fps，切换/导航等待高于原生 Chromium；这是 Web 默认零安装入口的代价。需要原生网页速度的 Windows 岗位改用桌面客户端（23.3.7），Web 路径继续保留，不把 Electron 设为默认入口。
- 验收：in-app browser 中 8787 页面 `+` 直接新增第二个标签，DOM 中 `#workbench-add-menu` 为 0；网页标签存在时 `#web-pane-foot.hidden=true`、`#web-takeover.hidden=true`、键盘按钮 `hidden=false` 且 `title=键盘输入`；点击键盘按钮后 footer 展开、输入框获得焦点；新建标签页显示“打开 Agent 团队 / 打开审批 / 打开云空间”三枚胶囊；点击“打开云空间”后右侧出现独立云空间标签，列根目录全部文件并支持打开文件预览；打开带图标的站点（360 搜索结果页）后标签图标 class 为 `has-favicon`，`favicon` 为可访问的 http(s) 图标，说明服务端 `x-eab-favicon` 链路已生效。`pnpm typecheck`、`browser-session.test.ts` 13 条通过。

### 23.3.7 Windows 桌面客户端分发（2026-11-26 第十轮）

- 定位：桌面客户端是 Web 的可选超集，不是第二套产品。它加载同一个 `/chat` 工作台，复用服务端登录、权限、会话和 Agent；额外提供原生 Chromium 网页标签、独立窗口和首次启动服务地址配置。Web / Node 仍为零安装默认入口。
- 首次启动：无配置时加载本地 `setup.html`；地址来源优先级 `EAB_DESKTOP_URL` > `%APPDATA%\EAB\desktop-config.json` > 安装目录 `resources\app\desktop-config.json`。Windows 安装包会把下载来源写入安装目录配置，首次启动直接绑定提供安装包的服务器；只有便携版、来源识别失败或用户主动改服务器时才需要手动填写。保存后写入用户配置并进入聊天页；配置损坏、协议非法或带账号密码时拒绝并留在配置页。
- 会话：主窗口与所有原生标签统一使用 `persist:eab-web-<owner>` 分区，登录一次即可共享；第三方站点仍按同源策略隔离。`EAB_DESKTOP_COOKIE` 只在开发态注入，打包版忽略。
- 设置页：Web 端「客户端」分组显示「下载桌面版」，桌面端显示「EAB 服务器」和「检查更新」，前者可重新打开配置页，后者可手动检查、下载或重启安装；对应 IPC 为 `eab:server-info`、`eab:save-server`、`eab:get-server`、`eab:open-server-settings`、`eab:update-check`、`eab:update-download`、`eab:update-apply`。
- 构建：`pnpm desktop:installer` 先用 `build-win-portable.mjs` 复制 Electron 运行时、应用代码和 setup 页，生成便携目录与 zip；再写 `installer/generated/build.nsh`，调用 NSIS 3 编译 `EAB-Setup-<版本>-x64.exe`。安装器脚本为 `installer/eab-installer.nsi`，品牌资源在 `installer/assets`，不依赖 electron-builder。`.gitignore` 已排除 `packages/desktop/release/`。
- 安装向导：欢迎 → 选择安装位置（默认 `C:\Program Files\EAB`，可点“浏览”改路径）→ 安装进度 → 完成并默认勾选“立即启动 EAB”。安装前 `taskkill /IM EAB.exe /F /T`，避免 Electron 文件被占用；写入开始菜单 `EAB` 程序组、公共桌面快捷方式、`HKLM\Software\EAB`（记住上次安装路径）和 `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\EAB` 卸载项。安装目录写 `.eab-install` 标记，卸载时据此确认目录归属，避免用户误选根目录后递归删除。
- 卸载向导：欢迎 → 卸载选项（默认保留 `%APPDATA%\EAB`；勾选后删除登录状态和服务地址）→ 确认 → 进度 → 完成。卸载删除程序目录、开始菜单、桌面快捷方式和注册表项。
- 分发：服务端 `GET /download/desktop` 提供下载中心；`GET /download/desktop/windows` 优先返回最新 Setup EXE，安装包缺失时退回 zip；`GET /download/desktop/setup` 只返回 EXE，新增 `?version=<版本号>` 按版本返回历史包；`GET /download/desktop/portable` 只返回便携 zip，同样支持 `?version=<版本号>` 按版本返回历史归档。路由在 `packages/server/src/routes/desktop-download.ts`，整页 HTML 拆到 `desktop-download-page.ts`，由 `app.ts` 注册。
- 本机验收：默认 `C:\Program Files\EAB` 和自定义 `D:\...\install-test` 两条路径都安装成功；自定义路径安装后 `InstallLocation`、`UninstallString`、开始菜单和公共桌面快捷方式均指向自定义目录。卸载向导五页可走通，默认保留 `%APPDATA%\EAB\desktop-config.json`；程序目录、注册表卸载项、开始菜单和桌面快捷方式均被清理。安装器资源包含 `eab.ico`、`wizard.bmp`、`header.bmp`，窗口、快捷方式和卸载项共用该图标。
- 图标资源：`installer/assets/eab.ico` 必须是 Windows 能解析的多尺寸 ICO，由同目录 `eab.png` 生成 16/24/32/48/64/128/256 七个尺寸；安装段创建 `$INSTDIR\assets` 并释放该文件，快捷方式与 `DisplayIcon` 才能稳定显示品牌图标。
- 未完成：`dp_*` / `bp_*` pageId 统一、Web 到桌面的免登录握手、安装包代码签名、macOS/Linux 构建。安装包未签名，Windows 可能提示“未知发布者”；自动更新链路已落地，见下节。

#### 23.3.7.1 原生标签页对齐豆包浏览器（2026-11-26 第十一轮）

- 链接分流：`setWindowOpenHandler` 不再拒绝全部弹窗，`target=_blank`、`window.open`、Ctrl+点击、中键点击统一交给主进程 `openLinkInNewTab` / `openNativePage` 创建新的 `WebContentsView`；`background-tab` 在后台创建、不抢当前标签，其余前台激活。普通链接继续走 `will-navigate` 同页跳转，所有导航仍只允许 http/https、拒绝带账号密码 URL。
- 标签同步：新页通过 `eab:browser-tab-open` 广播给工作台，`chat.js` 的 `handleDesktopTabOpen` 把它加入标签栏；`eab:browser-state` 继续同步标题、favicon、加载状态和 URL。
- 原生右键菜单：链接菜单提供「在新标签页打开 / 在后台标签页打开 / 在系统浏览器打开 / 复制链接地址」；页面菜单提供后退、前进、刷新、复制页面地址、系统浏览器打开；输入框和选中文字额外提供编辑、复制。
- 快捷键：原生页 `before-input-event` 处理 Ctrl+T 新建空标签、Ctrl+W 关闭当前标签、Ctrl+Tab / Shift+Ctrl+Tab 切换、Ctrl+L 聚焦地址栏、Alt+←/→、F5/Ctrl+R；主窗口也补了一套 `scope=shell` 的快捷键，地址栏和新标签输入框里同样可用。`Menu.setApplicationMenu(null)` 移除 Windows 默认 Ctrl+W 加速键，避免抢网页标签快捷键。
- 焦点与布局：原生 `WebContentsView` 隐藏时会把系统键盘焦点留在隐藏页面，新增 `eab:focus-shell` / `eab:focus-page` 显式切换；新标签 IPC 到达时标签栏尚未布局，视图同步改为双 `requestAnimationFrame` + 180ms 兜底，避免偶发 0×0 空白。
- 地址栏：失焦时只显示 `host:port`，Ctrl+L 或点击聚焦时切回完整 URL；`focusBrowserAddress` 先把焦点从原生页收回主窗口，再填完整 URL 并全选。
- 验收：真实键盘和真实鼠标已验证普通链接同页跳转、`target=_blank` 新标签、`window.open` 新标签、Ctrl+点击后台标签、Ctrl+T/W/Tab/L、地址栏完整 URL、链接右键菜单；CDP 合成 Ctrl+点击不能触发 Chromium 的链接分流，不能作为失败依据。

#### 23.3.7.2 下载即绑定服务器（2026-11-26 第十一轮）

- 来源识别：安装器释放 `installer/scripts/detect-server-url.ps1`，读取安装包自身的 Windows `Zone.Identifier`（`HostUrl` / `ReferrerUrl`），只接受 http/https、拒绝带账号密码，输出 origin（例如 `http://127.0.0.1:8787`）。
- 写入位置：识别结果写入 `$INSTDIR\resources\app\desktop-config.json`，字段 `serverUrl`、`source:"installer"`、`updatedAt`。打包后 `main.mjs` 的 `here` 是 `resources\app`，写到安装根目录客户端读不到，这是本轮修正的关键。
- 兜底：构建时可用 `EAB_DESKTOP_SERVER_URL` / `EAB_DESKTOP_URL` 注入地址，`build-win-installer.mjs` 写入 `generated/build.nsh` 的 `SERVER_URL`；没有下载标记时仍可用构建地址或首次启动手动配置。
- 验收：带人工 ADS 的安装包静默安装后，`resources\app\desktop-config.json` 内容为 `{"serverUrl":"http://127.0.0.1:8787","source":"installer","updatedAt":"2026.11.24"}`；临时移走 `%APPDATA%\EAB\desktop-config.json` 后首次启动直接进入已登录工作台，没有出现“连接 EAB 服务”设置页。
- 边界：Chrome / Edge 下载是否保留 `HostUrl` 取决于浏览器和来源策略；安装器只信任安装包自身的下载标记，不读取任意本机文件。

#### 23.3.7.3 服务器驱动自动更新（2026-11-26 第十一轮）

- 服务端清单：`build-win-installer.mjs` 构建结束生成 `packages/desktop/release/desktop-release.json`，包含 `version`、`platform`、`arch`、`file`、`size`、`sha256`、`publishedAt`、`notes`。
- 服务端接口：`GET /api/desktop/update?platform=win32&arch=x64&currentVersion=...` 返回 `version / hasUpdate / downloadUrl / fileName / size / sha256 / publishedAt / notes / channel / source`；`GET /api/desktop/version` 返回当前可用版本。`downloadUrl` 固定相对路径 `/download/desktop/setup`，只从当前 EAB 服务器下载；`/download/desktop/setup` 优先返回清单里的同一个安装包，保证 SHA256 与实际文件一致。
- 客户端状态机：启动后 12 秒检查一次，之后每 4 小时检查；状态经 `eab:update-state` 广播为 `checking / current / available / downloading / ready / error`。发现新版本弹原生「下载并安装 / 稍后」，下载到 `%APPDATA%\EAB\updates`，边下边算 SHA256，校验 `size` 和 `sha256`，任务栏显示进度。
- 安装：下载完成后弹「立即重启并安装 / 稍后」；确认后写 `updates/apply-update.ps1`，用 `Start-Process -Verb RunAs` 触发一次 UAC，静默执行安装器 `/S`，完成后从 `HKLM\Software\EAB\InstallDir` 启动新客户端；脚本把退出码或异常写 `updates/apply-update.log`。
- 界面：发现更新时顶栏出现「发现 v<版本>」胶囊；下载中显示百分比；下载完成变实心「重启安装 v<版本>」；设置页「检查更新」显示当前版本、检查中、下载进度、已就绪或失败原因。点击胶囊或设置行分别执行检查 / 下载 / 安装，不新增常驻入口。
- 验收：临时把清单版本改为 `2026.11.25` 后，桌面端启动自动弹「发现 EAB 桌面版 v2026.11.25」，顶栏出现胶囊；下载进度到 100%，SHA256/大小校验通过后弹「已下载完成」；恢复清单后接口 `hasUpdate:false`，正式版本仍是 `2026.11.24`。修复了下载流未 `end()` 导致 `finished()` 永久等待、进度停在 81% 的问题。
- 未做：真正跨版本的“下载→静默安装→重启→版本变化”闭环需先确定下一版版本号并重新构建；安装阶段 UAC 仍需用户点一次“是”。

#### 23.3.7.4 内网 HTTP 语音与品牌图标（2026-11-26 第十二轮）

- HTTP 语音：Chromium 只在安全上下文暴露 `navigator.mediaDevices`。桌面端启动时读取当前配置，如果 EAB 服务是 `http://` 且不是回环地址，就在 `app ready` 前追加 `--unsafely-treat-insecure-origin-as-secure=<当前 EAB origin>`。这样 `http://192.168.x.x:8787` 下 `isSecureContext=true`、`mediaDevices` 可用，语音按钮和录音链路不再要求 HTTPS。
- 变更服务器：在首次配置页或设置页保存一个此前未声明的 HTTP origin 时，先落盘配置并自动重启一次，让新的可信来源在 Chromium 启动阶段生效；HTTPS、localhost 和同 origin 修改不重启。
- 作用范围：只信任当前 EAB 服务 origin，不把右侧用户自己打开的第三方 HTTP 站点一起提升为可信来源。生产环境仍建议 HTTPS；该开关是桌面客户端对内网 HTTP 部署的兼容措施。
- 验收（局域网 `http://192.168.1.13:8787`）：`isSecureContext=true`、`navigator.mediaDevices.getUserMedia` 存在；使用 Chromium 虚拟麦克风实际拿到 1 条 audio track，`voiceSupported()` 为 true；把 `state.transcribeAvailable` 置真后语音按钮可见。
- 品牌图标：`eab.ico` 重新生成为 16/24/32/48/64/128/256 多尺寸；构建便携版时用 `rcedit` 把 ICO、ProductName、FileDescription、FileVersion 写入 `EAB.exe`，安装器再释放一份到 `$INSTDIR\assets`。标题栏、任务栏、桌面快捷方式和资源管理器统一显示 EAB 图标，不再显示 Electron 原子图标或通用文件图标。

#### 23.3.7.5 Agent 原生操作右侧标签与标签持久化（2026-11-26 第十三轮）

**问题定位**
- 桌面右侧标签是主进程里的 `WebContentsView`，`pageId` 为 `dp_*`；Agent `browser` 工具原来只走服务端 Playwright，拿不到这些页面。
- 前端 `streamChat()` 没有走统一 `api()`，聊天请求缺少 `x-eab-desktop` / `x-eab-desktop-device`，服务端即使有桌面桥也无法把 browser 工具路由到桌面设备。这是首次实测 Agent 读不到右侧页面的直接原因。
- 主页面 reload 时旧代码在 `did-start-navigation` 里销毁全部 `WebContentsView`，刷新聊天页必然丢标签。

**实现**
- 服务端：`desktop-bridge.ts` 新增 `kind`、`resolveOnlineDevice`、`updateBrowserTabs`、`browserTabsFor`、`browserCall`；新增 `POST /api/desktop/bridge/tabs` 接收桌面端上报的 `{activePageId,tabs}`；`routes/tools.ts` 的 `case 'browser'` 按设备头路由，30 秒超时；`routes/chat.ts` 的 `compileSystemPrompt` 新增桌面标签块，最多列 8 条并标出当前页，明确要求“当前页面/右侧标签/这个按钮”先用 `browser action=list/snapshot`，不要用 `web.fetch` 抓同一网址代替。
- 桌面主进程：标签元数据写入 `desktop-config.json` 的 `browserTabs`，注册成功、标签变化和窗口关闭前上报；`browserTabsOwnerUserId` 做归属校验；`restoreBrowserTabsIfNeeded` 在启动或首次 `listTabs` 时恢复；`executeNativeBrowserJob` 执行 13 个动作；`NATIVE_SNAPSHOT_SCRIPT` 生成与 `BrowserElement` 对齐的 `e1/e2...`；`click` 禁提交表单，`type` 只写不提交。
- preload / 前端：`listTabs(userId)`、`activateTab(pageId)`、`onActivate`；`currentUserId()` 从 `state.me.person.id` 取员工 id；`restoreBrowserTabs()` 先恢复主进程存活标签，再补 `localStorage` 草稿，最后激活原活动页；`localStorage` 键为 `eab.chat.browserTabs.v1:<person.id>`；`streamChat()` 补桌面设备头；`onActivate` 让 Agent 切页时前端标签栏跟随。
- 审批：`requiresToolApprovalForArgs` 对 `browser` 分流，`list/snapshot/screenshot/scroll/activate` 免审批，`open/navigate/click/type/back/forward/reload/close` 逐次审批。

**真实桌面验收（本机 Windows，Electron 45.4.1 / Chromium 156）**
- 刷新聊天页：主进程保留 `dp_e252b9b29e4b`；前端 `listTabs` 后重新出现 `Example Domain`，右侧页面正常显示，`/frame` 请求为 0。
- 重启桌面端：恢复 3 个标签（`Example Domains`、GNU 空白页、`百度一下，你就知道`），活动页恢复为 `dp_e252b9b29e4b`，标签栏 3 个均显示。
- Agent `snapshot`（免审批）：返回标题 `Example Domain`、网址 `https://example.com/`、正文第一段，工具耗时 50ms；模型最终回复正确引用页面标题、网址和正文。
- Agent `activate` + `snapshot` + `click ref=e1`：从 `Example Domain` 点 “Learn more”，同一标签跳到 `https://www.iana.org/help/example-domains`，标题变为 `Example Domains`。
- Agent `activate` + `snapshot` + `type`：切到百度 `dp_ed2382267bba`，输入“EAB 企业智能体”，快照回读 `elements[].value` 为该文本，页面未提交。百度搜索框是无 `type` 的 `textarea`，本轮把类型判断改成 `node.type || getAttribute('type')`，缺省 input 按 `text` 处理。
- Agent `open https://example.org/`：新标签 `dp_eb34be844f46` 创建并激活，前端标签栏同步出现 `Example Domain`，共 4 个标签；证明 `eab:browser-tab-open` 广播链路有效。
- Agent `reload/back/forward`（审批）：在 `dp_e252b9b29e4b` 依次执行，`reload` 耗时 1.2 秒并重新读出 31 个元素；`back/forward` 调用成功（约 320ms），但该标签历史栈只有一个页面，URL 和标题未变化，不能证明多页历史位移。
- Agent `screenshot`（免审批）：对当前 `dp_eb34be844f46` 截图，服务端在个人云空间根目录生成 `浏览器截图-20261126065448.png`（44,558 字节），`view.screenshot` 返回 `fileId`、`name`、`relPath`。
- Agent `close`（审批）：关闭 `dp_eb34be844f46`，工具返回 `closed:true`；随后 `list` 返回剩余 3 个标签，活动页回到百度，前端标签栏同步减为 3 个。
- 回归：`node --check` 对 `main.mjs`、`preload.cjs`、`chat.js` 通过；`npm run typecheck` 通过；项目/系统提示 26 个用例、审批 13 个用例通过。

**尚未验收**
- 真实长页 `scroll` 的实际滚动位移；多页历史下 `back/forward` 的跳转。
- 失效 URL 恢复后可能变成空白标签（GNU 错误页已出现），前端还没有“已失效 URL 清理”。
- 测试标签（IANA / GNU 空白 / 百度）与测试审批记录尚未清理。
- 本轮安装包已重建，版本仍是 `2026.11.24`；新版 `EAB-Setup-2026.11.24-x64.exe` 为 `113,052,393` 字节，SHA256 `3a8b2bcd8896eaea899a8feda61de03a7a40d17b9f76440077fa8abac143290d`。同版本旧客户端不会收到自动更新提示，需要手动重新安装。

**桌面本地项目读取修复（2026-11-26）**
- 现象：桌面端新建项目弹窗工作目录一直显示“添加本地文件夹”，底部停在“正在读取桌面设备…”，创建按钮不可用。
- 根因不是 Windows 文件权限，而是安装测试版用的是旧桌面包：`preload.cjs` 只有 `isDesktop`，没有 `getDesktopInfo / pickDirectory / bindProject`；`main.mjs` 也没有 `local-files` 模块。前端 `ensureDesktopInfo()` 因接口不存在直接返回空，设备标签永远不会变成已识别状态。
- 构建缺陷：`scripts/build-win-portable.mjs` 原来只复制 `main.mjs / preload.cjs / setup.html`，漏了 `main.mjs` 启动即 import 的 `local-files.mjs`，即使重新打包也会因缺模块启动失败。已把复制列表改为 `main.mjs / preload.cjs / local-files.mjs / setup.html`。
- 修复后真机验收：安装版 `getDesktopInfo()` 返回 `dev_8a74b97ce0e94d8dbda90d74e0a57e78 / DESKTOP-LK59VNR / win32 / x64`，弹窗底部显示 `DESKTOP-LK59VNR · 项目目录保存在这台电脑上`；点击“添加本地文件夹”能打开 Windows 原生目录对话框；`bindProject('lp_probe123','D:\\AI kaifa\\EAB')` 与 `unbindProject` 均成功。
- 打包验收：新建的 `release/EAB-Desktop-Windows-x64/resources/app` 含 `local-files.mjs`（21,223 字节），`preload.cjs` 含项目接口，`main.mjs` 含 `import './local-files.mjs'`；启动便携包后 `getDesktopInfo / pickDirectory / bindProject` 均为 `function`，设备信息正常返回。

#### 23.3.7.6 项目侧栏纯文件夹化与文件删除（2026-11-26）

**交互调整**
- 本地项目从“项目主页 + 文件树 + 分组标签”收口为可折叠的本地文件夹：项目行只保留文件夹图标、项目名和更多菜单，不显示展开/收起箭头；去掉“桌面端在线/离线”副标题，项目下不再显示「对话 / 工作任务」标签，任务用紫色图标区分。
- 项目行点击仍切换折叠/展开，折叠状态写 `localStorage` 键 `eab.chat.collapsedProjects.v1:<userId>`；新建项目或新建项目会话时强制展开。项目下只挂会话行，不再渲染“＋ 新建对话”虚线按钮，也不再显示项目文件列表；新对话从项目“⋯”菜单进入。
- 项目内会话复用普通会话菜单：悬浮“⋯”和右键都打开 `#session-menu`，支持重命名、删除；删除仍走会话软删除确认卡。项目操作菜单改为新建对话、新建工作任务、打开文件夹、重命名、移除项目，不再有“项目主页”。
- 项目主页 `#project-pane` 和 `openProjectHome/renderProjectHome` 暂保留但无入口，页面保持隐藏；`renderLocalProjectSide()` 不再显示 `#side-local-files`，`applySessionSpace()` 不再启动 5 秒项目文件轮询。`chat.html` 已移除 `#side-local-files / #local-file-list` DOM。
- 项目文件不再占左侧栏，但 Agent 仍可通过 `project.list/read/search/write/edit` 在项目目录内创建、读取、修改文件；新建目录由 `project.write` 自动创建父目录实现。

**输入区项目选择器与会话归属**
- 桌面端点击输入区「云空间」chip 打开豆包式项目选择器：列出本机项目（文件夹图标 + 名称），当前项目行显示根路径和勾选；底部提供「创建新项目」和「不使用项目」。Web 端仍保留云空间 / 不使用文件空间的简洁菜单。
- 选择项目时直接调用 `PATCH /api/chat/sessions/:id/space` 把当前已有会话归入该项目；未落库的新对话只更新前端待发送状态，下一条消息随 `spaceKind/spaceId` 持久化。选择「不使用项目」退回云空间。
- 归属接口只改 `chat_sessions.space_kind/space_id`，不动消息、标题和 `updated_at`；本地项目校验归属员工与 `local-space:read` 权限，项目不存在返回 404。切换后头部仍显示原会话标题，不把项目名写成对话名。
- 从选择器进入「创建新项目」时，创建成功后把当前对话直接归入新项目；从侧栏「新建项目」进入时只创建项目，不抢占当前对话。
- 未落库新对话归入项目后，切换项目不会创建空会话；已有会话的重命名、删除、任务徽标仍按原会话链路处理。

**文件删除**
- `project.delete` 新增到工具目录和能力清单，只允许删除**文件**，路径相对项目根；目录必须拒绝，避免一次误删整棵树。项目 `mode='read_only'` 时拒绝。
- 桌面桥 `DesktopFileOp` 增加 `delete`，`local-files.mjs` 增加 `deleteText()`；校验根边界、敏感文件和 realpath 后再 `unlinkSync`。服务端本机兼容路径在 `project-files.ts` 增加同语义 `deleteProjectEntry()`。
- 风险等级 `irreversible`，每次执行都走工具审批；不会把磁盘绝对路径交给模型。

**真实桌面验收**
- 项目侧栏 DOM：`projectCount=1`，`hasLocalFiles=false`，`projectPaneHidden=true`，`projectRowText=dsh-ding-card`（无“桌面端在线”），`hasStatus=false`，`hasKidsLabel=false`，`hasCaret=false`，`hasQuickStart=false`。
- 折叠/展开：点击项目行后 `aria-expanded=false`、`.project-children.hidden=true`；`localStorage` 写入折叠项目 id；再点恢复展开。
- 项目选择器：初始 `spaceKind=cloud` 时菜单为「dsh-ding-card / 创建新项目 / 不使用项目 ✓」；选中项目后 chip 变为项目名，项目内会话子项从 0 变 1；再次打开菜单显示项目根路径与勾选。点「不使用项目」后 `spaceKind=cloud`，项目子项回到 0。
- 刷新恢复：对已有会话执行归属后重新打开，返回 `spaceKind=local`、正确 `spaceId` 和 `project`，chip 与项目分组同步恢复。
- 会话菜单：项目内会话“⋯”打开 `#session-menu`，显示“重命名 / 删除”；删除确认卡目标为「侧栏交互验收」，确认后项目子项从 1 变 0。
- 项目菜单：显示“新建对话 / 新建工作任务 / 打开文件夹 / 重命名 / 移除项目”，无“项目主页”。
- 后端：`project.delete` 删除文件成功且大小正确，目录删除返回“只能删除文件”，越界路径返回 forbidden；`PATCH /api/chat/sessions/:id/space` 本地项目/云空间往返通过，缺失项目与会话返回 404；桌面 `deleteText` 同样通过缺失文件、目录和 `../` 越界测试。
- 回归：`node --check chat.js`、`node --check local-files.mjs`、`npm run typecheck` 通过；`local-project.test.ts` 5 个、`tool-approval.test.ts` 7 个、`chat-session-space-route.test.ts` 2 个用例通过。

#### 23.3.7.7 豆包式桌面侧栏第一轮（2026-11-26）

**布局与固定导航**
- 左侧栏改成“顶部固定导航 → 中部滚动项目/最近 → 底部紧凑账号与设置”三段式，不再把用户大卡片、项目区、最近区、云空间文件列表和分隔条依次堆叠。
- 顶部固定导航为：`新工作任务`、`新对话`、`工作台`、`定时任务`、`插件·技能·伙伴`、`云空间`、`更多`。图标统一为 18px 线性 SVG（方框笔、聊天气泡、四宫格、时钟、叠层方块、文件夹、四格更多），和豆包桌面版保持同一类线性语言。
- `云空间`放在固定导航的“资料库”位置，点击打开右侧云空间面板；侧栏底部原来的 `#side-files` 文件列表、`#side-split-resizer` 上下拖拽条和配额角标已从 DOM 移除。输入区 chip 仍负责把当前会话归属到项目/云空间，二者职责分开。
- 中部滚动区不再显示“项目 / 新建项目”标题和按钮，直接显示项目行；项目行使用浅灰底 20px 线性文件夹图标、项目名和悬浮“⋯”，不显示箭头、不显示绿色虚线“新建对话”。项目列表之后显示“最近”，独立会话行左侧统一加淡蓝圆底聊天气泡图标；工作任务行使用方框笔图标和淡紫圆底。
- 底部用户信息收成紧凑两行：28px 头像、姓名、职位；公司/部门/角色明细只在设置页完整展示。下面固定“设置”入口。
- `更多`是右侧浮出菜单，当前承载四个真实入口：新建项目（仅桌面端）、打开云空间、管理后台（按 `/api/me/console-entry` 可见性同步，是唯一入口）、设置；四项图标统一为线性 SVG。点击外部或按 Esc 收起。
- 员工端聊天页头部不再放“管理后台”按钮（原 `#console-entry` 已移除），避免把管理入口与日常对话操作混在同一排；后台入口收进 `更多`，点击后仍走 `POST /api/me/console-entry/session` 换取跳转地址并携带当前 `company` 与 `from=chat`。

**导航动作**
- `新工作任务`：项目内调用 `createProjectSession(project,'task')`；云空间创建 `projectMode='task'` 的独立任务，头部显示任务徽标，最近列表用任务图标。
- `新对话`：复用 `newSession()`；项目内创建项目对话，云空间回到空白新对话。
- `工作台`：`setChatMode('workspace')`，保留上次工作台子页。
- `插件·技能·伙伴`：进入工作台并切到插件子页（`setWorkspaceKind('plugins')`）。
- `云空间`：`openCloudSpacePane()`，右侧全宽文件浏览，不占用左侧项目/对话滚动区。

**定时任务浮层**
- 该浮层后来由独立定时任务页替代，页面布局与文案规则见 23.3.7.15；以下保留当轮浮层验收记录。
- 新增 `#schedule-modal`，从员工端 `GET /api/schedules` 读取任务，展示标题、状态、下次执行/上次执行、执行模式（对话/工作任务/单次）、渠道（网页/钉钉）。
- 状态映射：`active→运行中`、`paused→已暂停`、`running→执行中`、`done→已完成`、`error→失败`、`cancelled→已取消`；已完成/失败/取消不再把旧的 `nextRunAt`伪装成“下次执行”。
- `active` 可暂停、`paused` 可恢复，分别调用 `POST /api/schedules/:id/pause|resume`；支持刷新；空态提示在对话里描述周期任务，由 Agent 创建。
- `新建`不单独做表单，先开一个新对话并预填“帮我创建一个定时任务：”，让 Agent 继续走现有 `schedule` 工具审批链。

**兼容与清理**
- `#new-session`、`#new-project` 旧按钮从 `chat.html` 移除；`bindSideNav()` 接管顶部动作，旧的 `#new-project` 绑定保留 `?.` 兜底。
- 底部云空间文件区移除后，`#ws-new-folder`、`#ws-upload`、`#ws-input`、`#ws-upload-status` 的绑定全部改为可选链；`#ws-list/#ws-path` 渲染函数保持空值保护，不再影响启动。
- 项目行保留 `data-project-toggle` 折叠能力；`renderLocalProjects()` 只渲染项目与会话，不渲染项目主页。当前项目为空时提示“点上方「更多」→ 新建项目”。

**真实桌面验收**
- 固定导航 7 项全部存在，旧节点 `#new-project/#new-session/#side-files/#side-split-resizer` 查询均为 false；侧栏宽度 264px，中部滚动区 `scrollHeight=clientHeight=462`（当前数据量下不溢出）。
- 最近会话图标：普通会话 `.side-session-icon`、任务会话 `.side-session-icon.is-task` 均渲染；钉钉来源徽标仍保留。
- 顶部新工作任务：创建 `spaceKind=cloud`、`projectMode=task`、标题“新工作任务”的会话，头部任务徽标显示，最近行出现任务图标；测试后已删除临时会话。
- 项目内任务：`createProjectSession(project,'task')` 返回 `spaceKind=local`，项目子会话从 0 变 1，子行图标为 `.project-child-icon.is-task`，最近列表不重复出现该会话；测试后已删除临时会话。
- 定时任务浮层：打开后读取 3 条历史任务，卡片 540×329.5，已完成任务显示“上次 2026/11/24 14:00”，不再显示“下次”；关闭按钮、刷新、空态、Esc 路径可用。
- `更多`菜单：浮层 186×148.6，包含“新建项目 / 打开云空间 / 管理后台 / 设置”，`aria-expanded=true`，点击外部收起。
- 工作台 / 插件 / 云空间 / 新对话动作均返回预期状态：`mode=workspace`、`workspaceKind=plugins`、`tab=cloud`、`mode=chat`；从云空间切回新对话时会关闭右侧云空间面板。
- 回归：`node --check chat.js` 通过；后端本次未改，沿用 7 个会话归属/项目测试结果；普通启动（不带 9334 调试参数）后主窗口正常显示新侧栏。

**仍未做**
- 本轮只完成桌面侧栏第一轮视觉与导航收口；启动耗时、首屏渲染、长列表滚动、侧栏虚拟化等性能基线尚未测量。
- 定时任务“新建”仍依赖对话创建，未做完整创建表单；运行中任务的实时进度也未单独展示。
- 云空间从侧栏文件列表改为右侧面板后，窄屏下右侧面板与对话的切换仍需继续优化。

#### 23.3.7.8 桌面体验对齐豆包的阶段目标（2026-11-26 规划）

本轮完成的是侧栏结构与视觉语言的第一轮收口，以下为后续逐步改造的方向，尚未实施：

1. **交互与视觉一致性**：深色主题真实验收、窄屏布局、会话搜索、项目内显式新建入口、右键/更多菜单统一；动效只使用 `transform/opacity`，控制在 100–200ms，并保留 `prefers-reduced-motion` 降级。
2. **性能基线**：先测冷启动到可交互、首屏渲染、会话列表首帧、长列表滚动帧率和常驻内存；再做列表虚拟化/分批渲染、会话缓存、按需加载工作台与云空间、减少启动时重复请求。侧栏在 200 条会话下应保持首帧可读且滚动不卡顿。
3. **桌面壳能力**：快捷键（新对话/新工作任务/搜索/设置）、启动恢复上次会话、托盘与更新提示、异常退出恢复；先保证稳定和可测，再追求与豆包桌面版同级的响应速度。

#### 23.3.7.9 桌面与网页五项体验修正（2026-11-26 第二轮）

**需求与结论**

1. **新工作任务 / 新对话要立即区分并立即入列**：两者不再只重置本地空白状态，而是分别创建 `projectMode='task'` 和 `projectMode='chat'` 的会话；会话一创建就刷新“最近”并打开，不再等首条消息。当前已是同类型空白会话时只回到输入框，避免连点产生多条空记录。
2. **个人信息卡回到顶部**：`#side-user` 从 `.side-bottom` 移到品牌区下方、固定导航上方，显示头像、姓名、职位、公司/部门一行和在线点；底部只保留“设置”。
3. **工作台与插件入口都在工作台内部**：`工作台` 调用 `setChatMode('workspace')` 并保留上次子页；`插件·技能·伙伴` 进入同一工作台并切到插件子页；两者都是右侧工作台内页，不跳外部页面，侧栏对应入口有选中态。
4. **没有项目时不占位**：项目数为 0 时整块 `#side-projects` 收起，不再渲染虚线加号、“还没有项目”和“点上方「更多」→ 新建项目”空态。
5. **网页端可看到并继续桌面项目会话**：网页端“最近”混排当前账号的本地项目会话，行内显示项目徽标和“桌面在线/离线”；打开后恢复项目、项目指令和 `spaceId`，输入区项目选择器可切换归属；文件工具按 `deviceId` 经桌面桥转发。不同电脑登录同一账号，只要项目所属电脑在线，另一台电脑即可继续该项目对话并读写该项目文件。

**实现位置**

- `chat.js`：`openNewSession(mode)` 统一两个新会话入口；`newSession({create:false})` 只留给启动引导和定时任务草稿；`openSession()` 头部标题改为 `session.title`，项目名进 `#chat-project-badge`，任务徽标只由 `projectMode='task'` 控制；首条消息在标题仍为“新对话/新工作任务”时用首条文字更新本地标题。
- `chat.js`：`renderSessions()` 网页端包含 `spaceKind='local'` 会话，桌面端仍把项目会话挂在项目树；`renderSpaceMenu()` 两端共用项目列表，网页端行内显示设备在线状态且不显示“创建新项目”；`assignConversationSpace()` 允许网页端把已有会话归入远程项目。
- `chat.html` / `chat.css`：顶部 `side-profile-card`、项目徽标、设备徽标；项目选择器名称优先、路径让位截断。
- `packages/server/src/routes/chat.ts`：`GET /api/chat/sessions` 返回 `projectDeviceOnline`；历史与 `PATCH /api/chat/sessions/:id/space` 返回 `project.deviceOnline`；`ensureSession()` 对标题仍为默认名且已有首条文本的会话自动命名，用户手改过的标题不覆盖。

**网页端实测（2026-11-26）**

- 侧栏顶部个人信息卡显示“李鹏 / 技术员 / 重庆居易智能科技有限公司 / 重庆东环线组”，在线点正常；项目数为 0 时 `#side-projects.hidden === true`，没有空项目块。
- 临时远程项目会话实测：网页“最近”从 2 条增到 3 条，项目行显示 `远程项目验收` + `桌面在线`；打开后头部为“远程项目验收 / 远程项目任务 / 工作任务 / 桌面在线”，输入区 chip 为“远程项目验收”。在该会话发送“只回复 OK，不要调用任何工具”后返回 `OK`（Kilo Auto Free，70.1 tok/s），远程项目对话闭环成立；验证后临时项目、会话、消息和目录均已清理。
- 依次点击“新工作任务”“新对话”：会话数从 3 → 4 → 5，列表立即出现“新工作任务”和“新对话”，任务行有任务图标；前者头部显示工作任务徽标，后者不显示，标题不再被项目名覆盖。
- 工作台和插件入口均进入右侧工作台内页，侧栏高亮分别落在“工作台”和“插件·技能·伙伴”。
- 清理临时项目/会话后，“最近”回到 2 条，项目区保持隐藏；`node --check chat.js`、`npm run typecheck` 通过；`chat-session-space-route.test.ts` 2 条与 `local-project.test.ts` 5 条通过。

**边界与未完成**

- 跨设备当前开放的是“项目对话 + 项目文件读写”，**没有开放远程 shell/`project.exec`**；构建、测试、启动服务仍需在项目所属电脑本地执行。
- 远程文件链路要求项目在桌面端正常绑定。验收中通过 REST 直接创建的临时项目没有进入桌面桥 `bindings`，文件列表返回 `EAB_CONFLICT`；正常从桌面端“新建项目”创建会同时绑定，此路径已在前序真机验收通过。
- 安装包仍是 `2026.11.24`，未按本轮源码重建；桌面端旧安装包需重装或更新后才能看到新侧栏。
- 网页端“最近”采用“项目会话混入最近 + 项目徽标”的扁平形态，没有保留桌面端项目分组；自动命名也尚无专门单测。

#### 23.3.7.10 项目入口与右侧标签页会话隔离（2026-11-26 第三轮）

**需求与结论**

1. **云空间不再作为可选入口**：云空间是平台自带能力，对话选不选都可用，因此输入区不再显示绿色“云空间”胶囊，也没有必要让用户主动选择空间。
2. **改成豆包式“项目”入口**：输入区显示中性灰胶囊，内容为线性文件夹图标 + “项目” + 右箭头；未归属项目时固定显示“项目”，归属后显示项目名。菜单仍包含当前账号项目、创建新项目和“不使用项目”，但“不使用项目”只表示不把对话挂到项目，不代表失去云空间。
3. **右侧网页标签跟对话绑定**：每个对话各自维护一份标签栏和当前活动标签。切到没开过标签的对话时右侧网页栏整块隐藏；切回开过标签的对话时恢复该对话的标签、活动标签和工作台展开状态。网页端与桌面端同一规则。

**实现位置**

- `chat.html` / `chat.css`：`#space-chip` 改为文件夹 SVG + “项目” + 右箭头；中性灰底 `#f3f4f5`、透明边框、深灰文字，hover `#ebedef`，不再有绿点和绿色描边；`.caret` 在展开时旋转 90°。
- `chat.js`：`renderSpaceChip()` 未归项目固定显示“项目”，归项目显示项目名；`renderSpaceMenu()` 保留项目列表、创建新项目和“不使用项目”；`assignConversationSpace()` 退出项目时提示改为“已取消当前对话的项目归属”，云空间后端默认 `spaceKind='cloud'` 和文件工具不变。
- `chat.js`：标签快照存储改为 `eab.chat.browserTabs.v2:<userId>:session:<sessionId>`，无会话时用 `:draft`；`switchBrowserTabScope()` 切会话前先保存旧会话、再清空并通知桌面主进程切换；`restoreBrowserTabsForSession()` 只恢复当前会话的标签；`ensureBrowserTab()`、`newBrowserDraftTab()`、`handleDesktopTabOpen()` 都带 `sessionId` 归属和守卫。
- `chat.js`：`browserTabsLoadedScope` 用 `null` 表示“尚未恢复完成”，`persistBrowserTabsNow()` 在恢复完成前拒绝落盘，避免切换会话时把清空后的标签栏覆盖成空数组；这是“切回会话标签不恢复”的根因修复。
- `packages/desktop/main.mjs` / `preload.cjs`：主进程新增 `activeChatSessionId`、按会话的 `browserTabsPayload()`、`setActiveChatSession()`、v2 配置结构 `{version:2, ownerUserId, activeSessionId, sessions:{sessionId:{activePageId,tabs}}}`、按会话恢复、`entry.sessionId`、`browserTargetEntry()` 会话校验；IPC 新增 `eab:set-browser-session`，`eab:browser-tabs` 改为 `(userId, sessionId)`，激活、显示、bounds、关闭都只操作当前会话的页面。
- `packages/server/src/desktop-bridge.ts` / `routes/desktop-bridge.ts`：设备状态里的标签快照改为 `browserTabsBySession: Map<string, snapshot>`，每个对话一份，设备最多保留最近 40 个对话；`browserTabsFor(company,user,device,sessionId?)` 按会话返回。系统提示和桌面 `browserCall` 都带 `sessionId`。

**验收**

- 网页端：输入区显示中性“项目 >”胶囊，无绿点和“云空间”字样；项目菜单可打开。
- 网页端会话 A 打开“新标签页”后右侧展开；切到没开过标签的“钉钉·对话”后 `#workbench-rail.hidden === true`、标签栏为空；切回 A 后标签栏恢复为“新标签页”，刷新页面后仍能恢复。
- 桌面端用源码 `electron .` 实测：空会话开草稿标签能展开；切到另一个没标签的会话整块隐藏；切回后草稿标签恢复。把草稿升级为真实 `https://example.com` 原生标签后，`listTabs` 返回 `sessionId` 为该会话、`pageId` 独立；切走再切回，原生标签恢复；重启桌面进程后仍按会话恢复。
- `node --check chat.js / main.mjs / preload.cjs`、`npm run typecheck` 通过；新增 `desktop-bridge-tabs.test.ts` 2 条，连同会话项目归属 2 条、本地项目 5 条共 9 条通过。

**边界与未完成**

- 云空间仍是所有对话的默认文件空间，后端 `spaceKind='cloud'`、上传、文件工具和配额都没有改；本轮只是不再把它做成输入区的可选项。
- 桌面原生 `WebContentsView` 采用“非当前会话隐藏保活”，没有销毁重建；长期多对话会累计页面对象，后续需要按 LRU 或标签上限回收。
- 旧版全局标签只作为“无会话草稿”兜底读取一次，不迁移到具体会话；已删除会话遗留的 v2 localStorage 快照不会被自动清理。
- 本轮桌面端是源码启动验收，安装包仍是 `2026.11.24`，未重建；打包版要看到同样效果需重新构建并安装。
- 已验收“网页标签只在前端隔离”；网页端没有原生 `WebContentsView`，其网页标签由服务端 Playwright 承载，不走桌面主进程的按会话视图。

#### 23.3.7.11 云空间文件管理：新建、右键与拖拽上传（2026-11-26 第四轮）

**需求与结论**

1. **补全头部入口**：右侧云空间面板顶部在“刷新”旁增加“新建文件夹”“上传”，都作用于当前面包屑目录，不再只做只读浏览。
2. **文件/文件夹右键**：文件和文件夹行都支持右键浮出操作菜单，文件为打开、下载、重命名、编辑、发送到钉钉、删除；文件夹为打开、新建子文件夹、新建文件、重命名、删除。文件夹含他人共享文件时，整体重命名/删除沿用原有限制。
3. **空白区右键**：云空间列表空白处或空目录里的右键菜单为“新建文件夹 / 新建文件 / 上传文件”，和 Windows 文件系统的当前目录操作一致。
4. **拖拽上传**：从桌面或浏览器拖入文件到云空间面板，直接上传到当前目录；拖入期间显示“松开即可上传 + 目标目录”虚线高亮，上传后保留当前目录并显示进度。
5. **两端一致**：按钮、右键菜单、拖拽上传全部实现在共享的 `chat.html / chat.css / chat.js` 渲染层。网页端和桌面端使用同一套 UI 与同一后端接口；桌面端只是多一个 `window.eabDesktop` 原生网页桥，不另做一套文件面板。

**实现位置**

- `packages/server/public/chat.html`：`.cloud-pane-actions` 增加 `#cloud-pane-new-folder`、`#cloud-pane-upload`、`#cloud-pane-refresh`；新增隐藏的 `#cloud-upload-input`、`#cloud-upload-status` 和 `#cloud-drop-hint`。
- `packages/server/public/chat.css`：新增 `.cloud-pane-actions`、`.cloud-action`、`.cloud-icon-btn`、`.cloud-drop-hint`、`.cloud-pane.is-drop-target`；拖拽提示使用虚线边框和半透明遮罩，不改变正文布局。
- `packages/server/public/chat.js`：`bindCloudSpaceActions()` 绑定头部按钮、文件选择、空白右键和 `dragenter/dragover/dragleave/drop`；`renderCloudSpacePane()` 为文件夹/文件行绑定 `contextmenu`，并区分 `scope='cloud'`。
- `packages/server/public/chat.js`：复用现有 `createWorkspaceFolder()`、`renameWorkspaceFolder()`、`deleteWorkspaceFolder()`、`renameWorkspaceFile()`、`deleteWorkspaceFile()`、`openWorkspaceFile()`、`downloadWorkspaceFile()`、`editWorkspaceFile()`、`sendWorkspaceFileToDingTalk()`；没有另造一套文件 API。
- `packages/server/public/chat.js`：新增 `createWorkspaceFile()` 与 `workspaceFileNameError()`，创建空文本文件前检查同名文件和文件夹，避免静默覆盖；`uploadWorkspaceFileWithProgress()`、`uploadWorkspaceFiles()` 增加 `parentPath` 参数，云空间上传写入当前目录，而不是侧栏工作区目录。
- `packages/server/public/chat.js`：`showFileMenu()` / `showFolderMenu()` 增加 `scope` 参数和 `dataset.scope`，文件夹“打开”在云空间面板调用 `setCloudSpacePath()`，侧栏调用 `setWorkspacePath()`；`showCloudBlankMenu()` 负责空白区菜单。文件夹重命名/删除同时校正 `state.cloudSpacePath`。
- 后端沿用 `POST/PATCH/DELETE /api/workspace/folders`、`POST/PATCH/DELETE /api/workspace/files`、`GET /api/workspace/files/:id/download`，本轮未新增后端接口。

**验收**

- 网页端：头部显示“新建文件夹”“上传”和刷新按钮；右键 `README.md` 出现“打开 / 下载 / 重命名 / 编辑 / 发送到钉钉 / 删除”；右键空白区出现“新建文件夹 / 新建文件 / 上传文件”。
- 网页端实测通过右键新建文件夹“右键验收”、进入空目录后右键新建文件“验收文件.txt”、通过文件选择上传 `eab-cloud-upload-test.txt`、模拟拖拽上传“拖拽验收.txt”，并在右键菜单中完成文件重命名和删除；最后删除“右键验收”文件夹，`README.md` 与 `AGT-08_测试用例摘要.md` 恢复为根目录仅有两项。
- 桌面端源码 `electron . --remote-debugging-port=9222` 实测：云空间头部按钮与网页一致；`README.md` 右键菜单一致；空白区菜单一致；通过 `DataTransfer` 拖拽上传“桌面拖拽验收.txt”，上传进度与目标目录提示正常，随后删除该验收文件并关闭调试端口，恢复普通桌面启动。
- 拖拽高亮截图：`C:\Users\shq\AppData\Local\Temp\eab-cloud-drop-hint-final.png`；桌面云空间截图：`C:\Users\shq\AppData\Local\Temp\eab-desktop-cloud-pane.png`。
- `node --check chat.js`、`node --check main.mjs`、`npm run typecheck` 通过；`desktop-bridge-tabs.test.ts` 2 条、`chat-session-space-route.test.ts` 2 条、`local-project.test.ts` 5 条、`workspace-folders.test.ts` 6 条，共 15 条通过。

**边界与未完成**

- 拖拽只处理 `DataTransfer.files` 中的文件，不递归上传整个文件夹；拖入纯文件夹时提示“暂不支持直接拖入文件夹”。
- 单个文件沿用云空间上传上限 50 MB（面板侧）；后端 `POST /api/workspace/files` 的 `bodyLimit` 为 80 MB，大文件分片/对象存储直传仍未做。
- “新建文件”创建空文本文件，不内置内容编辑器；创建后通过右键“打开/编辑”进入现有预览与编辑器。
- 安装包仍是 `2026.11.24`，本轮只更新源码；打包版需重新构建并安装后才能看到同样界面。

#### 23.3.7.12 会话与右侧多标签收口：空草稿不登记、标签按会话常驻（2026-11-26 第五轮）

**需求与结论**

1. **右侧标签跟随对话**：打开几个标签就挂几个标签；切换对话、切走页面、刷新页面都不自动关闭，只有用户手动点 × 才消失。
2. **标签不跨对话串**：A 对话的网页、云空间、文件预览、Agent 团队、审批、工作台激活页只在 A 显示；切到 B 时 B 只恢复自己开过的标签，不继承 A 的。
3. **空对话不进左侧列表**：用户没有发出第一条消息前，不生成列表条目、不生成标题。点“新对话 / 新工作任务”只在右侧开临时空白态。
4. **空对话切走即丢弃**：首条消息前关闭标签、切到别的对话或切到工作台，临时草稿直接丢弃，不在 localStorage 留快照，也不在数据库留空会话。
5. **首条消息才登记**：发出第一条用户消息后，后端 `ensureSession()` 创建会话并落首条消息，前端用第一句话（前 24 字）作为标题，同时把草稿里已打开的右侧标签整体改归这个正式会话。
6. 本节覆盖此前 §0.2/23.3.7.9 中“新会话立即 POST 落库并 `loadSessions()`”的做法：即时创建改为首条消息后创建。

**实现位置**

- `packages/server/src/routes/chat.ts`：`GET /api/chat/sessions` 拿到读源行后，按 `chat_messages` 中是否存在 `role='user'` 批量过滤。一次 `SELECT DISTINCT session_id ... WHERE session_id IN (...)` 覆盖 SQLite / PostgreSQL 两种读源，不做逐行 N+1；预创建空会话、历史无消息会话都不返回。
- `packages/server/public/chat.js`：`enterBlankDraft()` 维持纯前端草稿（`state.sessionId=null`、`state.draftSession` 记录 mode/space），`openNewSession()` 同类型草稿只回输入框，换类型时先 `discardDraftSession()`。
- `packages/server/public/chat.js`：新增 `discardDraftSession()`、`discardDraftBrowserTabs()`、`removeDraftBrowserTabsStorage()`。空白草稿的 `persistBrowserTabsNow()` 直接返回并删除 `:draft` 快照；`restoreBrowserTabsForSession('')` 清空标签、不读旧 draft 快照，刷新后是全新空白态。
- `packages/server/public/chat.js`：新增 `currentWorkbenchShell()` / `applyWorkbenchShell()` / `clearWorkbenchShell()`。v2 快照新增 `shell` 字段，保存 `cloudSpaceOpen`、`cloudSpacePath`、`teamTabOpen`、`permOpen`、`filePreviewId`、`filePreviewSplit`、`workbenchTab`、`workbenchCollapsed`、`workbenchSplit`；兼容旧快照只有 `workbenchTab/collapsed/split` 的形态。
- `packages/server/public/chat.js`：`switchBrowserTabScope()` 切走前保存正式会话的网页标签与工作台外壳；旧 scope 是空白草稿时改为丢弃并关闭真实页面。切到新 scope 后由 `restoreBrowserTabsForSession()` 恢复自己的云空间、文件、团队、审批与网页标签；文件按保存的 id 异步重开，云空间按保存的路径刷新，审批重新加载。
- `packages/server/public/chat.js`：新增 `adoptBrowserTabsForSession(sessionId)`。首条消息 `meta` 返回新 `sessionId` 且仍停在草稿时，把 `browserTabsScopeSessionId` 从 `''` 改成正式会话、更新每个 tab 的 `sessionId`、删 draft key、按正式会话持久化。
- `packages/desktop/main.mjs` + `preload.cjs`：新增 `eab:adopt-browser-session` IPC。主进程只收养明确列出的、当前 `sessionId=''` 的原生 `WebContentsView`，把其 `sessionId` 改为正式会话并切换 `activeChatSessionId`；非法 sessionId 或非草稿标签不收养。
- `packages/server/public/chat.js`：`setChatMode()` 移除无条件的 `closeWorkspaceFile()`，切对话/切模式不再自动关文件标签；由会话切换逻辑负责保存/恢复。`closeWorkbenchKind('cloud')` 等手动 × 仍按用户动作关闭。

**验收**

- 网页真实服务：`POST /api/chat/sessions` 新建空会话后 `GET /api/chat/sessions` 的 `visible=false`；删除探针后列表只剩有用户消息的「钉钉 · 对话」「测试一下图表渲染」，原空「新工作任务」也被隐藏。
- 网页草稿：点「新对话」后左侧列表条数不变；在草稿开网页标签或云空间后 `localStorage` 的 `:draft` 仍为 `null`；切到已有对话后网页标签为 0、云空间自动关闭；再开新对话仍为 0 标签、0 云空间。
- 会话隔离：A 开云空间切 B，B 无云空间标签；切回 A 云空间恢复。A 开 `README.md` 切 B，B 无文件标签；切回 A 文件恢复为 `README.md`。A 开 `https://example.com` 切 B，B 0 标签；切回 A 恢复同一 `bp_...` 页面，手动 × 后标签归 0。
- 首条消息：草稿开一个空白网页标签，发送“只回复OK”后新会话进入左侧列表、标题为「只回复OK」，`state.sessionId === browserTabsScopeSessionId`、标签 `sessionId` 全部改为新会话、draft key 为空；验收后删除该会话。
- 刷新恢复：A 的云空间标签在刷新后自动恢复；标签只随用户手动关闭消失。
- 桌面源码 CDP：`eabDesktop.adoptBrowserSession('chat_desktop_probe',[pageId])` 返回 `adoptedCount=1`；收养后 `listTabs(...,'chat_desktop_probe')` 为 1、空白 scope 为 0；非法 sessionId 返回 `ok=false`；关闭页面后该会话标签为 0。桌面源码实例因独立 profile 未登录，只验收主进程 IPC，未重复整套聊天 UI。
- `node --check chat.js / main.mjs / preload.cjs`、`npm run typecheck` 通过；`desktop-bridge-tabs 2` + `local-project 5` + `workspace-folders 6` + `chat-session-space-route 3`，共 16 条通过。

**边界与未完成**

- 空会话只在 `GET /api/chat/sessions` 隐藏，不自动物理/软删除；旧数据库里预创建的空行仍保留，后续可加一次性清理。
- 空白草稿标签只在内存与当前页面存在；刷新即丢弃。正式会话的网页标签、云空间、文件、团队、审批、工作台激活页按会话快照持久化。
- 桌面原生标签仍然是隐藏保活，不是销毁重建；长期多对话会累计页面对象，后续需要 LRU 或标签上限。
- 草稿首条消息与用户立即切走存在竞态：当前只收养“发送后仍停在草稿直到 `meta` 返回”的主路径；后台自动收养未做。
- 桌面安装包仍为 `2026.11.24`，本轮桌面只改源码并通过源码 CDP 验收；打包版需重新构建安装后才能获得 `eab:adopt-browser-session` 与新的前端逻辑。
- 桌面安装包版本与网页同源：`build-win-portable.mjs` / `build-win-installer.mjs` 都读取项目根 `package.json` 的 `version`，和 `/api/health` 显示值一致，不再单独使用 `packages/desktop/package.json` 的版本。发版时只改根版本，桌面 Setup、`desktop-release.json`、网页健康接口和下载页会保持一致。

#### 23.3.7.13 v2026.11.26 桌面发布与服务器下载（2026-11-27）

**目标**

1. 根包、桌面包、`/api/health`、安装包和 `desktop-release.json` 统一为 `2026.11.26`；Git 标签和 Release 使用 `v2026.11.26`。
2. 桌面安装包和便携包上传 GitHub Release，仓库可直接下载。
3. 服务器升级后仍具备桌面下载能力：安装包不能只放在 `packages/desktop/release`，否则 `eab update` 整包替换 `packages` 时会丢失。
4. 对话页增加显眼的「下载桌面端」入口，不再只藏在设置里。

**实现**

- `packages/desktop/scripts/build-win-installer.mjs`：构建后把 Setup、便携 zip、`desktop-release.json` 同步到数据目录；优先级为 `EAB_DESKTOP_RELEASE_DIR` > `EAB_HOME/desktop-release` > 仓库 `.eab-dev/desktop-release`。
- `packages/server/src/routes/desktop-download.ts`：发布目录新增数据目录优先；本地无包时从 `EAB_DESKTOP_RELEASE_URL`（默认 `https://github.com/Jydsh/EAB/releases/latest/download`）读取 `desktop-release.json`，首次下载把 EXE 拉回数据目录并校验 SHA256，后续直接读本地。
- `packages/server/public/chat.html` + `chat.js`：网页端顶栏新增 `#open-desktop-download`「下载桌面端」，桌面宿主隐藏；设置里的入口保留。
- `.gitignore`：桌面 `release`、`installer/generated`、日志和 `node_modules` 不进 Git；桌面源码、安装器脚本和品牌资源进 Git。

**服务器下载能力结论**

- 本机源码服务：构建后数据目录和 `packages/desktop/release` 都有产物，`/download/desktop`、`/download/desktop/windows`、`/api/desktop/update` 直接可用。
- `eab update` 升级：数据目录不参与 `packages` 替换，安装包保留；若新服务器首次没有本地包，则从 GitHub Release 回源一次并缓存。
- Docker：必须把数据目录挂到 `/data/desktop-release`，并设置 `EAB_DESKTOP_RELEASE_DIR=/data/desktop-release`；镜像本身不塞 113MB 安装包。
- 其他用户访问对话页后可从顶栏或设置进入 `/download/desktop`，下载的是服务器当前版本；桌面端自动更新仍走 `/api/desktop/update`，不会直接跳第三方地址。

**验收**

- `/api/health`、根 `package.json`、`packages/desktop/package.json`、安装包文件名和 `desktop-release.json` 的版本一致。
- `/download/desktop` 显示 `v2026.11.26`，Setup 和便携包大小正确；`/api/desktop/update?currentVersion=2026.11.24` 返回 `hasUpdate=true`。
- 重启服务、模拟 `eab update` 删除 `packages` 后，数据目录中的安装包仍可下载。
- 清空数据目录后首次请求会回源 GitHub 并缓存，第二次请求直接走本地。

#### 23.3.7.14 下载中心改版与历史版本档案（2026-11-27）

**目标**

1. 当前只有 Windows x64 包，也要把下载页做成完整的产品下载中心，而不是单张说明卡。
2. 打开页面时自动识别访问设备的系统与架构，高亮并推荐对应安装通道。
3. 提前在页面上预留 Windows ARM64、macOS Apple Silicon / Intel、Linux x64、Android、iOS/iPadOS、HarmonyOS NEXT 的版本位与文件类型。
4. 每种安装包显示历史版本，旧包不覆盖，可按版本独立下载并核对 SHA256。

**实现**

- 页面从 `desktop-download.ts` 的内联单卡片重构为 `desktop-download-page.ts` 的整页下载中心：顶栏、首屏设备识别卡、原生窗口示意、平台矩阵、版本档案、安装流程和页脚；仍由服务端内联输出 CSS/JS，不依赖外网资源。
- 下载页不再沿用浏览器默认圆点图标：`<head>` 内联一枚与工作台一致的 EAB 品牌方块 SVG favicon，并设置 `theme-color`；页面加载后再读 `/api/branding`，如果企业上传过自定义图标或改了 Logo 文字，只替换 favicon，不改下载页标题。
- 发布目录扫描从“只挑 mtime 最新的 Setup”改为 `listSetupReleases()` 扫描 `EAB-Setup-*-x64.exe` 全部历史文件，按版本号倒序生成归档；每个归档独立计算或沿用清单 SHA256，`publishedAt` 优先读 `desktop-release.json`，否则取文件 mtime。
- `GET /download/desktop/setup?version=<版本号>` 精确匹配发布目录中的历史包；找不到返回 404，不静默回落到最新版。无 `version` 参数时保持原行为，始终返回最新版，兼容桌面自动更新。
- 页面客户端脚本用 `navigator.userAgentData` 的 `architecture` / `bitness` 与 UA 兜底识别 Windows、macOS、Linux、Android、iOS、HarmonyOS；Windows x64 高亮 `data-platform="windows-x64"` 并显示“当前设备”，Windows ARM64 提示先使用 x64 兼容包，非 Windows 设备把主按钮切到“查看平台支持计划”，同时保留 Windows 包下载入口。
- 便携版也进入同一套归档：`listPortableReleases()` 扫描 `EAB-Desktop-Windows-x64.zip` 与 `EAB-Desktop-Windows-x64-<版本>.zip`，按版本倒序去重；固定名 zip 视为最新构建，带版本号副本保留历史。`build-win-portable.mjs` 每次压缩后额外复制一份带版本号 zip，`build-win-installer.mjs` 发布缓存同时同步固定名与版本号副本。
- `GET /download/desktop/portable?version=<版本号>` 精确匹配历史便携包；无参数仍返回最新便携包，未知版本返回 404。
- 当前发布目录只有 `EAB-Desktop-Windows-x64.zip`，没有更早的便携归档，因此现在页面显示“1 个归档”；从下一次版本构建开始，带版本号副本会持续累积并可独立回滚。

**验收**

- `/download/desktop` 返回完整下载中心；Windows 浏览器显示“检测到 Windows · x64”、高亮 Windows x64 卡片，主按钮指向最新 Setup。
- 浏览器标签显示 EAB 品牌图标而非默认圆点，标签标题保持“下载 EAB · 桌面版与移动端”；下载页控制台无品牌接口报错。
- 版本档案同时出现 `v2026.11.26` 与 `v2026.11.24`，历史行带“历史”标记和独立下载链接。
- `GET /download/desktop/setup?version=2026.11.24` 返回 `EAB-Setup-2026.11.24-x64.exe`，`content-length` 与文件一致；不存在的版本返回 404。
- 便携版面板显示当前归档的版本、大小、日期、SHA256 和下载入口；存在旧便携归档时，面板底部列出“更早归档”，每条按 `?version=` 独立下载。
- 平台矩阵同时呈现 5 个桌面端和 3 个移动端版本位，未发布平台只显示“规划中/预留通道”，不产生虚假下载入口。
- `desktop-download.test.ts` 覆盖历史版本列表、按版本下载、历史便携包下载与未知版本 404；`pnpm typecheck` 通过；真实浏览器控制台无报错。

#### 23.3.7.15 定时任务页满宽与文案精简（2026-11-27）

**目标**

1. 定时任务页不再固定在 1180px 居中，进入页面后铺满左侧栏右侧的整个内容区。
2. 删除“一眼就知道怎么用”的说明性文案，只保留操作、字段、状态、数量与真实错误信息。
3. 宽屏下任务列表自然扩展，右侧创建表单保持可读宽度；窄容器自动改为上下堆叠。

**实现**

- `.schedules-main` 去掉 `max-width: 1180px`，改为 `width: 100%`；两列网格为 `minmax(0, 1fr) clamp(380px, 29vw, 460px)`，宽屏多出的宽度全部给任务列表。
- `.schedules-stage` 设为 `container-type: inline-size`，用 `@container (max-width: 900px)` 取代原先按 viewport 的 900px 断点；侧栏展开或收起时，按真实内容区宽度决定双列还是上下堆叠，右侧表单在窄屏变为 100% 宽。
- 删除说明性文案：页头“个人空间 · 只显示我的任务”、Hero 说明段、“SCHEDULE CENTER / CREATE”英文眉题、列表底部执行说明、“仅自己可见”徽章、表单头部说明、表单底部操作提示、间隔输入的最小/最大提示。
- 保留功能性信息：`Asia/Shanghai`、筛选计数、`共 N 个`、字段名、`选填`、占位示例、状态、执行时间、渠道和表单错误。
- 空状态只留标题（如“没有进行中任务”），不再追加“去右侧创建 / 切换筛选”等指导句。

**验收**

- 1647×963 视口、264px 侧栏下，`.schedules-stage` 与 `.schedules-main` 宽度均为 1383px，左右内边距 26px，任务列表 853px，创建表单 460px；页面 `scrollWidth=1647`，无横向溢出。
- 1200px 容器下仍为双列（`grid-template-columns: 670px 460px`）；800px 容器下自动变为 `display:flex` 上下堆叠。
- 页面文本只剩标题、时区、筛选、计数、任务内容、表单字段和按钮；控制台无报错，`node --check chat.js` 通过。

#### 23.3.7.16 员工端头部管理后台入口移除（2026-11-27）

**改动**

- 从员工端聊天页头部删除 `#console-entry` 按钮，日常对话顶栏不再出现“管理后台”。
- 管理后台入口统一收进左侧栏 `更多` 菜单的 `#side-more-console`；入口仍按 `/api/me/console-entry` 的 `visible` 显示，点击时调用 `POST /api/me/console-entry/session` 换取跳转地址。
- `chat.js` 的入口逻辑改为 `openConsoleEntry()` 与 `refreshConsoleEntry()` 共享，不再依赖头部按钮是否存在；同时给两个入口绑定点击，避免删除头部按钮后侧栏入口失效。
- 跳转仍携带当前 `company` 与 `from=chat`；403 时重新拉取可见性并回到受控状态。

**验收**

- 员工端头部 `#console-entry` 数量为 0。
- `#side-more-console` 不再隐藏，点击后真实进入 `http://127.0.0.1:8788/admin?company=c1&from=chat`。
- 控制台无报错；`node --check chat.js` 通过。

#### 23.3.7.17 个人插件栏范围说明移除（2026-11-27）

**改动**

- 插件·技能·伙伴页左侧 `myPluginRailHtml()` 的 `plugin-scope-block` 只保留“个人空间”眉题和本人姓名，删除 `<small>只显示你自己安装的插件</small>`。
- 范围规则本身不变：接口和权限仍只返回、只操作本人安装的插件；本次仅移除重复说明文案。
- 已安装数量、启用数量、工具数量、安装按钮和插件列表保持原样。

**验收**

- 插件工作台打开后，左侧顶部显示“个人空间 / 李鹏”，下方不再出现“只显示你自己安装的插件”。
- `.plugin-scope-block small` 数量为 0；插件列表、统计和安装按钮正常。
- 控制台无报错；`node --check chat.js` 通过。

#### 23.3.7.18 项目浮层锚点修正（2026-11-27）

**问题**

输入区“项目”气泡打开后，`.space-menu` 虽然使用 `position:absolute`，但最近定位祖先是整条 `.composer-left`，而 `left:0` 又让它贴到输入区最左侧。结果浮层与右侧“项目”按钮脱节，横向落在输入框左边。

**改动**

- 用 `.space-picker` 包住 `#space-chip` 与 `#space-menu`，并设为 `position:relative; display:inline-flex; flex:0 0 auto`，让浮层锚点回到项目按钮本身。
- `.space-menu` 使用 `left:0; right:auto`，浮层左边缘与项目气泡左边缘对齐，向上展开，不再固定贴输入区最左侧。
- 宽度保留 `316px`，增加 `max-width: calc(100vw - 32px)`；`@media (max-width: 760px)` 时改为右对齐，避免窄屏向左溢出。

**验收**

- 1647px 视口下，项目气泡 `826–906px`，浮层 `826–1142px`，左边缘与气泡严格对齐；宽度 316px，右边缘仍在输入框（`468–1444px`）内。
- 浮层仍向上展开，任务为空时显示“同账号还没有桌面项目”和“不使用项目”。
- 页面 `scrollWidth` 等于视口宽度，无横向溢出；控制台无报错。

#### 23.3.7.19 定时任务编辑、重新启用与物理删除（2026-11-27）

**目标**

员工端定时任务从“只能新建、暂停/恢复、软取消”扩展为可编辑、可重新启用、可物理删除。删除必须清除后台任务数据，不再保留 `cancelled` 占位行。

**卡片动作矩阵**

- `active`：暂停、编辑、复制、删除。
- `paused`：启用、编辑、复制、删除。
- `running`：仅复制；编辑与删除不渲染，服务端同时返回 409。
- `done` / `error` / `cancelled`：编辑、复制、删除。已结束任务的卡片按钮统一叫“编辑”，进入编辑表单后由底部“保存并启用”说明会自动重新启用。

员工端不再单独提供“取消”按钮，统一由“删除”停止后续执行；管理控制台旧的取消接口继续保留，语义仍是软取消。

**编辑态**

- 复用右侧创建表单，不另开弹窗。标题改为“编辑定时任务”，当前编辑卡片加品牌色描边，底部“清空”改为“退出编辑”。
- 原 `active` 保存后保持启用并重算下次执行，按钮“保存修改”。
- 原 `paused` 保存后保持暂停，不自动启用，按钮“保存修改”；之后在卡片点“启用”。
- 原 `done/error/cancelled` 保存后自动转 `active`，清空 `attempts` 与 `last_error`，按钮“保存并启用”。
- 一次性任务原时间已过期时，保存会被拒绝，要求重选未来时间，不静默改成十分钟后。
- 单次任务回填时，`payload.at` 的 ISO/UTC 时间先转成本地时间再写入 `datetime-local`，避免后台存 `06:00Z`、表单显示 `06:00` 而卡片显示 `14:00` 的偏差。
- 重新启用已结束任务同样受“每个员工最多 50 个进行中任务”限制。

**接口**

- `PATCH /api/schedules/:id`：接收与创建相同的 `title/prompt/mode/at/time/days/intervalMinutes/timezone/channel`，增加 `activate`；已结束任务必须显式传 `true`。
- `DELETE /api/schedules/:id`：物理删除任务行、`schedule_runs` 执行记录和 `schedule_events` 事件日志；已产生的 `chat_messages` 对话内容和已经发出的钉钉消息保留。
- `schedule.delete` 对话工具同步改为物理删除；控制台取消仍走软取消。

**并发保护**

- 调度器先用 `(schedule_id, scheduled_for)` 的 `INSERT OR IGNORE` 认领 occurrence，再用 `id + status='active' + updated_at` 条件更新为 `running`；条件不成立就删除刚插入的 run 并跳过本轮。
- 编辑与删除都以 `updated_at` / `status` 做条件写，运行中任务直接 409，避免调度器用旧规则继续执行或用完成回调覆盖新状态。

**验收**

- 单元测试：`schedule.test.ts` 14 项通过，覆盖编辑保持启用、编辑保持暂停、结束后显式启用、物理删除三张表、运行中拒绝编辑/删除、过期单次任务明确提示；`console-schedules.test.ts` 5 项通过。
- 真实页面：已取消的“页面联调测试”点“编辑”进入表单，点“保存并启用”后变为“运行中”，下次执行重算为 2026-11-28 09:00；暂停后再编辑仍保持“已暂停”；点“启用”恢复运行；删除确认文案正确，删除后列表从 4 条变 3 条。
- 单次任务“下午两点提鿁”的 `payload.at` 为 `2026-11-24T06:00Z`，编辑表单已回填为本地 `2026-11-24T14:00`。
- 删除后直接查询运行库，`user_schedules`、`schedule_runs`、`schedule_events` 中该任务计数均为 0；页面控制台无报错。

#### 23.3.7.20 过期单次任务即时提醒

**设计口径**

- 已过期的单次时间不创建、不落库。创建后既不会执行，还会占一条“进行中”记录并触发上限校验，因此采用“提醒并拦截”，而不是静默生成永不执行的任务。
- 提醒从“提交后报错”提前到“输入时提示”：`#schedule-once-at` 下方常驻一个 `role="alert"` 提示位，仅异常时显示红字，正常时隐藏且不占位。
- 三类异常分别给不同文案：已过期、距当前不足 30 秒、时间格式无效；已过期文案明确写出“该任务时间已过期，不会执行。请选择未来时间。”，让员工知道后果而不只是“时间不合法”。
- 编辑已结束的单次任务时，回填的旧时间通常已过期，进入编辑即显示提示；员工改到未来时间后提示自动消失，保存并启用才会成功。
- 前端拦截不作为唯一防线：服务端 `createSchedule` 与 `updateSchedule` 共用 `assertOnceRunFuture`，绕过页面直接调接口同样返回 `not_future`，提示文案与前端一致。

**实现**

- `chat.html`：`#schedule-once-warning` 位于时间输入框之后。
- `chat.js`：`scheduleOnceTimeState()` 将单次时间分为 `empty / invalid / expired / too_soon / ok`；`refreshScheduleOnceWarning()` 在模式切换、编辑回填和输入时实时刷新，非单次模式自动隐藏并移除 `aria-invalid`；`buildSchedulePayload()` 在提交前复用同一判断并抛出对应文案。
- `chat.css`：`.schedules-field-warning` 用 `--deny` 红色小字，跟随字段宽度，不挤压表单布局。
- `schedule.ts`：`assertOnceRunFuture(next, now)` 先判断 `next < now` 返回“已过期，不会执行”，再判断 `next <= now + 30s` 返回“时间太近”；创建和编辑统一调用，替换原先只校验 30 秒且文案笼统的实现。

**验证**

- `schedule.test.ts` 14 项通过，新增“创建已过期的单次任务时明确说明不会执行”，断言错误码 `not_future`、消息同时包含“已过期”和“不会执行”。
- `pnpm typecheck` 与 `node --check chat.js` 通过。
- 真实页面：编辑“下午两点提鿁”，单次时间回填为本地 `2026/11/24 14:00`，字段下方立即出现红色提示；改为未来 10 分钟后提示消失且 `aria-invalid` 移除；提交过期时间时表单错误与字段提示同时出现，未写入任务记录；退出编辑后提示复位隐藏。

#### 23.3.7.21 定时任务流式回复与钉钉过程面板（2026-11-27）

**问题**

- 定时任务原先走“后台跑完整轮、再插入 assistant 消息、最后 `publishChatEvent({ type: 'message' })`”的路径，页面在任务执行期间没有任何增量，回答只能一次性出现。
- 定时任务 assistant 消息的过程元数据写成 `meta.tools`，页面历史与实时收口读的是 `meta.toolCalls` 和 `meta.reasoning`，因此刷新后即使有调用记录也不显示思考与工具。
- 钉钉最终通知使用 `sendDingTalkRichTextToUser()`，构造 A2UI 卡片时把 `reasoning` 和 `tools` 固定为空；面板切换回调又依赖 `channel_turns` 反查 `card_instance_id -> session_id`，定时任务没有登记这张表，用户点击思考/工具面板会被拒绝，日志表现为“卡片与会话不匹配”。

**设计口径**

- 不新增前端协议：定时任务复用普通对话已经在用的 `chat-events` 总线和 `delta / tool / tool_result / subagent` 渲染链，避免维护两套前端状态机。
- 先分配稳定的 `assistantMessageId`，再开始执行；所有增量都绑定这个节点，最终 assistant 消息复用同一 ID，页面收口时不会出现“实时气泡消失、另起一条历史消息”的跳变。
- 定时任务期间关闭模型事件缓冲（`bufferModelEvents: false`），正文与思考按 token 发出；普通后台唤醒仍保留缓冲，避免无人观看时浪费事件。
- 落库元数据与普通对话统一为 `reasoning / toolCalls / thinkingMs`；工具记录统一走 `chat.tracesForStorage()`，不把临时 `trace` 直接写进消息。
- 钉钉采用“先建流式卡、边跑边更新、结束时同一张卡收口”；建卡或收口失败时才退回最终富文本/A2UI 新卡，不让用户丢结果。
- 为了让面板点击可反查会话，定时任务建卡成功后立即写一行 `channel_turns`，以 `schedule:<scheduleId>:<runId>` 作为 `event_key`，避开唯一索引，并记录 `card_instance_id`、`session_id`、`assistant_message_id`；结束后把状态更新为 `completed` 或 `failed`。

**实现**

- `packages/server/src/schedule.ts`：`runSchedule()` 新增 `liveAnswer / liveReasoning / liveTools / liveToolNames / thinkingStartedAt / thinkingDone / thinkingMs / dingCard / dingCardTurnId`；`emit` 按事件类型分流：
  - `reasoning` 累加思考并 `publishChatEvent({ type: 'delta', kind: 'reasoning' })`；
  - 首个 `content` 到达时结算 `thinkingMs`、把 `thinkingDone` 置真，再按 token 广播 `delta/content`；
  - `tool` 与 `tool_result` 同时更新本地记录和钉钉卡片，并向 SSE 广播工具事件；
  - `agent` 事件转成 `subagent` 广播，保留子 Agent 团队面板。
  - 最终 assistant 消息的 `meta` 改为 `reasoning: finalReasoning`、`toolCalls: storedTools`、`thinkingMs`、`runId`。
- `packages/server/src/dingtalk-outbound.ts`：新增 `DingTalkRichTextSendInput`（可选 `reasoning / tools / toolDetails / thinkingMs / sessionId`）和 `startDingTalkAICardToUser()`；`sendDingTalkRichTextToUser()` 的 A2UI `state` 不再固定清空思考与工具。原有审批、工具审批调用方不传这些字段，行为保持不变。
- `packages/server/src/dingtalk-card.ts`：沿用 `DingTalkAICardStream.start/update/finish/fail`，状态覆盖正文、思考、工具摘要、工具明细、思考耗时和会话 ID。
- `channel_turns` 登记字段：`provider='dingtalk'`、`external_id` 为外部用户 ID、`session_id`、`card_instance_id`、`card_kind='a2ui'`、`status='running'`，结束时更新为 `completed/failed`。
- 回退卡补登记：流式卡收口失败后重新发送最终 A2UI 卡时，原 `channel_turns` 行的 `card_instance_id` 更新为新卡；建卡直接失败、最终卡才成功的场景补写 `<runId>:fallback` 行。这样两种路径的思考/工具按钮都能反查到会话。
- 回退通道与会话绑定：创建钉钉任务时忽略请求里的网页 `sessionId`，只有网页任务允许保留当前网页会话；编辑任务时，钉钉通道一律解绑旧会话，执行时由 `ensureChannelSession` 重新取固定钉钉会话，网页通道未改通道则继续沿用原网页会话。
- 执行前再校验会话来源：`chat_sessions.source` 不是 `dingtalk`、或 `external_id` 与当前员工不一致时，钉钉任务会丢弃旧 `session_id`；网页任务也会拒绝钉钉会话。这样即使历史数据里通道被改过，也不会把钉钉结果和 SSE 增量塞进当前网页对话。
- 未修改 `chat.js / chat.html / chat.css`：现有前端已支持按 `messageId` 建实时快照、按 `tool/tool_result` 建工具卡、最终用 `meta.reasoning / meta.toolCalls` 收口。

**验证**

- 真实网页任务 `流式验收2`（`sch_7ff5aef2-780c-48cc-8d00-e037785ba95f`）：21:02:08 出现独立实时节点 `msg_71f4a9a7-b09f-4858-a87f-11bc4146bbec`，状态“正在思考中…”，SSE 连续收到 `delta/reasoning`；21:02:14 工具面板出现“写任务计划 → 列出我的文件和文件夹”；随后依次出现“读取 README.md”“读取工作区文件”“读取 AGT-08_测试用例摘要.md”；21:03:59 正文开始按 token 增长，21:04:02 落库完成。
- 该轮 `schedule_runs` 状态 `success`、`delivery='sent'`；assistant 消息正文 3534 字、`reasoning` 4860 字、`thinkingMs=117191`、`toolCalls` 8 条，`channel='web'`。页面最终节点同时保留可展开的思考面板与工具面板（`think-panel is-collapsed` + `tool-panel is-collapsed`），工具明细含参数与结果，不再出现“只有正文、没有过程”。
- 钉钉侧新建“介绍一下自己”任务复跑：A2UI 卡片 `eab_a2ui_101516e028934516b70692ac607092c3` 创建成功，`channel_turns` 已记录 `card_instance_id`、`external_id` 与 `session_id`，状态 `completed`；面板回调可据此反查到正确会话。旧测试卡 `eab_a2ui_acd1beeac01c4741b765543df5d03067` 早于登记逻辑，没有 `channel_turns`，点击仍会被拒绝，属于历史卡限制。
- `packages/server/test/dingtalk-outbound.test.ts` 7 项通过，新增“定时任务通知把思考过程和工具明细写进最终卡片”，断言创建请求包含思考文本、工具名与正文。
- 真实接口验证通道解绑：带当前网页 `sessionId` 创建钉钉任务，返回 `sessionId:null`；创建网页任务仍保留原网页会话；把该网页任务 PATCH 成钉钉通道后 `sessionId` 归零。验证后已删除两条临时任务。
- `schedule.test.ts` 15 项、`console-schedules.test.ts` 5 项通过；新增“钉钉通道不复用网页会话，切换回推通道时解绑旧会话”。
- `pnpm typecheck` 通过；未改前端，因此无需重新构建静态资源。

#### 23.3.7.22 定时任务图表按投递渠道收窄（2026-11-27）

**问题**

- 钉钉定时任务“个人本月加班数据分析”返回了折线图和一个 `doughnut` 环形图；折线图正常渲染，环形图被钉钉卡片判定为非原生图表，最终卡片出现“这个图表类型在钉钉消息里无法保持原图，已不画近似图；请到网页端查看”的提示。
- 实时钉钉对话早已按 `channel='dingtalk'` 构建提示词，只有定时任务漏了渠道参数：`runSchedule()` 调用 `chat.buildSystemPrompt()` 时没有传 `channel`，函数默认按 `web` 处理，模型拿到的是网页端 17 种图表清单，因此会生成环形图、面积图、雷达图等钉钉不支持的类型。

**修复**

- `packages/server/src/schedule.ts`：`runSchedule()` 按任务行 `row.channel` 计算提示渠道，`dingtalk` 传 `dingtalk`，其余传 `web`；定时任务不再默认落到网页图表清单。
- `packages/domain/src/chart-catalog.ts`：图表选型句也按渠道分流。钉钉只保留“占比 pie、比较 bar/horizontalBar、趋势 line、关系 scatter、结构对比 stackedBar/groupedBar”，不再向模型提示 `doughnut`、`area`、`radar` 等清单外类型；多序列数据形态说明中的 `line/area` 在钉钉改为 `line`。
- 钉钉提示词只列 `pie / bar / horizontalBar / line / scatter / stackedBar / groupedBar` 7 种原生图表；构成类数据应使用饼图，不再生成环形图。

**验证**

- 从 `.eab-dev/eab.db` 读出问题任务的最近一次 `schedule_runs.result_text`，确认正文同时包含 `line` 与 `doughnut` 两个 `chart` 块；对应任务 `sch_a75bd2d4-7c37-462a-809d-365d47c41f90`，`channel='dingtalk'`。
- `data-turn-prompt.test.ts`（8 项）、`chart-catalog.test.ts`（9 项）、`dingtalk-outbound.test.ts`（7 项）、`schedule.test.ts`（17 项）共 41 项通过；`data-turn-prompt` 新增断言：钉钉提示词全文不出现 `doughnut` 与 `line/area`。`tsc -p tsconfig.json --noEmit` 通过。
- 历史已发出的卡片不回溯改写；修复从下一次定时任务执行开始生效。

#### 23.3.7.23 定时任务间隔支持秒/分钟/小时/天/月/年（2026-11-27）

**问题**

- 原“间隔”只能填分钟（`intervalMinutes`，前端 5～10080 分钟），无法配置秒级巡检、按天轮询、月度盘点和年度复盘。
- 工具 schema、API、前端标签、控制台标签都写死“分钟”，DSH 的 `every_seconds` 又要求最少 300 秒，短周期任务只能退化成分钟任务。

**设计口径**

- interval 规则改成“数值 + 单位”：`intervalValue` 为正整数，`intervalUnit` 取 `second / minute / hour / day / month / year`；单位同时接受中文“秒/分钟/小时/天/月/年”和常见英文缩写。
- 秒级最低 30 秒：调度 worker 每 15 秒扫一次，低于 30 秒没有实际精度；分钟/小时/天/月/年最低 1。
- 数值上限 10000，避免极端配置把下一次执行时间推到不可控范围。
- 月和年按任务时区的本地日历推进，不按固定 30 天/365 天：1 月 31 日加 1 个月落到 2 月末，闰年 2 月 29 日加 1 年落到次年 2 月 28 日。
- 旧任务不改写：`rule_json` 里只有 `intervalMinutes` 的历史任务继续按分钟解释；编辑保存后再写成新字段。API 仍接受 `intervalMinutes` 兜底，工具仍接受 `every_seconds`。
- 秒级任务的“下次执行”显示到秒；日/周/单次任务保持原来的分钟粒度，不额外制造噪音。

**实现**

- `packages/server/src/schedule.ts`：新增 `IntervalUnit` 类型、`ScheduleRule.intervalValue / intervalUnit`、`ScheduleInput.intervalValue / intervalUnit`；新增 `INTERVAL_UNIT_ALIASES`、`INTERVAL_UNIT_MS`、`MIN_INTERVAL_SECONDS=30`、`MAX_INTERVAL_VALUE=10000`。
- `normalizeIntervalUnit()` 负责单位归一化；`intervalRuleOf()` 统一校验正整数、上限与秒级下限，`normalizeRule()` 的 `intervalValue / intervalUnit` 分支和 `everySeconds` 分支都复用它。
- `addLocalMonths()` / `addIntervalAt()` 负责推进：秒/分钟/小时按固定毫秒，天/月/年按任务时区的本地日历推进（天保持本地钟点，月/年夹到目标月最后一天）；`nextRunAt()` 的 interval 分支改走 `addIntervalAt()`。
- `toLocalIso()` 增加可选 `withSeconds` 参数；`rowView()` 只在秒级 interval 的 `nextRunLocal` 传 `true`，其余任务保持 `HH:mm`。`scheduleFailure` 的提示文案改为六种单位并提示 `intervalValue + intervalUnit`。
- `packages/server/src/routes/schedules.ts`：`scheduleInputFromBody()` 增加 `intervalValue / intervalUnit` 透传。
- `packages/server/src/routes/tools.ts`：`schedule.create` 描述与 schema 增加 `intervalValue / intervalUnit`，`everySeconds` 下限从 300 改为 30；执行时把两个新参数传给 `createSchedule()`。
- `packages/server/src/routes/chat.ts`：系统提示同步为 `every_seconds（最少 30 秒）`或 `interval_value + interval_unit`。
- 前端 `chat.html`：`#schedule-field-interval` 内改为数值输入 `#schedule-interval-value`（1～10000）加单位下拉 `#schedule-interval-unit`（秒/分钟/小时/天/月/年），默认 30 分钟。
- `chat.js`：`scheduleIntervalParts()` 统一解析新旧规则，列表标签输出“每 30 秒 / 每分钟 / 每 2 小时 / 每 2 天 / 每月 / 每年”；`buildSchedulePayload()` 提交 `intervalValue + intervalUnit` 并做前端校验；编辑回填数值与单位；单位切到“秒”时把最小值抬到 30 并自动纠正小于 30 的数值。
- `chat.css`：新增 `.schedule-interval-row`，输入框自适应、单位下拉固定 96px，与已有周几行保持同一套间距。
- `app.js`：控制台 `taskRuleText()` 同步六种单位与新字段，旧 `intervalMinutes` 仍显示“每 N 分钟”。

**验证**

- `schedule.test.ts` 17 项通过：新增“数值 + 单位、秒级最低 30 秒”“月/年按本地日历夹到月末与闰日”“兼容旧 intervalMinutes”，`every_seconds` 断言改为返回 `intervalValue/intervalUnit` 并按 20 秒触发 `frequency_too_high`。
- `console-schedules.test.ts` 5 项、`dingtalk-outbound.test.ts` 7 项通过，共 29 项；`pnpm typecheck`（`tsc -p tsconfig.json --noEmit`）通过。
- 真实页面验收：创建 30 秒网页任务后列表显示“每 30 秒 / 下次 2026-11-27 21:22:57”，删除确认后任务立即消失；创建“每 2 天”任务后列表显示“每 2 天 / 下次 2026-11-29 21:29”，点击编辑回填数值 `2` 与单位 `天`，随后删除。两条临时任务均已清理，没有产生 `schedule_runs` 或对话消息。
- 页面截图：`.eab-dev/schedules-interval-units-20261127.png`。

#### 23.3.7.24 定时任务时间选择器改为自定义连续双列（2026-11-27）

**问题**

- 定时任务的每日/每周时间仍使用原生 `<input type="time">`。Chromium 原生弹层在选中 `09:00` 时，左侧小时列从 `09` 连续向下，右侧分钟列却从 `01` 重新开始且整体下移，`00` 与 `01` 之间出现一块明显空白；该弹层属于浏览器 UI，页面 CSS 无法修正内部行距。

**实现**

- `chat.html`：`#schedule-daily-time`、`#schedule-weekly-time` 从 `type="time"` 改为 `type="text" readonly`，保留 `value="09:00"`；单次任务拆成日期 `#schedule-once-date` 加自定义时间 `#schedule-once-time`，隐藏域 `#schedule-once-at` 继续保存 `YYYY-MM-DDTHH:mm`，业务侧仍按原格式读取，不改 `buildSchedulePayload()` 与提交格式。
- `chat.js`：新增单例 `#schedule-time-popover`，两列分别渲染小时 `00–23`、分钟 `00–59`，共 84 个 `button[role="option"]`；选项高 32px、无外边距和间隙，列高固定并可滚动，滚动条隐藏，保证上下连续。
- 三个时间输入共用同一套选择器；单次的日期或时间变化都会回写隐藏域并刷新过期/过近提示。
- 打开时按输入框位置向下展开，空间不足则向上；选中项滚到列顶部并与另一列对齐，避免两列选中行一高一低。点击选项立即写回输入框并派发 `input` 事件。
- 支持 ArrowUp/Down 连续切换、Home/End、左右列切换、Esc 关闭、点击外部或焦点移出关闭；输入框 Enter/Space/ArrowDown 打开。窗口 resize 与页面滚动时重新定位。
- `chat.css`：新增 `.schedule-time-input`、`.schedule-time-popover`、`.schedule-time-columns`、`.schedule-time-column`、`.schedule-time-option`、`.is-selected`；选中项使用品牌浅绿底。浮层默认 `opacity:1`，避免入场过渡在低帧率环境下停留于透明状态；暗色主题单独调整阴影。

**验证**

- `node --check packages/server/public/chat.js`、`node --check packages/server/public/app.js` 通过。
- 真实页面点击“每天几点”后浮层可见，小时列从 `09` 起连续显示 `10/11/12...`，分钟列从 `00` 起连续显示 `01/02/03...`，`00` 与 `01` 之间无空白；点击分钟后输入框从 `09:00` 变为 `09:01`，再点小时变为 `10:01`，两列选中态同步；Esc 关闭后焦点回到输入框，`aria-expanded` 复位。
- 切到“每周”后同一浮层在周几行上方正常展开，仍为 84 个连续选项；切到“单次”后日期与时间拆成同一行，时间列从选中值连续展示，选择 `21:51` 后隐藏域同步为 `2026-11-27T21:51`，修改日期后同步为 `2026-11-28T21:51`。
- 页面截图：`.eab-dev/schedules-time-picker-20261127.png`、`.eab-dev/schedules-weekly-time-picker-20261127.png`、`.eab-dev/schedules-once-time-picker-20261127.png`。

**后续增强：循环滚动与键盘输入（2026-11-27）**

- 小时/分钟两列由单份 `00–23` / `00–59` 改为 5 份首尾相接的循环内容（共 420 个选项），可视区固定在中间副本；滚动越过边界时按整周期平移 `scrollTop`，实现向上、向下都能无限循环，`23→00`、`59→00` 不再停住。
- 每日、每周、单次、间隔四个时间输入取消 `readonly`，保留点击打开轮盘的行为，同时把焦点留在输入框并全选当前值，用户可直接键入时间，不必再手动清空。
- 支持 `930`、`0930`、`9:30`、`2359`、`23:59`、`9`、`23` 等写法；按 `Enter` 或失焦时归一为 `HH:MM`，并同步单次/间隔的隐藏 `at` 值。
- 输入非法（如 `24:00`、`9:60`）时回退到上一个有效时间，短暂显示 1.2 秒警示边框；输入合法后立即清除警示。
- 点击输入框且尚未输入时仍可打开轮盘；一旦开始键入，轮盘自动收起，避免键盘输入与轮盘选中状态不一致。
- 验证：`node --check chat.js` 通过；浏览器实测点击后输入 `930` 并按 Enter 得到 `09:30`，间隔隐藏值同步为 `2026-11-27T09:30`；输入 `2359` 后点击其他字段得到 `23:59`；输入 `2460` 失焦回退到 `09:30` 且隐藏值同步；每日、单次输入同样生效。

#### 23.3.7.25 定时任务结果回推到改为钉钉/对话/新建对话（2026-11-27）

**问题**

- 原下拉只有“网页对话 / 钉钉”两个泛选项，网页对话无法指定落到哪一个会话，也不支持让定时任务自动建一个对话显示结果。用户要求显示钉钉和全部网页对话、移除“网页对话”，并增加“新建对话”；选中新建对话后，首次执行时新建会话，后续每次执行继续落在这个会话里。

**实现**

- `chat.html`：`#schedule-channel` 保留为隐藏值容器（`dingtalk` / `new` / `session:<id>`），外层改为自定义触发按钮 + 搜索浮层。浮层内平铺“钉钉”“新建对话”和侧栏全部网页对话标题，不显示“对话”“已有对话”等分组标题。
- `chat.js`：新增 `scheduleSessionTargets()`、`scheduleSessionTitle()`、`scheduleTargetValue()`、`scheduleTargetLabel()`、`renderScheduleTargetOptions()`、`renderScheduleTargetMenu()`、`bindScheduleTargetPicker()` 等；只列非钉钉、非飞书的网页会话，按最近使用排序。搜索框按标题包含关键词过滤（支持空格分隔多个关键词、忽略大小写），“钉钉”“新建对话”始终固定在最上方。选择后按钮显示真实标题，编辑表单不再显示“对话 ·”前缀。
- 下拉支持键盘操作：触发按钮 Enter/Space/ArrowDown 打开，搜索框 ArrowDown/Up 进入选项列表，选项间 ArrowDown/Up/Home/End 移动，Enter 选中搜索到的会话，Esc 或点击外部关闭；窗口 resize、页面滚动时自动重新定位，空间不足时向上展开。
- `chat.css`：`.schedule-target-trigger` 负责输入框外观与省略长标题，`.schedule-target-popover` 为固定定位浮层，`.schedule-target-options` 限高滚动，选中项使用品牌浅绿底和右侧对勾；浮层阴影在暗色主题单独调整。
- `buildSchedulePayload()` 继续读取隐藏 `#schedule-channel`，发送 `channel: 'dingtalk' | 'web'` 与 `sessionId: string | null`；打开定时任务页时刷新选项。
- `schedule.ts`：`ScheduleInput.sessionId` 支持 `null`；`createSchedule` 把 `null` 保存为 SQL NULL，表示首次执行时新建对话。新增 `bindScheduleSession()` 统一处理执行时的会话解析：已有会话仍存在且渠道匹配则复用；网页任务无会话时创建 `source='schedule'` 的 `chat_<uuid>` 会话并回写 `user_schedules.session_id`；钉钉通道继续由 `ensureChannelSession()` 建固定会话。调度 worker 每次 tick 重新 `SELECT *` 取任务行，因此第一次回写后，后续执行拿到的就是已绑定会话。
- `routes/schedules.ts`：`scheduleInputFromBody` 保留 `sessionId` 的 `null` 语义，POST 直接传完整 `ScheduleInput`，不再把 JSON `null` 经 `String()` 写成字符串 `"null"`。

**验证**

- `schedule.test.ts` 覆盖“网页任务可以选择已有对话，也可以选择新建对话；编辑时显式 null 会解绑”，并新增“新建对话只在首次执行建会话，后续执行沿用同一个会话”：首次 `bindScheduleSession()` 生成一个 `chat_...` 并回写任务行，第二次以回写后的任务行再执行仍返回同一 ID，`chat_sessions` 中 `source='schedule'` 的会话数量保持 1。
- 真实页面验收：下拉平铺“钉钉 / 新建对话 / 晚上好”，无分组标题；搜索“晚上”保留匹配会话，搜索“abc”只保留两个固定项并显示“没有匹配的对话”；选中“晚上好”后按钮显示“晚上好”，隐藏值变为 `session:chat_...`，再次打开搜索框已清空。
- `tsc -p tsconfig.json --noEmit`、`node --check chat.js` 与 `schedule` 21 项测试通过。
- 页面截图：`.eab-dev/schedule-target-dropdown-20261127.png`。

#### 23.3.7.26 间隔任务增加“执行时间”并重排三块布局（2026-11-27）

**问题**

- 间隔模式原先只有“数值 + 单位”，用户无法在创建前确认下一次到底什么时候执行；编辑已有任务时也看不出服务端已经排到哪一次。

**口径**

- “执行时间”不是让用户填首次执行时间，而是只读显示下一次执行时间：新建时等于“当前时间 + 间隔”，编辑时优先显示服务端真实的 `nextRunAt`。
- 任务每次执行完成后，服务端把 `next_run_at` 推进到“执行完成时间 + 间隔”；页面在定时任务页可见时每 15 秒静默同步一次，并在窗口重新获得焦点或标签页恢复可见时立即同步，因此该显示会一直是新的下一次时间，不需要用户手动刷新。
- 静默同步使用 `cache: 'no-store'` 并附带 `ts` 时间戳，避免浏览器复用旧的 `/api/schedules` 响应；静默请求不受页面加载锁影响，避免一次挂起请求把自动刷新永久卡住。

**实现**

- `chat.html`：间隔字段拆为三块——数值输入、单位下拉、只读“执行时间”卡片；数值和单位合入 `.schedule-interval-every`，视觉上仍为三个字段。
- `chat.js`：新增 `schedulePreviewNextAt()`、`schedulePreviewText()`、`refreshScheduleIntervalPreview()`、`scheduleIntervalPreviewBound` 与每秒定时器；支持秒/分钟/小时/天/月/年，月/年推进沿用服务端的月末夹取规则。编辑真实任务时绑定 `nextRunAt`，用户改动数值或单位后解除绑定并按“现在 + 新间隔”重算。
- `chat.js`：新增 `scheduleLastListSyncAt` 和静默 `loadSchedules({ silent: true })`；定时任务页可见时每 15 秒拉一次最新排期，`window` 获得焦点、标签页恢复可见时也立即拉取，执行完成后的 `nextRunAt` 会直接反映到任务卡片与编辑表单，不闪“正在读取”。
- `chat.css`：`.schedule-interval-row` 使用两列网格，左侧组合控件为“数值 + 单位”，右侧为执行时间卡片；聚焦只改组合控件边框，不出现 outline 或外圈阴影；暗色主题沿用现有变量。
- 时间显示格式：同年 `MM-DD HH:mm`，跨年 `YYYY-MM-DD HH:mm`，秒级追加 `:ss`；无效值显示“下次 —”。

**验证**

- 新页面加载后，1367 宽度下卡片约 `180 × 40`、数值输入约 `91 × 38`、单位下拉 `74 × 38`；1050 宽度下卡片约 `335 × 40`、数值输入约 `234 × 38`，三块同排、同高、无溢出。
- 新建间隔任务实测：1 分钟任务的 `created_at=1795787327685`、`next_run_at=1795787387685`，严格相差 60,000ms；到点执行后 `last_run_at=1795787396323`、`next_run_at=1795787466529`，下一次已自动顺延，并创建网页会话、正确回写 `session_id`。
- 编辑已有任务时，表单“执行时间”显示服务端真实的 `下次 2026-11-27 21:51:06`，与 `next_run_at` 一致，不是“当前时间 + 间隔”的错误预览。
- 预览联动：1 小时显示 `下次 11-27 22:48`，45 秒显示 `下次 11-27 21:49:15`，1 分钟显示 `下次 11-27 21:49`。
- 自动刷新实测：30 秒间隔任务创建时卡片显示 `下次 2026-11-27 22:15:21`，首次执行结束后未点刷新，卡片自动变为 `下次 2026-11-27 22:16:01`，与服务端推进后的 `next_run_at` 一致；观察期间 `/api/schedules` 每 15 秒出现一次新请求。
- 页面截图：`.eab-dev/schedule-interval-next-20261127.png`（1367 新建）、`.eab-dev/schedule-interval-edit-20261127.png`（1050 编辑，显示真实下次时间）。
- 验收任务“间隔时间验收”“自动刷新验收”“自动刷新最终”“自动刷新终验”及其实测会话均已删除；`user_schedules` 计数为 0，相关测试会话 `deleted_at` 均已写入，属于软删除，可在审计中追溯。

#### 23.3.7.27 桌面本机终端（2026-11-27）

**目标**

- 桌面版右侧“新标签页”补上「打开终端」胶囊，打开后在右侧工作台生成独立「终端」标签，和网页标签、云空间、审批、文件预览并列。
- 交互与视觉对齐豆包桌面版：深色终端画布、顶部 PowerShell 标识、当前目录、清屏/复制/重启/关闭、底部状态与快捷键提示。
- 该能力只在 Electron 桌面宿主出现。Web 形态没有 `window.eabDesktop`，新标签页不渲染入口，也不会产生终端标签。

**实现**

- `packages/desktop/main.mjs`：新增 `terminalSessions` 和按会话隔离的 PowerShell 子进程。启动参数固定为 `-NoLogo -NoProfile -NoExit -Command`，初始化 `[Console]::InputEncoding/OutputEncoding`、`$OutputEncoding` 为 UTF-8，关闭进度条，`prompt` 固定为 `PS> `。
- IPC：`eab:terminal-create` / `eab:terminal-input` / `eab:terminal-close` / `eab:terminal-restart` / `eab:terminal-copy`；主进程按 16ms 合并 stdout 后通过 `eab:terminal-data` 推送，退出通过 `eab:terminal-exit` 推送。关闭窗口、页面重载、渲染进程崩溃和应用退出时统一按进程树结束，避免残留 PowerShell。
- `packages/desktop/preload.cjs`：通过 `contextBridge` 暴露 `terminalCreate`、`terminalInput`、`terminalClose`、`terminalRestart`、`terminalCopy`、`onTerminalData`、`onTerminalExit`，不暴露 Node 能力。
- `chat.html`：新标签页增加 `#web-draft-terminal` 胶囊；工作台增加 `#terminal-pane`，包含输出区、输入行、状态栏和四个操作按钮。
- `chat.js`：新增 `terminal` 工作台类型与 `hasTerminal/showTerminal` 布局；终端打开后加入标签栏，关闭时按进程树结束；支持命令历史（↑↓）、Ctrl+L 清屏、Ctrl+` 打开、复制全部输出、重启、错误/退出状态；输入焦点只改输入行边框，不画 outline 或外圈阴影。
- `chat.css`：终端使用独立深色面板和等宽字体，容器宽度小于 430px 或窗口小于 900px 时头部改纵向、按钮换行；终端栏沿用网页栏 44% 的默认分栏比例。

**边界**

- 当前使用 `child_process` 管道，不是完整 PTY。支持交互式命令行程序的“逐行输入/输出”，但 vim、ssh、top 等依赖光标定位和全屏重绘的程序不保证可用；需要时再引入 `node-pty` 并处理 Electron 原生模块重建。
- 终端命令以当前 Windows 用户身份执行，不再经过 Agent 工具审批；它是用户主动打开的本机终端，不是模型可调用的工具。模型仍只能使用受限的 `project.exec` / 文件桥能力。

**验证**

- Electron `--terminal-probe` 自检：`terminalCreate` 返回 `{ ok:true, shell:"PowerShell", cwd:"D:\\AI kaifa\\EAB", pid:... }`，输入 `echo 中文终端测试` 后输出 `PS> echo 中文终端测试\r\n中文终端测试\r\nPS> exit\r\n`，中文未乱码，`exit` 触发退出码 0；`terminalCopy` 返回 `{ok:true}`。
- 前端用桌面桥模拟验证：新标签页显示「打开终端」，点击后生成「终端」标签，输入命令后输出、清屏、关闭均正常；移除模拟桥后 Web 端 `terminalHidden=true`，不显示入口。

#### 23.3.7.28 侧栏响应式断点与抽屉空白修复（2026-11-27）

**问题**

- 侧栏原在 `≤1120px` 切换为覆盖式抽屉，但文件末尾的桌面侧栏样式又把 `.chat-side` 覆盖成 `position: relative; flex: 0 0 264px; width: 264px`。收起后侧栏自身仍占一列布局宽度，同时又被 `transform` 移出画面，于是留下一整条空白，看起来像“侧边栏不见了”。
- 用户截图 `1237×1290` 对应 CSS 视口约 `998px`：实测侧栏 `x=-316 / width=304 / visibility:hidden`，对话舞台从 `x=304` 开始，左侧空白正好是抽屉宽度。

**实现**

- `chat.js`：侧栏紧凑断点从 `1120px` 改为 `960px`；`canSidePeek()` 的桌面判断改为 `min-width: 961px`，`isCompactShell()` 与 `matchMedia` 变更监听同步为 `max-width: 960px`。
- `chat.css`：旧抽屉媒体查询同步改为 `960px`；并在文件末尾补一段最终覆盖规则，避免被后续桌面侧栏样式反超。
- `961–1216px`：侧栏保持普通固定列，宽 `264px`，对话舞台从侧栏右侧开始，不再自动收起。
- `≤960px`：侧栏改为 `position: absolute` 的 `288px` 抽屉，对话舞台始终 `width: 100%`；收起时抽屉 `translate3d(-104%, 0, 0)` 且不可见，展开时覆盖在内容上，配套遮罩与顶栏按钮品牌色提示。
- 抽屉的 `flex/width/padding` 使用 `.chat-body.is-side-collapsed .chat-side` 同等或更高优先级覆盖旧的 `304px` 规则，避免打开/收起时宽度跳变。

**验证**

- CSS 视口 `998px`：`chat-side` 为 `x=0 / width=264 / visible`，`chat-stage` 为 `x=264 / width=734`，左侧不再有空白；顶部栏按钮可见。
- CSS 视口 `900px`（同源 iframe 验收）：收起态 `chat-side` 为 `x≈-299 / width=288 / visibility:hidden`，`chat-stage` 为 `x=0 / width=900`；展开态抽屉 `x=0 / width=288`，舞台仍为 `x=0 / width=900`，按钮为 `32×32`。
- `node --check packages/server/public/chat.js` 通过；浏览器确认最终 `@media (max-width: 960px)` 规则已加载。
- 页面截图：`.eab-dev/sidebar-998-chat-fixed.png`。

#### 23.3.7.29 定时任务窄屏单列不再与表单重叠（2026-11-27）

**问题**

- 定时任务页在容器宽度 `≤900px` 时从双列改为单列；但 `.schedules-left` 和 `.schedules-compose` 仍保留默认 `flex-shrink: 1`。有任务列表时，两块内容总高度超过一屏，表单被纵向压扁，而 `overflow: visible` 让表单内容溢出自身盒子，直接盖到任务卡片上。
- 用户截图物理宽度 `1014px`（约 `814px` CSS 宽度）正是该区间：任务卡片底部与“新建定时任务”表单顶部相互覆盖。

**实现**

- `chat.css` 的 `@container (max-width: 900px)` 内，给 `.schedules-left` 与 `.schedules-compose` 统一加 `flex: 0 0 auto`，两块都按自身内容高度排布，不再互相挤压。
- 单列滚动统一交给 `.schedules-main`（已有 `overflow-y: auto`）；列表和表单仍保持 `14px` 间距，表单在列表之后完整展开，用户滚动即可看到全部字段。
- 双列布局（`>900px`）不变，表单仍固定在右侧列。

**验证**

- CSS 视口 `814px`：`.schedules-left` 为 `y=76 / height=470`，`.schedules-compose` 从 `y=560` 开始，间距 `14px`，两者无重叠；`.schedules-main` 可视高度 `905`、内容高度 `1101`，可正常纵向滚动。
- `919px` 下仍为双列，任务列表与表单左右并列，无回归；`node --check packages/server/public/chat.js` 通过。
- 页面截图：`.eab-dev/schedules-814-stacked-fixed.png`。

#### 23.3.7.30 全站滚动条改为隐藏但可滚动（2026-11-27）

**问题**

- Windows Chromium 会把纵向滚动条常驻绘制在聊天线程、定时任务页、设置页和各类弹层右侧；在浅色页面里形成一条明显的灰条，并且 `scrollbar-gutter: stable` 还会预留一条空白，页面切换时宽度跳动。
- 用户要求保留滚轮、触控板和键盘滚动，但不显示滚动条本身。

**实现**

- `chat.css` 末尾增加全局规则：`html`、`body`、`.chat-body` 及其全部后代统一 `scrollbar-width: none`、`-ms-overflow-style: none`、`scrollbar-gutter: auto`。
- Chromium/Edge 通过 `::-webkit-scrollbar` 把宽高归零并 `display:none`；`thumb`、`track`、`corner` 背景同时置为透明，避免旧样式残留。
- 不改 `overflow-y: auto/scroll`，滚动容器仍可正常滚动；文本框、代码块、表格和终端也不显示滚动条。

**验证**

- 聊天线程 `scrollbarWidth` 为 `none`，可视高度 `744px`、内容高度 `7361px`，仍可通过滚轮/触控板滚动；页面截图无右侧灰条。
- 定时任务页在 `919px` 宽度下滚动条消失，双列内容、表单和侧栏布局不变。
- 页面截图：`.eab-dev/scrollbars-hidden-20261127.png`、`.eab-dev/schedules-scrollbar-hidden-20261127.png`。

#### 23.3.7.31 间隔任务先设首次执行时间并按原定时间顺延（2026-11-27）

**目标**

- 间隔任务不再由系统直接按“当前时间 + 间隔”推一个只读的“下次执行时间”，而是先由用户设置首次执行时间，再设置间隔。
- 新建时显示“首次执行时间”，创建后第一次严格按该时间触发；之后每次执行完成，自动推进为下一次执行时间，不需要再次设置。
- 编辑已有任务时显示真实的下次执行时间；修改后按新时间重新排期。
- 顺延规则采用方案 A：始终从第一次设定的时间锚点按间隔推进，不按执行完成时间重算，避免任务越跑越漂移。

**规则与后端**

- `ScheduleRule` / `ScheduleInput` 新增 `interval.startAt`，格式为本地时间字符串，例如 `2026-11-28 09:00`。
- 创建或编辑时如果显式传入 `startAt`，必须在当前时间 30 秒之后，否则返回 `not_future`；不传时保留旧行为“现在 + 间隔”。
- `nextRunAt()` 对带 `startAt` 的 interval 规则改为锚点推进：秒/分钟/小时按固定毫秒计算，天/月/年按本地日历推进；当执行完成时间已越过一个或多个周期时，只取下一个未来槽位，不补跑。
- 编辑只改标题/提示词、不传 `startAt` 时，沿用原规则的 `startAt`，不会把任务重置成“现在 + 间隔”。
- `schedule.create` 工具同步暴露可选 `startAt`，支持“从明天九点开始，每 30 分钟”这类明确表述。

**界面与布局**

- 执行频率选择“间隔”后，右侧表单卡片改为“执行时间 → 执行间隔”的上下两段式：
  - 第一行是日期 + 时分选择器，右侧状态胶囊动态显示“首次 / 下次 / 启用”；
  - 第二行是间隔数值 + 单位；表单只保留执行时间和执行间隔两块，不再显示额外的排期摘要条。
- 新建默认把首次执行时间设为“当前时间 + 当前间隔”，并向上对齐到下一分钟；切换间隔单位后不重置已填时间。
- 时间早于当前、距离当前不足 30 秒或为空时，日期与时间输入框变为红色边框，并在下方给出明确错误；提交时再次校验。
- 输入框聚焦只改边框色，不画 outline 或外圈阴影。
- 不使用 `container-type` 包裹整个表单，改为日期/时间输入 `flex-wrap` 自适应；避免窄屏容器查询把表单高度压成 0。

**验证**

- `packages/server/test/schedule.test.ts` 新增用例：`startAt` 原样落库；首次触发等于设定时间；12:05 开始、每 5 分钟，12:07:30 跑完下一次为 12:10；正好 12:10 完成下一次为 12:15；只改标题不改间隔锚点；过期 `startAt` 返回 `not_future`。
- `pnpm typecheck` 通过；`schedule.test.ts` 20 项全部通过。
- 浏览器实测创建“布局验证临时任务”：设定 `2026-11-28 09:00`，列表显示“每 30 分钟 / 下次 2026-11-28 09:00”；编辑态显示“执行时间 / 下次 / 2026-11-28 / 09:00”。
- 浏览器实测过期时间：输入昨天 09:00 后出现“执行时间已过期，请选择未来时间”，输入框红色边框，隐藏值同步为 `2026-11-26T09:00`。
- CSS 视口 `980px`：表单完整展开，高度 493px；修复了原先容器查询导致的表单高度 0、只显示空白圆角条的问题。
- 验证任务已通过 `DELETE /api/schedules/:id` 删除，任务计数恢复为 0。
- 页面截图：`.eab-dev/schedule-interval-first-20261127.png`。

#### 23.3.7.32 对话与工作台分界线改为细线 + 中央胶囊（2026-11-27）

**目标**

- 把员工端对话与右侧工作台之间的可拖拽分界线对齐豆包：整高 1px 细线，中央一枚小胶囊拖拽柄，线不依赖右栏自身的 `border-left`。
- 默认网页分栏比例由“右栏更宽”调整为对话约 64% / 工作台约 36%；同时保留用户拖拽后记住宽度的能力。

**实现**

- `chat.css`：三类分栏（文件、团队、网页）的中间 gutter 从 `8px` 改为 `12px`，网格公式统一为 `calc(var(--xxx-split) - 6px) 12px minmax(0, 1fr)`。
- `.file-split-resizer` 热区宽 `20px`，`::before` 只画一条 `1px` 竖线；`::after` 画 `8×28`、圆角 `4px` 的白色胶囊，线色 `#e7e8eb`、边框 `#e2e4e8`，默认态几乎融入页面。
- 悬停时线加深到 `#d4d7dc`，胶囊放大到 `10×34`、底色 `#f7f8f9`、边框 `#cdd1d7`；拖拽态与键盘态沿用同一尺寸，边框改为品牌绿混合色。
- `chat.js` 在 `pointerenter/pointerleave` 上同步 `.is-hovered`，避免触屏或合成指针只依赖 `:hover`；`focus` / `focus-visible` 只改胶囊边框和底色，不画 outline 或外圈阴影。
- 去掉右栏重复的 `border-left`，但规则排除 `.is-workbench-collapsed`，折叠态 44px 恢复栏仍保留边界线。
- 网页分栏默认值改为 `0.64`；`localStorage` 键升级为 `eab.chat.webSplitRatio.v2`，避免旧宽度覆盖新默认，用户拖动后仍会写入并复用。
- `splitBounds` 为网页模式单独设最小右栏 `300px`、最小对话 `380px`，避免原先借用团队模式 `440px` 下限导致 64% 被夹回约 49%。

**验证**

- 真机 `1318×963`、右侧云空间打开时，`#file-split-resizer` 宽 `20`、高约 `905`，`::before` 为 `rgb(231,232,235)` 的 1px 线，`::after` 为 `8×28` 白底胶囊；分栏约为对话 63.8% / 工作台 36.2%，与参考图比例一致。
- 悬停后 `.is-hovered=true`，胶囊计算样式变为 `10×34`、底色 `rgb(247,248,249)`、边框 `rgb(205,209,215)`，线色变为 `rgb(212,215,220)`。
- 拖拽实测：从约 64% 拖到 `57.87%` 后 `eab.chat.webSplitRatio.v2=0.5787`，松手后 `body.is-resizing-split` 正常移除；键盘左右键每次调整 `2%`，焦点态 `outline-style=none`。
- 页面截图：`.eab-dev/split-divider-final-20261127.png`（默认）、`.eab-dev/split-divider-final-hover-20261127.png`（悬停）。

**边界**

- 分栏宽度仍是本机 `localStorage` 偏好，不跨设备同步；团队、文件模式的默认比例未改，只共享新的 gutter 与胶囊外观。
- 窄屏 `≤900px` 和折叠态仍走原有堆叠/44px 恢复栏逻辑，本轮只做了边界规则排除，未改变窄屏结构。

#### 23.3.7.33 定时任务“结果回推到”改为可搜索下拉框（2026-11-28）

**问题**

- 定时任务表单里，“结果回推到”原本是“独立模糊搜索框 + 下拉选择框”两件控件叠在一起：搜索框常驻在触发按钮下方，既占高度，又让同一个字段出现两个焦点入口。
- 用户从浏览器批注明确要求：搜索框不要单独显示在下面，搜索能力直接合并进下拉框。

**实现**

- `chat.html` 删除 `#schedule-target-search` 和只读的 `#schedule-target-value`；`#schedule-target-trigger` 由 `<button>` 改为 `<input type="text" role="combobox">`，左侧放大镜图标、右侧 caret 保持在同一个控件内，`aria-controls` 指向 `#schedule-target-options`。
- `#schedule-target-popover` 只保留选项列表与空状态，不再放搜索输入；隐藏的 `#schedule-channel` select 继续作为表单真实值来源，提交逻辑不变。
- 交互规则：
  - 点击控件打开弹层并全选当前值，直接输入即可替换为搜索词；
  - 输入实时过滤，按标题匹配；无查询时显示“钉钉 / 新建对话 / 已有对话”，有查询时只显示匹配项，避免输入“东环”后 Enter 误选排在前面的“钉钉”；
  - 点击或 Enter 选择；有查询时 Enter 选第一项匹配，无查询时 Enter 保持当前项；ArrowUp/ArrowDown 在选项间移动，Home/End 跳到首尾；
  - Escape 只关闭下拉并回焦输入框，`stopPropagation` 防止冒泡到全局 Escape 把定时任务页退回对话；
  - 点外、焦点外关闭，关闭后输入框恢复选中项标题，查询词清空。
- 打开弹层不再绑定 `focus` 事件：仅点击、输入、方向键或 Enter 打开。这样页面刷新、浏览器恢复焦点或 Tab 进入输入框时不会自动弹层；聚焦本身只改边框色，不画 outline 或外圈阴影。
- `chat.css` 将 `.schedule-target-trigger` 按输入框重写，搜索图标 `z-index: 2` 避免被输入框背景盖住；popover 宽度跟随触发控件，选项区 `flex: 1 1 auto`，窄屏仍按 900px 单列规则展开。

**验证**

- `node --check packages/server/public/chat.js` 通过。
- 真机 `1367×963` 定时任务页：刷新后输入框显示“新建对话”、弹层关闭、`document.activeElement` 为 `body`，不再自动展开。
- 点击打开后输入“东环”，选项实时收敛为“东环线有多少人”；Enter 后输入框与隐藏 select 同步为 `session:chat_c4a23097-...`，弹层关闭。
- 无查询按 Enter 保持当前选中项；Escape 关闭后 `#schedules-stage.hidden=false`、焦点回到输入框；点击任务名称输入框后弹层关闭并恢复标题。
- 输入不存在的标题显示“没有匹配的对话”，选项数为 0；清空查询后恢复完整列表。
- 页面截图：`.eab-dev/schedule-combobox-closed-20261128.png`、`.eab-dev/schedule-combobox-open-final-20261128.png`、`.eab-dev/schedule-combobox-filter-final-20261128.png`。

**边界**

- 搜索只匹配对话标题，不搜消息正文；大小写与空格做归一化，不做拼音首字母匹配。
- “钉钉 / 新建对话”在有搜索词时也参与过滤，只有标题命中才显示；否则优先保证 Enter 选到用户输入的目标。
- 本轮不改变回推渠道的数据结构，也不新增回推目标类型。

#### 23.3.7.34 创建任务按钮成功对勾与轻弹反馈（2026-11-28）

**问题**

- 定时任务提交时，按钮只从“创建任务”切成“创建中…”，成功后靠顶部 Toast 和列表变化提示；按钮本身没有明确的完成态，视线停在按钮上时确认感偏弱。
- 如果直接把按钮文字替换成对勾，按钮宽度会随文字长度变化，右侧表单操作区会横向跳动。

**实现**

- `chat.html` 的 `#schedule-create` 内部拆成两部分：正常标签 `.schedules-submit-label` 保留在文档流中负责占宽，对勾图层 `.schedules-submit-check` 绝对定位覆盖按钮内容区；检查路径使用 `pathLength="1"`，只对 `stroke-dashoffset` 做描线动画。
- 成功时给按钮加 `.is-success`：
  - 标签快速淡出并上移 `3px`、缩到 `.96`；
  - 18px 对勾在 `180ms` 内从左到右描出；
  - 按钮整体在 `320ms` 内 `1 → 1.026 → .997 → 1` 轻弹一次，只改 `transform`，不触发布局。
- `chat.js` 新增 `playScheduleSubmitSuccess()`：接口成功后保持 `.is-success` 约 `600ms`，期间按钮保持禁用，防止连点重复创建；到时移除状态、恢复按钮并调用 `syncScheduleEditorChrome()`。
- 所有按钮文字统一走 `setScheduleSubmitLabel()` 改内部标签，不再用 `button.textContent` 覆盖；加载态、失败态、新建/编辑/保存并启用等文案都能正确恢复，不会破坏对勾结构。
- 失败时不播放对勾，只恢复按钮并显示原有表单错误；编辑保存成功同样复用该反馈，恢复为编辑态对应文案。
- `prefers-reduced-motion: reduce` 下取消轻弹和描线动画，对勾直接显示并停留同样时长，信息不丢失。

**验证**

- 真实页面创建临时任务，按钮宽度点击前、成功态、恢复后均为 `293.2875px`，没有横向跳动。
- MutationObserver 记录：`.is-success` 从 `6284ms` 到 `6886ms`，实际停留 `602ms`；恢复后 `disabled=false`、文案回到“创建任务”。
- 成功态截图确认按钮内显示居中对勾；临时任务创建后已通过删除确认弹窗清理，任务计数恢复为 `0`。
- `node --check packages/server/public/chat.js` 通过。
- 页面截图：`.eab-dev/schedule-submit-check-20261128.png`。

**边界**

- 对勾只代表请求成功，不代替列表和 Toast；失败、校验错误、网络异常一律不显示成功态。
- 动画不使用 `width / height / left / top`，按钮宽度由常驻标签决定；窄屏单列表单同样保持宽度。
- 600ms 内按钮保持禁用，键盘 Enter 重复提交由 `submitScheduleForm()` 顶部的 disabled 守卫拦截。

#### 23.3.7.35 定时任务统计数字改为向上滚出、下方滚入（2026-11-28）

**问题**

- 四个统计标签里的数字原来直接改 `strong.textContent`；`1 → 2` 没有过渡，`9 → 10` 还会让数字宽度变化，卡片内部出现轻微横向跳动。
- 用户要求：收录数变化时旧数字向上移出、新数字从下方滚入，只过渡一次，并给数字预留固定宽度。

**实现**

- `chat.html` 的四个 `strong` 统一加 `.schedule-stat-number`，内部放一个 `.schedule-stat-number-value.is-current` 当前值；外层只负责固定容器。
- `chat.css` 为数字容器设置 `display: inline-grid`、`width: 3ch`、`height: 1em`、`overflow: hidden`、`font-variant-numeric: tabular-nums`。当前值与离场值都放在同一网格单元，旧值和新值重叠但不撑宽。
- `chat.js` 新增 `setScheduleCountValue()`：
  - 首次渲染只赋值，不播放动画；值没变直接返回。
  - 变化时保留当前值作为 `.is-leaving`，新值作为新的 `.is-current`，从 `translateY(105%)` 进入。
  - 旧值 `230ms` 内从 `translateY(0)` 升到 `-105%` 并淡出；新值 `250ms` 内从 `105%` 回到 `0` 并淡入；两条动画都只执行一次。
  - 动画结束后移除旧节点、清掉内联 transform，只保留一个当前节点；`getAnimations({ subtree: true })` 用于覆盖子元素动画。
  - 连续更新时先取消上一轮动画并清理离场节点，避免叠出多组数字。
- `prefers-reduced-motion: reduce` 下跳过滚动，直接替换为新值。

**验证**

- 四个数字容器在 `1367×963` 下均为 `37.96px × 22px`，与数字位数无关；`font-variant-numeric` 为 `tabular-nums`。
- 真实创建再删除临时任务：`#schedule-count-all` 和 `#schedule-count-active` 同时出现 2 条动画，旧值 `1` 位于 `translateY(0) / opacity 1`，新值 `0` 位于 `translateY(23.1px) / opacity 0`；动画结束后只剩一个 `.is-current` 节点，动画数为 0。
- 临时任务已删除，四个统计恢复 `0`，列表为空；`node --check packages/server/public/chat.js` 通过。
- 页面截图：`.eab-dev/schedule-count-roll-mid-20261128.png`（放慢到 10% 的中间态）、`.eab-dev/schedule-count-idle-20261128.png`（静止态）。

**边界**

- 数字容器固定按 3 位预留；当前统计超过 `999` 时会被容器裁切，若后续出现千级任务量，应把宽度改为 `4ch` 或按最大位数统一预留。
- 动画只改 `transform / opacity`，不改卡片或数字盒子的宽高；每个数字同一时间最多一组进出动画。
- 数值没变、首次加载、减少动态效果时不播放滚动。

#### 23.3.7.36 分界线中央胶囊改为仅悬停/拖拽时显示（2026-11-28）

**问题**

- 对话与右侧栏之间的 20px 拖拽热区里，中央 `8×28` 白色胶囊一直可见。分栏常态下这条灰底上多出一个白色小方块，干扰右侧工作台内容，看起来像未对齐的控件。
- 用户要求：鼠标移入分界线才显示小方块，移出立即隐藏；整高 1px 细线保留。

**实现**

- `chat.css` 的 `.file-split-resizer::after` 默认改为 `opacity: 0`、`transform: translate(-50%, -50%) scale(.94)`，随鼠标移出自然消失。
- 显示状态统一为 `opacity: 1`、`scale(1)`，覆盖：
  - `:hover` 与 JS 的 `.is-hovered`（鼠标移入 20px 热区）；
  - `:active` 与 `body.is-resizing-split`（按住拖拽时，即使指针短暂离开也保持可见）；
  - `:focus-visible`（键盘 Tab 到分隔条时作为无障碍例外显示）。
- 隐藏/显示只过渡 `opacity .12s` 和 `transform .16s`；原有悬停放大 `10×34`、边线与底色加深继续保留。
- 整高 1px 细线 `::before` 不参与隐藏，常态仍保留分栏位置提示。

**验证**

- 真机 `1367×963`，右侧网页工作台打开：
  - 鼠标离开分界线：`is-hovered=false`，`::after` 计算样式 `opacity=0`、`8×28px`；
  - 移入分界线：`is-hovered=true`，过渡完成后 `opacity=1`、`10×34px`，截图可见中央胶囊；
  - 再移出：`is-hovered=false`，`opacity` 回到 `0`，数字/卡片布局不变。
- 页面截图：`.eab-dev/split-handle-hidden-20261128.png`（默认隐藏）、`.eab-dev/split-handle-hover-20261128.png`（悬停显示）。

**边界**

- 触屏没有持续 hover；拖拽态仍由 `body.is-resizing-split` 保持可见。
- 键盘聚焦时胶囊会显示，这是可访问性需要，不与“鼠标移出隐藏”冲突。
- 不改变 20px 命中热区、分隔线颜色和分栏宽度逻辑。

- 仍然只允许 http/https；默认只读公网。内网地址必须由控制台显式开启，可配置精确主机白名单或 `*` 放行全部企业局域网，本机、链路本地和云元数据地址始终拒绝。
- 自动登录、验证码/短信/2FA 自动处理尚未实现；当前登录流程由用户在右侧接管完成，扫码页只做识别提示，不解码二维码。
- 站点账号密码已进入服务端加密凭据库；登录态复用已支持用户手动保存 Cookie/localStorage，但自动保存、站点适配器和招标分析流水线尚未落地。
- 不自动破解图形验证码、不绕过平台付费墙或会员权限；批量数据优先使用平台官方搜索、订阅、导出能力。
- 标标达站点适配器、招标项目数据模型和需求抽取流水线尚未落地，当前只能完成通用浏览器打开、人工登录和页面读取。

#### 23.3.7.37 v2026.11.27 发布收口（2026-11-28）

**版本口径**

- 根 `package.json`、`packages/desktop/package.json`、`/api/health`、Windows 安装包、`desktop-release.json`、Git tag 和 GitHub Release 统一为 `2026.11.27` / `v2026.11.27`。
- 桌面包版本必须与网页版本一致；桌面端更新检查会把低于当前服务版本的安装包判为旧版。

**发布内容**

- 定时任务：编辑/重新启用/物理删除、过期单次拦截、流式回复与钉钉过程面板、六种间隔单位、自定义连续时间选择器、可搜索回推目标、成功对勾与统计数字滚动。
- 桌面端：本机 PowerShell 终端标签、版本档案下载中心、历史安装包/便携包独立下载、带版本号便携 zip 副本。
- 员工端：960px 侧栏断点、定时任务窄屏单列、隐藏滚动条、分界线胶囊仅悬停/拖拽显示。
- 图表：定时任务按投递渠道收窄，钉钉只使用 7 种原生图表。

**发布验证**

- 根目录 `pnpm typecheck` 通过。
- `pnpm test` 全量通过（259 个测试文件、1632 个用例），测试日志保存在 `.eab-dev/release-test-20261127.log`。
- Windows 便携包和 NSIS 安装包使用 `2026.11.27` 构建，安装包、便携 zip、`desktop-release.json` 同步写入 `.eab-dev/desktop-release` 并上传 Release。
- 安装包 `EAB-Setup-2026.11.27-x64.exe`，113074274 字节，SHA256 `8f5d4fd35c4ff880e5bd4c63ea0152ee949c76f6e81a251e1d7f9a5cca2b9f0e`；便携包 `EAB-Desktop-Windows-x64.zip`，158277244 字节，SHA256 `3e78fa647113274be2b883eba777797b0f62583924452b2ed50b4fdab6ebf17`。
- `/api/health` 返回 `2026.11.27`；`/download/desktop` 同时列出 `v2026.11.27` 与 `v2026.11.26`。
- GitHub Release 资产包含源码 zip、Windows 安装包、便携 zip 和更新清单。

### 23.5 下一阶段（B1）

1. 服务端加密凭据库：账号密码只在浏览器进程注入，模型上下文不接触明文。
2. 二维码优先：识别登录二维码并提示用户扫码；图形验证码/短信/2FA 转人工接管。
3. 登录成功后的持久会话与站点适配器：标标达登录态复用、项目搜索/筛选/详情读取。
4. 招标分析流水线：需求抽取、资格门槛、评分办法、企业匹配度和风险清单。

#### 23.5.1 B1-1 已落地（2026-11-25）

- 服务端加密凭据库：`browser-credentials.ts` 按 `companyId:userId + origin` 隔离，密码用 AES-256-GCM 加密，AAD 绑定 owner 与 origin；密钥单独存 `browser-credentials.key`（32 字节、`0600`），密文存 `browser-credentials.json`，未写数据库。
- 工作台入口：浏览器工具栏新增钥匙按钮与“本站登录信息”面板，可保存、删除、回填；账号可回显，密码不在任何公开接口或审计中返回。
- 填充边界：服务端只在页面上下文写入账号和最近的前置文本输入框，把焦点移到密码框；不自动点击登录、不提交表单、不绕过验证码或扫码。页面没有可见密码框时直接失败。
- 已知限制：密钥与密文同目录，当前是应用层加密 + 文件权限，尚未接 Windows DPAPI / 凭据管理器；B1-2 已对凭据/登录态保存加 HTTPS 守卫，但控制台其他接口仍依赖部署层 TLS。
- 未做：二维码优先识别、登录态持久化/标标达站点适配、招标分析流水线；自动填入当前仍由用户点击“填入当前页”触发。

#### 23.5.2 B1-2 登录边界落地（2026-11-25）

- 远程凭据传输（D5）：保存站点账号或登录态时，本机回环直连允许 HTTP；远程请求必须直连 TLS，或由同机反代声明 `x-forwarded-proto: https`，跨机反代还需把代理 IP 写入 `EAB_CREDENTIAL_PROXY_HOSTS`。否则返回 `FORBIDDEN`，不把密码放进远程明文。
- 扫码识别：填充时若没有可见密码框，会检查页面是否存在语义为二维码/扫码的可见元素（class、id、aria-label、title、alt）。识别到就返回“当前页面是扫码登录，请用手机扫码完成”，不做二维码解码、不绕过登录。
- 登录态持久化：`browser-session-store.ts` 按用户隔离、按站点合并保存 Cookie 与 localStorage，AES-256-GCM 加密，AAD 绑定 ownerKey；密钥 `browser-sessions.key` 32 字节、`0600`，密文 `browser-sessions.json`。新建 BrowserContext 时自动恢复，服务重启后仍可复用。
- 工作台入口：登录面板新增“保存登录态 / 清除登录态”，显示已保存 Cookie 与本地存储数量；清除只删除持久化副本，当前页面仍保持登录，刷新或重开后才失效。
- UI 修复：`renderWebPane()` 在普通网页存在时显式恢复 `#web-browser-bar`，修复工具栏被 `hidden` 卡住、钥匙按钮不可见的问题。
- 仍未做：Windows DPAPI / 凭据管理器接入、登录成功自动保存、二维码自动优先打开、标标达站点适配器与招标分析流水线。

### 23.6 验收记录

> 说明：浏览器动作时间线已于 2026-11-26 第八轮按用户要求移除；本节下方早期验收中涉及“时间线/时钟按钮”的步骤仅作历史记录，不再作为当前验收标准。
>
> 移除验收（2026-11-26）：刷新 8787 后 `#web-timeline-toggle`、`#web-timeline`、`#web-timeline-count`、`#web-timeline-badge` 查询结果均为 0；工具栏只剩后退/前进/刷新/登录钥匙/键盘输入/暂停六个按钮；打开 `example.com` 后 `#web-pane-foot` 默认 `hidden=true`，画面仍铺满 `758×776`；点键盘按钮后 footer 展开、`#web-takeover` 出现且输入框获得焦点，再点一次收起；`pnpm typecheck` 通过。截图：`.eab-dev/timeline-removed-20261126.png`。

- `packages/server/test/browser-session.test.ts`：13 条通过，覆盖实时帧、坐标点击、焦点输入、按键、滚动、跨用户拒绝、登录凭据填入、无密码框拒绝、扫码登录识别、登录态恢复，以及前进 / 后退 / 刷新 / 地址栏跳转。
- `packages/server/test/browser-credentials.test.ts`：5 条通过，覆盖按用户和 origin 隔离、密码不落明文、重存覆盖、删除清空、origin 规范化与拒绝内嵌账号密码、密文篡改拒绝解密。
- `packages/server/test/browser-session-store.test.ts`：8 条通过，覆盖按 origin 过滤、用户隔离、多站点合并、空状态拒绝、非 http/https 拒绝、密文篡改、Cookie 域名匹配与错误码。
- `packages/server/test/browser-credential-transport.test.ts`：6 条通过，覆盖本机 HTTP、远程 HTTP 拒绝、直连 TLS、同机反代 HTTPS、跨机白名单和代理环境变量解析。
- B1-1 真机验收：在 `saucedemo` 登录页保存测试账号后，面板显示 `https://www.saucedemo.com` 与账号、密码输入清空；点“填入当前页”后页面用户名框出现 `eab-test-user`、密码框显示掩码，提示“请确认后手动点击登录”且未自动提交；删除后状态回到未保存，`browser-credentials.json` 变为 `{}`。验收截图：`.eab-dev/b1-credentials-fill-20261125.png`。
- 工作台内容区铺满真机验收（2026-11-25）：右侧打开 `https://example.com` 后，`#web-frame-shell` 为 `758×776`，帧自然尺寸 `1280×1310`，`#web-frame` 渲染为 `758×776` 且相对 shell 顶部偏移 `0`，`object-fit=contain`，上下留白消失；截图 `.eab-dev/web-browser-fill-final-20261125.png`。
- B1-2 真机验收：在右侧网页打开 `https://httpbin.org/cookies/set?eab_session=ok`，登录面板显示 `https://httpbin.org`；点“保存登录态”后提示“登录态已加密保存”，状态为“已保存本站登录态（1 个 Cookie）”，`browser-sessions.json` 中不出现 `eab_session` 或明文值，密钥 32 字节；点“清除登录态”后状态回到未保存，文件变为 `{}`，当前页面仍保持登录。验收截图：`.eab-dev/b1-session-20261125.png`。
- 多标签 UI 验收（第二轮记录；加号菜单已在第六轮移除）：顶栏只剩圆形加号与主题切换，审批与收起按钮均不再出现；加号菜单向下展开，可新建网页/Agent 团队/审批；连续点加号三次得到三个独立 `新标签页`，三个空标签的第一个胶囊都是可聚焦的网址输入框，顶部独立地址栏表单和“打开”按钮均不存在；在三个标签分别输入同一个 `https://example.com/` 后按回车，三个标签均显示 `Example Domain`、`已连接` 和各自实时帧，切换任意标签后画面跟随该页，关闭第二个标签后其余标签不受影响。空标签之间切换时各自已输入未提交的网址保持不变。在实时帧上点击一次，动作时间线从 1 条增到 2 条且无 `pageerror`。同时打开 `example.com` 与 `bbda.com` 两个网页标签，切换回第一个标签后标题恢复 `Example Domain`，关闭最后一个标签后面板收起、顶栏加号仍常驻。
- 内网访问验收：控制台开启白名单 `*` 后，内置浏览器打开局域网页面 `http://192.168.1.13/` 成功显示“EAB 内网验收页”、状态“已连接”并出现实时帧；同一策略下打开 `http://127.0.0.1/` 仍被拒绝，提示“内网访问仅放行企业局域网，本机、链路本地和保留地址仍被拒绝”，页面无 `pageerror`。`packages/server/test/net-policy.test.ts` 与 `browser-network-config.test.ts` 共 21 条通过；`pnpm typecheck` 通过。
- 新标签页搜索验收：输入框占位为“搜索或输入网址，回车打开”。输入不含网址的 `EAB 企业智能体基座` 后按回车，标签标题变为 `EAB 企业智能体基座_360搜索`，状态“已连接”，地址栏为 `https://www.so.com/s?q=...`，实时帧显示搜索结果页，动作时间线为“你 搜索‘EAB 企业智能体基座’”；同一输入框再输入 `example.com` 仍按网址打开 `Example Domain`，页面无 `pageerror`。搜索走公网 360 搜索页，不经过本机 SearXNG；SearXNG 仍在 `127.0.0.1:8080`，内置浏览器因本机地址硬拦截不能直接打开。
- 浏览器工具栏验收：空草稿标签隐藏工具栏；打开搜索结果后工具栏显示，地址栏收起值为 `www.so.com`，`title` 为完整搜索 URL，状态“已连接”。点击地址栏后完整 URL 出现，`selectionStart=0`、`selectionEnd=92` 为全选；在地址栏输入 `github` 回车，标签变为 `github_360搜索`，地址栏回到 `www.so.com`。后退回到 `EAB 企业智能体基座_360搜索`，前进回到 `github_360搜索`，刷新后状态重新变为“已连接”，时间线新增一条标题类动作。暂停后按钮 class 为 `is-paused`、`aria-label` 为“继续画面”。暗色主题下工具栏、地址栏和状态胶囊对比正常，无 `pageerror`。
- 真实接口：`https://example.com` 打开并取帧成功（JPEG 约 52KB，1280×800）；`https://bbda.com/` 返回标题“标标达_精准锁定全网招标采购商机_投标中标AI情报专家”，正文 4318 字、30 个可操作元素；`https://bidradar.com.cn/login.html` 返回手机号/验证码输入框和登录页帧。
- D1 桌面原生浏览验收：Electron 45.4.1 主进程加载 `chat?company=c1`，`window.eabDesktop` 方法齐全；360 搜索原生页打开后 CDP 出现独立 `EAB_360搜索` page target，JS 页面内截图正常。桌面态全轮 `/frame` 请求为 0；视口 bounds 与 `#web-frame-shell` 完全一致；标签切换、Agent 团队隐藏、原生页关闭、主页面 reload 清理均通过。非法 URL（`file:`、`javascript:`、`data:`、带账号密码 URL）全部拒绝，`window.open` 返回 null 且不新增 target；在原生页执行 `location.href='file:///...'` 被阻止，页面留在原 URL，改成 `https` 跳转正常。
- 第十一轮桌面验收：本地 `index.html` 上普通链接点击后 URL 变 `/same.html` 且标签数不变；`target=_blank`、`window.open` 各新增一个前台标签并立即有 `676×688` 视口；Ctrl+点击链接新增后台标签、当前标签保持原页；Ctrl+T 新建空标签、Ctrl+W 关闭草稿/原生标签、Ctrl+Tab 切换、Ctrl+L 聚焦地址栏并显示完整 URL；链接右键菜单出现「在新标签页打开 / 在后台标签页打开 / 在系统浏览器打开 / 复制链接地址」。安装包人工 ADS 绑定和服务端清单更新均通过；临时清单 `2026.11.25` 触发顶栏胶囊、原生弹窗、下载 100% 与 SHA256 校验，恢复清单后 `hasUpdate:false`。最终安装包 `EAB-Setup-2026.11.24-x64.exe` 为 `112,978,208` 字节，SHA256 `1a64803da675d12229be80ccbe4072b37766bbdbda4d38cd026f20a1d90809f0`。
- 桌面图标修复：原 `eab.ico` 是损坏的多尺寸 ICO（Windows 无法加载），且安装器只引用 `$INSTDIR\assets\eab.ico` 却没有释放该目录；快捷方式和“应用和功能”因此回退到通用文件图标。已用 Pillow 从 `eab.png` 重新生成 16/24/32/48/64/128/256 多尺寸 ICO，安装段显式创建 `$INSTDIR\assets` 并释放图标；原安装目录补入有效 ICO 并刷新外壳缓存后，公共桌面快捷方式显示 EAB 品牌图标。新安装包图标资源也已验证。
- 桌面 HTTP 语音验收：`http://192.168.1.13:8787` 下 `isSecureContext=true`、`navigator.mediaDevices` 可用、`voiceSupported()=true`；使用 Chromium 虚拟麦克风时 `getUserMedia` 返回 1 条音轨，证明无 HTTPS 的局域网部署也能进入录音链路。保存新的 HTTP 服务地址会先落盘配置再自动重启，让可信来源开关在新进程启动阶段生效。
- Web 形态回归：同一 `chat?company=c1` 在 Edge/Chromium 中运行，`window.eabDesktop` 不存在，自动走原 JPEG 分支；360 搜索打开后状态“已连接”，`#web-frame` 为 1280×800，`pageerror` 为 0。
- 浏览器 UI 对齐验收（第六轮）：原生壳顶栏和标签条 `+` 均直接新建“新标签页”，`#workbench-add-menu` 不存在；标签条激活页签高 42、白底圆角、带站点 favicon，工具栏高 44、地址居中、无“已连接”胶囊；`#web-frame-shell` bounds 与原生 View 完全一致；动作时间线默认隐藏，点时钟后 shell `688→621`、原生 bounds 同步 `610×621`；从 360 搜索跳到 `example.com` 后旧 favicon 清空；暗色主题下标签条 / 工具栏 / 地址栏无 `pageerror`。
- Web-only 右侧工作台验收（第七轮）：8787 页面 `+` 直接新增“新标签页”，`#workbench-add-menu` 为 0；网页标签激活时 `#web-pane-foot.hidden=true`、`#web-takeover.hidden=true`，工具栏键盘按钮可见且 `aria-expanded=false`；点击键盘按钮后 footer 展开、`#web-input-text` 获得焦点，再次点击收起；新建标签页展示 Agent 团队、审批、云空间三枚胶囊；`example.com` 页面通过服务端帧显示，`x-eab-favicon` 响应头存在；打开带图标站点后标签 class 含 `has-favicon` 且图标 URL 为 http(s) 地址；无 `pageerror`。
- 类型检查通过：`pnpm typecheck`。

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
| 3.2 进程模型 | `packages/server/src/main.ts`、`app.ts`、`job-queue.ts` |
| 5 工作区 | `packages/workspace`、`packages/server/src/routes/workspace.ts` |
| 7 权限 | `packages/authz`、`packages/domain/src/scopes.ts` |
| 9 插件 | `packages/server/src/plugins.ts`、`plugin-host.ts`、`plugin-scope.ts`、`plugin-tools.ts` |
| 10 知识库 | `packages/server/src/kb-*.ts`、`packages/storage/migrations/*kb*.sql` |
| 11 运行时 | `packages/server/src/agent-runtime.ts`、`agent-team.ts`、`llm.ts`、`model-registry.ts`、`routes/tools.ts`、`routes/chat.ts` |
| 15 数据字典 | `packages/storage/migrations/*.sql` |
| 23.3.4 桌面宿主与原生浏览器 | `packages/desktop`（D1 起）、`packages/server/public/chat.js` 的 `window.eabDesktop` 分支、`packages/server/src/browser-session.ts` 的桌面控制驱动 |
| 23.3.5 浏览器 UI 对齐 | `packages/server/public/chat.html` 的 `#workbench-tabs` / `#web-browser-bar`、`chat.js` 的 `renderWorkbenchTabs` / `applyDesktopBrowserState`、`chat.css` 末尾“浏览器工作台：对齐豆包桌面版”整段 |
| 23.3.7 桌面分发 / 更新 | `packages/desktop/main.mjs`、`preload.cjs`、`installer/eab-installer.nsi`、`installer/scripts/detect-server-url.ps1`、`scripts/build-win-installer.mjs`、`packages/server/src/routes/desktop-download.ts`、`chat.js` 的 `bindDesktopUpdates` / `renderDesktopUpdate`、`chat.html` 的 `#desktop-update-chip` / `#settings-update` |
| 23.3.7.27 桌面本机终端 | `packages/desktop/main.mjs` 的 `terminalSessions` / `createTerminalSession` / 终端 IPC、`preload.cjs` 的 `terminalCreate` 等桥方法、`chat.html` 的 `#web-draft-terminal` / `#terminal-pane`、`chat.js` 的 `terminalAvailable` / `openTerminalPane` / `bindTerminalPane`、`chat.css` 末尾“本机终端”整段 |
| 23.3.7.31 间隔任务首次执行时间 | `packages/server/src/schedule.ts` 的 `ScheduleRule.startAt` / `nextAnchoredIntervalRun` / `assertIntervalStartFuture`、`packages/server/src/routes/schedules.ts` 的 `startAt` 入参、`chat.html` 的 `#schedule-interval-date` / `#schedule-interval-time` / `#schedule-interval-at`、`chat.js` 的 `setScheduleIntervalFields` / `refreshScheduleIntervalPreview`、`chat.css` 的 `.schedule-interval-plan` 整段 |
| 23.3.7.32 对话/工作台分界线 | `packages/server/public/chat.css` 的 `.file-split-resizer` 与三类 `--file/team/web-split` 网格、`chat.js` 的 `splitBounds` / `bindFileSplitResizer` / `restoreWebSplitRatio`、`chat.html` 的 `#file-split-resizer` |
| 16 接口契约 | `packages/server/src/routes/*.ts`（实况）；没有独立的 shared-types 包 |
| 18 工程结构 | `packages/*`、`scripts/smoke-http.mjs` |
| 20 进度 | 本文件 20.2.2、`docs/EAB-P*-2026-11-24.md`、`docs/EAB-Agent框架对照审计与能力建设需求-2026-11-23.md` |
| 14 需求 | 任务看板按 FR 编号建 issue；当前实际执行以审计表 AGT-01~21 为准 |

> 本文档由人机协作编写，随开发迭代更新；任何与实现不一致之处，先改本文档再改代码。

---


## 附录 C：v2026.11.07 实现落点（历史快照）

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

### C.5 v2026.11.07 时仍未实现（历史，已被后续部分覆盖）

> 这 6 条是 2026-11-07 的快照。知识库 PDF/Word 解析与向量检索、一键更新/回滚、钉钉/飞书卡片审批等后来已经落地；不要直接拿这张旧表排期。当前缺口以 C.6 为准。

- PTL-01~04 访客门户（仅 `guest_invites` 表）
- MOB-01~03 移动端
- OPS-07 / PLG-07 在线升级与回滚（当前靠备份恢复）
- KB-02/KB-03 PDF/Word 解析与向量检索（当前纯文本 + 中文 bigram）
- CHN-04 长连接、CHN-08 IM 审批卡片、企微回调 AES 解密
- 真实厂商租户端到端（需外部凭证与公网回调地址）

### C.6 2026-11-24 当前校正

| 旧缺口 | 当前状态 | 证据 / 边界 |
|---|---|---|
| KB-02/KB-03 PDF/Word 解析、向量检索 | 已落地 | `kb-parsers.ts`、`kb-splitter.ts`、`kb-vector.ts`、知识库 P0/P1 交付文档；扫描件另有 OCR 路由 |
| OPS-07 / PLG-07 在线升级与回滚 | 基础链路已落地 | `scripts/eab-update.mjs`、控制台系统更新；状态恢复与回滚提示仍有该文档列出的缺口 |
| CHN-08 IM 审批卡片 | 钉钉/飞书已接 | `dingtalk-ai-card.md`、渠道卡片代码；企微未接 |
| CHN-04 长连接 | 飞书/钉钉机器人已接，企微真实回调未完成 | `feishu-bot.ts`、`dingtalk-bot.ts`；企微 AES 解密仍缺 |
| PTL-01~04 访客门户 | 未实现 | 只有 `guest_invites` 表与规划 |
| MOB-01~03 移动端 | 未实现 | 无 Capacitor/RN 壳 |
| 真实厂商租户端到端 | 未完成 | 缺生产租户凭证、公网回调与真实员工账号 |
| AGT-05 工具风险分级与逐次审批 | 已落地 | `tool-approval.ts`、网页审批卡、钉钉 A2UI 工具审批卡、控制台 `usedAt`；高风险工具参数哈希绑定、一次性核销 |
| AGT-05 `project.exec` OS 沙箱 | 代码已落地，真实隔离未验收 | Docker/bwrap strict、network denied、命令白名单、fail-closed；本机缺 Docker/bwrap，未做真实越界验收 |

**当前仍未实现（按影响排序）**

1. `video.analyze` 运行时调用：只有端点类型、用途位与设计管线。
2. AGT-05b `project.exec` strict 沙箱的**真实隔离验收**：Docker/bwrap 执行、断网和越界写入尚未在具备后端的机器上验证。
3. 移动端、访客门户、企微真实回调。
4. AGT-21 剩余项：真实厂商延迟、10 万 chunk 检索、子 Agent 并发、双实例与阶梯加压；v1 基线已落地，不能当成生产容量上限。
5. 生产监控、灾难恢复演练、真实员工大样本验收。

使用方式见同目录 `EAB使用说明.md`。
