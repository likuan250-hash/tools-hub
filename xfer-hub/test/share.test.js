// xfer-hub 分享链接解析单测（纯函数，不联网）
// 覆盖：网盘识别、提取码抽取（链接参数/中文文案）、从粘贴文案里剥离纯 URL
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { detectProvider, extractPwd, extractUrl } = require('../src/share');

test('detectProvider: 识别百度/夸克/迅雷，其它返回 null', () => {
  assert.strictEqual(detectProvider('https://pan.baidu.com/s/1abc?pwd=abcd'), 'baidu');
  assert.strictEqual(detectProvider('https://pan.quark.cn/s/f4330f55c78b'), 'quark');
  assert.strictEqual(detectProvider('https://pan.xunlei.com/s/VOv58YerX3QLQRgSvDgKnKqVA1#'), 'xunlei');
  assert.strictEqual(detectProvider('https://example.com/xxx'), null);
  assert.strictEqual(detectProvider(''), null);
});

test('extractPwd: 支持 ?pwd= / 提取码： / 密码 ', () => {
  assert.strictEqual(extractPwd('https://pan.baidu.com/s/1abc?pwd=k2ks'), 'k2ks');
  assert.strictEqual(extractPwd('链接: https://pan.baidu.com/s/1abc 提取码: 37d7'), '37d7');
  assert.strictEqual(extractPwd('密码：abcd'), 'abcd');
  assert.strictEqual(extractPwd('https://pan.quark.cn/s/f4330f55c78b'), '');
});

test('extractUrl: 从整段分享文案里剥离纯 URL，只给片段时保留片段', () => {
  assert.strictEqual(
    extractUrl('链接: https://pan.baidu.com/s/12u8z8E_upW1EqpwA2ELT3Q?pwd=k2ks 提取码: k2ks'),
    'https://pan.baidu.com/s/12u8z8E_upW1EqpwA2ELT3Q?pwd=k2ks'
  );
  assert.strictEqual(extractUrl('/s/1abcdefg'), '/s/1abcdefg');
  assert.strictEqual(extractUrl('  https://pan.quark.cn/s/f4330f55c78b  '), 'https://pan.quark.cn/s/f4330f55c78b');
});

test('prefs: 默认目标目录存在，且数据目录受 XFER_DATA_DIR 控制', () => {
  const dir = path.join(require('os').tmpdir(), 'xfer-prefs-test');
  process.env.XFER_DATA_DIR = dir;
  delete require.cache[require.resolve('../src/prefs')];
  const prefs = require('../src/prefs');
  assert.ok(prefs.DEFAULTS && typeof prefs.DEFAULTS === 'object', '应有 DEFAULTS');
  assert.ok(prefs.prefsPath().startsWith(dir), 'prefsPath 应落在 XFER_DATA_DIR 下');
});
