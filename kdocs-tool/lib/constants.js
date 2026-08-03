// ── 录入链路共享文本质量常量 ──
// 抽到单一真源，避免 executor 与 ai 各定义一份导致漂移。
// 前半段：bl 可能把"严禁编造"理解成"查不到就说虚构"，这类免责声明输出应丢弃并兜底。
// 后半段：规范文档 §3.3「禁止事项」的安全网——"该游戏"开头、"支持中文"、推测评分、
// 罗列平台、空泛形容词堆砌，即使 prompt 已明令禁止仍可能漏出，命中即判不合格并走兜底。
// 注意：只用 i 标志，不要加 g。带 g 的正则是模块级共享对象，.test() 会残留 lastIndex 状态，
// 连续调用时可能从上次命中位置继续搜而漏判开头的禁用词（命中率随候选词增多而上升）。
// 这里只通过 .test() 做"是否包含禁用词"判断，不需要 g。
const INTRO_BLACKLIST = /疑似虚构|无法确认|经核实无真实|请勿轻信|非官方渠道|暂无公开资料|无法核实|没有公开资料|不存在|误传|虚构|该游戏|支持中文|推测评分|罗列平台|精美画面|极致体验|沉浸式|身临其境/i;
const SIZE_EMPTY = /^(无|未知|none|null|未抓取到)?$/i;

// ── 大小归一化 ──
// 把各种写法（"30.7G" / "2T" / "512MB" / "800K" / "30.7GB"）统一为规范文档 §2.5 的
// 短格式 "30.7G" / "2T" / "512M" / "800K"（一位小数，不写 GB/TB），便于跨来源一致与比较。
// 输入仍兼容长短两种写法（幂等：normalizeSize("30.7G") === normalizeSize("30.7GB") === "30.7G"）。
// 纯函数，可单测；无法识别或非法值返回 ""。
const SIZE_UNIT_RE = /(\d+(?:\.\d+)?)\s*(B|KB|K|MB|M|GB|G|TB|T)\b/i;
function normalizeSize(raw) {
  if (raw == null) return "";
  const m = String(raw).match(SIZE_UNIT_RE);
  if (!m) return "";
  const v = parseFloat(m[1]);
  if (!isFinite(v) || v <= 0) return "";
  // 统一输出短写单位（§2.5）：KB→K / MB→M / GB→G / TB→T；B 保持 B
  let unit = m[2].toUpperCase();
  if (unit === "KB") unit = "K";
  else if (unit === "MB") unit = "M";
  else if (unit === "GB") unit = "G";
  else if (unit === "TB") unit = "T";
  // >=100 取整（如 512M / 123G），否则保留 1 位小数；去掉多余的 .0
  let s = v >= 100 ? v.toFixed(0) : v.toFixed(1);
  s = s.replace(/\.0$/, "");
  return s + unit;
}

function isBadIntro(s) {
  return !s || INTRO_BLACKLIST.test(s) || s.length < 10;
}
function isBadSize(s) {
  return !s || SIZE_EMPTY.test(s.trim());
}

module.exports = { INTRO_BLACKLIST, SIZE_EMPTY, SIZE_UNIT_RE, normalizeSize, isBadIntro, isBadSize };
