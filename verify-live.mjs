#!/usr/bin/env node
// 对真实国内网关验证 dsh-wb400-guard（不碰宿主进程，用真实凭证打真实网关）。
//
// 前置：本机已登录 WorkBuddy 桌面版。
//   export WORKBUDDY_ELECTRON_BIN='<WorkBuddy 的 Electron 可执行文件>'
//   node verify-live.mjs
//
// 退出码：0 全部符合预期；1 有偏差（凭证过期 / 网关规则变了 / 环境不对）。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createGuardedFetch, DEFAULT_GUARDED_HOSTS, FILE_REFERENCE_PROMPT } from './lib/index.js';

const ENDPOINT = 'https://copilot.tencent.com/v2/chat/completions';
const MODEL = 'deepseek-v4.1-flash';

const countAt = (s) => [...s].filter((c) => c === '@').length;

/**
 * 触发器：内核原文前垫一段填充文本。
 *
 * 网关的判定跟字符位置有关 —— 原文单独发（system 长 411）通过，垫到 3000 字符左右
 * 才会稳定被拦。这里固定成 deterministic 的前缀，保证每次跑结果一致。
 */
function minimalTrigger() {
  return `${'filler text. '.repeat(200)}${FILE_REFERENCE_PROMPT}`;
}

/**
 * 从 profile 里取真实凭证。
 *
 * dsh-workbuddy-connect 的导出名被混淆成单字母，这里按实际映射取：
 *   m = WorkBuddyCredentialStore, S = CN_VARIANT（国际版是 x = AI_VARIANT）
 * 导出名变了就报清楚，不静默跳过。
 */
async function loadCredential() {
  const profile =
    process.env.DSH_PROFILE_DIR ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'desktop');

  const candidates = [
    join(profile, 'node_modules', 'dsh-workbuddy-connect', 'lib', 'host-heartbeat-vU86u9aU.js'),
    join(profile, 'node_modules', 'dsh-workbuddy-connect', 'lib', 'index.js'),
  ];
  const hb = candidates.find((p) => existsSync(p));
  if (!hb) {
    throw new Error(
      `找不到 dsh-workbuddy-connect。\n` +
        `已尝试：\n  ${candidates.join('\n  ')}\n` +
        `请把 DSH_PROFILE_DIR 指向装了该插件的 profile。`,
    );
  }

  const mod = await import(pathToFileURL(hb).href);
  const Store = mod.m ?? mod.WorkBuddyCredentialStore;
  const Variant = mod.S ?? mod.CN_VARIANT;
  if (typeof Store !== 'function') {
    throw new Error(`${hb} 里没有找到凭证仓库类（试过 m / WorkBuddyCredentialStore）。`);
  }
  return new Store({ variant: Variant }).resolve();
}

function headersFor(credential) {
  return {
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
}

function buildBody(system) {
  return {
    model: MODEL,
    // 国内网关不接受非流式：stream:false 会回 11101，别误判成 11128。
    stream: true,
    max_tokens: 16,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: 'reply with the single word: ok' },
    ],
  };
}

function classify(res) {
  if (res.status === 200) return '200 PASS';
  if (res.text.includes('11128')) return '400 BLOCKED(11128)';
  if (res.text.includes('11101')) return '400 11101(非流式)';
  return `400 OTHER`;
}

async function main() {
  console.log('=== 准备 ===');
  const credential = await loadCredential();
  console.log('账号 uid :', credential.uid);
  console.log('账号域   :', credential.domain, '（决定走国内还是国际路由）');
  console.log('防护 host:', JSON.stringify(DEFAULT_GUARDED_HOSTS));

  const system = minimalTrigger();
  console.log('system 长度:', system.length, ' @ 数:', countAt(system));
  console.log('');

  const guarded = createGuardedFetch({ fetchImpl: globalThis.fetch, mode: 'anchor' });

  const send = async (useGuard) => {
    const init = {
      method: 'POST',
      headers: headersFor(credential),
      body: JSON.stringify(buildBody(system)),
    };
    const res = useGuard ? await guarded.fetch(ENDPOINT, init) : await globalThis.fetch(ENDPOINT, init);
    const text = await res.text();
    return { status: res.status, text };
  };

  const raw = await send(false);
  const fixed = await send(true);

  const rows = [
    ['经插件前（预期被拦）', classify(raw), raw.text.includes('11128')],
    ['经插件后（预期通过）', classify(fixed), fixed.status === 200],
  ];

  console.log('=== 结果 ===');
  for (const [label, got, ok] of rows) {
    console.log(`${label.padEnd(22)} ${got.padEnd(20)} ${ok ? 'OK' : 'FAIL'}`);
  }
  console.log('');
  console.log('guard 统计:', JSON.stringify(guarded.stats));

  const allOk = rows.every(([, , ok]) => ok);
  if (!allOk) {
    console.log('');
    console.log('偏差说明：');
    if (raw.status === 200) {
      console.log('  原样请求也通过了 —— 网关当前不再因 @ 拦截。插件此时空转，不影响功能。');
    } else if (!raw.text.includes('11128')) {
      console.log('  原样请求既没被拦也没通过。原始返回：');
      console.log('  ', raw.text.slice(0, 300));
    }
    if (fixed.status !== 200) {
      console.log('  经插件后仍然失败。原始返回：');
      console.log('  ', fixed.text.slice(0, 300));
    }
  }
  return allOk ? 0 : 1;
}

process.exit(await main());
