# OnlyOffice 全覆盖与 Agent 工作现场后续实施计划

> 依据：`docs/agent-workbench-and-onlyoffice-full-coverage.md`、任务板 #86、2026-11-13 的真实 HTTP/浏览器验收结果。
> 本文只列“尚未实现或只完成了一部分”的能力，已完成项作为基线，不重复开发。

## 1. 范围与结论

当前主线是 OnlyOffice 内容层（L1）和编辑器层（L2）。下一步不建议继续横向铺功能，而是先把“保存闭环”和“编辑态同步”做扎实，再补 docx 修订/批注/表格结构，最后进入 xlsx、pptx 和降级预览。

实施顺序按“先闭环、再语义、再文件类型、最后兜底”：

1. P3 收口：强制保存、插件保存按钮、编辑态版本同步、插件 token 过期恢复。
2. docx 语义补齐：修订（已完成）、批注生命周期（已完成）、表格行/列插入与删除（已完成删除，合并策略待做）、格式与范围读取。
3. xlsx：插件注入、服务端内容工具、保存同步。
4. pptx：插件注入、结构读取/文本替换，结构性编辑不足时走受控 GUI 兜底。
5. P4 治理：版本快照/撤销/冲突、GUI 兜底白名单、审计与回归。
6. P2 降级预览补齐：文本 diff、PDF 标注、图片 OCR/区域、权限失效自动关闭。
7. P1 工作台遗留：事件进 `chat-events` 总线、父子双向消息、会话级父 Agent 记录。

不在本轮承诺：任意宏、打印设置、OnlyOffice 全部原生按钮、像素级图片重绘、PDF 重排编辑。这些只做“明确提示 + 受控 GUI 兜底”。

## 2. 当前基线（已验收，不重复做）

- 插件 `panelRight` 常驻、SDK 握手、只读/编辑模式连接。
- `office.read_outline`、`office.find`、`office.replace`、`office.insert`、`office.format`、`office.comment` 六个服务端工具。
- docx 段落/表格/单元格定位；单元格绝对偏移修复；单元格内插入。
- 插件内定位并选中、编辑模式全部命中高亮；关闭预览触发 OnlyOffice 保存回调并回写高亮。
- `office.replace/insert/format/comment` 完成后，查看态预览自动重载；编辑态只警告不强制刷新。
- S1 强制保存：插件 token 保护的 `POST /api/workspace/office/plugin/force-save`，用 token 里的 `version` 计算编辑器 key，调用 OnlyOffice `/command` 的 `forcesave`；回调写回后返回 `saved`，4 秒未写回返回 `pending`，错误 4 返回 `no_changes`。
- S2 插件保存按钮：编辑模式启用、只读模式禁用；保存中禁用按钮，成功后显示版本和字节数，失败进入错误日志。
- 无预览文件不显示空白右栏；全量 93 文件 / 504 测试通过，`pnpm typecheck` 通过。

## 3. 未实现清单

| ID | 能力 | 当前状态 | 缺口 | 优先级 | 依赖 |
|---|---|---|---|---|---|
| S1 | 强制保存 | 已实现并验收：`forcesave` 命令服务、`saved`/`pending`/`no_changes`、`workspace.file.force_save` 审计 | 旧回调持久化水位与跨设备冲突留 S16 | 已完成 | — |
| S2 | 插件保存按钮 | 已实现并验收：编辑启用、只读禁用、保存中禁用、成功/无修改/失败日志 | 失败自动重试未做；当前由用户手动再点一次 | 已完成 | S1 |
| S3 | 编辑态版本同步 | 已实现并验收：持久警告条、二次确认、`refresh-guard` 抬水位、刷新列表并重开；审计 `workspace.file.office_stale_callback` | cutoff 仍是进程内 Map，服务重启会丢；跨设备冲突留 S16 | 已完成 | S1 |
| S4 | 插件 token 过期恢复 | 已实现并验收：403/409 分支、`reopen` 消息校验、重开前 `refresh-guard`、force-save 按 `payload.version` 校验旧编辑器 | 真实 10 分钟 JWT 过期未等待，由单测覆盖；跨文件/跨用户拒绝已验 | 已完成 | S2 |
| S5 | docx 修订 track changes | 已实现并验收：L1 `office.revisions` + `office.replace(trackChanges)`，L2 开启/关闭、读取、接受/拒绝 | 目标段落已有修订、`occurrence=0`、含换行/制表符的范围拒绝；移动/格式修订不识别；编辑态并发覆盖留 S16 | 已完成 | S1 |
| S6 | 批注生命周期 | 已实现并验收：`office.comment` 支持 `add/list/reply/resolve/delete`，短语级 `oldText/occurrence` 或 `start/end`，回复线程与 resolved 状态基于 `commentsExtended`/`commentsIds` | 同一段落多批注重叠、跨 run 复杂范围未逐一验证；删除后 `comments*.xml` 保留空部件；xlsx 单元格批注已由 S12-L6 单独实现，不复用 docx 线程模型 | 已完成 | S5 |
| S7 | 表格结构 | 已实现 docx `tN-rN`/`tN-cN` 行/列插入和删除；行删除支持 `gridSpan/vMerge/hMerge`，删纵向合并锚点行时把内容和 `restart` 迁到下一行；列删除按表格 grid 缩减 `gridSpan` 或移除覆盖该列的 cell；新增 `action=merge` 矩形合并和 `action=split` 整表拆分 | 列插入、含纵向合并的行插入和已合并表再 `merge` 仍需先 `split`；`merge` 不支持合并多单元格文本；xlsx 删除和 pptx 结构变更未做 | 已完成 docx 合并表结构变更 | — |
| S8 | 格式扩展 | 已实现字体、字号、颜色、加粗、斜体、下划线、高亮、字体族、段落对齐、行距、段前段后 | 缺表格边框/底纹 | P2 | — |
| S9 | 范围读取 | 已实现 docx `pN`/`tN`/`tN-rN`/`tN-cN`/`tN-rN-cN` 完整文本、run 格式与表格结构读取；`start/end` 仅用于段落/单元格 | xlsx/pptx 明确返回未覆盖 | P2 | — |
| S10 | 保存/版本/导出 | 保存只更新当前文件 | 缺 `office.save` 快照、版本列表/恢复、`office.export` PDF/图片 | P2 | S1 |
| S11 | xlsx 插件注入 | 已实现并验收：xlsx 注入插件，config 返回 `EditorsSupport:["cell"]`，上下文 `documentType:"cell"`；插件面板分流 WORKSHEET，支持只读读取工作表、查找并选中，编辑模式可替换选中单元格 | 数字/公式/合并单元格的 `SetValue` 行为未验证；保存与查看态重载见 S12b | 已完成 | S1 |
| S12 | xlsx 内容工具 | 已实现读取/查找/替换、插入行列、单元格格式、工作表追加/删除、列宽/行高、单元格批注 `add/list/delete` | 缺 threaded comments/persons 部件兼容、批注 VML 自定义位置/尺寸、Excel 桌面端人工打开验证；未做 xlsx 图片/图表结构编辑 | 已完成当前约定范围 | — |
| S12b | xlsx 保存同步 | 已实现并验收：插件保存按钮、保存后自动切查看态、`refresh-guard` 丢弃旧编辑器关闭回调；补 900ms 同步等待与 `no_changes` 重试 | 数字/公式/合并单元格保存未验证；同会话连续二次保存改为重新进入编辑；pptx 未做 | 已完成 | S1、S12 |
| S13 | pptx 插件注入 | 已实现并验收：pptx 注入 `pluginConfigUrl`，config `documentType:"slide"`、`EditorsSupport:["slide"]`；插件页新增 `PRESENTATION` 面板，`readPresentation()` 读取页数/形状/文本，`locateSlideText()` 逐页逐形状匹配并用 `ApiSlide.Select()` 跳转 + `shape.Select(true)` 选中 | 当前 OnlyOffice 构建没有 `Api.GoToSlide`/`presentation.GoToSlide`，已回退 `ApiSlide.Select()`；真实浏览器只测 1 页，分页跳转、多形状和组合形状未逐一验证 | 已完成 | S1 |
| S14 | pptx 内容工具 | 已实现并验收：`office.read_outline` 返回 `kind:"pptx"`、`slideCount`、`slides[].paragraphs[]`（`sN-pM`）；`office.find` 返回 pptx 命中、区间和上下文；`office.replace` 支持跨 run 文本替换并保留未改 run 与 `a:rPr`；`occurrence=0`、段落内换行、非法段落 ID 明确 400 | 仅文本级读取/替换，不做新增幻灯片、复制版式、插入图片；`read_range` 仍不支持 pptx；只测 1 页样例 | 已完成当前约定范围 | — |
| S15 | GUI 兜底 | 无 | 缺白名单动作、用户确认、失败即停、审计 | P3 | S13 |
| S16 | 版本/撤销/冲突/审计 | 只有 `workspace.file.agent_edit` | 缺保存前版本快照、冲突检测、撤销入口、操作前后摘要 | P3 | S10 |
| P2-1 | 文本 diff | 有文本选区，无 diff | 缺修改前后行/字符 diff 高亮和引用回填 | P2 | — |
| P2-2 | PDF 标注 | 只有 PDF iframe 预览 | 缺页/区域选择、文本提取、高亮批注 | P2 | — |
| P2-3 | 图片 OCR/区域 | 只有图片预览 | 缺区域选择、OCR/描述、标注建议 | P2 | — |
| P2-4 | 权限失效自动关闭 | 删除文件会关闭预览 | 缺权限撤销、跨设备删除、OnlyOffice 失效时的轮询/事件关闭 | P2 | — |
| P1-1 | Agent 事件总线 | `agent` 事件未进 `chat-events` | 缺事件持久化/回放和跨端恢复 | P3 | — |
| P1-2 | 父子双向消息 | 只有阻塞式派发 | 缺子 Agent 反问父 Agent、父 Agent 继续派发的异步通道 | P3 | P1-1 |
| P1-3 | 会话级父 Agent | 当前按回合根 run | 缺会话级父 Agent 记录、模型/身份稳定绑定 | P3 | P1-1 |

