// ── Steam 搜索 + 封面下载 ──
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { DEFAULT_COVER_DIR } = require("./config");
const { cleanGameName, stripSubtitle, parseSteamAppIdFromText } = require("./nameutil");
const { lookupEnglishNameOffline } = require("./gamemap");
const { lookupAppIdOffline } = require("./gameappid");
const { rememberAppId } = require("./datapack");
const { fetchTextProxy, fetchJsonProxy } = require("./proxyHttp");

/**
 * 搜索 Steam AppID（代理感知：走 fetchJsonProxy，无代理时退化为直连，行为与历史一致）。
 * 按候选查询词（原名 → 剥英文版本词 → 剥中文副标题）逐级尝试；结果内按名称相似度择优，
 * 避免 storesearch 把模糊首条当答案导致错配 AppID。单请求 10s 超时防卡死；
 * 任何失败返回 null（绝不抛错，交由上层 Wikidata/百度/网页兜底）。
 */
async function searchSteamAppId(gameName, fetchImpl) {
  const getJson = fetchImpl || fetchJsonProxy;
  if (!gameName) return null;
  // 离线优先：常见游戏直接命中 AppID，零网络依赖（storesearch 在受限网络下连不上，fork 子进程不继承代理变量）
  // 带版本词（Deluxe/Game of the Year/Remastered…）时离线库只有基础名，需同时试剥词后的变体，
  // 避免「Split Fiction Deluxe Edition」离线不中而白白走在线。
  const offlineVariants = [gameName];
  const strippedName = String(gameName).replace(EDITION_RE_G, "").replace(/\s+/g, " ").trim();
  if (strippedName && strippedName !== String(gameName).trim()) offlineVariants.push(strippedName);
  for (const v of offlineVariants) {
    const offline = lookupAppIdOffline(v);
    if (offline) return offline;
  }
  const norm = (s) =>
    String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  const variants = [];
  const push = (t) => {
    const v = String(t == null ? "" : t).trim();
    if (v && !variants.includes(v)) variants.push(v);
  };
  push(gameName);
  // 剥中文噪声标签 + 版本号 → 核心名（如「巫师3：狂猎 年度版 v1.6 官方中文」→「巫师3：狂猎」）
  push(cleanGameName(String(gameName).trim()));
  // 剥英文版本词（Game of the Year / Remastered / Definitive ...）得到基础英文名，提升精确匹配率
  push(String(gameName).replace(EDITION_RE_G, "").replace(/\s+/g, " ").trim());
  for (const term of variants) {
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=CN`;
    let j = null;
    try {
      j = await getJson(url, { timeout: 10000 });
    } catch {
      j = null;
    }
    const items = (j && Array.isArray(j.items) && j.items) || [];
    if (!items.length) continue;
    const q = norm(term);
    let best = null,
      bestScore = -1;
    for (const it of items) {
      const nm = norm(it && it.name);
      let score = 0;
      if (nm && q) {
        if (nm === q) score = 3;
        else if (nm.includes(q) || q.includes(nm)) score = 2;
        // 续作编号必须对上：查询带数字而候选缺号（如 PC Building Simulator 2 → PC Building Simulator）不算命中
        if (score >= 2 && !iterationMatches(term, it && it.name)) score = 0;
      }
      if (score > bestScore) {
        bestScore = score;
        best = it;
      }
    }
    // 强匹配（score>=2）直接采纳；查询带序号且无强匹配 → 不退化首条（避免前作顶包，交由上层兜底）
    if (bestScore >= 2) {
      if (best && best.id) {
        const en = best.name || term;
        rememberAppId(en, best.id, {
          zhName: /\p{Script=Han}/u.test(gameName) ? gameName : "",
        });
        return String(best.id);
      }
    } else if (!iterationMarkers(term).size && items.length) {
      if (items[0].id) {
        const en = items[0].name || term;
        rememberAppId(en, items[0].id, {
          zhName: /\p{Script=Han}/u.test(gameName) ? gameName : "",
        });
        return String(items[0].id);
      }
    }
  }
  return null;
}

/** 校验文件头 magic 是否为真实图片（JPEG/PNG/WEBP/GIF/BMP）。用于下载后过滤占位图/错误页。 */
function isImageMagic(buf) {
  if (!buf || buf.length < 4) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // GIF: 47 49 46 38 ("GIF8")
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  // BMP: 42 4D ("BM")
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
  // WEBP: 52 49 46 46 ("RIFF") + 偏移 8 处 57 45 42 50 ("WEBP")
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return true;
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
      if (r.statusCode !== 200) {
        r.destroy();
        return reject(new Error("HTTP " + r.statusCode));
      }
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
              try {
                fs.unlinkSync(fp);
              } catch {}
              return reject(new Error("下载内容非图片（magic 不匹配），已丢弃"));
            }
          } catch (e) {
            try {
              fs.unlinkSync(fp);
            } catch {}
            return reject(e);
          }
          resolve(fp);
        });
      });
      f.on("error", (e) => {
        f.destroy();
        reject(e);
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("下载超时"));
    });
    req.on("error", (e) => {
      req.destroy();
      reject(e);
    });
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
    `${cdn}/header.jpg`, // 横版 header，最后兜底（比例不佳）
    `${fas}/header.jpg`,
    `${aka}/header.jpg`,
    `${fas}/library_hero.jpg`, // 新游戏/未上架仅有 hero 横版大图时兜底（如 007 First Light 3768760）
    `${cdn}/library_hero.jpg`,
  ];
  return (async () => {
    let lastErr;
    for (const url of candidates) {
      try {
        return await tryDownload(url, fp);
      } catch (e) {
        lastErr = e;
      }
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
    ? data.genres.map((g) => (g && g.description) || "").filter(Boolean)
    : [];
  const type = data.type || "";
  const size = parseSteamSizeFromRequirements(data.pc_requirements);
  return { shortDescription: sd, genres, type, size };
}

/**
 * 抓取 Steam 官方 store 描述（主源，质量最高）。
 * 代理感知：走 fetchJsonProxy，无代理时退化为直连。失败/无结果返回 null，绝不抛错打断流程。
 */
async function getSteamAppDetails(appid) {
  if (!appid) return null;
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=schinese&cc=CN`;
  let j = null;
  // 瞬错（代理 TLS 握手 / 超时）常见：失败自动重试 1 次再放弃，避免一次抽风就把大小/描述全丢
  for (let attempt = 0; attempt < 2 && !j; attempt += 1) {
    try {
      j = await fetchJsonProxy(url, { timeout: 10000 });
    } catch {
      j = null;
    }
  }
  if (!j) return null;
  const entry = j[String(appid)];
  if (entry && entry.success && entry.data) return parseSteamAppDetails(entry.data);
  return null; // 应用下架/无数据：返回 null，交由 bl 兜底
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
// 通用 GET（文本 / JSON）：经 lib/proxyHttp 的代理感知层，无代理时退化为直连，行为不变。
// 任何异常 / 非 200 / 超时一律返回兜底值，绝不抛错打断流程。
// depth 参数保留仅为兼容旧调用签名，重定向由代理层内部处理（封顶 3 跳）。
function httpGetText(url, timeoutMs = 10000, depth = 0) {
  return fetchTextProxy(url, { timeout: timeoutMs }).then((t) => (t == null ? "" : t));
}

function httpGetJson(url, timeoutMs = 10000, depth = 0) {
  return fetchJsonProxy(url, { timeout: timeoutMs });
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
          const v =
            arr[0] &&
            arr[0].mainsnak &&
            arr[0].mainsnak.datavalue &&
            arr[0].mainsnak.datavalue.value;
          if (v) return String(v);
        }
      }
    }
  } catch {}
  return "";
}

