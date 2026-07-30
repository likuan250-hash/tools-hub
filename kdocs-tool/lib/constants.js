// ── 录入链路共享文本质量常量 ──
// bl 可能把"严禁编造"理解成"查不到就说虚构"，这类输出应丢弃并兜底。
// 抽到单一真源，避免 executor 与 ai 各定义一份导致漂移。
const INTRO_BLACKLIST = /疑似虚构|无法确认|经核实无真实|请勿轻信|非官方渠道|暂无公开资料|无法核实|没有公开资料|不存在|误传|虚构/gi;
const SIZE_EMPTY = /^(无|未知|none|null|未抓取到)?$/i;

function isBadIntro(s) {
  return !s || INTRO_BLACKLIST.test(s) || s.length < 10;
}
function isBadSize(s) {
  return !s || SIZE_EMPTY.test(s.trim());
}

module.exports = { INTRO_BLACKLIST, SIZE_EMPTY, isBadIntro, isBadSize };
