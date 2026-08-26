// test/trailer.test.js —— TrailerDownloader 单测
// 覆盖：yt-dlp 参数构造（ytsearch10 + --flat-playlist）/ NDJSON 解析 /
//       规范打分筛选（频道档位 + 类型优先级 + 时长）/ 规范命名 / 下载 / 分辨率校验 / 转码。
// 注入 spawn + fs + probe 替身，全程不执行 yt-dlp/ffmpeg、不访问网络、不写磁盘。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  TrailerDownloader,
  runCommand,
  normalizeText,
  nameTokens,
  SEARCH_SUFFIX,
  SEARCH_LIMIT,
  TARGET_HEIGHT,
  DURATION_MIN,
  DURATION_MAX,
  PROXY_PROBE_URL,
  extractEnglishName,
} = require("../lib/trailer");
const { resolveProxy, toProxyUrl } = require("../lib/http");

/**
 * 构造 spawn 替身返回的假子进程。
 * @param {{stdout?: string, stderr?: string, code?: number}} [opts]
 * @returns {EventEmitter}
 */
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

/**
 * 构造 spawn 替身。
 * @param {object|Function} plan 固定返回值或 (cmd,args)=>opts
 * @param {Array} [calls] 记录调用
 * @returns {Function}
 */
function fakeSpawn(plan, calls) {
  return (cmd, args) => {
    if (calls) calls.push({ cmd, args });
    const opts = typeof plan === "function" ? plan(cmd, args) : plan;
    return makeChild(opts || {});
  };
}

/**
 * 构造 fs 替身。
 * @param {string[]} entries 目录内容
 * @returns {object}
 */
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

/**
 * 构造 MediaProbe 替身。
 * @param {{ok?: boolean, width?: number, height?: number, error?: string}} [res]
 * @returns {{probeSize: Function, calls: Array}}
 */
function fakeProbe(res) {
  const probe = {
    calls: [],
    async probeSize(file, opts) {
      probe.calls.push({ file, opts });
      if (!res) return { ok: false, error: "no-result" };
      return res;
    },
  };
  return probe;
}

/**
 * 便捷构造器。
 * env 默认注入空对象：不让测试结果被开发机上真实存在的 HTTP_PROXY 环境变量污染，
 * 需要验证代理行为的用例显式传 env。
 * @param {object} [opts] 选项
 * @returns {TrailerDownloader}
 */
function make(opts = {}) {
  return new TrailerDownloader({
    spawn: fakeSpawn(opts.plan || {}, opts.calls),
    fs: fakeFs(opts.entries || []),
    probe: opts.probe || null,
    ytDlpPath: opts.ytDlpPath,
    ffmpegPath: opts.ffmpegPath,
    env: opts.env || {},
    proxyUrl: opts.proxyUrl,
    retryGapMs: opts.retryGapMs === undefined ? 0 : opts.retryGapMs,
  });
}

// ───────────────────────── 纯函数：参数构造 ─────────────────────────

test("buildSearchArgs 构造规范要求的 ytsearch10 + --flat-playlist --dump-json", () => {
  const t = make();
  const args = t.buildSearchArgs("Elden Ring");
  assert.equal(args[0], "ytsearch" + SEARCH_LIMIT + ":Elden Ring " + SEARCH_SUFFIX);
  assert.equal(args[0], "ytsearch10:Elden Ring official launch trailer");
  assert.ok(args.includes("--flat-playlist"));
  assert.ok(args.includes("--dump-json"));
  assert.ok(args.includes("--skip-download"));
  assert.ok(args.includes("--no-warnings"));
  // 旧实现的 --dump-single-json / --no-playlist 已彻底移除（那是只能取 1 条的根源）
  assert.ok(!args.includes("--dump-single-json"));
});

test("buildSearchArgs 支持自定义条数与后缀，并 trim 游戏名", () => {
  const t = make();
  assert.equal(t.buildSearchArgs("  战神4  ")[0], "ytsearch10:战神4 " + SEARCH_SUFFIX);
  assert.equal(t.buildSearchArgs("战神4", { limit: 5 })[0], "ytsearch5:战神4 " + SEARCH_SUFFIX);
  assert.equal(t.buildSearchArgs("战神4", { limit: 0 })[0], "ytsearch10:战神4 " + SEARCH_SUFFIX);
  assert.equal(t.buildSearchArgs("战神4", { suffix: "" })[0], "ytsearch10:战神4");
  assert.equal(t.buildSearchArgs(null)[0], "ytsearch10: " + SEARCH_SUFFIX);
});

test("buildDownloadArgs 逐字对齐规范命令：优先 H.264/AAC（avc1+m4a），退化为任意 mp4/任意格式", () => {
  const t = make();
  const withFf = t.buildDownloadArgs("https://youtu.be/v1", "dir/out.mp4", { ffmpeg: true });
  assert.equal(withFf[0], "-f");
  assert.equal(
    withFf[1],
    "bestvideo[height<=1080][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]" +
      "/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]" +
      "/best[height<=1080]",
  );
  assert.equal(withFf[withFf.indexOf("--merge-output-format") + 1], "mp4");
  assert.equal(withFf[withFf.indexOf("-o") + 1], "dir/out.mp4");
  assert.equal(withFf[withFf.length - 1], "https://youtu.be/v1");
  assert.ok(withFf.includes("--newline"));
  assert.ok(withFf.includes("--no-part"));
  assert.equal(TARGET_HEIGHT, 1080);

  // 无 ffmpeg 无法合流，退到单文件流且不带 --merge-output-format
  const noFf = t.buildDownloadArgs("https://youtu.be/v1", "dir/out.mp4", { ffmpeg: false });
  assert.equal(noFf[1], "best[height<=1080]");
  assert.ok(!noFf.includes("--merge-output-format"));
});

