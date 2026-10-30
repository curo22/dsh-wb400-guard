# 推广文案包

复制粘贴就能发。所有链接指向 <https://github.com/curo22/dsh-wb400-guard>。

英文版：[PROMO.en.md](PROMO.en.md)

---

## 一句话（标题 / 副标题 / 一句话介绍）

**标题备选**

- `dsh-wb400-guard` —— 让 DSH 的 WorkBuddy 国内版反代不再每轮 400
- 一条命令，修掉 "请求被拦截，请重新发送"
- 给 DeepSeek Harness 的 WorkBuddy 国内版补丁：零依赖，17 个测试

**副标题**

> 国内网关对 system 消息里的 `@` 做通道校验，看到就回 `11128`。这个插件只改 system 里的那一个字符，其他一律不碰。

**一句话介绍（各平台 bio、issue 引用、推荐语都用得上）**

> DSH 走 WorkBuddy 国内版反代时每轮都报 `400 请求被拦截`，根因是 system prompt 里有一个 `@`。这个插件在 fetch 层把它换成 `(at)`，零依赖、fail-open、17 个测试。

---

## 短帖（微博 / X / 朋友圈 / 群消息）

**版本 A（痛点开场，转发率最高）**

> 如果你的 DeepSeek Harness 接了 WorkBuddy 国内版反代，每轮都在第一步就挂：
>
> `400 workbuddy upstream client: 请求被拦截，请重新发送`
>
> 换账号、换模型、换机器都没用，因为问题不在你身上 —— 国内网关会扫 system 消息里的 `@`，看到就判成非授权渠道，回 `code 11128`。
>
> 修好了，一个插件，一条命令：
>
> ```
> git clone https://github.com/curo22/dsh-wb400-guard
> cd dsh-wb400-guard && node install.mjs
> ```
>
> 重启，结束。零依赖，17 个测试，改坏了自动退回原请求。
> 👉 https://github.com/curo22/dsh-wb400-guard

**版本 B（技术钩子开场）**

> 排查了一天的 400，根因离谱到你猜不到。
>
> 请求被拦不是因为体积、不是因为工具太多、不是因为请求头 —— 是因为 system prompt 里有一个 `@` 字符。
>
> 实验：原文截到 25860 字符 → 200；截到 25865 → 400。差 5 个字符，内容里正好跨过一个 `@`。
> 全角 `＠` 也不行，网关会折回半角再判。
>
> 国内网关 `copilot.tencent.com` 对 system 消息做通道校验，看到 `@` 就回 `11128 Illegal API invocation from an unapproved channel`。国际版网关不查。
>
> 现成的修复，fetch 层替换，零依赖：
> https://github.com/curo22/dsh-wb400-guard

**版本 C（极短，适合群里丢一句）**

> DSH 接 WorkBuddy 国内版报「请求被拦截」的，装这个就行，一条命令，重启生效 👉 https://github.com/curo22/dsh-wb400-guard

---

## 长帖（知乎 / 掘金 / V2EX / 博客 / 公众号）

### 标题

- 我用 5 个字符定位了一个 400：WorkBuddy 国内网关的 `@` 校验
- 请求被拦截：一次从 25860 到 25865 的二分排查
- 给 DSH 写了个零依赖插件，修掉 WorkBuddy 国内版每轮 400

### 正文

**症状**

DeepSeek Harness 走 WorkBuddy 国内版反代，每轮对话第一步就失败：

```
本轮运行失败 400: {"message":"workbuddy upstream client (http 400): 请求被拦截，请重新发送","type":"client","code":"client"}
```

标签 `INVALID_REQUEST`。切到国际版模型（`deepseek-v4.1-flash-sg`，走 `www.workbuddy.ai`）立刻正常，切回国内版立刻挂。

**先排除的**

换账号、换模型、补请求头、改 `reasoning_effort`、调 `max_tokens`、减工具数量、换网络、关并发 —— 全部无效。网上能搜到的方案都试过了。

有一条线索值得记下来：国际版网关和国内网关的路径不一样。**国际版根本不做这个校验**，所以同一份请求发过去就是 200。这排除了"请求本身不合规"的可能。

**二分**

拿一份真实的失败 body（154 KB，94 个工具，15 条消息），逐条消息重放：每条单独发都失败，把 system 换成一句无关的 `You are helpful.` 就通过。问题在 system。

接着对 system 做 prefix 截断：

| 长度 | 结果 |
|---|---|
| 25,850 | 200 |
| 25,860 | 200 |
| 25,865 | 400 / 11128 |
| 25,870 | 400 / 11128 |

**5 个字符，从过到拦。**

于是"长度阈值"假设成立了一半 —— 直到我做了三个反证实验：

- 纯 `a` 填充到 60,000 字符 → 200
- 纯中文填充到 30,000 字符 → 200
- 把触发的那一块重复 400 次 → 200

这三组都远超阈值却全部通过。**不是长度，是内容。**

**码点级比对**

把 25855–25874 这 20 个字符的码点全打出来：

```
c e ␠ r o o t ; ␠ a b s o l u t e ␠ p a
```

普通的 ASCII，看不出问题。但最小触发块是另一段 —— 117 个字符，起于 `Tokens prefixed with @`。

把那个 `@` 换成 `(at)`：

**200。**

换成全角 `＠`？**400** —— 网关把全角折回半角再判，所以"视觉上换掉"没用，必须真的去掉这个字形。

再验证一件事：把 `@` 放进 user 消息里（`test@example.com`、`@someone`）→ **200**。只在 system 里触发。

