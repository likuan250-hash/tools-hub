// test/coerce-int.test.js —— coerceInt helper 单测（#noReprint falsy 陷阱修复）
// 核心：coerceInt("0", 1) 必须返回 0，不能把 0 当成 falsy 兜底成 1。
const test = require('node:test');
const assert = require('node:assert');
const { coerceInt } = require('../public/coerce-int.js');

test('coerceInt("0", 1) === 0（核心：0 不被当 falsy 兜底）', () => {
  assert.strictEqual(coerceInt('0', 1), 0);
});

test('coerceInt("", 1) === 1（空串回退默认）', () => {
  assert.strictEqual(coerceInt('', 1), 1);
});

test('coerceInt("17", 17) === 17（命中默认值不变）', () => {
  assert.strictEqual(coerceInt('17', 17), 17);
});

test('coerceInt("20", 17) === 20（非内置分区原值保留）', () => {
  assert.strictEqual(coerceInt('20', 17), 20);
});

test('coerceInt(null, 5) === 5（null 回退默认）', () => {
  assert.strictEqual(coerceInt(null, 5), 5);
});

test('coerceInt("abc", 9) === 9（非法数字回退默认）', () => {
  assert.strictEqual(coerceInt('abc', 9), 9);
});
