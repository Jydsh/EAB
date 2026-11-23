# EAB 天气工具设计与接入

> 版本：随 `2026.11.23`，不单独变更版本号。  
> 状态：代码已实现并完成真实接口、角色工具页与全量回归验证；未提交、未推送。

## 结论

EAB 原先没有任何天气工具。最合适的接入方式是**内置只读工具 `weather.now` + Open-Meteo 公开接口**：

- 不需要 API Key，不需要额外账号，符合免费、低成本优先。
- 一次调用返回当前天气和未来 1–7 天预报。
- 走 EAB 现有内置工具链，所有角色统一可见、可审计、可按角色工具权限控制。
- 外部 provider 放在独立适配层，后续换成和风天气、高德天气不影响工具 id 和权限配置。

不把天气做成个人插件：天气是平台级公共能力，做成插件会导致每个用户都要安装，权限与审计也分散。

## 用户看到的能力

用户可以直接说：

- “重庆现在天气怎么样？”
- “明天会下雨吗？”
- “未来三天重庆多少度？”
- “北京朝阳区天气”

工具入参：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `location` | string | 是 | 城市/区县名，如“重庆”“渝北”“北京朝阳”；也支持“纬度,经度” |
| `days` | number | 否 | 预报天数，默认 3，范围 1–7 |

返回内容：

- 地点：标准名称、省市区、经纬度、时区。
- 当前：天气现象、温度、体感温度、湿度、降水量、风速、观测时间。
- 预报：每天的天气、最高/最低温、降水概率、日出日落。
- `summary`：一段可直接念给用户的中文摘要。

示例（2026-11-22 实测）：

> 重庆 · 重庆市 · 中国当前阴，16.2°C，体感 16.1°C，湿度 74%。未来 3 天：11-22 阴 11.9~16.5°C；11-23 毛毛雨 13.4~15.9°C；11-24 小阵雨 11.6~14.5°C。

## 实现落点

| 文件 | 作用 |
| --- | --- |
| `packages/server/src/weather.ts` | 天气适配器：地理编码、预报请求、WMO 天气码中文映射、参数校验、超时和错误处理 |
| `packages/server/src/routes/tools.ts` | 注册 `weather.now`，补 `executeTool` 执行分支、搜索别名、首轮能力路由 |
| `packages/server/src/capability-route.ts` | 新增 `weather` 能力和 `weather` 工具组，让天气问题首轮直接拿到工具 |
| `packages/server/test/weather.test.ts` | 适配器单测：城市、坐标、找不到地点、上游 503、天数校验、天气码映射 |
| `packages/server/test/capability-route.test.ts` | 天气问题命中 `weather`，且不误触发文件工具 |
| `packages/server/test/tool-search.test.ts` | `tool_search` 能搜到 `weather_now`，且首轮下发 |

### 工具定义

```ts
{
  id: 'weather.now',
  name: '查看天气',
  scope: SC.AGENT_TOOL_INVOKE,
  dangerous: false,
  concurrency: 'read',
  input: {
    location: { type: 'string', required: true },
    days: { type: 'number' },
  },
}
```

工具 id 中的点会在函数名中转为下划线：`weather.now` → `weather_now`。天气是只读、非高危工具，沿用 `SC.AGENT_TOOL_INVOKE`，不需要新增权限 scope。

### 首轮路由

`routeCapabilities` 新增 `weather` 字段，命中词包括：

`天气、气温、温度、多少度、几度、下雨、降雨、降水、下雪、降雪、台风、大风、雾霾、空气质量、湿度、风力、冷不冷、热不热、weather、forecast`

命中后 `toolSpecsForAgent` 直接下发 `weather.now`。这样“重庆天气”不需要先走 `tool_search`，少一次往返。

同时保留 `TOOL_SEARCH_ALIASES`：

`天气 气温 温度 多少度 几度 下雨 降雨 降水 下雪 降雪 预报 冷不冷 热不热 湿度 风力 weather forecast temperature rain snow`

