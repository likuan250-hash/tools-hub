// test/cover.test.js —— CoverFetcher 单测（规范十级来源的 URL 构造 / HTML 解析 / 逐级降级）
// 全程注入 fetch + fs 替身：不发任何真实网络请求，不写任何真实文件。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CoverFetcher,
  normalizeUrl,
  hostOf,
  COVER_FILE,
  WALLHAVEN_API,
  WALLHAVEN_CATEGORIES,
  WALLHAVEN_PURITY,
  WALLHAVEN_ATLEAST,
  WALLHAVEN_SORTING,
  // 缺陷 3 / 缺陷 4 新增的纯函数
  hasCjk,
  isLatinTitle,
  cleanEnglishTitle,
  buildQueryPlan,
  parseSteamSearchAppId,
  parseSteamAppName,
  normalizeTokens,
  isRelevantCandidate,
  extractSlugFromUrl,
  extractTitleFromHtml,
  hasWordToken,
  STEAM_SEARCH_API,
  STEAM_DETAILS_API,
  // Bing 图片搜索 + Steam CDN 纯函数 / 常量
  parseBingImageResults,
  filterBingCandidates,
  isBingItemRelevant,
  isYouTubeTitleRelevant,
  looksLikeBingBlockPage,
  pickRelevantSteamAppId,
  STEAM_CDN_BASE,
  STEAM_CDN_STRICT,
  STEAM_CDN_LOWRES,
  GAME_MEDIA_SITES,
  CHINESE_WALLPAPER_SITES,
  BING_IMAGE_SEARCH,
  BING_SIZE_FILTER,
} = require('../lib/cover');

/**
 * 构造最小 JPEG（可被 imagesize.readImageSize 解析出指定宽高）。
 * @param {number} w 宽
 * @param {number} h 高
 * @returns {Buffer}
 */
function jpegBuf(w, h) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof[0] = 0xff; sof[1] = 0xc0;
  sof.writeUInt16BE(9, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof[9] = 3; sof[10] = 1;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(8)]);
}

/**
 * 构造最小 PNG。
 * @param {number} w 宽
 * @param {number} h 高
 * @returns {Buffer}
 */
function pngBuf(w, h) {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/**
 * 构造 fetch 替身。
 * @param {Object<string, {status?: number, text?: string, json?: object, buf?: Buffer}>|Function} routes
 *   URL → 响应；也可传函数做完全自定义
 * @param {Array} [calls] 记录请求
 * @returns {Function}
 */
function fakeFetch(routes, calls) {
  return async (url, opts) => {
    if (calls) calls.push({ url, opts });
    const hit = typeof routes === 'function' ? routes(url, opts) : routes[url];
    if (!hit) return { ok: false, status: 404, async text() { return ''; } };
    if (hit.throws) throw new Error(hit.throws);
    const status = hit.status == null ? 200 : hit.status;
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return hit.text == null ? '' : hit.text; },
      async json() {
        if (hit.json === undefined) throw new Error('not json');
        return hit.json;
      },
      async arrayBuffer() {
        const b = hit.buf || Buffer.alloc(0);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
    };
  };
}

/**
 * 构造 fs 替身（记录写盘内容）。
 * @returns {object}
 */
function fakeFs() {
  return {
    written: [],
    unlinked: [],
    writeFileSync(p, buf) { this.written.push({ path: p, bytes: buf.length }); },
    unlinkSync(p) { this.unlinked.push(p); },
    existsSync() { return true; },
  };
}

// 构造测试用 CoverFetcher：默认关掉 Bing 节流/退避，避免单测被 600ms 节流拖慢
function makeCover(fetch, fs, calls) {
  const fetcher = calls
    ? fakeFetch(fetch, calls)
    : (typeof fetch === 'function' ? fakeFetch(fetch) : fakeFetch(fetch || {}));
  return new CoverFetcher({ fetch: fetcher, fs: fs || fakeFs(), bingThrottleMs: 0, bingRetryDelayMs: 0 });
}

// 把一个 JSON 对象转成 Bing <a m='...'> 属性能安全解析的形态（内部双引号转 &quot;）
function bingItemHtml(item) {
  const m = JSON.stringify(item).replace(/"/g, '&quot;');
  return '<a class="iusc" m=\'' + m + '\' href="' + (item.purl || '#') + '">';
}

// ─────────────────────── 纯函数 ───────────────────────

test('normalizeUrl / hostOf 归一化与取域名', () => {
  assert.equal(normalizeUrl('//4kwallpapers.com/a.jpg'), 'https://4kwallpapers.com/a.jpg');
  assert.equal(normalizeUrl('https://a.com/x?y=1&amp;z=2'), 'https://a.com/x?y=1&z=2');
  assert.equal(normalizeUrl('/relative/path.jpg'), '');
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeUrl(null), '');
  assert.equal(hostOf('https://Wallhaven.CC/api'), 'wallhaven.cc');
  assert.equal(hostOf('not a url'), '');
});

test('buildWallhavenApiUrl 带 atleast/categories/purity（免 key 公开接口）', () => {
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs() });
  const u = c.buildWallhavenApiUrl('Elden Ring');
  assert.ok(u.startsWith(WALLHAVEN_API + '?q='));
  assert.ok(u.includes('q=Elden%20Ring'));
  assert.ok(u.includes('atleast=1280x720'));
  assert.ok(u.includes('categories=100'));
  assert.ok(u.includes('purity=100'));
  assert.ok(u.includes('sorting=relevance'));
});

// 缺陷 1 回归锁：categories 是 3 个二进制位 general/anime/people。
test('buildWallhavenApiUrl 必须用 categories=100（general），绝不能是 010（anime）', () => {
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs() });
  assert.equal(WALLHAVEN_CATEGORIES, '100', 'general 位在最高位');
  assert.equal(WALLHAVEN_PURITY, '100', 'purity=100 只要 SFW');
  assert.equal(WALLHAVEN_ATLEAST, '1280x720');
  assert.equal(WALLHAVEN_SORTING, 'relevance');

  for (const name of ['Just Cause 4', 'Nioh 2', 'Elden Ring', 'God of War', '正当防卫4']) {
    const u = c.buildWallhavenApiUrl(name);
    assert.ok(u.includes('categories=100'), name + ' 的 URL 必须带 categories=100');
    assert.ok(!u.includes('categories=010'), name + ' 的 URL 绝不能带 categories=010（anime）');
    assert.ok(!u.includes('categories=001'), name + ' 的 URL 绝不能带 categories=001（people）');
  }

  assert.equal(
    c.buildWallhavenApiUrl('Just Cause 4'),
    WALLHAVEN_API + '?q=Just%20Cause%204&atleast=1280x720&categories=100&purity=100&sorting=relevance',
  );
});

test('buildWallhavenApiUrl 四个参数均可由 opts 覆盖（不再硬编码在拼接串里）', () => {
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs() });
  const u = c.buildWallhavenApiUrl('X', {
    categories: '110', purity: '110', atleast: '2560x1440', sorting: 'toplist',
  });
  assert.ok(u.includes('categories=110'));
  assert.ok(u.includes('purity=110'));
  assert.ok(u.includes('atleast=2560x1440'));
  assert.ok(u.includes('sorting=toplist'));

  const c2 = new CoverFetcher({
    fetch: fakeFetch({}), fs: fakeFs(), wallhaven: { categories: '111', sorting: 'random' },
  });
  const u2 = c2.buildWallhavenApiUrl('X');
  assert.ok(u2.includes('categories=111'));
  assert.ok(u2.includes('sorting=random'));
  assert.ok(u2.includes('purity=100'), '未覆盖的项仍用默认值');
});

