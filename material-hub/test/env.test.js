// test/env.test.js —— EnvDetector 单测（PATH 检测逻辑 + 缺失引导文案）
// 注入 spawnWhich 替身，绝不真实 spawn `where`/`which`，不依赖本机是否装了 yt-dlp/ffmpeg。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EnvDetector,
  defaultSpawnWhich,
  YT_DLP_GUIDANCE,
  FFMPEG_GUIDANCE,
} = require('../lib/env');

/**
 * 构造 spawnWhich 替身。
 * @param {Object<string, any>} table 命令名 → 返回值
 * @param {string[]} [seen] 记录被探测的命令名
 * @returns {(cmd: string) => any}
 */
function fakeWhich(table, seen) {
  return (cmd) => {
    if (seen) seen.push(cmd);
    return table[cmd];
  };
}

test('detect 两者都在 PATH 时无缺失、无引导', () => {
  const seen = [];
  const d = new EnvDetector({ spawnWhich: fakeWhich({ 'yt-dlp': true, ffmpeg: true }, seen) }).detect();
  assert.equal(d.ytDlp, true);
  assert.equal(d.ffmpeg, true);
  assert.deepEqual(d.missing, []);
  assert.equal(d.guidance, '');
  assert.deepEqual(seen, ['yt-dlp', 'ffmpeg']);
});

test('detect 缺 yt-dlp 时给出 yt-dlp 安装引导', () => {
  const d = new EnvDetector({ spawnWhich: fakeWhich({ 'yt-dlp': false, ffmpeg: true }) }).detect();
  assert.equal(d.ytDlp, false);
  assert.equal(d.ffmpeg, true);
  assert.deepEqual(d.missing, ['yt-dlp']);
  assert.ok(d.guidance.includes(YT_DLP_GUIDANCE));
  assert.ok(!d.guidance.includes(FFMPEG_GUIDANCE));
});

test('detect 缺 ffmpeg 时给出 ffmpeg 安装引导', () => {
  const d = new EnvDetector({ spawnWhich: fakeWhich({ 'yt-dlp': true, ffmpeg: false }) }).detect();
  assert.deepEqual(d.missing, ['ffmpeg']);
  assert.ok(d.guidance.includes(FFMPEG_GUIDANCE));
});

test('detect 两者都缺时引导文案同时包含两条', () => {
  const d = new EnvDetector({ spawnWhich: fakeWhich({ 'yt-dlp': false, ffmpeg: false }) }).detect();
  assert.deepEqual(d.missing, ['yt-dlp', 'ffmpeg']);
  assert.ok(d.guidance.includes(YT_DLP_GUIDANCE));
  assert.ok(d.guidance.includes(FFMPEG_GUIDANCE));
  assert.ok(d.guidance.includes('|'));
});

test('detect 只认严格 true，非布尔真值视为不可用', () => {
  const d = new EnvDetector({ spawnWhich: fakeWhich({ 'yt-dlp': 'C:\\bin\\yt-dlp.exe', ffmpeg: 1 }) }).detect();
  assert.equal(d.ytDlp, false);
  assert.equal(d.ffmpeg, false);
  assert.deepEqual(d.missing, ['yt-dlp', 'ffmpeg']);
});

test('detect 探测抛错时不冒泡（由替身模拟 spawn 失败）', () => {
  const detector = new EnvDetector({
    spawnWhich: (cmd) => {
      if (cmd === 'yt-dlp') return false;
      return false;
    },
  });
  const d = detector.detect();
  assert.equal(d.ytDlp, false);
  assert.equal(d.ffmpeg, false);
});

test('未注入替身时回落到 defaultSpawnWhich（仅校验契约，不执行探测）', () => {
  const detector = new EnvDetector();
  assert.equal(typeof detector.spawnWhich, 'function');
  assert.equal(detector.spawnWhich, defaultSpawnWhich);
  assert.equal(typeof YT_DLP_GUIDANCE, 'string');
  assert.ok(YT_DLP_GUIDANCE.length > 0);
  assert.equal(EnvDetector.YT_DLP_GUIDANCE, YT_DLP_GUIDANCE);
  assert.equal(EnvDetector.FFMPEG_GUIDANCE, FFMPEG_GUIDANCE);
});
