// 端到端模拟 DSH 真实链路：原版插件 prepareCnChatBody → guard 改写 → 真实国内网关。
// 这是「插件不手改 + guard 单独承担」这个组合的最终验收。
//
//   $env:WORKBUDDY_ELECTRON_BIN='D:\wkbd cn\WorkBuddy\WorkBuddyAI.exe'
//   node scripts/verify-pipeline.mjs
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createGuardedFetch, FILE_REFERENCE_PROMPT } from '../lib/index.js';

const profile = process.env.DSH_PROFILE_DIR ?? join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop');
const hb = join(profile, 'node_modules', 'dsh-workbuddy-connect', 'lib', 'host-heartbeat-vU86u9aU.js');
const mod = await import(pathToFileURL(hb).href);
const { m: Store, S: CN_VARIANT, F: prepareCnChatBody } = mod;

const credential = await new Store({ variant: CN_VARIANT }).resolve();
console.log('账号域:', credential.domain);

// 原版插件是否已被还原（不该再有内容改写）
const src = await import('node:fs').then((fs) => fs.readFileSync(hb, 'utf8'));
console.log('插件内是否残留 neutralizeFileReferencePrompt:', src.includes('neutralizeFileReferencePrompt'));

// 模拟 pi-ai 折叠后的 messages：首条 system 含内核原文 + 一条 user
const systemText = `You are DSH agent.\n\n${FILE_REFERENCE_PROMPT}\n\nSome other instructions.`;
const piBody = {
  model: 'deepseek-v4.1-flash',
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 32,
  messages: [
    { role: 'system', content: systemText },
    { role: 'user', content: 'reply with the single word: ok' },
  ],
};

// 插件原版处理
const prepared = prepareCnChatBody(JSON.stringify(piBody));
const atAfterPrepare = [...prepared].filter((c) => c.codePointAt(0) === 64).length;
console.log('prepareCnChatBody 后 @ 数:', atAfterPrepare, '（应 > 0，说明插件没改）');

const headers = {
  Authorization: `Bearer ${credential.accessToken}`,
  'Content-Type': 'application/json',
  'X-User-Id': credential.uid,
  'X-Domain': credential.domain,
  'X-IDE-Type': 'WorkBuddy',
  'X-IDE-Name': 'WorkBuddy',
  'X-IDE-Version': '1.0.0',
  'X-Product': 'SaaS',
  'User-Agent': 'WorkBuddy/1.0.0 WorkBuddy/1.0.0',
};
const url = 'https://copilot.tencent.com/v2/chat/completions';

async function send(fetchImpl, label) {
  const res = await fetchImpl(url, { method: 'POST', headers, body: prepared });
  let head = '';
  if (res.body) {
    const r = res.body.getReader();
    const { value } = await r.read();
    r.cancel().catch(() => {});
    if (value) head = new TextDecoder().decode(value);
  }
  const code = (head.match(/"code"\s*:\s*(\d+)/) ?? [])[1] ?? '-';
  console.log(`  ${label.padEnd(24)} status=${res.status}  code=${code}  ${head.slice(0, 50).replace(/\s+/g, ' ')}`);
  return res.status;
}

console.log('\n=== 发送 ===');
const before = await send(globalThis.fetch, '插件原版·无 guard');

const guard = createGuardedFetch({ fetchImpl: globalThis.fetch, mode: 'anchor' });
const after = await send(guard.fetch, '插件原版+guard');

console.log('  guard 统计:', JSON.stringify(guard.stats));
const ok = before === 400 && after === 200 && guard.stats.rewritten === 1;
console.log('');
console.log(ok ? '结论：插件保持原版，guard 在 fetch 层独立解决，链路通。' : '结论：不符预期。');
process.exit(ok ? 0 : 1);
