# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)：`0.x` 阶段次版本号表示**能力批次**，
修订号表示修复与打磨。所有版本都保留在 [插件市场索引](market-index.json) 中，可回退到任意历史版本。

---

## [0.4.11] — 2026-11-28

### 修复
- 🔴 **「WorkBuddy 一直显示加载失败」根治**：宿主（聊天模型选择器）对抛错的 provider
  显示「{name} 加载失败：{message}」并**缓存该失败**，只在 `llm/adapters-updated` /
  `llm/models-updated` 事件或手动「重试」时重拉。插件侧三处加固，让宿主**永远不可能**
  为 WorkBuddy 记失败：
  - `workbuddy` 适配器 `listModels()` 加 try/catch + 12s 超时竞速——出错返回空清单
    （宿主显示空分组，事件触发后自动恢复），不向宿主抛错；
  - `credit-hub` 聚合适配器 `listModels()` 同样兜底（catalog 内部已按来源降级，
    外层再兜 combos/settings 意外异常）；
  - WorkBuddy `v3/config` 目录拉取超时 30s → **8s 快速失败**回退静态清单——此前
    网络抖动时两个 realm 串行 30s×2 会把宿主目录 RPC 拖到 60s 触发超时失败。

### 排查结论（供后来者）
- 宿主文案定位：`dsh-client-ui-model-selection/src/client/locales.ts` 的
  `'warning.groupLoad': '{name} 加载失败：{message}'`；客户端在
  `service.ts` 监听 `llm/adapters-updated` + `llm/models-updated` 触发
  `catalog.refresh()`。
- 网关直调 `wb/cn/auto` 与 `workbuddy.listModels()` 实测均正常（27 模型 / 359ms），
  失败是**宿主早前的缓存**——所以除事件广播外，更要让 adapter 永不抛错。

---

## [0.4.10] — 2026-11-27

### 修复
- 🔴 **「WorkBuddy 一直显示加载失败」**：宿主把各 provider 的模型目录缓存在本地，
  并**明确监听 `llm/models-updated(provider)` 来重载 `listModels()`**（见宿主 Event 契约）。
  本插件此前只发 `llm/adapters-updated`（拓扑变化），且 `ctx.llm?.emitAdaptersUpdated?.()`
  未用 `ctx.root` 回退查找、在子 ctx 上是 no-op。结果：宿主若在插件启动早期（账号未就绪 /
  网络抖动）拉过一次失败清单，就把失败状态永久缓存、之后永不重试。
- 修法：`broadcastCatalogChanged()` 补齐两级事件（`adapters-updated` +
  `models-updated('workbuddy'/'credit-hub')`）、llm 服务用 `ctx.root` 回退；两条车道注册完
  **立即同步广播**，并在启动后 3s / 15s 两次兜底；周期任务与 `/refresh-models` 统一走它。
- 🔴 **CI 概率性失败（Node 22 windows 反复出现）**：各 e2e 用 `X + Math.random()*Y`
  分配端口，区间大量重叠，两个测试撞同一端口且前一个 server 尚在 TIME_WAIT 时即
  `EADDRINUSE`。改为进程内单调递增分配器 `nextTestPort()`，端口绝不重复。

---

## [0.4.9] — 2026-11-27

### 新增
- **`POST /api/credit-hub/refresh-models` 强制刷新模型清单**：旧版「刷新」按钮只重读 45s 缓存，
  上游新上架的模型永远看不到。新端点做三件事——清 WorkBuddy 模型缓存（含 11102 负缓存）、
  对**所有启用且有 Key 的上游**重新 `discover`、强制重算目录（跳过 TTL）。返回
  `{ before, after, added, details }`，单条上游失败不中断，逐条汇报。
- 总览页**「刷新」按钮改为直接执行完整刷新**（不再是只重读状态），完成后 toast 报
  「模型清单已更新：133 → 146（新增 13）」并按上游列出 `+N`。单按钮零学习成本，
  刷新期间显示「更新中…」并禁用防连点。

