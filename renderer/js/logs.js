/* logs.js — 日志页（过滤、级别着色、自动滚动） */
'use strict';

const LOG_MAX_LINES = 4000;

/**
 * 按内容猜日志级别。
 *
 * ⚠ 中文关键词**不能**用 `\b` 包。
 * JS 的 `\b` 是 **ASCII** 词边界（`\w` = `[A-Za-z0-9_]`），中日韩字符一律被当作非单词字符，
 * 于是 `\b失败\b` 永远不可能匹配 —— 而引擎日志里"失败"有 100+ 处、"熔断"80+ 处、
 * "冷却"60+ 处。旧实现在这些行上全部返回无色，用户看到一片灰以为一切正常。
 * 另外 `\bError\b` 在 `ReferenceError` 里也匹配不上（前面是字母）—— 那才是我们最想标红的行。
 * 所以：英文词用不带边界的子串匹配（`errors`、`ReferenceError` 都能命中），中文直接子串匹配。
 * 判定顺序仍是 错误 > 警告 > 正常 > 高亮。
 */
function logLineClass(line) {
  const s = String(line == null ? '' : line);

  // ① 先摘掉"看着像错误、其实是正常自愈"的行。
  //    `upstream p1 网络错误（ECONNRESET，1200ms）→ 原地重试一次` 含"错误"，
  //    按下面的 err 规则会把整行标红 —— 可它描述的恰恰是"抖动已自动恢复"。
  //    这类行多了会让用户以为网关不稳，去改配置/换供应商。
  if (/原地重试一次|重试成功|已降敏重试/.test(s)) return 'warn';

  // ② 判定顺序：错误 > 高亮 > 警告 > 正常。
  // 「一键写入」要排在"成功"前面，否则 `一键写入[claude-code]：成功` 会被当成普通成功行。
  if (/error|failed|failure|exception|unhandled|不合法|非法|失败|错误|异常|拒绝|熔断|不可用|泄漏|未通过/i.test(s)) return 'err';

  // ③ 带状态码的行按**状态码**定级 —— 比"有没有中文错误词"可靠得多。
  //    · `status=NNN` 出现在 `[call]` 收尾行上，是**客户端最终拿到的**状态：
  //      `[call] responses POST … status=502` 整行没有任何中文错误词，
  //      旧实现把它归进 `[call]` → 绿色"成功"。一次彻底失败的请求被标成绿的，是最坏的一种误判。
  //    · `HTTP NNN` 出现在上游交互行上，是**上游返回的**状态：至少算警告。
  //      不直接判 err —— 这类行后面常常跟着"→ 继续 failover"，请求最终可能成功；
  //      真失败的行会带"失败/错误/熔断"等词，已经被上面接走了。
  //    注意顺序：`status=` 必须放在 `[call]` 的 ok 规则**之前**。
  {
    const mStat = /\bstatus=(\d{3})\b/i.exec(s);
    if (mStat) {
      const c = Number(mStat[1]);
      return (c >= 200 && c < 300) ? 'ok' : 'err';
    }
  }

  if (/\[write-dsh\]|一键写入/.test(s)) return 'hl';
  // ③ 警告。
  //    后半段是**failover 的决策行**：它们既不含"错误"也不含"失败"，旧实现一律无色，
  //    用户扫日志时直接跳过 —— 而这正是"为什么这次请求走了那家/为什么被拒"的答案。
  if (/warn|deprecat|retry|timeout|超时|重试|冷却|跳过|降级|回退|占位|忽略|限流|rate.?limit|\b429\b|余额|额度|缺少|breaker open|skip/i.test(s)) return 'warn';
  if (/failover stopped|终止 failover|继续 failover|无候选|归属无法判定|不支持 thinking|不支持该模型/i.test(s)) return 'warn';
  // 上游返回了 4xx/5xx（哪怕这一行没写"失败"两个字）
  if (/\bHTTP\s+[45]\d\d\b/i.test(s)) return 'warn';
  // ④ 正常。
  //    ⚠ `[route]` 不能无条件算正常：`[route] model-x: 无候选 provider（没有一家声明该模型）`
  //    是最该被立刻看见的路由失败（模型名拼错 / 供应商被停用），旧实现给它贴的是
  //    绿色"路由成功"色。那类行已被上面的 warn 分支接走，到这里的才是正常路由。
  if (/\[route\]|\[call\]|listening|已就绪|ready|已启动|已写入|成功/.test(s)) return 'ok';
  return '';
}

function renderLogs() {
  const box = $('#logBox');
  if (!box) return;
  const q = String(($('#logFilter') || {}).value || '').trim().toLowerCase();
  let lines = String(LG.logText || '').split(/\r?\n/);
  if (lines.length > LOG_MAX_LINES) lines = lines.slice(-LOG_MAX_LINES);
  if (q) lines = lines.filter((l) => l.toLowerCase().includes(q));

  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = lines.map((l) => {
    const c = logLineClass(l);
    return `<span class="ln ${c}">${esc(l)}</span>`;
  }).join('');

  const auto = $('#logAutoScroll');
  if (auto && auto.checked && (near || !box.dataset.inited)) {
    box.scrollTop = box.scrollHeight;
  }
  box.dataset.inited = '1';
}

function setLogText(text) {
  LG.logText = String(text == null ? '' : text);
  // 只在日志页可见时重绘（避免后台每 800ms 一次无谓的 DOM 重建）
  if (LG.activeView === 'logs') renderLogs();
}

LG.renders.logs = renderLogs;

LG.initLogs = function initLogs() {
  $('#logFilter').addEventListener('input', () => renderLogs());
  $('#btnLogClear').addEventListener('click', async () => {
    await window.lgw.gwAction('clear-log');
    LG.logText = '';
    renderLogs();
    toast('已清屏（仅清界面缓冲，日志文件不动）', 'ok', 2600);
  });
  $('#btnLogFile').addEventListener('click', () => {
    if (LG.state) window.lgw.openPath(LG.state.dataDir + '\\logs\\gateway.log');
  });
  renderLogs();
};
