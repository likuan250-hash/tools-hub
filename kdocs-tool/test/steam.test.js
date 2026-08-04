// steam.test.js — Steam 官方描述解析单元测试（纯函数，无需网络）
const test = require("node:test");
const assert = require("node:assert");
const { parseSteamAppDetails, parseSteamSizeFromRequirements, parseSteamAppIdFromText, extractEnglishNameFromWikidata, extractEnglishNameFromBaidu, resolveEnglishName, cleanGameName, stripSubtitle } = require("../lib/steam");

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

// ── resolveEnglishName 多候选降级（清洗→剥副标题→原名）──
test("resolveEnglishName 清洗后 Wikidata 命中直接返回（不发剥副标题请求）", async () => {
  const calls = [];
  const fakeHttpJson = async (url) => {
    calls.push(url);
    if (calls.length === 1) return { search: [{ id: "Q1" }] };
    return { entities: { Q1: { labels: { en: { value: "The Last of Us Part II Remastered" } } } } };
  };
  const en = await resolveEnglishName(
    "最后的生还者2：重制版 v1.6.10721.0105 官方中文+预购特典+单独升级档",
    { httpGetJson: fakeHttpJson }
  );
  assert.strictEqual(en, "The Last of Us Part II Remastered");
  assert.strictEqual(calls.length, 2);
});

test("resolveEnglishName 清洗名 Wikidata 失败 → 剥副标题命中", async () => {
  const calls = [];
  const fakeHttpJson = async (url) => {
    calls.push(url);
    if (calls.length === 1) return { search: [] };
    if (calls.length === 2) return { search: [{ id: "Q1" }] };
    return { entities: { Q1: { labels: { en: { value: "The Last of Us Part II" } } } } };
  };
  const en = await resolveEnglishName(
    "最后的生还者2：重制版 v1.6.10721.0105 官方中文+预购特典+单独升级档",
    { httpGetJson: fakeHttpJson }
  );
  assert.strictEqual(en, "The Last of Us Part II");
  assert.strictEqual(calls.length, 3);
});

test("resolveEnglishName Wikidata 全失败 → 百度百科清洗名命中", async () => {
  const callsJson = [];
  const callsText = [];
  const fakeHttpJson = async (url) => { callsJson.push(url); return { search: [] }; };
  const fakeHttpText = async (url) => {
    callsText.push(url);
    if (callsText.length === 1) return "<th>英文名</th><td>The Last of Us Part II Remastered</td>";
    return "";
  };
  const en = await resolveEnglishName(
    "最后的生还者2：重制版 v1.6.10721.0105 官方中文+预购特典+单独升级档",
    { httpGetJson: fakeHttpJson, httpGetText: fakeHttpText }
  );
  assert.strictEqual(en, "The Last of Us Part II Remastered");
  assert.strictEqual(callsText.length, 1);
});

test("resolveEnglishName 所有候选都失败返回空", async () => {
  const fakeHttpJson = async () => { throw new Error("net"); };
  const fakeHttpText = async () => "";
  const en = await resolveEnglishName(
    "最后的生还者2：重制版 v1.6.10721.0105 官方中文+预购特典+单独升级档",
    { httpGetJson: fakeHttpJson, httpGetText: fakeHttpText }
  );
  assert.strictEqual(en, "");
});
