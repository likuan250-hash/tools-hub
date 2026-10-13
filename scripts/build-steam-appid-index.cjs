#!/usr/bin/env node
// 构建 Steam 离线 AppID 索引（开发期一次性任务，产物随包发布）。
//
// 数据来源：
//   1) Steam 商店搜索接口（cc=CN&l=schinese&category1=998）—— 全量游戏 + 中文名（约 17.8 万条，需爬 ~1800 页）
//   2) HM-YS/hm-appid-database games_appid.json —— 英文名（约 18.8 万条）
//   3) Austrum-lab/steam-appdb applist.json —— 全量应用（含工具/DLC，补漏）
//
// 产物：kdocs-tool/lib/steam-appid-index.json.gz  {"v":1,"count":N,"map":{"<归一化名>":appid}}
// 归一化规则与 kdocs-tool/lib/gameappid.js 的 normEn 保持一致（小写、去非字母数字）；
// 中文名同样按「小写 + 去标点空白」归一化，键前缀不区分中英，命中即返回。
//
// 用法：
//   node scripts/build-steam-appid-index.cjs --crawl     # 爬全量商店（慢，~20 分钟，可断点续爬）
//   node scripts/build-steam-appid-index.cjs             # 只用本地已下载/已爬数据生成索引

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(ROOT, ".tmp");
const OUT = path.join(ROOT, "kdocs-tool", "lib", "steam-appid-index.json.gz");
const OUT_NAME_MAP = path.join(ROOT, "kdocs-tool", "lib", "steam-name-map.json.gz");
const CHECKPOINT = path.join(TMP, "steam-store-cn.json");
const LOCAL = {
  games: path.join(TMP, "steam-games-appid-raw.json"),
  applist: path.join(TMP, "steam-applist-raw.json"),
};
const REMOTE = {
  games: "https://cdn.jsdelivr.net/gh/HM-YS/hm-appid-database@main/data/games_appid.json",
  applist: "https://cdn.jsdelivr.net/gh/Austrum-lab/steam-appdb@master/data/applist.json",
};

const CONCURRENCY = Number(process.env.STEAM_CRAWL_CONCURRENCY || 1);
const PAGE_DELAY = Number(process.env.STEAM_CRAWL_DELAY_MS || 700);
const COOLDOWN_MS = Number(process.env.STEAM_CRAWL_COOLDOWN_MS || 300000);
const PAGE = 100;

const norm = (s) =>
  String(s == null ? "" : s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u2122\u00ae\u2120]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff]+/g, "");

function storeUrl(start, cc, l) {
  return (
    "https://store.steampowered.com/search/results/?query" +
    `&start=${start}&count=${PAGE}&infinite=1&json=1&cc=${cc}&l=${l}&category1=998`
  );
}

function parseRows(html) {
  const out = [];
  const chunks = String(html || "").split('data-ds-appid="');
  for (let i = 1; i < chunks.length; i += 1) {
    const c = chunks[i];
    const appid = c.slice(0, c.indexOf('"'));
    if (!/^\d+$/.test(appid)) continue;
    const m = c.slice(0, 1600).match(/<span class="title">([^<]+)<\/span>/);
    if (!m) continue;
    const name = m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
    if (name) out.push([appid, name]);
  }
  return out;
}

async function getJson(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ToolsHub-index-builder" },
        signal: AbortSignal.timeout(30000),
      });
      if (r.status === 429) {
        const err = new Error("HTTP 429");
        err.status = 429;
        throw err;
      }
      if (r.status >= 500) throw new Error("HTTP " + r.status);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (e.status === 429) break; // 限流：交给上层冷却，别在重试里死磕
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function downloadIfMissing(file, url) {
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return file;
  process.stdout.write(`[fetch] ${path.basename(file)} ...\n`);
  const r = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error("download failed " + r.status + " " + url);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return file;
}

function loadCheckpoint() {
  try {
    const j = JSON.parse(fs.readFileSync(CHECKPOINT, "utf8"));
    return { total: j.total || 0, rows: j.rows || {}, done: new Set(j.done || []) };
  } catch (_) {
    return { total: 0, rows: {}, done: new Set() };
  }
}

function saveCheckpoint(state) {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(
    CHECKPOINT,
    JSON.stringify({ total: state.total, rows: state.rows, done: [...state.done], savedAt: Date.now() })
  );
}

