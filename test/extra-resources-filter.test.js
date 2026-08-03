// build.extraResources 的 filter 规则单测 —— 专门守 npm 暂存目录排除规则。
//
// ===== 根因（2026-08-04）=====
// npm（@npmcli/arborist）安装依赖时不会直接把包解到最终目录，而是先解到同级的一个
// 「点开头 + 随机后缀」暂存目录，落盘完成后再原子 rename 成正式目录。命名文法是
//     .<包名去 scope>-<crypto.randomBytes(6).toString("base64url")>
// 即：一个点、包名、一个连字符、**恰好 8 位** base64url 字符（A-Za-z0-9_-）。
// 正常装完 npm 会清掉这些暂存目录；但只要安装中途被打断（本机曾在写 package-lock.json
// 时被系统 EPERM 打断），它们就会原样留在 node_modules 里。
//
// 事故形态：material-hub/node_modules 下同时存在
//     @ffmpeg-installer/win32-x64/ffmpeg.exe          61.5MB  正式
//     @ffmpeg-installer/.win32-x64-DA7iMGRX/ffmpeg.exe 61.5MB  暂存残留
//     @ffprobe-installer/win32-x64/ffprobe.exe         77.2MB  正式
//     @ffprobe-installer/.win32-x64-AOGq4KQO/ffprobe.exe 77.2MB 暂存残留
// 而 extraResources 的 filter 是 ["**/*", ...] 全量纳入，没有任何规则排除点开头暂存目录，
// 于是两份 61.5MB + 77.2MB 的重复二进制被原样打进安装包，白白让包胖 138.7MB。
// 另有一条 .tools-hub-Jyabht3r 是 npm 留下的暂存**符号链接**，指向开发机绝对路径
// E:\d\work\tools-hub —— 装到用户机上是个悬空链接，还顺带泄露开发者本地路径。
//
// ===== 为什么是现在这两条规则 =====
// electron-builder 的 glob 语义（app-builder-lib/out/fileMatcher.js）有两个关键点：
//   1. minimatchOptions = { dot: true }，所以 * / ** 会匹配点开头的名字，
//      不能想当然以为「点开头天然被 * 跳过」；
//   2. util/filter.js 的 minimatchAll 对目录用 partial 匹配正向规则、对排除规则用
//      非 partial 匹配，且 builder-util 的 copyDir 明确「Empty directories is never created」
//      —— 所以只排掉「目录内容」也不会在产物里留下空目录。
//
// 采用的两条规则是分层的，一条精准、一条兜底：
//   A. "!node_modules/**/.*-????????"
//      精准命中 npm 暂存命名文法（8 位随机后缀），能连**条目本身**一起排掉，
//      因此对暂存目录、暂存符号链接都生效。
//      不会误伤 .package-lock.json：它最后一个连字符后是 "lock.json"，9 个字符，? 数对不上。
//      不会误伤 .bin：压根没有连字符。
//      不会误伤正式的 win32-x64：没有前导点。
//   B. "!node_modules/**/.*-*/**"
//      兜底层，只排「点开头且带连字符的目录」的**内容**。即使将来 npm 改了随机后缀长度、
//      规则 A 失效，这条仍能拦住体积大头。
//      它结构上不可能误伤 .package-lock.json / .yarn-integrity 这类**文件**
//      —— 尾部的 /** 要求后面还有路径段，文件没有「内容」，永远匹配不上。
//
// 本测试不做推理，直接实例化 electron-builder 自己的 FileMatcher，用它真实的
// createFilter() 去跑判定，保证测的就是构建时的语义。
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { FileMatcher } = require("app-builder-lib/out/fileMatcher");

const ROOT = path.join(__dirname, "..");

/** 本次新增的两条排除规则（必须与 package.json 中的完全一致）。 */
const STAGING_RULES = ["!node_modules/**/.*-????????", "!node_modules/**/.*-*/**"];

/** 期望装上这两条规则的子模块（四个都要，保持一致、防患于未然）。 */
const GUARDED_SUBMODULES = ["kdocs-tool", "netdisk-hub", "biliup-hub", "material-hub"];

