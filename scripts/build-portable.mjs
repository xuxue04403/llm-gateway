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
// 用法：node scripts/build-portable.mjs [输出目录名] [--dry-run | --check-name]
//
//   --check-name   只做输出目录名/位置校验，然后立即退出（不暂存 data、不删任何东西）
//   --dry-run      校验通过后打印将要执行的动作并退出（同上，非破坏性）
//
// ⚠ 2026-11-12 审计 H1 的验证过程本身踩了坑，记在这里：当时为了验边界，用"合法名"
// （`a b` / `out`）直接跑了本脚本，结果真的执行了完整构建 —— 于是 `rmSync` 打到了
// **正在运行的** `out\LLM-Gateway`。万幸文件被占用立刻 EPERM 中止、data 也备份放回了，
// 但那两次 `data-backup-*`（各 64 文件 / 22MB，含真实密钥）是我手工删掉的。
// 结论：**永远不要用真的跑一次来验证构建脚本的边界**。所以现在有了 --check-name。
'use strict';

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// ⚠⚠ 输出目录名必须做边界校验（2026-11-12 审计 H1）。
//
// 旧实现直接 `path.join(ROOT, 'out', process.argv[2] || 'LLM-Gateway')`，然后
// 第 105 行 `rmSync(OUT_DIR, { recursive: true, force: true })`。而 `path.join` 会**归一化**
// `..`，于是：
//     node scripts/build-portable.mjs ..        → OUT_DIR = <仓库根>        → 递归删掉整个仓库
//     node scripts/build-portable.mjs ../..     → OUT_DIR = D:\IDE\dsh      → 连同级项目一起删
//     node scripts/build-portable.mjs .         → OUT_DIR = <仓库根>\out
// 这不是理论风险：`rmSync` 是同步递归强删，且 `process.on('exit')` 的 data 还原钩子
// 只在 out\ 里有 data\ 时才起作用 —— 一旦打到仓库根，什么都不会被还原。
//
// 校验分两层（都要过）：
//   1) 名字本身：只允许单段、不含路径分隔符/盘符/全角空格，不能是 `.` `..`，
//      首尾不能是空白或点（Windows 上 `foo.` 会被静默截断成 `foo`）。
//   2) 解析后位置：`path.resolve(OUT_DIR)` 必须严格位于 `<仓库根>\out\` 之下且不等于它。
//      第 2 层是真正的兜底 —— 即使第 1 层哪天被放宽，也不会删到 out\ 之外。
// ⚠ 2026-11-12 复核修：取名字时必须**跳过选项**，否则 `--check-name` / `--no-zip` 会被当成目录名。
// 旧写法是 `process.argv[2] || 'LLM-Gateway'`，实测 `node scripts/build-portable.mjs --check-name`
// 会打印"校验通过：…\out\--check-name"，而 `node scripts/build-portable.mjs --no-zip` 会真的
// 往 `out\--no-zip` 里构建一份 —— 名字校验里没有排除 `-` 开头，所以一路放行。
const POSITIONAL = process.argv.slice(2).filter((a) => !String(a).startsWith('-'));
const OUT_NAME_RAW = POSITIONAL[0] || 'LLM-Gateway';
// ⚠ 2026-11-13 发布事故：改名 OUT_NAME → OUT_NAME_RAW 时漏了 zip 段的两处引用，
//    构建到最后一步抛 "OUT_NAME is not defined"，data\ 被恢复但整个发布中断
//    （应用停在停机状态）。现在只保留一个名字来源：后面的代码统一用 OUT_NAME。
const OUT_NAME = OUT_NAME_RAW;
const CHECK_ONLY = process.argv.includes('--check-name') || process.argv.includes('--dry-run');
const outRoot = path.join(ROOT, 'out');
const OUT_DIR = path.resolve(outRoot, OUT_NAME_RAW);
const outRelative = path.relative(outRoot, OUT_DIR);
const badOutName = (() => {
  const n = String(OUT_NAME_RAW);
  if (!n || n === '.' || n === '..') return '不能为空、`.` 或 `..`';
  if (/[\\/:*?"<>|\u3000]/.test(n)) return '不能包含路径分隔符或 Windows 非法字符';
  if (/^[A-Za-z]:/.test(n)) return '不能是盘符路径';
  if (n !== n.trim()) return '首尾不能有空白';
  if (/^[. ]|[. ]$/.test(n)) return '首尾不能是点或空格（Windows 会静默截断）';
  if (n.length > 64) return '过长（上限 64 字符）';
  // Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）：建目录会失败或被重定向到设备
  const stem = n.split('.')[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) return '是 Windows 保留设备名';
  return '';
})();
if (badOutName) {
  console.error('输出目录名非法：' + JSON.stringify(OUT_NAME_RAW) + ' —— ' + badOutName);
  console.error('用法：node scripts/build-portable.mjs [输出目录名]   （默认 LLM-Gateway，必须是单层目录名）');
  process.exit(2);
}
if (!outRelative || outRelative.startsWith('..') || path.isAbsolute(outRelative) || outRelative.split(path.sep).length !== 1) {
  console.error('输出目录解析后越界：' + OUT_DIR);
  console.error('必须严格位于 ' + outRoot + path.sep + ' 之下。已中止，未删除任何文件。');
  process.exit(2);
}
if (CHECK_ONLY) {
  console.log('✅ 输出目录校验通过：' + OUT_DIR);
  console.log('   （--check-name/--dry-run：未暂存 data、未删除、未复制任何文件）');
  process.exit(0);
}
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

/** zip 阶段是否失败（审计 M7：失败必须在收尾时置非零退出码，而不是静默成功）。 */
let zipFailed = false;

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

/**
 * 异常退出也要把 data\ 放回。
 *
 * ⚠ 2026-10-14 实测命中（不是理论风险）：应用正在运行时执行本脚本，
 * 第 69 行的 `rmSync(OUT_DIR)` 会因文件被占用抛 **EPERM**。此时 data\ 已经**暂存走**
 * （stashed=true），而原来的放回逻辑在文件末尾 —— 异常直接终止进程，**永远走不到那里**。
 * 结果：`out\.data-stash\` 成为唯一副本，而用户以为配置还在原处。
 * （这次是 `cpSync` 复制而非移动，原目录侥幸完好；但只要哪天真改成 move，就是数据丢失。）
 * 审计里这条被列为"build-portable 的 data 暂存在中途失败时不自动还原"——现在它真的发生了。
 *
 * 用 `process.on('exit')` 而不是 try/catch 包住全文：本文件是**顶层顺序语句**，
 * 包 try/catch 要把 1~8 步整体缩进重排，改动面大、易错。exit 钩子在"正常结束"与
 * "未捕获异常导致的退出"两种路径上都会跑，且 cpSync/rmSync 都是同步的，可以在这里安全收尾。
 */
let restored = false;
const restoreStash = (why) => {
  if (restored || !stashed) return;
  restored = true;
  try {
    if (!existsSync(stashDir)) return;
    cpSync(stashDir, dataDir, { recursive: true });
    rmSync(stashDir, { recursive: true, force: true });
    console.log(`  data\\ 已放回（${why}）`);
  } catch (e) {
    console.warn('  ⚠ 放回 data\\ 失败：' + (e && e.message)
      + '\n    副本仍在：' + stashDir + '　请手工拷回 ' + dataDir);
  }
};
process.on('exit', () => restoreStash('进程退出兜底'));
process.on('uncaughtException', (e) => {
  console.error('构建异常：' + (e && e.message));
  restoreStash('异常退出');
  process.exit(1);
});

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
//
// ⚠ 2026-11-12 审计 L1：这里有个真实的版本混用风险 —— exe 取 dist\win-unpacked 的，
// 而 DLL / .pak / snapshot_blob.bin 一律取 node_modules\electron\dist 的。两边版本不一致时
// 会得到一个"exe 是 45.0.0-alpha.6、运行时资源却是别的版本"的目录，症状是启动即崩或白屏，
// 而且极难定位（因为每份文件单独看都正常）。
// 现状核对（2026-11-12 实测本机）：ffmpeg.dll / vk_swiftshader.dll / d3dcompiler_47.dll /
// icudtl.dat 四份哈希与 node_modules 完全一致，所以**当前**不会出问题。
// 这里加一道防线而不是改行为：先把两边都读得到的版本标记比一下（electron dist 有 `version`
// 文件；electron-builder 产物可能没有），能读到且不一致就**拒绝**，读不到就只在日志里
// 提示一句"未能核对版本"。宁可让构建失败一次，也不要发一个混装运行时出去。
const exeInOut = path.join(OUT_DIR, 'electron.exe');
const exeDst = path.join(OUT_DIR, 'LLM Gateway.exe');
const iconed = path.join(ROOT, 'dist', 'win-unpacked', pkg.productName + '.exe');
if (existsSync(iconed)) {
  const readVer = (p) => { try { return readFileSync(path.join(p, 'version'), 'utf8').trim(); } catch (_) { return ''; } };
  const distVer = readVer(ELECTRON_DIST);
  const unpackedVer = readVer(path.join(ROOT, 'dist', 'win-unpacked'));
  if (distVer && unpackedVer && distVer !== unpackedVer) {
    console.error('');
    console.error('[STOP] Electron 运行时版本不一致，拒绝混装：');
    console.error('   node_modules\\electron\\dist  = ' + distVer);
    console.error('   dist\\win-unpacked           = ' + unpackedVer);
    console.error('   用 electron-builder 产物里的 exe 覆盖，却拿另一版本的 dll/pak 拼在一起，');
    console.error('   启动会崩且很难查。请让两边版本一致（必要时 rm -rf dist 后重跑 npm run pack）。');
    process.exit(4);
  }
  rmSync(exeInOut, { force: true });
  cpSync(iconed, exeDst);
  console.log('  可执行：LLM Gateway.exe（取自 electron-builder 产物，图标/版本信息已写入）');
  if (!distVer || !unpackedVer) {
    console.log('     ⚠ 未能核对运行时版本（' + (distVer ? 'win-unpacked 无 version 文件' : 'electron dist 无 version 文件') + '），默认按同版本处理');
  }
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

// 6) **硬闸门**：产物目录里绝不能有 data\ 或任何用户数据残留。
//
// 为什么值得单独设一道闸：绿色版的 data\ 就在被分发的那个目录里，里面是用户的
// `gateway.config.json`（含全部上游密钥）与生成的 `clients\llm-gateway-env.*`（含统一 Key）。
// 本脚本只在开头 rmSync 重建，所以走这条路是安全的 —— 但只要有人在
// `out/LLM-Gateway/` 里跑过一次程序、之后又用**别的方式**打包（手工 zip、改脚本、
// 换 electron-builder 输出目录），12 家上游密钥就跟着发出去了。
// 而 README 与「使用说明.txt」恰恰在教用户"整个目录复制到别的电脑"。
//
// ⚠ 2026-11-12 审计 M14：旧实现只查 `OUT_DIR` **根**下的 `data`/`logs` 与根目录的文件名。
// 但用户数据不只在根：`_backupConfig()` 写的是 `data\config-backups\`（子目录，10 份全部
// 含明文密钥），写入器还会往 `data\clients\` 放统一 Key。只查根等于只挡住了一半 ——
// 只要哪天 data\ 被挪到别的位置、或产物里出现 `resources\app\data\`，闸门就静默放过。
// 现在改成**递归**：任意深度的 `data`/`logs` 目录、任意深度的 `*.bak*`/`*.log`/
// `gateway.config*.json` 文件都算泄漏。实测当前产物递归命中 0 个多余文件（只有 data\ 本身），
// 所以不会误报。
const leaked = [];
const leakFiles = [];
(function scanLeak(dir, depth) {
  if (depth > 8) return; // 防御：符号链接环
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'data' || e.name === 'logs') { leaked.push(p); continue; }
      scanLeak(p, depth + 1);
    } else if (/\.bak|\.log$/i.test(e.name) || /^gateway\.config(-|\.json$)/i.test(e.name)) {
      // ⚠ 这里刻意不用 `gateway\.config.*\.json` 这种宽匹配：`src\gateway\gateway.config.example.json`
      // 是**要发布**的示例配置，宽匹配会让每次构建都被自己的闸门挡住（实测命中 1 次）。
      // 真正要拦的是 `gateway.config.json` 本身与 `_backupConfig()` 产出的
      // `gateway.config-<ISO>.json`（`gateway.config-` 前缀），以及任何 `*.bak*`。
      leakFiles.push(p);
    }
  }
})(OUT_DIR, 0);
if (leaked.length || leakFiles.length) {
  console.error('');
  console.error('[STOP] 产物目录里出现了用户数据，已中止打包：');
  for (const d of leaked) console.error('   目录  ' + d);
  for (const f of leakFiles) console.error('   文件  ' + f);
  console.error('   这些内容含你的上游密钥与本机网关 Key。请先删除它们再重跑本脚本。');
  process.exit(1);
}

