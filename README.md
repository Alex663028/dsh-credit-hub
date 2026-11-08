# dsh-credit-hub · 积分汇通

DeepSeek Harness（DSH）插件：把各家 coding agent 的**账号积分渠道**与**自填的官方 API / 中转**，
汇成一条统一模型车道（`积分汇通`）和一个本地 **OpenAI + Anthropic 兼容网关**。

```
DSH 设置 → 积分汇通
├─ 总览      汇通模型清单 / 各来源状态 / 开关
├─ WorkBuddy 腾讯 CodeBuddy·WorkBuddy 原生渠道：设备流登录 / Token 导入 / 账号池 / 积分 / 签到
├─ API 中转  预设 + 自定义上游（OpenAI 兼容 / Anthropic 兼容），填 Key 即接入
├─ 降级链    把汇通目录里的模型串成链（fallback / round-robin），提交前失败自动换下一跳
├─ 网关      127.0.0.1:8330（可改端口），/v1/chat/completions + /v1/messages + /v1/models
└─ 日志      逐条运行日志
```

## 渠道来源

| 来源 | 实现方式 | 说明 |
| --- | --- | --- |
| WorkBuddy / CodeBuddy（腾讯） | 本插件**原生移植**，协议对齐开源 [workbuddy2api](https://github.com/linguo2625469/workbuddy2api-panel)（MIT） | 设备授权流登录、OpenAI 直通 + 出站修正、refresh 单飞（refreshToken 反重放）、错误分类（积分耗尽/限流/风控码）、积分余额与签到。**仅个人自用** |
| Raccoon 商汤小浣熊 / Qoder / Qoder CN / ZCode / MiniMax / TRAE / Cline / Loomy / LobsterAI / Gemini | vendored `channel-pack`（MIT，上游 Jet/iJetLi，见 `vendor/channel-pack/NOTICE.md`） | 登录、账号池、积分领取。渠道模型由 **pack 桥接**（`pk/<provider>/<model>`）并入积分汇通目录，8330 网关与降级链均可直接使用；`accountPack: auto` 时若检测到已装 dsh-our-free-model 则自动跳过（其自带同源渠道包），避免双份注册与双重签到 |
| 官方 API / 任意中转 | 本插件原生（openai-chat / anthropic-messages 双线格式） | 内置预设：DeepSeek、Z.ai、Kimi、MiniMax、SiliconFlow、OpenRouter、百炼、阶跃、Anthropic、SenseNova；也支持任意 OpenAI 兼容中转站 |

## 网关接入

```
# OpenAI 兼容
base_url = http://127.0.0.1:8330/v1     api_key = 网关页显示的 Key
POST /v1/chat/completions · GET /v1/models

# Anthropic 兼容（Claude Code / Codex 等）
ANTHROPIC_BASE_URL = http://127.0.0.1:8330
POST /v1/messages
```

仅绑定回环地址；Key 落 `{DSH_HOME}/credit-hub/gateway/api-key`（0600）。

模型 id 前缀：`wb/`（WorkBuddy 原生）、`up/`（自填上游）、`pk/`（渠道包桥接）、`combo/`（降级链）。

## 数据与凭据

- 数据目录：`{DSH_HOME}/credit-hub/`（settings.json / routes.json / accounts.json / gateway/ / channel-pack/）
- WorkBuddy token 与上游 API Key 只写 `accounts.json`（0600 目录 + 0600 原子写），管理接口只回 `hasKey` 与指纹
- channel-pack 状态隔离在 `{DSH_HOME}/credit-hub/channel-pack/`
- **平台差异**：0600/0700 权限位只在 POSIX 生效；Windows 下 Node 的 mode 仅影响只读位，
  凭据文件实际以用户 profile 目录的 ACL 保护。如需系统级凭据托管，后续可接入宿主
  `dsh-credentials` 服务（已在 peerDependencies 声明）

## 安装

```powershell
git clone https://github.com/Alex663028/dsh-credit-hub.git
```

在 `{DSH_HOME}/profiles/desktop/package.json`（桌面端）的 `dependencies` 加：

```json
"dsh-credit-hub": "link:<克隆路径>/dsh-credit-hub"
```

并把 `"dsh-credit-hub"` 加入 `dsh.profile.bundles`，然后重启 DSH。设置 → 积分汇通。

## 使用声明（必读）

- 本插件仅供**管理自己的账号**：自动签到、保活、给本地工具提供统一入口。不支持、不授权任何
  批量小号、额度转卖、卡密分发——那些行为违反平台服务条款，风险自担。
- 各渠道均为非官方客户端接入，平台随时可能收紧识别（WorkBuddy 上游 2026-10 已开始；
  workbuddy2api 项目因此停更）。由此导致的账号风控/封禁由使用者自行承担。
- refresh 单飞是硬约束：WorkBuddy 的 refreshToken 上游反重放，并发第二发会整条链作废（12153），
  本插件已按账号串行化，请勿同时跑多份指向同一账号的网关。

## 许可

MIT。`vendor/channel-pack/` 为 MIT 再分发（见其 NOTICE.md 与 LICENSE）。
