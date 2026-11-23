# EAB 企业智能体基座

EAB 是一套面向**单公司本地部署**的企业智能体基座：一个进程同时提供员工对话工作台和管理控制台，数据、模型密钥、插件都落在本机，不依赖公有云多租户。

- 员工入口：`http://127.0.0.1:8787/chat`
- 管理控制台：`http://127.0.0.1:8788/admin`
- 当前版本：`2026.11.23`
- 本版发布说明：[`docs/releases/v2026.11.23.md`](docs/releases/v2026.11.23.md)

> 单公司边界：一个实例只服务一家公司。钉钉、飞书、企业微信、模型供应商、知识库、插件都在控制台里配置。

---

## 一、安装方式（Web / Node）

> **桌面版已停止发布。** 旧版 Windows 安装包中的本地服务不再维护，Release 也不再提供 `EAB-Setup-*.exe`。已经安装桌面版的用户，请先卸载桌面版，再按下面的 Web / Node 方式重新部署；数据备份、迁移和清理步骤见 [`docs/UNINSTALL-REDEPLOY.md`](docs/UNINSTALL-REDEPLOY.md)。

适合部署在 Windows / macOS / Linux 服务器上，用浏览器访问。

前置条件：

- Node.js `>= 22.13.0`（推荐 22 LTS 或更高；PDF.js 预览要求该版本起点）
- pnpm `12.x`（`corepack enable` 或 `npm i -g pnpm`）
- Windows 使用 PowerShell；macOS / Linux 使用 bash/zsh

```bash
git clone https://github.com/Jydsh/EAB.git
cd EAB
pnpm install
node scripts/eab.mjs server
```

> 如果 `pnpm install` 卡住，先确认网络和镜像配置；服务端运行不需要 Electron，也不再有桌面端依赖。

### 联网搜索会自动补齐 SearXNG

首次执行 `eab start` / `eab server` 时，EAB 会先检查控制台保存的搜索配置：

1. 已有可用的 SearXNG（本机或远程）→ 直接复用，不再安装；
2. 本机没有，但有 Docker + Compose → 用 `searxng/searxng` 官方镜像启动，只监听 `127.0.0.1`；
3. 没有 Docker，但有 Python 3.10+ → 在 `.eab-dev/searxng-runtime` 下载固定提交的源码、创建虚拟环境并启动；
4. 两种运行时都没有 → 打印明确提示，EAB 继续启动，搜索保持不可用，不影响其他功能。

安装完成后会自动把 `provider=searxng` 和实际地址写入控制台设置，不需要手工改 `console-settings.json`，也不需要另找一台服务器。常用命令：

```bash
eab searxng status              # 查看地址、健康状态、Docker/本机 Python
eab searxng install             # 交互安装：可输入端口，回车自动选空闲端口
eab searxng install --port=8090 # 指定端口安装；被占用会报错，不会强占
eab searxng start               # 启动已安装的运行时
eab searxng restart --port=8090 # 停止旧实例，在新端口启动并写回配置
eab searxng stop                # 停止 EAB 管理的 SearXNG
```

首次部署也可以直接在启动命令上指定：

```bash
eab start --searxng-port=8090
```

不写 `--searxng-port` 时仍从 8080 开始，被占用自动向后顺延最多 50 个端口；写 `auto` 与省略等价。

不希望 EAB 启动时自动安装，可设置 `EAB_SEARXNG_AUTO=0`；已经使用博查/Tavily/Serper 或远程 SearXNG 时也会自动跳过本机安装。自动安装目录在 `.eab-dev/searxng-runtime`，和业务数据一样不进入发布包。

首次启动会在终端打印员工端、控制台、健康检查地址；控制台账号写入：

```text
.eab-dev/admin-credentials.txt
```

浏览器打开 `http://127.0.0.1:8788/admin` 用该账号登录；员工打开 `http://127.0.0.1:8787/chat` 用工号/钉钉登录。

> **新部署实例是空数据**：代码仓库只包含程序本身，不包含插件、知识库文档、渠道绑定、模型供应商和密钥、组织成员等运行数据。换一台机器或新用户部署后，需要登录控制台自行安装插件、配置模型与渠道、创建/导入知识库并同步组织；本机的 `.eab-dev` 数据不会随 GitHub 代码一起过去。

