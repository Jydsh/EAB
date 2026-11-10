# EAB 企业智能体基座

EAB 是一套面向**单公司本地部署**的企业智能体基座：一个进程同时提供员工对话工作台和管理控制台，数据、模型密钥、插件都落在本机，不依赖公有云多租户。

- 员工入口：`http://127.0.0.1:8787/chat`
- 管理控制台：`http://127.0.0.1:8788/admin`
- 当前版本：`2026.11.10`

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

> 不想先敲 `node scripts/eab.mjs` 也可以直接执行 `pnpm dev`，两种方式等价；`eab server` 是推荐的统一入口。

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
eab server
```

### macOS / Linux

```bash
node scripts/eab.mjs install-cli
```

它会创建 `~/.local/bin/eab` 软链。确认 `~/.local/bin` 在 `PATH` 中后：

```bash
eab server
```

### 常用命令

```text
eab -v, --version              显示当前版本
eab -h, --help                 显示命令帮助
eab server                     前台启动（员工 8787 / 控制台 8788）
eab server --background        后台启动并做健康检查
eab server --host=0.0.0.0      本次启动监听所有网卡
eab server --chat-port=8787 --admin-port=8788
eab stop                       停止本机 EAB 服务
eab update                     检测 GitHub Release 新版本
eab update --apply             确认更新（下载、备份、替换、重启）
eab install-cli                安装 eab 命令并写入用户 PATH
eab doctor                     检查服务、数据库、凭据
eab backup                     备份当前数据库
eab restore <file> --yes       恢复数据库（会先停服务）
eab audit verify               校验审计链
eab audit export               导出审计 CSV
eab user create --name=张三 --dept=d10 --password=... --no=U_ZS
eab plugin list                查看已安装插件
```

`eab server` 不带参数时读取控制台保存的网络设置；带 `--host/--chat-port/--admin-port` 时这些环境变量优先，并会锁定控制台里的对应字段，直到去掉显式参数重启。

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
eab stop
eab server --background
```

局域网访问地址形如 `http://192.168.1.10:8787/chat`、`http://192.168.1.10:8788/admin`。

### 环境变量（部署侧强制覆盖）

```powershell
$env:EAB_HOST = "0.0.0.0"
$env:EAB_PORT = "8787"
$env:EAB_ADMIN_PORT = "8788"
$env:EAB_CONSOLE_ALLOW_REMOTE = "1"
eab server
```

```bash
EAB_HOST=0.0.0.0 EAB_PORT=8787 EAB_ADMIN_PORT=8788 EAB_CONSOLE_ALLOW_REMOTE=1 eab server
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
| `EAB_UPDATE_REPO` | 更新检查仓库，默认 `Jydsh/EAB` |
| `EAB_GITHUB_TOKEN` | 访问私有 Release 或提高 GitHub API 限额时使用 |

更换数据目录：控制台 → 系统 → 数据目录，填绝对路径并保存，重启后会把现有数据库搬过去。不要把 `EAB_HOME` 和 `EAB_DB` 指向同一个会产生冲突的位置。

---

## 五、版本发现与更新

EAB 的版本来自 GitHub Release：

- Release tag：`v2026.11.10`
- Release 资产：源码 zip（`EAB-2026.11.10.zip`）。桌面安装包、`latest.yml`、`.blockmap` 已停止发布。

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
pnpm dev                  # 等价于 eab server
```

发布新版本：

1. 改根 `package.json` 的 `version`；
2. 更新 `README.md` 版本与源码包名；
3. 提交并打 tag：`git tag v2026.11.10 && git push origin v2026.11.10`；
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
`eab stop`，或在控制台改端口；也可以 `eab server --chat-port=... --admin-port=...` 临时启动。

**Q：更新后数据还在吗？**  
在。更新器只替换代码，不碰 `.eab-dev` / `EAB_HOME`。

**Q：以前装过桌面版，现在怎么办？**

先退出桌面版并备份 `%APPDATA%\EAB\data`，再卸载桌面版，按本文的 Web / Node 方式部署；完整步骤见 [`docs/UNINSTALL-REDEPLOY.md`](docs/UNINSTALL-REDEPLOY.md)。

**Q：为什么只有一家公司？**  
这是产品边界：一个实例服务一家公司。多公司请部署多个实例/多个数据目录。