即使模型没走首轮路由，也能搜到工具。

## 外部接口

### 地理编码

```text
https://geocoding-api.open-meteo.com/v1/search?name=重庆&count=5&language=zh&format=json
```

优先选择 `country_code=CN` 的结果。

完整行政区名经常匹配不到，例如实测 `重庆市两江新区`、`重庆市`、`渝北区` 都是 0 结果，但 `重庆`、`渝北` 可以命中。适配器会按以下顺序回退，避免第一次调用报错后模型再重复调用：

1. 精确查询原名称。
2. 名称里带“市”时，回退到市名，例如 `重庆市两江新区 → 重庆`。
3. 去掉行政区后缀，例如 `渝北区 → 渝北`；短名有多个同名地点时拒绝猜测，例如 `天河` 有 5 个结果，不会随便选一个。

回退结果会带 `approximate: true`、`resolvedFrom`、`note` 和 `matchType`，例如：

```json
{
  "name": "重庆",
  "approximate": true,
  "resolvedFrom": "重庆市两江新区",
  "note": "未精确匹配「重庆市两江新区」，按重庆全市数据参考",
  "matchType": "parent-city"
}
```

全部候选都失败时返回 `EAB_VALIDATION`，提示补充省份或换更常见的城市名，不猜城市。

### 天气预报

```text
https://api.open-meteo.com/v1/forecast?latitude=29.56026&longitude=106.55771
  &current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m
  &daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset
  &timezone=Asia/Shanghai&forecast_days=3
```

- 单次请求超时 8 秒；连接超时或网络错误自动重试 1 次，间隔 350ms。
- HTTP 非 2xx 不重试，直接返回 `EAB_UPSTREAM`。
- 重试后仍超时返回中文错误“天气服务请求超时，请稍后重试”，不再把底层英文异常直接暴露给模型和用户。
- 参数错误 → `EAB_VALIDATION`。
- 不返回缓存或编造的天气数据。

### WMO 天气码

Open-Meteo 用 WMO code 表示天气现象，适配器内置中文映射，例如：

| code | 含义 |
| --- | --- |
| 0 | 晴 |
| 1 / 2 / 3 | 大部晴朗 / 多云 / 阴 |
| 45 / 48 | 有雾 / 雾凇 |
| 51 / 53 / 55 | 小毛毛雨 / 毛毛雨 / 大毛毛雨 |
| 61 / 63 / 65 | 小雨 / 中雨 / 大雨 |
| 71 / 73 / 75 | 小雪 / 中雪 / 大雪 |
| 80 / 81 / 82 | 小阵雨 / 阵雨 / 强阵雨 |
| 95 / 96 / 99 | 雷暴 / 雷暴伴小冰雹 / 雷暴伴大冰雹 |

未知 code 返回“天气代码 N”，不会被当成晴或阴。

## Provider 选择

| 方案 | 优点 | 代价 | 结论 |
| --- | --- | --- | --- |
| Open-Meteo | 免 Key、接口简单、当前天气+预报齐全 | 中国城市级精度一般；商用授权与 SLA 需另行确认 | 当前默认，先可用 |
| 和风天气 | 中文描述完整、国内数据好、有免费额度 | 需申请 Key，受配额和条款约束 | 后续正式商用可替换 |
| 高德天气 | 国内城市覆盖好、和地图能力协同 | 需 Key，天气要素相对少 | 可作为备选 |
| 个人插件 | 安装/审批隔离完整 | 每个用户都要装，平台公共能力碎片化 | 不作为首选 |

适配层已经把“地理编码 + 预报”封装在 `getWeather`，未来替换 provider 只需改 `weather.ts` 内部实现，工具 id、权限、路由和前端不需要动。

## 验证记录

已完成：

