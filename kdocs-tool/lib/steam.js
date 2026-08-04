// ── Steam 搜索 + 封面下载 ──
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { DEFAULT_COVER_DIR } = require("./config");

/** 搜索 Steam AppID（10 秒超时，避免网络不畅时卡死整流程） */
function searchSteamAppId(gameName) {
  return new Promise((resolve) => {
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(gameName)}&l=schinese&cc=CN`;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try { const j = JSON.parse(d); done(j.items?.[0]?.id || null); }
        catch { done(null); }
      });
      res.on("error", () => done(null));
    });
    req.on("error", () => done(null));
    req.on("timeout", () => { req.destroy(); done(null); });
  });
}

/** 尝试从单个 URL 下载封面，成功返回 fp，失败 reject（自动跟随 301/302 重定向） */
function tryDownload(url, fp) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 }, (r) => {
      if (r.statusCode === 301 || r.statusCode === 302) {
        const loc = r.headers.location;
        r.destroy();
        if (!loc) return reject(new Error("重定向无 location"));
        const next = loc.startsWith("http") ? loc : new URL(loc, url).href;
        return tryDownload(next, fp).then(resolve, reject);
      }
      if (r.statusCode !== 200) { r.destroy(); return reject(new Error("HTTP " + r.statusCode)); }
      const f = fs.createWriteStream(fp);
      r.pipe(f);
      f.on("finish", () => { f.close(); resolve(fp); });
      f.on("error", (e) => { f.destroy(); reject(e); });
    });
    req.on("timeout", () => { req.destroy(new Error("下载超时")); });
    req.on("error", (e) => { req.destroy(); reject(e); });
  });
}

/** 下载 Steam 封面到指定目录（多源 fallback：首选 fastly 竖版 library_600x900_2x，规范文档 §1.2 指定直链） */
function downloadCover(gameName, appid, coverDir) {
  coverDir = coverDir || DEFAULT_COVER_DIR;
  if (!fs.existsSync(coverDir)) fs.mkdirSync(coverDir, { recursive: true });
  const safe = gameName.replace(/[\\/:*?"<>|]/g, "_");
  const fp = path.join(coverDir, `${safe}_cover.jpg`);
  const cdn = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}`;
  const fas = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}`;
  const aka = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}`;
  const candidates = [
    `${fas}/library_600x900_2x.jpg`, // 规范文档 §1.2 指定的官方直链（竖版 600x900@2x），首选
    `${cdn}/library_600x900_2x.jpg`, // cloudflare 同款竖版，fallback
    `${cdn}/header.jpg`,             // 横版 header，最后兜底（比例不佳）
    `${fas}/header.jpg`,
    `${aka}/header.jpg`,
  ];
  return (async () => {
    let lastErr;
    for (const url of candidates) {
      try { return await tryDownload(url, fp); }
      catch (e) { lastErr = e; }
    }
    throw new Error("所有 Steam 封面源均失败：" + (lastErr && lastErr.message));
  })();
}

/**
 * 解析 Steam store appdetails 返回的 data 块（纯函数，可单测）。
 * @returns {{shortDescription:string, genres:string[], type:string}|null}
 */
function parseSteamAppDetails(data) {
  if (!data) return null;
  const sd = (data.short_description || "").replace(/\s+/g, " ").trim();
  const genres = Array.isArray(data.genres)
    ? data.genres.map(g => (g && g.description) || "").filter(Boolean)
    : [];
  const type = data.type || "";
  const size = parseSteamSizeFromRequirements(data.pc_requirements);
  return { shortDescription: sd, genres, type, size };
}

