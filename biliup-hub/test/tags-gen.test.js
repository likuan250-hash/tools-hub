// biliup-hub/test/tags-gen.test.js —— 标签自动生成 genTags 单测（需求②）
// genTags 为自包含纯函数（停用词内联），从 public/app.js 中抽取后独立运行验证。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// 从源码中按括号配平提取函数源码（与 app.renderer.test.js 同源）。
function extractFunction(src, name) {
  const sig = 'function ' + name + '(';
  const start = src.indexOf(sig);
  if (start < 0) throw new Error('未找到函数: ' + name);
  let k = src.indexOf('{', start);
  let depth = 0, inStr = null, inTmpl = false;
  for (; k < src.length; k++) {
    const ch = src[k];
    if (inStr) { if (ch === '\\') { k++; continue; } if (ch === inStr) inStr = null; continue; }
    if (inTmpl) { if (ch === '\\') { k++; continue; } if (ch === '`') inTmpl = false; continue; }
    if (ch === "'" || ch === '"') { inStr = ch; continue; }
    if (ch === '`') { inTmpl = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { k++; break; } }
  }
  return src.slice(start, k);
}

// 在沙箱中实例化 genTags（自包含，不依赖模块作用域变量）。
function makeGenTags() {
  const ctx = { Math, Set, String, Array };
  vm.createContext(ctx);
  vm.runInContext('var genTags = (' + extractFunction(appSrc, 'genTags') + ');', ctx);
  return ctx.genTags;
}

test('genTags: 去扩展名 + 基础分词（空格/_/-）', () => {
  const genTags = makeGenTags();
  const r = genTags('Fallout4_Gameplay_HD.mp4', '', '单机游戏');
  // Fallout4 / Gameplay 保留；HD 命中停用词被过滤；默认标签 单机游戏 叠加
  assert.ok(r.split(',').includes('Fallout4'), '应含 Fallout4');
  assert.ok(r.split(',').includes('Gameplay'), '应含 Gameplay');
  assert.ok(r.split(',').includes('单机游戏'), '应叠加默认标签 单机游戏');
  assert.ok(!r.split(',').includes('HD'), 'HD 应被停用词过滤');
  assert.ok(!r.split(',').includes('mp4'), '扩展名 mp4 不应残留');
});

test('genTags: 中文文件名按分隔符分词', () => {
  const genTags = makeGenTags();
  const r = genTags('辐射4 实况 - 第1期.mp4', '', '');
  assert.ok(r.split(',').includes('辐射4'), '应含 辐射4');
  assert.ok(r.split(',').includes('实况'), '应含 实况');
  assert.ok(r.split(',').includes('第1期'), '应含 第1期（整体不被拆）');
});

test('genTags: 过滤停用词与过短词（≤1 字）', () => {
  const genTags = makeGenTags();
  const r = genTags('视频 测试 the a 我', '', '');
  const parts = r.split(',');
  assert.ok(parts.includes('测试'), '测试 应保留');
  assert.ok(!parts.includes('视频'), '视频 为停用词应过滤');
  assert.ok(!parts.includes('the'), 'the 为停用词应过滤');
  assert.ok(!parts.includes('a'), 'a 为停用词应过滤');
  assert.ok(!parts.includes('我'), '单字 我 过短应过滤');
});

test('genTags: 叠加默认标签并去重（不重复出现）', () => {
  const genTags = makeGenTags();
  const r = genTags('辐射4', '', '辐射4,RPG');
  const parts = r.split(',');
  assert.ok(parts.includes('辐射4'), '应有 辐射4');
  assert.ok(parts.includes('RPG'), '应叠加 RPG');
  // 去重：辐射4 只出现一次
  assert.equal(parts.filter((p) => p === '辐射4').length, 1, '辐射4 不应因默认标签重复');
});

test('genTags: 默认标签可被独立提供（逗号分隔，支持中英文逗号）', () => {
  const genTags = makeGenTags();
  // 标题「视频」为停用词被全过滤，仅剩默认标签；默认标签含中文逗号分隔。
  const r = genTags('', '视频', '单机游戏，RPG');
  const parts = r.split(',');
  assert.deepEqual(parts.sort(), ['RPG', '单机游戏'].sort(), '中文逗号分隔的默认标签应被解析且标题被全过滤');
});

