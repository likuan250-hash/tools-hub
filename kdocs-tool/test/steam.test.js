// steam.test.js — Steam 官方描述解析单元测试（纯函数，无需网络）
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseSteamAppDetails, parseSteamSizeFromRequirements, parseSteamAppIdFromText, extractEnglishNameFromWikidata, extractEnglishNameFromBaidu, resolveEnglishName, cleanGameName, stripSubtitle, tryDownload, isImageMagic,
  extractEnglishNameFromWikiSnippet, extractEnglishNameFromWikiInfobox, fetchEnglishNameFromWikipedia, fetchEnglishNameFromBangumi, isLatinName, cnNameSimilarity,
  detectEditionSuffix, augmentWithEdition } = require("../lib/steam");
const { lookupEnglishNameOffline, normZh } = require("../lib/gamemap");

test("parseSteamAppDetails 提取官方 short_description / genres / type", () => {
  const data = {
    type: "game",
    short_description: "  Hazelight 出品的双人合作冒险游戏。  ",
    genres: [{ description: "动作" }, { description: "冒险" }],
  };
  const r = parseSteamAppDetails(data);
  assert.strictEqual(r.shortDescription, "Hazelight 出品的双人合作冒险游戏。");
  assert.deepStrictEqual(r.genres, ["动作", "冒险"]);
  assert.strictEqual(r.type, "game");
});

test("parseSteamAppDetails 无 short_description 返回空串", () => {
  const r = parseSteamAppDetails({ type: "game" });
  assert.strictEqual(r.shortDescription, "");
  assert.deepStrictEqual(r.genres, []);
});

test("parseSteamAppDetails 入参为空返回 null", () => {
  assert.strictEqual(parseSteamAppDetails(null), null);
  assert.strictEqual(parseSteamAppDetails(undefined), null);
});

test("parseSteamAppDetails 同时解析 pc_requirements 中的大小", () => {
  const data = {
    type: "game",
    short_description: "测试游戏",
    pc_requirements: { recommended: "Storage: 50 GB available space" },
  };
  const r = parseSteamAppDetails(data);
  assert.strictEqual(r.shortDescription, "测试游戏");
  assert.strictEqual(r.size, "50GB");
});

test("parseSteamAppIdFromText 从 store/community/steamdb 链接抽 AppID", () => {
  assert.strictEqual(parseSteamAppIdFromText("https://store.steampowered.com/app/123456/agecheck"), "123456");
  assert.strictEqual(parseSteamAppIdFromText("见 steamcommunity.com/app/789 页面"), "789");
  assert.strictEqual(parseSteamAppIdFromText("https://steamdb.info/app/555/details"), "555");
  assert.strictEqual(parseSteamAppIdFromText("没有任何链接"), "");
});

test("parseSteamSizeFromRequirements 优先 recommended（中文 存储空间）", () => {
  const pc = {
    recommended: "<strong>存储空间：</strong> 40 GB 可用空间",
    minimum: "<strong>Storage:</strong> 30 GB",
  };
  assert.strictEqual(parseSteamSizeFromRequirements(pc), "40GB");
});

test("parseSteamSizeFromRequirements 仅 minimum（英文 Storage）", () => {
  const pc = { minimum: "Storage: 8 GB available space" };
  assert.strictEqual(parseSteamSizeFromRequirements(pc), "8GB");
});

test("parseSteamSizeFromRequirements 支持 MB / TB 单位", () => {
  assert.strictEqual(parseSteamSizeFromRequirements({ minimum: "Storage: 512 MB" }), "512MB");
  assert.strictEqual(parseSteamSizeFromRequirements({ minimum: "硬盘：2 TB" }), "2TB");
});

test("parseSteamSizeFromRequirements 无 requirements 返回空", () => {
  assert.strictEqual(parseSteamSizeFromRequirements(null), "");
  assert.strictEqual(parseSteamSizeFromRequirements({}), "");
  assert.strictEqual(parseSteamSizeFromRequirements({ minimum: "无大小信息" }), "");
});

test("parseSteamSizeFromRequirements 标签穿插也能命中（Storage:</strong> 40 GB）", () => {
  const pc = { minimum: "<strong>Storage:</strong> 40 GB available space" };
  assert.strictEqual(parseSteamSizeFromRequirements(pc), "40GB");
});

