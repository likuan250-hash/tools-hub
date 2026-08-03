// test/steam.test.js —— SteamCover 单测（URL 构造 / storesearch 解析 / 维度校验 / YouTube 回退）
// 注入 fetch + fs 替身，全程不发网络请求、不写磁盘。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SteamCover,
  readImageSize,
  meetsMinSize,
  STEAM_CDN,
  YT_THUMB_CDN,
  MIN_WIDTH,
  MIN_HEIGHT,
} = require('../lib/steam');

/**
 * 构造最小 PNG 头（仅签名 + IHDR，够解析尺寸）。
 * @param {number} w 宽
 * @param {number} h 高
 * @returns {Buffer}
 */
function pngBuffer(w, h) {
  const b = Buffer.alloc(24, 0);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/**
 * 构造最小 JPEG 头（SOI + SOF0）。
 * @param {number} w 宽
 * @param {number} h 高
 * @returns {Buffer}
 */
function jpegBuffer(w, h) {
  const b = Buffer.alloc(24, 0);
  b[0] = 0xff; b[1] = 0xd8;   // SOI
  b[2] = 0xff; b[3] = 0xc0;   // SOF0
  b.writeUInt16BE(17, 4);     // 段长
  b[6] = 8;                   // 精度
  b.writeUInt16BE(h, 7);
  b.writeUInt16BE(w, 9);
  return b;
}

/**
 * 构造 fetch 替身。
 * @param {Array<{match: RegExp, json?: object, body?: Buffer, ok?: boolean, status?: number}>} routes
 * @param {string[]} [seen] 记录请求过的 URL
 * @returns {Function}
 */
function fakeFetch(routes, seen) {
  return async (url) => {
    if (seen) seen.push(String(url));
    const hit = routes.find((r) => r.match.test(String(url)));
    if (!hit) return { ok: false, status: 404, async json() { return {}; }, async arrayBuffer() { return new ArrayBuffer(0); } };
    return {
      ok: hit.ok !== false,
      status: hit.status || 200,
      async json() { return hit.json || {}; },
      async arrayBuffer() { const u = new Uint8Array(hit.body || Buffer.alloc(0)); return u.buffer; },
    };
  };
}

/**
 * 构造 fs 替身（只记录写盘，不落地）。
 * @returns {{writes: Array, writeFileSync: Function}}
 */
function fakeFs() {
  return {
    writes: [],
    writeFileSync(p, buf) { this.writes.push({ path: p, bytes: buf.length }); },
  };
}

test('readImageSize 解析 PNG / JPEG，无法识别返回 null', () => {
  assert.deepEqual(readImageSize(pngBuffer(1920, 1080)), { width: 1920, height: 1080, format: 'png' });
  assert.deepEqual(readImageSize(jpegBuffer(1280, 720)), { width: 1280, height: 720, format: 'jpg' });
  assert.equal(readImageSize(Buffer.alloc(4)), null);
  assert.equal(readImageSize(null), null);
  assert.equal(readImageSize(Buffer.alloc(64, 0x41)), null);
});

test('meetsMinSize 默认下限 1920×1080，可自定义', () => {
  assert.equal(MIN_WIDTH, 1920);
  assert.equal(MIN_HEIGHT, 1080);
  assert.equal(meetsMinSize({ width: 1920, height: 1080 }), true);
  assert.equal(meetsMinSize({ width: 3840, height: 2160 }), true);
  assert.equal(meetsMinSize({ width: 1280, height: 720 }), false);
  assert.equal(meetsMinSize({ width: 1920, height: 1079 }), false);
  assert.equal(meetsMinSize(null), false);
  assert.equal(meetsMinSize({ width: 1280, height: 720 }, { width: 1000, height: 500 }), true);
});

test('searchUrl 构造 storesearch 查询串', () => {
  const c = new SteamCover({ fetch: fakeFetch([]), fs: fakeFs() });
  const u = c.searchUrl('God of War');
  assert.ok(u.startsWith('https://store.steampowered.com/api/storesearch/?term='));
  assert.ok(u.includes('term=God%20of%20War'));
  assert.ok(u.includes('l=english'));
  assert.ok(u.includes('cc=US'));
  const u2 = c.searchUrl(' 战神4 ', { cc: 'CN', l: 'schinese' });
  assert.ok(u2.includes('cc=CN'));
  assert.ok(u2.includes('l=schinese'));
  assert.ok(!u2.includes('%20%E6')); // 已 trim，首尾无空格
});

test('parseAppId 取首个数值 id，无命中返回 null', () => {
  const c = new SteamCover({ fetch: fakeFetch([]), fs: fakeFs() });
  assert.equal(c.parseAppId({ items: [{ id: 292030, name: 'God of War' }] }), 292030);
  assert.equal(c.parseAppId({ items: [{ id: 'x' }, { id: 42 }] }), 42);
  assert.equal(c.parseAppId({ items: [] }), null);
  assert.equal(c.parseAppId({}), null);
  assert.equal(c.parseAppId(null), null);
});

test('heroUrl / heroCandidates / youtubeThumbUrl 直链构造', () => {
  const c = new SteamCover({ fetch: fakeFetch([]), fs: fakeFs() });
  assert.equal(c.heroUrl(292030), STEAM_CDN + '/292030/library_hero.jpg');
  const cands = c.heroCandidates(292030);
  assert.equal(cands[0], c.heroUrl(292030)); // 设计主路径必须排第一
  assert.equal(cands.length, 3);
  assert.ok(cands.every((u) => u.startsWith(STEAM_CDN + '/292030/')));
  assert.equal(c.youtubeThumbUrl('abc123'), YT_THUMB_CDN + '/abc123/maxresdefault.jpg');
});

test('searchAppId 命中与未命中', async () => {
  const ok = new SteamCover({
    fetch: fakeFetch([{ match: /storesearch/, json: { items: [{ id: 292030 }] } }]),
    fs: fakeFs(),
  });
  assert.equal(await ok.searchAppId('God of War'), 292030);

  const miss = new SteamCover({
    fetch: fakeFetch([{ match: /storesearch/, json: { items: [] } }]),
    fs: fakeFs(),
  });
  assert.equal(await miss.searchAppId('不存在的游戏'), null);

  const bad = new SteamCover({
    fetch: fakeFetch([{ match: /storesearch/, ok: false, status: 500 }]),
    fs: fakeFs(),
  });
  assert.equal(await bad.searchAppId('x'), null);
});

test('downloadImage 尺寸达标才写盘，命名为 封面.<ext>', async () => {
  const fs1 = fakeFs();
  const c1 = new SteamCover({
    fetch: fakeFetch([{ match: /hero/, body: jpegBuffer(1920, 1080) }]),
    fs: fs1,
  });
  const r1 = await c1.downloadImage('https://cdn/hero.jpg', 'E:\\素材\\【游戏1】x');
  assert.equal(r1.ok, true);
  assert.equal(r1.file, '封面.jpg');
  assert.equal(r1.width, 1920);
  assert.equal(r1.height, 1080);
  assert.equal(fs1.writes.length, 1);

  // PNG 走 .png 扩展名
  const fs2 = fakeFs();
  const c2 = new SteamCover({ fetch: fakeFetch([{ match: /hero/, body: pngBuffer(1920, 1080) }]), fs: fs2 });
  const r2 = await c2.downloadImage('https://cdn/hero.png', 'dir');
  assert.equal(r2.file, '封面.png');

  // 尺寸不达标 → 不写盘
  const fs3 = fakeFs();
  const c3 = new SteamCover({ fetch: fakeFetch([{ match: /hero/, body: jpegBuffer(1280, 720) }]), fs: fs3 });
  const r3 = await c3.downloadImage('https://cdn/hero.jpg', 'dir');
  assert.equal(r3.ok, false);
  assert.ok(r3.error.includes('尺寸不达标'));
  assert.equal(fs3.writes.length, 0);

  // minSize: null 跳过校验（回退路径）
  const fs4 = fakeFs();
  const c4 = new SteamCover({ fetch: fakeFetch([{ match: /thumb/, body: jpegBuffer(1280, 720) }]), fs: fs4 });
  const r4 = await c4.downloadImage('https://cdn/thumb.jpg', 'dir', { minSize: null });
  assert.equal(r4.ok, true);
  assert.equal(fs4.writes.length, 1);

  // HTTP 失败
  const c5 = new SteamCover({ fetch: fakeFetch([{ match: /hero/, ok: false, status: 404 }]), fs: fakeFs() });
  const r5 = await c5.downloadImage('https://cdn/hero.jpg', 'dir');
  assert.equal(r5.ok, false);
  assert.ok(r5.error.includes('404'));
});

test('fetchCover 主路径：storesearch → library_hero.jpg 成功', async () => {
  const seen = [];
  const events = [];
  const c = new SteamCover({
    fetch: fakeFetch([
      { match: /storesearch/, json: { items: [{ id: 292030 }] } },
      { match: /library_hero\.jpg/, body: jpegBuffer(1920, 1080) },
    ], seen),
    fs: fakeFs(),
    trailer: { async searchTrailer() { throw new Error('回退路径不应被触发'); } },
  });
  const r = await c.fetchCover('God of War', 'dir', { emit: (t, s, m, ok) => events.push({ t, m, ok }) });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'steam');
  assert.equal(r.appid, 292030);
  assert.equal(r.file, '封面.jpg');
  assert.ok(seen.some((u) => u.includes('library_hero.jpg')));
  assert.ok(events.some((e) => e.t === 'cover_search' && e.m.includes('292030')));
  assert.ok(events.some((e) => e.t === 'cover_download' && e.ok === true));
});

