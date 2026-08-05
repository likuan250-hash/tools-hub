// datapack.test.js — 离线数据包管理单元测试（内置/缓存覆盖/版本比较，无需网络）
const os = require("os");
const path = require("path");
const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert");

// 隔离缓存目录：必须在 require datapack 之前设置环境变量（模块加载时计算 CACHE_FILE）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "datapack-test-"));
process.env.KDOCS_DATA_DIR = tmp;

const { getActiveDataPack, getActiveDataPackVersion, normZh, normEn, CACHE_FILE } = require("../lib/datapack");

test("内置数据包：结构完整 + 关键映射正确", () => {
  const pack = getActiveDataPack();
  assert.ok(pack.version >= 1, "内置数据包版本 >= 1");
  assert.strictEqual(pack.gameNames[normZh("巫师3")], "The Witcher 3: Wild Hunt");
  assert.strictEqual(pack.gameNames[normZh("最后的生还者2：重制版")], "The Last of Us Part II Remastered");
  assert.strictEqual(pack.appIds[normEn("The Last of Us Part II Remastered")], "2531310");
  assert.strictEqual(pack.appIds[normEn("Cyberpunk 2077")], "1091500");
});

test("缓存版本更高时生效（主进程拉取更新场景）", () => {
  const v = getActiveDataPackVersion();
  const higher = { version: v + 5, gameNames: { "测试新游戏": "Test New Game" }, appIds: {} };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(higher), "utf8");
  const pack = getActiveDataPack();
  assert.strictEqual(pack.version, v + 5, "应使用更高版本缓存");
  assert.strictEqual(pack.gameNames[normZh("测试新游戏")], "Test New Game", "新游戏映射应生效");
});

test("缓存版本 <= 内置时回退内置（防旧包回滚）", () => {
  // 先清掉前序测试留下的高版本缓存，取纯净内置版本
  try { fs.unlinkSync(CACHE_FILE); } catch (_) {}
  const v = getActiveDataPackVersion();
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ version: v, gameNames: {}, appIds: {} }), "utf8");
  const pack = getActiveDataPack();
  assert.strictEqual(pack.version, v, "版本相同 → 仍用内置（不采纳缓存）");
  assert.strictEqual(pack.gameNames[normZh("巫师3")], "The Witcher 3: Wild Hunt", "内置映射仍可用");
});

test("损坏缓存回退内置（拉取中断/半包不致命）", () => {
  fs.writeFileSync(CACHE_FILE, "{{{ not json", "utf8");
  const pack = getActiveDataPack();
  assert.ok(pack.version >= 1, "损坏缓存应回退内置");
  assert.strictEqual(pack.gameNames[normZh("只狼")], "Sekiro: Shadows Die Twice");
});

test("归一化：normEn 去标点、normZh 剥「的」+版本词统一", () => {
  assert.strictEqual(normEn("The Last of Us: Part II Remastered"), "thelastofuspartiiremastered");
  assert.strictEqual(normEn(""), "");
  assert.strictEqual(normZh("最后的生还者2：重制版"), "最后生还者2重制版");
});