test('parseWallhavenResults 取 data[].path 并挡掉明确不达标项', () => {
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs() });
  const json = {
    data: [
      { path: 'https://w.wallhaven.cc/full/ab/wallhaven-1.jpg', dimension_x: 1920, dimension_y: 1080 },
      { path: 'https://w.wallhaven.cc/full/cd/wallhaven-2.jpg', dimension_x: 1280, dimension_y: 720 },
      { path: 'https://w.wallhaven.cc/full/ef/wallhaven-3.jpg' },
      { path: '' },
      null,
    ],
  };
  assert.deepEqual(c.parseWallhavenResults(json), [
    'https://w.wallhaven.cc/full/ab/wallhaven-1.jpg',
    'https://w.wallhaven.cc/full/cd/wallhaven-2.jpg',
    'https://w.wallhaven.cc/full/ef/wallhaven-3.jpg',
  ]);
  assert.deepEqual(c.parseWallhavenResults(null), []);
  assert.deepEqual(c.parseWallhavenResults({}), []);
});

test('youtubeThumbUrl 拼 maxresdefault 缩略图地址', () => {
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs() });
  assert.equal(c.youtubeThumbUrl('abc123'), 'https://i.ytimg.com/vi/abc123/maxresdefault.jpg');
});

// ─────────────────────── Bing 图片搜索：纯函数 ───────────────────────

test('parseBingImageResults 从 <a m=> 提取原图直链 / 来源页 / 标题，并反转义', () => {
  const html = [
    bingItemHtml({ murl: 'https://cdn.4kwallpapers.com/just-cause-4.jpg', purl: 'https://4kwallpapers.com/just-cause-4', t: 'Just Cause 4 Wallpaper' }),
    bingItemHtml({ murl: 'https://images.alphacoders.com/136/1360000.jpg', purl: 'https://alphacoders.com/x', t: 'Just Cause 4' }),
    '<a class="iusc" m=\'broken json\'>', // 坏 JSON 跳过
    '<img src="https://example.com/no-m.jpg">', // 无 m 属性忽略
  ].join('\n');
  const items = parseBingImageResults(html);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    murl: 'https://cdn.4kwallpapers.com/just-cause-4.jpg',
    purl: 'https://4kwallpapers.com/just-cause-4',
    title: 'Just Cause 4 Wallpaper',
    turl: '',
  });
  // 协议相对的 murl 也会被补成 https（Bing 实际用 &quot; 转义属性内的 JSON）
  assert.equal(parseBingImageResults(bingItemHtml({ murl: '//x.com/a.jpg' }))[0].murl, 'https://x.com/a.jpg');
  assert.deepEqual(parseBingImageResults(''), []);
  assert.deepEqual(parseBingImageResults(null), []);
});

test('filterBingCandidates 只保留指定域名（purl host）且相关的候选，并去重截断', () => {
  const items = [
    { murl: 'https://cdn.4kwallpapers.com/jc4.jpg', purl: 'https://4kwallpapers.com/jc4', title: 'Just Cause 4' },
    { murl: 'https://images.alphacoders.com/136/1360000.jpg', purl: 'https://alphacoders.com/x', title: 'Just Cause 4' },
    { murl: 'https://cdn.4kwallpapers.com/jc4-2.jpg', purl: 'https://4kwallpapers.com/jc4-2', title: 'Just Cause 4 Reloaded' },
    { murl: 'https://cdn.4kwallpapers.com/persona.jpg', purl: 'https://4kwallpapers.com/persona', title: 'Persona 4' }, // 不相关
    { murl: 'https://cdn.4kwallpapers.com/jc4.jpg', purl: 'https://4kwallpapers.com/jc4', title: 'Just Cause 4' }, // 重复
  ];
  const q = normalizeTokens('just cause 4');
  // 单站过滤 + 相关性
  const out = filterBingCandidates(items, q, { hosts: ['4kwallpapers.com'] });
  assert.deepEqual(out, [
    'https://cdn.4kwallpapers.com/jc4.jpg',
    'https://cdn.4kwallpapers.com/jc4-2.jpg',
  ]);
  // hosts 为空 → 不做站点过滤，但仍按相关性 + 去重
  const out2 = filterBingCandidates(items, q, {});
  assert.ok(out2.includes('https://images.alphacoders.com/136/1360000.jpg'));
  assert.ok(!out2.includes('https://cdn.4kwallpapers.com/persona.jpg'), '不相关项必须被剔除');
  // 截断
  assert.equal(filterBingCandidates(items, q, { hosts: ['4kwallpapers.com'], limit: 1 }).length, 1);
});

test('isBingItemRelevant 标题 / murl slug / purl slug 任一自证相关即通过', () => {
  const q = normalizeTokens('just cause 4');
  assert.equal(isBingItemRelevant({ murl: 'https://x/just-cause-4.jpg', purl: 'https://4kwallpapers.com/jc4', title: 'X' }, q), true);
  assert.equal(isBingItemRelevant({ murl: 'https://x/foo.jpg', purl: 'https://4kwallpapers.com/just-cause-4', title: 'X' }, q), true, 'purl slug 命中');
  assert.equal(isBingItemRelevant({ murl: 'https://x/foo.jpg', purl: 'https://a.com/b', title: 'Just Cause 4 Wallpaper' }, q), true, '标题命中');
  assert.equal(isBingItemRelevant({ murl: 'https://x/persona.jpg', purl: 'https://a.com/b', title: 'Persona 4' }, q), false, '三者都不相关');
  assert.equal(isBingItemRelevant({ murl: 'https://x/foo.jpg', purl: 'https://a.com/b', title: 'X' }, []), false, '无 token 一律不相关');
});

test('looksLikeBingBlockPage 识别拦截/空页，但完整 0 结果页不算拦截', () => {
  assert.equal(looksLikeBingBlockPage('<html><body>short</body></html>'), true, '正文过短');
  assert.equal(looksLikeBingBlockPage('<html><body>' + 'x'.repeat(50) + 'verify you are human' + 'y'.repeat(2000) + '</body></html>'), true, '命中特征词');
  // 结构完整但 0 条结果（真没搜到）→ 不重试
  const full = '<html><body>' + bingItemHtml({ murl: 'https://x/a.jpg', purl: 'https://x/a', t: 'A' }) + 'zzz'.repeat(400) + '</body></html>';
  assert.equal(looksLikeBingBlockPage(full), false, '结构完整不误判');
  assert.equal(looksLikeBingBlockPage(''), true);
});

test('buildBingImageUrl 单站 / 多站 OR / 尺寸过滤（qft 绝不 encodeURIComponent）', () => {
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs() });
  const single = c.buildBingImageUrl('4kwallpapers.com', 'Just Cause 4', 'key art');
  assert.ok(single.startsWith(BING_IMAGE_SEARCH + '?q='));
  assert.ok(single.includes('site%3A4kwallpapers.com'), '单站 site: 限定');
  assert.ok(single.includes(encodeURIComponent('Just Cause 4')));
  assert.ok(single.includes(encodeURIComponent('key art')));
  assert.ok(single.endsWith('qft=' + BING_SIZE_FILTER), 'qft 以字面量拼接（含 +filterui）');

  const multi = c.buildBingImageUrl(GAME_MEDIA_SITES, 'X', 'wallpaper');
  assert.ok(multi.includes('(site%3Anintendo.com%20OR%20site%3Aplaystation.com'), '多站 OR 拼法');
  assert.ok(GAME_MEDIA_SITES.every((s) => multi.includes(encodeURIComponent('site:' + s))), '每个站点都在');
});

// ─────────────────────── Steam 官方 CDN ───────────────────────

