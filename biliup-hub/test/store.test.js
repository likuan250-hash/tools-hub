// biliup-hub/test/store.test.js —— store.js 单测（I：置顶评论存量迁移）
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../lib/store');

// 旧短版话术（须与 lib/store.js 中 OLD_COMMENT 完全一致）。
const OLD = '老规矩！！！三连后关注私信自动回复下载方式';
// 新完整版以 defaultConfig().comment 为准（store 已内联该完整版）。
const NEW = store.defaultConfig().comment;

test('mergeDefaults: 旧短版 comment 自动迁移为新完整版 (I)', () => {
  const out = store.mergeDefaults({ comment: OLD });
  assert.notEqual(out.comment, OLD);
  assert.equal(out.comment, NEW);
});

test('mergeDefaults: 空 comment 回退默认新完整版 (I)', () => {
  const out = store.mergeDefaults({ comment: '' });
  assert.equal(out.comment, NEW);
});

test('mergeDefaults: 未提供 comment 使用默认新完整版 (I)', () => {
  const out = store.mergeDefaults({});
  assert.equal(out.comment, NEW);
});

test('mergeDefaults: 其它自定义 comment 不被覆盖 (I)', () => {
  const custom = '这是我自己的置顶评论，请勿改动';
  const out = store.mergeDefaults({ comment: custom });
  assert.equal(out.comment, custom);
});

test('mergeDefaults: seasonId/sectionId 空串保持空串（不回退默认值）', () => {
  const out = store.mergeDefaults({ seasonId: '', sectionId: '' });
  assert.equal(out.seasonId, '');
  assert.equal(out.sectionId, '');
});

test('mergeDefaults: 缺失 seasonId/sectionId 回退默认空串（安全性修正，不回退硬编码开发者合集）', () => {
  // #问题1 安全性修正：新装用户不配置时默认空串，禁止把视频加到开发者合集下。
  // 缺失（非 null）应回退到 defaultConfig() 的 ''，而非旧的 6918057/7630305。
  const out = store.mergeDefaults({});
  assert.equal(out.seasonId, '');
  assert.equal(out.sectionId, '');
});

test('mergeDefaults: 显式传 null 的 seasonId/sectionId 同样回退默认空串（不回退硬编码值）', () => {
  const out = store.mergeDefaults({ seasonId: null, sectionId: null });
  assert.equal(out.seasonId, '');
  assert.equal(out.sectionId, '');
});

test('mergeDefaults: 默认 defaultTags 为空串（需求②）', () => {
  const out = store.mergeDefaults({});
  assert.equal(out.defaultTags, '', 'defaultTags 默认应为空串');
});

test('mergeDefaults: defaultTags 字符串原样保留（需求②）', () => {
  const out = store.mergeDefaults({ defaultTags: '单机游戏,RPG' });
  assert.equal(out.defaultTags, '单机游戏,RPG');
});

test('mergeDefaults: defaultTags 非字符串回退默认空串（需求②）', () => {
  const out = store.mergeDefaults({ defaultTags: 123 });
  assert.equal(out.defaultTags, '');
});
