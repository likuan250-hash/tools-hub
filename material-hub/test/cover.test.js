// test/cover.test.js —— CoverFetcher 单测（规范六级来源的 URL 构造 / HTML 解析 / 逐级降级）
// 全程注入 fetch + fs 替身：不发任何真实网络请求，不写任何真实文件。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CoverFetcher,
  normalizeUrl,
  hostOf,
  COVER_FILE,
  DDG_HTML_URL,
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

test('buildDuckDuckGoUrl 用 site: 限定站内并带上游戏名', () => {
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs() });
  const u = c.buildDuckDuckGoUrl('4kwallpapers.com', '正当防卫4', 'key art');
  assert.ok(u.startsWith(DDG_HTML_URL + '?q='));
  const q = decodeURIComponent(u.split('?q=')[1]);
  assert.equal(q, 'site:4kwallpapers.com 正当防卫4 key art');
});

test('parseDuckDuckGoLinks 解析 uddg 跳转链接与直链，并按域名过滤', () => {
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs() });
  const html = [
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2F4kwallpapers.com%2Fgames%2Fjust-cause-4-1234.html&amp;rut=xx">Just Cause 4</a>',
    '<a href="https://4kwallpapers.com/games/another-5678.html">Another</a>',
    '<a href="https://example.com/noise.html">Noise</a>',
  ].join('\n');
  const links = c.parseDuckDuckGoLinks(html, '4kwallpapers.com');
  assert.deepEqual(links, [
    'https://4kwallpapers.com/games/just-cause-4-1234.html',
    'https://4kwallpapers.com/games/another-5678.html',
  ]);
  // 其它域名过滤后为空
  assert.deepEqual(c.parseDuckDuckGoLinks(html, 'alphacoders.com'), []);
  assert.deepEqual(c.parseDuckDuckGoLinks('', '4kwallpapers.com'), []);
  assert.deepEqual(c.parseDuckDuckGoLinks(null, '4kwallpapers.com'), []);
});

test('parse4kWallpapersDirect 只保留 ≥1280×720 档位并按面积降序', () => {
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs() });
  const html = [
    '<a href="https://4kwallpapers.com/images/wallpapers/just-cause-4-640x480-111.jpg">SD</a>',
    '<a href="https://4kwallpapers.com/images/wallpapers/just-cause-4-1280x720-111.jpg">720p</a>',
    '<a href="https://4kwallpapers.com/images/wallpapers/just-cause-4-1920x1080-111.jpg">1080p</a>',
    '<a href="/images/wallpapers/just-cause-4-3840x2160-111.jpg">4K</a>',
  ].join('\n');
  const urls = c.parse4kWallpapersDirect(html);
  assert.deepEqual(urls, [
    'https://4kwallpapers.com/images/wallpapers/just-cause-4-3840x2160-111.jpg',
    'https://4kwallpapers.com/images/wallpapers/just-cause-4-1920x1080-111.jpg',
    'https://4kwallpapers.com/images/wallpapers/just-cause-4-1280x720-111.jpg',
  ]);
  assert.deepEqual(c.parse4kWallpapersDirect('<html>nothing</html>'), []);
});

test('alphacodersIdFromUrl / buildAlphacodersCandidates 按规范做 id 前三位推断', () => {
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs() });
  assert.equal(c.alphacodersIdFromUrl('https://wall.alphacoders.com/big.php?i=1360000'), '1360000');
  assert.equal(c.alphacodersIdFromUrl('https://wall.alphacoders.com/1360000.html'), '1360000');
  assert.equal(c.alphacodersIdFromUrl('https://wall.alphacoders.com/'), null);

  assert.deepEqual(c.buildAlphacodersCandidates('1360000'), [
    'https://images.alphacoders.com/136/1360000.jpg',
    'https://images.alphacoders.com/136/1360000.png',
  ]);
  // 不足 3 位没有「前三位」可用
  assert.deepEqual(c.buildAlphacodersCandidates('12'), []);
  assert.deepEqual(c.buildAlphacodersCandidates(''), []);
});

