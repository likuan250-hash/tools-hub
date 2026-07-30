// parsers.test.js — 网盘分享链接解析函数单元测试（纯函数，无需网络/浏览器）
// 运行：node --test  （CI 中由 build.yml 出包门禁调用）
const test = require('node:test');
const assert = require('node:assert');

// 注意：xunlei.js 已改为「懒加载 playwright」，故此处 require 不会触发浏览器依赖，
// 即使 netdisk-hub 未安装 playwright 也能跑（提升单测可用性 + 启动速度）。
const baidu = require('../src/baidu');
const quark = require('../src/quark');
const xunlei = require('../src/xunlei');

test('baidu.parseSurl: 提取 ?surl= 参数', () => {
  assert.strictEqual(baidu.parseSurl('?surl=abc123'), 'abc123');
});

test('baidu.parseSurl: 提取 pan.baidu.com/s/ 路径', () => {
  assert.strictEqual(baidu.parseSurl('https://pan.baidu.com/s/abc123'), 'abc123');
  assert.strictEqual(baidu.parseSurl('https://pan.baidu.com/s/abc123?pwd=8888'), 'abc123');
});

test('baidu.parseSurl: 无匹配时原样返回（含空串）', () => {
  assert.strictEqual(baidu.parseSurl(''), '');
  assert.strictEqual(baidu.parseSurl('   '), '');
  assert.strictEqual(baidu.parseSurl('https://pan.xunlei.com/s/ZZZ'), 'https://pan.xunlei.com/s/ZZZ');
});

test('baidu.parseSurl: 去首尾空白', () => {
  assert.strictEqual(baidu.parseSurl('  https://pan.baidu.com/s/xyz  '), 'xyz');
});

test('quark.parseLink: 完整链接带提取码', () => {
  assert.deepStrictEqual(quark.parseLink('https://pan.quark.cn/s/def456?pwd=abc'), {
    pwdId: 'def456',
    passcode: 'abc',
  });
});

test('quark.parseLink: 无提取码', () => {
  assert.deepStrictEqual(quark.parseLink('https://pan.quark.cn/s/def456'), {
    pwdId: 'def456',
    passcode: '',
  });
});

test('quark.parseLink: 提取码 URL 解码', () => {
  assert.strictEqual(quark.parseLink('https://pan.quark.cn/s/def456?pwd=a%20b').passcode, 'a b');
});

test('quark.parseLink: 无匹配时 pwdId 取原串、passcode 空', () => {
  assert.deepStrictEqual(quark.parseLink(''), { pwdId: '', passcode: '' });
  assert.deepStrictEqual(quark.parseLink('not-a-link'), { pwdId: 'not-a-link', passcode: '' });
});

test('xunlei.parseSurl: 完整链接去除提取码参数', () => {
  assert.strictEqual(xunlei.parseSurl('https://pan.xunlei.com/s/ABC123?pwd=xyz'), 'https://pan.xunlei.com/s/ABC123');
});

test('xunlei.parseSurl: ?s= 参数归一化为标准链接', () => {
  assert.strictEqual(xunlei.parseSurl('?s=ABC123'), 'https://pan.xunlei.com/s/ABC123');
});

test('xunlei.parseSurl: 裸 ID 补全为标准链接', () => {
  assert.strictEqual(xunlei.parseSurl('ABC123'), 'https://pan.xunlei.com/s/ABC123');
});

test('xunlei.parseSurl: 非分享链接原样返回（含空串）', () => {
  assert.strictEqual(xunlei.parseSurl(''), '');
  assert.strictEqual(xunlei.parseSurl('https://example.com/foo'), 'https://example.com/foo');
});

test('三个解析模块均可在无 playwright 依赖下加载', () => {
  assert.strictEqual(typeof baidu.parseSurl, 'function');
  assert.strictEqual(typeof quark.parseLink, 'function');
  assert.strictEqual(typeof xunlei.parseSurl, 'function');
});
