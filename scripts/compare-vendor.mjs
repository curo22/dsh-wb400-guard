// 逐文件哈希比对仓库与 profile 里的 vendor 副本，只比 install.mjs 会拷的那些。
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const [repo, vend] = process.argv.slice(2);

const ENTRIES = [
  'lib',
  'cordis.patch.yml',
  'package.json',
  'README.md',
  'LICENSE',
  'test',
  'scripts',
  'verify-live.mjs',
  'install.mjs',
];

const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

function collect(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else {
        out.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  for (const name of ENTRIES) {
    const full = join(root, name);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(full);
    else out.push(name);
  }
  return out;
}

const files = collect(repo).sort();
let same = 0;
const diff = [];
const missing = [];

for (const file of files) {
  const a = join(repo, file);
  const b = join(vend, file);
  if (!existsSync(b)) {
    missing.push(file);
    continue;
  }
  if (hash(a) === hash(b)) same += 1;
  else diff.push(file);
}

console.log('应拷贝文件数:', files.length);
console.log('一致:', same);
console.log('内容不同:', diff.length === 0 ? '0' : `${diff.length} → ${diff.join(', ')}`);
console.log('vendor 缺失:', missing.length === 0 ? '0' : `${missing.length} → ${missing.join(', ')}`);
console.log(same === files.length ? '\n结论：vendor 与仓库完全一致。' : '\n结论：存在差异，重跑 install.mjs。');
