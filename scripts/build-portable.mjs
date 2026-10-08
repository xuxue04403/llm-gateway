// build-portable.mjs — 打绿色免安装目录（解压即用，数据随目录走）
//
// 产物：out/LLM-Gateway/
//   LLM Gateway.exe          ← Electron 运行时（同时充当网关子进程的 Node 运行时）
//   resources/app/           ← 本程序源码（无 node_modules —— 运行时零外部依赖）
//   使用说明.txt
//
// 为什么用 `resources/app/` 目录而不是 `app.asar`：本程序**运行时零 npm 依赖**（全是 Node 内置
// 模块），因此不需要打包 asar；省掉 asar 也省掉"外部 node 子进程读不了 asar 内文件"那一类坑。
//
// 用法：node scripts/build-portable.mjs [输出目录名]
'use strict';

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const OUT_NAME = process.argv[2] || 'LLM-Gateway';
const OUT_DIR = path.join(ROOT, 'out', OUT_NAME);
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

if (!existsSync(ELECTRON_DIST)) {
  console.error('找不到 Electron 运行时：' + ELECTRON_DIST);
  console.error('请先执行 npm install（若 electron 的 postinstall 没跑，见 README 说明）。');
  process.exit(1);
}

const exeSrc = path.join(ELECTRON_DIST, 'electron.exe');
if (!existsSync(exeSrc)) {
  console.error('找不到 ' + exeSrc);
  process.exit(1);
}

console.log('打绿色目录：' + OUT_DIR);

// ⚠⚠ 重建前必须**保住 data\**。
//
// `OUT_DIR` 就是绿色版目录本身，而 `data\`（gateway.config.json / settings.json / logs\）
// 是**用户的实际运行状态** —— 供应商、API Key、模型映射全在里面。
// 旧实现直接 `rmSync(OUT_DIR)` 把 data\ 一并删掉，而下一次启动又会从"既有安装"导入一份
// **旧配置**，于是用户新加的供应商**静默消失**，看起来就像"配置自己变回去了"。
//
// 这不是理论风险：2026-10-08 我为了发版本连续重建了 4 次，把用户当天新增的 3 个供应商
// 删掉了，而且全盘找不到副本 —— 本脚本末尾那道"产物里绝不能有 data\"的闸门，
// 保证了 zip 里也没有。
//
// 现在：先把 data\ 暂存到一边，重建完原样放回；同时额外留一份带时间戳的副本兜底。
const dataDir = path.join(OUT_DIR, 'data');
const stashDir = path.join(ROOT, 'out', '.data-stash');
let stashed = false;
if (existsSync(dataDir)) {
  rmSync(stashDir, { recursive: true, force: true });
  cpSync(dataDir, stashDir, { recursive: true });
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    cpSync(dataDir, path.join(ROOT, 'out', `data-backup-${stamp}`), { recursive: true });
    console.log('  已额外备份 data\\（out\\data-backup-' + stamp + '）');
  } catch (e) {
    console.warn('  ⚠ 额外备份失败（不影响构建）：' + (e && e.message));
  }
  stashed = true;
  console.log('  已暂存 data\\（构建后原样放回，配置不会丢）');
}
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
// ⚠ `data\` 刻意**不在这里**放回。
// 它必须在"闸门校验 + 打 zip"**之后**才回来 —— 见文件末尾的说明。
// 早期版本在这里就放回，结果是：闸门看到 data\ 存在 → 中止打包 → **zip 永远生不出来**。
// （而这个闸门本身是对的：分发的压缩包里绝不能有用户的密钥。）

// 1) Electron 运行时（排除它自带的 default_app.asar —— 那是"没有 app 时"的占位页面）
let copied = 0;
for (const e of readdirSync(ELECTRON_DIST, { withFileTypes: true })) {
  if (e.name === 'default_app.asar') continue;
  cpSync(path.join(ELECTRON_DIST, e.name), path.join(OUT_DIR, e.name), { recursive: true });
  copied++;
}
console.log(`  运行时：${copied} 项`);

// 2) 应用本体（resources/app/）
const appDir = path.join(OUT_DIR, 'resources', 'app');
mkdirSync(appDir, { recursive: true });
for (const rel of ['src', 'renderer', 'package.json', 'README.md']) {
  const from = path.join(ROOT, rel);
  if (!existsSync(from)) continue;
  cpSync(from, path.join(appDir, rel), { recursive: true });
}
// 产物里的 package.json 去掉 devDependencies / scripts —— 免得有人误以为要 npm install
const appPkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
delete appPkg.devDependencies;
delete appPkg.scripts;
writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(appPkg, null, 2) + '\n', 'utf8');
console.log('  应用：src / renderer / package.json');

