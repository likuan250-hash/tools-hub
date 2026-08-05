// 离线 英文名→Steam AppID 映射（无需联网，fork 子进程内置）。
// 数据来源：手工精选常见游戏（与 game-name-override.json 同源思路，仅覆盖确实上架 Steam 的游戏）。
// 设计动机：store.steampowered.com/api/storesearch 在受限网络下（fork 子进程不继承代理变量）连不上，
//   导致 AppID 在线获取失败；而英文名靠 Bangumi/离线库已能拿到。本文件让「已有英文名 → AppID」也走离线，
//   与离线英文名库形成闭环，常见游戏零网络依赖即可拿到 AppID。
// 查找：归一化英文名精确匹配；未命中返回 null，交由上层网络兜底（配代理时 storesearch 仍可用）。

const MAP = {};
try {
  const raw = require("./game-appid-override.json");
  for (const k of Object.keys(raw)) {
    const nk = normEn(k);
    if (nk) MAP[nk] = String(raw[k]);
  }
} catch (_) { /* 文件缺失不致命，退化为纯网络 */ }

/** 英文名归一化：小写、去所有非字母数字（含空格/标点/冒号）。 */
function normEn(s) {
  if (!s) return "";
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * 离线解析 Steam AppID（英文名 → AppID）。
 * @param {string} englishName 已解析的游戏英文名
 * @returns {string|null} AppID 字符串；未命中返回 null
 */
function lookupAppIdOffline(englishName) {
  if (!englishName) return null;
  const n = normEn(englishName);
  if (!n) return null;
  return MAP[n] ? String(MAP[n]) : null;
}

module.exports = { normEn, lookupAppIdOffline };
