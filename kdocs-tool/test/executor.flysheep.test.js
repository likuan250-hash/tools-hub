// executor.flysheep.test.js — 取数线路（flysheep6 游戏站，可选）：封面/介绍优先从站点取，缺失自动回退 Steam
const test = require("node:test");
const assert = require("node:assert");
const { autoExecute } = require("../lib/executor");

const FS_INTRO =
  "本作是刀光血影、以牙还牙的极致动作游戏，在面目全非的京都斩杀幻魔，追寻战斗的意义。";

// 站点返回什么由各用例切换（默认：鬼武者命中）；单测一律不真联网
let stubProvider = null;
const stubInfo = () => (stubProvider ? stubProvider() : null);
const FS_HIT = () => ({
  url: "https://www.flysheep6.com/archives/95242",
  zhName: "鬼武者",
  enName: "Way of the Sword",
  appid: "2638890",
  coverUrl:
    "https://shared.cdn.queniuqe.com/store_item_assets/steam/apps/2638890/x/capsule_616x353.jpg",
  intro: FS_INTRO,
  trailerHls: "",
});

function baseParsed(over = {}) {
  return {
    gameName: "鬼武者",
    englishName: "",
    baiduUrl: "",
    quarkUrl: "",
    xunleiUrl: "",
    tags: ["PC游戏"],
    raw: "鬼武者（Way of the Sword）",
    size: "",
    coverUrl: "",
    ...over,
  };
}

function baseDeps(over = {}) {
  const calls = { flysheep: [], coverFromUrl: [], coverSteam: [] };
  let lastCreate = null;
  const deps = {
    checkKdocsReady: () => true,
    searchSteamAppId: async () => "999999",
    getSteamAppDetails: async () => ({
      shortDescription: "Steam 官方中文介绍。",
      size: "40G",
      headerImage: "https://cdn.example.com/steam-header.jpg",
    }),
    fetchAppIdFromWikidata: async () => null,
    fetchAppIdFromBaiduBaike: async () => null,
    fetchAppIdFromWebSearch: async () => null,
    fetchWikiIntro: async () => null,
    resolveEnglishName: async () => "",
    downloadCover: async (name, appid, dir, opts) => {
      calls.coverSteam.push({ name, appid, imageUrl: opts && opts.imageUrl });
      return "/fake/steam_cover.jpg";
    },
    downloadCoverFromUrl: async (name, url) => {
      calls.coverFromUrl.push({ name, url });
      return "/fake/flysheep_cover.jpg";
    },
    flysheepLookup: async (name) => {
      calls.flysheep.push(name);
      return stubInfo();
    },
    // executor 优先用带原因的版本（site 打不开 vs 站内没有），单测里同样用 stub，避免真联网
    flysheepLookupDetailed: async (name) => {
      calls.flysheep.push(name);
      const info = stubInfo();
      return info ? { ok: true, info } : { ok: false, reason: "not-found" };
    },
    fileBase64: () => "base64data",
    callMcporter: (fn, args) => {
      if (fn === "dbsheet.create_records") lastCreate = args.records[0].fields;
      if (fn === "upload_attachment") return { object_id: "obj1" };
      if (fn === "dbsheet.list_records") return { data: { detail: { records: [] } } };
      return { data: { records: [{ id: "r1" }] } };
    },
    fs: { statSync: () => ({ size: 1234 }) },
    calls,
    _state: () => ({ lastCreate }),
    ...over,
  };
  return deps;
}

