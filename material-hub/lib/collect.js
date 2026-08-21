// lib/collect.js —— 素材搜集全流程编排（scan → trailer → cover → 抽帧兜底 → done）
//
// 经 handlers.onEvent(obj) 发射 SSE 事件；本文件不碰 HTTP，便于替换传输层。
//
// ── 相对旧版的两处关键修复 ──
// Bug A（重复建文件夹 【游戏268/269/270】正当防卫4）：
//   旧版调 reserveFolder 时只传 startIndex，等于每次都「最大编号 +1 再 mkdir」。
//   现在改为直接依赖 name.js 的同名复用能力，并把返回的 reused 字段贯通到 SSE，
//   前端因此能显示「复用已有文件夹」而不是「已创建」。
//
// Bug B（点击运行一直不成功）：
//   旧版 `result.success = result.coverOk`，而封面源（Steam 1920×620 / YouTube 1280×720）
//   物理上不可能满足规范的 ≥1920×1080 → 必然判失败。现在：
//     ① 封面走 lib/cover.js 的规范六级来源；
//     ② 先下视频、后取封面，网络源全挂时用 probe.extractFrame 抽帧（必得视频原生分辨率）；
//     ③ success 改为「封面 + 视频都拿到」，抽帧兜底生效后整体必然判成功。
const path = require("path");
const fsDefault = require("fs");

/** 宣传片标题归一化（排除已落盘候选用）：去标点/空白/大小写。 */
function normTrailerTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

/** 判断候选是否与上次已落盘宣传片是同一个（id / url / 归一化标题任一命中）。 */
function sameTrailer(prev, c) {
  if (!prev || !c) return false;
  if (prev.id && c.id && String(prev.id) === String(c.id)) return true;
  if (prev.url && c.url && String(prev.url).trim() === String(c.url).trim()) return true;
  if (prev.title && c.title && normTrailerTitle(prev.title) === normTrailerTitle(c.title))
    return true;
  return false;
}

const { NameResolver } = require("./name");
const { CoverFetcher, COVER_FILE } = require("./cover");
const { TrailerDownloader, extractEnglishName: trailerExtractEnglishName } = require("./trailer");
const { MediaProbe } = require("./probe");
const { EnvDetector, YT_DLP_GUIDANCE } = require("./env");
const { meetsMinSize, MIN_WIDTH, MIN_HEIGHT } = require("./imagesize");
const loggerDefault = require("./logger");

/** 步骤名常量（SSE 事件 step 字段，前端直接展示）。 */
const STEP_SCAN = "扫描编号并准备文件夹";
const STEP_TRAILER = "下载官方宣传片";
const STEP_COVER = "获取封面";
const STEP_DONE = "素材搜集完成";
const STEP_DONE_PARTIAL = "素材搜集部分完成";
const STEP_DONE_FAIL = "素材搜集未完成";
/** 默认落盘根目录（可经 MATERIAL_OUTPUT_DIR 覆盖）。 */
const DEFAULT_OUTPUT_DIR = "E:\\素材\\";
/** 复用文件夹时识别既有产物用的扩展名。 */
const VIDEO_EXTS = [".mp4", ".mkv", ".webm", ".mov"];
const COVER_EXTS = [".jpg", ".jpeg", ".png", ".webp"];
/** 宣传片元数据 sidecar 文件名（复用视频时读取以支持英文名提取）。 */
const TRAILER_META_FILE = ".trailer.json";
/** 规范《目录结构》里的投稿完成标记，不能被当成素材产物。 */
const UPLOADED_MARK = ".uploaded";
/** 交互式封面选择的等待上限；超时自动采用第一个候选（保持原自动行为，避免流程卡死）。 */
const COVER_CHOICE_TIMEOUT_MS = 180 * 1000;

/** 全流程编排服务。 */
class CollectService {
  /**
   * @param {{
   *   name?: NameResolver, cover?: CoverFetcher, trailer?: TrailerDownloader,
   *   probe?: MediaProbe, env?: EnvDetector, logger?: object, fs?: object
   * }} [deps] 依赖注入（单测用）
   */
  constructor(deps = {}) {
    this.fs = deps.fs || fsDefault;
    this.name = deps.name || new NameResolver({ fs: this.fs });
    this.probe = deps.probe || new MediaProbe({ fs: this.fs });
    this.trailer = deps.trailer || new TrailerDownloader({ fs: this.fs, probe: this.probe });
    this.cover = deps.cover || new CoverFetcher({ fs: this.fs, probe: this.probe });
    this.env = deps.env || new EnvDetector({ fs: this.fs });
    this.logger = deps.logger || loggerDefault;
    /** 待处理的封面选择：requestId → {resolve}（由 /api/cover/choose 触发 resolve）。 */
    this._coverChoices = new Map();
    /** 待处理的宣传片选择：requestId → {resolve}（由 /api/video/choose 触发 resolve）。 */
    this._videoChoices = new Map();
  }

