// test/name.test.js —— NameResolver 单测（编号解析 / 构造 / 扫描 / 占位重试）
// 全部注入 fs 替身，不触碰真实磁盘，不依赖 E:\素材\ 是否存在。
const test = require('node:test');
const assert = require('node:assert/strict');
const { NameResolver, FOLDER_RE, MAX_RESERVE_ATTEMPTS } = require('../lib/name');

/**
 * 构造 fs 替身。
 * @param {{entries?: string[], exists?: boolean, onMkdir?: Function}} [opts]
 * @returns {object}
 */
function fakeFs(opts = {}) {
  const entries = opts.entries || [];
  return {
    calls: [],
    existsSync() { return opts.exists !== false; },
    readdirSync() {
      if (opts.readdirThrows) throw new Error('EACCES');
      return entries;
    },
    mkdirSync(p, o) {
      this.calls.push({ path: p, options: o });
      if (typeof opts.onMkdir === 'function') opts.onMkdir(p, o);
    },
  };
}

test('parseIndexFromFolder 解析【游戏NNN】前缀', () => {
  const r = new NameResolver({ fs: fakeFs() });
  assert.equal(r.parseIndexFromFolder('【游戏256】战神4'), 256);
  assert.equal(r.parseIndexFromFolder('【游戏007】Elden Ring'), 7);
  assert.equal(r.parseIndexFromFolder('【游戏1】x'), 1);
  assert.equal(r.parseIndexFromFolder('战神4'), null);
  assert.equal(r.parseIndexFromFolder('【游戏abc】x'), null);
  assert.equal(r.parseIndexFromFolder(''), null);
  assert.equal(r.parseIndexFromFolder(null), null);
  assert.ok(FOLDER_RE.test('【游戏256】战神4'));
});

test('buildFolderName 编号补零到 3 位并保留游戏名空格', () => {
  const r = new NameResolver({ fs: fakeFs() });
  assert.equal(r.buildFolderName(256, '战神4'), '【游戏256】战神4');
  assert.equal(r.buildFolderName(7, 'Elden Ring'), '【游戏007】Elden Ring');
  assert.equal(r.buildFolderName(1234, '大编号'), '【游戏1234】大编号');
  // 非法字符清洗为下划线，空格保留（文件夹名可读性）
  assert.equal(r.buildFolderName(3, 'Ratchet & Clank: Rift Apart'), '【游戏003】Ratchet & Clank_ Rift Apart');
  // 非法编号回退 0
  assert.equal(r.buildFolderName(NaN, 'x'), '【游戏000】x');
});

test('scanMaxIndex 取最大编号，异常/空目录回 0', () => {
  const r1 = new NameResolver({ fs: fakeFs({ entries: ['【游戏010】a', '【游戏255】b', '杂项', '【游戏099】c'] }) });
  assert.equal(r1.scanMaxIndex('E:\\素材\\'), 255);

  const r2 = new NameResolver({ fs: fakeFs({ entries: [] }) });
  assert.equal(r2.scanMaxIndex('E:\\素材\\'), 0);

  const r3 = new NameResolver({ fs: fakeFs({ exists: false }) });
  assert.equal(r3.scanMaxIndex('E:\\素材\\'), 0);

  const r4 = new NameResolver({ fs: fakeFs({ readdirThrows: true }) });
  assert.equal(r4.scanMaxIndex('E:\\素材\\'), 0);
});

test('nextIndex = 最大编号 + 1', () => {
  const r = new NameResolver({ fs: fakeFs({ entries: ['【游戏255】b'] }) });
  assert.equal(r.nextIndex('E:\\素材\\'), 256);

  const empty = new NameResolver({ fs: fakeFs({ entries: [] }) });
  assert.equal(empty.nextIndex('E:\\素材\\'), 1);
});

test('ensureOutputDir 走 mkdir -p（裁定④：输出目录不存在自动创建）', () => {
  const fs = fakeFs();
  const r = new NameResolver({ fs });
  r.ensureOutputDir('E:\\素材\\');
  assert.equal(fs.calls.length, 1);
  assert.deepEqual(fs.calls[0].options, { recursive: true });
});

test('reserveFolder EEXIST 时编号 +1 重试（裁定⑤）', () => {
  const fs = fakeFs({
    entries: ['【游戏010】旧'],
    onMkdir(p, o) {
      if (o && o.recursive) return;            // ensureOutputDir 放行
      if (/【游戏011】/.test(p) || /【游戏012】/.test(p)) {
        const e = new Error('EEXIST');
        e.code = 'EEXIST';
        throw e;
      }
    },
  });
  const r = new NameResolver({ fs });
  const res = r.reserveFolder('E:\\素材\\', '战神4');
  assert.equal(res.index, 13);
  assert.equal(res.folderName, '【游戏013】战神4');
  assert.ok(res.folder.includes('【游戏013】战神4'));
  // 首次 mkdir 是 ensureOutputDir，其后是三次占位尝试
  assert.equal(fs.calls.length, 4);
  assert.deepEqual(fs.calls[0].options, { recursive: true });
  assert.equal(fs.calls[1].options, undefined);
});

test('reserveFolder 支持外部传入 startIndex', () => {
  const fs = fakeFs({ entries: [] });
  const r = new NameResolver({ fs });
  const res = r.reserveFolder('E:\\素材\\', '黑神话悟空', { startIndex: 300 });
  assert.equal(res.index, 300);
  assert.equal(res.folderName, '【游戏300】黑神话悟空');
});

test('reserveFolder 重试耗尽抛 ERESERVE，非 EEXIST 错误直接冒泡', () => {
  const alwaysExist = fakeFs({
    entries: [],
    onMkdir(p, o) {
      if (o && o.recursive) return;
      const e = new Error('EEXIST');
      e.code = 'EEXIST';
      throw e;
    },
  });
  const r1 = new NameResolver({ fs: alwaysExist });
  assert.throws(() => r1.reserveFolder('E:\\素材\\', 'x'), (e) => e.code === 'ERESERVE');
  // ensureOutputDir 1 次 + 占位 MAX_RESERVE_ATTEMPTS 次
  assert.equal(alwaysExist.calls.length, MAX_RESERVE_ATTEMPTS + 1);

  const denied = fakeFs({
    entries: [],
    onMkdir(p, o) {
      if (o && o.recursive) return;
      const e = new Error('EPERM');
      e.code = 'EPERM';
      throw e;
    },
  });
  const r2 = new NameResolver({ fs: denied });
  assert.throws(() => r2.reserveFolder('E:\\素材\\', 'x'), (e) => e.code === 'EPERM');
});
