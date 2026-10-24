const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeName, pickLandedEntries } = require("../src/landing");

test("normalizeName 归一化全半角、空白与复制后缀", () => {
  assert.equal(normalizeName("  Game（1）  "), "game");
  assert.equal(normalizeName("Game (2).txt"), "game.txt");
});

test("pickLandedEntries 优先精确同名", () => {
  const r = pickLandedEntries(["PCGAME-Demo"], null, [
    { fs_id: "1", server_filename: "PCGAME-Demo", isdir: 1 },
    { fs_id: "2", server_filename: "其他", isdir: 1 },
  ]);
  assert.equal(r.reason, "exact");
  assert.deepEqual(
    r.entries.map((x) => x.fs_id),
    ["1"],
  );
});

test("pickLandedEntries 支持规范化同名", () => {
  const r = pickLandedEntries(["Game: Demo"], null, [
    { fs_id: "1", server_filename: "game： demo", isdir: 1 },
  ]);
  assert.equal(r.reason, "normalized");
  assert.equal(r.entries[0].fs_id, "1");
});

test("pickLandedEntries 文件夹分享改名时按新增 fs_id 认领", () => {
  const r = pickLandedEntries(
    ["PCGAME-Call.of.Duty.Modern.Warfare.4-P2P"],
    [{ fs_id: "old", server_filename: "旧目录", isdir: 1 }],
    [
      { fs_id: "old", server_filename: "旧目录", isdir: 1 },
      { fs_id: "new", server_filename: "使命召唤：现代战争4", isdir: 1 },
    ],
  );
  assert.equal(r.reason, "new-entry");
  assert.deepEqual(
    r.entries.map((x) => x.server_filename),
    ["使命召唤：现代战争4"],
  );
});

test("pickLandedEntries 目标目录原本为空时也能按新增项认领", () => {
  const r = pickLandedEntries(
    ["PCGAME-Demo"],
    [],
    [{ fs_id: "new", server_filename: "实际目录名", isdir: 1 }],
  );
  assert.equal(r.reason, "new-entry");
  assert.equal(r.entries[0].fs_id, "new");
});

test("pickLandedEntries 已有中文目录时可按分享标题别名认领", () => {
  const r = pickLandedEntries(
    ["PCGAME-Call.of.Duty.Modern.Warfare.4-P2P"],
    [{ fs_id: "old", server_filename: "使命召唤：现代战争4", isdir: 1 }],
    [{ fs_id: "old", server_filename: "使命召唤：现代战争4", isdir: 1 }],
    { aliases: ["使命召唤：现代战争4（Call of Duty: Modern Warfare 4）官方中文版"] },
  );
  assert.equal(r.reason, "title-alias");
  assert.equal(r.entries[0].fs_id, "old");
});

test("pickLandedEntries 无新增项时不误认领", () => {
  const r = pickLandedEntries(
    ["PCGAME-Demo"],
    [{ fs_id: "old", server_filename: "旧目录", isdir: 1 }],
    [{ fs_id: "old", server_filename: "旧目录", isdir: 1 }],
  );
  assert.equal(r.reason, "none");
  assert.deepEqual(r.entries, []);
});
