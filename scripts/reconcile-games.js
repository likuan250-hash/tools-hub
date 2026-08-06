// B站已发视频 ↔ 金山文档资源 对账，生成静态 HTML 展示。
// 用法：node scripts/reconcile-games.js [输出.html]
// 数据源：B站创作中心 archives/sp（biliup-hub cookies）+ 金山多维表 cnYP7TEeZYJ1（kdocs-cli）。
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const ROOT = path.resolve(__dirname, "..");

const KDOCS_FILE_ID = "cnYP7TEeZYJ1";
const KDOCS_CLI = path.join(ROOT, "kdocs-tool", "kdocs-cli-bin", "kdocs-cli.exe");
const OUT_HTML = process.argv[2] || path.join(ROOT, "docs", "games-reconcile.html");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) biliup-hub/0.1";
// 中英映射（kdocs-tool 现成）：中文名 → 英文名，用于桥接不同语言写法
let lookupEnglishName = null;
try {
  const gamemap = require(path.join(ROOT, "kdocs-tool", "lib", "gamemap"));
  lookupEnglishName = gamemap.lookupEnglishNameOffline;
} catch (e) {
  /* 映射缺失时仅靠同语言匹配 */
}

// ── 匹配词表 ──
const SUFFIX_WORDS = [
  "官方中文版",
  "官方中文",
  "全DLC",
  "免安装硬盘版",
  "免安装",
  "硬盘版",
  "学习版",
  "免费学习版",
  "破解版",
  "绿色版",
  "豪华版",
  "豪华中文",
  "豪华中文版",
  "完整豪华版",
  "终极版",
  "年度版",
  "黄金版",
  "冠军版",
  "高级版",
  "完整版",
  "中文版",
  "数字豪华版",
  "周年纪念版",
  "最终纪念版",
  "重制版",
  "重置版",
  "复刻版",
  "重植版",
  "次时代版",
  "次世代版",
  "内置汉化",
  "官方简中语音",
  "简中语音",
  "简体中文",
  "官方简体",
  "教程",
  "汉化",
  "原声乐",
  "原声音乐",
  "扩展包",
  "季票",
  "XG器",
  "全物品解锁存档",
  "导演剪辑",
  "记忆重置",
  "高清材质包",
  "材质包",
  "实用MOD",
  "MOD",
  "mod整合",
  "联动",
  "整合",
  "存档",
  "手机版",
  "手机",
  "内置",
  "免费",
  "中文",
  "版本",
  "版",
  "DLC",
  "下载",
  "合集",
  "系列",
  "三部曲",
];
const NUM_VERSION = /\bv\d+(?:\.\d+)+\b/gi;
const BARE_VERSION = /\b\d+(?:\.\d+)+\b/g;
const BILI_PREFIX = /^【[^】]*】/;

function stripWords(s) {
  for (let i = 0; i < 5; i++) {
    const before = s;
    for (const w of SUFFIX_WORDS) s = s.split(w).join(" ");
    s = s.replace(BARE_VERSION, " ").replace(/[+＋]/g, " ");
    if (s === before) break;
  }
  return s;
}

// ── 归一化（轻量版，不依赖 kdocs 模块避免副作用）──
function normZh(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s:：·•、，,.。!！?？()（）\[\]【】"'«»/\\|_\-—～~*+#@%&='"'']/g, "")
    .replace(/的/g, "")
    .replace(/重置版|复刻版/g, "重制版");
}
function normEn(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function stripTitle(raw) {
  let s = String(raw || "").replace(/\.(mp4|mkv|webm|mov)$/i, "");
  s = s.replace(BILI_PREFIX, "").replace(NUM_VERSION, " ");
  s = stripWords(s);
  s = s.replace(/[（(]\s*[^）)]*[）)]/g, " "); // 清残留括号（如「剑星（非 ）」）
  return s.replace(/\s+/g, " ").trim();
}

// 从金山记录拆中英文候选
function splitCandidates(raw) {
  let s = String(raw || "").replace(NUM_VERSION, " ");
  s = s.replace(/【[^】]*】/g, " ");
  s = stripWords(s);
  const zh = new Set(),
    en = new Set();
  // 双名拆分（如龙/人中之龙0、COD21/使命召唤21），每段独立提候选
  const parts = String(s)
    .split(/[\/／]/)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const part of parts) {
    const zhSegs = part.match(/[\u4e00-\u9fff][\u4e00-\u9fff0-9]{1,}/g) || [];
    if (zhSegs.length) zh.add(normZh(zhSegs.join("")));
    zhSegs.forEach((z) => zh.add(normZh(z)));
    const parens = part.match(/[（(]\s*([A-Za-z][^）)]*)[）)]/g) || [];
    const enSegs = parens.map((p) => p.replace(/[（()）]/g, "").trim());
    const outer = part.replace(/[（(][^）)]*[）)]/g, " ");
    const outerEn = outer.match(/[A-Za-z][A-Za-z0-9 .:'&()-]{2,}/g) || [];
    enSegs.push(...outerEn);
    if (enSegs.length) en.add(normEn(enSegs.join(" ")));
    enSegs.forEach((x) => en.add(normEn(x)));
  }
  return { zh: [...zh].filter(Boolean), en: [...en].filter(Boolean) };
}

