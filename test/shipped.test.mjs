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

test('只改 system / developer，user 里的 @ 不动', () => {
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
  assert.equal(parsed.messages[2].content, 'ok @you');
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
