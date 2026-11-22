# 架构

本文描述 dsh-credit-hub 的进程结构与请求流转路径。面向维护者与想理解内部机制的贡献者。

## 总览图

```
┌─────────────────────────── DeepSeek Harness Host (Node) ───────────────────────────┐
│                                                                                     │
│  index.js — 插件装配层                                                              │
│  ├─ createStores()            settings/routes/accounts/usage 持久化 (0600+ACL)      │
│  ├─ createWorkbuddyRuntime()  WorkBuddy/CodeBuddy 原生渠道（登录/刷新/签到）        │
│  ├─ createUpstreamRuntime()   自填上游 + 13 预设（千帆 AK:SK 自动换 token）         │
│  ├─ createPackBridge()        pk/<provider>/<model> 桥接 channel-pack 渠道          │
│  ├─ mountAccountPack()        vendored channel-pack（raccoon/qoder/trae/…）         │
│  ├─ createHubRuntime()        ★ 统一目录 + 降级链 + 熔断器 + trace-id               │
│  ├─ startGateway()            127.0.0.1:8330 OpenAI/Anthropic/Responses 三线兼容    │
│  └─ createApiRoutes()         /api/credit-hub 管理面（回环 + Origin 校验）          │
│                                                                                     │
│  ctx.llm.registerAdapter(['credit-hub']) → 宿主模型选择器出现「积分汇通」分组        │
└─────────────────────────────────────────────────────────────────────────────────────┘
                          │ /plugins/<pkg>/client.js
                          ▼
┌─────────────────────── 浏览器半身 client.js（单文件 bundle） ───────────────────────┐
│  IIFE + 幂等守卫 → ModuleLoader.load(descriptor) → settings/plugins.* Slot 注册    │
│  页面：总览 / 账号渠道 / API 中转 / 降级链 / 网关 / 日志                            │
│  「一键签到」按钮：credits.claimAll(全部在用渠道) ∥ workbuddy/checkin(cn 账号)      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## 请求流转（一次聊天请求）

```
外部 Agent / DSH 聊天框
    │ POST /v1/chat/completions（或 /v1/messages、/v1/responses）
    ▼
startGateway（src/forward.js）
    ├─ authorized()      Key 匹配（Bearer/x-api-key/api-key/?key= 白名单式兼容）
    ├─ traceOf()         x-credit-hub-trace 响应头（客户端 x-request-id 优先）
    └─ harnessOptions()  线格式 → 宿主统一 chunk 形状
    ▼
hub.adapter.prepareCall('credit-hub', modelId)   （src/hub.js）
    ├─ catalog()         45s 缓存 + 并发单飞 + 重入闸门（防自激递归 OOM）
    ├─ resolveModel()    未知模型 fail-fast；reasoning efforts 消毒
    └─ 按来源分发：
        ├─ wb/*   → workbuddy.streamTurn（refresh 单飞，账号池轮转）
        ├─ up/*   → upstreams.streamTurn（openai-chat / anthropic-messages 双线；
        │           qianfan 预设先 AK:SK → IAM token，缓存到期自动续）
        ├─ pk/*   → packBridge.streamTurn（宿主 llm 进程内转发）
        └─ combo/*→ runCombo（降级链）
    ▼
runCombo（降级链核心）
    ├─ breaker.canTry()      冷却成员直接跳过（半开例外放行一次试探）
    ├─ runInto(candidate)    每候选独立 AbortController + 静默看门狗
    ├─ commitsAnswer()       首个「答案」块前失败 → advance 换下一跳（对调用方不可见）
    ├─ recordFailure/Success 连续 3 败 → 熔断（30s 起指数退避，封顶 10min）
    └─ recordTurn            traceId + TTFB + 总耗时 → usage.json + 日志
    ▼
流式帧（统一 chunk 形状）→ 网关按请求线格式重新编码 → SSE 给调用方
```

## 模块清单

| 文件 | 职责 | 备注 |
| --- | --- | --- |
| `index.js` | 装配 + 生命周期 + 定时任务 + usage 统计 | 宿主半身入口 |
| `client.js` | 浏览器半身（单文件 bundle，宿主只认单入口） | IIFE 幂等守卫 |
| `src/hub.js` | 统一目录 / 降级链 / 熔断接入 / 失败帧 | 核心 |
| `src/breaker.js` | 成员健康度：熔断/冷却/半开（内存态） | 批次五 |
| `src/forward.js` | 8330 网关 + 三线协议转换 + trace-id + 限流 | |
| `src/routes.js` | 网关路由表（声明式）；新增协议线只需加一行 | 优先级一 |
| `src/aggregate.js` | 自填上游 + 预设 + 千帆 token 续期 | |
| `src/workbuddy.js` | WorkBuddy 渠道运行时（协议对齐 workbuddy2api） | |
| `src/workbuddy-adapter.js` | WorkBuddy 独立 provider 车道 | |
| `src/pack-bridge.js` | pk/* 桥接宿主 llm | |
| `src/pack-mount.js` | channel-pack 挂载/卸载/状态 | |
| `src/normalize.js` | 上游 SSE → 统一 chunk | openai-chat / anthropic |
| `src/wire.js` | 宿主 chunk → 上游请求体 + WorkBuddy 出站修正 | |
| `src/http.js` | postJson/getJson/postSse + UpstreamError（category/retryable） | 统一错误模型 |
| `src/validate.js` | 管理面输入校验（400 + 逐字段原因） | |
| `src/rate-limit.js` | 令牌桶限流 + 鉴权失败计数器 | 优先级六 |
| `src/store.js` | JSON 持久化（原子写 + fsync + 迁移） | |
| `src/api.js` | 管理面 REST 路由 | |
| `src/util.js` | mintId / clamp / createRing | |

## 关键设计决策

- **为什么 client.js 不拆物理文件**：宿主 `dsh-client-modules` 只认每插件一个单文件 bundle（懒加载/combo/HMR/revision 全围绕单入口设计）。物理拆分需引入构建产物链路，待 TypeScript 迁移时一并做；当前用分区注释维护可读性。
- **降级链的 commit 语义**：候选在吐出第一个答案块之前失败，客户端完全无感（held 缓冲丢弃）；推理增量不算答案——"想了很久才撞墙"正是降级最值钱的场景。
- **熔断是内存态**：不落盘。重启复位是特性不是缺陷——避免把一次抖动永久写进配置。
- **catalog 重入闸门**：宿主 llm 注册表枚举可能经 packBridge 反向调 catalog（自激递归曾致 OOM exit 134）。in-flight 等待 2s 上限：正常并发等得到，真递归拿空清单，不死锁也不指数展开。
- **refresh 单飞**：WorkBuddy refreshToken 上游反重放（并发第二发整条链作废 12153），按账号严格串行化。

## 测试与 CI

```
node test/run.mjs        # 41+ 单元/集成/网关 e2e（进程级看门狗 10min + 显式退出）
node test/render-smoke.mjs  # UI 渲染冒烟
```

GitHub Actions：Node 22/24 × Ubuntu/Windows 四矩阵，语法检查 → Host tests → UI 冒烟 → package files 完整性 → npm audit（非阻断）。