test('buildSteamCdnUrl / buildSteamCdnCandidates 拼官方图地址，非数字 appid 返回空', () => {
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs() });
  assert.equal(c.buildSteamCdnUrl('123', 'library_hero_2x.jpg'), STEAM_CDN_BASE + '/123/library_hero_2x.jpg');
  assert.deepEqual(c.buildSteamCdnCandidates('123', 'strict'), [
    STEAM_CDN_BASE + '/123/capsule_616x353_2x.jpg',
    STEAM_CDN_BASE + '/123/capsule_616x353.jpg',
    STEAM_CDN_BASE + '/123/header.jpg',
  ]);
  assert.deepEqual(c.buildSteamCdnCandidates('123', 'hero'), [
    STEAM_CDN_BASE + '/123/library_hero_2x.jpg',
    STEAM_CDN_BASE + '/123/page_bg_generated_v6b.jpg',
  ]);
  assert.deepEqual(c.buildSteamCdnCandidates('123', 'lowres'), [STEAM_CDN_BASE + '/123/library_hero.jpg']);
  assert.deepEqual(c.buildSteamCdnCandidates('abc', 'strict'), [], '非数字 appid');
  assert.deepEqual(c.buildSteamCdnCandidates('', 'lowres'), []);
});

test('pickRelevantSteamAppId 只取标题相关项，绝不退回首条', () => {
  assert.equal(pickRelevantSteamAppId(
    { total: 2, items: [{ id: 111, name: 'Persona 4' }, { id: 222, name: 'Just Cause 4' }] },
    normalizeTokens('just cause 4')), '222');
  assert.equal(pickRelevantSteamAppId({ total: 1, items: [{ id: 1, name: 'Persona 4' }] }, normalizeTokens('just cause 4')), '', '无相关项返回空');
  assert.equal(pickRelevantSteamAppId({ total: 0, items: [] }, normalizeTokens('x')), '');
  assert.equal(pickRelevantSteamAppId(null, normalizeTokens('x')), '');
});

test('resolveSteamAppId 入参优先 → 缓存命中 → storesearch 反查', async () => {
  const storeUrl = 'https://store.steampowered.com/api/storesearch/?term=' + encodeURIComponent('Just Cause 4') + '&l=english&cc=US';

  // 入参优先，不打网络（独立实例，避免缓存污染后续断言）
  const c0 = makeCover({});
  assert.equal(await c0.resolveSteamAppId('Just Cause 4', { steamAppId: '999' }), '999');

  // 走 storesearch
  const c = makeCover({ [storeUrl]: { json: { total: 1, items: [{ id: 123, name: 'Just Cause 4' }] } } });
  assert.equal(await c.resolveSteamAppId('Just Cause 4'), '123');

  // 缓存命中：再问一次不打第二个请求
  const calls = [];
  const c2 = makeCover({ [storeUrl]: { json: { total: 1, items: [{ id: 123, name: 'Just Cause 4' }] } } }, null, calls);
  await c2.resolveSteamAppId('Just Cause 4');
  const n1 = calls.length;
  await c2.resolveSteamAppId('Just Cause 4');
  assert.equal(calls.length, n1, '第二次命中缓存');

  // 网络失败 → 返回空
  const c3 = makeCover({ [storeUrl]: { status: 500 } });
  assert.equal(await c3.resolveSteamAppId('Just Cause 4'), '');

  // lookup=false 关闭反查
  const calls4 = [];
  const c4 = makeCover({}, null, calls4);
  assert.equal(await c4.resolveSteamAppId('Just Cause 4', { lookup: false }), '');
  assert.equal(calls4.length, 0);
});

test('fromSteamCdn strict 档强制尺寸门槛；lowres 档跳过门槛但如实标 degraded', async () => {
  const fs = fakeFs();
  const strictUrls = ['https://cdn.akamai.steamstatic.com/steam/apps/123/capsule_616x353_2x.jpg', 'https://cdn.akamai.steamstatic.com/steam/apps/123/capsule_616x353.jpg', 'https://cdn.akamai.steamstatic.com/steam/apps/123/header.jpg'];
  const heroUrl = 'https://cdn.akamai.steamstatic.com/steam/apps/123/library_hero_2x.jpg';
  const lowresUrl = 'https://cdn.akamai.steamstatic.com/steam/apps/123/library_hero.jpg';

  // strict：达标 → ok，degraded=false
  const c1 = makeCover({ [strictUrls[0]]: { buf: jpegBuf(1920, 1080) }, [strictUrls[1]]: { buf: jpegBuf(640, 480) } }, fs);
  const r1 = await c1.fromSteamCdn('123', 'D:\\out', { tier: 'strict' });
  assert.equal(r1.ok, true);
  assert.equal(r1.source, 'steam-cdn');
  assert.equal(r1.degraded, false);
  assert.equal(r1.width, 1920);

  // strict：官方图不达标也采纳，标 degraded（官方宣传图优先于高清门槛）
  const c2 = makeCover({ [strictUrls[0]]: { buf: jpegBuf(640, 480) } }, fs);
  const r2 = await c2.fromSteamCdn('123', 'D:\\out', { tier: 'strict' });
  assert.equal(r2.ok, true);
  assert.equal(r2.degraded, true);

  // lowres：不达标也落盘，但 degraded=true
  const c3 = makeCover({ [lowresUrl]: { buf: jpegBuf(640, 480) } }, fs);
  const r3 = await c3.fromSteamCdn('123', 'D:\\out', { tier: 'lowres' });
  assert.equal(r3.ok, true);
  assert.equal(r3.source, 'steam-cdn-lowres');
  assert.equal(r3.degraded, true);

  // hero 档：横幅图（library_hero_2x）达标即采纳，source=steam-cdn-hero
  const c5 = makeCover({ [heroUrl]: { buf: jpegBuf(1920, 620) } }, fs);
  const r5 = await c5.fromSteamCdn('123', 'D:\\out', { tier: 'hero' });
  assert.equal(r5.ok, true);
  assert.equal(r5.source, 'steam-cdn-hero');

  // 非数字 appid → 直接失败
  const c4 = makeCover({}, fs);
  assert.equal((await c4.fromSteamCdn('abc', 'D:\\out')).ok, false);
});

// ─────────────────────── 网络请求必带 UA ───────────────────────

test('所有请求都带 User-Agent（Bing / Steam 无 UA 会被直接拒绝）', async () => {
  const calls = [];
  const c = new CoverFetcher({ fetch: fakeFetch({}, calls), fs: fakeFs() });
  await c.httpText('https://cn.bing.com/images/search?q=x');
  await c.httpJson('https://wallhaven.cc/api/v1/search?q=x');
  await c.fetchImage('https://example.com/a.jpg');
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.ok(call.opts.headers['User-Agent'], '缺少 User-Agent 头');
    assert.ok(call.opts.headers['User-Agent'].includes('Mozilla/5.0'));
  }
});

// ─────────────────────── 尺寸硬校验 ───────────────────────

test('tryCandidates 只采纳实测达标的候选，不信 URL 里的分辨率字样', async () => {
  const fs = fakeFs();
  const liar = 'https://4kwallpapers.com/images/wallpapers/x-1920x1080-1.jpg';
  const real = 'https://4kwallpapers.com/images/wallpapers/y-1920x1080-2.jpg';
  const c = new CoverFetcher({
    fetch: fakeFetch({ [liar]: { buf: jpegBuf(640, 480) }, [real]: { buf: jpegBuf(1920, 1080) } }),
    fs,
  });
  const r = await c.tryCandidates([liar, real], 'D:\\out', { source: '4kwallpapers' });
  assert.equal(r.ok, true);
  assert.equal(r.url, real);
  assert.equal(r.width, 1920);
  assert.equal(r.height, 1080);
  assert.equal(r.file, COVER_FILE);
  assert.equal(fs.written.length, 1);
});

