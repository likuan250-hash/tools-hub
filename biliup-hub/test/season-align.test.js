// biliup-hub/test/season-align.test.js —— 合集/分集字段对齐 helper 单测（#问题1 修复）
// 验证：合集仅一个分集时自动对齐到 sectionId；多分集/无分集不猜测。
const test = require('node:test');
const assert = require('node:assert/strict');
const { autoSelectSection } = require('../public/season-align');

test('autoSelectSection: 空数组 → null（无分集无需后置）', () => {
  assert.equal(autoSelectSection([]), null);
});

test('autoSelectSection: 无入参/非数组 → null', () => {
  assert.equal(autoSelectSection(undefined), null);
  assert.equal(autoSelectSection(null), null);
  assert.equal(autoSelectSection('x'), null);
});

test('autoSelectSection: 单分集 → 返回其 id（字段对齐生效）', () => {
  assert.equal(autoSelectSection([{ id: '7630305', title: '唯一分集' }]), '7630305');
});

test('autoSelectSection: 多分集 → null（不猜测，需用户明确选）', () => {
  assert.equal(autoSelectSection([{ id: '1' }, { id: '2' }]), null);
});

test('autoSelectSection: 元素缺 id → 视作无效 → null', () => {
  assert.equal(autoSelectSection([{}]), null);
});
