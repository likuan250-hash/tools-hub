// live-flysheep.test.js — flysheep6 取数线路「真联网」验收（默认跳过，不进 npm test 门禁）
//
// 跑法：npm --prefix kdocs-tool run test:live-flysheep
// 覆盖：站点可达 → 搜索/详情解析 → 封面直链可下载 → executor 端到端（金山后端全 mock，不写文档）
//
// 之所以单列：正常 npm test 必须离线可跑（CI/无网环境不能红），这条要有网才有意义。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const LIVE =
  process.env.LIVE_FLYSHEEP === "1" || process.env.npm_lifecycle_event === "test:live-flysheep";
const flysheep = require("../lib/flysheep");
const { autoExecute } = require("../lib/executor");

const COVER_DIR = path.join(__dirname, "..", "cache", "live-flysheep-cover");
const skip = LIVE ? false : "真联网用例：用 npm run test:live-flysheep 触发";

test("站点可达（直连，不依赖代理）", { skip }, async () => {
  const r = await fetch("https://www.flysheep6.com/", {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(20000),
  });
  assert.strictEqual(r.status, 200);
  const html = await r.text();
  assert.ok(html.length > 10000, "首页应有实质内容");
});

test("搜索 + 详情解析：中文名能拿到 appid/介绍/封面", { skip }, async () => {
  const r = await flysheep.lookupDetailed("鬼武者");
  assert.strictEqual(r.ok, true, "鬼武者 应命中（失败原因：" + JSON.stringify(r) + "）");
  assert.strictEqual(r.info.appid, "2638890");
  assert.ok(r.info.intro.length > 30, "应有中文介绍");
  assert.match(r.info.coverUrl, /^https:\/\/.+\.(jpg|png)/);
});

test("站内没有的游戏：判 not-found（不能误报成站点故障）", { skip }, async () => {
  const r = await flysheep.lookupDetailed("ZZZ测试用不存在游戏999");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not-found");
});

test("封面直链能真实下载（国区 CDN）", { skip }, async () => {
  const r = await flysheep.lookupDetailed("鬼武者");
  assert.strictEqual(r.ok, true);
  const resp = await fetch(r.info.coverUrl, { signal: AbortSignal.timeout(30000) });
  assert.strictEqual(resp.status, 200);
  const buf = Buffer.from(await resp.arrayBuffer());
  assert.ok(buf.length > 20 * 1024, "封面应 >20KB，实际 " + buf.length);
  assert.strictEqual(buf[0], 0xff, "应为 JPEG 头");
});

test("executor 端到端：勾选取数线路 → 封面/介绍都来自 flysheep6", { skip }, async () => {
  fs.rmSync(COVER_DIR, { recursive: true, force: true });
  const events = [];
  const parsed = {
    gameName: "全面战争：战锤3",
    englishName: "Total War: Warhammer III",
    baiduUrl: "",
    quarkUrl: "",
    xunleiUrl: "",
    tags: ["PC游戏"],
    raw: "全面战争：战锤3 免安装硬盘版",
    size: "",
    coverUrl: "",
  };
  const deps = {
    checkKdocsReady: () => true,
    callMcporter: (fn, args) => {
      if (fn === "dbsheet.create_records")
        return { data: { records: [{ id: "mock-1", fields: args.records[0].fields }] } };
      if (fn === "upload_attachment") return { object_id: "mock-obj" };
      if (fn === "dbsheet.list_records") return { data: { detail: { records: [] } } };
      return { data: { records: [{ id: "mock-1" }] } };
    },
    fileBase64: () => "bW9jaw==",
    searchSteamAppId: async () => "",
    getSteamAppDetails: async () => null,
    fetchAppIdFromWikidata: async () => "",
    fetchAppIdFromBaiduBaike: async () => "",
    fetchAppIdFromWebSearch: async () => "",
    fetchWikiIntro: async () => null,
    resolveEnglishName: async () => "",
    downloadCover: async () => {
      throw new Error("不该走 Steam 封面");
    },
    downloadCoverFromUrl: async (_n, url, dir) => {
      const fp = path.join(dir || COVER_DIR, "flysheep_cover.jpg");
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      fs.writeFileSync(fp, Buffer.from(await resp.arrayBuffer()));
      return fp;
    },
  };
  const res = await autoExecute(parsed, null, COVER_DIR, {
    flysheep: true,
    deps,
    onStep: (e) => events.push(e),
  });
  const names = events
    .filter((e) => e.type === "step")
    .map((e) => e.step.name + ":" + e.step.status);
  assert.ok(names.includes("flysheep6 命中:成功"), "应有站点命中步骤，实际：" + names.join(" | "));
  assert.ok(names.includes("游戏介绍生成（flysheep6 游戏站）:成功"), "介绍应来自站点");
  assert.ok(names.includes("封面下载（flysheep6）:成功"), "封面应来自站点");
  assert.strictEqual(res.introProvenance, "flysheep6");
  assert.strictEqual(res.coverStatus, "ok");
});