test('tryCandidates 全不达标时干净失败，不抛异常', async () => {
  const c = new CoverFetcher({
    fetch: fakeFetch({ 'https://a.com/1.jpg': { buf: jpegBuf(800, 600) } }),
    fs: fakeFs(),
  });
  const r = await c.tryCandidates(['https://a.com/1.jpg'], 'D:\\out', { source: 'test' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('尺寸不达标'));

  assert.equal((await c.tryCandidates([], 'D:\\out')).ok, false);
});

test('saveCover 对 PNG 调用 probe.convertToJpg 转成规范要求的 封面.jpg', async () => {
  const fs = fakeFs();
  const convCalls = [];
  const probe = {
    async convertToJpg(input, output) { convCalls.push({ input, output }); return { ok: true, path: output }; },
  };
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs, probe });
  const r = await c.saveCover(pngBuf(1920, 1080), { format: 'png' }, 'D:\\out');
  assert.equal(r.ok, true);
  assert.equal(r.file, COVER_FILE);
  assert.equal(r.converted, true);
  assert.equal(convCalls.length, 1);
  assert.equal(fs.unlinked.length, 1);
});

test('saveCover 无 ffmpeg 时保留原扩展名，不阻断流程', async () => {
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs(), probe: null });
  const r = await c.saveCover(pngBuf(1920, 1080), { format: 'png' }, 'D:\\out');
  assert.equal(r.ok, true);
  assert.equal(r.file, '封面.png');
  assert.equal(r.converted, false);
});

// 缺陷 1 附带项：wallhaven 实测会返回 PNG，规范要求封面必须是 封面.jpg
test('PNG 候选先按真实格式落盘再转码成 封面.jpg，绝不改名冒充', async () => {
  const fs = fakeFs();
  const convCalls = [];
  const probe = {
    async convertToJpg(input, output) { convCalls.push({ input, output }); return { ok: true, path: output }; },
  };
  const png = 'https://w.wallhaven.cc/full/ab/wallhaven-1.png';
  const c = new CoverFetcher({ fetch: fakeFetch({ [png]: { buf: pngBuf(3840, 2160) } }), fs, probe });
  const r = await c.tryCandidates([png], 'D:\\out', { source: 'wallhaven' });

  assert.equal(r.ok, true);
  assert.equal(r.format, 'png', '实际下载到的就是 PNG');
  assert.equal(r.file, COVER_FILE, '最终产物必须是 封面.jpg');
  assert.equal(r.converted, true, '必须经过 ffmpeg 真实转码');
  assert.equal(r.width, 3840);
  assert.equal(r.height, 2160);
  assert.ok(fs.written[0].path.endsWith('封面.png'), '不得把 png 字节直接写成 .jpg');
  assert.equal(convCalls.length, 1);
  assert.ok(convCalls[0].input.endsWith('封面.png'));
  assert.ok(convCalls[0].output.endsWith('封面.jpg'));
  assert.equal(fs.unlinked.length, 1);
});

test('WEBP 候选同样走转码路径', async () => {
  const convCalls = [];
  const probe = {
    async convertToJpg(input, output) { convCalls.push({ input, output }); return { ok: true, path: output }; },
  };
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs(), probe });
  const r = await c.saveCover(Buffer.alloc(8), { format: 'webp' }, 'D:\\out');
  assert.equal(r.file, COVER_FILE);
  assert.equal(r.converted, true);
  assert.ok(convCalls[0].input.endsWith('封面.webp'));
});

test('convertToJpg 抛异常时不崩，退回保留原格式', async () => {
  const probe = {
    async convertToJpg() { throw new Error('ffmpeg 挂了'); },
  };
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs(), probe });
  const r = await c.saveCover(pngBuf(1920, 1080), { format: 'png' }, 'D:\\out');
  assert.equal(r.ok, true);
  assert.equal(r.file, '封面.png');
  assert.equal(r.converted, false);
});

// ─────────────────────── 代理感知（缺陷 2）───────────────────────

test('未注入 fetch 时默认使用 lib/http.js 的代理感知 proxyFetch，而不是 globalThis.fetch', () => {
  const { proxyFetch } = require('../lib/http');
  const c = new CoverFetcher({ fs: fakeFs(), probe: null });
  assert.equal(c.fetch, proxyFetch, 'globalThis.fetch 不读 HTTP_PROXY，必须换成 proxyFetch');
});

test('所有请求都把 timeout / env 透传给 proxyFetch（代理与超时才会生效）', async () => {
  const calls = [];
  const c = new CoverFetcher({
    fetch: fakeFetch({}, calls),
    fs: fakeFs(),
    timeout: 9000,
    env: { HTTPS_PROXY: 'http://127.0.0.1:7990/' },
  });
  await c.httpText('https://cn.bing.com/images/search?q=x');
  await c.httpJson('https://wallhaven.cc/api/v1/search?q=x');
  await c.fetchImage('https://w.wallhaven.cc/full/ab/x.jpg');
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.opts.timeout, 9000);
    assert.equal(call.opts.env.HTTPS_PROXY, 'http://127.0.0.1:7990/');
    assert.equal(call.opts.redirect, 'follow');
  }
});

// ─────────────────────── 逐级降级 ───────────────────────

test('第 2 级 wallhaven 端到端：API → 直链 → 下载 → 校验 → 落盘', async () => {
  const api = 'https://wallhaven.cc/api/v1/search?q=Elden%20Ring&atleast=1280x720&categories=100&purity=100&sorting=relevance';
  const img = 'https://w.wallhaven.cc/full/ab/wallhaven-1.jpg';
  const fs = fakeFs();
  const c = makeCover({
    [api]: { json: { data: [{ path: img, dimension_x: 1920, dimension_y: 1080 }] } },
    [img]: { buf: jpegBuf(1920, 1080) },
  }, fs);
  const r = await c.fromWallhaven('Elden Ring', 'D:\\out');
  assert.equal(r.ok, true);
  assert.equal(r.source, 'wallhaven');
  assert.equal(r.width, 1920);
  assert.equal(fs.written.length, 1);
});

test('fetchCover 按新规范顺序降级：steam-cdn 无 appid 跳过 → wallhaven 命中', async () => {
  const events = [];
  const img = 'https://w.wallhaven.cc/full/ab/wallhaven-1.jpg';
  const c = makeCover((url) => {
    if (url.includes('wallhaven.cc/api')) {
      return { json: { data: [{ path: img, dimension_x: 1920, dimension_y: 1080 }] } };
    }
    if (url === img) return { buf: jpegBuf(1920, 1080) };
    return null; // 其它来源（Bing / reddit / Steam）一律无果
  });
  const r = await c.fetchCover('Elden Ring', 'D:\\out', {
    emit: (type, step, msg, ok, detail) => events.push({ type, msg, ok, detail }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'wallhaven');
  // steam-cdn / steam-cdn-lowres 因无 appid 被跳过，wallhaven 是第一个真正尝试的来源
  assert.deepEqual(r.tried, ['wallhaven']);
  assert.ok(!events.some((e) => e.type === 'error'), '前序失败只发日志，不发 error');
  assert.ok(events.some((e) => e.type === 'cover_download' && e.ok === true));
});

test('fetchCover 缺少入参的来源被跳过（不计入 tried）', async () => {
  const c = makeCover(() => null);
  // 不传 coverUrl / videoId / steamAppId → user / youtube / steam 两级跳过
  const r = await c.fetchCover('X', 'D:\\out');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cover-all-sources-failed');
  assert.deepEqual(r.tried, ['wallhaven', 'reddit', '4kwallpapers', 'alphacoders', 'game-sites', 'chinese-sites']);
});

test('第 4 级用户指定 URL：默认排在第 4 位，userUrlFirst 可提前', async () => {
  const user = 'https://mycdn.com/keyart.jpg';
  const make = () => makeCover((url) => {
    if (url === user) return { buf: jpegBuf(2560, 1440) };
    return null;
  });

  const r1 = await make().fetchCover('X', 'D:\\out', { coverUrl: user });
  assert.equal(r1.ok, true);
  assert.equal(r1.source, 'user');
  assert.deepEqual(r1.tried, ['wallhaven', 'reddit', 'user']);

  const r2 = await make().fetchCover('X', 'D:\\out', { coverUrl: user, userUrlFirst: true });
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.tried, ['user']);
});

test('第 10 级 YouTube 1280×720 → 达标（不再降级）', async () => {
  const thumb = 'https://i.ytimg.com/vi/vid1/maxresdefault.jpg';
  const c = makeCover((url) => (url === thumb ? { buf: jpegBuf(1280, 720) } : null));
  const r = await c.fetchCover('X', 'D:\\out', { videoId: 'vid1' });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'youtube');
  assert.equal(r.degraded, false, '1280×720 达封面最低门槛');
  assert.equal(r.width, 1280);
});

