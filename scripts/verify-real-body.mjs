// 最强验证：拿真实失败 body（154 KB，就是当初被拦的那一份）打真实国内网关，
// 一组原样发（预期 11128），一组经 vendor 里已安装的 guard 发（预期 200）。
//
//   $env:WORKBUDDY_ELECTRON_BIN='D:\wkbd cn\WorkBuddy\WorkBuddyAI.exe'
//   node scripts/verify-real-body.mjs
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createGuardedFetch } from '../lib/index.js';

const bodyPath = process.env.CN_FAIL_BODY ?? join(process.env.TEMP ?? '/tmp', 'cn_fail_body.json');
if (!existsSync(bodyPath)) {
  console.log(`跳过：找不到真实失败 body ${bodyPath}`);
  process.exit(0);
}

const raw = readFileSync(bodyPath, 'utf8');
const parsed = JSON.parse(raw);
const msgCount = Array.isArray(parsed.messages) ? parsed.messages.length : 0;
const toolCount = Array.isArray(parsed.tools) ? parsed.tools.length : 0;
let atInSystem = 0;
for (const m of parsed.messages ?? []) {
  if (m.role !== 'system') continue;
  const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  for (const ch of text) if (ch.codePointAt(0) === 64) atInSystem += 1;
}
console.log('=== 真实失败 body ===');
console.log('路径:', bodyPath);
console.log('字节:', Buffer.byteLength(raw), ' 消息:', msgCount, ' 工具:', toolCount, ' system 内 @ 数:', atInSystem);

const profile = process.env.DSH_PROFILE_DIR ?? join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop');
const hb = join(profile, 'node_modules', 'dsh-workbuddy-connect', 'lib', 'host-heartbeat-vU86u9aU.js');
const { m: Store, S: CN_VARIANT } = await import(pathToFileURL(hb).href);
const credential = await new Store({ variant: CN_VARIANT }).resolve();
console.log('账号域:', credential.domain, '（region =', credential.domain.endsWith('workbuddy.ai') ? 'global' : 'cn', '）');

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
  const res = await fetchImpl(url, { method: 'POST', headers, body: raw });
  let text = '';
  // 只读前 400 字节，流式响应不必读完
  if (res.body) {
    const reader = res.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    if (value) text = new TextDecoder().decode(value);
  }
  let code = null;
  try {
    const j = JSON.parse(text);
    code = j.code ?? j.error?.code ?? null;
  } catch {
    const mm = text.match(/"code"\s*:\s*(\d+)/);
    code = mm ? Number(mm[1]) : null;
  }
  console.log(`  ${label.padEnd(26)} status=${res.status}  code=${code ?? '-'}  ${text.slice(0, 60).replace(/\s+/g, ' ')}`);
  return res.status;
}

console.log('\n=== 发送 ===');
const s1 = await send(globalThis.fetch, '原样（预期 400/11128）');

const guard = createGuardedFetch({ fetchImpl: globalThis.fetch, mode: 'anchor' });
const s2 = await send(guard.fetch, '经 guard（预期 200）');
console.log('  guard 统计:', JSON.stringify(guard.stats));

const ok = s1 === 400 && s2 === 200 && guard.stats.rewritten === 1;
console.log('');
console.log(ok ? '结论：真实失败 body 经插件改写后通过。' : '结论：不符预期，需要排查。');
process.exit(ok ? 0 : 1);
