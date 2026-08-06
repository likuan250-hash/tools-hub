// 渲染静态页（对账 / 资源 / 热门 Top50 三标签页）
// 数据源：games-reconcile.html 原有对账区 + docs/forum-resources.json + docs/hot-games.json
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "docs", "forum-resources.json");
const HOT = path.join(ROOT, "docs", "hot-games.json");
const OUT = path.join(ROOT, "docs", "games-reconcile.html");
const { normZh, lookupEnglishNameOffline } = require(
  path.join(ROOT, "kdocs-tool", "lib", "gamemap"),
);

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
  "内置汉化",
  "官方简中语音",
  "简中语音",
  "简体中文",
  "官方简体",
  "教程",
  "汉化",
  "扩展包",
  "季票",
  "XG器",
  "XG",
  "修改器",
  "存档",
  "MOD",
  "mod",
  "整合包",
  "整合",
  "联动",
  "镜像",
  "完整",
  "版本",
  "版",
  "DLC",
  "下载",
  "合集",
  "系列",
  "三部曲",
  "中文",
  "最新",
  "搬运",
  "附视频",
  "视频安装",
  "安装教程",
  "安装视频",
  "美化",
  "模组",
  "补丁",
  "解锁",
  "联机",
  "单机",
  "升级",
  "支持键盘",
  "鼠标",
  "手柄",
  "解压即玩",
  "数据",
  "云存档",
  "成就",
  "集换式",
  "国语配音",
  "决定版",
  "修改器",
  "升级补丁",
  "联机补丁",
  "修正补丁",
  "失地复苏",
  "集成",
];
const NUM_VERSION = /\bv\d+(?:\.\d+)+[a-z0-9]*\b/gi;
const BARE_VERSION = /\b\d+(?:\.\d+)+[a-z0-9]*\b/g;

function stripWords(s) {
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s.replace(/[+＋]/g, " ");
    for (const w of SUFFIX_WORDS) s = s.split(w).join(" ");
    s = s.replace(BARE_VERSION, " ");
    if (s === before) break;
  }
  return s;
}

