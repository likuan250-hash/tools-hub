// test/command.test.js —— command.js 单测
// 断言 ps1 内容 / 转义 / utf-8-sig（坑点1/2/3）；bat 兜底转义。
// 不依赖真实 biliup / powershell / 网络。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const command = require('../lib/command');

const BASE_CFG = {
  biliupExePath: 'D:\\biliupR\\biliup.exe',
  tid: 17,
  copyright: 1,
  noReprint: 1,
  line: 'bda2',
  cookiesPath: 'D:\\biliupR\\cookies.json',
  tags: [],
};

test('buildPs1: 头部 @chcp 65001 + 调用符 &', () => {
  const req = { videoPath: 'C:\\v.mp4', title: 't', tags: ['a', 'b'], desc: 'd', publishMode: 'now' };
  const s = command.buildPs1(req, BASE_CFG, null);
  assert.strictEqual(s.shell, 'ps1');
  assert.match(s.content, /@chcp 65001 >nul/);
  assert.match(s.content, /& "[^"]*biliup\.exe"/);
  assert.match(s.content, /--video-file "C:\\v\.mp4"/);
  assert.match(s.content, /--tag "a" --tag "b"/);
});

test('buildPs1: 双引号用反引号转义', () => {
  const req = { videoPath: 'C:\\v.mp4', title: '他说"你好"', tags: [], desc: 'x', publishMode: 'now' };
  const s = command.buildPs1(req, BASE_CFG, null);
  assert.ok(s.content.includes('他说`"你好`"'), '标题内双引号应转义为 `"');
});

test('buildPs1: 多行 desc 用 `n 拼接', () => {
  const req = { videoPath: 'C:\\v.mp4', title: 't', tags: [], desc: '行1\n行2\n行3', publishMode: 'now' };
  const s = command.buildPs1(req, BASE_CFG, null);
  assert.ok(s.content.includes('行1`n行2`n行3'), '多行 desc 应转 `n');
});

test('buildPs1: dtime 仅定时模式注入', () => {
  const now = command.buildPs1({ videoPath: 'v', title: 't', tags: [], desc: 'd', publishMode: 'now' }, BASE_CFG, null);
  assert.ok(!/--dtime/.test(now.content), '立即发布不应含 --dtime');
  const dt = command.buildPs1({ videoPath: 'v', title: 't', tags: [], desc: 'd', publishMode: 'dtime', dtime: 1700000000 }, BASE_CFG, null);
  assert.match(dt.content, /--dtime 1700000000/, '定时发布应含 --dtime');
});

test('buildPs1: 有封面时注入 --cover', () => {
  const s = command.buildPs1({ videoPath: 'v', title: 't', tags: [], desc: 'd', publishMode: 'now' }, BASE_CFG, 'C:\\cover.png');
  assert.match(s.content, /--cover "C:\\cover\.png"/);
});

test('writeTempScript: 写入 utf-8-sig（BOM）', () => {
  const s = command.buildPs1({ videoPath: 'v', title: 't', tags: [], desc: 'd', publishMode: 'now' }, BASE_CFG, null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biliup-cmd-'));
  const p = command.writeTempScript(s, dir);
  const buf = fs.readFileSync(p);
  assert.strictEqual(buf[0], 0xEF);
  assert.strictEqual(buf[1], 0xBB);
  assert.strictEqual(buf[2], 0xBF);
  fs.unlinkSync(p);
  fs.rmdirSync(dir);
});

test('buildBat: 双引号用 "" 转义，且无反引号', () => {
  const req = { videoPath: 'C:\\v.mp4', title: '他说"你好"', tags: [], desc: '单行', publishMode: 'now' };
  const s = command.buildBat(req, BASE_CFG, null);
  assert.strictEqual(s.shell, 'bat');
  assert.ok(s.content.includes('他说""你好"'), 'bat 双引号应转义为 ""');
  assert.ok(!s.content.includes('`'), 'bat 不应含反引号');
});

test('buildBat: desc 含多行时回退 ps1', () => {
  const req = { videoPath: 'v', title: 't', tags: [], desc: 'a\nb', publishMode: 'now' };
  const s = command.buildBat(req, BASE_CFG, null);
  assert.strictEqual(s.shell, 'ps1', '多行 desc 应回退 ps1');
});
