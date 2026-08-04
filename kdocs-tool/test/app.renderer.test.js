// kdocs-tool/test/app.renderer.test.js
// 渲染层回归测试：在沙箱内（无 Electron）用轻量 DOM stub + vm 真实执行 public/app.js / index.html
// 图标系统 / 执行按钮 setExec / 统一 Toast(toastMsg) / 按钮结构 / 零回归（厚玻璃/焦点环/减弱动效）。
//
// 运行：cd kdocs-tool && node --test test/app.renderer.test.js

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert");

const PUBLIC = path.join(__dirname, "..", "public");
const appSrc = fs.readFileSync(path.join(PUBLIC, "app.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");

// ───────────────────────── 轻量 DOM stub（增强版） ─────────────────────────
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
    this.oninput = null;
    this.onchange = null;
    this.onpaste = null;
    this.tabIndex = 0;
    this.title = "";
    this.hidden = false;
    this.id = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.className = "";
    this.offsetParent = null;
    this.offsetWidth = 0;
    this.parent = null;
    this._sinks = {};
    const self = this;
    Object.defineProperty(this, "innerHTML", {
      get() { return self._innerHTML; },
      set(v) { self._innerHTML = v; if (v === "") self.children.length = 0; },
    });
    Object.defineProperty(this, "className", {
      get() { return Array.from(this.classList._set).join(" "); },
      set(v) { this.classList._set.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList._set.add(c)); },
    });
  }
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  removeAttribute(k) { delete this._attrs[k]; }
  addEventListener(t, cb) { (this._listeners[t] = this._listeners[t] || []).push(cb); }
  removeEventListener() {}
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  remove() { if (this.parent) this.parent.removeChild(this); }
  _findChild(sel) {
    const cls = sel.startsWith(".") ? sel.slice(1) : null;
    const id = sel.startsWith("#") ? sel.slice(1) : null;
    const tag = (!cls && !id) ? sel.toLowerCase() : null;
    for (const ch of this.children) {
      if (cls && ch.classList.contains(cls)) return ch;
      if (id && ch.id === id) return ch;
      if (tag && ch.tagName && ch.tagName.toLowerCase() === tag) return ch;
    }
    return null;
  }
  querySelector(sel) {
    const f = this._findChild(sel);
    if (f) return f;
    if (!this._sinks[sel]) this._sinks[sel] = new El();
    return this._sinks[sel];
  }
  querySelectorAll() { return []; }
  closest() { return null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50 }; }
  focus() {} scrollIntoView() {} setPointerCapture() {} releasePointerCapture() {}
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

function makeContext(opts = {}) {
  const ids = {};
  const documentStub = {
    documentElement: new El("html"),
    body: new El("body"),
    getElementById(id) {
      if (id === "toastHost" && opts.nullToastHost) return null;
      if (!ids[id]) ids[id] = new El();
      return ids[id];
    },
    createElement(tag) { return new El(tag); },
    querySelector() { return new El(); },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const ctx = {};
  ctx.window = ctx;
  ctx.document = documentStub;
  ctx.console = console;
  ctx.localStorage = makeLocalStorage();
  ctx.addEventListener = () => {};
  ctx.open = () => null;
  ctx.requestAnimationFrame = () => 0;
  ctx.cancelAnimationFrame = () => {};
  ctx.setTimeout = () => 0;
  ctx.clearTimeout = () => {};
  ctx.setInterval = () => 0;
  ctx.Promise = Promise;
  ctx.Math = Math;
  ctx.JSON = JSON;
  ctx.Date = Date;
  ctx.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  ctx.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  ctx.navigator = { clipboard: { writeText: () => Promise.resolve() } };
  ctx.location = { search: "", origin: "http://localhost", href: "" };
  ctx.history = { replaceState() {} };
  ctx.URLSearchParams = URLSearchParams;
  ctx.fetch = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      json: () => Promise.resolve([]),
      text: () => Promise.resolve(""),
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    });
  vm.createContext(ctx);
  return { ctx, ids, documentStub };
}

// 从源码中按括号配平提取函数源码（支持字符串/模板串内的括号）。
function extractFunction(src, name) {
  const sig = "function " + name + "(";
  const start = src.indexOf(sig);
  if (start < 0) throw new Error("未找到函数: " + name);
  let k = src.indexOf("{", start);
  let depth = 0, inStr = null, inTmpl = false;
  for (; k < src.length; k++) {
    const ch = src[k];
    if (inStr) { if (ch === "\\") { k++; continue; } if (ch === inStr) inStr = null; continue; }
    if (inTmpl) { if (ch === "\\") { k++; continue; } if (ch === "`") inTmpl = false; continue; }
    if (ch === "'" || ch === '"') { inStr = ch; continue; }
    if (ch === "`") { inTmpl = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { k++; break; } }
  }
  return src.slice(start, k);
}

