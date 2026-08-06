// 生成热门 Top50 数据：Steam 官方热销榜（open_page 抓取结果手工整理）+ B站游戏区热门榜前 50
// 输出：docs/hot-games.json { steam: [{name}], bili: [{title, name, play}] }
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "docs", "hot-games.json");

// Steam 官方热销榜前 50（2026-08-06 从 store.steampowered.com/search/?filter=topsellers 抓取）
const STEAM_TOP50 = [
  "Apex Legends",
  "Counter-Strike 2",
  "Yu-Gi-Oh! Master Duel",
  "PUBG: BATTLEGROUNDS",
  "机械狂欢",
  "博德之门3",
  "赛博朋克 2077",
  "Marvel's Spider-Man 2",
  "午夜轮班",
  "Escape from Tarkov",
  "三角洲行动",
  "Dota 2",
  "大巴扎 The Bazaar",
  "The Bazaar - 双龙",
  "Warframe 星际战甲",
  "超级机器人大战Y",
  "极限竞速：地平线 6",
  "赛博朋克 2077：往日之影",
  "Wallpaper Engine：壁纸引擎",
  "Big Walk",
  "双影奇境",
  "Ready or Not",
  "超级机器人大战Y - 周年纪念扩充组合包",
  "雾影猎人",
  "It Takes Two Friend's Pass",
  "双人成行",
  "PEAK",
  "龙之剑:觉醒",
  "Street Fighter 6",
  "永劫无间",
  "赛菲莉娅",
  "使命召唤®：现代战争® 4",
  "Escape the Backrooms",
  "Stardew Valley",
  "战地风云™ 6",
  "Marvel's Spider-Man: Miles Morales",
  "猎杀：对决 1896",
  "刺客信条：黑旗 记忆重置",
  "歧路旅人 II",
  "World of Warships",
  "Grand Theft Auto V 增强版",
  "纵横秘湾 Corsair Cove",
  "人类一败涂地 / Human Fall Flat",
  "MECCHA CHAMELEON",
  "Overcooked! 2",
  "黎明杀机",
  "Slay the Spire 2",
  "Palworld / 幻兽帕鲁",
  "逸剑风云决",
  "竞拍之王",
];

async function fetchBiliTop() {
  // B站游戏区热门榜（rid=4 游戏分区），无需登录
  const r = await fetch("https://api.bilibili.com/x/web-interface/ranking/v2?rid=4&type=all", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://www.bilibili.com/",
    },
  });
  const j = await r.json();
  const list = (j.data && j.data.list) || [];
  return list.slice(0, 50).map((x) => ({
    title: x.title || "",
    name: (x.title || "")
      .replace(/^《|》/g, "")
      .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, " ")
      .trim(),
    play: Number(x.stat && x.stat.view) || 0,
  }));
}

async function main() {
  const bili = await fetchBiliTop();
  const data = {
    generatedAt: new Date().toISOString(),
    steam: STEAM_TOP50.map((name) => ({ name })),
    bili,
  };
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2), "utf8");
  console.log("Steam:", data.steam.length, "条; B站:", data.bili.length, "条");
  console.log(
    "B站 top5:",
    data.bili
      .slice(0, 5)
      .map((x) => x.name + " (" + x.play + ")")
      .join(" | "),
  );
  console.log("输出:", OUT);
}

main().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
