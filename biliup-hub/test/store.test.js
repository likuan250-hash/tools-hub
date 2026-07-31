// test/store.test.js —— store.js 单测（默认配置 / 合并兜底）
// 覆盖：comment 默认话术（#E 新版完整引流话术）、关键默认值、缺失字段兜底。
const test = require('node:test');
const assert = require('node:assert');
const store = require('../lib/store');

test('defaultConfig: comment 为新版完整引流话术（含 [表情名] 语法，非 Unicode emoji）', () => {
  const cfg = store.defaultConfig();
  assert.strictEqual(
    cfg.comment,
    '老规矩！！！三[打call]连后关[调皮]注或者私[喜欢][喜欢]信一下就会自动回复（去看私信哦）会有下载方式哦！！'
  );
  // 确保仍使用 B站评论表情语法，而不是被替换成 Unicode emoji。
  assert.ok(cfg.comment.includes('[打call]'), '应保留 [打call] 表情语法');
  assert.ok(cfg.comment.includes('[调皮]'), '应保留 [调皮] 表情语法');
  assert.ok(cfg.comment.includes('[喜欢]'), '应保留 [喜欢] 表情语法');
});

test('defaultConfig: 关键默认值符合 PRD（tid=17/line=bda2/copyright/noReprint/uid）', () => {
  const cfg = store.defaultConfig();
  assert.strictEqual(cfg.tid, 17);
  assert.strictEqual(cfg.line, 'bda2');
  assert.strictEqual(cfg.copyright, 1);
  assert.strictEqual(cfg.noReprint, 1);
  assert.strictEqual(cfg.uid, 236743002);
  assert.strictEqual(cfg.seasonId, '6918057');
  assert.strictEqual(cfg.sectionId, '7630305');
});

test('mergeDefaults: 缺失 comment 兜底为默认话术', () => {
  const out = store.mergeDefaults({});
  assert.ok(typeof out.comment === 'string' && out.comment.length > 0, 'comment 应兜底为默认话术');
});

test('mergeDefaults: 保留用户已设 comment', () => {
  const out = store.mergeDefaults({ comment: '自定义置顶话术' });
  assert.strictEqual(out.comment, '自定义置顶话术');
});
