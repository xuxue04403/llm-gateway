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
  // 顺序很重要：错误 > 高亮 > 警告 > 正常。
  // 「一键写入」要排在"成功"前面，否则 `一键写入[claude-code]：成功` 会被当成普通成功行。
  if (/error|failed|failure|exception|unhandled|不合法|非法|失败|错误|异常|拒绝|熔断|不可用|泄漏|未通过/i.test(s)) return 'err';
  if (/\[write-dsh\]|一键写入/.test(s)) return 'hl';
  if (/warn|deprecat|retry|timeout|超时|重试|冷却|跳过|降级|回退|占位|忽略|限流|rate.?limit|\b429\b|余额|额度|缺少|breaker open|skip/i.test(s)) return 'warn';
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
