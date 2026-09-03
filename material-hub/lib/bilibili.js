// lib/bilibili.js —— B站视频下载（贴链接 → 拉满画质下载 → 转 mp4 容器 → 分辨率校验）
//
// 复用 TrailerDownloader 的底座：ytDlpCmd / ffmpegCmd / withProxyArgs / resolveProxyUrl /
// normalizeToH264 / probeResolution / findDownloaded / cleanupTrailerArtifacts / runCommand。
// B站是 yt-dlp 原生支持的站点（BV/AV/EP/SS/合集/空间链接均可用），无需新依赖；
// 仅补 B站专属的清晰度选择，以及「拉满画质 = 不重编码（仅流拷贝换容器）」的收尾逻辑。
//
// 与 trailer.js 的差异：
//   · trailer 面向 YouTube 官方宣传片（1080p H.264/AAC 规范，失败自动格式降级 + 重编码保底）；
//   · bilibili 面向用户贴的任意视频，用户明确要「拉满画质」，故下载后尽量零损失：
//     已是 mp4 容器则原样保留（AV1/HEVC 也保留，仅打兼容性提示），非 mp4 才流拷贝转 mp4，
//     只有流拷贝不被 ffmpeg 支持时才回退重编码为 H.264/AAC（兼容性兜底，非默认路径）。
const fs = require("fs");
const path = require("path");
const { TrailerDownloader } = require("./trailer");
const { runCommand } = require("./runner");
const { resolveCookieFile, getLoginInfo } = require("./biliCookies");

/** B站链接识别（含短链 b23.tv / 播放器域名）。 */
function isBiliUrl(url) {
  const u = String(url || "").trim().toLowerCase();
  return (
    u.includes("bilibili.com") ||
    u.includes("b23.tv") ||
    u.includes("player.bilibili.com")
  );
}

/** 分辨率档位显示名：2160→4K，其余用 N P。 */
function resolutionLabel(height, fps) {
  const h = Number(height) || 0;
  const base = h >= 2160 ? "4K" : h >= 1440 ? "2K" : h + "P";
  const f = Number(fps) || 0;
  return f > 30 ? base + " " + Math.round(f) + "fps" : base;
}

/** yt-dlp 的 vcodec 串（avc1.640032 / hvc1… / av01…）映射成用户看得懂的编码名。 */
function codecLabel(vcodec) {
  const v = String(vcodec || "").toLowerCase();
  // yt-dlp 用 avc1.*/hvc1.*/av01.*，ffprobe 用 h264/hevc/av1 —— 两种命名都要认。
  if (v.startsWith("avc") || v === "h264") return "H.264";
  if (v.startsWith("hev") || v.startsWith("hvc") || v === "h265") return "HEVC";
  if (v.startsWith("av01") || v === "av1") return "AV1";
  if (v.startsWith("vp9")) return "VP9";
  if (v.startsWith("vp8")) return "VP8";
  return v || "未知";
}

/**
 * 按 quality 选项构造 yt-dlp 格式选择器。
 * @param {string|number} quality 'best'（默认拉满）/ 数字（限高，如 1080 / 720）
 * @param {boolean} hasFfmpeg 是否有 ffmpeg（无则无法合流，退到单文件流）
 * @param {string} [formatId] 用户在画质下拉框里指定的档位 format_id（最高优先）；
 *   形如 "30120"。B站 每个分辨率同时提供 H.264/HEVC/AV1 多条流，format_id 可精确定位。
 * @returns {{format: string, extra: string[]}}
 */