/** 抓取 Steam 官方 store 描述（主源，质量最高）。失败/无结果返回 null，绝不抛错打断流程。 */
function getSteamAppDetails(appid) {
  return new Promise((resolve) => {
    if (!appid) return resolve(null);
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=schinese&cc=CN`;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(d);
          const entry = j && j[String(appid)];
          if (entry && entry.success && entry.data) done(parseSteamAppDetails(entry.data));
          else done(null); // 应用下架/无数据：返回 null，交由 bl 兜底
        } catch { done(null); }
      });
      res.on("error", () => done(null));
    });
    req.on("error", () => done(null));
    req.on("timeout", () => { req.destroy(); done(null); });
  });
}

/** 从任意图片 URL 下载封面（非 Steam 游戏：用户提供的官方封面链接兜底） */
function downloadCoverFromUrl(gameName, url, coverDir) {
  coverDir = coverDir || DEFAULT_COVER_DIR;
  if (!fs.existsSync(coverDir)) fs.mkdirSync(coverDir, { recursive: true });
  const safe = gameName.replace(/[\\/:*?"<>|]/g, "_");
  const ext = /\.png/i.test(url) ? "png" : /\.webp/i.test(url) ? "webp" : "jpg";
  const fp = path.join(coverDir, `${safe}_cover.${ext}`);
  return tryDownload(url, fp);
}

// ────────────────────── AppID 多源取拿（维基 / 百度 / 网页兜底）──────────────────────
// 通用 GET（文本 / JSON），带超时、UA、单跳重定向跟随；任何异常 / 非 200 / 超时一律返回兜底值，绝不抛错打断流程。
function httpGetText(url, timeoutMs = 10000, depth = 0) {
  return new Promise((resolve) => {
    const finish = (v) => resolve(v);
    if (depth > 3) return finish("");
    let req;
    try {
      const mod = url.startsWith("http://") ? http : https;
      req = mod.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: timeoutMs }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const loc = res.headers.location;
          res.destroy();
          if (!loc) return finish("");
          const next = loc.startsWith("http") ? loc : new URL(loc, url).href;
          return finish(httpGetText(next, timeoutMs, depth + 1));
        }
        if (res.statusCode !== 200) { res.destroy(); return finish(""); }
        let d = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (d += c));
        res.on("end", () => finish(d));
        res.on("error", () => finish(""));
      });
    } catch { return finish(""); }
    req.on("error", () => finish(""));
    req.on("timeout", () => { try { req.destroy(); } catch {} finish(""); });
  });
}

function httpGetJson(url, timeoutMs = 10000, depth = 0) {
  return new Promise((resolve) => {
    const finish = (v) => resolve(v);
    if (depth > 3) return finish(null);
    let req;
    try {
      const mod = url.startsWith("http://") ? http : https;
      req = mod.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: timeoutMs }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const loc = res.headers.location;
          res.destroy();
          if (!loc) return finish(null);
          const next = loc.startsWith("http") ? loc : new URL(loc, url).href;
          return finish(httpGetJson(next, timeoutMs, depth + 1));
        }
        if (res.statusCode !== 200) { res.destroy(); return finish(null); }
        let d = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (d += c));
        res.on("end", () => { try { finish(JSON.parse(d)); } catch { finish(null); } });
        res.on("error", () => finish(null));
      });
    } catch { return finish(null); }
    req.on("error", () => finish(null));
    req.on("timeout", () => { try { req.destroy(); } catch {} finish(null); });
  });
}

/** 从任意文本抽 Steam AppID（store.steampowered.com/app/<id> / steamcommunity / steamdb）。纯函数。 */
function parseSteamAppIdFromText(text) {
  if (!text) return "";
  const m = /store\.steampowered\.com\/app\/(\d+)|steamcommunity\.com\/app\/(\d+)|steamdb\.info\/app\/(\d+)/i.exec(String(text));
  return m ? (m[1] || m[2] || m[3] || "") : "";
}

/**
 * 维基百科 / Wikidata 反查 Steam AppID（P1733 属性 = Steam Application ID）。
 * 多语言搜索（zh→en）提高命中；取前若干候选实体的首个 P1733 值。失败静默返回空。
 */
async function fetchAppIdFromWikidata(gameName) {
  if (!gameName) return "";
  try {
    for (const lang of ["zh", "en"]) {
      const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(gameName)}&language=${lang}&format=json&limit=3`;
      const search = await httpGetJson(searchUrl, 8000);
      const entities = (search && search.search) || [];
      for (const e of entities) {
        const qid = e && e.id;
        if (!qid) continue;
        const claimsUrl = `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${qid}&property=P1733&format=json`;
        const claims = await httpGetJson(claimsUrl, 8000);
        const arr = claims && claims.claims && claims.claims.P1733;
        if (Array.isArray(arr) && arr.length) {
          const v = arr[0] && arr[0].mainsnak && arr[0].mainsnak.datavalue && arr[0].mainsnak.datavalue.value;
          if (v) return String(v);
        }
      }
    }
  } catch {}
  return "";
}

/** 百度百科：best-effort，从词条页 HTML 抽 Steam 链接里的 AppID。失败静默返回空。 */
async function fetchAppIdFromBaiduBaike(gameName) {
  if (!gameName) return "";
  try {
    const url = `https://baike.baidu.com/item/${encodeURIComponent(gameName)}`;
    const html = await httpGetText(url, 8000);
    return parseSteamAppIdFromText(html);
  } catch {}
  return "";
}

/** 网页搜索兜底（DuckDuckGo HTML）→ 抽 Steam AppID。best-effort，失败静默返回空。 */
async function fetchAppIdFromWebSearch(gameName) {
  if (!gameName) return "";
  try {
    const q = `${gameName} steam appid`;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const html = await httpGetText(url, 8000);
    return parseSteamAppIdFromText(html);
  } catch {}
  return "";
}

