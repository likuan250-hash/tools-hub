// drag-geometry.test.js — 拖拽插入位置几何计算的纯函数单测（DOM 无关）
// 运行：node --test renderer/test
const test = require("node:test");
const assert = require("node:assert");
const { computeInsertIndex } = require("../drag-geometry");

// 2x2 网格布局（与入口卡片一致：上排优先、同排左优先）
const GRID = [
  { left: 0, top: 0, width: 100, height: 50 },   // 0
  { left: 100, top: 0, width: 100, height: 50 }, // 1
  { left: 0, top: 100, width: 100, height: 50 }, // 2
  { left: 100, top: 100, width: 100, height: 50 },// 3
];

test("空兄弟列表：插入位置恒为 0", () => {
  assert.strictEqual(computeInsertIndex([], 10, 10), 0);
});

test("指针明显在首行之上：插入到最前", () => {
  assert.strictEqual(computeInsertIndex(GRID, 10, -100), 0);
});

test("指针落在第 0 卡左半（同排、中心左侧）：插入其前 → 0", () => {
  // 第0卡中心 cx=50,cy=25；指针(10,10) 在其左侧且同行
  assert.strictEqual(computeInsertIndex(GRID, 10, 10), 0);
});

test("指针落在第 0 卡右半（同排、中心右侧）：跳过 → 1", () => {
  // (90,10)：cx=50, px>cx → 不插入第0卡前；第1卡(110,10) 同行但 px<cx=150 → 插入第1卡前 =1
  assert.strictEqual(computeInsertIndex(GRID, 90, 10), 1);
});

test("指针落在第 1 卡左半：插入其前 → 1", () => {
  assert.strictEqual(computeInsertIndex(GRID, 110, 10), 1);
});

test("指针落在第 1 卡右半：跳过前两卡 → 2", () => {
  assert.strictEqual(computeInsertIndex(GRID, 190, 10), 2);
});

test("指针落在第 2 卡（第二行首卡）左半：插入其前 → 2", () => {
  assert.strictEqual(computeInsertIndex(GRID, 10, 110), 2);
});

test("指针落在末卡右半：追加到末尾 → length", () => {
  // (190,110)：第3卡 cx=150, px>cx 且同行 → 不插入其前；循环结束 idx=length=4
  assert.strictEqual(computeInsertIndex(GRID, 190, 110), 4);
});

test("指针落在行间隙（首行之下、次行之上）：插入到次行首卡前 → 2", () => {
  // (10,60)：首行两卡 cy=25 均不满足；第2卡 top=100 → py<100 → 插入其前 =2
  assert.strictEqual(computeInsertIndex(GRID, 10, 60), 2);
});

test("指针远在所有卡片之下：追加到末尾 → length", () => {
  assert.strictEqual(computeInsertIndex(GRID, 10, 1000), 4);
});
