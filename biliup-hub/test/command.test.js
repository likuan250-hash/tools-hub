// biliup-hub/test/command.test.js —— command.js 单测
// 覆盖：@chcp 语法回归 + biliup-cli v0.2.4 实参语法（buildArgs）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildArgs, buildPs1, buildBat } = require('../lib/command');

const cfg = {
  biliupExePath: 'C:\\tools\\biliup.exe',
  tid: 17,
  copyright: 1,
  noReprint: 1,
  line: 'bda2',
  cookiesPath: 'C:\\cookies.json',
  loginInfoPath: 'C:\\login_info.json',
};
const req = {
  videoPath: 'C:\\v.mp4',
  title: '标题',
  tags: ['a', 'b'],
  desc: '简介',
  publishMode: 'now',
  dtime: 0,
};

// ── @chcp 语法回归（K）──
test('buildPs1 不应包含 @chcp（K：cmd 语法写在 .ps1 会被 PowerShell 当 splatting 报错）', () => {
  const { content, shell } = buildPs1(req, cfg, null);
  assert.equal(shell, 'ps1');
  assert.doesNotMatch(content, /@chcp/i);
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

// ── v0.2.4 实参语法（buildArgs）──
test('buildArgs: 全局 -u 放在 upload 之前，且指向 loginInfoPath', () => {
  const args = buildArgs(req, cfg, null);
  assert.equal(args[0], '-u');
  assert.equal(args[1], '"C:\\login_info.json"');
  assert.equal(args[2], 'upload');
});

test('buildArgs: 视频文件是 upload 之后的位置参数（末位），且无 --video-file / --cookies', () => {
  const args = buildArgs(req, cfg, null);
  // 末位必须是视频路径（位置参数）。
  assert.equal(args[args.length - 1], '"C:\\v.mp4"');
  assert.doesNotMatch(args.join(' '), /--video-file/);
  assert.doesNotMatch(args.join(' '), /--cookies/);
});

test('buildArgs: --tag 合并成单个逗号分隔值（非逐个 -t）', () => {
  const args = buildArgs(req, cfg, null);
  const tagIdx = args.indexOf('--tag');
  assert.ok(tagIdx > 0, '应存在 --tag');
  // 紧随 --tag 的应是 "a,b" 单值。
  assert.equal(args[tagIdx + 1], '"a,b"');
  // 整个数组里 --tag 只能出现一次。
  const tagCount = args.filter((a) => a === '--tag').length;
  assert.equal(tagCount, 1);
});

test('buildArgs: 保留真实 flag（--title/--tid/--copyright/--no-reprint/--line/--desc/--cover）', () => {
  const args = buildArgs(req, cfg, 'C:\\cover.png');
  assert.ok(args.includes('--title'));
  assert.ok(args.includes('--tid'));
  assert.ok(args.includes('--copyright'));
  assert.ok(args.includes('--no-reprint'));
  assert.ok(args.includes('--line'));
  assert.ok(args.includes('--desc'));
  assert.ok(args.includes('--cover'));
  // tid 紧随其后的值应为 17（字符串化）。
  assert.equal(args[args.indexOf('--tid') + 1], '17');
});

test('buildArgs: --dtime 仅在 dtime 模式出现', () => {
  const nowArgs = buildArgs({ ...req, publishMode: 'now' }, cfg, null);
  assert.ok(!nowArgs.includes('--dtime'), 'now 模式不应有 --dtime');
  const dtimeArgs = buildArgs({ ...req, publishMode: 'dtime', dtime: 1700000000 }, cfg, null);
  assert.ok(dtimeArgs.includes('--dtime'));
  assert.equal(dtimeArgs[dtimeArgs.indexOf('--dtime') + 1], '1700000000');
});

test('buildArgs: req.tags 为空时回落 cfg.tags 并合并为 --tag 单值', () => {
  const cfgWithTags = { ...cfg, tags: ['x', 'y'] };
  const args = buildArgs({ ...req, tags: [] }, cfgWithTags, null);
  const tagIdx = args.indexOf('--tag');
  assert.ok(tagIdx > 0, '应存在 --tag（来自 cfg.tags 回落）');
  assert.equal(args[tagIdx + 1], '"x,y"');
  const tagCount = args.filter((a) => a === '--tag').length;
  assert.equal(tagCount, 1);
});

test('buildPs1 内容：顺序为 exe -u upload ...flags... video（位置参数在末位）', () => {
  const { content } = buildPs1(req, cfg, null);
  // 全局 -u 在 upload 之前。
  assert.ok(content.indexOf('-u') < content.indexOf('upload'), '-u 应在 upload 之前');
  // 视频路径出现在 upload 之后。
  assert.ok(content.indexOf('upload') < content.indexOf('"C:\\v.mp4"'), 'video 应在 upload 之后');
  // 不应再出现非法 flag。
  assert.doesNotMatch(content, /--video-file/);
  assert.doesNotMatch(content, /--cookies/);
});
