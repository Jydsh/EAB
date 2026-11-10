# 桌面端与发布

本文说明 EAB 桌面端的结构、打包方式，以及 GitHub Release 的版本资产约定。安装/使用见根 [`README.md`](../README.md)。

## 1. 桌面端是什么

桌面端是 Electron 外壳 + **内置 EAB 服务**：

```text
EAB.exe（Electron 主进程）
  └─ 启动 build/server.mjs（Node 服务，ELECTRON_RUN_AS_NODE）
       ├─ 员工端  http://127.0.0.1:8787/chat
       └─ 控制台  http://127.0.0.1:8788/admin
```

- 用户安装后不需要再装 Node.js / pnpm；
- 数据目录固定为 `%APPDATA%\EAB\data`，数据库、密钥、凭据、备份都在这里；
- 服务只监听本机，局域网地址/端口可在控制台「系统 → 网络与访问入口」修改；
- 仍保留连接远程 EAB 服务器的能力（浏览器直接访问远程地址即可）；
- 桌面端更新走 `electron-updater`，和控制台/CLI 的源码更新是两条独立通道。

## 2. 代码结构

```text
packages/desktop/
├── package.json     electron-builder 配置、版本号
├── main.cjs         主进程：拉起/停止本地服务、菜单、桌面更新
└── build/           由 scripts/build-desktop.mjs 生成（不入库）
    ├── server.mjs   esbuild 打好的服务端（ESM）
    ├── public/      server/public 静态页面
    ├── migrations/  SQLite 迁移 SQL
    └── plugins/     插件目录
```

## 3. 本地构建

```bash
pnpm install
pnpm desktop:build
```

`desktop:build` 会：

1. 用 esbuild 把 `packages/server/src/main.ts` 及其 workspace 依赖打成 `packages/desktop/build/server.mjs`（ESM，target node22）；
2. 复制 `packages/server/public`；
3. 复制 `packages/storage/migrations`；
4. 复制 `plugins/`（跳过 `.trash`）。

产物检查：

```bash
node packages/desktop/build/server.mjs
```

服务启动后会读 `EAB_HOME`（未设置则回退项目 `.eab-dev`），控制台地址打印在终端。

### 开发模式启动桌面端

先准备构建产物，再启动 Electron：

```bash
pnpm desktop:build
pnpm --filter @eab/desktop start
```

开发模式下 `main.cjs` 不检查桌面更新，服务日志在 `%APPDATA%\EAB\logs\server.log`。

## 4. 打 Windows 安装包

```bash
pnpm desktop:dist
```

等价于：

```bash
pnpm desktop:build
pnpm --filter @eab/desktop dist
```

产物：

```text
packages/desktop/release/
├── EAB-Setup-2026.11.10.exe
├── EAB-Setup-2026.11.10.exe.blockmap
└── latest.yml
```

安装包是 NSIS，支持选择安装目录，创建桌面/开始菜单快捷方式。

## 5. Release 资产约定

每个版本对应一个 GitHub Release：

- tag：`v2026.11.10`
- 资产：
  - `EAB-2026.11.10.zip`：源码包（由 workflow 从 tag 生成，包含除 `.eab-dev` 外的代码）；
  - `EAB-Setup-2026.11.10.exe`：Windows 安装包；
  - `latest.yml` / `.blockmap`：桌面端自动更新元数据。

控制台/CLI 的更新器优先使用 Release 里的 `.zip` 源码资产；如果没有，回退到 GitHub 的 `zipball_url`。安装包只给桌面端更新使用。

## 6. GitHub Actions

`.github/workflows/release.yml` 在推送 `v*` tag 时执行：

1. checkout；
2. `pnpm install --frozen-lockfile`；
3. `pnpm typecheck` + `pnpm test`；
4. `pnpm desktop:dist`；
5. `gh release create` 或 `gh release upload` 上传安装包、`latest.yml`、`.blockmap`，并生成源码 zip。

需要的 Secrets：

- `GITHUB_TOKEN`：仓库默认提供，用于创建 Release 和上传资产；
- 如果构建签名安装包，另加证书相关 secrets（未配置时输出未签名安装包，Windows 可能提示未知发布者）。

## 7. 桌面自动更新

`main.cjs` 在打包后启用 `electron-updater`：

- 启动 5 秒后检查 `Jydsh/EAB` 的最新 Release；
- 发现新版本弹窗询问「下载并安装 / 稍后」；
- 下载完成后再询问「立即重启 / 稍后」；
- 安装前会停止本地 EAB 服务，避免文件占用。

`package.json` 的 `build.publish` 指向 GitHub，`electron-builder` 生成的 `latest.yml` 是更新的索引文件，必须随 Release 上传。

## 8. 数据与升级

- 安装包升级不删除 `%APPDATA%\EAB\data`；
- 数据库迁移在服务启动时自动执行；
- 更新前建议在控制台「数据与运维」做一次备份；
- 回滚安装包不会自动回滚数据库结构；跨大版本升级前先备份。

## 9. 已知限制

- 当前只配置 Windows x64 安装包；macOS/Linux 需要补 `build.mac` / `build.linux` 配置和对应 CI runner；
- 安装包未签名时 Windows SmartScreen 会提示未知发布者；
- Electron 安装包体积较大（约 80–120 MB），这是内置 Node 服务的代价；
- 桌面端控制台里的「源码一键更新」不适用于安装版，安装版请用菜单「检查桌面更新」。
