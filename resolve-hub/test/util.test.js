const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("../lib/util");

test("sanitizeOutName：去 .mp4 / 非法字符 / 路径穿越，空值回退默认名", () => {
  assert.strictEqual(util.sanitizeOutName("游戏A 官方中文.mp4", "项目"), "游戏A 官方中文");
  const traversal = util.sanitizeOutName("..\\..\\evil", "项目");
  assert.ok(!traversal.includes("/") && !traversal.includes("\\"), "不能保留路径分隔符");
  assert.ok(!traversal.startsWith("."), "不能以点开头");
  assert.strictEqual(util.sanitizeOutName('a/b:c*?"<>|d', "项目"), "a_b_c_d");
  const fallback = util.sanitizeOutName("", "项目");
  assert.strictEqual(fallback, "项目 " + util.DEFAULT_SUFFIX);
  assert.strictEqual(util.sanitizeOutName("..", "项目"), fallback);
});

test("sanitizeProjectName：去路径和非法字符，空返回空串", () => {
  assert.strictEqual(util.sanitizeProjectName("  【游戏341】鬼灭/之刃  "), "【游戏341】鬼灭_之刃");
  assert.strictEqual(util.sanitizeProjectName("   "), "");
});

test("isAllowedOrigin：本机回环放行，外站/非法 Origin 拒绝", () => {
  assert.strictEqual(util.isAllowedOrigin(undefined), true);
  assert.strictEqual(util.isAllowedOrigin("http://127.0.0.1:3800"), true);
  assert.strictEqual(util.isAllowedOrigin("http://localhost:3800"), true);
  assert.strictEqual(util.isAllowedOrigin("https://evil.example.com"), false);
  assert.strictEqual(util.isAllowedOrigin("not a url"), false);
});

test("findRenderedFile：能认 DaVinci 的 名字 (1).mp4，并取最新", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-hub-out-"));
  const base = "项目 官方中文";
  const a = path.join(dir, base + ".mp4");
  const b = path.join(dir, base + " (1).mp4");
  fs.writeFileSync(a, "old");
  fs.writeFileSync(b, "newer");
  fs.writeFileSync(path.join(dir, "别的.mp4"), "x");
  const t = new Date(Date.now() - 60000);
  fs.utimesSync(a, t, t);
  const hit = util.findRenderedFile(dir, base);
  assert.ok(hit, "应找到输出文件");
  assert.strictEqual(path.basename(hit.path), base + " (1).mp4");
  assert.strictEqual(util.findRenderedFile(dir, "不存在"), null);
});

test("退出码标记：解析最后一个，并从日志里剥离", () => {
  const text = "日志\n__RESOLVE_EXIT__=1\n更多\n__RESOLVE_EXIT__=0\n";
  assert.strictEqual(util.parseExitMarker(text), 0);
  assert.strictEqual(util.stripExitMarker(text).includes("__RESOLVE_EXIT__"), false);
  assert.strictEqual(util.parseExitMarker("无标记"), null);
});
