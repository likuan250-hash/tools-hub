const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { lookupAppIdOffline, normEn } = require("../lib/gameappid");
const { lookupSteamAppId } = require("../lib/steamindex");

const HAS_BIG_INDEX = fs.existsSync(path.join(__dirname, "..", "lib", "steam-appid-index.json.gz"));

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

// ── 离线大库（steam-appid-index.json.gz，商店全量中/英文名）────────────────────
test("离线大库：商店中文名 / 英文名 → AppID", { skip: !HAS_BIG_INDEX }, () => {
  assert.strictEqual(lookupAppIdOffline("双人成行"), "1426210");
  assert.strictEqual(lookupAppIdOffline("全面战争：战锤3"), "1142710");
  assert.strictEqual(lookupSteamAppId("Total War: Warhammer III"), "1142710");
});

test("离线大库：过短噪声名不误配（「X」「3」这类不查）", { skip: !HAS_BIG_INDEX }, () => {
  assert.strictEqual(lookupSteamAppId("X"), null);
  assert.strictEqual(lookupSteamAppId("3"), null);
  assert.strictEqual(lookupSteamAppId(""), null);
});