// ── 英文名前置解析（中文名 → 英文名）──
test("extractEnglishNameFromWikidata 从 search+entities 抽首个 en label", () => {
  const search = { search: [{ id: "Q1" }, { id: "Q2" }] };
  const entities = { entities: { Q1: { labels: { en: { value: "Elden Ring" } } }, Q2: { labels: { en: { value: "Other" } } } } };
  assert.strictEqual(extractEnglishNameFromWikidata(search, entities), "Elden Ring");
});

test("extractEnglishNameFromWikidata 候选无 en label 返回空", () => {
  const search = { search: [{ id: "Q1" }] };
  const entities = { entities: { Q1: { labels: { zh: { value: "艾尔登法环" } } } } };
  assert.strictEqual(extractEnglishNameFromWikidata(search, entities), "");
});

test("extractEnglishNameFromBaidu 从 infobox 抽英文名", () => {
  const html = "<th>英文名</th><td>Elden Ring</td>";
  assert.strictEqual(extractEnglishNameFromBaidu(html), "Elden Ring");
});

test("extractEnglishNameFromBaidu 无英文名返回空", () => {
  assert.strictEqual(extractEnglishNameFromBaidu(""), "");
  assert.strictEqual(extractEnglishNameFromBaidu("<th>发行日期</th><td>2022</td>"), "");
});

test("resolveEnglishName 空输入直接返回空（不发起请求）", async () => {
  assert.strictEqual(await resolveEnglishName(""), "");
  assert.strictEqual(await resolveEnglishName(null), "");
});

// ── cleanGameName / stripSubtitle（英文名清洗规则）──
test("cleanGameName 用户例子：剥 v 版本 + 尾部标签列表，保留重制版副标题", () => {
  assert.strictEqual(
    cleanGameName("最后的生还者2：重制版 v1.6.10721.0105 官方中文+预购特典+单独升级档"),
    "最后的生还者2：重制版"
  );
});

test("cleanGameName 无副标题时只剩核心名", () => {
  assert.strictEqual(cleanGameName("艾尔登法环 v1.10 官方中文"), "艾尔登法环");
  assert.strictEqual(cleanGameName("只狼 v1.6 官方中文+预购特典"), "只狼");
});

test("cleanGameName 复合标签一次性剥除", () => {
  assert.strictEqual(cleanGameName("赛博朋克 2077 整合版"), "赛博朋克 2077");
  assert.strictEqual(cleanGameName("黑神话：悟空 v1.0 整合版 DLC"), "黑神话：悟空");
});

test("cleanGameName 纯英文原名无噪音原样返回", () => {
  assert.strictEqual(cleanGameName("Split Fiction"), "Split Fiction");
  assert.strictEqual(cleanGameName("Elden Ring"), "Elden Ring");
});

test("cleanGameName 边界输入安全", () => {
  assert.strictEqual(cleanGameName(""), "");
  assert.strictEqual(cleanGameName(null), "");
  assert.strictEqual(cleanGameName(undefined), "");
  assert.strictEqual(cleanGameName(123), "");
  assert.strictEqual(cleanGameName("   "), "");
  assert.strictEqual(cleanGameName("v1.2.3 整合版"), "");
});

test("cleanGameName 资料片副标题保留（不在 NOISE_TAGS）", () => {
  assert.strictEqual(cleanGameName("赛博朋克 2077：幻影自由 v2.1"), "赛博朋克 2077：幻影自由");
});

test("stripSubtitle 剥掉冒号后的副标题", () => {
  assert.strictEqual(stripSubtitle("最后的生还者2：重制版"), "最后的生还者2");
  assert.strictEqual(stripSubtitle("艾尔登法环：黄金树之影"), "艾尔登法环");
});

test("stripSubtitle 无副标题原样返回", () => {
  assert.strictEqual(stripSubtitle("艾尔登法环"), "艾尔登法环");
  assert.strictEqual(stripSubtitle(""), "");
  assert.strictEqual(stripSubtitle(null), "");
});