// 3) 可执行文件：优先用 electron-builder 已经打好图标/版本信息的那个（dist/win-unpacked），
//    没有就用原始 Electron 的 exe（功能一样，只是图标还是 Electron 默认的）。
const exeInOut = path.join(OUT_DIR, 'electron.exe');
const exeDst = path.join(OUT_DIR, 'LLM Gateway.exe');
const iconed = path.join(ROOT, 'dist', 'win-unpacked', pkg.productName + '.exe');
if (existsSync(iconed)) {
  rmSync(exeInOut, { force: true });
  cpSync(iconed, exeDst);
  console.log('  可执行：LLM Gateway.exe（取自 electron-builder 产物，图标/版本信息已写入）');
} else {
  renameSync(exeInOut, exeDst);
  console.log('  可执行：LLM Gateway.exe（原始 Electron exe；先跑 npm run pack 可带上图标）');
}

// 3b) 可选：用应用自己的图标生成器打一个 .ico 并写到 exe 上（需要 rcedit；没有就跳过）
//     图标是程序化生成的（src/icon.js），不依赖任何图片素材。
try {
  const require = createRequire(import.meta.url);
  const icon = require(path.join(ROOT, 'src', 'icon.js'));
  const icoDir = path.join(OUT_DIR, 'assets');
  mkdirSync(icoDir, { recursive: true });
  const icoPath = path.join(icoDir, 'llm-gateway.ico');
  writeFileSync(icoPath, icon.iconIcoBuffer(icon.COLORS.brand, [16, 32, 48, 64, 128, 256]));
  let rcedit = null;
  try { rcedit = require('rcedit'); } catch (_) { /* 未安装 */ }
  if (rcedit) {
    await (rcedit.default || rcedit)(exeDst, {
      icon: icoPath,
      'version-string': { ProductName: pkg.productName, FileDescription: pkg.description, CompanyName: '' },
      'file-version': pkg.version,
      'product-version': pkg.version,
    });
    console.log('  图标：已写入 exe');
  } else {
    console.log('  图标：已生成 assets/llm-gateway.ico（未安装 rcedit，未写入 exe；npm i -D rcedit 后重跑即可）');
  }
} catch (e) {
  console.log('  图标：跳过（' + (e && e.message ? e.message : e) + '）');
}

// 4) 说明文件
const nodeVer = (() => {
  try { return readFileSync(path.join(ELECTRON_DIST, 'version'), 'utf8').trim(); } catch (_) { return '?'; }
})();
writeFileSync(path.join(OUT_DIR, '使用说明.txt'), [
  `LLM Gateway v${pkg.version}（绿色免安装版，内置 Electron ${nodeVer} 运行时）`,
  '',
  '【怎么用】',
  '  1. 双击「LLM Gateway.exe」启动。首次启动会自动尝试导入 dsh-app / DSH 桌面的网关配置。',
  '  2. 在「设置」里确认端口（默认 3091），在「供应商」里填 Base URL 与 API Key。',
  '  3. 顶部点「启动」拉起网关。',
  '  4. 去「客户端接入」页，选目标 → 预览 → 写入。',
  '',
  '【数据在哪】',
  `  就在本目录下的 data\\（settings.json / gateway.config.json / logs\\）。`,
  '  整个目录复制到别的电脑即可连数据一起搬走。',
  '',
  '【不需要装 Node】',
  '  程序自带的 exe 同时充当网关子进程的 Node 运行时，目标机器无需预装 Node.js。',
  '',
  '【安全提醒】',
  '  data\\gateway.config.json 与 data\\clients\\ 下含你的上游密钥与本机网关 Key，',
  '  分享/上传本目录前请先删除 data\\（或至少删掉这两个位置）。',
  '',
].join('\r\n'), 'utf8');

// 5) 体积统计
function dirSize(dir) {
  let total = 0;
  let files = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const s = dirSize(p); total += s.total; files += s.files; } else { try { total += statSync(p).size; files++; } catch (_) { /* 忽略 */ } }
  }
  return { total, files };
}
const s = dirSize(OUT_DIR);
console.log('');
console.log(`[OK] 绿色目录已生成：${OUT_DIR}`);
console.log(`     ${(s.total / 1048576).toFixed(1)} MB / ${s.files} 个文件`);

