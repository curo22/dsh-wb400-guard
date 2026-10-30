// 在混淆插件文件里定位 "Tokens prefixed" 附近的原文，逐字打印码点（避开终端渲染）
import { readFileSync } from 'node:fs';

const files = {
  '原始备份': 'C:/Users/罗雨/.dsh/profiles/desktop/node_modules/dsh-workbuddy-connect/lib/host-heartbeat-vU86u9aU.js.bak-wb400-20261029-231736',
  '当前补丁': 'C:/Users/罗雨/.dsh/profiles/desktop/node_modules/dsh-workbuddy-connect/lib/host-heartbeat-vU86u9aU.js',
};

for (const [label, path] of Object.entries(files)) {
  const s = readFileSync(path, 'utf8');
  console.log(`\n===== ${label} (${s.length} chars) =====`);
  let from = 0;
  let n = 0;
  for (;;) {
    const i = s.indexOf('Tokens prefixed', from);
    if (i < 0) break;
    n += 1;
    const seg = s.slice(i, i + 90);
    const ats = [];
    for (let k = 0; k < seg.length; k += 1) if (seg.charCodeAt(k) === 0x40) ats.push(k);
    console.log(`命中#${n} @偏移${i}`);
    console.log(`  片段: ${JSON.stringify(seg)}`);
    console.log(`  段内 U+0040 位置: [${ats.join(', ')}]`);
    console.log(`  前40码点: ${[...seg.slice(0, 40)].map((c) => c.charCodeAt(0)).join(',')}`);
    from = i + 1;
  }
  if (n === 0) console.log('无 "Tokens prefixed" 命中');
}
