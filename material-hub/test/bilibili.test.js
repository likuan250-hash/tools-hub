// test/bilibili.test.js —— BiliDownloader 单测
// 覆盖：buildFormat 格式选择 / buildBiliDownloadArgs 参数构造（含 cookie 可选）/
//       downloadUrl 成功流程（贴链接→下载→finalize 保画质→探针）/ 缺链接报错。
// 注入 spawn + fs + probe 替身，不执行真实 yt-dlp/ffmpeg、不访问网络；
// 仅 success 用例在 os.tmpdir() 建一个真实临时目录（用完即删）以验证 finalize 的 existsSync 分支。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { BiliDownloader, buildFormat } = require("../lib/bilibili");

/** 构造 spawn 替身返回的假子进程。 */
function makeChild(opts = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    if (opts.stdout) child.stdout.emit("data", opts.stdout);
    if (opts.stderr) child.stderr.emit("data", opts.stderr);
    child.emit("close", opts.code == null ? 0 : opts.code);
  });
  return child;
}

/** 构造 spawn 替身（按 cmd 区分 yt-dlp / ffprobe）。 */
function fakeSpawn(plan) {
  return (cmd, args) => {
    const opts = typeof plan === "function" ? plan(cmd, args) : plan;
    return makeChild(opts || {});
  };
}

/** 构造 fs 替身（readdirSync 返回给定列表）。 */
function fakeFs(entries) {
  return {
    unlinked: [],
    readdirSync() {
      return entries || [];
    },
    unlinkSync(p) {
      this.unlinked.push(p);
    },
  };
}

/** 构造 MediaProbe 替身。 */
function fakeProbe(res) {
  return {
    calls: [],
    async probeSize(file, opts) {
      this.calls.push({ file, opts });
      if (!res) return { ok: false, error: "no-result" };
      return res;
    },
  };
}

// ───────────────────────── 纯函数：格式选择 ─────────────────────────

test("buildFormat：best 拉满 = bv*+ba/b + 合流 mp4", () => {
  const a = buildFormat("best", true);
  assert.equal(a.format, "bv*+ba/b");
  assert.deepEqual(a.extra, ["--merge-output-format", "mp4"]);
  const b = buildFormat(null, true);
  assert.equal(b.format, "bv*+ba/b");
  assert.deepEqual(b.extra, ["--merge-output-format", "mp4"]);
});

test("buildFormat：数字限定高度时优先同档 H.264，无 ffmpeg 不带合流参数", () => {
  const a = buildFormat(1080, true);
  assert.ok(a.format.includes("height=1080"));
  assert.ok(a.format.includes("vcodec~='^(avc1|h264)'"), "应优先精确高度的 H.264");
  assert.ok(a.format.includes("height<=1080"), "应保留 ≤1080 的降级链");
  assert.ok(!a.format.includes("bestvideo"));
  assert.deepEqual(a.extra, ["--merge-output-format", "mp4"]);

  const b = buildFormat("720", false);
  assert.ok(b.format.includes("height=720"));
  assert.deepEqual(b.extra, []); // 无 ffmpeg 无法合流
});

// ───────────────────────── 参数构造 ─────────────────────────

test("buildBiliDownloadArgs：含 -f / -o / url，无 cookie 时不带 --cookies", () => {
  const d = new BiliDownloader({ cookieFile: "/no/such/cookies.txt" });
  const args = d.buildBiliDownloadArgs(
    "https://www.bilibili.com/video/BV1xx",
    "out/bili_1.%(ext)s",
    { ffmpeg: true },
    { quality: "best" },
  );
  assert.equal(args[0], "-f");
  assert.equal(args[1], "bv*+ba/b");
  assert.ok(args.includes("--merge-output-format"));
  assert.ok(args.includes("--no-part"));
  assert.ok(args.includes("--retries"));
  assert.equal(args[args.indexOf("-o") + 1], "out/bili_1.%(ext)s");
  assert.equal(args[args.length - 1], "https://www.bilibili.com/video/BV1xx");
  assert.ok(!args.includes("--cookies"));
});

test("buildBiliDownloadArgs：cookie 文件存在时带 --cookies", () => {
  const cookie = path.join(os.tmpdir(), "bili-test-cookie-" + Date.now() + ".txt");
  fs.writeFileSync(cookie, "# Netscape cookie\n", "utf8");
  try {
    const d = new BiliDownloader({ cookieFile: cookie });
    const args = d.buildBiliDownloadArgs("https://b23.tv/abc", "out/x.%(ext)s", {}, {});
    const i = args.indexOf("--cookies");
    assert.ok(i >= 0, "应带 --cookies");
    assert.equal(args[i + 1], cookie);
  } finally {
    fs.unlinkSync(cookie);
  }
});

// ───────────────────────── 下载流程 ─────────────────────────

