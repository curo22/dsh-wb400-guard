// 装完、重启后跑这一条，回答一个问题：修复此刻到底在不在工作。
//
//   node scripts/health-check.mjs
//   node scripts/health-check.mjs --host-log "<dsh host log 路径>"   # 自动找不到时手动指
//
// 只读，不改任何东西。零外部依赖。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileDir = process.env.DSH_PROFILE_DIR || join(dshHome, 'profiles', 'desktop');

const at = (s) => {
  if (!s) return '—';
  const d = new Date(s);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const line = (label, value) => console.log(`  ${String(label).padEnd(22)}${value}`);

/* ---------------------------------------------------------------- 1. 安装状态 */

let installedDep = null;
let listedBundle = false;
try {
  const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
  installedDep = pkg.dependencies?.['dsh-wb400-guard'] ?? null;
  listedBundle = Array.isArray(pkg.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes('dsh-wb400-guard');
} catch (error) {
  console.log(`读不到 profile 的 package.json：${error.message}`);
}

const shimPresent = existsSync(join(profileDir, 'vendor', 'dsh-wb400-guard', 'lib', 'index.js'))
  && existsSync(join(profileDir, 'node_modules', 'dsh-wb400-guard'));

/* ---------------------------------------------------------------- 2. guard 日志 */

const guardLog = join(dshHome, 'logs', 'dsh-wb400-guard.jsonl');
let installs = [];
let rewrites = [];
if (existsSync(guardLog)) {
  const rows = readFileSync(guardLog, 'utf8').split('\n').filter(Boolean);
  const events = [];
  for (const row of rows) {
    try {
      events.push(JSON.parse(row));
    } catch {
      /* 单行坏掉不影响整体 */
    }
  }
  installs = events.filter((e) => e.event === 'installed');
  const lastInstallAt = installs.length > 0 ? installs[installs.length - 1].at : null;
  rewrites = events.filter((e) => e.event === 'rewritten' && (!lastInstallAt || e.at >= lastInstallAt));
}

const lastInstall = installs.length > 0 ? installs[installs.length - 1] : null;

/* ---------------------------------------------------------------- 3. 宿主日志 */

function hostLogDir() {
  const manual = argOf('--host-log');
  if (manual) return manual;
  const roots = [
    join(process.env.APPDATA || '', 'DSH Desktop', 'logs', 'host'),
    join(homedir(), 'Library', 'Application Support', 'DSH Desktop', 'logs', 'host'),
    join(homedir(), '.config', 'DSH Desktop', 'logs', 'host'),
  ];
  return roots.find((p) => p && existsSync(p)) || null;
}

function loadHostLines() {
  const dir = hostLogDir();
  if (!dir) return { dir: null, lines: [] };
  if (statSync(dir).isFile()) return { dir, lines: readFileSync(dir, 'utf8').split('\n') };
  const files = readdirSync(dir).filter((f) => f.endsWith('.log')).sort().slice(-3);
  const lines = [];
  for (const file of files) {
    lines.push(...readFileSync(join(dir, file), 'utf8').split('\n'));
  }
  return { dir, lines };
}

const host = loadHostLines();
const installLines = host.lines.filter((l) => l.includes('[dsh-wb400-guard]') && l.includes('fetch guard installed'));
const blockedLines = host.lines.filter((l) => /11128|请求被拦截/.test(l));
const lastInstallLine = installLines.length > 0 ? installLines[installLines.length - 1] : null;
const hostInstallAt = lastInstallLine ? (lastInstallLine.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)/)?.[1] ?? null) : null;
const blockedAfterInstall = hostInstallAt
  ? blockedLines.filter((l) => (l.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)/)?.[1] ?? '') >= hostInstallAt)
  : blockedLines;

/* ------------------------------------------------- 3b. 有没有别处手改过插件的痕迹 */

// 早期修法是直接改 dsh-workbuddy-connect 的源码。那份改动会先于本插件把 @ 换掉，
// 结果本插件看不到 @、改写计数永远是 0，而用户以为没生效。
// 这里只做识别，不动任何文件。
const HANDMARKERS = [
  'neutralizeFileReferencePrompt',
  'CN_FILE_REFERENCE_PROMPT',
  'repairChannelRejection',
  'wireLog',
];

function scanHandPatches() {
  const dir = join(profileDir, 'node_modules', 'dsh-workbuddy-connect', 'lib');
  if (!existsSync(dir)) return { dir, found: [] };
  const found = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.js')) continue;
    let text;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const hits = HANDMARKERS.filter((m) => text.includes(m));
    if (hits.length > 0) found.push({ name, hits });
  }
  return { dir, found };
}

const handPatches = scanHandPatches();

/* ---------------------------------------------------------------- 4. wire log（可选） */

