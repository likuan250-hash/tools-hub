// test/collect.test.js —— CollectService 全流程编排单测
//
// 重点锁死 Bug B：「点击运行一直不成功」。
//   旧版 `result.success = result.coverOk`，而当时的封面源（Steam library_hero 1920×620 /
//   YouTube maxresdefault 1280×720）物理上不可能满足规范的 ≥1920×1080 → 必然判失败。
//   现在：网络封面失败或降级时，用主视频抽帧兜底（必得视频原生分辨率），
//   且 success = coverOk && trailerOk —— 只要视频下来了，整体就必然成功。
//
// 全部依赖（name/cover/trailer/probe/env/logger/fs）经构造函数注入替身，
// 不访问网络、不启动子进程、不读写磁盘。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  CollectService,
  STEP_SCAN,
  STEP_COVER,
  STEP_TRAILER,
  STEP_DONE,
  STEP_DONE_PARTIAL,
  STEP_DONE_FAIL,
} = require('../lib/collect');
const { COVER_FILE } = require('../lib/cover');

const OUT_DIR = 'E:\\素材\\';
const FOLDER_NAME = '【游戏268】正当防卫4';
const FOLDER = path.join(OUT_DIR, FOLDER_NAME);

/**
 * 构造 EnvDetector 替身。
 * @param {object} [over] 覆盖字段
 * @returns {object}
 */
function fakeEnv(over = {}) {
  const info = Object.assign({
    ytDlp: true,
    ffmpeg: true,
    ffprobe: true,
    ytDlpPath: 'E:\\bin\\yt-dlp.exe',
    ffmpegPath: 'E:\\bin\\ffmpeg.exe',
    ffprobePath: 'E:\\bin\\ffprobe.exe',
    sources: { ytDlp: 'builtin', ffmpeg: 'builtin', ffprobe: 'builtin' },
    missing: [],
    guidance: '',
  }, over);
  return { detect: () => info, info };
}

/**
 * 构造 NameResolver 替身。
 * @param {object} [over] 覆盖 reserveFolder 返回值；over.throws 时抛错
 * @returns {object}
 */
function fakeName(over = {}) {
  const calls = [];
  return {
    calls,
    reserveFolder(outputDir, gameName, opts) {
      calls.push({ outputDir, gameName, opts });
      if (over.throws) throw over.throws;
      return Object.assign({
        folder: FOLDER,
        folderName: FOLDER_NAME,
        index: 268,
        reused: false,
      }, over.reserved || {});
    },
  };
}

/**
 * 构造 TrailerDownloader 替身。
 * @param {{info?: object|null, download?: object, transcode?: object, searchThrows?: Error}} [over]
 * @returns {object}
 */
function fakeTrailer(over = {}) {
  const calls = { setBinaries: [], search: [], download: [], transcode: [] };
  return {
    calls,
    setBinaries(p) { calls.setBinaries.push(p); },
    async searchTrailer(name, opts) {
      calls.search.push({ name, opts });
      if (over.searchThrows) throw over.searchThrows;
      return over.info === undefined
        ? { id: 'vid123', title: 'Just Cause 4 - Launch Trailer', url: 'https://youtu.be/vid123', channel: 'Square Enix' }
        : over.info;
    },
    async download(name, dir, env, opts) {
      calls.download.push({ name, dir, env, opts });
      return over.download || {
        ok: true,
        file: '【游戏268】正当防卫4 Launch Trailer 免费学习版下载.mp4',
        path: path.join(dir, '【游戏268】正当防卫4 Launch Trailer 免费学习版下载.mp4'),
        title: 'Just Cause 4 - Launch Trailer',
        url: 'https://youtu.be/vid123',
        channel: 'Square Enix',
        width: 1920,
        height: 1080,
        hd: true,
      };
    },
    async transcodeIfNeeded(file, dir, env, opts) {
      calls.transcode.push({ file, dir });
      return over.transcode || { file, converted: false };
    },
  };
}

/**
 * 构造 CoverFetcher 替身。
 * @param {{result?: object, throws?: Error}} [over]
 * @returns {object}
 */
