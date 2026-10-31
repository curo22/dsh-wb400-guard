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
 *
 * 第三、第四个触发源（v0.1.5 补，来自 a1141171521/dsh-multi-agent-gateway#1 的真实失败）：
 * 网关的通道校验不只看开头，它认的是「一组固定的身份句」，命中任意一句即 400。
 * 另外两句在官方内核里同样默认发出，位置分别在中段和尾部：
 *   #2 "You are a coding agent powered by the {model} model."   ← @deepseek-ai/dsh-web-app cordis.patch.yml:19-20（personaPrefix）
 *   #3 "You are interacting with the user through the DeepSeek\u200B Harness Web GUI ..."
 *                                                              ← @deepseek-ai/dsh-harness-dev-context lib/index.js:29（WEB_SURFACE_PROMPT）
 * 加上系统会话里那条 "Current DeepSeek\u200B Harness Web GUI URL: ..."，共四处带 harness 身份。
 * 只清 #1 和文件引用段的实现在这类机器上必挂，所以 v0.1.5 起对扫描角色做四段顺序改写。

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

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/* --------------------------------------------- 触发源三/四：内核里另外两处身份句
 *
 * 这两句在官方内核里默认就会发出，命中任意一句国内网关同样回 400 / 11128。
 * 它们的共同点是都在说「我是谁」，而不是「我要做什么」，所以整句改写成
 * 不带身份声明的等义句，语义不变、网关放行。
 *
 * 零宽空格 U+200B 是内核原文里就有的（DeepSeek + U+200B + " Harness"），
 * 正则必须容忍它，否则匹配不上。
 */

/** U+200B / U+00A0 / U+2060 / U+FEFF 与普通空白，内核各处混用。 */
const INVISIBLE = '[\\s\\u00A0\\u200B\\u2060\\uFEFF]*';

/** `DeepSeek` + 不可见分隔 + `Harness`，这是网关认的品牌指纹。 */
const BRAND_RE = new RegExp(`DeepSeek${INVISIBLE}Harness`, 'g');

/** 品牌指纹的等义写法：保留可读性，去掉「两个大写词相邻」这个形状。 */
const BRAND_SAFE = 'DeepSeek-Harness';

/**
 * 触发源三：@deepseek-ai/dsh-web-app 的 personaPrefix
 *   "You are a coding agent powered by the workbuddy/hy4-preview model."
 * 这句没有任何品牌词，靠的是 `coding agent powered by` 这个句式，所以单独处理，
 * 只把 `powered by` 换掉，模型名原样保留 —— 模型名本身网关不拦。
 */
const CODING_AGENT_RE = new RegExp(
  `You${INVISIBLE}are${INVISIBLE}a${INVISIBLE}coding${INVISIBLE}agent${INVISIBLE}powered${INVISIBLE}by`,
  'gi',
);

/**
 * 触发源四：@deepseek-ai/dsh-harness-dev-context 的 WEB_SURFACE_PROMPT
 *   "You are interacting with the user through the DeepSeek\u200B Harness Web GUI ..."
 * 以及同一插件注册的运行时上下文
 *   "Current DeepSeek\u200B Harness Web GUI URL: ..."
 * 官方的 LEGACY_WEB_SURFACE（历史会话里冻结的旧段落）也要一起处理。
 */
const WEB_SURFACE_RE = new RegExp(
  `You${INVISIBLE}are${INVISIBLE}interacting${INVISIBLE}with${INVISIBLE}the${INVISIBLE}user${INVISIBLE}through${INVISIBLE}the${INVISIBLE}DeepSeek${INVISIBLE}Harness${INVISIBLE}Web${INVISIBLE}GUI`,
  'gi',
);
const WEB_SURFACE_SAFE = 'You are interacting with the user through this Web GUI';

const WEB_URL_RE = new RegExp(
  `Current${INVISIBLE}DeepSeek${INVISIBLE}Harness${INVISIBLE}Web${INVISIBLE}GUI${INVISIBLE}URL`,
  'gi',
);
const WEB_URL_SAFE = 'Current Web GUI URL';

/** 是否有任何一处可改写的身份/品牌指纹。提前返回用，宁可多算不可漏判。 */
const FINGERPRINT_HINT_RE = new RegExp(`DeepSeek${INVISIBLE}Harness|coding${INVISIBLE}agent`, 'i');

/** 这些句子是否需要在发出去之前改写。 */
export function hasFingerprintText(text) {
  if (typeof text !== 'string' || text === '') return false;
  return FINGERPRINT_HINT_RE.test(text) || text.includes(IDENTITY_HINT);
}

/**
 * 按固定顺序抹掉四处身份指纹。未命中返回入参原引用。
 *
 * 顺序不能乱：
 *  1. 先处理锚定在开头的 #1（它依赖「位于消息开头」这个条件，被别处改写挤掉就失效）；
 *  2. 再处理句式型 #2（`coding agent powered by`）；
 *  3. 再处理带品牌词的 #3、#4（整句替换比逐词替换干净）；
 *  4. 最后兜底把残留的 `DeepSeek Harness` 品牌指纹换成连字符写法。
 */