  /**
   * 列出目录内条目（异常一律返回空数组）。
   * @param {string} dir 目录
   * @returns {string[]}
   */
  listDir(dir) {
    try {
      const entries = this.fs.readdirSync(dir);
      return Array.isArray(entries) ? entries : [];
    } catch (e) {
      return [];
    }
  }

  /**
   * 在（复用的）文件夹里找已存在的封面。
   * @param {string} folder 素材文件夹
   * @returns {{file: string, path: string}|null}
   */
  findExistingCover(folder) {
    for (const entry of this.listDir(folder)) {
      const lower = entry.toLowerCase();
      if (!entry.startsWith("封面")) continue;
      if (COVER_EXTS.some((e) => lower.endsWith(e))) {
        return { file: entry, path: path.join(folder, entry) };
      }
    }
    return null;
  }

  /**
   * 在（复用的）文件夹里找已存在的视频。
   * @param {string} folder 素材文件夹
   * @returns {{file: string, path: string}|null}
   */
  findExistingVideo(folder) {
    for (const entry of this.listDir(folder)) {
      if (entry === UPLOADED_MARK) continue;
      if (/\.f\d+(\.\w+)?$/i.test(entry)) continue; // yt-dlp 中间产物（如 .f137.mp4）不算成品
      const lower = entry.toLowerCase();
      if (VIDEO_EXTS.some((e) => lower.endsWith(e))) {
        return { file: entry, path: path.join(folder, entry) };
      }
    }
    return null;
  }

  // ── 宣传片元数据 sidecar（复用场景下提取英文名用）──
  saveTrailerMeta(folder, meta) {
    try {
      this.fs.writeFileSync(
        path.join(folder, TRAILER_META_FILE),
        JSON.stringify(meta, null, 2),
        "utf8",
      );
    } catch (e) {
      /* sidecar 静默失败 */
    }
  }
  readTrailerMeta(folder) {
    try {
      const p = path.join(folder, TRAILER_META_FILE);
      if (!this.fs.existsSync(p)) return null;
      return JSON.parse(this.fs.readFileSync(p, "utf8"));
    } catch (e) {
      return null;
    }
  }

  /**
   * 提交一次封面选择（由 server 层 /api/cover/choose 转发）。
   * @param {string} requestId 候选事件携带的请求 id
   * @param {string} url 选中的候选直链；空串表示跳过（走抽帧兜底）
   * @returns {boolean} 是否存在待处理的对应请求
   */
  chooseCover(requestId, url) {
    const entry = this._coverChoices.get(requestId);
    if (!entry) return false;
    this._coverChoices.delete(requestId);
    entry.resolve({ url: String(url || "").trim() });
    return true;
  }

  /**
   * 提交一次宣传片候选选择（由 server 层 /api/video/choose 转发）。
   * @param {string} requestId 候选事件携带的请求 id
   * @param {string[]} urls 选中的候选直链列表（按勾选顺序）；空数组表示跳过（走自动第一个）
   * @returns {boolean} 是否存在待处理的对应请求
   */
  chooseVideo(requestId, urls) {
    const entry = this._videoChoices.get(requestId);
    if (!entry) return false;
    this._videoChoices.delete(requestId);
    const list = Array.isArray(urls) ? urls : [];
    entry.resolve({ urls: list.map((u) => String(u || "").trim()).filter(Boolean) });
    return true;
  }

