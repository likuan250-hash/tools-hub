// biliup-hub/test/season-align.test.js —— 合集/分集字段对齐 helper 单测（需求①「选即生效」）
// 验证：合集含 ≥1 个分集时自动对齐到第一个分集 id（选即生效）；无分集返回 null。
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

test('autoSelectSection: 多分集 → 返回第一个分集 id（选即生效，默认选首）', () => {
  assert.equal(autoSelectSection([{ id: '1' }, { id: '2' }]), '1');
});

test('autoSelectSection: 多分集（含 title）仍返回第一个分集 id', () => {
  assert.equal(
    autoSelectSection([{ id: '111', title: '分集甲' }, { id: '112', title: '分集乙' }]),
    '111'
  );
});

test('autoSelectSection: 元素缺 id → 视作无效 → null', () => {
  assert.equal(autoSelectSection([{}]), null);
});

test('autoSelectSection: 仅首元素缺 id，后续元素有 id → 仍按「第一个分集」语义返回 null', () => {
  // 需求① 明确返回 sections[0].id；首个分集无 id 视为无效，不跨项跳过，返回 null。
  assert.equal(autoSelectSection([{}, { id: '5' }]), null);
});
