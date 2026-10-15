// verify-artifact.mjs — 发布前门禁：**产物 == 源码 == HEAD** 的三方比对
//
// 用法：
//   node scripts/verify-artifact.mjs [输出目录名] [--no-git] [--json]
//     · 输出目录名默认 `LLM-Gateway`（即 out\LLM-Gateway）
//     · --no-git   跳过 git 检查（git 不可用时也能验"产物==源码"）
//     · --json     以 JSON 输出（给 CI / 其它脚本消费）
//
// 为什么需要它（2026-10-15 实测教训）：
//   发布 v1.0.1 时我要回答"out\LLM-Gateway 到底是不是最新代码"，当时是手工比的 ——
//   而且第一次还比错了：用 `git show HEAD:<path> | Set-Content` 取 HEAD 版本，
//   PowerShell 写文件会加 BOM、改换行，于是**全部报"不一致"**，差点得出反向结论。
//   现在把这件事固化：产物/源码用 SHA256 比字节，源码/HEAD 用 `git status` 比，不留人工环节。
//
// 它守的五件事：
//   A 产物 == 源码树   —— 打进去的确实是当前源码（逐文件 SHA256；package.json 归一化后深比较）
//   B 源码 == git HEAD —— 当前源码已提交（工作区干净 → 发布可复现）
//   C 构建不陈旧       —— 没有"比产物新且内容不同"的源文件（内容相同的更新是无害的）
//   D 版本一致         —— 产物内 package.json 的 version == 仓库 version
//   E 无"会被打进去但没提交"的文件
//
// 退出码：0 = 全部通过；1 = 有检查未通过；2 = 根本跑不了（产物不存在 / 参数错）。
'use strict';

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const NO_GIT = argv.includes('--no-git');
const OUT_NAME = argv.find((a) => !a.startsWith('--')) || 'LLM-Gateway';
const OUT_DIR = path.join(ROOT, 'out', OUT_NAME);
const APP_DIR = path.join(OUT_DIR, 'resources', 'app');

/**
 * 产物里**应该**有哪些东西 —— 刻意镜像 build-portable.mjs 第 2 步的那个数组。
 *
 * ⚠ 不要改用 package.json 的 `build.files`：那是给 **electron-builder** 打 dist/win-unpacked 用的
 *   （它会把 `assets/` 也放进去），而绿色目录的 resources/app 是 build-portable **自己拼的**。
 *   实测（2026-10-15）：`assets/` 只在**构建期**用来给 exe 生成图标（写到 <out>/assets/，
 *   不进 resources/app），应用运行时根本不读它 —— src/ 与 renderer/ 里没有任何对 assets/ 的引用。
 *   所以把 assets 当"必须出现在产物里"会得到一个假阳性。
 */
const APP_CONTENT = ['src', 'renderer', 'package.json', 'README.md'];

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/* ---------------- 小工具 ---------------- */
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const toPosix = (p) => p.split(path.sep).join('/');

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const git = (args, opts = {}) => {
  const out = execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', windowsHide: true });
  // ⚠ 默认只剥掉**结尾换行**，不能对整体 `.trim()`。
  //   `git status --porcelain` 的**首行前导空格是有意义的**（` M` = 已修改未暂存）：
  //   整体 trim 会把第一行变成 `M package.json`，于是 slice(3) 切出 `ackage.json`
  //   —— 实测踩到过：每次运行都报一个"不存在的文件名"，假阳性会让门禁失去可信度。
  if (opts.raw) return out.replace(/\r?\n$/, '');
  return out.trim();
};

/** 把 APP_CONTENT 展开成"仓库里实际存在的相对路径"清单 */
function expectedInArtifact() {
  const out = [];
  for (const entry of APP_CONTENT) {
    const abs = path.join(ROOT, entry);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) for (const f of walk(abs)) out.push(toPosix(path.relative(ROOT, f)));
    else out.push(entry);
  }
  return out;
}

/**
 * 两边 package.json 归一化后比较。
 * electron-builder 与 build-portable 都会把 `scripts` / `devDependencies` 剥掉（实测唯一差异），
 * 所以这两个键不参与比较 —— 但**其余字段一个都不放过**（否则 version 写错也会被放过）。
 */
