# EAB Desktop（Windows 桌面客户端）

访问已有 EAB 服务的 Electron 客户端。它不做第二套业务 UI，直接加载服务端 `/chat`，把右侧网页工作台从服务端 JPEG 投屏改为原生 Chromium `WebContentsView`。

## 关系与边界

- Web / Node 仍是默认入口，桌面版是可选的访问端。
- 桌面客户端不自带服务端、数据库、模型密钥或知识库，只连接管理员提供的 EAB 地址。
- 主窗口、原生网页标签、登录会话共用同一个 `persist:eab-web-*` 分区，登录一次即可共享 Cookie。
- Agent 的浏览器工具仍走服务端 Playwright；桌面原生页面的 Agent 控制桥尚未接入。

## 开发运行

```powershell
# 1. 启动 EAB 服务（8787）
pnpm dev

# 2. 另开终端启动桌面客户端
pnpm desktop
```

首次启动没有配置时，会进入 `setup.html` 填写服务地址。保存后写入：

```text
%APPDATA%\EAB\desktop-config.json
```

地址来源优先级：`EAB_DESKTOP_URL` 环境变量 > 用户配置 > 安装目录内 `resources\app\desktop-config.json`。Windows 安装包会读取自身下载来源，把服务器地址写进安装目录配置，首次启动直接进入工作台；便携版或来源识别失败时才需要手动填写。

| 变量 | 作用 |
|---|---|
| `EAB_DESKTOP_URL` | 跳过首次配置，直接加载指定地址 |
| `EAB_DESKTOP_OWNER` | 会话分区标识，默认 `default`；同一员工应固定使用同一值 |
| `EAB_DESKTOP_COOKIE` | 仅开发态：注入 `eab_session` 做本机自动化验收，打包后忽略 |

## 构建 Windows 安装包与便携包

```powershell
pnpm desktop:installer
```

产物：

- 安装包：`packages/desktop/release/EAB-Setup-<版本>-x64.exe`
- 便携目录：`packages/desktop/release/EAB-Desktop-Windows-x64`
- 便携压缩包：`packages/desktop/release/EAB-Desktop-Windows-x64.zip`
- 更新清单：`packages/desktop/release/desktop-release.json`，含版本、文件名、大小、SHA256

服务端下载与更新接口：

- `GET /download/desktop`：说明页，提供安装包和便携版入口
- `GET /download/desktop/windows`：优先返回 Setup EXE，安装包缺失时退回 zip
- `GET /download/desktop/setup`：只返回 Setup EXE，也是桌面自动更新的唯一下载入口
- `GET /download/desktop/portable`：只返回便携 zip
- `GET /api/desktop/update?platform=win32&arch=x64&currentVersion=...`：返回是否有更新、版本、大小、SHA256、下载地址
- `GET /api/desktop/version`：返回当前可用桌面版本

## 安装与卸载

安装器用 NSIS 3 编译，脚本在 `installer/eab-installer.nsi`，不依赖 electron-builder。

- 默认安装到 `C:\Program Files\EAB`；安装向导的「选择安装位置」页可以点“浏览”改到其他目录。
- 安装前会先结束正在运行的 `EAB.exe`，避免 Electron 文件被占用。
- 安装完成后写入开始菜单 `EAB` 程序组、公共桌面快捷方式，以及 `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\EAB` 卸载项。
- 卸载向导包含欢迎、卸载选项、确认、进度、完成五页；可在“卸载选项”页勾选同时删除 `%APPDATA%\EAB`，默认保留。
- 安装阶段读取安装包的 `Zone.Identifier`（`HostUrl` / `ReferrerUrl`），把来源服务器 origin 写入 `resources\app\desktop-config.json`；构建时也可用 `EAB_DESKTOP_SERVER_URL` / `EAB_DESKTOP_URL` 兜底。
- 安装器释放 `$INSTDIR\assets\eab.ico`，桌面快捷方式、开始菜单和“应用和功能”共用这个多尺寸品牌图标；不要再只引用 `resources\app` 外的未释放路径。
- 卸载会删除程序目录、开始菜单、桌面快捷方式和注册表项；程序目录通过 `.eab-install` 标记确认，避免误删用户选错目录。
- 安装包和卸载器仍未做代码签名，Windows 可能提示“未知发布者”。

## 已实现

- 首次启动服务地址配置、错误提示、连接后进入聊天页；安装包下载来源自动绑定服务器；
- 设置页「客户端」分组：Web 端下载桌面版，桌面端打开「EAB 服务器」重新配置，并可手动「检查更新」；
- 原生网页标签：打开、导航、后退、前进、刷新、关闭、标题/URL/favicon/加载态同步；
- 内网 HTTP 语音：启动时把当前 EAB 服务 origin 声明为可信来源，`navigator.mediaDevices` 和语音对话在无 HTTPS 的内网地址下也可用；只作用于当前 EAB 地址，右侧第三方网站不继承；
- 标签页行为对齐豆包浏览器：普通链接同页跳转，`target=_blank` / `window.open` / Ctrl+点击新开标签，Ctrl+点击和中键后台打开；
- 原生页右键菜单、Ctrl+T/W/Tab/L、Alt+←→、F5/Ctrl+R 快捷键；
- 原生视口 bounds 跟随 `#web-frame-shell`，窗口缩放后自动重排；
- 桌面模式不再请求 `/api/browser/workspace/:pageId/frame`，也不启动 JPEG 取帧定时器；
- 主窗口和原生标签共享持久会话，登录一次两边通用；
- 服务器驱动自动更新：启动后 12 秒检查、之后每 4 小时；发现新版本弹窗、顶栏胶囊、下载进度、SHA256 校验、`RunAs` 静默安装并重启；
- 品牌图标：构建时用 rcedit 把 `eab.ico` 写入 `EAB.exe`，并释放到 `$INSTDIR\assets`；快捷方式、标题栏、任务栏、资源管理器一致；
- 安全默认值：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`，只允许 http/https，标签弹窗由 EAB 自己接管，其他外链交给系统浏览器。

## 已知限制

- 未接入 Agent 控制桥；桌面原生页 `dp_*` 与服务端页 `bp_*` 的 pageId 尚未统一。
- 未实现 Web 与桌面之间的免登录握手，桌面首次启动仍需在窗口内登录。
- 安装包未做代码签名；更新安装阶段会触发一次 UAC；崩溃上报尚未接入。
- 暂无 macOS / Linux 构建；当前只发布 Windows x64 安装包和便携包。
