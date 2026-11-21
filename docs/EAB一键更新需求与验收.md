# EAB 一键更新需求与验收

> 适用范围：管理控制台「系统 → 系统更新」、`scripts/eab.mjs` 命令行更新与 `scripts/eab-update.mjs`。
> 版本基线：v2026.11.18 起的源码更新链路。

## 1. 背景

一键更新不是“下载一个 zip 后覆盖目录”，而是一次有状态的运维动作：检测版本、选择源码资产、下载校验、备份代码与运行数据、替换依赖、重启服务、健康检查、失败回滚，最后把结果落盘并反馈给页面。

当前链路已具备下载、sha256 校验、备份、替换、`pnpm install`、重启、健康检查和回滚能力，但存在以下缺口：

1. 更新失败并回滚后，页面只轮询 `/api/health`，旧版本健康响应不等于目标版本，页面会一直等到 5 分钟超时，无法立即知道“已回滚”。
2. 更新状态只有结束时写一次 `last-update.json`，页面刷新或服务重启后无法恢复“这次更新到哪一步”。
3. 控制台接口没有服务端并发锁，连续点击可能启动多个更新器。
4. `spawn` 的失败是异步事件，接口可能已返回 accepted，但更新器实际没有启动，随后旧服务被关闭。
5. `waitPortFree` 把“连接超时”当成端口已释放，端口被占用但连接挂起时可能提前替换文件。
6. 返回给审计的 `command` 缺少 `--url`、`--root`，且 `--restart` 与实际参数 `--restart=1` 不一致。

## 2. 目标

- 一次点击只启动一个更新器。
- 更新器真正接管后才关闭当前服务。
- 页面能区分：进行中、成功、失败、已回滚、超时。
- 更新失败时，旧版本必须被重新拉起；页面不空等。
- 每次尝试都留下可审计的状态和错误信息。
- 更新范围明确，不误覆盖用户数据、插件、技能、计划和知识库数据。

## 3. 更新范围

### 会替换

- `packages/`
- `scripts/`
- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `tsconfig.json`
- `tsconfig.base.json`
- `README.md`
- `LICENSE`
- `.gitignore`

### 不会替换

- `.eab-dev/`：数据库、WAL/SHM、`secrets.json`、`console-settings.json`、`admin-credentials.txt`、更新状态与日志。
- `plugins/`、`skills/`、`plans/`：用户或运行时数据。
- `docs/`、`demo/`、`EAB使用说明.md`、`EAB企业智能体基座-总体架构方案.md`：文档与示例，不作为本次一键更新范围，避免覆盖用户本地编辑。
- `.github/`：仓库 CI 配置，不影响本地运行。

> 如果后续需要“连文档一起更新”，应新增显式开关，不能默认覆盖用户文档。

## 4. 功能需求

### R1 检查更新

- `POST /api/console/update/check` 强制读取 GitHub `releases/latest`。
- 返回当前版本、最新版本、是否有更新、Release URL、发布时间、Release notes、源码资产 URL、资产大小、sha256、安装包 URL、错误信息、上次更新结果。
- 网络失败只记录错误，不阻塞服务启动。
- 检查结果缓存 10 分钟；手动检查强制刷新。

### R2 版本比较

- 统一去掉 `v` 前缀，按数字段比较。
- 当前版本等于最新版本时 `hasUpdate=false`，按钮禁用。
- 当前版本小于最新版本时 `hasUpdate=true`。
- 控制台只面向最新版本，不提供“同版本重装/修复重装”入口；命令行可用 `eab update --apply --version=<当前版本> --force` 重装。

### R3 源码资产选择

- 优先选择 Release 中的源码 zip（如 `EAB-2026.11.18.zip`）。
- 明确排除 `Setup.exe`、`windows.zip`、`desktop-*.zip`、`.sha256` 等安装包/校验文件。
- 没有源码 zip 时回退 GitHub `zipball_url`。
- 有 `digest` 时传递 `--sha256`；没有 `digest` 时允许更新，但页面和日志必须明确“未校验 sha256”，不能宣称已校验。

### R4 更新前置条件

- 必须有 `scripts/eab-update.mjs`。
- 必须能拿到源码 URL。
- 必须不是桌面版（`EAB_DESKTOP=1` 拒绝控制台替换）。
- 当前进程必须提供 `shutdown`，否则提示改用 `eab restart`。
- 已有 `starting/running` 状态且未超过 30 分钟时拒绝新的 apply。
- `starting/running` 超过 30 分钟视为陈旧状态，允许重新发起。

### R5 更新器启动握手