### 修复
- WorkBuddy 模型清单缓存（10 分钟）此前无法手动清除，新模型上架后要等自然过期或重挂插件。

---

## [0.4.8] — 2026-11-22

### 修复
- **`/summary` 版本号每次加载从磁盘重读**（绕过 CJS 模块缓存）。此前 `set_bundle` 开关重挂
  只重配 Loader entry、不清 `require.cache`，版本串会永久停在首次加载时的值，用户会误以为
  升级没生效（实际功能代码已是最新）。
- 🔴 诊断快照测试硬编码版本号 `'0.4.1'`，**每次发版必红一次**（本地因模块缓存未暴露，
  CI 全新安装会失败）。改为 mock 注入 `'test-version'`，测试不再依赖真实 package.json。

---

## [0.4.7] — 2026-11-22

### 文档
- 新增 `CHANGELOG.md`：0.4.0~0.4.6 逐版本变更（含 4 个已修关键 bug 的根因）、升级注意事项、
  回退版本对照表。加进 `package.json` 的 `files` 与 `release-check.mjs` 必需文件清单。

---

## [0.4.6] — 2026-11-22

### 重构
- **网关路由抽成声明式表**（`src/routes.js`）：三条 wire 线原本各写一遍「解析体 → 建
  AbortController → stream/complete → 日志 → 统计」，约 90 行重复代码；现在共用一套流程 +
  处理器注册表。**新增协议线只需 `routes.js` 加一行 + 注册三个处理器**，分发逻辑零改动。
- 顺带修复 `responses` 线**漏记结果日志**（openai/claude 都有，此前 responses 没有）。

### 测试
- 路由表结构自洽（8 组路径、方法敏感、无前缀/后缀泄漏、id 唯一）。
- 表驱动真实分发：6 个别名 + `healthz` 全 200，未知路径 404。

---

## [0.4.5] — 2026-11-22

### 安全
- **令牌桶限流**（`src/rate-limit.js`）：默认 120 突发容量、每 500ms 回填 1 个（≈2 req/s 持续）。
  按客户端 IP 计数，超限返回 `429 rate_limit_error` 并给出恢复时间。挂在鉴权**之前**，
  同时防 Key 暴力枚举。
- **鉴权失败告警**：连续失败第 10 / 50 次写警告日志，成功后清零。防"某个 agent 用错 Key
  无限重试"这类静默故障。
- **SSE 响应增长上限**：单请求累计 64MB 即截断，以 error 帧收尾。防失控上游吃光内存与带宽。
- `stats.rateLimited` 计数进网关统计视图。

### 修复
- 🔴 **令牌桶回填速率 bug**：参数 `refillPerMs` 命名是「每毫秒 token 数」，实现却当
  「每 token 毫秒数」用，导致回填放大 50 万倍、**限流完全失效**。已统一为 `msPerToken`
  （回填 1 个令牌所需毫秒数）。*这个 bug 是写测试时才暴露的——若无测试，功能会被认为
  「已实现」但实际不生效。*

### 测试
- 令牌桶：容量、回填、`retryAfter`、per-key 隔离（可注入时钟，零真实等待）。
- 失败计数器：累积、成功清零、超 256 key 逐出最旧。
- 网关级实测：连打 130 次 → 121 次 200（120 容量 + 1 回填）+ 9 次 429。

---

## [0.4.4] — 2026-11-22

### 测试
- **升级数据保留 e2e**：手工构造 0.2.x 时代的旧数据目录，验证新版本接管后每一样用户数据
  都不丢 —— `gatewayPort` / `thinkingOffByDefault` / `modelDisabled` / 旧 `checkinMarks`
  （旧键清理、新格式保留）/ WorkBuddy token / 上游 apiKey+baseURL / 降级链定义 / `usage.json`
  / **`gateway/api-key`（返回同一个 Key，已填进十几个 agent 的配置不会失效）**。
- `migrate()` 幂等：已是当前 schema 时零改动，连跑两次凭据与设置纹丝不动。
- `accounts.json` 在 POSIX 上是 `0600`。