function fakeCover(over = {}) {
  const calls = [];
  return {
    calls,
    async resolveEnglishTitle(gameName, opts) {
      const eng = opts && opts.englishTitle ? opts.englishTitle : (over.englishTitle || '');
      return { title: eng, source: eng ? 'opts' : 'none' };
    },
    async fetchCover(gameName, outDir, opts) {
      calls.push({ gameName, outDir, opts });
      if (over.throws) throw over.throws;
      return over.result || {
        ok: true,
        source: 'wallhaven',
        file: COVER_FILE,
        path: path.join(outDir, COVER_FILE),
        width: 2560,
        height: 1440,
        url: 'https://w.wallhaven.cc/full/xx/wallhaven-abc.jpg',
      };
    },
  };
}

/**
 * 构造 MediaProbe 替身。
 * @param {{frame?: object, size?: object, frameThrows?: Error}} [over]
 * @returns {object}
 */
function fakeProbe(over = {}) {
  const calls = { setBinaries: [], extractFrame: [], probeSize: [] };
  return {
    calls,
    setBinaries(p) { calls.setBinaries.push(p); },
    async extractFrame(video, output, opts) {
      calls.extractFrame.push({ video, output, opts });
      if (over.frameThrows) throw over.frameThrows;
      return over.frame || { ok: true, seek: '00:00:15', file: output };
    },
    async probeSize(file, opts) {
      calls.probeSize.push({ file, opts });
      return over.size || { ok: true, width: 1920, height: 1080 };
    },
  };
}

/** 静默 logger 替身。 */
function fakeLogger() {
  const lines = [];
  return {
    lines,
    info(...a) { lines.push(['info', a.join(' ')]); },
    warn(...a) { lines.push(['warn', a.join(' ')]); },
    error(...a) { lines.push(['error', a.join(' ')]); },
  };
}

/**
 * 构造 fs 替身（仅 listDir 用到 readdirSync）。
 * @param {string[]} [entries] 素材文件夹内已有条目
 * @returns {object}
 */
function fakeFs(entries) {
  return { readdirSync() { return entries || []; } };
}

/**
 * 跑一次 collect，返回结果 + 事件流 + 各替身。
 * @param {object} [deps] 替身覆盖
 * @param {object} [opts] run 入参覆盖
 * @returns {Promise<{result: object, events: object[], deps: object}>}
 */
async function runCollect(deps = {}, opts = {}) {
  const d = {
    name: deps.name || fakeName(),
    cover: deps.cover || fakeCover(),
    trailer: deps.trailer || fakeTrailer(),
    probe: deps.probe || fakeProbe(),
    env: deps.env || fakeEnv(),
    logger: deps.logger || fakeLogger(),
    fs: deps.fs || fakeFs([]),
  };
  const svc = new CollectService(d);
  const events = [];
  const result = await svc.run(
    Object.assign({ name: '正当防卫4', outDir: OUT_DIR }, opts),
    { onEvent: (ev) => events.push(ev) },
  );
  return { result, events, deps: d };
}

/**
 * 取某类型事件。
 * @param {object[]} events 事件流
 * @param {string} type 类型
 * @returns {object[]}
 */
function ofType(events, type) {
  return events.filter((e) => e.type === type);
}

// ───────────────────────── 正常路径 ─────────────────────────

test('全绿路径：新建文件夹 + 视频 + 网络封面 → success=true，不触发抽帧', async () => {
  const probe = fakeProbe();
  const { result, events } = await runCollect({ probe });

  assert.equal(result.success, true);
  assert.equal(result.partial, false);
  assert.equal(result.coverOk, true);
  assert.equal(result.trailerOk, true);
  assert.equal(result.reused, false);
  assert.equal(result.folder, FOLDER);
  assert.equal(result.index, 268);
  assert.equal(result.cover.source, 'wallhaven');
  assert.equal(result.cover.degraded, false);
  assert.equal(result.trailer.hd, true);

  // 封面达标，不应抽帧
  assert.equal(probe.calls.extractFrame.length, 0);
  assert.equal(ofType(events, 'cover_extract').length, 0);

  const done = ofType(events, 'done')[0];
  assert.equal(done.step, STEP_DONE);
  assert.equal(done.ok, true);
  assert.equal(done.detail.coverOk, true);
  assert.equal(done.detail.trailerOk, true);
});