test("勾选取数线路：AppID/封面/介绍都优先用 flysheep6", async () => {
  stubProvider = FS_HIT;
  // Steam/离线解析到同一个 appid（正常命中场景）→ 站点封面与官方来源指向同一款，可用站点图
  const deps = baseDeps({ searchSteamAppId: async () => "2638890" });
  const events = [];
  const res = await autoExecute(baseParsed(), null, "/tmp", {
    flysheep: true,
    deps,
    onStep: (ev) => events.push(ev),
  });
  assert.strictEqual(deps.calls.flysheep.length, 1, "应查询一次 flysheep6");
  assert.deepStrictEqual(
    deps.calls.coverFromUrl.map((c) => c.url),
    ["https://shared.cdn.queniuqe.com/store_item_assets/steam/apps/2638890/x/capsule_616x353.jpg"],
  );
  assert.strictEqual(deps.calls.coverSteam.length, 0, "站点封面拿得到就不该再打 Steam");
  assert.strictEqual(deps._state().lastCreate["游戏介绍"], FS_INTRO, "介绍应取站内中文文案");
  assert.ok(
    events.some((e) => e.step && e.step.name === "flysheep6 命中"),
    "应有站点命中步骤",
  );
  assert.strictEqual(res.success, true);
});

test("不勾取数线路：一次都不查 flysheep6，行为与原来一致", async () => {
  stubProvider = FS_HIT;
  const deps = baseDeps();
  await autoExecute(baseParsed(), null, "/tmp", { deps, onStep: () => {} });
  assert.strictEqual(deps.calls.flysheep.length, 0);
  assert.strictEqual(deps.calls.coverFromUrl.length, 0);
  assert.strictEqual(deps.calls.coverSteam.length, 1, "封面仍走 Steam 官方");
});

test("站点 appid 与解析到的 appid 不一致（本体/DLC 合页）：封面回退 Steam 官方", async () => {
  stubProvider = () => ({
    url: "https://www.flysheep6.com/archives/5340",
    zhName: "艾尔登法环 黄金树之影",
    enName: "ELDEN RING Shadow of the Erdtree",
    appid: "3655690",
    coverUrl: "https://shared.cdn.queniuqe.com/store_item_assets/steam/apps/3655690/y/header.jpg",
    intro: FS_INTRO,
    trailerHls: "",
  });
  const deps = baseDeps();
  await autoExecute(
    baseParsed({ gameName: "艾尔登法环", raw: "艾尔登法环（ELDEN RING）" }),
    null,
    "/tmp",
    {
      flysheep: true,
      deps,
      onStep: () => {},
    },
  );
  assert.strictEqual(deps.calls.coverFromUrl.length, 0, "appid 不一致时不用站点封面");
  assert.strictEqual(deps.calls.coverSteam.length, 1, "改用 Steam 官方封面");
});

test("站内没这个游戏：整条线路跳过，封面/介绍回退原有来源", async () => {
  stubProvider = () => null;
  const deps = baseDeps();
  const events = [];
  await autoExecute(baseParsed(), null, "/tmp", {
    flysheep: true,
    deps,
    onStep: (ev) => events.push(ev),
  });
  assert.strictEqual(deps.calls.coverFromUrl.length, 0);
  assert.ok(
    events.some(
      (e) =>
        e.step &&
        e.step.status === "跳过" &&
        String(e.step.name).includes("flysheep6") &&
        /站内无此游戏/.test(String(e.step.reason)),
    ),
    "站内没有时应报「站内无此游戏」",
  );
});

test("站点打不开（网络/证书）：报「站点访问失败」警告，不能误说成站内没这个游戏", async () => {
  stubProvider = FS_HIT;
  const deps = baseDeps({
    flysheepLookup: async () => null,
    flysheepLookupDetailed: async () => ({
      ok: false,
      reason: "network",
      error: "unable to verify the first certificate",
      url: "https://www.flysheep6.com/?s=x",
    }),
  });
  const events = [];
  await autoExecute(baseParsed(), null, "/tmp", {
    flysheep: true,
    deps,
    onStep: (ev) => events.push(ev),
  });
  const warnStep = events
    .map((e) => e.step)
    .filter(Boolean)
    .find((s) => s.status === "警告" && String(s.name).includes("flysheep6"));
  assert.ok(warnStep, "应产生一条 flysheep6 警告步骤");
  assert.match(String(warnStep.reason), /站点访问失败/);
  assert.match(String(warnStep.reason), /verify the first certificate/);
  assert.strictEqual(deps.calls.coverSteam.length, 1, "站点不可用时应回退 Steam 官方封面");
});
