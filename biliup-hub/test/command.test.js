// biliup-hub/test/command.test.js —— command.js 单测（K：@chcp 语法回归）
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPs1, buildBat } = require('../lib/command');

const cfg = {
  biliupExePath: 'C:\\tools\\biliup.exe',
  tid: 17,
  copyright: 1,
  noReprint: 1,
  line: 'bda2',
  cookiesPath: 'C:\\cookies.json',
};
const req = {
  videoPath: 'C:\\v.mp4',
  title: '标题',
  tags: ['a', 'b'],
  desc: '简介',
  publishMode: 'now',
  dtime: 0,
};

test('buildPs1 不应包含 @chcp（K：cmd 语法写在 .ps1 会被 PowerShell 当 splatting 报错）', () => {
  const { content, shell } = buildPs1(req, cfg, null);
  assert.equal(shell, 'ps1');
  // 关键回归断言：不能把 @chcp 65001 写进 ps1。
  assert.doesNotMatch(content, /@chcp/i);
  // 仍应正常生成 biliup 调用。
  assert.match(content, /&/);
  assert.match(content, /biliup\.exe/);
});

test('buildPs1 多行 desc 仍用 `n 转义且不含 @chcp', () => {
  const { content } = buildPs1({ ...req, desc: '行1\n行2' }, cfg, null);
  assert.doesNotMatch(content, /@chcp/i);
  assert.match(content, /`n/);
});

test('buildBat 不写 @chcp 也正常生成', () => {
  const { content, shell } = buildBat(req, cfg, null);
  assert.equal(shell, 'bat');
  assert.doesNotMatch(content, /@chcp/i);
  assert.match(content, /biliup\.exe/);
});
