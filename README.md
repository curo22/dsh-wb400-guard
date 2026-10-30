# dsh-wb400-guard

修掉 DeepSeek Harness 走 **WorkBuddy 国内版反代**时每轮对话都失败的 400。

症状：

```
本轮运行失败 400: {"message":"workbuddy upstream client (http 400): 请求被拦截，请重新发送","type":"client","code":"client"}
```

标签 `INVALID_REQUEST`，底层是网关的 `code 11128`。走国际版（`www.workbuddy.ai`）不出现。

## 为什么会被拦

DSH 内核 `@deepseek-ai/dsh-file-reference` 会往 system prompt 里注入一段文件引用说明：

```
Tokens prefixed with @ are paths the user explicitly referenced. ...
@"..." quotes a path containing spaces.
```

国内网关 `copilot.tencent.com` 对 system 消息做通道校验，看到字面量 `@` 就判成非授权渠道调用：

```json
{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}
```

插件包把这条错误包装成上面那句「请求被拦截」。

### 定位过程（可复现）

判定依据是内容和字符位置，不是长度：

| 实验 | 结果 |
|---|---|
| 原文截到 25860 字符 | 200 |
| 原文截到 25865 字符 | 400 / 11128 |
| 纯 `a` 填充到 60000 字符 | 200 |
| 纯中文填充到 30000 字符 | 200 |
| 把触发块重复 100 / 400 次 | 200 |
| `@` → `(at)` | **200** |
| 全角 `＠` 替换 | 400（网关折回半角再判） |
| `@` 放进 user 消息 | 200（只在 system 里触发） |
| 同一 body 连发 5 次 | 5 次全 11128，完全确定性 |

最小触发块是原文里 `Tokens prefixed with @` 那一段，117 字符。单独发也拦。

## 插件做什么

在宿主进程包一层 `globalThis.fetch`，只对发往 `copilot.tencent.com` 的请求，把 **system / developer 消息里**的 `@` 换成等义写法 `(at)`。user、assistant、tool 消息一个字不动，别的 API（DeepSeek、OpenAI、Anthropic、WorkBuddy 国际版）一律原样透传。

`(at)` 在这句话里语义等价（描述「以 @ 开头的 token 是路径」），读起来仍然通顺：

```
Tokens prefixed with (at) are paths the user explicitly referenced. ...
(at)"..." quotes a path containing spaces.
```

### 为什么挂在 fetch 层

试过另外两个位置，都不行：

- **`llm/stream` 事件**：`GenerateOptions` 到达时是深冻结的，`next()` 也不接参数，只能读不能改。
- **`system-prompt/assemble` 事件**：能改，但它会改掉所有 provider 的提示词，而问题只出在国内网关一家。

fetch 是唯一既精准、又能覆盖插件内部 11128 重试阶梯的位置 —— 那套阶梯每次重试都会重新发请求，在 body 组装层改就会漏掉其中几级。

## 安装

零运行时依赖，只用 node 内置模块。需要 Node `^22.19.0 || >=24.0.0`。

### 一条命令

把本仓库拷到任意位置，然后：

```powershell
node install.mjs
```

它做四件事：拷文件到 `%USERPROFILE%\.dsh\profiles\desktop\vendor\dsh-wb400-guard`、往 profile 的 `package.json` 写 `dependencies` 与 `dsh.profile.bundles`、建 junction 让模块可解析、跑一遍产物的 17 条自测。

指定别的 profile：

```powershell
node install.mjs D:\path\to\other\profile
```

卸载：

```powershell
node install.mjs --uninstall
```

装完 **重启 DSH Desktop**。宿主日志里应该出现：

```
[I] [dsh-wb400-guard] [dsh-wb400-guard] fetch guard installed for copilot.tencent.com
```

