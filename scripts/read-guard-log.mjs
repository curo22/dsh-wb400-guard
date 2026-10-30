// 读 guard 的日志，看真实流量有没有被改写。
//
//   node scripts/read-guard-log.mjs
//   node scripts/read-guard-log.mjs --tail 30
//
// 日志默认在 ~/.dsh/logs/dsh-wb400-guard.jsonl，每行一个 JSON 事件：
//   installed    插件装上
//   uninstalled  插件卸下
//   rewritten    真的改写了一次（真实 CN 对话被救回）
//   passedThrough 放过去了（非防护 host，或 body 里没有 @）
//
// 用 Node 读而不是 PowerShell 的 Get-Content：中文用户名下 Get-Content 会把
// UTF-8 当 GBK 显示成乱码。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
const logPath = join(home, 'logs', 'dsh-wb400-guard.jsonl');

const tailArg = process.argv.indexOf('--tail');
const tail = tailArg > -1 ? Number(process.argv[tailArg + 1]) || 10 : 10;

console.log('日志路径:', logPath);
if (!existsSync(logPath)) {
  console.log('文件不存在 —— 插件还没在本机运行过，或者你禁用了它。');
  console.log('装上并重启 DSH 后，这个文件会自动出现。');
  process.exit(0);
}

const raw = readFileSync(logPath, 'utf8');
const lines = raw.split('\n').filter(Boolean);

const counts = Object.create(null);
const bad = [];
for (const line of lines) {
  try {
    const rec = JSON.parse(line);
    counts[rec.event] = (counts[rec.event] ?? 0) + 1;
  } catch {
    bad.push(line.slice(0, 120));
  }
}

console.log('总行数:', lines.length);
console.log('事件统计:', JSON.stringify(counts));
if (bad.length) console.log('无法解析的行:', bad.length);

const rewritten = counts.rewritten ?? 0;
console.log('');
if (rewritten > 0) {
  console.log(`真实流量被改写了 ${rewritten} 次 —— 说明修复在工作。`);
} else {
  console.log('还没有 rewritten 事件。');
  console.log('可能是：最近没走国内网关、body 里本来就没有 @、或者插件没被加载。');
  console.log('确认插件加载：宿主日志里搜 dsh-wb400-guard，应有 "fetch guard installed"。');
}

if (lines.length) {
  console.log('');
  console.log(`最近 ${Math.min(tail, lines.length)} 条：`);
  for (const line of lines.slice(-tail)) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const { at, event, ...rest } = rec;
    const detail = Object.keys(rest).length ? JSON.stringify(rest) : '';
    console.log(`  ${at}  ${String(event).padEnd(14)} ${detail}`);
  }
}