## 4. 里程碑与实施顺序

### M0：P3 保存闭环（先做）

**S1 强制保存服务（已完成）**

- 目标：不关闭编辑器也能把当前编辑内容保存到云空间。
- 改动：
  - `packages/server/src/onlyoffice.ts`：增加命令服务 URL 和 `forcesave` 请求体/JWT 构造。
  - `packages/server/src/routes/workspace.ts`：新增插件 token 保护的 `force-save` 路由；校验 `kind=plugin`、`mode=edit`、`fileId`、文件归属；用插件 token 里的 `version` 计算编辑器 key，不能用当前 DB 的 `updated_at`（服务端工具可能在编辑器打开期间改过文件）。
  - 命令服务返回异常、OnlyOffice 不可达、回调未在超时内到达时，返回明确错误，不假装成功。
- 验收：
  - 临时副本编辑模式高亮/改格式，点击保存后不关闭编辑器，DB `updated_at` 和文件 `size` 变化，XML 中出现对应修改。
  - 共享文件只读调用返回 403，且 DB/文件无变化。
  - 错误 token、过期 token、跨 fileId 均返回 403。
- 风险：OnlyOffice 命令服务路径/JWT 负载格式需按当前 10.0.0-169 实测；`forcesave` 成功是“已请求保存”，回调完成才算持久化，接口必须区分。
- 实测结果（2026-11-13）：真实编辑器 key `74a69410aa3414b9bbbcb370`；无修改返回 `no_changes`；加入测试文字后返回 `saved`，文件 `13869` → `31140` 字节，`updated_at` 前进；再改一次并点插件按钮后为 `31156` 字节，`word/document.xml` 同时包含两段测试文字；无 token/非法 token/只读 token 均返回 403；未打开编辑器的副本返回 409“找不到当前编辑会话”，文件未变化且审计记为 `failure`。

**S2 插件保存按钮与状态（已完成）**

- 目标：用户在编辑器内能主动保存，知道保存结果。
- 改动：`public/onlyoffice-plugin/index.html` 增加“保存到云空间”；`plugin.js` 只在 `canEdit` 启用，调用 S1 接口，显示“保存中/已保存/保存失败”，禁止重复点击；失败后恢复按钮，由用户手动再点一次。
- 验收：编辑模式按钮可用、只读模式禁用；保存中按钮禁用；成功后日志和 `updated_at` 一致；失败不误报成功。
- 风险：按钮与 OnlyOffice 原生保存并存，文案必须说明“保存当前编辑内容到 EAB 云空间”。
- 实测结果（2026-11-13）：编辑模式按钮初始可用，点击后日志“已保存到云空间 · 版本 1794580925841 · 31156 字节”；只读模式按钮 `disabled=true`；无修改时日志“没有需要保存的修改”；请求前禁用、`finally` 恢复按钮的路径已在代码中实现，未单独计时观察保存中状态。

**S3 编辑态版本同步**

- 目标：服务端工具改文件后，编辑中的用户知道云端已有新版本，并能安全刷新。
- 改动：`public/chat.js` 在现有警告条上增加“刷新到云端版本”动作；执行前二次确认，关闭当前编辑器并重新打开新版本；若编辑器有未保存内容，只提示用户先保存/撤销，不自动关闭。
- 验收：查看态自动重载保持；编辑态只出现警告；点击刷新后 `updatedAt` 变为新版本，编辑器展示新内容；不点击时编辑器内容不被覆盖。
- 风险：OnlyOffice 插件 API 没有可靠的“是否有未保存修改”读取；先不做自动判断，保持显式确认。
- 实测结果（2026-11-14，临时副本 `office-s3-test.docx`，fileId `01M7ATCP2K7WKHWCRMNBMNF6R6`）：
  - 编辑态云端更新后只出现持久警告条，文案含云端更新时间和大小；取消二次确认后警告条保留、编辑器不重开；确认后警告条消失，预览头和编辑器都切到新版本。
  - 无守卫刷新会复现旧编辑器关闭回调覆盖新版本，因此新增 `POST /api/workspace/office/:id/refresh-guard` 水位。旧会话带 `STALE-OLD-004` 未保存修改、云端为 `...004` 时刷新，旧回调 `payloadVersion=1794587015091` 小于 `cutoff=1794587163242`，被服务端丢弃并写审计 `workspace.file.office_stale_callback`；刷新后云端仍为 `...004`，新编辑器全文含 `...004`、不含 `STALE-OLD-004`。
  - 同时给插件“保存到云空间”加版本保护：旧编辑器对云端新版本调用 force-save 返回 409，不写回；实测云端保持 `...008`，插件显示“保存失败：云端已有新版本”并提供重新打开入口。
  - 已知边界：`refresh-guard` 水位目前是进程内 `Map`，服务重启会丢失；若旧编辑器在重启后关闭，回调仍有覆盖风险。force-save 已有版本校验，回调侧的持久化或版本校验留 S16。

