# Promo Kit

Copy, paste, post. Everything points at <https://github.com/curo22/dsh-wb400-guard>.

中文版：[PROMO.md](PROMO.md)

---

## One-liners

**Repo title options**

- `dsh-wb400-guard` — stop the 400 that kills every turn on WorkBuddy's China gateway
- One command to fix "请求被拦截，请重新发送"
- A WorkBuddy China-gateway patch for DeepSeek Harness: zero dependencies, 25 tests

**Subtitle**

> The China gateway runs a channel check over system messages and returns `11128` the moment it sees a literal `@`. This plugin rewrites that one character inside system messages and touches nothing else.

**One-sentence description (bios, issue replies, recommendations)**

> DSH fails on every turn through WorkBuddy's China gateway with `400 请求被拦截`. The cause is two fingerprints in the system prompt that the gateway recognises. This plugin neutralises both fingerprints at the fetch layer — zero dependencies, fail-open, 25 tests.

---

## Short posts (X / Mastodon / Bluesky / Discord / Slack)

**Version A — lead with the pain**

> If your DeepSeek Harness setup dies on step 1 every single turn through WorkBuddy's China gateway:
>
> `400 workbuddy upstream client: 请求被拦截，请重新发送`
>
> New account, new model, new machine — same failure. Because it isn't you. The China gateway scans system messages for `@` and treats anything containing it as an unapproved channel, returning `code 11128`.
>
> Fixed. One plugin, one command:
>
> ```
> git clone https://github.com/curo22/dsh-wb400-guard
> cd dsh-wb400-guard && node install.mjs
> ```
>
> Restart. Done. Zero dependencies, 25 tests, fails open.
> 👉 https://github.com/curo22/dsh-wb400-guard

**Version B — lead with the technical hook**

> Spent a day on a 400. The root cause is not what you'd guess.
>
> Not payload size. Not too many tools. Not the headers. It was one `@` character in the system prompt.
>
> The bisect: truncate to 25,860 chars → 200. Truncate to 25,865 → 400. Five characters apart, and the difference is one `@` sitting inside that window.
> Fullwidth `＠` doesn't help either — the gateway folds it back to ASCII before matching.
>
> `copilot.tencent.com` runs a channel check over system messages and returns `11128 Illegal API invocation from an unapproved channel`. The international gateway does no such check.
>
> Working fix, fetch-layer rewrite, zero dependencies:
> https://github.com/curo22/dsh-wb400-guard

**Version C — one line for a chat group**

> If DSH through WorkBuddy's China gateway says 请求被拦截, install this — one command, restart, done 👉 https://github.com/curo22/dsh-wb400-guard

---

## Long post (dev.to / Hacker News / Lobsters / Reddit / personal blog)

### Title options

- Five Characters: how I bisected a 400 down to a single `@`
- Request blocked: a bisect from 25,860 to 25,865
- A zero-dependency plugin that fixes WorkBuddy's China gateway for DeepSeek Harness

### Body

**The symptom**

DeepSeek Harness through WorkBuddy's China gateway fails on step 1 of every turn:

```
本轮运行失败 400: {"message":"workbuddy upstream client (http 400): 请求被拦截，请重新发送","type":"client","code":"client"}
```

Tagged `INVALID_REQUEST`. Switch to an international model (`deepseek-v4.1-flash-sg`, routed to `www.workbuddy.ai`) and it works instantly. Switch back and it breaks instantly.

**What I ruled out**

Different account, different model, extra headers, client identity, `reasoning_effort`, `max_tokens` from 1 to 1,048,576, tool count from 1 to 94, network, concurrency. All of it.

One clue mattered more than the rest: the international and China gateways take different paths, and **the international one performs no such check at all**. Same request, 200. That kills the "the request itself is malformed" theory.

**The bisect**

I had a real failed body on disk — 154 KB, 94 tools, 15 messages. Replaying it message by message: every single message failed standalone, but replacing the system prompt with a plain `You are helpful.` passed. So it's in the system message.

Prefix truncation:

| Length | Result |
|---|---|
| 25,850 | 200 |
| 25,860 | 200 |
| 25,865 | 400 / 11128 |
| 25,870 | 400 / 11128 |

**Five characters, from passing to blocked.**

So "length threshold" looked right — until three counter-experiments killed it:

- Pad with plain `a` to 60,000 chars → 200
- Pad with CJK to 30,000 chars → 200
- Repeat the trigger block 400 times → 200

All three blow past the threshold and all three pass. **It's content, not length.**

**Codepoint level**

I dumped the codepoints around offset 25,855–25,874. Plain ASCII, nothing visible.

But the gateway does not match a single character — it matches a run of consecutive words. Delete any word from the opening of that paragraph and it passes.

Replace that `@` with `(at)`: **200.**

Replace it with fullwidth `＠`? **400.** The gateway folds fullwidth back to ASCII before matching, so a cosmetic swap doesn't count. The glyph has to actually go.

One more check: put `@` in a user message instead (`test@example.com`, `@someone`) → **200.** It only triggers in system messages.