// ────────────────────── 英文名前置解析（中文名 → 英文名）──────────────────────
// 背景：Steam 商店与 Wikidata 多以英文名为准，直接用中文名搜 Steam 常搜不到或错配。
// 因此在「查 AppID」之前先解析出规范英文名，再用英文名（优先）去匹配，显著提升命中率。

/** 纯函数：从 Wikidata search + entities 两份 JSON 抽英文 label（取前 3 候选首个有 en label 的）。可单测。 */
function extractEnglishNameFromWikidata(searchJson, entitiesJson) {
  const entities = (searchJson && searchJson.search) || [];
  const ids = entities.map(e => e && e.id).filter(Boolean).slice(0, 3);
  if (!ids.length) return "";
  const map = (entitiesJson && entitiesJson.entities) || {};
  for (const id of ids) {
    const label = map[id] && map[id].labels && map[id].labels.en && map[id].labels.en.value;
    if (label) return String(label);
  }
  return "";
}

/** 纯函数：从百度百科词条页 HTML 抽英文名字段。可单测。 */
function extractEnglishNameFromBaidu(html) {
  if (!html) return "";
  // 百度百科 infobox 形如 <th>英文名</th><td>Elden Ring</td>，先剥离 HTML 标签，
  // 否则懒惰量词会在 </th> 的 "th" 处提前满足、误把标签残字当英文名。
  const text = String(html).replace(/<[^>]+>/g, " ");
  const m = /英文名[\s\S]{0,30}?([A-Za-z][A-Za-z0-9\s:'’!&.\-]{1,40})/i.exec(text);
return m ? m[1].trim() : "";
}

// ── 清洗：剥除游戏名里的版本号 / repack 标签噪音，便于百科精确匹配 ──
// 背景：百度网盘分享页标题常带 "v1.6.10721.0105 官方中文+预购特典+单独升级档" 这类噪音，
// 直接拿去 Wikidata / 百度百科搜会因词条名不匹配而 0 结果。先做轻量清洗再查命中率显著上升。
const NOISE_TAGS = [
  // 复合标签优先剥
  '官方中文+预购特典+单独升级档', '官方简中+预购特典+单独升级档', '官方繁中+预购特典+单独升级档',
  '官方中文+预购特典', '官方简中+预购特典', '官方繁中+预购特典',
  '预购特典+单独升级档', '预购特典',
  '单独升级档',
  // 单标签
  '官方中文', '官方简中', '官方繁中', '官方英文', '官方日文', '官方中文版',
  '整合版', '年度版', '终极版', '完全版', '豪华版', '典藏版', '黄金版', '黄金典藏版',
  '高清版', '中文版', '汉化版', '国行版', '美版', '欧版', '日版',
  'PC版', 'Steam版', '免安装', '免安装版', '绿色版', '破解版', '学习版', '未加密版',
  '离线版', '联机版', '单机版', '多人版',
  'D加密', 'Steam脱机', '数字版', '实体版', '光盘版', '全DLC', 'DLC',
  '赠品版', '体验版', '正式版', '尝鲜版', '抢先版', 'Beta版', 'Demo版',
  '更新版', '修正版', '升级版', '补丁版',
  '简体中文', '官方简体中文',
];

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * 清洗游戏名：剥除版本号与尾部 repack 标签噪音，保留副标题（重制版等）。
 * 例：「最后的生还者2：重制版 v1.6.10721.0105 官方中文+预购特典+单独升级档」 → 「最后的生还者2：重制版」
 * 纯函数，可单测。
 */
function cleanGameName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';
  // 1) 剥版本号 v1.2.3 / V2 / v 1.2
  s = s.replace(/\s*[vV]\s*\d+(?:\.\d+)*\b/g, ' ');
  // 2) 反复剥除 +/、/空格/，串接的标签（前/后锚定避免误伤核心名里的同字）
  const SEP = '[+\\s、/,,　]';
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const tag of NOISE_TAGS) {
      const re = new RegExp(`(?:^|${SEP})${escapeRe(tag)}(?=${SEP}|$)`, 'g');
      const before = s;
      s = s.replace(re, ' ');
      if (s !== before) changed = true;
    }
    if (!changed) break;
  }
  // 3) 清理多余分隔符
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[：:+\s、/,,]+/, '').replace(/[：:+\s、/,,]+$/, '');
  s = s.replace(/\s+\+\s+/g, ' ').trim();
  return s;
}

/**
 * 进一步剥掉冒号/破折号后的副标题（"重制版"、"Remastered"、"终极版"等），
 * 仅保留核心名用作百科兜底查询。纯函数。
 */
