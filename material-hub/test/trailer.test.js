// test/trailer.test.js —— TrailerDownloader 单测（yt-dlp 参数构造 / 结果解析 / 转码条件 / 文件名清洗）
// 注入 spawn + fs 替身，全程不执行 yt-dlp/ffmpeg、不访问网络、不写磁盘。
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  TrailerDownloader,
  runCommand,
  SEARCH_SUFFIX,
} = require('../lib/trailer');

/**
 * 构造 spawn 替身返回的假子进程。
 * @param {{stdout?: string, stderr?: string, code?: number}} [opts]
 * @returns {EventEmitter}
 */
function makeChild(opts = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    if (opts.stdout) child.stdout.emit('data', opts.stdout);
    if (opts.stderr) child.stderr.emit('data', opts.stderr);
    child.emit('close', opts.code == null ? 0 : opts.code);
  });
  return child;
}

/**
 * 构造 spawn 替身。
 * @param {object|Function} plan 固定返回值或 (cmd,args)=>opts
 * @param {Array} [calls] 记录调用
 * @returns {Function}
 */
function fakeSpawn(plan, calls) {
  return (cmd, args) => {
    if (calls) calls.push({ cmd, args });
    const opts = typeof plan === 'function' ? plan(cmd, args) : plan;
    return makeChild(opts || {});
  };
}

/**
 * 构造 fs 替身。
 * @param {string[]} entries 目录内容
 * @returns {object}
 */
function fakeFs(entries) {
  return {
    unlinked: [],
    readdirSync() { return entries || []; },
    unlinkSync(p) { this.unlinked.push(p); },
  };
}

test('buildSearchArgs 构造 ytsearch1 + 只取元数据的参数', () => {
  const t = new TrailerDownloader({ spawn: fakeSpawn({}), fs: fakeFs([]) });
  const args = t.buildSearchArgs('战神4');
  assert.equal(args[0], 'ytsearch1:战神4 ' + SEARCH_SUFFIX);
  assert.ok(args.includes('--dump-single-json'));
  assert.ok(args.includes('--no-playlist'));
  assert.ok(args.includes('--skip-download'));
  // 前后空格被 trim
  assert.equal(t.buildSearchArgs('  Elden Ring  ')[0], 'ytsearch1:Elden Ring ' + SEARCH_SUFFIX);
  assert.equal(t.buildSearchArgs(null)[0], 'ytsearch1: ' + SEARCH_SUFFIX);
});

test('parseSearchResult 解析 playlist / 单视频 / 非法输入', () => {
  const t = new TrailerDownloader({ spawn: fakeSpawn({}), fs: fakeFs([]) });
  const playlist = JSON.stringify({
    entries: [{ id: 'v1', title: 'God of War - Launch Trailer', channel: 'PlayStation', duration: 134, webpage_url: 'https://youtu.be/v1' }],
  });
  assert.deepEqual(t.parseSearchResult(playlist), {
    id: 'v1',
    title: 'God of War - Launch Trailer',
    url: 'https://youtu.be/v1',
    duration: 134,
    channel: 'PlayStation',
  });

  const single = JSON.stringify({ id: 'v2', title: 'T2' });
  const r2 = t.parseSearchResult(single);
  assert.equal(r2.id, 'v2');
  assert.equal(r2.url, 'https://www.youtube.com/watch?v=v2');
  assert.equal(r2.duration, 0);
  assert.equal(r2.channel, '');

  assert.equal(t.parseSearchResult('not json'), null);
  assert.equal(t.parseSearchResult(''), null);
  assert.equal(t.parseSearchResult(null), null);
  assert.equal(t.parseSearchResult(JSON.stringify({ entries: [] })), null);
  assert.equal(t.parseSearchResult(JSON.stringify({ title: '无 id' })), null);
});

