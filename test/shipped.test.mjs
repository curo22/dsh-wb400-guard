/**
 * 针对「已构建产物的实际字节」的测试。
 *
 * 与 test/*.test.mjs（跑 src/guard-core.mjs）不同，本文件直接 import
 * lib/index.js —— 也就是分发出去、被 profile 加载的那份文件。
 * 目的：保证「测过的代码」和「装上去的代码」是同一份，不会出现 src 改了 dist 没同步。
 *
 * 跑法：node --test test/shipped.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import * as guard from '../lib/index.js';

/** 内核 dsh-file-reference 注入到 system 的原文（两处 @）。 */
const KERNEL_PROMPT =
  'Tokens prefixed with @ are paths the user explicitly referenced. ' +
  'Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. ' +
  'A trailing slash marks a directory: list it when its contents matter. ' +
  'Anything else is a file: use the read tool when its contents are needed, ' +
  'and do not claim to have inspected it before reading. ' +
  '@"..." quotes a path containing spaces.';

const countAt = (s) => [...s].filter((c) => c === '@').length;

/* ---------------------------------------------------------------- 契约 */

test('产物导出 cordis 插件契约', () => {
  assert.equal(guard.name, 'dsh-wb400-guard');
  assert.deepEqual(guard.inject, []);
  assert.equal(typeof guard.apply, 'function');
});

test('默认只防护国内网关，不含国际网关', () => {
  assert.deepEqual(guard.DEFAULT_GUARDED_HOSTS, ['copilot.tencent.com']);
  assert.equal(guard.isGuardedUrl('https://copilot.tencent.com/v2/chat/completions'), true);
  assert.equal(guard.isGuardedUrl('https://www.workbuddy.ai/v2/chat/completions'), false);
  assert.equal(guard.isGuardedUrl('https://api.deepseek.com/v1/chat/completions'), false);
});

test('常量与内核原文逐字一致（码点级，两处 @）', () => {
  assert.equal(countAt(guard.FILE_REFERENCE_PROMPT), 2);
  assert.equal(guard.FILE_REFERENCE_PROMPT, KERNEL_PROMPT);
});

/* ---------------------------------------------------------------- 改写 */

test('改写内核原文后不再含 @，且语义可用 (at) 还原', () => {
  const body = JSON.stringify({ messages: [{ role: 'system', content: KERNEL_PROMPT }] });
  const out = guard.rewriteJsonBody(body, 'anchor');
  assert.equal(out.changed, true);
  const text = JSON.parse(out.body).messages[0].content;
  assert.equal(countAt(text), 0);
  assert.equal(text.split('(at)').join('@'), KERNEL_PROMPT);
});

test('幂等：第二次改写不再变动且返回原引用', () => {
  const body = JSON.stringify({ messages: [{ role: 'system', content: KERNEL_PROMPT }] });
  const first = guard.rewriteJsonBody(body, 'anchor');
  const second = guard.rewriteJsonBody(first.body, 'anchor');
  assert.equal(second.changed, false);
  assert.equal(second.body, first.body);
});

test('user 消息里的 @ 不动，assistant 里的普通 @ 也不动', () => {
  const body = JSON.stringify({
    messages: [
      { role: 'system', content: KERNEL_PROMPT },
      { role: 'user', content: 'mail me at a@b.com or ping @someone' },
      { role: 'assistant', content: 'ok @you' },
    ],
  });
  const out = guard.rewriteJsonBody(body, 'anchor');
  const parsed = JSON.parse(out.body);
  assert.equal(countAt(parsed.messages[0].content), 0);
  assert.equal(parsed.messages[1].content, 'mail me at a@b.com or ping @someone');
  assert.equal(parsed.messages[2].content, 'ok @you', 'assistant 里的普通 @ 不碰，只碰整段指纹');
});

