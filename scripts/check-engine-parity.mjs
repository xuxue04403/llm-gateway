// check-engine-parity.mjs — 引擎与 dsh-app 版本的差异校验（**声明式**）
//
// 背景：llm-gateway 的引擎最初是 dsh-app 版本的**原样副本**，靠"逐行完全一致"来证明
// "现有网关功能全部保留"。后来为了提升客户端仿真/防封禁能力，确实改了若干处 ——
// 于是"零差异"这句话不再成立。
//
// 与其让一句已经不成立的话继续挂在文档里，不如把它换成**可复核的声明式差异**：
//   · 逐块（顶层 function/const/class）比对两个文件；
//   · 变化过的块**必须**在下面的 DECLARED 清单里，且每条都写明理由；
//   · 清单里挂着但实际没变的条目也会报错（防止清单腐烂成"历史遗留"）。
// 这样"哪些地方动了、为什么动"是可机器校验的，而不是靠人记。
//
// 用法：node scripts/check-engine-parity.mjs [--verbose]
// 找不到 dsh-app 的基线时（例如只拿到本程序源码）会明确说明并跳过，不算失败。

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT = path.join(ROOT, 'src', 'gateway', 'model-gateway.mjs');

const BASELINE_CANDIDATES = [
  process.env.DSH_GATEWAY_ENGINE_BASELINE,
  path.join(ROOT, '..', 'dsh-app', 'src', 'gateway', 'model-gateway.mjs'),
  path.join(ROOT, '..', '..', 'dsh-app', 'src', 'gateway', 'model-gateway.mjs'),
].filter(Boolean);

/**
 * **声明过的**改动。每一处都必须回答"改了什么、为什么"。
 * 新增改动时务必同时加进这里 —— 脚本会因为"有未声明的变化"而失败，这是故意的。
 */
