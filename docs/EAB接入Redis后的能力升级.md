# EAB 接入 Redis 后的能力升级（可选增强，不接也能跑）

> 定位：Redis 不是主库，而是**协作层**。`EAB_REDIS_URL` 配了、且 `EAB_CACHE=auto|redis` 时，下列能力自动切成 Redis 实现；没配 / 连不上 / 命令超时，一律落回今天的进程内实现，接口不变、行为不变、启动不阻塞。
> 判定依据：`packages/server/src/backends/cache.ts`（已有 `MemoryCache` / `RedisCache` / `HybridCache`）+ `backends/runtime.ts` 的 `connectRedis()`。

## 1. 现在为什么不够用

EAB 当前是「单进程 + SQLite」形态，大量状态存在进程内 `Map`。项目里已经同时跑着 8787 与 8788 两个进程，这些状态天然是**分裂的**；几百人规模一旦上多实例（或分端口承载聊天/控制台），同一份数据会出现两份互相不知道的判断。

| 进程内状态 | 位置 | 现在的问题 |
|---|---|---|
| 全局容量闸门：`active` / `waiters` / `users` / `modelActive` / `companyActive` | `chat-capacity.ts:87-91` | 每个进程各算一份，并发上限乘上实例数；用户 1 分钟窗口在两处各算 |
| 聊天运行表 `activeRuns` | `chat-runs.ts:42` | 跨实例停止生成无效；重启后残留 |
| Agent 运行表 `activeRuns` + 会话锁 | `agent-runtime.ts:83-84` | 同会话可被两个进程同时跑；重启留下 `status='running'` 僵尸（实测 12 条） |
| 控制台会话 `sessions` | `console-auth.ts:25` | 换实例即掉登录；「改密后让其它设备失效」只对一个进程有效 |
| 模型健康 `healthByCompany` / `preferredByCompany` / `probesInFlight` | `model-health.ts:27,35,155` | 探测结果不共享，A 实例判定坏模型、B 实例照样去撞；同一模型被多实例重复探测 |
| 钉钉频控 `rateBuckets` | `dingtalk-bot.ts:619-628` | 重启清零；每人 60 秒额度按实例翻倍 |
| Webhook 频控 `rateBuckets` | `routes/console.ts:4466` | 同上，渠道回调直接暴露在公网 |
| 工具/插件并发 `KeyedSemaphore`、会话互斥 `KeyedMutex` | `concurrency.ts` | 类注释已写明「多进程部署必须换成数据库或 Redis 锁」 |
| 插件宿主、插件工具目录 | `plugin-host.ts`、`plugin-tools.ts` | 每进程各加载一套；目录每轮重建 |
| 各类定时器：保留清理、Stream 巡检、组织同步、定时任务、模型探测 | `retention.ts`、`dingtalk-bot.ts:1865`、`feishu-bot.ts:388`、`org-sync-scheduler.ts`、`schedule.ts`、`model-health.ts` | 每个实例各跑一份 → 重复清理、重复巡检、定时任务重复触发 |

## 2. 升级后的能力清单（Redis 在线才启用）

分四档落地，档内可独立上线、独立回滚。

**当前实施进度（2026-11-13）**

