// 抓取论坛作者资源帖（无需登录，版区翻页 + 作者过滤）
// 3DM 风花雪月Zzz：forum-192（综合资源区，卡片）+ game0day（新游发布区，表格）
// 游侠 天选搬运工：两阶段（板块扫描 + 命中板块深翻）
// 输出：docs/forum-resources.json { authors: [{site, author, items:[{title, url, tid, game}]}] }
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "docs", "forum-resources.json");
const YX_CKPT = path.join(ROOT, "docs", ".forum-yx-checkpoint.json");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function get(url, referer) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9", Referer: referer || "" },
      redirect: "follow",
    });
    return { status: r.status, text: await r.text() };
  } finally {
    clearTimeout(timer);
  }
}

// ── 3DM：综合资源区 fid=192（卡片式）+ 新游发布区 game0day（表格式）──
async function scrape3dm() {
  const site = "https://bbs.3dmgame.com";
  const author = "风花雪月Zzz";
  const map = new Map(); // tid -> {tid, title, url, board, views, time}
  const add = (tid, title, board) => {
    if (!tid || !title) return;
    if (!map.has(tid)) {
      map.set(tid, { tid, title, url: site + "/thread-" + tid + "-1-1.html", board });
    }
  };
  // 卡片式（综合资源区）
  for (let p = 1; p <= 20; p++) {
    let text = "";
    try {
      const r = await get(site + "/forum-192-" + p + ".html", site + "/forum.php");
      text = r.text;
    } catch (e) {
      /* 跳过该页 */
    }
    const lis = text.match(/<li style="width:274px">[\s\S]*?<\/li>/g) || [];
    for (const li of lis) {
      const t = /thread-(\d+)-1-\d+\.html"[^>]*title="([^"]+)"/.exec(li);
      const a = /space-uid-(\d+)\.html"[^>]*>([^<]+)</.exec(li);
      if (t && a && a[2].trim() === author) add(t[1], t[2], "综合资源区");
    }
    await sleep(1000);
  }
  // 表格式（新游发布区）
  for (let p = 1; p <= 8; p++) {
    let text = "";
    try {
      const r = await get(site + "/game0day?page=" + p, site + "/forum.php");
      text = r.text;
    } catch (e) {
      /* 跳过 */
    }
    const trs = text.match(/<tr>[\s\S]*?<\/tr>/g) || [];
    for (const tr of trs) {
      const t = /thread-(\d+)-1-\d+\.html"[^>]*class="s xst"[^>]*>([^<]+)</.exec(tr);
      const by = /space-uid-(\d+)\.html"[^>]*>([^<]+)</.exec(tr);
      if (t && by && by[2].trim() === author) add(t[1], t[2], "新游发布区");
    }
    await sleep(1000);
  }
  return [...map.values()];
}

// ── 游侠：两阶段（板块扫描定位 + 命中板块深翻）──
async function scrapeYx() {
  const site = "https://game.ali213.net";
  const author = "天选搬运工";
  let map = new Map(); // tid -> {tid, title, url, board}
  let scanDone = []; // 阶段1已完成扫描的 fid
  let deepDone = []; // 阶段2已完成深翻的 fid
  let hits = new Set(); // 命中作者出没的 fid
  if (fs.existsSync(YX_CKPT)) {
    try {
      const ck = JSON.parse(fs.readFileSync(YX_CKPT, "utf8"));
      map = new Map((ck.items || []).map((x) => [x.tid, x]));
      scanDone = ck.scanDone || ck.processed || [];
      deepDone = ck.deepDone || [];
      hits = new Set(ck.hits || []);
      console.log(
        "恢复游侠断点: 已收",
        map.size,
        "条, 扫描完",
        scanDone.length,
        ", 深翻完",
        deepDone.length,
      );
    } catch (e) {
      /* 断点损坏则重来 */
    }
  }
  const add = (tid, title, board) => {
    if (!tid || !title) return;
    if (!map.has(tid))
      map.set(tid, { tid, title, url: site + "/thread-" + tid + "-1-1.html", board });
  };
  const saveCkpt = () => {
    fs.writeFileSync(
      YX_CKPT,
      JSON.stringify({ items: [...map.values()], scanDone, deepDone, hits: [...hits] }, null, 0),
      "utf8",
    );
  };
  // 从版区页解析帖子（标准 Discuz 表格）：返回 { tid, title, author }[]
  const parseBoard = (html) => {
    const out = [];
    const tb =
      html.match(/<tbody[^>]*id="(?:normal|stick)thread_(\d+)">([\s\S]*?)<\/tbody>/g) || [];
    for (const row of tb) {
      const tid =
        /id="(?:normal|stick)thread_(\d+)"/.exec(row) &&
        /id="(?:normal|stick)thread_(\d+)"/.exec(row)[1];
      const xst = /class="xst"[^>]*>([^<]+)</.exec(row);
      const by = /<td class="by">\s*<cite>\s*<a[^>]*>([^<]+)</.exec(row);
      if (tid && xst) out.push({ tid, title: xst[1].trim(), author: by ? by[1].trim() : "" });
    }
    return out;
  };
  const fetchBoard = async (fid, page) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await get(site + "/forum-" + fid + "-" + page + ".html", site + "/forum.php");
        if (r.status === 200 && r.text.length > 5000) return r.text;
      } catch (e) {
        /* 重试 */
      }
      await sleep(1500 + attempt * 500);
    }
    return "";
  };
  // 阶段 1：板块索引 → 候选 fid（>=3000）
  const idxText = await (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await get(site + "/forum.php?mod=index", site + "/");
        if (r.status === 200 && r.text.length > 5000) return r.text;
      } catch (e) {
        /* 重试 */
      }
      await sleep(1500 + attempt * 500);
    }
    return "";
  })();
  const fidSet = new Set();
  const boardNames = {};
  const re = /forum-(\d+)-1\.html"[^>]*>(?:<[^>]+>)*([^<]{2,30})</g;
  let m;
  while ((m = re.exec(idxText))) {
    const fid = Number(m[1]);
    if (fid >= 3000) {
      fidSet.add(fid);
      boardNames[fid] = m[2].replace(/&nbsp;/g, " ").trim();
    }
  }
  // 若首页无板块列表，抓 forum.php 再试
  if (!fidSet.size) {
    const r = await get(site + "/forum.php", site + "/");
    const re2 = /forum-(\d+)-1\.html"[^>]*>(?:<[^>]+>)*([^<]{2,30})</g;
    while ((m = re2.exec(r.text))) {
      const fid = Number(m[1]);
      if (fid >= 3000) {
        fidSet.add(fid);
        boardNames[fid] = m[2].replace(/&nbsp;/g, " ").trim();
      }
    }
  }
  console.log("游侠候选板块:", fidSet.size);
  // 阶段 1.5：逐板块首页扫描
  for (const fid of fidSet) {
    if (scanDone.includes(fid)) continue;
    const html = await fetchBoard(fid, 1);
    if (!html) continue;
    for (const p of parseBoard(html)) {
      if (p.author === author) hits.add(fid);
    }
    scanDone.push(fid);
    saveCkpt();
    await sleep(1500);
  }
  console.log("游侠命中板块:", hits.size);
  // 阶段 2：命中板块深翻（最多 10 页，p>1 且 0 新帖早停）
  for (const fid of hits) {
    if (deepDone.includes(fid)) continue;
    let fresh = 0;
    for (let p = 1; p <= 10; p++) {
      const html = await fetchBoard(fid, p);
      if (!html) break;
      const posts = parseBoard(html).filter((x) => x.author === author);
      if (p > 1 && !posts.length) break;
      for (const x of posts) add(x.tid, x.title, boardNames[fid] || "板块" + fid);
      fresh += posts.length;
      await sleep(1500);
    }
    deepDone.push(fid);
    saveCkpt();
  }
  return [...map.values()];
}

async function main() {
  const data = { generatedAt: new Date().toISOString(), authors: [] };
  let m3 = [];
  let yx = null;
  if (process.argv.includes("--yx-only")) {
    if (fs.existsSync(OUT)) {
      try {
        const old = JSON.parse(fs.readFileSync(OUT, "utf8"));
        const old3 = (old.authors || []).find((a) => a.site === "3DM");
        m3 = (old3 && old3.items) || [];
        const oldYx = (old.authors || []).find((a) => a.site === "游侠");
        yx = (oldYx && oldYx.items) || null;
      } catch (e) {
        /* 旧数据损坏则重抓 */
      }
    }
  }
  if (!m3.length) m3 = await scrape3dm();
  data.authors.push({ site: "3DM", author: "风花雪月Zzz", count: m3.length, items: m3 });
  if (!yx) yx = await scrapeYx();
  data.authors.push({ site: "游侠", author: "天选搬运工", count: yx.length, items: yx });
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2), "utf8");
  if (fs.existsSync(YX_CKPT)) fs.unlinkSync(YX_CKPT);
  console.log("3DM:", m3.length, "条");
  console.log("游侠:", yx.length, "条");
  console.log("输出:", OUT);
}

main().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
