// netdisk-hub/test/agg-status.test.js
// 校验 aggregateStatus 纯函数（严重度阶梯 + 翻红逻辑）。
// 该文件 require 的是 public/status-luxe.js 副本，需在其被创建后才能跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateStatus } = require('../public/status-luxe.js');

test('全 ok → ok', () => {
  assert.equal(aggregateStatus(['ok', 'ok']), 'ok');
});

test('含 off → off', () => {
  assert.equal(aggregateStatus(['ok', 'off']), 'off');
});

test('含 warn → warn', () => {
  assert.equal(aggregateStatus(['ok', 'warn']), 'warn');
});

test('含 err → err', () => {
  assert.equal(aggregateStatus(['ok', 'err']), 'err');
});

test('[off, warn] → off（off 严重度高于 warn）', () => {
  assert.equal(aggregateStatus(['off', 'warn']), 'off');
});

test('[err, off] → err', () => {
  assert.equal(aggregateStatus(['err', 'off']), 'err');
});

test('混合 [ok, info, warn, off, err] → err', () => {
  assert.equal(aggregateStatus(['ok', 'info', 'warn', 'off', 'err']), 'err');
});

test('空数组 → ok', () => {
  assert.equal(aggregateStatus([]), 'ok');
});

test('含非法 token（xyz）忽略', () => {
  assert.equal(aggregateStatus(['ok', 'xyz']), 'ok');
  assert.equal(aggregateStatus(['xyz', 'err']), 'err');
});

test('[info, off] → off', () => {
  assert.equal(aggregateStatus(['info', 'off']), 'off');
});
