// regression-stuck-initializing.test.js
// 回归测试：工具箱「卡在初始化中…」Bug 修复（v0.1.55）
//
// 测试策略（沙箱内无法跑 Electron，做代码级场景验证）：
//   1) 静态检查：app.js 无 require 调用；renderStatus 内 renderCards 在 try/catch 外部；
//      所有 status* 调用均有 typeof 守卫；index.html 脚本加载顺序正确。
//   2) 双上下文导出：drag-geometry.js / status-luxe.js 在「浏览器(window)」与「Node(module)」
//      两种环境下都能导出且不报错（验证「双导出不会在任一环境报错」）。
//   3) 内联兜底一致性：app.js 内的 fallbackComputeInsertIndex 与 drag-geometry.js 原实现逐用例一致。
//   4) 场景推演（S1~S6）：用 vm + 轻量 DOM stub 真实执行 app.js 的 IIFE，
//      验证无论状态系统/依赖库是否健康，IIFE 都不会崩溃，且 renderCards 必然执行（卡片渲染）。
//   5) 回归验证：主题/标签/更新/窗口控制/排序 绑定在 IIFE 内完整保留且可绑定（运行时 + 代码结构）。
//
// 运行：node --test renderer/test/regression-stuck-initializing.test.js

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert");

const RENDERER = path.join(__dirname, ".."); // 本文件位于 renderer/test，父目录即 renderer
const appSrc = fs.readFileSync(path.join(RENDERER, "app.js"), "utf8");
const dragGeoSrc = fs.readFileSync(path.join(RENDERER, "drag-geometry.js"), "utf8");
const statusLuxeSrc = fs.readFileSync(path.join(RENDERER, "status-luxe.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(RENDERER, "index.html"), "utf8");
const { computeInsertIndex: realComputeInsertIndex } = require(path.join(RENDERER, "drag-geometry"));

// ───────────────────────── 轻量 DOM stub ─────────────────────────
class StyleStub {
  constructor() { this._props = {}; }
  setProperty(k, v) { this._props[k] = v; }
  removeProperty(k) { delete this._props[k]; }
  getPropertyValue(k) { return this._props[k] || ""; }
}
class ClassListStub {
  constructor() { this._set = new Set(); }
  add(...c) { c.forEach((x) => this._set.add(x)); }
  remove(...c) { c.forEach((x) => this._set.delete(x)); }
  toggle(c, force) {
    if (force === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); }
    else { force ? this._set.add(c) : this._set.delete(c); }
  }
  contains(c) { return this._set.has(c); }
}
class El {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = new StyleStub();
    this.classList = new ClassListStub();
    this._attrs = {};
    this._listeners = {};
    this._innerHTML = "";
    this.textContent = "";
    this.onclick = null;
    this.tabIndex = 0;
    this.title = "";
    this.hidden = false;
    this.id = "";
    const self = this;
    Object.defineProperty(this, "innerHTML", {
      get() { return self._innerHTML; },
      set(v) { self._innerHTML = v; if (v === "") self.children.length = 0; },
    });
  }
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return this._attrs[k]; }
  addEventListener() {}
  removeEventListener() {}
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  remove() { if (this.parent) this.parent.removeChild(this); }
  querySelector() { return new El(); }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50 }; }
  focus() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  send() {}
  resize() {}
}

function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
}

// 构建一个干净的 vm 上下文，并注入最小 DOM。返回 { ctx, ids }（ids 便于断言卡片是否渲染）。
function makeContext() {
  const ids = {};
  const documentStub = {
    documentElement: new El("html"),
    body: new El("body"),
    getElementById(id) { if (!ids[id]) ids[id] = new El(); return ids[id]; },
    createElement(tag) { return new El(tag); },
    querySelector() { return new El(); },
    addEventListener() {},
  };
  const ctx = {};
  ctx.window = ctx; // 浏览器中 window 即全局对象，便于 window.X 暴露为裸全局
  ctx.document = documentStub;
  ctx.console = console;
  ctx.localStorage = makeLocalStorage();
  ctx.addEventListener = () => {};
  ctx.requestAnimationFrame = () => 0;
  ctx.cancelAnimationFrame = () => {};
  ctx.setTimeout = () => 0;
  ctx.clearTimeout = () => {};
  ctx.Promise = Promise;
  ctx.Math = Math;
  ctx.JSON = JSON;
  vm.createContext(ctx);
  return { ctx, ids };
}