test('parseAlphacodersDirect 提取直链并排除缩略图', () => {
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs() });
  const html = [
    '<img src="https://images.alphacoders.com/136/thumb-1920-1360000.jpg">',
    '<img src="https://images.alphacoders.com/136/1360000.jpg">',
    '<img src="//images.alphacoders.com/136/1360001.png">',
  ].join('\n');
  assert.deepEqual(c.parseAlphacodersDirect(html), [
    'https://images.alphacoders.com/136/1360000.jpg',
    'https://images.alphacoders.com/136/1360001.png',
  ]);
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
// 曾经误写成 010（anime），导致 Just Cause 4 等绝大多数游戏返回 0 条 →
// 主力可编程封面源静默失空 → 一路降级到全失败（用户实测「点击运行一直不成功」）。
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

  // 精确锁死整串拼接结果（含参数顺序），任何改动都会被这条测试拦下
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

  // 也可以在构造 CoverFetcher 时整体覆盖默认值
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

test('youtubeThumbUrl / parseOgImage', () => {
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs() });
  assert.equal(c.youtubeThumbUrl('abc123'), 'https://i.ytimg.com/vi/abc123/maxresdefault.jpg');
  const html = '<meta property="og:image" content="https://nintendo.com/a.jpg"><meta name="twitter:image" content="https://nintendo.com/b.png">';
  assert.deepEqual(c.parseOgImage(html), ['https://nintendo.com/a.jpg', 'https://nintendo.com/b.png']);
  assert.deepEqual(c.parseOgImage('<html></html>'), []);
});

// ─────────────────────── 网络请求必带 UA ───────────────────────

test('所有请求都带 User-Agent（DuckDuckGo 无 UA 会被直接拒绝）', async () => {
  const calls = [];
  const c = new CoverFetcher({ fetch: fakeFetch({}, calls), fs: fakeFs() });
  await c.httpText('https://html.duckduckgo.com/html/?q=x');
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
  // URL 号称 1920x1080，实际字节是 640×480 → 必须拒绝（URL 不可信）
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
  // 只写了达标的那一张
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

  // 空候选
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
  // 转换后原 png 被清掉
  assert.equal(fs.unlinked.length, 1);
});

test('saveCover 无 ffmpeg 时保留原扩展名，不阻断流程', async () => {
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs(), probe: null });
  const r = await c.saveCover(pngBuf(1920, 1080), { format: 'png' }, 'D:\\out');
  assert.equal(r.ok, true);
  assert.equal(r.file, '封面.png');
  assert.equal(r.converted, false);
});

// 缺陷 1 附带项：wallhaven 实测会返回 PNG（Just Cause 4 第一条就是 image/png），
// 规范要求封面必须是 封面.jpg —— 绝不允许把 png 字节直接改名成 .jpg。
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
  // 写盘时用的是真实扩展名 .png，转码后才有 .jpg，且原 png 被清理
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
  await c.httpText('https://html.duckduckgo.com/html/?q=x');
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

test('第 3 级 wallhaven 端到端：API → 直链 → 下载 → 校验 → 落盘', async () => {
  const api = 'https://wallhaven.cc/api/v1/search?q=Elden%20Ring&atleast=1280x720&categories=100&purity=100&sorting=relevance';
  const img = 'https://w.wallhaven.cc/full/ab/wallhaven-1.jpg';
  const fs = fakeFs();
  const c = new CoverFetcher({
    fetch: fakeFetch({
      [api]: { json: { data: [{ path: img, dimension_x: 1920, dimension_y: 1080 }] } },
      [img]: { buf: jpegBuf(1920, 1080) },
    }),
    fs,
  });
  const r = await c.fromWallhaven('Elden Ring', 'D:\\out');
  assert.equal(r.ok, true);
  assert.equal(r.source, 'wallhaven');
  assert.equal(r.width, 1920);
  assert.equal(fs.written.length, 1);
});