- 已落地：新增 `packages/server/src/backends/coordination.ts`（`hitRate` 固定窗口计数、`claimOnce` 一次性声明、`reserveCapacity` 分布式并发名额、`coordinationStatus()` / `coordinationBackendStatus()`）。
- 已落地：`CacheBackend` 增加 `adjust(key, delta, ttlSeconds)` 原子加减（Memory / Redis / Hybrid 三套实现），名额预留与回滚都靠它。
- 已落地：**对话并发闸门接入共享层**（`chat-capacity.ts`）——全局、单公司、单模型、单用户同时在途四层名额都走 Redis 计数；每分钟频控走 `hitRate`；共享层满员时本地每 500ms 轮询重试，超时/排队满仍返回原样的 429。共享层报错自动退回本地闸门，不拒绝用户。名额带 600 秒 TTL，实例崩溃不会永久占坑。
- 已落地：渠道频控（`dingtalk-bot.ts` 钉钉私聊、`routes/console.ts` 回调）切协作层；`/api/console/backends` 追加一行「协作层（频控 · 去重）」。
- 已落地（2026-11-14）：**渠道事件 Redis 原子预去重**——`claimOnce` 从「先 GET 再 SET」改为 `SET NX EX`；钉钉 / 飞书入站入口先写 `once:<provider>:event:<companyId>:<eventKey>`（300 秒），同一事件被多个实例同时收到时只有一个实例进入处理。缓存层不可用时放行，`channel_events` 的 DB 唯一约束仍是最终闸门。
- 已落地：`/api/console/backends` 状态行 + 控制台「系统 → 数据与运维」可见当前跑在内存还是 Redis。
- 已落地：**Phase 2 的第一半（锁与心跳/僵尸回收）**
  - `CacheBackend` 增加 `setIfAbsent(key, value, ttlSeconds)`（Redis `SET NX EX`）与 `compareAndTouch(key, value, ttlSeconds)`（Redis 用 Lua 比对 token 后续租/删除，无 `eval` 时退化为 `GET + EXPIRE/DEL`）。
  - `coordination.ts` 新增 `acquireCoordinationLock(key, {ttlMs, waitMs, signal})`：共享层在线时 `SET NX` 抢锁、250ms 重试、超时抛 `LOCK_TIMEOUT`、按 `ttlMs/3` 自动续租、释放只在 token 匹配时删除；离线或 Redis 报错退回进程内 `KeyedMutex`。
  - `agent-runtime.ts` 的会话锁改走分布式锁（`agent:session:<id>`，TTL 180 秒、最长等 120 秒）；每个 `startAgentRun` 写入后立刻打心跳 `run:alive:<runId>`（TTL 90 秒、每 30 秒续），`finish()` 清心跳。
  - 新增 `sweepOrphanAgentRuns(db)`，并在 `main.ts` 启动时（`initBackends` 之后）调用：库里 `status='running'` 但心跳不存在的行统一改为 `cancelled`（原因「实例已退出，任务未正常结束」）。当前库里 12 条僵尸 run 会在下次重启时一次性收尾。
- 已落地：**Phase 3 第一半（定时任务领导权）** —— `runAsLeader(key, ttlMs, task)`：Redis 在线时抢 `leader:<key>` 租约、抢不到直接跳过本次，任务执行期间自动续租；离线时等同单实例旧行为。已接入四处后台任务：
  - `retention.ts` 保留清理（`leader:retention`）
  - `org-sync-scheduler.ts` 通讯录自动同步（`leader:org-sync`）
  - `schedule.ts` 定时任务 worker（`leader:schedule-worker`）
  - `model-health.ts` 插件模型探测（`leader:model-probe`）
  多实例部署时这些定时器不再重复跑、不再重复触发同一个定时任务。
- 已落地：**控制台会话改为签名 Cookie**（`console-auth.ts`）——不再把会话存在进程内 `Map`，改成 HMAC-SHA256 签名的无状态 Cookie：
  - 多实例天然共享：所有实例用同一份管理员密码派生签名密钥，A 实例签的 Cookie B 实例也认；
  - 重启不掉登录（旧版本重启全员掉线）；
  - 改密码即全端失效：签名密钥由密码派生，改完旧 Cookie 一律验不过；改密响应里给当前设备换发一张新证书，所以只有自己继续在线；密钥为空时退回进程级随机密钥，外部无法伪造。
  - 代价：升级后第一次访问需要重新登录一次（旧 Cookie 没有签名）；`revokedSessions` 在无状态模式下无法精确计数，固定返回 0，前端只提示「密码已更新」。
  - 测试：`console-session.test.ts` 3 例（签发/篡改、改密失效并换发、重新 configure 后跨实例有效）。