test('developer 角色同样被处理（CN 路由会归一成 system）', () => {
  const body = JSON.stringify({ messages: [{ role: 'developer', content: KERNEL_PROMPT }] });
  const out = guard.rewriteJsonBody(body, 'anchor');
  assert.equal(out.changed, true);
  assert.equal(countAt(JSON.parse(out.body).messages[0].content), 0);
});

test('content 是分块数组时也能改', () => {
  const body = JSON.stringify({
    messages: [{ role: 'system', content: [{ type: 'text', text: KERNEL_PROMPT }] }],
  });
  const out = guard.rewriteJsonBody(body, 'anchor');
  assert.equal(out.changed, true);
  assert.equal(countAt(JSON.parse(out.body).messages[0].content[0].text), 0);
});

test('非 JSON / 非字符串 / 无 @ 的 body 原样透传同一引用', () => {
  const notJson = 'not json @ here';
  assert.equal(guard.rewriteJsonBody(notJson, 'anchor').body, notJson);
  assert.equal(guard.rewriteJsonBody(notJson, 'anchor').changed, false);

  const noAt = JSON.stringify({ messages: [{ role: 'system', content: 'plain' }] });
  assert.equal(guard.rewriteJsonBody(noAt, 'anchor').body, noAt);

  assert.equal(guard.rewriteJsonBody(null, 'anchor').changed, false);
  assert.equal(guard.rewriteJsonBody({}, 'anchor').changed, false);
});

test('mode=all 兜底：system 里所有 @ 都换掉', () => {
  const body = JSON.stringify({
    messages: [{ role: 'system', content: 'see @here and @there; not a@b.com' }],
  });
  const out = guard.rewriteJsonBody(body, 'all');
  assert.equal(countAt(JSON.parse(out.body).messages[0].content), 0);
});

/* ---------------------------------------------------------------- fetch 层 */

function makeFetchSpy() {
  const calls = [];
  const spy = async (input, init) => {
    calls.push({ input, init });
    return new Response('{}', { status: 200 });
  };
  return { spy, calls };
}

test('createGuardedFetch 只对 guarded host 改写，并剔除陈旧 Content-Length', async () => {
  const { spy, calls } = makeFetchSpy();
  const g = guard.createGuardedFetch({ fetchImpl: spy });

  await g.fetch('https://copilot.tencent.com/v2/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '999999' },
    body: JSON.stringify({ messages: [{ role: 'system', content: KERNEL_PROMPT }] }),
  });

  assert.equal(calls.length, 1);
  const sent = calls[0].init;
  assert.equal(countAt(JSON.parse(sent.body).messages[0].content), 0);
  assert.equal(
    Object.keys(sent.headers).some((k) => k.toLowerCase() === 'content-length'),
    false,
  );
  assert.equal(sent.headers['Content-Type'], 'application/json');
  assert.equal(g.stats.rewritten, 1);
});

test('国际网关请求完全不碰', async () => {
  const { spy, calls } = makeFetchSpy();
  const g = guard.createGuardedFetch({ fetchImpl: spy });
  const body = JSON.stringify({ messages: [{ role: 'system', content: KERNEL_PROMPT }] });

  await g.fetch('https://www.workbuddy.ai/v2/chat/completions', { method: 'POST', body });

  assert.equal(calls[0].init.body, body);
  assert.equal(g.stats.passedThrough, 1);
  assert.equal(g.stats.rewritten, 0);
});

test('dryRun: true 时请求原样发出，只记录 would-rewrite', async () => {
  const { spy, calls } = makeFetchSpy();
  const events = [];
  const g = guard.createGuardedFetch({ fetchImpl: spy, dryRun: true, onEvent: (e) => events.push(e) });
  const body = JSON.stringify({ messages: [{ role: 'system', content: KERNEL_PROMPT }] });

  await g.fetch('https://copilot.tencent.com/v2/chat/completions', { method: 'POST', body });

  assert.equal(calls.length, 1);
  // 一个字节都没改
  assert.equal(calls[0].init.body, body);
  assert.equal(countAt(JSON.parse(calls[0].init.body).messages[0].content), 2);
  // 统计口径区分"改了"和"本来会改"
  assert.equal(g.stats.rewritten, 0);
  assert.equal(g.stats.wouldRewrite, 1);
  assert.equal(g.stats.passedThrough, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'would-rewrite');
});