test('buildDownloadArgs：ffmpeg 可用合流 mp4，不可用退单文件流', () => {
  const t = new TrailerDownloader({ spawn: fakeSpawn({}), fs: fakeFs([]) });
  const withFf = t.buildDownloadArgs('https://youtu.be/v1', 'dir/base.%(ext)s', { ffmpeg: true });
  assert.equal(withFf[0], '-f');
  assert.ok(withFf[1].includes('bv*'));
  assert.ok(withFf.includes('--merge-output-format'));
  assert.equal(withFf[withFf.indexOf('--merge-output-format') + 1], 'mp4');
  assert.equal(withFf[withFf.indexOf('-o') + 1], 'dir/base.%(ext)s');
  assert.equal(withFf[withFf.length - 1], 'https://youtu.be/v1');
  assert.ok(withFf.includes('--newline'));

  const noFf = t.buildDownloadArgs('https://youtu.be/v1', 'dir/base.%(ext)s', { ffmpeg: false });
  assert.ok(!noFf.includes('--merge-output-format'));
  assert.equal(noFf[1], 'b[height>=1080]/b');
});

test('needsTranscode 只对 .webm 为真', () => {
  const t = new TrailerDownloader({ spawn: fakeSpawn({}), fs: fakeFs([]) });
  assert.equal(t.needsTranscode('a.webm'), true);
  assert.equal(t.needsTranscode('A.WEBM'), true);
  assert.equal(t.needsTranscode('dir/a.webm'), true);
  assert.equal(t.needsTranscode('a.mp4'), false);
  assert.equal(t.needsTranscode('a.mkv'), false);
  assert.equal(t.needsTranscode(''), false);
  assert.equal(t.needsTranscode(null), false);
});

test('buildTranscodeArgs 严格对齐规则命令', () => {
  const t = new TrailerDownloader({ spawn: fakeSpawn({}), fs: fakeFs([]) });
  assert.deepEqual(
    t.buildTranscodeArgs('in.webm', 'out.mp4'),
    ['-y', '-i', 'in.webm', '-c:v', 'copy', '-c:a', 'aac', 'out.mp4']
  );
});

test('findDownloaded 按基名匹配、优先 mp4、忽略中间产物', () => {
  const t1 = new TrailerDownloader({ spawn: fakeSpawn({}), fs: fakeFs(['base.webm', 'base.mp4', 'other.mp4']) });
  assert.equal(t1.findDownloaded('dir', 'base'), 'base.mp4');

  const t2 = new TrailerDownloader({ spawn: fakeSpawn({}), fs: fakeFs(['base.webm']) });
  assert.equal(t2.findDownloaded('dir', 'base'), 'base.webm');

  const t3 = new TrailerDownloader({ spawn: fakeSpawn({}), fs: fakeFs(['base.mp4.part', 'base.ytdl']) });
  assert.equal(t3.findDownloaded('dir', 'base'), null);

  const t4 = new TrailerDownloader({ spawn: fakeSpawn({}), fs: fakeFs([]) });
  assert.equal(t4.findDownloaded('dir', 'base'), null);
});

test('runCommand 逐行回调 stdout/stderr 并返回退出码', async () => {
  const lines = [];
  const r = await runCommand('yt-dlp', ['--version'], {
    spawn: fakeSpawn({ stdout: 'line1\nline2\n', stderr: 'warn1\n', code: 0 }),
    onLine: (line, stream) => lines.push(stream + ':' + line),
    timeout: 5000,
  });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('line1'));
  assert.deepEqual(lines, ['stdout:line1', 'stdout:line2', 'stderr:warn1']);
});

test('searchTrailer 命中时发 trailer_search 事件并返回元数据', async () => {
  const events = [];
  const calls = [];
  const t = new TrailerDownloader({
    spawn: fakeSpawn({ stdout: JSON.stringify({ entries: [{ id: 'v1', title: 'GOW Launch Trailer', channel: 'PlayStation' }] }) }, calls),
    fs: fakeFs([]),
  });
  const info = await t.searchTrailer('战神4', { emit: (type, step, msg) => events.push({ type, msg }) });
  assert.equal(info.id, 'v1');
  assert.equal(calls[0].cmd, 'yt-dlp');
  assert.ok(calls[0].args[0].startsWith('ytsearch1:战神4'));
  assert.ok(events.some((e) => e.type === 'trailer_search' && e.msg.includes('PlayStation')));
});

