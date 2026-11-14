# EAB 企业智能体基座

EAB 是一套面向**单公司本地部署**的企业智能体基座：一个进程同时提供员工对话工作台和管理控制台，数据、模型密钥、插件都落在本机，不依赖公有云多租户。

- 员工入口：`http://127.0.0.1:8787/chat`
- 管理控制台：`http://127.0.0.1:8788/admin`
- 当前版本：`2026.11.14`

> 单公司边界：一个实例只服务一家公司。钉钉、飞书、企业微信、模型供应商、知识库、插件都在控制台里配置。

---

## 一、安装方式（Web / Node）

> **桌面版已停止发布。** 旧版 Windows 安装包中的本地服务不再维护，Release 也不再提供 `EAB-Setup-*.exe`。已经安装桌面版的用户，请先卸载桌面版，再按下面的 Web / Node 方式重新部署；数据备份、迁移和清理步骤见 [`docs/UNINSTALL-REDEPLOY.md`](docs/UNINSTALL-REDEPLOY.md)。

适合部署在 Windows / macOS / Linux 服务器上，用浏览器访问。

前置条件：

- Node.js `>= 22.5.0`（推荐 22 LTS 或更高）
- pnpm `12.x`（`corepack enable` 或 `npm i -g pnpm`）
- Windows 使用 PowerShell；macOS / Linux 使用 bash/zsh

```bash
git clone https://github.com/Jydsh/EAB.git
cd EAB
pnpm install
node scripts/eab.mjs server
```

> 如果 `pnpm install` 卡住，先确认网络和镜像配置；服务端运行不需要 Electron，也不再有桌面端依赖。

首次启动会在终端打印员工端、控制台、健康检查地址；控制台账号写入：

```text
.eab-dev/admin-credentials.txt
```

浏览器打开 `http://127.0.0.1:8788/admin` 用该账号登录；员工打开 `http://127.0.0.1:8787/chat` 用工号/钉钉登录。

> **新部署实例是空数据**：代码仓库只包含程序本身，不包含插件、知识库文档、渠道绑定、模型供应商和密钥、组织成员等运行数据。换一台机器或新用户部署后，需要登录控制台自行安装插件、配置模型与渠道、创建/导入知识库并同步组织；本机的 `.eab-dev` 数据不会随 GitHub 代码一起过去。

> 不想先敲 `node scripts/eab.mjs` 也可以直接执行 `pnpm dev`，两种方式等价；`eab start` 是推荐的统一入口（旧命令 `eab server` 仍然兼容）。

---

## 二、`eab` 命令（加入 PATH）

### Windows

在项目根目录执行：

```powershell
node scripts\eab.mjs install-cli
```

它会：

1. 创建 `%LOCALAPPDATA%\EAB\bin\eab.cmd`；
2. 把 `%LOCALAPPDATA%\EAB\bin` 写入**当前用户**的 `Path`（不修改系统级 PATH，不需要管理员）。

**新开一个 PowerShell 窗口**后即可：

```powershell
eab start
```

### macOS / Linux

```bash
node scripts/eab.mjs install-cli
```

它会创建 `~/.local/bin/eab` 软链。确认 `~/.local/bin` 在 `PATH` 中后：

```bash
eab start
```

### 常用命令

```text
eab -v, --version              显示当前版本
eab -h, --help                 显示命令帮助
eab start                      前台启动（员工 8787 / 控制台 8788）
eab start server               等价写法（server 可省略）
eab start --background         后台启动并做健康检查
eab start --host=0.0.0.0       本次启动监听所有网卡
eab start --chat-port=8787 --admin-port=8788
eab restart                    先停止，再按 start 参数启动
eab restart --background       停止后后台启动
eab stop                       停止本机 EAB 服务
eab stop server                等价写法（server 可省略）
eab server                     兼容旧写法，等价 eab start server
eab update                     检测 GitHub Release 新版本
eab update --apply             确认更新（下载、备份、替换、重启）
eab install-cli                安装 eab 命令并写入用户 PATH
eab doctor                     检查服务、数据库、凭据
eab backup                     备份当前数据库
eab backup --full              备份运行数据（数据库 + 插件包 + dsh-home + 设置，不含密钥）
eab restore <file|目录> --yes  恢复数据库或运行数据备份（会先停服务）
eab audit verify               校验审计链
eab audit export               导出审计 CSV
eab user create --name=张三 --dept=d10 --password=... --no=U_ZS
eab plugin list                查看已安装插件
```