test('dryRun: false 时照常改写（默认行为不受影响）', async () => {
  const { spy, calls } = makeFetchSpy();
  const g = guard.createGuardedFetch({ fetchImpl: spy, dryRun: false });

  await g.fetch('https://copilot.tencent.com/v2/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'system', content: KERNEL_PROMPT }] }),
  });

  assert.equal(countAt(JSON.parse(calls[0].init.body).messages[0].content), 0);
  assert.equal(g.stats.rewritten, 1);
  assert.equal(g.stats.wouldRewrite, 0);
});

test('dryRun 下无命中的请求同样不发 would-rewrite 事件', async () => {
  const { spy } = makeFetchSpy();
  const events = [];
  const g = guard.createGuardedFetch({ fetchImpl: spy, dryRun: true, onEvent: (e) => events.push(e) });

  await g.fetch('https://copilot.tencent.com/v2/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'plain text, nothing to rewrite' }] }),
  });

  assert.equal(events.length, 0);
  assert.equal(g.stats.wouldRewrite, 0);
  assert.equal(g.stats.passedThrough, 1);
});

test('safeUrl 剥掉查询串与 hash，只留 origin + path', () => {
  assert.equal(
    guard.safeUrl('https://copilot.tencent.com/v2/chat/completions?token=secret&session=abc'),
    'https://copilot.tencent.com/v2/chat/completions',
  );
  assert.equal(
    guard.safeUrl('https://copilot.tencent.com/v2/chat/completions#frag'),
    'https://copilot.tencent.com/v2/chat/completions',
  );
  assert.equal(guard.safeUrl('not a url?token=secret'), 'not a url');
  assert.equal(guard.safeUrl(''), '');
  assert.equal(guard.safeUrl(null), '');
});

test('改写事件的 url 不含查询串', async () => {
  const { spy } = makeFetchSpy();
  const events = [];
  const g = guard.createGuardedFetch({ fetchImpl: spy, onEvent: (e) => events.push(e) });

  await g.fetch('https://copilot.tencent.com/v2/chat/completions?prompt_cache_key=session-abc123', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'system', content: KERNEL_PROMPT }] }),
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].url, 'https://copilot.tencent.com/v2/chat/completions');
  assert.equal(events[0].url.includes('?'), false);
  assert.equal(events[0].url.includes('session-abc123'), false);
});

test('fetch 内部异常不影响请求（fail-open）', async () => {
  const { spy, calls } = makeFetchSpy();
  let seen = 0;
  const g = guard.createGuardedFetch({
    fetchImpl: spy,
    onEvent: () => {
      seen += 1;
      throw new Error('observer boom');
    },
  });

  await g.fetch('https://copilot.tencent.com/v2/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'system', content: KERNEL_PROMPT }] }),
  });

  assert.equal(calls.length, 1);
  assert.equal(seen, 1);
});

test('URL 对象与 Request 形态的 input 也能识别', () => {
  assert.equal(guard.urlOf(new URL('https://copilot.tencent.com/x')), 'https://copilot.tencent.com/x');
  assert.equal(guard.urlOf({ url: 'https://copilot.tencent.com/y' }), 'https://copilot.tencent.com/y');
  assert.equal(guard.urlOf(42), '');
});

/* ---------------------------------------------------------------- 安装/卸载 */