function isAuxRecord(raw) {
  const s = String(raw || "");
  if (!s.trim()) return true;
  if (/查询|⬇|⬆|说明|目录|QQ群|加群/.test(s)) return true;
  return s.trim().length < 4;
}

// ── B站：拉全部已发稿件标题 ──
async function fetchBiliTitles() {
  const cookiesMod = require(path.join(ROOT, "biliup-hub", "lib", "cookies"));
  const store = require(path.join(ROOT, "biliup-hub", "lib", "store"));
  const cf = cookiesMod.load(store.getConfig().cookiesPath);
  const cookieHeader = cookiesMod.toHeader(cf);
  const titles = [];
  for (let pn = 1; ; pn++) {
    const r = await fetch(
      "https://member.bilibili.com/x2/creative/web/archives/sp?pn=" + pn + "&ps=100",
      {
        headers: {
          Cookie: cookieHeader,
          Referer: "https://member.bilibili.com/",
          "User-Agent": UA,
        },
      },
    );
    const j = await r.json();
    const audits = (j.data && j.data.arc_audits) || [];
    const batch = audits.map((a) => a.Archive && a.Archive.title).filter(Boolean);
    titles.push(...batch);
    if (batch.length < 100) break;
  }
  return titles;
}

// ── 金山：拉全部游戏名称记录 ──
function callKdocs(params) {
  return new Promise((resolve, reject) => {
    const child = spawn(KDOCS_CLI, ["dbsheet", "list-records", JSON.stringify(params)], {
      windowsHide: true,
    });
    let out = "",
      err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error("kdocs-cli exit=" + code + " " + err.slice(0, 200)));
      const j = JSON.parse(out);
      if (j.code !== 0) return reject(new Error("kdocs err=" + j.code + " " + j.message));
      resolve(j.data.detail);
    });
  });
}

async function fetchKdocsNames() {
  const names = [];
  let offset = "";
  for (;;) {
    const detail = await callKdocs({
      file_id: KDOCS_FILE_ID,
      sheet_id: 1,
      page_size: 100,
      fields: ["游戏名称"],
      offset,
    });
    for (const rec of detail.records || []) {
      const v = rec.fields && rec.fields["游戏名称"];
      if (v != null && !isAuxRecord(v)) names.push(String(v).trim());
    }
    const next = detail.offset;
    if (!next || next === offset) break;
    offset = next;
  }
  return names;
}

// ── 匹配 ──
function buildIndex(names) {
  const zhIdx = new Map(),
    enIdx = new Map(); // key -> Set<记录原文>
  const zhList = [],
    enList = []; // {k, n}[]
  for (const n of names) {
    const c = splitCandidates(n);
    for (const z of c.zh) {
      if (!zhIdx.has(z)) zhIdx.set(z, new Set());
      zhIdx.get(z).add(n);
      zhList.push({ k: z, n });
    }
    for (const e of c.en) {
      if (!enIdx.has(e)) enIdx.set(e, new Set());
      enIdx.get(e).add(n);
      enList.push({ k: e, n });
    }
  }
  return { zhIdx, enIdx, zhList, enList, raw: names };
}

function matchBili(title, idx) {
  const clean = stripTitle(title);
  const z = normZh(clean),
    e = normEn(clean);
  const hit = new Set();
  if (z && idx.zhIdx.has(z)) idx.zhIdx.get(z).forEach((n) => hit.add(n));
  if (e && idx.enIdx.has(e)) idx.enIdx.get(e).forEach((n) => hit.add(n));
  // 中英桥接：中文名 → 英文名 → 匹配金山英文候选（如「正当防卫4」→ Just Cause 4）
  if (z && lookupEnglishName) {
    const enName = normEn(lookupEnglishName(clean) || "");
    if (enName && idx.enIdx.has(enName)) idx.enIdx.get(enName).forEach((n) => hit.add(n));
    if (enName && enName.length >= 6) {
      for (const it of idx.enList) {
        if (it.k.length >= 6 && (enName.includes(it.k) || it.k.includes(enName))) hit.add(it.n);
      }
    }
  }
  // 包含匹配兜底：金山候选是 B站 名（或反之）的子串且足够长，视为命中
  if (z && z.length >= 3) {
    for (const it of idx.zhList) {
      if (it.k.length >= 3 && (z.includes(it.k) || it.k.includes(z))) hit.add(it.n);
    }
  }
  if (e && e.length >= 5) {
    for (const it of idx.enList) {
      if (it.k.length >= 5 && (e.includes(it.k) || it.k.includes(e))) hit.add(it.n);
    }
  }
  return hit.size ? [...hit] : null;
}