test('fetchCover 按规范顺序降级：前两级失败 → wallhaven 命中', async () => {
  const events = [];
  const img = 'https://w.wallhaven.cc/full/ab/wallhaven-1.jpg';
  const c = new CoverFetcher({
    fetch: fakeFetch((url) => {
      // DuckDuckGo 一律 503（模拟被限流）
      if (url.includes('duckduckgo.com')) return { status: 503 };
      if (url.includes('wallhaven.cc/api')) {
        return { json: { data: [{ path: img, dimension_x: 1920, dimension_y: 1080 }] } };
      }
      if (url === img) return { buf: jpegBuf(1920, 1080) };
      return null;
    }),
    fs: fakeFs(),
  });
  const r = await c.fetchCover('Elden Ring', 'D:\\out', {
    emit: (type, step, msg, ok, detail) => events.push({ type, msg, ok, detail }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'wallhaven');
  assert.deepEqual(r.tried, ['4kwallpapers', 'alphacoders', 'wallhaven']);
  // 前两级失败只发日志，不发 error，不中断
  assert.ok(!events.some((e) => e.type === 'error'));
  assert.ok(events.some((e) => e.type === 'cover_download' && e.ok === true));
});

test('fetchCover 缺少入参的来源被跳过（不计入 tried）', async () => {
  const c = new CoverFetcher({ fetch: fakeFetch({}), fs: fakeFs() });
  // 不传 coverUrl / videoId → user 与 youtube 两级跳过
  const r = await c.fetchCover('X', 'D:\\out');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cover-all-sources-failed');
  assert.deepEqual(r.tried, ['4kwallpapers', 'alphacoders', 'wallhaven', 'game-sites', 'chinese-sites']);
});

test('第 4 级用户指定 URL：默认排在规范的第 4 位，userUrlFirst 可提前', async () => {
  const user = 'https://mycdn.com/keyart.jpg';
  const make = () => new CoverFetcher({
    fetch: fakeFetch((url) => {
      if (url === user) return { buf: jpegBuf(2560, 1440) };
      return { status: 500 };
    }),
    fs: fakeFs(),
  });

  const r1 = await make().fetchCover('X', 'D:\\out', { coverUrl: user });
  assert.equal(r1.ok, true);
  assert.equal(r1.source, 'user');
  assert.deepEqual(r1.tried, ['4kwallpapers', 'alphacoders', 'wallhaven', 'user']);

  const r2 = await make().fetchCover('X', 'D:\\out', { coverUrl: user, userUrlFirst: true });
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.tried, ['user']);
});

test('第 6 级 YouTube 1280×720 → 达标（不再降级）', async () => {
  const thumb = 'https://i.ytimg.com/vi/vid1/maxresdefault.jpg';
  const c = new CoverFetcher({
    fetch: fakeFetch((url) => (url === thumb ? { buf: jpegBuf(1280, 720) } : { status: 500 })),
    fs: fakeFs(),
  });
  const r = await c.fetchCover('X', 'D:\\out', { videoId: 'vid1' });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'youtube');
  assert.equal(r.degraded, false, '1280×720 达封面最低门槛');
  assert.equal(r.width, 1280);
});

test('第 6 级 YouTube 若实测达标则 degraded=false', async () => {
  const thumb = 'https://i.ytimg.com/vi/vid1/maxresdefault.jpg';
  const c = new CoverFetcher({
    fetch: fakeFetch((url) => (url === thumb ? { buf: jpegBuf(1920, 1080) } : { status: 500 })),
    fs: fakeFs(),
  });
  const r = await c.fetchCover('X', 'D:\\out', { videoId: 'vid1' });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
});

test('某一级抛异常不会中断整条降级链', async () => {
  const img = 'https://w.wallhaven.cc/full/ab/wallhaven-1.jpg';
  const c = new CoverFetcher({
    fetch: fakeFetch((url) => {
      if (url.includes('duckduckgo.com')) return { throws: '网络被重置' };
      if (url.includes('wallhaven.cc/api')) {
        return { json: { data: [{ path: img, dimension_x: 1920, dimension_y: 1080 }] } };
      }
      if (url === img) return { buf: jpegBuf(1920, 1080) };
      return null;
    }),
    fs: fakeFs(),
  });
  const r = await c.fetchCover('X', 'D:\\out');
  assert.equal(r.ok, true);
  assert.equal(r.source, 'wallhaven');
});