// ── resolveEnglishName 多源管道（Wikidata → Wikipedia → 百度）+ 版本词增强 ──
// URL 感知 mock：按请求 URL 区分 Wikidata / Wikipedia 搜索 / Wikipedia infobox / 百度，便于离线断言。
function urlAwareDeps(opts) {
  const calls = { wikidataSearch: 0, wikidataEntities: 0, wikiSearch: 0, wikiInfobox: 0, baidu: 0, bangumi: 0 };
  const httpGetJson = async (url) => {
    if (url.includes("api.bgm.tv")) { calls.bangumi++; return opts.bangumi ? opts.bangumi(url) : { list: [] }; }
    if (url.includes("wikidata.org") && url.includes("wbsearchentities")) { calls.wikidataSearch++; return opts.wikidataSearch ? opts.wikidataSearch(url) : { search: [] }; }
    if (url.includes("wikidata.org") && url.includes("wbgetentities")) { calls.wikidataEntities++; return opts.wikidataEntities ? opts.wikidataEntities(url) : {}; }
    if (url.includes("wikipedia.org") && url.includes("list=search")) { calls.wikiSearch++; return opts.wikiSearch ? opts.wikiSearch(url) : { query: { search: [] } }; }
    if (url.includes("wikipedia.org") && url.includes("prop=revisions")) { calls.wikiInfobox++; return opts.wikiInfobox ? opts.wikiInfobox(url) : { query: { pages: {} } }; }
    return {};
  };
  const httpGetText = async (url) => { calls.baidu++; return opts.baidu ? opts.baidu(url) : ""; };
  return { httpGetJson, httpGetText, calls, disableOffline: !!opts.disableOffline };
}

test("extractEnglishNameFromWikiSnippet 解析 英語：/原名：", () => {
  assert.strictEqual(extractEnglishNameFromWikiSnippet("《最後生還者 第II章》（英語：The Last of Us Part II）"), "The Last of Us Part II");
  assert.strictEqual(extractEnglishNameFromWikiSnippet("原名：Black Myth: Wukong"), "Black Myth: Wukong");
  assert.strictEqual(extractEnglishNameFromWikiSnippet("无英文名摘要"), "");
});

test("extractEnglishNameFromWikiInfobox 解析 | english = / | 原名 =", () => {
  assert.strictEqual(extractEnglishNameFromWikiInfobox("{{Infobox\n| english = The Last of Us Part II\n| released = 2020\n}}"), "The Last of Us Part II");
  assert.strictEqual(extractEnglishNameFromWikiInfobox("| 原名 = Elden Ring"), "Elden Ring");
  assert.strictEqual(extractEnglishNameFromWikiInfobox("| title = 最後生還者"), "");
});

test("fetchEnglishNameFromWikipedia 走 snippet 快路径", async () => {
  const httpJson = async () => ({ query: { search: [{ snippet: "（英語：Hollow Knight）" }] } });
  assert.strictEqual(await fetchEnglishNameFromWikipedia("空洞骑士", httpJson), "Hollow Knight");
});

test("fetchEnglishNameFromWikipedia 无结果返回空", async () => {
  const httpJson = async () => ({ query: { search: [] } });
  assert.strictEqual(await fetchEnglishNameFromWikipedia("某某", httpJson), "");
});

test("detectEditionSuffix / augmentWithEdition 版本词映射", () => {
  assert.strictEqual(detectEditionSuffix("最后的生还者2：重制版"), "Remastered");
  assert.strictEqual(detectEditionSuffix("生化危机2 复刻版"), "Remake");
  assert.strictEqual(detectEditionSuffix("巫师3 年度版"), "Game of the Year");
  assert.strictEqual(detectEditionSuffix("无版本词"), "");
  assert.strictEqual(augmentWithEdition("The Last of Us Part II", "最后的生还者2：重制版"), "The Last of Us Part II Remastered");
  assert.strictEqual(augmentWithEdition("The Last of Us Part II Remastered", "最后的生还者2：重制版"), "The Last of Us Part II Remastered", "已含版本词不重复");
  assert.strictEqual(augmentWithEdition("The Last of Us Part II", "无版本词"), "The Last of Us Part II");
});