test('第 10 级 YouTube 实测达标则 degraded=false', async () => {
  const thumb = 'https://i.ytimg.com/vi/vid1/maxresdefault.jpg';
  const c = makeCover((url) => (url === thumb ? { buf: jpegBuf(1920, 1080) } : null));
  const r = await c.fetchCover('X', 'D:\\out', { videoId: 'vid1' });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
});

test('某一级抛异常不会中断整条降级链', async () => {
  const img = 'https://w.wallhaven.cc/full/ab/wallhaven-1.jpg';
  const c = makeCover((url) => {
    if (url.includes('wallhaven.cc/api')) {
      return { json: { data: [{ path: img, dimension_x: 1920, dimension_y: 1080 }] } };
    }
    if (url === img) return { buf: jpegBuf(1920, 1080) };
    return { throws: '网络被重置' };
  });
  const r = await c.fetchCover('X', 'D:\\out');
  assert.equal(r.ok, true);
  assert.equal(r.source, 'wallhaven');
});

test('全部来源失败时返回 cover-all-sources-failed 并列出尝试过的来源', async () => {
  const c = makeCover(() => ({ status: 500 }));
  const r = await c.fetchCover('X', 'D:\\out', { coverUrl: 'https://a.com/x.jpg', videoId: 'v1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cover-all-sources-failed');
  assert.deepEqual(r.tried, ['youtube', 'wallhaven', 'reddit', 'user', '4kwallpapers', 'alphacoders', 'game-sites', 'chinese-sites']);
  assert.ok(r.error.includes('wallhaven'));
});

test('HTML 错误页伪装成图片时被识别并拒绝', async () => {
  const c = makeCover({ 'https://a.com/x.jpg': { buf: Buffer.from('<!DOCTYPE html><html>404 not found</html>') } });
  const r = await c.tryCandidates(['https://a.com/x.jpg'], 'D:\\out', { source: 'test' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('无法识别图片格式'));
});

// ─────────────────────── 缺陷 3：englishTitle 链路（中文名不能喂给英文站）───────────────────────

test('hasCjk / isLatinTitle 区分中文名与拉丁标题', () => {
  assert.equal(hasCjk('正当防卫4'), true);
  assert.equal(hasCjk('仁王2'), true);
  assert.equal(hasCjk('Elden Ring'), false);
  assert.equal(isLatinTitle('Elden Ring'), true);
  assert.equal(isLatinTitle('Nioh 2'), true);
  assert.equal(isLatinTitle('艾尔登法环'), false);
  assert.equal(isLatinTitle('2077'), false, '纯数字不算拉丁标题');
  assert.equal(isLatinTitle('   '), false);
  assert.equal(isLatinTitle(null), false);
});

test('cleanEnglishTitle 去商标符号与版本后缀（Steam 实测返回值）', () => {
  assert.equal(cleanEnglishTitle('Nioh 2 – The Complete Edition'), 'Nioh 2');
  assert.equal(cleanEnglishTitle('Just Cause 4 Reloaded'), 'Just Cause 4');
  assert.equal(cleanEnglishTitle('ELDEN RING'), 'ELDEN RING');
  assert.equal(cleanEnglishTitle('Just Cause™ 4'), 'Just Cause 4');
  assert.equal(cleanEnglishTitle('Dark Souls III: Deluxe Edition'), 'Dark Souls III');
  assert.equal(cleanEnglishTitle('  '), '');
  assert.equal(cleanEnglishTitle(null), '');
  assert.equal(cleanEnglishTitle('Ultimate'), 'Ultimate');
});

test('buildQueryPlan 英文名优先、原名兜底，等价时不重复排轮次', () => {
  assert.deepEqual(buildQueryPlan('艾尔登法环', 'ELDEN RING'), ['ELDEN RING', '艾尔登法环']);
  assert.deepEqual(buildQueryPlan('仁王2', 'Nioh 2'), ['Nioh 2', '仁王2']);
  assert.deepEqual(buildQueryPlan('正当防卫4', ''), ['正当防卫4']);
  assert.deepEqual(buildQueryPlan('Elden Ring', 'Elden Ring'), ['Elden Ring']);
  assert.deepEqual(buildQueryPlan('elden ring', 'Elden Ring'), ['Elden Ring']);
  assert.deepEqual(buildQueryPlan('', ''), []);
});

test('parseSteamSearchAppId / parseSteamAppName 解析 Steam 两步反查响应', () => {
  assert.equal(parseSteamSearchAppId({ total: 1, items: [{ id: 1325200, name: '仁王２ Complete Edition' }] }), '1325200');
  assert.equal(parseSteamSearchAppId({ total: 0, items: [] }), '');
  assert.equal(parseSteamSearchAppId(null), '');
  assert.equal(parseSteamSearchAppId({}), '');

  const detail = { 1245620: { success: true, data: { name: 'ELDEN RING' } } };
  assert.equal(parseSteamAppName(detail, 1245620), 'ELDEN RING');
  assert.equal(parseSteamAppName(detail, '1245620'), 'ELDEN RING');
  assert.equal(parseSteamAppName({ 1: { success: false } }, 1), '');
  assert.equal(parseSteamAppName(null, 1), '');
});

test('buildSteamSearchUrl 必须用 l=schinese（l=english 配中文 term 实测 total=0）', () => {
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs() });
  const u = c.buildSteamSearchUrl('艾尔登法环');
  assert.ok(u.startsWith(STEAM_SEARCH_API + '?term='));
  assert.ok(u.includes('l=schinese'));
  assert.ok(u.includes('cc=CN'));
  assert.ok(!u.includes('l=english'));

  const d = c.buildSteamDetailsUrl(1245620);
  assert.ok(d.startsWith(STEAM_DETAILS_API + '?appids=1245620'));
  assert.ok(d.includes('l=english'));
});

test('resolveEnglishTitle：opts 显式传入优先，且不发任何请求', async () => {
  const calls = [];
  const c = makeCover({}, null, calls);
  const r = await c.resolveEnglishTitle('正当防卫4', { englishTitle: 'Just Cause 4' });
  assert.deepEqual(r, { title: 'Just Cause 4', source: 'opts' });
  assert.equal(calls.length, 0, 'opts 已给英文名，不该打 Steam 接口');
});

test('resolveEnglishTitle：原名本身是拉丁标题时直接复用，不打维基', async () => {
  const calls = [];
  const c = makeCover({}, null, calls);
  const r = await c.resolveEnglishTitle('Elden Ring');
  assert.deepEqual(r, { title: 'Elden Ring', source: 'origin' });
  assert.equal(calls.length, 0);
});

