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

/** 下载 Steam 封面到指定目录（多源 fallback：优先 cloudflare，国内最稳） */
function downloadCover(gameName, appid, coverDir) {
  coverDir = coverDir || DEFAULT_COVER_DIR;
  if (!fs.existsSync(coverDir)) fs.mkdirSync(coverDir, { recursive: true });
  const safe = gameName.replace(/[\\/:*?"<>|]/g, "_");
  const fp = path.join(coverDir, `${safe}_cover.jpg`);
  const cdn = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}`;
  const fas = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}`;
  const aka = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}`;
  const candidates = [
    `${cdn}/library_600x900_2x.jpg`,  // 竖版大图，最像"宣传图"
    `${cdn}/header.jpg`,
    `${fas}/library_600x900_2x.jpg`,
    `${fas}/header.jpg`,
    `${aka}/header.jpg`,             // 原 akamai，兜底
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

/** 从任意图片 URL 下载封面（非 Steam 游戏：用户提供的官方封面链接兜底） */
function downloadCoverFromUrl(gameName, url, coverDir) {
  coverDir = coverDir || DEFAULT_COVER_DIR;
  if (!fs.existsSync(coverDir)) fs.mkdirSync(coverDir, { recursive: true });
  const safe = gameName.replace(/[\\/:*?"<>|]/g, "_");
  const ext = /\.png/i.test(url) ? "png" : /\.webp/i.test(url) ? "webp" : "jpg";
  const fp = path.join(coverDir, `${safe}_cover.${ext}`);
  return tryDownload(url, fp);
}

module.exports = { searchSteamAppId, downloadCover, downloadCoverFromUrl };