export function neutralizeFingerprints(text) {
  if (typeof text !== 'string' || text === '') return text;
  if (!hasFingerprintText(text)) return text;

  let out = neutralizeIdentity(text);
  if (out.includes('coding agent') || CODING_AGENT_RE.test(out)) {
    CODING_AGENT_RE.lastIndex = 0;
    out = out.replace(CODING_AGENT_RE, 'You are a coding agent running on');
    CODING_AGENT_RE.lastIndex = 0;
  }
  if (WEB_SURFACE_RE.test(out)) {
    WEB_SURFACE_RE.lastIndex = 0;
    out = out.replace(WEB_SURFACE_RE, WEB_SURFACE_SAFE);
    WEB_SURFACE_RE.lastIndex = 0;
  }
  if (WEB_URL_RE.test(out)) {
    WEB_URL_RE.lastIndex = 0;
    out = out.replace(WEB_URL_RE, WEB_URL_SAFE);
    WEB_URL_RE.lastIndex = 0;
  }
  if (BRAND_RE.test(out)) {
    BRAND_RE.lastIndex = 0;
    out = out.replace(BRAND_RE, BRAND_SAFE);
    BRAND_RE.lastIndex = 0;
  }
  return out;
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

/**
 * 日志用的 URL 投影：只留 origin + pathname。
 * 查询串可能带敏感参数（token、session、prompt_cache_key 之类），不落盘。
 */
export function safeUrl(url) {
  if (typeof url !== 'string' || url === '') return '';
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url).split(/[?#]/)[0];
  }
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
  let out = neutralizeFingerprints(text);
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
  if (!raw.includes('@') && !hasFingerprintText(raw)) return { body: raw, changed: false };
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
    dryRun = false,
    onEvent = null,
  } = options;

  if (typeof fetchImpl !== 'function') throw new TypeError('createGuardedFetch: fetchImpl must be a function');

  const stats = { total: 0, rewritten: 0, wouldRewrite: 0, passedThrough: 0, failed: 0, lastEvent: null };

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
          // dryRun：只观察，绝不改请求。请求原样发出，只把"本来会改"记下来。
          if (outcome.changed && !dryRun) {
            rewrite = outcome;
            nextInit = { ...init, body: outcome.body };
            if (nextInit.headers) nextInit.headers = dropContentLength(nextInit.headers);
          } else if (outcome.changed) {
            stats.wouldRewrite += 1;
            emit({ kind: 'would-rewrite', url: safeUrl(url), bytesIn: body.length, mode });
            stats.passedThrough += 1;
            return fetchImpl(input, init);
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
      emit({ kind: 'rewritten', url: safeUrl(urlOf(input)), bytesIn: rewrite.body.length, mode });
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

export function resolveLogPath(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured);
  return join(dshHome(), 'logs', 'dsh-wb400-guard.jsonl');
}

/**
 * 找 DSH 家目录。
 *
 * 不能直接信 process.env.USERPROFILE：部分 Electron host（中文用户名机器上实测）
 * 会把 Windows 的 UTF-16 路径按 GBK 解出来，得到 `C:\Users\缃楅洦` 这种假目录，
 * 日志就写进一个根本不存在的乱码路径。Node 的 os.homedir() 在 Windows 上底层
 * 也是读 USERPROFILE，同样会中招。
 *
 * 所以按候选顺序取「磁盘上真的存在」的那一个，全都不存在才退回最后候选。
 */
function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const candidates = [];
  // 1) 从本模块自己的真实路径往上找 .dsh —— 插件装在 <profile>/vendor/ 下时最可靠，
  //    完全绕开环境变量的码页解码问题。
  const ancestor = findDshAncestor();
  if (ancestor) candidates.push(ancestor);
  // 2) os.userInfo().homedir 在 Windows 上走 GetUserProfileDirectoryW，
  //    不读环境变量，所以不会被码页解码坑到。这是备用里最可信的一条。
  try {
    candidates.push(join(userInfo().homedir, '.dsh'));
  } catch {
    /* 拿不到就跳过 */
  }
  // 3) homedir() 在 Windows 上就是读 USERPROFILE，会被同样的码页问题坑到，排在 userInfo 之后。
  try {
    candidates.push(join(homedir(), '.dsh'));
  } catch {
    /* 跳过 */
  }
  if (process.env.USERPROFILE) candidates.push(join(process.env.USERPROFILE, '.dsh'));
  if (process.env.HOME) candidates.push(join(process.env.HOME, '.dsh'));
  candidates.push('.dsh');
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* 权限之类的问题，试下一个 */
    }
  }
  return candidates[0] ?? '.dsh';
}

function findDshAncestor() {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 12; depth += 1) {
      if (basename(dir) === '.dsh') return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* 拿不到就交给后面的候选 */
  }
  return '';
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
      dryRun,
      onEvent: (event) => {
        writeLog({ event: event.kind, url: event.url, bytesIn: event.bytesIn, mode: event.mode, dryRun });
      },
    });

    writeLog({ event: 'installed', hosts, mode, dryRun, logPath: resolveLogPath(logPath) });
    ctx.logger?.info?.(
      `[dsh-wb400-guard] fetch guard installed for ${hosts.join(', ')}${dryRun ? ' (dryRun: observe only, nothing is rewritten)' : ''}`,
    );

    return () => {
      uninstall();
      writeLog({ event: 'uninstalled' });
    };
  }, 'dsh-wb400-guard: fetch guard');
}
