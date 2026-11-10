# 「模型返回了空内容」诊断记录

## 现象

- 会话：钉钉私聊
- 用户消息：`帮我整理一下今天的工作记录，我们今天完成了什么工作，然后写到我的工作空间里面`
- 时间：2026-11-10 00:03:02（Asia/Shanghai，库内 `created_at=1794240182973`）
- 失败回复：内容为
  `这次回答没有成功：模型返回了空内容。可以换个问法再试。`
- 时间：2026-11-10 00:03:55（`created_at=1794240235513`）
- 该轮审计：`rounds:0`、`tools:0`，没有实际工具调用。

## 决定性证据

失败回复的 `meta_json`：

- `rounds: 0`
- `toolCalls: []`
- `tokens: { prompt: 0, completion: 0 }`
- `reasoning` 长度 **3934 字符**，末尾停在
  `... 312 = 7*44 + 4, so 4 days after Thursday = Monday`
  —— 句子在中间被截断。
- 正文 `content` 为空。

前几轮正常回复的 `reasoning` 只有 152～459 字符，且 `rounds:2 / tools:1`。这说明不是模型服务整体不可用，而是这一轮模型把输出预算几乎全部花在了“今天到底是 11-09 还是 11-10、2026-11-09 是星期几”的自我推理上。

## 根因

1. 聊天链路给模型设置的默认 `max_tokens` 是 **1024**（`packages/server/src/routes/chat.ts`、`packages/server/src/llm.ts`）。
2. 当前模型是带 reasoning 的 `Qwen3.8-27B-FP8`。这一轮 reasoning 已经写到 3934 字符，达到 1024 token 左右的上限后被截断。
3. 截断发生时，模型既没有生成 `content`，也没有发出 `tool_calls`；`callOpenAiStream` 在流结束后检测到“无正文、无工具调用”，抛出 `模型返回了空内容`。
4. 钉钉入口把该异常转成用户看到的兜底文案：
   `这次回答没有成功：模型返回了空内容。可以换个问法再试。`
5. 因为异常发生在第一轮模型调用返回之前，`runAgentTurn` 的统计结果没有建立，所以 `rounds` 被记为 0；截图中“工具调用记录”只是卡片的固定入口，没有真实工具记录。

补充：`tokens: { prompt: 0, completion: 0 }` 不是“没有消耗 token”，而是当前流式请求没有要求上游回传 `usage`，代码拿不到统计时落成了 0。

## 修复

已落地三处：

1. `packages/server/src/llm.ts`
   - 流式/非流式默认 `max_tokens` 从 1024 提高到 **4096**。
   - 新增“只返回 reasoning、没有正文”的识别；遇到这种情况用翻倍预算（最多 16384）自动重试一次，重试时丢弃 reasoning 事件，避免前端看到重复思考。
2. `packages/server/src/routes/chat.ts`
   - 对话默认输出预算同步改为 4096。
   - 系统提示里加入当前时间与星期：
     `当前时间：YYYY/MM/DD HH:mm 星期X（Asia/Shanghai）...不要靠心算日期和星期`
     减少模型在“今天/星期几”上的长推理。
3. `packages/server/test/llm-empty-content-retry.test.ts`
   - 新增回归测试：第一次只返回 reasoning + `finish_reason=length`，第二次返回正文；断言请求次数为 2、第二次 `max_tokens` 翻倍、最终拿到正文。

## 验证

- `pnpm typecheck`：0 错误。
- `pnpm test`：**31 文件 / 231 例全部通过**。
- 8787 已重启，`/api/health` 返回 `ok:true`。
- 未做真实钉钉重发：失败那一轮的用户诉求（写工作记录）仍未完成；需要用户在钉钉里重发一次，或由我在网页工作台补做。