test('resolveEnglishTitle：中文名经维基百科反查拿到英文名并缓存', async () => {
  const zhSearchUrl = 'https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent('仁王2') + '&format=json&srlimit=1';
  const llUrl = 'https://zh.wikipedia.org/w/api.php?action=query&prop=langlinks&lllang=en&pageids=123&format=json&lllimit=1';
  const enPagesUrl = 'https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&titles=' + encodeURIComponent('Nioh 2') + '&format=json';
  const wdUrl = 'https://www.wikidata.org/wiki/Special:EntityData/Q12345.json';
  const calls = [];
  const c = makeCover({
    [zhSearchUrl]: { json: { query: { search: [{ pageid: 123, title: '仁王2' }] } } },
    [llUrl]: { json: { query: { pages: { 123: { langlinks: [{ '*': 'Nioh 2' }] } } } } },
    [enPagesUrl]: { json: { query: { pages: { '-1': { pageprops: { wikibase_item: 'Q12345' } } } } } },
    [wdUrl]: { json: { entities: { Q12345: { claims: { P1733: [{ mainsnak: { datavalue: { value: '1325200' } } }] } } } } },
  }, null, calls);
  const r = await c.resolveEnglishTitle('仁王2');
  assert.equal(r.title, 'Nioh 2');
  assert.equal(r.source, 'wiki');
  assert.equal(r.steamAppId, '1325200');
  assert.equal(calls.length, 4);

  const again = await c.resolveEnglishTitle('仁王2');
  assert.equal(again.title, 'Nioh 2');
  assert.equal(again.steamAppId, '1325200');
  assert.equal(calls.length, 4);
});

test('resolveEnglishTitle：维基百科查不到 / 出错时退回空英文名，绝不报错', async () => {
  const c1 = makeCover(() => ({ json: { query: { search: [] } } }));
  const r1 = await c1.resolveEnglishTitle('不存在的游戏名');
  assert.equal(r1.title, '');
  assert.equal(r1.source, 'none');

  const c2 = makeCover(() => ({ throws: '连接被重置' }));
  const r2 = await c2.resolveEnglishTitle('正当防卫4');
  assert.equal(r2.title, '');
  assert.equal(r2.source, 'none');

  const zhUrl = 'https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent('黑神话悟空') + '&format=json&srlimit=1';
  const llUrl = 'https://zh.wikipedia.org/w/api.php?action=query&prop=langlinks&lllang=en&pageids=999&format=json&lllimit=1';
  const c3 = makeCover({
    [zhUrl]: { json: { query: { search: [{ pageid: 999, title: '黑神话：悟空' }] } } },
    [llUrl]: { json: { query: { pages: { 999: { langlinks: [] } } } } },
  });
  const r3 = await c3.resolveEnglishTitle('黑神话悟空');
  assert.equal(r3.title, '');
  assert.equal(r3.source, 'none');

  const calls = [];
  const c4 = makeCover({}, null, calls);
  assert.deepEqual(await c4.resolveEnglishTitle('正当防卫4', { lookup: false }), { title: '', source: 'none' });
  assert.equal(calls.length, 0);
});

// 缺陷 3 回归锁：中文名绝不能被原样拼进英文站的查询串
test('fetchCover 把英文名喂给 wallhaven，而不是中文名（缺陷 3 回归锁）', async () => {
  const seen = [];
  const img = 'https://w.wallhaven.cc/full/ab/wallhaven-1.jpg';
  const c = makeCover((url) => {
    seen.push(url);
    if (url.includes('wallhaven.cc/api')) {
      return url.includes(encodeURIComponent('Elden Ring'))
        ? { json: { data: [{ path: img, dimension_x: 4417, dimension_y: 6147 }] } }
        : { json: { data: [] } };
    }
    if (url === img) return { buf: jpegBuf(4417, 6147) };
    return null;
  });

  const r = await c.fetchCover('艾尔登法环', 'D:\\out', { englishTitle: 'Elden Ring' });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'wallhaven');
  assert.equal(r.queryUsed, 'Elden Ring', '成功时必须如实上报用的是英文名');
  assert.deepEqual(r.queryPlan, ['Elden Ring', '艾尔登法环']);
  assert.equal(r.englishTitle, 'Elden Ring');
  assert.equal(r.englishTitleSource, 'opts');

  const whCalls = seen.filter((u) => u.includes('wallhaven.cc/api'));
  assert.ok(whCalls[0].includes(encodeURIComponent('Elden Ring')), '第一轮必须用英文名');
});

test('fetchCover 双轮策略：英文名无果时用原名再查一轮', async () => {
  const queries = [];
  const img = 'https://w.wallhaven.cc/full/ab/wallhaven-1.jpg';
  const c = makeCover((url) => {
    if (url.includes('wallhaven.cc/api')) {
      const q = decodeURIComponent(/[?&]q=([^&]*)/.exec(url)[1]);
      queries.push(q);
      return q === '光环'
        ? { json: { data: [{ path: img, dimension_x: 1920, dimension_y: 1080 }] } }
        : { json: { data: [] } };
    }
    if (url === img) return { buf: jpegBuf(1920, 1080) };
    return null;
  });

  const r = await c.fetchCover('光环', 'D:\\out', { englishTitle: 'Halo', sources: ['wallhaven'] });
  assert.equal(r.ok, true);
  assert.deepEqual(queries, ['Halo', '光环'], '先英文名后原名，两轮都要跑');
  assert.equal(r.queryUsed, '光环', '第二轮命中时 queryUsed 必须是原名');
});

test('fetchCover 原名即英文名时只跑一轮（不白费网络请求）', async () => {
  const queries = [];
  const c = makeCover((url) => {
    if (url.includes('wallhaven.cc/api')) {
      queries.push(decodeURIComponent(/[?&]q=([^&]*)/.exec(url)[1]));
      return { json: { data: [] } };
    }
    return null;
  });
  const r = await c.fetchCover('Elden Ring', 'D:\\out', { sources: ['wallhaven'] });
  assert.equal(r.ok, false);
  assert.deepEqual(queries, ['Elden Ring']);
  assert.equal(r.englishTitleSource, 'origin');
  assert.deepEqual(r.queryPlan, ['Elden Ring']);
});

test('fetchCover 不传 englishTitle 时自动经维基百科反查（端到端链路）', async () => {
  const zhUrl = 'https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent('仁王2') + '&format=json&srlimit=1';
  const llUrl = 'https://zh.wikipedia.org/w/api.php?action=query&prop=langlinks&lllang=en&pageids=123&format=json&lllimit=1';
  const img = 'https://w.wallhaven.cc/full/cd/wallhaven-nioh.jpg';
  const c = makeCover((url) => {
    if (url === zhUrl) return { json: { query: { search: [{ pageid: 123, title: '仁王2' }] } } };
    if (url === llUrl) return { json: { query: { pages: { 123: { langlinks: [{ '*': 'Nioh 2' }] } } } } };
    if (url.includes('wallhaven.cc/api')) {
      return url.includes(encodeURIComponent('Nioh 2'))
        ? { json: { data: [{ path: img, dimension_x: 3840, dimension_y: 2160 }] } }
        : { json: { data: [] } };
    }
    if (url === img) return { buf: jpegBuf(3840, 2160) };
    return null;
  });

  const r = await c.fetchCover('仁王2', 'D:\\out');
  assert.equal(r.ok, true);
  assert.equal(r.englishTitle, 'Nioh 2');
  assert.equal(r.englishTitleSource, 'wiki');
  assert.equal(r.queryUsed, 'Nioh 2');
  assert.deepEqual(r.queryPlan, ['Nioh 2', '仁王2']);
});

test('fetchCover 全失败时也要带上查询词决策信息，便于排查', async () => {
  const c = makeCover(() => ({ status: 500 }));
  const r = await c.fetchCover('Nioh 2', 'D:\\out');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cover-all-sources-failed');
  assert.equal(r.queryUsed, 'Nioh 2');
  assert.deepEqual(r.queryPlan, ['Nioh 2']);
  assert.equal(r.englishTitleSource, 'origin');
});

// ═══════════════════ 缺陷 4：相关性校验（绝不给错图）═══════════════════

