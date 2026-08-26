// lib/trailer.js —— 官方宣传片检索 / 打分筛选 / 下载 / 分辨率校验
//
// 严格对齐《素材搜集规则》「视频搜集」：
//   检索：yt-dlp --flat-playlist --dump-json "ytsearch10:{游戏名} official launch trailer"
//   筛选：官方频道（开发商 > 发行商 > 平台方）、Launch > Release Date > Announcement、
//         标识词 Official / Launch / 公式、时长 60~300 秒
//   下载：yt-dlp -f "bestvideo[height<=1080]+bestaudio/best[height<=1080]" --merge-output-format mp4
//   命名：lib/filename.js 的 buildLaunchTrailerName / buildMainVideoName
//   校验：ffprobe 读实际分辨率
//
// Bug B 根因之一的修复点：yt-dlp 不再硬编码成 'yt-dlp' 去撞系统 PATH，
// 一律使用 lib/env.js 解析出的 ytDlpPath（内置 material-hub/bin/yt-dlp.exe）。
//
// 缺陷 2 的修复点：yt-dlp 是**子进程**，Node 里设的代理对它无效，环境变量它也不一定认全。
// 因此检测到代理环境变量时，显式给它加 `--proxy <url>`（yt-dlp 原生支持该参数），
// 并同样尊重 NO_PROXY —— 判定逻辑复用 lib/http.js，与 Node 侧请求保持一致。
const { spawn: spawnDefault } = require("child_process");
const fsDefault = require("fs");
const path = require("path");
const { FilenameSanitizer, MAX_LEN } = require("./filename");
const { runCommand } = require("./runner");
const { resolveProxy, toProxyUrl } = require("./http");
let kdocsRemember = null;
function rememberSteamAppId(en, id, zhName) {
  try {
    if (!kdocsRemember) {
      const { rememberAppId } = require(
        path.join(__dirname, "..", "..", "kdocs-tool", "lib", "datapack.js"),
      );
      kdocsRemember = rememberAppId;
    }
    kdocsRemember(en, id, { zhName: zhName || "" });
  } catch (e) {
    /* 本地积累失败不影响主流程 */
  }
}

/**
 * 从宣传片标题里提取英文游戏名，作为封面检索的 fallback。
 *
 * 场景：Steam 国区 storesearch 搜不到中文名对应的 appid 时，
 * resolverEnglishTitle 只能退回原名；但此时宣传片搜索结果可能已经拿到了
 * 诸如 "Just Cause 4 - Launch Trailer | PS4" 的 YouTube 标题——
 * 这里面藏着准确的英文名，白嫖比什么都不做强。
 *
 * 策略：YouTube 宣传片标题的典型格式是 "{游戏名} - {trailer 类型} [| {频道}]"。
 * 取第一个 " - " 之前的部分，过一遍基础检查即可。
 *
 * @param {string} title YouTube 视频标题
 * @returns {string|null} 提取的英文游戏名；标题结构不对或中文为主时返回 null
 */
function extractEnglishName(title) {
  if (!title || typeof title !== "string") return null;
  const idx = title.indexOf(" - ");
  if (idx <= 0) return null;
  const name = title.slice(0, idx).trim();
  // 必须以拉丁字母开头且含至少 2 个字母（排除纯中文/纯日文标题，
  // 也排除 "Go" / "Ar 2" 这类短名被错杀的情况）。
  if (!/^[a-zA-Z]/.test(name)) return null;
  if (!/[a-zA-Z]{2}/.test(name)) return null;
  if (name.length < 2 || name.length > 80) return null;
  return name;
}

/** 检索关键词后缀（规范原文：{游戏名} official launch trailer）。 */
const SEARCH_SUFFIX = "official launch trailer";
/** 规范指定的检索条数：ytsearch10。 */
const SEARCH_LIMIT = 10;
/** 步骤名（SSE 事件 step 字段）。 */
const STEP_SEARCH = "搜索官方宣传片 (yt-dlp)";
const STEP_DOWNLOAD = "下载宣传片";
const STEP_TRANSCODE = "转码 .webm → .mp4";
const STEP_PROBE = "校验视频分辨率";
/** 子进程超时。 */
const TIMEOUT_SEARCH = 90 * 1000;
const TIMEOUT_DOWNLOAD = 20 * 60 * 1000;
/** 规范《视频搜集》筛选标准：时长 60~300 秒。 */
const DURATION_MIN = 60;
const DURATION_MAX = 300;
/** 规范《视频要求》：1080p。 */
const TARGET_HEIGHT = 1080;
/** 下载失败时最多依次尝试的候选数（年龄限制/网络失败自动换下一个）。 */
const TRAILER_DOWNLOAD_ATTEMPTS = 5;
/** 候选间切换的停顿（ms）：YouTube 403 多为限流，稍等再试下一个候选。 */
const RETRY_GAP_MS = 6000;
/**
 * 同候选内的格式降级链：YouTube 对 avc1(137) 流常做 403 限流，
 * 撞上后换一档格式重试，避免同一视频一次失败就放弃。
 * 0: 规范首选 H.264/AAC；1: 任意 mp4；2: 任意格式（webm 由转码兜底）。
 */
const FORMAT_TIERS = [
  "bestvideo[height<=1080][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]" +
    "/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]" +
    "/best[height<=1080]",
  "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]" + "/best[height<=1080]",
  "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
];
/** 判定「yt-dlp 该不该走代理」时使用的代表性目标地址（yt-dlp 全程只访问 YouTube）。 */
const PROXY_PROBE_URL = "https://www.youtube.com/";

/**
 * 规范《频道优先级》第 2 档：发行商官方频道。
 * 命中即认为是官方发布源（小写子串匹配）。
 */