test('环境三件套一次性解析并注入 probe / trailer（Bug B 根因之一）', async () => {
  const probe = fakeProbe();
  const trailer = fakeTrailer();
  await runCollect({ probe, trailer });

  assert.deepEqual(probe.calls.setBinaries[0], {
    ffmpegPath: 'E:\\bin\\ffmpeg.exe',
    ffprobePath: 'E:\\bin\\ffprobe.exe',
  });
  assert.deepEqual(trailer.calls.setBinaries[0], {
    ytDlpPath: 'E:\\bin\\yt-dlp.exe',
    ffmpegPath: 'E:\\bin\\ffmpeg.exe',
  });
});

test('先下视频后取封面：宣传片 videoId 透传给封面模块（第 6 级来源前提）', async () => {
  const cover = fakeCover();
  const trailer = fakeTrailer();
  await runCollect({ cover, trailer }, { coverUrl: 'https://example.com/my.jpg' });

  // 顺序：searchTrailer 先于 fetchCover
  assert.equal(trailer.calls.search.length, 1);
  assert.equal(cover.calls.length, 1);
  assert.equal(cover.calls[0].opts.videoId, 'vid123');
  assert.equal(cover.calls[0].opts.coverUrl, 'https://example.com/my.jpg');
  assert.equal(cover.calls[0].outDir, FOLDER);
});

// ───────────────────────── Bug B 核心：抽帧兜底 ─────────────────────────

test('【Bug B 核心】网络封面 6 级全失败 + 视频成功 → 抽帧兜底 → 整体判成功', async () => {
  const probe = fakeProbe({ frame: { ok: true, seek: '00:00:15' }, size: { ok: true, width: 1920, height: 1080 } });
  const cover = fakeCover({
    result: {
      ok: false,
      reason: 'cover-all-sources-failed',
      error: '规范前 6 级封面来源均未取到达标图',
      tried: ['4kwallpapers', 'alphacoders', 'wallhaven', 'game-sites', 'chinese-sites', 'reddit', 'youtube'],
    },
  });
  const { result, events } = await runCollect({ probe, cover });

  // 旧版在这里会 success=false（result.success = result.coverOk）
  assert.equal(result.success, true);
  assert.equal(result.partial, false);
  assert.equal(result.coverOk, true);
  assert.equal(result.trailerOk, true);
  assert.equal(result.cover.source, 'ffmpeg-frame');
  assert.equal(result.cover.file, COVER_FILE);
  assert.equal(result.cover.width, 1920);
  assert.equal(result.cover.height, 1080);
  assert.equal(result.cover.degraded, false);

  // 抽帧确实被调用，且输出到 封面.jpg
  assert.equal(probe.calls.extractFrame.length, 1);
  assert.equal(probe.calls.extractFrame[0].output, path.join(FOLDER, COVER_FILE));
  assert.equal(probe.calls.extractFrame[0].video, result.trailer.path);

  const extract = ofType(events, 'cover_extract')[0];
  assert.ok(extract);
  assert.ok(extract.msg.includes('抽帧兜底'));
  const dl = ofType(events, 'cover_download').find((e) => e.detail && e.detail.source === 'ffmpeg-frame');
  assert.ok(dl);
  assert.equal(dl.ok, true);
  assert.equal(dl.detail.seek, '00:00:15');

  // 不应再对外报封面失败
  assert.equal(ofType(events, 'error').length, 0);
  const done = ofType(events, 'done')[0];
  assert.equal(done.step, STEP_DONE);
  assert.equal(done.ok, true);
});

