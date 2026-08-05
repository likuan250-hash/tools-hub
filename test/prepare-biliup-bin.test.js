// scripts/prepare-biliup-bin.js 纯函数单测：只测判定逻辑。
// 硬约束：不发任何真实网络请求、不真的解压、不落盘 —— 这些在 CI/离线机器上都不可靠。
// 覆盖三条核心防线：
//   ① 资产挑选（选错资产 = 打进一个 Linux 二进制，装包后必失败，且体积校验发现不了）
//   ② 跳过下载的判定（判松了会把半截文件/错误页当成已就位）
//   ③ GitHub API 失败文案（403 匿名限流是最高频故障，必须让人一眼看懂怎么办）
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const {
  humanSize,
  shouldSkipDownload,
  isZipName,
  pickWindowsAsset,
  resolveTokenHeaders,
  describeApiFailure,
  pickExtractedExe,
  sha256Of,
  verifySha256,
  BILIUP_VERSION,
  BILIUP_SHA256,
  RELEASE_API,
  BILIUP_DEST,
  MIN_VALID_BYTES,
  TOKEN_ENV_KEYS,
} = require("../scripts/prepare-biliup-bin");

/* ---------- require 守卫：被 require 时不应触发下载 ---------- */

test("require 该脚本不会触发下载主流程（导出齐全、常量正确）", () => {
  assert.strictEqual(typeof pickWindowsAsset, "function");
  assert.strictEqual(typeof shouldSkipDownload, "function");
  assert.strictEqual(MIN_VALID_BYTES, 1024 * 1024);
  assert.strictEqual(BILIUP_VERSION, "v0.2.4");
  assert.match(BILIUP_SHA256, /^[0-9a-f]{64}$/);
  assert.strictEqual(
    RELEASE_API,
    "https://api.github.com/repos/biliup/biliup-rs/releases/tags/" + BILIUP_VERSION,
  );
  assert.deepStrictEqual(TOKEN_ENV_KEYS, ["GH_TOKEN", "GITHUB_TOKEN"]);
});

test("目标路径固定为 biliup-hub/bin/biliup.exe（extraResources 与门禁都按此路径断言）", () => {
  const tail = BILIUP_DEST.replace(/\\/g, "/").split("/").slice(-3).join("/");
  assert.strictEqual(tail, "biliup-hub/bin/biliup.exe");
  assert.strictEqual(path.isAbsolute(BILIUP_DEST), true);
});

/* ---------- 资产挑选 ---------- */

const REAL_ASSETS = [
  { name: "biliupR-v0.2.7-x86_64-linux.tar.xz", browser_download_url: "https://x/linux.tar.xz" },
  { name: "biliupR-v0.2.7-x86_64-macos.tar.xz", browser_download_url: "https://x/macos.tar.xz" },
  { name: "biliupR-v0.2.7-x86_64-windows.zip", browser_download_url: "https://x/win.zip" },
  { name: "biliupR-v0.2.7-aarch64-linux.tar.xz", browser_download_url: "https://x/arm.tar.xz" },
];

test("pickWindowsAsset：真实 release 资产列表里选中 x86_64-windows 包", () => {
  const hit = pickWindowsAsset(REAL_ASSETS);
  assert.ok(hit);
  assert.strictEqual(hit.name, "biliupR-v0.2.7-x86_64-windows.zip");
  assert.strictEqual(hit.browser_download_url, "https://x/win.zip");
});

test("pickWindowsAsset：兼容 windows-x64 命名（CI 的第二种匹配写法）", () => {
  const hit = pickWindowsAsset([
    { name: "biliup-linux-x64.tar.gz" },
    { name: "biliup-windows-x64.zip" },
  ]);
  assert.strictEqual(hit.name, "biliup-windows-x64.zip");
});

test("pickWindowsAsset：第一轮不命中时回退到 windows 的 zip", () => {
  const hit = pickWindowsAsset([
    { name: "biliup-linux.tar.gz" },
    { name: "biliup-Windows-portable.zip" },
  ]);
  assert.strictEqual(hit.name, "biliup-Windows-portable.zip");
});

test("pickWindowsAsset：前两轮都不命中时回退到任意 .exe", () => {
  const hit = pickWindowsAsset([{ name: "biliup-linux.tar.gz" }, { name: "biliup.exe" }]);
  assert.strictEqual(hit.name, "biliup.exe");
});

test("pickWindowsAsset：优先级严格 —— x86_64-windows 压过普通 windows zip 与裸 exe", () => {
  const hit = pickWindowsAsset([
    { name: "biliup.exe" },
    { name: "biliup-windows-portable.zip" },
    { name: "biliupR-v1.0.0-x86_64-windows.zip" },
  ]);
  assert.strictEqual(hit.name, "biliupR-v1.0.0-x86_64-windows.zip");
});

test("pickWindowsAsset：只有非 Windows 资产时返回 null（由调用方明确报错，不许瞎选）", () => {
  assert.strictEqual(
    pickWindowsAsset([{ name: "biliup-linux.tar.xz" }, { name: "biliup-macos.tar.xz" }]),
    null,
  );
});