const PUBLISHER_CHANNELS = [
  "nintendo",
  "electronic arts",
  "ea sports",
  "ubisoft",
  "bandai namco",
  "square enix",
  "capcom",
  "sega",
  "konami",
  "bethesda",
  "activision",
  "blizzard",
  "rockstar games",
  "2k",
  "devolver",
  "annapurna",
  "focus entertainment",
  "deep silver",
  "thq nordic",
  "paradox interactive",
  "team ninja",
  "koei tecmo",
  "fromsoftware",
  "cd projekt",
  "warner bros. games",
  "sony interactive",
  "game science",
  "游戏科学",
];
/** 规范《频道优先级》第 3 档：平台方频道。 */
const PLATFORM_CHANNELS = ["playstation", "xbox", "steam", "epic games", "nintendo of america"];
/** 规范《频道优先级》第 4 档：非官方高质量频道（可用，但需标注来源）。 */
const AGGREGATOR_CHANNELS = [
  "ign",
  "gamespot",
  "gametrailers",
  "gamesradar",
  "pc gamer",
  "game informer",
];
/** 明确排除的二创/搬运频道特征。 */
const BAD_CHANNEL_HINTS = [
  "reaction",
  "fan made",
  "fanmade",
  "concept",
  "unofficial",
  "edit",
  "amv",
];
/** 明确排除的标题特征（非宣传片正片）。 */
const BAD_TITLE_RE =
  /reaction|review|walkthrough|full\s*game|speedrun|let'?s\s*play|breakdown|analysis|parody|fan[\s-]?made|how\s*to/i;

/**
 * 规范《筛选标准》视频类型优先级：Launch > Release Date > Announcement。
 * 顺序敏感：第一条命中即取其分值，避免「Official Launch Trailer」被低档规则截胡。
 */
const TYPE_RULES = [
  { re: /launch\s*trailer/i, score: 50, kind: "launch" },
  { re: /official\s*trailer/i, score: 40, kind: "official" },
  { re: /公式\s*(?:トレーラー|pv|プロモーション)/i, score: 40, kind: "official-jp" },
  { re: /release\s*date\s*trailer/i, score: 35, kind: "release-date" },
  { re: /story\s*trailer/i, score: 28, kind: "story" },
  { re: /gameplay\s*trailer/i, score: 25, kind: "gameplay" },
  { re: /(?:announcement|reveal|teaser)\s*trailer/i, score: 20, kind: "announcement" },
  { re: /trailer|予告|宣传片|預告/i, score: 15, kind: "trailer" },
];

/**
 * 归一化文本用于比对（小写、去标点与空白）。
 * @param {string} raw 原始文本
 * @returns {string}
 */
