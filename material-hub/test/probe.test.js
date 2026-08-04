// test/probe.test.js —— MediaProbe 单测（ffprobe/ffmpeg 参数构造、输出解析、抽帧回退）
// 注入 spawn + fs 替身，全程不执行任何真实二进制、不读写磁盘。
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MediaProbe, DEFAULT_SEEK, FALLBACK_SEEKS } = require('../lib/probe');

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
 * @param {object|Function} plan 固定返回或 (cmd,args)=>opts
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
 * @param {string[]} [existing] 视为存在的路径
 * @returns {object}
 */
function fakeFs(existing = []) {
  const set = new Set(existing);
  return {
    added: set,
    existsSync(p) { return set.has(p); },
  };
}

test('buildProbeArgs 逐字对齐规范《验证命令》', () => {
  const p = new MediaProbe({ spawn: fakeSpawn({}), fs: fakeFs() });
  assert.deepEqual(p.buildProbeArgs('封面.jpg'), [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0',
    '封面.jpg',
  ]);
});

test('parseProbeOutput 解析 csv=p=0 输出', () => {
  const p = new MediaProbe({ spawn: fakeSpawn({}), fs: fakeFs() });
  assert.deepEqual(p.parseProbeOutput('1920,1080'), { width: 1920, height: 1080 });
  assert.deepEqual(p.parseProbeOutput('1920,1080\n'), { width: 1920, height: 1080 });
  assert.deepEqual(p.parseProbeOutput(' 1280 , 720 \r\n'), { width: 1280, height: 720 });
  // 多流时取第一行有效数据
  assert.deepEqual(p.parseProbeOutput('\n1920,1080\n640,480\n'), { width: 1920, height: 1080 });
  assert.equal(p.parseProbeOutput(''), null);
  assert.equal(p.parseProbeOutput(null), null);
  assert.equal(p.parseProbeOutput('N/A,N/A'), null);
  assert.equal(p.parseProbeOutput('0,0'), null);
});

test('buildExtractFrameArgs 逐字对齐规范第 7 级抽帧命令（含 -y 覆盖）', () => {
  const p = new MediaProbe({ spawn: fakeSpawn({}), fs: fakeFs() });
  assert.deepEqual(p.buildExtractFrameArgs('v.mp4', '封面.jpg'), [
    '-y', '-ss', '00:00:05', '-i', 'v.mp4', '-vframes', '1', '-q:v', '2', '封面.jpg',
  ]);
  assert.equal(p.buildExtractFrameArgs('v.mp4', 'c.jpg', '00:00:30')[2], '00:00:30');
  assert.equal(DEFAULT_SEEK, '00:00:05');
});

test('buildConvertToJpgArgs 构造转 JPG 参数', () => {
  const p = new MediaProbe({ spawn: fakeSpawn({}), fs: fakeFs() });
  assert.deepEqual(p.buildConvertToJpgArgs('封面.png', '封面.jpg'), [
    '-y', '-i', '封面.png', '-q:v', '2', '封面.jpg',
  ]);
});

test('setBinaries 注入路径后才会真正 spawn', async () => {
  const calls = [];
  const p = new MediaProbe({ spawn: fakeSpawn({ stdout: '1920,1080' }, calls), fs: fakeFs() });

  // 未注入 ffprobe 路径 → 直接返回未找到，绝不 spawn
  const r0 = await p.probeSize('v.mp4');
  assert.equal(r0.ok, false);
  assert.equal(r0.reason, 'ffprobe-not-found');
  assert.equal(calls.length, 0);

  p.setBinaries({ ffprobePath: 'C:\\bin\\ffprobe.exe' });
  const r1 = await p.probeSize('v.mp4');
  assert.equal(r1.ok, true);
  assert.equal(r1.width, 1920);
  assert.equal(r1.height, 1080);
  assert.equal(calls[0].cmd, 'C:\\bin\\ffprobe.exe');
});

test('probeSize 解析失败时返回 probe-parse-failed，不抛异常', async () => {
  const p = new MediaProbe({
    spawn: fakeSpawn({ stdout: 'garbage', stderr: 'boom' }),
    fs: fakeFs(),
    ffprobePath: 'ffprobe',
  });
  const r = await p.probeSize('v.mp4');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'probe-parse-failed');
});

test('extractFrame 成功时返回产出路径与命中的 seek', async () => {
  const out = 'E:\\素材\\【游戏1】x\\封面.jpg';
  const calls = [];
  const p = new MediaProbe({
    spawn: fakeSpawn({ code: 0 }, calls),
    fs: fakeFs([out]),
    ffmpegPath: 'C:\\bin\\ffmpeg.exe',
  });
  const r = await p.extractFrame('v.mp4', out);
  assert.equal(r.ok, true);
  assert.equal(r.path, out);
  assert.equal(r.seek, '00:00:05');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'C:\\bin\\ffmpeg.exe');
});

test('extractFrame 首个时间点失败时按 FALLBACK_SEEKS 依次回退', async () => {
  const out = 'cover.jpg';
  const calls = [];
  // 前两次退出码非 0，第三次成功
  let n = 0;
  const p = new MediaProbe({
    spawn: fakeSpawn(() => { n += 1; return { code: n < 3 ? 1 : 0 }; }, calls),
    fs: fakeFs([out]),
    ffmpegPath: 'ffmpeg',
  });
  const r = await p.extractFrame('v.mp4', out);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(r.seek, FALLBACK_SEEKS[1]);
});

test('extractFrame 在 ffmpeg 缺失 / 全部时间点失败时干净返回失败', async () => {
  const p1 = new MediaProbe({ spawn: fakeSpawn({}), fs: fakeFs() });
  const r1 = await p1.extractFrame('v.mp4', 'c.jpg');
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'ffmpeg-not-found');

  // 退出码 0 但没产出文件 → 也算失败（fs 替身里不存在该路径）
  const p2 = new MediaProbe({ spawn: fakeSpawn({ code: 0 }), fs: fakeFs(), ffmpegPath: 'ffmpeg' });
  const r2 = await p2.extractFrame('v.mp4', 'c.jpg');
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'extract-failed');
});

test('convertToJpg 成功 / ffmpeg 缺失 / 退出码非 0', async () => {
  const out = 'c.jpg';
  const p1 = new MediaProbe({ spawn: fakeSpawn({ code: 0 }), fs: fakeFs([out]), ffmpegPath: 'ffmpeg' });
  assert.deepEqual(await p1.convertToJpg('c.png', out), { ok: true, path: out });

  const p2 = new MediaProbe({ spawn: fakeSpawn({ code: 0 }), fs: fakeFs() });
  assert.equal((await p2.convertToJpg('c.png', out)).reason, 'ffmpeg-not-found');

  const p3 = new MediaProbe({ spawn: fakeSpawn({ code: 1 }), fs: fakeFs([out]), ffmpegPath: 'ffmpeg' });
  assert.equal((await p3.convertToJpg('c.png', out)).reason, 'ffmpeg-failed');
});