- 测试：`coordination.test.ts` 10 例（含 leader 互斥与离线直跑）+ `chat-capacity.test.ts` 9 例 + `agent-runtime.test.ts` 3 例；`schedule` / `org-sync-scheduler` / `model-health` / `retention-audit` / `console-schedules` 共 23 例回归通过；`pnpm typecheck` 通过。
- 已落地：**分布式并发名额（信号量）**（`acquireCoordinationSlot`）——`reserveCapacity` 轮询抢名额，超时抛 `SEMAPHORE_TIMEOUT`、排队超限抛 `SEMAPHORE_QUEUE_FULL`，离线退回进程内 `KeyedSemaphore`。已接入两处：
  - 内置工具并发（`routes/tools.ts`，key `tool:<toolId>`）
  - 插件工具并发（`plugin-tools.ts`，key `plugin:tool:<instanceKey>`）
  多实例下同一工具/插件不再出现「每个实例各放大一份并发」的情况。名额带 300 秒 TTL，实例崩溃不会永久占坑。
- 测试：`coordination.test.ts` 13 例（含信号量上限/超时/离线退化）；`plugin-tool-capacity` / `tool-lock` / `plugin-tools` 回归通过。
- 已落地：**SSE 跨实例扇出**（新增 `backends/pubsub.ts` + `chat-events.ts` 桥接）——Redis 在线时另开一条订阅连接（订阅态不能复用普通命令连接），`publishChatEvent` 在本地广播后同时发到 `eab:rt` 频道，其它实例收到后转给本进程的 SSE 订阅者；消息带 `origin` 实例标识，自己的回环消息直接丢弃。没接 Redis 时保持纯进程内广播。订阅失败只影响跨实例实时性，不影响落库与重连快照。
  - 测试：`chat-events-bridge.test.ts` 4 例（本地只收一次且事件被广播、其它实例事件被接收、无广播层退回本地、Pub/Sub 适配器丢弃自身回环）。
- 已落地：**跨实例「停止生成 / 取消 Agent 任务树」**（新增 `realtime-control.ts`）——复用同一条 Redis Pub/Sub 通道，本实例找不到目标 run 时广播一条控制消息，持有该任务的实例收到后真正 `abort()`；没接 Redis 时请求照旧只作用于本进程。路由响应多带 `forwarded`，前端只认 `cancelled`，语义不变。
  - 测试：`realtime-control.test.ts` 3 例（取消消息打断本进程对话运行、取消消息把另一实例的 Agent 运行行标成 cancelled、无广播层返回 false / 有广播层发出消息）。
- 已落地：**控制台并发面板回读共享计数**（`readCapacityCount` + `sharedToolCapacityStats` / `sharedPluginCapacityStats`）——接 Redis 时工具/插件的「正在执行」改成从 Redis 读回全局占用（对话与排队仍是本进程实时值），面板标题会标注「全局」，不再出现「每个实例各显示一份」的错觉。未接 Redis 时沿用本实例统计。
  - 测试：`shared-capacity.test.ts` 3 例（离线返回 null、共享层读数、释放后归零）。
- 已落地：**渠道长连接单实例托管**（新增 `acquireLeaderHold` + 钉钉/飞书 Stream 巡检接入）——钉钉 Stream、飞书 WSClient 这类「一条连接对应一个机器人」的长连接，多实例各连一份会重复收事件、重复回消息。现在用 Redis 租约（90 秒 TTL、每 30 秒续租）选一个实例持有连接，其余实例待命；续租失败（被别的实例接手或 Redis 抖动）时 `isHeld()` 变 false，下一轮巡检主动断开自己的连接。没接 Redis 时租约恒为「本实例持有」，与升级前完全一致。
  - 测试：`stream-leader.test.ts` 3 例（单实例恒持有、共享层只允许一个持有者且释放后接手、租约被删除后续租失败把 held 置 false）。
- 已落地：**热数据读缓存**（新增 `hot-cache.ts` + 模型目录接入）——通用 `hotRead` / `hotReadVersioned` 以 15 秒 TTL 缓存「每轮对话都要重建」的配置数据，配了 Redis 就多实例共享，没配就是进程内 Map。失效用「版本号」实现按前缀整体失效：控制台保存/删除模型、改插件模型角色时 `bumpHotVersion('models')`，所有用户的目录缓存 key 立即未命中。
  - **只缓存配置不缓存状态**：健康探测结果、角色映射、额度、会话正文都每次现算，模型容灾切换不会被缓存拖慢。
  - 已接入 7 处模型目录读取（chat 的模型列表/发送/路由/子 Agent、钉钉、飞书、定时任务）。
  - 测试：`hot-cache.test.ts` 3 例（TTL 内只算一次且失效后重算、共享缓存确实写入、版本号 +1 后整族 key 立即失效）。