test('YouTube 官方 720p 缩略图保留，不再被抽帧覆盖（发售宣传图优先）', async () => {
  const probe = fakeProbe({ frame: { ok: true, seek: '00:00:05' }, size: { ok: true, width: 1920, height: 1080 } });
  const cover = fakeCover({
    result: {
      ok: true,
      degraded: true,
      source: 'youtube',
      file: COVER_FILE,
      path: path.join(FOLDER, COVER_FILE),
      width: 1280,
      height: 720,
    },
  });
  const { result, events } = await runCollect({ probe, cover });

  assert.equal(result.success, true);
  assert.equal(result.cover.source, 'youtube');
  assert.equal(result.cover.height, 720);
  assert.equal(result.cover.degraded, true);
  assert.equal(probe.calls.extractFrame.length, 0, '官方图不触发抽帧');
  assert.equal(ofType(events, 'cover_extract').length, 0);
});

test('YouTube 官方图直接采纳，仍判成功（有总比没有强）', async () => {
  const probe = fakeProbe({ frame: { ok: false, reason: 'extract-failed', error: 'ffmpeg 退出码 1' } });
  const cover = fakeCover({
    result: { ok: true, degraded: true, source: 'youtube', file: COVER_FILE, path: path.join(FOLDER, COVER_FILE), width: 1280, height: 720 },
  });
  const { result, events } = await runCollect({ probe, cover });

  assert.equal(result.success, true);
  assert.equal(result.coverOk, true);
  assert.equal(result.cover.source, 'youtube');
  assert.equal(result.cover.degraded, true);
  assert.equal(probe.calls.extractFrame.length, 0);
});

test('抽帧产出低于 1280×720 时标记 degraded 但不判失败', async () => {
  const probe = fakeProbe({ frame: { ok: true, seek: '00:00:05' }, size: { ok: true, width: 960, height: 540 } });
  const cover = fakeCover({ result: { ok: false, reason: 'cover-all-sources-failed', error: 'x', tried: [] } });
  const { result } = await runCollect({ probe, cover });

  assert.equal(result.success, true);
  assert.equal(result.cover.source, 'ffmpeg-frame');
  assert.equal(result.cover.degraded, true);
});

test('抽帧后读不到尺寸时采纳结果，不因此判失败', async () => {
  const probe = fakeProbe({ frame: { ok: true, seek: '00:00:05' }, size: { ok: false, error: 'parse-failed' } });
  const cover = fakeCover({ result: { ok: false, reason: 'cover-all-sources-failed', error: 'x', tried: [] } });
  const { result } = await runCollect({ probe, cover });

  assert.equal(result.success, true);
  assert.equal(result.cover.source, 'ffmpeg-frame');
  assert.equal(result.cover.degraded, false);
  assert.equal(result.cover.width, undefined);
});

test('抽帧抛异常被吞掉，不使整个流程崩溃', async () => {
  const probe = fakeProbe({ frameThrows: new Error('spawn EACCES') });
  const cover = fakeCover({ result: { ok: false, reason: 'cover-all-sources-failed', error: '全挂', tried: ['wallhaven'] } });
  const { result, events } = await runCollect({ probe, cover });

  assert.equal(result.coverOk, false);
  assert.equal(result.trailerOk, true);
  assert.equal(result.success, false);
  assert.equal(result.partial, true);
  const err = ofType(events, 'error').find((e) => e.detail.group === 'cover');
  assert.ok(err);
  assert.deepEqual(err.detail.tried, ['wallhaven']);
});

test('没有视频时不触发抽帧（抽帧的前提就是有视频）', async () => {
  const probe = fakeProbe();
  const cover = fakeCover({ result: { ok: false, reason: 'cover-all-sources-failed', error: '全挂', tried: [] } });
  const trailer = fakeTrailer({ download: { ok: false, reason: 'trailer-not-found', error: '未搜索到符合规范的官方宣传片' } });
  const { result, events } = await runCollect({ probe, cover, trailer });

  assert.equal(probe.calls.extractFrame.length, 0);
  assert.equal(result.success, false);
  assert.equal(result.partial, false);
  const done = ofType(events, 'done')[0];
  assert.equal(done.step, STEP_DONE_FAIL);
  assert.ok(done.msg.includes('仅创建了文件夹'));
});

// ───────────────────────── 视频侧分支 ─────────────────────────