  /**
   * 等待用户在前端弹窗中做封面选择；超时自动采用第一个候选（保持原自动行为）。
   * @param {string} requestId 请求 id
   * @param {number} timeoutMs 等待上限
   * @returns {Promise<{url: string, auto?: boolean}>}
   */
  waitCoverChoice(requestId, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._coverChoices.delete(requestId)) resolve({ url: "", auto: true });
      }, timeoutMs);
      this._coverChoices.set(requestId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
    });
  }

  /**
   * 等待用户在前端弹窗中做宣传片候选选择；超时/跳过自动采用原排序第一个。
   * @param {string} requestId 请求 id
   * @param {number} timeoutMs 等待上限
   * @returns {Promise<{url: string, auto?: boolean}>}
   */
  waitVideoChoice(requestId, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._videoChoices.delete(requestId)) resolve({ url: "", auto: true });
      }, timeoutMs);
      this._videoChoices.set(requestId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
    });
  }

  /**
   * 交互式封面步骤：收集候选 → 弹窗选择 → 应用所选直链。
   * 无候选时直接失败，交给上层走抽帧兜底。
   * @param {string} searchName 检索用游戏名（英文名优先）
   * @param {string} outDir 目标目录
   * @param {{
   *   emit?: Function, coverUrl?: string, videoId?: string,
   *   englishTitle?: string, originalName?: string, steamAppId?: string
   * }} [opts]
   * @returns {Promise<object>} 与 cover.fetchCover 同构的结果对象
   */
  async runInteractiveCover(searchName, outDir, opts = {}) {
    const emit = typeof opts.emit === "function" ? opts.emit : () => {};
    const c = await this.cover.collectCandidates(searchName, {
      emit,
      coverUrl: opts.coverUrl,
      videoId: opts.videoId,
      englishTitle: opts.englishTitle,
      originalName: opts.originalName,
      steamAppId: opts.steamAppId,
      userUrlFirst: !!opts.coverUrl,
      resolveEnglish: false,
      skipSource: opts.skipSource,
      skipUrl: opts.skipUrl,
    });
    // 候选预检：下载到本地（绕防盗链）→ 过滤 <720P/不可访问 → 前端预览本地文件
    const prechecked = await this.cover.precheckCandidates(c.candidates || [], {
      emit,
      skipSource: opts.skipSource,
      skipUrl: opts.skipUrl,
    });
    if (!prechecked.length) {
      emit("log", STEP_COVER, "[cover] 未找到可预览的候选封面，走原有降级流程", null, {
        level: "warn",
      });
      return { ok: false, reason: "cover-no-candidates", error: c.error || "无候选封面" };
    }

    const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    emit(
      "cover_candidates",
      STEP_COVER,
      "找到 " + prechecked.length + " 张候选封面（已过滤低清/不可访问），请选择",
      null,
      {
        requestId,
        candidates: prechecked,
        meta: {
          queryUsed: (c.queryPlan && c.queryPlan[0]) || searchName,
          englishTitle: c.englishTitle || "",
          steamAppId: c.steamAppId || "",
          filtered: (c.candidates || []).length - prechecked.length,
        },
      },
    );

    const choice = await this.waitCoverChoice(
      requestId,
      opts.choiceTimeoutMs || COVER_CHOICE_TIMEOUT_MS,
    );
    if (choice.auto) {
      emit("log", STEP_COVER, "[cover] 选择超时，自动采用第一个候选", null, { level: "warn" });
      choice.url = prechecked[0].url;
    }
    if (!choice.url) {
      emit("log", STEP_COVER, "[cover] 已跳过封面选择，走抽帧兜底", null, { level: "info" });
      return { ok: false, reason: "cover-skipped-by-user", error: "未选择封面" };
    }
    const picked = prechecked.find((it) => it.url === choice.url) || {};
    emit(
      "cover_download",
      STEP_COVER,
      "应用所选封面（" + (picked.label || picked.source || "user") + "）…",
      null,
      {
        url: picked.originalUrl || choice.url,
        source: picked.source || "user",
        interactive: true,
      },
    );
    const applied = await this.cover.applyCandidate(choice.url, outDir, {
      emit,
      source: picked.source || "user",
      localPath: picked.localPath,
    });
    if (applied.ok && applied.source && applied.source !== "user" && applied.source !== "reused") {
      this.cover.saveCoverMeta(outDir, {
        source: applied.source,
        url: picked.originalUrl || "",
        width: applied.width,
        height: applied.height,
        file: applied.file,
        savedAt: new Date().toISOString(),
      });
    }
    // 用户主动勾选（非超时自动）视为「确认保留」：即便降级也不再被抽帧覆盖
    applied.userConfirmed = choice.auto !== true;
    // 封面已落盘：补发 ok 终态，前端执行进度才能显示成功（否则流程结束被收敛为失败）
    if (applied.ok) {
      emit("cover_download", STEP_COVER, "封面已落盘：" + (applied.file || ""), true, {
        file: applied.file || "",
        source: applied.source || picked.source || "user",
        width: applied.width,
        height: applied.height,
        degraded: applied.degraded === true,
        interactive: true,
      });
    }
    return applied;
  }

  /**
   * 宣传片候选交互选择：发 video_candidates 事件 → 前端弹窗预览选择（缩略图/标题/频道/时长）。
   * 重找视频时候选已剔除上次落盘项；跳过/超时返回 null（沿用自动第一个）。
   * @param {Array<object>} cands 排序后的候选列表（trailer.searchTrailerCandidates 输出）
   * @param {{emit?: Function, choiceTimeoutMs?: number}} [opts]
   * @returns {Promise<object[]|null>} 选中的候选列表（按勾选顺序）；跳过/超时返回 null
   */
  async runInteractiveTrailer(cands, opts = {}) {
    const emit = typeof opts.emit === "function" ? opts.emit : () => {};
    const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    emit("video_candidates", STEP_TRAILER, "找到 " + cands.length + " 条宣传片候选，请选择", null, {
      requestId,
      candidates: cands.map((c) => ({
        id: c.id || "",
        title: c.title || "",
        url: c.url || "",
        channel: c.channel || "",
        duration: c.duration || 0,
        score: c.score || 0,
        thumb: c.thumb || "",
      })),
    });
    const choice = await this.waitVideoChoice(
      requestId,
      opts.choiceTimeoutMs || COVER_CHOICE_TIMEOUT_MS,
    );
    if (choice.auto) {
      emit("log", STEP_TRAILER, "[trailer] 候选选择超时，自动采用第一个", null, { level: "warn" });
      return null;
    }
    if (!choice.urls || !choice.urls.length) {
      emit("log", STEP_TRAILER, "[trailer] 已跳过候选选择，自动采用第一个", null, {
        level: "info",
      });
      return null;
    }
    const byUrl = new Map(cands.map((c) => [c.url, c]));
    const picked = [];
    for (const u of choice.urls) {
      const hit = byUrl.get(u);
      if (hit && !picked.includes(hit)) picked.push(hit);
    }
    return picked.length ? picked : null;
  }

  /**
   * 执行一次素材搜集。
   * @param {{
   *   name: string, outDir?: string, coverUrl?: string,
   *   englishName?: string, developer?: string, versionDesc?: string,
   *   kind?: string, force?: boolean, forceTrailer?: boolean, forceCover?: boolean
   * }} opts 入参；forceTrailer/forceCover 针对单类强制重下，force=true 等价于两者都 true
   * }} opts 入参；force=true 时忽略复用文件夹里的既有产物强制重下
   * @param {{onEvent?: (ev: object) => void}} [handlers] 事件回调（SSE 发送器）
   * @returns {Promise<{
   *   folder: string, index: number, reused: boolean,
   *   cover: object|null, trailer: object|null,
   *   success: boolean, partial: boolean, coverOk: boolean, trailerOk: boolean
   * }>}
   */
  async run(opts = {}, handlers = {}) {
    const onEvent = typeof handlers.onEvent === "function" ? handlers.onEvent : () => {};
    /**
     * 发射一条 SSE 事件。
     * @param {string} type 事件类型
     * @param {string} step 人类可读步骤名
     * @param {string} msg 进展描述
     * @param {boolean|null} [ok] true=成功 / false=失败 / null=进行中
     * @param {object} [detail] 结构化细节
     */
    const emit = (type, step, msg, ok = null, detail) => {
      const ev = { type, step, msg, ok: ok === undefined ? null : ok };
      if (detail !== undefined) ev.detail = detail;
      try {
        onEvent(ev);
      } catch (e) {
        /* 客户端已断开 */
      }
    };

    // 统一清洗游戏名：去首尾空格，消除中文与数字间的多余空格
    // （如「正当防卫 4」→「正当防卫4」，但不影响「Elden Ring」「Just Cause 4」）
    const gameName = String(opts.name == null ? "" : opts.name)
      .trim()
      .replace(/([\u4e00-\u9fff\u3400-\u4dbf])\s+(\d)/g, "$1$2")
      .replace(/(\d)\s+([\u4e00-\u9fff\u3400-\u4dbf])/g, "$1$2");
    const outDir = opts.outDir || DEFAULT_OUTPUT_DIR;
    const force = opts.force === true;
    const forceTrailer = force || opts.forceTrailer === true;
    const forceCover = force || opts.forceCover === true;
    const result = {
      folder: "",
      index: 0,
      reused: false,
      cover: null,
      trailer: null,
      success: false,
      partial: false,
      coverOk: false,
      trailerOk: false,
    };

    if (!gameName) {
      emit("error", STEP_SCAN, "游戏名不能为空", false, { reason: "empty-name", group: "scan" });
      emit("done", STEP_DONE_FAIL, "未执行：游戏名为空", false, {
        coverOk: false,
        trailerOk: false,
        partial: false,
      });
      return result;
    }

    // ── 0. 环境：一次性解析三件套并注入各组件（工具已内置，正常情况全部命中）──
    const envInfo = this.env.detect();
    this.probe.setBinaries({ ffmpegPath: envInfo.ffmpegPath, ffprobePath: envInfo.ffprobePath });
    if (typeof this.trailer.setBinaries === "function") {
      this.trailer.setBinaries({
        ytDlpPath: envInfo.ytDlpPath,
        ffmpegPath: envInfo.ffmpegPath,
        ffprobePath: envInfo.ffprobePath,
      });
    }
    if (envInfo.missing.length) {
      emit("log", STEP_SCAN, "[env] 缺少依赖：" + envInfo.missing.join(", "), null, {
        level: "warn",
      });
    } else {
      emit(
        "log",
        STEP_SCAN,
        "[env] yt-dlp/" +
          envInfo.sources.ytDlp +
          " · ffmpeg/" +
          envInfo.sources.ffmpeg +
          " · ffprobe/" +
          envInfo.sources.ffprobe,
        null,
        { level: "info" },
      );
    }
    // 代理探测：环境变量/.proxy 文件都没有时，自动扫描本地常见代理端口（127.0.0.1:7990 等）。
    // 封面搜索与宣传片下载都依赖代理出网，无声缺失会导致全超时；这里明确提示命中来源。
    const { resolveProxyAsync } = require("./http");
    const px = await resolveProxyAsync("https://www.google.com");
    const pxEnv = process.env.HTTP_PROXY || process.env.http_proxy || "";
    let pxStatus = "(未设置，将直连)";
    let pxLevel = "warn";
    if (px) {
      pxStatus = px.href + (pxEnv ? "（环境变量）" : "（自动探测/配置文件）");
      pxLevel = "info";
    }
    emit("log", STEP_SCAN, "[env] HTTP_PROXY=" + pxStatus, null, {
      level: pxLevel,
      proxy: px ? px.href : "",
    });

    // ── 1. scan：同名复用优先，不存在才按「最大编号 +1」新建（Bug A）──
    let reserved = null;
    try {
      emit("scan", STEP_SCAN, "检测「" + gameName + "」是否已有素材文件夹…", null);
      reserved = this.name.reserveFolder(outDir, gameName);
    } catch (e) {
      this.logger.error("[collect] 创建素材文件夹失败:", e.message);
      emit("error", STEP_SCAN, "创建素材文件夹失败：" + e.message, false, {
        reason: "mkdir-failed",
        group: "scan",
        outDir,
      });
      emit("done", STEP_DONE_FAIL, "未落盘：无法创建素材文件夹", false, {
        coverOk: false,
        trailerOk: false,
        partial: false,
      });
      return result;
    }
    result.folder = reserved.folder;
    result.index = reserved.index;
    result.reused = reserved.reused === true;
    emit(
      "scan",
      STEP_SCAN,
      (result.reused ? "复用已有文件夹 " : "已创建 ") + reserved.folderName,
      true,
      {
        folder: reserved.folder,
        folderName: reserved.folderName,
        index: reserved.index,
        reused: result.reused,
      },
    );
    this.logger.info("[collect] 素材文件夹 " + reserved.folder + " reused=" + result.reused);

    // ── 1.5 英文名：第一步就定下来，后续视频和封面统一用它检索 ──
    //      先读 trailer sidecar（如果有的话），供英文名提取用
    this.reusedTrailerMeta = this.readTrailerMeta(reserved.folder);
    //      优先级：用户给的 > 原名就是拉丁文 > trailer sidecar 里的标题 > Steam 反查 > YouTube 搜索
    let searchName = gameName;
    const english = await this.cover.resolveEnglishTitle(gameName, {
      englishTitle:
        opts.englishName ||
        (this.reusedTrailerMeta
          ? trailerExtractEnglishName(this.reusedTrailerMeta.title || "")
          : ""),
      emit,
      lookup: true,
      ytDlpPath: envInfo.ytDlpPath,
    });
    if (english.title) {
      searchName = english.title;
      emit(
        "log",
        STEP_SCAN,
        "[collect] 英文名定稿：" + searchName + "（来源：" + (english.source || "none") + "）",
        null,
        { level: "info" },
      );
    } else {
      emit("log", STEP_SCAN, "[collect] 英文名获取失败，使用原名检索：" + gameName, null, {
        level: "warn",
      });
    }
    const steamAppId = english.steamAppId || "";

    // ── 2. trailer：先下视频（YouTube 优先，Steam 兜底）──
    //      ① 第 6 级封面来源要用宣传片的 videoId 取缩略图；
    //      ② 第 7 级抽帧兜底必须有视频文件才能执行。
    let trailerInfo = null;
    let videoPath = "";

    const existingVideo =
      !forceTrailer && result.reused ? this.findExistingVideo(reserved.folder) : null;
    if (existingVideo) {
      result.trailerOk = true;
      const reusedTitle = (this.reusedTrailerMeta && this.reusedTrailerMeta.title) || "";
      result.trailer = {
        file: existingVideo.file,
        path: existingVideo.path,
        title: reusedTitle,
        reused: true,
      };
      videoPath = existingVideo.path;
      emit("trailer_download", STEP_TRAILER, "复用已有视频 " + existingVideo.file, true, {
        file: existingVideo.file,
        reused: true,
      });
    } else if (!envInfo.ytDlp) {
      emit("error", STEP_TRAILER, "未检测到 yt-dlp，无法下载宣传片", false, {
        reason: "yt-dlp-not-found",
        guidance: YT_DLP_GUIDANCE,
        group: "trailer",
      });
    } else {
      let dl = { ok: false, error: "未执行" };
      try {
        let trailerCands =
          (await this.trailer.searchTrailerCandidates(searchName, {
            emit,
            developer: opts.developer,
          })) || [];
        // 重找视频：排除上次已落盘的候选（重找即对旧视频不满意）
        if (forceTrailer && trailerCands.length) {
          const prev = this.readTrailerMeta(reserved.folder);
          if (prev && (prev.id || prev.url || prev.title)) {
            const before = trailerCands.length;
            trailerCands = trailerCands.filter((c) => !sameTrailer(prev, c));
            if (trailerCands.length !== before) {
              emit(
                "log",
                STEP_TRAILER,
                "[trailer] 已排除上次落盘候选（" + (before - trailerCands.length) + " 条）",
                null,
                { level: "info" },
              );
            }
          }
        }
        // 交互式候选预览选择（缩略图弹窗）：重找视频时默认开启，可显式开关；跳过/超时沿用自动第一个
        const wantInteractive =
          opts.videoInteractive === true || (forceTrailer && opts.videoInteractive !== false);
        if (wantInteractive && trailerCands.length > 1) {
          const picked = await this.runInteractiveTrailer(trailerCands, { emit });
          if (picked) trailerCands = picked;
        }
        trailerInfo = trailerCands && trailerCands.length ? trailerCands[0] : null;
        if (!trailerInfo) {
          dl = { ok: false, reason: "trailer-not-found", error: "未搜索到符合规范的官方宣传片" };
          // YouTube 没搜到 → 如果有 Steam appid，尝试从 Steam 商店页下载官方预告片
          if (steamAppId) {
            try {
              emit(
                "log",
                STEP_TRAILER,
                "尝试 Steam 商店页预告片（appid=" + steamAppId + "）…",
                null,
                { level: "info" },
              );
              dl = await this.trailer.downloadFromSteam(searchName, reserved.folder, envInfo, {
                steamAppId,
                emit,
                index: reserved.index,
                kind: opts.kind,
                englishName: opts.englishName,
                versionDesc: opts.versionDesc,
              });
            } catch (e) {
              dl = { ok: false, reason: "steam-trailer-exception", error: e.message };
            }
          }
        } else {
          dl = await this.trailer.download(searchName, reserved.folder, envInfo, {
            candidates: trailerCands,
            info: trailerInfo,
            emit,
            index: reserved.index,
            kind: opts.kind,
            englishName: opts.englishName,
            versionDesc: opts.versionDesc,
          });
        }
      } catch (e) {
        dl = { ok: false, reason: "trailer-exception", error: e.message };
      }

      if (dl.ok) {
        const tr = await this.trailer.transcodeIfNeeded(dl.file, reserved.folder, envInfo, {
          emit,
        });
        const finalFile = tr.file;
        const finalPath = path.join(reserved.folder, finalFile);
        videoPath = finalPath;
        result.trailerOk = true;
        result.trailer = {
          file: finalFile,
          path: finalPath,
          title: dl.title || "",
          url: dl.url || "",
          channel: dl.channel || "",
          width: dl.width,
          height: dl.height,
          hd: dl.hd === true,
          converted: tr.converted === true,
          reused: false,
        };
        this.saveTrailerMeta(reserved.folder, {
          title: dl.title || "",
          channel: dl.channel || "",
          url: dl.url || "",
          id: trailerInfo && trailerInfo.id ? trailerInfo.id : "",
        });
        emit("trailer_download", STEP_TRAILER, finalFile, true, {
          file: finalFile,
          title: dl.title || "",
          width: dl.width,
          height: dl.height,
          hd: dl.hd === true,
          converted: tr.converted === true,
        });
      } else {
        this.logger.warn("[collect] 宣传片获取失败:", dl.error);
        emit("error", STEP_TRAILER, dl.error || "宣传片下载失败", false, {
          reason: dl.reason || "trailer-failed",
          group: "trailer",
        });
      }
    }

    // ── 3. cover：规范六级来源依次降级 ──
    const existingCover =
      !forceCover && result.reused ? this.findExistingCover(reserved.folder) : null;
    let coverRes = { ok: false, error: "未执行" };

    if (existingCover) {
      coverRes = { ok: true, file: existingCover.file, path: existingCover.path, source: "reused" };
      emit("cover_download", STEP_COVER, "复用已有封面 " + existingCover.file, true, {
        file: existingCover.file,
        source: "reused",
        reused: true,
      });
    } else {
      try {
        // 英文名已在 1.5 步定稿，直接传入，不再让 cover.js 自己反查
        // 重找封面：读取上次采纳来源/URL，候选收集时跳过，确保换来源重找
        let skipSource = "";
        let skipUrl = "";
        if (opts.forceCover) {
          const prev = this.cover.readCoverMeta(reserved.folder);
          if (prev && prev.source) skipSource = prev.source;
          if (prev && prev.url) skipUrl = prev.url;
        }
        const coverOpts = {
          emit,
          coverUrl: opts.coverUrl,
          ytDlpPath: envInfo.ytDlpPath,
          englishTitle: searchName !== gameName ? searchName : "",
          originalName: gameName,
          steamAppId,
          videoId: trailerInfo && trailerInfo.id ? trailerInfo.id : "",
          resolveEnglish: false,
          skipSource,
          skipUrl,
        };
        // 用户提供了封面直链（重找封面填了链接）：直接用链接下载，不再检索任何来源，
        // 后续步骤也跳过候选预检/弹窗选择，直接落盘为封面。
        if (opts.coverUrl && String(opts.coverUrl).trim()) {
          emit("cover_search", STEP_COVER, "使用用户指定 URL（跳过来源检索）", null, {
            source: "user",
            url: String(opts.coverUrl).trim(),
          });
          coverRes = await this.cover.applyCandidate(opts.coverUrl, reserved.folder, {
            emit,
            source: "user",
          });
          if (coverRes.ok) {
            emit("cover_download", STEP_COVER, "封面已落盘：" + (coverRes.file || ""), true, {
              file: coverRes.file || "",
              source: "user",
              width: coverRes.width,
              height: coverRes.height,
              degraded: coverRes.degraded === true,
              interactive: false,
            });
          }
        } else if (opts.coverInteractive === true) {
          coverRes = await this.runInteractiveCover(searchName, reserved.folder, coverOpts);
        } else {
          coverRes = await this.cover.fetchCover(
            searchName,
            reserved.folder,
            Object.assign({ userUrlFirst: !!opts.coverUrl }, coverOpts),
          );
        }
      } catch (e) {
        // cover.js 内部已全程 try/catch，这里只是最后一道保险
        coverRes = { ok: false, reason: "cover-exception", error: e.message };
      }
    }

    // ── 4. 抽帧兜底（主视频抽帧，最终兜底）——Bug B 的决定性修复 ──
    //      触发条件：封面完全没拿到，或只拿到不达标的降级图（YouTube 720p）。
    //      前提：本轮已有可用视频。抽帧产出的就是视频原生分辨率，1080p 视频必得 1920×1080。
    // 官方来源（Steam 官方图 / YouTube 官方缩略图）与用户指定/勾选的封面即便不达标也保留，
    // 不再用视频抽帧覆盖（用户明确要求「发售宣传图优先于高清/视频帧」且「我指定的必须最优先」）。
    const PRESERVE_COVER_SOURCES = [
      "youtube",
      "steam-cdn",
      "steam-cdn-hero",
      "steam-cdn-lowres",
      "user",
    ];
    const needFallback =
      (!coverRes.ok ||
        (coverRes.degraded === true &&
          PRESERVE_COVER_SOURCES.indexOf(coverRes.source) < 0 &&
          coverRes.userConfirmed !== true)) &&
      !!videoPath;
    if (needFallback) {
      const why = coverRes.ok
        ? "网络封面仅 720p 降级图"
        : coverRes.source === "user"
          ? "用户指定封面下载失败"
          : "规范 10 级封面来源均失败";
      emit("cover_extract", STEP_COVER, why + "，改用主视频抽帧兜底…", null, {
        reason: coverRes.reason || "cover-degraded",
        video: videoPath,
      });
      const framePath = path.join(reserved.folder, COVER_FILE);
      let frame = { ok: false, error: "未执行" };
      try {
        frame = await this.probe.extractFrame(videoPath, framePath, { emit, step: STEP_COVER });
      } catch (e) {
        frame = { ok: false, reason: "extract-exception", error: e.message };
      }

      if (frame.ok) {
        // 抽出来的帧同样要按规范核实分辨率，不盲信
        let width = 0;
        let height = 0;
        try {
          const sized = await this.probe.probeSize(framePath, { emit, step: STEP_COVER });
          if (sized && sized.ok) {
            width = sized.width;
            height = sized.height;
          }
        } catch (e) {
          /* 读不到尺寸不影响采纳，仅不展示分辨率 */
        }

        const meets =
          width && height
            ? meetsMinSize({ width, height }, { width: MIN_WIDTH, height: MIN_HEIGHT })
            : true;
        coverRes = {
          ok: true,
          degraded: !meets,
          file: COVER_FILE,
          path: framePath,
          width: width || undefined,
          height: height || undefined,
          source: "ffmpeg-frame",
          seek: frame.seek,
        };
        emit(
          "cover_download",
          STEP_COVER,
          COVER_FILE +
            "（" +
            (width || "?") +
            "×" +
            (height || "?") +
            " · 主视频抽帧 @" +
            (frame.seek || "00:00:05") +
            "）",
          true,
          {
            file: COVER_FILE,
            path: framePath,
            width,
            height,
            source: "ffmpeg-frame",
            seek: frame.seek,
          },
        );
      } else if (coverRes.ok) {
        // 抽帧失败但手上还有降级图 → 保留它，「有总比没有强」
        emit("cover_download", STEP_COVER, "抽帧失败，保留降级封面 " + coverRes.file, true, {
          file: coverRes.file,
          source: coverRes.source,
          degraded: true,
          error: frame.error,
        });
      } else {
        emit("log", STEP_COVER, "[cover] 抽帧兜底失败：" + (frame.error || "未知原因"), null, {
          level: "err",
        });
      }
    }

    // 网络来源封面采纳后记录来源 sidecar（供下次「重找封面」跳过）；抽帧/reused 不记录
    if (
      coverRes.ok &&
      coverRes.source &&
      coverRes.source !== "ffmpeg-frame" &&
      coverRes.source !== "reused"
    ) {
      this.cover.saveCoverMeta(reserved.folder, {
        source: coverRes.source,
        url: coverRes.url || "",
        width: coverRes.width,
        height: coverRes.height,
        file: coverRes.file,
        savedAt: new Date().toISOString(),
      });
    }
    // 清理候选预检临时文件（交互预览模式使用）
    this.cover.clearPreviewTmp();

    if (coverRes.ok) {
      result.coverOk = true;
      result.cover = {
        file: coverRes.file,
        path: coverRes.path,
        width: coverRes.width,
        height: coverRes.height,
        source: coverRes.source || "unknown",
        degraded: coverRes.degraded === true,
        reused: coverRes.source === "reused",
      };
    } else {
      this.logger.warn("[collect] 封面获取失败:", coverRes.error);
      emit("error", STEP_COVER, coverRes.error || "所有封面来源均获取失败", false, {
        reason: coverRes.reason || "cover-all-sources-failed",
        group: "cover",
        tried: coverRes.tried || [],
      });
    }

    // ── 5. done：按规范《目录结构》，一份完整素材 = 主视频 + 封面 ──
    //      不再是旧版的 `success = coverOk` 单点判定。
    //      抽帧兜底生效后，只要视频下来了封面必然有 → 整体判成功。
    result.success = result.coverOk && result.trailerOk;
    result.partial = !result.success && (result.coverOk || result.trailerOk);

    let step = STEP_DONE_FAIL;
    if (result.success) step = STEP_DONE;
    else if (result.partial) step = STEP_DONE_PARTIAL;

    let msg = "";
    if (result.success) {
      msg = "落盘 " + reserved.folder + "\\";
    } else if (result.partial) {
      msg =
        (result.coverOk ? "仅封面落盘" : "仅视频落盘") +
        "，缺 " +
        (result.coverOk ? "主视频" : "封面") +
        "：" +
        reserved.folder +
        "\\";
    } else {
      msg =
        "封面与视频均未取到，仅" +
        (result.reused ? "复用了" : "创建了") +
        "文件夹 " +
        reserved.folder +
        "\\";
    }

    emit("done", step, msg, result.success, {
      folder: result.folder,
      folderName: reserved.folderName,
      index: result.index,
      reused: result.reused,
      coverOk: result.coverOk,
      trailerOk: result.trailerOk,
      partial: result.partial,
      cover: result.cover,
      trailer: result.trailer,
    });
    this.logger.info(
      "[collect] 完成 success=" +
        result.success +
        " cover=" +
        result.coverOk +
        " trailer=" +
        result.trailerOk +
        " reused=" +
        result.reused,
    );
    return result;
  }
}

module.exports = {
  CollectService,
  DEFAULT_OUTPUT_DIR,
  STEP_SCAN,
  STEP_COVER,
  STEP_TRAILER,
  STEP_DONE,
  STEP_DONE_PARTIAL,
  STEP_DONE_FAIL,
  VIDEO_EXTS,
  COVER_EXTS,
  UPLOADED_MARK,
};