test("buildSteamDownloadArgs 用通用 1080p 选择器（HLS/DASH 可用，不锁 avc1）", () => {
  const t = make();
  const args = t.buildSteamDownloadArgs(
    "https://store.steampowered.com/app/1154030/Titan_Quest_II/",
    "dir/out.mp4",
    { ffmpeg: true },
  );
  assert.equal(args[0], "-f");
  assert.equal(args[1], "bestvideo[height<=1080]+bestaudio/best[height<=1080]");
  assert.equal(args[args.length - 1], "https://store.steampowered.com/app/1154030/Titan_Quest_II/");
});

test("verifySteamAppId：真实游戏通过、非游戏/无效拒绝", async () => {
  const t = make({
    fetchFn: async (url) => ({
      ok: true,
      json: async () => ({ 1154030: { success: true, data: { type: "game" } } }),
    }),
  });
  assert.equal(await t.verifySteamAppId("1154030"), true);
  const bad = make({
    fetchFn: async () => ({ ok: true, json: async () => ({ 1: { success: false } }) }),
  });
  assert.equal(await bad.verifySteamAppId("1"), false);
});

test("resolveSteamAppId：商店搜索命中返回 appid，无结果返回空串", async () => {
  const t = make({
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ items: [{ type: "app", id: 1154030, name: "Titan Quest II" }] }),
    }),
  });
  assert.equal(await t.resolveSteamAppId("Titan Quest II"), "1154030");
  const none = make({ fetchFn: async () => ({ ok: true, json: async () => ({ items: [] }) }) });
  assert.equal(await none.resolveSteamAppId("不存在游戏xyz"), "");
});

test("ytDlpCmd / ffmpegCmd 优先用 env 解析出的绝对路径（Bug B 根因之一）", () => {
  const t = make();
  // 未注入时才退回命令名，交由上层 env 检查报错
  assert.equal(t.ytDlpCmd(), "yt-dlp");
  assert.equal(t.ffmpegCmd(), "ffmpeg");

  t.setBinaries({ ytDlpPath: "E:\\bin\\yt-dlp.exe", ffmpegPath: "E:\\bin\\ffmpeg.exe" });
  assert.equal(t.ytDlpCmd(), "E:\\bin\\yt-dlp.exe");
  assert.equal(t.ffmpegCmd(), "E:\\bin\\ffmpeg.exe");

  // 只传一个字段不影响另一个
  t.setBinaries({ ytDlpPath: null });
  assert.equal(t.ytDlpCmd(), "yt-dlp");
  assert.equal(t.ffmpegCmd(), "E:\\bin\\ffmpeg.exe");
});

// ───────────────────────── 纯函数：NDJSON 解析 ─────────────────────────

test("parseSearchResults 解析 --flat-playlist --dump-json 的 NDJSON 多行输出", () => {
  const t = make();
  const raw = [
    JSON.stringify({
      id: "v1",
      title: "A - Launch Trailer",
      channel: "PlayStation",
      duration: 120,
    }),
    JSON.stringify({ id: "v2", title: "B", webpage_url: "https://youtu.be/v2" }),
    "not json at all",
    JSON.stringify({ id: "v3" }),
  ].join("\n");
  const items = t.parseSearchResults(raw);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], {
    id: "v1",
    title: "A - Launch Trailer",
    url: "https://www.youtube.com/watch?v=v1",
    duration: 120,
    channel: "PlayStation",
    verified: false,
    thumb: "",
  });
  assert.equal(items[1].url, "https://youtu.be/v2");
  // 无 title 时以 id 兜底，duration 缺省 0
  assert.equal(items[2].title, "v3");
  assert.equal(items[2].duration, 0);
});

test("parseSearchResults 兼容 entries 形态 / 裸 id url / 非法输入", () => {
  const t = make();
  const withEntries = JSON.stringify({
    entries: [{ id: "e1", title: "E1" }, null, { title: "无 id" }],
  });
  const r1 = t.parseSearchResults(withEntries);
  assert.equal(r1.length, 1);
  assert.equal(r1[0].id, "e1");

  // flat-playlist 有时 url 只有视频 id，需补全成 watch 链接
  const r2 = t.parseSearchResults(JSON.stringify({ id: "v4", url: "v4" }));
  assert.equal(r2[0].url, "https://www.youtube.com/watch?v=v4");

  assert.deepEqual(t.parseSearchResults(""), []);
  assert.deepEqual(t.parseSearchResults(null), []);
  assert.deepEqual(t.parseSearchResults("garbage"), []);
  assert.deepEqual(t.parseSearchResults("{坏 JSON"), []);
});

test("normalizeEntry 识别认证频道并回退 uploader 字段", () => {
  const t = make();
  const e = t.normalizeEntry({
    id: "x",
    title: "T",
    uploader: "Bandai Namco",
    channel_is_verified: true,
  });
  assert.equal(e.channel, "Bandai Namco");
  assert.equal(e.verified, true);
  assert.equal(t.normalizeEntry(null), null);
  assert.equal(t.normalizeEntry({ title: "无 id" }), null);
});

test("normalizeText / nameTokens 归一化与分词", () => {
  assert.equal(
    normalizeText("ELDEN RING: Shadow of the Erdtree"),
    "elden ring shadow of the erdtree",
  );
  assert.equal(normalizeText(null), "");
  assert.deepEqual(nameTokens("Elden Ring"), ["elden", "ring"]);
  // 单字母词被丢弃，CJK 保留
  assert.deepEqual(nameTokens("战神4"), ["战神4"]);
  assert.deepEqual(nameTokens(""), []);
});

// ───────────────────────── 纯函数：规范打分筛选 ─────────────────────────