**S4 插件 token 过期恢复**

- 目标：10 分钟后 token 过期不再静默卡死。
- 改动：插件页 `loadContext` 捕获 403/409，显示“令牌过期/文件已更新”；提供“重新打开预览”；可监听 `visibilitychange` 重新校验；不把 token 写入日志。
- 验收：伪造过期 token 返回 403；页面显示可恢复提示；重新打开后 `已连接`；跨用户/跨文件 token 仍拒绝。
- 实测结果（2026-11-14，同一临时副本）：
  - 云端从 `...006` 更新到 `...007` 后，插件“刷新上下文”返回 409，状态显示“版本已更新”，日志提示当前编辑器仍是旧版本，并出现“重新打开预览”按钮。
  - 点击按钮后顶层 EAB 先写刷新水位，再关闭旧编辑器、重新拉取文件列表并重开；预览头更新到 `2026/11/14 00:44:05`，插件恢复“已连接”，编辑器全文为 `...009`，不含上一版 `...008`。
  - 用无效 token 直接打开插件页返回 403，页面显示“令牌已过期”和恢复说明；真实等待 10 分钟未执行，JWT 过期拒绝由现有单测覆盖。

### M1：docx 语义补齐

**S5 修订 track changes（已完成，2026-11-14）**

- 能力探测结论：`ApiDocument.SetTrackRevisions(isTrack)` 存在并返回 boolean，必须放在插件 `callCommand` 内调用；接受/拒绝使用 `window.Asc.plugin.executeMethod("AcceptReviewChanges"/"RejectReviewChanges", [true])`，官方语义为处理全部修订且无回调；读取使用 `ApiDocument.GetReviewReport()`，返回按作者名分组的对象，每个作者对应一个修订数组（`Date`/`Type`/`Value`），不是扁平的 `{reviews:[...]}`。
- L1：新增 `office.revisions` 只读工具，解压 `word/document.xml` 扫描顶层 `w:ins`/`w:del`，返回修订数量、插入/删除数、作者统计、段落/单元格定位和字符偏移；`office.replace` 增加 `trackChanges` 与 `author`，生成 `<w:del><w:delText>旧</w:delText></w:del>` + `<w:ins><w:t>新</w:t></w:ins>`，正文读取只显示新文本，旧文本保留在 `w:delText`。
- L2：插件新增“开启修订/修订已开启”“读取修订”“接受全部”“拒绝全部”；编辑态可用、只读禁用。接受/拒绝后 1.2 秒自动重读修订报告，只有归零才写入“已接受/已拒绝全部修订”，仍有剩余则明确提示“请求已发送，仍有修订”。
- 修复：`GetReviewReport()` 返回的对象带有可枚举的 `toJSON` 方法，原统计会把 `toJSON` 当成第二个作者；改为只接受数组值的作者分组后，读取结果从“2 处 · 2 位作者”修正为“2 处 · 1 位作者”。
- 验收（`S5修订验收.docx`，fileId `01M7BYYY0T9S52HAX3MK9D8KKH`）：
  - 干净副本执行 `office.find` + `office.replace(trackChanges=true, author=S5验收)`，审计 `seq=774 workspace.file.agent_edit`，size 13971、`nextText=附件四`；XML 为 1 个 `w:del`（附件三）+ 1 个 `w:ins`（附件四）。
  - 真实 OnlyOffice 编辑器显示“附件三”删除线 + “附件四”下划线；插件读取 `2 处 · 1 位作者`，日志为 `S5验收 · TextRem: 附件三`、`S5验收 · TextAdd: 附件四`。
  - “接受全部”后正文只剩“附件四”、修订归零；“拒绝全部”后正文只剩“附件三”、修订归零。两次操作均无 callback，物理文件 SHA256 保持 `B5EC2EE972073C233992BA2745F8FF1CAE1FD88D0C6D219F27CF1720D30929D2`，主文档未改动。
  - 同一 `document.url` 经 OnlyOffice `ConvertService.ashx` 转 PDF，PDF 第 1 页同样可见“附件三”删除线 + “附件四”下划线，作为编辑器之外的独立渲染证据。
  - 副本已软删：用 `deleteUserWorkspaceFile`（与 `workspace.delete` 同一语义）写入 `deleted_at=1794627334684`，文件移入 `_recycle/01M7BYYY0T9S52HAX3MK9D8KKH-S5修订验收.docx`；主文档 SHA256 和 size 未变。
- L1 真实路由复验（`表格插入测试.docx`，fileId `01M7TESTDOCXTABLE0000001`）：`read` 为 `revisionCount=0/trackChanges=false`；`enable`/`disable` 均 `changed=true` 且 `trackChanges` 正确翻转；`office.replace(p1, 记录本→检查表, trackChanges=true)` 后 `read` 返回 2 条修订（`id=1 delete 记录本`、`id=2 insert 检查表`）；`reject all` 后 `p1` 恢复“安全防护记录本”，`accept all` 后为“安全防护检查表”，再用普通替换恢复原文。
- 已知边界：目标段落已有 `w:ins/w:del` 时拒绝再写；`occurrence=0` 拒绝；选中范围含 `<w:br>/<w:tab>` 拒绝；不识别移动/格式修订。编辑态下 Agent L1 写入与旧编辑器保存的覆盖关系未验证，当前建议先关闭编辑器再写入，冲突治理留 S16。
- 验收环境说明：本机 Chrome 常规配置下 OnlyOffice 编辑器停在加载骨架，独立最小配置页同样复现；改用无痕窗口 + 独立最小配置页后完成真实编辑器验收。同一文档可由 OnlyOffice 转换服务成功转 PDF，判定为浏览器侧加载问题，不是 EAB 配置或文档内容问题。

**S6 批注生命周期（已完成，2026-11-14）**

- L1：`office.comment` 增加 `action`：`add` / `list` / `reply` / `resolve` / `delete`，默认 `add` 兼容现有调用；批注模型使用 `comments.xml`、`commentsExtended.xml`（`w15:commentEx`）、`commentsIds.xml`（`w16cid:commentId`）和 `w14:paraId`/`w16cid:durableId`，回复线程按 `parentId` 关联。
- 范围：`add` 支持 `oldText + occurrence` 或 `start/end`，短语落在 run 中间时拆成左/中/右三个 run，`commentRangeStart`/`End` 只包住目标片段；整段批注继续走原有路径。
- `list` 返回 `comments/total/open/resolvedCount/threads`，每条包含 `anchor/parentId/threadRootId/resolved/replyCount/durableId`；`reply` 新建子批注并挂到父线程；`resolve` 写 `w15:commentEx` 的 `w15:done`；`delete` 删除目标批注、回复子节点和 `document.xml` 的 range/reference 锚点。
- 修复：`removeCommentAnchors` 删除 reference run 的正则原会从更早的正文 run 起跨 `</w:r>` 匹配，短语批注删除后把“安全”“防护”两个正文 run 一起删掉；改为 rPr 内容不跨 run 边界后，删除只移除 reference run，正文 run 原样保留。
- 验收（fixture `表格插入测试.docx`，fileId `01M7TESTDOCXTABLE0000001`，真实路由 `POST /api/tools/office.comment/invoke`）：
  - `add`（`p1`、`oldText=防护`、`occurrence=1`）返回 `commentId=1`、`start=2`、`end=4`，批注 `anchor="防护"`，`p1` 仍为“安全防护记录本”。
  - `list` 返回 `total=1/resolved=0/unresolved=1`；`reply` 返回 `replyId=2`；`resolve` 返回 `resolved=true`；再次 `list` 返回 `total=2/resolved=1/unresolved=1`，父批注 `replyCount=1`、回复 `parentId=1`。
  - `delete(commentId=1)` 返回 `deletedIds=[1,2]`，`list` 归零；物理 `document.xml` 中 `commentRange`/`commentReference` 均为 0，`p1` 仍为“安全防护记录本”（XML 为“安全”“防护”“记录本”三个正文 run），表格 3 行×3 列、`trPr`/`shd`/`pStyle`、`sectPr` 和尾随正文均保留。
  - 回归：`office-content.test.ts` 新增“批注在第二段，删除后第一段和表格仍在”的用例；`deleteDocxComment` 只移除目标批注的 range/reference run，不再从正文开头跨 run 删除。当前 43 个批注测试通过。
