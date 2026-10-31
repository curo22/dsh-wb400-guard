# dsh-wb400-guard

**中文** | [English](README.en.md)

[![CI](https://github.com/curo22/dsh-wb400-guard/actions/workflows/test.yml/badge.svg)](https://github.com/curo22/dsh-wb400-guard/actions/workflows/test.yml)
[![tests](https://img.shields.io/badge/tests-40%20passing-brightgreen)](test/shipped.test.mjs)
[![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](package.json)
[![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-green)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

一条命令修掉 DeepSeek Harness 走 **WorkBuddy 国内版反代**时每轮对话都失败的 400。

```
本轮运行失败 400: {"message":"workbuddy upstream client (http 400): 请求被拦截，请重新发送","type":"client","code":"client"}
```

标签 `INVALID_REQUEST`，底层是网关的 `code 11128`。走国际版（`www.workbuddy.ai`）不出现。

---

## 30 秒判断你需不需要它

| 现象 | 命中 |
|---|---|
| 报错文字是「请求被拦截，请重新发送」，标签 `INVALID_REQUEST` | 是 |
| 换成国际版模型就正常，换回国内版就失败 | 是 |
| 每次都在第一步就挂，连一句完整回复都没有 | 是 |
| 换个账号、换个模型、换台机器，症状一模一样 | 是 |
| 手动在 WorkBuddy 官方客户端里聊天是正常的 | 是 |
| 报的是 `429` 或「usage exceeds frequency limit」 | 否，那是额度 |
| 报的是 `11101` 或「Non-stream chat request」 | 否，那是非流式请求 |
| 报的是 `fetch failed` / 502 | 否，那是网络 |

上面前三条同时命中，基本可以确定就是本文档解决的那个问题。

## 为什么会被拦

国内网关 `copilot.tencent.com` 在服务端对 system 消息做通道校验，命中规则就回：

```json
{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}
```

插件包把这条错误包装成「请求被拦截，请重新发送」。**触发这条规则的来源有四个，互不相关**，DSH 默认全都带着，所以插件全都要处理。

前两个是本机实测定位出来的；后两个来自 [a1141171521/dsh-multi-agent-gateway#1](https://github.com/a1141171521/dsh-multi-agent-gateway/issues/1) 的真实失败——那台机器上四段同时在，只修前两段必挂。

### 触发源一：文件引用说明里的那一段字

`@deepseek-ai/dsh-file-reference` 会往 system prompt 里注入这段：

```
Tokens prefixed with @ are paths the user explicitly referenced. Relative paths
resolve from the workspace root; absolute paths identify files or directories on the
host. ... @\"...\" quotes a path containing spaces.
```

它不是「只要出现 @ 就拦」。逐词删词消融能直接看出来：这段话里删掉 `Tokens` `prefixed` `with` `are` `paths` `the` `user` `explicitly` `Relative` `resolve` `from` `workspace` 里的**任何一个词**，请求立刻变 200；删掉后半截的词（`referenced.` `root;` `absolute` `identify` `files` `or`）照样 400。

也就是说网关匹配的是**前段连续词组 + 那个 @ 字形**这个组合，不是单个字符。同一份文本把 @ 去掉，或换成等义的 `(at)`，都变 200。

### 触发源二：内核身份句

`@deepseek-ai/dsh-system-prompt` 的**官方发布版**默认 `includeHarnessIdentity = true`，会在 system 最前面放一句：

```
You are an AI agent powered by DeepSeek Harness.
```

（`DeepSeek` 和 `Harness` 之间是一个零宽空格 U+200B。）

这句只要**位于 system 消息开头**就会被拦。放到句子中间、放到消息尾部、前面先垫一行别的文字，都不拦。零宽字符、前置普通空格、前置 BOM 都绕不过去。

本机这个坑被 `~/.dsh/prompt-inject.md` 顶掉了，所以有些人只撞到触发源一；没写过注入文件的用户两个都会撞。这也是为什么另一个插件只修了身份句、用户升级后照样报错——两个源必须一起修。

### 触发源三：personaPrefix 里的 coding agent 句

`@deepseek-ai/dsh-web-app` 的 `cordis.patch.yml` 用 `personaPrefix` 往 system 里插一句：

```
You are a coding agent powered by the workbuddy/hy4-preview model.
```

模型名由内核插值，国内版是 `workbuddy/hy4-preview`，国际版是 `workbuddy-intl/deepseek-v4.1-flash`。
这句里没有任何品牌词，网关认的是 `coding agent powered by` 这个**句式**，所以换模型名救不了。

### 触发源四：Web GUI 段

`@deepseek-ai/dsh-harness-dev-context` 注册了两段，默认都在：

```
You are interacting with the user through the DeepSeek​ Harness Web GUI whose URL the runtime context names. ...
```

```
Current DeepSeek​ Harness Web GUI URL: "http://127.0.0.1:43120".
```

这两段在 system 的**尾部**（偏移 6552 左右），不在开头——所以只做「开头锚定」的修法完全够不到它们。

国际网关 `www.workbuddy.ai` 不做这个校验，同一份请求发过去是 200。

> **取证强度说明**：触发源一和二是本机真机 A/B 打出来的；触发源三和四在**本机**单独发送是 200（我这台机器的 system prompt 里这两段被 `dsh-purge` 清空过，所以复现不出对方的失败），把它们纳入改写表是基于对方 issue 的实测（同 system prompt 国内 400 / 国际 200，逐行 diff 只差模型名）加**防御性覆盖**。四段一起中性化不会让任何正常请求变坏——改动都是语义等价的，本机四段全拼的对照里改前 400、改后 200。

## 定位过程（可复现）

全部结论都是对真实网关做 A/B 打出来的，同账号同请求头，只换 body 里的 system 文本。

**触发源一**：

| 实验 | 结果 |
|---|---|
| 真实 system 原文（含 @） | 400 / 11128 |
| 同一份文本把 @ 去掉 | **200** |
| 同一份文本 @ 换成 `(at)` | **200** |
| 只去掉第一个 @（还剩一个） | **200** |
| 只去掉第二个 @（还剩一个） | 400 |
| 短句 `Tokens prefixed with @ are paths.` | **200**（单独发不触发） |
| 单词 @、`@ ` + 纯填充 | 200 |
| @ 放进 user 消息 | 200（只在 system 里触发） |
| 原文前缀截到 110 字符 | 200 |
| 原文前缀截到 112 字符（末尾正好是 `workspace root;`） | 400 |
| 同样 112 字符，把 @ 换成 `x` | 200 |
| 同样 112 字符，纯 `x` 填充 | 200 |
| 300 字符 = 弱内容 + 纯填充 | 200（不是长度阈值） |
| 逐词删词（前半段任一词） | **全部 200** |
| 逐词删词（后半段任一词） | 全部 400 |
| 换成全角 `＠` | 400（网关折回半角再判） |
| 同一 body 连发 5 次 | 5 次全 11128，完全确定性 |

**触发源二**：

| 实验 | 结果 |
|---|---|
| 身份句在 system 开头 | 400 / 11128 |
| 身份句放句子中间 | **200** |
| 身份句放消息尾部 | **200** |
| 身份句前面先垫一行别的文字 | **200** |
| 身份句前加普通空格 / BOM | 400（绕不过） |
| `DeepSeek` 与 `Harness` 之间加零宽字符 | 400（绕不过） |
| 改成分号 `DeepSeek-Harness.` | **200** |
| 改成分号 `DeepSeek.Harness.` | **200** |
| `You are the AI agent ...` | **200** |
| 换词序 `... that DeepSeek Harness powers.` | **200** |
| 换成 `WorkBuddy` | **200** |

**跟长度无关、跟请求头无关、跟工具数量无关**：`max_tokens` 从 1 扫到 1048576 全 200；94 个工具的完整请求头一字不改；纯填充到 60000 字符也不拦。

## 插件做什么

在宿主进程包一层 `globalThis.fetch`，只对发往 `copilot.tencent.com` 的请求，对 **system / developer / assistant 消息**做四件事：

| # | 改什么 | 改成什么 |
|---|---|---|
| 1 | 文件引用段里的 `@` | 等义写法 `(at)` |
| 2 | 开头的 `You are an AI agent powered by DeepSeek​ Harness.` | `You are an AI agent powered by DeepSeek-Harness.`（空格改连字符） |
| 3 | `You are a coding agent powered by ...` | `You are a coding agent running on ...`（模型名原样保留） |
| 4 | `... the DeepSeek​ Harness Web GUI ...` / `Current DeepSeek​ Harness Web GUI URL` | `... this Web GUI ...` / `Current Web GUI URL` |

最后兜底一步：把任何残留的 `DeepSeek` + 不可见分隔 + `Harness` 品牌指纹（含历史会话里冻结的旧段落）统一换成 `DeepSeek-Harness`。

全部是语义等价改写，模型读到的指令含义没变，网关匹配不到那些指纹。user 和 tool 消息一个字不动；别的 API（DeepSeek、OpenAI、Anthropic、WorkBuddy 国际版）一律原样透传。

### 为什么要连 assistant 一起扫

网关不止看 system。实测（同一账号、同一请求头，只换 body）：

| assistant 消息 | 结果 |
|---|---|
| 干净内容 | 200 |
| 身份句在开头 | **400** 11128 |
| 身份句在中段 / 尾部 | 200 |
| 文件引用段在开头 / 中段 / 尾部 | **400** 11128 |
| 文件引用段 @ 换成 `(at)` | **200** |
| 文件引用段前加 1 空格 / tab / 换行 / BOM | **400** 全部 |
| 普通 `@`、邮箱 `a@b.com`、`@someone` | 200 |
| 多轮对话里只有第 2 条 assistant 带指纹 | **400**（每条都查） |

结论：assistant 里文件引用段**任意位置**都触发（比 system 严），身份句仍然只在开头触发。user 和 tool 消息里放同样的内容都 200，所以刻意不动它们。

`mode=all` 只在 system 上兜底全换，不影响 assistant 的普通 @。

## 为什么挂在 fetch 层

试过另外两个位置，都不行：

- **`llm/stream` 事件**：`GenerateOptions` 到达时是深冻结的，`next()` 也不接参数，只能读不能改。
- **`system-prompt/assemble` 事件**：能改，但它会改掉所有 provider 的提示词，而问题只出在国内网关一家。

fetch 是唯一既精准、又能覆盖插件内部 11128 重试阶梯的位置。那套阶梯每次重试都会重新发请求，在 body 组装层改就会漏掉其中几级。

## 安装

零运行时依赖，只用 node 内置模块。需要 Node `^22.19.0 || >=24.0.0`。

### 用 DSH 自己的命令装（推荐）

```bash
dsh plugin --profile web add github:curo22/dsh-wb400-guard
```

把 `web` 换成你自己的 profile 名（桌面版是 `desktop`）。

### 或者 clone 下来跑

```powershell
git clone https://github.com/curo22/dsh-wb400-guard.git
cd dsh-wb400-guard
node install.mjs
```

它做四件事：拷文件到 `%USERPROFILE%\.dsh\profiles\desktop\vendor\dsh-wb400-guard`、往 profile 的 `package.json` 写 `dependencies` 与 `dsh.profile.bundles`、建 junction 让模块可解析、跑一遍产物的 40 条自测。

指定别的 profile：

```powershell
node install.mjs D:\path\to\other\profile
```

卸载：

```powershell
node install.mjs --uninstall
```

装完 **重启 DSH Desktop**（不是关窗口，是完全退出）。宿主日志里应该出现：

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
| `mode` | `"anchor"` | `anchor` 只改两处指纹那几句；`all` 把 system 里所有 `@` 全换掉（内核改了措辞时兜底） |
| `logPath` | `""` | 空则写 `~/.dsh/logs/dsh-wb400-guard.jsonl` |
| `dryRun` | `false` | 只记录不实际改写 |

## 安全边界

- **只改 system / developer / assistant**。user 与 tool 消息里的邮箱 `a@b.com`、`@某人`、代码里的装饰器一律不动。
- **只改受防护的 host**。别家 API 请求原样透传同一引用，不重新序列化。
- **非 JSON、非字符串、无 body 的请求**原样透传。
- **幂等**。第二次改写不再变动，返回入参原引用。
- **fail-open**。改写链路任何异常都退回原始请求，不阻断对话、不引入重试。
- **剔除陈旧的 `Content-Length`**。body 变短后若还带旧长度，上游会按旧长度截断。
- **不写入、不上报**。只读请求 body，改写后立刻发走，不落盘、不外传。

## 验证

```powershell
# 产物自测 40 条：契约、四处指纹改写、assistant 扫描、host 判定、幂等、fail-open、安装卸载、配置
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

另外几个更贴现场的脚本：

```powershell
# 触发源一/二各自单独发、叠加发，五组真实网关对照
node scripts/verify-identity-live.mjs
node scripts/verify-assistant-live.mjs

# 端到端：原版 dsh-workbuddy-connect 组装 → guard 改写 → 真实网关
node scripts/verify-pipeline.mjs

# 拿一份 154KB 的真实失败 body（94 个工具、15 条消息）重放
node scripts/verify-real-body.mjs

# 装完重启后跑这个：一条命令回答「修复此刻在不在工作」
node scripts/health-check.mjs

# 只读日志，看真实流量有没有被改写
node scripts/read-guard-log.mjs

# 仓库与已安装的 vendor 副本是否一致
node scripts/compare-vendor.mjs . "$env:USERPROFILE\.dsh\profiles\desktop\vendor\dsh-wb400-guard"
```

## 排障

装完还是不行，按这个顺序查：

**1. 插件有没有被加载。** 宿主日志（`%APPDATA%\DSH Desktop\logs\host\`）里搜 `dsh-wb400-guard`。没有 `fetch guard installed` 这一行，说明 profile 没读到它 —— 多半是没重启，或者 `dsh.profile.bundles` 没写进去。

**2. 插件本身有没有效。** 跑 `node verify-live.mjs`。它不依赖 DSH 的加载链路，直接拿真实凭证打真实网关。如果这一步的「经插件后」也不是 200，问题在插件或凭证，不在安装。

**3. 有没有别处手改抢先处理了。** 早期修法是直接改 `dsh-workbuddy-connect` 源码，那份改动会先于本插件把 `@` 换掉，`health-check.mjs` 的改写计数就会一直是 0，看着像没生效。它会扫 `node_modules/dsh-workbuddy-connect/lib/*.js` 里几个特征标识，扫到就明说。注意：磁盘上已经恢复原版、但进程还没重启时，内存里仍是旧代码，同样会抢先处理——这种情况重启一次就好。

**4. 改写有没有真的发生。** 跑 `node scripts/health-check.mjs`。它会同时读安装状态、宿主加载行、guard 日志的改写计数、宿主日志的拦截记录，然后给结论。看到「已就绪，但还没有国内路由的流量经过」，用国内版模型发一条消息再跑一次。

**5. 网关是不是改了规则。** 如果 `verify-live.mjs` 的「经插件前」那一行也变成 200 了，说明网关不再因为 `@` 拦截，插件处于空转，不影响使用。

## 常见问题

**会不会影响我别的模型？**
不会。只有 host 匹配 `copilot.tencent.com` 的请求才会被看。DeepSeek 官方 API、OpenAI、Anthropic、WorkBuddy 国际版都是原样透传同一个对象引用，连序列化都不会重做。

**会不会改坏我的对话内容？**
只动 system / developer / assistant 消息。user 和 tool 里写的邮箱、`@某人`、代码里的装饰器、正则，一个都不碰，`@"` 这种 here-string 开头也原样保留。改的只有两处指纹，语义不变。

**为什么不用改 `dsh-workbuddy-connect`？**
改那个包在插件升级时会被覆盖，得重打。本插件在 profile 层，插件包升级不影响它。

**升级插件后要重装吗？**
要。`install.mjs` 是拷贝到 `vendor`，不是链接。拉新代码后重跑一次，再用 `compare-vendor.mjs` 确认一致。

**国际版也装吗？**
默认不防护国际版。如果哪天 `www.workbuddy.ai` 也开始校验，往 `gatewayHosts` 加一条、`mode` 设成 `all` 即可。

**会被封号吗？**
只改自己发出去的消息里一个字符的写法，请求还是同一个端点、同一套凭证、同样的工具和对话。没有伪造身份、没有绕过额度、没有多开。

## 已知限制

- **网关改了规则**（不再因 `@` 拦截）时插件空转，不影响功能。`verify-live.mjs` 会告诉你原样请求已经能过。
- **DSH 内核改了 `FILE_REFERENCE_PROMPT` 措辞**时，`anchor` 模式仍有 `Tokens prefixed with @` 这个锚点兜底；锚点也变了就把 `mode` 设成 `all`。
- **触发源三、四没有在本机独立复现成功**（本机这两段被 dsh-purge 清空过）。纳入改写表是依据他人机器的实测加防御性覆盖。如果你的机器四段全在、改了还是 400，把 mode 设成 ll，开 dryRun 抓一份原始 body 提 issue——那说明网关又加了新指纹。
- **429 限流与本插件无关**。那是额度用尽，等额度重置。
- **`stream: false` 会被国内网关拒为 `11101`**，这个码跟 `11128` 不是一回事。本插件只解决 `11128`。
- **两个插件同时包装 `fetch` 时**后装的在外层。本插件用 `Symbol.for('dsh-wb400-guard.installed')` 保证只装一层，重复调用返回同一个卸载函数，卸载时也不会覆盖别人后来装的 `fetch`。
- **磁盘文件与运行中进程是两回事**。把磁盘文件改回原版，不会让进程里的改动消失，它要等下次启动才失效。装了插件不重启，同理。

## 开发

```powershell
# 跑测试（Node 24 上 `node --test test/` 不认目录参数，直接不带参数让它自动发现）
node --test

# 把自己的 profile 指向本仓库，改代码即时生效（不需要每次拷贝）
.\scripts\link-local.ps1
.\scripts\link-local.ps1 -Remove   # 拆掉
```

两个脚本的分工：`install.mjs` 拷贝到 `profile\vendor`，适合分发；`link-local.ps1` 用 junction 指向本仓库，适合开发。

`install.mjs` 是拷贝而不是链接，所以拉了新代码之后要重跑一次，vendor 才会跟上。想知道有没有落后：

```powershell
node scripts/compare-vendor.mjs . "$env:USERPROFILE\.dsh\profiles\desktop\vendor\dsh-wb400-guard"
```

逐文件哈希比对，列出内容不同和缺失的文件。全一致时只有一句「vendor 与仓库完全一致」。

推送到 GitHub：

```powershell
.\scripts\push-github.ps1
```

会依次检查工作区干净、SSH 认证、远端仓库存在，再推。哪一步不通就停在哪一步并说清原因。

> Windows 上 git 自带的 ssh 在中文用户名下会把 HOME 解析成 GBK 乱码路径，导致 `Host key verification failed`。
> 用系统 OpenSSH：`git config core.sshCommand 'C:/Windows/System32/OpenSSH/ssh.exe'`。

## 相关

- [推广文案包 PROMO.md](PROMO.md) —— 一句话简介、各平台发布帖、标签建议，随手转发用
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 本插件服务的宿主

## 许可

MIT