test('yt-dlp 缺失时给出明确报错与引导，封面仍继续走 → partial', async () => {
  const env = fakeEnv({ ytDlp: false, ytDlpPath: null, missing: ['yt-dlp'], guidance: '请运行 npm run prepare:material-bins' });
  const trailer = fakeTrailer();
  const { result, events } = await runCollect({ env, trailer });

  assert.equal(trailer.calls.search.length, 0);
  assert.equal(trailer.calls.download.length, 0);
  assert.equal(result.trailerOk, false);
  assert.equal(result.coverOk, true);
  assert.equal(result.success, false);
  assert.equal(result.partial, true);

  const err = ofType(events, 'error').find((e) => e.detail.reason === 'yt-dlp-not-found');
  assert.ok(err);
  assert.equal(err.detail.group, 'trailer');
  assert.equal(err.step, STEP_TRAILER);
  assert.ok(ofType(events, 'log').some((e) => e.msg.includes('缺少依赖')));

  const done = ofType(events, 'done')[0];
  assert.equal(done.step, STEP_DONE_PARTIAL);
  assert.ok(done.msg.includes('仅封面落盘'));
});

test('searchTrailer 抛异常时降级为 trailer-exception，不中断封面流程', async () => {
  const trailer = fakeTrailer({ searchThrows: new Error('yt-dlp 执行超时（90s）') });
  const { result, events } = await runCollect({ trailer });

  assert.equal(result.trailerOk, false);
  assert.equal(result.coverOk, true);
  const err = ofType(events, 'error').find((e) => e.detail.reason === 'trailer-exception');
  assert.ok(err);
  assert.ok(err.msg.includes('超时'));
});

test('下载到 .webm 时经转码得到最终 mp4 文件名', async () => {
  const webm = '【游戏268】正当防卫4 Launch Trailer 免费学习版下载.webm';
  const mp4 = '【游戏268】正当防卫4 Launch Trailer 免费学习版下载.mp4';
  const trailer = fakeTrailer({
    download: { ok: true, file: webm, title: 'T', url: 'u' },
    transcode: { file: mp4, converted: true },
  });
  const { result, events } = await runCollect({ trailer });

  assert.equal(result.trailer.file, mp4);
  assert.equal(result.trailer.converted, true);
  assert.equal(result.trailer.path, path.join(FOLDER, mp4));
  assert.equal(trailer.calls.transcode[0].file, webm);
  const ev = ofType(events, 'trailer_download').find((e) => e.detail && e.detail.converted === true);
  assert.ok(ev);
});

test('download 的命名参数（编号 / 英文名 / 版本描述 / kind）如实透传', async () => {
  const trailer = fakeTrailer();
  await runCollect({ trailer }, {
    englishName: 'Just Cause 4',
    versionDesc: '官方中文+全DLC',
    kind: 'main',
    developer: 'Avalanche Studios',
  });
  const o = trailer.calls.download[0].opts;
  assert.equal(o.index, 268);
  assert.equal(o.englishName, 'Just Cause 4');
  assert.equal(o.versionDesc, '官方中文+全DLC');
  assert.equal(o.kind, 'main');
  assert.equal(trailer.calls.search[0].opts.developer, 'Avalanche Studios');
});

// ───────────────────────── 复用路径（Bug A 贯通） ─────────────────────────

test('复用已有文件夹时 reused 贯通到 scan 事件与 done 事件', async () => {
  const name = fakeName({ reserved: { reused: true } });
  const { result, events } = await runCollect({ name });

  assert.equal(result.reused, true);
  const scan = ofType(events, 'scan').find((e) => e.ok === true);
  assert.ok(scan.msg.includes('复用已有文件夹'));
  assert.equal(scan.detail.reused, true);
  assert.equal(scan.detail.index, 268);
  assert.equal(ofType(events, 'done')[0].detail.reused, true);
  // 复用判定由 name.js 负责，编排层不再传 startIndex
  assert.equal(name.calls[0].opts, undefined);
});

