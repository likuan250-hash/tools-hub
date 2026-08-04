// scripts/verify-build-assets.js 纯函数单测：只测判定逻辑，绝不真的去构建产物。
// 覆盖两条核心防线：filter 规则是否会排掉 bin/node_modules、二进制体积阈值判定。
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fs = require("fs");
const path = require("path");
const {
  MIN_BINARY_BYTES,
  PROTECTED_DIRS,
  isSaneBinarySize,
  formatBytes,
  ruleBlocksDir,
  findBlockingFilterRules,
  filterHasCatchAllInclude,
  resolveArtifactPaths,
  findFileRecursive,
} = require("../scripts/verify-build-assets");

/* ---------- require 守卫：被 require 时不应执行 main() ---------- */

test("require 该脚本不会触发校验主流程（无进程退出、导出齐全）", () => {
  assert.strictEqual(typeof ruleBlocksDir, "function");
  assert.strictEqual(typeof findBlockingFilterRules, "function");
  assert.strictEqual(typeof isSaneBinarySize, "function");
  assert.strictEqual(MIN_BINARY_BYTES, 1024 * 1024);
  assert.deepStrictEqual(PROTECTED_DIRS, ["bin", "node_modules"]);
});

/* ---------- 体积阈值判定 ---------- */

test("isSaneBinarySize：大于 1MB 判定通过", () => {
  assert.strictEqual(isSaneBinarySize(18226085), true);
  assert.strictEqual(isSaneBinarySize(1024 * 1024 + 1), true);
});

test("isSaneBinarySize：等于或小于 1MB 判定失败（严格大于）", () => {
  assert.strictEqual(isSaneBinarySize(1024 * 1024), false);
  assert.strictEqual(isSaneBinarySize(1024 * 1024 - 1), false);
});

test("isSaneBinarySize：GitHub 错误页体量（几 KB）必须被拦下", () => {
  assert.strictEqual(isSaneBinarySize(3241), false);
  assert.strictEqual(isSaneBinarySize(0), false);
});

test("isSaneBinarySize：非法输入一律判失败，不抛错", () => {
  assert.strictEqual(isSaneBinarySize(undefined), false);
  assert.strictEqual(isSaneBinarySize(null), false);
  assert.strictEqual(isSaneBinarySize(NaN), false);
  assert.strictEqual(isSaneBinarySize(Infinity), false);
  assert.strictEqual(isSaneBinarySize("18226085"), false);
});

test("isSaneBinarySize：支持自定义下限", () => {
  assert.strictEqual(isSaneBinarySize(2048, 1024), true);
  assert.strictEqual(isSaneBinarySize(2048, 4096), false);
});

test("formatBytes：分档输出可读文案", () => {
  assert.strictEqual(formatBytes(512), "512B");
  assert.strictEqual(formatBytes(3241), "3.2KB");
  assert.strictEqual(formatBytes(18226085), "17.4MB");
  assert.strictEqual(formatBytes(-1), "未知大小");
  assert.strictEqual(formatBytes("abc"), "未知大小");
});

/* ---------- filter 规则：会整体排掉目录的写法 ---------- */

test("ruleBlocksDir：!node_modules/** 等整体排除写法全部命中", () => {
  const forms = [
    "!node_modules",
    "!node_modules/",
    "!node_modules/*",
    "!node_modules/**",
    "!node_modules/**/*",
    "!**/node_modules",
    "!**/node_modules/**",
    "!**/node_modules/**/*",
  ];
  for (const rule of forms) {
    assert.strictEqual(ruleBlocksDir(rule, "node_modules"), true, `应命中: ${rule}`);
  }
});

test("ruleBlocksDir：bin 目录的整体排除写法同样命中", () => {
  assert.strictEqual(ruleBlocksDir("!bin/**", "bin"), true);
  assert.strictEqual(ruleBlocksDir("!bin", "bin"), true);
  assert.strictEqual(ruleBlocksDir("!**/bin/**", "bin"), true);
});

test("ruleBlocksDir：通配一切的排除规则对任意受保护目录都命中", () => {
  for (const rule of ["!*", "!**", "!**/*"]) {
    assert.strictEqual(ruleBlocksDir(rule, "bin"), true, `应命中: ${rule}`);
    assert.strictEqual(ruleBlocksDir(rule, "node_modules"), true, `应命中: ${rule}`);
  }
});

