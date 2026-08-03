// test/filename.test.js —— FilenameSanitizer 单测（清洗 / 限长 / 扩展名映射）
// 对应主理人裁定⑦：非法字符 (/ \ : * ? " < > |) → `_`，限长 180，保留可读英文原名。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FilenameSanitizer,
  MAX_LEN,
  FALLBACK_BASE,
  FREE_SUFFIX,
  LAUNCH_MARK,
  DEFAULT_VERSION_DESC,
} = require('../lib/filename');

const s = new FilenameSanitizer();

test('sanitize 把 Windows 非法字符替换为下划线', () => {
  assert.equal(s.sanitize('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  // 控制字符同样清洗
  assert.equal(s.sanitize('ab\u0001cd'), 'ab_cd');
});

test('sanitize 默认把空白折叠为下划线（宣传片文件名场景）', () => {
  assert.equal(
    s.sanitize('God of War (2018) - Launch Trailer'),
    'God_of_War_(2018)_-_Launch_Trailer'
  );
  assert.equal(s.sanitize('a    b'), 'a_b');
  assert.equal(s.sanitize('a\t\nb'), 'a_b');
});

test('sanitize space:keep 保留空格（文件夹名场景）', () => {
  assert.equal(s.sanitize('Elden Ring', { space: 'keep' }), 'Elden Ring');
  assert.equal(s.sanitize('Elden   Ring', { space: 'keep' }), 'Elden Ring');
  assert.equal(s.sanitize('黑神话:悟空', { space: 'keep' }), '黑神话_悟空');
  // 全角冒号在 Windows 合法，不应被清洗
  assert.equal(s.sanitize('黑神话：悟空', { space: 'keep' }), '黑神话：悟空');
});

test('sanitize 去首尾点/空格/下划线并折叠重复下划线', () => {
  assert.equal(s.sanitize('  ..trailer..  '), 'trailer');
  assert.equal(s.sanitize('a___b'), 'a_b');
  assert.equal(s.sanitize('name.'), 'name');
  assert.equal(s.sanitize('_name_'), 'name');
});

test('sanitize 空值回退到 trailer，永不返回空串', () => {
  assert.equal(s.sanitize(''), FALLBACK_BASE);
  assert.equal(s.sanitize(null), FALLBACK_BASE);
  assert.equal(s.sanitize(undefined), FALLBACK_BASE);
  assert.equal(s.sanitize('   '), FALLBACK_BASE);
  assert.equal(s.sanitize('///'), FALLBACK_BASE);
});

test('truncate / sanitize 限长 180', () => {
  assert.equal(s.truncate('abcdef', 3), 'abc');
  assert.equal(s.truncate('abc', 10), 'abc');
  assert.equal(s.truncate(null, 5), '');
  assert.equal(s.truncate('abcdef', 0), 'abcdef'); // 非法 max 回退默认 180
  const long = 'x'.repeat(300);
  assert.equal(s.sanitize(long).length, MAX_LEN);
  assert.equal(s.sanitize(long, { max: 20 }).length, 20);
});

test('extForFormat 容器格式 → 扩展名，未知回退 .mp4', () => {
  assert.equal(s.extForFormat('mp4'), '.mp4');
  assert.equal(s.extForFormat('.WEBM'), '.webm');
  assert.equal(s.extForFormat('mkv'), '.mkv');
  assert.equal(s.extForFormat('jpeg'), '.jpg');
  assert.equal(s.extForFormat('png'), '.png');
  assert.equal(s.extForFormat('unknown'), '.mp4');
  assert.equal(s.extForFormat(''), '.mp4');
  assert.equal(s.extForFormat(null), '.mp4');
});

test('buildFileName 组合清洗基名与扩展名且总长不超 180', () => {
  assert.equal(
    s.buildFileName('God of War (2018) - Launch Trailer', 'mp4'),
    'God_of_War_(2018)_-_Launch_Trailer.mp4'
  );
  assert.equal(s.buildFileName('Trailer: 4K/60fps', 'webm'), 'Trailer_4K_60fps.webm');
  const name = s.buildFileName('y'.repeat(400), 'webm');
  assert.equal(name.length, MAX_LEN);
  assert.ok(name.endsWith('.webm'));
});

// ─────────────────── 规范《视频命名规范》构造 ───────────────────
// Launch Trailer：【游戏XXX】游戏名 英文版名 Launch Trailer 免费学习版下载.mp4
// 主视频        ：【游戏XXX】游戏名 版本描述 免费学习版下载.mp4

test('indexPrefix 与文件夹编号同源，补零到 3 位', () => {
  assert.equal(s.indexPrefix(267), '【游戏267】');
  assert.equal(s.indexPrefix(7), '【游戏007】');
  assert.equal(s.indexPrefix(1234), '【游戏1234】');
  assert.equal(s.indexPrefix(NaN), '【游戏000】');
  assert.equal(s.indexPrefix(-5), '【游戏000】');
  assert.equal(s.indexPrefix(undefined), '【游戏000】');
});

test('joinParts 丢弃空片段并折叠多余空格', () => {
  assert.equal(s.joinParts(['a', '', '  b  ', null, 'c']), 'a b c');
  assert.equal(s.joinParts(['单段']), '单段');
  assert.equal(s.joinParts([]), '');
  assert.equal(s.joinParts(null), '');
});

test('buildLaunchTrailerName 生成规范示例同款文件名', () => {
  assert.equal(
    s.buildLaunchTrailerName(267, '忍者龙剑传4', { englishName: 'The Two Masters' }),
    '【游戏267】忍者龙剑传4 The Two Masters Launch Trailer 免费学习版下载.mp4'
  );
  // 无英文版名时该段省略，不留双空格
  assert.equal(
    s.buildLaunchTrailerName(264, '光环：战役进化'),
    '【游戏264】光环：战役进化 ' + LAUNCH_MARK + ' ' + FREE_SUFFIX + '.mp4'
  );
  // 规范另一示例：mark 显式置空则省略类型标识
  assert.equal(
    s.buildLaunchTrailerName(264, '光环：战役进化', { mark: '' }),
    '【游戏264】光环：战役进化 免费学习版下载.mp4'
  );
});

test('buildLaunchTrailerName 清洗非法字符并支持自定义扩展名', () => {
  assert.equal(
    s.buildLaunchTrailerName(3, 'Ratchet & Clank: Rift Apart', { englishName: 'Rift Apart' }),
    '【游戏003】Ratchet & Clank_ Rift Apart Rift Apart Launch Trailer 免费学习版下载.mp4'
  );
  assert.ok(s.buildLaunchTrailerName(1, 'x', { ext: 'webm' }).endsWith('.webm'));
  assert.ok(s.buildLaunchTrailerName(1, 'x', { ext: 'unknown' }).endsWith('.mp4'));
  // 超长输入仍不超过 180
  const long = s.buildLaunchTrailerName(1, 'g'.repeat(300), { englishName: 'e'.repeat(300) });
  assert.ok(long.length <= MAX_LEN);
  assert.ok(long.endsWith('.mp4'));
});

test('buildMainVideoName 默认带规范版本描述，可自定义或省略', () => {
  assert.equal(
    s.buildMainVideoName(265, '模拟人生4'),
    '【游戏265】模拟人生4 ' + DEFAULT_VERSION_DESC + ' ' + FREE_SUFFIX + '.mp4'
  );
  assert.equal(
    s.buildMainVideoName(265, '模拟人生4'),
    '【游戏265】模拟人生4 官方中文+全DLC+免安装硬盘版 免费学习版下载.mp4'
  );
  assert.equal(
    s.buildMainVideoName(265, '模拟人生4', { versionDesc: '中文豪华版' }),
    '【游戏265】模拟人生4 中文豪华版 免费学习版下载.mp4'
  );
  assert.equal(
    s.buildMainVideoName(265, '模拟人生4', { versionDesc: '' }),
    '【游戏265】模拟人生4 免费学习版下载.mp4'
  );
});

test('两种命名的编号前缀与文件夹编号严格一致，且都以规范后缀收尾', () => {
  const launch = s.buildLaunchTrailerName(268, '正当防卫4');
  const main = s.buildMainVideoName(268, '正当防卫4');
  assert.ok(launch.startsWith('【游戏268】'));
  assert.ok(main.startsWith('【游戏268】'));
  assert.ok(launch.includes(FREE_SUFFIX + '.'));
  assert.ok(main.includes(FREE_SUFFIX + '.'));
});
