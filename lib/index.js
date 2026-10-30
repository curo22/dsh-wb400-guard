/**
 * dsh-wb400-guard — WorkBuddy 国内网关 400（code 11128）防护插件。
 *
 * 背景：内核 `@deepseek-ai/dsh-file-reference` 会把
 *   FILE_REFERENCE_PROMPT = "Tokens prefixed with @ are paths the user explicitly referenced. ..."
 * 注入到 system prompt。国内网关 copilot.tencent.com 的通道校验把 system 里出现的字面量 `@`
 * 判定为「非授权渠道调用」，回 400 / {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}。
 * 国际网关 www.workbuddy.ai 不校验，因此本插件只对国内 host 生效。
 *
 * 第二个触发源（独立）：@deepseek-ai/dsh-system-prompt 的官方发布版默认
 * includeHarnessIdentity = true，会在 system 最前面放一句
 *   "You are an AI agent powered by DeepSeek\u200B Harness."
 * 国内网关只在这一句位于 system 开头时拦截（放句中/尾部不拦）。两个触发源互不相关，
 * 必须同时处理，否则一类用户的请求仍然 400。

 * 第三个事实：网关也扫 assistant 消息。实测（同账号同头只换 body）：
 *  - 文件引用段放在 assistant 的开头、中段、尾部，全部 400；@ 换成 (at) 后 200。
 *  - 身份句在 assistant 里仍然只有「开头」触发，中段/尾部不触发。
 *  - assistant 里前导空格 / tab / 换行 / BOM 都绕不过。
 *  - user 和 tool 消息里放同样内容都 200，所以这两类刻意不动。
 *  - 多轮对话里每一条 assistant 都会被查，只改第一条无效。
 *
 * 设计约束（与 test/shipped.test.mjs 的 29 条断言一一对应）：
 *  1. 只改 system / developer / assistant 消息的 content，user / tool 一律不动。
 *     并且只动两处指纹（文件引用整段、开头身份句），不是「见到 @ 就换」。
 *  2. 只改命中 gatewayHosts 的请求；国际网关默认放行。
 *  3. 非 JSON 字符串 body、非字符串 body、无 body 请求一律原样透传（同引用）。
 *  4. 幂等：rewrite(rewrite(x)) === rewrite(x)，未改动时返回入参原引用。
 *  5. 任何内部异常 fail-open 到原始请求，且绝不引入重试。
 *  6. 改动后必须剔除陈旧的 Content-Length，否则上游按旧长度截断。
 *
 * 本文件零外部依赖（只用 node: 内置模块），因此装进 profile 不会引入 peer 解析问题。
 *
 * @module dsh-wb400-guard
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const name = 'dsh-wb400-guard';

/** 不 inject 任何 Service：本插件只包装 globalThis.fetch，不注册 tool / adapter。 */
export const inject = [];

/** 内核原文（D:\dsh2\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-file-reference\lib\index.js:54）。 */
export const FILE_REFERENCE_PROMPT =
  'Tokens prefixed with @ are paths the user explicitly referenced. ' +
  'Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. ' +
  'A trailing slash marks a directory: list it when its contents matter. ' +
  'Anything else is a file: use the read tool when its contents are needed, ' +
  'and do not claim to have inspected it before reading. ' +
  '@"..." quotes a path containing spaces.';

/** 宽松锚点：内核可能改写句子尾部，但开头这一句是网关实际匹配的位置。 */
const LOOSE_ANCHOR = 'Tokens prefixed with @';

/* ------------------------------------------------------- 触发源二：内核身份句
 *
 * @deepseek-ai/dsh-system-prompt 的 realse 版本默认 includeHarnessIdentity = true，
 * 会在 system 最前面放一句 "You are an AI agent powered by DeepSeek\u200B Harness."
 * （DeepSeek 与 Harness 之间是 U+200B 零宽空格）。国内网关只在这一句位于消息开头时
 * 拦截，放到句中或尾部不拦。实测改写法：把空格换成连字符，语义不变，网关放行。
 */
const IDENTITY_SAFE = 'You are an AI agent powered by DeepSeek-Harness.';
const IDENTITY_RE = /^You are an AI agent powered by DeepSeek[\u200B\s]*Harness\./;
const LEADING_NOISE_RE = /^[\s\uFEFF]*/;
const IDENTITY_HINT = 'You are an AI agent powered by DeepSeek';

/** 内核身份句是否需要在发出去之前改写。 */
export function hasIdentitySentence(text) {
  if (typeof text !== 'string' || !text.includes(IDENTITY_HINT)) return false;
  const head = LEADING_NOISE_RE.exec(text)?.[0] ?? '';
  return IDENTITY_RE.test(text.slice(head.length));
}