function normalizeAppPkg(obj) {
  const o = JSON.parse(JSON.stringify(obj));
  delete o.scripts;
  delete o.devDependencies;
  return o;
}
function normalizeJsonText(o) {
  return JSON.stringify(o, Object.keys(o).sort());
}
/** 该源文件与产物里的对应文件"内容是否一致"（package.json 按归一化比） */
function contentMatches(relPath) {
  const src = path.join(ROOT, relPath);
  const dst = path.join(APP_DIR, relPath);
  if (!existsSync(dst)) return false;
  if (relPath === 'package.json') {
    try {
      const a = normalizeAppPkg(JSON.parse(readFileSync(dst, 'utf8')));
      const b = normalizeAppPkg(JSON.parse(readFileSync(src, 'utf8')));
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
      return true;
    } catch { return false; }
  }
  return sha256(src) === sha256(dst);
}

const problems = [];
const notes = [];
const checks = {};

/* ---------------- 前置 ---------------- */
if (!existsSync(APP_DIR)) {
  console.error('[verify-artifact] 找不到产物：' + APP_DIR);
  console.error('  先执行：npm run pack && node scripts/build-portable.mjs ' + OUT_NAME);
  process.exit(2);
}

/* ---------------- A. 产物 == 源码树 ---------------- */
{
  const artFiles = walk(APP_DIR);
  const mismatched = [];
  const notInSource = [];
  let identical = 0;
  for (const f of artFiles) {
    const r = toPosix(path.relative(APP_DIR, f));
    if (!existsSync(path.join(ROOT, r))) { notInSource.push(r); continue; }
    if (contentMatches(r)) identical++;
    else mismatched.push(r);
  }
  const expected = expectedInArtifact();
  const missingInArtifact = expected.filter((r) => !existsSync(path.join(APP_DIR, r)));

  const ok = mismatched.length === 0 && notInSource.length === 0 && missingInArtifact.length === 0;
  checks.artifactVsSource = { ok, artifactFiles: artFiles.length, identical, mismatched, notInSource, missingInArtifact };
  if (!ok) {
    if (mismatched.length) problems.push('产物与源码**内容不同**（产物是旧的或被改过）：' + mismatched.join(', '));
    if (notInSource.length) problems.push('产物里有源码树中不存在的文件：' + notInSource.join(', '));
    if (missingInArtifact.length) problems.push('本该打进产物却缺失：' + missingInArtifact.slice(0, 8).join(', ')
      + (missingInArtifact.length > 8 ? ` … 共 ${missingInArtifact.length} 个` : ''));
  }
}

/* ---------------- B. 源码 == git HEAD ---------------- */
{
  if (NO_GIT) {
    checks.sourceVsHead = { ok: null, skipped: true };
    notes.push('已按 --no-git 跳过 git 检查 —— 因此**无法**证明"源码 == HEAD"');
  } else {
    try {
      const head = git(['rev-parse', '--short', 'HEAD']);
      let tag = '';
      try { tag = git(['describe', '--tags', '--abbrev=0']); } catch { /* 没有标签也正常 */ }
      const dirty = [];
      const untracked = [];
      for (const line of git(['status', '--porcelain'], { raw: true }).split(/\r?\n/)) {
        if (!line) continue;
        const code = line.slice(0, 2);
        const file = line.slice(3).trim().replace(/^"|"$/g, '');
        if (code === '??') untracked.push(file);
        else dirty.push(code.trim() + ' ' + file);
      }
      // 只有"会被打进产物"的未跟踪文件才是问题；其它（临时脚本等）只提示
      const expected = new Set(expectedInArtifact());
      const untrackedShipped = untracked.filter((u) => expected.has(u));
      const ok = dirty.length === 0 && untrackedShipped.length === 0;
      checks.sourceVsHead = { ok, head, tag, dirty, untracked, untrackedShipped };
      if (dirty.length) problems.push('工作区有未提交改动（' + dirty.length + ' 个）：' + dirty.slice(0, 6).join('；')
        + (dirty.length > 6 ? ' …' : ''));
      if (untrackedShipped.length) {
        problems.push('有未跟踪文件会被打进产物（等于发布未提交的代码）：' + untrackedShipped.join(', '));
      }
      if (untracked.length && !untrackedShipped.length) {
        notes.push('有 ' + untracked.length + ' 个未跟踪文件，但都不在产物内容清单内，不影响发布');
      }
    } catch (e) {
      const msg = String((e && e.stderr) || (e && e.message) || e).split('\n')[0];
      checks.sourceVsHead = { ok: false, error: msg };
      problems.push('git 不可用 / 不在 git 仓库 —— 无法证明"源码 == HEAD"（确认无误可用 --no-git 显式跳过）：' + msg);
    }
  }
}