test("scoreTitleType 严格按 Launch > Official > Release Date > Announcement 排序", () => {
  const t = make();
  assert.equal(t.scoreTitleType("X - Launch Trailer").kind, "launch");
  // 「Official Launch Trailer」必须命中 launch 档，不能被 official 档截胡
  assert.equal(t.scoreTitleType("X - Official Launch Trailer").kind, "launch");
  assert.equal(t.scoreTitleType("X - Official Trailer").kind, "official");
  assert.equal(t.scoreTitleType("X - Release Date Trailer").kind, "release-date");
  assert.equal(t.scoreTitleType("X - Announcement Trailer").kind, "announcement");
  assert.equal(t.scoreTitleType("X 宣传片").kind, "trailer");
  assert.equal(t.scoreTitleType("随便一个视频").kind, "none");

  const launch = t.scoreTitleType("X - Launch Trailer").score;
  const release = t.scoreTitleType("X - Release Date Trailer").score;
  const announce = t.scoreTitleType("X - Announcement Trailer").score;
  assert.ok(launch > release && release > announce);
});

test("scoreChannel 按开发商 > 发行商 > 平台方 > 聚合号分档，二创号负分", () => {
  const t = make();
  // 显式传开发商 → 最高档
  assert.deepEqual(t.scoreChannel("FromSoftware", "Elden Ring", { developer: "FromSoftware" }), {
    score: 45,
    tier: "developer",
  });
  // 未传开发商时，发行商名单命中
  assert.equal(t.scoreChannel("FromSoftware", "Elden Ring").tier, "publisher");
  assert.equal(
    t.scoreChannel("Bandai Namco Entertainment America", "Elden Ring").tier,
    "publisher",
  );
  assert.equal(t.scoreChannel("PlayStation", "God of War").tier, "platform");
  assert.equal(t.scoreChannel("IGN", "Elden Ring").tier, "aggregator");
  assert.equal(t.scoreChannel("Elden Ring Reaction Guy", "Elden Ring").tier, "bad");
  assert.ok(t.scoreChannel("Elden Ring Reaction Guy", "Elden Ring").score < 0);
  assert.deepEqual(t.scoreChannel("", "Elden Ring"), { score: 0, tier: "unknown" });

  // 频道名含完整游戏名 → 视作该作官方频道
  assert.equal(t.scoreChannel("Elden Ring Official", "Elden Ring").tier, "developer");

  const dev = t.scoreChannel("FromSoftware", "x", { developer: "FromSoftware" }).score;
  const pub = t.scoreChannel("Capcom", "x").score;
  const plat = t.scoreChannel("Xbox", "x").score;
  const agg = t.scoreChannel("GameSpot", "x").score;
  assert.ok(dev > pub && pub > plat && plat > agg);
});

test("scoreDuration 60~300 秒加分，超长/过短扣分，未知时长中性", () => {
  const t = make();
  assert.equal(t.scoreDuration(DURATION_MIN), 20);
  assert.equal(t.scoreDuration(180), 20);
  assert.equal(t.scoreDuration(DURATION_MAX), 20);
  assert.equal(t.scoreDuration(45), 5);
  assert.ok(t.scoreDuration(500) < 0);
  assert.ok(t.scoreDuration(3600) < t.scoreDuration(500));
  // flat-playlist 常常不给时长，不能因此惩罚
  assert.equal(t.scoreDuration(0), 0);
  assert.equal(t.scoreDuration(null), 0);
  assert.equal(t.scoreDuration("abc"), 0);
});

test("scoreCandidate 综合打分：官方 Launch Trailer 远高于二创搬运", () => {
  const t = make();
  const official = t.scoreCandidate(
    {
      id: "a",
      title: "ELDEN RING - Official Launch Trailer",
      channel: "Bandai Namco Entertainment America",
      duration: 180,
    },
    "Elden Ring",
  );
  const reaction = t.scoreCandidate(
    {
      id: "b",
      title: "ELDEN RING Launch Trailer REACTION!!",
      channel: "Random Reaction Channel",
      duration: 900,
    },
    "Elden Ring",
  );
  assert.ok(official.score > reaction.score);
  assert.equal(official.kind, "launch");
  assert.equal(official.tier, "publisher");
  assert.ok(official.reasons.some((r) => r.includes("official")));
  assert.ok(reaction.score < 0);
  assert.ok(reaction.reasons.some((r) => r.includes("非正片")));

  // 标题完全不含游戏名 → 判定为搜索噪声，扣分
  const noise = t.scoreCandidate(
    { id: "c", title: "Some Other Game - Launch Trailer", channel: "Ubisoft", duration: 120 },
    "Elden Ring",
  );
  assert.ok(noise.reasons.some((r) => r.includes("不含游戏名")));
  assert.ok(noise.score < official.score);

  assert.equal(t.scoreCandidate(null, "x").score, -Infinity);
});

test("pickBest 选出评分最高者，同分保持 yt-dlp 原始相关度序", () => {
  const t = make();
  const items = [
    { id: "c", title: "ELDEN RING - Announcement Trailer", channel: "IGN", duration: 90 },
    {
      id: "a",
      title: "ELDEN RING - Official Launch Trailer",
      channel: "Bandai Namco Entertainment America",
      duration: 180,
    },
    {
      id: "b",
      title: "ELDEN RING Launch Trailer REACTION!!",
      channel: "Random Reaction Channel",
      duration: 900,
    },
  ];
  const best = t.pickBest(items, "Elden Ring");
  assert.equal(best.id, "a");
  assert.equal(best.kind, "launch");
  assert.equal(best.tier, "publisher");
  assert.ok(Number.isFinite(best.score));
  assert.ok(Array.isArray(best.reasons));

  // 同分稳定：两条完全一致时取靠前的
  const tie = [
    { id: "first", title: "ELDEN RING - Launch Trailer", channel: "Capcom", duration: 120 },
    { id: "second", title: "ELDEN RING - Launch Trailer", channel: "Capcom", duration: 120 },
  ];
  assert.equal(t.pickBest(tie, "Elden Ring").id, "first");

  assert.equal(t.pickBest([], "x"), null);
  assert.equal(t.pickBest(null, "x"), null);
  // 全是负分候选 → minScore 默认 0，判定无可用
  assert.equal(t.pickBest([items[2]], "Elden Ring"), null);
  // 放宽 minScore 后可取
  assert.ok(t.pickBest([items[2]], "Elden Ring", { minScore: -999 }) != null);
});

