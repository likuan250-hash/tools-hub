// netdisk-hub/test/app.renderer.test.js
// 渲染层回归测试：在沙箱内（无 Electron）用轻量 DOM stub + vm 真实执行 public/app.js / index.html
// 图标系统 / 执行按钮 setExec / 统一 Toast / alert()->toast() 迁移 / 按钮结构 / 零回归。
//
// 运行：cd netdisk-hub && node --test test/app.renderer.test.js

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
  const label = new El("span"); label.classList.add("bx-label"); label.textContent = "转存选中并生成分享";
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
  const c = iconBlockMd5(fs.readFileSync(path.join(__dirname, "..", "..", "kdocs-tool", "public", "index.html"), "utf8"));
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
  assert.strictEqual(btn.querySelector(".bx-label").textContent, "转存选中并生成分享");
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
  assert.strictEqual(btn.querySelector(".bx-label").textContent, "转存选中并生成分享");
});

// ───────────────────────── 3) 统一 Toast（netdisk 为 toast） ─────────────────────────
test("toast(ok)：在 #toastHost 下生成玻璃 .toast-host / .toast 子节点，含正确文案与 check 图标", () => {
  const { ctx, documentStub } = makeContext({ nullToastHost: true });
  vm.runInContext(extractIconBlock(indexHtml), ctx); // 提供 ico()
  vm.runInContext("var toast = (" + extractFunction(appSrc, "toast") + ");", ctx);
  ctx.toast("转存成功", "ok");
  const host = documentStub.body.children.find((c) => c.classList.contains("toast-host"));
  assert.ok(host, "应创建 .toast-host 并挂到 body");
  assert.strictEqual(host.children.length, 1, "toast-host 下应有 1 个 .toast");
  const toastEl = host.children[0];
  assert.ok(toastEl.classList.contains("toast"), "子节点应含 .toast");
  assert.strictEqual(toastEl._sinks[".toast-msg"].textContent, "转存成功");
  assert.ok(/<svg class="app-ico"/.test(toastEl._sinks[".toast-ico"].innerHTML), "ok 态应内联 check 图标 SVG");
});
test("toast(err)：错误态内联 cross 图标 SVG", () => {
  const { ctx, documentStub } = makeContext({ nullToastHost: true });
  vm.runInContext(extractIconBlock(indexHtml), ctx);
  vm.runInContext("var toast = (" + extractFunction(appSrc, "toast") + ");", ctx);
  ctx.toast("保存失败", "err");
  const host = documentStub.body.children.find((c) => c.classList.contains("toast-host"));
  const toastEl = host.children[0];
  assert.ok(/<svg class="app-ico"/.test(toastEl._sinks[".toast-ico"].innerHTML), "err 态应内联 cross 图标 SVG");
});

// ───────────────────────── 4) alert() -> toast() 迁移（统一提示） ─────────────────────────
test("alert->toast：netdisk app.js 已无任何 alert() 调用（已统一为 toast）", () => {
  assert.ok(!/\balert\s*\(/.test(appSrc), "不应再出现 alert(，应统一为 toast(");
  assert.ok(/toast\(/.test(appSrc), "应使用 toast( 作为统一提示");
});
test("alert->toast：openAuth 弹窗被拦截时调用 toast(err) 而非 alert", () => {
  const { ctx } = makeContext();
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, "status-luxe.js"), "utf8"), ctx);
  vm.runInContext(extractIconBlock(indexHtml), ctx);
  vm.runInContext(appSrc, ctx); // 全量执行，得到真实 openAuth / toast
  const realToast = ctx.toast;
  const calls = [];
  ctx.toast = (m, t) => { calls.push([m, t]); return realToast(m, t); };
  ctx.open = () => null; // 模拟弹窗被浏览器拦截
  ctx.openAuth("baidu");
  const hit = calls.find(([m]) => /浏览器拦截了弹窗/.test(m));
  assert.ok(hit, "openAuth 弹窗被拦截应调用 toast 提示");
  assert.strictEqual(hit[1], "err", "应作为 err 类型提示");
});
test("alert->toast：confirmDir 保存失败时 catch 内调用 toast(err) 而非 alert", async () => {
  const { ctx } = makeContext();
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, "status-luxe.js"), "utf8"), ctx);
  vm.runInContext(extractIconBlock(indexHtml), ctx);
  vm.runInContext(appSrc, ctx);
  const realToast = ctx.toast;
  const calls = [];
  ctx.toast = (m, t) => { calls.push([m, t]); return realToast(m, t); };
  // 真实流程：先 openDirPicker 初始化 dirCtx.stack（UI 中确认按钮仅在目录选择弹窗内可见）
  await ctx.openDirPicker("baidu");
  ctx.fetch = () => Promise.reject(new Error("network down")); // 触发 confirmDir 的 catch
  await ctx.confirmDir();
  const hit = calls.find(([m]) => /保存失败/.test(m));
  assert.ok(hit, "confirmDir 保存失败应调用 toast 提示");
  assert.strictEqual(hit[1], "err", "应作为 err 类型提示");
});

// ───────────────────────── 5) 按钮结构（无 emoji 残留） ─────────────────────────
test("按钮结构：#batchBtn(.btn-exec) 含 .bx-ico(SVG) + .bx-label", () => {
  const re = /<button class="btn-exec" id="batchBtn"[\s\S]*?<svg class="bx-ico"[\s\S]*?<span class="bx-label">/;
  assert.ok(re.test(indexHtml), "batchBtn 应含 bx-ico 与 bx-label");
});
test("按钮结构：.icon-btn(#fmtIconBtn) 含 .ib-ico + .ib-label", () => {
  const re = /<button class="icon-btn" id="fmtIconBtn"[\s\S]*?class="ib-ico"[\s\S]*?class="ib-label">/;
  assert.ok(re.test(indexHtml), "fmtIconBtn 应含 ib-ico 与 ib-label");
});
test("无残留 emoji：app.js + index.html 中 Extended_Pictographic 只允许 ↩（本模块为 2 个 ↩）", () => {
  const scan = (s) => [...s.matchAll(/\p{Extended_Pictographic}/gu)].map((x) => x[0]);
  for (const [label, src] of [["app.js", appSrc], ["index.html", indexHtml]]) {
    const em = scan(src);
    assert.ok(em.every((c) => c === "↩"), `${label} 中存在非 ↩ 的 emoji: [${em.join("")}]`);
  }
});

// ───────────────────────── 6) 零回归（厚玻璃 / 焦点环 / 减弱动效） ─────────────────────────
test("零回归：.modal.glass 厚玻璃 backdrop-filter: blur(40px) saturate(2.0)", () => {
  assert.ok(/\.modal\.glass\s*\{[\s\S]*?backdrop-filter:\s*blur\(40px\)\s*saturate\(2\.0\)/.test(indexHtml));
});
test("零回归：:focus-visible 键盘焦点环门禁存在", () => {
  assert.ok(/:focus-visible\s*\{/.test(indexHtml));
});
test("零回归：prefers-reduced-motion 减弱动效门禁存在", () => {
  assert.ok(/prefers-reduced-motion/.test(indexHtml));
});

// ───────────────────────── 7) 加载安全：app.js 真实执行不崩溃 ─────────────────────────
test("加载安全：public/app.js 在沙箱中真实执行不抛异常（含 status-luxe/图标）", () => {
  const { ctx } = makeContext();
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, "status-luxe.js"), "utf8"), ctx);
  vm.runInContext(extractIconBlock(indexHtml), ctx);
  assert.doesNotThrow(() => { vm.runInContext(appSrc, ctx); }, "app.js 不应抛异常");
});