> 不想先敲 `node scripts/eab.mjs` 也可以直接执行 `pnpm dev`，两种方式等价；`eab start` 是推荐的统一入口（旧命令 `eab server` 仍然兼容）。
>
> Windows 前台启动会自动关闭当前终端窗口的“快速编辑”模式。否则鼠标点一下终端就会进入选区，Node 的输出被挂起，表现为服务卡住、再按一次回车才恢复。该设置只影响当前窗口，不改注册表；如果确实需要用鼠标选中日志复制，可以设置 `EAB_KEEP_QUICK_EDIT=1` 跳过这一步，或改用 `eab start --background` 后台运行。

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
eab update                     升级到 GitHub 最新版本（下载、备份、替换、重启）
eab update <版本>              升级或降级到指定版本（如 2026.11.19）
eab update --list              列出可安装的历史版本（--limit=20 控制数量）
eab update <版本> --check      只查看目标版本，不执行安装
eab update <版本> --force      同版本重装
eab update --apply             兼容旧写法，等同 eab update
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

EAB 默认是 **SQLite + 进程内缓存**，不安装 PostgreSQL / Redis 也能完整启动。需要时优先在控制台「连接与平台 → 数据连接」里新增连接：

| 组合 | 配置 | 效果 |
|---|---|---|
| 推荐：控制台接入 | 数据连接新增 Redis / PostgreSQL | 保存即热接入；连接表为空时只用 SQLite + 内存 |
| 默认 | 数据连接为空，不配外部服务 | SQLite 主库 + 内存缓存 |
| 审计读走 PG | 数据连接有 PG，再加 `EAB_AUDIT_READ=postgres` | 审计列表/导出读镜像，失败回退 SQLite |
| 会话列表走 PG | 数据连接有 PG，再加 `EAB_CHAT_READ=postgres` | 会话列表读镜像；未追平/失败回退 SQLite |
| 老部署环境变量兼容 | `EAB_BACKENDS_FROM_ENV=1` + `EAB_REDIS_URL` / `EAB_POSTGRES_URL` | 仅在没有对应数据连接时回退到环境变量 |

```powershell
# 推荐：打开 http://127.0.0.1:8788/admin → 连接与平台 → 数据连接 → ＋ 新增连接
# 老部署需要沿用环境变量时，显式开启兼容开关：
$env:EAB_BACKENDS_FROM_ENV = "1"
$env:EAB_REDIS_URL = "redis://127.0.0.1:6379/0"
$env:EAB_POSTGRES_URL = "postgres://eab:密码@127.0.0.1:5432/eab"
eab start
```

数据连接是平台后端的实际读取来源：表中没有启用的 Redis/PG 时，不会因为环境变量里还留着旧连接串就去探测。保存、测试、删除连接后会自动热重连，不需要重启服务。外部服务连不上时默认降级继续启动；只有 `EAB_BACKENDS_STRICT=1` 才启动失败。**PostgreSQL 当前承接审计镜像和会话镜像，不替换 SQLite 主库**；审计列表/导出可通过 `EAB_AUDIT_READ` 切到 PG，会话列表可通过 `EAB_CHAT_READ` 切到 PG，镜像未追平或失败会自动回退 SQLite。首次接入 PG 时会自动把 SQLite 已有审计回填到镜像，不会出现“切过去是 0 条”。哈希链校验始终读 SQLite 权威链。Redis 当前用于钉钉 accessToken 共享缓存。完整矩阵、写入模型和排障见 [`docs/EAB可选后端插件与部署.md`](docs/EAB可选后端插件与部署.md)。

### 可选：上网与内置浏览器

EAB 内置 `web.fetch`（读取公网网页）、`web.search`（联网搜索）和 `browser`（无头 Edge/Chrome 打开页面并截图）。不配置也能用 `web.fetch` 和 `browser`；`web.search` 需要先配置一个搜索 provider，否则会明确提示“搜索服务未配置”，不会伪造结果。

