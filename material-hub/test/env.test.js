// test/env.test.js —— EnvDetector 单测（三级解析：环境变量 > 内置 > 系统 PATH）
//
// 契约变更说明：旧版 EnvDetector 只探测系统 PATH，spawnWhich 返回布尔；
// 这正是 Bug B 的根因之一（用户机器没装 yt-dlp → 宣传片下载 100% 失败）。
// 现版本改为「解析出可执行文件绝对路径」，spawnWhich 返回路径字符串或 null，
// 并新增内置 bin/ 与 npm 安装包两级来源，同时把 ffprobe 纳入检测。本文件按新契约重写。
//
// 全部依赖（fs / env / platform / binDir / spawnWhich / resolveModuleBin）经构造函数注入，
// 绝不真实 spawn `where`/`which`，不依赖本机是否装了 yt-dlp/ffmpeg，也不读真实 bin 目录。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  EnvDetector,
  defaultSpawnWhich,
  defaultResolveModuleBin,
  ENV_YT_DLP,
  ENV_FFMPEG,
  ENV_FFPROBE,
  YT_DLP_GUIDANCE,
  FFMPEG_GUIDANCE,
  FFPROBE_GUIDANCE,
} = require('../lib/env');

/** 测试用的虚拟内置 bin 目录。 */
const BIN = 'E:\\hub\\bin';
const BUILTIN = {
  ytDlp: path.join(BIN, 'yt-dlp.exe'),
  ffmpeg: path.join(BIN, 'ffmpeg.exe'),
  ffprobe: path.join(BIN, 'ffprobe.exe'),
};

/**
 * 构造 fs 替身：只有列出的路径存在。
 * @param {string[]} [existing] 存在的绝对路径
 * @param {boolean} [throws] 为 true 时 existsSync 抛错
 * @returns {object}
 */
function fakeFs(existing = [], throws = false) {
  const set = new Set(existing);
  return {
    existsSync(p) {
      if (throws) throw new Error('EACCES');
      return set.has(p);
    },
  };
}

/**
 * 构造 spawnWhich 替身（新契约：返回绝对路径字符串或 null）。
 * @param {Object<string, any>} table 命令名 → 返回值
 * @param {string[]} [seen] 记录被探测的命令名
 * @returns {(cmd: string) => any}
 */
function fakeWhich(table = {}, seen) {
  return (cmd) => {
    if (seen) seen.push(cmd);
    return Object.prototype.hasOwnProperty.call(table, cmd) ? table[cmd] : null;
  };
}

/**
 * 构造 resolveModuleBin 替身。
 * @param {Object<string, any>} table 包名 → 路径
 * @returns {(moduleId: string) => any}
 */
function fakeModuleBin(table = {}) {
  return (id) => (Object.prototype.hasOwnProperty.call(table, id) ? table[id] : null);
}

/**
 * 构造被测对象，默认「什么都找不到」的干净环境。
 * @param {object} [over] 覆盖依赖
 * @returns {EnvDetector}
 */
function make(over = {}) {
  return new EnvDetector({
    fs: over.fs || fakeFs(over.existing || []),
    env: over.env || {},
    platform: over.platform || 'win32',
    binDir: over.binDir || BIN,
    spawnWhich: over.spawnWhich || fakeWhich({}, over.seen),
    resolveModuleBin: over.resolveModuleBin || fakeModuleBin({}),
  });
}

// ───────────────────────── 解析优先级 ─────────────────────────

test('三件套全部命中内置 bin 时无缺失、无引导', () => {
  const d = make({ existing: [BUILTIN.ytDlp, BUILTIN.ffmpeg, BUILTIN.ffprobe] }).detect();
  assert.equal(d.ytDlp, true);
  assert.equal(d.ffmpeg, true);
  assert.equal(d.ffprobe, true);
  assert.equal(d.ytDlpPath, BUILTIN.ytDlp);
  assert.equal(d.ffmpegPath, BUILTIN.ffmpeg);
  assert.equal(d.ffprobePath, BUILTIN.ffprobe);
  assert.deepEqual(d.sources, { ytDlp: 'builtin', ffmpeg: 'builtin', ffprobe: 'builtin' });
  assert.deepEqual(d.missing, []);
  assert.equal(d.guidance, '');
});

test('命中内置 bin 时不再探测系统 PATH（内置优先）', () => {
  const seen = [];
  make({
    existing: [BUILTIN.ytDlp, BUILTIN.ffmpeg, BUILTIN.ffprobe],
    spawnWhich: fakeWhich({}, seen),
  }).detect();
  assert.deepEqual(seen, []);
});

