// biliup-hub/test/avatar-menu.test.js —— 头像二级菜单单测（需求③）
// 从 public/app.js 抽取菜单相关函数（buildAccountMenu / ensureAccountMenu / toggleAccountMenu /
// closeAccountMenu / onDocClickCloseMenu），用轻量 DOM stub 在沙箱中真实执行验证交互。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// ── 轻量 DOM stub（增强：含 contains） ──
class StyleStub {
  constructor() { this._props = {}; }
  setProperty(k, v) { this._props[k] = v; }
  removeProperty(k) { delete this._props[k]; }
  getPropertyValue(k) { return this._props[k] || ''; }
}
class ClassListStub {
  constructor() { this._set = new Set(); }
  add(...c) { c.forEach((x) => this._set.add(x)); }
  remove(...c) { c.forEach((x) => this._set.delete(x)); }
  toggle(c, f) { if (f === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else { f ? this._set.add(c) : this._set.delete(c); } }
  contains(c) { return this._set.has(c); }
}
class El {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = new StyleStub();
    this.classList = new ClassListStub();
    this._attrs = {};
    this._listeners = {};
    this._innerHTML = '';
    this.textContent = '';
    this.onerror = null;
    this.onclick = null;
    this.title = '';
    this.id = '';
    this.value = '';
    this.disabled = false;
    this.offsetWidth = 0;
    this.offsetParent = null;
    this.parent = null;
    this.className = '';
    const self = this;
    Object.defineProperty(this, 'innerHTML', {
      get() { return self._innerHTML; },
      set(v) { self._innerHTML = v; if (v === '') self.children.length = 0; },
    });
    Object.defineProperty(this, 'className', {
      get() { return Array.from(this.classList._set).join(' '); },
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
  contains(node) { let cur = node; while (cur) { if (cur === this) return true; cur = cur.parent; } return false; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50 }; }
  querySelector() { return new El(); }
  querySelectorAll() { return []; }
}

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

const MENU_FNS = ['ensureAccountMenu', 'buildAccountMenu', 'toggleAccountMenu', 'closeAccountMenu', 'onDocClickCloseMenu'];
const MENU_CONSTS = ['ACCT_MENU_ICON_USER', 'ACCT_MENU_ICON_LOGOUT'];

// 抽取单行 `const NAME = ...;` 常量声明（图标 SVG 字符串，单行、不含分号）。
function extractConst(src, name) {
  const sig = 'const ' + name + ' =';
  const start = src.indexOf(sig);
  if (start < 0) throw new Error('未找到常量: ' + name);
  const end = src.indexOf(';', start);
  return src.slice(start, end + 1);
}

function makeCtx() {
  const documentStub = {
    body: new El('body'),
    getElementById: () => new El(),
    createElement: (t) => new El(t),
    addEventListener() {},
    removeEventListener() {},
  };
  const ctx = {};
  ctx.window = ctx;
  ctx.document = documentStub;
  ctx.Math = Math;
  ctx.setTimeout = () => 0;
  ctx.$ = () => new El();
  ctx.__openSpaceCalls = [];
  ctx.openSpace = (url) => { ctx.__openSpaceCalls.push(url); };
  ctx.__doLogoutCalls = 0;
  ctx.doLogout = () => { ctx.__doLogoutCalls++; };
  vm.createContext(ctx);
  const constSrc = MENU_CONSTS.map((n) => extractConst(appSrc, n)).join('\n');
  const fnSrc = 'var accountMenuEl = null;\n' + constSrc + '\n' + MENU_FNS.map((n) => extractFunction(appSrc, n)).join('\n');
  vm.runInContext(fnSrc, ctx);
  return ctx;
}

test('头像菜单：buildAccountMenu 生成含「个人中心」「退出登录」两项', () => {
  const ctx = makeCtx();
  ctx.buildAccountMenu({ mid: 123, uname: 'u' });
  assert.ok(ctx.accountMenuEl, '菜单应被创建');
  assert.strictEqual(ctx.accountMenuEl.children.length, 2, '应含 2 个菜单项');
  const first = ctx.accountMenuEl.children[0];
  const second = ctx.accountMenuEl.children[1];
  assert.ok(first._innerHTML.includes('个人中心'), '第一项应为「个人中心」');
  assert.ok(second._innerHTML.includes('退出登录'), '第二项应为「退出登录」');
  assert.ok(first.classList.contains('acct-menu-item'), '第一项应有 .acct-menu-item');
  assert.ok(second.classList.contains('acct-menu-item--danger'), '退出登录应为危险色样式');
});

test('头像菜单：点击「个人中心」调用 openSpace(mid)', () => {
  const ctx = makeCtx();
  ctx.buildAccountMenu({ mid: 12345, uname: 'u' });
  const profile = ctx.accountMenuEl.children[0];
  assert.strictEqual(profile._listeners.click.length, 1, '应有 click 监听');
  profile._listeners.click[0]({ target: profile });
  assert.strictEqual(ctx.__openSpaceCalls.length, 1, '应调用 openSpace 一次');
  // 菜单项传入 mid，URL 拼接由 openSpace 内部完成（此处验证 mid 正确透传）。
  assert.strictEqual(ctx.__openSpaceCalls[0], 12345, '应将 mid=12345 透传给 openSpace');
});

test('头像菜单：点击「退出登录」调用 doLogout', () => {
  const ctx = makeCtx();
  ctx.buildAccountMenu({ mid: 1, uname: 'u' });
  const logout = ctx.accountMenuEl.children[1];
  logout._listeners.click[0]({ target: logout });
  assert.strictEqual(ctx.__doLogoutCalls, 1, '应调用 doLogout 一次');
});

test('头像菜单：toggleAccountMenu 打开(display=block) 再次点击关闭(display=none)', () => {
  const ctx = makeCtx();
  const anchor = new El('img');
  ctx.toggleAccountMenu({ mid: 1 }, anchor);
  assert.strictEqual(ctx.accountMenuEl.style.display, 'block', '首次点击应打开菜单');
  ctx.toggleAccountMenu({ mid: 1 }, anchor);
  assert.strictEqual(ctx.accountMenuEl.style.display, 'none', '再次点击应关闭菜单');
});