test("pickBest 传入 developer 时优先开发商官方频道", () => {
  const t = make();
  const items = [
    {
      id: "pub",
      title: "ELDEN RING - Launch Trailer",
      channel: "Bandai Namco Entertainment America",
      duration: 120,
    },
    { id: "dev", title: "ELDEN RING - Launch Trailer", channel: "FromSoftware", duration: 120 },
  ];
  assert.equal(t.pickBest(items, "Elden Ring", { developer: "FromSoftware" }).id, "dev");
  // 不传开发商时两者同为 publisher 档，退回原始序
  assert.equal(t.pickBest(items, "Elden Ring").id, "pub");
});

// ───────────────────────── 纯函数：命名 / 文件定位 / 转码判定 ─────────────────────────

test("buildTargetName 按规范《视频命名规范》生成文件名", () => {
  const t = make();
  assert.equal(
    t.buildTargetName("忍者龙剑传4", { index: 267, englishName: "The Two Masters" }),
    "【游戏267】忍者龙剑传4 The Two Masters Launch Trailer 免费学习版下载.mp4",
  );
  // 无英文名时省略该段
  assert.equal(
    t.buildTargetName("光环：战役进化", { index: 264 }),
    "【游戏264】光环：战役进化 Launch Trailer 免费学习版下载.mp4",
  );
  // kind='main' 走主视频命名
  assert.equal(
    t.buildTargetName("模拟人生4", { index: 265, kind: "main" }),
    "【游戏265】模拟人生4 官方中文+全DLC+免安装硬盘版 免费学习版下载.mp4",
  );
  assert.equal(
    t.buildTargetName("模拟人生4", { index: 265, kind: "main", versionDesc: "中文豪华版" }),
    "【游戏265】模拟人生4 中文豪华版 免费学习版下载.mp4",
  );
});

test("needsTranscode 只对 .webm 为真", () => {
  const t = make();
  assert.equal(t.needsTranscode("a.webm"), true);
  assert.equal(t.needsTranscode("A.WEBM"), true);
  assert.equal(t.needsTranscode("dir/a.webm"), true);
  assert.equal(t.needsTranscode("a.mp4"), false);
  assert.equal(t.needsTranscode("a.mkv"), false);
  assert.equal(t.needsTranscode(""), false);
  assert.equal(t.needsTranscode(null), false);
});

test("buildTranscodeArgs 严格对齐规则命令", () => {
  const t = make();
  assert.deepEqual(t.buildTranscodeArgs("in.webm", "out.mp4"), [
    "-y",
    "-i",
    "in.webm",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "out.mp4",
  ]);
});

test("findDownloaded 按基名匹配、优先 mp4、忽略中间产物", () => {
  assert.equal(
    make({ entries: ["base.webm", "base.mp4", "other.mp4"] }).findDownloaded("dir", "base"),
    "base.mp4",
  );
  assert.equal(make({ entries: ["base.webm"] }).findDownloaded("dir", "base"), "base.webm");
  assert.equal(
    make({ entries: ["base.mp4.part", "base.ytdl"] }).findDownloaded("dir", "base"),
    null,
  );
  assert.equal(make({ entries: [] }).findDownloaded("dir", "base"), null);
});

// ───────────────────────── runCommand ─────────────────────────

test("runCommand 逐行回调 stdout/stderr 并返回退出码", async () => {
  const lines = [];
  const r = await runCommand("yt-dlp", ["--version"], {
    spawn: fakeSpawn({ stdout: "line1\nline2\n", stderr: "warn1\n", code: 0 }),
    onLine: (line, stream) => lines.push(stream + ":" + line),
    timeout: 5000,
  });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("line1"));
  assert.deepEqual(lines, ["stdout:line1", "stdout:line2", "stderr:warn1"]);
});

// ───────────────────────── 带 IO 的流程 ─────────────────────────

test("searchTrailer 用注入的 yt-dlp 绝对路径执行，命中后发 trailer_search 事件", async () => {
  const events = [];
  const calls = [];
  const stdout = [
    JSON.stringify({ id: "noise", title: "路人试玩实况", channel: "某某解说", duration: 3600 }),
    JSON.stringify({
      id: "v1",
      title: "ELDEN RING - Official Launch Trailer",
      channel: "Bandai Namco Entertainment America",
      duration: 180,
    }),
  ].join("\n");
  const t = make({ plan: { stdout }, calls, ytDlpPath: "E:\\bin\\yt-dlp.exe" });

  const info = await t.searchTrailer("Elden Ring", {
    emit: (type, step, msg, ok, detail) => events.push({ type, msg, detail }),
  });
  assert.equal(info.id, "v1");
  assert.equal(info.tier, "publisher");
  assert.equal(calls[0].cmd, "E:\\bin\\yt-dlp.exe");
  assert.ok(calls[0].args[0].startsWith("ytsearch10:Elden Ring"));
  const hit = events.find((e) => e.type === "trailer_search" && e.detail && e.detail.url);
  assert.ok(hit);
  assert.equal(hit.detail.total, 2);
  assert.equal(hit.detail.kind, "launch");
});