test('环境变量覆盖优先级最高，且即便文件不存在也采纳（便于测试注入）', () => {
  const d = make({
    env: {
      [ENV_YT_DLP]: 'D:\\custom\\yt-dlp.exe',
      [ENV_FFMPEG]: '  D:\\custom\\ffmpeg.exe  ',
      [ENV_FFPROBE]: 'D:\\custom\\ffprobe.exe',
    },
    existing: [BUILTIN.ytDlp, BUILTIN.ffmpeg, BUILTIN.ffprobe],
  }).detect();
  assert.equal(d.ytDlpPath, 'D:\\custom\\yt-dlp.exe');
  assert.equal(d.ffmpegPath, 'D:\\custom\\ffmpeg.exe');
  assert.equal(d.ffprobePath, 'D:\\custom\\ffprobe.exe');
  assert.deepEqual(d.sources, { ytDlp: 'env', ffmpeg: 'env', ffprobe: 'env' });
  assert.deepEqual(d.missing, []);
});

test('内置 bin 缺失时回落到 npm 安装包给出的绝对路径', () => {
  const ffm = 'E:\\hub\\node_modules\\@ffmpeg-installer\\win32-x64\\ffmpeg.exe';
  const ffp = 'E:\\hub\\node_modules\\@ffprobe-installer\\win32-x64\\ffprobe.exe';
  const d = make({
    existing: [BUILTIN.ytDlp, ffm, ffp],
    resolveModuleBin: fakeModuleBin({
      '@ffmpeg-installer/ffmpeg': ffm,
      '@ffprobe-installer/ffprobe': ffp,
    }),
  }).detect();
  assert.equal(d.sources.ytDlp, 'builtin');
  assert.equal(d.sources.ffmpeg, 'module');
  assert.equal(d.sources.ffprobe, 'module');
  assert.equal(d.ffmpegPath, ffm);
  assert.deepEqual(d.missing, []);
});

test('npm 包解析出的路径不存在时不予采纳，继续降级到 PATH', () => {
  const d = make({
    existing: [],
    resolveModuleBin: fakeModuleBin({ '@ffmpeg-installer/ffmpeg': 'E:\\不存在\\ffmpeg.exe' }),
    spawnWhich: fakeWhich({ ffmpeg: 'C:\\Windows\\ffmpeg.exe' }),
  }).detect();
  assert.equal(d.sources.ffmpeg, 'path');
  assert.equal(d.ffmpegPath, 'C:\\Windows\\ffmpeg.exe');
});

test('全部内置缺失时回落系统 PATH，并 trim 掉多余空白', () => {
  const seen = [];
  const d = make({
    spawnWhich: fakeWhich({
      'yt-dlp': 'C:\\tools\\yt-dlp.exe\n',
      ffmpeg: '  C:\\tools\\ffmpeg.exe  ',
      ffprobe: 'C:\\tools\\ffprobe.exe',
    }, seen),
  }).detect();
  assert.deepEqual(seen, ['yt-dlp', 'ffmpeg', 'ffprobe']);
  assert.deepEqual(d.sources, { ytDlp: 'path', ffmpeg: 'path', ffprobe: 'path' });
  assert.equal(d.ytDlpPath, 'C:\\tools\\yt-dlp.exe');
  assert.equal(d.ffmpegPath, 'C:\\tools\\ffmpeg.exe');
  assert.deepEqual(d.missing, []);
});

// ───────────────────────── 缺失与引导 ─────────────────────────

test('只缺 yt-dlp 时仅给出 yt-dlp 引导', () => {
  const d = make({
    existing: [BUILTIN.ffmpeg, BUILTIN.ffprobe],
  }).detect();
  assert.equal(d.ytDlp, false);
  assert.equal(d.ytDlpPath, null);
  assert.equal(d.sources.ytDlp, 'none');
  assert.deepEqual(d.missing, ['yt-dlp']);
  assert.ok(d.guidance.includes(YT_DLP_GUIDANCE));
  assert.ok(!d.guidance.includes(FFMPEG_GUIDANCE));
  assert.ok(!d.guidance.includes(FFPROBE_GUIDANCE));
});

test('只缺 ffmpeg 时仅给出 ffmpeg 引导', () => {
  const d = make({ existing: [BUILTIN.ytDlp, BUILTIN.ffprobe] }).detect();
  assert.deepEqual(d.missing, ['ffmpeg']);
  assert.ok(d.guidance.includes(FFMPEG_GUIDANCE));
  assert.ok(!d.guidance.includes(YT_DLP_GUIDANCE));
});

