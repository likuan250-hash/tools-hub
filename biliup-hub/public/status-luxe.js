// status.js —— 状态组件「全量豪华档」逻辑（单一真源，三处副本逐字节一致）
// 浏览器全局 + Node 模块双导出：供前端 <script> 与单测 require 共用。

// 严重度（由轻到重）：ok0 info1 warn2 off3 err4
const SEV = { ok: 0, info: 1, warn: 2, off: 3, err: 4 };

/**
 * 聚合一组状态等级，返回严重度最高者（纯函数，便于单测）。
 * @param {string[]} levels 等级数组，可含非法 token（自动忽略）
 * @returns {string} 最严重等级，空数组返回 'ok'
 */
function aggregateStatus(levels) {
  let best = 'ok', bestSev = -1;
  for (const l of (levels || [])) {
    if (!(l in SEV)) continue;
    if (SEV[l] > bestSev) { bestSev = SEV[l]; best = l; }
  }
  return best; // 空数组→'ok'
}

// 入口翻红：off/err 均显红
function aggColorLevel(tok) {
  return (tok === 'off' || tok === 'err') ? 'err' : tok;
}

/**
 * 生成玻璃态状态胶囊 HTML 字符串。
 * @param {string} level ok|info|off|warn|err
 * @param {string} text 文字标签
 * @param {{size?:'sm'|'md', pulse?:boolean}} [opts]
 */
function statusHTML(level, text, opts) {
  opts = opts || {};
  const size = opts.size === 'sm' ? 'sm' : 'md';
  const pulse = opts.pulse ? ' st-luxe--pulse' : '';
  const aria = text;
  return `<span class="st-luxe st-luxe--${level} st-luxe--${size}${pulse}" role="status" aria-label="${aria}">`
    + `<span class="st-luxe__dot st-luxe__dot--${level}" aria-hidden="true"></span>`
    + `<span class="st-luxe__text">${text}</span>`
    + `<span class="st-luxe__sweep" aria-hidden="true"></span>`
    + `</span>`;
}

// 光标光斑：鼠标移到 info 态时把位置写入 --mx/--my 供 ::after 径向高光使用
function bindStatusCursor(root) {
  root.addEventListener('mousemove', (e) => {
    const el = e.target.closest && e.target.closest('.st-luxe--info');
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
    el.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { statusHTML, aggregateStatus, aggColorLevel, bindStatusCursor };
}
if (typeof window !== 'undefined') {
  window.statusHTML = statusHTML;
  window.aggregateStatus = aggregateStatus;
  window.aggColorLevel = aggColorLevel;
  window.bindStatusCursor = bindStatusCursor;
}