function buildFormat(quality, hasFfmpeg, formatId) {
  const merge = hasFfmpeg ? ["--merge-output-format", "mp4"] : [];
  // 指定档位：该视频流 + 最佳音频；若这条流本身已含音轨（+ba 无法匹配），退到单流，再退到自动。
  const fid = String(formatId == null ? "" : formatId).trim();
  if (fid && /^\d+$/.test(fid)) {
    return { format: fid + "+ba/" + fid + "/bv*+ba/b", extra: merge };
  }
  const q = String(quality == null ? "" : quality).trim();
  if (q === "" || q === "best") {
    return { format: "bv*+ba/b", extra: merge };
  }
  const h = Number(q);
  if (Number.isFinite(h) && h > 0) {
    // 默认档位：优先「正好 h 高度且 H.264」（免转码）→ 同高度任意编码 → ≤h 的 H.264 → ≤h 任意，
    // 保证目标高度优先、其次才向下兼容；兜底 b 防纯 DASH 无视频时仍能出片。
    return {
      format:
        `bv*[height=${h}][vcodec~='^(avc1|h264)']+ba/` +
        `bv*[height=${h}]+ba/` +
        `bv*[height<=${h}][vcodec~='^(avc1|h264)']+ba/` +
        `bv*[height<=${h}]+ba/b`,
      extra: merge,
    };
  }
  return { format: "bv*+ba/b", extra: merge };
}

class BiliDownloader extends TrailerDownloader {
  /**
   * @param {object} [deps] 同 TrailerDownloader；额外支持 cookieFile
   * @param {string} [deps.cookieFile] Netscape 格式 cookie 文件路径（支持高画质/大会员）；
   *   缺省读 process.env.BILI_COOKIES，再退到 material-hub/.bili-cookies.txt（已 gitignore）。
   */
  constructor(deps = {}) {
    super(deps);
    this.cookieFile =
      deps.cookieFile ||
      process.env.BILI_COOKIES ||
      path.join(__dirname, ".bili-cookies.txt");
  }

  /**
   * 解析本次要用的 cookie 文件（登录态是 B站 解析/下载的前置条件，未登录会 412）。
   * 优先用户显式指定（构造参数 / BILI_COOKIES / .bili-cookies.txt），否则复用 biliup-hub 登录态。
   * @returns {string} 文件路径；无登录态返回空串
   */
  resolveCookie() {
    if (this.cookieFile && fs.existsSync(this.cookieFile)) return this.cookieFile;
    try {
      const r = resolveCookieFile();
      return r && r.file ? r.file : "";
    } catch (e) {
      return "";
    }
  }

  /**
   * 构造 B站下载参数（拉满画质：best video + best audio，合流为 mp4 容器）。
   * @param {string} url 视频页地址
   * @param {string} outPath 输出模板（含 %(ext)s）
   * @param {{ffmpeg?: boolean}} [env] 外部依赖可用性
   * @param {{quality?: string|number, formatId?: string}} [opts]
   * @returns {string[]}
   */
  buildBiliDownloadArgs(url, outPath, env = {}, opts = {}) {
    const hasFfmpeg = env.ffmpeg !== false;
    const { format, extra } = buildFormat(opts.quality, hasFfmpeg, opts.formatId);
    const args = ["-f", format];
    if (extra.length) args.push(...extra);
    // --no-playlist：B站 多P(分集)视为播放列表，不加则会把整集全拉下来且同名互相覆盖；
    // 只下链接对应的那一个 P（URL 带 ?p=N 即指定分集，不带默认 P1）。
    args.push("--no-warnings", "--newline", "--no-part", "--no-playlist");
    args.push("--retries", "3", "--fragment-retries", "3", "--retry-sleep", "2");
    // 登录 cookie：B站 对未登录请求直接 412（连页面都拿不到），因此这是必需项而非可选项。
    const cookieFile = this.resolveCookie();
    if (cookieFile) {
      args.push("--cookies", cookieFile);
    }
    args.push("-o", outPath, url);
    return args;
  }

