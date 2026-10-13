// 离线 英文名→Steam AppID 映射（无需联网，fork 子进程内置）。
// 数据来源：data-pack.json（手工精选常见游戏，与 gameNames 同包、同版本，可增量更新——见 datapack.js）。
// 设计动机：store.steampowered.com/api/storesearch 在受限网络下（fork 子进程不继承代理变量）连不上，
//   导致 AppID 在线获取失败；而英文名靠 Bangumi/离线库已能拿到。本文件让「已有英文名 → AppID」也走离线，
//   与离线英文名库形成闭环，常见游戏零网络依赖即可拿到 AppID。
// 查找：归一化英文名精确匹配（内置 + 可更新缓存）；未命中返回 null，交由上层网络兜底（配代理时 storesearch 仍可用）。

const { getActiveDataPack } = require("./datapack");
const { lookupSteamAppId } = require("./steamindex");

/** 英文名归一化：小写、去所有非字母数字（含空格/标点/冒号）。 */
function normEn(s) {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** 罗马数字→阿拉伯数字（只匹配结尾，避免误伤 i/v/x 开头的单词） */
const ROMAN = { viii: 8, vii: 7, iii: 3, ii: 2, ix: 9, iv: 4, vi: 6, xi: 11, x: 10, v: 5, i: 1 };
function toArabic(n) {
  return String(n).replace(/(viii|vii|iii|ii|ix|iv|vi|xi|x|v|i)$/, (m) =>
    ROMAN[m] ? String(ROMAN[m]) : m,
  );
}

/** 宽松键：归一化 + 罗马数字转数字（"warhammeriii" → "warhammer3"） */
function looseKey(s) {
  const n = normEn(s);
  return n ? toArabic(n) : "";
}

/** 去副标题的宽松键：冒号/破折号只取前半（"Total War: Warhammer III" → "totalwar"） */
function looseKeyNoSub(s) {
  const first = String(s == null ? "" : s).split(/[:：\-–—]/)[0];
  return looseKey(first);
}

/**
 * 离线解析 Steam AppID（英文名 → AppID）。
 * 匹配顺序：精确 → 宽松（罗马数字↔数字）→ 去副标题 → 库里键的宽松形态比对。
 * 以前只做精确匹配，导致 "Total War: Warhammer III" 这类带副标题/罗马数字的名字即使库里有也命中不了。
 * @param {string} englishName 已解析的游戏英文名
 * @returns {string|null} AppID 字符串；未命中返回 null
 */
function lookupAppIdOffline(englishName) {
  if (!englishName) return null;
  const pack = getActiveDataPack();
  const ids = pack.appIds || {};
  const direct = [normEn(englishName), looseKey(englishName), looseKeyNoSub(englishName)].filter(
    Boolean,
  );
  for (const k of direct) if (ids[k]) return String(ids[k]);
  const want = new Set(direct);
  for (const k of Object.keys(ids)) {
    if (want.has(looseKey(k)) || want.has(looseKeyNoSub(k))) return String(ids[k]);
  }
  // 精选小库未命中 → 查商店全量大库（17 万+ 中/英文名），命中就不必再走网络
  const big = lookupSteamAppId(englishName);
  if (big) return big;
  return null;
}

module.exports = { normEn, looseKey, looseKeyNoSub, lookupAppIdOffline };