test('复用文件夹里已有封面与视频时直接沿用，不重复下载', async () => {
  const name = fakeName({ reserved: { reused: true } });
  const fs = fakeFs(['封面.jpg', '【游戏268】正当防卫4 Launch Trailer 免费学习版下载.mp4', '.uploaded']);
  const trailer = fakeTrailer();
  const cover = fakeCover();
  const probe = fakeProbe();
  const { result, events } = await runCollect({ name, fs, trailer, cover, probe });

  assert.equal(trailer.calls.download.length, 0);
  assert.equal(cover.calls.length, 0);
  assert.equal(probe.calls.extractFrame.length, 0);
  assert.equal(result.success, true);
  assert.equal(result.cover.source, 'reused');
  assert.equal(result.cover.reused, true);
  assert.equal(result.trailer.reused, true);
  assert.ok(ofType(events, 'trailer_download')[0].msg.includes('复用已有视频'));
  assert.ok(ofType(events, 'cover_download')[0].msg.includes('复用已有封面'));
});

test('.uploaded 标记文件不会被误当成视频产物', async () => {
  const name = fakeName({ reserved: { reused: true } });
  const fs = fakeFs(['.uploaded']);
  const trailer = fakeTrailer();
  const { result } = await runCollect({ name, fs, trailer });

  assert.equal(trailer.calls.download.length, 1);
  assert.equal(result.trailer.reused, false);
});

test('force=true 时忽略既有产物强制重下', async () => {
  const name = fakeName({ reserved: { reused: true } });
  const fs = fakeFs(['封面.jpg', 'old.mp4']);
  const trailer = fakeTrailer();
  const cover = fakeCover();
  const { result } = await runCollect({ name, fs, trailer, cover }, { force: true });

  assert.equal(trailer.calls.download.length, 1);
  assert.equal(cover.calls.length, 1);
  assert.equal(result.cover.source, 'wallhaven');
  assert.equal(result.trailer.reused, false);
});

test('forceTrailer=true 单独勾选：只重下视频，封面复用', async () => {
  const name = fakeName({ reserved: { reused: true } });
  const fs = fakeFs(['封面.jpg', 'old.mp4']);
  const trailer = fakeTrailer();
  const cover = fakeCover();
  const { result } = await runCollect({ name, fs, trailer, cover }, { forceTrailer: true });

  assert.equal(trailer.calls.download.length, 1, '应重新下载视频');
  assert.equal(cover.calls.length, 0, '封面应复用，不重下');
  assert.equal(result.cover.source, 'reused');
  assert.equal(result.trailer.reused, false);
});

test('forceCover=true 单独勾选：只重找封面，视频复用', async () => {
  const name = fakeName({ reserved: { reused: true } });
  const fs = fakeFs(['封面.jpg', 'old.mp4']);
  const trailer = fakeTrailer();
  const cover = fakeCover();
  const { result } = await runCollect({ name, fs, trailer, cover }, { forceCover: true });

  assert.equal(trailer.calls.download.length, 0, '视频应复用，不重下');
  assert.equal(cover.calls.length, 1, '应重新获取封面');
  assert.equal(result.trailer.reused, true);
  assert.equal(result.cover.source, 'wallhaven');
});

// ───────────────────────── 失败与边界 ─────────────────────────

test('游戏名为空时立即结束，不建目录不联网', async () => {
  const name = fakeName();
  const cover = fakeCover();
  const trailer = fakeTrailer();
  const { result, events } = await runCollect({ name, cover, trailer }, { name: '   ' });

  assert.equal(result.success, false);
  assert.equal(result.folder, '');
  assert.equal(name.calls.length, 0);
  assert.equal(cover.calls.length, 0);
  assert.equal(trailer.calls.download.length, 0);
  assert.equal(ofType(events, 'error')[0].detail.reason, 'empty-name');
  assert.equal(ofType(events, 'done')[0].step, STEP_DONE_FAIL);
});

test('创建素材文件夹失败时明确报错并终止', async () => {
  const err = new Error('拒绝访问');
  err.code = 'EPERM';
  const name = fakeName({ throws: err });
  const cover = fakeCover();
  const { result, events } = await runCollect({ name, cover });

  assert.equal(result.success, false);
  assert.equal(result.folder, '');
  assert.equal(cover.calls.length, 0);
  const e = ofType(events, 'error')[0];
  assert.equal(e.detail.reason, 'mkdir-failed');
  assert.equal(e.step, STEP_SCAN);
  assert.equal(e.detail.outDir, OUT_DIR);
  assert.equal(ofType(events, 'done')[0].step, STEP_DONE_FAIL);
});

