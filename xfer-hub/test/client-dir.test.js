// 客户端下载目录探测单测（不依赖真实客户端：注入配置目录/注册表读取）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cd = require('../src/client-dir');

function tmpDir(name) {
  const d = path.join(os.tmpdir(), 'xfer-cdir-' + name + '-' + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

test('extractPaths: 从 JSON/INI 文本里抽含 download/save 的路径，并还原转义', () => {
  const json = JSON.stringify({ downloadPath: 'E:\\网盘中转\\dl' });
  assert.deepStrictEqual(cd.extractPaths(json), ['E:\\网盘中转\\dl']);
  assert.deepStrictEqual(cd.extractPaths('savepath="C:/Users/x/Downloads"'), ['C:\\Users\\x\\Downloads']);
  assert.deepStrictEqual(cd.extractPaths('nothing here'), []);
});

test('scanConfigDirs: 命中真实存在的目录就返回，不存在则继续找下一个', () => {
  const cfg = tmpDir('cfg');
  const real = tmpDir('real');
  fs.writeFileSync(path.join(cfg, 'a.json'), JSON.stringify({ downloadPath: 'C:\\not-exist-zzz' }), 'utf8');
  fs.writeFileSync(path.join(cfg, 'b.json'), JSON.stringify({ downloadPath: real }), 'utf8');
  assert.strictEqual(cd.scanConfigDirs([cfg]), real);
  assert.strictEqual(cd.scanConfigDirs(['C:\\no-such-dir-xyz']), '');
});

test('detectDownloadDir: 配置里读到就用配置（不碰注册表）', () => {
  const cfg = tmpDir('baidu-cfg');
  const real = tmpDir('baidu-dl');
  fs.writeFileSync(path.join(cfg, 'conf.json'), JSON.stringify({ downloadPath: real }), 'utf8');
  let regCalled = 0;
  const got = cd.detectDownloadDir('baidu', {
    env: { APPDATA: path.dirname(cfg), LOCALAPPDATA: '', USERPROFILE: '' },
    scan: (roots) => cd.scanConfigDirs([path.join(path.dirname(cfg), path.basename(cfg))]),
    reg: () => { regCalled += 1; return ''; },
  });
  assert.strictEqual(got, real);
  assert.strictEqual(regCalled, 0, '配置命中就不该再读注册表');
});

test('detectDownloadDir: 配置读不到 → 回退注册表；都没有 → 空串', () => {
  const realReg = tmpDir('reg-dl');
  assert.strictEqual(
    cd.detectDownloadDir('quark', { env: {}, scan: () => '', reg: () => realReg }),
    realReg
  );
  assert.strictEqual(cd.detectDownloadDir('baidu', { env: {}, scan: () => '', reg: () => '' }), '');
});

test('localPathFor: 带顶层文件夹时去掉重复层，散文件时直接拼', () => {
  assert.strictEqual(
    cd.localPathFor('E:\\下载', '先发制人', '先发制人/part01.rar'),
    path.join('E:\\下载', 'part01.rar')
  );
  assert.strictEqual(
    cd.localPathFor('E:\\下载', '', 'part01.rar'),
    path.join('E:\\下载', 'part01.rar')
  );
  assert.strictEqual(
    cd.localPathFor('E:\\下载', 'X', 'X/子目录/a.bin'),
    path.join('E:\\下载', '子目录', 'a.bin')
  );
});

test('fallbackDownloadDir: 常见目录里挑第一个存在的', () => {
  const d = tmpDir('fallback');
  assert.strictEqual(cd.fallbackDownloadDir({ USERPROFILE: d }), '', '临时目录下没有 Downloads/下载/Desktop 时返回空串');
  fs.mkdirSync(path.join(d, 'Downloads'), { recursive: true });
  assert.strictEqual(cd.fallbackDownloadDir({ USERPROFILE: d }), path.join(d, 'Downloads'));
});