/**
 * 维基百科游戏介绍兜底（Steam 官方描述不可达时使用）。
 * zh 搜中文名取词条首段；无词条则 en 搜英文名。失败/过短返回 null（绝不抛错）。
 * @param {string} englishName 英文名（可空）
 * @param {string} chineseName 中文名（可空）
 * @returns {Promise<{text:string, source:string}|null>}
 */
async function fetchWikiIntro(englishName, chineseName) {
  const candidates = [
    { lang: "zh", q: chineseName || englishName },
    { lang: "en", q: englishName || chineseName },
  ];
  for (const { lang, q } of candidates) {
    if (!q) continue;
    try {
      const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=1`;
      const s = await fetchJsonProxy(searchUrl, { timeout: 8000 });
      const title = s && s.query && s.query.search && s.query.search[0] && s.query.search[0].title;
      if (!title) continue;
      const extUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&titles=${encodeURIComponent(title)}&format=json&redirects=1`;
      const e = await fetchJsonProxy(extUrl, { timeout: 8000 });
      const pages = (e && e.query && e.query.pages) || {};
      const pg = Object.values(pages)[0];
      const text = pg && pg.extract ? String(pg.extract).trim() : "";
      if (text.length >= 40) {
        return { text: text.replace(/\s*\n+\s*/g, "\n").slice(0, 800), source: lang };
      }
    } catch (_) {
      /* 单语言失败继续下一语言 */
    }
  }
  return null;
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
  const ids = entities
    .map((e) => e && e.id)
    .filter(Boolean)
    .slice(0, 3);
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
  const m =
    /(?:英文名|英文名称|游戏英文名)[\s\S]{0,40}?([A-Za-z][A-Za-z0-9\s:'’!&.\-]{1,40})/i.exec(text);
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
  const tests = [/\|\s*english\s*=\s*([^\n|{}<]{1,80})/i, /\|\s*原名\s*=\s*([^\n|{}<]{1,80})/i];
  for (const re of tests) {
    const m = re.exec(wikitext);
    if (m) {
      const v = m[1].trim();
      if (/[A-Za-z]/.test(v)) return v;
    }
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
  if (
    /2|二|第\s*ii|ii|2代|3|三|第\s*iii|iii/.test(inL) &&
    /ii|2|part|iii|3|vol/i.test(enL + " " + tiL)
  )
    score += 2;
  if (/重制|复刻/.test(inL) && /remaster|remake/i.test(enL + " " + tiL)) score += 2;
  if (/年度/.test(inL) && /year|goty/i.test(enL + " " + tiL)) score += 1;
  if (/决定|终极|完全/.test(inL) && /definitive|ultimate|complete/i.test(enL + " " + tiL))
    score += 1;
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
const EDITION_WORDS =
  /remaster|remake|definitive|deluxe|gold|platinum|complete|collector|goty|game of the year|ultimate|edition/i;
/** 全局剥词用（EDITION_WORDS 无 g 标志用于 test()，剥词需 g 才能剥掉叠词）。 */
const EDITION_RE_G =
  /remaster|remake|definitive|deluxe|gold|platinum|complete|collector|goty|game of the year|ultimate|edition/gi;

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

// ── Bangumi（api.bgm.tv，国内必达，无需代理）中文名 → 英文名 ──
/** 纯函数：判断字符串是否「拉丁字母为主」（可作英文名候选）。含 CJK/假名则视为非拉丁，不可用。可单测。 */
function isLatinName(s) {
  if (!s) return false;
  // 命中任一 CJK / 日文假名 / 全角标点范围 → 非拉丁
  return !/[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/.test(s);
}

/** 纯函数：中文名相似度（归一化后字符 Jaccard + 包含加分）。可单测。 */
function cnNameSimilarity(a, b) {
  const norm = (s) =>
    String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[\s'’!.,:：·\-_/()（）]/g, "");
  const x = norm(a),
    y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.9; // 一方包含另一方：高相似（副标题差异）
  const sx = new Set(x),
    sy = new Set(y);
  let inter = 0;
  sx.forEach((c) => {
    if (sy.has(c)) inter++;
  });
  const union = sx.size + sy.size - inter;
  return union ? inter / union : 0;
}

/** 提取名称里的续作编号标记（阿拉伯数字 / 中文数字 / 常见罗马数字）。 */
function iterationMarkers(s) {
  const t = String(s == null ? "" : s).toLowerCase();
  const set = new Set();
  const digits = t.match(/\d+/g) || [];
  digits.forEach((d) => set.add(d));
  const CN = {
    一: "1",
    二: "2",
    三: "3",
    四: "4",
    五: "5",
    六: "6",
    七: "7",
    八: "8",
    九: "9",
    十: "10",
  };
  Object.keys(CN).forEach((ch) => {
    if (t.includes(ch)) set.add(CN[ch]);
  });
  const ROMAN = {
    i: "1",
    ii: "2",
    iii: "3",
    iv: "4",
    v: "5",
    vi: "6",
    vii: "7",
    viii: "8",
    ix: "9",
    x: "10",
  };
  Object.keys(ROMAN).forEach((r) => {
    if (new RegExp("\\b" + r + "\\b").test(t)) set.add(ROMAN[r]);
  });
  return set;
}

/** 续作编号门禁：term 带序号时，orig 必须含对应序号（防前作顶包）。 */
function iterationMatches(term, orig) {
  const t = iterationMarkers(term);
  if (!t.size) return true;
  const o = iterationMarkers(orig);
  for (const n of t) if (o.has(n)) return true;
  return false;
}

/**
 * 从 Bangumi（api.bgm.tv，国内必达）反查英文名。
 * 对候选名逐级查询：取 name_cn 与输入中文名相似度最高、且 name 为拉丁字母（非日文原名）的条目。
 * 过滤规则（防错配）：① name_cn 与输入相似度 < 0.5 跳过；② name 是日文原名（非拉丁）跳过。
 * 失败 / 无匹配 / 超时一律返回 ""（绝不抛错打断流程）。deps.httpGetJson 可注入 mock 单测。
 */
async function fetchEnglishNameFromBangumi(name, httpGetJson) {
  if (!name) return "";
  const terms = [name, stripSubtitle(name)].filter((t, i, a) => t && a.indexOf(t) === i);
  try {
    for (const term of terms) {
      const url = `https://api.bgm.tv/search/subject/${encodeURIComponent(term)}?type=4&max_results=10`;
      const data = await httpGetJson(url, 8000);
      const list = (data && (data.list || (data.data && data.data.list) || [])) || [];
      let best = "",
        bestScore = 0;
      for (const it of list) {
        const cn = it && it.name_cn ? String(it.name_cn) : "";
        const orig = it && it.name ? String(it.name) : "";
        if (!orig) continue;
        const sim = cnNameSimilarity(term, cn);
        if (sim < 0.5) continue; // 中文名对不上的候选跳过，避免错配
        if (!isLatinName(orig)) continue; // 日文原名不可作英文名（如 ペルソナ5 ザ・ロイヤル）
        // 续作编号门禁：仅子串相似（非精确）时校验序号，防止前作顶包（如 装机模拟器2 → PC Building Simulator）
        if (sim < 1 && !iterationMatches(term, orig)) continue;
        if (sim > bestScore) {
          bestScore = sim;
          best = orig;
        }
      }
      if (best) return best;
    }
  } catch {}
  return "";
}

// ── 清洗 / 副标题剥离 / AppID 抽取：见 lib/nameutil.js（纯函数，parser 与 steam 共享）──

/**
 * 解析游戏英文名（中文名 → 英文名）。多源兜底：
 *   0) 离线静态库（内置映射，无需联网，优先命中）
 *   1) Bangumi（api.bgm.tv，国内必达，无需代理）中文名→英文名
 *   2) Wikidata 中文 search → 英文 label（最结构化、最可靠）
 *   3) Wikipedia 中文模糊搜 摘要/infobox 英語/原名
 *   4) 百度百科词条页英文段
 * 失败/超时/异常一律返回 ""（绝不抛错打断流程），交由上层直接用中文名匹配。
 * 注：Wikidata/Wikipedia/百度 在「配置了 HTTP 代理」时才能从国内连上；否则退化到 Bangumi/离线库。
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
      // 1) Bangumi（api.bgm.tv，国内必达，无需代理）：中文名→英文名 高覆盖，离线库未命中时首选在线源
      try {
        const en = await fetchEnglishNameFromBangumi(name, httpJson);
        if (en) {
          baseEn = en;
          break;
        }
      } catch {}
      // 2) Wikidata zh search → en label（有中文 label 时最结构化、最可靠，离线+Bangumi 未命中时再用）
      try {
        const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=zh&format=json&limit=3`;
        const search = await httpJson(searchUrl, 8000);
        const ids = ((search && search.search) || [])
          .map((e) => e && e.id)
          .filter(Boolean)
          .slice(0, 3);
        if (ids.length) {
          const entUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.join("|")}&props=labels&languages=en&format=json`;
          const ent = await httpJson(entUrl, 8000);
          const label = extractEnglishNameFromWikidata(search, ent);
          if (label) {
            baseEn = label;
            break;
          }
        }
      } catch {}
      // 3) Wikipedia 中文模糊搜 → 摘要/infobox 的 英語/原名（覆盖 Wikidata 无中文 label 的游戏）
      try {
        const en = await fetchEnglishNameFromWikipedia(name, httpJson);
        if (en) {
          baseEn = en;
          break;
        }
      } catch {}
      // 4) 百度百科英文段（防御性：遇反爬验证页直接跳过）
      try {
        const html = await httpText(
          `https://baike.baidu.com/item/${encodeURIComponent(name)}`,
          8000,
        );
        const en = extractEnglishNameFromBaidu(html);
        if (en) {
          baseEn = en;
          break;
        }
      } catch {}
    }
    if (!baseEn) return "";
    // 版本词增强：输入含 重制版/年度版 等 → 拼出精确英文名（如 Part II + 重制版 → Part II Remastered）
    return augmentWithEdition(baseEn, raw);
  };

  // 总超时预算（H2）：多源全失败时最坏会串行挂数十秒，这里封顶 15s，
  // 超时即放弃解析（交上层直接用中文名匹配），避免整条录入被拖死。
  let timer;
  const timeoutP = new Promise((res) => {
    timer = setTimeout(() => res(""), 15000);
  });
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
  const m =
    /(?:storage|存储空间|硬盘|磁盘空间)[\s\S]{0,40}?([\d]+(?:\.\d+)?)\s*(gb|mb|tb|g|m|t)/i.exec(
      html,
    );
  if (m) return m[1] + m[2].toUpperCase();
  // 2) 兜底：requirements 段内第一个 "40 GB" 形态
  const m2 = /([\d]+(?:\.\d+)?)\s*(gb|mb|tb|g|m|t)\b/i.exec(html);
  return m2 ? m2[1] + m2[2].toUpperCase() : "";
}

module.exports = {
  searchSteamAppId,
  downloadCover,
  downloadCoverFromUrl,
  getSteamAppDetails,
  parseSteamAppDetails,
  parseSteamAppIdFromText,
  fetchAppIdFromWikidata,
  fetchAppIdFromBaiduBaike,
  fetchAppIdFromWebSearch,
  parseSteamSizeFromRequirements,
  resolveEnglishName,
  extractEnglishNameFromWikidata,
  extractEnglishNameFromBaidu,
  extractEnglishNameFromWikiSnippet,
  extractEnglishNameFromWikiInfobox,
  fetchEnglishNameFromWikipedia,
  fetchEnglishNameFromBangumi,
  isLatinName,
  cnNameSimilarity,
  fetchWikiIntro,
  detectEditionSuffix,
  augmentWithEdition,
  cleanGameName,
  stripSubtitle,
  tryDownload,
  isImageMagic,
};
