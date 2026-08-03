// ── Steam 搜索 + 封面下载 ──
const https = require("https");
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
  return { shortDescription: sd, genres, type };
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

module.exports = { searchSteamAppId, downloadCover, downloadCoverFromUrl, getSteamAppDetails, parseSteamAppDetails };