- 已落地（2026-11-14）：**插件工具目录进程内缓存 + 跨实例失效广播**——`pluginToolSpecsFor` 每轮对话都会按「公司实例 + 本人个人实例 + 角色白名单」重建工具 schema，原来每次都查两遍 `plugin_*` 表。现在加 5 秒进程内短缓存：
  - **不放进 Redis**：插件工具注册表 `toolsByInstance` 是每个进程自己加载的，把 A 实例的 schema 共享给没加载该插件的 B 实例，模型会看到本机不存在的工具；缓存必须是「本机注册表 → 本机 schema」。
  - **安装 / 启停 / 卸载 / 工具角色授权**保存后调用 `invalidatePluginToolSpecsEverywhere()`：清本进程 + 通过 Redis Pub/Sub 频道 `plugin-tools` 通知其它实例立即清空；没接 Redis 时只清本进程，靠 5 秒 TTL 兜底。
  - 插件宿主注册 / 注销 / 重扫时也会清本地缓存，新工具不需要等 TTL 才出现。
  - 测试：`plugin-tools` / `tool-role-access` / `plugin-tool-capacity` 共 15 例通过；缓存 Key 含公司、用户、个人模式、角色与权限集，不同身份互不串。
- 已落地（2026-11-14）：**Redis 断线重连与自动恢复**——原来 `socket.reconnectStrategy: false`，Redis 重启或网络抖动后进程不会重连，协作层会永久退化成内存，控制台却可能仍显示可用。
  - 首次连接仍然快速失败（2.5 秒超时后回退内存），连上之后才启用「500ms 起、最长 5 秒」的指数退避重连，启动不会因为 Redis 没开而卡死。
  - 缓存命令任意一条成功就把 `RedisCache` / `HybridCache` 的连续失败计数清零，`/api/console/backends` 自动从 `degraded` 翻回 `ready`，不会重启后还停在降级。
  - 协作层降级时仍把计数请求交给 `HybridCache`（内部先试 Redis 再落内存），恢复后下一次命令成功即可重新标记为共享；不再出现「降级后只走本地、永远不探测 Redis」的永久降级。
  - 订阅连接重连后触发 `RedisPubSub.resubscribe()`，恢复 SSE 跨实例扇出、停止生成、缓存失效广播等频道；重连失败只影响跨实例实时性。
  - **单条命令超时熔断**：所有 Redis 命令统一加 2 秒上限（`EAB_REDIS_COMMAND_TIMEOUT_MS` 可调）。解决「TCP 还连着、命令一直不回」不会触发重连的问题；超时按失败处理并立刻落内存兜底，对话请求最多多花 2 秒，不会无限等待。
  - TCP 层开启 `keepAlive`（30 秒初始探测），半开连接最终由系统回收，配合应用层超时一起兜底。
  - 跨实例广播增加独立状态行：发布/订阅失败时控制台显示 `degraded` 和错误原因，下一次发布成功自动回到 `ready`，不再出现「广播坏了但控制台全绿」。
  - 缓存与订阅连接发生连接层错误（还没走到具体命令）也会立即标降级，下一笔命令成功后恢复 `ready`，控制台不再因为「暂时没请求」而显示假绿。
  - 运行时实测：用 `CLIENT KILL` 分别断开订阅连接和缓存主连接，日志出现「Redis 订阅连接已恢复，重新订阅频道」「Redis 连接已恢复」，控制台后端状态全部 `ready`（新增广播状态后为 6 行）。
  - 测试：`backends` / `coordination` / `chat-events-bridge` / `realtime-control` 共 39 例通过（含降级后恢复 ready、重连后重新订阅、命令挂住 20ms 超时后走内存不拖住调用方、广播失败后状态恢复、连接层报错立即降级）。
  - 待接：组织快照（同一套「短 TTL + 写入口失效」，需要先把 16+ 个组织写入口收敛出统一的失效点）。