const wireLog = join(dshHome, '.workbuddy-wire.log');
let cnRequests = null;
if (existsSync(wireLog)) {
  cnRequests = 0;
  for (const row of readFileSync(wireLog, 'utf8').split('\n')) {
    if (!row) continue;
    try {
      const r = JSON.parse(row);
      if (r.event === 'request' && r.region === 'cn') cnRequests += 1;
    } catch {
      /* ignore */
    }
  }
}

/* ---------------------------------------------------------------- 报告 */

console.log('=== 安装 ===');
line('profile', profileDir);
line('dependencies 条目', installedDep ?? '（缺失）');
line('bundles 里已登记', listedBundle ? '是' : '否');
line('vendor + junction', shimPresent ? '在' : '缺（重跑 install.mjs）');

console.log('\n=== 插件加载 ===');
line('guard 日志', existsSync(guardLog) ? guardLog : '（还没有，说明插件没跑起来）');
line('最近一次安装', lastInstall ? `${at(lastInstall.at)}  hosts=${(lastInstall.hosts || []).join(',')}` : '（无记录）');
line('宿主日志确认行', lastInstallLine ? lastInstallLine.trim().slice(0, 96) : '（无，说明宿主没加载插件）');

console.log('\n=== 实际改写 ===');
line('本次安装后改写', rewrites.length === 0 ? '0 次' : `${rewrites.length} 次`);if (rewrites.length > 0) {
  const last = rewrites[rewrites.length - 1];
  line('最近一次', `${at(last.at)}  bytesIn=${last.bytesIn ?? '-'}  mode=${last.mode ?? '-'}`);
}
if (cnRequests !== null) line('wire log 国内请求', `${cnRequests} 条`);

console.log('\n=== 别处的手改 ===');
if (!existsSync(handPatches.dir)) {
  line('dsh-workbuddy-connect', '没装，跳过');
} else if (handPatches.found.length === 0) {
  line('dsh-workbuddy-connect', '干净，没有手改痕迹');
} else {
  for (const f of handPatches.found) {
    line(f.name, `含 ${f.hits.join(' / ')}`);
  }
  console.log('  这份手改会先于本插件把 @ 换掉，本插件的改写计数因此恒为 0。');
  console.log('  两个办法：留着它（功能重叠但不冲突），或者重装插件恢复原版后重跑 install.mjs。');
}

console.log('\n=== 拦截 ===');
line('宿主日志 11128', blockedLines.length === 0 ? '0 条' : `共 ${blockedLines.length} 条`);
line('其中安装之后', blockedAfterInstall.length === 0 ? '0 条' : `${blockedAfterInstall.length} 条（修复没生效）`);

/* ---------------------------------------------------------------- 结论 */

console.log('\n=== 结论 ===');
if (!installedDep || !listedBundle || !shimPresent) {
  console.log('  没装好。重跑 install.mjs，然后完全退出 DSH Desktop 再打开。');
} else if (!lastInstall && !lastInstallLine) {
  console.log('  装是装了，宿主还没加载。完全退出 DSH Desktop 再打开，不要只关窗口。');
} else if (blockedAfterInstall.length > 0) {
  console.log('  加载了但没拦住。跑 node verify-live.mjs 看插件本身是否有效；');
  console.log('  有效的话把配置里的 mode 改成 all 再试。');
} else if (handPatches.found.length > 0) {
  console.log('  插件就位，但 dsh-workbuddy-connect 里还有手改补丁，它抢先一步把 @ 换掉了。');
  console.log('  所以本插件 0 次改写是正常的，不是没生效 —— 修复在别处完成，功能等价。');
  console.log('  想让这个插件接管：把 dsh-workbuddy-connect 恢复原版，再跑 node install.mjs 重启。');
} else if (rewrites.length > 0) {
  console.log('  修复在工作：已经实际改写并放行过请求，安装后没有新的 11128。');
} else if (cnRequests === 0) {
  console.log('  已就绪，但还没有国内路由的流量经过。用国内版模型发一条消息后再跑一次。');
} else {
  console.log('  宿主已装好、也没有新的 11128，但改写计数是 0。两种可能：');
  if (handPatches.found.length === 0 && existsSync(handPatches.dir)) {
    console.log('  1. 磁盘上的插件已经是原版，但正在跑的进程是更早启动的，内存里还留着旧的');
    console.log('     手改代码，它先把 @ 换掉了。完全退出 DSH Desktop 再打开，本插件就接管。');
  } else {
    console.log('  1. 请求到 fetch 时已经没有 @ 了，上游有别的环节先处理过。');
  }
  console.log('  2. 网关不再因为 @ 拦截 —— 跑 node verify-live.mjs，若「原样」那行也通过即属此类，');
  console.log('     插件处于空转，不影响使用。');
}