test('installFetchGuard 装上后可卸载，且不覆盖别人后装的 fetch', async () => {
  const original = globalThis.fetch;
  const { spy } = makeFetchSpy();
  globalThis.fetch = spy;

  try {
    const uninstall = guard.installFetchGuard({});
    const installedState = guard.guardState();
    assert.equal(installedState.installed, true);

    // 重复安装返回同一个 uninstall（不叠加包装）
    const uninstallAgain = guard.installFetchGuard({});
    assert.equal(uninstallAgain, uninstall);

    // 模拟别人在我们之后又换掉了 fetch
    const later = async () => new Response('later', { status: 200 });
    globalThis.fetch = later;
    uninstall();
    assert.equal(globalThis.fetch, later, '不得把别人后装的 fetch 还原掉');

    globalThis.fetch = spy;
    const u2 = guard.installFetchGuard({});
    u2();
    assert.equal(globalThis.fetch, spy);
    assert.equal(guard.guardState().installed, false);
  } finally {
    globalThis.fetch = original;
  }
});

/* ---------------------------------------------------------------- 配置 */

test('apply 在 enabled=false 时不装 fetch', () => {
  const original = globalThis.fetch;
  const effects = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      effects.push(fn);
    },
  };
  try {
    guard.apply(ctx, { enabled: false });
    assert.equal(globalThis.fetch, original);
    assert.equal(effects.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('apply 装好后 dispose 能还原', () => {
  const original = globalThis.fetch;
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      disposers.push(fn());
    },
  };
  try {
    guard.apply(ctx, { enabled: true, logPath: '' });
    assert.notEqual(globalThis.fetch, original);
    for (const d of disposers) d();
    assert.equal(globalThis.fetch, original);
  } finally {
    globalThis.fetch = original;
  }
});

/* ------------------------------------------- 第二个触发源：内核身份句

 * 官方 @deepseek-ai/dsh-system-prompt 默认 includeHarnessIdentity = true，
 * 会在 system 最前面放 "You are an AI agent powered by DeepSeek\u200B Harness."
 * 国内网关只在这一句位于消息开头时回 400 / 11128（放句中或尾部不拦）。
 * 实测改写法：空格换连字符，语义不变，网关放行。
 */

const IDENTITY = 'You are an AI agent powered by DeepSeek' + String.fromCharCode(0x200b) + ' Harness.';

test('hasIdentitySentence 只认消息开头的身份句', () => {
  assert.equal(guard.hasIdentitySentence(IDENTITY + ' Be concise.'), true);
  assert.equal(guard.hasIdentitySentence('You are an AI agent powered by DeepSeek Harness. go'), true);
  assert.equal(guard.hasIdentitySentence('   ' + IDENTITY), true, '前导空格仍应命中');
  assert.equal(guard.hasIdentitySentence(String.fromCharCode(0xfeff) + IDENTITY), true, '前导 BOM 仍应命中');
  assert.equal(guard.hasIdentitySentence('\n\n' + IDENTITY), true, '前导换行仍应命中');

  assert.equal(guard.hasIdentitySentence('Intro. ' + IDENTITY + ' Then more.'), false, '句中不拦，不该改');
  assert.equal(guard.hasIdentitySentence('xx. ' + IDENTITY), false, '尾部不拦，不该改');
  assert.equal(guard.hasIdentitySentence('You are an AI agent powered by DeepSeek Harness go'), false, '无句尾不拦');
  assert.equal(guard.hasIdentitySentence('You are a helpful assistant.'), false);
  assert.equal(guard.hasIdentitySentence(''), false);
  assert.equal(guard.hasIdentitySentence(null), false);
});

test('neutralizeIdentity 换成连字符写法且保留前导与后文', () => {
  assert.equal(
    guard.neutralizeIdentity(IDENTITY + ' Be concise.'),
    'You are an AI agent powered by DeepSeek-Harness. Be concise.',
  );
  assert.equal(
    guard.neutralizeIdentity('\n\n' + IDENTITY + ' tail'),
    '\n\nYou are an AI agent powered by DeepSeek-Harness. tail',
    '前导空白要保留',
  );
});

test('neutralizeIdentity 对不该改的文本返回原引用', () => {
  const noHit = 'You are a helpful assistant. Nothing to see.';
  assert.equal(guard.neutralizeIdentity(noHit), noHit, '未命中必须返回同一引用');
  const mid = 'Intro. ' + IDENTITY + ' Then more.';
  assert.equal(guard.neutralizeIdentity(mid), mid);
});