function makeApi({ statusResolves = true, statusValue } = {}) {
  return {
    getVersion: () => Promise.resolve("0.1.55"),
    getStatus: () => (statusResolves
      ? Promise.resolve(statusValue || { kdocs: { running: true }, netdisk: { running: false } })
      : Promise.reject(new Error("status unavailable"))),
    onStatus: () => {},
    onUpdateStatus: () => {},
    windowControl: () => {},
    onRequestQuit: () => {},
    setTheme: () => {},
    getWebviewPreload: () => Promise.resolve(""),
    checkUpdate: () => Promise.resolve(),
    installUpdate: () => {},
    confirmQuit: () => {},
  };
}

// 在指定上下文中按「脚本加载顺序」运行依赖库，再运行 app.js（IIFE）。
// libs: ['drag-geometry','status-luxe'] 的子集；apiSpec: 传给 makeApi 的配置或 null（模拟无 electronAPI）。
function runApp(libs, apiSpec) {
  const { ctx, ids } = makeContext();
  if (libs.includes("drag-geometry")) vm.runInContext(dragGeoSrc, ctx, { filename: "drag-geometry.js" });
  if (libs.includes("status-luxe")) vm.runInContext(statusLuxeSrc, ctx, { filename: "status-luxe.js" });
  if (apiSpec) ctx.electronAPI = makeApi(apiSpec);
  vm.runInContext(appSrc, ctx, { filename: "app.js" }); // 若 IIFE 崩溃会在此抛出
  return { ctx, ids };
}

function tick() { return new Promise((r) => setImmediate(r)); }

// 2x2 网格（与入口卡片一致：上排优先、同排左优先）
const GRID = [
  { left: 0, top: 0, width: 100, height: 50 },   // 0
  { left: 100, top: 0, width: 100, height: 50 }, // 1
  { left: 0, top: 100, width: 100, height: 50 }, // 2
  { left: 100, top: 100, width: 100, height: 50 },// 3
];
const GRID_CASES = [
  [[], 10, 10, 0],
  [GRID, 10, -100, 0],
  [GRID, 10, 10, 0],
  [GRID, 90, 10, 1],
  [GRID, 110, 10, 1],
  [GRID, 190, 10, 2],
  [GRID, 10, 110, 2],
  [GRID, 190, 110, 4],
  [GRID, 10, 60, 2],
  [GRID, 10, 1000, 4],
];

// ───────────────────────── 1) 静态检查 / 代码审查 ─────────────────────────

