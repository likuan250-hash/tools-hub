// 弹窗自动填充：纯函数逻辑 + 真机 dryRun 扫描（不会写入任何值）
const test = require('node:test');
const assert = require('node:assert');

const af = require('../src/client-autofill');

test('isDownloadDialogTitle: 识别下载/保存/目录类标题，普通页面不算', () => {
  assert.strictEqual(af.isDownloadDialogTitle('选择保存目录'), true);
  assert.strictEqual(af.isDownloadDialogTitle('Download to folder'), true);
  assert.strictEqual(af.isDownloadDialogTitle('另存为'), true);
  assert.strictEqual(af.isDownloadDialogTitle('首页 - 夸克网盘'), false);
  assert.strictEqual(af.isDownloadDialogTitle(''), false);
});

test('pickPathEdit: 优先"值已是盘符路径"的框', () => {
  const edits = [
    { name: '搜索', value: '' },
    { name: '保存位置', value: 'C:\\Users\\x\\Downloads' },
  ];
  assert.deepStrictEqual(af.pickPathEdit(edits, 'E:\\网盘中转'), { index: 1, reason: 'value-is-path' });
});

test('pickPathEdit: 其次看名字含目录/路径，再次唯一框，最后回退第一个', () => {
  assert.deepStrictEqual(
    af.pickPathEdit([{ name: '关键字' }, { name: '下载目录' }], 'E:\\x'),
    { index: 1, reason: 'name-hint' }
  );
  assert.deepStrictEqual(af.pickPathEdit([{ name: 'only' }], 'E:\\x'), { index: 0, reason: 'only-one' });
  assert.deepStrictEqual(
    af.pickPathEdit([{ name: 'a' }, { name: 'b' }], 'E:\\x'),
    { index: 0, reason: 'fallback-first' }
  );
  assert.strictEqual(af.pickPathEdit([], 'E:\\x'), null);
});

test('autofill: dryRun 只扫描不写入（本机夸克已开则应能读到窗口）', () => {
  const r = af.autofill('quark', 'E:\\网盘中转');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(r.applied, false, 'dryRun 绝不能写入');
  console.log('    扫描结果:', JSON.stringify({ windows: r.windows, dialogTitle: r.dialogTitle, edits: r.edits.length }));
});