test('neutralizeIdentity 幂等', () => {
  const once = guard.neutralizeIdentity(IDENTITY + ' tail.');
  assert.equal(guard.neutralizeIdentity(once), once);
  assert.equal(guard.hasIdentitySentence(once), false);
});

test('rewriteJsonBody 同时处理两个触发源', () => {
  const raw = JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: true,
    max_tokens: 16,
    messages: [
      { role: 'system', content: IDENTITY + '\n\n' + KERNEL_PROMPT },
      { role: 'user', content: 'mail me at a@b.com' },
    ],
  });
  const out = guard.rewriteJsonBody(raw);
  assert.equal(out.changed, true);
  const parsed = JSON.parse(out.body);
  const sys = parsed.messages[0].content;
  assert.equal(guard.hasIdentitySentence(sys), false, '身份句要被中和');
  assert.equal(countAt(sys), 0, '两个 @ 都要处理');
  assert.equal(parsed.messages[1].content, 'mail me at a@b.com', 'user 消息一个字都不许动');
});

test('只有身份句没有 @ 时也会改写（早退条件不能只看 @）', () => {
  const raw = JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: true,
    messages: [
      { role: 'system', content: IDENTITY + ' Be concise.' },
      { role: 'user', content: 'hi' },
    ],
  });
  assert.equal(raw.includes('@'), false, '这个 body 里本来就没有 @');
  const out = guard.rewriteJsonBody(raw);
  assert.equal(out.changed, true, '没有 @ 也必须处理身份句');
  assert.equal(guard.hasIdentitySentence(JSON.parse(out.body).messages[0].content), false);
});

test('含身份句但 role=user 时不改', () => {
  const raw = JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: IDENTITY }],
  });
  const out = guard.rewriteJsonBody(raw);
  assert.equal(out.changed, false);
  assert.equal(out.body, raw);
});

test('mode=all 时身份句仍然只按语义改，不破坏正文', () => {
  const raw = JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'system', content: IDENTITY + ' 联系 a@b.com' }],
  });
  const parsed = JSON.parse(guard.rewriteJsonBody(raw, 'all').body);
  const sys = parsed.messages[0].content;
  assert.equal(guard.hasIdentitySentence(sys), false);
  assert.equal(countAt(sys), 0, 'mode=all 会把正文里的 @ 也换掉，这是既定行为');
});

/* ------------------------------------------------------------------ assistant 角色 */

test('assistant 消息里的整段指纹也要处理（实测网关会扫 assistant）', () => {
  const raw = JSON.stringify({
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Sure. ' + KERNEL_PROMPT + ' More.' },
      { role: 'user', content: 'again' },
    ],
  });
  const out = guard.rewriteJsonBody(raw);
  assert.equal(out.changed, true, 'assistant 里的指纹必须被处理，否则整轮 400');
  const asst = JSON.parse(out.body).messages[2].content;
  assert.equal(countAt(asst), 0);
  assert.ok(asst.startsWith('Sure. '), '前缀不能被动');
  assert.ok(asst.endsWith(' More.'), '后缀不能被动');
});

test('assistant 开头的身份句同样要被中和', () => {
  const raw = JSON.stringify({
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: IDENTITY + ' Sure.' },
      { role: 'user', content: 'again' },
    ],
  });
  const out = guard.rewriteJsonBody(raw);
  assert.equal(out.changed, true);
  assert.equal(guard.hasIdentitySentence(JSON.parse(out.body).messages[2].content), false);
});

test('tool 消息里的指纹不改（实测网关不扫 tool）', () => {
  const raw = JSON.stringify({
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: KERNEL_PROMPT },
    ],
  });
  assert.equal(guard.rewriteJsonBody(raw).changed, false);
});

