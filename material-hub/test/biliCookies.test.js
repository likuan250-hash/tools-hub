// biliCookies.js 单测：Netscape 转换（纯函数）+ 无登录态时解析为 null（离线，不联网）。
const test = require("node:test");
const assert = require("node:assert/strict");
const { toNetscape, resolveCookieFile, getLoginInfo } = require("../lib/biliCookies");

test("toNetscape：扁平 cookie 转 Netscape 格式（含 SESSDATA，expiry 取 int32 上限）", () => {
  const txt = toNetscape(
    { SESSDATA: "abc123", bili_jct: "jct", DedeUserID: "12345", empty: "", nullv: null },
    ".bilibili.com",
  );
  const lines = txt.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.equal(lines.length, 3, "空值/未定义值应被过滤");
  for (const line of lines) {
    const cols = line.split("\t");
    assert.equal(cols.length, 7);
    assert.equal(cols[0], ".bilibili.com");
    assert.equal(cols[2], "/");
    assert.equal(cols[4], "2147483647");
  }
  assert.ok(lines.some((l) => l.includes("SESSDATA\tabc123")));
  assert.ok(lines.some((l) => l.includes("DedeUserID\t12345")));
});

test("resolveCookieFile：无本地 cookie 且无 BILIUP_DATA_DIR 时返回 null", () => {
  const prev = process.env.BILIUP_DATA_DIR;
  delete process.env.BILIUP_DATA_DIR;
  try {
    assert.equal(resolveCookieFile({ force: true }), null);
  } finally {
    if (prev) process.env.BILIUP_DATA_DIR = prev;
  }
});

test("getLoginInfo：无登录态时返回 ok=false（离线不抛错）", async () => {
  const prev = process.env.BILIUP_DATA_DIR;
  delete process.env.BILIUP_DATA_DIR;
  try {
    const r = await getLoginInfo({ force: true });
    assert.equal(r.ok, false);
    assert.ok(r.source === null || r.source === undefined);
  } finally {
    if (prev) process.env.BILIUP_DATA_DIR = prev;
  }
});