test('normalizeTokens 规范化：小写 / 去标点 / 拆 CJK 与数字 / 去停用词 / 去重', () => {
  assert.deepEqual(normalizeTokens('Just Cause 4'), ['just', 'cause', '4']);
  assert.deepEqual(normalizeTokens('just-cause-4'), ['just', 'cause', '4']);
  assert.deepEqual(normalizeTokens('JUST_CAUSE_4'), ['just', 'cause', '4']);
  assert.deepEqual(normalizeTokens('kagurabachi-key-art'), ['kagurabachi']);
  assert.deepEqual(normalizeTokens('Elden Ring 4K Wallpaper HD'), ['elden', 'ring']);
  assert.deepEqual(normalizeTokens('正当防卫4'), ['正当防卫', '4']);
  assert.deepEqual(normalizeTokens('仁王2'), ['仁王', '2']);
  assert.deepEqual(normalizeTokens('witcher3'), ['witcher', '3']);
  assert.deepEqual(normalizeTokens('Final Fantasy VII'), ['final', 'fantasy', '7']);
  assert.deepEqual(normalizeTokens('final-fantasy-7'), ['final', 'fantasy', '7']);
  assert.deepEqual(normalizeTokens("Assassin's Creed"), ['assassins', 'creed']);
  assert.deepEqual(normalizeTokens('halo halo halo'), ['halo']);
  assert.deepEqual(normalizeTokens(''), []);
  assert.deepEqual(normalizeTokens(null), []);
});

test('extractSlugFromUrl 剥掉目录/扩展名/分辨率尾巴/站点 id，但保留续作编号', () => {
  assert.equal(
    extractSlugFromUrl('https://4kwallpapers.com/images/wallpapers/persona-4-revival-3840x2160-26747.jpg'),
    'persona-4-revival',
  );
  assert.equal(
    extractSlugFromUrl('https://4kwallpapers.com/images/wallpapers/just-cause-4-1920x1080-111.jpg'),
    'just-cause-4',
  );
  assert.equal(extractSlugFromUrl('https://4kwallpapers.com/games/just-cause-4-4142.html'), 'just-cause-4');
  assert.equal(extractSlugFromUrl('https://images.alphacoders.com/136/1360000.jpg'), '1360000');
  assert.equal(extractSlugFromUrl('https://4kwallpapers.com/'), '');
  assert.equal(extractSlugFromUrl(''), '');
  assert.equal(extractSlugFromUrl(null), '');
});

test('extractTitleFromHtml 取 og:title 优先，退回 <title>', () => {
  assert.equal(
    extractTitleFromHtml('<meta property="og:title" content="Just Cause 4 HD Wallpaper"><title>Wallpaper Abyss</title>'),
    'Just Cause 4 HD Wallpaper',
  );
  assert.equal(
    extractTitleFromHtml('<title>Just Cause 4 &amp; DLC | Wallpaper Abyss</title>'),
    'Just Cause 4 & DLC | Wallpaper Abyss',
  );
  assert.equal(extractTitleFromHtml('<html><body>no title</body></html>'), '');
  assert.equal(extractTitleFromHtml(null), '');
});

test('hasWordToken 区分「有实义词的 slug」与「纯数字 slug」', () => {
  assert.equal(hasWordToken('just-cause-4'), true);
  assert.equal(hasWordToken('1360000'), false, 'alphacoders 纯 id 直链无从判定');
  assert.equal(hasWordToken(''), false);
});

// ★ 缺陷 4 回归锁：主理人实测抓到的三个真实反例
test('isRelevantCandidate 必须判定实测错图为不相关（缺陷 4 回归锁）', () => {
  const q = normalizeTokens('just cause 4');

  assert.equal(isRelevantCandidate('persona-4-revival', q), false, 'persona-4-revival 只命中一个数字 4');
  assert.equal(isRelevantCandidate('kagurabachi-key-art', q), false, 'kagurabachi 与 just cause 毫无交集');
  assert.equal(isRelevantCandidate('just-cause-4', q), true);
  assert.equal(isRelevantCandidate('just-cause-4-avalanche-studios', q), true);
  assert.equal(
    isRelevantCandidate(extractSlugFromUrl('https://4kwallpapers.com/images/wallpapers/just-cause-4-3840x2160-777.jpg'), q),
    true,
  );
  assert.equal(
    isRelevantCandidate(
      extractSlugFromUrl('https://4kwallpapers.com/images/wallpapers/persona-4-revival-3840x2160-26747.jpg'), q,
    ),
    false,
  );
  assert.equal(
    isRelevantCandidate(
      extractSlugFromUrl('https://4kwallpapers.com/images/wallpapers/kagurabachi-key-art-3840x2160-26856.jpg'), q,
    ),
    false,
  );
});

test('isRelevantCandidate 主要 token 必须大部分命中，光命中数字不算数', () => {
  const jc4 = normalizeTokens('just cause 4');
  assert.equal(isRelevantCandidate('random-game-4', jc4), false, '只命中数字 4');
  assert.equal(isRelevantCandidate('just-another-thing', jc4), false, '只命中 just，2 个实义词要求全中');
  const god = normalizeTokens('god of war ragnarok');
  assert.equal(isRelevantCandidate('god-war-kratos', god), true, 'god+war 命中 2/3');
  assert.equal(isRelevantCandidate('god-simulator', god), false, '只命中 1/3');
});

test('isRelevantCandidate 续作编号必须对上（挡住同系列前作错配）', () => {
  const jc4 = normalizeTokens('just cause 4');
  assert.equal(isRelevantCandidate('just-cause-3', jc4), false, 'Just Cause 3 不是 Just Cause 4');
  assert.equal(isRelevantCandidate('just-cause', jc4), false, '无编号也不算 4 代');

  const nioh2 = normalizeTokens('Nioh 2');
  assert.equal(isRelevantCandidate('nioh-2-samurai', nioh2), true);
  assert.equal(isRelevantCandidate('nioh-complete-edition', nioh2), false);

  const elden = normalizeTokens('Elden Ring');
  assert.equal(isRelevantCandidate('elden-ring-malenia', elden), true);
  assert.equal(isRelevantCandidate('elden-ring-shadow-of-the-erdtree', elden), true);
  assert.equal(isRelevantCandidate('dark-souls-3', elden), false);
});

test('isRelevantCandidate 中文查询词走整段子串匹配；无实义词一律判不相关', () => {
  const cn = normalizeTokens('正当防卫4');
  assert.equal(isRelevantCandidate('正当防卫4-壁纸', cn), true);
  assert.equal(isRelevantCandidate('persona-4-revival', cn), false);
  assert.equal(isRelevantCandidate('anything', normalizeTokens('4k wallpaper')), false);
  assert.equal(isRelevantCandidate('anything', []), false);
  assert.equal(isRelevantCandidate('', normalizeTokens('just cause 4')), false);
});

// ═══════════════════ 缺陷 4 端到端：Bing 图片搜索路径（替代旧 DDG 路径）═══════════════════

test('from4kWallpapers 经 Bing：只采纳 4kwallpapers 域名且相关的原图，混入无关图被剔除', async () => {
  const fs = fakeFs();
  const right = 'https://cdn.4kwallpapers.com/just-cause-4-3840x2160-1.jpg';
  const wrong = 'https://cdn.4kwallpapers.com/persona-4-revival-3840x2160-2.jpg';
  const other = 'https://cdn.alphacoders.com/x.jpg'; // 非 4kwallpapers 域名
  const bingHtml = [
    bingItemHtml({ murl: right, purl: 'https://4kwallpapers.com/just-cause-4', t: 'Just Cause 4 Wallpaper' }),
    bingItemHtml({ murl: wrong, purl: 'https://4kwallpapers.com/persona', t: 'Persona 4' }),
    bingItemHtml({ murl: other, purl: 'https://alphacoders.com/x', t: 'Just Cause 4' }),
  ].join('\n');
  const downloaded = [];
  const c = makeCover((url) => {
    if (url.startsWith(BING_IMAGE_SEARCH)) return { text: bingHtml };
    downloaded.push(url);
    return { buf: jpegBuf(3840, 2160) };
  }, fs);

  const r = await c.from4kWallpapers('Just Cause 4', 'D:\\out', { query: 'Just Cause 4' });
  assert.equal(r.ok, true);
  assert.equal(r.url, right, '只采纳 4kwallpapers 域名且相关的那张');
  assert.deepEqual(downloaded, [right], '无关图（persona / 其它域名）连下载都不该发生');
  assert.equal(fs.written.length, 1);
  assert.equal(r.queryUsed, 'Just Cause 4');
});