/* ---------------- C. 构建不陈旧 ----------------
 * 判据：源文件比构建时刻新**且内容与产物不同**才算问题。
 * ⚠ 只比 mtime 会假阳性：`npm run dist` 会在 build-portable 之后**再次**跑 make-icon
 *   （assets/*.ico|png 的 mtime 因此晚于构建），但内容完全一样，属无害。
 * ⚠ 构建时刻取 build-portable 写的 `使用说明.txt` 的 mtime —— 不能拿某个产物文件的 mtime 当基准：
 *   cpSync 保留每个源文件各自的 mtime，不同文件天生不同（实测踩到，会误报"构建后改了源码"）。 */
{
  const marker = path.join(OUT_DIR, '使用说明.txt');
  const buildTime = existsSync(marker) ? statSync(marker).mtimeMs : null;
  const newerAndDifferent = [];
  const newerButIdentical = [];
  if (buildTime === null) {
    checks.buildFreshness = { ok: null, buildTime: null, newerAndDifferent, newerButIdentical };
    notes.push('找不到构建时刻标记（out/' + OUT_NAME + '/使用说明.txt）→ 跳过"构建是否陈旧"');
  } else {
    for (const r of expectedInArtifact()) {
      const f = path.join(ROOT, r);
      if (!existsSync(f) || statSync(f).mtimeMs <= buildTime) continue;
      if (contentMatches(r)) newerButIdentical.push(r);
      else newerAndDifferent.push(r);
    }
    const ok = newerAndDifferent.length === 0;
    checks.buildFreshness = { ok, buildTime: new Date(buildTime).toISOString(), newerAndDifferent, newerButIdentical };
    if (!ok) {
      problems.push('源码比产物新且内容不同（产物是旧的，必须重新构建）：' + newerAndDifferent.join(', '));
    }
    if (newerButIdentical.length) {
      notes.push('有 ' + newerButIdentical.length + ' 个文件 mtime 晚于构建但内容一致（如 npm run dist 重跑的 make-icon）'
        + '：' + newerButIdentical.join(', '));
    }
  }
}

/* ---------------- D. 版本一致 ---------------- */
{
  let artVersion = null;
  try { artVersion = JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version; } catch { /* 下面统一报 */ }
  const ok = artVersion === pkg.version;
  checks.version = { ok, repo: pkg.version, artifact: artVersion };
  if (!ok) problems.push(`版本不一致：仓库 ${pkg.version} vs 产物 ${artVersion}`);
}

/* ---------------- 输出 ---------------- */
const failed = problems.length > 0;
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: !failed, outDir: OUT_DIR, checks, problems, notes }, null, 2));
} else {
  const row = (name, ok, okText, badText) =>
    console.log(`  ${ok === null ? '–' : ok ? '✓' : '✗'} ${name}  ${ok === null ? '（跳过）' : ok ? okText : badText}`);

  console.log('三方比对：产物 == 源码 == HEAD');
  console.log('  产物目录：' + toPosix(path.relative(ROOT, OUT_DIR)));
  console.log('');

  const a = checks.artifactVsSource;
  row('A 产物 == 源码树', a.ok,
    `${a.artifactFiles} 个文件，${a.identical} 个逐字节一致`,
    '见下方问题清单');

  const b = checks.sourceVsHead;
  if (b.skipped) row('B 源码 == HEAD', null, '', '');
  else if (b.error) row('B 源码 == HEAD', false, '', b.error);
  else row('B 源码 == HEAD', b.ok,
    `HEAD=${b.head}${b.tag ? '  tag=' + b.tag : ''}  工作区干净`, '见下方问题清单');

  const c = checks.buildFreshness;
  row('C 构建不陈旧', c.ok,
    `构建时刻 ${c.buildTime ? new Date(c.buildTime).toLocaleString() : '?'}，无源码更新`,
    '有源码晚于构建且内容不同');

  const d = checks.version;
  row('D 版本一致', d.ok, `仓库与产物都是 ${d.repo}`, `仓库 ${d.repo} vs 产物 ${d.artifact}`);

  if (notes.length) { console.log('\n  说明：'); for (const n of notes) console.log('    · ' + n); }

  if (failed) {
    console.log('\n✗ 未通过 —— ' + problems.length + ' 个问题：');
    for (const p of problems) console.log('  · ' + p);
    console.log('\n修复方向：');
    console.log('  · 产物与源码不一致 / 构建陈旧 → 重新构建：npm run pack && node scripts/build-portable.mjs ' + OUT_NAME);
    console.log('  · 工作区有未提交改动          → 先提交，再发布（发布必须可复现到某个 HEAD）');
  } else {
    console.log('\n✓ 三方一致：产物就是当前源码，且源码已提交到 HEAD —— 可以发布。');
  }
}

process.exit(failed ? 1 : 0);