最小触发块单独发（不掺别的内容）→ 仍然 400。同一份 body 连发 5 次 → 5 次全 11128，完全确定性。同一份 body 连发 5 次（截到 25860 那版）→ 5 次全 200。

**根因**

DSH 内核包 `@deepseek-ai/dsh-file-reference` 往 system prompt 里注入一段文件引用说明，原文带两处 `@`：

```
Tokens prefixed with @ are paths the user explicitly referenced. ...
@"..." quotes a path containing spaces.
```

国内网关 `copilot.tencent.com` 对 system 消息做通道校验，看到 `@` 就认为不是授权渠道，返回：

```json
{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}
```

插件把这句包装成了"请求被拦截，请重新发送"。

**修复放在哪一层**

试过两个更"正统"的位置，都不行：

`llm/stream` 事件 —— `GenerateOptions` 到达监听器时是**深冻结**的，改一下就抛异常，`next()` 也不接收参数。设计上就是只读。

`system-prompt/assemble` 事件 —— 能改，但它对所有 provider 生效。为了一个网关的问题去改所有人的提示词，不合适。

最后选 `globalThis.fetch`：只对发往 `copilot.tencent.com` 的请求动手，而且能覆盖插件内部那套 11128 重试阶梯 —— 那套阶梯每次重试都会重新发请求，在 body 组装层改就会漏掉几级。

**插件做的事**

在 system / developer 消息里把 `@` 换成 `(at)`。语义不变（这句话本来就是描述"以 @ 开头的 token 是路径"），模型读到的指令一样，网关看到的不再有那个字符。

六条安全边界：只改 system/developer、只改受防护 host、非 JSON 原样透传、幂等、fail-open、剔除陈旧的 `Content-Length`。

**验证**

- 17 个产物自测，直接 import 装到 disk 上的那份文件（不是 src），保证"测过的=装上去的"
- 真实网关对打：原样 400 BLOCKED(11128) / 经插件 200 PASS
- 154 KB 真实失败 body 重放：原样 400 / 经插件 200
- 全新 clone + 装到干净 profile + 卸载，三条都跑过

**装**

```powershell
git clone https://github.com/curo22/dsh-wb400-guard
cd dsh-wb400-guard
node install.mjs
```

零运行时依赖，只用 node 内置模块。有 `install.mjs` 会自己备份 `package.json`、回读校验有没有 BOM、确认中文路径依赖没被写坏。

**一个坑值得单独说**

别用 `ConvertTo-Json | Set-Content` 改 profile 的 `package.json`。中文用户名下 PowerShell 这套组合会把 UTF-8 字节按 GBK 解一次再编码：

```
link:C:/Users/罗雨/新目录/...  →  link:C:/Users/缃楅洦/鏂扮洰褰?/...
```

同时加上 BOM，DSH 的配置热重载直接报 `SyntaxError: Unexpected token 'ï¿¿'`，profile 加载失败。我踩了这个坑，所以 `install.mjs` 用 Node 的 `fs` 读写，写完回读校验。

**仓库**

https://github.com/curo22/dsh-wb400-guard

MIT，欢迎提 issue 补充别的网关的类似情况。

---

## GitHub 仓库设置建议

**About / Description**

> Fix WorkBuddy China gateway 400 / code 11128 in DeepSeek Harness by rewriting @ in system messages at the fetch layer. One command, zero dependencies.

**Topics（标签）**

```
deepseek-harness
dsh
dsh-plugin
workbuddy
codebuddy
gateway
http-400
11128
proxy
fetch-interceptor
nodejs
mit-license
```

**Social preview 建议拍的内容**：左侧贴错误原文（`请求被拦截，请重新发送`），右侧贴 `200 PASS`，中间一个箭头写 `@ → (at)`。

---

## Issue 模板可用开场

有人来报同样的问题，可以直接回：

> 症状对得上，是 WorkBuddy 国内网关对 system 消息里 `@` 的通道校验（网关码 11128）。装 https://github.com/curo22/dsh-wb400-guard 就行：
>
> ```
> git clone https://github.com/curo22/dsh-wb400-guard && cd dsh-wb400-guard && node install.mjs
> ```
>
> 装完完全退出 DSH Desktop 再打开。想确认生效，跑 `node scripts/health-check.mjs`，它会同时读安装状态、宿主加载行、改写计数和拦截记录，然后告诉你现在属于哪种情况。
>
> 如果 `node verify-live.mjs` 的「经插件前」那行也是 200，说明网关改了规则，插件空转，不影响使用。

---

## 传播要点（写给想帮忙转的人）

这个问题的传播性在于三点，讲的时候抓住就行：

1. **它会伪装成"你的配置错了"。** 换账号没用、换模型没用、重装没用，人会一直怀疑自己。说清"不是你的问题"比说清技术细节更有用。
2. **根因小到反直觉。** 一个 `@` 字符。截到 25860 通过、25865 被拦，这种具体数字比"网关有校验"可信得多。
3. **修法不侵入。** 不碰内核、不碰第三方包、不伪造身份、不绕额度。只改自己发出去的消息里一个字符的写法。这一点要说，因为很多人第一反应是"这会不会被封"。

---

## 免责与边界（发帖时可带上，减少误读）

- 只解决 `11128`。`429`（额度）、`11101`（非流式）、`502 / fetch failed`（网络）不是它管的事。
- 不绕过任何额度或权限。请求还是同一个端点、同一套凭证、同样的工具和对话。
- 网关哪天不查 `@` 了，插件自动空转，不会干扰。
- MIT，没有遥测，不上报任何数据。