test("ruleBlocksDir：反斜杠与 ./ 前缀写法能归一化后命中", () => {
  assert.strictEqual(ruleBlocksDir("!node_modules\\**", "node_modules"), true);
  assert.strictEqual(ruleBlocksDir("!./bin/**", "bin"), true);
  assert.strictEqual(ruleBlocksDir("  !bin/**  ", "bin"), true);
});

/* ---------- filter 规则：不应误判的安全写法 ---------- */

test("ruleBlocksDir：现网既有的精确子路径排除不得误判", () => {
  const safe = [
    "!node_modules/**/.cache",
    "!**/*.log",
    "!logs/**",
    "!**/.env",
    "!.tmp/**",
    "!data/**",
  ];
  for (const rule of safe) {
    assert.strictEqual(ruleBlocksDir(rule, "node_modules"), false, `不应命中: ${rule}`);
    assert.strictEqual(ruleBlocksDir(rule, "bin"), false, `不应命中: ${rule}`);
  }
});

test("ruleBlocksDir：正向规则（不带 !）永远不算排除", () => {
  assert.strictEqual(ruleBlocksDir("**/*", "bin"), false);
  assert.strictEqual(ruleBlocksDir("node_modules/**", "node_modules"), false);
  assert.strictEqual(ruleBlocksDir("bin/**", "bin"), false);
});

test("ruleBlocksDir：目录名相近但不相同的规则不误伤", () => {
  assert.strictEqual(ruleBlocksDir("!bin-tmp/**", "bin"), false);
  assert.strictEqual(ruleBlocksDir("!binaries", "bin"), false);
  assert.strictEqual(ruleBlocksDir("!node_modules_old/**", "node_modules"), false);
  assert.strictEqual(ruleBlocksDir("!bin/yt-dlp.exe", "bin"), false);
});

test("ruleBlocksDir：非法输入返回 false，不抛错", () => {
  assert.strictEqual(ruleBlocksDir(null, "bin"), false);
  assert.strictEqual(ruleBlocksDir(undefined, "bin"), false);
  assert.strictEqual(ruleBlocksDir(123, "bin"), false);
  assert.strictEqual(ruleBlocksDir("!bin", ""), false);
  assert.strictEqual(ruleBlocksDir("!", "bin"), false);
});

/* ---------- findBlockingFilterRules：整数组判定 ---------- */

test("findBlockingFilterRules：现网 material-hub 的真实 filter 判定为安全", () => {
  const filter = [
    "**/*",
    "!node_modules/**/.cache",
    "!**/*.log",
    "!logs/**",
    "!**/.env",
    "!.tmp/**",
  ];
  assert.deepStrictEqual(findBlockingFilterRules(filter), []);
});

test("findBlockingFilterRules：改坏成排掉 node_modules 会被抓出", () => {
  const filter = ["**/*", "!node_modules/**", "!**/*.log"];
  const hits = findBlockingFilterRules(filter);
  assert.strictEqual(hits.length, 1);
  assert.deepStrictEqual(hits[0], { rule: "!node_modules/**", dir: "node_modules" });
});

test("findBlockingFilterRules：bin 与 node_modules 同时被排掉时全部报出", () => {
  const filter = ["**/*", "!bin/**", "!node_modules/**"];
  const hits = findBlockingFilterRules(filter);
  assert.strictEqual(hits.length, 2);
  assert.deepStrictEqual(
    hits.map((h) => h.dir),
    ["bin", "node_modules"],
  );
});

test("findBlockingFilterRules：非数组输入返回空数组", () => {
  assert.deepStrictEqual(findBlockingFilterRules(undefined), []);
  assert.deepStrictEqual(findBlockingFilterRules(null), []);
  assert.deepStrictEqual(findBlockingFilterRules("**/*"), []);
});

test("findBlockingFilterRules：可自定义受保护目录列表", () => {
  const hits = findBlockingFilterRules(["!public/**"], ["public"]);
  assert.deepStrictEqual(hits, [{ rule: "!public/**", dir: "public" }]);
});

/* ---------- filterHasCatchAllInclude：窄白名单防护 ---------- */

test("filterHasCatchAllInclude：含 **/* 判为全量", () => {
  assert.strictEqual(filterHasCatchAllInclude(["**/*", "!**/*.log"]), true);
  assert.strictEqual(filterHasCatchAllInclude(["**"]), true);
});

