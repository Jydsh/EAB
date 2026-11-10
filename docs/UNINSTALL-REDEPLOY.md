# 卸载桌面版后重新部署

本文写给装过旧版 EAB Windows 桌面版（`EAB-Setup-*.exe`）的用户。

桌面版已停止发布，GitHub Release 不再提供 `EAB-Setup-*.exe`、`latest.yml` 和 `.blockmap`。请先卸载桌面版，再按下面的 Web / Node 方式重新部署；需要保留原来的企业数据时，按第 3 节的迁移步骤操作。

## 1. 先备份桌面版数据

桌面版数据默认在：

```text
%APPDATA%\EAB\data
```

先完全退出 EAB（托盘图标、任务栏窗口都要退出），再复制整个数据目录到备份位置。下面命令会在 `D:\EAB-backup-2026-11-10` 下生成一份 `data` 副本：

```powershell
$src = Join-Path $env:APPDATA 'EAB\data'
$backup = 'D:\EAB-backup-2026-11-10'
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item -LiteralPath $src -Destination $backup -Recurse -Force
Get-ChildItem -LiteralPath (Join-Path $backup 'data') | Select-Object Name, Length
```

备份里应能看到 `eab.db`、`admin-credentials.txt`、`secrets.json` 等文件。不要只复制 `eab.db` 而漏掉同目录下的 `eab.db-wal`、`eab.db-shm`；要么整目录复制，要么先正常停止桌面版让数据库落盘。

## 2. 卸载桌面版

1. 在 Windows「设置 → 应用 → 已安装的应用」里找到 **EAB**，选择卸载；如果安装包自带卸载入口，也可以直接用它。
2. 如果托盘里还有 EAB 在运行，先退出；确认没有残留进程后再卸载：

```powershell
Get-Process EAB -ErrorAction SilentlyContinue | Stop-Process -Force
```

3. 卸载过程如果询问是否保留用户数据，选择保留。此时先不要手动删除 `%APPDATA%\EAB`，等新部署验证完成后再清理。

> 桌面版和 Web 版都用 `8787`（员工端）和 `8788`（控制台）。如果桌面版服务还在后台运行，新服务会启动失败，所以务必先退出桌面版。

## 3. 部署 Web / Node 版

### 3.1 准备运行环境

需要：

- Node.js `>= 22.5.0`（推荐 22 LTS）
- pnpm `12.x`

```powershell
node -v
pnpm -v
```

没有 pnpm 时：

```powershell
corepack enable
corepack prepare pnpm@12 --activate
```

或者：

```powershell
npm install -g pnpm@12
```

### 3.2 解压源码包

从 [Releases](https://github.com/Jydsh/EAB/releases) 下载当前版本的源码包，例如 `EAB-2026.11.10.zip`，解压到一个固定目录：

```powershell
Expand-Archive -LiteralPath 'D:\EAB-2026.11.10.zip' -DestinationPath 'D:\EAB' -Force
Set-Location 'D:\EAB'
pnpm install
```

建议不要把部署目录放在中文路径或带空格的路径下，避免脚本和插件调用时出现路径问题。

### 3.3 选择数据：全新部署，或迁移旧桌面数据

**A. 全新部署（不保留旧数据）**

直接启动即可。首次启动会在项目根下生成 `.eab-dev`，并写入新的控制台账号：

```powershell
node scripts\eab.mjs server --background
```

**B. 保留旧桌面数据**

把第 1 节备份里的 `data` 内容复制到新部署目录的 `.eab-dev`：

```powershell
$backupData = 'D:\EAB-backup-2026-11-10\data'
$target = 'D:\EAB\.eab-dev'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Get-ChildItem -LiteralPath $backupData -Force | Copy-Item -Destination $target -Recurse -Force
```

如果备份目录结构不同，就以实际复制出来的目录为准，确保 `eab.db` 最终落在 `D:\EAB\.eab-dev\eab.db`。

然后启动：

```powershell
Set-Location 'D:\EAB'
node scripts\eab.mjs server --background
```

旧数据迁移后，原来的公司配置、成员、知识库、模型密钥、控制台账号都会保留；控制台密码仍是原来的密码，凭据文件在：

```text
D:\EAB\.eab-dev\admin-credentials.txt
```

> 也可以不改数据目录，启动前设置 `EAB_HOME` 指向旧的 `%APPDATA%\EAB\data`。但桌面版卸载可能会清理 `%APPDATA%\EAB`，所以更推荐复制到新目录，确认无误后再清理旧目录。

### 3.4 验证服务

```powershell
Invoke-RestMethod 'http://127.0.0.1:8787/api/health'
```

浏览器打开：

- 员工端：`http://127.0.0.1:8787/chat`
- 控制台：`http://127.0.0.1:8788/admin`

控制台登录账号默认是 `admin`，密码见 `.eab-dev\admin-credentials.txt`。

需要局域网访问时，在控制台「系统 → 网络与访问入口」把监听地址改成 `0.0.0.0`，并确认防火墙放行 `8787`、`8788`。

## 4. 清理旧桌面版残留

确认新服务能正常登录、数据正确后，再处理旧目录。**不要在新服务验证完成前删除备份。**

如果不再需要桌面版数据，并且备份已经确认可用：

```powershell
Remove-Item -LiteralPath (Join-Path $env:APPDATA 'EAB') -Recurse -Force
```

同时删除旧的 `EAB-Setup-*.exe` 安装包和桌面/开始菜单快捷方式。

如果还打算保留旧目录作为回滚点，就不要执行上面的删除命令。

## 5. 常见问题

**启动后数据是空的？**

先确认服务读的是哪个数据目录：默认是项目根下的 `.eab-dev`；如果设置了 `EAB_HOME` 或 `EAB_DB`，以环境变量为准。旧桌面数据在 `%APPDATA%\EAB\data`，需要复制到 `.eab-dev` 或让 `EAB_HOME` 指向它。

**端口被占用？**

```powershell
netstat -ano | findstr ':8787'
netstat -ano | findstr ':8788'
```

找到占用进程后先退出桌面版；也可以临时换端口启动：

```powershell
node scripts\eab.mjs server --chat-port=8797 --admin-port=8798
```

**控制台密码忘了？**

看 `.eab-dev\admin-credentials.txt`。如果迁移的是旧数据，旧密码仍然有效；如果文件丢失，不要直接删库，先备份数据库后再走账号恢复流程。

**以后怎么升级？**

先备份整个 `.eab-dev`，再用新版本的源码包替换代码目录，保留 `.eab-dev`，重新执行 `pnpm install` 并重启服务。不要用旧桌面安装包覆盖。