function gameName(raw) {
  let s = String(raw || "");
  const m = /《([^》]+)》/.exec(s) || /《([^》]*)/.exec(s); // 无闭合《》的变体标题也取
  const b = [...s.matchAll(/【([^】]+)】/g)].map((x) => x[1]);
  if (m) s = m[1];
  else if (b.length) s = b.join(" ");
  s = s.replace(/[《》【】]/g, " ");
  // 括号内的英文名保留并追加（如「杀戮尖塔2（Slay the Spire 2）」），其余括号内容删除
  const enParts = [...s.matchAll(/[（(]([A-Za-z][A-Za-z0-9 .:'\-]*\s[A-Za-z0-9 .:'\-]+)[）)]/g)]
    .map((m) => m[1])
    .filter((p) => {
      const pn = normEn(p);
      const sn = normEn(s.replace(/[（(][^）)]*[）)]/g, ""));
      return (
        !pn ||
        !sn.includes(pn) ||
        ![...enTokens(p)].every((t) => enTokens(s.replace(/[（(][^）)]*[）)]/g, "")).has(t))
      );
    });
  s = s.replace(/[（(][^）)]*[）)]/g, " ");
  s += " " + enParts.join(" ");
  s = s.replace(NUM_VERSION, " ");
  s = stripWords(s);
  for (const w of [
    "最新",
    "整合包",
    "更新",
    "MOD",
    "mod",
    "Mod",
    "美化",
    "模组",
    "视频教程",
    "安装教程",
    "安装视频",
    "视频安装",
    "附视频",
    "附安装",
    "教程",
    "实用功能",
    "服装替换",
    "清凉",
    "工具盒",
    "盒子",
    "显血",
    "DPS",
    "视角扩大",
    "人物",
    "武器",
    "Npc",
    "NPC",
    "功能",
    "优化",
    "捏脸",
    "转性",
    "附",
    "包",
    "！",
    "!",
  ]) {
    s = s.split(w).join(" ");
  }
  s = s.replace(/[+＋]/g, " ").replace(/\s+/g, " ");
  s = s.replace(/\bv?\d+(?:\.\d+)+\b/gi, " ");
  s = s.replace(/\bv\d+\b/gi, " ");
  s = s.replace(/^[\s+＋.:：·]*|[\s+＋.:：·]*$/g, " ").replace(/\s{2,}/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

// B站热门视频标题 → 游戏名：优先命中已知游戏名库（资源帖游戏名 + gamemap 键）
function biliGameName(raw, knownNames) {
  let s = String(raw || "");
  // 1) 《》内原文（如《崩坏：星穹铁道》动画短片 → 崩坏：星穹铁道）
  const m = /《([^》]{2,30})》/.exec(s);
  if (m && knownNames.has(normZh(m[1]))) return m[1];
  // 2) 已知游戏名包含匹配（最长的那个）
  const nz = normZh(s);
  let best = "";
  for (const k of knownNames) {
    if (k.length >= 3 && nz.includes(k)) {
      if (k.length > normZh(best).length) best = k;
    }
  }
  if (best) return best;
  // 3) 兜底：清洗模板词
  for (const w of [
    "动画短片",
    "动画短篇",
    "PV",
    "EP",
    "MV",
    "CM",
    "预告",
    "宣传片",
    "特别篇",
    "先行",
    "即将上映",
    "上线",
    "主题曲",
    "角色",
    "印象曲",
    "序章",
    "终章",
    "版本",
    "动画",
    "短片",
    "剧情",
    "演示",
    "实机",
    "预告片",
    "公开",
    "发布",
    "展示",
    "视频",
    "丨",
    "|",
    "：",
    ":",
    "「",
    "」",
    "『",
    "』",
    "“",
    "”",
    "《",
    "》",
  ]) {
    s = s.split(w).join(" ");
  }
  s = s.replace(NUM_VERSION, " ").replace(/\s+/g, " ").trim();
  return s.slice(0, 30);
}

function normEn(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function enTokens(s) {
  return new Set(
    (
      String(s || "")
        .toLowerCase()
        .match(/[a-z0-9]+/g) || []
    ).filter((t) => t.length >= 3),
  );
}

function wordContains(long, short) {
  if (!short || short.length < 8 || !long) return false;
  const idx = long.indexOf(short);
  if (idx === -1) return false;
  const before = idx > 0 ? long[idx - 1] : "";
  const after = idx + short.length < long.length ? long[idx + short.length] : "";
  return !/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after);
}

// 英文版本词尾缀（normEn 后形态）：资源名是 hotName 的扩展时，剩余部分仅允许版本词
const EN_VERSION_TAIL_RE =
  /^(remastered|deluxe|complete|goty|ultimate|gold|directors?cut|hd|collection|learningedition|standard|digitaldeluxe|enhanced|definitive|anniversary|remake|rebirth|reloaded|upgrade)$/;

function enSameGameExt(e, ge) {
  if (ge.length > e.length && ge.includes(e)) {
    const rest = ge.replace(e, "");
    return /^\d+$/.test(rest) || EN_VERSION_TAIL_RE.test(rest);
  }
  return true;
}

// 版本词尾缀（normZh 后形态）：较长名去掉较短名后若只剩这些词，视为同一游戏
const VERSION_TAIL_RE =
  /^(重制版|豪华版|完全版|年度版|终极版|黄金版|导演剪辑版|高清版|学习版|合集|完整版|典藏版|数字豪华版|中文版|加强版|增强版|决定版|超级版|大师版|究极版|高清重制版|remastered|deluxe|complete|goty|ultimate|gold|directors?cut|hd|collection|learningedition|standard|digitaldeluxe)*$/;

// gz 包含 z 时，判断剩余部分是否仅为版本词（避免「我的世界→我的世界：传奇」这类不同游戏误配）
function isSameGameExt(z, gz) {
  const rest = gz.replace(z, "");
  if (/[\u4e00-\u9fff]/.test(rest)) return VERSION_TAIL_RE.test(rest);
  // 剩余部分为英文名/纯数字时，版本数字必须与 z 一致（防「使命召唤→使命召唤5」类泛前缀误配）
  const zNums = z.match(/\d+/g) || [];
  const rNums = rest.match(/\d+/g) || [];
  return rNums.every((n) => zNums.includes(n));
}

// 版本数字一致性：双方都带版本号但无交集 → 视为不同代游戏（防 Spider-Man 2 ↔ 1 代、FC 27 ↔ FC 等）
function versionNums(s) {
  const n = new Set();
  const t = String(s || "").trim();
  // 只取末尾词中的版本号，避免把「Left 4 Dead」中间的 4 等误当版本
  const tail = t.split(/[\s/]+/).pop() || "";
  for (const m of tail.matchAll(/\d+/g)) n.add(m[0]);
  for (const m of tail.matchAll(/[一二三四五六七八九十]+/g)) n.add(m[0]);
  if (/^(?:X{1,3}|IX|IV|V?I{1,3})$/i.test(tail)) n.add(tail.toLowerCase());
  return n;
}

function numConflict(a, b) {
  const na = versionNums(a);
  const nb = versionNums(b);
  if (!na.size || !nb.size) return na.size > 0 || nb.size > 0;
  for (const x of na) if (nb.has(x)) return false;
  return true;
}

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

// 资源按游戏名（归一化）分组：game -> [{title,url,site}]
function groupResources(authors) {
  const groups = new Map();
  for (const a of authors) {
    for (const it of a.items) {
      const n = gameName(it.title);
      const key = normZh(n) || normEn(n);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { name: n, items: [] });
      groups.get(key).items.push({ title: it.title, url: it.url, site: a.site, author: a.author });
    }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

// 热门游戏名 → 资源（中英双通道 + gamemap 桥接 + 英文词级匹配）
function matchHot(hotName, groups) {
  hotName = String(hotName || "").replace(/[®™]/g, "");
  const z = normZh(hotName);
  const e = normEn(hotName);
  const zhEn = normEn(lookupEnglishNameOffline(hotName) || "");
  const hits = [];
  for (const g of groups) {
    const gz = normZh(g.name);
    const ge = normEn(g.name);
    const gEn = normEn(lookupEnglishNameOffline(g.name) || "");
    let ok = false;
    if (gz && z) {
      if (gz === z) ok = true;
      else if (z.length >= 4 && gz.includes(z) && isSameGameExt(z, gz)) ok = true;
      else if (gz.length >= 4 && z.includes(gz) && isSameGameExt(gz, z)) ok = true;
    }
    if (
      !ok &&
      e &&
      ge &&
      e.length >= 5 &&
      !numConflict(hotName, g.name) &&
      enSameGameExt(e, ge) &&
      (ge === e || (ge.includes(e) && e.length >= 8) || (e.includes(ge) && ge.length >= 8))
    )
      ok = true;
    if (!ok && zhEn && gEn && (zhEn === gEn || wordContains(gEn, zhEn) || wordContains(zhEn, gEn)))
      ok = true;
    // 反向桥接：hotName 为英文、资源为中文时，用资源中文名→英文名比对
    if (
      !ok &&
      e &&
      gEn &&
      e.length >= 5 &&
      !numConflict(hotName, g.name) &&
      (e === gEn || wordContains(e, gEn) || wordContains(gEn, e))
    )
      ok = true;
    if (!ok && e && ge && e.length >= 5 && ge.length >= 5) {
      const a = enTokens(hotName);
      const b = enTokens(g.name);
      let shared = 0;
      a.forEach((t) => {
        if (b.has(t)) shared++;
      });
      if (shared >= 2 && shared >= a.size && shared >= b.size && !numConflict(hotName, g.name))
        ok = true;
    }
    if (ok) hits.push(g);
  }
  return hits;
}

function renderResourceRows(groups) {
  return groups
    .map((g) => {
      const links = g.items
        .map(
          (it) =>
            '<a href="' +
            esc(it.url) +
            '" target="_blank" rel="noopener">[' +
            esc(it.site) +
            "] " +
            esc(it.title) +
            "</a>",
        )
        .join("<br>");
      return "<tr><td>" + esc(g.name) + "</td><td>" + links + "</td></tr>";
    })
    .join("");
}

// 网游/手游黑名单：资源帖本身均为 PC 单机学习版，命中资源即视为 PC 单机，仅排除明显联机向作品
const ONLINE_BLACKLIST = [
  "王者荣耀",
  "和平精英",
  "原神",
  "崩坏",
  "星穹铁道",
  "绝区零",
  "三角洲行动",
  "暗区突围",
  "永劫无间",
  "英雄联盟",
  "穿越火线",
  "CS2",
  "Counter-Strike",
  "PUBG",
  "Apex",
  "守望先锋",
  "无畏契约",
  "VALORANT",
  "War Thunder",
  "World of Warships",
  "战舰世界",
  "坦克世界",
  "蛋仔派对",
  "雀魂",
  "漫威争锋",
  "第五人格",
  "逆水寒",
  "天涯明月刀",
  "剑网3",
  "剑灵",
  "Dota 2",
  "永劫",
];

function isOnlineGame(name) {
  const s = name ? String(name).toLowerCase() : "";
  return ONLINE_BLACKLIST.some((w) => s.includes(w.toLowerCase()));
}

// 热门榜只保留「有资源帖 ∧ PC 单机」的条目
function hotWithResource(list, groups) {
  return list
    .map((h) => ({ ...h, hits: matchHot(h.name, groups) }))
    .filter((h) => h.hits.length > 0 && !isOnlineGame(h.name));
}

function renderHotTable(list, groups) {
  return hotWithResource(list, groups)
    .slice(0, 50)
    .map((h, i) => {
      const hits = h.hits;
      const links = hits.length
        ? hits
            .map((g) =>
              g.items
                .map(
                  (it) =>
                    '<a href="' +
                    esc(it.url) +
                    '" target="_blank" rel="noopener">[' +
                    esc(it.site) +
                    "] " +
                    esc(g.name) +
                    "</a>",
                )
                .join(" "),
            )
            .join(" ")
        : "";
      return (
        "<tr><td>" +
        (i + 1) +
        "</td><td>" +
        esc(String(h.name).replace(/[®™]/g, "")) +
        "</td><td>" +
        links +
        "</td></tr>"
      );
    })
    .join("");
}

function main() {
  const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
  const hot = JSON.parse(fs.readFileSync(HOT, "utf8"));
  const oldHtml = fs.readFileSync(OUT, "utf8");
  // 对账区 = 原页面里「发了没收集」「有资源没发」两个表（h2 到 </table>）
  const tables = [...oldHtml.matchAll(/<h2[^>]*>[\s\S]*?<\/table>/g)];
  const reconBody =
    tables.length >= 2
      ? "<h1>B站投稿 vs 金山文档 对账</h1>" +
        tables
          .slice(0, 2)
          .map((m) => m[0])
          .join("")
      : oldHtml.slice(oldHtml.indexOf("<h1>"), oldHtml.indexOf("</body>"));

  const groups = groupResources(data.authors);
  // 已知游戏名库：资源帖游戏名（zh+en 归一化）+ gamemap 中文键
  const known = new Set();
  for (const g of groups) {
    const gz = normZh(g.name);
    known.add(gz);
    const zhCore = gz.replace(/[a-z0-9]+/g, "");
    if (zhCore.length >= 2) known.add(zhCore);
    const en = normEn(g.name);
    if (en.length >= 4) known.add(en);
    const enName = lookupEnglishNameOffline(g.name);
    if (enName && normEn(enName).length >= 4) known.add(normEn(enName));
  }
  try {
    const gm = require(path.join(ROOT, "kdocs-tool", "lib", "game-name-map.json"));
    for (const k of Object.keys(gm)) if (normZh(k).length >= 2) known.add(normZh(k));
    for (const v of Object.values(gm)) if (normEn(v).length >= 4) known.add(normEn(v));
  } catch (e) {
    /* 映射缺失时仅靠资源帖 */
  }
  const biliGames = hot.bili.map((x) => ({ ...x, name: biliGameName(x.title, known) || x.name }));

  const tabCss =
    "<style>.tabs{display:flex;gap:4px;margin:16px 0}.tab{padding:6px 16px;border:1px solid #d0d5dd;border-radius:6px 6px 0 0;cursor:pointer;background:#eef1f5;font-size:14px}.tab.active{background:#0b57d0;color:#fff;border-color:#0b57d0}.pane{display:none}.pane.active{display:block}.muted{color:#999}.badge{display:inline-block;font-size:11px;padding:1px 6px;border-radius:8px;margin-right:4px}.badge-steam{background:#1b2838;color:#fff}.badge-bili{background:#fb7299;color:#fff}</style>" +
    '<script>function showTab(n){document.querySelectorAll(".tab").forEach((t,i)=>t.classList.toggle("active",i===n));document.querySelectorAll(".pane").forEach((p,i)=>p.classList.toggle("active",i===n));}</script>';

  const html =
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>B站投稿 / 资源 / 热门对账</title>' +
    "<style>body{font-family:system-ui;margin:24px;background:#f7f8fa;color:#222}h1{font-size:20px}h2{margin-top:28px;font-size:16px;color:#0b57d0}" +
    "table{border-collapse:collapse;width:100%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:20px}" +
    "th,td{border:1px solid #e2e5ea;padding:8px 12px;text-align:left;font-size:13px;vertical-align:top}th{background:#f0f2f5}.warn{color:#c5221f}.ok{color:#188038}.count{font-size:13px;color:#666}" +
    ".tabs{display:flex;gap:4px;margin:16px 0}.tab{padding:6px 16px;border:1px solid #d0d5dd;border-radius:6px 6px 0 0;cursor:pointer;background:#eef1f5;font-size:14px}.tab.active{background:#0b57d0;color:#fff;border-color:#0b57d0}.pane{display:none}.pane.active{display:block}.muted{color:#999}" +
    "a{color:#0b57d0;text-decoration:none}a:hover{text-decoration:underline}</style></head><body>" +
    "<h1>B站投稿 / 论坛资源 / 热门对账</h1>" +
    '<div class="tabs"><div class="tab active" onclick="showTab(0)">对账</div><div class="tab" onclick="showTab(1)">资源</div><div class="tab" onclick="showTab(2)">热门 Top50</div></div>' +
    '<div class="pane active">' +
    reconBody +
    "</div>" +
    '<div class="pane"><h2>论坛资源区（' +
    groups.length +
    " 款游戏，" +
    data.authors.reduce((s, a) => s + a.items.length, 0) +
    " 帖）</h2>" +
    '<p class="count">抓取时间：' +
    esc(data.generatedAt) +
    "；同名游戏合并为一行，多个链接分别为两站帖子</p>" +
    "<table><tr><th>游戏</th><th>帖子（" +
    data.authors.map((a) => esc(a.site) + " " + a.items.length + " 帖").join(" / ") +
    "）</th></tr>" +
    renderResourceRows(groups) +
    "</table></div>" +
    '<div class="pane"><h2>Steam 热销 Top50（已有资源帖）</h2>' +
    '<p class="count">口径：Steam 热销榜前 200 ∩ 论坛已有资源帖（共 ' +
    hotWithResource(hot.steam, groups).length +
    " 款），按 Steam 排名取前 50</p>" +
    "<table><tr><th>#</th><th>游戏</th><th>对应资源</th></tr>" +
    renderHotTable(hot.steam, groups) +
    "</table>" +
    '<h2>B站游戏区热门 Top50（已有资源帖）</h2><p class="count">口径：B站游戏区排行 ∩ 已有资源帖（共 ' +
    hotWithResource(biliGames, groups).length +
    " 款），按播放量取前 50（" +
    esc(hot.generatedAt) +
    "）</p>" +
    "<table><tr><th>#</th><th>视频/游戏</th><th>播放</th><th>对应资源</th></tr>" +
    hotWithResource(biliGames, groups)
      .sort((a, b) => b.play - a.play)
      .slice(0, 50)
      .map((h, i) => {
        const hits = h.hits;
        const links = hits.length
          ? hits
              .map((g) =>
                g.items
                  .map(
                    (it) =>
                      '<a href="' +
                      esc(it.url) +
                      '" target="_blank" rel="noopener">[' +
                      esc(it.site) +
                      "] " +
                      esc(g.name) +
                      "</a>",
                  )
                  .join(" "),
              )
              .join(" ")
          : "";
        return (
          "<tr><td>" +
          (i + 1) +
          "</td><td>" +
          esc(h.title) +
          "</td><td>" +
          h.play.toLocaleString() +
          "</td><td>" +
          links +
          "</td></tr>"
        );
      })
      .join("") +
    "</table></div>" +
    '<script>function showTab(n){document.querySelectorAll(".tab").forEach((t,i)=>t.classList.toggle("active",i===n));document.querySelectorAll(".pane").forEach((p,i)=>p.classList.toggle("active",i===n));}</script>' +
    "</body></html>";
  fs.writeFileSync(OUT, html, "utf8");
  console.log(
    "游戏数:",
    groups.length,
    "; Steam热门:",
    hot.steam.length,
    "; B站热门:",
    biliGames.length,
    "; 写入:",
    OUT,
  );
  const sample = groups.filter((g) => g.items.length > 1).slice(0, 3);
  sample.forEach((g) => console.log("合并样例:", g.name, g.items.map((i) => i.site).join("+")));
}

main();