### 修复
- 0600 断言原本在 fixture（`writeFileSync` 产物，0644）上执行，**验证的是测试自己而不是
  store**；改为断言前先触发一次真实 `stores.accounts.update()`（走 secret store 的
  `chmodSync`）。*这个问题只在 ubuntu 上暴露——Windows 走 else 分支，说明四平台 CI 矩阵
  不是冗余。*

---

## [0.4.3] — 2026-11-22

### 安全
- **非法 JSON 请求体回 `400 invalid_request_error`**（此前落进通用 catch 变 `500`）。
- **错误响应体不再回传内部堆栈**：堆栈只进日志（定位现场），响应只给消息。此前
  `error.stack` 数组会随 500 一起下发，暴露内部路径与代码结构。

### 可观测性
- `turn` 日志行补齐结构化字段：`traceId` / `ttfb` / `fallback`（候选切换数）/
  `breaker`（当时熔断态）/ `category`（统一错误分类）。

### 测试
- 网关 e2e：非法 JSON 400 无堆栈、空数组体不炸 500。
- **客户端断开 → 上游 abort 传播**：断开后 `streamTurn` 确实收到 abort signal。
- **IPv4 + IPv6 双栈**：`127.0.0.1` 与 `[::1]` 同端口都可达。
- **finish 三态跨线统一**：`stop`→`stop`/`end_turn`；`max_tokens`→`length`/`max_tokens`；
  错误→`error` 帧 + 已交付内容保留 + `[DONE]`。

### 修复
- 熔断冷却断言放宽至 `>=25s`：`cooldownRemainingMs` 从触发瞬间起算，断言执行时已流逝数 ms，
  严格 `>=30000` 会偶发失败（真实时钟竞态，不是划水）。

---

## [0.4.2] — 2026-11-22

### 新增
- **统一诊断快照 `GET /api/credit-hub/diagnostics`**：一次请求聚合
  `catalog`（含 `cacheAgeMs`/`stale`/`inflight`/三来源健康）/ `breakers`（汇总 + 明细）/
  `gateway` / `channels` / `recentFailures`。前端不再需要拼多个接口，降低轮询状态漂移。

### 修复
- 🔴 **测试框架静默通过缺陷**：`test()` 不 `await` 返回值，用
  `test('x', () => (async () => {...})())` 写的异步断言会在 `ok` 打印**之后**才执行，
  失败变成 unhandledRejection 而不计入 failures。已加防呆守卫（检测 thenable 直接报
  "必须用 testAsync"）+ 转换 8 处违规。*这个缺陷一度让转换器契约测试看起来是绿的。*

### 测试
- 熔断器集成：跨链共享同一成员状态、错误分类（TIMEOUT/TRANSPORT 熔断、
  REGION/AUTH 永不熔断）、并发半开只放行 1 个探测。

---

## [0.4.1] — 2026-11-22

### 测试
- **转换器契约测试 5 组**：OpenAI 全角色入站映射 + usage 线上字段 + finish 映射；
  OpenAI chunk 映射（工具参数跨 chunk 累积、未知 chunk 安全跳过）；Claude 混合内容
  拆两条（文本 + tool_result 不丢）；Responses 全 item 形态 + tools 过滤补 schema；
  **交叉协议一致性**（同一轮对话经三条线入站后 harness 侧等价）。
- **客户端注册契约测试**（`test/client-apply.mjs`）：验证 `apply()` 确实注册了
  `settings.section` 且无槽位挂载警告。补上了「设置里找不到积分汇通」这个长期盲区
  ——此前 `mount()` 的 try/catch 会静默吞掉注册失败。

### 文档与 CI
- `docs/PROTOCOL-MATRIX.md` 协议兼容矩阵（**以测试为准，非代码推断**，诚实标注 3 处差异）。
- 发布产物校验脚本 `test/release-check.mjs`：files 覆盖、transforms 打包、版本与索引同步、
  密钥泄露扫描、依赖声明一致性、`install.ps1` 备份 + DryRun、根目录无运行时数据。

---

## [0.4.0] — 2026-11-22