  /**
   * 解析视频可用画质档位（供前端下拉框）。不下载任何内容，只探测。
   * 按「分辨率 + 帧率」分档，每档取该档码率最高的一条流（B站 同分辨率常有 H.264/HEVC/AV1 三条）。
   * @param {string} url 视频页地址
   * @param {{ytDlp?: boolean}} [env] 外部依赖可用性
   * @param {{emit?: Function}} [opts]
   * @returns {Promise<{ok: boolean, title?: string, uploader?: string, duration?: number,
   *   login?: {ok: boolean, uname?: string}, formats?: Array<{id:string,label:string,height:number,
   *   width:number,fps:number,codec:string,sizeMB:number}>, error?: string, reason?: string}>}
   */
  async listFormats(url, env = {}, opts = {}) {
    const emit = typeof opts.emit === "function" ? opts.emit : () => {};
    const rawUrl = String(url || "").trim();
    if (!rawUrl) return { ok: false, reason: "empty-url", error: "缺少 B站链接" };
    if (env.ytDlp === false) {
      return { ok: false, reason: "yt-dlp-not-found", error: "未检测到 yt-dlp，无法解析画质" };
    }

    const args = ["--no-warnings", "--dump-json", "--no-playlist"];
    const cookieFile = this.resolveCookie();
    if (cookieFile) args.push("--cookies", cookieFile);
    args.push(rawUrl);

    let r = null;
    try {
      r = await runCommand(this.ytDlpCmd(), this.withProxyArgs(args), {
        spawn: this.spawn,
        timeout: 60 * 1000,
        env: Object.assign({}, process.env, { PYTHONUTF8: "1" }),
      });
    } catch (e) {
      return { ok: false, reason: "yt-dlp-failed", error: "yt-dlp 执行失败：" + e.message };
    }

    const line = String(r.stdout || "")
      .split("\n")
      .find((l) => l.trim().startsWith("{"));
    if (r.code !== 0 || !line) {
      const stderr = String(r.stderr || "");
      // 412 = B站 反爬拦截，绝大多数是"没有登录态"
      if (/412|Precondition/i.test(stderr)) {
        return {
          ok: false,
          reason: "bili-auth",
          error: "B站 拒绝了未登录请求（HTTP 412）。请到「B站自动投稿」完成扫码登录后重试。",
        };
      }
      return {
        ok: false,
        reason: "parse-failed",
        error: "解析画质失败：" + (stderr.slice(0, 200) || "无输出"),
      };
    }

    let j = null;
    try {
      j = JSON.parse(line);
    } catch (e) {
      return { ok: false, reason: "parse-failed", error: "画质数据解析失败" };
    }

    // 按 分辨率+帧率+编码 分档（同一编码家族内挑码率 tbr 最高的一条）：
    // 用户要能在下拉里显式选 H.264（免转码）或 AV1/HEVC（更清晰但需自动转码），
    // 不能只按分辨率折叠成一条（那样 AV1 永远挤掉 H.264）。
    const buckets = new Map();
    for (const f of j.formats || []) {
      if (!f || !f.vcodec || f.vcodec === "none") continue;
      const h = Number(f.height) || 0;
      if (!h) continue;
      const fps = Number(f.fps) || 0;
      const family = codecLabel(f.vcodec);
      const key = h + "@" + fps + "@" + family;
      const tbr = Number(f.tbr) || 0;
      const prev = buckets.get(key);
      if (prev && prev.tbr >= tbr) continue;
      buckets.set(key, {
        tbr,
        id: String(f.format_id),
        height: h,
        width: Number(f.width) || 0,
        fps,
        codec: family,
        sizeMB: Math.round(
          (Number(f.filesize || f.filesize_approx || 0) || 0) / 1048576,
        ),
      });
    }

    // 同档内展示顺序：H.264（免转码）→ HEVC → AV1 → VP9 → 其他；不同档按 分辨率/帧率 降序
    const CODEC_ORDER = { "H.264": 0, HEVC: 1, AV1: 2, VP9: 3 };
    const formats = Array.from(buckets.values())
      .sort(
        (a, b) =>
          b.height - a.height ||
          b.fps - a.fps ||
          (CODEC_ORDER[a.codec] ?? 9) - (CODEC_ORDER[b.codec] ?? 9),
      )
      .map((x) => ({
        id: x.id,
        height: x.height,
        width: x.width,
        fps: x.fps,
        codec: x.codec,
        sizeMB: x.sizeMB,
        label:
          resolutionLabel(x.height, x.fps) +
          " · " +
          x.codec +
          (x.sizeMB ? " · ≈" + x.sizeMB + "MB" : "") +
          (x.codec !== "H.264" ? " · 将自动转码 H.264" : ""),
      }));

    const login = await getLoginInfo();
    // 默认档：1080P H.264（免转码，达芬奇直接可用）→ 退 1080P 任意编码 → 退最高档
    const defaultFmt =
      formats.find((f) => f.height === 1080 && f.codec === "H.264") ||
      formats.find((f) => f.height === 1080) ||
      formats[0];

    return {
      ok: true,
      title: j.title || "",
      uploader: (j.uploader || j.channel || "").toString(),
      duration: Number(j.duration) || 0,
      login: {
        ok: !!login.ok,
        uname: login.uname || "",
        source: login.source || null,
        reason: login.reason || null,
      },
      formats,
      defaultId: defaultFmt ? defaultFmt.id : "",
    };
  }