- `pnpm typecheck` 通过。
- 全量 `pnpm test`：194 个测试文件、1190 个用例全部通过。
- `pnpm test packages/server/test/weather.test.ts packages/server/test/capability-route.test.ts packages/server/test/tool-search.test.ts`：3 个文件、29 个用例全部通过。
- 真实 Node 进程调用 Open-Meteo 成功，返回重庆当前阴、16.2°C、湿度 74%、未来三天预报；证明不是只有 PowerShell 能连通。
- 通过 `executeTool(..., 'weather.now', ...)` 走完整工具注册、权限入口和执行分支，真实返回上述天气数据，不是只测适配器函数。
- 已复现并修复“重庆市两江新区”首调失败：精确查询 0 结果，回退到“重庆”后成功，`note` 明确写“按重庆全市数据参考”，不再需要第二次工具调用。
- 角色工具页实测：普通员工“可用工具”页共 45 项，新增“查看天气”并默认勾选，说明工具已进入角色授权目录。
- 单测覆盖：城市地理编码、坐标跳过地理编码、上级城市回退、区县去后缀、同名地点拒绝猜测、找不到地点、上游 503、`days` 越界、WMO 映射。
- 路由覆盖：“今天天气怎么样”“查看今天天气”“明天重庆下雨吗”命中 `weather`，文件/报表问题不误命中。

### 2026-11-23 超时故障修复

- 现象：网页工具卡“查看天气”耗时 8.3s，参数 `{days:3, location:"重庆"}`，错误 `The operation was aborted due to timeout`。
- 服务端日志：同一轮 `weather.now` 耗时 8971ms、8250ms，均未成功。
- 网络复测：地理编码稳定 1.1–1.7s；预报接口 3 次中 2 次 20s 超时、1 次 1.1s，确认是 Open-Meteo 预报端点的间歇性连接超时，不是参数或城市解析问题。
- 修复：天气请求增加 1 次超时/网络错误重试（间隔 350ms）；HTTP 4xx/5xx 不重试；重试仍失败时返回中文 `EAB_UPSTREAM`，不泄露底层英文异常。
- 验证：`weather.test.ts` 11 个用例通过，新增“首次超时后重试成功”和“重试仍超时返回中文错误”；`pnpm typecheck` 通过；真实 `getWeather('重庆')` 返回 200，耗时 3.2s。
- 网页真实对话：新建会话发送“重庆未来三天天气怎么样？”，模型选择 `weather_now`，工具执行 2.8s 成功，返回 11-23 小毛毛雨、11-24 小阵雨、11-25 小毛毛雨及温度区间。

待完成：

- 正式商用前确认 Open-Meteo 商用条款与 SLA。

## 风险与后续

1. **外部依赖**：Open-Meteo 不可用时天气工具会返回 502，不影响其他工具；连接超时和网络错误已增加 1 次重试，当前仍没有缓存。
2. **数据精度**：Open-Meteo 对中国区县级别精度有限，正式商用前应评估和风/高德。
3. **授权边界**：Open-Meteo 免费 API 的商用条款和 SLA 未在本轮核实，上线商业版本前必须确认。
4. **地点歧义**：同名城市可能选错；当前完整行政区名会回退到上级城市并明确标注，短名出现多个同名地点时直接拒绝，不静默猜测。
5. **后续增强**：可加 5–10 分钟短期缓存、provider 配置、空气质量、天气预警、按用户常用城市默认查询。

## 变更范围

本轮新增/修改：

- 新增 `packages/server/src/weather.ts`
- 新增 `packages/server/test/weather.test.ts`
- 修改 `packages/server/src/routes/tools.ts`
- 修改 `packages/server/src/capability-route.ts`
- 修改 `packages/server/test/capability-route.test.ts`
- 修改 `packages/server/test/tool-search.test.ts`
- 新增本文档

2026-11-23 超时修复：

- 修改 `packages/server/src/weather.ts`：超时/网络错误重试，中文错误归一化
- 修改 `packages/server/test/weather.test.ts`：补充超时重试成功与失败用例

未改版本号，未提交，未推送。