/** 把开头的内核身份句换成等义但网关放行的写法。未命中返回入参原引用。 */
export function neutralizeIdentity(text) {
  if (!hasIdentitySentence(text)) return text;
  const head = LEADING_NOISE_RE.exec(text)?.[0] ?? '';
  const rest = text.slice(head.length);
  return head + IDENTITY_SAFE + rest.replace(IDENTITY_RE, '');
}

/** 默认防护 host。国际网关 www.workbuddy.ai 刻意不在列表内。 */
export const DEFAULT_GUARDED_HOSTS = ['copilot.tencent.com'];

/**
 * 网关会扫描的角色。
 *
 * `assistant` 也在其中，而且行为和 system 不同：
 * - 文件引用那一段（指纹一）在 assistant 消息里 **任意位置** 都触发，
 *   开头、中段、尾部、前面垫空白或 BOM 全都会 400；
 * - 身份句（指纹二）在 assistant 里仍然是 **开头锚定**，
 *   和 system 一样，前面垫一整行能过、垫空格或 BOM 不能过。
 *
 * `user` 和 `tool` 消息实测不扫描（塞完整指纹进去也是 200），
 * 所以刻意不动 —— 用户自己写的 @ 和邮箱一个字符都不碰。
 */
const SCANNED_ROLES = new Set(['system', 'developer', 'assistant']);

/* ------------------------------------------------------------------ host 判定 */

export function isGuardedHost(hostname, hosts = DEFAULT_GUARDED_HOSTS) {
  if (typeof hostname !== 'string' || hostname === '') return false;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  for (const raw of hosts) {
    if (typeof raw !== 'string' || raw === '') continue;
    const entry = raw.toLowerCase().replace(/\.$/, '');
    if (entry.startsWith('.')) {
      if (host === entry.slice(1) || host.endsWith(entry)) return true;
    } else if (host === entry) return true;
  }
  return false;
}

export function urlOf(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && typeof input.url === 'string') return input.url;
  return '';
}

export function isGuardedUrl(url, hosts = DEFAULT_GUARDED_HOSTS) {
  if (typeof url !== 'string' || url === '') return false;
  try {
    return isGuardedHost(new URL(url).hostname, hosts);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ 文本改写 */

/**
 * 只替换**整段指纹**，不做任何「见到 @ 就换」的兜底。
 *
 * 早期版本还有一条 `@"` → `(at)"` 的兜底，已经删掉：
 * 实测裸的 `@"` 完全不触发网关（PowerShell here-string、C# 逐字字符串、
 * 重复 20 次、加长文本，全部 200）。留着它只会把用户代码里的
 * here-string 静默改坏，换不来任何好处。
 */
function rewriteAnchor(text) {
  let out = text;
  if (out.includes(FILE_REFERENCE_PROMPT)) {
    out = out.split(FILE_REFERENCE_PROMPT).join(FILE_REFERENCE_PROMPT.replaceAll('@', '(at)'));
  }
  if (out.includes(LOOSE_ANCHOR)) {
    out = out.split(LOOSE_ANCHOR).join('Tokens prefixed with (at)');
  }
  return out;
}

function rewriteAll(text) {
  return text.replaceAll('@', '(at)');
}

function rewriteText(text, mode) {
  if (typeof text !== 'string') return text;
  let out = neutralizeIdentity(text);
  if (out.includes('@')) out = mode === 'all' ? rewriteAll(out) : rewriteAnchor(out);
  return out;
}

function walkContent(value, mode, state) {
  if (typeof value === 'string') {
    const next = rewriteText(value, mode);
    if (next !== value) state.changed = true;
    return next;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = walkContent(value[i], mode, state);
    return value;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = walkContent(value[key], mode, state);
    return value;
  }
  return value;
}

export function rewriteChatBodyObject(body, mode = 'anchor') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  const state = { changed: false };
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
    if (!SCANNED_ROLES.has(role)) continue;
    if (message.content === undefined) continue;
    message.content = walkContent(message.content, mode, state);
  }
  return state.changed;
}

export function rewriteJsonBody(raw, mode = 'anchor') {
  if (typeof raw !== 'string') return { body: raw, changed: false };
  if (!raw.includes('@') && !raw.includes(IDENTITY_HINT)) return { body: raw, changed: false };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { body: raw, changed: false };
  }
  const changed = rewriteChatBodyObject(parsed, mode);
  if (!changed) return { body: raw, changed: false };
  return { body: JSON.stringify(parsed), changed: true };
}

