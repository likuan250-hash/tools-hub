// 主进程纯函数（lib/host-utils.js）单测：不依赖 Electron 运行时，可直接在 node 跑。
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { safeStr, copyDir } = require("../lib/host-utils");

test("safeStr：字符串原样返回", () => {
  assert.strictEqual(safeStr("hello"), "hello");
});

test("safeStr：Error 返回 stack 或 message", () => {
  const e = new Error("boom");
  const r = safeStr(e);
  assert.ok(r.includes("boom"), "应含错误信息");
});

test("safeStr：普通对象 JSON 化", () => {
  assert.strictEqual(safeStr({ a: 1, b: "x" }), '{"a":1,"b":"x"}');
});

test("safeStr：循环引用对象回退 String，不抛错", () => {
  const obj = { a: 1 };
  obj.self = obj;
  assert.strictEqual(typeof safeStr(obj), "string");
});

test("copyDir：递归拷贝目录树且内容一致", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "hu-src-"));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "hu-dest-"));
  fs.mkdirSync(path.join(src, "sub"));
  fs.writeFileSync(path.join(src, "a.txt"), "AAA");
  fs.writeFileSync(path.join(src, "sub", "b.txt"), "BBB");

  copyDir(src, dest);

  assert.strictEqual(fs.readFileSync(path.join(dest, "a.txt"), "utf8"), "AAA");
  assert.strictEqual(fs.readFileSync(path.join(dest, "sub", "b.txt"), "utf8"), "BBB");
  assert.ok(fs.statSync(path.join(dest, "sub")).isDirectory());
});