test("searchTrailer 无候选 / 候选全不达标 / 命令异常均安全返回 null", async () => {
  assert.equal(await make({ plan: { stdout: "garbage" } }).searchTrailer("查无此游戏"), null);

  const events = [];
  const onlyBad = JSON.stringify({
    id: "b",
    title: "ELDEN RING Launch Trailer REACTION!!",
    channel: "Reaction Guy",
    duration: 900,
  });
  const r = await make({ plan: { stdout: onlyBad } }).searchTrailer("Elden Ring", {
    emit: (type, step, msg) => events.push({ type, msg }),
  });
  assert.equal(r, null);
  assert.ok(events.some((e) => e.msg.includes("筛选标准")));

  const boom = new TrailerDownloader({
    spawn: () => {
      throw new Error("ENOENT");
    },
    fs: fakeFs([]),
  });
  assert.equal(await boom.searchTrailer("x"), null);
});

test("download 用原始视频标题落盘，并用 ffprobe 校验实际分辨率", async () => {
  const calls = [];
  const events = [];
  const target = "NINJA GAIDEN 4 - Launch Trailer.mp4";
  const probe = fakeProbe({ ok: true, width: 1920, height: 1080 });
  const t = new TrailerDownloader({
    spawn: fakeSpawn({ code: 0 }, calls),
    fs: fakeFs([target]),
    probe,
    ytDlpPath: "E:\\bin\\yt-dlp.exe",
  });

  const r = await t.download(
    "忍者龙剑传4",
    "E:\\素材\\【游戏267】忍者龙剑传4",
    { ytDlp: true, ffmpeg: true },
    {
      info: {
        id: "v1",
        title: "NINJA GAIDEN 4 - Launch Trailer",
        url: "https://youtu.be/v1",
        channel: "Koei Tecmo",
      },
      emit: (type, step, msg, ok, detail) => events.push({ type, msg, detail }),
    },
  );

  assert.equal(r.ok, true);
  assert.equal(r.file, target);
  assert.equal(r.width, 1920);
  assert.equal(r.height, 1080);
  assert.equal(r.hd, true);
  assert.equal(r.channel, "Koei Tecmo");
  // 输出路径 = 原始视频标题（不再套【游戏NNN】…免费学习版下载 规范命名）
  const outArg = calls[0].args[calls[0].args.indexOf("-o") + 1];
  assert.equal(outArg, path.join("E:\\素材\\【游戏267】忍者龙剑传4", target));
  assert.equal(probe.calls.length, 1);
  assert.ok(events.some((e) => e.type === "trailer_probe" && e.detail.hd === true));
});

test("download 在 yt-dlp 缺失时直接失败，不 spawn", async () => {
  const calls = [];
  const t = make({ calls });
  const r = await t.download("x", "dir", { ytDlp: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "yt-dlp-not-found");
  assert.equal(calls.length, 0);
});

test("download 未搜到符合规范的宣传片时返回 trailer-not-found", async () => {
  const t = make({ plan: { stdout: "garbage" } });
  const r = await t.download("查无此游戏", "dir", { ytDlp: true, ffmpeg: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "trailer-not-found");
});

test("download 区分 yt-dlp 失败与产出文件缺失", async () => {
  const fail = make({ plan: { code: 1 }, entries: [] });
  const r1 = await fail.download(
    "x",
    "dir",
    { ytDlp: true, ffmpeg: true },
    { info: { id: "v", title: "T", url: "u" } },
  );
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, "yt-dlp-failed");

  const missing = make({ plan: { code: 0 }, entries: [] });
  const r2 = await missing.download(
    "x",
    "dir",
    { ytDlp: true, ffmpeg: true },
    { info: { id: "v", title: "T", url: "u" } },
  );
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "trailer-file-missing");
});

