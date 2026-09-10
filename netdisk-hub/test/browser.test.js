// browser.js 单测：验证「优先系统 Edge、缺 Edge 回退内置 Chromium」的选路与错误信息。
// 关键：browser.js 是**调用时**才 require('playwright')，所以替身必须写进 require 缓存
// 并且在被测函数执行期间一直生效（只临时改 Module._load 会失效，导致真去启动浏览器）。
const test = require("node:test");
const assert = require("node:assert/strict");

/** 用替身加载 browser.js；返回 { launchBrowser, launchPersistentContext, restore }。 */
function withFakePlaywright(fakeChromium) {
  const pwPath = require.resolve("playwright");
  const browserPath = require.resolve("../src/browser");
  const prevPw = require.cache[pwPath];
  require.cache[pwPath] = {
    id: pwPath,
    filename: pwPath,
    loaded: true,
    exports: { chromium: fakeChromium },
  };
  delete require.cache[browserPath];
  const mod = require("../src/browser");
  return {
    ...mod,
    restore() {
      if (prevPw) require.cache[pwPath] = prevPw;
      else delete require.cache[pwPath];
      delete require.cache[browserPath];
    },
  };
}

test("launchBrowser：优先用系统 Edge（channel=msedge）", async () => {
  const calls = [];
  const m = withFakePlaywright({
    async launch(opts) {
      calls.push(opts);
      return { id: "browser" };
    },
  });
  try {
    const r = await m.launchBrowser({ headless: false });
    assert.equal(r.engine, "msedge");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, "msedge");
    assert.equal(calls[0].headless, false);
  } finally {
    m.restore();
  }
});

test("launchBrowser：Edge 不可用时回退内置 Chromium", async () => {
  const calls = [];
  const m = withFakePlaywright({
    async launch(opts) {
      calls.push(opts);
      if (opts.channel === "msedge") throw new Error("Chromium distribution 'msedge' is not found");
      return { id: "browser" };
    },
  });
  try {
    const r = await m.launchBrowser({ headless: true });
    assert.equal(r.engine, "chromium");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].channel, undefined);
  } finally {
    m.restore();
  }
});

test("launchBrowser：两个引擎都失败时抛出可读错误（含各自原因）", async () => {
  const m = withFakePlaywright({
    async launch() {
      throw new Error("boom");
    },
  });
  try {
    await assert.rejects(() => m.launchBrowser(), (e) => {
      assert.match(e.message, /系统 Edge/);
      assert.match(e.message, /内置 Chromium/);
      assert.match(e.message, /Microsoft Edge/);
      return true;
    });
  } finally {
    m.restore();
  }
});

test("launchPersistentContext：同样 Edge 优先并透传 userDataDir", async () => {
  const calls = [];
  const m = withFakePlaywright({
    async launchPersistentContext(dir, opts) {
      calls.push({ dir, opts });
      return { id: "context" };
    },
  });
  try {
    const r = await m.launchPersistentContext("/tmp/profile", { headless: true });
    assert.equal(r.engine, "msedge");
    assert.equal(calls[0].dir, "/tmp/profile");
    assert.equal(calls[0].opts.channel, "msedge");
    assert.equal(calls[0].opts.headless, true);
  } finally {
    m.restore();
  }
});
