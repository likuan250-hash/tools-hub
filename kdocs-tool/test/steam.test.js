// steam.test.js — Steam 官方描述解析单元测试（纯函数，无需网络）
const test = require("node:test");
const assert = require("node:assert");
const { parseSteamAppDetails, parseSteamSizeFromRequirements, parseSteamAppIdFromText } = require("../lib/steam");

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
