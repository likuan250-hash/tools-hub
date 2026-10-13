// flysheep6 站点取数（金山录入专用，直连不走代理）：
//   搜索页 https://www.flysheep6.com/?s=<名字>  → 详情页 /archives/<id>
// 详情页一次能给：AppID、中文名、英文名、中文游戏介绍、官方封面（国区 CDN）、官方预告片 HLS 直链。
// 用途：金山录入的「封面 / 游戏介绍 / AppID」三处都优先用它，Steam 接口与维基只做兜底。
// 站点内容是搬 Steam 官方商店页的（图片/预告片都在 shared.cdn.queniuqe.com、video.cdn.queniuqe.com），文案即官方中文介绍。

const fs = require("fs");
const path = require("path");
const { fetchTextProxy } = require("./proxyHttp");
const { WORK_DIR } = require("./config");

const HOST = "https://www.flysheep6.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const CACHE_FILE = path.join(
  process.env.KDOCS_DATA_DIR || path.join(WORK_DIR, "..", "cache"),
  "flysheep.json",
);

// 标题噪声：站内前缀标签【…】/[…]、版别词、下载相关后缀。
// 注意：**不能**把游戏名里的数字当噪声删掉（"装机模拟器2"、"战锤3" 会被削成基础名，导致整条线路误配/漏配）。
const NOISE =
  /【[^】]*】|\[[^\]]*\]|免安装|硬盘版|豪华中文版|官方中文|中文版|全DLC|全dlc|学习版|绿色版|豪华版|终极版|决定版|完整版|完全版|典藏版|收藏版|数字版|PC版|解压即玩|赠|修改器|单独汉化补丁|汉化补丁|整合|高压版|高压/g;

