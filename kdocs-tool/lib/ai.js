// ── 已废弃：阿里百炼（bl CLI）AI 集成 ──
// 自 v2.8.0 起，kdocs-tool 不再依赖阿里百炼为游戏简介 / 大小 / 封面提供兜底：
//   · 简介主源统一为 Steam 官方 store 描述（质量最高、零编造）；缺失则占位待人工补充
//   · 封面主源统一为 Steam 官方 CDN；缺失则留空
// 不再有「AI 生成」兜底分支。
//
// 本文件仅作为占位保留，避免历史 require 路径直接崩溃；新代码请勿再 require 本模块。
// 后续可在干净环境中执行：
//   git rm kdocs-tool/lib/ai.js kdocs-tool/test/ai.test.js scripts/prune-bailian.js
// 将其彻底删除。
//
// 历史导出名仍保留为安全占位（均为 no-op / 永不匹配），以便任何遗漏的引用不会直接抛错。
module.exports = {
  checkBlAvailable: async () => false,
  aiDescribe: async () => ({ intro: "", size: "", coverUrl: "" }),
  aiCoverSearch: async () => "",
  parseSingle: () => ({ intro: "", size: "", badIntro: false, badSize: false }),
  buildPrompt: () => "",
  INTRO_BLACKLIST: /$.^/, // 永不匹配占位
  isBadIntro: () => false,
  isBadSize: () => false,
};
