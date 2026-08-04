// public/coerce-int.js —— 整数解析 helper（#noReprint falsy 陷阱修复）
// 问题：saveCfgBtn 用 Number(x) || def 兜底，noReprint 的 option value="0"（禁止转载）
// 经 Number("0")=0 → 0 || 1 = 1，被静默改写成「允许转载」。
// 本 helper 仅在「空串 / null」时回退默认值，0 与合法数字原样返回。
// 双导出：浏览器挂 window / globalThis；Node 单测走 module.exports。
(function () {
  'use strict';

  /**
   * 解析为整数；空串 / null / 非有限数 → 默认值 def。
   * 关键点：0 是合法值，不会被当作 falsy 兜底（修复 noReprint=0 被改写）。
   * @param {*} v 待解析值
   * @param {number} def 兜底默认值
   * @returns {number}
   */
  function coerceInt(v, def) {
    if (v === '' || v == null) return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  const api = { coerceInt: coerceInt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.coerceInt = coerceInt;
  if (typeof globalThis !== 'undefined') globalThis.coerceInt = coerceInt;
})();