/**
 * 用 electron-builder 真实的 FileMatcher 造一个判定函数。
 * @param {string[]} patterns filter 规则数组
 * @param {string} [from] 源目录（只影响相对路径计算，不必真实存在）
 * @returns {(relPath: string, isDir?: boolean) => boolean} true 表示该路径会被打进包
 */
function makeDecider(patterns, from = path.join(ROOT, "material-hub")) {
  const matcher = new FileMatcher(from, path.join(ROOT, "dist", "__probe__"), (s) => s, patterns);
  const filter = matcher.createFilter();
  return (relPath, isDir = false) => {
    const full = path.join(from, relPath.replace(/\//g, path.sep));
    // 只喂 filter 需要的两个字段，避免依赖磁盘上真实存在该路径
    const fakeStat = { isDirectory: () => isDir, isFile: () => !isDir };
    return filter(full, fakeStat);
  };
}

/* ---------- 1) 规则精准性：该排的排掉、该留的一个不少 ---------- */

test("暂存规则会排掉 npm 暂存目录里的冗余二进制", () => {
  const decide = makeDecider(["**/*", ...STAGING_RULES]);
  assert.strictEqual(
    decide("node_modules/@ffmpeg-installer/.win32-x64-DA7iMGRX/ffmpeg.exe"),
    false,
    "61.5MB 冗余 ffmpeg 副本必须被排除",
  );
  assert.strictEqual(
    decide("node_modules/@ffprobe-installer/.win32-x64-AOGq4KQO/ffprobe.exe"),
    false,
    "77.2MB 冗余 ffprobe 副本必须被排除",
  );
  assert.strictEqual(
    decide("node_modules/@ffmpeg-installer/.ffmpeg-BqplFM1u/index.js"),
    false,
    "暂存的壳包内容也应排除",
  );
});

test("暂存规则会排掉暂存目录/符号链接条目本身（靠 8 位后缀那条）", () => {
  const decide = makeDecider(["**/*", ...STAGING_RULES]);
  assert.strictEqual(
    decide("node_modules/@ffmpeg-installer/.win32-x64-DA7iMGRX", true),
    false,
    "暂存目录本体应被排除，walk 无需下钻",
  );
  assert.strictEqual(
    decide("node_modules/.tools-hub-Jyabht3r", false),
    false,
    "指向开发机绝对路径的暂存符号链接必须被排除（lstat 下它不是目录）",
  );
});

test("暂存规则绝不误伤正式平台目录与其中的二进制", () => {
  const decide = makeDecider(["**/*", ...STAGING_RULES]);
  assert.strictEqual(decide("node_modules/@ffmpeg-installer/win32-x64", true), true);
  assert.strictEqual(decide("node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe"), true);
  assert.strictEqual(decide("node_modules/@ffprobe-installer/win32-x64", true), true);
  assert.strictEqual(decide("node_modules/@ffprobe-installer/win32-x64/ffprobe.exe"), true);
  assert.strictEqual(decide("node_modules/@ffmpeg-installer/ffmpeg/index.js"), true);
});

test("暂存规则绝不误伤 .bin 与 .package-lock.json（点开头但不是暂存物）", () => {
  const decide = makeDecider(["**/*", ...STAGING_RULES]);
  assert.strictEqual(decide("node_modules/.bin", true), true, ".bin 无连字符，不该被匹配");
  assert.strictEqual(decide("node_modules/.bin/ffmpeg.cmd"), true);
  assert.strictEqual(
    decide("node_modules/.package-lock.json"),
    true,
    ".package-lock.json 末段连字符后是 9 字符 lock.json，8 位 ? 匹配不上",
  );
  // 其它常见的点开头基础设施条目同样不能被误伤
  assert.strictEqual(decide("node_modules/.yarn-integrity"), true);
  assert.strictEqual(decide("node_modules/.modules.yaml"), true);
});

test("暂存规则不影响 node_modules 以外的路径", () => {
  const decide = makeDecider(["**/*", ...STAGING_RULES]);
  assert.strictEqual(decide("server.js"), true);
  assert.strictEqual(decide("lib/env.js"), true);
  assert.strictEqual(decide("bin/yt-dlp.exe"), true);
  // 业务目录下就算有点开头带连字符的名字也不归这条规则管（规则前缀锁定 node_modules/）
  assert.strictEqual(decide("bin/.keep-me-Abcd1234"), true);
});

/* ---------- 2) 与既有规则共存：不能把老规则顶掉 ---------- */

test("加了暂存规则后，既有排除规则依旧生效", () => {
  const decide = makeDecider([
    "**/*",
    "!node_modules/**/.cache",
    "!**/*.log",
    "!logs/**",
    "!**/.env",
    "!.tmp/**",
    ...STAGING_RULES,
  ]);
  assert.strictEqual(decide("node_modules/foo/.cache", true), false);
  assert.strictEqual(decide("server.log"), false);
  assert.strictEqual(decide("logs/run.log"), false);
  assert.strictEqual(decide(".env"), false);
  assert.strictEqual(decide(".tmp/scratch.bin"), false);
  // 同时正式二进制仍在
  assert.strictEqual(decide("node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe"), true);
});

/* ---------- 3) 配置守卫：package.json 四个子模块都要带上这两条 ---------- */

test("package.json 四个子模块的 extraResources 均含暂存排除规则", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const entries = (pkg.build && pkg.build.extraResources) || [];
  for (const name of GUARDED_SUBMODULES) {
    const entry = entries.find((e) => e && typeof e === "object" && e.from === name);
    assert.ok(entry, `extraResources 缺少 from: "${name}" 条目`);
    const filter = Array.isArray(entry.filter) ? entry.filter : [];
    for (const rule of STAGING_RULES) {
      assert.ok(
        filter.includes(rule),
        `extraResources[${name}].filter 缺少 npm 暂存排除规则 ${rule}`,
      );
    }
  }
});

/* ---------- 4) 真实磁盘校验：当前工作区确实存在暂存残留时，规则必须能全部盖住 ---------- */

test("对真实 node_modules 落盘树，规则能盖住全部暂存残留且不误伤正式二进制", () => {
  const from = path.join(ROOT, "material-hub");
  const nm = path.join(from, "node_modules");
  if (!fs.existsSync(nm)) {
    // 未安装依赖的环境（如干净 CI checkout）跳过，不做假阳性拦截
    return;
  }
  const decide = makeDecider(["**/*", ...STAGING_RULES], from);

  /** npm 暂存命名文法：点 + 任意 + 连字符 + 恰好 8 位 base64url。 */
  const STAGING_NAME = /^\.[^/]*-[A-Za-z0-9_-]{8}$/;
  const stagingHits = [];
  const officialBinaries = [];

  (function scan(dir, depth) {
    if (depth > 5) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(from, full).replace(/\\/g, "/");
      const isDir = ent.isDirectory() && !ent.isSymbolicLink();
      if (STAGING_NAME.test(ent.name)) stagingHits.push({ rel, isDir });
      if (/^ff(mpeg|probe)\.exe$/i.test(ent.name) && !rel.includes("/.")) {
        officialBinaries.push(rel);
      }
      if (isDir) scan(full, depth + 1);
    }
  })(nm, 0);

  // 本机当前确有 19 条残留；断言「凡是符合暂存文法的，一条都不许进包」
  for (const hit of stagingHits) {
    assert.strictEqual(
      decide(hit.rel, hit.isDir),
      false,
      `暂存残留未被排除，会白白进包: ${hit.rel}`,
    );
  }
  // 反向：正式的 ffmpeg.exe / ffprobe.exe 必须一个不少地留下
  assert.ok(officialBinaries.length > 0, "未找到正式二进制，说明扫描逻辑或依赖安装有问题");
  for (const rel of officialBinaries) {
    assert.strictEqual(decide(rel), true, `正式二进制被误伤: ${rel}`);
  }
});