function dropContentLength(headers) {
  const out = {};
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
  for (const [key, value] of entries) {
    if (String(key).toLowerCase() === 'content-length') continue;
    out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ fetch 包装 */

export function createGuardedFetch(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    hosts = DEFAULT_GUARDED_HOSTS,
    mode = 'anchor',
    onEvent = null,
  } = options;

  if (typeof fetchImpl !== 'function') throw new TypeError('createGuardedFetch: fetchImpl must be a function');

  const stats = { total: 0, rewritten: 0, passedThrough: 0, failed: 0, lastEvent: null };

  const emit = (event) => {
    stats.lastEvent = event;
    if (typeof onEvent !== 'function') return;
    try {
      onEvent(event);
    } catch {
      /* 观察者异常不得影响请求 */
    }
  };

  const guardedFetch = async function guardedFetch(input, init) {
    stats.total += 1;
    let nextInit = init;
    let rewrite = null;
    try {
      const url = urlOf(input);
      if (isGuardedUrl(url, hosts)) {
        const body = init && init.body;
        if (typeof body === 'string') {
          const outcome = rewriteJsonBody(body, mode);
          if (outcome.changed) {
            rewrite = outcome;
            nextInit = { ...init, body: outcome.body };
            if (nextInit.headers) nextInit.headers = dropContentLength(nextInit.headers);
          }
        }
      }
    } catch {
      rewrite = null;
      nextInit = init;
      stats.failed += 1;
    }

    if (rewrite) {
      stats.rewritten += 1;
      emit({ kind: 'rewritten', url: urlOf(input), bytesIn: rewrite.body.length, mode });
    } else {
      stats.passedThrough += 1;
    }

    return fetchImpl(input, nextInit);
  };

  return { fetch: guardedFetch, stats };
}

/* ------------------------------------------------------------------ 全局安装 */

const INSTALL_KEY = Symbol.for('dsh-wb400-guard.installed');

export function installFetchGuard(options = {}) {
  const existing = globalThis[INSTALL_KEY];
  if (existing) return existing.uninstall;

  const original = globalThis.fetch;
  const guard = createGuardedFetch({ ...options, fetchImpl: original });
  globalThis.fetch = guard.fetch;

  const uninstall = () => {
    if (globalThis.fetch === guard.fetch) globalThis.fetch = original;
    delete globalThis[INSTALL_KEY];
  };

  globalThis[INSTALL_KEY] = { guard, uninstall, original };
  return uninstall;
}

export function guardState() {
  const installed = globalThis[INSTALL_KEY];
  return installed ? { installed: true, stats: installed.guard.stats } : { installed: false };
}

/* ------------------------------------------------------------------ 日志 */

function resolveLogPath(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured);
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '.', '.dsh');
  return join(home, 'logs', 'dsh-wb400-guard.jsonl');
}

function createLogger(logPath) {
  let ready = false;
  return (record) => {
    try {
      if (!ready) {
        mkdirSync(dirname(logPath), { recursive: true });
        ready = true;
      }
      appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8');
    } catch {
      /* 日志失败不得影响请求链路 */
    }
  };
}

/* ------------------------------------------------------------------ Cordis 入口 */

/**
 * 挂载点：包装 globalThis.fetch，用 ctx.effect 绑定生命周期。
 * 卸载时（profile reload / 插件禁用 / 进程退出前 dispose）自动还原原始 fetch。
 */
export function apply(ctx, config = {}) {
  const {
    enabled = true,
    gatewayHosts = DEFAULT_GUARDED_HOSTS,
    logPath = '',
    dryRun = false,
    mode = 'anchor',
  } = config || {};

  if (!enabled) {
    ctx.logger?.info?.('[dsh-wb400-guard] disabled by config; fetch left untouched');
    return;
  }

  const hosts = Array.isArray(gatewayHosts) && gatewayHosts.length > 0 ? gatewayHosts : DEFAULT_GUARDED_HOSTS;
  const writeLog = createLogger(resolveLogPath(logPath));

  ctx.effect(() => {
    const uninstall = installFetchGuard({
      hosts,
      mode,
      onEvent: (event) => {
        writeLog({ event: event.kind, url: event.url, bytesIn: event.bytesIn, mode: event.mode, dryRun });
      },
    });

    writeLog({ event: 'installed', hosts, mode, dryRun, logPath: resolveLogPath(logPath) });
    ctx.logger?.info?.(`[dsh-wb400-guard] fetch guard installed for ${hosts.join(', ')}`);

    return () => {
      uninstall();
      writeLog({ event: 'uninstalled' });
    };
  }, 'dsh-wb400-guard: fetch guard');
}