- 已知边界：同一段落多个批注重叠、同一 run 多处短语、回复锚点单独删除尚未逐一验证；`list` 忽略 `commentId`，始终返回全部批注；删除后保留空的 `comments*.xml` 部件（Word 可正常打开，但未做部件级清理）；根批注 `resolve` 后回复仍计为 open；旧式仅写 `w:parentId` 的线程不级联；`commentsExtensible.xml` 未写；插件暂无批注面板；xlsx 单元格批注仍归 S12。
- 真实 docx 验收（`OnlyOffice测试.docx` 副本 `S6批注验收*.docx`，源 size 13869、SHA256 `27B7B286571BE64C7B87B8331DD7F57F0F514B8AD5D8C7F85F511F005A9ADE70` 未变）：`p2` + `oldText="通知开放信号"` 得到 `commentId=1/start=9/end=15/anchor="通知开放信号"`；`reply` 得到 `commentId=2`、父 `threadRootId=1`、`replyCount=1`；`resolve(1)` 后 `commentsExtended` 为 `w15:done="1"`；`delete(1)` 得到 `deletedIds=[1,2]`，正文 `commentRangeStart/End` 与 `commentReference` 全部为 0，删除副本 14751 字节且 3 个顶层元素（`p1`/`t1`/`p2`）文本与源文件逐一相等。`commentsIds.xml` 保留 `40000001/50000001`、`40000002/50000002` 两条线程 ID（解决态副本）。
- 工具级验收：新增 `packages/server/test/office-comment-tool.test.ts`，用内存 SQLite + 磁盘 docx 走 `executeTool('office.comment')` 的 `add → reply → list → resolve → delete`，断言工具返回 `start/end`、`replyId`、`list` 的 `threadRootId/replyCount`，并逐次读回磁盘文件确认 `total` 归零。
- OnlyOffice 结构验收：上述解决态副本经 EAB 内容 URL 提交 `ConvertService.ashx`，返回 `Percent=100/EndConvert=True`，PDF 260551 字节；PDF 第 3 页正文保留“通知开放信号”片段，说明 `commentsExtended/commentsIds` 结构可被 OnlyOffice 解析，PDF 本身不渲染批注气泡。
- 验收环境：服务端 8787 使用 S5/S6 代码重启，`/api/health` 返回 `ok:true`；S5 的 `read/enable/disable` 与 S6 的 `add/list/reply/resolve/delete` 均走真实路由验证，并补充真实 `OnlyOffice测试.docx` 副本与 OnlyOffice 转换服务验收；未做编辑器内批注面板像素级复验（插件当前没有批注 UI，`bu` 也无可用登录 tab）。
- 全量回归：`pnpm typecheck` exit 0；`pnpm test` 98 个测试文件 / 550 个测试全部通过。

S7 表格结构回归：`pnpm typecheck` exit 0；`office-content.test.ts` 50 tests、`office-table-tool.test.ts` 2 tests 通过；`pnpm test` 103 个测试文件 / 577 个测试全部通过；8787 服务热重载后 `/api/health` 返回 `ok:true`、`devAuth:false`。

**S7 表格行/列插入与删除、合并单元格策略**

- 已完成插入：`office.insert` 支持 `tN-rN`（行前/后）和 `tN-cN`（列左/右）；克隆现有 `<w:tr>`/`<w:tc>` 保留样式和网格。目标行只含 `gridSpan` 时允许插入行并克隆 span；目标行含纵向合并或旧式横向合并时拒绝。列插入仍要求表格无合并，否则提示先 `split`。
- 已完成删除：`deleteDocxTable` 按 `tN-rN` 删除整行、按 `tN-cN` 删除网格列。行删除支持 `gridSpan/vMerge/hMerge`；若目标行是 `vMerge=restart` 锚点，下一行同网格范围的 continuation 会被替换为锚点行内容并改成 `restart`，纵向合并内容和样式不丢。列删除按 `startColumn/endColumn` 找到覆盖目标网格列的 cell：跨列 cell 缩减 `gridSpan`，单列 cell 直接移除；旧式 `hMerge` 明确拒绝。
- 合并布局：`tableRowLayoutsOf` 用 `w:tblGrid` 的 gridCol 数校验每行 span 之和；`gridSpanOfCell`、`mergeModeOf` 解析 `w:gridSpan`、`w:vMerge`、`w:hMerge`；`cellXmlWithGridSpan`、`cellXmlWithVMerge`、`docxRowXmlWithCells` 负责安全改写 `tcPr` 和行 XML。
- 整表拆分：`splitDocxTableMergedCells` 按 `gridSpan` 把每个合并 cell 展开为多个网格 cell，文本保留在首 cell，其余为空；`tblGrid` 不变，拆分后每行 cell 数等于 gridCol 数，可继续列插入/删除和 `merge`。真实 16×7 表实际是 9 个 gridCol，拆分返回 `splitCells=52`、`16×9`。
- 矩形合并：`mergeDocxTableCells` 接受 `tN-rA-cA:tN-rB-cB`，要求整表无合并、区域至少 2 个 cell、除左上角外无文本；左上角保留内容并加 `gridSpan`，跨行时加 `vMerge=restart`，其余行生成 `vMerge=continue` 空 cell。返回 `mergedRows/mergedColumns` 与 `remainingRows/remainingColumns`。
- 工具接入：`office.insert` 的 `action` 扩展为 `insert | delete | merge | split`；仅 `insert` 要求 `text`；`merge` 的 `elementId` 传矩形范围，`split` 传 `tN`；两条路径都通过 `editUserWorkspaceFile` 保存并写 `workspace.file.agent_edit` 审计，记录 `splitCells` 或 `mergedRows/mergedColumns`。xlsx 只支持 `insert`，pptx 拒绝结构变更。
- 单测：`office-content.test.ts` 新增合并行删除后 `continuation → restart` 且内容迁移、vMerge 列删除缩减 span、整表 split 3×2→3×3、2×2 区域 merge 后 split 回 4 cell、合并区域有其他文本拒绝、已合并表再 merge 提示先 split，共 50 tests；`office-table-tool.test.ts` 新增 `split → delete column → merge → insert column 拒绝 → 再删除` 链路，共 2 tests。
- 真实无合并夹具验收：以真实 `OnlyOffice测试.docx` 样式页为外壳生成 3×3 无合并表格 `S7表格删除源.docx`，删除 `t1-r2` 后 2×3，再删除 `t1-c2` 后 2×2，输出 10581 字节；OnlyOffice 返回 `Percent=100/EndConvert=True`，PDF 222821 字节。
- 真实合并表验收（`OnlyOffice测试.docx`，16 行 / 9 gridCol，SHA256 `27B7B286571BE64C7B87B8331DD7F57F0F514B8AD5D8C7F85F511F005A9ADE70` 未变）：
  - 直接删除 `t1-r2`：返回 `remainingRows=15/remainingColumns=9`；原 row2 的 `作业地点`、`天窗调度命令正式` 等 restart 内容迁到原 row3 continuation，row2 变为 `1 v:restart "作业地点" | 4 v:restart | 1 v:restart "天窗调度命令正式" | 1 v:restart "命令号" | 2`，行 span 合计 9。
  - 直接删除 `t1-c8`：返回 `remainingRows=16/remainingColumns=8`；原列 8 覆盖的 cell 逐个缩减 span 或移除，row1 span 9→8，row15 仍为 `1+1+1+1+2+1+1=8`。
  - 再删除 `t1-r15`：返回 `remainingRows=15/remainingColumns=8`；`readDocxOutline` 仍按每行 cell 数显示 7 列，`remainingColumns` 是 grid 列数，二者在合并表下不相等。
  - 直接删列 PDF `S7-merged-direct.pdf` 260251 字节，第 1 页标题、第 2 页 9→8 网格表格、第 3 页填写说明和表格尾部均保留；直接删行 PDF `S7-merged-row.pdf` 260309 字节，第 2 页保留“作业地点/天窗调度命令正式/命令号”等合并内容，未出现空白锚点块。
  - 真实 HTTP 验收：创建该员工临时会话和临时 `workspace_files` 行，`POST /api/tools/office.insert/invoke` 依次执行 `delete t1-c8`、`delete t1-r15`，均返回 200，结果分别为 `remainingRows=16/remainingColumns=8`、`remainingRows=15/remainingColumns=8`；临时文件 13869→13871→13765 字节，审计 `workspace.file.agent_edit` 记录 `source=office.insert`、`action=delete`、`elementId=t1-c8/t1-r15`、`size=13871/13765`（seq 882/884）。转换 PDF `S7-http-final.pdf` 260257 字节，第 2 页与直接删列/删行结果一致。
