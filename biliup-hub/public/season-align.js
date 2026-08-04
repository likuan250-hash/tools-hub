// public/season-align.js —— 合集/分集字段对齐 helper（#问题1 修复）
// 语义断链：UI 的「合集」(cfgSeason → config.seasonId) 是用户主要填写项，
// 但后端 lib/task.js 仅以「分集」(cfgSection → config.sectionId) 触发合集后置(season.add)。
// 用户只选合集、未选分集 → config.sectionId 为空 → task.js 跳过合集后置。
// 修复（需求①「选即生效」）：合集一旦选中即有分集时，自动选中第一个分集，
// 使「用户只填合集」也能对齐到 sectionId，无需再手动选分集。
//   - 多分集：默认自动选第一个分集（选即生效）；用户若想换分集仍可手动改。
//   - 单分集：自动选中唯一分集（等价旧行为）。
//   - 无分集：返回 null（无需后置；前端 field-hint 会提示「该合集暂无可选分集」）。
// 注意：app.js 的 fillSections 会优先保留用户/历史已选 prev，故「返回第一个」只作默认，
// 不会覆盖用户已有的明确选择。
// 双导出：浏览器挂 window / globalThis；Node 单测走 module.exports。
(function () {
  'use strict';

  /**
   * 给定某合集的分集列表，返回应「自动选中」的分集 id。
   * 合集含 ≥1 个分集时返回第一个分集 id（字符串）；空数组/无分集返回 null。
   * @param {Array<{id:string|number, title?:string}>} [sections]
   * @returns {string|null}
   */
  function autoSelectSection(sections) {
    if (Array.isArray(sections) && sections.length >= 1 && sections[0] && sections[0].id != null) {
      return String(sections[0].id);
    }
    return null;
  }

  const api = { autoSelectSection: autoSelectSection };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.autoSelectSection = autoSelectSection;
  if (typeof globalThis !== 'undefined') globalThis.autoSelectSection = autoSelectSection;
})();
