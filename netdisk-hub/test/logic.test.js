// netdisk-hub 纯逻辑测试：百度脏 cookie 清理 + 夸克分享有效期映射
const baidu = require('../src/baidu');
const quark = require('../src/quark');
const { test } = require('node:test');
const assert = require('node:assert');

test('baidu.parseCleanCookie 过滤空 key / undefined value 并正确重组', () => {
  const jar = baidu.parseCleanCookie(' BDUSS =abc; =novalue; STOKEN=undefined ; BAIDUID=ok;;  ');
  assert.strictEqual(jar['BDUSS'], 'abc');
  assert.strictEqual(jar['STOKEN'], undefined, 'undefined value 应被过滤');
  assert.strictEqual(jar['BAIDUID'], 'ok');
  assert.strictEqual(jar[''], undefined, '空 key 不应进入 jar');
  // 重组后的 header 不应残留 undefined
  const header = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  assert.ok(header.includes('BDUSS=abc'));
  assert.ok(!header.includes('undefined'));
});

test('baidu.parseCleanCookie 空/未定义输入返回空对象', () => {
  assert.deepStrictEqual(baidu.parseCleanCookie(''), {});
  assert.deepStrictEqual(baidu.parseCleanCookie(undefined), {});
  assert.deepStrictEqual(baidu.parseCleanCookie(null), {});
});

test('quark.mapExpiredType 映射正确', () => {
  assert.strictEqual(quark.mapExpiredType(0), 1, '0=永久→1');
  assert.strictEqual(quark.mapExpiredType(undefined), 1, '缺省→1');
  assert.strictEqual(quark.mapExpiredType(1), 2);
  assert.strictEqual(quark.mapExpiredType(7), 3);
  assert.strictEqual(quark.mapExpiredType(30), 4);
  assert.strictEqual(quark.mapExpiredType(99), 1, '未知档位回退永久→1');
});
