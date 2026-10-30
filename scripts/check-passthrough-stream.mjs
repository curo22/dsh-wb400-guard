// 验证 guard 对非 CN host 完全不干预，且包了 guard 之后流式响应仍能逐块读取。
//
// 这里用本地 HTTP 服务当被测上游，而不是打真实国际网关：
// 要证明的是「guard 不碰非 CN host + 不破坏流式读取」，与上游是谁无关。
// 真实 CN 网关的改写效果由 verify-live.mjs 负责（那里有真实凭证）。
//
//   node scripts/check-passthrough-stream.mjs
import { createServer } from 'node:http';

import { installFetchGuard, guardState } from '../lib/index.js';

// 内核原文：两处 U+0040。放在 system 里，用来检查 guard 有没有偷偷改写非 CN host。
const KERNEL_PROMPT =
  'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; ' +
  'absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its ' +
  'contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have ' +
  'inspected it before reading. @"..." quotes a path containing spaces.';
console.log(`测试用 system 文本 ${KERNEL_PROMPT.length} 字符，含 @ ${(KERNEL_PROMPT.match(/@/g) || []).length} 处`);

// ---- 本地上游：记录收到的 body，回一条 3 块的 SSE 流 ----
let received = null;
const upstream = createServer((req, res) => {
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => {
    received = Buffer.concat(parts).toString('utf8');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const port = upstream.address().port;
const url = `http://127.0.0.1:${port}/v2/chat/completions`;
console.log('本地上游:', url);

// ---- 装 guard ----
const originalFetch = globalThis.fetch;
const uninstall = installFetchGuard({ mode: 'anchor' });
console.log('guard 已装:', guardState().installed);
console.log('fetch 已替换:', globalThis.fetch !== originalFetch);

// ---- 打过去：host 不在 guardedHosts 里，必须原样透传 ----
const body = JSON.stringify({
  model: 'any-model',
  stream: true,
  max_tokens: 32,
  messages: [
    { role: 'system', content: `You are a concise assistant.\n\n${KERNEL_PROMPT}` },
    { role: 'user', content: 'Say OK.' },
  ],
});
const sentAt = (body.match(/@/g) || []).length;

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
});

console.log('status:', res.status);
let chunks = 0;
const texts = [];
if (res.body) {
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    chunks += 1;
    texts.push(decoder.decode(chunk).replace(/\n/g, '\\n'));
  }
}
console.log('chunk 数:', chunks);
console.log('收到的流内容:', texts.join(' | '));

const stats = guardState().stats;
console.log('guard 统计:', JSON.stringify(stats));

// ---- 上游实际收到的 body 必须与发出去的一字不差 ----
const sameBody = received === body;
const atAfter = (received.match(/@/g) || []).length;

uninstall();
console.log('已卸载，fetch 还原:', globalThis.fetch === originalFetch);

const streamText = texts.join('');
const checks = [
  ['状态 200', res.status === 200],
  // 响应体很小，undici 会把多次 write 合并成一两个 chunk 交付，这里只要求「能读到流」。
  ['读到流式数据', chunks >= 1 && streamText.length > 0],
  ['两段增量都在', streamText.includes('"he"') && streamText.includes('"llo"')],
  ['收到结束标记', streamText.includes('[DONE]')],
  ['未改写（rewritten=0）', stats.rewritten === 0],
  ['按放行计数（passedThrough=1）', stats.passedThrough === 1],
  ['上游收到的 body 与发出的一致', sameBody],
  [`@ 全部保留（${sentAt} → ${atAfter}）`, sentAt === atAfter && sentAt === 2],
  ['fetch 已还原', globalThis.fetch === originalFetch],
];

upstream.close();

console.log('');
for (const [label, ok] of checks) console.log(`${ok ? '✔' : '✗'} ${label}`);
const pass = checks.every(([, ok]) => ok);
console.log('');
console.log(pass ? '结论：非防护 host 原样透传，流式读取未受影响。' : '结论：有检查项未通过，需要排查。');
process.exit(pass ? 0 : 1);