| 环境变量 | 作用 |
|---|---|
| `EAB_WEB_SEARCH_PROVIDER` | `none` / `searxng` / `bocha` / `tavily` / `serper`；不设置时按 `auto`，`eab start` 会先自动检查/补齐 SearXNG |
| `EAB_SEARXNG_URL` | 自建 SearXNG 地址，例如 `http://127.0.0.1:8080`；只配它也会自动启用 searxng |
| `EAB_SEARXNG_AUTO` | 默认 `1`；设为 `0` 时 `eab start` 不自动安装 SearXNG |
| `EAB_SEARXNG_IMAGE` | 可选：Docker 镜像，默认 `searxng/searxng:latest` |
| `EAB_SEARXNG_SOURCE_URL` | 可选：源码 tar.gz 地址；内网可指向镜像，默认固定提交 `c6ee3e9` |
| `EAB_PYTHON` | 可选：没有 Docker 时用于建虚拟环境的 Python 路径，默认自动找 `python` / `python3` |
| `EAB_BOCHA_API_KEY` | 博查搜索 Key |
| `EAB_TAVILY_API_KEY` | Tavily 搜索 Key |
| `EAB_SERPER_API_KEY` | Serper 搜索 Key |
| `EAB_WEB_ALLOWED_DOMAINS` | 可选：只允许访问这些域名，逗号分隔 |
| `EAB_WEB_DENIED_DOMAINS` | 可选：禁止访问这些域名，逗号分隔 |
| `EAB_HTTP_PROXY` | 可选：HTTP/HTTPS 出网代理；也兼容 `HTTPS_PROXY`、`HTTP_PROXY` 及小写形式 |
| `EAB_NO_PROXY` | 可选：代理旁路列表；也兼容 `NO_PROXY` / `no_proxy` |
| `EAB_BROWSER_PROXY` | 可选：浏览器独立代理；不填则复用上面的出网代理 |
| `EAB_WEB_SEARCH_PER_MIN` | 每用户每分钟搜索上限，默认 `10` |
| `EAB_WEB_FETCH_PER_MIN` | 每用户每分钟读网页上限，默认 `20` |
| `EAB_BROWSER_PER_MIN` | 每用户每分钟浏览器动作上限，默认 `20` |
| `EAB_BROWSER_ENABLED` | 默认 `1`；`0` 关闭 `browser` |
| `EAB_BROWSER_CHANNEL` | `msedge` / `chrome` / `chromium`，Windows 默认 `msedge` |
| `EAB_BROWSER_EXECUTABLE_PATH` | 浏览器可执行文件的绝对路径，优先于 channel |
| `EAB_BROWSER_HEADLESS` | 默认 `1`，无头运行 |
| `EAB_BROWSER_MAX_PAGES` | 全局最多页面数，默认 `4` |
| `EAB_BROWSER_IDLE_MS` | 空闲回收时长，默认 `300000`（5 分钟） |

`browser` 依赖本机 Edge/Chrome；`playwright-core` 是 `optionalDependencies`，没有浏览器时只会让 `browser` 不可用，不影响服务启动。截图会写入个人云空间，员工端工具卡直接显示。详细边界与安全策略见 [`docs/EAB内置浏览器与上网能力方案.md`](docs/EAB内置浏览器与上网能力方案.md)。

**控制台配置**：`连接与平台 → 数据连接` 用一张统一连接表管理全部外部资源，表体固定分「数据源」和「平台服务」两组：数据源是 PostgreSQL / MySQL / SQLite / Redis，平台服务是联网搜索、内置浏览器和内网访问。右上角「＋ 新增连接」打开接入向导，先选类型，再进入统一的步骤 2 表单；选择数据库也会沿用向导头部、返回和步骤条，不再跳成另一套弹窗。搜索行提供“测试 / 配置”，点“配置”进入步骤 2：先看到 6 张服务卡片（自动 / 关闭搜索 / SearXNG / 博查 / Tavily / Serper），卡片标出“当前 / 已保存 / 未配置”，下方只展开选中那个服务的表单，SearXNG 只填地址、其余只填各自 Key，多套配置分别保留、互不覆盖；“仅保存此配置”只写当前服务不切换生效服务，“设为当前并测试”会立即执行一次真实搜索。`SearXNG 地址`包含端口，可指向任意主机或端口，改完保存即测试，不需要重启 EAB；本地开发实例可用 `.\\.eab-dev\\start-searxng.ps1 -Port 8090` 切换端口，脚本会先停止旧实例。Key 只写入 `.eab-dev/secrets.json`，页面只显示“已配置/未配置”，不回显明文。环境变量优先于控制台配置；控制台状态会标注来源。保存后搜索缓存立即清空，不需要重启。数据库、缓存与平台服务共用筛选计数和刷新状态，不再放在「系统 → 运行与准入」。配置读写权限随「数据连接」页可见放行，页面只调用 `/api/console/settings/web-services` 读取搜索、浏览器和内网三个视图，不再依赖「系统 → 系统与运维」权限。

同一张统一连接表「平台服务」分组的内网访问行点“配置”，可以设置**内置浏览器内网访问**：默认关闭；打开开关后必须填写域名/IP 白名单，只放行名单内目标。公共网站不受影响，`localhost` 和 EAB 自身地址始终拒绝，`web.fetch` 仍只读公网。开关打开但名单为空时后端拒绝保存，避免“一开全通”。保存后下一次浏览器打开或导航立即按新策略校验，子资源同样受控。内网目标当前只支持 80/443 标准网页端口。

**代理**：`web.fetch`、搜索 provider 和 `browser` 共用代理配置。HTTP 目标通过代理发 absolute-form 请求；HTTPS 目标先 `CONNECT` 建隧道，再由本地完成 TLS 握手。`NO_PROXY` 命中的目标仍直连，并保留 DNS 固定 IP 的防重绑定逻辑。代理只支持 http/https，不支持 socks；企业 MITM 证书用 `NODE_EXTRA_CA_CERTS`。代理地址可能带凭据，属于部署基础设施，只在环境变量配置；控制台只读显示当前出口，不提供编辑。