function normalizeText(raw) {
  return String(raw == null ? "" : raw)
    .toLowerCase()
    .replace(/[：:：]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 简单的延迟工具（候选间限流停顿用）。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把游戏名切成可比对的词元（长度 >=2 的词，或单个 CJK 字符块）。
 * @param {string} gameName 游戏名
 * @returns {string[]}
 */
function nameTokens(gameName) {
  const norm = normalizeText(gameName);
  if (!norm) return [];
  return norm
    .split(" ")
    .filter((t) => t.length >= 2 || /^\d+$/.test(t) || /[\u4e00-\u9fa5\u3040-\u30ff]/.test(t));
}

/** 官方宣传片下载器。 */
class TrailerDownloader {
  /**
   * @param {{
   *   spawn?: Function, fs?: object, sanitizer?: FilenameSanitizer,
   *   probe?: object, ytDlpPath?: string|null, ffmpegPath?: string|null,
   *   env?: object, proxyUrl?: string
   * }} [deps] 依赖注入（单测用）；proxyUrl 显式覆盖自动探测，传空串表示强制不走代理
   */
  constructor(deps = {}) {
    this.spawn = deps.spawn || spawnDefault;
    this.fs = deps.fs || fsDefault;
    this.sanitizer = deps.sanitizer || new FilenameSanitizer();
    // MediaProbe，用于下载后按规范做分辨率校验；缺失时跳过校验但不阻断
    this.probe = deps.probe || null;
    this.ytDlpPath = deps.ytDlpPath || null;
    this.ffmpegPath = deps.ffmpegPath || null;
    this.ffprobePath = deps.ffprobePath || null;
    this.env = deps.env || process.env;
    this.proxyUrl = typeof deps.proxyUrl === "string" ? deps.proxyUrl : undefined;
    this.retryGapMs = deps.retryGapMs === undefined ? RETRY_GAP_MS : Number(deps.retryGapMs) || 0;
    this.fetchFn = deps.fetchFn || ((...a) => globalThis.fetch(...a));
    this.steamResolver = typeof deps.steamResolver === "function" ? deps.steamResolver : null;
  }

  /**
   * 注入 env.detect() 解析出的二进制路径（CollectService 在流程开始时调用）。
   * @param {{ytDlpPath?: string|null, ffmpegPath?: string|null}} paths 路径
   */
  setBinaries(paths = {}) {
    if (paths.ytDlpPath !== undefined) this.ytDlpPath = paths.ytDlpPath;
    if (paths.ffmpegPath !== undefined) this.ffmpegPath = paths.ffmpegPath;
    if (paths.ffprobePath !== undefined) this.ffprobePath = paths.ffprobePath;
  }

  /**
   * 取实际要执行的 yt-dlp 命令。
   * 绝不再硬编码 'yt-dlp' 去撞 PATH——那正是 Bug B 的根因之一；
   * 仅在完全没有解析到路径时才退回命令名，让上层的 env 检查去报错。
   * @returns {string}
   */
  ytDlpCmd() {
    return this.ytDlpPath || "yt-dlp";
  }

  /**
   * 取实际要执行的 ffmpeg 命令。
   * @returns {string}
   */
  ffmpegCmd() {
    return this.ffmpegPath || "ffmpeg";
  }

  /**
   * 解析 yt-dlp 该使用的代理地址。
   * 优先用构造时显式注入的 proxyUrl（空串 = 强制直连）；否则按 HTTPS_PROXY/HTTP_PROXY
   * 等环境变量自动探测，并尊重 NO_PROXY。
   * @param {string} [target=PROXY_PROBE_URL] 判定用的目标地址
   * @returns {string} 代理地址；直连时返回空串
   */
  resolveProxyUrl(target = PROXY_PROBE_URL) {
    if (typeof this.proxyUrl === "string") return this.proxyUrl;
    return toProxyUrl(resolveProxy(target, this.env));
  }

  /**
   * 检测到代理时给 yt-dlp 参数前置 `--proxy <url>`（yt-dlp 原生支持）。
   * 纯函数（除读取已注入的 env 外无副作用），可单测；
   * 参数放在最前面而不是插进中间，保证 buildSearchArgs/buildDownloadArgs 的原有顺序不被打乱。
   * @param {string[]} args 原始参数
   * @param {string} [target=PROXY_PROBE_URL] 判定用的目标地址
   * @returns {string[]} 可能带上 --proxy 的新数组（不修改入参）
   */
  withProxyArgs(args, target = PROXY_PROBE_URL) {
    const list = Array.isArray(args) ? args.slice() : [];
    const url = this.resolveProxyUrl(target);
    if (!url) return list;
    if (list.indexOf("--proxy") >= 0) return list;
    return ["--proxy", url].concat(list);
  }

  // ─────────────────── 纯函数：参数构造 / 结果解析 / 打分筛选 ───────────────────

  /**
   * 构造 yt-dlp 检索参数（规范：ytsearch10 + --flat-playlist + --dump-json）。
   * @param {string} name 游戏名
   * @param {{limit?: number, suffix?: string}} [opts]
   * @returns {string[]}
   */
  buildSearchArgs(name, opts = {}) {
    const limit =
      Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : SEARCH_LIMIT;
    const suffix = opts.suffix === undefined ? SEARCH_SUFFIX : String(opts.suffix || "");
    const term = String(name == null ? "" : name).trim();
    const query = suffix ? term + " " + suffix : term;
    return [
      "ytsearch" + limit + ":" + query,
      "--flat-playlist",
      "--dump-json",
      "--no-warnings",
      "--skip-download",
    ];
  }

  /**
   * 解析 `--flat-playlist --dump-json` 的输出。
   * 该组合输出 NDJSON（每行一个视频对象），不是单个 JSON 文档——
   * 这正是必须替换掉旧 `--dump-single-json` 解析逻辑的原因。
   * 同时兼容单文档/带 entries 的历史形态，容错不崩。
   * @param {string} raw stdout 文本
   * @returns {Array<{id: string, title: string, url: string, duration: number, channel: string, verified: boolean}>}
   */
  parseSearchResults(raw) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) return [];
    const objs = [];
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s[0] !== "{") continue;
      try {
        const o = JSON.parse(s);
        if (o && typeof o === "object") {
          if (Array.isArray(o.entries))
            objs.push(...o.entries.filter((e) => e && typeof e === "object"));
          else objs.push(o);
        }
      } catch (e) {
        /* 单行坏 JSON 不影响其它行 */
      }
    }
    return objs.map((it) => this.normalizeEntry(it)).filter((it) => it != null);
  }

  /**
   * 把 yt-dlp 条目归一化成内部结构。
   * flat-playlist 模式下 `url` 可能只是视频 id，需要补全成完整 watch 链接。
   * @param {object} item yt-dlp 输出的单条
   * @returns {{id: string, title: string, url: string, duration: number, channel: string, verified: boolean}|null}
   */
  normalizeEntry(item) {
    if (!item || typeof item !== "object" || !item.id) return null;
    const id = String(item.id);
    let url = String(item.webpage_url || item.url || "");
    if (!/^https?:\/\//i.test(url)) url = "https://www.youtube.com/watch?v=" + id;
    const duration = Number.isFinite(Number(item.duration)) ? Number(item.duration) : 0;
    return {
      id,
      title: String(item.title || item.fulltitle || id),
      url,
      duration,
      channel: String(item.channel || item.uploader || item.playlist_uploader || ""),
      verified: item.channel_is_verified === true,
      thumb: String(
        item.thumbnail ||
          (Array.isArray(item.thumbnails) && item.thumbnails[0] && item.thumbnails[0].url) ||
          "",
      ),
    };
  }

  /**
   * 频道档位打分（规范《频道优先级》1 开发商 > 2 发行商 > 3 平台方 > 4 非官方高质量）。
   * 开发商名单无法内建（逐游戏而异），故由 opts.developer 传入；
   * 未传时用「频道名包含游戏名」作为开发商/官方作品频道的近似判据。
   * @param {string} channel 频道名
   * @param {string} gameName 游戏名
   * @param {{developer?: string}} [opts]
   * @returns {{score: number, tier: string}}
   */
  scoreChannel(channel, gameName, opts = {}) {
    const ch = normalizeText(channel);
    if (!ch) return { score: 0, tier: "unknown" };

    if (BAD_CHANNEL_HINTS.some((k) => ch.includes(k))) return { score: -40, tier: "bad" };

    const dev = normalizeText(opts.developer);
    if (dev && ch.includes(dev)) return { score: 45, tier: "developer" };

    // 频道名里含游戏名 → 大概率是该作/该系列的官方频道
    const tokens = nameTokens(gameName);
    if (tokens.length && tokens.every((t) => ch.includes(t)))
      return { score: 40, tier: "developer" };

    if (PUBLISHER_CHANNELS.some((k) => ch.includes(k))) return { score: 30, tier: "publisher" };
    if (PLATFORM_CHANNELS.some((k) => ch.includes(k))) return { score: 20, tier: "platform" };
    if (AGGREGATOR_CHANNELS.some((k) => ch.includes(k))) return { score: 5, tier: "aggregator" };
    return { score: 0, tier: "unknown" };
  }

  /**
   * 标题类型打分（规范：Launch Trailer > Release Date Trailer > Announcement Trailer）。
   * @param {string} title 视频标题
   * @returns {{score: number, kind: string}}
   */
  scoreTitleType(title) {
    const t = String(title == null ? "" : title);
    for (const rule of TYPE_RULES) {
      if (rule.re.test(t)) return { score: rule.score, kind: rule.kind };
    }
    return { score: 0, kind: "none" };
  }

  /**
   * 时长打分（规范《筛选标准》：60~300 秒）。
   * duration=0 表示 flat-playlist 未给出时长，按中性处理，不惩罚。
   * @param {number} duration 秒
   * @returns {number}
   */
  scoreDuration(duration) {
    const d = Number(duration);
    if (!Number.isFinite(d) || d <= 0) return 0;
    if (d >= DURATION_MIN && d <= DURATION_MAX) return 20;
    if (d >= 30 && d < DURATION_MIN) return 5;
    if (d > DURATION_MAX && d <= 600) return -15;
    return -25;
  }

  /**
   * 对单个候选综合打分（纯函数，可单测）。
   * @param {object} item normalizeEntry 后的候选
   * @param {string} gameName 游戏名
   * @param {{developer?: string}} [opts]
   * @returns {{score: number, kind: string, tier: string, reasons: string[]}}
   */
  scoreCandidate(item, gameName, opts = {}) {
    const reasons = [];
    if (!item || !item.id)
      return { score: -Infinity, kind: "none", tier: "none", reasons: ["无效条目"] };

    const title = String(item.title || "");
    const type = this.scoreTitleType(title);
    const chan = this.scoreChannel(item.channel, gameName, opts);
    const dur = this.scoreDuration(item.duration);
    let score = type.score + chan.score + dur;
    if (type.score) reasons.push("类型 " + type.kind + " +" + type.score);
    if (chan.score)
      reasons.push("频道 " + chan.tier + " " + (chan.score > 0 ? "+" : "") + chan.score);
    if (dur) reasons.push("时长 " + (dur > 0 ? "+" : "") + dur);

    // 规范《筛选标准》标识词：Official / Launch / 公式
    if (/\bofficial\b|公式/i.test(title)) {
      score += 15;
      reasons.push("标识词 official +15");
    }
    // 平台认证账号
    if (item.verified === true) {
      score += 10;
      reasons.push("认证频道 +10");
    }

    // 标题包含游戏名 → 强相关；完全不含 → 很可能是搜索噪声
    const tokens = nameTokens(gameName);
    const normTitle = normalizeText(title);
    if (tokens.length) {
      const hit = tokens.filter((t) => normTitle.includes(t)).length;
      if (hit === tokens.length) {
        score += 25;
        reasons.push("标题全词匹配 +25");
      } else if (hit > 0) {
        score += 10;
        reasons.push("标题部分匹配 +10");
      } else {
        score -= 20;
        reasons.push("标题不含游戏名 -20");
      }
      // 数字序号缺失（如 "PC Building Simulator 2" 漏掉 "2"）→ 强惩罚，避免命中前作/他作预告
      const numMiss = tokens.filter((t) => /^\d+$/.test(t) && !normTitle.includes(t)).length;
      if (numMiss > 0) {
        const p = 25 * numMiss;
        score -= p;
        reasons.push("标题缺游戏序号 -" + p);
      }
    }

    if (BAD_TITLE_RE.test(title)) {
      score -= 50;
      reasons.push("非正片特征 -50");
    }

    return { score, kind: type.kind, tier: chan.tier, reasons };
  }

  /**
   * 从候选列表里挑最佳（纯函数，可单测）。
   * 同分时保持 yt-dlp 原始相关度序（稳定排序）。
   * @param {Array<object>} items 候选列表
   * @param {string} gameName 游戏名
   * @param {{developer?: string, minScore?: number}} [opts] minScore 默认 0，低于该分视为不可用
   * @returns {object|null} 附带 score/kind/tier/reasons 的最佳候选；无可用返回 null
   */
  pickBest(items, gameName, opts = {}) {
    const list = Array.isArray(items) ? items.filter((i) => i && i.id) : [];
    if (!list.length) return null;
    const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0;
    const scored = list.map((item, idx) => {
      const s = this.scoreCandidate(item, gameName, opts);
      return { item, idx, score: s.score, kind: s.kind, tier: s.tier, reasons: s.reasons };
    });
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
    const best = scored[0];
    if (!best || best.score < minScore) return null;
    return Object.assign({}, best.item, {
      score: best.score,
      kind: best.kind,
      tier: best.tier,
      reasons: best.reasons,
    });
  }

  /**
   * 按规范打分对候选排序，返回完整排序列表（最优在前）。
   * 供「下载失败自动换下一个候选」使用；pickBest 只取第一条，语义一致。
   * @param {Array<object>} items yt-dlp 检索结果
   * @param {string} gameName 游戏名
   * @param {{developer?: string, minScore?: number}} [opts]
   * @returns {Array<object>} 带 score/kind/tier/reasons 的候选数组（已按分数降序）
   */
  rankCandidates(items, gameName, opts = {}) {
    const list = Array.isArray(items) ? items.filter((i) => i && i.id) : [];
    const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0;
    const scored = list.map((item, idx) => {
      const s = this.scoreCandidate(item, gameName, opts);
      return Object.assign({}, item, {
        score: s.score,
        kind: s.kind,
        tier: s.tier,
        reasons: s.reasons,
        idx,
      });
    });
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
    return scored.filter((c) => c.score >= minScore);
  }

  /**
   * 构造 yt-dlp 下载参数（逐字对齐规范《搜索策略》第 3 步给出的命令）。
   * 无 ffmpeg 时无法合流，只能退到单文件流。
   * @param {string} url 视频页地址
   * @param {string} outPath 输出文件完整路径（含 .mp4）
   * @param {{ffmpeg?: boolean}} [env] 外部依赖可用性
   * @returns {string[]}
   */
  buildDownloadArgs(url, outPath, env = {}, formatTier = 0) {
    const hasFfmpeg = env.ffmpeg !== false;
    const tier = Math.min(Math.max(Number(formatTier) || 0, 0), FORMAT_TIERS.length - 1);
    const format = hasFfmpeg ? FORMAT_TIERS[tier] : "best[height<=" + TARGET_HEIGHT + "]";
    const args = ["-f", format];
    if (hasFfmpeg) args.push("--merge-output-format", "mp4");
    args.push("--no-playlist", "--no-warnings", "--newline", "--no-part");
    args.push("--retries", "2", "--fragment-retries", "3", "--retry-sleep", "2");
    args.push("-o", outPath, url);
    return args;
  }

  /**
   * Steam 商店页专用下载参数：HLS/DASH 源用通用 1080p 选择器（无 H.264 限制）。
   * @param {string} url 商店页地址
   * @param {string} outPath 输出文件路径
   * @param {{ffmpeg?: boolean}} [env] 外部依赖可用性
   * @returns {string[]}
   */
  buildSteamDownloadArgs(url, outPath, env = {}) {
    const hasFfmpeg = env.ffmpeg !== false;
    const format = hasFfmpeg
      ? "bestvideo[height<=1080]+bestaudio/best[height<=1080]"
      : "best[height<=1080]";
    const args = ["-f", format];
    if (hasFfmpeg) args.push("--merge-output-format", "mp4");
    args.push("--no-playlist", "--no-warnings", "--newline", "--no-part");
    args.push("--retries", "2", "--fragment-retries", "3", "--retry-sleep", "2");
    args.push("-o", outPath, url);
    return args;
  }

  /**
   * 是否需要转码（规则：.webm → .mp4）。
   * @param {string} file 文件名或路径
   * @returns {boolean}
   */
  needsTranscode(file) {
    return /\.webm$/i.test(String(file == null ? "" : file));
  }

  /**
   * 构造 ffmpeg 转码参数（视频流直拷、音频转 aac）。
   * @param {string} input 输入 .webm 路径
   * @param {string} output 输出 .mp4 路径
   * @returns {string[]}
   */
  buildTranscodeArgs(input, output) {
    return ["-y", "-i", input, "-c:v", "copy", "-c:a", "aac", output];
  }

  /**
   * 在目录中按基名查找实际产出文件（yt-dlp 可能因合流失败换扩展名）。
   * @param {string} dir 目录
   * @param {string} base 不含扩展名的基名
   * @returns {string|null} 文件名；未找到返回 null
   */
  findDownloaded(dir, base) {
    let entries = [];
    try {
      entries = this.fs.readdirSync(dir);
    } catch (e) {
      return null;
    }
    const prefix = base + ".";
    const hit = (Array.isArray(entries) ? entries : []).filter(
      (n) => n.startsWith(prefix) && !/\.(part|ytdl|temp)$/i.test(n) && !/\.f\d+(\.\w+)?$/i.test(n),
    );
    if (!hit.length) return null;
    hit.sort((a, b) => (/\.mp4$/i.test(b) ? 1 : 0) - (/\.mp4$/i.test(a) ? 1 : 0));
    return hit[0];
  }

  /**
   * 清理指定基名的 yt-dlp 中间产物（.fNNN / .part / .ytdl / .temp）。
   * 下载失败（如 HTTP 403 中断）会残留半成品 .f299.mp4，必须清掉避免误当成品/多视频落盘。
   * @param {string} dir 目录
   * @param {string} base 不含扩展名的基名
   */
  cleanupTrailerArtifacts(dir, base) {
    let entries = [];
    try {
      entries = this.fs.readdirSync(dir);
    } catch (e) {
      return;
    }
    const prefix = base + ".";
    for (const n of Array.isArray(entries) ? entries : []) {
      if (!n.startsWith(prefix)) continue;
      if (/\.f\d+(\.\w+)?$|\.(part|ytdl|temp)$/i.test(n)) {
        try {
          this.fs.unlinkSync(path.join(dir, n));
        } catch (e) {
          /* 删不掉不影响结果 */
        }
      }
    }
  }

  /**
   * 按规范《视频命名规范》生成目标文件名。
   * @param {string} gameName 游戏名
   * @param {{index?: number, kind?: string, englishName?: string, versionDesc?: string}} [opts]
   *   kind='main' 用主视频命名，其余用 Launch Trailer 命名
   * @returns {string} 形如 '【游戏267】忍者龙剑传4 The Two Masters Launch Trailer 免费学习版下载.mp4'
   */
  buildTargetName(gameName, opts = {}) {
    const index = Number.isFinite(Number(opts.index)) ? Number(opts.index) : 0;
    if (opts.kind === "main") {
      return this.sanitizer.buildMainVideoName(index, gameName, { versionDesc: opts.versionDesc });
    }
    return this.sanitizer.buildLaunchTrailerName(index, gameName, {
      englishName: opts.englishName,
    });
  }

  /**
   * 生成下载输出文件名：优先用候选视频的原始 YouTube 标题（用户要求「就用原始视频名，不用再重命名」），
   * 无标题时退回规范命名（buildTargetName）兜底。
   * @param {object} info 候选（含 title）
   * @param {string} name 游戏名
   * @param {object} [opts] buildTargetName 兜底参数
   * @returns {string} 形如 'Warhammer 40,000_ Space Marine 2 - Launch Trailer.mp4'
   */
  buildOutputName(info, name, opts = {}) {
    const rawTitle = String((info && info.title) || "").trim();
    if (rawTitle) {
      return this.sanitizer.sanitize(rawTitle, { space: "keep", max: MAX_LEN - 4 }) + ".mp4";
    }
    return this.buildTargetName(name, opts);
  }

  // ─────────────────── 带 IO 的方法 ───────────────────

  /**
   * 检索并按规范打分挑出最佳官方宣传片。
   * @param {string} name 游戏名
   * @param {{emit?: Function, limit?: number, developer?: string, minScore?: number}} [opts]
   * @returns {Promise<object|null>} 最佳候选（含 score/kind/tier）；无命中返回 null
   */
  async searchTrailerCandidates(name, opts = {}) {
    const emit = typeof opts.emit === "function" ? opts.emit : () => {};
    // 本机直连 YouTube 可能被墙，检测到代理就显式传给 yt-dlp 子进程
    const args = this.withProxyArgs(this.buildSearchArgs(name, { limit: opts.limit }));
    const proxyUrl = this.resolveProxyUrl();
    if (proxyUrl) {
      emit("log", STEP_SEARCH, "[yt-dlp] 经代理访问：" + proxyUrl, null, { level: "info" });
    }
    emit("trailer_search", STEP_SEARCH, "检索 “" + name + " " + SEARCH_SUFFIX + "”…", null, {
      limit: Number.isFinite(opts.limit) ? opts.limit : SEARCH_LIMIT,
      proxy: proxyUrl,
    });

    let r = null;
    try {
      r = await runCommand(this.ytDlpCmd(), args, {
        spawn: this.spawn,
        timeout: TIMEOUT_SEARCH,
        env: Object.assign({}, process.env, { PYTHONUTF8: "1" }),
        onLine: (line, stream) => {
          if (stream === "stderr")
            emit("log", STEP_SEARCH, "[yt-dlp] " + line, null, { level: "info" });
        },
      });
    } catch (e) {
      emit("log", STEP_SEARCH, "[yt-dlp] 检索失败：" + e.message, null, { level: "err" });
      return null;
    }

    const items = this.parseSearchResults(r.stdout);
    if (!items.length) {
      emit("trailer_search", STEP_SEARCH, "未检索到候选视频", null);
      return null;
    }
    const candidates = this.rankCandidates(items, name, {
      developer: opts.developer,
      minScore: opts.minScore,
    });
    if (!candidates.length) {
      emit(
        "trailer_search",
        STEP_SEARCH,
        "检索到 " + items.length + " 条，但均不满足官方宣传片筛选标准",
        null,
        {
          total: items.length,
        },
      );
      return null;
    }
    const best = candidates[0];
    emit(
      "trailer_search",
      STEP_SEARCH,
      "命中 " +
        (best.channel ? best.channel + " · " : "") +
        best.title +
        "（评分 " +
        best.score +
        "）",
      null,
      {
        title: best.title,
        url: best.url,
        channel: best.channel,
        score: best.score,
        kind: best.kind,
        tier: best.tier,
        total: items.length,
      },
    );
    return candidates;
  }

  /**
   * 检索并按规范筛选宣传片，返回最佳候选。
   * @param {string} name 游戏名
   * @param {{emit?: Function, limit?: number, developer?: string, minScore?: number}} [opts]
   * @returns {Promise<object|null>} 最佳候选（含 score/kind/tier）；无命中返回 null
   */
  async searchTrailer(name, opts = {}) {
    const list = await this.searchTrailerCandidates(name, opts);
    return list && list.length ? list[0] : null;
  }

  /**
   * 下载宣传片并按规范命名 + 校验分辨率。
   * @param {string} name 游戏名
   * @param {string} dir 目标目录
   * @param {{ytDlp?: boolean, ffmpeg?: boolean}} [env] 外部依赖可用性
   * @param {{
   *   info?: object, emit?: Function, index?: number,
   *   kind?: string, englishName?: string, versionDesc?: string, developer?: string
   * }} [opts]
   * @returns {Promise<{
   *   ok: boolean, file?: string, path?: string, title?: string, url?: string,
   *   width?: number, height?: number, hd?: boolean, error?: string, reason?: string
   * }>}
   */
  async download(name, dir, env = {}, opts = {}) {
    const emit = typeof opts.emit === "function" ? opts.emit : () => {};
    if (env.ytDlp === false) {
      return { ok: false, reason: "yt-dlp-not-found", error: "未检测到 yt-dlp，无法下载宣传片" };
    }

    // 候选来源优先级：显式候选列表（collect.js 传入完整排序）> 单个 info > 重新检索
    let candidates = Array.isArray(opts.candidates) ? opts.candidates : [];
    if (!candidates.length && opts.info) candidates = [opts.info];
    if (!candidates.length) {
      const list = await this.searchTrailerCandidates(name, { emit, developer: opts.developer });
      candidates = list || [];
    }
    if (!candidates.length) {
      return { ok: false, reason: "trailer-not-found", error: "未搜索到符合规范的官方宣传片" };
    }
    // 去重 + 限制尝试次数（下载失败自动换下一个候选，年龄限制/网络失败不再直接判死）
    const seen = new Set();
    const list = [];
    for (const c of candidates) {
      const url = String((c && c.url) || "").trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      list.push(c);
      if (list.length >= TRAILER_DOWNLOAD_ATTEMPTS) break;
    }

    let last = null;
    for (let i = 0; i < list.length; i += 1) {
      const info = list[i];
      // 文件名：直接用候选视频的原始标题（不再套规范重命名）；无标题退回规范命名兜底
      const targetName = this.buildOutputName(info, name, opts);
      const base = targetName.replace(/\.[^.]+$/, "");
      const outPath = path.join(dir, targetName);
      const multi = list.length > 1;
      // 同候选内格式降级重试：撞上 YouTube 403 限流自动换一档格式，不直接放弃
      let produced = null;
      for (let tier = 0; tier < FORMAT_TIERS.length; tier += 1) {
        // Steam 商店页走通用格式选择（HLS/DASH），YouTube 才走 H.264 降级链
        const isSteam = String(info.url || "").indexOf("store.steampowered.com/app/") >= 0;
        const args = this.withProxyArgs(
          isSteam
            ? this.buildSteamDownloadArgs(info.url, outPath, env)
            : this.buildDownloadArgs(info.url, outPath, env, tier),
        );
        emit(
          "trailer_download",
          STEP_DOWNLOAD,
          "下载 1080p mp4：" +
            targetName +
            (multi ? "（候选 " + (i + 1) + "/" + list.length + "）" : "") +
            (tier > 0 ? "（格式档 " + (tier + 1) + "/" + FORMAT_TIERS.length + "）" : ""),
          null,
          {
            url: info.url,
            title: info.title,
            file: targetName,
            proxy: this.resolveProxyUrl(),
            attempt: i + 1,
            total: list.length,
            tier: tier + 1,
          },
        );
        let r = null;
        try {
          r = await runCommand(this.ytDlpCmd(), args, {
            spawn: this.spawn,
            timeout: TIMEOUT_DOWNLOAD,
            env: Object.assign({}, process.env, { PYTHONUTF8: "1" }),
            onLine: (line) =>
              emit("log", STEP_DOWNLOAD, "[yt-dlp] " + line, null, { level: "info" }),
          });
        } catch (e) {
          last = { ok: false, reason: "yt-dlp-failed", error: "yt-dlp 执行失败：" + e.message };
          continue;
        }

        produced = this.findDownloaded(dir, base);
        if (r.code !== 0 || !produced) {
          // 失败时清掉该候选的残留：成品 + .fNNN/.part/.ytdl 等中间产物（403 中断会留半成品）
          this.cleanupTrailerArtifacts(dir, base);
          if (produced) {
            try {
              this.fs.unlinkSync(path.join(dir, produced));
            } catch (e) {
              /* 删不掉不影响结果 */
            }
          }
          last = {
            ok: false,
            reason: r.code !== 0 ? "yt-dlp-failed" : "trailer-file-missing",
            error: r.code !== 0 ? "yt-dlp 退出码 " + r.code : "下载完成但未找到产出文件",
          };
          if (tier < FORMAT_TIERS.length - 1) {
            emit(
              "log",
              STEP_DOWNLOAD,
              "[trailer] 候选 " +
                (i + 1) +
                " 格式档 " +
                (tier + 1) +
                " 失败（" +
                last.error +
                "），换格式重试…",
              null,
              { level: "warn" },
            );
          }
          continue;
        }
        break;
      }
      if (!produced) {
        if (i < list.length - 1) {
          emit(
            "log",
            STEP_DOWNLOAD,
            "[trailer] 候选 " + (i + 1) + " 失败（" + (last && last.error) + "），尝试下一个候选…",
            null,
            { level: "warn" },
          );
        }
        // 403 多为 YouTube 限流：短暂停顿再换下一个候选，降低连续触发概率
        if (i < list.length - 1 && this.retryGapMs > 0) await sleep(this.retryGapMs);
        continue;
      }

      const result = {
        ok: true,
        file: produced,
        path: path.join(dir, produced),
        title: info.title,
        url: info.url,
        channel: info.channel || "",
        score: info.score,
        attempts: i + 1,
      };

      // 素材规范：统一归一化为 H.264+AAC mp4（yt-dlp 已优先 H.264 直下，来源不合规时保底转码）
      const norm = await this.normalizeToH264(result.path, env, { emit });
      if (norm.error) {
        last = { ok: false, reason: "normalize-failed", error: norm.error };
        if (i < list.length - 1) {
          emit(
            "log",
            STEP_DOWNLOAD,
            "[trailer] 候选 " + (i + 1) + " 转码失败（" + norm.error + "），尝试下一个候选…",
            null,
            { level: "warn" },
          );
        }
        continue;
      }
      if (norm.converted) {
        emit(
          "trailer_download",
          STEP_DOWNLOAD,
          "已转码为 H.264/AAC（" + (norm.from || "未知") + " → h264）",
          true,
          { converted: true, from: norm.from },
        );
      }

      // 规范《最终验证》：确认分辨率
      const probed = await this.probeResolution(result.path, { emit });
      if (probed.ok) {
        result.width = probed.width;
        result.height = probed.height;
        result.hd = probed.height >= TARGET_HEIGHT;
      }
      return result;
    }
    return last || { ok: false, reason: "yt-dlp-failed", error: "宣传片下载失败" };
  }

  /**
   * 用 ffprobe 校验已下载视频的实际分辨率（probe 缺失时静默跳过）。
   * @param {string} file 视频路径
   * @param {{emit?: Function}} [opts]
   * @returns {Promise<{ok: boolean, width?: number, height?: number, error?: string}>}
   */
  async probeResolution(file, opts = {}) {
    const emit = typeof opts.emit === "function" ? opts.emit : () => {};
    if (!this.probe || typeof this.probe.probeSize !== "function") {
      return { ok: false, error: "未注入 MediaProbe，跳过分辨率校验" };
    }
    let r = null;
    try {
      r = await this.probe.probeSize(file, { emit, step: STEP_PROBE });
    } catch (e) {
      return { ok: false, error: "ffprobe 异常：" + e.message };
    }
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || "ffprobe 未返回分辨率" };
    const hd = r.height >= TARGET_HEIGHT;
    emit(
      "trailer_probe",
      STEP_PROBE,
      "实际分辨率 " + r.width + "×" + r.height + (hd ? "（达标）" : "（低于 1080p）"),
      hd ? true : null,
      {
        width: r.width,
        height: r.height,
        hd,
      },
    );
    return { ok: true, width: r.width, height: r.height };
  }

  /**
   * 归一化预告片为 H.264+AAC mp4（素材规范）。已合规（h264+aac）则原样返回。
   * 转换写临时文件，成功后才替换，避免破坏半成品。
   */
  async normalizeToH264(file, env = {}, opts = {}) {
    const emit = typeof opts.emit === "function" ? opts.emit : () => {};
    const ffprobe = this.ffprobePath || env.ffprobePath || "ffprobe";
    const ffmpeg = this.ffmpegPath || env.ffmpegPath || "ffmpeg";
    let r = null;
    try {
      r = await runCommand(
        ffprobe,
        ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", file],
        { spawn: this.spawn, timeout: 60000 },
      );
    } catch (e) {
      return { converted: false, error: "ffprobe 异常：" + e.message };
    }
    let vcodec = "";
    let acodec = "";
    try {
      const j = JSON.parse(r.stdout || "{}");
      for (const s of j.streams || []) {
        if (s.codec_type === "video" && !vcodec) vcodec = String(s.codec_name || "");
        if (s.codec_type === "audio" && !acodec) acodec = String(s.codec_name || "");
      }
    } catch (e) {
      /* JSON 解析失败按不合规处理 */
    }
    if (!vcodec) return { converted: false, vcodec, acodec, skipped: true }; // 探测不出编码 → 不干预
    if (vcodec === "h264" && (!acodec || acodec === "aac")) {
      return { converted: false, vcodec, acodec };
    }
    const fsm = this.fs && typeof this.fs.existsSync === "function" ? this.fs : fsDefault;
    const tmp = file + ".norm.mp4";
    emit(
      "log",
      STEP_DOWNLOAD,
      "[trailer] 转码为 H.264/AAC（" + (vcodec || "未知") + " → h264）…",
      null,
      { level: "info" },
    );
    try {
      r = await runCommand(
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
          tmp,
        ],
        { spawn: this.spawn, timeout: 20 * 60 * 1000 },
      );
    } catch (e) {
      return { converted: false, error: "ffmpeg 异常：" + e.message };
    }
    if (r.code !== 0 || !fsm.existsSync(tmp)) {
      return { converted: false, error: "ffmpeg 转码失败（退出码 " + r.code + "）" };
    }
    try {
      fsm.unlinkSync(file);
    } catch (e) {
      /* ignore */
    }
    try {
      fsm.renameSync(tmp, file);
    } catch (e) {
      try {
        fsm.copyFileSync(tmp, file);
        fsm.unlinkSync(tmp);
      } catch (e2) {
        /* ignore */
      }
    }
    return { converted: true, vcodec, acodec };
  }

  /**
   * 按需把 .webm 转成 .mp4（合流成功时通常用不到，作为保险留存）。
   * @param {string} file 已下载的文件名
   * @param {string} dir 所在目录
   * @param {{ffmpeg?: boolean}} [env] 外部依赖可用性
   * @param {{emit?: Function}} [opts]
   * @returns {Promise<{file: string, converted: boolean, reason?: string, error?: string}>}
   */
  async transcodeIfNeeded(file, dir, env = {}, opts = {}) {
    const emit = typeof opts.emit === "function" ? opts.emit : () => {};
    if (!this.needsTranscode(file)) return { file, converted: false };
    if (env.ffmpeg === false) {
      emit("trailer_transcode", STEP_TRANSCODE, "未检测到 ffmpeg，保留 .webm 原文件", null, {
        reason: "ffmpeg-not-found",
      });
      return { file, converted: false, reason: "ffmpeg-not-found" };
    }
    const input = path.join(dir, file);
    const outName = file.replace(/\.webm$/i, ".mp4");
    const output = path.join(dir, outName);
    emit("trailer_transcode", STEP_TRANSCODE, "ffmpeg 转码中…", null, { from: file, to: outName });
    let r = null;
    try {
      r = await runCommand(this.ffmpegCmd(), this.buildTranscodeArgs(input, output), {
        spawn: this.spawn,
        timeout: TIMEOUT_DOWNLOAD,
        onLine: (line) => emit("log", STEP_TRANSCODE, "[ffmpeg] " + line, null, { level: "info" }),
      });
    } catch (e) {
      emit("trailer_transcode", STEP_TRANSCODE, "ffmpeg 转码失败，保留 .webm：" + e.message, null, {
        reason: "ffmpeg-failed",
      });
      return { file, converted: false, reason: "ffmpeg-failed", error: e.message };
    }
    if (r.code !== 0) {
      emit("trailer_transcode", STEP_TRANSCODE, "ffmpeg 退出码 " + r.code + "，保留 .webm", null, {
        reason: "ffmpeg-failed",
      });
      return { file, converted: false, reason: "ffmpeg-failed", error: "ffmpeg 退出码 " + r.code };
    }
    try {
      this.fs.unlinkSync(input);
    } catch (e) {
      /* 删不掉原文件不影响结果 */
    }
    emit("trailer_transcode", STEP_TRANSCODE, "已转为 " + outName, true, {
      file: outName,
      converted: true,
    });
    return { file: outName, converted: true };
  }

  /**
   * 从 Steam 商店页下载官方预告片（yt-dlp Steam extractor）。
   * 当 YouTube 没搜到合适结果时，如果有 Steam appid 就走这条通路。
   * yt-dlp 的 Steam 提取器支持直接传商店页 URL，自动解析视频。
   */
  async downloadFromSteam(name, dir, env = {}, opts = {}) {
    const emit = typeof opts.emit === "function" ? opts.emit : () => {};
    let appId = String(opts.steamAppId || "").trim();
    // appid 可能是商店搜索的误判（如解析成其它游戏）→ 先校验，无效则用游戏名重新搜索
    if (appId && !(await this.verifySteamAppId(appId))) {
      emit("log", STEP_DOWNLOAD, "[steam] appid=" + appId + " 无效，用游戏名重新搜索…", null, {
        level: "warn",
      });
      appId = "";
    }
    if (!appId) {
      // 优先用 cover 的完整反查（离线映射 + 版本词剥离 + 相关性过滤），无注入时用内置简化版
      appId = this.steamResolver
        ? await this.steamResolver(name)
        : await this.resolveSteamAppId(name);
      if (!appId) {
        return { ok: false, reason: "steam-no-appid", error: "未找到有效的 Steam appid" };
      }
    }
    // 本地积累：把本次成功解析的「英文名 → appid」写进共用离线缓存，下次免联网
    rememberSteamAppId(name, appId, opts.originalName || "");
    const url = "https://store.steampowered.com/app/" + appId + "/";
    emit("log", STEP_DOWNLOAD, "[steam] 搜索 Steam 商店页预告片…", null, { level: "info", url });
    const r = await runCommand(
      this.ytDlpCmd(),
      ["--no-warnings", "--dump-json", "--playlist-end", "1", url],
      { timeout: 30000, env: Object.assign({}, process.env, { PYTHONUTF8: "1" }) },
    );
    if (r.code !== 0 || !r.stdout) {
      return { ok: false, reason: "steam-extract-failed", error: "yt-dlp Steam 提取失败" };
    }
    // 解析 Steam 提取的 JSON（可能有多行）
    const lines = r.stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const info = JSON.parse(line);
        if (info.id) {
          emit("trailer_search", STEP_SEARCH, "Steam 命中：" + (info.title || ""), null, {
            title: info.title,
            url,
            channel: "Steam",
            source: "steam",
          });
          // 复用 download 方法去下载
          return this.download(name, dir, env, {
            info: Object.assign({}, info, { channel: "Steam", source: "steam" }),
            emit,
            index: opts.index,
            kind: opts.kind,
            englishName: opts.englishName,
            versionDesc: opts.versionDesc,
            steamUrl: url,
          });
        }
      } catch (e) {
        /* skip bad lines */
      }
    }
    return { ok: false, reason: "steam-no-video", error: "Steam 商店页无明显预告片" };
  }

  /**
   * 校验 Steam appid 是否真实有效（避免搜索误判拿到其它游戏/声轨）。
   * @param {string} appId
   * @returns {Promise<boolean>}
   */
  async verifySteamAppId(appId) {
    const id = String(appId || "").trim();
    if (!/^\d+$/.test(id)) return false;
    try {
      const r = await this.fetchFn(
        "https://store.steampowered.com/api/appdetails?appids=" + id + "&l=schinese",
        { timeout: 15000, signal: AbortSignal.timeout(15000) },
      );
      if (!r.ok) return false;
      const j = await r.json();
      const app = j && j[id];
      return !!(app && app.success && app.data && app.data.type === "game");
    } catch (e) {
      return false;
    }
  }

  /**
   * 用游戏名反查 Steam appid（Steam 商店搜索接口，stablesearch）。
   * @param {string} name 游戏名
   * @returns {Promise<string>} appid 字符串；找不到返回空串
   */
  async resolveSteamAppId(name) {
    const q = String(name || "").trim();
    if (!q) return "";
    try {
      const r = await this.fetchFn(
        "https://store.steampowered.com/api/storesearch/?term=" +
          encodeURIComponent(q) +
          "&l=schinese&cc=CN",
        { timeout: 15000, signal: AbortSignal.timeout(15000) },
      );
      if (!r.ok) return "";
      const j = await r.json();
      const items = (j && j.items) || [];
      const hit = items.find((it) => it && it.type === "app" && it.id);
      return hit ? String(hit.id) : "";
    } catch (e) {
      return "";
    }
  }
}

module.exports = {
  TrailerDownloader,
  // 从 lib/runner.js 再导出，保持既有 require('./trailer').runCommand 调用点不破
  runCommand,
  normalizeText,
  nameTokens,
  SEARCH_SUFFIX,
  SEARCH_LIMIT,
  STEP_SEARCH,
  STEP_DOWNLOAD,
  STEP_TRANSCODE,
  STEP_PROBE,
  DURATION_MIN,
  DURATION_MAX,
  TARGET_HEIGHT,
  PROXY_PROBE_URL,
  PUBLISHER_CHANNELS,
  PLATFORM_CHANNELS,
  AGGREGATOR_CHANNELS,
  TYPE_RULES,
  extractEnglishName,
};