- 拆分边界：对 row1 整行 `gridSpan=9` 的标题执行 `split` 会把标题文字压进第 1 个窄 grid cell，PDF 出现竖排标题和表格错位；因此真实合并表结构变更优先直接删行/删列，不把 `split` 当作无损归一化。`split` 仍用于需要列插入、纵向合并行插入或再 `merge` 的显式归一化场景，并会改变横向合并版式。
- 剩余：`merge` 不支持多单元格文本合并；列插入、含 `vMerge` 的行插入、已合并表再 `merge` 仍需先 `split`；xlsx 行/列删除；pptx 结构变更。

**S8 格式扩展**

- 已完成：`office.format` 增加 `align`、`lineSpacing`、`spaceBefore/After`、`fontFamily`；仍按目标元素定位，不改其他元素。
- 剩余：`tableBorders`、`shading`。

**S9 范围读取**

- 已完成：新增 `office.read_range`，支持 docx `pN` 段落、`tN` 整表、`tN-rN` 行、`tN-cN` 列、`tN-rN-cN` 单元格；返回 `text`、`start/end`、`totalLength`、run 级格式（加粗/斜体/下划线/颜色/字号/字体族/字符样式）、段落格式（样式/对齐/行距/段前段后）和表格行列数据。
- 边界：`start/end` 只对 `pN` 和 `tN-rN-cN` 有效；整表、行、列读取要求省略偏移；xlsx/xlsm/pptx 明确返回“暂只支持 docx”，不静默降级。
- 验收已通过：fixture `表格插入测试.docx` 的 `p1` 读回完整文本和“黑体 + Heading1 + 居中 + 1.5 倍行距 + 段前段后 6 磅”；`t1` 读回 3×3 表格文本与 9 个 run；`t1-r2`、`t1-c2`、`t1-r2-c2` 分别读回行、列、单元格；非法偏移和非法 ID 被拒绝，未写盘。

### M2：xlsx

**S11 xlsx 插件注入**

- 已实现 `buildOfficePluginConfig(token, editorTypes)`：`editorTypes` 支持单个或数组，S13 后缺省 `['word','cell','slide']`；无 token 的元数据同时声明三种编辑器，带 token 的 config 按文件类型返回 `['cell']`、`['word']` 或 `['slide']`。
- `workspace.ts` 对 `documentType === 'word' || 'cell' || 'slide'` 注入 `pluginConfigUrl`，xlsx/pptx 走 `officeDocumentType(row.name,row.mime)`；`/onlyoffice-plugin/config.json` 的 `editorType` 使用 `documentType || 'word'`，不再把 slide 落到 word；`/api/workspace/office/plugin/context` 返回 `documentType`。
- 插件页新增 `cell-section` 工作表面板：xlsx 隐藏修订/高亮，按钮文案改为“读取工作表”“查找并选中”，显示工作表摘要与“替换选中”输入；`applyEditorMode()` 在上下文到达后分流。
- `readWorksheet()` 用 `Api.GetActiveSheet()` 读取 `A1:F12`，返回工作表名、行列、非空格数和前 3 行预览；`locateCell()` 在前 20×8 区域按 `A1`…`H20` 扫描 `GetValue()`，命中后 `Select()`；`replaceSelectedCell()` 在编辑模式对已选中地址执行 `SetValue()`，只读时拒绝。`readDocumentStructure()` / `locateText()` 在 cell 模式分别转入工作表读取和单元格查找。
- 已通过：`pnpm typecheck` exit 0；S13 后 `onlyoffice.test.ts` 11 tests、`onlyoffice-plugin.test.ts` 4 tests；`node --check plugin.js` / `chat.js`。真实 HTTP：无 token config `EditorsSupport:["word","cell","slide"]`；`格式测试.xlsx` 令牌 config `EditorsSupport:["cell"]`；context `documentType:"cell"`、`previewKind:"office"`、`canEdit:false`、8 项 agentOps。
- 新增 xlsx→PDF 证据：同一 xlsx 经 OnlyOffice `ConvertService.ashx` 返回 HTTP 200、`EndConvert=True`、`Percent=100`，生成 `.eab-dev/tmp/S11-xlsx.pdf`（219015 字节）；第 1 页可见 `项目`、`负责人`、`何益`，证明文档服务能下载并渲染 xlsx 内容。
- 真实浏览器插件验收已通过（无头 Chrome 登录态 + CDP 读取 OnlyOffice 插件 iframe）：
  - 只读：插件页 `status=已连接`、文档 `格式测试.xlsx`、标签 `只读`；`cell-section` 可见、`review-section` 隐藏；按钮为“读取工作表”“查找并选中”。
  - 读取：点“读取工作表”后返回 `隐患台账 · 12×6`、`A1:F12`、非空 4 格，日志前 3 行包含 `项目 | 10 |`、`负责人 | 何益`。
  - 查找：输入 `何益` 后 `cell-summary=已选中 B2`，日志 `B2 · 何益`；只读下“替换选中”保持禁用。
  - 编辑：切编辑模式后标签 `可编辑`，选中 `B2` 并输入 `验收替换值`，日志 `B2 → 验收替换值；保存或关闭预览后回写云空间`；再次读取工作表，预览显示 `负责人 | 验收替换值`。
  - 未保存副作用：直接关闭预览，云端 `格式测试.xlsx` SHA256 仍为 `6289B5960D398B6385913D15E0A5248E3765C9D24D7F17D2F1A7A9AE9024F61F`、大小 2555、mtime 仍为 `2026-11-13T22:58:44`，证明替换只发生在编辑器内存。