  /**
   * 重编码为 H.264/AAC（素材规范要求的剪辑友好格式）。
   * 用于两处：① 拉满画质下到 AV1/HEVC 流；② 非 mp4 容器流拷贝失败时的兜底。
   * @param {string} file 输入文件
   * @param {string} outPath 输出文件（.mp4）
   * @param {string} ffmpeg ffmpeg 命令/路径
   * @param {Function} [emit]
   * @returns {Promise<boolean>} 是否成功产出文件
   */
  async reencodeH264(file, outPath, ffmpeg, emit = () => {}) {
    try {
      const r = await runCommand(
        ffmpeg,
        [
          "-y",
          "-i",
          file,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "19",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-movflags",
          "+faststart",
          outPath,
        ],
        // 4K AV1 → H.264 可能很慢（实测十几分钟量级），给足 60 分钟上限
        { spawn: this.spawn, timeout: 60 * 60 * 1000 },
      );
      return r.code === 0 && fs.existsSync(outPath);
    } catch (e) {
      emit("log", "B站下载", "转码异常：" + e.message, null, { level: "warn" });
      return false;
    }
  }

  /**
   * 收尾：尽量零质量损失地产出 mp4 容器。
   *   · 已是 mp4 容器 → 原样保留（拉满画质，不重编码）；AV1 仅打兼容性提示。
   *   · 非 mp4（webm/mkv 等） → 先流拷贝转 mp4（零损失）；失败才回退重编码 H.264/AAC。
   * @param {string} file 已下载文件完整路径
   * @param {{ffmpeg?: boolean, ffprobePath?: string, ffmpegPath?: string}} [env]
   * @param {Function} [emit]
   * @returns {Promise<{file: string, converted: boolean, preserved?: boolean, remuxed?: boolean, vcodec?: string, acodec?: string, note?: string}>}
   */
  async finalize(file, env = {}, emit = () => {}) {
    const ext = path.extname(file).toLowerCase();
    const ffprobe = this.ffprobePath || env.ffprobePath || "ffprobe";
    const ffmpeg = this.ffmpegPath || env.ffmpegPath || "ffmpeg";

    // 探测编码（失败按不干预处理）
    let vcodec = "";
    let acodec = "";
    try {
      const r = await runCommand(
        ffprobe,
        ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", file],
        { spawn: this.spawn, timeout: 60000 },
      );
      const j = JSON.parse(r.stdout || "{}");
      for (const s of j.streams || []) {
        if (s.codec_type === "video" && !vcodec) vcodec = String(s.codec_name || "");
        if (s.codec_type === "audio" && !acodec) acodec = String(s.codec_name || "");
      }
    } catch (e) {
      /* 探测失败按不干预处理 */
    }

    if (ext === ".mp4") {
      // 素材规范 = H.264/AAC。拉满画质时 B站 常给 AV1/HEVC（同分辨率下码率更高，yt-dlp 优先选它），
      // 这类文件在 DaVinci Resolve 里会渲染失败，故非 H.264/AAC 一律自动转码，不再只是提示。
      const vOk = !vcodec || vcodec === "h264" || vcodec === "avc1";
      const aOk = !acodec || acodec === "aac";
      if (vOk && aOk) {
        return { file, converted: false, preserved: true, vcodec, acodec };
      }
      if (env.ffmpeg === false) {
        emit(
          "log",
          "B站下载",
          "警告：视频为 " +
            codecLabel(vcodec) +
            "/" +
            codecLabel(acodec) +
            " 编码，且未检测到 ffmpeg，无法自动转码，剪辑软件可能不兼容",
          null,
          { level: "warn" },
        );
        return { file, converted: false, preserved: true, vcodec, acodec };
      }
      emit(
        "log",
        "B站下载",
        "检测到 " + codecLabel(vcodec) + " 编码，转码为 H.264/AAC（剪辑软件兼容）…",
        null,
        { level: "info" },
      );
      const tmp = file.replace(/\.mp4$/i, "") + ".transcoding.mp4";
      if (await this.reencodeH264(file, tmp, ffmpeg, emit)) {
        try {
          fs.unlinkSync(file);
        } catch (e) {
          /* Windows 上可能被占用，忽略 */
        }
        try {
          fs.renameSync(tmp, file);
        } catch (e) {
          /* 重命名失败则保留 tmp，交由用户处理 */
          emit("log", "B站下载", "转码完成，但替换原文件失败：" + e.message, null, {
            level: "warn",
          });
        }
        return { file, converted: true, vcodec, acodec };
      }
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch (e) {
        /* ignore */
      }
      emit(
        "log",
        "B站下载",
        "警告：转码失败，保留原始 " + codecLabel(vcodec) + " 文件，剪辑软件可能不兼容",
        null,
        { level: "warn" },
      );
      return { file, converted: false, preserved: true, vcodec, acodec };
    }

    // 非 mp4 → 流拷贝转 mp4（零质量损失）
    const mp4 = file.replace(/\.[^.]+$/, ".mp4");
    emit("log", "B站下载", "封装转 mp4（流拷贝，不重编码）…", null, { level: "info" });
    try {
      const r = await runCommand(ffmpeg, ["-y", "-i", file, "-c", "copy", mp4], {
        spawn: this.spawn,
        timeout: 20 * 60 * 1000,
      });
      if (r.code === 0 && fs.existsSync(mp4)) {
        try {
          fs.unlinkSync(file);
        } catch (e) {
          /* ignore */
        }
        return { file: mp4, converted: false, remuxed: true, vcodec, acodec };
      }
    } catch (e) {
      /* 落到重编码兜底 */
    }

    // 拷贝失败（如个别 ffmpeg 构建不支持 AV1 进 mp4）→ 重编码 H.264/AAC（兼容性兜底）
    emit("log", "B站下载", "流拷贝失败，回退重编码为 H.264/AAC…", null, { level: "warn" });
    if (await this.reencodeH264(file, mp4, ffmpeg, emit)) {
      try {
        fs.unlinkSync(file);
      } catch (e) {
        /* ignore */
      }
      return { file: mp4, converted: true, vcodec, acodec };
    }
    return {
      file,
      converted: false,
      preserved: true,
      vcodec,
      acodec,
      note: "封装转换失败，保留原始文件",
    };
  }

