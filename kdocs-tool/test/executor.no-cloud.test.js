// executor.no-cloud.test.js — 云库线路已彻底移除（2026-10）：只写金山文档
// 这条测试是回归护栏：一旦有人把云库代码/调用加回来，会立刻红。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { autoExecute } = require("../lib/executor");

function baseParsed() {
  return {
    gameName: "双影奇境",
    englishName: "Split Fiction",
    baiduUrl: "",
    quarkUrl: "",
    xunleiUrl: "",
    tags: ["PC游戏"],
    raw: "双影奇境（Split Fiction）",
    size: "",
    coverUrl: "",
  };
}

function baseDeps() {
  return {
    checkKdocsReady: () => true,
    searchSteamAppId: async () => null,
    getSteamAppDetails: async () => null,
    fetchAppIdFromWikidata: async () => null,
    fetchAppIdFromBaiduBaike: async () => null,
    fetchAppIdFromWebSearch: async () => null,
    fetchWikiIntro: async () => null,
    resolveEnglishName: async () => "",
    downloadCover: async () => "/fake/steam.jpg",
    downloadCoverFromUrl: async () => "/fake/cover.jpg",
    fileBase64: () => "base64data",
    callMcporter: (fn, args) => {
      if (fn === "dbsheet.create_records")
        return { data: { records: [{ id: "r1", fields: args.records[0].fields }] } };
      if (fn === "upload_attachment") return { object_id: "obj1" };
      if (fn === "dbsheet.list_records") return { data: { detail: { records: [] } } };
      return { data: { records: [{ id: "r1" }] } };
    },
    fs: { statSync: () => ({ size: 1234 }) },
  };
}

test("云库模块文件已删除（require 会失败）", () => {
  assert.strictEqual(fs.existsSync(path.join(__dirname, "..", "lib", "gamecloud.js")), false);
  assert.throws(() => require("../lib/gamecloud"), /Cannot find module/);
});

test("一键执行不再产出云库结果：无 cloud 字段、无云库步骤、无 targets", async () => {
  const events = [];
  const res = await autoExecute(baseParsed(), null, "/tmp", {
    deps: baseDeps(),
    onStep: (e) => events.push(e),
  });
  assert.strictEqual(res.cloud, undefined, "结果里不应再有 cloud");
  assert.strictEqual(res.targets, undefined, "结果里不应再有 targets");
  assert.strictEqual(events.filter((e) => e.group === "cloud").length, 0, "不应有云库步骤事件");
  assert.strictEqual(res.action, "created", "金山线路照常执行");
});

test("旧调用兼容：targets.kdocs === false 时整条线路不跑（前端勾选控制仍有效）", async () => {
  const res = await autoExecute(baseParsed(), null, "/tmp", {
    deps: baseDeps(),
    targets: { kdocs: false },
    onStep: () => {},
  });
  assert.strictEqual(res.action, "noop");
  assert.strictEqual(res.success, true);
});
