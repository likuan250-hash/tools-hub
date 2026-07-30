// constants.test.js — 大小归一化单元测试
const test = require("node:test");
const assert = require("node:assert");
const { normalizeSize } = require("../lib/constants");

test("normalizeSize 统一各种写法为规范形式", () => {
  assert.strictEqual(normalizeSize("30.7G"), "30.7GB");
  assert.strictEqual(normalizeSize("30.7GB"), "30.7GB");
  assert.strictEqual(normalizeSize("2T"), "2TB");
  assert.strictEqual(normalizeSize("2TB"), "2TB");
  assert.strictEqual(normalizeSize("512MB"), "512MB");
  assert.strictEqual(normalizeSize("800K"), "800KB");
  assert.strictEqual(normalizeSize("1.5G"), "1.5GB");
});

test("normalizeSize 大数值取整（>=100）", () => {
  assert.strictEqual(normalizeSize("123G"), "123GB");
  assert.strictEqual(normalizeSize("512MB"), "512MB");
});

test("normalizeSize 无法识别或非法返回空串", () => {
  assert.strictEqual(normalizeSize(""), "");
  assert.strictEqual(normalizeSize("未抓取到"), "");
  assert.strictEqual(normalizeSize("abc"), "");
  assert.strictEqual(normalizeSize(null), "");
  assert.strictEqual(normalizeSize("0G"), "");
});