- `startUpdate` 在启动更新器前先写 `last-update.json` 的 `starting` 状态，记录目标版本、旧版本、源码 URL、摘要和开始时间；此时 `updaterPid` 为空。
- 先写 `starting` 再 `spawn`，避免更新器先写 `running` 后被服务端的 `starting` 覆盖，导致握手永远等不到 `running`。
- 更新器启动后写 `running` 状态，并写入自己的 `updaterPid` 与 `startedAt`。
- 控制台接口在关闭服务前最多等待 3 秒，确认状态变为 `running`，且 `startedAt` 属于本次更新；不能把上一次遗留的 `running` 当成新更新器已接管。
- 3 秒内未确认，接口返回失败、终止未确认接管的更新器、把仍处于 `starting` 或本次 `updaterPid` 对应的 `running` 状态标记为 `failed`、**不关闭当前服务**，并提示检查日志。
- 不能改写上一轮遗留的 `running`，也不能把已成功的终态覆盖成失败。

### R6 更新状态机

状态文件：默认 `.eab-dev/updates/last-update.json`；设置 `EAB_HOME` 时为 `$EAB_HOME/updates/last-update.json`。

状态值：

| 状态 | 含义 |
|---|---|
| `starting` | 控制台已启动更新器，等待更新器接管 |
| `running` | 更新器已接管，正在下载/校验/备份/替换/重启 |
| `succeeded` | 新版本已通过健康检查 |
| `rolled_back` | 新版本失败，已恢复旧代码/数据/依赖并健康 |
| `failed` | 更新失败，且未确认回滚成功 |

必需字段：

```json
{
  "status": "rolled_back",
  "ok": false,
  "version": "2026.11.19",
  "previousVersion": "2026.11.18",
  "startedAt": "2026-11-19T01:00:00.000Z",
  "finishedAt": "2026-11-19T01:02:00.000Z",
  "at": "2026-11-19T01:02:00.000Z",
  "error": "新版本未恢复健康",
  "health": false,
  "healthDetail": "version=2026.11.18 pid=... uptime=...",
  "rolledBack": true,
  "root": "D:\\AI kaifa\\EAB",
  "backupDir": "...",
  "dataBackupDir": "..."
}
```

兼容旧文件：只有 `ok` 和 `at` 时，`ok=true` 推断为 `succeeded`，`ok=false` 推断为 `failed`。

### R7 下载、校验与备份

- 下载源码 zip 到 `.eab-dev/updates/download-<timestamp>/release.zip`。
- 有 `--sha256` 时校验下载文件；校验失败直接失败，不备份、不替换。
- 解压后定位源码根，校验必需文件：
  - `packages/server/src/main.ts`
  - `packages/server/public/chat.html`
  - `packages/server/package.json`
  - `packages/domain/package.json`
  - `packages/storage/package.json`
  - `packages/workspace/package.json`
  - `scripts/eab.mjs`
  - `pnpm-lock.yaml`
- 校验源码 `package.json` 的版本必须等于目标版本。
- 备份代码到 `.eab-dev/updates/backup-<timestamp>/`，备份运行数据到 `.eab-dev/updates/data-backup-<timestamp>/`。
- 不整目录复制 `.eab-dev`。

### R8 停服、替换、重启

- 控制台一键更新会先关闭旧服务，更新器等待 chat 端口释放，最多 30 秒。
- 端口检测语义：
  - 连接成功 = 仍被占用，继续等。
  - 连接被拒绝/主机不可达 = 端口已释放。
  - **连接超时 = 无法确认，不能当成已释放**，继续等待或最终由 `eab stop` 强停。
- 端口释放后备份、替换代码、执行 `pnpm install --frozen-lockfile`。
- 以 `eab start --background` 启动新版本，启动前清掉继承的 `EAB_VERSION`，避免新进程继续上报旧版本。
- 健康检查：目标版本 + 新 pid（拿不到 pid 时要求 uptime 足够短），45 秒。
- 首次健康失败再重启一次，20 秒；仍失败进入回滚。

### R9 失败与回滚

- 新版本健康失败：停新服务、恢复代码、恢复运行数据、重装依赖、启动旧版本、健康检查 30 秒。
- 下载/校验阶段失败：如果旧服务已被关闭，也必须重新启动旧版本。
- 回滚成功：`status=rolled_back`，`ok=false`，`rolledBack=true`，`error` 记录原因。
- 回滚失败：`status=failed`，`ok=false`，`error` 记录原因。
- 回滚完成后页面必须能读到 `rolled_back`，不能只依赖 `/api/health`。

### R10 页面反馈

