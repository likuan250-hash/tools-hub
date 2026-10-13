// 离线 Steam AppID 大库（英文名/中文名 → AppID，约 17 万+ 条，含商店中文名）。
// 数据文件：steam-appid-index.json.gz（由 scripts/build-steam-appid-index.cjs 生成，随包发布）。
// 与 gameappid.js 的分工：data-pack.json 是手工精选的小库（零误判、可热更新），本文件是大库兜底，
// 只有小库未命中时才查，用于把「离线拿不到 AppID → 走网络（受限网络下常失败）」的比例压下去。

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const INDEX_FILE = path.join(__dirname, "steam-appid-index.json.gz");
// 可选增量覆盖：{KDOCS_DATA_DIR}/steam-appid-index.json.gz（存在则优先，便于不发整包更新大库）
const OVERRIDE_FILE = path.join(
  process.env.KDOCS_DATA_DIR || path.join(__dirname, "..", "cache"),
  "steam-appid-index.json.gz",
);

let MAP = null;
let LOAD_FAILED = false;

/** 归一化：小写、去掉全部标点/空白（中日文与字母数字保留），与索引构建脚本保持一致。 */
function normIndexKey(s) {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u2122\u00ae\u2120]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff]/g, "");
}

const ROMAN = { viii: 8, vii: 7, iii: 3, ii: 2, ix: 9, iv: 4, vi: 6, xi: 11, x: 10, v: 5, i: 1 };
function toArabic(n) {
  return String(n).replace(/(viii|vii|iii|ii|ix|iv|vi|xi|x|v|i)$/, (m) =>
    ROMAN[m] ? String(ROMAN[m]) : m,
  );
}

function loadIndex() {
  if (MAP) return MAP;
  if (LOAD_FAILED) return (MAP = {});
  try {
    const file = fs.existsSync(OVERRIDE_FILE) ? OVERRIDE_FILE : INDEX_FILE;
    MAP = JSON.parse(zlib.gunzipSync(fs.readFileSync(file))).map || {};
  } catch (e) {
    LOAD_FAILED = true;
    MAP = {};
  }
  return MAP;
}

/**
 * 键是否足够"具体"到可以放心采用。
 * 大库里有 1900+ 条超短键（"0"/"1"/"x"/"3a"…），拿它们去匹配"X""3"这类噪声名会查出无关游戏，
 * 所以：纯数字键直接弃用；纯拉丁键要求 ≥4 字符；含中日文的键要求 ≥2 个汉字/假名。
 */
function usableKey(k) {
  if (!k || /^\d+$/.test(k)) return false;
  const cjk = k.match(/[\u4e00-\u9fff\u3040-\u30ff]/g);
  if (cjk && cjk.length >= 2) return true;
  return k.length >= 4;
}

/**
 * 查离线大库。
 * 英文名：精确 → 罗马数字转阿拉伯 → 去副标题（仅拉丁名，避免中文名被冒号截断误配）。
 * 中文名：只做精确匹配（索引里的中文名就是商店原名）。
 */
function lookupSteamAppId(name) {
  if (!name) return null;
  const map = loadIndex();
  const raw = String(name).trim();
  if (!raw) return null;
  const exact = normIndexKey(raw);
  if (usableKey(exact) && map[exact]) return String(map[exact]);
  if (!/[a-z]/i.test(raw)) return null;
  const arabic = toArabic(exact);
  if (usableKey(arabic) && map[arabic]) return String(map[arabic]);
  const head = raw.split(/[:：\-–—]/)[0];
  const noSub = normIndexKey(head);
  if (noSub.length >= 5 && noSub !== exact && usableKey(noSub) && map[noSub])
    return String(map[noSub]);
  return null;
}

/** 索引规模（用于日志/自检；未加载时返回 0，不触发加载）。 */
function indexSize() {
  return Object.keys(loadIndex()).length;
}

module.exports = { lookupSteamAppId, normIndexKey, indexSize, INDEX_FILE };