- 已落地：**模型健康结论跨实例共享**（修正单 leader 探测的盲区）——定时探测是领导权任务，只有 leader 真打上游，其它实例原本永远拿不到探测结果，会把插件模型全部当成「未验证」而隐藏。现在 leader 把「公司 → 模型 → 健康」快照写共享缓存（TTL 120 秒、200ms 合并批量写），各实例组装模型目录前先合并一次；同一条模型以 `checkedAt` 较新者为准，本实例刚真实调用成功的结论不会被旧快照覆盖。没配 Redis 时读写本进程 Map，行为不变。
  - 测试：`model-health-share.test.ts` 3 例（读到 leader 结论、本实例新结论不被旧快照覆盖、健康结论批量写回）。
- 已落地：**Phase 4 首项 · 异步作业队列地基**（`0049_async_jobs.sql` + `job-queue.ts`）——控制台的慢操作不再占着 HTTP 连接：
  - 提交作业只落库为 `queued` 就立刻返回 `jobId`，页面轮询 `GET /api/console/jobs/:jobId` 拿进度/结果；
  - **库是权威状态**（`async_jobs` 表跨实例共享），任何实例都能回读任意作业，控制台不会再出现「轮询打到另一台实例查不到」；
  - **Redis 只做加速**：有 Redis 时提交/唤醒走 Pub/Sub 频道 `jobs`，worker 立刻开工；没 Redis 就按 1.5 秒轮询，行为一致、只是晚一个周期；
  - **租约而不是锁**：`lease_owner + lease_until` 记录谁在跑，30 秒~5 分钟租约、按租约 1/3 心跳；实例崩溃后启动时 `recoverStaleJobs` 把过期租约的 running 作业放回 queued，任务不会永久卡住；
  - 抢占用「先查候选 id、再按 status=queued 条件更新」，同一条作业被两个实例同时抢时只有一个 `changes=1`。
  - 首个接入的真实场景：`POST /api/console/plugin-channels/:id/refresh` 原来同步探测（6 个模型 × 15 秒超时 ≈ 90 秒），现在改成提交 `plugin.channel-refresh` 作业，前端按钮改轮询并在完成后自动刷新模型列表。
  - 测试：`job-queue.test.ts` 6 例（提交/跨公司隔离、抢单唯一、租约过期回收、worker 跑完写结果、处理器抛错标 failed、成功清租约）。
  - 运行时实测：插入一条 `plugin.channel-refresh` 探针作业，worker 在 1 个轮询周期内抢到、执行、写回 `failed: 作业缺少 channelId` 并清空租约。
- 已落地：**控制台「后台作业」面板**——系统页新增第 5 个分组：作业标题与 id、类型、状态（排队中/执行中/已完成/失败/已取消）、进度（含已重试次数）、耗时、结果或失败原因；排队中的作业可一键取消（`POST /api/console/jobs/:jobId/cancel`），执行中的作业不允许强杀，交给处理器自己收尾。
  - 接口：`GET /api/console/jobs?limit=`、`GET /api/console/jobs/:jobId`、`POST /api/console/jobs/:jobId/cancel`（都需要控制台登录）。
- 已落地（2026-11-14）：**对话内慢工具后台化的地基**——迁移 `0050_agent_run_suspend.sql` 给 `agent_runs` 加 `pending_job_id` / `resume_state_json` / `updated_at`，状态机新增 `suspended`；`agent-runtime.ts` 提供 `suspendAgentRun` / `loadSuspendedRun` / `resumeAgentRun` / `failSuspendedRun` / `sweepSuspendedRuns`，启动时按后台作业终态收尾（作业失败/丢失判 failed，作业在跑或成功则保留等恢复）；控制台 Agent 运行树显示「挂起 · 等后台工具」。7 例测试全过。
  - 设计文档：`docs/EAB对话内慢工具后台化方案.md`（含 `resume_state_json` 结构、白名单与幂等边界、`EAB_TOOL_BACKGROUND_MS` 默认关闭、验收标准）。
- 待落地（Phase 4 剩余）：主链路接入——`job-queue` 的 `tool.background` 处理器、`routes/chat.ts` 按阈值改投作业并组装恢复载荷、`chat-events` 的 `tool-background` 状态事件、气泡上的「已转后台」提示。