  /**
   * 贴 B站链接下载（不搜索，直接下）。
   * @param {string} url BV/AV/EP/SS/合集/空间链接
   * @param {string} outDir 落盘目录
   * @param {{ytDlp?: boolean, ffmpeg?: boolean}} [env] 外部依赖可用性
   * @param {{emit?: Function, quality?: string|number, fileName?: string}} [opts]
   * @returns {Promise<{ok:boolean, file?:string, path?:string, title?:string, width?:number, height?:number, hd?:boolean, vcodec?:string, acodec?:string, error?:string, reason?:string}>}
   */
  async downloadUrl(url, outDir, env = {}, opts = {}) {
    const emit = typeof opts.emit === "function" ? opts.emit : () => {};
    const rawUrl = String(url || "").trim();
    if (!rawUrl) return { ok: false, reason: "empty-url", error: "缺少 B站链接" };
    if (env.ytDlp === false) {
      return { ok: false, reason: "yt-dlp-not-found", error: "未检测到 yt-dlp，无法下载" };
    }

    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch (e) {
      /* 目录已存在 */
    }

    const base = (opts.fileName && String(opts.fileName).trim()) || "bili_" + Date.now();
    const safeBase = base.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
    const outTemplate = path.join(outDir, safeBase + ".%(ext)s");

    const args = this.withProxyArgs(
      this.buildBiliDownloadArgs(rawUrl, outTemplate, env, {
        quality: opts.quality,
        formatId: opts.formatId,
      }),
    );
    const proxyUrl = this.resolveProxyUrl();
    if (proxyUrl) emit("log", "B站下载", "经代理访问：" + proxyUrl, null, { level: "info" });
    if (!this.resolveCookie()) {
      emit(
        "log",
        "B站下载",
        "未检测到 B站登录态，可能被拒（HTTP 412）。可到「B站自动投稿」扫码登录后重试。",
        null,
        { level: "warn" },
      );
    }
    emit(
      "bili_download",
      "B站下载",
      "开始下载（画质：" +
        (opts.formatId
          ? "指定档位 " + opts.formatId
          : opts.quality === "best" || opts.quality == null
            ? "拉满"
            : opts.quality + "p") +
        "）…",
      null,
      { url: rawUrl, proxy: proxyUrl },
    );

    let r = null;
    try {
      r = await runCommand(this.ytDlpCmd(), args, {
        spawn: this.spawn,
        timeout: 20 * 60 * 1000,
        env: Object.assign({}, process.env, { PYTHONUTF8: "1" }),
        onLine: (line) => emit("log", "B站下载", "[yt-dlp] " + line, null, { level: "info" }),
      });
    } catch (e) {
      return { ok: false, reason: "yt-dlp-failed", error: "yt-dlp 执行失败：" + e.message };
    }

    const produced = this.findDownloaded(outDir, safeBase);
    if (r.code !== 0 || !produced) {
      this.cleanupTrailerArtifacts(outDir, safeBase);
      if (produced) {
        try {
          fs.unlinkSync(path.join(outDir, produced));
        } catch (e) {
          /* ignore */
        }
      }
      const reason = r.code !== 0 ? "yt-dlp-failed" : "file-missing";
      const err = r.code !== 0 ? "yt-dlp 退出码 " + r.code : "下载完成但未找到产出文件";
      // 常见：未登录 cookie 导致高画质 403 / 无权限 / 大会员专享
      if (/403|copyright|login|cookie|会员|大会员|版权|ignoring/i.test(r.stderr || "")) {
        return {
          ok: false,
          reason: "bili-auth",
          error:
            "下载被拒（多为未登录 / 大会员限制）：" +
            err +
            "。可在 .bili-cookies.txt 配置登录 cookie 后重试。",
        };
      }
      return { ok: false, reason, error: err };
    }

    const producedPath = path.join(outDir, produced);
    const fin = await this.finalize(producedPath, env, emit);
    const finalPath = fin.file || producedPath;
    const title = (produced.replace(/\.[^.]+$/, "") || safeBase).replace(/^bili_\d+_?/, "");

    const result = {
      ok: true,
      file: path.basename(finalPath),
      path: finalPath,
      title: title || safeBase,
      fromBili: true,
      vcodec: fin.vcodec,
      acodec: fin.acodec,
    };

    const probed = await this.probeResolution(finalPath, { emit });
    if (probed.ok) {
      result.width = probed.width;
      result.height = probed.height;
    }
    emit(
      "bili_done",
      "B站下载",
      "下载完成：" +
        result.file +
        (result.height ? "（" + result.width + "×" + result.height + "）" : ""),
      true,
      { file: result.file, path: finalPath, width: result.width, height: result.height },
    );
    return result;
  }
}

module.exports = { BiliDownloader, isBiliUrl, buildFormat };