`eab start`、`eab start server` 不带参数时读取控制台保存的网络设置；带 `--host/--chat-port/--admin-port` 时这些环境变量优先，并会锁定控制台里的对应字段，直到去掉显式参数重启。

---

## 三、端口、IP 与局域网访问

默认：

| 用途 | 默认地址 | 环境变量 |
|---|---|---|
| 员工对话 | `127.0.0.1:8787` | `EAB_PORT` |
| 管理控制台 | `127.0.0.1:8788` | `EAB_ADMIN_PORT` |
| 监听地址 | `127.0.0.1` | `EAB_HOST` |
| 控制台是否允许局域网登录 | 关闭 | `EAB_CONSOLE_ALLOW_REMOTE=1` |

### 在控制台里改（推荐）

管理控制台 → **系统 → 网络与访问入口**：

- `监听地址`：本机使用填 `127.0.0.1`；局域网访问填 `0.0.0.0`
- `员工对话端口` / `管理控制台端口`：两个端口不能相同
- `允许局域网登录控制台`：默认只允许本机登录；开启后局域网设备可访问 `/admin`
- 保存后需要**重启服务**才生效；页面会提示

重启：

```powershell
eab restart --background
```

局域网访问地址形如 `http://192.168.1.10:8787/chat`、`http://192.168.1.10:8788/admin`。

### 环境变量（部署侧强制覆盖）

```powershell
$env:EAB_HOST = "0.0.0.0"
$env:EAB_PORT = "8787"
$env:EAB_ADMIN_PORT = "8788"
$env:EAB_CONSOLE_ALLOW_REMOTE = "1"
eab start
```

```bash
EAB_HOST=0.0.0.0 EAB_PORT=8787 EAB_ADMIN_PORT=8788 EAB_CONSOLE_ALLOW_REMOTE=1 eab start
```

> 安全提醒：`0.0.0.0` 会把员工端和控制台暴露到局域网。生产环境至少要做到：
> 1. 只开放员工端 8787；控制台 8788 仅本机或内网白名单；
> 2. 在服务器防火墙/安全组放行所需端口，其余关闭；
> 3. 不要把控制台直接暴露到公网，前面加反向代理和访问控制。

---

## 四、数据目录与环境变量

默认数据目录是项目根下的 `.eab-dev`。如果你是从旧桌面版迁移，数据默认在 `%APPDATA%\EAB\data`，迁移方法见 [`docs/UNINSTALL-REDEPLOY.md`](docs/UNINSTALL-REDEPLOY.md)。

