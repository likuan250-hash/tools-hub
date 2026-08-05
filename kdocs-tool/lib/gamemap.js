// 离线中文名→英文名映射（无需联网，electron 主进程内置）。
// 数据来源：
//   game-name-map.json      —— Karasukaigan/pc-game-name-translations（2.5万条，en/zh/ja）归一化索引（大库，随整包升级）
//   data-pack.json          —— 手工精选短写法兜底（覆盖用户常录入的缩写，零误判）+ 可被主进程启动时从 GitHub
//                              Release 静默增量更新（见 datapack.js，缓存版本更高则优先）
// 查找顺序：data-pack 精确（含更新） → 大库精确 → 大库前缀包含模糊。命中即返回英文名。

const { getActiveDataPack } = require("./datapack");

let BIG = {};
try { BIG = require('./game-name-map.json'); } catch (_) { BIG = {}; }

/** 中文游戏名归一化：小写、全角→半角、去空白/标点、去「的」、重置版/复刻版→重制版。 */
function normZh(s) {
  if (!s) return '';
  let t = String(s).toLowerCase();
  t = t.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  t = t.replace(/\s+/g, '');
  t = t.replace(/[：:·•、，,.。!！?？()（）\[\]【】""''«»/\\|_\-—～~*+#@%&='"]/g, '');
  t = t.replace(/的/g, '');
  t = t.replace(/重置版|复刻版/g, '重制版');
  return t;
}

/**
 * 离线解析游戏英文名（中文名 → 英文名）。
 * 约定：传入已清洗的游戏名（cleanGameName 之后），不做二次清洗，保持纯函数、无外部依赖。
 * @param {string} gameName 已清洗的中文游戏名
 * @returns {string} 英文名；未命中返回 ""
 */
function lookupEnglishNameOffline(gameName) {
  if (!gameName || !String(gameName).trim()) return '';
  const n = normZh(gameName);
  if (!n) return '';
  // 1) 手工精选兜底（data-pack：内置 + 可增量更新，最高优先，覆盖率虽小但零误判）
  const pack = getActiveDataPack();
  if (pack.gameNames[n]) return pack.gameNames[n];
  // 2) 大库精确
  if (BIG[n]) return BIG[n];
  return '';
}

module.exports = { normZh, lookupEnglishNameOffline };