// ── 生成 HTML ──
function renderHtml(notCollected, notPosted) {
  const rows = (list) =>
    list.map((x) => "<tr><td>" + esc(x.game) + "</td><td>" + esc(x.source) + "</td></tr>").join("");
  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    "<title>B站投稿 vs 金山文档 对账</title>" +
    "<style>body{font-family:system-ui;margin:24px;background:#f7f8fa;color:#222}" +
    "h1{font-size:20px}h2{margin-top:28px;font-size:16px;color:#0b57d0}" +
    "table{border-collapse:collapse;width:100%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.08)}" +
    "th,td{border:1px solid #e2e5ea;padding:8px 12px;text-align:left;font-size:13px;vertical-align:top}" +
    "th{background:#f0f2f5}.warn{color:#c5221f}.ok{color:#188038}.count{font-size:13px;color:#666}</style></head><body>" +
    "<h1>B站投稿 vs 金山文档 对账</h1>" +
    '<h2 class="warn">发了视频但金山文档没收集（' +
    notCollected.length +
    "）</h2>" +
    "<table><tr><th>游戏</th><th>B站标题</th></tr>" +
    rows(notCollected) +
    "</table>" +
    '<h2 class="ok">金山文档有资源但没发视频（' +
    notPosted.length +
    "）</h2>" +
    "<table><tr><th>游戏</th><th>金山记录</th></tr>" +
    rows(notPosted) +
    "</table>" +
    "</body></html>"
  );
}
function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// ── 主流程 ──
async function main() {
  const [titles, names] = await Promise.all([fetchBiliTitles(), fetchKdocsNames()]);
  if (process.argv.includes("--debug")) {
    console.log("--- B站样例 ---");
    titles.slice(0, 8).forEach((t) => console.log(JSON.stringify(stripTitle(t))));
    console.log("--- 金山样例 ---");
    names.slice(0, 8).forEach((n) => console.log(JSON.stringify(splitCandidates(n))));
  }
  const idx = buildIndex(names);
  const matched = new Set();
  const notCollected = [];
  for (const t of titles) {
    // 只对游戏投稿做对账：无【游戏NNN】前缀的（攻略/测试/流程视频）跳过
    if (!/^【游戏/.test(t)) continue;
    const hit = matchBili(t, idx);
    const game = stripTitle(t);
    if (hit) {
      hit.forEach((n) => matched.add(n));
      continue;
    }
    notCollected.push({ game, source: t });
  }
  const notPosted = names
    .filter((n) => !matched.has(n))
    .map((n) => {
      const c = splitCandidates(n);
      return { game: c.zh[0] || c.en[0] || n, source: n };
    });
  if (process.argv.includes("--miss")) {
    console.log("--- 未收集样例（B站） ---");
    notCollected.forEach((x) =>
      console.log(JSON.stringify(x.game), "<-", JSON.stringify(x.source)),
    );
    console.log("--- 未发布样例（金山） ---");
    notPosted.forEach((x) => console.log(JSON.stringify(x.game), "<-", JSON.stringify(x.source)));
  }
  if (process.argv.includes("--kdocs")) {
    console.log("--- 金山全量记录 ---");
    names.forEach((n, i) => console.log(i + 1 + ".", JSON.stringify(n)));
  }
  if (process.argv.includes("--dbg")) {
    const t = titles.find((x) => x.includes("巫师3"));
    const k = names.find((x) => x.includes("巫师3"));
    console.log("B站 title:", JSON.stringify(t));
    console.log("B站 clean:", JSON.stringify(stripTitle(t)));
    console.log("金山 raw:", JSON.stringify(k));
    console.log("金山 cand:", JSON.stringify(splitCandidates(k)));
    console.log("match=", JSON.stringify(matchBili(t, idx)));
  }
  fs.writeFileSync(OUT_HTML, renderHtml(notCollected, notPosted), "utf8");
  console.log("B站", titles.length, "条 / 金山", names.length, "条");
  console.log("发了没收集", notCollected.length, "条；有资源没发", notPosted.length, "条");
  console.log("输出:", OUT_HTML);
}

main().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
