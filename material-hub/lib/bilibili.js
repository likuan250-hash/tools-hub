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

/** B站链接识别（含短链 b23.tv / 播放器域名）。 */
function isBiliUrl(url) {
  const u = String(url || "").trim().toLowerCase();
  return (
    u.includes("bilibili.com") ||
    u.includes("b23.tv") ||
    u.includes("player.bilibili.com")
  );
}

/**
 * 按 quality 选项构造 yt-dlp 格式选择器。
 * @param {string|number} quality 'best'（默认拉满）/ 数字（限高，如 1080 / 720）
 * @param {boolean} hasFfmpeg 是否有 ffmpeg（无则无法合流，退到单文件流）
 * @returns {{format: string, extra: string[]}}
 */
function buildFormat(quality, hasFfmpeg) {
  const merge = hasFfmpeg ? ["--merge-output-format", "mp4"] : [];
  const q = String(quality == null ? "" : quality).trim();
  if (q === "" || q === "best") {
    return { format: "bv*+ba/b", extra: merge };
  }
  const h = Number(q);
  if (Number.isFinite(h) && h > 0) {
    return {
      format: `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`,
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
   * 构造 B站下载参数（拉满画质：best video + best audio，合流为 mp4 容器）。
   * @param {string} url 视频页地址
   * @param {string} outPath 输出模板（含 %(ext)s）
   * @param {{ffmpeg?: boolean}} [env] 外部依赖可用性
   * @param {{quality?: string|number}} [opts]
   * @returns {string[]}
   */
  buildBiliDownloadArgs(url, outPath, env = {}, opts = {}) {
    const hasFfmpeg = env.ffmpeg !== false;
    const { format, extra } = buildFormat(opts.quality, hasFfmpeg);
    const args = ["-f", format];
    if (extra.length) args.push(...extra);
    args.push("--no-warnings", "--newline", "--no-part");
    args.push("--retries", "3", "--fragment-retries", "3", "--retry-sleep", "2");
    // 可选登录 cookie：支持高画质（1080p+）/ 大会员专享。文件不存在则跳过（非阻断）。
    if (this.cookieFile && fs.existsSync(this.cookieFile)) {
      args.push("--cookies", this.cookieFile);
    }
    args.push("-o", outPath, url);
    return args;
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
      if (vcodec === "av1") {
        emit(
          "log",
          "B站下载",
          "提示：视频为 AV1 编码，部分剪辑软件（如旧版 DaVinci Resolve）兼容性差，必要时可手动转码",
          null,
          { level: "warn" },
        );
      }
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
          mp4,
        ],
        { spawn: this.spawn, timeout: 20 * 60 * 1000 },
      );
      if (r.code === 0 && fs.existsSync(mp4)) {
        try {
          fs.unlinkSync(file);
        } catch (e) {
          /* ignore */
        }
        return { file: mp4, converted: true, vcodec, acodec };
      }
    } catch (e) {
      /* 都失败 → 保留原文件 */
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
      this.buildBiliDownloadArgs(rawUrl, outTemplate, env, { quality: opts.quality }),
    );
    const proxyUrl = this.resolveProxyUrl();
    if (proxyUrl) emit("log", "B站下载", "经代理访问：" + proxyUrl, null, { level: "info" });
    emit(
      "bili_download",
      "B站下载",
      "开始下载（画质：" +
        (opts.quality === "best" || opts.quality == null ? "拉满" : opts.quality + "p") +
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