test("download 首候选失败自动换下一个候选（年龄限制/下载错误不再直接判死）", async () => {
  const calls = [];
  const target = "B - Official Trailer.mp4";
  const entries = []; // 初始为空：候选失败不产生文件，候选成功才"落盘"
  const t = new TrailerDownloader({
    spawn: fakeSpawn((cmd, args) => {
      const isV1 = args[args.length - 1].indexOf("v1") >= 0;
      if (!isV1) entries.push(target); // 第二个候选（v2）下载成功
      return isV1 ? { code: 1 } : { code: 0 };
    }, calls),
    fs: fakeFs(entries),
    probe: fakeProbe({ ok: true, width: 1920, height: 1080 }),
    ytDlpPath: "E:\\bin\\yt-dlp.exe",
  });
  const r = await t.download(
    "正当防卫4",
    "E:\\素材\\【游戏268】正当防卫4",
    { ytDlp: true, ffmpeg: true },
    {
      candidates: [
        {
          id: "v1",
          title: "A - Launch Trailer",
          url: "https://youtu.be/v1",
          channel: "XBOX",
          score: 125,
        },
        {
          id: "v2",
          title: "B - Official Trailer",
          url: "https://youtu.be/v2",
          channel: "Publisher",
          score: 100,
        },
      ],
      index: 268,
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://youtu.be/v2");
  assert.equal(r.attempts, 2);
  assert.equal(calls.length, 5); // v1 三档格式尝试 + v2 下载 + 1 次 ffprobe 探测
  assert.equal(calls[0].args[calls[0].args.length - 1], "https://youtu.be/v1");
  assert.equal(calls[1].args[calls[1].args.length - 1], "https://youtu.be/v1");
  assert.equal(calls[2].args[calls[2].args.length - 1], "https://youtu.be/v1");
  assert.equal(calls[3].args[calls[3].args.length - 1], "https://youtu.be/v2");
});

test("download 同一候选 403 限流时按格式档降级重试，不直接放弃（YouTube 137 流限流）", async () => {
  const calls = [];
  const entries = [];
  const t = new TrailerDownloader({
    spawn: fakeSpawn((cmd, args) => {
      const f = args[args.indexOf("-f") + 1];
      if (f.indexOf("avc1") >= 0) return { code: 1 }; // 第一档 avc1 被限流
      entries.push("A - Launch Trailer.mp4"); // 第二档任意 mp4 成功
      return { code: 0 };
    }, calls),
    fs: fakeFs(entries),
    probe: fakeProbe({ ok: true, width: 1920, height: 1080 }),
    ytDlpPath: "E:\\bin\\yt-dlp.exe",
  });
  const r = await t.download(
    "泰坦之旅2",
    "dir",
    { ytDlp: true, ffmpeg: true },
    {
      candidates: [
        {
          id: "v1",
          title: "A - Launch Trailer",
          url: "https://youtu.be/v1",
          channel: "THQ Nordic",
          score: 125,
        },
      ],
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://youtu.be/v1");
  assert.equal(calls.length, 3); // 档1 失败 + 档2 成功 + ffprobe 探测
  assert.equal(calls[0].args[calls[0].args.indexOf("-f") + 1].indexOf("avc1") >= 0, true);
});

test("download 失败时清理 yt-dlp 残留半成品（.fNNN），避免多视频落盘", async () => {
  const entries = ["A - Launch Trailer.f299.mp4"]; // 候选下载失败（403 中断）残留的半成品
  const t = new TrailerDownloader({
    spawn: fakeSpawn({ code: 1 }, []),
    fs: fakeFs(entries),
    probe: fakeProbe({ ok: true, width: 1920, height: 1080 }),
    ytDlpPath: "E:\\bin\\yt-dlp.exe",
  });
  const r = await t.download(
    "x",
    "dir",
    { ytDlp: true, ffmpeg: true },
    {
      candidates: [
        {
          id: "v1",
          title: "A - Launch Trailer",
          url: "https://youtu.be/v1",
          channel: "XBOX",
          score: 100,
        },
      ],
      index: 1,
    },
  );
  assert.equal(r.ok, false);
  assert.ok(t.fs.unlinked.length >= 1, "残留半成品必须在尝试后清理");
  assert.ok(t.fs.unlinked[0].includes("A - Launch Trailer.f299.mp4"), "半成品必须被清理");
});

test("download 全部候选失败返回最后错误，且尝试次数封顶", async () => {
  const calls = [];
  const t = new TrailerDownloader({
    spawn: fakeSpawn({ code: 1 }, calls),
    fs: fakeFs([]),
    ytDlpPath: "E:\\bin\\yt-dlp.exe",
  });
  const cands = [];
  for (let i = 1; i <= 8; i += 1)
    cands.push({ id: "v" + i, title: "T" + i, url: "https://youtu.be/v" + i });
  const r = await t.download(
    "正当防卫4",
    "dir",
    { ytDlp: true, ffmpeg: true },
    { candidates: cands, index: 268 },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "yt-dlp-failed");
  assert.ok(r.error.includes("退出码 1"));
  assert.equal(calls.length, 15); // 5 个候选 × 3 档格式（TRAILER_DOWNLOAD_ATTEMPTS 封顶）
});

test("searchTrailerCandidates 返回完整排序候选列表，searchTrailer 取第一条", async () => {
  const out =
    JSON.stringify({
      id: "v1",
      title: "Just Cause 4 - Release Date Trailer",
      url: "https://youtu.be/v1",
      channel: "Square Enix",
      duration: 120,
    }) +
    "\n" +
    JSON.stringify({
      id: "v2",
      title: "Just Cause 4 - Launch Trailer",
      url: "https://youtu.be/v2",
      channel: "Square Enix",
      duration: 120,
    });
  const t = make({ plan: { stdout: out, code: 0 } });
  const list = await t.searchTrailerCandidates("Just Cause 4", {});
  assert.equal(list.length, 2);
  assert.equal(list[0].url, "https://youtu.be/v2");
  assert.equal(list[1].url, "https://youtu.be/v1");
  const best = await t.searchTrailer("Just Cause 4", {});
  assert.equal(best.url, "https://youtu.be/v2");
});

test("buildOutputName：优先原始标题，无标题退回规范命名", () => {
  const t = make();
  assert.equal(
    t.buildOutputName({ title: "Warhammer 40,000: Space Marine 2 - Launch Trailer" }, "正当防卫4", {
      index: 268,
    }),
    "Warhammer 40,000_ Space Marine 2 - Launch Trailer.mp4",
  );
  assert.equal(
    t.buildOutputName({}, "正当防卫4", { index: 268 }),
    "【游戏268】正当防卫4 Launch Trailer 免费学习版下载.mp4",
  );
});

test("probeResolution 未注入 probe 或 ffprobe 失败时不阻断下载结果", async () => {
  const noProbe = make({ entries: [] });
  const r1 = await noProbe.probeResolution("a.mp4");
  assert.equal(r1.ok, false);
  assert.ok(r1.error.includes("MediaProbe"));

  const bad = make({ probe: fakeProbe({ ok: false, error: "ffprobe-not-found" }) });
  const r2 = await bad.probeResolution("a.mp4");
  assert.equal(r2.ok, false);
  assert.equal(r2.error, "ffprobe-not-found");

  // 即便校验失败，download 仍应判成功（视频已落盘）
  const target = "T.mp4";
  const t = new TrailerDownloader({
    spawn: fakeSpawn({ code: 0 }),
    fs: fakeFs([target]),
    probe: fakeProbe({ ok: false, error: "boom" }),
  });
  const r3 = await t.download(
    "x",
    "dir",
    { ytDlp: true, ffmpeg: true },
    {
      info: { id: "v", title: "T", url: "u" },
    },
  );
  assert.equal(r3.ok, true);
  assert.equal(r3.width, undefined);
});

test("probeResolution 对低于 1080p 的视频标记未达标", async () => {
  const events = [];
  const t = make({ probe: fakeProbe({ ok: true, width: 1280, height: 720 }) });
  const r = await t.probeResolution("a.mp4", {
    emit: (type, step, msg, ok, detail) => events.push({ type, ok, detail }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.height, 720);
  const ev = events.find((e) => e.type === "trailer_probe");
  assert.equal(ev.detail.hd, false);
  assert.equal(ev.ok, null);
});

test("transcodeIfNeeded：mp4 直接跳过；webm + ffmpeg 转码并删原文件", async () => {
  const t1 = make();
  assert.deepEqual(await t1.transcodeIfNeeded("a.mp4", "dir", { ffmpeg: true }), {
    file: "a.mp4",
    converted: false,
  });

  const calls = [];
  const events = [];
  const t2 = new TrailerDownloader({
    spawn: fakeSpawn({ code: 0 }, calls),
    fs: fakeFs([]),
    ffmpegPath: "E:\\bin\\ffmpeg.exe",
  });
  const r2 = await t2.transcodeIfNeeded(
    "a.webm",
    "dir",
    { ffmpeg: true },
    {
      emit: (type, step, msg, ok) => events.push({ type, ok }),
    },
  );
  assert.equal(r2.file, "a.mp4");
  assert.equal(r2.converted, true);
  assert.equal(calls[0].cmd, "E:\\bin\\ffmpeg.exe");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-y", "-i"]);
  assert.equal(t2.fs.unlinked.length, 1);
  assert.ok(events.some((e) => e.type === "trailer_transcode" && e.ok === true));
});

test("transcodeIfNeeded：ffmpeg 缺失或失败时保留 .webm，不抛异常", async () => {
  const r1 = await make().transcodeIfNeeded("a.webm", "dir", { ffmpeg: false });
  assert.equal(r1.file, "a.webm");
  assert.equal(r1.converted, false);
  assert.equal(r1.reason, "ffmpeg-not-found");

  const t2 = make({ plan: { code: 1 } });
  const r2 = await t2.transcodeIfNeeded("a.webm", "dir", { ffmpeg: true });
  assert.equal(r2.file, "a.webm");
  assert.equal(r2.converted, false);
  assert.equal(r2.reason, "ffmpeg-failed");
  assert.equal(t2.fs.unlinked.length, 0);
});

// ───────────────────────── 缺陷 2：yt-dlp 子进程代理 ─────────────────────────
// 全程不访问网络，也不真正 spawn yt-dlp；只用注入的 env / proxyUrl 验证「参数是否带上 --proxy」。

/** 开发机真实的代理环境（缺陷 2 复现用）。 */
const PROXY_ENV = {
  HTTP_PROXY: "http://127.0.0.1:7990/",
  HTTPS_PROXY: "http://127.0.0.1:7990/",
  NO_PROXY: "localhost,127.0.0.1,::1",
};

test("resolveProxyUrl 检测到 HTTPS_PROXY 时返回代理地址（缺陷 2 根因修复）", () => {
  const t = make({ env: PROXY_ENV });
  assert.equal(t.resolveProxyUrl(), "http://127.0.0.1:7990");
  // 与 lib/http.js 的解析口径一致
  assert.equal(t.resolveProxyUrl(), toProxyUrl(resolveProxy(PROXY_PROBE_URL, PROXY_ENV)));
});

test("resolveProxyUrl 无代理环境时返回空串（直连）", () => {
  assert.equal(make({ env: {} }).resolveProxyUrl(), "");
  assert.equal(make({ env: { NO_PROXY: "*" } }).resolveProxyUrl(), "");
});

test("resolveProxyUrl 大小写变体都识别（https_proxy / Http_Proxy 等）", () => {
  assert.equal(
    make({ env: { https_proxy: "http://127.0.0.1:7990/" } }).resolveProxyUrl(),
    "http://127.0.0.1:7990",
  );
  assert.equal(
    make({ env: { HTTPS_PROXY: "http://10.0.0.1:8080" } }).resolveProxyUrl(),
    "http://10.0.0.1:8080",
  );
});

test("resolveProxyUrl proxyUrl 显式注入优先于环境变量", () => {
  const t = make({ env: PROXY_ENV, proxyUrl: "http://explicit:9999" });
  assert.equal(t.resolveProxyUrl(), "http://explicit:9999");
  // 空串表示强制直连
  assert.equal(make({ env: PROXY_ENV, proxyUrl: "" }).resolveProxyUrl(), "");
});

test("resolveProxyUrl 尊重 NO_PROXY：* 与 localhost 均绕过代理", () => {
  assert.equal(
    make({ env: { HTTPS_PROXY: "http://127.0.0.1:7990/", NO_PROXY: "*" } }).resolveProxyUrl(),
    "",
  );
  // 探测目标本就是 youtube.com，NO_PROXY 里没有它，所以仍走代理
  assert.equal(make({ env: PROXY_ENV }).resolveProxyUrl(), "http://127.0.0.1:7990");
  // 换一个命中 NO_PROXY 的目标（如 127.0.0.1）则直连
  assert.equal(make({ env: PROXY_ENV }).resolveProxyUrl("http://127.0.0.1:8080/health"), "");
});

test("withProxyArgs 检测到代理时前置 --proxy <url>", () => {
  const t = make({ env: PROXY_ENV });
  const out = t.withProxyArgs(["ytsearch10:x", "--flat-playlist"]);
  assert.deepEqual(out, ["--proxy", "http://127.0.0.1:7990", "ytsearch10:x", "--flat-playlist"]);
});

test("withProxyArgs 无代理时原样返回（不改顺序、不抛）", () => {
  const base = ["ytsearch10:x", "--flat-playlist"];
  const out = make({ env: {} }).withProxyArgs(base);
  assert.deepEqual(out, base);
});

test("withProxyArgs 不修改入参、不重复加 --proxy", () => {
  const base = ["a", "b"];
  const t = make({ env: PROXY_ENV });
  const out = t.withProxyArgs(base);
  // 入参未被修改
  assert.deepEqual(base, ["a", "b"]);
  assert.equal(out.indexOf("--proxy"), 0);
  // 已经带 --proxy 时不重复加
  assert.deepEqual(t.withProxyArgs(["--proxy", "http://x", "a"]), ["--proxy", "http://x", "a"]);
  // 入参为 null/undefined 也不崩
  assert.deepEqual(t.withProxyArgs(null), ["--proxy", "http://127.0.0.1:7990"]);
  assert.deepEqual(make({ env: {} }).withProxyArgs(undefined), []);
});

test("buildSearchArgs / buildDownloadArgs 本身不带 --proxy（保持纯净，由 withProxyArgs 叠加）", () => {
  const t = make({ env: PROXY_ENV });
  assert.ok(!t.buildSearchArgs("Elden Ring").includes("--proxy"));
  assert.ok(
    !t.buildDownloadArgs("https://youtu.be/v", "dir/out.mp4", { ffmpeg: true }).includes("--proxy"),
  );
});

test("searchTrailer 集成：检测到代理时把 --proxy 前置传给 yt-dlp 子进程", async () => {
  const calls = [];
  const stdout = JSON.stringify({
    id: "v1",
    title: "ELDEN RING - Official Launch Trailer",
    channel: "Bandai Namco",
    duration: 180,
  });
  const t = make({ plan: { stdout }, calls, env: PROXY_ENV, ytDlpPath: "E:\\bin\\yt-dlp.exe" });
  await t.searchTrailer("Elden Ring");
  assert.equal(calls.length, 1); // searchTrailer 只发 1 次检索，无 normalize
  const args = calls[0].args;
  assert.equal(args[0], "--proxy");
  assert.equal(args[1], "http://127.0.0.1:7990");
  assert.ok(args[2].startsWith("ytsearch10:Elden Ring"));
});

test("download 集成：下载参数也前置 --proxy，且 -o / -f / URL 顺序不受影响", async () => {
  const calls = [];
  const target = "T.mp4";
  const t = new TrailerDownloader({
    spawn: fakeSpawn({ code: 0 }, calls),
    fs: fakeFs([target]),
    env: PROXY_ENV,
    ytDlpPath: "E:\\bin\\yt-dlp.exe",
  });
  await t.download(
    "x",
    "dir",
    { ytDlp: true, ffmpeg: true },
    {
      info: { id: "v", title: "T", url: "https://youtu.be/v", channel: "Koei Tecmo" },
    },
  );
  assert.equal(calls.length, 2); // 1 次下载 + 1 次 normalizeToH264 的 ffprobe 探测
  const args = calls[0].args;
  assert.equal(args[0], "--proxy");
  assert.equal(args[1], "http://127.0.0.1:7990");
  // 原有下载语义不变
  assert.equal(args[args.indexOf("-o") + 1], path.join("dir", target));
  assert.ok(args.includes("-f"));
  assert.equal(args[args.length - 1], "https://youtu.be/v");
});

test("无代理环境时 searchTrailer / download 都不带 --proxy", async () => {
  const calls = [];
  const stdout = JSON.stringify({ id: "v1", title: "T", channel: "C", duration: 180 });
  const t = make({ plan: { stdout }, calls, env: {} });
  await t.searchTrailer("Elden Ring");
  assert.ok(!calls[0].args.includes("--proxy"));
});

// ── extractEnglishName ──
test('extractEnglishName: 标准 YouTube 标题 "Just Cause 4 - Launch Trailer | PS4"', () => {
  assert.equal(extractEnglishName("Just Cause 4 - Launch Trailer | PS4"), "Just Cause 4");
});
test('extractEnglishName: "Elden Ring - Official Launch Trailer"', () => {
  assert.equal(extractEnglishName("Elden Ring - Official Launch Trailer"), "Elden Ring");
});
test('extractEnglishName: "Nioh 2 - The Complete Edition | Launch Trailer"（游戏名含 " - " 子标题，只能提取到 "Nioh 2"）', () => {
  // 客观限制：无法区分游戏名内部的 " - " 与 YouTube 标题的 " - " 分隔符。
  // "Nioh 2" 虽漏了子标题，但仍比什么都不做强——至少能命中英文章。
  assert.equal(extractEnglishName("Nioh 2 - The Complete Edition | Launch Trailer"), "Nioh 2");
});
test("extractEnglishName: 纯中文标题返回 null", () => {
  assert.equal(extractEnglishName("仁王2 Complete Edition - Launch Trailer"), null);
});
test('extractEnglishName: 无 " - " 分隔符返回 null', () => {
  assert.equal(extractEnglishName("Just Cause 4 Launch Trailer"), null);
});
test("extractEnglishName: 空字符串返回 null", () => {
  assert.equal(extractEnglishName(""), null);
});
test("extractEnglishName: null 返回 null", () => {
  assert.equal(extractEnglishName(null), null);
});
test("extractEnglishName: undefined 返回 null", () => {
  assert.equal(extractEnglishName(undefined), null);
});
test("extractEnglishName: 只有两个字母的英文名也提取", () => {
  assert.equal(extractEnglishName("Go - Launch Trailer"), "Go");
});
test('extractEnglishName: 标题只有 " - " 前面是空白', () => {
  assert.equal(extractEnglishName(" - Launch Trailer"), null);
});