function stripSubtitle(name) {
  if (!name || typeof name !== 'string') return '';
  const m = /^([^：:\-—–]+?)\s*[：:\-—–]\s*/.exec(name);
  let core = m ? m[1].trim() : name.trim();
  core = core.replace(/[：:+\s、/,,]+$/, '').trim();
  return core;
}

/**
 * 解析游戏英文名（中文名 → 英文名）。多源兜底：
   *   1) Wikidata 中文 search → 英文 label（最结构化、最可靠）
   *   2) 百度百科词条页英文段
   * 失败/超时/异常一律返回 ""（绝不抛错打断流程），交由上层直接用中文名匹配。
   *
   * 每个数据源内部按候选名顺序逐级尝试：
   *   ① cleanGameName(raw) — 保留副标题（重制版/年度版等独立条目更准）
   *   ② stripSubtitle(①) — 剥副标题的核心名（百科核心名覆盖更高）
   *   ③ raw 原名 — 最后兜底
   * 候选去重保序，避免重复请求。
   * 第 2 参数 deps（可选）注入 httpGetJson/httpGetText，便于单测 mock。
   */
async function resolveEnglishName(gameName, deps) {
  if (!gameName || !String(gameName).trim()) return "";
  const raw = String(gameName).trim();
  // 候选名顺序：清洗后名（保留副标题，重制版/年度版独立条目更准）→ 剥副标题（百科核心名覆盖高）→ 原名兜底
  const cleaned = cleanGameName(raw);
  const candidates = [];
  if (cleaned) candidates.push(cleaned);
  const stripped = stripSubtitle(cleaned);
  if (stripped && stripped !== cleaned) candidates.push(stripped);
  if (!candidates.includes(raw)) candidates.push(raw);
  const httpJson = (deps && deps.httpGetJson) || httpGetJson;
  const httpText = (deps && deps.httpGetText) || httpGetText;
  // 1) Wikidata zh search → en label（按候选顺序逐级尝试）
  for (const name of candidates) {
    try {
      const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=zh&format=json&limit=3`;
      const search = await httpJson(searchUrl, 8000);
      const ids = ((search && search.search) || []).map(e => e && e.id).filter(Boolean).slice(0, 3);
      if (ids.length) {
        const entUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.join("|")}&props=labels&languages=en&format=json`;
        const ent = await httpJson(entUrl, 8000);
        const label = extractEnglishNameFromWikidata(search, ent);
        if (label) return label;
      }
    } catch {}
  }
  // 2) 百度百科英文段（同上逐级尝试）
  for (const name of candidates) {
    try {
      const html = await httpText(`https://baike.baidu.com/item/${encodeURIComponent(name)}`, 8000);
      const en = extractEnglishNameFromBaidu(html);
      if (en) return en;
    } catch {}
  }
  return "";
}

/**
 * 从 Steam pc_requirements（appdetails 返回的 {minimum, recommended} HTML 串）抽磁盘占用。
 * 优先 recommended，其次 minimum；中英双语识别 Storage / 存储空间 / 硬盘。纯函数。
 * @returns {string} 形如 "40GB" / "512MB"，无则返回 ""
 */
function parseSteamSizeFromRequirements(pc) {
  if (!pc || typeof pc !== "object") return "";
  const segments = [pc.recommended, pc.minimum].filter((s) => typeof s === "string" && s);
  for (const html of segments) {
    const s = extractStorageFromHtml(html);
    if (s) return s;
  }
  return "";
}

function extractStorageFromHtml(html) {
  if (!html) return "";
  // 1) 显式"Storage:" / "存储空间：" / "硬盘：" 后跟数字+单位（允许标签/空格穿插，限制窗口避免误抓）
  const m = /(?:storage|存储空间|硬盘|磁盘空间)[\s\S]{0,40}?([\d]+(?:\.\d+)?)\s*(gb|mb|tb|g|m|t)/i.exec(html);
  if (m) return m[1] + m[2].toUpperCase();
  // 2) 兜底：requirements 段内第一个 "40 GB" 形态
  const m2 = /([\d]+(?:\.\d+)?)\s*(gb|mb|tb|g|m|t)\b/i.exec(html);
  return m2 ? m2[1] + m2[2].toUpperCase() : "";
}

module.exports = {
  searchSteamAppId, downloadCover, downloadCoverFromUrl, getSteamAppDetails, parseSteamAppDetails,
  parseSteamAppIdFromText, fetchAppIdFromWikidata, fetchAppIdFromBaiduBaike, fetchAppIdFromWebSearch,
  parseSteamSizeFromRequirements, resolveEnglishName, extractEnglishNameFromWikidata, extractEnglishNameFromBaidu,
  cleanGameName, stripSubtitle,
};