test("resolveEnglishName Wikidata 命中直接返回（不触发 Wikipedia/百度）", async () => {
  const deps = urlAwareDeps({
    disableOffline: true,
    wikidataSearch: () => ({ search: [{ id: "Q1" }] }),
    wikidataEntities: () => ({ entities: { Q1: { labels: { en: { value: "The Last of Us Part II Remastered" } } } } }),
  });
  const en = await resolveEnglishName(
    "最后的生还者2：重制版 v1.6.10721.0105 官方中文+预购特典+单独升级档",
    deps
  );
  assert.strictEqual(en, "The Last of Us Part II Remastered");
  assert.strictEqual(deps.calls.wikidataSearch, 1);
  assert.strictEqual(deps.calls.wikidataEntities, 1);
  assert.strictEqual(deps.calls.wikiSearch, 0, "Wikidata 命中后不应再搜 Wikipedia");
  assert.strictEqual(deps.calls.baidu, 0, "不应再查百度");
});

test("resolveEnglishName Wikidata 失败 → Wikipedia infobox 命中（含版本词增强）", async () => {
  const deps = urlAwareDeps({
    disableOffline: true,
    wikiSearch: () => ({ query: { search: [{ ns: 0, title: "最后生还者 第II章", snippet: "《最後生還者 第II章》（英語：The Last of Us Part II）" }] } }),
    wikiInfobox: () => ({ query: { pages: { "1": { title: "最后生还者 第II章", revisions: [{ slots: { main: { "*": "| english = The Last of Us Part II\n" } } }] } } } }),
  });
  const en = await resolveEnglishName(
    "最后的生还者2：重制版 v1.6.10721.0105 官方中文+预购特典+单独升级档",
    deps
  );
  // 基础名 The Last of Us Part II + 输入含「重制版」→ 拼成精确名
  assert.strictEqual(en, "The Last of Us Part II Remastered");
  assert.strictEqual(deps.calls.baidu, 0, "Wikipedia 命中后不应再查百度");
});

test("resolveEnglishName Wikipedia 多结果按匹配度择优（跳过系列通用名/干扰项）", async () => {
  const deps = urlAwareDeps({
    disableOffline: true,
    wikiSearch: () => ({ query: { search: [
      { ns: 0, title: "最後生還者", snippet: "系列页" },
      { ns: 0, title: "最后生还者 第II章", snippet: "（英語：The Last of Us Part II）" },
      { ns: 0, title: "生化危机2 重制版", snippet: "（英語：Resident Evil 2 Remake）" },
    ] } }),
    wikiInfobox: (url) => {
      if (url.includes("第II章")) return { query: { pages: { "1": { title: "最后生还者 第II章", revisions: [{ slots: { main: { "*": "| english = The Last of Us Part II\n" } } }] } } } };
      if (url.includes("生化危机")) return { query: { pages: { "2": { title: "生化危机2 重制版", revisions: [{ slots: { main: { "*": "| english = Resident Evil 2 Remake\n" } } }] } } } };
      return { query: { pages: { "0": { title: "最後生還者", revisions: [{ slots: { main: { "*": "| english = The Last of Us\n" } } }] } } } };
    },
  });
  const en = await resolveEnglishName(
    "最后的生还者2：重制版 v1.6.10721.0105 官方中文+预购特典+单独升级档",
    deps
  );
  assert.strictEqual(en, "The Last of Us Part II Remastered");
});

test("resolveEnglishName Wikidata+Wikipedia 失败 → 百度百科命中", async () => {
  const deps = urlAwareDeps({
    disableOffline: true,
    baidu: () => "<th>英文名</th><td>The Last of Us Part II Remastered</td>",
  });
  const en = await resolveEnglishName(
    "最后的生还者2：重制版 v1.6.10721.0105 官方中文+预购特典+单独升级档",
    deps
  );
  assert.strictEqual(en, "The Last of Us Part II Remastered");
  assert.strictEqual(deps.calls.baidu, 1);
});

test("resolveEnglishName 百度遇反爬验证页应跳过（返回空，不误抽）", async () => {
  const deps = urlAwareDeps({
    disableOffline: true,
    baidu: () => "<title>百度安全验证</title><script>验证码</script>",
  });
  const en = await resolveEnglishName(
    "最后的生还者2：重制版 v1.6.10721.0105 官方中文+预购特典+单独升级档",
    deps
  );
  assert.strictEqual(en, "");
});