test("pickWindowsAsset：空/非法输入一律返回 null 且不抛错", () => {
  assert.strictEqual(pickWindowsAsset([]), null);
  assert.strictEqual(pickWindowsAsset(null), null);
  assert.strictEqual(pickWindowsAsset(undefined), null);
  assert.strictEqual(pickWindowsAsset("not-an-array"), null);
  assert.strictEqual(pickWindowsAsset([null, {}, { name: "" }, { name: "   " }]), null);
});

test("pickWindowsAsset：匹配大小写不敏感（上游改成大写命名也不能漏）", () => {
  const hit = pickWindowsAsset([{ name: "BiliupR-X86_64-WINDOWS.ZIP" }]);
  assert.strictEqual(hit.name, "BiliupR-X86_64-WINDOWS.ZIP");
});

/* ---------- 跳过下载判定 ---------- */

test("shouldSkipDownload：真实 biliup.exe 体量（十几 MB）判定为已就位", () => {
  assert.strictEqual(shouldSkipDownload(15 * 1024 * 1024), true);
  assert.strictEqual(shouldSkipDownload(1024 * 1024 + 1), true);
});

test("shouldSkipDownload：半截文件 / GitHub 错误页必须触发重新下载", () => {
  assert.strictEqual(shouldSkipDownload(0), false);
  assert.strictEqual(shouldSkipDownload(3241), false);
  assert.strictEqual(shouldSkipDownload(1024 * 1024), false); // 严格大于
});

test("shouldSkipDownload：非法输入一律不跳过（宁可多下一次也不出残包）", () => {
  assert.strictEqual(shouldSkipDownload(undefined), false);
  assert.strictEqual(shouldSkipDownload(null), false);
  assert.strictEqual(shouldSkipDownload(NaN), false);
  assert.strictEqual(shouldSkipDownload(Infinity), false);
  assert.strictEqual(shouldSkipDownload("15728640"), false);
});

test("shouldSkipDownload：支持自定义下限，非法下限回落到默认 1MB", () => {
  assert.strictEqual(shouldSkipDownload(2048, 1024), true);
  assert.strictEqual(shouldSkipDownload(2048, 4096), false);
  assert.strictEqual(shouldSkipDownload(2048, NaN), false);
  assert.strictEqual(shouldSkipDownload(2 * 1024 * 1024, NaN), true);
});

/* ---------- zip 判定 ---------- */

test("isZipName：区分 zip 资产与裸 exe 资产（决定走解压还是直接改名）", () => {
  assert.strictEqual(isZipName("biliupR-v0.2.7-x86_64-windows.zip"), true);
  assert.strictEqual(isZipName("BILIUP.ZIP"), true);
  assert.strictEqual(isZipName("  biliup.zip  "), true);
  assert.strictEqual(isZipName("biliup.exe"), false);
  assert.strictEqual(isZipName("biliup.tar.xz"), false);
  assert.strictEqual(isZipName("biliup.zip.sig"), false);
  assert.strictEqual(isZipName(""), false);
  assert.strictEqual(isZipName(null), false);
  assert.strictEqual(isZipName(undefined), false);
});

/* ---------- token 头 ---------- */

test("resolveTokenHeaders：GH_TOKEN 优先于 GITHUB_TOKEN", () => {
  assert.deepStrictEqual(resolveTokenHeaders({ GH_TOKEN: "a", GITHUB_TOKEN: "b" }), {
    Authorization: "Bearer a",
  });
});

test("resolveTokenHeaders：只有 GITHUB_TOKEN 时也能用", () => {
  assert.deepStrictEqual(resolveTokenHeaders({ GITHUB_TOKEN: "ghp_x" }), {
    Authorization: "Bearer ghp_x",
  });
});

test("resolveTokenHeaders：无 token / 空白 token 时返回空对象（走匿名配额）", () => {
  assert.deepStrictEqual(resolveTokenHeaders({}), {});
  assert.deepStrictEqual(resolveTokenHeaders({ GH_TOKEN: "   " }), {});
  assert.deepStrictEqual(resolveTokenHeaders({ GH_TOKEN: "" }), {});
  assert.deepStrictEqual(resolveTokenHeaders(null), {});
});

test("resolveTokenHeaders：token 两侧空白被裁掉（复制粘贴常带换行）", () => {
  assert.deepStrictEqual(resolveTokenHeaders({ GH_TOKEN: "  tok\n" }), {
    Authorization: "Bearer tok",
  });
});

/* ---------- API 失败文案 ---------- */

test("describeApiFailure：2xx 返回空串（表示不是失败）", () => {
  assert.strictEqual(describeApiFailure(200, {}, { assets: [] }, false), "");
  assert.strictEqual(describeApiFailure(204, {}, {}, true), "");
});

