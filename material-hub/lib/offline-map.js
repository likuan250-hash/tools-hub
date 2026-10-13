// 离线英文名 / Steam AppID 映射：复用 kdocs-tool 的同一份数据（单一数据源，不复制副本）。
// 打包后 material-hub 与 kdocs-tool 都是 extraResources 的兄弟目录，运行时相对引用即可；
// kdocs-tool 缺失或文件损坏时降级为空映射，不影响联网反查。
const path = require("path");

let zhLookup = null;
let appIdLookup = null;

function ensureLoaded() {
  if (zhLookup) return;
  zhLookup = () => null;
  appIdLookup = () => "";
  try {
    const kdocsLib = path.join(__dirname, "..", "..", "kdocs-tool", "lib");
    const { lookupEnglishNameOffline } = require(path.join(kdocsLib, "gamemap.js"));
    const { lookupAppIdOffline } = require(path.join(kdocsLib, "gameappid.js"));
    zhLookup = (name) => lookupEnglishNameOffline(name) || null;
    // 走 kdocs 同一套解析：精选小库 → 商店全量大库（17 万+ 中/英文名）
    appIdLookup = (name) => lookupAppIdOffline(name) || "";
  } catch (e) {
    /* 保持空映射 */
  }
}

/** 中文名 → 英文名；未命中返回 null（不抛错）。 */
function lookupOfflineEnglishName(gameName) {
  ensureLoaded();
  return zhLookup(String(gameName == null ? "" : gameName));
}

/** 英文名 → Steam AppID；未命中返回空串。 */
function lookupOfflineAppId(enTitle) {
  ensureLoaded();
  return appIdLookup(enTitle);
}

module.exports = { lookupOfflineEnglishName, lookupOfflineAppId };
