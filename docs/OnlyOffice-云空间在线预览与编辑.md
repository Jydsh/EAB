# OnlyOffice 云空间在线预览与编辑接入

## 结论

EAB 云空间已接入 OnlyOffice DocumentServer：

- `.doc/.docx/.docm/.xls/.xlsx/.xlsm/.ppt/.pptx/.pptm/.odt/.ods/.odp` 等 Office 文件在云空间文件面板内直接打开，不再走浏览器下载。
- 共享文件只读；本人文件默认只读，可点「编辑」进入在线编辑，保存回调后写回原文件。
- PDF、图片、文本仍走原有预览路径，行为不变。
- OnlyOffice 未配置时，Office 文件会显示「OnlyOffice 文档服务未配置」，不会误触发下载。

## 服务端新增

- `packages/server/src/onlyoffice.ts`：Office 扩展名/类型识别、HS256 JWT 签发与校验、文档 key、编辑器配置。
- `packages/server/src/routes/workspace.ts`：
  - `GET /api/workspace/files/:id/office-config?mode=view|edit`
  - `GET /api/workspace/office/:id/content/:token`
  - `POST /api/workspace/office/:id/callback/:token`
- `packages/server/src/config.ts`：三个环境变量。

权限规则：

- `office-config` 必须先登录，且当前用户对文件有读权限。
- 本人文件可以 `mode=edit`；共享文件固定 `view`，请求编辑直接返回 403。
- 内容和保存回调使用短期签名令牌，不依赖浏览器 Cookie，方便 OnlyOffice 容器回访。
- 保存回调只处理 `status=2/6`，校验令牌、公司、文件归属和 owner；只允许从配置的 OnlyOffice 服务同端口/同源主机下载文件，上限 80 MB。
- 写回后更新 `size`、`storage_path`、`updated_at`，同步个人/公司配额并写 `workspace.file.edit` 审计。

## 前端新增

- `packages/server/public/chat.js`：`isOfficeLike`、OnlyOffice API 动态加载、`openWorkspaceOffice`、编辑器销毁、编辑/预览切换。
- `packages/server/public/chat.css`：`.onlyoffice-editor` 高度铺满文件面板。
- Office 文件打开时先请求 `office-config`，拿到 `scriptUrl` 和签名后的 `config`，在 `#file-pane-body` 内创建 `DocsAPI.DocEditor`。

## 服务器环境变量

OnlyOffice 容器已用下面参数启动（端口可按实际修改）：

```powershell
docker run -d --name onlyoffice-ds --restart unless-stopped -p 8080:80 `
  -e JWT_ENABLED=true -e JWT_SECRET=$secret `
  -v onlyoffice_data:/var/www/onlyoffice/Data `
  onlyoffice/documentserver:latest
```

EAB 侧需要设置：

| 变量 | 含义 | 示例 |
|---|---|---|
| `EAB_ONLYOFFICE_URL` | 浏览器能访问的 OnlyOffice 地址 | `http://192.168.1.50:8080` |
| `EAB_ONLYOFFICE_JWT_SECRET` | 必须等于容器的 `JWT_SECRET` | 从服务器密钥文件读取 |
| `EAB_ONLYOFFICE_INTERNAL_URL` | OnlyOffice 容器回访 EAB 的地址 | 同机 Docker：`http://host.docker.internal:8787`；跨机：`http://192.168.1.13:8787` |
| `EAB_HOST` | EAB 监听地址 | 需要容器回访时必须 `0.0.0.0` |

PowerShell 启动示例（在 EAB 仓库根目录）：

```powershell
$secret = (Get-Content -LiteralPath "$env:USERPROFILE\onlyoffice-jwt.txt" -Raw).Trim()
$env:EAB_ONLYOFFICE_URL = 'http://192.168.1.50:8080'
$env:EAB_ONLYOFFICE_JWT_SECRET = $secret
$env:EAB_ONLYOFFICE_INTERNAL_URL = 'http://host.docker.internal:8787'
$env:EAB_HOST = '0.0.0.0'
node scripts/eab.mjs server --background
```

跨机部署时，把 `EAB_ONLYOFFICE_INTERNAL_URL` 改为 EAB 所在机器局域网 IP，并确认：

1. OnlyOffice 容器能访问 `http://<EAB-IP>:8787/api/health`。
2. Windows 防火墙放行 8787。
3. EAB 以 `EAB_HOST=0.0.0.0` 启动。

## 验收步骤

1. 浏览器打开 `http://<EAB-IP>:8787/chat`，进入云空间。
2. 上传一个 `.docx`，点击文件名；应出现 OnlyOffice 编辑器，而不是下载提示。
3. 本人文件点击「编辑」，修改文字后在编辑器内保存；等待回调完成，刷新文件面板确认大小/更新时间变化。
4. 用另一个账号查看共享文件，应只读，无「编辑」按钮。
5. 再测 `.xlsx` 和 `.pptx`。
6. 检查服务端日志无 `onlyoffice callback failed`，审计有 `workspace.file.edit`。

## 常见问题

- `OnlyOffice 文档服务未配置`：`EAB_ONLYOFFICE_URL` 和 `EAB_ONLYOFFICE_JWT_SECRET` 没有同时设置。
- 编辑器打开但提示下载失败/一直加载：先检查 `GET /api/workspace/office/:id/content/:token` 是否返回 `414 URI Too Long`。OnlyOffice 的内容/回调令牌约 300+ 字符，Fastify 默认 `maxParamLength=100` 会在进入路由前拒绝；`packages/server/src/app.ts` 已设置 `routerOptions.maxParamLength=1024`。如果令牌长度正常但仍失败，再检查 OnlyOffice 容器能否访问 `EAB_ONLYOFFICE_INTERNAL_URL`、EAB 监听地址、防火墙和跨机 IP。
- 下载/保存回调均为 200 但编辑器仍报错：用 OnlyOffice `ConvertService.ashx` 传同一内容 URL 做一次转换；能返回 `Percent=100` 说明容器到 EAB 的下载链路正常，问题在编辑器配置或回调，而不是网络。
- 保存后文件没变化：检查回调是否到达 EAB；`status=2/6` 才会保存，`status=7` 是强制保存失败，不写回。
- 脚本加载失败：浏览器访问 `EAB_ONLYOFFICE_URL` 的 `/web-apps/apps/api/documents/api.js` 是否 200；跨机时确认端口和防火墙。
- JWT 报错：EAB 的 `EAB_ONLYOFFICE_JWT_SECRET` 与容器 `JWT_SECRET` 不一致，或密钥文件带了多余空格/BOM；用 `.Trim()` 去掉。