// 7) 打成 zip（分发用）。
//
// ⚠ 不用系统的 bsdtar：它写 zip 时**不设 UTF-8 文件名标志位**，中文文件名（`使用说明.txt`）
// 在 Windows 资源管理器/Expand-Archive 下会变成 `ʹ��˵��.txt`（实测确认，内容不受影响但名字坏了）。
//
// ⚠⚠ 2026-10-14 修正：**不能**用 `ZipFile.CreateFromDirectory`（Windows PowerShell 5.1 的
// .NET Framework 版）。它用 `Path.DirectorySeparatorChar` 拼条目名 → 在 Windows 上写出的是
// `LLM-Gateway\chrome_100_percent.pak` 这种**反斜杠条目名**。ZIP 规范要求正斜杠，
// 实测：本脚本产出的 zip 113 个条目**全部**是反斜杠；而手工用 pwsh(.NET Core) 重打的同内容
// zip 是正斜杠。反斜杠条目在 Windows 资源管理器/Expand-Archive 下能看（伪装成目录），
// 但在 Linux/macOS 的 unzip 下会变成**文件名里带反斜杠的散文件**，等于解压出一堆垃圾。
//
// 现改为：自己遍历目录 + `ZipArchive.CreateEntry(名字)`，名字里的分隔符显式用 `/`。
// 仍然走 .NET（保持 UTF-8 文件名标志位，中文名不乱码），仍然带一层 `LLM-Gateway/` 顶层目录。
if (!process.argv.includes('--no-zip')) {
  const zipPath = path.join(ROOT, 'out', `${OUT_NAME}-${pkg.version}.zip`);
  rmSync(zipPath, { force: true });
  console.log('     正在打 zip（几百 MB，需要一会儿）…');
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  // 注意：整段脚本里**不出现反斜杠字面量**（用 [char]92/[char]47 代替），
  // 免得在 JS 字符串与 PowerShell 字符串之间来回转义出错。
  const script = [
    '$ErrorActionPreference = "Stop"',
    // ⚠ 两个程序集都要加载：`ZipFile` 在 System.IO.Compression.FileSystem，
    // 而 **`ZipArchive` / `CompressionLevel` 在 System.IO.Compression**。
    // 只加载前者会报 `Unable to find type [System.IO.Compression.ZipArchive]`
    // （实测踩到：zip 被建成 0 字节的坏文件）。
    'Add-Type -AssemblyName System.IO.Compression -ErrorAction SilentlyContinue',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue',
    `$src = (Resolve-Path ${q(OUT_DIR)}).Path`,
    `$zip = ${q(zipPath)}`,
    `$top = ${q(OUT_NAME)}`,
    'if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }',
    '$sep = [char]92',
    '$slash = [char]47',
    '$fs = [System.IO.File]::Open($zip, [System.IO.FileMode]::CreateNew)',
    '$arch = [System.IO.Compression.ZipArchive]::new($fs, [System.IO.Compression.ZipArchiveMode]::Create, [System.Text.Encoding]::UTF8)',
    'try {',
    '  $files = Get-ChildItem -LiteralPath $src -Recurse -File -Force',
    '  foreach ($f in $files) {',
    '    $rel = $f.FullName.Substring($src.Length + 1).Replace($sep, $slash)',
    '    $entry = $arch.CreateEntry($top + $slash + $rel, [System.IO.Compression.CompressionLevel]::Optimal)',
    '    $es = $entry.Open()',
    '    $ins = [System.IO.File]::OpenRead($f.FullName)',
    '    try { $ins.CopyTo($es) } finally { $ins.Dispose(); $es.Dispose() }',
    '  }',
    '} finally { $arch.Dispose(); $fs.Dispose() }',
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 30 * 60 * 1000,
  });
  // ⚠ 判定必须带**大小下限**：出错时 ZipArchive 已经建好文件而内容为空，
  // 只判 `existsSync` 会把 0 字节的坏 zip 报成 `[OK]`（实测踩到，发布前才发现）。
  const zipOk = r.status === 0 && existsSync(zipPath) && statSync(zipPath).size > 1024 * 1024;
  if (zipOk) {
    console.log(`[OK] zip：${zipPath}（${(statSync(zipPath).size / 1048576).toFixed(1)} MB）`);
  } else {
    // ⚠ 必须**置非零退出码**（2026-11-12 审计 M7）。
    // 旧实现只 console.log 一句就继续往下走、正常 exit 0 —— 于是
    // `scripts\release.ps1` 里 `npm run` 那一串不会失败，发布流程会拿着一个
    // 根本不存在（或 0 字节）的 zip 继续上传，甚至打 tag。
    // 修 M7 时保持这一点：先说清为什么失败，再让进程带着码退出（data 仍会由下面的
    // restoreStash 放回，因为退出前会走 process.on('exit') 钩子）。
    const why = existsSync(zipPath) ? `产物过小（${statSync(zipPath).size} 字节，疑似损坏）` : '未生成';
    console.error('     zip 打包失败：' + why + '　' + ((r.stderr || r.stdout || '').trim() || ''));
    zipFailed = true;
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
  restoreStash('构建收尾：用户的供应商配置完好，且**没有**进 zip');
}

// 9) 清理 out\data-backup-* 的旧副本（只留最新 2 份）。
// 这些是上面"额外备份"留下的**整目录**副本（每个都有几百 MB 的日志），
// 不清理会随每次构建无界增长 —— 审计里点过这一条。
try {
  const baks = readdirSync(path.join(ROOT, 'out'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('data-backup-'))
    .map((e) => e.name)
    .sort();
  for (const name of baks.slice(0, Math.max(0, baks.length - 2))) {
    rmSync(path.join(ROOT, 'out', name), { recursive: true, force: true });
    console.log('  已清理旧备份 out\\' + name);
  }
} catch (e) {
  console.warn('  ⚠ 清理旧备份失败（不影响构建）：' + (e && e.message));
}

// 10) 收尾退出码（审计 M7）。
//
// 放在 data 放回之后：即使 zip 失败，用户的配置也必须先归位，再带着非零码退出。
// 只在这一处判定，避免前面的 `process.exit(2)`（参数校验）被覆盖。
if (zipFailed) {
  console.error('[FAIL] zip 打包失败 —— 目录已生成，但压缩包不可用。不要再往上发布，先看上面的原因。');
  process.exit(3);
}