test('裸 @" 不触发网关，所以绝不能改（会弄坏 PowerShell here-string）', () => {
  const ps = '$c = @"\nGet-ChildItem\n"@';
  const raw = JSON.stringify({ messages: [{ role: 'assistant', content: ps }] });
  const out = guard.rewriteJsonBody(raw);
  assert.equal(out.changed, false, 'here-string 必须原样透传');
  assert.equal(out.body, raw);
});

/* ============================================ 四处身份指纹（v0.1.5 起）
 *
 * 来自 a1141171521/dsh-multi-agent-gateway#1 的真实失败：对方机器上 DSH 的
 * system prompt 里同时有四段带身份的句子，网关命中任意一句就回 400 / 11128。
 * v0.1.4 只处理 #1 和 #4，所以那台机器必挂。
 *
 * 四段的出处（全部是官方内核默认就会发出的文本，不是用户写的）：
 *   #1 @deepseek-ai/dsh-system-prompt        lib/index.js:231  （includeHarnessIdentity 默认 true）
 *   #2 @deepseek-ai/dsh-web-app              cordis.patch.yml:19-20（personaPrefix）
 *   #3 @deepseek-ai/dsh-harness-dev-context  lib/index.js:29    （WEB_SURFACE_PROMPT）
 *   #4 @deepseek-ai/dsh-file-reference       lib/index.js:54    （FILE_REFERENCE_PROMPT）
 */

const ZW = String.fromCharCode(0x200b);

/** #1 的原文。DeepSeek 与 Harness 之间是 U+200B，不是普通空格。 */
const FP_IDENTITY = 'You are an AI agent powered by DeepSeek' + ZW + ' Harness.';

/** #2 的原文。模型名由内核插值，这里覆盖国内常见的两个。 */
const FP_PERSONA_CN = 'You are a coding agent powered by the workbuddy/hy4-preview model.';
const FP_PERSONA_INTL = 'You are a coding agent powered by the workbuddy-intl/deepseek-v4.1-flash model.';

/** #3 的原文（长句，只取开头可判定的部分做断言）。 */
const FP_WEB_SURFACE =
  'You are interacting with the user through the DeepSeek' +
  ZW +
  ' Harness Web GUI whose URL the runtime context names.';

/** #3 的同插件运行时上下文。 */
const FP_WEB_URL = 'Current DeepSeek' + ZW + ' Harness Web GUI URL: "http://127.0.0.1:43120".';

test('#2 personaPrefix 被改写，且模型名原样保留', () => {
  const out = guard.neutralizeFingerprints(FP_PERSONA_CN);
  assert.notEqual(out, FP_PERSONA_CN, '这一句必须被改，否则对方机器上必挂');
  assert.equal(/coding agent powered by/i.test(out), false, '网关认的是这个句式');
  assert.ok(out.includes('workbuddy/hy4-preview'), '模型名本身网关不拦，不该动');
  assert.ok(out.includes('coding agent'), '保持可读，不当垃圾删');
});

test('#2 国际版模型名同样被改写', () => {
  const out = guard.neutralizeFingerprints(FP_PERSONA_INTL);
  assert.equal(/coding agent powered by/i.test(out), false);
  assert.ok(out.includes('workbuddy-intl/deepseek-v4.1-flash'));
});

test('#3 WEB_SURFACE_PROMPT 被改写', () => {
  const out = guard.neutralizeFingerprints(FP_WEB_SURFACE);
  assert.notEqual(out, FP_WEB_SURFACE);
  assert.equal(/Harness Web GUI/.test(out), false, '品牌 + Web GUI 的组合是 #3 的指纹');
  assert.ok(out.includes('Web GUI'), '功能语义要保留');
});

test('#3 运行时 URL 上下文被改写', () => {
  const out = guard.neutralizeFingerprints(FP_WEB_URL);
  assert.notEqual(out, FP_WEB_URL);
  assert.equal(/Harness Web GUI/.test(out), false);
  assert.ok(out.includes('127.0.0.1:43120'), 'URL 本体要保留');
});