const DECLARED = [
  { name: '<文件头>', why: '顶部注明本文件是 dsh-app 引擎的副本，并指向本脚本复核差异' },
  { name: 'APP_DIR', why: '默认数据目录名 DSHDesktop → llm-gateway（只影响不传 --config 的裸跑）' },

  // —— 2026-09-30：客户端仿真 / 防封禁专项改进（依据是官方 SDK/CLI 一手源码）——
  { name: 'clientIdentityOverrides', why: '新增：版本/身份统一覆盖入口（env > 配置 > 默认），避免版本号写死后被上游最低版本门禁拒掉' },
  { name: 'osRelease', why: '新增：os.release() 安全包装，供 UA 与平台头构造使用' },
  { name: 'platformInfo', why: '新增：运行平台规范名（与 @anthropic-ai/sdk 的 detect-platform 同口径）' },
  { name: 'stainlessHeaders', why: '新增：@anthropic-ai/sdk buildHeaders() 必发的 8 个 X-Stainless-*（旧实现一个都没有，"只发 UA+accept 的 Anthropic 客户端"并不存在）' },
  { name: 'CC_BETA_FLAGS', why: '新增：真实 Claude Code 的 anthropic-beta flag 全集（可关，防个别中转对未知 flag 直接 400）' },
  { name: 'claudeClientHeaders', why: '补 x-app/x-stainless-*/anthropic-beta；UA 版本与入口点语义修正（cli → sdk-cli）；accept 改为真实值 application/json' },
  { name: 'clineClientHeaders', why: '版本号改为可配置（服务端有最低版本门禁）；新增 X-Task-ID；版本三者自洽' },
  { name: 'codexClientHeaders', why: 'UA 由"Codex 前缀 + Chrome 浏览器 UA"（Rust CLI 不可能有 AppleWebKit/Safari，最易识破）改为真实形态 codex_cli_rs/<ver> (<os> <ver>; <arch>)；补一等身份头 originator' },
  { name: 'upstreamRequestHeaders', why: 'accept-encoding 由 identity 改为真实值并留回退开关；connection 保持 close 但可配置关闭；按 profile 传 cfg 与 cline 会话 id' },
  { name: 'passthroughHeaders', why: '透传 cfg（供上面的仿真选项使用）' },
  { name: 'fetchCatalog', why: '透传 cfg（目录探测同样走上游请求头构造）' },
  { name: 'doFetchCatalog', why: '透传 cfg' },

  // —— 失效分类与限流遵循 ——
  { name: 'MODEL_UNSUPPORTED_BY_PROVIDER_RE', why: '扩充：把"地区/套餐受限"归入"这家不提供该模型"。实测事故：cline 对一个地区受限模型回 403，旧实现按供应商级 403 熔断整家 30 分钟，把它家另外 13 个正常模型一起封掉' },
  { name: 'CLIENT_FINGERPRINT_RE', why: '新增：识别"客户端指纹被拒"。这类拒绝换 Key/重试都没用，继续打只会加剧风控，必须与普通 403 区分开' },
  { name: 'classifyAccountFailure', why: '指纹类拒绝不得判为账户失败（否则会把用户所有可用 Key 逐把冷却掉还继续往上打）' },
  { name: 'ACCOUNT_RATE_COOLDOWN_MAX_MS', why: '新增：限流冷却上限（含 Retry-After 的夹取）' },
  { name: 'rateCooldownMs', why: '新增：429 冷却优先遵循服务端 Retry-After，否则按连续失败次数指数增长并加 ±20% 抖动（旧实现固定 90 秒、无抖动 → 多账户同刻复活再一起撞墙）' },
  { name: 'retryAfterMs', why: '新增：解析 Retry-After（秒数或 HTTP-date）。旧实现全文件 0 处引用它 —— 无视限流头是升级为封禁的常见路径' },
  { name: 'ACCOUNT_RATE_COOLDOWN_MS', why: '注释更新（由基准值改为基准值+上限）' },
  { name: 'markAccountFailure', why: '接受并应用上游 Retry-After' },
  { name: 'breakerRecordFail', why: '接受可选的服务端 Retry-After 作为短熔断下限（不再"刚被限流就立刻回来接着打"）' },
  { name: 'forwardWithAccounts', why: '把 failureSink 里的 Retry-After 透传给 markAccountFailure' },
  { name: 'forward', why: '接入指纹拒绝/地区受限分支（**在通配 4xx/5xx 熔断之前**判定，否则地区受限的模型会把整家 13 个正常模型一起封掉）；429 冷却传入 Retry-After；failureSink 带 retryMs' },
  { name: 'forwardAnthropicViaOpenAI', why: '同上（Anthropic 翻译路径保持一致）' },
  { name: 'handleModels', why: '透传 cfg 到 fetchCatalog' },
  { name: 'handleCompletion', why: '透传 cfg 到 header 构造' },
  { name: 'handleMessages', why: '同上' },
  { name: 'handleResponsesResource', why: '同上' },

  // —— 逐模型超时（2026-09-30，用户要求）——
  { name: 'modelTimeoutMs', why: '新增：逐模型超时。同一家里不同模型速度能差一个数量级（实测 amd 的 DeepSeek-V4.1-Flash 首字节 13.7–15.5s，同家 DeepSeek-V4-Flash 只要 0.7–1.1s）；只配供应商级时只能按最慢的定，于是一个挂住的慢模型就能把该家快的模型一起拖累' },
  { name: 'providerTimeoutMs', why: '超时优先级改为 模型级 > 供应商级 > 全局默认（新增可选的 model 参数）' },
  { name: 'UPSTREAM_TIMEOUT_MS', why: '仅前导注释块位置变化（常量值一字未改）' },

  // —— 缓存时效 ——
  { name: 'workbuddyVersionCache', why: '缓存加时间戳' },
  { name: 'WORKBUDDY_VERSION_TTL_MS', why: '新增：版本缓存 TTL。客户端自动更新后旧实现会一直发旧版本号（身份头与实际版本不一致，正是仿真里最不该有的破绽）' },
  { name: 'readWorkbuddyVersions', why: '按 TTL 重读版本' },

  // —— 与上游无差异但块边界受上面注释影响的（脚本按"块"比对，注释归属会让相邻块显示为变化）——
  { name: 'accountUsable', why: '仅前导注释块位置变化（函数体一字未改）' },
  { name: 'readTextWithTimeout', why: '仅前导注释块位置变化（函数体一字未改）' },

  // —— 2026-10-07：dsh 写入目标跟进官方新格式（profile patch）——
  // 实测背景：官方 dsh 已把 settings.yaml 标记为 **removed** —— 启动时 importLegacyDocument()
  // 只把它导入一次然后改名成 .imported，而且必须重启才生效。当前真正生效的载体是
  // `<dshHome>/profiles/<profile>/cordis.patch.yml` 里 `- id: llm-pi-ai` 项的 config。
  // 只写 settings.yaml 的话，用户会遇到"命令报成功、dsh 里看不到网关"，而且过一阵还会消失。
  { name: 'reindentBlock', why: '新增：把 gateway 块整体缩进（settings.yaml 里是 4 空格，profile patch 里多一层 `- id:` 数组项、要 6 空格）' },
  { name: 'upsertGatewayInPatch', why: '新增：在 profile patch 里按缩进层级 upsert `- id: llm-pi-ai → config.providers.gateway`。只合并 gateway 一个键（实测踩到：整段替换会把用户已配的其它供应商全部抹掉）' },
  { name: 'writeDshConfig', why: '除 settings.yaml 外**同时**写 profile patch（新老版本互相兜底）；profile 目录不存在时跳过，patch 无法安全合并时如实报错而不是静默跳过' },
  { name: 'writeFileAtomicDsh', why: '仅前导注释块位置变化（函数体一字未改）—— 新增的两个函数插在它前面，脚本按"块"比对会把注释归属算进来' },
];

