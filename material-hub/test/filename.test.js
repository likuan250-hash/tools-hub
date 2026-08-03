// test/filename.test.js —— FilenameSanitizer 单测（清洗 / 限长 / 扩展名映射）
// 对应主理人裁定⑦：非法字符 (/ \ : * ? " < > |) → `_`，限长 180，保留可读英文原名。
const test = require('node:test');
const assert = require('node:assert/strict');
const { FilenameSanitizer, MAX_LEN, FALLBACK_BASE } = require('../lib/filename');

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
