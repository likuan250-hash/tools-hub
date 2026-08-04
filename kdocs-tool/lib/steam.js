// ── Steam 搜索 + 封面下载 ──
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { DEFAULT_COVER_DIR } = require("./config");
const { cleanGameName, stripSubtitle, parseSteamAppIdFromText } = require("./nameutil");
const { lookupEnglishNameOffline } = require("./gamemap");

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

/** 校验文件头 magic 是否为真实图片（JPEG/PNG/WEBP/GIF/BMP）。用于下载后过滤占位图/错误页。 */
function isImageMagic(buf) {
  if (!buf || buf.length < 4) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
  // GIF: 47 49 46 38 ("GIF8")
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  // BMP: 42 4D ("BM")
  if (buf[0] === 0x42 && buf[1] === 0x4D) return true;
  // WEBP: 52 49 46 46 ("RIFF") + 偏移 8 处 57 45 42 50 ("WEBP")
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

/** 尝试从单个 URL 下载封面，成功返回 fp，失败 reject（自动跟随 301/302 重定向） */
function tryDownload(url, fp) {
  return new Promise((resolve, reject) => {
    // 按协议选模块：Steam CDN 为 https；用户手动封面链接也可能是 http，统一兼容
    const mod = url.startsWith("http://") ? http : https;
    const req = mod.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 }, (r) => {
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
      f.on("finish", () => {
        // 关闭后再做图片校验，避免把 Steam 占位图/错误页/1x1 当封面收下（H9）
        f.close((err) => {
          if (err) return reject(err);
          try {
            const fd = fs.openSync(fp, "r");
            const head = Buffer.alloc(12);
            fs.readSync(fd, head, 0, 12, 0);
            fs.closeSync(fd);
            if (!isImageMagic(head)) {
              try { fs.unlinkSync(fp); } catch {}
              return reject(new Error("下载内容非图片（magic 不匹配），已丢弃"));
            }
          } catch (e) {
            try { fs.unlinkSync(fp); } catch {}
            return reject(e);
          }
          resolve(fp);
        });
      });
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

/** 纯函数：从百度百科词条页 HTML 抽英文名字段。可单测。
 *  防御性：百度现已对词条页加反爬验证页（"百度安全验证"/验证码），
 *  这种页里没有真实词条内容，必须直接返回空，避免误抽验证码页里的英文碎片。 */
function extractEnglishNameFromBaidu(html) {
  if (!html) return "";
  const s = String(html);
  if (/百度安全验证|验证码|security|captcha|anti-spam/i.test(s)) return "";
  // 百度百科 infobox 形如 <th>英文名</th><td>Elden Ring</td>，先剥离 HTML 标签，
  // 否则懒惰量词会在 </th> 的 "th" 处提前满足、误把标签残字当英文名。
  const text = s.replace(/<[^>]+>/g, " ");
  const m = /(?:英文名|英文名称|游戏英文名)[\s\S]{0,40}?([A-Za-z][A-Za-z0-9\s:'’!&.\-]{1,40})/i.exec(text);
  return m ? m[1].trim() : "";
}

// ── Wikipedia 中文模糊搜 → 英文名（主力源：覆盖 Wikidata 无中文 label 的游戏）──
/** 纯函数：从 Wikipedia 搜索摘要抽英文名（摘要常含「英語：X」/「原名：X」）。可单测。 */
function extractEnglishNameFromWikiSnippet(snippet) {
  if (!snippet) return "";
  const text = String(snippet).replace(/<[^>]+>/g, ""); // 去 <span class="searchmatch"> 等标签残字
  const m = /(?:英語|英语|原名)[:：]\s*([A-Za-z][A-Za-z0-9\s:'’!&.\-]{1,60})/.exec(text);
  return m ? m[1].trim().replace(/\s+/g, " ") : "";
}

/** 纯函数：从 Wikipedia 词条 infobox wikitext 抽英文名（| english = X / | 原名 = X）。可单测。 */
function extractEnglishNameFromWikiInfobox(wikitext) {
  if (!wikitext) return "";
  const tests = [
    /\|\s*english\s*=\s*([^\n|{}<]{1,80})/i,
    /\|\s*原名\s*=\s*([^\n|{}<]{1,80})/i,
  ];
  for (const re of tests) {
    const m = re.exec(wikitext);
    if (m) { const v = m[1].trim(); if (/[A-Za-z]/.test(v)) return v; }
  }
  return "";
}

/**
 * 从 Wikipedia 中文模糊搜解析英文名。多步兜底：
 *   1) 直接解析 top5 搜索摘要里的「英語：/原名：」
 *   2) 抓 top3 词条的 infobox（| english=/| 原名=），按与输入的匹配度择优
 * 失败/异常/超时一律返回 ""。依赖 httpGetJson（可注入 mock 单测）。
 */
async function fetchEnglishNameFromWikipedia(name, httpGetJson) {
  if (!name) return "";
  try {
    const searchUrl = `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&format=json&srlimit=5`;
    const s = await httpGetJson(searchUrl, 8000);
    const items = (s && s.query && s.query.search) || [];
    if (!items.length) return "";
    // 1) 摘要快路径
    for (const it of items) {
      const en = extractEnglishNameFromWikiSnippet(it && it.snippet);
      if (en) return en;
    }
    // 2) infobox 兜底：抓 top3 词条的英文名，按匹配度择优
    const picks = [];
    for (const it of items.slice(0, 3)) {
      const t = it && it.title;
      if (!t) continue;
      try {
        const url = `https://zh.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(t)}&prop=revisions&rvprop=content&rvslots=main&format=json`;
        const r = await httpGetJson(url, 8000);
        const pages = (r && r.query && r.query.pages) || {};
        for (const k of Object.keys(pages)) {
          const p = pages[k];
          if (p && p.missing) continue;
          const rev = p && p.revisions && p.revisions[0];
          const wt = rev && rev.slots && rev.slots.main && rev.slots.main["*"];
          const en = extractEnglishNameFromWikiInfobox(wt);
          if (en) picks.push({ title: t, en, score: scoreWikiPick(en, t, name) });
        }
      } catch {}
    }
    if (!picks.length) return "";
    picks.sort((a, b) => b.score - a.score || b.en.length - a.en.length);
    return picks[0].en;
  } catch {}
  return "";
}

/** 给 Wikipedia 候选英文名打分：与输入里的序号/版本词对齐的优先。纯函数。 */
function scoreWikiPick(en, title, input) {
  let score = 0;
  const enL = String(en).toLowerCase();
  const tiL = String(title).toLowerCase();
  const inL = String(input).toLowerCase();
  if (/2|二|第\s*ii|ii|2代|3|三|第\s*iii|iii/.test(inL) && /ii|2|part|iii|3|vol/i.test(enL + " " + tiL)) score += 2;
  if (/重制|复刻/.test(inL) && /remaster|remake/i.test(enL + " " + tiL)) score += 2;
  if (/年度/.test(inL) && /year|goty/i.test(enL + " " + tiL)) score += 1;
  if (/决定|终极|完全/.test(inL) && /definitive|ultimate|complete/i.test(enL + " " + tiL)) score += 1;
  return score;
}

// ── 版本词增强：输入含「重制版」等 → 拼出精确英文名 ──
const EDITION_RULES = [
  { re: /复刻版/, suffix: "Remake" },
  { re: /重制版/, suffix: "Remastered" },
  { re: /年度版|年度豪華|game\s*of\s*the\s*year|\bgoty\b/i, suffix: "Game of the Year" },
  { re: /决定版|终极版/, suffix: "Definitive Edition" },
  { re: /豪华版|豪華版/, suffix: "Deluxe Edition" },
  { re: /黄金版|白金版/, suffix: "Gold Edition" },
  { re: /完整版|完全版/, suffix: "Complete Edition" },
  { re: /典藏版|收藏版|珍藏版/, suffix: "Collector's Edition" },
];
const EDITION_WORDS = /remaster|remake|definitive|deluxe|gold|platinum|complete|collector|goty|game of the year|ultimate|edition/i;

/** 纯函数：从原始输入检测版本后缀（中文 → 英文）。可单测。 */
function detectEditionSuffix(raw) {
  if (!raw) return "";
  for (const r of EDITION_RULES) if (r.re.test(raw)) return r.suffix;
  return "";
}

/** 纯函数：把基础英文名按输入里的版本词拼成精确名。已含版本词则不重复。可单测。 */
function augmentWithEdition(baseEn, raw) {
  if (!baseEn) return "";
  const suffix = detectEditionSuffix(raw);
  if (!suffix) return baseEn;
  if (EDITION_WORDS.test(baseEn)) return baseEn;
  return `${baseEn} ${suffix}`;
}

// ── 清洗 / 副标题剥离 / AppID 抽取：见 lib/nameutil.js（纯函数，parser 与 steam 共享）──

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
  const httpJson = (deps && deps.httpGetJson) || httpGetJson;
  const httpText = (deps && deps.httpGetText) || httpGetText;

  // 内部解析：候选名逐级尝试 Wikidata → Wikipedia → 百度百科，命中即返回英文名，否则 ""。
  const doResolve = async () => {
    // 候选名顺序：清洗后名（保留副标题，重制版/年度版独立条目更准）→ 剥副标题（百科核心名覆盖高）→ 原名兜底
    const cleaned = cleanGameName(raw);
    const candidates = [];
    if (cleaned) candidates.push(cleaned);
    const stripped = stripSubtitle(cleaned);
    if (stripped && stripped !== cleaned) candidates.push(stripped);
    if (!candidates.includes(raw)) candidates.push(raw);

    // 0) 离线静态库（内置中文名→英文名映射，无需联网，优先命中）
    //    彻底摆脱对 Wikipedia/Wikidata 网络的依赖：用户网络到不了百科时也能稳定解析常见游戏。
    //    deps.disableOffline=true 时跳过（仅供单测隔离网络管道用）。
    const offlineEnabled = !(deps && deps.disableOffline);
    if (offlineEnabled) {
      for (const name of candidates) {
        const en = lookupEnglishNameOffline(name);
        if (en) return augmentWithEdition(en, raw);
      }
    }

    let baseEn = "";
    for (const name of candidates) {
      // 1) Wikidata zh search → en label（有中文 label 时最结构化、最可靠，优先）
      try {
        const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=zh&format=json&limit=3`;
        const search = await httpJson(searchUrl, 8000);
        const ids = ((search && search.search) || []).map(e => e && e.id).filter(Boolean).slice(0, 3);
        if (ids.length) {
          const entUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.join("|")}&props=labels&languages=en&format=json`;
          const ent = await httpJson(entUrl, 8000);
          const label = extractEnglishNameFromWikidata(search, ent);
          if (label) { baseEn = label; break; }
        }
      } catch {}
      // 2) Wikipedia 中文模糊搜 → 摘要/infobox 的 英語/原名（覆盖 Wikidata 无中文 label 的游戏）
      try {
        const en = await fetchEnglishNameFromWikipedia(name, httpJson);
        if (en) { baseEn = en; break; }
      } catch {}
      // 3) 百度百科英文段（防御性：遇反爬验证页直接跳过）
      try {
        const html = await httpText(`https://baike.baidu.com/item/${encodeURIComponent(name)}`, 8000);
        const en = extractEnglishNameFromBaidu(html);
        if (en) { baseEn = en; break; }
      } catch {}
    }
    if (!baseEn) return "";
    // 版本词增强：输入含 重制版/年度版 等 → 拼出精确英文名（如 Part II + 重制版 → Part II Remastered）
    return augmentWithEdition(baseEn, raw);
  };

  // 总超时预算（H2）：多源全失败时最坏会串行挂数十秒，这里封顶 15s，
  // 超时即放弃解析（交上层直接用中文名匹配），避免整条录入被拖死。
  let timer;
  const timeoutP = new Promise((res) => { timer = setTimeout(() => res(""), 15000); });
  try {
    return await Promise.race([doResolve(), timeoutP]);
  } finally {
    clearTimeout(timer);
  }
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
  extractEnglishNameFromWikiSnippet, extractEnglishNameFromWikiInfobox, fetchEnglishNameFromWikipedia,
  detectEditionSuffix, augmentWithEdition,
  cleanGameName, stripSubtitle, tryDownload, isImageMagic,
};