test("describeApiFailure：匿名限流 403 要说清配额、恢复时间与 GH_TOKEN 解法", () => {
  const msg = describeApiFailure(
    403,
    { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" },
    { message: "API rate limit exceeded for 1.2.3.4." },
    false,
  );
  assert.match(msg, /速率限制/);
  assert.match(msg, /403/);
  assert.match(msg, /GH_TOKEN/);
  assert.match(msg, /5000/);
  assert.match(msg, /恢复/);
});

test("describeApiFailure：已带 token 仍被限流时不再重复劝人配 token", () => {
  const msg = describeApiFailure(
    403,
    { "x-ratelimit-remaining": "0" },
    { message: "API rate limit exceeded" },
    true,
  );
  assert.match(msg, /速率限制/);
  assert.match(msg, /已带 token/);
  assert.ok(!/设置环境变量/.test(msg));
});

test("describeApiFailure：429 也按限流处理", () => {
  const msg = describeApiFailure(429, {}, { message: "You have exceeded a secondary rate limit" }, false);
  assert.match(msg, /速率限制/);
});

test("describeApiFailure：403 但不是限流（如被 UA 拒）走通用文案，不误导", () => {
  const msg = describeApiFailure(403, { "x-ratelimit-remaining": "58" }, { message: "Forbidden" }, false);
  assert.match(msg, /HTTP 403/);
  assert.ok(!/速率限制/.test(msg));
});

test("describeApiFailure：401 指向 token 失效", () => {
  const msg = describeApiFailure(401, {}, { message: "Bad credentials" }, true);
  assert.match(msg, /401/);
  assert.match(msg, /无效或已过期/);
});

test("describeApiFailure：404 指向上游 release 不存在", () => {
  const msg = describeApiFailure(404, {}, { message: "Not Found" }, false);
  assert.match(msg, /404/);
  assert.match(msg, /biliup-rs/);
});

test("describeApiFailure：其他状态码带上服务端原文，且非法入参不抛错", () => {
  assert.match(describeApiFailure(500, {}, { message: "boom" }, false), /HTTP 500.*boom/);
  assert.match(describeApiFailure(502, null, null, false), /HTTP 502/);
  assert.match(describeApiFailure("bad", undefined, undefined, false), /HTTP 0/);
});

/* ---------- 解压产物挑选 ---------- */

test("pickExtractedExe：优先精确命中 biliup.exe", () => {
  const hit = pickExtractedExe([
    path.join("unzip", "README.md"),
    path.join("unzip", "extra", "helper.exe"),
    path.join("unzip", "biliup.exe"),
  ]);
  assert.strictEqual(path.basename(hit), "biliup.exe");
});

test("pickExtractedExe：大小写不敏感匹配 BiliUp.EXE", () => {
  const hit = pickExtractedExe([path.join("unzip", "BiliUp.EXE")]);
  assert.strictEqual(path.basename(hit), "BiliUp.EXE");
});

test("pickExtractedExe：没有 biliup.exe 时退而求其次取任意 .exe", () => {
  const hit = pickExtractedExe([path.join("unzip", "readme.txt"), path.join("unzip", "biliupR.exe")]);
  assert.strictEqual(path.basename(hit), "biliupR.exe");
});

test("pickExtractedExe：一个 exe 都没有时返回 null（由调用方 exit 1）", () => {
  assert.strictEqual(pickExtractedExe([path.join("unzip", "readme.txt")]), null);
  assert.strictEqual(pickExtractedExe([]), null);
  assert.strictEqual(pickExtractedExe(null), null);
  assert.strictEqual(pickExtractedExe(["", null, 42]), null);
});

/* ---------- 体积文案 ---------- */

test("humanSize：分档输出可读文案", () => {
  assert.strictEqual(humanSize(0), "0B");
  assert.strictEqual(humanSize(512), "512B");
  assert.strictEqual(humanSize(2048), "2.0KB");
  assert.strictEqual(humanSize(15 * 1024 * 1024), "15.0MB");
  assert.strictEqual(humanSize(undefined), "0B");
  assert.strictEqual(humanSize(null), "0B");
});

/* ---------- SHA256 校验 ---------- */

test("sha256Of / verifySha256：一致通过，不一致抛清晰错误", () => {
  const os = require("os");
  const fs = require("fs");
  const tmp = path.join(os.tmpdir(), "biliup_sha_" + Date.now() + ".bin");
  fs.writeFileSync(tmp, "hello tools-hub");
  const expected = require("crypto").createHash("sha256").update("hello tools-hub").digest("hex");
  assert.strictEqual(sha256Of(tmp), expected);
  assert.strictEqual(verifySha256(tmp, expected.toUpperCase()), true); // 大小写不敏感
  assert.throws(() => verifySha256(tmp, "0".repeat(64)), /SHA256 校验失败/);
  fs.unlinkSync(tmp);
});

test("BILIUP_SHA256 与固定版本一致（防误改常量导致构建时才发现）", () => {
  // 该哈希来自 biliup-rs v0.2.4 官方 release 资产 biliupR-v0.2.4-x86_64-windows.zip（2026-08-05 实测）
  assert.strictEqual(BILIUP_SHA256, "bdd3d7a56f00aea580cd3e609fd4b1748085e68ea2f1527d4aa8ff06b9796365");
});