test('genTags: 限长 ≤10', () => {
  const genTags = makeGenTags();
  const many = Array.from({ length: 15 }, (_, i) => '词' + i).join('_');
  const r = genTags(many, '', '');
  assert.ok(r.split(',').length <= 10, '标签数量应不超过 10');
  assert.equal(r.split(',').length, 10, '恰好截到 10');
});

test('genTags: 空入参安全返回空串', () => {
  const genTags = makeGenTags();
  assert.equal(genTags('', '', ''), '');
  assert.equal(genTags(undefined, undefined, undefined), '');
});

test('genTags: 优先用标题（标题非空时忽略文件名）', () => {
  const genTags = makeGenTags();
  const r = genTags('unused_filename.mp4', '标题A 标题B', '默认标签');
  const parts = r.split(',');
  assert.ok(parts.includes('标题A') && parts.includes('标题B'), '应基于标题分词');
  assert.ok(parts.includes('默认标签'), '应叠加默认标签');
  assert.ok(!parts.includes('unused'), '不应混入文件名（标题优先）');
});

test('genTags: 序号前缀剥离 + 敏感词过滤（正当防卫4 场景）', () => {
  const genTags = makeGenTags();
  const r = genTags('【游戏268】正当防卫4 官方中文+全DLC+免安装硬盘版 免费学习版下载.mp4', '', '');
  const parts = r.split(',');
  assert.ok(parts.includes('正当防卫4'), '应含 正当防卫4（序号前缀剥离后）');
  assert.ok(parts.includes('全DLC'), '应保留 全DLC（内容关键词）');
  assert.ok(!parts.some((p) => p.includes('【') || p.includes('】')), '不应含方括号残留');
  assert.ok(!parts.some((p) => p.includes('游戏268')), '不应含序号前缀 游戏268');
  assert.ok(!parts.some((p) => p.includes('学习版')), '不应含敏感词 学习版 子串');
  assert.ok(!parts.some((p) => p.includes('官方中文')), '不应含版本描述词 官方中文');
  assert.ok(!parts.some((p) => p.includes('免安装')), '不应含版本描述词 免安装');
});

test('genTags: 纯英文标题分词合理（Elden Ring Official Launch Trailer）', () => {
  const genTags = makeGenTags();
  const r = genTags('', 'Elden Ring Official Launch Trailer', '');
  const parts = r.split(',');
  assert.ok(parts.includes('Elden') && parts.includes('Ring'), '应含 Elden/Ring');
  assert.ok(parts.includes('Official'), '应含 Official');
  assert.ok(parts.includes('Launch') && parts.includes('Trailer'), '应含 Launch/Trailer');
});

test('genTags: 中英混合分隔符切分（战神4-God of War）', () => {
  const genTags = makeGenTags();
  const r = genTags('战神4-God of War.mp4', '', '');
  const parts = r.split(',');
  assert.ok(parts.includes('战神4'), '应含 战神4');
  assert.ok(parts.includes('God') && parts.includes('War'), '应含 God/War');
  assert.ok(!parts.includes('of'), 'of 为停用词应过滤');
});

test('genTags: 敏感词子串整体丢弃（xx学习版）', () => {
  const genTags = makeGenTags();
  const r = genTags('xx学习版下载 测试', '', '');
  const parts = r.split(',');
  assert.ok(!parts.some((p) => p.includes('学习版')), '含 学习版 子串的 token 应整体丢弃');
  assert.ok(parts.includes('测试'), '其余正常 token 应保留');
});

test('genTags: 长度上限（>12 丢弃，正当防卫4 剥离后保留）', () => {
  const genTags = makeGenTags();
  // 【游戏268】剥离后剩 正当防卫4（5 字符），保留
  const r = genTags('【游戏268】正当防卫4', '', '');
  assert.ok(r.split(',').includes('正当防卫4'), '剥离序号前缀后 正当防卫4 应保留');
  // 无分隔符超长粘连串（26 字符 > 12）应整串丢弃
  const long = '这是一个超级无敌非常非常长的没有任何意义的内容标签测试串';
  assert.equal(genTags(long, '', ''), '', '超长 token 应被过滤');
});