/** 把源码切成"顶层块"：以列 0 开始的 function/const/let/var/class 声明为界。 */
function blocks(src) {
  const lines = src.split(/\r?\n/);
  const out = new Map();
  let name = '<文件头>';
  let buf = [];
  const flush = () => { out.set(name, (out.get(name) || '') + buf.join('\n')); buf = []; };
  for (const l of lines) {
    const m = /^(?:async\s+)?(?:function\s+([A-Za-z0-9_$]+)|(?:const|let|var)\s+([A-Za-z0-9_$]+)|class\s+([A-Za-z0-9_$]+))/.exec(l);
    if (m) { flush(); name = m[1] || m[2] || m[3]; }
    buf.push(l);
  }
  flush();
  return out;
}

const norm = (s) => s.replace(/\r/g, '').replace(/[ \t]+$/gm, '').trim();

const verbose = process.argv.includes('--verbose');
const baselinePath = BASELINE_CANDIDATES.find((p) => existsSync(p));

if (!baselinePath) {
  console.log('[SKIP] 找不到 dsh-app 的引擎基线，无法做差异校验。');
  console.log('       可设 DSH_GATEWAY_ENGINE_BASELINE 指向基线文件后重跑。');
  console.log('       候选位置：');
  for (const p of BASELINE_CANDIDATES) console.log('         ' + p);
  process.exit(0);
}

const a = blocks(readFileSync(baselinePath, 'utf8'));
const b = blocks(readFileSync(CURRENT, 'utf8'));

const changed = [];
const removed = [];
const added = [];
for (const n of new Set([...a.keys(), ...b.keys()])) {
  const x = a.get(n);
  const y = b.get(n);
  if (x === undefined) { added.push(n); continue; }
  if (y === undefined) { removed.push(n); continue; }
  if (norm(x) !== norm(y)) changed.push(n);
}

console.log('基线：' + baselinePath);
console.log('当前：' + CURRENT);
console.log(`块总数：基线 ${a.size} / 当前 ${b.size}；有变化的块 ${changed.length} 个，新增 ${added.length} 个，删除 ${removed.length} 个`);
console.log('');

const declaredNames = new Set(DECLARED.map((d) => d.name));
const problems = [];

// ① 所有变化都必须被声明
for (const n of [...changed, ...added, ...removed]) {
  if (!declaredNames.has(n)) problems.push(`「${n}」发生了变化但**没有**在 DECLARED 清单里声明`);
}
// ② 声明了但实际没变 → 清单腐烂
for (const d of DECLARED) {
  const existsNow = b.has(d.name);
  const existsBefore = a.has(d.name);
  const isChanged = changed.includes(d.name) || added.includes(d.name) || removed.includes(d.name);
  if (!isChanged) {
    problems.push(`「${d.name}」在清单里声明为"已改动"，但实际上与基线一致（清单已过期）`);
  } else if (!existsNow && !existsBefore) {
    problems.push(`「${d.name}」在两边都不存在`);
  }
}

if (verbose) {
  console.log('==== 已声明的改动 ====');
  for (const d of DECLARED) console.log(`  · ${d.name}\n      ${d.why}`);
  console.log('');
}

if (problems.length) {
  console.log('[FAIL] 引擎差异与声明不符：');
  for (const p of problems) console.log('  ✗ ' + p);
  console.log('');
  console.log('  如果这是有意改动：请在 scripts/check-engine-parity.mjs 的 DECLARED 里补一条，');
  console.log('  并写清"改了什么、为什么"。如果这是无意改动 —— 那就是**功能回退**，请撤回。');
  process.exit(1);
}

console.log(`[OK] 差异与声明一致：共 ${DECLARED.length} 处已声明改动，无未声明变化。`);
console.log('     每一处的理由见 scripts/check-engine-parity.mjs 的 DECLARED（用 --verbose 打印）。');
console.log('     ⇒ 「除这些块之外，引擎没有别的块被改动」这句话可机器复核。');
console.log('     ⚠ 粒度是**块**不是行：一旦某个块进了 DECLARED，之后对它内部的修改');
console.log('       （包括整段删功能）就不会再被发现 —— 那由 tests/gateway.test.js 等测试守。');
