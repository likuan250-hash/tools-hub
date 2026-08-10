// lib/pendingVideos.js —— 待发布清单单测（临时文件）
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const pendingVideos = require('../lib/pendingVideos');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'biliup-pv-'));
const FILE = path.join(TMP, 'pending_videos.json');

test('add/update/remove/clearDone：基础 CRUD 与完成判定', () => {
  const a = pendingVideos.add('零.红蝶.重制版', { file: FILE });
  assert.ok(a && a.id);
  assert.strictEqual(pendingVideos.add('零.红蝶.重制版', { file: FILE }), null, '同名去重');
  assert.strictEqual(pendingVideos.add('  ', { file: FILE }), null, '空名拒绝');
  pendingVideos.update(a.id, { hasResource: true }, { file: FILE });
  pendingVideos.update(a.id, { published: true }, { file: FILE });
  let list = pendingVideos.load({ file: FILE });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].hasResource && list[0].published, true);
  assert.strictEqual(pendingVideos.clearDone({ file: FILE }), 1);
  assert.strictEqual(pendingVideos.load({ file: FILE }).length, 0);
  pendingVideos.remove(a.id, { file: FILE }); // 幂等不报错
});

test('markPublishedByTitle：归一化前缀后按包含匹配', () => {
  pendingVideos.add('【游戏272】零.红蝶', { file: FILE });
  pendingVideos.add('战争机器：重装上阵', { file: FILE });
  pendingVideos.add('短', { file: FILE }); // 短名不应误伤
  const n1 = pendingVideos.markPublishedByTitle('【游戏272】零.红蝶.重制版 官方中文+全DLC 免费学习版下载', { file: FILE });
  assert.strictEqual(n1, 1, '应标记 零.红蝶 一条');
  const list = pendingVideos.load({ file: FILE });
  assert.strictEqual(list.find((x) => x.name.includes('零.红蝶')).published, true);
  assert.strictEqual(list.find((x) => x.name.includes('战争机器')).published, false);
  assert.strictEqual(list.find((x) => x.name === '短').published, false, '短名不应被包含匹配误伤');
  // 再次投稿同名：不重复标记
  assert.strictEqual(pendingVideos.markPublishedByTitle('【游戏272】零.红蝶.重制版', { file: FILE }), 0);
});

test('normalizeTitle：去掉【游戏NNN】前缀与空白', () => {
  assert.strictEqual(pendingVideos.normalizeTitle('【游戏272】零.红蝶'), '零.红蝶');
  assert.strictEqual(pendingVideos.normalizeTitle('  战争机器  '), '战争机器');
});

test('add/update：支持待发布日期与预勾状态', () => {
  const a = pendingVideos.add('幽灵行动：荒野', {
    file: FILE,
    publishDate: '2026-08-15',
    hasResource: true,
    published: false,
  });
  assert.ok(a);
  assert.strictEqual(a.publishDate, '2026-08-15');
  assert.strictEqual(a.hasResource, true);
  assert.strictEqual(a.published, false);
  const u = pendingVideos.update(a.id, { publishDate: '2026-08-18', published: true }, { file: FILE });
  assert.strictEqual(u.publishDate, '2026-08-18');
  assert.strictEqual(u.published, true);
  pendingVideos.remove(a.id, { file: FILE });
});