test("resolveEnglishName 所有候选都失败返回空", async () => {
  const fakeHttpJson = async () => { throw new Error("net"); };
  const fakeHttpText = async () => "";
  const en = await resolveEnglishName(
    "最后的生还者2：重制版 v1.6.10721.0105 官方中文+预购特典+单独升级档",
    { httpGetJson: fakeHttpJson, httpGetText: fakeHttpText, disableOffline: true }
  );
  assert.strictEqual(en, "");
});

// ── Bangumi 国内源（isLatinName / cnNameSimilarity / fetchEnglishNameFromBangumi）──
test("isLatinName 过滤日文原名、保留拉丁英文名", () => {
  assert.strictEqual(isLatinName("The Witcher 3: Wild Hunt"), true);
  assert.strictEqual(isLatinName("Black Myth: Wukong"), true);
  assert.strictEqual(isLatinName("ペルソナ5 ザ・ロイヤル"), false, "日文原名不可用");
  assert.strictEqual(isLatinName("巫师3"), false, "中文名不是拉丁");
  assert.strictEqual(isLatinName(""), false);
});

test("cnNameSimilarity 完全匹配 / 包含 / 无关", () => {
  assert.strictEqual(cnNameSimilarity("巫师3", "巫师3"), 1);
  assert.strictEqual(cnNameSimilarity("巫师3", "巫师3：狂猎"), 0.9, "输入含候选（副标题差异）");
  assert.strictEqual(cnNameSimilarity("黑神话", "黑神话：悟空"), 0.9);
  assert.strictEqual(cnNameSimilarity("最后的生还者2", "只狼"), 0);
});

test("fetchEnglishNameFromBangumi 命中（name_cn 匹配 + 拉丁原名）", async () => {
  const httpGetJson = async () => ({
    list: [
      { name: "The Witcher 3: Wild Hunt", name_cn: "巫师3：狂猎" },
      { name: "Some Other", name_cn: "无关游戏" },
    ],
  });
  assert.strictEqual(await fetchEnglishNameFromBangumi("巫师3", httpGetJson), "The Witcher 3: Wild Hunt");
});

test("fetchEnglishNameFromBangumi 日文原名被过滤（宁可返回空也不误用日文）", async () => {
  const httpGetJson = async () => ({
    list: [{ name: "ペルソナ5 ザ・ロイヤル", name_cn: "女神异闻录5 皇家版" }],
  });
  assert.strictEqual(await fetchEnglishNameFromBangumi("女神异闻录5", httpGetJson), "");
});

test("fetchEnglishNameFromBangumi name_cn 不匹配输入时跳过", async () => {
  const httpGetJson = async () => ({
    list: [{ name: "Hollow Knight", name_cn: "空洞骑士" }],
  });
  // 输入是「巫师3」，与「空洞骑士」相似度低 → 跳过返回空
  assert.strictEqual(await fetchEnglishNameFromBangumi("巫师3", httpGetJson), "");
});

test("fetchEnglishNameFromBangumi 网络/异常静默返回空", async () => {
  const httpGetJson = async () => { throw new Error("net"); };
  assert.strictEqual(await fetchEnglishNameFromBangumi("巫师3", httpGetJson), "");
});

test("resolveEnglishName 离线关闭 + Bangumi 命中（不触发 Wikidata/Wikipedia/百度）", async () => {
  const deps = urlAwareDeps({
    disableOffline: true,
    bangumi: () => ({
      list: [
        { name: "The Witcher 3: Wild Hunt", name_cn: "巫师3：狂猎" },
      ],
    }),
  });
  const en = await resolveEnglishName(
    "巫师3 v1.6 官方中文",
    deps
  );
  assert.strictEqual(en, "The Witcher 3: Wild Hunt");
  assert.strictEqual(deps.calls.bangumi, 1, "Bangumi 应被查询");
  assert.strictEqual(deps.calls.wikidataSearch, 0, "Bangumi 命中后不应再查 Wikidata");
  assert.strictEqual(deps.calls.baidu, 0);
});

