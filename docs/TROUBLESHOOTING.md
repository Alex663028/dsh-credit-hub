# 故障排查

按症状定位。先跑「一秒自查」，再按条目深入。

## 一秒自查

```powershell
# 1. 插件活着吗？（回环 + Origin 头必须带）
Invoke-RestMethod "$env:DSH_WEB_URL/api/credit-hub/summary" -Headers @{ Origin = $env:DSH_WEB_URL }

# 2. 网关通吗？
$key = (Get-Content "$env:USERPROFILE\.dsh\credit-hub\gateway\api-key" -Raw).Trim()
Invoke-RestMethod "http://127.0.0.1:8330/v1/models" -Headers @{ Authorization = "Bearer $key" }

# 3. 链路/成员健康度
(Invoke-RestMethod "$env:DSH_WEB_URL/api/credit-hub/summary" -Headers @{ Origin = $env:DSH_WEB_URL }).breaker
```

## 设置页看不到「积分汇通」

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| summary 接口 404/无响应 | 宿主半身没加载：link 断链或 bundle 未启用 | 检查 profile `package.json` 的 link 路径与 `dsh.profile.bundles`；跑 `install.ps1` |
| summary 正常但设置页没有 | 浏览器半身未注册 | **F5 刷新页面**；仍不行 → 托盘完全退出重启 DSH |
| 曾反复开关插件后消失 | client.js 幂等标志位残留在页面 | F5 即恢复（刷新重建 window） |

## 模型选择器里没有模型 / 模型变少

```powershell
# 看三来源各自的降级计数（>0 说明该来源本轮清单失败）
$s = Invoke-RestMethod "$env:DSH_WEB_URL/api/credit-hub/summary" -Headers @{ Origin = $env:DSH_WEB_URL }
"modelCount=$($s.modelCount) wb=$($s.workbuddy.ok) up=$($s.upstreams.models) pack=$($s.pack.status.mounted)"
```

- **wb=0**：WorkBuddy 登录过期 → 账号渠道页重新登录；refresh 反重放触发（12153）时等 10 分钟
- **up=0**：上游 Key 失效或千帆 AK:SK 格式错 → API 中转页检查；千帆填 `AK:SK`（冒号分隔）
- **pack 未挂载**：看 `pack.status.reason`——`ofm-installed` 表示装了 dsh-our-free-model 冲突，二选一

## 网关 401

- Key 没带或带错：`Authorization: Bearer <key>` 或 `x-api-key`；网关页核对 `keyFingerprint` 前 8 位
- Key 轮换过：旧 Key 立即失效，重新复制
- `?key=` 方式默认关闭（防 Key 泄漏进 URL/日志），确需旧客户端兼容在设置里开 `allowQueryKey`

## 模型请求失败 / 自动换模型

```powershell
# 熔断视图：哪些成员在冷却、失败原因是什么
(Invoke-RestMethod "$env:DSH_WEB_URL/api/credit-hub/summary" -Headers @{ Origin = $env:DSH_WEB_URL }).breaker
```

- 成员 `state=open`：连续 3 次失败进入冷却（30s 起，指数退避封顶 10min），链路自动跳过它；成功一次即复位
- `category=auth`：Key/登录态问题，**换跳也救不了**，去修凭据
- `category=rate-limit`：限流，冷却期过后自动恢复
- 日志页有 `[trc_xxx]` trace-id → 同一次请求的全部决策用同一 id 串联

## 千帆报「invalid_iam_token」

- 千帆 `/v2` 不接受裸 API Key，需要 IAM token
- 确认填的是 `AK:SK`（百度智能云 IAM 访问密钥，不是应用 API Key）
- 插件自动换 token 并在到期前续期；如果 AK/SK 权限不足（未开通千帆 ModelBuilder），去控制台开通

## One-click 签到部分渠道失败

- 结果 toast 里列出每个失败渠道与原因，全部是上游语义（限流/风控/今日已领过）
- 「今天已签到」计为成功，不会假红
- opencode 匿名车道无积分，自动跳过

## 数据位置与清理

```
{DSH_HOME}/credit-hub/
├─ settings.json        设置
├─ routes.json          降级链定义
├─ accounts.json        凭据（0600 + Windows ACL）— 手动备份这里
├─ usage.json           逐模型用量（进程重启不清零）
├─ gateway/api-key      网关 Key
├─ channel-pack/        渠道包账号状态
└─ logs.jsonl           运行日志（1MB 轮转，读出自动脱敏 body=）
```

## 与 dsh-our-free-model 共存

`accountPack: auto`（默认）时，插件检测到 ofm 已装会**自动跳过自身渠道包挂载**，避免双份注册与双重签到。用本插件的渠道能力请卸载 ofm 或把 `accountPack` 设为 `on`（强制挂载，自担重复注册风险）。