test('四处身份指纹拼在一起时全部被清，且不留 U+200B', () => {
  const all = [FP_IDENTITY, FP_PERSONA_CN, FP_WEB_SURFACE, FP_WEB_URL].join('\n\n');
  const out = guard.neutralizeFingerprints(all);
  assert.equal(out.includes(ZW), false, '零宽空格必须一个不剩');
  assert.equal(/coding agent powered by/i.test(out), false);
  assert.equal(/Harness Web GUI/.test(out), false);
});

test('身份改写与 @ 改写是两条独立路径，走 rewriteJsonBody 时两者都生效', () => {
  const raw = JSON.stringify({
    messages: [
      { role: 'system', content: [FP_IDENTITY, FP_PERSONA_CN, FP_WEB_SURFACE, FP_WEB_URL, KERNEL_PROMPT].join('\n\n') },
      { role: 'user', content: 'hi' },
    ],
  });
  const out = guard.rewriteJsonBody(raw);
  assert.equal(out.changed, true);
  const sys = JSON.parse(out.body).messages[0].content;
  assert.equal(sys.includes(ZW), false, '零宽空格一个不剩');
  assert.equal(/coding agent powered by/i.test(sys), false);
  assert.equal(/Harness Web GUI/.test(sys), false);
  assert.equal(countAt(sys), 0, '@ 也一并处理');
});

test('对方机器那种 system prompt：只清 #2 #3 也必须能改（不能只认 #1 #4）', () => {
  const raw = JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: true,
    messages: [
      { role: 'system', content: FP_PERSONA_CN + '\n\n' + FP_WEB_SURFACE + '\n\n随便一段正文。' },
      { role: 'user', content: 'hi' },
    ],
  });
  assert.equal(raw.includes('@'), false, '这个 body 里一个 @ 都没有 —— 早退条件不能只看 @');
  const out = guard.rewriteJsonBody(raw);
  assert.equal(out.changed, true, 'v0.1.4 在这里会 return 未改动，正是对方必挂的原因');
  const sys = JSON.parse(out.body).messages[0].content;
  assert.equal(/coding agent powered by/i.test(sys), false);
  assert.equal(/Harness Web GUI/.test(sys), false);
  assert.ok(sys.includes('随便一段正文。'), '正文不能被牵连');
});

test('hasFingerprintText 能识别四处，且不误判普通文本', () => {
  assert.equal(guard.hasFingerprintText(FP_IDENTITY), true);
  assert.equal(guard.hasFingerprintText(FP_PERSONA_CN), true);
  assert.equal(guard.hasFingerprintText(FP_WEB_SURFACE), true);
  assert.equal(guard.hasFingerprintText(FP_WEB_URL), true);
  assert.equal(guard.hasFingerprintText(KERNEL_PROMPT), false, '@ 由另一条路径处理');
  assert.equal(guard.hasFingerprintText('You are a helpful assistant.'), false);
  assert.equal(guard.hasFingerprintText(''), false);
  assert.equal(guard.hasFingerprintText(null), false);
});

test('neutralizeFingerprints 对无关文本返回原引用', () => {
  const plain = 'Just some ordinary prompt text without any fingerprint.';
  assert.equal(guard.neutralizeFingerprints(plain), plain);
});

test('neutralizeFingerprints 幂等', () => {
  const once = guard.neutralizeFingerprints(FP_IDENTITY + '\n' + FP_PERSONA_CN + '\n' + FP_WEB_SURFACE);
  assert.equal(guard.neutralizeFingerprints(once), once);
});

test('中性化不破坏正文里的普通 DeepSeek/Harness 词', () => {
  const text = '用户问的是 DeepSeek 这个模型本身，以及 Harness 这个词的含义。';
  const out = guard.neutralizeFingerprints(text);
  assert.equal(out, text, '两个词分开出现、中间没有零宽空格，不该被当成品牌指纹');
});
