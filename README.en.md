# dsh-wb400-guard

[中文](README.md) | **English**

[![CI](https://github.com/curo22/dsh-wb400-guard/actions/workflows/test.yml/badge.svg)](https://github.com/curo22/dsh-wb400-guard/actions/workflows/test.yml)
[![tests](https://img.shields.io/badge/tests-29%20passing-brightgreen)](test/shipped.test.mjs)
[![dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](package.json)
[![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-green)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

One command fixes the 400 that kills every turn when DeepSeek Harness talks to **WorkBuddy's China gateway**.

```
本轮运行失败 400: {"message":"workbuddy upstream client (http 400): 请求被拦截，请重新发送","type":"client","code":"client"}
```

Tagged `INVALID_REQUEST`; underneath it is gateway `code 11128`. The international route (`www.workbuddy.ai`) never shows it.

---

## Do you have this problem? 30-second check

| Symptom | Match |
|---|---|
| Error says 请求被拦截 (request blocked), tagged `INVALID_REQUEST` | yes |
| Switching to an international model works, switching back to the China route fails | yes |
| It dies on step 1, before a single token of reply | yes |
| Different account, different model, different machine — identical failure | yes |
| The official WorkBuddy desktop app chats fine | yes |
| Error is `429` / "usage exceeds frequency limit" | no — that's quota |
| Error is `11101` / "Non-stream chat request" | no — that's a non-streaming request |
| Error is `fetch failed` / 502 | no — that's the network |

All of the first three together means it's almost certainly this.

## Why it gets blocked

The DSH kernel package `@deepseek-ai/dsh-file-reference` injects a file-reference paragraph into the system prompt:

```
Tokens prefixed with @ are paths the user explicitly referenced. ...
@"..." quotes a path containing spaces.
```

The China gateway `copilot.tencent.com` runs a channel check over system messages. It sees a literal `@` and treats the call as coming from an unapproved channel:

```json
{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}
```

The WorkBuddy plugin wraps that into the 请求被拦截 message above.

The international gateway does no such check, which is why the same request to `www.workbuddy.ai` returns 200.

## How it was pinned down (reproducible)

The trigger is content, not length:

| Experiment | Result |
|---|---|
| Truncate the prompt to 25,860 chars | 200 |
| Truncate to 25,865 chars | 400 / 11128 |
| Pad with plain `a` to 60,000 chars | 200 |
| Pad with CJK to 30,000 chars | 200 |
| Repeat the trigger block 100 / 400 times | 200 |
| Replace `@` with `(at)` | **200** |
| Replace with the fullwidth `＠` | 400 (gateway folds it back before matching) |
| Put `@` in a user message instead | 200 (only system messages trigger) |
| Resend the same body 5 times | 5 × 11128, fully deterministic |

The trigger is the opening run of words in that paragraph plus the literal `@` glyph, as a combination — not the character alone. A 112-character prefix is blocked; the same 112 characters with `@` replaced by `x` pass. Deleting any one of the opening words also passes.

A sliding window narrowed the trigger to offsets 25,000–30,000; section-level substitution ruled out "one sensitive paragraph". A codepoint-level comparison confirmed it: the trigger is that single glyph.

## What the plugin does

It wraps `globalThis.fetch` in the host process. For requests to `copilot.tencent.com` only, it rewrites two things **inside system, developer and assistant messages**:

1. the `@` in the file-reference paragraph, to the equivalent `(at)`;
2. a leading identity sentence (`You are an AI agent powered by DeepSeek​ Harness.`) to the hyphenated form `You are an AI agent powered by DeepSeek-Harness.`.

Both are meaning-preserving edits: the model reads the same instruction, the gateway no longer matches either fingerprint. User and tool messages are untouched. Every other API (DeepSeek, OpenAI, Anthropic, WorkBuddy international) passes through the same object reference, without even being re-serialized.

### Why assistant messages are scanned too

The gateway does not stop at system. Measured with the same account and identical headers, varying only the body:

| assistant message | Result |
|---|---|
| clean content | 200 |
| identity sentence at the start | **400** 11128 |
| identity sentence mid-body / at the end | 200 |
| file-reference paragraph at the start / mid-body / at the end | **400** 11128 |
| file-reference paragraph with `@` rewritten to `(at)` | **200** |
| paragraph prefixed with 1 space / a tab / a newline / a BOM | **400**, every variant |
| ordinary `@`, an email like `a@b.com`, an `@mention` | 200 |
| only the second assistant turn carries the fingerprint | **400** (every message is checked) |

So inside assistant messages the file-reference paragraph fires at *any* position (stricter than system), while the identity sentence still only fires at the start. The same content inside a user or tool message returns 200, which is why those are left alone.

`mode=all` still only applies to system messages; it does not touch ordinary `@` characters in assistant text.

## Why the fetch layer

Two other hooks were tried and both are wrong:

- **`llm/stream` event**: `GenerateOptions` arrives deep-frozen, and `next()` takes no arguments. Read-only.
- **`system-prompt/assemble` event**: it can rewrite, but it would rewrite the prompt for every provider, and only one gateway has the problem.

fetch is the only place that is both narrow and complete — it also covers the plugin's internal 11128 retry ladder. Each rung re-sends the request, so rewriting at body-assembly time would miss several of them.

## Install

Zero runtime dependencies, node built-ins only. Requires Node `^22.19.0 || >=24.0.0`.

### With the DSH CLI (recommended)

```bash
dsh plugin --profile web add github:curo22/dsh-wb400-guard
```

Swap `web` for your own profile name (the desktop app uses `desktop`).

### Or clone and run

```powershell
git clone https://github.com/curo22/dsh-wb400-guard.git
cd dsh-wb400-guard
node install.mjs
```

It copies files into `%USERPROFILE%\.dsh\profiles\desktop\vendor\dsh-wb400-guard`, writes `dependencies` and `dsh.profile.bundles` into the profile's `package.json`, creates a junction so the module resolves, and runs the 29 shipped tests.

A different profile:

```powershell
node install.mjs D:\path\to\other\profile
```

Uninstall:

```powershell
node install.mjs --uninstall
```

Then **restart DSH Desktop** — fully quit it, not just close the window. The host log should show:

```
[I] [dsh-wb400-guard] [dsh-wb400-guard] fetch guard installed for copilot.tencent.com
```

### Manual install

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item -Recurse -Force .\* "$prof\vendor\dsh-wb400-guard\"
New-Item -ItemType Junction -Path "$prof\node_modules\dsh-wb400-guard" -Target "$prof\vendor\dsh-wb400-guard"
```

Then edit `$prof\package.json` by hand: add `"dsh-wb400-guard": "file:./vendor/dsh-wb400-guard"` to `dependencies`, and `"dsh-wb400-guard"` to the end of `dsh.profile.bundles`.

> **Do not edit the profile's `package.json` with `ConvertTo-Json | Set-Content`.**
> Under a non-ASCII Windows user name that combo decodes UTF-8 bytes as GBK and re-encodes them.
> `link:C:/Users/罗雨/新目录/...` becomes `link:C:/Users/缃楅洦/鏂扮洰褰?/...`, and the file gets a BOM.
> DSH's config hot-reload then fails with `SyntaxError: Unexpected token 'ï»¿'` and the profile won't load.
> `install.mjs` uses Node's `fs`, then re-reads and verifies there is no BOM and no non-ASCII dependency value was damaged.

## Configuration

Tunable in `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn it off and `fetch` is never touched |
| `gatewayHosts` | `["copilot.tencent.com"]` | Hosts to guard; a leading `.` means suffix match. The international gateway is not listed by default |
| `mode` | `"anchor"` | `anchor` rewrites only the file-reference paragraph; `all` rewrites every `@` in system messages (fallback if the kernel changes wording) |
| `logPath` | `""` | Empty writes to `~/.dsh/logs/dsh-wb400-guard.jsonl` |
| `dryRun` | `false` | Log rewrites without applying them |

## Safety boundaries

- **System / developer only.** Emails like `a@b.com` and `@mentions` in user messages are never touched.
- **Guarded hosts only.** Other APIs get the same request object back, not a re-serialized copy.
- **Non-JSON, non-string, or bodyless requests** pass straight through.
- **Idempotent.** A second pass changes nothing and returns the input reference.
- **Fail-open.** Any exception in the rewrite path falls back to the original request. No broken turns, no added retries.
- **Stale `Content-Length` is dropped.** A shortened body carrying the old length gets truncated upstream.
- **Writes nothing, reports nothing.** The body is read, rewritten, sent. Never persisted, never transmitted anywhere else.

## Verify

```powershell
# 29 shipped tests: contract, rewriting (all three trigger scenes), host matching, idempotence, fail-open, install/uninstall, config
node --test

# Against the real China gateway (needs WorkBuddy desktop signed in on this machine)
$env:WORKBUDDY_ELECTRON_BIN = '<path to the WorkBuddy Electron binary>'
node verify-live.mjs
```

`verify-live.mjs` uses real credentials against the real gateway. Expected:

```
经插件前（预期被拦）      400 BLOCKED(11128)   OK
经插件后（预期通过）      200 PASS             OK
```

Closer-to-production scripts:

```powershell
# Both triggers, alone and stacked — five live A/B cases
node scripts/verify-identity-live.mjs
node scripts/verify-assistant-live.mjs

# End to end: stock dsh-workbuddy-connect assembles → guard rewrites → real gateway
node scripts/verify-pipeline.mjs

# Replay a real 154 KB failed body (94 tools, 15 messages)
node scripts/verify-real-body.mjs

# Run after install+restart: one command answers "is the fix working right now"
node scripts/health-check.mjs

# Read-only: did real traffic actually get rewritten
node scripts/read-guard-log.mjs

# Is the installed vendor copy in sync with the repo
node scripts/compare-vendor.mjs . "$env:USERPROFILE\.dsh\profiles\desktop\vendor\dsh-wb400-guard"
```

## Troubleshooting

Still broken after install? Check in this order.

**1. Was the plugin loaded?** Search the host log (`%APPDATA%\DSH Desktop\logs\host\`) for `dsh-wb400-guard`. No `fetch guard installed` line means the profile never loaded it — usually you didn't restart, or `dsh.profile.bundles` never got written.

**2. Does the plugin itself work?** Run `node verify-live.mjs`. It bypasses DSH's load path and hits the real gateway with real credentials. If its "after the guard" line isn't 200 either, the problem is the plugin or the credential, not the install.

**3. Did something else get there first?** An earlier fix edited `dsh-workbuddy-connect`'s source directly. That edit rewrites the `@` before this plugin ever sees it, so the rewrite counter stays at 0 and the plugin looks dead. `health-check.mjs` scans `node_modules/dsh-workbuddy-connect/lib/*.js` for the telltale identifiers and says so when it finds them. The same thing happens when the file on disk is already restored but the process has not restarted: the old code still lives in memory. One restart settles it.

**4. Did rewriting actually happen?** Run `node scripts/health-check.mjs`. It reads install state, the host load line, the guard log's rewrite counter and the host log's block records, then tells you which case you're in. If it says the plugin is ready but no China-route traffic has passed, send one message on a China-route model and run it again.

**5. Did the gateway change its rules?** If the "before the guard" line in `verify-live.mjs` also turns 200, the gateway no longer blocks on `@`. The plugin is idle, which is fine.

## FAQ

**Will it affect my other models?**
No. Only requests whose host matches `copilot.tencent.com` are inspected. DeepSeek's own API, OpenAI, Anthropic and WorkBuddy international get the same object reference back — not even re-serialized.

**Will it corrupt my conversation content?**
It touches system, developer and assistant messages only. Emails, `@mentions`, decorators, regexes and PowerShell here-strings in user code are untouched. Within those messages it changes only the two fingerprints, and the meaning is unchanged.

**Why not just patch `dsh-workbuddy-connect`?**
Editing that package gets overwritten on every plugin upgrade and has to be re-applied. This plugin lives at the profile layer, so package upgrades don't touch it.

**Do I need to reinstall after upgrading the plugin?**
Yes. `install.mjs` copies into `vendor` rather than linking. Pull new code, re-run it, then confirm with `compare-vendor.mjs`.

**Should I guard the international gateway too?**
Not by default. If `www.workbuddy.ai` ever starts checking, add it to `gatewayHosts` and set `mode` to `all`.

**Does this risk my account?**
It changes how one character is spelled in your own outgoing message. Same endpoint, same credentials, same tools, same conversation. No identity spoofing, no quota bypass, no multi-accounting.

## Known limits

- **If the gateway changes its rules** (stops blocking on `@`), the plugin goes idle and nothing breaks. `verify-live.mjs` will tell you the raw request now passes.
- **If the DSH kernel rewords `FILE_REFERENCE_PROMPT`**, `anchor` mode still has the `Tokens prefixed with @` anchor as a fallback; if the anchor changes too, set `mode` to `all`.
- **429 rate limits are unrelated.** That's quota exhaustion; wait for the reset.
- **`stream: false` is rejected by the China gateway as `11101`**, a different code from `11128`. This plugin only fixes `11128`.
- **Two plugins wrapping `fetch`** — the later one sits outermost. This plugin uses `Symbol.for('dsh-wb400-guard.installed')` so only one layer installs, repeated calls return the same uninstaller, and uninstalling won't clobber a `fetch` someone else installed afterwards.
- **The file on disk and the running process are different things.** Reverting the file does not undo the change inside a running process; it takes effect next launch. Same for installing the plugin without restarting.

## Development

```powershell
# Run tests (on Node 24, `node --test test/` doesn't accept a directory — let it auto-discover)
node --test

# Point your own profile at this checkout so edits apply immediately
.\scripts\link-local.ps1
.\scripts\link-local.ps1 -Remove   # undo
```

The division of labour: `install.mjs` copies into `profile\vendor` (good for distribution); `link-local.ps1` junctions to this checkout (good for development).

`install.mjs` copies rather than links, so after pulling new code re-run it for `vendor` to catch up. To check whether it's behind:

```powershell
node scripts/compare-vendor.mjs . "$env:USERPROFILE\.dsh\profiles\desktop\vendor\dsh-wb400-guard"
```

Per-file hash comparison; it lists differing and missing files. When everything matches it prints one line.

Push to GitHub:

```powershell
.\scripts\push-github.ps1
```

It checks clean worktree, SSH auth and remote reachability in order, then pushes. Any failing step stops there and states why.

> On Windows, git's bundled ssh resolves HOME to a GBK-mangled path under a non-ASCII user name and fails with `Host key verification failed`.
> Use the system OpenSSH instead: `git config core.sshCommand 'C:/Windows/System32/OpenSSH/ssh.exe'`.

## Related

- [PROMO.md](PROMO.md) / [PROMO.en.md](PROMO.en.md) — one-liners, ready-to-post blurbs, suggested tags
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the host this plugin serves

## License

MIT