test('全部来源失败时返回 cover-all-sources-failed 并列出尝试过的来源', async () => {
  const c = new CoverFetcher({
    fetch: fakeFetch(() => ({ status: 500 })),
    fs: fakeFs(),
  });
  const r = await c.fetchCover('X', 'D:\\out', { coverUrl: 'https://a.com/x.jpg', videoId: 'v1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cover-all-sources-failed');
  assert.deepEqual(r.tried, ['4kwallpapers', 'alphacoders', 'wallhaven', 'user', 'game-sites', 'chinese-sites', 'youtube']);
  assert.ok(r.error.includes('wallhaven'));
});

test('HTML 错误页伪装成图片时被识别并拒绝', async () => {
  const c = new CoverFetcher({
    fetch: fakeFetch({ 'https://a.com/x.jpg': { buf: Buffer.from('<!DOCTYPE html><html>404 not found</html>') } }),
    fs: fakeFs(),
  });
  const r = await c.tryCandidates(['https://a.com/x.jpg'], 'D:\\out', { source: 'test' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('无法识别图片格式'));
});

// ═══════════════════ 缺陷 3：englishTitle 链路（中文名不能喂给英文站）═══════════════════

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
  // 实测：仁王2 → Steam appdetails 返回 'Nioh 2 – The Complete Edition'
  assert.equal(cleanEnglishTitle('Nioh 2 – The Complete Edition'), 'Nioh 2');
  // 实测：Just Cause 4 → 'Just Cause 4 Reloaded'
  assert.equal(cleanEnglishTitle('Just Cause 4 Reloaded'), 'Just Cause 4');
  // 实测：艾尔登法环 → 'ELDEN RING'（无后缀，原样保留）
  assert.equal(cleanEnglishTitle('ELDEN RING'), 'ELDEN RING');
  assert.equal(cleanEnglishTitle('Just Cause™ 4'), 'Just Cause 4');
  assert.equal(cleanEnglishTitle('Dark Souls III: Deluxe Edition'), 'Dark Souls III');
  assert.equal(cleanEnglishTitle('  '), '');
  assert.equal(cleanEnglishTitle(null), '');
  // 全是后缀词时不许清成空串
  assert.equal(cleanEnglishTitle('Ultimate'), 'Ultimate');
});

test('buildQueryPlan 英文名优先、原名兜底，等价时不重复排轮次', () => {
  assert.deepEqual(buildQueryPlan('艾尔登法环', 'ELDEN RING'), ['ELDEN RING', '艾尔登法环']);
  assert.deepEqual(buildQueryPlan('仁王2', 'Nioh 2'), ['Nioh 2', '仁王2']);
  // 英文名缺失 → 只剩原名一轮
  assert.deepEqual(buildQueryPlan('正当防卫4', ''), ['正当防卫4']);
  // 原名本身就是英文名 → 只跑一轮，不白费一次网络请求
  assert.deepEqual(buildQueryPlan('Elden Ring', 'Elden Ring'), ['Elden Ring']);
  assert.deepEqual(buildQueryPlan('elden ring', 'Elden Ring'), ['Elden Ring']);
  assert.deepEqual(buildQueryPlan('', ''), []);
});

test('parseSteamSearchAppId / parseSteamAppName 解析 Steam 两步反查响应', () => {
  // storesearch 实测（l=schinese 才搜得到中文名，但返回的 name 也是中文，所以只取 id）
  assert.equal(parseSteamSearchAppId({ total: 1, items: [{ id: 1325200, name: '仁王２ Complete Edition' }] }), '1325200');
  assert.equal(parseSteamSearchAppId({ total: 0, items: [] }), '');
  assert.equal(parseSteamSearchAppId(null), '');
  assert.equal(parseSteamSearchAppId({}), '');

  // appdetails 实测（l=english 才拿得到英文名）
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

  // 第二步反过来：必须 l=english，否则拿回的还是中文名
  const d = c.buildSteamDetailsUrl(1245620);
  assert.ok(d.startsWith(STEAM_DETAILS_API + '?appids=1245620'));
  assert.ok(d.includes('l=english'));
});

test('resolveEnglishTitle：opts 显式传入优先，且不发任何请求', async () => {
  const calls = [];
  const c = new CoverFetcher({ fetch: fakeFetch({}, calls), fs: fakeFs() });
  const r = await c.resolveEnglishTitle('正当防卫4', { englishTitle: 'Just Cause 4' });
  assert.deepEqual(r, { title: 'Just Cause 4', source: 'opts' });
  assert.equal(calls.length, 0, 'opts 已给英文名，不该打 Steam 接口');
});