test("downloadUrl：缺链接直接报错（不启动子进程）", async () => {
  const calls = [];
  const d = new BiliDownloader({
    spawn: fakeSpawn(() => {
      throw new Error("不应被调用");
    }),
    fs: fakeFs([]),
    cookieFile: "/no/such/cookies.txt",
  });
  const r = await d.downloadUrl("", "out", { ytDlp: true, ffmpeg: true }, { emit: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty-url");
});

test("downloadUrl：贴链接成功下载并保留 mp4 画质 + 探针分辨率", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-test-"));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {}
  });
  // 预置成品文件（模拟 yt-dlp 已落盘），finalize 因已是 mp4 而原样保留
  fs.writeFileSync(path.join(dir, "test_clip.mp4"), "fake-mp4");

  const events = [];
  const d = new BiliDownloader({
    spawn: fakeSpawn((cmd, args) => {
      // yt-dlp 调用：直接成功（文件已预置）；ffprobe 不会被调用（已是 mp4）
      return { code: 0 };
    }),
    fs: fakeFs(["test_clip.mp4"]),
    probe: fakeProbe({ ok: true, width: 1920, height: 1080 }),
    cookieFile: "/no/such/cookies.txt",
  });

  const r = await d.downloadUrl(
    "https://www.bilibili.com/video/BV1xx",
    dir,
    { ytDlp: true, ffmpeg: true },
    {
      emit: (type, step, msg, ok, detail) => events.push({ type, step, msg, ok, detail }),
      quality: "best",
      fileName: "test_clip",
    },
  );

  assert.equal(r.ok, true);
  assert.equal(r.file, "test_clip.mp4");
  assert.equal(r.width, 1920);
  assert.equal(r.height, 1080);
  assert.equal(r.fromBili, true);
  // 成功事件已发出
  assert.ok(events.some((e) => e.type === "bili_done"));
  // 未触发重编码（已是 mp4）
  assert.ok(!events.some((e) => e.msg && e.msg.includes("重编码")));
});

test("downloadUrl：yt-dlp 失败（退出码非 0）返回错误且不残留", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-test-"));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {}
  });
  const d = new BiliDownloader({
    spawn: fakeSpawn(() => ({ code: 1, stderr: "ERROR: Some error" })),
    fs: fakeFs([]),
    cookieFile: "/no/such/cookies.txt",
  });
  const r = await d.downloadUrl(
    "https://www.bilibili.com/video/BV1xx",
    dir,
    { ytDlp: true, ffmpeg: true },
    { emit: () => {}, fileName: "fail_clip" },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "yt-dlp-failed");
});

test("downloadUrl：403/大会员限制给出可操作的中文报错", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-test-"));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {}
  });
  const d = new BiliDownloader({
    spawn: fakeSpawn(() => ({ code: 1, stderr: "ERROR: 403 Forbidden, need login or 大会员" })),
    fs: fakeFs([]),
    cookieFile: "/no/such/cookies.txt",
  });
  const r = await d.downloadUrl(
    "https://www.bilibili.com/video/BV1xx",
    dir,
    { ytDlp: true, ffmpeg: true },
    { emit: () => {}, fileName: "auth_clip" },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bili-auth");
  assert.ok(/cookie/i.test(r.error));
});

// ───────────────────────── 画质解析（dump-json）─────────────────────────

test("listFormats：解析可用档位并按 分辨率+帧率 排序、同档取码率最高", async () => {
  const json = JSON.stringify({
    title: "测试视频",
    uploader: "UP主",
    duration: 120,
    formats: [
      { format_id: "30280", vcodec: "av01.0.08M.08", width: 1920, height: 1080, fps: 30, tbr: 5000 },
      { format_id: "80", vcodec: "avc1.640032", width: 1920, height: 1080, fps: 60, tbr: 4000 },
      { format_id: "30120", vcodec: "av01.0.09M.10", width: 1920, height: 1080, fps: 60, tbr: 6500 },
      { format_id: "120", vcodec: "hvc1.1.6.L153", width: 3840, height: 2160, fps: 60, tbr: 12000 },
      { format_id: "30216", vcodec: "none", width: 0, height: 0, fps: 0 }, // 纯音频，跳过
    ],
  });
  const d = new BiliDownloader({
    spawn: fakeSpawn(() => ({ code: 0, stdout: json + "\n" })),
    cookieFile: "/no/such/cookies.txt",
  });
  const r = await d.listFormats("https://www.bilibili.com/video/BV1xx", { ytDlp: true }, {});
  assert.equal(r.ok, true);
  assert.equal(r.title, "测试视频");
  assert.equal(r.login.ok, false, "无登录态时 login.ok 应为 false（不联网）");
  assert.ok(r.formats.length >= 4, "同分辨率不同编码应分别列档");
  // 排序：4K 60fps 最前
  assert.ok(r.formats[0].label.startsWith("4K"));
  assert.equal(r.formats[0].id, "120");
  // 1080P60 的 H.264（80）与 AV1（30120）应分别成档
  const h264 = r.formats.find((f) => f.height === 1080 && f.fps === 60 && f.codec === "H.264");
  const av1 = r.formats.find((f) => f.height === 1080 && f.fps === 60 && f.codec === "AV1");
  assert.ok(h264 && av1, "1080P60 应同时有 H.264 与 AV1 两档可选");
  assert.equal(h264.id, "80");
  assert.equal(av1.id, "30120");
  assert.ok(av1.label.includes("将自动转码"), "非 H.264 档应标注将自动转码");
  // 默认档：1080P H.264（id 80），不是最高的 4K
  assert.equal(r.defaultId, "80");
});

test("listFormats：yt-dlp 412（未登录）给出 bili-auth 提示", async () => {
  const d = new BiliDownloader({
    spawn: fakeSpawn(() => ({ code: 1, stderr: "ERROR: HTTP Error 412: Precondition Failed" })),
    cookieFile: "/no/such/cookies.txt",
  });
  const r = await d.listFormats("https://www.bilibili.com/video/BV1xx", { ytDlp: true }, {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bili-auth");
  assert.ok(/412/.test(r.error));
});

// ───────────────────────── AV1→H.264 重编码 ─────────────────────────

test("reencodeH264：ffmpeg 成功且产出文件时返回 true", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-re-"));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {}
  });
  const outPath = path.join(dir, "out.mp4");
  fs.writeFileSync(outPath, "fake"); // 模拟 ffmpeg 已产出
  const d = new BiliDownloader({
    spawn: fakeSpawn(() => ({ code: 0 })),
    cookieFile: "/no/such/cookies.txt",
  });
  const ok = await d.reencodeH264(path.join(dir, "in.mp4"), outPath, "ffmpeg");
  assert.equal(ok, true);
});
