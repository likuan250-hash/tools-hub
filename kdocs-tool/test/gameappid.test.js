const test = require("node:test");
const assert = require("node:assert");
const { lookupAppIdOffline, normEn } = require("../lib/gameappid");

test("normEn 归一化：去标点/空白/大小写", () => {
  assert.strictEqual(normEn("The Last of Us: Part II Remastered"), "thelastofuspartiiremastered");
  assert.strictEqual(normEn(""), "");
  assert.strictEqual(normEn(null), "");
});

test("lookupAppIdOffline 命中规范英文名（含大小写/标点归一化）", () => {
  assert.strictEqual(lookupAppIdOffline("The Last of Us Part II Remastered"), "2531310");
  assert.strictEqual(lookupAppIdOffline("the last of us part ii remastered"), "2531310");
  assert.strictEqual(lookupAppIdOffline("Cyberpunk 2077"), "1091500");
  assert.strictEqual(lookupAppIdOffline("Marvel's Spider-Man"), "1817070");
});

test("lookupAppIdOffline 未命中返回 null", () => {
  assert.strictEqual(lookupAppIdOffline("Some Unknown Game XYZ"), null);
  assert.strictEqual(lookupAppIdOffline(""), null);
  assert.strictEqual(lookupAppIdOffline(null), null);
});

test("lookupAppIdOffline 仅含确实上架 Steam 的游戏（非 Steam 主机独占不收录）", () => {
  // 塞尔达系列为任天堂独占，不应有 AppID 映射
  assert.strictEqual(lookupAppIdOffline("The Legend of Zelda: Tears of the Kingdom"), null);
  assert.strictEqual(lookupAppIdOffline("The Legend of Zelda: Breath of the Wild"), null);
});
