// public/select-preserve.js —— 下拉框值保真 helper（#D Bug 修复）
// 问题：旧 config 中 tid/copyright/noReprint/line 含非内置选项（如 tid=20）时，
// 对应 <select> 无匹配项，浏览器会取消选中（value 回落为 ""），保存时被
// Number("") || 17 等兜底静默改错，导致存量用户分区被覆盖。
// 本 helper 在「值不命中任何 option」时，动态追加一个「其它 (val)」option 并选中，
// 保证原值能被读回，不丢数据。
// 双导出：浏览器挂到 window / globalThis；Node 单测走 module.exports。
(function () {
  'use strict';

  /**
   * 把 val 安全写入 <select>，兼容「值不在 option 集合」的情况。
   * @param {HTMLSelectElement} sel 目标下拉框
   * @param {*} val 待写入的值（null / 空串 → 清空选中）
   */
  function selectPreserve(sel, val) {
    if (!sel) return;
    if (val == null || val === '') {
      sel.value = '';
      return;
    }
    const str = String(val);
    sel.value = str;
    // 浏览器：当无匹配 option 时，赋值后 select.value 会回落为空，与期望值不一致。
    if (sel.value !== str) {
      const doc = sel.ownerDocument || (typeof document !== 'undefined' ? document : null);
      const opt = (doc && typeof doc.createElement === 'function')
        ? doc.createElement('option')
        : { value: str, textContent: '', selected: false };
      opt.value = str;
      opt.textContent = '其它 (' + str + ')';
      opt.selected = true;
      sel.appendChild(opt);
    }
  }

  const api = { selectPreserve: selectPreserve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.selectPreserve = selectPreserve;
  if (typeof globalThis !== 'undefined') globalThis.selectPreserve = selectPreserve;
})();