- 页面位置：一级「系统」→ 二级「系统更新」，位于「系统与运维」右侧；更新内容独占该页，不再混在「系统与运维」里。
- 入口权限：页面以独立分区 `system:update` 登记，自动出现在角色和成员「后台权限」中；只配置一个「可见」，不拆检查更新 / 一键更新动作。
- 执行权限：勾选「系统更新」可见后，即可查看当前/最新版本与 Release notes、执行检查更新和一键更新；「复制命令」只复制命令文本，不调用服务端。
- 接口权限：`GET /api/console/update*`、`POST /api/console/update/check`、`POST /api/console/update/apply` 都只要求 `system:update` 可见。未勾选可见时返回 403，且不得进入更新器。
- 顶栏「新版本 vX」徽标点击后直接进入「系统更新」页。
- 面板展示：当前版本、最新版本、上次检查、更新来源、上次更新结果、Release notes。
- 点击“一键更新”后：
  - 每 2 秒同时检查 `/api/health` 和 `/api/console/update/result`。
  - 健康响应版本等于目标版本 → 成功，刷新页面。
  - 状态文件为 `succeeded` → 成功，刷新页面。
  - 状态文件为 `rolled_back` → 立即提示“更新失败，已回滚到 v旧版本”，恢复按钮。
  - 状态文件为 `failed` → 立即提示失败并给出日志路径，恢复按钮。
  - 状态文件为 `running/starting` → 显示“更新执行中”。
  - 5 分钟仍无结论 → 提示检查 `last-update.log`，恢复按钮。
- 页面刷新/重新进入后，读取 `GET /api/console/update/result` 恢复上次结果。
- “更新中”状态不允许重复点击；按钮本地禁用只是第一层，服务端锁才是最终防线。

### R11 审计

- `ops.update.check`：记录 current、latest、hasUpdate、error。
- `ops.update.apply`：记录 from、to、sourceUrl、sourceDigest、command、updaterPid、startedAt。
- `ops.update.apply.failed`：记录 from、to、sourceUrl、error、updaterPid。
- 审计中的 command 必须包含 `--apply`、`--url`、`--version`、`--root`、`--restart=1`、`--old-pid`；有摘要时包含 `--sha256`。

## 5. 验收用例

### A1 当前已是最新

- 当前 `2026.11.18`，GitHub 最新 `v2026.11.18`。
- 页面显示“已是最新”，一键更新禁用。
- 手动检查不报错。

### A2 正常升级

- 当前 `2026.11.18`，最新 `v2026.11.19`。
- 点击一键更新，状态从 `starting → running → succeeded`。
- 页面在服务恢复后刷新，版本变为 `2026.11.19`。
- `.eab-dev/updates/last-update.json` 有 `status=succeeded`、`finishedAt`、`healthDetail`。

### A3 新版本健康失败并回滚

- 构造目标版本启动失败（如缺少必需文件或端口占用）。
- 状态最终为 `rolled_back`。
- 页面在旧服务恢复后立即显示“已自动回滚到 v2026.11.18”，不等待 5 分钟。
- `.eab-dev/updates/last-update.json` 有 `error`、`rolledBack=true`。

### A4 更新器启动失败

- 将 `scripts/eab-update.mjs` 临时移走或让 Node 无法启动。
- 点击一键更新，接口返回失败，当前服务不关闭。
- `last-update.json` 状态为 `failed`，页面提示检查日志。

### A5 并发点击

- 在更新进行中再次调用 `POST /api/console/update/apply`。
- 第二次返回“已有更新正在执行”，不启动第二个更新器。

### A6 端口占用

- 旧服务未退出且端口连接超时。
- 更新器不能把超时当成空闲，必须继续等待/强停，不得提前替换文件。

### A7 旧状态文件兼容

- `last-update.json` 只有 `{ version, at, ok: true }` 时，页面显示成功。
- `{ version, at, ok: false }` 时，页面显示失败。

### A8 独立页面与入口

- 一级「系统」的二级导航在「系统与运维」右侧出现「系统更新」。
- 点击「系统更新」后只显示更新面板，不同时出现存储、日志、备份等「系统与运维」内容。
- 角色详情「后台权限」与成员「后台访问」都自动出现「系统更新」选项，只提供「可见」，默认不勾选。
- 勾选「系统更新 → 可见」的后台成员即可查看版本页、执行检查更新和一键更新；`GET /api/console/update`、`POST /api/console/update/check`、`POST /api/console/update/apply` 均放行。
- 未授予「系统更新」可见权限的后台成员看不到该二级项，`GET /api/console/update` 返回 403。
- 只有旧 `system:data` 权限的角色/成员升级后仍能看到「系统更新」，并在权限配置中显示为「可见」已勾选。
- 顶栏有新版本徽标时，点击徽标直接进入「系统更新」页。

## 6. 暂不支持

- 控制台同版本重装/修复重装入口（需要显式 `--force`，避免误覆盖）；命令行已支持 `eab update --apply --version=<当前版本> --force`。
- 文档、示例、架构方案随代码一起更新。
- 更新前磁盘空间/权限的完整预检（当前只校验脚本、版本、源码必需文件和摘要）。
- 管理端口独立健康检查（当前以 chat 端口 `/api/health` 为主）。