function extractIconBlock(html) {
  const s = html.indexOf("window.ICONS = {");
  const marker = "hydrateIcons(document);";
  const e = html.indexOf(marker);
  assert.ok(s >= 0 && e >= 0, "应能定位图标系统脚本块");
  return html.slice(s, e + marker.length);
}
function iconBlockMd5(html) {
  return crypto.createHash("md5").update(extractIconBlock(html)).digest("hex");
}

function makeButtonEl() {
  const btn = new El("button");
  const ico = new El("svg"); ico.classList.add("bx-ico");
  const label = new El("span"); label.classList.add("bx-label"); label.textContent = "一键执行";
  btn.appendChild(ico);
  btn.appendChild(label);
  return btn;
}

// ───────────────────────── 1) 图标系统（ICONS / ico / hydrateIcons） ─────────────────────────
test("图标系统：window.ico('check') 返回含 <svg class=\"app-ico\" 的字符串", () => {
  const { ctx } = makeContext();
  vm.runInContext(extractIconBlock(indexHtml), ctx);
  assert.ok(/<svg class="app-ico"/.test(ctx.window.ico("check")));
});
test("图标系统：未知图标名 ico('nope') 优雅返回空串", () => {
  const { ctx } = makeContext();
  vm.runInContext(extractIconBlock(indexHtml), ctx);
  assert.strictEqual(ctx.window.ico("nope"), "");
});
test("图标系统：hydrateIcons(root) 能把 [data-ico] 元素填成 <svg>", () => {
  const { ctx } = makeContext();
  vm.runInContext(extractIconBlock(indexHtml), ctx);
  const root = new El();
  const child = new El();
  child.setAttribute("data-ico", "check");
  root.appendChild(child);
  root.querySelectorAll = (sel) => (sel.indexOf("data-ico") >= 0 ? [child] : []);
  ctx.window.hydrateIcons(root);
  assert.ok(/<svg class="app-ico"/.test(child.innerHTML));
});
test("图标系统：三模块 index.html 图标脚本块逐字节一致（md5）", () => {
  const a = iconBlockMd5(indexHtml);
  const b = iconBlockMd5(fs.readFileSync(path.join(__dirname, "..", "..", "biliup-hub", "public", "index.html"), "utf8"));
  const c = iconBlockMd5(fs.readFileSync(path.join(__dirname, "..", "..", "netdisk-hub", "public", "index.html"), "utf8"));
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
});

// ───────────────────────── 2) 执行按钮 setExec ─────────────────────────
test("setExec(true)：加 .is-loading、disabled=true、bx-label 变「执行中…」", () => {
  const { ctx } = makeContext();
  vm.runInContext("var setExec = (" + extractFunction(appSrc, "setExec") + ");", ctx);
  const btn = makeButtonEl();
  ctx.setExec(btn, true);
  assert.ok(btn.classList.contains("is-loading"));
  assert.strictEqual(btn.disabled, true);
  assert.strictEqual(btn.getAttribute("aria-busy"), "true");
  assert.strictEqual(btn.querySelector(".bx-label").textContent, "执行中…");
});
test("setExec(false)：复原 .is-loading 移除、disabled=false、bx-label 恢复原文案", () => {
  const { ctx } = makeContext();
  vm.runInContext("var setExec = (" + extractFunction(appSrc, "setExec") + ");", ctx);
  const btn = makeButtonEl();
  ctx.setExec(btn, true);
  ctx.setExec(btn, false);
  assert.ok(!btn.classList.contains("is-loading"));
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(btn.getAttribute("aria-busy"), null);
  assert.strictEqual(btn.querySelector(".bx-label").textContent, "一键执行");
});
test("setExec：异步流程抛异常时 finally 必调用 setExec(btn,false)，按钮绝不卡在 loading", async () => {
  const { ctx } = makeContext();
  vm.runInContext("var setExec = (" + extractFunction(appSrc, "setExec") + ");", ctx);
  vm.runInContext(
    "globalThis.__work = async function(btn){ setExec(btn, true); try { await Promise.reject(new Error('boom')); } finally { setExec(btn, false); } };",
    ctx
  );
  const btn = makeButtonEl();
  let thrown = null;
  try { await ctx.__work(btn); } catch (e) { thrown = e; }
  assert.ok(thrown && /boom/.test(thrown.message), "异常应向上抛出（行为真实）");
  assert.ok(!btn.classList.contains("is-loading"), "finally 后不应卡在 .is-loading");
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(btn.querySelector(".bx-label").textContent, "一键执行");
});