test('cover.fetchCover 抛异常时兜成 cover-exception，不炸整个流程', async () => {
  const cover = fakeCover({ throws: new Error('fetch is not a function') });
  const probe = fakeProbe({ frame: { ok: true, seek: '00:00:05' } });
  const { result } = await runCollect({ cover, probe });

  // 有视频 → 仍走抽帧兜底 → 最终成功
  assert.equal(result.success, true);
  assert.equal(result.cover.source, 'ffmpeg-frame');
});

test('onEvent 抛异常（客户端断开）不影响流程与返回值', async () => {
  const svc = new CollectService({
    name: fakeName(),
    cover: fakeCover(),
    trailer: fakeTrailer(),
    probe: fakeProbe(),
    env: fakeEnv(),
    logger: fakeLogger(),
    fs: fakeFs([]),
  });
  const result = await svc.run({ name: '正当防卫4', outDir: OUT_DIR }, {
    onEvent() { throw new Error('client aborted'); },
  });
  assert.equal(result.success, true);
});

test('未传 handlers 时不报错', async () => {
  const svc = new CollectService({
    name: fakeName(),
    cover: fakeCover(),
    trailer: fakeTrailer(),
    probe: fakeProbe(),
    env: fakeEnv(),
    logger: fakeLogger(),
    fs: fakeFs([]),
  });
  const result = await svc.run({ name: '正当防卫4', outDir: OUT_DIR });
  assert.equal(result.success, true);
});

test('所有 SSE 事件形状统一：type/step/msg/ok 四字段齐备', async () => {
  const { events } = await runCollect();
  assert.ok(events.length > 0);
  for (const ev of events) {
    assert.equal(typeof ev.type, 'string', 'type 必须是字符串');
    assert.equal(typeof ev.step, 'string', 'step 必须是字符串');
    assert.equal(typeof ev.msg, 'string', 'msg 必须是字符串');
    assert.ok(ev.ok === true || ev.ok === false || ev.ok === null, 'ok 必须是 true/false/null');
    if (ev.detail !== undefined) assert.equal(typeof ev.detail, 'object');
  }
  // done 永远是最后一条
  assert.equal(events[events.length - 1].type, 'done');
  assert.equal(ofType(events, 'done').length, 1);
});

test('done 事件携带完整落盘信息供前端渲染', async () => {
  const { events } = await runCollect();
  const done = ofType(events, 'done')[0];
  assert.equal(done.detail.folder, FOLDER);
  assert.equal(done.detail.folderName, FOLDER_NAME);
  assert.equal(done.detail.index, 268);
  assert.equal(done.detail.reused, false);
  assert.equal(done.detail.partial, false);
  assert.equal(done.detail.cover.source, 'wallhaven');
  assert.equal(done.detail.trailer.hd, true);
  assert.ok(done.msg.includes(FOLDER));
});

test('未传 outDir 时使用规范默认根目录 E:\\素材\\', async () => {
  const name = fakeName();
  const svc = new CollectService({
    name,
    cover: fakeCover(),
    trailer: fakeTrailer(),
    probe: fakeProbe(),
    env: fakeEnv(),
    logger: fakeLogger(),
    fs: fakeFs([]),
  });
  await svc.run({ name: '正当防卫4' });
  assert.equal(name.calls[0].outputDir, 'E:\\素材\\');
});

// ─────────────────────── 交互式封面选择 ───────────────────────