test("resolveEnglishName Bangumi 仅返回日文原名 → 跳过 → 回落百度命中", async () => {
  const deps = urlAwareDeps({
    disableOffline: true,
    bangumi: () => ({ list: [{ name: "ペルソナ5 ザ・ロイヤル", name_cn: "女神异闻录5 皇家版" }] }),
    baidu: () => "<th>英文名</th><td>Persona 5 Royal</td>",
  });
  const en = await resolveEnglishName(
    "女神异闻录5 皇家版",
    deps
  );
  assert.strictEqual(en, "Persona 5 Royal");
  assert.strictEqual(deps.calls.bangumi, 1, "Bangumi 应被查询");
  assert.strictEqual(deps.calls.baidu, 1, "Bangumi 误判后应回落百度");
});

// ── 离线静态库（内置中文名→英文名映射，无需联网）──
test("lookupEnglishNameOffline 清洗后名命中 TLOU2R（传入 cleanGameName 结果）", () => {
  assert.strictEqual(
    lookupEnglishNameOffline("最后的生还者2：重制版"),
    "The Last of Us Part II Remastered"
  );
});

test("lookupEnglishNameOffline 缩写兜底（override）命中 巫师3/只狼/荒野大镖客2", () => {
  assert.strictEqual(lookupEnglishNameOffline("巫师3"), "The Witcher 3: Wild Hunt");
  assert.strictEqual(lookupEnglishNameOffline("只狼"), "Sekiro: Shadows Die Twice");
  assert.strictEqual(lookupEnglishNameOffline("荒野大镖客2"), "Red Dead Redemption 2");
});

test("lookupEnglishNameOffline 未收录游戏返回空", () => {
  assert.strictEqual(lookupEnglishNameOffline("幻影游戏XYZ 最终版"), "");
});

test("normZh 归一化：去「的」/全角→半角/重置版↔重制版统一", () => {
  assert.strictEqual(normZh("最后的生还者2：重制版"), "最后生还者2重制版");
  assert.strictEqual(normZh("最后生还者2 重置版"), "最后生还者2重制版");
});

test("resolveEnglishName 离线库优先命中（不发起任何网络请求）", async () => {
  const fakeHttpJson = async () => { throw new Error("net should not be called"); };
  const fakeHttpText = async () => { throw new Error("net should not be called"); };
  const en = await resolveEnglishName(
    "最后的生还者2：重制版 v1.6.10721.0105 官方中文+预购特典+单独升级档 免安装硬盘版",
    { httpGetJson: fakeHttpJson, httpGetText: fakeHttpText }
  );
  assert.strictEqual(en, "The Last of Us Part II Remastered");
});

// ── H9：tryDownload 落盘后校验图片 magic，非图片内容应被丢弃并 reject ──
test("isImageMagic 识别常见图片格式", () => {
  assert.strictEqual(isImageMagic(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])), true, "JPEG");
  assert.strictEqual(isImageMagic(Buffer.from([0x89, 0x50, 0x4E, 0x47])), true, "PNG");
  assert.strictEqual(isImageMagic(Buffer.from([0x47, 0x49, 0x46, 0x38])), true, "GIF");
  assert.strictEqual(isImageMagic(Buffer.from([0x42, 0x4D, 0x00, 0x00])), true, "BMP");
  assert.strictEqual(isImageMagic(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), true, "WEBP");
  assert.strictEqual(isImageMagic(Buffer.from([0x3C, 0x68, 0x74, 0x6D])), false, "HTML 非图片");
  assert.strictEqual(isImageMagic(Buffer.alloc(2)), false, "太短");
});

test("tryDownload 真实图片落盘，非图片内容被丢弃并 reject", async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === "/img") {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]));
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>not an image</body></html>");
    }
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  const fpOk = path.join(os.tmpdir(), `kdocs_trydl_ok_${Date.now()}.jpg`);
  const fpBad = path.join(os.tmpdir(), `kdocs_trydl_bad_${Date.now()}.jpg`);
  try {
    const got = await tryDownload(`http://127.0.0.1:${port}/img`, fpOk);
    assert.strictEqual(got, fpOk);
    assert.ok(fs.existsSync(fpOk), "真实图片应落盘");
    await assert.rejects(
      tryDownload(`http://127.0.0.1:${port}/html`, fpBad),
      /非图片/,
      "非图片内容应被拒绝"
    );
    assert.ok(!fs.existsSync(fpBad), "非图片文件应被丢弃（不落盘）");
  } finally {
    srv.close();
    for (const f of [fpOk, fpBad]) { try { fs.unlinkSync(f); } catch {} }
  }
});