### Phase 1｜并发与频控（几百人最直接的收益）

| 能力 | 无 Redis | 有 Redis |
|---|---|---|
| 全局对话并发闸门 | 单进程计数 | `INCR/DECR` + 租约，全公司一个总量；排队位次用 `LIST`/`ZSET` |
| 单用户每分钟请求窗口 | 进程内数组 | 滑动窗口计数，跨实例一致（防单人刷爆） |
| 单模型 / 单公司并发 | 进程内 Map | 同 key 共享计数，避免某模型被多实例同时打满 |
| 登录/回调/插件调用频控 | 进程内 Map | `INCR + EXPIRE` 共享窗口，重启不清零 |
| 渠道事件去重（钉钉/飞书 `eventKey`） | DB 唯一约束（写放大） | `SET NX EX` 先拦一道，DB 兜底 |

降级语义：Redis 调用失败 → 直接走内存实现并打点（`coordination` 状态标 `degraded`），**不拒绝请求**。

### Phase 2｜锁、运行表与僵尸回收

| 能力 | 无 Redis | 有 Redis |
|---|---|---|
| 会话互斥锁 | `KeyedMutex` | `SET NX PX` + Lua 比对 token 释放；等待者在本地 FIFO + 轮询 |
| 工具/插件并发额度 | `KeyedSemaphore` | 分布式信号量（`ZSET` 租约 + 超时摘除） |
| 聊天/Agent 运行表 | 进程内 Map | Redis Hash + 60 秒心跳 key；实例掉线 key 过期即判死 |
| 僵尸 run 收尾 | 无（只能手工） | 启动时扫 `status='running'` 且心跳 key 不存在的行 → 改 `cancelled`（原因「实例已退出」） |
| 停止生成 / 取消子 Agent 树 | 只能打断本进程 | 通过 Redis 广播取消信号，任何一个实例都能停 |

锁的 TTL 必须大于最长工具执行时间（插件工具默认 60s 超时）；长任务用「续租」协程，续租失败视为锁丢失并终止任务，防止双跑。

### Phase 3｜多实例一致性

| 能力 | 无 Redis | 有 Redis |
|---|---|---|
| 控制台会话 | 进程内 `Map` | `eab:console:sid:<id>` 存储，多实例共享；改密后 `DEL` 全量失效 |
| 定时任务只跑一份 | 每实例各跑 | leader 租约（`SET NX PX` + 续租），非 leader 空转 |
| 保留清理、Stream 巡检、组织同步、模型探测 | 每实例各跑 | 同上，只由 leader 执行 |
| 热数据缓存 | 每次读 SQLite / 重新解析 | 模型目录、用途路由、插件工具目录、组织快照按版本号缓存；控制台改动后 `DEL` 对应前缀 |
| 渠道 access_token | 已有内存 + 共享缓存（`dingtalk-card.ts:100`） | 扩到飞书/企微，全部走共享缓存，避免多实例各自换 token 触发上游限流 |

### Phase 4｜扇出与异步（多实例负载均衡才需要）

| 能力 | 无 Redis | 有 Redis |
|---|---|---|
| SSE / 流式输出跨实例 | 只能同实例 | `PUBLISH` 到 `eab:stream:<sessionId>`，任意实例转发 |
| 长连接持有 | 每实例各连（钉钉/飞书） | 单 leader 持有，其余实例只读状态 |
| 重活异步队列 | 进程内 `setImmediate` | `LIST`/Streams 队列：文档解析、嵌入、批量同步交给 worker |
| 限流排队可见性 | 只有本进程数字 | 队列长度、位次可全局观测，控制台能看到「真实等待人数」 |

## 3. 不放进 Redis 的东西

- **审计日志哈希链**：顺序追加 + 链校验要求单写，Redis 会破坏可验证性，继续走 SQLite/PG 镜像。
- **配额与账本**：月度用量、额度扣减的**权威值**留在 DB；Redis 只做预扣/热计数，定期与 DB 对账，漂移就重置。
- **会话正文、知识库文档**：主存仍是 SQLite/文件，Redis 只存指针与热窗口。
- **配置与密钥**：仍走设置文件与 `.eab-dev/secrets.json`。

