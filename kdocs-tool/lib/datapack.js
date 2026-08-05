// 离线数据包统一管理与增量更新（中文名→英文名 override + 英文名→AppID）。
// 数据源（版本高的生效）：
//   1) 内置 data-pack.json —— 随安装包 extraResources 内置（v1 起步，兜底）
//   2) 本地缓存 {KDOCS_DATA_DIR}/data-pack.json —— 主进程启动时从 GitHub Release
//      (releases/latest/download/data-pack.json) 后台静默拉取写入，仅当 version 更高才生效
// 设计动机：数据更新无需整包升级。维护者改数据 → bump data-pack.version → 发版时 release.sh
//   上传 data-pack.json 为 Release 资产 → App 启动静默拉取写缓存 → 下次查询自动用新数据。
//   拉取失败 / 无缓存 / 低版本 / 损坏缓存一律回退内置，零风险、零打扰。
const fs = require("fs");
const path = require("path");

const WORK_DIR = __dirname; // tools-hub/kdocs-tool/lib
const DATA_DIR = process.env.KDOCS_DATA_DIR || path.join(WORK_DIR, "..", "cache");
const CACHE_FILE = path.join(DATA_DIR, "data-pack.json");

/** 中文游戏名归一化（与 gamemap.js 同规则：小写、全角→半角、去空白/标点/「的」、版本词统一）。 */
function normZh(s) {
  if (!s) return "";
  let t = String(s).toLowerCase();
  t = t.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  t = t.replace(/\s+/g, "");
  t = t.replace(/[：:·•、，,.。!！?？()（）\[\]【】""''«»/\\|_\-—～~*+#@%&='"]/g, "");
  t = t.replace(/的/g, "");
  t = t.replace(/重置版|复刻版/g, "重制版");
  return t;
}

/** 英文名归一化：小写、去所有非字母数字。 */
function normEn(s) {
  if (!s) return "";
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** 归一化数据包：抽出 version + 归一化后的 gameNames/appIds 索引。非法包返回 null。 */
function normalizePack(pack) {
  if (!pack || typeof pack.version !== "number" || pack.version < 1) return null;
  const gameNames = {};
  const rawG = (pack.gameNames && typeof pack.gameNames === "object") ? pack.gameNames : {};
  for (const k of Object.keys(rawG)) {
    const nk = normZh(k);
    if (nk && rawG[k]) gameNames[nk] = String(rawG[k]);
  }
  const appIds = {};
  const rawA = (pack.appIds && typeof pack.appIds === "object") ? pack.appIds : {};
  for (const k of Object.keys(rawA)) {
    const nk = normEn(k);
    if (nk && rawA[k]) appIds[nk] = String(rawA[k]);
  }
  return { version: pack.version, gameNames, appIds };
}

let BUILTIN = null;
try {
  BUILTIN = normalizePack(require("./data-pack.json"));
} catch (_) { BUILTIN = null; }

/** 加载缓存包（不存在/损坏/非数字版本返回 null）。 */
function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    return normalizePack(JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")));
  } catch (_) { return null; }
}

/**
 * 获取当前生效数据包：缓存版本 > 内置版本 → 缓存，否则内置。
 * 每次调用重读缓存文件（KB 级，开销可忽略；查询频率低），保证主进程更新缓存后立即生效。
 * @returns {{version:number, gameNames:Object, appIds:Object}} 绝不返回 null（最差空包）
 */
function getActiveDataPack() {
  let best = BUILTIN;
  const cachePack = loadCache();
  if (cachePack && (!best || cachePack.version > best.version)) best = cachePack;
  return best || { version: 0, gameNames: {}, appIds: {} };
}

/** 当前生效数据包版本号（调试/日志用）。 */
function getActiveDataPackVersion() {
  return getActiveDataPack().version;
}

module.exports = { normZh, normEn, getActiveDataPack, getActiveDataPackVersion, DATA_DIR, CACHE_FILE };
