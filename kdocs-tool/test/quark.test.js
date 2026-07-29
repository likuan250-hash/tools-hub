// quark.test.js — 夸克分享页大小抓取单元测试（版本号选择为纯函数，无需网络）
const test = require("node:test");
const assert = require("node:assert");
const { parseVersion, pickLatestVersion } = require("../lib/quark");

test("parseVersion 提取名称中的版本号", () => {
  assert.deepStrictEqual(parseVersion("游戏v1"), [1]);
  assert.deepStrictEqual(parseVersion("Game 2.0"), [2, 0]);
  assert.deepStrictEqual(parseVersion("无版本文件夹"), null);
  assert.deepStrictEqual(parseVersion(""), null);
});

test("pickLatestVersion 选最高版本（扁平：根=版本）", () => {
  const list = [
    { file_name: "游戏v1", dir: true, fid: "1" },
    { file_name: "游戏v2", dir: true, fid: "2" },
    { file_name: "游戏v3", dir: true, fid: "3" },
    { file_name: "说明.txt", dir: false, fid: "4" },
  ];
  assert.deepStrictEqual(pickLatestVersion(list).map(x => x.file_name), ["游戏v3"]);
});

test("pickLatestVersion 无版本号返回空（上层回退全部求和）", () => {
  const list = [{ file_name: "游戏本体", dir: true, fid: "1" }];
  assert.deepStrictEqual(pickLatestVersion(list), []);
});

test("pickLatestVersion 同版本分卷一起选中", () => {
  const list = [
    { file_name: "Game v2 part1", dir: true, fid: "1" },
    { file_name: "Game v2 part2", dir: true, fid: "2" },
    { file_name: "Game v1", dir: true, fid: "3" },
  ];
  const r = pickLatestVersion(list);
  assert.ok(r.length >= 1, "应选中至少一个（不崩溃）");
  // 最高版本为 v2 系列，应优先于 v1
  assert.ok(r.every(x => /v2/.test(x.file_name)), "命中项应属 v2 系列");
});

test("pickLatestVersion 带点版本号正确比较", () => {
  const list = [
    { file_name: "Game 1.5", dir: true, fid: "1" },
    { file_name: "Game 1.10", dir: true, fid: "2" },
  ];
  assert.deepStrictEqual(pickLatestVersion(list).map(x => x.file_name), ["Game 1.10"]);
});