- 未完成/未验证：数字、公式、合并单元格被 `SetValue` 替换后的行为；替换后保存与查看态重载属于 S12b。全量 vitest 在 8GB 内存下仍因 esbuild `VirtualAlloc ... errno=1455` 未能收集 105 个 suite，不能当作全量回归通过。

**S12 xlsx 内容工具**

- 在现有 `readXlsxOutline`/`findInXlsx`/`replaceXlsxCellText` 上已补：
  - `office.insert`：插入行/列、追加工作表、删除工作表；
  - `office.format`：单元格字体、填充、数字格式、对齐，以及列宽/行高；
  - `office.comment`：xlsx legacy 单元格批注 `add/list/delete` 已按 comments + VML 模型实现（S12-L6），不复用 docx `comments.xml` 线程模型；`reply/resolve` 与短语锚点参数明确拒绝。
- 验收：每个工具真实 HTTP 调用后读回 xlsx XML；公式不被字符串替换误伤；多 sheet 定位正确；只读拒绝。

**S12b xlsx 保存同步**

- 插件 `saveDocument()` 复用 `POST /api/workspace/office/plugin/force-save`；`replaceSelectedCell()` 成功后置 `documentDirty`，保存前等待 900ms，并在 `no_changes` 时最多重试 2 次（间隔 1200ms），避免 OnlyOffice 尚未登记 Api 写入就触发 forcesave。
- `force-save` 返回 `saved` 后，插件向顶层发 `eab:onlyoffice:saved`（含 fileId/documentType/updatedAt/size）；`chat.js` 校验同端口与当前预览 fileId，先调 `refresh-guard` 抬 cutoff，再刷新文件列表并 `openWorkspaceFile(id,{mode:'view'})`。旧编辑器关闭回调因版本低于 cutoff 被丢弃，不会二次改写。
- 只读 token、非本人、版本不一致仍由现有 `force-save` 与回调校验拒绝；查看态插件保持只读。
- 验收（2026-11-14，真实浏览器 + 审计）：临时副本 `S12b保存验收.xlsx`（fileId `01M7CC6K3QCRNP5NBPN1NWXHEG`）编辑态把 B1 替换为 `S12b最终值`，点保存后 `force_save state=saved`，`updatedAt=1794638449504`、size 8508；父页自动切 `mode=view`，预览头显示 `2026/11/14 14:40:49`，新插件以 `只读` 读回 `项目 | S12b最终值`。审计记录 `workspace.file.edit source=onlyoffice`、`workspace.file.force_save saved`；关闭旧编辑器的回调 `payloadVersion=1794638298917 < cutoff=1794638449504` 记为 `office_stale_callback` 并丢弃。
- 未验证：数字/公式/合并单元格替换后保存；保存成功后同一编辑器会话连续二次保存（当前设计是切查看态，需重新进入编辑取得新 token）；共享只读文件的浏览器写入拒绝沿用 S1/S2 拒绝路径。

**S12-L3/L4 xlsx 工作表结构与尺寸（已完成，2026-11-14）**

- 新增 `appendXlsxSheet`：校验工作表名（去空格后非空、≤31 字符、不含 `\ / ? * [ ] :`、不以单引号开头/结尾、与已有表大小写不敏感重名拒绝）；`sheetId` 取现有最大值 +1，relationship 取最小未用 `rIdN`，工作表 part 取最小未用 `xl/worksheets/sheetN.xml`；同步更新 `xl/workbook.xml` 的 `<sheets>`、`xl/_rels/workbook.xml.rels`、`[Content_Types].xml` override 并写入新 worksheet。
- 新增 `deleteXlsxSheet`：只接受 `elementId=sN`，至少保留一个工作表；删除前扫描其他工作表的 `<f>`/`<formula>`/`<formula1>`/`<formula2>` 公式、workbook `<definedName>`，以及 `xl/charts|pivotTables|pivotCache` 下的 `<c:f>` 公式中指向目标表的引用并拒绝；删除 workbook `<sheet>`、relationship、worksheet part、worksheet rels、content type override，按引用计数清理该表独占的 comments/VML/drawing/table 等关联部件（仍被其他工作表引用的部件保留），存在 `xl/calcChain.xml` 时一并删除。
- 新增 `formatXlsxDimension`：支持 `sN-cN`/`sN-rN` 及同类型范围 `sN-c2:c4`、`sN-r2:r4`；列宽 0–255、行高 0–409，同一调用不能同时传列宽和行高，类型必须与 `elementId` 匹配。列号限制 1–16384、行号限制 1–1048576；单次行高范围最多 20000 行，避免超大范围生成巨量 `<row>`。列宽会拆分已有 `<cols><col min max/></cols>` 区间并保留原属性；行高更新已有 `<row>` 或按行号插入空 `<row>`，保持升序。
- 修复真实验收暴露的问题：新工作表最初写成自闭合 `<sheetData/>`，`office.replace` 写空单元格时会报“xlsx 工作表缺少 sheetData”；已改为 `<sheetData></sheetData>`，并在 `office-content.test.ts` 增加“追加工作表后写入 `s2-r1-c1` 并读回”的回归断言。
- 真实 HTTP 验收（2026-11-14）：
  - 副本 `S12c结构验收2.xlsx`（fileId `01M7CDYD1A81S7AF396A41GW00`）：`office.insert` 追加 `新增验收表` 返回 `sheetId=s2/sheetCount=2`；`office.replace` 写 `s2-r1-c1=结构验收` 返回 `replacements=1`；`office.format` 设 `s2-c1` 列宽 22、`s2-r1` 行高 30 均返回 `wrote=true`；`office.read_outline` 读回 s2 的 A1 为“结构验收”；`office.insert(action=delete,s2)` 返回 `remainingSheets=1`，原「隐患台账」4 格内容不变。
  - 副本 `S12c结构验收4.xlsx`（fileId `01M7CE0N1VC5D42XVSBSD6FH6G`）保留新表用于物理 XML 检查：`xl/worksheets/sheet2.xml` 为 `<cols><col width="22" customWidth="1" min="1" max="1"/></cols>`、`<row r="1" ht="30" customHeight="1"><c r="A1" t="inlineStr"><is><t>结构验收</t></is></c></row>`；workbook `r:id="rId5"`、rels 指向 `worksheets/sheet2.xml`、Content Types 有对应 override。
  - 同一 `S12c结构验收4.xlsx` 经 OnlyOffice `ConvertService.ashx` 返回 `Percent=100/EndConvert=True`，生成 `S12c-structure.pdf`（221159 字节），说明 OnlyOffice 可解析该工作簿。
  - 硬化副本 `S12c硬化验收3.xlsx`（fileId `01M7CFH0S9VXTNGM9M3H4C86YK`）：`office.format s1-c1` 列宽 22、`s1-r1` 行高 30 返回 200；`s1-c16385`、`s1-r1048577`、`s1-r1:r20001` 分别返回 400「列号必须在 1 到 16384 之间」「行号必须在 1 到 1048576 之间」「单次行高设置最多 20000 行」；追加 `硬化验收表` 返回 s2、删除返回 `remainingSheets=1`，最终 1 表、size 7242，原 4 格内容不变。审计里成功写入仍记 `workspace.file.agent_edit`，失败校验未产生文件写入审计。