test('from4kWallpapers 经 Bing：整页都不相关时干净失败而不是给错图', async () => {
  const fs = fakeFs();
  const bingHtml = bingItemHtml({ murl: 'https://cdn.4kwallpapers.com/persona-4-revival.jpg', purl: 'https://4kwallpapers.com/persona', t: 'Persona 4 Revival' });
  const c = makeCover((url) => {
    if (url.startsWith(BING_IMAGE_SEARCH)) return { text: bingHtml };
    return { buf: jpegBuf(3840, 2160) };
  }, fs);

  const r = await c.from4kWallpapers('Just Cause 4', 'D:\\out', { query: 'Just Cause 4' });
  assert.equal(r.ok, false, '整页都不相关必须干净失败');
  assert.equal(r.error, '无候选直链');
  assert.equal(fs.written.length, 0, '绝不允许把 persona 落盘成封面');
  assert.equal(r.queryUsed, 'Just Cause 4');
});

test('fromGameSites 一次 Bing 多站 OR 即可命中（不再逐站抓详情页）', async () => {
  const fs = fakeFs();
  const right = 'https://media.nintendo.com/jc4.jpg';
  const bingHtml = bingItemHtml({ murl: right, purl: 'https://nintendo.com/jc4', t: 'Just Cause 4' });
  const c = makeCover((url) => {
    if (url.startsWith(BING_IMAGE_SEARCH)) return { text: bingHtml };
    return { buf: jpegBuf(1920, 1080) };
  }, fs);

  const r = await c.fromGameSites('Just Cause 4', 'D:\\out', { query: 'Just Cause 4' });
  assert.equal(r.ok, true);
  assert.equal(r.url, right);
  assert.equal(r.source, 'game-sites');
});

test('fromChineseSites 用中文名搜中文站，命中游民星空等域名', async () => {
  const fs = fakeFs();
  const right = 'https://img.gamersky.com/jc4.jpg';
  const bingHtml = bingItemHtml({ murl: right, purl: 'https://www.gamersky.com/jc4', t: '正当防卫4 壁纸' });
  const c = makeCover((url) => {
    if (url.startsWith(BING_IMAGE_SEARCH)) return { text: bingHtml };
    return { buf: jpegBuf(1920, 1080) };
  }, fs);

  const r = await c.fromChineseSites('正当防卫4', 'D:\\out', { originalName: '正当防卫4' });
  assert.equal(r.ok, true);
  assert.equal(r.url, right);
  assert.equal(r.watermarkRisk, true);
});

test('fromReddit 相关性闸门：只采纳标题相关的贴，无关热门贴被剔除', async () => {
  const fs = fakeFs();
  const right = 'https://i.redd.it/jc4.jpg';
  const wrong = 'https://i.redd.it/cat.jpg';
  const redditUrl = 'https://www.reddit.com/r/gamewallpaper/search.json?q=' + encodeURIComponent('Just Cause 4') + '&sort=relevance&limit=10&restrict_sr=on';
  const json = {
    data: {
      children: [
        { data: { url: wrong, title: 'Cute cat wallpaper' } },
        { data: { url: right, title: 'Just Cause 4 key art' } },
      ],
    },
  };
  const downloaded = [];
  const c = makeCover((url) => {
    if (url === redditUrl) return { json };
    downloaded.push(url);
    return { buf: jpegBuf(1920, 1080) };
  }, fs);

  const r = await c.fromReddit('Just Cause 4', 'D:\\out', { query: 'Just Cause 4' });
  assert.equal(r.ok, true);
  assert.equal(r.url, right, '只采纳标题相关的贴');
  assert.deepEqual(downloaded, [right], '无关的热门贴根本不下');
});

test('fetchCover steam-cdn 优先级最高：有 appid 时先取官方图', async () => {
  const hero = 'https://cdn.akamai.steamstatic.com/steam/apps/123/capsule_616x353_2x.jpg';
  const c = makeCover({
    // resolveSteamAppId 命中缓存（直接传 steamAppId）
    [hero]: { buf: jpegBuf(1920, 1080) },
  });
  const r = await c.fetchCover('Just Cause 4', 'D:\\out', { steamAppId: '123' });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'steam-cdn');
  assert.equal(r.steamAppId, '123');
  assert.deepEqual(r.tried, ['steam-cdn'], 'steam-cdn 是第一个被尝试的来源');
  assert.equal(r.degraded, false);
});

test('fetchCover Bing 相关性拦截后继续降级到下一来源，不会把错图当成功', async () => {
  const fs = fakeFs();
  const bingHtml = bingItemHtml({ murl: 'https://cdn.4kwallpapers.com/kagurabachi.jpg', purl: 'https://4kwallpapers.com/kagura', t: 'Kagurabachi' });
  const wallhavenImg = 'https://w.wallhaven.cc/full/ab/wallhaven-jc4.jpg';
  const c = makeCover((url) => {
    if (url.startsWith(BING_IMAGE_SEARCH) && url.includes('4kwallpapers')) return { text: bingHtml };
    if (url.includes('wallhaven.cc/api')) {
      return { json: { data: [{ path: wallhavenImg, dimension_x: 3840, dimension_y: 2160 }] } };
    }
    if (url === wallhavenImg) return { buf: jpegBuf(3840, 2160) };
    return null;
  }, fs);

  const r = await c.fetchCover('Just Cause 4', 'D:\\out');
  assert.equal(r.ok, true);
  assert.equal(r.source, 'wallhaven', '4kwallpapers 因相关性不过被跳过，降级到 wallhaven');
  assert.equal(r.url, wallhavenImg);
  assert.equal(fs.written.length, 1);
});

// ── isYouTubeTitleRelevant：YouTube 反查英文名的相关性校验（防误判）──

test('isYouTubeTitleRelevant：中文搜索词+数字，宣传片标题且编号匹配 → 采纳', () => {
  assert.equal(isYouTubeTitleRelevant('Just Cause 4 Launch Trailer', '正当防卫4'), true);
  assert.equal(isYouTubeTitleRelevant('The Legend of Zelda - Nintendo Switch Presentation 2017 Trailer', '塞尔达传说'), true);
});

test('isYouTubeTitleRelevant：无关视频（无宣传片特征词）→ 拒绝，防误判', () => {
  assert.equal(isYouTubeTitleRelevant('How to make Connect 4 game', '正当防卫4'), false);
  assert.equal(isYouTubeTitleRelevant('Connect 4 world record run', '正当防卫4'), false);
});

test('isYouTubeTitleRelevant：数字编号不匹配（同系列错配）→ 拒绝', () => {
  assert.equal(isYouTubeTitleRelevant('Just Cause 3 Launch Trailer', '正当防卫4'), false);
  assert.equal(isYouTubeTitleRelevant('GTA VI Trailer', 'GTA 5'), false);
});

test('isYouTubeTitleRelevant：拉丁搜索词共享实词 → 采纳；无关 → 拒绝', () => {
  assert.equal(isYouTubeTitleRelevant('Elden Ring Official Trailer', 'Elden Ring'), true);
  assert.equal(isYouTubeTitleRelevant('How to make Connect 4 game', 'Just Cause 4'), false);
});