test('resolveEnglishTitle：原名本身是拉丁标题时直接复用，不打维基', async () => {
  const calls = [];
  const c = new CoverFetcher({ fetch: fakeFetch({}, calls), fs: fakeFs() });
  const r = await c.resolveEnglishTitle('Elden Ring');
  assert.deepEqual(r, { title: 'Elden Ring', source: 'origin' });
  assert.equal(calls.length, 0);
});

test('resolveEnglishTitle：中文名经维基百科反查拿到英文名并缓存', async () => {
  // 模拟 zh.wikipedia.org 搜索 + langlinks.en 两步
  const zhSearchUrl = 'https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent('仁王2') + '&format=json&srlimit=1';
  const llUrl = 'https://zh.wikipedia.org/w/api.php?action=query&prop=langlinks&lllang=en&pageids=123&format=json&lllimit=1';
  const calls = [];
  const c = new CoverFetcher({
    fetch: fakeFetch({
      [zhSearchUrl]: { json: { query: { search: [{ pageid: 123, title: '仁王2' }] } } },
      [llUrl]: { json: { query: { pages: { 123: { langlinks: [{ '*': 'Nioh 2' }] } } } } },
    }, calls),
    fs: fakeFs(),
  });
  const r = await c.resolveEnglishTitle('仁王2');
  assert.equal(r.title, 'Nioh 2');
  assert.equal(r.source, 'wiki');
  assert.equal(calls.length, 2);

  // 同名再问一次走缓存
  const again = await c.resolveEnglishTitle('仁王2');
  assert.equal(again.title, 'Nioh 2');
  assert.equal(calls.length, 2);
});

test('resolveEnglishTitle：维基百科查不到 / 出错时退回空英文名，绝不报错', async () => {
  // ① 维基无收录
  const c1 = new CoverFetcher({ fetch: fakeFetch(() => ({ json: { query: { search: [] } } })), fs: fakeFs() });
  const r1 = await c1.resolveEnglishTitle('不存在的游戏名');
  assert.equal(r1.title, '');
  assert.equal(r1.source, 'none');

  // ② 网络异常
  const c2 = new CoverFetcher({ fetch: fakeFetch(() => ({ throws: '连接被重置' })), fs: fakeFs() });
  const r2 = await c2.resolveEnglishTitle('正当防卫4');
  assert.equal(r2.title, '');
  assert.equal(r2.source, 'none');

  // ③ 有中文词条但无英文跨语言链接
  const zhUrl = 'https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent('黑神话悟空') + '&format=json&srlimit=1';
  const llUrl = 'https://zh.wikipedia.org/w/api.php?action=query&prop=langlinks&lllang=en&pageids=999&format=json&lllimit=1';
  const c3 = new CoverFetcher({
    fetch: fakeFetch({
      [zhUrl]: { json: { query: { search: [{ pageid: 999, title: '黑神话：悟空' }] } } },
      [llUrl]: { json: { query: { pages: { 999: { langlinks: [] } } } } },
    }),
    fs: fakeFs(),
  });
  const r3 = await c3.resolveEnglishTitle('黑神话悟空');
  assert.equal(r3.title, '');
  assert.equal(r3.source, 'none');

  // ④ lookup=false 直接关掉网络反查
  const calls = [];
  const c4 = new CoverFetcher({ fetch: fakeFetch({}, calls), fs: fakeFs() });
  assert.deepEqual(await c4.resolveEnglishTitle('正当防卫4', { lookup: false }), { title: '', source: 'none' });
  assert.equal(calls.length, 0);
});