test('searchTrailer 未命中返回 null', async () => {
  const t = new TrailerDownloader({ spawn: fakeSpawn({ stdout: 'garbage' }), fs: fakeFs([]) });
  assert.equal(await t.searchTrailer('查无此游戏'), null);
});

test('download 保留清洗后的原始英文名，产出文件可被定位', async () => {
  const calls = [];
  const t = new TrailerDownloader({
    spawn: fakeSpawn({ code: 0 }, calls),
    fs: fakeFs(['God_of_War_(2018)_-_Launch_Trailer.mp4']),
  });
  const r = await t.download('战神4', 'E:\\素材\\【游戏1】战神4', { ytDlp: true, ffmpeg: true }, {
    info: { id: 'v1', title: 'God of War (2018) - Launch Trailer', url: 'https://youtu.be/v1' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.file, 'God_of_War_(2018)_-_Launch_Trailer.mp4');
  assert.equal(r.title, 'God of War (2018) - Launch Trailer');
  // 输出模板用清洗后的基名 + %(ext)s
  const outArg = calls[0].args[calls[0].args.indexOf('-o') + 1];
  assert.ok(outArg.endsWith('God_of_War_(2018)_-_Launch_Trailer.%(ext)s'));
});

test('download 在 yt-dlp 缺失时直接失败，不 spawn', async () => {
  const calls = [];
  const t = new TrailerDownloader({ spawn: fakeSpawn({}, calls), fs: fakeFs([]) });
  const r = await t.download('x', 'dir', { ytDlp: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'yt-dlp-not-found');
  assert.equal(calls.length, 0);
});

test('download 未产出文件时报错', async () => {
  const t = new TrailerDownloader({ spawn: fakeSpawn({ code: 1 }), fs: fakeFs([]) });
  const r = await t.download('x', 'dir', { ytDlp: true, ffmpeg: true }, { info: { id: 'v', title: 'T', url: 'u' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'yt-dlp-failed');
});

test('transcodeIfNeeded：mp4 直接跳过；webm + ffmpeg 转码并删原文件', async () => {
  const t1 = new TrailerDownloader({ spawn: fakeSpawn({}), fs: fakeFs([]) });
  assert.deepEqual(await t1.transcodeIfNeeded('a.mp4', 'dir', { ffmpeg: true }), { file: 'a.mp4', converted: false });

  const fs2 = fakeFs([]);
  const calls = [];
  const events = [];
  const t2 = new TrailerDownloader({ spawn: fakeSpawn({ code: 0 }, calls), fs: fs2 });
  const r2 = await t2.transcodeIfNeeded('a.webm', 'dir', { ffmpeg: true }, {
    emit: (type, step, msg, ok) => events.push({ type, ok }),
  });
  assert.equal(r2.file, 'a.mp4');
  assert.equal(r2.converted, true);
  assert.equal(calls[0].cmd, 'ffmpeg');
  assert.deepEqual(calls[0].args.slice(0, 2), ['-y', '-i']);
  assert.equal(fs2.unlinked.length, 1);
  assert.ok(events.some((e) => e.type === 'trailer_transcode' && e.ok === true));
});

test('transcodeIfNeeded：ffmpeg 缺失或失败时保留 .webm，不抛异常', async () => {
  const t1 = new TrailerDownloader({ spawn: fakeSpawn({}), fs: fakeFs([]) });
  const r1 = await t1.transcodeIfNeeded('a.webm', 'dir', { ffmpeg: false });
  assert.equal(r1.file, 'a.webm');
  assert.equal(r1.converted, false);
  assert.equal(r1.reason, 'ffmpeg-not-found');

  const fs2 = fakeFs([]);
  const t2 = new TrailerDownloader({ spawn: fakeSpawn({ code: 1 }), fs: fs2 });
  const r2 = await t2.transcodeIfNeeded('a.webm', 'dir', { ffmpeg: true });
  assert.equal(r2.file, 'a.webm');
  assert.equal(r2.converted, false);
  assert.equal(r2.reason, 'ffmpeg-failed');
  assert.equal(fs2.unlinked.length, 0);
});