test('三件套全缺时引导文案按 yt-dlp / ffmpeg / ffprobe 顺序拼接', () => {
  const d = make().detect();
  assert.deepEqual(d.missing, ['yt-dlp', 'ffmpeg', 'ffprobe']);
  assert.ok(d.guidance.includes(YT_DLP_GUIDANCE));
  assert.ok(d.guidance.includes(FFMPEG_GUIDANCE));
  assert.ok(d.guidance.includes(FFPROBE_GUIDANCE));
  assert.ok(d.guidance.includes('|'));
  assert.ok(d.guidance.indexOf('yt-dlp:') < d.guidance.indexOf('ffmpeg:'));
});

test('spawnWhich 返回空串 / 空白 / 非字符串一律视为未命中', () => {
  const d = make({
    spawnWhich: fakeWhich({ 'yt-dlp': '', ffmpeg: '   ', ffprobe: true }),
  }).detect();
  assert.equal(d.ytDlp, false);
  assert.equal(d.ffmpeg, false);
  assert.equal(d.ffprobe, false);
  assert.deepEqual(d.missing, ['yt-dlp', 'ffmpeg', 'ffprobe']);
});

// ───────────────────────── 健壮性 ─────────────────────────

test('fileExists 遇 IO 异常不冒泡，视为不存在', () => {
  const d = new EnvDetector({
    fs: fakeFs([], true),
    env: {},
    platform: 'win32',
    binDir: BIN,
    spawnWhich: fakeWhich({}),
    resolveModuleBin: fakeModuleBin({}),
  });
  assert.equal(d.fileExists(BUILTIN.ytDlp), false);
  assert.equal(d.fileExists(''), false);
  assert.equal(d.fileExists(null), false);
  // detect 整体也不应抛
  const r = d.detect();
  assert.deepEqual(r.missing, ['yt-dlp', 'ffmpeg', 'ffprobe']);
});

test('builtinBinPath 按平台决定是否带 .exe', () => {
  assert.equal(make({ platform: 'win32' }).builtinBinPath('yt-dlp'), path.join(BIN, 'yt-dlp.exe'));
  assert.equal(make({ platform: 'linux' }).builtinBinPath('yt-dlp'), path.join(BIN, 'yt-dlp'));
  assert.equal(make({ platform: 'darwin' }).builtinBinPath('ffmpeg'), path.join(BIN, 'ffmpeg'));
});

test('resolveTool 各来源返回统一的 {path, source} 结构', () => {
  const d = make({ existing: [BUILTIN.ytDlp] });
  assert.deepEqual(d.resolveYtDlp(), { path: BUILTIN.ytDlp, source: 'builtin' });
  assert.deepEqual(d.resolveFfmpeg(), { path: null, source: 'none' });
  assert.deepEqual(
    d.resolveTool({ envKey: '', builtinBase: '', pathCmd: '不存在的命令' }),
    { path: null, source: 'none' },
  );
});

test('未注入替身时回落到默认实现，静态常量正确挂载', () => {
  const d = new EnvDetector();
  assert.equal(typeof d.spawnWhich, 'function');
  assert.equal(d.spawnWhich, defaultSpawnWhich);
  assert.equal(typeof d.resolveModuleBin, 'function');
  assert.equal(d.resolveModuleBin, defaultResolveModuleBin);
  assert.equal(typeof YT_DLP_GUIDANCE, 'string');
  assert.ok(YT_DLP_GUIDANCE.length > 0);
  assert.equal(EnvDetector.YT_DLP_GUIDANCE, YT_DLP_GUIDANCE);
  assert.equal(EnvDetector.FFMPEG_GUIDANCE, FFMPEG_GUIDANCE);
  assert.equal(EnvDetector.FFPROBE_GUIDANCE, FFPROBE_GUIDANCE);
  assert.equal(ENV_YT_DLP, 'MATERIAL_YT_DLP_BIN');
  assert.equal(ENV_FFMPEG, 'MATERIAL_FFMPEG_BIN');
  assert.equal(ENV_FFPROBE, 'MATERIAL_FFPROBE_BIN');
});

test('defaultResolveModuleBin 对不存在的包返回 null 而非抛错', () => {
  assert.equal(defaultResolveModuleBin('@完全不存在的/包'), null);
  assert.equal(defaultResolveModuleBin(''), null);
});