/** 统一清洗：去标签/版别词/版本号，保留游戏名里的数字（v1.2.3、V 这类版本标记才删） */
function cleanName(t) {
  return String(t == null ? "" : t)
    .replace(/&amp;/g, "&")
    .replace(/\s*[-|_]\s*(flysheep6?|flysheep)[^|]*$/i, "")
    .replace(NOISE, " ")
    .replace(/\bv?\d+(?:\.\d+){1,}\b/gi, " ") // 1.2.3 / v1.2 这种版本号
    .replace(/\bv\d+\b/gi, " ") // 单段版本号 v2
    .replace(/[《》]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
const cleanTitle = cleanName;
const cleanQuery = cleanName;

// 罗马数字 → 阿拉伯数字：站点常写 "Total War WARHAMMER III"，玩家输入的是"战锤3"，两侧要能对上
const ROMAN = { viii: 8, vii: 7, iii: 3, ii: 2, ix: 9, iv: 4, vi: 6, xi: 11, x: 10, v: 5, i: 1 };
function toArabic(s) {
  return String(s == null ? "" : s).replace(/[a-z]+/gi, (w) => {
    const lw = w.toLowerCase();
    const m = lw.match(/(viii|vii|iii|ii|ix|iv|vi|xi|x|v|i)$/);
    if (!m) return w;
    const head = lw.slice(0, lw.length - m[1].length);
    if (head) return head + ROMAN[m[1]];
    // 单独一段的罗马数字（"Total War WARHAMMER III"）：多字符才转，单个 i/v/x 当普通词，避免误伤
    return m[1].length >= 2 ? String(ROMAN[m[1]]) : w;
  });
}
const digitsOf = (s) => (toArabic(String(s || "").toLowerCase()).match(/\d+/g) || []).join(",");

/** 从站点标题里拆中英文名：【VBS】鬼武者（Way of the Sword）免安装豪华中文版 → 鬼武者 / Way of the Sword */
function splitNames(title) {
  const t = cleanTitle(title);
  const m = t.match(/^(.*?)[（(]([A-Za-z0-9][^)）]{1,90})[)）]\s*(.*)$/);
  if (m && /[\u4e00-\u9fff]/.test(m[1])) {
    return { zhName: m[1].trim(), enName: m[2].trim(), tail: (m[3] || "").trim() };
  }
  if (/[\u4e00-\u9fff]/.test(t)) return { zhName: t, enName: "", tail: "" };
  return { zhName: "", enName: t, tail: "" };
}

const normKey = (s) =>
  String(s == null ? "" : s)
    .toLowerCase()
    .replace(/[\u2122\u00ae\u2120]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");

/** 搜索结果里挑最像的那个（中文名精确/包含优先，其次英文名/原名包含） */
function pickBest(items, name) {
  const want = normKey(cleanQuery(name));
  if (!want || !items.length) return items[0] || null;
  const wantA = normKey(toArabic(want));
  const wantDigits = digitsOf(want);
  // "1" 与"不带号"视为同一部（站内/Steam 常把初代写成无编号：战锤1 ↔ 全面战争 战锤）
  const wantDigitsAlt = wantDigits === "1" ? "" : null;
  let best = null;
  let bestScore = -1;
  for (const it of items) {
    const n = splitNames(it.title);
    const keys = [normKey(n.zhName), normKey(n.enName), normKey(cleanTitle(it.title))].filter(
      Boolean,
    );
    let score = 0;
    for (const k of keys) {
      const kA = normKey(toArabic(k));
      // 版本号不一致（装机模拟器 vs 装机模拟器2、战锤 vs 战锤3）不算同款，直接排除；
      // 罗马数字已在 toArabic 里统一，所以 "WARHAMMER III" 能对上玩家的 "战锤3"
      const kd = digitsOf(k);
      if (kd !== wantDigits && !(wantDigitsAlt !== null && kd === wantDigitsAlt)) continue;
      if (kA === wantA) score = Math.max(score, 100);
      // 带后缀的（艾尔登法环 vs 艾尔登法环 黄金树之影）按多出来的字数扣分，优先基础版
      else if (kA.startsWith(wantA) || wantA.startsWith(kA))
        score = Math.max(score, 70 - Math.min(40, Math.abs(kA.length - wantA.length)));
      else if (kA.includes(wantA) || wantA.includes(kA))
        score = Math.max(score, 50 - Math.min(40, Math.abs(kA.length - wantA.length)));
    }
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return bestScore > 0 ? best : null;
}

function parseSearch(html) {
  const out = [];
  const chunks = String(html)
    .split(/<div id="post-\d+"/)
    .slice(1);
  for (const c of chunks) {
    const url = (c.match(/href="(https:\/\/www\.flysheep6\.com\/archives\/\d+)"/) || [])[1];
    if (!url) continue;
    const title =
      (c.match(
        /<h\d[^>]*class="[^"]*entry-title[^"]*"[^>]*>[\s\S]{0,200}?<a[^>]*>([\s\S]{0,150}?)<\/a>/,
      ) || [])[1] ||
      (c.match(/<img[^>]+alt="([^"]{2,150})"/) || [])[1] ||
      "";
    const cover = (c.match(/<img[^>]+src="(https:\/\/[^"]+?)"/) || [])[1] || "";
    const appid = (cover.match(/steam\/apps\/(\d+)\//) || [])[1] || "";
    out.push({ url, title: cleanTitle(title), coverUrl: cover, appid });
  }
  return out;
}

const INTRO_NOISE =
  /下载|解压|安装|配置|最低|推荐|网盘|提取码|密码|QQ群|群号|公众号|订阅|版权|免责|声明|转载|教程|图文说明|游戏截图|点击|进入|站内|广告|赞助/i;

function parseDetail(url, html, fallbackCover = "") {
  const title = cleanTitle((html.match(/<title>([\s\S]{0,200}?)<\/title>/) || [])[1] || "");
  const names = splitNames((html.match(/<title>([\s\S]{0,200}?)<\/title>/) || [])[1] || "");
  const body = html.slice(html.indexOf("<article") >= 0 ? html.indexOf("<article") : 0);
  const paras = [
    ...body.matchAll(/<p[^>]*class="[^"]*wp-block-paragraph[^"]*"[^>]*>([\s\S]*?)<\/p>/g),
  ]
    .map((m) =>
      m[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((t) => t.length >= 12 && /[\u4e00-\u9fff]/.test(t) && !INTRO_NOISE.test(t));
  let intro = paras.join(" ").trim();
  if (!intro) {
    const meta = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "";
    intro = meta
      .split(/最低配置|推荐配置|配置要求/)[0]
      .replace(/\s+/g, " ")
      .trim();
  }
  // 封面：站点封面是搬 Steam 官方图（国区镜像有时带 hash，有时走 eccdnx 老路径），按 优先级取
  const coverUrl =
    (html.match(/https:\/\/[^"'\s]*steam\/apps\/\d+\/[^"'\s]*capsule_616x353\.jpg[^"'\s]*/) ||
      [])[0] ||
    (html.match(/https:\/\/[^"'\s]*steam\/apps\/\d+\/[^"'\s]*header\.jpg[^"'\s]*/) || [])[0] ||
    (html.match(/https:\/\/[^"'\s]*steam\/apps\/\d+\/[^"'\s]*\.(?:jpg|png)/) || [])[0] ||
    fallbackCover ||
    "";
  const appid =
    (coverUrl.match(/steam\/apps\/(\d+)\//) ||
      html.match(/store_item_assets\/steam\/apps\/(\d+)\//) ||
      [])[1] || "";
  const trailerHls = (html.match(/data-url="(https:\/\/video\.[^"]+\.m3u8)"/) || [])[1] || "";
  return {
    url,
    siteTitle: title,
    zhName: names.zhName,
    enName: names.enName,
    appid,
    coverUrl: coverUrl.replace(/&amp;/g, "&"),
    intro: intro.slice(0, 800),
    trailerHls,
  };
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) || {};
  } catch (e) {
    return {};
  }
}
function writeCache(all) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(all, null, 1), "utf8");
  } catch (e) {
    /* 缓存写失败不影响主流程 */
  }
}

async function getText(url, timeout = 15000) {
  const t = await fetchTextProxy(url, { timeout, headers: { "User-Agent": UA } });
  return t == null ? "" : t;
}

/** 搜索站内条目（不打开详情页），返回候选列表 */
async function search(keyword) {
  if (!keyword || !String(keyword).trim()) return [];
  const html = await getText(`${HOST}/?s=${encodeURIComponent(String(keyword).trim())}`);
  return html ? parseSearch(html) : [];
}

/**
 * 按游戏名取站点信息（带本地缓存）。
 * @returns {Promise<object|null>} {url,zhName,enName,appid,coverUrl,intro,trailerHls}；未命中返回 null
 */
/**
 * 带原因的取数（给 UI 用）：
 * 站点打不开（网络/证书/DNS）与「站内确实没这个游戏」是两回事，混在一起会让人以为线路坏了。
 * @returns {Promise<{ok:true, info:object}|{ok:false, reason:"not-found"|"network"|"bad-name", error?:string, url:string}>}
 */
async function lookupDetailed(name) {
  const key = normKey(cleanQuery(name));
  if (!key) return { ok: false, reason: "bad-name", url: "" };
  const cache = readCache();
  if (cache[key] && cache[key].appid) return { ok: true, info: cache[key] };
  const searchUrl = `${HOST}/?s=${encodeURIComponent(String(name).trim())}`;
  try {
    let items = await search(name);
    // 站内搜索对「：」「空格」「数字」敏感（"全面战争：战锤2" 直接 0 条），放宽成基础名再搜一次，匹配仍按版本号严格判定
    if (!items.length) {
      const loose = String(name)
        .replace(/[：:]/g, " ")
        .replace(/\d+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (loose && loose !== String(name).trim()) items = await search(loose);
    }
    const hit = pickBest(items, name);
    if (!hit) return { ok: false, reason: "not-found", url: searchUrl };
    const html = await getText(hit.url);
    if (!html)
      return { ok: false, reason: "network", error: "页面为空（站点可能限流）", url: hit.url };
    const info = parseDetail(hit.url, html, hit.coverUrl);
    info.query = String(name).trim();
    writeCache(Object.assign(readCache(), { [key]: info }));
    return { ok: true, info };
  } catch (e) {
    return { ok: false, reason: "network", error: (e && e.message) || String(e), url: searchUrl };
  }
}

/** 兼容旧调用：只关心拿到没拿到 */
async function lookup(name) {
  const r = await lookupDetailed(name);
  return r.ok ? r.info : null;
}

module.exports = {
  lookup,
  lookupDetailed,
  search,
  parseSearch,
  parseDetail,
  splitNames,
  cleanTitle,
  pickBest,
};