## 4. 代码落点

新增一个模块，业务侧只依赖接口，不认 Redis：

```
packages/server/src/backends/coordination.ts
  DistributedLock   acquire(key, { ttlMs, waitMs }) -> release()
  DistributedGate   enter(key, limit, ttl) -> release()        // 并发额度
  SlidingWindow     hit(key, limit, windowSec) -> { allowed, count, retryAfter }
  LeaderLease       acquire(name, ttlSec) -> { renew(), release(), isLeader }
  OnceKey           claim(key, ttlSec) -> boolean              // 事件去重
  RunRegistry       heartbeat(runId, ttlSec) / alive(runId) / sweepStale()
```

- 每个方法内部先探测 `getBackendRuntime()?.cache` 是否 Redis 且 `state === 'ready'`；否则用内存实现（等价于今天的行为）。
- 状态并入 `BackendStatus`，控制台「系统 → 运行与准入」多一行「协作层（锁/频控/租约）」，显示当前是 `内存` 还是 `Redis`、命中与降级次数。
- 配置沿用 `EAB_CACHE` / `EAB_REDIS_URL` / `EAB_REDIS_PREFIX`，不新增环境变量；需要单独关闭某项时用 `EAB_REDIS_FEATURES=lock,rate,lease`（默认全开）。
- 改动文件（按阶段）：`chat-capacity.ts`、`chat-runs.ts`、`agent-runtime.ts`、`console-auth.ts`、`model-health.ts`、`dingtalk-bot.ts`、`feishu-bot.ts`、`routes/console.ts`、`retention.ts`、`schedule.ts`、`org-sync-scheduler.ts`、`main.ts`、`backends/runtime.ts`。

## 5. 验收标准（每阶段）

1. **不接 Redis**：`EAB_CACHE=memory` 下全量 `pnpm test` 通过，控制台与聊天行为与今天一致；启动日志无 Redis 报错。
2. **接 Redis**：同一会话在两个实例并发发起对话，只有一个真正执行，另一个按排队返回；停掉一个实例后，其 run 在 60 秒内被判死并回落 `cancelled`。
3. **Redis 抖动**：运行时 `kill` Redis，业务不 5xx，错误日志出现「降级到内存」，控制台协作层状态变 `degraded`，恢复后自动回到 `ready`。
4. **频控**：两实例同时打同一员工的 60 秒窗口，总次数不超过阈值。
5. **调度唯一性**：两实例同时启动，保留清理 / Stream 巡检 / 定时任务各只执行一次。

## 6. 风险与取舍

- 锁 TTL < 任务时长会双跑；TTL 过大会让挂掉的实例长时间占坑 → 用「短 TTL + 定期续租」，续租失败主动中止。
- Redis 降级瞬间，跨实例一致性暂时丢失（各自内存计数），这是**刻意的可用性优先**；配额类数据一律以 DB 对账为准，不依赖 Redis 权威值。
- 序列化开销：热数据缓存只放「JSON 小对象 + 版本号」，不缓存大文本与二进制。
- 排队中的请求不占共享的「单用户在途」名额（否则排队者会互相卡死），极端情况下同一用户能同时排几条，由本地队列上限兜底；真正开始生成时才计入共享名额。
- 共享名额带 TTL，实例崩溃时泄漏的名额最多存活 600 秒；这是「不永久占坑」与「名额准确」之间的取舍。
- 运维成本：多一个组件、多一份备份与监控；单机小规模部署建议保持 `EAB_CACHE=auto` 且不配 URL。

## 7. 建议的落地顺序

1. Phase 1 频控 + 并发闸门（收益最大、改动面可控，半天到一天）。
2. Phase 2 锁 + 运行表 + 僵尸回收（一天，顺带清掉现存 12 条僵尸）。
3. Phase 3 控制台会话共享 + 调度 leader 租约 + 热数据缓存（一天半）。
4. Phase 4 流式扇出与异步队列（等真正上多实例负载均衡再做）。

每阶段独立可发布，回滚方式统一：把 `EAB_CACHE` 改回 `memory`（或删掉 `EAB_REDIS_URL`）重启即可，代码路径自动退回今天的实现。
