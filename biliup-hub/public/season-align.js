// public/season-align.js —— 合集/分集字段对齐 helper（#问题1 修复）
// 语义断链：UI 的「合集」(cfgSeason → config.seasonId) 是用户主要填写项，
// 但后端 lib/task.js 仅以「分集」(cfgSection → config.sectionId) 触发合集后置(season.add)。
// 用户只选合集、未选分集 → config.sectionId 为空 → task.js 跳过合集后置。
// 修复：当合集仅含「一个分集」时，自动选中该分集，使「用户只填合集」也能对齐到 sectionId。
//   - 多分集：不猜测，必须由用户明确选择（避免加错分集）。
//   - 无分集：无需后置。
// 双导出：浏览器挂 window / globalThis；Node 单测走 module.exports。
(function () {
  'use strict';

  /**
   * 给定某合集的分集列表，返回应「自动选中」的分集 id。
   * 仅当恰好一个分集时返回其 id（字符串），其余情况返回 null（交由用户明确选择/留空）。
   * @param {Array<{id:string|number, title?:string}>} [sections]
   * @returns {string|null}
   */
  function autoSelectSection(sections) {
    if (Array.isArray(sections) && sections.length === 1 && sections[0] && sections[0].id != null) {
      return String(sections[0].id);
    }
    return null;
  }

  const api = { autoSelectSection: autoSelectSection };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.autoSelectSection = autoSelectSection;
  if (typeof globalThis !== 'undefined') globalThis.autoSelectSection = autoSelectSection;
})();
