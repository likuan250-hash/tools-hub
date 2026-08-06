// 从 docs/forum-resources.json 渲染论坛资源区，并入 games-reconcile.html
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "docs", "forum-resources.json");
const OUT = path.join(ROOT, "docs", "games-reconcile.html");

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
  "整合",
  "联动",
  "模拟器",
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
];
const NUM_VERSION = /\bv\d+(?:\.\d+)+\b/gi;
const BARE_VERSION = /\b\d+(?:\.\d+)+\b/g;

function stripWords(s) {
  for (let i = 0; i < 5; i++) {
    const before = s;
    for (const w of SUFFIX_WORDS) s = s.split(w).join(" ");
    s = s.replace(BARE_VERSION, " ");
    if (s === before) break;
  }
  return s;
}

function gameName(raw) {
  let s = String(raw || "");
  // 取 《》 内核心名（去掉英文括号说明）
  const m = /《([^》]+)》/.exec(s);
  if (m) s = m[1];
  s = s.replace(/[（(]\s*[A-Za-z0-9][^）)]*[）)]/g, " "); // 去英文注释
  s = s.replace(NUM_VERSION, " ");
  s = stripWords(s);
  return s.replace(/\s+/g, " ").trim();
}

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

function renderSection(author) {
  const rows = author.items
    .map(
      (it) =>
        "<tr><td>" +
        esc(gameName(it.title)) +
        '</td><td><a href="' +
        esc(it.url) +
        '" target="_blank" rel="noopener">' +
        esc(it.title) +
        "</a></td></tr>",
    )
    .join("");
  return (
    "<h2>" +
    esc(author.author) +
    "（" +
    esc(author.site) +
    "，" +
    author.items.length +
    " 帖）</h2>" +
    "<table><tr><th>游戏</th><th>帖子标题 / 链接</th></tr>" +
    rows +
    "</table>"
  );
}

function main() {
  const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
  const html = fs.readFileSync(OUT, "utf8");
  const resourceHtml =
    '<h1 style="margin-top:40px">论坛资源区</h1>' +
    '<p class="count">数据抓取时间：' +
    esc(data.generatedAt) +
    "</p>" +
    data.authors.map(renderSection).join("");
  // 幂等：先移除旧的资源区再写入
  const cleaned = html.replace(
    /<h1 style="margin-top:40px">论坛资源区<\/h1>[\s\S]*?<\/body><\/html>/,
    "</body></html>",
  );
  const final = cleaned.replace("</body></html>", resourceHtml + "</body></html>");
  fs.writeFileSync(OUT, final, "utf8");
  console.log("资源区写入", data.authors.map((a) => a.site + " " + a.items.length).join(" / "));
}

main();