test('fetchCover 回退路径：Steam 不达标 → YouTube maxres 缩略图（裁定⑥）', async () => {
  const c = new SteamCover({
    fetch: fakeFetch([
      { match: /storesearch/, json: { items: [{ id: 292030 }] } },
      { match: /steamstatic/, body: jpegBuffer(1280, 720) },     // 三个候选都不达标
      { match: /maxresdefault\.jpg/, body: jpegBuffer(1280, 720) },
    ]),
    fs: fakeFs(),
    trailer: { async searchTrailer() { return { id: 'vid123', title: 'GOW Launch Trailer' }; } },
  });
  const r = await c.fetchCover('God of War', 'dir', { env: { ytDlp: true } });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'youtube');
  assert.equal(r.videoId, 'vid123');
});

test('fetchCover 两源皆失败 → 报错不静默（reason=cover-both-failed）', async () => {
  const c = new SteamCover({
    fetch: fakeFetch([{ match: /storesearch/, json: { items: [] } }]),
    fs: fakeFs(),
    trailer: { async searchTrailer() { return null; } },
  });
  const r = await c.fetchCover('查无此游戏', 'dir', { env: { ytDlp: true } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cover-both-failed');
  assert.ok(r.error.includes('Steam 与 YouTube'));
});

test('fetchYouTubeThumbnail 在 yt-dlp 缺失时直接失败，不 spawn', async () => {
  const c = new SteamCover({
    fetch: fakeFetch([]),
    fs: fakeFs(),
    trailer: { async searchTrailer() { throw new Error('不应调用 yt-dlp'); } },
  });
  const r = await c.fetchYouTubeThumbnail('x', 'dir', { env: { ytDlp: false } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'yt-dlp-not-found');
});