本机开发环境已带一个本地 SearXNG（Bing + Baidu，`http://127.0.0.1:8080`），启动命令：

```powershell
powershell -File .eab-dev\start-searxng.ps1
```

源码、虚拟环境和设置都在 `.eab-dev`，不进入发布包。生产部署不需要手工另起 SearXNG：`eab start` 会自动复用已有实例，缺失时优先用 Docker 启动，没有再回退到本机 Python 安装；首次部署可在 `eab start` 上加 `--searxng-port=8090` 指定端口，或运行 `eab searxng install` 按提示输入，回车交给系统自动选择。也可以直接用 `eab searxng install`、`eab searxng status` 管理。没有安装条件时仍可配置博查/Tavily/Serper Key，或在另一台服务器部署后把 `EAB_SEARXNG_URL` 指过去。

**审计与限流**：`web.search`、`web.fetch`、`browser` 的成功和失败都会写审计，动作分别是 `net.web.search`、`net.web.fetch`、`net.browser`；只记搜索词、URL、标题、字符数、动作、截图 fileId、耗时和错误摘要，不记网页正文和密钥。每用户独立限流，默认搜索 10 次/分钟、读网页 20 次/分钟、浏览器动作 20 次/分钟；超出返回 `EAB_RATE_LIMITED`（HTTP 429），不会消耗幂等重放额度。

---

## 五、版本发现与更新

EAB 的版本来自 GitHub Release：

- Release tag：`v2026.11.23`
- Release 资产：源码 zip（`EAB-2026.11.23.zip`）。桌面安装包、`latest.yml`、`.blockmap` 已停止发布。

### 两种更新方式

**一键更新（控制台）**

管理控制台 → 系统 → **系统更新**：

页面在角色详情「后台权限」和成员「后台访问」中只配置一个「可见」：勾选后即可查看版本、检查更新、一键更新和使用复制命令；未勾选则没有该页入口。升级时会从原有「系统与运维」可见权限回填，已有后台角色不会丢失入口。

1. 点「检查更新」，读取 GitHub 最新 Release；
2. 有新版本时「一键更新」按钮可用；
3. 确认后服务调用更新器：先写 `starting` 状态并等待更新器确认接管 → 下载源码包 → 校验版本与 SHA-256（Release 提供 digest 时）→ 备份代码和数据库/配置 → 替换 → `pnpm install --frozen-lockfile` → `eab restart --background` → 健康检查（版本 + 新进程 pid，确认不是旧进程）→ 失败自动回滚并重新拉起旧版本；
4. 页面按 `/api/console/update/result` 和 `/api/health` 同时跟踪，能区分“成功 / 已回滚 / 失败 / 执行中”；回滚后会立即提示，不再空等 5 分钟；
5. 更新器启动失败时服务不会被关闭；同一时间只允许一个更新器运行；
6. 更新结果和健康状态写入 `.eab-dev/updates/last-update.json` 与 `last-update.log`，字段与验收口径见 [docs/EAB一键更新需求与验收.md](docs/EAB一键更新需求与验收.md)。

**命令更新**

```bash
eab update                              # 升级到最新版本
eab update 2026.11.19                   # 升级或降级到指定版本
eab update --list                       # 列出可安装的历史版本
eab update 2026.11.19 --check           # 只查看目标版本，不安装
eab update 2026.11.23 --force           # 当前版本重装
```

`eab update` 现在直接执行安装，不再需要 `--apply`；`--apply` 仅保留为旧写法兼容。不带版本号时读取 GitHub 最新 Release，带版本号时按该版本安装，因此同一条命令既可升级也可降级。指定版本时仍会校验 Release 源码包里的 `package.json` 版本与目标版本一致；同版本默认不重装，必须显式加 `--force`。降级和重装都会先停服务、备份代码与运行数据，失败自动回滚。`--version=2026.11.19` 或 `--version 2026.11.19` 仍可用。

更新范围只替换代码与根配置（`packages/`、`scripts/`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`tsconfig*.json`、`README.md`、`LICENSE`、`.gitignore`），**不会覆盖 `.eab-dev` 数据目录**，也不会覆盖 `docs/`、`demo/`、`EAB使用说明.md`、`EAB企业智能体基座-总体架构方案.md`、`plugins/`、`skills/`、`plans/`。失败会自动回滚代码并恢复依赖；日志在 `.eab-dev/updates/last-update.log`。

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
3. 提交并打 tag：`git tag v2026.11.23 && git push origin v2026.11.23`；
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