// 6) **硬闸门**：产物目录里绝不能有 data\。
//
// 为什么值得单独设一道闸：绿色版的 data\ 就在被分发的那个目录里，里面是用户的
// `gateway.config.json`（含全部上游密钥）与生成的 `clients\llm-gateway-env.*`（含统一 Key）。
// 本脚本只在开头 rmSync 重建，所以走这条路是安全的 —— 但只要有人在
// `out/LLM-Gateway/` 里跑过一次程序、之后又用**别的方式**打包（手工 zip、改脚本、
// 换 electron-builder 输出目录），12 家上游密钥就跟着发出去了。
// 而 README 与「使用说明.txt」恰恰在教用户"整个目录复制到别的电脑"。
const leaked = ['data', 'logs'].filter((d) => existsSync(path.join(OUT_DIR, d)));
const leakFiles = (() => {
  try { return readdirSync(OUT_DIR).filter((f) => /\.bak|\.log$|gateway\.config\.json$/i.test(f)); } catch (_) { return []; }
})();
if (leaked.length || leakFiles.length) {
  console.error('');
  console.error('[STOP] 产物目录里出现了用户数据，已中止打包：');
  for (const d of leaked) console.error('   目录  ' + path.join(OUT_DIR, d));
  for (const f of leakFiles) console.error('   文件  ' + path.join(OUT_DIR, f));
  console.error('   这些内容含你的上游密钥与本机网关 Key。请先删除它们再重跑本脚本。');
  process.exit(1);
}

// 7) 打成 zip（分发用）。
//
// ⚠ 不用系统的 bsdtar：它写 zip 时**不设 UTF-8 文件名标志位**，中文文件名（`使用说明.txt`）
// 在 Windows 资源管理器/Expand-Archive 下会变成 `ʹ��˵��.txt`（实测确认，内容不受影响但名字坏了）。
// 改用 .NET 的 ZipFile.CreateFromDirectory + 显式 UTF8 编码：一次调用、名字正确、速度可接受。
if (!process.argv.includes('--no-zip')) {
  const zipPath = path.join(ROOT, 'out', `${OUT_NAME}-${pkg.version}.zip`);
  rmSync(zipPath, { force: true });
  console.log('     正在打 zip（几百 MB，需要一会儿）…');
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue',
    // includeBaseDirectory = $true：zip 里带一层 `LLM-Gateway/` 顶层目录。
    // 传 $false 的话解压出来是一堆散文件直接铺在当前目录（实测踩到，很难看也不好分发）。
    `[System.IO.Compression.ZipFile]::CreateFromDirectory(${q(OUT_DIR)}, ${q(zipPath)}, `
      + '[System.IO.Compression.CompressionLevel]::Optimal, $true, [System.Text.Encoding]::UTF8)',
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 30 * 60 * 1000,
  });
  if (r.status === 0 && existsSync(zipPath)) {
    console.log(`[OK] zip：${zipPath}（${(statSync(zipPath).size / 1048576).toFixed(1)} MB）`);
  } else {
    console.log('     zip 打包失败：' + ((r.stderr || r.stdout || '').trim() || '未知错误'));
  }
}

// 8) **把用户的 data\ 放回**。
//
// 为什么必须放在最后（这是两个需求的交点，摆错过一次）：
//   · 用户需求：`out\LLM-Gateway\data\` 是他的**运行状态**（供应商/密钥/日志），
//     构建不能删它 —— 早期版本 `rmSync(OUT_DIR)` 把它一起删了，
//     而下次启动又从"既有安装"导入旧配置，用户新加的家**静默消失**。
//   · 分发需求：打进 zip 的那个目录里**绝不能**有 data\（上面第 6 步的闸门）。
//
// 两者不矛盾，只要顺序对：**暂存 → 构建 → 闸门 → 打 zip → 放回**。
// 摆成"构建后立刻放回"会让闸门挡住 zip；摆成"根本不暂存"会删掉用户配置。
if (stashed) {
  cpSync(stashDir, dataDir, { recursive: true });
  rmSync(stashDir, { recursive: true, force: true });
  console.log('  data\\ 已放回（用户的供应商配置完好；它**没有**进 zip）');
}