### 新增
- **成员熔断器**（`src/breaker.js`）：连续 N 次失败 → 熔断，冷却 30s 起指数退避封顶 10min，
  半开放行一次探测，成功即复位。降级链遍历时**直接跳过冷却成员**，不再白等它超时。
  - 阈值与冷却可通过 `settings.breaker.*` 配置（非法值自动回退默认）。
  - 熔断键用 `upstreamId ?? id`（同上游的多模型共享健康度，防状态分裂）。
  - 取消/外部 abort 不计失败；auth/配置错不熔断（换跳也救不了凭据问题）。
  - 429 的 `Retry-After` 覆盖冷却时长（只延长不缩短）。
- **可观测性**：每请求 `x-credit-hub-trace` 响应头（客户端 `x-request-id` 优先复用）；
  逐成员 TTFB + 总耗时采样，`usage` 视图给出 P50/P95 分位。
- `GET /breaker` 状态视图 + `POST /breaker/reset` 手动恢复（前端二次确认）。
- `/summary` 新增 `sources` 字段：按来源（workbuddy/upstreams/pack）报告健康与错误，
  不再笼统显示零模型。

### 重构
- **三协议转换器拆到 `src/transforms/{openai,claude,responses}.js`**（纯函数搬移）。
  `forward.js` 从 886 行降到 740 行，只剩生命周期/鉴权/分发/流控状态机。

### 修复
- 🔴 **熔断器半开语义写反**：旧实现「冷却期内第一次调用就放行」，等于熔断不挡人。
  正确语义：冷却期一律拒绝，期满才放行一个探测并立即加锁（并发安全）。
- 半开探测失败时档位未升级（`openUntil` 已过期被误判为"全新一轮"），冷却未翻倍。

---

## 0.3.0 及更早

| 版本 | 要点 |
|---|---|
| **0.3.0** | 新增火山方舟 / 百度千帆 / 魔搭 API-Inference 三个内置预设；千帆支持 `AK:SK` 自动换 IAM token 并续期；预设卡增加「获取 Key」直达官方页、保存后自动发现模型；一键签到（渠道包全部在用渠道 + WorkBuddy 国内账号）；撤销渠道卡与账号行的重复签到按钮 |
| **0.2.1** | channel-pack 读写兼容两层路径，既有账号/积分数据无需迁移 |
| **0.2.0** | 积分汇通车道注册、降级链（fallback / round-robin）、8330 网关三线兼容、账号池与积分查询 |
| **0.1.x** | 初版：WorkBuddy 渠道 + 自填上游 + 本地网关 |

---

## 升级注意

- **数据完全向前兼容**：`settings.json` / `accounts.json` / `routes.json` / `usage.json` /
  `gateway/api-key` 全部保留（有 e2e 测试保证，见 0.4.4）。
- **网关 Key 不变**：升级后已填进各 agent 的旧 Key 继续有效。
- **升级后建议刷新页面**（F5）：浏览器半身（`client.js`）按文件 mtime/size 重算 revision，
  刷新即可加载新 UI。
- **版本号显示可能滞后**：`/summary` 的 `version` 来自插件模块首次加载时缓存的
  `package.json`，用插件开关重挂不会清除 Node 的 CJS 模块缓存。完全重启 DSH 后更新。
  这只影响显示，功能代码始终是最新的。

## 如何验证

```bash
npm test          # host 测试 + 客户端注册契约 + UI 冒烟 + 发布产物校验，共 84 个用例
```

CI：GitHub Actions，Node 22/24 × Ubuntu/Windows 四矩阵，含语法检查、打包形状、
市场索引格式、文档链接、密钥泄露扫描。

## 如何回退

插件市场索引保留了全部历史版本，钉在各自的 commit 上：

```
0.4.6 → f07dbec    0.4.3 → 0277f3b    0.4.0 → 47dc6c9
0.4.5 → 1ee8bb1    0.4.2 → f91a7d3    0.3.0 → 6fd8a27
0.4.4 → afb6188    0.4.1 → 0a7b3b3
```