test("filterHasCatchAllInclude：空数组或未定义视为全量拷贝", () => {
  assert.strictEqual(filterHasCatchAllInclude([]), true);
  assert.strictEqual(filterHasCatchAllInclude(undefined), true);
});

test("filterHasCatchAllInclude：只有排除规则时仍视为全量（electron-builder 语义）", () => {
  assert.strictEqual(filterHasCatchAllInclude(["!**/*.log", "!logs/**"]), true);
});

test("filterHasCatchAllInclude：被改成窄白名单时判失败", () => {
  assert.strictEqual(filterHasCatchAllInclude(["lib/**/*", "server.js"]), false);
  assert.strictEqual(filterHasCatchAllInclude(["lib/**/*", "!**/*.log"]), false);
});

/* ---------- resolveArtifactPaths：两个环境变量互相自洽 ---------- */

test("resolveArtifactPaths：都不设时指向同一个默认 resources/", () => {
  const { asarPath, resourcesDir } = resolveArtifactPaths({}, "/repo");
  assert.strictEqual(path.dirname(asarPath), resourcesDir);
  assert.ok(resourcesDir.endsWith(path.join("dist", "win-unpacked", "resources")));
  assert.ok(asarPath.endsWith("app.asar"));
});

test("resolveArtifactPaths：只设 ASAR_PATH 时 resourcesDir 跟随其父目录", () => {
  const custom = path.resolve("/tmp/out/resources/app.asar");
  const { asarPath, resourcesDir } = resolveArtifactPaths({ ASAR_PATH: custom }, "/repo");
  assert.strictEqual(asarPath, custom);
  assert.strictEqual(resourcesDir, path.dirname(custom));
});

test("resolveArtifactPaths：只设 RESOURCES_DIR 时 asarPath 跟随其下 app.asar", () => {
  const dir = path.resolve("/tmp/out/resources");
  const { asarPath, resourcesDir } = resolveArtifactPaths({ RESOURCES_DIR: dir }, "/repo");
  assert.strictEqual(resourcesDir, dir);
  assert.strictEqual(asarPath, path.join(dir, "app.asar"));
});

test("resolveArtifactPaths：两者都设时各自生效，互不覆盖", () => {
  const asar = path.resolve("/a/resources/app.asar");
  const dir = path.resolve("/b/resources");
  const r = resolveArtifactPaths({ ASAR_PATH: asar, RESOURCES_DIR: dir }, "/repo");
  assert.strictEqual(r.asarPath, asar);
  assert.strictEqual(r.resourcesDir, dir);
});

/* ---------- findFileRecursive：平台子包定位 ---------- */

test("findFileRecursive：能在平台子包目录里找到 exe", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vba-scope-"));
  const sub = path.join(root, "win32-x64");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "ffmpeg.exe"), "MZ");

  const hit = findFileRecursive(root, "ffmpeg.exe");
  assert.strictEqual(hit, path.join(sub, "ffmpeg.exe"));
});

test("findFileRecursive：跳过 npm 遗留的点开头临时目录", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vba-dot-"));
  const dotDir = path.join(root, ".win32-x64-AbCdEf");
  fs.mkdirSync(dotDir, { recursive: true });
  fs.writeFileSync(path.join(dotDir, "ffprobe.exe"), "MZ");

  assert.strictEqual(findFileRecursive(root, "ffprobe.exe"), null);
});

test("findFileRecursive：找不到时返回 null，目录不存在也不抛错", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vba-empty-"));
  assert.strictEqual(findFileRecursive(root, "ffmpeg.exe"), null);
  assert.strictEqual(findFileRecursive(path.join(root, "nope"), "ffmpeg.exe"), null);
});

test("findFileRecursive：文件名大小写不敏感", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vba-case-"));
  fs.writeFileSync(path.join(root, "FFmpeg.EXE"), "MZ");
  assert.strictEqual(findFileRecursive(root, "ffmpeg.exe"), path.join(root, "FFmpeg.EXE"));
});

test("findFileRecursive：深度超限时停止下钻，返回 null", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vba-depth-"));
  const deep = path.join(root, "a", "b", "c");
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, "ffmpeg.exe"), "MZ");

  assert.strictEqual(findFileRecursive(root, "ffmpeg.exe", 1), null);
  assert.strictEqual(findFileRecursive(root, "ffmpeg.exe", 8), path.join(deep, "ffmpeg.exe"));
});
