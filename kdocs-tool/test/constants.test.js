// constants.test.js — 大小归一化单元测试
const test = require("node:test");
const assert = require("node:assert");
const { normalizeSize, isBadIntro } = require("../lib/constants");

test("normalizeSize 统一各种写法为 X.XG 短格式（§2.5）", () => {
  assert.strictEqual(normalizeSize("30.7G"), "30.7G");
  assert.strictEqual(normalizeSize("30.7GB"), "30.7G");
  assert.strictEqual(normalizeSize("2T"), "2.0T");
  assert.strictEqual(normalizeSize("2TB"), "2.0T");
  assert.strictEqual(normalizeSize("512MB"), "512.0M");
  assert.strictEqual(normalizeSize("800K"), "800.0K");
  assert.strictEqual(normalizeSize("1.5G"), "1.5G");
});

test("normalizeSize 短格式输入输出幂等（重复归一不变形）", () => {
  assert.strictEqual(normalizeSize(normalizeSize("30.7GB")), "30.7G");
  assert.strictEqual(normalizeSize(normalizeSize("2TB")), "2.0T");
  assert.strictEqual(normalizeSize("512M"), "512.0M");
  assert.strictEqual(normalizeSize("800KB"), "800.0K");
  assert.strictEqual(normalizeSize("17.70G"), "17.7G", "夸克页 17.70G 应简化为 17.7G");
  assert.strictEqual(normalizeSize("1024B"), "1024.0B", "B 单位保持 B");
});

test("normalizeSize 大数值保留一位小数（>=100 不再取整）", () => {
  assert.strictEqual(normalizeSize("123G"), "123.0G");
  assert.strictEqual(normalizeSize("512.5MB"), "512.5M");
});

test("normalizeSize 无法识别或非法返回空串", () => {
  assert.strictEqual(normalizeSize(""), "");
  assert.strictEqual(normalizeSize("未抓取到"), "");
  assert.strictEqual(normalizeSize("abc"), "");
  assert.strictEqual(normalizeSize(null), "");
  assert.strictEqual(normalizeSize("0G"), "");
});

test("isBadIntro 连续调用不受 lastIndex 状态残留影响（g 标志回归）", () => {
  // 回归：INTRO_BLACKLIST 曾带 g 标志，模块级共享正则 .test() 残留 lastIndex，
  // 连续调用时可能从残留下标开始搜而漏判开头的禁用词。
  assert.strictEqual(isBadIntro("该游戏是某厂商推出的作品"), true, "开头含'该游戏'应判不合格");
  // 紧跟一次不含禁用词的调用，再回到含禁用词的串——若 lastIndex 残留则会漏判
  assert.strictEqual(isBadIntro("一款正常的国产独立游戏，玩法很扎实。"), false);
  assert.strictEqual(isBadIntro("该游戏支持中文且画面精美"), true, "再次命中'该游戏'不应因上次调用漏判");
  assert.strictEqual(isBadIntro("沉浸式体验极佳的开放世界大作"), true, "末尾'沉浸式'也应稳定命中");
  assert.strictEqual(isBadIntro("正常介绍：开发商于 2024 年推出的双人合作冒险游戏。"), false, "正常介绍始终判合格");
});