| 环境变量 | 作用 |
|---|---|
| `EAB_HOME` | 部署目录（数据库、密钥、凭据、备份、更新日志） |
| `EAB_DB` | 直接指定 SQLite 文件路径；设置后控制台不能改数据目录 |
| `EAB_HOST` | 监听地址 |
| `EAB_PORT` | 员工对话端口 |
| `EAB_ADMIN_PORT` | 管理控制台端口 |
| `EAB_CONSOLE_ALLOW_REMOTE` | `1` 允许局域网登录控制台 |
| `EAB_VERSION` | 覆盖健康检查显示的版本号；默认读 `package.json` |
| `EAB_PUBLIC_DIR` | 可选：覆盖静态页面目录 |
| `EAB_MIGRATIONS_DIR` | 可选：覆盖迁移 SQL 目录 |
| `EAB_PLUGINS_DIR` | 可选：覆盖插件目录 |
| `EAB_CACHE` | 可选缓存：`auto` / `memory` / `redis` / `off`，默认 `auto` |
| `EAB_REDIS_URL` | Redis 连接串；不配则只用内存缓存 |
| `EAB_REDIS_PREFIX` | Redis key 前缀，默认 `eab:` |
| `EAB_POSTGRES` | 可选 PostgreSQL：`auto` / `off` / `mirror`，默认 `auto` |
| `EAB_POSTGRES_URL` | PostgreSQL 连接串；不配则不启用审计/会话镜像 |
| `EAB_AUDIT_READ` | 审计列表/导出数据源：`sqlite` / `postgres` / `auto`，默认 `sqlite`；PG 失败自动回退 |
| `EAB_CHAT_READ` | 会话列表数据源：`sqlite` / `postgres` / `auto`，默认 `sqlite`；镜像未追平/失败自动回退 |
| `EAB_BACKENDS_STRICT` | `1` 时外部后端连不上直接启动失败，默认 `0` 降级 |
| `EAB_UPDATE_REPO` | 更新检查仓库，默认 `Jydsh/EAB` |
| `EAB_GITHUB_TOKEN` | 访问私有 Release 或提高 GitHub API 限额时使用 |

更换数据目录：控制台 → 系统 → 数据目录，填绝对路径并保存，重启后会把现有数据库搬过去。不要把 `EAB_HOME` 和 `EAB_DB` 指向同一个会产生冲突的位置。

### 可选 PostgreSQL / Redis（不接也能用）

EAB 默认是 **SQLite + 进程内缓存**，不安装 PostgreSQL / Redis 也能完整启动。需要时可按任意组合接入：

| 组合 | 配置 | 效果 |
|---|---|---|
| 默认 | 不配任何变量 | SQLite 主库 + 内存缓存 |
| 只接 Redis | `EAB_CACHE=redis` + `EAB_REDIS_URL` | Redis 优先缓存，故障自动回退内存 |
| 只接 PostgreSQL | `EAB_POSTGRES=mirror` + `EAB_POSTGRES_URL` | SQLite 主库 + 审计镜像 + 会话镜像 |
| 审计读走 PG | 再加 `EAB_AUDIT_READ=postgres` | 审计列表/导出读镜像，失败回退 SQLite |
| 会话列表走 PG | 再加 `EAB_CHAT_READ=postgres` | 会话列表读镜像；未追平/失败回退 SQLite |
| 两者都接 | 同时配置 | 缓存共享 + 审计/会话镜像 |

```powershell
$env:EAB_REDIS_URL = "redis://127.0.0.1:6379/0"
$env:EAB_POSTGRES_URL = "postgres://eab:密码@127.0.0.1:5432/eab"
eab start
```

外部服务连不上时默认降级继续启动；只有 `EAB_BACKENDS_STRICT=1` 才启动失败。**PostgreSQL 当前承接审计镜像和会话镜像，不替换 SQLite 主库**；审计列表/导出可通过 `EAB_AUDIT_READ` 切到 PG，会话列表可通过 `EAB_CHAT_READ` 切到 PG，镜像未追平或失败会自动回退 SQLite。首次接入 PG 时会自动把 SQLite 已有审计回填到镜像，不会出现“切过去是 0 条”。两条路径切换只需改环境变量并重启服务，不需要改代码或迁移数据。哈希链校验始终读 SQLite 权威链。Redis 当前用于钉钉 accessToken 共享缓存。完整矩阵、写入模型和排障见 [`docs/EAB可选后端插件与部署.md`](docs/EAB可选后端插件与部署.md)。

---

## 五、版本发现与更新

EAB 的版本来自 GitHub Release：

- Release tag：`v2026.11.14`
- Release 资产：源码 zip（`EAB-2026.11.14.zip`）。桌面安装包、`latest.yml`、`.blockmap` 已停止发布。

### 两种更新方式

**一键更新（控制台）**

管理控制台 → 系统 → **版本更新**：

1. 点「检查更新」，读取 GitHub 最新 Release；
2. 有新版本时「一键更新」按钮可用；
3. 确认后服务调用更新器：下载源码包 → 校验版本 → 备份代码 → 替换 → `pnpm install` → 重启；
4. 页面短暂断开，刷新后查看新版本。

