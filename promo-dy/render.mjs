import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = 'C:\\Users\\罗雨\\Documents\\deepseek-harness\\default-workspace\\wb400-guard\\promo-dy';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const outDir = path.join(dir, 'out');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const slides = process.argv.slice(2).length ? process.argv.slice(2) : ['01','02','03','04','05','06'];
const results = [];

for (const id of slides) {
  const html = path.join(dir, `${id}.html`);
  const png = path.join(outDir, `${id}.png`);
  if (existsSync(png)) rmSync(png, { force: true });
  try {
    execFileSync(edge, [
      '--headless', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--screenshot=${png}`,
      '--window-size=1080,1440',
      '--virtual-time-budget=4000',
      '--default-background-color=00000000',
      pathToFileURL(html).href,
    ], { stdio: 'ignore', timeout: 60000 });
  } catch (e) {
    // headless edge often exits non-zero even on success; check the file
  }
  const ok = existsSync(png);
  results.push({ id, ok, bytes: ok ? statSync(png).size : 0 });
}

for (const r of results) {
  console.log(`${r.id}  ${r.ok ? 'OK  ' + r.bytes + ' bytes' : 'FAIL'}`);
}
const bad = results.filter(r => !r.ok || r.bytes < 20000);
process.exit(bad.length ? 1 : 0);