### 手动装

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item -Recurse -Force .\* "$prof\vendor\dsh-wb400-guard\"
New-Item -ItemType Junction -Path "$prof\node_modules\dsh-wb400-guard" -Target "$prof\vendor\dsh-wb400-guard"
```

然后手改 `$prof\package.json`：`dependencies` 加 `"dsh-wb400-guard": "file:./vendor/dsh-wb400-guard"`，`dsh.profile.bundles` 数组末加 `"dsh-wb400-guard"`。

> **别用 `ConvertTo-Json | Set-Content` 改 profile 的 `package.json`。**
> PowerShell 这套组合在中文用户名下会把 UTF-8 字节按 GBK 解一次再编码，
> `link:C:/Users/罗雨/新目录/...` 会变成 `link:C:/Users/缃楅洦/鏂扮洰褰?/...`，同时给文件加 BOM。
> DSH 的配置热重载会直接报 `SyntaxError: Unexpected token 'ï»¿'`，profile 加载失败。
> `install.mjs` 用 Node 的 `fs` 读写，写完回读校验 BOM 和中文依赖值没被破坏。

## 配置

`cordis.patch.yml` 里可调：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉就完全不碰 fetch |
| `gatewayHosts` | `["copilot.tencent.com"]` | 要防护的 host；以 `.` 开头做后缀匹配。国际网关默认不在列表 |
| `mode` | `"anchor"` | `anchor` 只改文件引用说明那几句；`all` 把 system 里所有 `@` 全换掉（内核改了措辞时兜底） |
| `logPath` | `""` | 空则写 `~/.dsh/logs/dsh-wb400-guard.jsonl` |
| `dryRun` | `false` | 只记录不实际改写 |

## 安全边界

- **只改 system / developer**。user 消息里的邮箱 `a@b.com`、`@某人` 一律不动。
- **只改受防护的 host**。别家 API 请求原样透传同一引用，不重新序列化。
- **非 JSON、非字符串、无 body 的请求**原样透传。
- **幂等**。第二次改写不再变动，返回入参原引用。
- **fail-open**。改写链路任何异常都退回原始请求，不阻断对话、不引入重试。
- **剔除陈旧的 `Content-Length`**。body 变短后若还带旧长度，上游会按旧长度截断。
- **不写入、不上报**。只读请求 body，改写后立刻发走，不落盘、不外传。

## 验证

```powershell
# 产物自测 17 条：契约、改写、host 判定、幂等、fail-open、安装卸载、配置
node --test

# 对真实国内网关验证（需要本机已登录 WorkBuddy 桌面版）
$env:WORKBUDDY_ELECTRON_BIN = '<WorkBuddy 的 Electron 可执行文件>'
node verify-live.mjs
```

`verify-live.mjs` 拿真实凭证打真实网关，预期：

```
经插件前（预期被拦）      400 BLOCKED(11128)   OK
经插件后（预期通过）      200 PASS             OK
```

另外三个更贴现场的脚本：

```powershell
# 端到端：原版 dsh-workbuddy-connect 组装 → guard 改写 → 真实网关
node scripts/verify-pipeline.mjs

# 拿一份 154KB 的真实失败 body（94 个工具、15 条消息）重放
node scripts/verify-real-body.mjs

# 只读日志，看真实流量有没有被改写
node scripts/read-guard-log.mjs
```

## 不用手改 `dsh-workbuddy-connect`

本插件在 fetch 层独立完成改写，不依赖插件包里的任何内容：

```
dsh-workbuddy-connect 原版 → 组装 body（@ 原样保留）→ globalThis.fetch → dsh-wb400-guard 改写 → 国内网关
```

如果你之前直接改过 `node_modules/dsh-workbuddy-connect/lib/host-heartbeat-*.js`，可以把那份改动还原成原版 —— 修复在 DSH 的 profile 层，插件包升级不会覆盖它。

## 已知限制

- **网关改了规则**（不再因 `@` 拦截）时插件空转，不影响功能。`verify-live.mjs` 会告诉你原样请求已经能过。
- **DSH 内核改了 `FILE_REFERENCE_PROMPT` 措辞**时，`anchor` 模式仍有 `Tokens prefixed with @` 这个锚点兜底；锚点也变了就把 `mode` 设成 `all`。
- **429 限流与本插件无关**。那是额度用尽，等额度重置。
- **`stream: false` 会被国内网关拒为 `11101`**，这个码跟 `11128` 不是一回事。本插件只解决 `11128`。
- **国际网关**默认不防护。如果哪天 `www.workbuddy.ai` 也开始校验 `@`，往 `gatewayHosts` 里加一条即可（`mode` 建议设为 `all`）。

## 开发

```powershell
# 跑测试（Node 24 上 `node --test test/` 不认目录参数，直接不带参数让它自动发现）
node --test

# 把自己的 profile 指向本仓库，改代码即时生效（不需要每次拷贝）
.\scripts\link-local.ps1
.\scripts\link-local.ps1 -Remove   # 拆掉
```

两个脚本的分工：`install.mjs` 拷贝到 `profile\vendor`，适合分发；`link-local.ps1` 用 junction 指向本仓库，适合开发。

推送到 GitHub：

```powershell
.\scripts\push-github.ps1
```

会依次检查工作区干净、SSH 认证、远端仓库存在，再推。哪一步不通就停在哪一步并说清原因。

## 许可

MIT