- 验证：`office-content.test.ts` 53 tests（S12-L3/L4 当时）；随 S12-L6 批注用例增至 58 tests，`pnpm typecheck` exit 0；真实 HTTP 审计记录 `workspace.file.agent_edit`，`source=office.insert`（追加/删除）、`source=office.replace`、`source=office.format`（`applied=["columnWidth"]`、`applied=["rowHeight"]`）均 `result=success`。
- 已知边界：追加/删除后整包按固定级别重新压缩，文件大小会变化（8508 → 7678，删除新表后 7205），内容与关系读回正常，不视为数据丢失；未在 Excel 桌面端人工打开验证；删除表已覆盖公式、definedName、图表/透视公式与独占关联部件，但未覆盖 threaded comments 的 persons 部件、图片/媒体等跨部件递归清理。

**S12-L6 xlsx 单元格批注（已完成，2026-11-14）**

- 新增 `readXlsxComments`、`addXlsxCellComment`、`deleteXlsxCellComment`，按 xlsx legacy note 模型实现，不复用 docx `comments.xml` 线程结构：
  - comments 部件：`xl/comments/commentN.xml`，维护 `<authors>` 与 `<commentList>`，正文写入 `<text><t xml:space="preserve">`；
  - VML 部件：`xl/drawings/vmlDrawingN.vml`，每条批注一个 `ObjectType="Note"` 形状，`<Row>/<Column>` 为单元格零基行列；
  - sheet rels：写入 `comments`、`vmlDrawing` 关系，Target 采用绝对 `/<part>`（与 openpyxl 样本一致）；
  - Content Types：补 `Default Extension="vml"` 与 comments part 的 `Override`。
- `office.comment` 的 xlsx 分支支持 `add/list/delete`：
  - `add` 只接受 `sN-rN-cN`，同一单元格已有批注时拒绝，不静默覆盖；
  - `list` 返回 `kind/xlsx`、`total/open`、每条批注的 `elementId/sheetId/sheetName/cell/author/text`；
  - `delete` 支持按 `elementId` 或 `commentId`（list 序号）删除；删除最后一条时一并清理 comments、VML、sheet rels、Content Types override 与 VML rels；
  - `reply/resolve` 明确返回 400，`oldText/start/end/occurrence` 明确返回 400，不伪造线程或短语锚点。
- 修复 `xlsxResolvePartPath` 对绝对 Target 的处理：openpyxl 样本的 sheet rels 使用 `Target="/xl/comments/comment1.xml"`、`Target="/xl/drawings/commentsDrawing1.vml"`；原实现会拼成 sheet 目录下的错误路径。修复后删除工作表时能按引用计数清理真实 Excel/openpyxl 批注部件。
- 验证：
  - `office-content.test.ts` 58 tests 全过，覆盖新增/读回、`& <验收>` XML 转义、重复单元格拒绝、按 elementId/commentId 删除、最后一条清理、VML 仍有非批注形状时保留 VML、openpyxl 绝对 Target 读取与删除、删表清理批注/VML；`pnpm typecheck` exit 0。
  - 真实 HTTP 副本 `S12d批注验收.xlsx`（fileId `01M7CGAA1A3BY9E9MP1MW0X7S4`）：初始 `list total=0`；A1 add 返回 `commentId=1`、B2 add 返回 `commentId=2`，list 读回两条作者/正文；A1 重复 add 返回 400「已有批注」；delete A1 返回 `remaining=1`；delete B2 by `commentId=1` 返回 `remaining=0`；重建 B2 后 `list total=1`；reply/resolve、oldText、`s1-c1` 均返回 400。重启服务加载最终代码后再次删除最后一条 B2：返回 `remaining=0`、size 7527，`list total=0`，comments/VML 部件均被清理；重新 add B2 后 size 8572，`list total=1`，openpyxl 与 OnlyOffice 再次读回成功。最终文件 8572 字节，`office.read_outline` 四格内容不变。
  - XML 证据：最终文件含 `xl/comments/comment1.xml`（B2、EAB Agent）、`xl/drawings/vmlDrawing1.vml`（`Row=1/Column=1`）、sheet1 rels 两条关系、Content Types `vml` Default + comments Override；`openpyxl.load_workbook` 读回 B2 批注正文“批注重建”、作者 `EAB Agent`，A1 无批注。
  - OnlyOffice `ConvertService.ashx` 对同一 fileId 返回 `Percent=100/EndConvert=True`，生成 `S12d-comments.pdf`（221152 字节）；PDF 可渲染工作簿，说明 OnlyOffice 能解析带批注的包。
  - 审计：所有成功 add/delete 均记 `workspace.file.agent_edit`，`source=office.comment`，包含 `action/elementId/commentId/author/text/remaining`；重复、reply/resolve、oldText、非法 cell 失败均未产生文件写入审计。
- 已知边界：只支持 legacy flat comments，不读取/写入 `xl/threadedComments` 与 persons；VML 使用固定 `59.25pt/1.5pt/144px/79px` 位置并只写 Row/Column，不保留/计算自定义批注框位置；`commentId` 是当前 list 的 1 基序号，删除后会重排；保留未使用作者直到 comments 部件整体删除；未在 Excel 桌面端人工打开验证；全量 vitest 仍未重跑。

### M3：pptx

**S13/S14 pptx 插件与内容工具（已完成 2026-11-14）**

