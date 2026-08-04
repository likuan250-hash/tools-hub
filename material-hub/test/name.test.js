// test/name.test.js —— NameResolver 单测（编号解析 / 构造 / 扫描 / 占位重试）
// 全部注入 fs 替身，不触碰真实磁盘，不依赖 E:\素材\ 是否存在。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
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

// ─────────────────── Bug A 回归：同名游戏不得重复建文件夹 ───────────────────
// 现场表现：连点「运行」产出 【游戏268】正当防卫4 / 【游戏269】正当防卫4 / 【游戏270】正当防卫4。
// 规范《完整流程》第 2 步：已存在 → 跳过创建，直接进入下一步。

test('parseGameNameFromFolder 剥离【游戏NNN】前缀取游戏名', () => {
  const r = new NameResolver({ fs: fakeFs() });
  assert.equal(r.parseGameNameFromFolder('【游戏268】正当防卫4'), '正当防卫4');
  assert.equal(r.parseGameNameFromFolder('【游戏007】Elden Ring'), 'Elden Ring');
  assert.equal(r.parseGameNameFromFolder('杂项'), null);
  assert.equal(r.parseGameNameFromFolder(null), null);
});

test('normalizeGameName 忽略大小写/空白/中英标点差异', () => {
  const r = new NameResolver({ fs: fakeFs() });
  assert.equal(r.normalizeGameName('正当防卫 4'), r.normalizeGameName('正当防卫4'));
  assert.equal(r.normalizeGameName('Elden Ring'), r.normalizeGameName('elden  ring'));
  assert.equal(r.normalizeGameName('黑神话：悟空'), r.normalizeGameName('黑神话:悟空'));
  assert.equal(r.normalizeGameName('Ratchet—Clank'), r.normalizeGameName('Ratchet-Clank'));
  assert.equal(r.normalizeGameName(''), '');
  assert.equal(r.normalizeGameName(null), '');
});

test('findExistingFolder 命中同名游戏，多个同名时取最小编号（最早建立的为准）', () => {
  // 这就是 Bug A 的现场目录状态
  const r = new NameResolver({
    fs: fakeFs({ entries: ['【游戏270】正当防卫4', '【游戏268】正当防卫4', '【游戏269】正当防卫4', '【游戏100】其它游戏'] }),
  });
  const hit = r.findExistingFolder('E:\\素材\\', '正当防卫4');
  assert.equal(hit.index, 268);
  assert.equal(hit.folderName, '【游戏268】正当防卫4');
  assert.equal(hit.folder, path.join('E:\\素材\\', '【游戏268】正当防卫4'));

  // 空格差异不影响判定
  assert.equal(r.findExistingFolder('E:\\素材\\', '正当防卫 4').index, 268);
});

test('findExistingFolder 大小写不敏感，且能匹配被清洗过的磁盘目录名', () => {
  const r1 = new NameResolver({ fs: fakeFs({ entries: ['【游戏010】Elden Ring'] }) });
  assert.equal(r1.findExistingFolder('E:\\素材\\', 'elden ring').index, 10);

  // 磁盘上的目录名是 sanitize 过的（冒号 → 下划线），输入的是原始名
  const r2 = new NameResolver({ fs: fakeFs({ entries: ['【游戏011】黑神话_悟空'] }) });
  assert.equal(r2.findExistingFolder('E:\\素材\\', '黑神话:悟空').index, 11);
});

test('findExistingFolder 未命中 / 无编号前缀 / 空名一律返回 null', () => {
  const r = new NameResolver({ fs: fakeFs({ entries: ['【游戏268】正当防卫4', '正当防卫5'] }) });
  assert.equal(r.findExistingFolder('E:\\素材\\', '正当防卫3'), null);
  // 无【游戏NNN】前缀的目录不参与判定
  assert.equal(r.findExistingFolder('E:\\素材\\', '正当防卫5'), null);
  assert.equal(r.findExistingFolder('E:\\素材\\', ''), null);
  assert.equal(r.findExistingFolder('E:\\素材\\', null), null);

  const missing = new NameResolver({ fs: fakeFs({ exists: false }) });
  assert.equal(missing.findExistingFolder('E:\\素材\\', '正当防卫4'), null);
});

test('reserveFolder 命中同名时复用且完全不 mkdir 新目录（Bug A 核心回归）', () => {
  const fs = fakeFs({
    entries: ['【游戏268】正当防卫4', '【游戏269】正当防卫4', '【游戏270】正当防卫4'],
    onMkdir(p, o) {
      // 非递归 mkdir 出现 = 又建了一个同名新编号目录 = Bug A 复发
      if (!o || !o.recursive) throw new Error('不应新建目录：' + p);
    },
  });
  const r = new NameResolver({ fs });
  const res = r.reserveFolder('E:\\素材\\', '正当防卫4');
  assert.equal(res.reused, true);
  assert.equal(res.index, 268);
  assert.equal(res.folderName, '【游戏268】正当防卫4');
  // 只有 ensureOutputDir 那一次 recursive mkdir
  assert.equal(fs.calls.length, 1);
  assert.deepEqual(fs.calls[0].options, { recursive: true });

  // 连续调用三次仍然稳定复用同一个编号，不再逐次 +1
  assert.equal(r.reserveFolder('E:\\素材\\', '正当防卫4').index, 268);
  assert.equal(r.reserveFolder('E:\\素材\\', '正当防卫 4').index, 268);
});

test('reserveFolder 无同名时正常新建并返回 reused=false', () => {
  const fs = fakeFs({ entries: ['【游戏268】正当防卫4'] });
  const r = new NameResolver({ fs });
  const res = r.reserveFolder('E:\\素材\\', '战神4');
  assert.equal(res.reused, false);
  assert.equal(res.index, 269);
  assert.equal(res.folderName, '【游戏269】战神4');
  // ensureOutputDir + 一次非递归占位
  assert.equal(fs.calls.length, 2);
  assert.equal(fs.calls[1].options, undefined);
});

test('reserveFolder reuseExisting=false 可强制新建（force 重下场景）', () => {
  const fs = fakeFs({ entries: ['【游戏268】正当防卫4'] });
  const r = new NameResolver({ fs });
  const res = r.reserveFolder('E:\\素材\\', '正当防卫4', { reuseExisting: false });
  assert.equal(res.reused, false);
  assert.equal(res.index, 269);
});
