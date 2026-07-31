// test/select-preserve.test.js —— selectPreserve helper 单测（最小 fake <select>）
// 覆盖：值命中已有 option（不加额外 option）、值不命中（追加「其它 (val)」且选中）、
// 回读正确（Number(value) 保留原值而非兜底）、空值清空、穷尽选项集合（line）正常选中。
const test = require('node:test');
const assert = require('node:assert');
const { selectPreserve } = require('../public/select-preserve.js');

// 最小 fake <select>：options 数组 + appendChild；set value 时模拟浏览器——
// 若与现有 option 不匹配则回落为空（与真实 select 行为一致）。
function makeSelect(values) {
  const sel = {
    _value: '',
    options: values.map((v) => ({ value: String(v), textContent: '', selected: false })),
    ownerDocument: null,
    appendChild(opt) {
      this.options.push(opt);
      if (opt.selected) this._value = opt.value; // 浏览器：追加 selected option 即反映到 value
    },
  };
  Object.defineProperty(sel, 'value', {
    get() { return this._value || ''; },
    set(v) {
      const matched = this.options.some((o) => o.value === v);
      this._value = matched ? v : ''; // 无匹配项 → 浏览器取消选中
    },
  });
  return sel;
}

test('命中已有 option → 不加额外 option，并正确选中', () => {
  const sel = makeSelect(['17', '171', '172', '21', '24']);
  selectPreserve(sel, 17);
  assert.strictEqual(sel.value, '17');
  assert.strictEqual(sel.options.length, 5, '不应追加 option');
  assert.ok(sel.options.every((o) => !(o.textContent || '').includes('其它')), '不应含「其它」option');
});

test('值不命中 → 追加「其它 (val)」且 selected', () => {
  const sel = makeSelect(['17', '171', '172', '21', '24']);
  selectPreserve(sel, 20);
  assert.strictEqual(sel.value, '20', '回读应为用户原值 20');
  const extra = sel.options[sel.options.length - 1];
  assert.strictEqual(extra.value, '20');
  assert.strictEqual(extra.textContent, '其它 (20)');
  assert.strictEqual(extra.selected, true);
  assert.strictEqual(sel.options.length, 6, '应仅追加 1 个 option');
});

test('回读正确：保存侧 Number(value) || 17 应读到原值 20（不静默改错）', () => {
  const sel = makeSelect(['17', '171', '172', '21', '24']);
  selectPreserve(sel, 20);
  assert.strictEqual(Number(sel.value) || 17, 20, '应保留用户原值 20 而非兜底 17');
});

test('空值 → 清空且不追加 option', () => {
  const sel = makeSelect(['17']);
  selectPreserve(sel, '');
  assert.strictEqual(sel.value, '');
  assert.strictEqual(sel.options.length, 1);
});

test('line 命中穷尽选项之一 → 正常选中，无副作用', () => {
  const sel = makeSelect(['bda2', 'upos', 'kodo', 'cos']);
  selectPreserve(sel, 'bda2');
  assert.strictEqual(sel.value, 'bda2');
  assert.strictEqual(sel.options.length, 4);
});

test('copyright 非穷尽值 → 追加「其它」并保留原值', () => {
  const sel = makeSelect(['1', '2']);
  selectPreserve(sel, 3);
  assert.strictEqual(sel.value, '3');
  assert.strictEqual(sel.options[sel.options.length - 1].textContent, '其它 (3)');
  assert.strictEqual(Number(sel.value) || 1, 3);
});