test("静态检查：app.js 不再包含任何 require() 调用（渲染进程 nodeIntegration=false）", () => {
  assert.ok(!/\brequire\s*\(/.test(appSrc), "app.js 必须不含任何 require(");
});

test("代码审查：renderStatus 内 renderCards() 位于 try/catch 外部（无论状态系统是否异常都渲染卡片）", () => {
  const start = appSrc.indexOf("function renderStatus(status) {");
  const end = appSrc.indexOf("// 入口聚合标签");
  assert.ok(start >= 0 && end > start, "应能定位 renderStatus 函数体");
  const rs = appSrc.slice(start, end);
  const tryIdx = rs.indexOf("try {");
  const catchIdx = rs.indexOf("} catch");
  assert.ok(tryIdx >= 0 && catchIdx > tryIdx, "renderStatus 应含 try/catch");
  const tryBlock = rs.slice(tryIdx + "try {".length, catchIdx);
  assert.ok(!/renderCards/.test(tryBlock), "renderCards 绝不能位于 try 块内（否则状态异常会阻断渲染）");
  const callIdx = rs.indexOf("renderCards();");
  assert.ok(callIdx > catchIdx, "renderCards() 必须在 catch 块之后调用");
});

test("代码审查：所有 statusHTML / aggregateStatus / aggColorLevel 调用都有 typeof === 'function' 守卫", () => {
  const count = (re) => (appSrc.match(re) || []).length;
  assert.strictEqual(count(/typeof statusHTML === "function"/g), count(/statusHTML\(/g),
    "statusHTML 守卫数必须等于调用数");
  assert.strictEqual(count(/typeof aggregateStatus === "function"/g), count(/aggregateStatus\(/g),
    "aggregateStatus 守卫数必须等于调用数");
  assert.strictEqual(count(/typeof aggColorLevel === "function"/g), count(/aggColorLevel\(/g),
    "aggColorLevel 守卫数必须等于调用数");
  assert.strictEqual(count(/statusHTML\(/g), 3, "statusHTML 应有 3 处调用（renderCards/renderStatus/setUpdateUI）");
  assert.strictEqual(count(/aggregateStatus\(/g), 1);
  assert.strictEqual(count(/aggColorLevel\(/g), 1);
});

test("代码审查：index.html 脚本加载顺序为 drag-geometry.js → status-luxe.js → app.js", () => {
  const scripts = [...indexHtml.matchAll(/<script src="([^"]+)">/g)].map((m) => m[1]);
  assert.deepStrictEqual(scripts, ["drag-geometry.js", "status-luxe.js", "app.js"]);
});

// ───────────────────────── 2) 双上下文导出 ─────────────────────────

test("双导出：drag-geometry.js 在「浏览器(window)」环境下挂载 window.computeInsertIndex 且不报错", () => {
  const { ctx } = makeContext();
  assert.strictEqual(typeof ctx.module, "undefined", "浏览器环境不应有 module");
  vm.runInContext(dragGeoSrc, ctx, { filename: "drag-geometry.js" });
  assert.strictEqual(typeof ctx.window.computeInsertIndex, "function");
  assert.strictEqual(typeof ctx.computeInsertIndex, "function");
});

test("双导出：status-luxe.js 在「浏览器(window)」环境下挂载 4 个全局函数且不报错", () => {
  const { ctx } = makeContext();
  vm.runInContext(statusLuxeSrc, ctx, { filename: "status-luxe.js" });
  assert.strictEqual(typeof ctx.window.statusHTML, "function");
  assert.strictEqual(typeof ctx.window.aggregateStatus, "function");
  assert.strictEqual(typeof ctx.window.aggColorLevel, "function");
  assert.strictEqual(typeof ctx.window.bindStatusCursor, "function");
});

test("双导出：drag-geometry.js 的 module.exports 在 Node 环境保留（既有单测依赖）", () => {
  const m = require(path.join(RENDERER, "drag-geometry"));
  assert.strictEqual(typeof m.computeInsertIndex, "function");
});

test("回归确认：status-luxe.js 未被误改，Node 导出 4 个函数齐全", () => {
  const m = require(path.join(RENDERER, "status-luxe"));
  assert.strictEqual(typeof m.statusHTML, "function");
  assert.strictEqual(typeof m.aggregateStatus, "function");
  assert.strictEqual(typeof m.aggColorLevel, "function");
  assert.strictEqual(typeof m.bindStatusCursor, "function");
});

// ───────────────────────── 3) 内联兜底一致性 ─────────────────────────

test("内联兜底 fallbackComputeInsertIndex 与 drag-geometry.js 原实现逐用例一致", () => {
  const matched = appSrc.match(/function fallbackComputeInsertIndex\(rects, px, py\) \{[\s\S]*?\n        \}/);
  assert.ok(matched, "应从 app.js 中提取出 fallbackComputeInsertIndex 函数体");
  const fallback = new Function("return (" + matched[0] + ");")();
  for (const [rects, px, py, exp] of GRID_CASES) {
    assert.strictEqual(fallback(rects, px, py), exp, `fallback(${px},${py}) 应=${exp}`);
    assert.strictEqual(realComputeInsertIndex(rects, px, py), exp, `real(${px},${py}) 应=${exp}`);
    assert.strictEqual(fallback(rects, px, py), realComputeInsertIndex(rects, px, py),
      "兜底实现必须与正式实现结果完全一致");
  }
});

// ───────────────────────── 4) 场景推演 S1~S6（真实执行 IIFE） ─────────────────────────

test("S1 正常路径：三段 JS 均加载 + electronAPI → 卡片渲染、玻璃态胶囊、按钮绑定完整", async () => {
  const { ids } = runApp(["drag-geometry", "status-luxe"],
    { statusResolves: true, statusValue: { kdocs: { running: true }, netdisk: { running: false } } });
  await tick();
  assert.strictEqual(ids["toolCards"].children.length, 2, "应渲染 2 张卡片");
  assert.ok(/st-luxe/.test(ids["aggStatus"]._innerHTML), "aggStatus 应显示玻璃态胶囊");
  // 回归验证：既有绑定在 IIFE 内正常位置且已绑定
  assert.strictEqual(typeof ids["themeBtn"].onclick, "function", "themeBtn 绑定应存在");
  assert.strictEqual(typeof ids["sortBtn"].onclick, "function", "sortBtn 绑定应存在");
  assert.strictEqual(typeof ids["updateBtn"].onclick, "function", "updateBtn 绑定应存在");
  assert.strictEqual(typeof ids["winMin"].onclick, "function", "winMin 绑定应存在");
  assert.strictEqual(typeof ids["winMax"].onclick, "function", "winMax 绑定应存在");
  assert.strictEqual(typeof ids["winClose"].onclick, "function", "winClose 绑定应存在");
});

test("S2 getStatus reject：走 catch 分支 → renderStatus({}) 仍渲染卡片", async () => {
  const { ids } = runApp(["drag-geometry", "status-luxe"], { statusResolves: false });
  await tick();
  assert.strictEqual(ids["toolCards"].children.length, 2, "reject 后卡片仍必须渲染");
  assert.ok(/st-luxe/.test(ids["aggStatus"]._innerHTML), "仍应显示玻璃态胶囊");
});

test("S3 electronAPI 缺失：走 else 分支 → aggEl 设文本 + 卡片渲染", () => {
  const { ids } = runApp(["drag-geometry", "status-luxe"], null);
  assert.strictEqual(ids["toolCards"].children.length, 2, "无 electronAPI 时卡片仍必须渲染");
  assert.strictEqual(ids["aggStatus"].textContent, "未运行在桌面应用环境中");
});

test("S4 status-luxe.js 缺失：statusHTML 等为 undefined → typeof 守卫回退纯文本 → 卡片照常渲染", async () => {
  const { ids } = runApp(["drag-geometry"],
    { statusResolves: true, statusValue: { kdocs: { running: true }, netdisk: { running: false } } });
  await tick();
  assert.strictEqual(ids["toolCards"].children.length, 2, "状态库缺失时卡片仍必须渲染");
  assert.strictEqual(ids["aggStatus"]._innerHTML, "离线", "应回退为纯文本标签而非崩溃");
});

test("S5 drag-geometry.js 缺失：用内联 fallbackComputeInsertIndex → 卡片渲染、不崩溃", async () => {
  const { ids } = runApp(["status-luxe"],
    { statusResolves: true, statusValue: { kdocs: { running: true }, netdisk: { running: false } } });
  await tick();
  assert.strictEqual(ids["toolCards"].children.length, 2, "拖拽库缺失时应启用内联兜底且卡片渲染");
  assert.ok(/st-luxe/.test(ids["aggStatus"]._innerHTML), "状态胶囊仍正常（玻璃态）");
});

test("S6 两库全缺失：最强兜底 → 卡片照常渲染、页面可操作", () => {
  const { ids } = runApp([], null);
  assert.strictEqual(ids["toolCards"].children.length, 2, "双库缺失的最坏情况下卡片仍必须渲染");
});

// ───────────────────────── 5) 回归验证（既有功能未被破坏） ─────────────────────────

test("回归验证：主题切换 / 标签 / 更新 / 窗口控制 / 排序 逻辑完整保留", () => {
  // 函数定义仍在
  assert.ok(/function switchTab\(key\)/.test(appSrc), "switchTab 应保留");
  assert.ok(/function closeTab\(key, event\)/.test(appSrc), "closeTab 应保留");
  assert.ok(/function setUpdateUI\(/.test(appSrc), "setUpdateUI 应保留");
  assert.ok(/function toggleSortMode\(/.test(appSrc), "toggleSortMode 应保留");
  assert.ok(/function saveCardOrder\(/.test(appSrc), "saveCardOrder 应保留");
  assert.ok(/function getCardOrder\(/.test(appSrc), "getCardOrder 应保留");
  // 绑定点仍在 IIFE 内正确位置
  assert.ok(/themeBtn\.onclick =/.test(appSrc), "themeBtn 绑定应保留");
  assert.ok(/sortBtn\.onclick = toggleSortMode/.test(appSrc), "sortBtn→toggleSortMode 绑定应保留");
  assert.ok(/winMin\.onclick =/.test(appSrc) && /winMax\.onclick =/.test(appSrc) && /winClose\.onclick =/.test(appSrc),
    "窗口控制按钮绑定应完整保留");
  assert.ok(/updateBtn\.onclick/.test(appSrc) && /api\.checkUpdate/.test(appSrc), "更新检测 UI + checkUpdate 应保留");
});