/** 交互式测试用 CoverFetcher 替身：collectCandidates 直接返回固定候选。 */
function fakeInteractiveCover(over = {}) {
  const calls = { collectCandidates: [], applyCandidate: [] };
  return {
    calls,
    async resolveEnglishTitle(gameName, opts) {
      const eng = opts && opts.englishTitle ? opts.englishTitle : '';
      return { title: eng, source: eng ? 'opts' : 'none' };
    },
    async collectCandidates(gameName, opts) {
      calls.collectCandidates.push({ gameName, opts });
      if (over.collectThrows) throw over.collectThrows;
      return over.candidates === undefined
        ? {
            ok: true,
            candidates: [
              { url: 'https://cdn.akamai.steamstatic.com/steam/apps/517630/capsule_616x353_2x.jpg', source: 'steam-cdn', label: 'Steam 官方图' },
              { url: 'https://w.wallhaven.cc/full/xx/wallhaven-abc.jpg', source: 'wallhaven', label: 'wallhaven.cc' },
            ],
            queryPlan: ['Just Cause 4'],
            englishTitle: '',
            steamAppId: '517630',
          }
        : over.candidates;
    },
    async applyCandidate(url, outDir, opts) {
      calls.applyCandidate.push({ url, outDir, opts });
      if (over.applyThrows) throw over.applyThrows;
      return {
        ok: true,
        source: (opts && opts.source) || 'user',
        file: COVER_FILE,
        path: path.join(outDir, COVER_FILE),
        width: 1920,
        height: 1080,
        url,
      };
    },
  };
}

/** 轮询等待指定类型事件出现。 */
async function waitEvent(events, type, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const ev = events.find((e) => e.type === type);
    if (ev) return ev;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('等待事件超时: ' + type);
}

test('交互式封面：发出 cover_candidates → chooseCover 选中 → 应用所选 URL', async () => {
  const cover = fakeInteractiveCover();
  const svc = new CollectService({
    name: fakeName(),
    cover,
    trailer: fakeTrailer(),
    probe: fakeProbe(),
    env: fakeEnv(),
    logger: fakeLogger(),
    fs: fakeFs([]),
  });
  const events = [];
  const p = svc.run(
    { name: '正当防卫4', outDir: OUT_DIR, coverInteractive: true },
    { onEvent: (ev) => events.push(ev) },
  );
  const ev = await waitEvent(events, 'cover_candidates');
  assert.equal(ev.detail.candidates.length, 2);
  assert.equal(ev.detail.candidates[0].source, 'steam-cdn');
  const pickedUrl = ev.detail.candidates[1].url;
  assert.equal(svc.chooseCover(ev.detail.requestId, pickedUrl), true);
  const result = await p;
  assert.equal(result.coverOk, true);
  assert.equal(cover.calls.applyCandidate.length, 1);
  assert.equal(cover.calls.applyCandidate[0].url, pickedUrl);
  assert.equal(cover.calls.applyCandidate[0].opts.source, 'wallhaven');
});

test('交互式封面：跳过选择 → 走主视频抽帧兜底', async () => {
  const cover = fakeInteractiveCover();
  const probe = fakeProbe();
  const svc = new CollectService({
    name: fakeName(),
    cover,
    trailer: fakeTrailer(),
    probe,
    env: fakeEnv(),
    logger: fakeLogger(),
    fs: fakeFs([]),
  });
  const events = [];
  const p = svc.run(
    { name: '正当防卫4', outDir: OUT_DIR, coverInteractive: true },
    { onEvent: (ev) => events.push(ev) },
  );
  const ev = await waitEvent(events, 'cover_candidates');
  assert.equal(svc.chooseCover(ev.detail.requestId, ''), true);
  const result = await p;
  assert.equal(cover.calls.applyCandidate.length, 0);
  assert.equal(probe.calls.extractFrame.length, 1);
  assert.equal(result.coverOk, true);
  assert.equal(result.cover.source, 'ffmpeg-frame');
});

test('交互式封面：无候选 → 直接失败走抽帧兜底（不发 cover_candidates）', async () => {
  const cover = fakeInteractiveCover({ candidates: { ok: false, candidates: [], reason: 'cover-no-candidates', error: '无候选封面' } });
  const probe = fakeProbe();
  const { result, events } = await runCollect({ cover, probe }, { coverInteractive: true });
  assert.equal(ofType(events, 'cover_candidates').length, 0);
  assert.equal(cover.calls.applyCandidate.length, 0);
  assert.equal(probe.calls.extractFrame.length, 1);
  assert.equal(result.coverOk, true);
  assert.equal(result.cover.source, 'ffmpeg-frame');
});