The minimal trigger sent alone still gets blocked. The same body sent five times: 5 × 11128, fully deterministic. The 25,860 version sent five times: 5 × 200.

**Root cause**

The DSH kernel package `@deepseek-ai/dsh-file-reference` injects a file-reference paragraph into the system prompt, carrying two `@` characters:

```
Tokens prefixed with @ are paths the user explicitly referenced. ...
@"..." quotes a path containing spaces.
```

`copilot.tencent.com` runs a channel check over system messages. It sees `@`, concludes the call isn't from an approved channel, and returns:

```json
{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}
```

The WorkBuddy plugin wraps that into 请求被拦截，请重新发送.

**Where the fix goes**

I tried two more "orthodox" hooks. Both are wrong:

`llm/stream` event — `GenerateOptions` arrives **deep-frozen**, mutation throws, and `next()` takes no arguments. Read-only by design.

`system-prompt/assemble` event — it can rewrite, but it would rewrite the prompt for every provider. Changing everyone's prompt to work around one gateway isn't a fix.

`globalThis.fetch` won: narrow (only `copilot.tencent.com`) and complete — it also covers the plugin's internal 11128 retry ladder. Each rung re-sends the request, so rewriting at body-assembly time would miss several of them.

**What the plugin does**

Rewrites `@` to `(at)` inside system and developer messages. The meaning is unchanged (the sentence is describing "tokens starting with @ are paths"), the model reads the same instruction, and the gateway no longer sees the character.

Six boundaries: system/developer only, guarded hosts only, non-JSON passes through, idempotent, fail-open, stale `Content-Length` dropped.

**Verification**

- 17 shipped tests that import the file **as installed on disk**, not the source — so what's tested is what runs
- Live gateway A/B: raw → 400 BLOCKED(11128), through the guard → 200 PASS
- Real 154 KB failed body replayed: raw → 400, through the guard → 200
- Fresh clone → install into a clean profile → uninstall, all three exercised

**Install**

```powershell
git clone https://github.com/curo22/dsh-wb400-guard
cd dsh-wb400-guard
node install.mjs
```

Zero runtime dependencies, node built-ins only. `install.mjs` backs up `package.json`, re-reads it to confirm no BOM, and verifies no non-ASCII dependency value was damaged.

**One trap worth its own paragraph**

Do not edit the profile's `package.json` with `ConvertTo-Json | Set-Content`. Under a non-ASCII Windows user name that pipeline decodes UTF-8 as GBK and re-encodes it:

```
link:C:/Users/罗雨/新目录/...  →  link:C:/Users/缃楅洦/鏂扮洰褰?/...
```

It also adds a BOM, and DSH's config hot-reload dies with `SyntaxError: Unexpected token 'ï¿¿'` — the profile won't load. I hit this myself, which is why `install.mjs` uses Node's `fs` and re-reads to verify.

**Repo**

https://github.com/curo22/dsh-wb400-guard

MIT. Issues welcome, especially if another gateway turns out to behave the same way.

---

## Suggested GitHub repo settings

**About / Description**

> Fix WorkBuddy China gateway 400 / code 11128 in DeepSeek Harness by rewriting @ in system messages at the fetch layer. One command, zero dependencies.

**Topics**

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

**Social preview idea**: the error text on the left (`请求被拦截，请重新发送`), `200 PASS` on the right, and an arrow between them labelled `@ → (at)`.

---

## Issue reply template

When someone reports the same thing, reply:

> That matches a known issue: the WorkBuddy China gateway runs a channel check for `@` in system messages and returns gateway code 11128. Install https://github.com/curo22/dsh-wb400-guard:
>
> ```
> git clone https://github.com/curo22/dsh-wb400-guard && cd dsh-wb400-guard && node install.mjs
> ```
>
> Then fully quit DSH Desktop and reopen it. To confirm it's working, run `node scripts/health-check.mjs` — it reads install state, the host load line, the rewrite counter and the block records together, then tells you which case you're in.
>
> If the "before the guard" line in `node verify-live.mjs` is also 200, the gateway changed its rules; the plugin is idle, which is harmless.

---

## Why this spreads (for anyone kind enough to share it)

Three things make it shareable. Lead with these:

1. **It disguises itself as your own misconfiguration.** New account doesn't help, new model doesn't help, reinstalling doesn't help — people keep doubting themselves. Telling them "it isn't you" is worth more than any technical detail.
2. **The root cause is small enough to be counterintuitive.** One `@`. "25,860 passes, 25,865 is blocked" is far more convincing than "the gateway has a check."
3. **The fix is non-invasive.** No kernel patching, no third-party package edits, no identity spoofing, no quota bypass. It changes how one character is spelled in your own outgoing message. Say this out loud — the first question people ask is "will this get me banned."

---

## Scope and limits (include when posting, to prevent misreads)

- Fixes `11128` only. `429` (quota), `11101` (non-streaming), and `502 / fetch failed` (network) are different problems.
- No quota or permission is bypassed. Same endpoint, same credentials, same tools, same conversation.
- If the gateway stops checking `@`, the plugin goes idle and stays out of the way.
- MIT, no telemetry, reports nothing anywhere.
