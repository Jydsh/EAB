# SystemOne 决策模型接入与子 Agent 模型分配

更新日期：2026-11-14
适用仓库：`D:\AI kaifa\EAB`

## 1. 它解决什么问题

父 Agent 派生子 Agent 时，过去只用正则匹配任务里的“代码 / 图片 / 检索 / 快速”等关键词，再按能力命中数、父模型连续性、优先级和本轮负载打分。规则稳定，但不懂任务语义。

接入 SystemOne 后，父 Agent 会把这一批子任务和可用模型一起发给决策模型，由决策模型按任务内容为每个子任务选择模型；规则只作为降级路径。

## 2. 控制台配置

1. 进入「模型接入」→ 新增或编辑模型。
2. 模型类型选「决策 / 推理模型」，端点类型选「决策 / SystemOne（/v1/systemone）」。
3. 供应商必须是自定义 Base URL：填到 `/v1`，例如 `https://chat.ecnu.edu.cn/open/api/v1`；模型标识填上游要求的 model key（示例 `ecnu-decision`，以实际上游为准）。SystemOne 不是内置协议，不能留空走默认 OpenAI 地址。
4. 到「用途路由」把「子 Agent 模型分配」（`agent.model_choice`）绑定到这个模型。未绑定时，只要公司模型目录里存在启用的 systemone 决策模型，也会按用途路由的自动候选规则选用；不想启用就把该模型停用或删除绑定。
5. 决策模型属于服务端基础设施，不需要授权给员工角色；它只负责选模型，不会出现在员工聊天模型下拉里。子 Agent 实际可选的模型仍受“模型角色”限制：只有当前员工可见的 chat 模型才会进入候选。
6. 从供应商自动发现模型时，导入列表可以把类型选成「决策 / SystemOne」；模型名里含 `systemone` 的会自动推断成这个类型，其余决策模型仍按普通对话端点导入，需要手动改端点。

## 3. SystemOne 协议约定

请求：

```http
POST {base}/v1/systemone
Authorization: Bearer <token>
Content-Type: application/json

{
  "model": "<model key>",
  "state": { "purpose": "agent.model_choice", "tasks": [...], "models": [...] },
  "questions": {
    "task_1": {
      "type": "choice",
      "instructions": "为子任务选择最适合执行的模型…",
      "criteria": { "m1": "模型名称；能力：…", "m2": "…" }
    }
  }
}
```

EAB 只使用 `choice` 题型：每个候选模型对应一个短标签（`m1`、`m2`…），`criteria` 用短标签做键，避免小模型把 UUID 当标签时置信度被拉低；响应里的 `answers[questionId].choice` 可以是短标签或模型 ID，EAB 都会映射回真实模型。`confidence` 低于 0.3 视为不可靠并回退。

## 4. 降级与回退

以下情况不会阻断子 Agent 启动，会回退到 `chooseSubAgentModel` 原有能力匹配：

- 没有绑定 `agent.model_choice`，也没有可用的 systemone 模型；
- 决策模型没在公司模型目录里，或已停用 / 删除；
- 可用 chat 候选少于 2 个；
- SystemOne 超时、HTTP 错误、响应缺少 `answers`、choice 不在候选内；
- 置信度低于 0.3。

`task.modelId` 显式指定仍然最高优先级，不送入决策。

## 5. 当前验证

- `pnpm typecheck`：通过。
- `packages/server/test/systemone.test.ts`：6 例通过（端点/用途注册、模型名推断、请求路径与请求体、detail 错误、批量分配、短标签映射、低置信度回退）。
- `pnpm test`：111 个测试文件 / 642 个用例通过。
- 8788 服务已用新代码重启；`http://127.0.0.1:8788/app.js` 返回 200。
- 真实联调（2026-11-14，company `c1`）：`agent.model_choice` 已绑定 `kev-4b`；`kev-4b` 通过 LM Studio 的 `/v1/systemone` 正常返回结构化决策。三个真实子任务中，“修接口”选择 `Qwen3.8-27B-FP8`（置信度 32%），“查制度”选择 `Qwen3.8-27B-FP8`（置信度 33%）；“写摘要”置信度约 7%，低于 0.3，按设计回退能力匹配。
- `openjev-1.7b` 在同一次联调中返回 HTTP 400：LM Studio 未加载该模型（`Invalid model identifier`）。如果要用它，需要先在 LM Studio 加载并确认 `/v1/systemone` 可用。
- 上述真实联调走的是公司已配置的 LM Studio 兼容端点，不是 ECNU 公网网关；换 ECNU 时按第 2 节填写 Base URL、model key 和 token 即可。
