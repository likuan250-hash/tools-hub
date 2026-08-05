// biliup-hub/test/crypto.test.js —— 凭证加密模块测试
// 覆盖：加密/解密往返、cookies 新旧格式兼容、login_info 加密读取、
// materializeLoginInfo 临时明文生命周期（写入 + cleanup 删除）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const secret = require('../lib/crypto');
const cookies = require('../lib/cookies');
const auth = require('../lib/auth');

function tmpFile(prefix) {
  return path.join(os.tmpdir(), `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
}

test('crypto: encryptObj/decryptObj 往返一致', () => {
  const obj = { SESSDATA: 'sess', bili_jct: 'jct', nested: { a: [1, 2, 3] } };
  const blob = secret.encryptObj(obj);
  assert.equal(secret.isEncrypted(blob), true);
  assert.equal(blob.v, 1);
  // 密文不应出现明文键名
  assert.ok(!JSON.stringify(blob).includes('SESSDATA'));
  assert.deepEqual(secret.decryptObj(blob), obj);
});

test('cookies.save 加密落盘；cookies.load 可解密；明文旧文件仍可读', () => {
  const p = tmpFile('biliup_crypto_cookies');
  cookies.save(p, { SESSDATA: 'a', bili_jct: 'b' });
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(!raw.includes('SESSDATA'), '落盘不应含明文键名');
  assert.deepEqual(cookies.load(p), { SESSDATA: 'a', bili_jct: 'b' });

  // 旧版明文（含浏览器导出的数组形态）仍兼容
  const legacy = tmpFile('biliup_crypto_legacy');
  fs.writeFileSync(legacy, JSON.stringify([{ name: 'SESSDATA', value: 'x' }, { name: 'bili_jct', value: 'y' }]));
  assert.deepEqual(cookies.load(legacy), { SESSDATA: 'x', bili_jct: 'y' });
  assert.equal(cookies.checkFile(legacy).ok, true);
  fs.unlinkSync(p);
  fs.unlinkSync(legacy);
});

test('auth.saveLoginInfo 加密；loadLoginInfo 兼容加密与明文', () => {
  const p = tmpFile('biliup_crypto_li');
  const li = { cookie_info: { cookies: [{ name: 'SESSDATA', value: 's' }] }, token_info: { access_token: 'AT' } };
  auth.saveLoginInfo(li, { path: p });
  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(!raw.includes('access_token'), 'login_info.json 不应含明文 token');
  assert.deepEqual(auth.loadLoginInfo(p), li);

  // 旧版明文兼容
  const legacy = tmpFile('biliup_crypto_li_legacy');
  fs.writeFileSync(legacy, JSON.stringify(li));
  assert.deepEqual(auth.loadLoginInfo(legacy), li);
  fs.unlinkSync(p);
  fs.unlinkSync(legacy);
});

test('auth.materializeLoginInfo: 解密到临时明文文件，cleanup 后删除', () => {
  const p = tmpFile('biliup_crypto_mat');
  const li = { cookie_info: {}, token_info: { access_token: 'TEMP_AT', refresh_token: 'RT' } };
  auth.saveLoginInfo(li, { path: p });
  const m = auth.materializeLoginInfo(p);
  assert.ok(fs.existsSync(m.path), '临时明文文件应存在');
  const tmp = JSON.parse(fs.readFileSync(m.path, 'utf8'));
  assert.equal(tmp.token_info.access_token, 'TEMP_AT');
  m.cleanup();
  assert.equal(fs.existsSync(m.path), false, 'cleanup 后临时文件应删除');
  fs.unlinkSync(p);
});

test('auth.materializeLoginInfo: login_info 缺失 → 抛清晰错误', () => {
  assert.throws(
    () => auth.materializeLoginInfo(path.join(os.tmpdir(), 'nope_' + Date.now() + '.json')),
    /无法读取或不存在/
  );
});