- S13 配置：`buildOfficePluginConfig` 默认 `EditorsSupport` 改为 `['word','cell','slide']`；`workspace.ts` 对 `documentType === 'slide'` 注入 `pluginConfigUrl`，`/onlyoffice-plugin/config.json` 的 `editorType` 改为 `documentType || 'word'`，不再把 slide 落到 word。
- S13 插件页：`plugin.js` 归一化 `documentType` 支持 slide；`applyEditorMode()` 隐藏修订/高亮和 cell 区、显示 `slide-section`；`readPresentation()` 用 `Api.GetPresentation()`、`GetAllSlides()`、`GetAllShapes()`、`shape.GetContent().GetText()` 读取，回退 `GetElementsCount/GetElement/GetText`；`locateSlideText()` 逐页逐形状匹配，优先 `GoToSlide`，当前构建回退 `ApiSlide.Select()`，再 `shape.Select(true)`。
- S14 服务端能力沿用既有 `office-content.ts` pptx 内核：`pptxTargetPath`、`pptxSlideRefs`、`pptxOpenPackage`、`pptxParseParagraphs`、`pptxLoadSlides`、`readPptxOutline`、`findInPptx`、`pptxReplaceValue`、`replacePptxText`；工具路由 `office.read_outline` / `office.find` / `office.replace` 的 pptx 分支无需重写，本轮做真实入口复核。
- 验证：
  - 真实 HTTP 副本 `S13pptx验收2.pptx`（fileId `01M7CHH1132APQ7XFPRZQ9SMMM`）：`read_outline` 返回 1 页、`s1-p1/s1-p2/s1-p3` 正确；`find` 命中 `s1-p2`、`start=2/end=8`；`replace(oldText=真实链路验收,newText=PPTX 真实验收)` 返回 `wrote:true/saved:true/replacements:1`，读回 `这是PPTX 真实验收`，`s1-p1/s1-p3` 不变；`version 1794643624995 → 1794643625176`、size 28812。
  - 拒绝路径：`occurrence=0`、段落内换行、`s1-p99` 均 400，文件未变。
  - XML：只改 `ppt/slides/slide1.xml`（1065→1064 字节），包内无新增/删除部件；`p2` 仍为两个 run，`这是` 保留 `b=1`，新文本沿用第二个 run 的无格式；`p1`/`p3` 原样。
  - 插件配置：pptx `documentType:"slide"`，token config `EditorsSupport:["slide"]`，context `documentType:"slide"`；xlsx/docx 分别保持 `["cell"]`/`["word"]`。
  - 真实 OnlyOffice：`S13pptx验收2.pptx` 在演示编辑器中打开，右侧出现 `PRESENTATION` 面板并显示“已连接”；点“读取幻灯片”返回 `1 页 · 2 个形状 · 2 个文本形状`；输入 `PPTX 真实验收` 后“查找并选中”返回 `已选中第 1 页 · 形状 2`，日志 `已跳转 · 已选中形状`。
  - OnlyOffice `ConvertService.ashx` 返回 `Percent=100/EndConvert=True`，`S13-pptx.pdf` 80323 字节，第 1 页可见 `这是` 加粗 + `PPTX 真实验收` 常规文本。
  - 审计：`workspace.file.agent_edit` 记录 `source=office.replace`、`elementId=s1-p2`、`replacements=1`、size 28812；被拒绝的 400 路径没有产生文件写入审计。
- 边界：pptx 只做文本级读取/替换，不新增幻灯片、复制版式、插入图片；`read_range` 仍不支持 pptx；当前 OnlyOffice 构建无 `GoToSlide`，已用 `ApiSlide.Select()` 兼容；真实浏览器只验证了单页样例，多页跳转与组合形状需补样本。

### M4：兜底与治理

**S15 GUI 兜底白名单**

- 只列 L1/L2 无法完成且用户明确确认的动作：打印设置、宏管理器、部分导出选项、OnlyOffice 原生对话框。
- 每次动作前确认；失败一次即停；记录 `workspace.file.agent_gui` 审计；不承诺稳定。
- 验收：白名单外的 GUI 动作被拒绝；确认后动作有审计；失败不无限重试。

**S16 版本/撤销/冲突/审计**

- 保存前写版本快照（文件字节 + `updated_at` + operationId）；提供 `office.save` 的 `snapshot:true` 和版本列表/恢复；冲突按 `updated_at` 或显式 `baseVersion` 拒绝覆盖。
- 撤销优先用 OnlyOffice 编辑器撤销；服务端提供“恢复到上一版本”，不伪装成编辑器撤销。
- 审计补 `operationId`、目标、修改前后摘要、保存结果。
- 验收：并发写入一方冲突被拒且文件未变；版本恢复读回旧内容；审计字段完整。

### P2/P1 后续（不阻塞 OnlyOffice 主线）

- P2-1 文本 diff：保存原文，按行/字符 diff 高亮，发送区回填选区。
- P2-2 PDF：页/区域选择、文本提取、批注覆盖层；重排编辑仍交给 PDF 工具。
- P2-3 图片：区域选择 + OCR/描述 + 标注建议；不做像素级生成式重绘。
- P2-4 权限失效：预览打开时轮询 `preview-capability`，403/404 或文件被删除时关闭右栏、恢复全宽。
- P1-1/2/3：`agent` 事件进 `chat-events`、父子双向通道、会话级父 Agent 记录；需要单独设计，不与 OnlyOffice 写工具混在一起。

## 5. 每步完成定义

每一步都必须同时满足：

1. 代码接入真实入口，不是只写函数或静态页面。
2. 有区分旧行为的最小验证；能单元测试的进 `office-content.test.ts` / `onlyoffice.test.ts` / 路由测试。
3. 至少一次真实入口验收：HTTP 工具调用或 `/chat` 浏览器操作；涉及 OnlyOffice 的必须打开真实编辑器。
4. 只读、共享、过期 token、跨文件四类拒绝路径至少覆盖与本次改动相关的一类，并证明没有副作用。
5. 更新设计文档对应段落和任务板 #86 描述；不 commit、不 push、不改版本号，除非用户明确要求。

## 6. 回归基线

- 后端：`pnpm test` 当前 107 文件 / 624 测试通过（2026-11-14 S13/S14 后全量回归）；`onlyoffice.test.ts` 11、`onlyoffice-plugin.test.ts` 4、`office-content.test.ts` 58，合计 73 个定向测试通过；全量测试不能与定向测试互相替代。
- 类型：`pnpm typecheck`。
- 插件脚本：`node --check packages/server/public/onlyoffice-plugin/plugin.js`；前端 `node --check packages/server/public/chat.js`。
- 真实服务：`/api/health` 的 `sqlite`、`memory` 为 ready；OnlyOffice 容器可达；临时副本验收后 `workspace.delete` 软删，主文档不动。

## 7. 风险与待决定

1. `forcesave` 的 key 必须与编辑器打开时的版本一致；服务端工具在编辑器打开期间改文件会造成 key 不一致，S1 用插件 token 的 `version`，不回退到当前 DB 版本。
2. 修订 S5、批注 S6 已完成读取/写入、线程与删除闭环；批注线程依赖 `commentsExtended`/`commentsIds`，旧式仅 `w:parentId` 的线程不级联，根解决后回复仍计为 open，`commentsExtensible.xml` 未写，这三项需在 S16 前决定是否兼容。
3. xlsx 批注按 legacy comments + VML 实现，支持 add/list/delete；threaded comments/persons 与自定义批注框位置仍未做，公式、共享字符串、合并单元格仍不能按纯文本替换处理。
4. pptx 形状/版式差异大，先做文本级读取/替换；结构性编辑不足时明确走 GUI 兜底。
5. 编辑态“是否有未保存修改”没有可靠 API，S3 只做显式刷新确认，不自动覆盖。
6. 版本快照的存储位置、保留周期、配额计入方式尚未决定；S16 开始前需用户确认。
7. 插件 token 过期后的恢复方式：重新打开预览，还是在插件内换取新 token，需在 S4 前定。

## 8. 建议的下一步

S1–S14 已完成各自当前约定范围；S13/S14 已补齐 pptx 插件注入、幻灯片面板、文本级读取/查找/替换，并通过真实 HTTP、XML、OnlyOffice 编辑器和 PDF 验收。下一步建议进入 S15（GUI 兜底白名单）和 S16（版本快照/撤销/冲突/审计）；pptx 多页跳转、组合形状、结构编辑仍缺样本；threaded comments/persons 兼容、批注 VML 自定义位置、S10 版本快照、S16 并发覆盖策略仍需先确认范围与存储口径。

技能体系（与插件同级的后台、前端、权限、安全扫描、隔离与多层冗余）不在本 Office 计划内，另行维护在 `docs/skill-system-implementation-plan.md`；Office 的 S5/S6 已于 2026-11-14 完成，不重复实施。