// ───────────────────────── 3) 统一 Toast（kdocs 为 toastMsg） ─────────────────────────
test("toastMsg(ok)：在 #toastHost 下生成玻璃 .toast-host / .toast 子节点，含正确文案与 check 图标", () => {
  const { ctx } = makeContext();
  vm.runInContext(extractIconBlock(indexHtml), ctx); // 提供 ico()
  ctx.toastHost = new El(); // toastMsg 闭包引用 toastHost（模块顶部 const），在此注入等价宿主
  vm.runInContext("var toastMsg = (" + extractFunction(appSrc, "toastMsg") + ");", ctx);
  ctx.toastMsg("AI 已恢复在线", "ok");
  assert.strictEqual(ctx.toastHost.children.length, 1, "toastHost 下应有 1 个 .toast");
  const toastEl = ctx.toastHost.children[0];
  assert.ok(toastEl.classList.contains("toast"), "子节点应含 .toast");
  assert.strictEqual(toastEl._sinks[".toast-msg"].textContent, "AI 已恢复在线");
  assert.ok(/<svg class="app-ico"/.test(toastEl._sinks[".toast-ico"].innerHTML), "ok 态应内联 check 图标 SVG");
});
test("toastMsg(err)：错误态内联 cross 图标 SVG", () => {
  const { ctx } = makeContext();
  vm.runInContext(extractIconBlock(indexHtml), ctx);
  ctx.toastHost = new El();
  vm.runInContext("var toastMsg = (" + extractFunction(appSrc, "toastMsg") + ");", ctx);
  ctx.toastMsg("AI 重连失败", "err");
  const toastEl = ctx.toastHost.children[0];
  assert.ok(/<svg class="app-ico"/.test(toastEl._sinks[".toast-ico"].innerHTML), "err 态应内联 cross 图标 SVG");
});

// ───────────────────────── 4) 按钮结构（无 emoji 残留） ─────────────────────────
test("按钮结构：#autoBtn(.btn-exec) 含 .bx-ico(SVG) + .bx-label", () => {
  const re = /<button class="btn-exec" id="autoBtn"[\s\S]*?<svg class="bx-ico"[\s\S]*?<span class="bx-label">/;
  assert.ok(re.test(indexHtml), "autoBtn 应含 bx-ico 与 bx-label");
});
test("按钮结构：.icon-btn(#historyIconBtn) 含 .ib-ico + .ib-label", () => {
  const re = /<button class="icon-btn" id="historyIconBtn"[\s\S]*?class="ib-ico"[\s\S]*?class="ib-label">/;
  assert.ok(re.test(indexHtml), "historyIconBtn 应含 ib-ico 与 ib-label");
});
test("无残留 emoji：app.js + index.html 中 Extended_Pictographic 只允许 ↩（本模块为 0）", () => {
  const scan = (s) => [...s.matchAll(/\p{Extended_Pictographic}/gu)].map((x) => x[0]);
  for (const [label, src] of [["app.js", appSrc], ["index.html", indexHtml]]) {
    const em = scan(src);
    assert.ok(em.every((c) => c === "↩"), `${label} 中存在非 ↩ 的 emoji: [${em.join("")}]`);
  }
});

// ───────────────────────── 5) 零回归（厚玻璃 / 焦点环 / 减弱动效） ─────────────────────────
test("零回归：.modal.glass 厚玻璃 backdrop-filter: blur(40px) saturate(2.0)", () => {
  assert.ok(/\.modal\.glass\s*\{[\s\S]*?backdrop-filter:\s*blur\(40px\)\s*saturate\(2\.0\)/.test(indexHtml));
});
test("零回归：:focus-visible 键盘焦点环门禁存在", () => {
  assert.ok(/:focus-visible\s*\{/.test(indexHtml));
});
test("零回归：prefers-reduced-motion 减弱动效门禁存在", () => {
  assert.ok(/prefers-reduced-motion/.test(indexHtml));
});

// ───────────────────────── 6) 加载安全：app.js 真实执行不崩溃 ─────────────────────────
test("加载安全：public/app.js 在沙箱中真实执行不抛异常（含 status-luxe/图标）", () => {
  const { ctx } = makeContext();
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, "status-luxe.js"), "utf8"), ctx);
  vm.runInContext(extractIconBlock(indexHtml), ctx);
  assert.doesNotThrow(() => { vm.runInContext(appSrc, ctx); }, "app.js 不应抛异常");
});