// 缺陷 3 回归锁：中文名绝不能被原样拼进英文站的查询串
test('fetchCover 把英文名喂给 wallhaven，而不是中文名（缺陷 3 回归锁）', async () => {
  const seen = [];
  const img = 'https://w.wallhaven.cc/full/ab/wallhaven-1.jpg';
  const c = new CoverFetcher({
    fetch: fakeFetch((url) => {
      seen.push(url);
      if (url.includes('duckduckgo.com')) return { status: 503 };
      if (url.includes('wallhaven.cc/api')) {
        // 只有英文查询词才给结果，中文查询词返回空（真实站点行为）
        return url.includes(encodeURIComponent('Elden Ring'))
          ? { json: { data: [{ path: img, dimension_x: 4417, dimension_y: 6147 }] } }
          : { json: { data: [] } };
      }
      if (url === img) return { buf: jpegBuf(4417, 6147) };
      return null;
    }),
    fs: fakeFs(),
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
  const c = new CoverFetcher({
    fetch: fakeFetch((url) => {
      if (url.includes('wallhaven.cc/api')) {
        const q = decodeURIComponent(/[?&]q=([^&]*)/.exec(url)[1]);
        queries.push(q);
        return q === '光环'
          ? { json: { data: [{ path: img, dimension_x: 1920, dimension_y: 1080 }] } }
          : { json: { data: [] } };
      }
      if (url === img) return { buf: jpegBuf(1920, 1080) };
      return { status: 503 };
    }),
    fs: fakeFs(),
  });

  const r = await c.fetchCover('光环', 'D:\\out', { englishTitle: 'Halo', sources: ['wallhaven'] });
  assert.equal(r.ok, true);
  assert.deepEqual(queries, ['Halo', '光环'], '先英文名后原名，两轮都要跑');
  assert.equal(r.queryUsed, '光环', '第二轮命中时 queryUsed 必须是原名');
});

test('fetchCover 原名即英文名时只跑一轮（不白费网络请求）', async () => {
  const queries = [];
  const c = new CoverFetcher({
    fetch: fakeFetch((url) => {
      if (url.includes('wallhaven.cc/api')) {
        queries.push(decodeURIComponent(/[?&]q=([^&]*)/.exec(url)[1]));
        return { json: { data: [] } };
      }
      return { status: 503 };
    }),
    fs: fakeFs(),
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
  const c = new CoverFetcher({
    fetch: fakeFetch((url) => {
      if (url === zhUrl) return { json: { query: { search: [{ pageid: 123, title: '仁王2' }] } } };
      if (url === llUrl) return { json: { query: { pages: { 123: { langlinks: [{ '*': 'Nioh 2' }] } } } } };
      if (url.includes('wallhaven.cc/api')) {
        return url.includes(encodeURIComponent('Nioh 2'))
          ? { json: { data: [{ path: img, dimension_x: 3840, dimension_y: 2160 }] } }
          : { json: { data: [] } };
      }
      if (url === img) return { buf: jpegBuf(3840, 2160) };
      return { status: 503 };
    }),
    fs: fakeFs(),
  });

  const r = await c.fetchCover('仁王2', 'D:\\out');
  assert.equal(r.ok, true);
  assert.equal(r.englishTitle, 'Nioh 2');
  assert.equal(r.englishTitleSource, 'wiki');
  assert.equal(r.queryUsed, 'Nioh 2');
  assert.deepEqual(r.queryPlan, ['Nioh 2', '仁王2']);
});

test('fetchCover 全失败时也要带上查询词决策信息，便于排查', async () => {
  const c = new CoverFetcher({ fetch: fakeFetch(() => ({ status: 500 })), fs: fakeFs() });
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
  // 停用词不计入
  assert.deepEqual(normalizeTokens('kagurabachi-key-art'), ['kagurabachi']);
  assert.deepEqual(normalizeTokens('Elden Ring 4K Wallpaper HD'), ['elden', 'ring']);
  // CJK 与数字之间自动补空格
  assert.deepEqual(normalizeTokens('正当防卫4'), ['正当防卫', '4']);
  assert.deepEqual(normalizeTokens('仁王2'), ['仁王', '2']);
  // 字母数字粘连
  assert.deepEqual(normalizeTokens('witcher3'), ['witcher', '3']);
  // 罗马数字统一
  assert.deepEqual(normalizeTokens('Final Fantasy VII'), ['final', 'fantasy', '7']);
  assert.deepEqual(normalizeTokens('final-fantasy-7'), ['final', 'fantasy', '7']);
  // 撇号不制造额外 token
  assert.deepEqual(normalizeTokens("Assassin's Creed"), ['assassins', 'creed']);
  // 去重（重复词不许灌水命中率）
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
  // 站点 id 尾巴（≥4 位）剥掉，但 `just-cause-4` 的 4 必须留着
  assert.equal(extractSlugFromUrl('https://4kwallpapers.com/games/just-cause-4-4142.html'), 'just-cause-4');
  assert.equal(extractSlugFromUrl('https://wall.alphacoders.com/big.php?i=1360000'), 'big');
  assert.equal(extractSlugFromUrl('https://images.alphacoders.com/136/1360000.jpg'), '1360000');
  // 首页 / 分类页没有 slug
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

  // ① 实测错图 1：女神异闻录被当成《正当防卫4》的封面
  assert.equal(isRelevantCandidate('persona-4-revival', q), false,
    'persona-4-revival 只命中一个数字 4，绝不能算相关');
  // ② 实测错图 2：动漫《卡古拉婆娑》被当成《正当防卫4》的封面
  assert.equal(isRelevantCandidate('kagurabachi-key-art', q), false,
    'kagurabachi 与 just cause 毫无交集');
  // ③ 正例：真正的《正当防卫4》壁纸必须判相关
  assert.equal(isRelevantCandidate('just-cause-4', q), true);
  assert.equal(isRelevantCandidate('just-cause-4-avalanche-studios', q), true);
  assert.equal(
    isRelevantCandidate(extractSlugFromUrl('https://4kwallpapers.com/images/wallpapers/just-cause-4-3840x2160-777.jpg'), q),
    true,
  );
  // ④ 直接拿两条真实错图 URL 走完整链路
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
  // 3 个实义词时允许中 2 个（0.6 比例）
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

  // 无编号的游戏名不受此规则影响
  const elden = normalizeTokens('Elden Ring');
  assert.equal(isRelevantCandidate('elden-ring-malenia', elden), true);
  assert.equal(isRelevantCandidate('elden-ring-shadow-of-the-erdtree', elden), true);
  assert.equal(isRelevantCandidate('dark-souls-3', elden), false);
});

test('isRelevantCandidate 中文查询词走整段子串匹配；无实义词一律判不相关', () => {
  const cn = normalizeTokens('正当防卫4');
  assert.equal(isRelevantCandidate('正当防卫4-壁纸', cn), true);
  // 中文名 vs 英文 slug 无从校验 → 判不相关（宁可失败也不要错图）
  assert.equal(isRelevantCandidate('persona-4-revival', cn), false);
  // 查询词规范化后只剩数字/停用词 → 无从判定，一律不相关
  assert.equal(isRelevantCandidate('anything', normalizeTokens('4k wallpaper')), false);
  assert.equal(isRelevantCandidate('anything', []), false);
  assert.equal(isRelevantCandidate('', normalizeTokens('just cause 4')), false);
});

// ★ 缺陷 4 端到端回归：完整复现「DDG 返回泛结果页 → 抓到第一张达标图」的错图路径
test('from4kWallpapers 遇到泛结果页时跳过全部无关图，干净失败而不是给错图', async () => {
  const fs = fakeFs();
  // DDG 搜不到精确匹配，返回站点分类页（正是实测错图的成因）
  const listPage = 'https://4kwallpapers.com/games/';
  const c = new CoverFetcher({
    fetch: fakeFetch((url) => {
      if (url.includes('duckduckgo.com')) {
        return { text: '<a href="' + listPage + '">Games Wallpapers</a>' };
      }
      if (url === listPage) {
        return {
          text: [
            '<title>Games 4K Wallpapers</title>',
            '<img src="https://4kwallpapers.com/images/wallpapers/persona-4-revival-3840x2160-26747.jpg">',
            '<img src="https://4kwallpapers.com/images/wallpapers/kagurabachi-key-art-3840x2160-26856.jpg">',
          ].join('\n'),
        };
      }
      // 一旦真去下载这两张错图就算测试失败
      return { buf: jpegBuf(3840, 2160) };
    }),
    fs,
  });

  const r = await c.from4kWallpapers('Just Cause 4', 'D:\\out', { query: 'Just Cause 4' });
  assert.equal(r.ok, false, '整页都不相关必须干净失败');
  assert.equal(r.error, '无候选直链');
  assert.equal(fs.written.length, 0, '绝不允许把 persona / kagurabachi 落盘成封面');
  assert.equal(r.queryUsed, 'Just Cause 4');
});

test('from4kWallpapers 在相关详情页里只挑相关候选，混入的无关图被剔除', async () => {
  const fs = fakeFs();
  const detail = 'https://4kwallpapers.com/games/just-cause-4-4142.html';
  const right = 'https://4kwallpapers.com/images/wallpapers/just-cause-4-3840x2160-4142.jpg';
  const wrong = 'https://4kwallpapers.com/images/wallpapers/persona-4-revival-3840x2160-26747.jpg';
  const downloaded = [];
  const c = new CoverFetcher({
    fetch: fakeFetch((url) => {
      if (url.includes('duckduckgo.com')) return { text: '<a href="' + detail + '">Just Cause 4</a>' };
      if (url === detail) {
        // 详情页底部常带「相关壁纸」推荐位，混着别的游戏
        return { text: '<title>Just Cause 4 4K Wallpaper</title><img src="' + wrong + '"><img src="' + right + '">' };
      }
      downloaded.push(url);
      return { buf: jpegBuf(3840, 2160) };
    }),
    fs,
  });

  const r = await c.from4kWallpapers('Just Cause 4', 'D:\\out', { query: 'Just Cause 4' });
  assert.equal(r.ok, true);
  assert.equal(r.url, right);
  assert.deepEqual(downloaded, [right], '无关的 persona 图连下载都不该发生');
});

test('alphacoders 详情页 URL 是纯 id 时靠页面标题判相关性', async () => {
  const ok = 'https://wall.alphacoders.com/big.php?i=1360000';
  const bad = 'https://wall.alphacoders.com/big.php?i=1360001';
  const imgOk = 'https://images.alphacoders.com/136/1360000.jpg';
  const imgBad = 'https://images.alphacoders.com/136/1360001.jpg';
  const downloaded = [];
  const fs = fakeFs();
  const c = new CoverFetcher({
    fetch: fakeFetch((url) => {
      if (url.includes('duckduckgo.com')) {
        return { text: '<a href="' + bad + '">x</a><a href="' + ok + '">y</a>' };
      }
      if (url === bad) return { text: '<title>Persona 4 Revival HD Wallpaper</title><img src="' + imgBad + '">' };
      if (url === ok) return { text: '<title>Just Cause 4 HD Wallpaper | Wallpaper Abyss</title><img src="' + imgOk + '">' };
      downloaded.push(url);
      return { buf: jpegBuf(1920, 1080) };
    }),
    fs,
  });

  const r = await c.fromAlphacoders('Just Cause 4', 'D:\\out', { query: 'Just Cause 4' });
  assert.equal(r.ok, true);
  assert.equal(r.url, imgOk);
  assert.deepEqual(downloaded, [imgOk], '标题不相关的详情页整页跳过，其中的图一张都不下');
});

test('fetchCover 相关性拦截后继续降级到下一来源，不会把错图当成功', async () => {
  const fs = fakeFs();
  const listPage = 'https://4kwallpapers.com/games/';
  const wallhavenImg = 'https://w.wallhaven.cc/full/ab/wallhaven-jc4.jpg';
  const c = new CoverFetcher({
    fetch: fakeFetch((url) => {
      if (url.includes('duckduckgo.com') && url.includes('4kwallpapers')) {
        return { text: '<a href="' + listPage + '">Games</a>' };
      }
      if (url === listPage) {
        return { text: '<title>Games 4K Wallpapers</title><img src="https://4kwallpapers.com/images/wallpapers/kagurabachi-key-art-3840x2160-26856.jpg">' };
      }
      if (url.includes('duckduckgo.com')) return { status: 503 };
      if (url.includes('wallhaven.cc/api')) {
        return { json: { data: [{ path: wallhavenImg, dimension_x: 3840, dimension_y: 2160 }] } };
      }
      return { buf: jpegBuf(3840, 2160) };
    }),
    fs,
  });

  const r = await c.fetchCover('Just Cause 4', 'D:\\out');
  assert.equal(r.ok, true);
  assert.equal(r.source, 'wallhaven', '4kwallpapers 因相关性不过被跳过，降级到 wallhaven');
  assert.equal(r.url, wallhavenImg);
  assert.equal(fs.written.length, 1);
});
