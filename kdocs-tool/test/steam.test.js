// steam.test.js — Steam 官方描述解析单元测试（纯函数，无需网络）
const test = require("node:test");
const assert = require("node:assert");
const { parseSteamAppDetails } = require("../lib/steam");

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
