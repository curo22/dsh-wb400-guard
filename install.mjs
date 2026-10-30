#!/usr/bin/env node
// 一键把 dsh-wb400-guard 装进本机 DSH profile。
//
//   node install.mjs                     装到 %USERPROFILE%\.dsh\profiles\desktop
//   node install.mjs <profile 目录>       装到指定 profile
//   node install.mjs --uninstall         从 profile 移除
//
// 全程用 Node 的 fs 读写，不经过 PowerShell 的 ConvertTo-Json / Set-Content：
// 那套组合在中文用户名下会把 UTF-8 字节按 GBK 解一次再编码，把
// link:C:/Users/罗雨/... 写成 link:C:/Users/缃楅洦/...，还会给文件加 BOM，
// 让 DSH 的配置热重载直接报 SyntaxError。
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = 'dsh-wb400-guard';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const uninstall = argv.includes('--uninstall');
const profileArg = argv.find((a) => !a.startsWith('--'));

const profile = resolve(
  profileArg ??
    process.env.DSH_PROFILE_DIR ??
    join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'profiles', 'desktop'),
);

console.log(`插件源 : ${here}`);
console.log(`profile: ${profile}`);
console.log('');

if (!existsSync(join(profile, 'package.json'))) {
  console.error(`它不是一个 DSH profile 目录：${profile} 下没有 package.json。`);
  console.error('用 DSH_PROFILE_DIR 环境变量或第一个参数指定正确的 profile 路径。');
  process.exit(1);
}

const pkgPath = join(profile, 'package.json');
const vendorDir = join(profile, 'vendor', PKG);
const linkPath = join(profile, 'node_modules', PKG);

/* ------------------------------------------------------------ 读 manifest */

/** 读 profile 的 package.json，剥掉 BOM（有些编辑器会加）。 */
function readManifest() {
  const raw = readFileSync(pkgPath, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

/** 写回并回读自检：BOM 必须没有，中文依赖值必须原样。 */
function writeManifest(pkg) {
  const before = readManifest();
  const nonAsciiBefore = nonAsciiDeps(before);

  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  const bytes = readFileSync(pkgPath);
  if (bytes.slice(0, 3).toString('hex') === 'efbbbf') {
    throw new Error('写回后出现了 BOM，DSH 会解析失败。请手动检查 package.json。');
  }
  const after = JSON.parse(bytes.toString('utf8'));

  for (const [name, value] of nonAsciiBefore) {
    if (name === PKG) continue;
    if (after.dependencies?.[name] !== value) {
      throw new Error(
        `依赖 ${name} 的值被破坏了：\n  期望 ${value}\n  实际 ${after.dependencies?.[name]}`,
      );
    }
  }
  return { before, after };
}

function nonAsciiDeps(pkg) {
  return Object.entries(pkg.dependencies ?? {}).filter(([, v]) => /[^\x20-\x7e]/.test(v));
}

/* ---------------------------------------------------------------- 卸载 */

if (uninstall) {
  console.log('模式：卸载');
  const pkg = readManifest();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(pkgPath, `${pkgPath}.bak-${stamp}`);

  let changed = false;
  if (pkg.dependencies?.[PKG] !== undefined) {
    delete pkg.dependencies[PKG];
    changed = true;
  }
  const bundles = pkg.dsh?.profile?.bundles;
  if (Array.isArray(bundles) && bundles.includes(PKG)) {
    pkg.dsh.profile.bundles = bundles.filter((b) => b !== PKG);
    changed = true;
  }
  if (changed) writeManifest(pkg);

  if (existsSync(linkPath)) rmSync(linkPath, { recursive: true, force: true });
  if (existsSync(vendorDir)) rmSync(vendorDir, { recursive: true, force: true });

  console.log(`  已备份 package.json.bak-${stamp}`);
  console.log(`  依赖与 bundles 已清理：${changed}`);
  console.log(`  vendor 与 junction 已删除`);
  console.log('');
  console.log('卸载完成。重启 DSH Desktop 生效。');
  process.exit(0);
}

/* ---------------------------------------------------------------- 安装 */

// 1. 拷文件到 vendor
// 这份清单要与 scripts/compare-vendor.mjs 的同名常量保持一致，
// 否则「vendor 是否与仓库一致」的检查会误报。
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
mkdirSync(vendorDir, { recursive: true });
let copied = 0;
for (const entry of ENTRIES) {
  const from = join(here, entry);
  if (!existsSync(from)) continue;
  cpSync(from, join(vendorDir, entry), { recursive: true });
  copied += 1;
}
console.log(`1. 已拷贝 ${copied} 项到 ${vendorDir}`);

// 2. 登记到 package.json
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
copyFileSync(pkgPath, `${pkgPath}.bak-${stamp}`);
console.log(`2. 已备份 package.json.bak-${stamp}`);

const pkg = readManifest();
pkg.dependencies ??= {};
const previous = pkg.dependencies[PKG];
pkg.dependencies[PKG] = `file:./vendor/${PKG}`;

pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
const bundleAdded = !pkg.dsh.profile.bundles.includes(PKG);
if (bundleAdded) pkg.dsh.profile.bundles.push(PKG);

const { after } = writeManifest(pkg);
console.log(`   dependencies["${PKG}"]: ${previous ?? '(新增)'} → ${after.dependencies[PKG]}`);
console.log(`   bundles 追加: ${bundleAdded}   当前 ${after.dsh.profile.bundles.length} 项`);
console.log(`   BOM: 无   非 ASCII 依赖未被破坏: 是`);

// 3. 建 junction 让模块可解析
mkdirSync(dirname(linkPath), { recursive: true });
if (existsSync(linkPath)) rmSync(linkPath, { recursive: true, force: true });
try {
  symlinkSync(vendorDir, linkPath, 'junction');
  console.log(`3. 已建 junction → ${vendorDir}`);
} catch (error) {
  console.log(`3. 建软链失败：${error.message}`);
  console.log(`   Windows 手动执行：`);
  console.log(`     New-Item -ItemType Junction -Path "${linkPath}" -Target "${vendorDir}"`);
  console.log(`   macOS / Linux 手动执行：`);
  console.log(`     ln -s "${vendorDir}" "${linkPath}"`);
}

// 4. 跑产物自测
console.log('');
console.log('4. 自测：');
const result = spawnSync(process.execPath, ['--test', join(vendorDir, 'test', 'shipped.test.mjs')], {
  encoding: 'utf8',
});
for (const line of (result.stdout ?? '').split('\n')) {
  if (/^ℹ (tests|pass|fail)/.test(line)) console.log(`   ${line}`);
}
const ok = result.status === 0;
console.log(`   ${ok ? '全部通过' : '有失败项，先别重启，看上面的输出'}`);

console.log('');
if (ok) {
  console.log('安装完成。');
  console.log('重启 DSH Desktop 后，宿主日志里应该出现这一行：');
  console.log(`  [I] [${PKG}] [${PKG}] fetch guard installed for copilot.tencent.com`);
} else {
  console.log('安装未完成。凭上面的失败信息排查，或在 GitHub issues 反馈。');
}
process.exit(ok ? 0 : 1);