**命令更新**

```bash
eab update            # 只检测并显示当前/最新版本
eab update --apply    # 确认更新
```

更新范围只替换代码目录（`packages/`、`scripts/`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`tsconfig*.json`、`README.md`、`LICENSE`、`.gitignore`），**不会覆盖 `.eab-dev` 数据目录**。失败会自动回滚代码并恢复依赖；日志在 `.eab-dev/updates/last-update.log`。

> 备份口径：`eab backup` / 控制台「SQLite 快照」只备份主库；`eab backup --full` / 控制台「运行数据备份」额外包含 `plugins/`、`dsh-home/`、`dsh/`、`workspaces/`、`company-assets/` 和 `console-settings.json`。两类备份都不复制 `secrets.json` 与 `admin-credentials.txt`，恢复后需要重新确认密钥/控制台口令。运行数据备份可能达到数百 MB，接口会后台生成，页面轮询任务状态。
>
> 恢复会先停服务，把当前 `eab.db` 复制到 `restore-safety-<时间戳>/eab.db`；运行数据恢复还会把当前运行目录整体改名到该安全目录，再按 `manifest.json` 回填，并清理 `eab.db-wal/shm`。旧目录会保留，确认无误后再手动清理。

启动时也会异步检查一次新版本，只在终端打印提示，不阻塞服务。

---

## 六、目录结构

```text
EAB/
├── packages/
│   ├── domain/       领域模型、错误码、权限 scope
│   ├── authz/        鉴权
│   ├── storage/      SQLite 与迁移
│   ├── workspace/    工作区/空间
│   ├── channel/      钉钉、飞书、企业微信渠道
│   ├── server/       Fastify 服务、控制台/员工端页面、Agent
├── scripts/
│   ├── eab.mjs       CLI：server / stop / update / install-cli
│   └── eab-update.mjs 源码更新器（下载/备份/替换/回滚/重启）
├── plugins/          插件（hello / oncall / dsh-*）
├── docs/             补充文档
└── .eab-dev/         运行数据（不入库）
```

---

## 七、开发与发布

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm dev                  # 等价于 eab start
```

发布新版本：

1. 改根 `package.json` 的 `version`；
2. 更新 `README.md` 版本与源码包名；
3. 提交并打 tag：`git tag v2026.11.14 && git push origin v2026.11.14`；
4. GitHub Actions 只构建源码 zip 并创建/更新 Release，不再生成桌面安装包；
5. 控制台/CLI 的版本检查读取该 Release。

---

## 八、许可

本项目采用「源码可见、禁止商用」许可：允许个人/企业内部学习与自用，禁止未授权的商业销售、SaaS 转售、二次分发收费版本。商业授权请联系作者。完整条款见 [`LICENSE`](LICENSE)。

---

## 九、常见问题

**Q：控制台打不开？**  
确认服务已启动：`eab doctor` 或 `curl http://127.0.0.1:8787/api/health`；控制台是 8788，不是 8787。

**Q：局域网设备访问不了？**  
控制台把监听地址改为 `0.0.0.0` 并重启；确认防火墙放行 8787/8788；控制台还需开启「允许局域网登录控制台」。

**Q：端口被占用？**  
`eab stop`，或在控制台改端口；也可以 `eab start --chat-port=... --admin-port=...` 临时启动。

**Q：更新后数据还在吗？**  
在。更新器只替换代码，不碰 `.eab-dev` / `EAB_HOME`。

**Q：以前装过桌面版，现在怎么办？**

先退出桌面版并备份 `%APPDATA%\EAB\data`，再卸载桌面版，按本文的 Web / Node 方式部署；完整步骤见 [`docs/UNINSTALL-REDEPLOY.md`](docs/UNINSTALL-REDEPLOY.md)。

**Q：为什么只有一家公司？**  
这是产品边界：一个实例服务一家公司。多公司请部署多个实例/多个数据目录。
