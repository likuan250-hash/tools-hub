// 客户端接力模块单测：探测、命令组装、dryRun 不真启动
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cb = require('../src/client-bridge');

test('detectClient: 候选路径里存在哪个就用哪个，都不存在返回空串', () => {
  const tmp = path.join(os.tmpdir(), 'xfer-client-test.exe');
  fs.writeFileSync(tmp, 'x');
  try {
    assert.strictEqual(cb.detectClient('baidu', ['C:\\not-exist-xxx.exe', tmp]), tmp);
    assert.strictEqual(cb.detectClient('baidu', ['C:\\not-exist-aaa.exe', 'C:\\not-exist-bbb.exe']), '');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('buildLaunch: 百度单参数、夸克 --single-argument，缺参数返回 null', () => {
  assert.deepStrictEqual(cb.buildLaunch('baidu', 'B.exe', 'https://pan.baidu.com/s/abc'), {
    exe: 'B.exe',
    args: ['https://pan.baidu.com/s/abc'],
  });
  assert.deepStrictEqual(cb.buildLaunch('quark', 'Q.exe', 'https://pan.quark.cn/s/abc'), {
    exe: 'Q.exe',
    args: ['--single-argument', 'https://pan.quark.cn/s/abc'],
  });
  assert.strictEqual(cb.buildLaunch('baidu', '', 'x'), null);
  assert.strictEqual(cb.buildLaunch('baidu', 'B.exe', ''), null);
});

test('launch: 默认 dryRun 不真启动；找不到客户端给明确原因', () => {
  const r = cb.launch('baidu', 'https://pan.baidu.com/s/abc');
  if (cb.detectClient('baidu')) {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.dryRun, true);
    assert.ok(!r.pid, 'dryRun 不应产生进程');
  } else {
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /未找到/);
  }
});

test('detectAllClients: 返回两端探测结果（本机应能探到已装客户端）', () => {
  const all = cb.detectAllClients();
  assert.ok(all && typeof all === 'object');
  assert.ok('baidu' in all && 'quark' in all);
  console.log('    探测结果:', JSON.stringify(all));
});
