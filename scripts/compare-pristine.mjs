// 比对：原始备份里的 FILE_REFERENCE_PROMPT 究竟是什么（码点级，避开终端 @ 渲染）
import { readFileSync } from 'node:fs';

const files = {
  '原始备份': 'C:/Users/罗雨/.dsh/profiles/desktop/node_modules/dsh-workbuddy-connect/lib/host-heartbeat-vU86u9aU.js.bak-wb400-20261029-231736',
  '当前补丁': 'C:/Users/罗雨/.dsh/profiles/desktop/node_modules/dsh-workbuddy-connect/lib/host-heartbeat-vU86u9aU.js',
  '内核': 'D:/dsh2/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-file-reference/lib/index.js',
};

for (const [label, path] of Object.entries(files)) {
  let s;
  try {
    s = readFileSync(path, 'utf8');
  } catch (e) {
    console.log(`${label}: 读取失败 ${e.code}`);
    continue;
  }
  const m = s.match(/const FILE_REFERENCE_PROMPT = "([^"]*)"/);
  const whole = s.match(/@/g) || [];
  const at = s.match(/\(at\)/g) || [];
  console.log(`\n--- ${label} ---`);
  console.log(`文件长度 ${s.length}  全文件 U+0040=${whole.length}  "(at)"=${at.length}`);
  if (m) {
    const v = m[1];
    console.log(`常量长度 ${v.length}  常量内 U+0040=${(v.match(/@/g) || []).length}  "(at)"=${(v.match(/\(at\)/g) || []).length}`);
    const idx = [];
    for (let i = 0; i < v.length; i += 1) if (v.charCodeAt(i) === 0x40) idx.push(i);
    console.log(`@ 出现在常量内位置: [${idx.join(', ')}]`);
    console.log(`开头 60 字符码点: ${[...v.slice(0, 60)].map((c) => c.charCodeAt(0)).join(',')}`);
  } else {
    console.log('未匹配到 const FILE_REFERENCE_PROMPT 声明');
  }
}