async function crawl() {
  const state = loadCheckpoint();
  let first = null;
  for (let i = 0; i < 20 && !first; i += 1) {
    try {
      first = await getJson(storeUrl(0, "CN", "schinese"));
    } catch (e) {
      if (e.status !== 429) throw e;
      process.stdout.write(`[crawl] 首页被限流，等待 ${90 + i * 30}s 后重试（${i + 1}/20）\n`);
      await new Promise((r) => setTimeout(r, (90 + i * 30) * 1000));
    }
  }
  if (!first) throw new Error("商店搜索持续 429，稍后再跑 --crawl");
  state.total = first.total_count || state.total;
  for (const [id, name] of parseRows(first.results_html)) if (!state.rows[id]) state.rows[id] = name;
  state.done.add(0);
  const pages = Math.ceil(state.total / PAGE);
  process.stdout.write(`[crawl] total=${state.total} pages=${pages} resumed=${state.done.size}\n`);
  saveCheckpoint(state);

  let queue = [];
  for (let p = 0; p < pages; p += 1) if (!state.done.has(p * PAGE)) queue.push(p * PAGE);
  const attempts = new Map();
  let retry = [];
  let savedAt = Date.now();
  let cooldownUntil = 0;

  const worker = async (slot) => {
    for (;;) {
      const start = queue.shift();
      if (start === undefined) return;
      const wait = cooldownUntil - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 120000)));
      try {
        const j = await getJson(storeUrl(start, "CN", "schinese"));
        for (const [id, name] of parseRows(j.results_html)) if (!state.rows[id]) state.rows[id] = name;
        state.done.add(start);
      } catch (e) {
        if (e.status === 429) {
          const cool = COOLDOWN_MS + Math.floor(Math.random() * 60000);
          cooldownUntil = Date.now() + cool;
          process.stdout.write(`[crawl] 429 限流，冷却 ${Math.round(cool / 1000)}s\n`);
        }
        const n = (attempts.get(start) || 0) + 1;
        attempts.set(start, n);
        if (n <= 20) retry.push(start);
        else process.stdout.write(`[crawl] start=${start} 放弃（${e.message}）\n`);
      }
      await new Promise((r) => setTimeout(r, PAGE_DELAY + Math.floor(Math.random() * 300 * slot)));
      if (queue.length === 0 && retry.length) {
        queue = retry;
        retry = [];
        await new Promise((r) => setTimeout(r, 30000));
      }
      if (Date.now() - savedAt > 15000) {
        saveCheckpoint(state);
        savedAt = Date.now();
        process.stdout.write(`[crawl] progress ${state.done.size}/${pages} pages, rows=${Object.keys(state.rows).length}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  saveCheckpoint(state);
  process.stdout.write(`[crawl] done pages=${state.done.size}/${pages} rows=${Object.keys(state.rows).length}\n`);
}

function buildIndex() {
  const map = {};
  let src = 0;
  const put = (id, name) => {
    const k = norm(name);
    if (!k || !id) return;
    if (map[k] == null) map[k] = String(id);
  };
  if (fs.existsSync(CHECKPOINT)) {
    const j = JSON.parse(fs.readFileSync(CHECKPOINT, "utf8"));
    for (const [id, name] of Object.entries(j.rows || {})) put(id, name);
    src += Object.keys(j.rows || {}).length;
  }
  for (const [file, pick] of [
    [LOCAL.games, (j) => j],
    [LOCAL.applist, (j) => (j.applist && j.applist.apps) || []],
  ]) {
    if (!fs.existsSync(file)) continue;
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const it of pick(j)) put(it.appid, it.name);
    src += 1;
  }
  // 中文名大库（Karasukaigan）→ 已有英文名，反向补一份「英文名→appid」已由上面覆盖
  const keys = Object.keys(map);
  const payload = JSON.stringify({ v: 1, builtAt: new Date().toISOString().slice(0, 10), count: keys.length, map });
  fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(payload, "utf8"), { level: 9 }));
  process.stdout.write(
    `[build] sources=${src} keys=${keys.length} raw=${(payload.length / 1048576).toFixed(1)}MB gz=${(fs.statSync(OUT).size / 1048576).toFixed(2)}MB -> ${OUT}\n`
  );
  buildNameMap();
}

// 中文名（商店）→ 英文名（数据集）按 appid join，产出与 game-name-map.json 同格式的补充库。
function buildNameMap() {
  const zhByApp = {};
  if (fs.existsSync(CHECKPOINT)) {
    const j = JSON.parse(fs.readFileSync(CHECKPOINT, "utf8"));
    for (const [id, name] of Object.entries(j.rows || {})) zhByApp[id] = name;
  }
  const enByApp = {};
  if (fs.existsSync(LOCAL.games)) {
    for (const it of JSON.parse(fs.readFileSync(LOCAL.games, "utf8"))) if (it.name) enByApp[it.appid] = it.name;
  }
  if (fs.existsSync(LOCAL.applist)) {
    const apps = JSON.parse(fs.readFileSync(LOCAL.applist, "utf8")).applist.apps || [];
    for (const it of apps) if (it.name && !enByApp[it.appid]) enByApp[it.appid] = it.name;
  }
  const map = {};
  let pairs = 0;
  for (const [id, zh] of Object.entries(zhByApp)) {
    const en = enByApp[id];
    if (!en || !zh) continue;
    if (norm(zh) === norm(en)) continue;
    if (!/[\u4e00-\u9fff]/.test(zh)) continue; // 中文名字段里不是中文的，交给 AppID 索引即可
    const k = norm(zh);
    if (k && !map[k]) {
      map[k] = en;
      pairs += 1;
    }
  }
  const payload = JSON.stringify({ v: 1, builtAt: new Date().toISOString().slice(0, 10), count: pairs, map });
  fs.writeFileSync(OUT_NAME_MAP, zlib.gzipSync(Buffer.from(payload, "utf8"), { level: 9 }));
  process.stdout.write(
    `[build] name-map pairs=${pairs} raw=${(payload.length / 1048576).toFixed(1)}MB gz=${(fs.statSync(OUT_NAME_MAP).size / 1048576).toFixed(2)}MB -> ${OUT_NAME_MAP}\n`
  );
}

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  if (process.argv.includes("--crawl")) await crawl();
  if (process.argv.includes("--fetch")) {
    await downloadIfMissing(LOCAL.games, REMOTE.games);
    await downloadIfMissing(LOCAL.applist, REMOTE.applist);
  }
  buildIndex();
})().catch((e) => {
  process.stderr.write("FAILED " + e.stack + "\n");
  process.exit(1);
});
