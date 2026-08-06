// lib/cover.js —— 封面获取：严格按《素材搜集规则》「封面来源优先级」实现多级降级。
//
// 封面来源优先级链（11 级，见 fetchCover 的 order 数组；第 12 级 ffmpeg 抽帧由 collect.js 编排）：
//   1  steam-cdn         Steam 官方宣传主视觉（capsule_616x353 / header）                    需 steamAppId
//   2  youtube           官方宣传片缩略图（maxresdefault，发行商官方 key art）                需 videoId
//   3  steam-cdn-hero    Steam 官方宽幅横幅（library_hero_2x / page_bg，非宣传主视觉）       需 steamAppId
//   4  wallhaven         公开 JSON API（免 key）                                              英文查询词
//   5  reddit            公开 JSON API（免 key，★带相关性闸门）                                英文查询词
//   6  user              用户指定 URL（直链）                                                 位置不变
//   7  4kwallpapers      Bing 图片搜索（cn.bing.com，国内可直连）                             英文查询词
//   8  alphacoders       Bing 图片搜索                                                       英文查询词
//   9  game-sites        Bing 图片搜索（6 站 OR 合并，1 次请求）                              英文查询词
//  10  chinese-sites     Bing 图片搜索（5 站 OR 合并，中文原名）                              ⚠可能带水印
//  11  steam-cdn-lowres  Steam 官方图 · 降级档（library_hero，仅 1920×620）                  需 steamAppId，degraded=true
//
// 设计要点（v2.7.0 重构：DuckDuckGo 站内搜 → Bing 图片搜索 + Steam CDN 官方图）：
//   · Bing 图片搜索的 `m.murl` 直接给原图直链，替代旧的「DDG 搜 → 抓详情页 → 抽直链」三段式；
//     游戏媒体站 / 中文站用 `(site:a OR site:b OR ...)` 一次查询覆盖全部站点，全链请求数从 ~90 降到 ≤7。
//   · Steam CDN 直连优先（国内有节点）：首次探测只用 8s，失败一次后全程走代理；HTTP 4xx/5xx 不算直连不可用。
//   · 每个候选「下载后」必须用 imagesize.readImageSize + meetsMinSize 校验真实分辨率再采纳，绝不相信 URL 字样。
//   · 任何一级失败（网络异常 / 解析不出 / 尺寸不达标）都干净降级到下一级，绝不抛异常中断链路。
//   · 默认走 lib/http.js 的 proxyFetch —— Node 内置 fetch 不认 HTTP_PROXY，在需代理机器上会 100% 超时。
const fsDefault = require('fs');
const path = require('path');
const { readImageSize, meetsMinSize, extForImageFormat, MIN_WIDTH, MIN_HEIGHT } = require('./imagesize');
const { proxyFetch } = require('./http');

/** 单次网络请求超时（经代理可能慢，取 30s）。 */
const FETCH_TIMEOUT = 30 * 1000;
/** 维基 / Steam 反查等「轻量 JSON 接口」的较短超时（避免 wiki 4 连请求串行拖垮整链）。 */
const SEARCH_TIMEOUT = 12 * 1000;
/** 直连探测超时（首次直连只给 8s，失败时立即降级代理）。 */
const DIRECT_PROBE_TIMEOUT = 8 * 1000;
/** 直连优先逃生开关（auto / always / never），从 env 读取。 */
const DIRECT_FIRST_ENV_KEY = 'MATERIAL_DIRECT_FIRST';
/** Bing 图片搜索端点（国内可直连，比走代理更稳）。 */
const BING_IMAGE_SEARCH = 'https://cn.bing.com/images/search';
/** Bing 尺寸过滤（≥1280×720），**字面量**拼接，绝不 encodeURIComponent。 */
const BING_SIZE_FILTER = '+filterui:imagesize-custom_' + MIN_WIDTH + '_' + MIN_HEIGHT;
/** Bing 表单标识（固定值，官方图片搜索必带）。 */
const BING_FORM = 'HDRSC2';
/** Bing 请求最小间隔（节流，防脉冲）。 */
const BING_MIN_INTERVAL_MS = 600;
/** Bing 失败重试退避（最多 1 次）。 */
const BING_RETRY_DELAY_MS = 1500;
/** Bing 失败最大重试次数。 */
const BING_MAX_RETRY = 1;
/** Bing 单 run 请求熔断上限（护 IP）。 */
const BING_MAX_REQUESTS_PER_RUN = 12;
/** Bing 请求头：中文版布局，避免 consent 跳转。 */
const BING_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';
const BING_REFERER = 'https://cn.bing.com/';
/** Steam CDN 官方图基础地址（cdn.akamai.steamstatic.com）。 */
const STEAM_CDN_BASE = 'https://cdn.akamai.steamstatic.com/steam/apps';
/** Steam CDN 官方宣传主视觉（商店胶囊图/头图，发行商上传的 key art）。 */
const STEAM_CDN_STRICT = ['capsule_616x353_2x.jpg', 'capsule_616x353.jpg', 'header.jpg'];
/** Steam CDN 官方宽幅横幅（商店页顶部 hero / 背景图，非宣传主视觉，仅作兜底）。 */
const STEAM_CDN_HERO = ['library_hero_2x.jpg', 'page_bg_generated_v6b.jpg'];
/** Steam CDN 降级档资源（library_hero 仅 1920×620，必不达标）。 */
const STEAM_CDN_LOWRES = ['library_hero.jpg'];
/** wallhaven 公开搜索 API（免 key）。 */
const WALLHAVEN_API = 'https://wallhaven.cc/api/v1/search';
/**
 * wallhaven categories 是 3 个二进制开关位 `general/anime/people`：
 *   100 = general（游戏原画、Key Art、截图都归在这一类）
 *   010 = anime（日系动漫画风，**不是**我们要的）
 *   001 = people（人像）
 * 曾经误写成 010，导致主力可编程封面源对绝大多数游戏静默返回 0 条
 * （实测 Just Cause 4：010 → 0 条；100 → 2 条含 3840×2160），是「点击运行一直不成功」的直接原因之一。
 */
const WALLHAVEN_CATEGORIES = '100';
/** wallhaven purity 同样是 3 位开关 `sfw/sketchy/nsfw`；100 = 只要 SFW。 */
const WALLHAVEN_PURITY = '100';
/** 服务端分辨率下限，直接在 API 层过滤掉不达标图，省一次下载。 */
const WALLHAVEN_ATLEAST = MIN_WIDTH + 'x' + MIN_HEIGHT;
/** 默认排序：相关度。 */
const WALLHAVEN_SORTING = 'relevance';
/** YouTube 缩略图 CDN。 */
const YT_THUMB_CDN = 'https://i.ytimg.com/vi';
/** 必带的浏览器 UA：DuckDuckGo / 壁纸站对无 UA 请求一律拒绝。 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
/** 规范要求的封面固定文件名。 */
const COVER_BASE = '封面';
const COVER_FILE = COVER_BASE + '.jpg';
/** 每级来源最多实际下载校验多少个候选（防止一个来源把时间耗光）。 */
const MAX_CANDIDATES_PER_SOURCE = 4;
/** 步骤名（SSE 事件 step 字段）。 */
const STEP_SEARCH = '检索封面来源';
const STEP_DOWNLOAD = '下载封面';

// ─────────────────────── 缺陷 3：英文查询词 ───────────────────────

/**
 * Steam 商店搜索 API（**仅**用于「中文名 → appid」的反查）。
 *
 * 关键实测结论（务必保留，改动前先复现）：
 *   · `l=english&cc=US` + 中文 term → total=0（Steam 只在对应语言的本地化标题里做匹配），
 *     所以这一步必须用 `l=schinese&cc=CN`；
 *   · 但 `l=schinese` 返回的 items[].name 也是**中文名**（如「艾尔登法环」「仁王２ Complete Edition」），
 *     拿不到英文名 → 必须再走一次 appdetails 才行。
 * Steam 在此**只用来查英文名，不再用来取封面**：官方 library_hero 最大 1920×620，
 * 物理上达不到规范要求的 ≥1920×1080（这正是旧 lib/steam.js 被删除的原因）。
 */
const STEAM_SEARCH_API = 'https://store.steampowered.com/api/storesearch/';
/** Steam 应用详情 API（appid → 英文名；filters=basic 只取基础字段，响应体小很多）。 */
const STEAM_DETAILS_API = 'https://store.steampowered.com/api/appdetails';
/** 依赖英文查询词的来源：这几个站没有中文索引，喂中文名必然 0 结果。 */
const ENGLISH_QUERY_SOURCES = ['wallhaven', 'reddit', '4kwallpapers', 'alphacoders', 'game-sites'];
/** 第 5 级「游戏媒体站」：覆盖主要平台与游戏新闻站，不限任天堂一家。 */
const GAME_MEDIA_SITES = ['nintendo.com', 'playstation.com', 'xbox.com', 'ign.com', 'gamespot.com', 'pcgamer.com'];
/** 第 5.5 级「中文游戏站」：游民星空/3DM/游侠/网易/腾讯（⚠ 可能带水印，谨慎采纳）。 */
const CHINESE_WALLPAPER_SITES = ['gamersky.com', '3dmgame.com', 'ali213.net', '163.com', 'qq.com'];

// ─────────────────────── 缺陷 4：相关性校验 ───────────────────────

/**
 * 相关性判定停用词：这些 token 在壁纸站 slug / 标题里几乎无处不在，
 * 计入命中率只会把「随便一张 4K 壁纸」判成相关。
 */
const STOP_TOKENS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'for', 'to', 'with', 'by',
  'game', 'games', 'gaming', 'key', 'art', 'keyart', 'artwork', 'cover',
  'wallpaper', 'wallpapers', 'background', 'backgrounds', 'image', 'images',
  'photo', 'photos', 'pic', 'pics', 'picture', 'pictures', 'poster', 'posters',
  'hd', 'fhd', 'qhd', 'uhd', '2k', '4k', '5k', '8k', '1080p', '1440p', '2160p',
  'ultra', 'widescreen', 'desktop', 'screenshot', 'screenshots',
  'official', 'free', 'download', 'downloads', 'pc', 'video',
]);

/**
 * 罗马数字 → 阿拉伯数字（统一续作编号写法，`Final Fantasy VII` ≡ `final-fantasy-7`）。
 * 刻意**不收** `i` 和 `x`：前者是英文人称代词，后者常作分隔符/系列代号（Mega Man X），
 * 误转会制造大量假匹配。查询词与候选词都过同一张表，所以映射本身是对称安全的。
 */
const ROMAN_MAP = {
  ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9',
  xi: '11', xii: '12', xiii: '13', xiv: '14', xv: '15',
};

/** 查询词「主要 token」的最低命中比例（0.6 → 2 个词必须全中，3 个词至少中 2 个）。 */
const RELEVANCE_MIN_HIT_RATIO = 0.6;

/** CJK（含日文假名）字符类，用于中文/日文名的整段子串匹配。 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

/** 常见「版本后缀」——Steam 英文名带着它会明显拉低壁纸站命中率。 */
const EDITION_TAIL_RE = new RegExp(
  '\\s*(?:[-–—:|]\\s*)?(?:the\\s+)?'
  + '(?:complete|definitive|deluxe|digital\\s+deluxe|ultimate|premium|gold|standard|legendary'
  + '|anniversary|remastered|remaster|remake|reloaded|enhanced|redux|goty'
  + '|game\\s+of\\s+the\\s+year|director\'?s\\s+cut)'
  + '(?:\\s+edition)?\\s*$',
  'i',
);

/**
 * 判断字符串是否含 CJK（中日韩）字符。
 * @param {string} s 待判定字符串
 * @returns {boolean}
 */
function hasCjk(s) {
  return CJK_RE.test(String(s == null ? '' : s));
}

/**
 * 判断字符串是否是「可直接拿去英文站搜索」的拉丁标题：不含 CJK 且至少有一个拉丁字母。
 * 用来短路掉 Steam 反查——`Elden Ring` / `Nioh 2` 这类原名本身就是英文名，没必要再发请求。
 * @param {string} s 待判定字符串
 * @returns {boolean}
 */
function isLatinTitle(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return false;
  if (hasCjk(t)) return false;
  return /[A-Za-z]/.test(t);
}

/**
 * YouTube 反查候选标题的相关性校验（防误判，纯函数）。
 *
 * 背景：`ytsearch3:"正当防卫4 game"` 可能返回无关视频（实测命中
 * 「How to make Connect 4 game - ...」），旧逻辑把 ` - ` 前段直接当游戏名，
 * 导致后续宣传片/封面全部按错误名字搜索。
 *
 * 判定口径：
 *   1. 搜索词带数字编号时（续作），候选必须含相同数字（挡同系列错配）；
 *   2. 搜索词为拉丁文 → 候选须与搜索词共享至少一个实词（前缀级模糊）；
 *   3. 搜索词为中文 → 无法做词根匹配，候选必须带宣传片特征词
 *      （trailer/gameplay/official/launch/teaser/reveal/cinematic/opening）才可信，
 *      否则宁可不采纳，退回原名搜索。
 *
 * @param {string} candidate YouTube 标题「 - 」前段
 * @param {string} query 原始搜索词（中文或拉丁文）
 * @returns {boolean} true=可信，可采纳为英文名
 */
function isYouTubeTitleRelevant(candidate, query) {
  const cand = String(candidate == null ? '' : candidate).trim();
  const q = String(query == null ? '' : query).trim();
  if (!cand || !q) return false;
  if (!isLatinTitle(cand)) return false;

  const queryTokens = normalizeTokens(q);
  const candTokens = normalizeTokens(cand);
  if (!candTokens.length) return false;
  const queryNums = queryTokens.filter((t) => /^\d+$/.test(t));
  const candNums = candTokens.filter((t) => /^\d+$/.test(t));
  // ① 数字编号必须匹配
  if (queryNums.length && !queryNums.some((n) => candNums.includes(n))) return false;

  const lowerCand = cand.toLowerCase();
  if (hasCjk(q)) {
    // ③ 中文搜索词：候选必须带宣传片特征词
    return /(trailer|gameplay|official|launch|teaser|reveal|cinematic|opening)/i.test(lowerCand);
  }
  // ② 拉丁文搜索词：共享至少一个实词（前缀级）
  const words = queryTokens.filter((t) => !/^\d+$/.test(t));
  return words.some((t) => {
    if (t.length < 3) return false;
    if (lowerCand.includes(t)) return true;
    return candTokens.some((w) => w.startsWith(t) || t.startsWith(w));
  });
}

/**
 * 极简 HTML 实体解码（只覆盖标题里真正会出现的几个，不引入第三方依赖）。
 * @param {string} s 原始字符串
 * @returns {string}
 */
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/**
 * 把任意名称/slug/标题规范化成可比对的 token 列表（相关性校验的地基，纯函数）。
 *
 * 规则：
 *   1. 全部转小写；撇号直接删除（`don't` → `dont`），避免被拆成两个 token；
 *   2. 其余非「数字/拉丁字母/CJK/假名」字符统一当分隔符；
 *   3. CJK 与 数字/拉丁 之间补空格：`正当防卫4` → `正当防卫` + `4`；
 *   4. 「≥3 个字母 + 1~2 位数字」粘连时拆开：`witcher3` → `witcher` + `3`
 *      （限定 ≥3 个字母是为了别把 `ps5`、`4k` 之类拆坏）；
 *   5. 罗马数字按 ROMAN_MAP 归一到阿拉伯数字；
 *   6. 去掉停用词并去重（保持首次出现顺序，便于命中率计算不被重复词灌水）。
 *
 * @param {string} str 原始字符串
 * @returns {string[]} 规范化 token 列表
 */
function normalizeTokens(str) {
  let s = String(str == null ? '' : str).toLowerCase();
  s = decodeEntities(s);
  // 撇号/重音撇号先删掉，别让它变成分隔符
  s = s.replace(/['’`´ʼ]/g, '');
  // 非字母数字 CJK 一律换成空格
  s = s.replace(/[^0-9a-z\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+/g, ' ');
  // CJK ↔ 数字/拉丁 边界补空格
  s = s.replace(/([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff])([0-9a-z])/g, '$1 $2');
  s = s.replace(/([0-9a-z])([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff])/g, '$1 $2');
  // `witcher3` → `witcher 3`（≥3 字母 + 1~2 数字，且数字后不再接字母数字）
  s = s.replace(/([a-z]{3,})(\d{1,2})(?![0-9a-z])/g, '$1 $2');

  const out = [];
  for (const raw of s.split(/\s+/)) {
    if (!raw) continue;
    const token = Object.prototype.hasOwnProperty.call(ROMAN_MAP, raw) ? ROMAN_MAP[raw] : raw;
    if (STOP_TOKENS.has(token)) continue;
    if (out.indexOf(token) < 0) out.push(token);
  }
  return out;
}

/**
 * 从一个 URL 里抽出「有语义的 slug」（相关性校验的输入之一，纯函数）。
 *
 * 依次剥掉：query/hash → 目录 → 扩展名 → `-<宽>x<高>-<id>` 分辨率尾巴 → ≥4 位的纯数字 id 尾巴。
 * 注意最后一步刻意要求 **≥4 位**：`just-cause-4` 的 `4` 是续作编号，绝不能被当成 id 删掉，
 * 而 `just-cause-4-4142.html` 里的 `4142` 才是站点 id。
 *
 * @param {string} url 候选图 / 详情页地址
 * @returns {string} slug（取不到返回空串）
 */
function extractSlugFromUrl(url) {
  const raw = String(url == null ? '' : url).trim();
  if (!raw) return '';
  let pathname = '';
  try {
    pathname = new URL(raw).pathname;
  } catch (e) {
    pathname = raw.split('#')[0].split('?')[0];
  }
  const segments = pathname.split('/').filter((x) => x.length > 0);
  let slug = segments.length ? segments[segments.length - 1] : '';
  if (!slug) return '';
  slug = slug.replace(/\.(?:jpe?g|png|webp|gif|bmp|avif|html?|php|aspx?)$/i, '');
  slug = slug.replace(/[-_]\d{3,5}x\d{3,5}(?:[-_]\d+)?$/i, '');
  slug = slug.replace(/[-_]\d{4,}$/, '');
  return slug;
}

/**
 * 从页面 HTML 里取标题（og:title 优先，退回 `<title>`）。
 * alphacoders 的详情页 URL 是 `big.php?i=1360000` 这种纯 id，slug 无从判定相关性，
 * 只能靠标题（`Just Cause 4 HD Wallpaper | Background Image …`）。
 * @param {string} html 页面 HTML
 * @returns {string} 标题（取不到返回空串）
 */
function extractTitleFromHtml(html) {
  const text = String(html == null ? '' : html);
  const ogTag = /<meta[^>]+(?:property|name)\s*=\s*["']og:title["'][^>]*>/i.exec(text);
  if (ogTag) {
    const c = /content\s*=\s*["']([^"']*)["']/i.exec(ogTag[0]);
    if (c && c[1].trim()) return decodeEntities(c[1].replace(/\s+/g, ' ').trim());
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  if (titleTag) return decodeEntities(titleTag[1].replace(/\s+/g, ' ').trim());
  return '';
}

/**
 * 判断 token 列表里是否含「实义词」（非纯数字）。
 * alphacoders 直链是 `136/1360000.jpg`，slug 全是数字 → 无从判定，只能依赖详情页级校验。
 * @param {string} str 待判定字符串
 * @returns {boolean}
 */
function hasWordToken(str) {
  return normalizeTokens(str).some((t) => !/^\d+$/.test(t));
}

/**
 * 相关性校验（缺陷 4 的核心，纯函数、可单测）。
 *
 * 判定口径：
 *   1. 查询词拆成「实义词」与「数字」两组；实义词一个都没有时直接判不相关
 *      （无从校验就不给过，宁可失败也不要错图）；
 *   2. 实义词命中数必须 ≥ `ceil(实义词数 × RELEVANCE_MIN_HIT_RATIO)`，且至少 1 个 ——
 *      `just cause 4` 的 `just` + `cause` 必须都在，光命中一个 `4` 不算数；
 *   3. CJK token 走整段子串包含（中文不分词）；
 *   4. 查询词带数字时（续作编号），候选必须至少出现其中一个 ——
 *      挡住 `just-cause-3` 冒充 `Just Cause 4` 这类同系列错配。
 *
 * @param {string} candidate 候选名称（图片 slug 或详情页标题）
 * @param {string[]|string} queryTokens 查询词 token 列表（也接受原始字符串，内部自行规范化）
 * @param {{minHitRatio?: number}} [opts] minHitRatio 可覆盖命中率下限
 * @returns {boolean} true=相关，可采纳；false=不相关，必须跳过
 */
function isRelevantCandidate(candidate, queryTokens, opts = {}) {
  const tokens = Array.isArray(queryTokens) ? queryTokens.slice() : normalizeTokens(queryTokens);
  const words = tokens.filter((t) => t && !/^\d+$/.test(t));
  const nums = tokens.filter((t) => t && /^\d+$/.test(t));
  if (!words.length) return false;

  const candTokens = normalizeTokens(candidate);
  if (!candTokens.length) return false;
  const candSet = new Set(candTokens);
  const candJoined = candTokens.join('');

  let hit = 0;
  for (const w of words) {
    if (candSet.has(w)) { hit += 1; continue; }
    if (CJK_RE.test(w) && candJoined.indexOf(w) >= 0) hit += 1;
  }
  const ratio = Number.isFinite(opts.minHitRatio) ? opts.minHitRatio : RELEVANCE_MIN_HIT_RATIO;
  const need = Math.max(1, Math.ceil(words.length * ratio));
  if (hit < need) return false;

  if (nums.length && !nums.some((n) => candSet.has(n))) return false;
  return true;
}

/**
 * 清洗 Steam 英文名：去商标符号、去「Complete/Deluxe/Reloaded … Edition」版本后缀。
 * 实测 `仁王2` → Steam `Nioh 2 – The Complete Edition`，
 * `Just Cause 4` → `Just Cause 4 Reloaded`；带着后缀去壁纸站搜命中率明显更差。
 * @param {string} raw Steam 返回的原始名称
 * @returns {string} 清洗后的英文名（清空则返回空串）
 */
function cleanEnglishTitle(raw) {
  let s = String(raw == null ? '' : raw).replace(/[™®©]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // 可能叠加多层后缀（`… Digital Deluxe Edition`），最多剥 3 次
  for (let i = 0; i < 3; i += 1) {
    const next = s.replace(EDITION_TAIL_RE, '').trim();
    if (!next || next === s) break;
    s = next;
  }
  return s.replace(/[\s:–—|-]+$/, '').trim();
}

/**
 * 构造查询词计划：英文名优先，原名兜底（缺陷 3 的「双轮策略」）。
 * 两者等价（忽略大小写）时只保留一条，避免白跑一轮网络请求。
 * @param {string} gameName 原始游戏名
 * @param {string} englishTitle 解析出的英文名（可为空）
 * @returns {string[]} 去重后的查询词列表，按尝试顺序排列
 */
function buildQueryPlan(gameName, englishTitle) {
  const out = [];
  const push = (v) => {
    const t = String(v == null ? '' : v).trim();
    if (!t) return;
    if (out.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    out.push(t);
  };
  push(englishTitle);
  push(gameName);
  return out;
}

/**
 * 从 Steam storesearch 响应里取第一个 appid（纯函数）。
 * @param {object} json storesearch 响应体
 * @returns {string} appid 字符串；无结果返回空串
 */
function parseSteamSearchAppId(json) {
  if (!json || !Array.isArray(json.items)) return '';
  for (const it of json.items) {
    if (!it) continue;
    const id = it.id == null ? '' : String(it.id).trim();
    if (/^\d+$/.test(id)) return id;
  }
  return '';
}

/**
 * 从 Steam appdetails 响应里取英文名（纯函数）。
 * @param {object} json appdetails 响应体（形如 `{ "1245620": { success: true, data: { name } } }`）
 * @param {string|number} appId 应用 id
 * @returns {string} 英文名；取不到返回空串
 */
function parseSteamAppName(json, appId) {
  if (!json) return '';
  const node = json[String(appId == null ? '' : appId)];
  if (!node || node.success !== true || !node.data) return '';
  return String(node.data.name == null ? '' : node.data.name).trim();
}

/** 来源标识 → 中文展示名（前端 detail.source 直接用得上）。 */
const SOURCE_LABEL = {
  'steam-cdn': 'Steam 官方图',
  'steam-cdn-hero': 'Steam 官方横幅',
  'steam-cdn-lowres': 'Steam 官方图（低分辨率）',
  '4kwallpapers': '4kwallpapers.com',
  alphacoders: 'alphacoders.com',
  wallhaven: 'wallhaven.cc',
  user: '用户指定 URL',
  nintendo: 'Nintendo 官网',
  'game-sites': '游戏媒体站（英文）',
  'chinese-sites': '中文游戏站（可能带水印）',
  reddit: 'Reddit 壁纸社区',
  youtube: 'YouTube 缩略图',
  'ffmpeg-frame': '主视频抽帧',
};

// ─────────────────────── Bing 图片搜索解析（纯函数）──────────────────────

/**
 * 从 Bing 图片搜索结果页提取候选项（纯函数）。
 *
 * Bing 每条结果是 `<a class="iusc" ... m="<HTML 转义的 JSON>">`，
 * JSON 形如 `{murl(原图直链), purl(来源页), t(标题), turl(缩略图)}`。
 * 属性顺序不固定，故先切出 `m="..."` 属性值再 JSON.parse。
 *
 * @param {string} html Bing 结果页 HTML
 * @returns {Array<{murl: string, purl: string, title: string, turl: string}>}
 *   murl 解析不出或非 http(s) 的条目直接丢弃；保持 Bing 的相关度原序
 */
function parseBingImageResults(html) {
  const text = String(html == null ? '' : html);
  const out = [];
  // 取所有带 m= 属性的标签（iusc）；属性值以 " 或 ' 界定
  const re = /<a\b[^>]*\bm=["']([^"']*)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    // HTML 转义的 JSON（Bing 用 &quot; 代替 "）：先反转义再解析
    const jsonStr = String(raw)
      .replace(/&quot;/gi, '"')
      .replace(/&amp;/gi, '&')
      .replace(/&#0*39;/gi, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&nbsp;/gi, ' ');
    let obj;
    try {
      obj = JSON.parse(jsonStr);
    } catch (e) {
      continue; // 坏 JSON 跳过，绝不崩
    }
    if (!obj || typeof obj !== 'object') continue;
    const murl = normalizeUrl(obj.murl || obj.m || '');
    if (!murl) continue; // 无原图直链丢弃
    out.push({
      murl,
      purl: normalizeUrl(obj.purl || obj.p || ''),
      title: String(obj.t || obj.title || ''),
      turl: normalizeUrl(obj.turl || ''),
    });
  }
  return out;
}

/**
 * 判定单条 Bing 结果是否与查询词相关（纯函数，OR 语义）。
 * 标题 / 原图 slug / 来源页 slug 三者**任一**自证相关即通过：
 *   · 4kwallpapers → murl slug `just-cause-4` 命中
 *   · alphacoders  → murl slug 是纯数字 `1360000`，靠标题命中
 *   · 中文站       → 标题「正当防卫4壁纸_游民星空」走 CJK 整段子串命中
 * 三者都不自证 → 判不相关（宁可失败，绝不给错图）。
 * @param {{murl: string, purl: string, title: string}} item
 * @param {string[]} queryTokens normalizeTokens 的输出
 * @returns {boolean}
 */
function isBingItemRelevant(item, queryTokens) {
  const tokens = Array.isArray(queryTokens) ? queryTokens.slice() : normalizeTokens(queryTokens);
  if (!tokens.length) return false;
  const candidates = [];
  if (item && item.title) candidates.push(item.title);
  if (item && item.murl) candidates.push(extractSlugFromUrl(item.murl));
  if (item && item.purl) candidates.push(extractSlugFromUrl(item.purl));
  for (const c of candidates) {
    if (c && isRelevantCandidate(c, tokens)) return true;
  }
  return false;
}

/**
 * 过滤 + 去重 + 截断 Bing 候选（纯函数）。
 * @param {Array<object>} items parseBingImageResults 输出
 * @param {string[]} queryTokens 查询词 token
 * @param {{hosts?: string[], relevance?: boolean, limit?: number}} [opts]
 *   hosts —— **只校验 purl 的 host**，不校验 murl（游戏媒体站的图挂在 CDN 域名上，
 *     校验 murl 会把正确结果全部误杀）。hosts 为空/未传则不做站点过滤。
 *   relevance —— 默认 true；limit 默认 MAX_CANDIDATES_PER_SOURCE(4)
 * @returns {string[]} murl 列表（保持 Bing 相关度序）
 */
function filterBingCandidates(items, queryTokens, opts = {}) {
  const hosts = Array.isArray(opts.hosts) ? opts.hosts : [];
  const relevance = opts.relevance !== false;
  const limit = Number.isFinite(opts.limit) ? opts.limit : MAX_CANDIDATES_PER_SOURCE;
  const seen = new Set();
  const out = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    if (!it || !it.murl) continue;
    if (hosts.length) {
      const ph = hostOf(it.purl || '');
      if (!ph || !hosts.some((h) => ph === h || ph.endsWith('.' + h))) continue;
    }
    if (relevance && !isBingItemRelevant(it, queryTokens)) continue;
    if (seen.has(it.murl)) continue;
    seen.add(it.murl);
    out.push(it.murl);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 识别 Bing 的反爬拦截页 / 空白页（纯函数，决定是否值得重试）。
 * 判据：正文过短(<2000 字符) 或 命中 captcha / unusual traffic / challenge-form 等特征词。
 * 注意：HTTP 200 且结构完整但 0 条结果 = 真没搜到，**必须返回 false**（不重试）。
 * @param {string} html
 * @returns {boolean}
 */
function looksLikeBingBlockPage(html) {
  const text = String(html == null ? '' : html);
  if (!text) return true;
  // 含有 Bing 图片结果标记（<a class="iusc"）即结构完整，是正常页——
  // 哪怕只有 1 条或 0 条结果也**不是**拦截页，绝不能重试。
  if (/class\s*=\s*["']iusc/i.test(text)) return false;
  if (text.length < 2000) return true; // 正文过短，疑似拦截/空页
  const lower = text.toLowerCase();
  return ['captcha', 'unusual traffic', 'challenge-form', 'verify you are human', 'automated access']
    .some((w) => lower.includes(w));
}

/**
 * 从 Steam storesearch 响应里挑**与查询词相关**的 appid（纯函数）。
 * 替代裸用 parseSteamSearchAppId：后者只取 items[0].id，
 * 搜 "Just Cause 4" 若首条是 "Just Cause 3" 会直接拿错 appid → 错图。
 * @param {object} json storesearch 响应体
 * @param {string[]} queryTokens normalizeTokens 输出
 * @returns {string} 相关的 appid；无相关项返回空串（**不退回首条**）
 */
function pickRelevantSteamAppId(json, queryTokens) {
  const tokens = Array.isArray(queryTokens) ? queryTokens.slice() : normalizeTokens(queryTokens);
  if (!json || !Array.isArray(json.items)) return '';
  for (const it of json.items) {
    if (!it) continue;
    const id = it.id == null ? '' : String(it.id).trim();
    if (!/^\d+$/.test(id)) continue;
    const name = String(it.name || '').trim();
    if (name && tokens.length && isRelevantCandidate(name, tokens)) return id;
  }
  // 无标题相关项 → 返回空，绝不退回首条
  return '';
}

/**
 * 从 HTML 里去掉转义并归一化 URL。
 * @param {string} raw 原始 URL 片段（可能含 &amp; / 协议相对 //host/…）
 * @returns {string} 归一化后的绝对 URL（无法归一化时返回空串）
 */
function normalizeUrl(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  s = s.replace(/&amp;/g, '&').replace(/\\\//g, '/');
  if (s.startsWith('//')) s = 'https:' + s;
  if (!/^https?:\/\//i.test(s)) return '';
  return s;
}

/**
 * 取 URL 的 hostname（解析失败返回空串）。
 * @param {string} url 待解析地址
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

/** 多级封面来源获取器。 */
class CoverFetcher {
  /**
   * @param {{
   *   fetch?: Function,
   *   fs?: object,
   *   probe?: object,
   *   timeout?: number,
   *   userAgent?: string,
   *   env?: object,
   *   wallhaven?: {categories?: string, purity?: string, atleast?: string, sorting?: string}
   * }} [deps] 依赖注入（单测注入 fetch/fs 替身，绝不发真实请求）
   */
  constructor(deps = {}) {
    // 默认用代理感知的 proxyFetch 而非 globalThis.fetch：后者不认 HTTP_PROXY，
    // 在必须走代理才能出网的机器上所有封面源都会超时（缺陷 2）
    this.fetch = deps.fetch || proxyFetch;
    this.fs = deps.fs || fsDefault;
    // MediaProbe，仅用于把 png/webp 转成规范要求的 封面.jpg
    this.probe = deps.probe === undefined ? null : deps.probe;
    // 调用方完全没提 probe 时允许惰性自建一个（独立使用 CoverFetcher 时也能真正转 JPG）；
    // 显式传 probe:null 表示「明确不要转换」，此时保留原扩展名
    this.autoProbe = deps.probe === undefined;
    this.timeout = Number.isFinite(deps.timeout) ? deps.timeout : FETCH_TIMEOUT;
    this.userAgent = deps.userAgent || USER_AGENT;
    this.env = deps.env || process.env;
    const wh = deps.wallhaven || {};
    this.wallhaven = {
      categories: wh.categories || WALLHAVEN_CATEGORIES,
      purity: wh.purity || WALLHAVEN_PURITY,
      atleast: wh.atleast || WALLHAVEN_ATLEAST,
      sorting: wh.sorting || WALLHAVEN_SORTING,
    };
    // 英文名反查结果缓存：同一次运行里同名游戏不重复打 Steam 接口（appdetails 有频控）
    this.englishTitleCache = new Map();
    // Steam appid 反查缓存（Steam CDN 双档用）
    this.steamAppIdCache = new Map();
    // 直连优先三态：null=未探测，true=直连可用，false=不可用（Bing + Steam CDN 共享）
    this.directFirstOk = null;
    // Bing 单 run 请求计数（熔断）与节流时间戳
    this._bingRequests = 0;
    this._lastBingAt = 0;
    // Bing 反爬参数（可注入以加速单测）
    // 注：用 != null 而非 || —— 允许单测显式注入 0 来彻底关掉节流/退避
    this.bingThrottleMs = deps.bingThrottleMs != null ? deps.bingThrottleMs : BING_MIN_INTERVAL_MS;
    this.bingRetryDelayMs = deps.bingRetryDelayMs != null ? deps.bingRetryDelayMs : BING_RETRY_DELAY_MS;
    // Bing 专用请求头（中文版布局 + Referer，避免 consent 跳转）
    this.bingHeaders = {
      'User-Agent': this.userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': BING_ACCEPT_LANGUAGE,
      Referer: BING_REFERER,
    };
  }

  // ─────────────────────── 缺陷 3：英文名解析 ───────────────────────

  /**
   * 构造 Steam 商店搜索地址（游戏名 → appid）。
   * 语言自适应：查中文名必须用 `l=schinese&cc=CN`（实测 `l=english` 配中文 term 返回 total=0）；
   * 查英文名用 `l=english&cc=US`（否则反查回来的名字还是中文，相关性闸门必挂）。
   * @param {string} gameName 游戏名
   * @returns {string} 完整 API 地址
   */
  buildSteamSearchUrl(gameName) {
    const term = String(gameName == null ? '' : gameName).trim();
    const lang = hasCjk(term) ? 'l=schinese&cc=CN' : 'l=english&cc=US';
    return STEAM_SEARCH_API + '?term=' + encodeURIComponent(term) + '&' + lang;
  }

  /**
   * 构造 Steam 应用详情地址（appid → 英文名）。
   * 这里必须 `l=english`，否则拿回来的还是中文名。
   * @param {string|number} appId 应用 id
   * @returns {string} 完整 API 地址
   */
  buildSteamDetailsUrl(appId) {
    return STEAM_DETAILS_API
      + '?appids=' + encodeURIComponent(String(appId == null ? '' : appId).trim())
      + '&l=english&filters=basic';
  }

  /**
   * 经维基百科反查英文名（zh.wikipedia.org 搜索 → langlinks.en）。
   * 维基百科有完善的跨语言链接，中文名搜到词条后直接拿英文标题，
   * 远胜 Steam storesearch（很多游戏在 Steam 国区没条目）。
   */
  async lookupEnglishTitleFromWiki(gameName, opts = {}) {
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    const name = String(gameName == null ? '' : gameName).trim();
    if (!name) return { title: '', source: 'none' };

    emit('cover_search', STEP_SEARCH, '维基百科反查「' + name + '」的英文名…', null, { source: 'wiki' });
    try {
      // 第一步：中文维基搜索
      const srUrl = 'https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch='
        + encodeURIComponent(name) + '&format=json&srlimit=1';
      const srRes = await this.httpJson(srUrl, { timeout: SEARCH_TIMEOUT });
      if (!srRes.ok) {
        return { title: '', source: 'none', error: 'Wikipedia 返回 ' + srRes.status };
      }
      const srData = srRes.json;
      const page = (srData.query && srData.query.search || [])[0];
      if (!page) {
        emit('log', STEP_SEARCH, '[cover] 维基百科未收录「' + name + '」', null, { level: 'info' });
        return { title: '', source: 'none' };
      }

      // 第二步：取英文跨语言链接
      const llUrl = 'https://zh.wikipedia.org/w/api.php?action=query&prop=langlinks'
        + '&lllang=en&pageids=' + page.pageid + '&format=json&lllimit=1';
      const llRes = await this.httpJson(llUrl, { timeout: SEARCH_TIMEOUT });
      if (!llRes.ok) {
        return { title: '', source: 'none', error: 'Wikipedia langlinks 返回 ' + llRes.status };
      }
      const llData = llRes.json;
      const pages = llData.query && llData.query.pages || {};
      const pg = Object.values(pages)[0];
      const ll = (pg && pg.langlinks || [])[0];
      if (!ll || !ll['*']) {
        emit('log', STEP_SEARCH, '[cover] 维基百科无英文跨语言链接', null, { level: 'info' });
        return { title: '', source: 'none' };
      }
      const title = String(ll['*']).trim();
      if (title && isLatinTitle(title) && title.length >= 3) {
        // 第三步：尝试从 Wikidata 取 Steam appid（供后续 Steam 视频/封面源使用）
        let steamAppId = '';
        try {
          const enPageUrl = 'https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&titles='
            + encodeURIComponent(title) + '&format=json';
          const enPageRes = await this.httpJson(enPageUrl, { timeout: SEARCH_TIMEOUT });
          if (enPageRes.ok) {
            const enPageData = enPageRes.json;
            const enPages = enPageData.query && enPageData.query.pages || {};
            const enPg = Object.values(enPages)[0];
            const wb = enPg && enPg.pageprops && enPg.pageprops.wikibase_item;
            if (wb) {
              const wdUrl = 'https://www.wikidata.org/wiki/Special:EntityData/' + wb + '.json';
              const wdRes = await this.httpJson(wdUrl, { timeout: SEARCH_TIMEOUT });
              if (wdRes.ok) {
                const wdData = wdRes.json;
                const entity = wdData.entities && wdData.entities[wb];
                steamAppId = (entity && entity.claims && entity.claims.P1733 || [])
                  .map((c) => (c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value) || '')
                  .find(Boolean) || '';
              }
            }
          }
        } catch (e) { /* Wikidata 失败不影响主链路 */ }
        emit('cover_search', STEP_SEARCH, '维基百科英文名：' + title
          + (steamAppId ? '（Steam appid=' + steamAppId + '）' : ''), null, {
          source: 'wiki', englishTitle: title, zhPage: page.title, steamAppId: steamAppId || undefined,
        });
        return { title, source: 'wiki', zhPage: page.title, steamAppId: steamAppId || '' };
      }
    } catch (e) {
      // 静默降级
    }
    emit('log', STEP_SEARCH, '[cover] 维基百科英文名反查失败', null, { level: 'info' });
    return { title: '', source: 'none' };
  }

  /**
   * YouTube 搜索反查英文名（Steam 搜不到的兜底，v2.3.5）。
   *
   * yt-dlp 往 YouTube 搜 "{name} game" 拿前几条视频标题，
   * 从中提取英文游戏名。yt-dlp 已内置且确定能在本机代理下工作，
   * 比 Wikipedia/DDG scraping 都可靠。
   *
   * @param {string} gameName 中文游戏名
   * @param {{emit?: Function, ytDlpPath?: string}} [opts]
   * @returns {Promise<{title: string, source: 'youtube-title'|'none'}>}
   */
  async lookupEnglishTitleFromWeb(gameName, opts = {}) {
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    const ytDlpPath = opts.ytDlpPath;
    const name = String(gameName == null ? '' : gameName).trim();
    if (!name || !ytDlpPath) return { title: '', source: 'none' };

    emit('cover_search', STEP_SEARCH, 'YouTube 反查「' + name + '」的英文名…', null, { source: 'youtube-title' });
    try {
      const { spawn } = require('child_process');
      const args = [
        '--flat-playlist', '--dump-json',
        '--playlist-end', '3',
        '--no-warnings',
        'ytsearch3:' + name + ' game',
      ];
      const { resolveProxy, toProxyUrl } = require('./http');
      const px = resolveProxy('https://www.youtube.com/');
      if (px) {
        const u = toProxyUrl(px);
        if (u) args.unshift('--proxy', u);
      }
      const raw = await new Promise((resolve) => {
        const chunks = [];
        const child = spawn(ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d) => chunks.push(d));
        child.stderr.on('data', () => {});
        child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
        setTimeout(() => { try { child.kill(); } catch (e) { /* ignore */ } resolve(''); }, 12000);
      });
      if (!raw) return { title: '', source: 'none' };
      const lines = raw.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          const title = String(item.title || '');
          // YouTube 标题格式："{Game Name} - {trailer/type} | {channel}"
          const idx = title.indexOf(' - ');
          if (idx <= 0) continue;
          const candidate = title.slice(0, idx).trim();
          // 必须是拉丁字母为主的游戏名
          if (!isLatinTitle(candidate) || candidate.length < 3 || candidate.length > 60) continue;
          if (candidate.toLowerCase() === name.toLowerCase()) continue;
          // 相关性校验（防止「正当防卫4」被搜成 How to make Connect 4 game）
          if (!isYouTubeTitleRelevant(candidate, name)) continue;
          emit('cover_search', STEP_SEARCH, 'YouTube 反查英文名：' + candidate, null, {
            source: 'youtube-title', englishTitle: candidate,
          });
          return { title: candidate, source: 'youtube-title' };
        } catch (e) { /* 跳过解析失败的 JSON 行 */ }
      }
    } catch (e) {
      // 静默降级
    }
    emit('log', STEP_SEARCH, '[cover] YouTube 英文名反查无结果，退回原名查询', null, { level: 'info' });
    return { title: '', source: 'none' };
  }

  /**
   * 解析本次要用的英文名。
   *
   * 优先级：
   *   1. `opts.englishTitle` —— 调用方显式给的，最可信，不发任何请求；
   *   2. 原名本身就是拉丁标题（`Elden Ring` / `Nioh 2`）—— 它就是英文名；
   *   3. 维基百科反查（zh.wikipedia.org → langlinks.en）；
   *   4. YouTube 搜索兜底（yt-dlp 搜视频标题）；
   *   5. 全都拿不到 → 返回空英文名，**不报错**。
   *
   * @param {string} gameName 游戏名
   * @param {{englishTitle?: string, emit?: Function, lookup?: boolean}} [opts]
   *   lookup=false 可关闭 Steam 网络反查（单测与离线场景用）
   * @returns {Promise<{title: string, source: 'opts'|'origin'|'steam'|'none', appId?: string}>}
   */
  async resolveEnglishTitle(gameName, opts = {}) {
    const name = String(gameName == null ? '' : gameName).trim();
    const given = cleanEnglishTitle(opts.englishTitle);
    if (given) return { title: given, source: 'opts' };
    if (!name) return { title: '', source: 'none' };
    if (isLatinTitle(name)) return { title: name, source: 'origin' };
    if (opts.lookup === false) return { title: '', source: 'none' };

    if (this.englishTitleCache.has(name)) return this.englishTitleCache.get(name);
    let r = { title: '', source: 'none' };
    try {
      r = await this.lookupEnglishTitleFromWiki(name, { emit: opts.emit });
    } catch (e) {
      r = { title: '', source: 'none', error: e && e.message ? e.message : String(e) };
    }
    // 维基没查到 → YouTube 搜索兜底
    if (!r.title) {
      try {
        const webR = await this.lookupEnglishTitleFromWeb(name, { emit: opts.emit, ytDlpPath: opts.ytDlpPath });
        if (webR.title) r = webR;
      } catch (e) {
        // 保持 Steam 的 error 信息不覆盖
      }
    }
    this.englishTitleCache.set(name, r);
    return r;
  }

  /**
   * 取用于格式转换的 MediaProbe。
   * 未注入且允许自建时，用 lib/env.js 解析出的内置 ffmpeg 惰性创建一个——
   * 保证 PNG/WEBP 候选是**真的被转码**成 封面.jpg，而不是把 png 改个名了事。
   * 惰性 require 同时避免 cover ↔ probe/env 的加载期循环依赖。
   * @returns {object|null} MediaProbe 实例；不可用时返回 null
   */
  resolveProbe() {
    if (this.probe) return this.probe;
    if (!this.autoProbe) return null;
    this.autoProbe = false;
    try {
      // eslint-disable-next-line global-require
      const { MediaProbe } = require('./probe');
      // eslint-disable-next-line global-require
      const { EnvDetector } = require('./env');
      const info = new EnvDetector({ fs: this.fs }).detect();
      if (!info.ffmpegPath) return null;
      this.probe = new MediaProbe({ fs: this.fs, ffmpegPath: info.ffmpegPath, ffprobePath: info.ffprobePath });
      return this.probe;
    } catch (e) {
      return null;
    }
  }

  // ─────────────────────── 纯函数：URL 构造与 HTML 解析（单测主战场）───────────────────────

  /**
   * 构造 DuckDuckGo HTML 端点的站内搜索地址。
   * 规范给的是「web_search 搜 {游戏名} key art 4kwallpapers」，这里用 `site:` 限定站内，
   * 命中率与可解析性都更高。
   * @param {string} site 站点域名，如 '4kwallpapers.com'
   * @param {string} gameName 游戏名
   * @param {string} [extra='key art'] 附加关键词
   * @returns {string} 完整查询地址
   */
  /**
   * 构造 Bing 图片搜索地址（纯逻辑，可单测）。
   * @param {string|string[]} sites 站点域名；数组时用 `(site:a OR site:b)` 合并成一次查询
   * @param {string} query 查询词
   * @param {string} [extra] 附加关键词，如 'key art' / '壁纸'
   * @returns {string} 完整地址
   *
   * 拼接规则（务必逐字对齐，测试会锁死整串）：
   *   q = 单站: 'site:a <query> <extra>'
   *       多站: '(site:a OR site:b) <query> <extra>'
   *   URL = BING_IMAGE_SEARCH + '?q=' + encodeURIComponent(q)
   *       + '&form=HDRSC2&first=1&qft=' + BING_SIZE_FILTER
   *   ⚠ BING_SIZE_FILTER 以**字面量**拼接，绝不 encodeURIComponent
   *     （Bing 期望 `qft=+filterui:...`，编码成 %2B 会让过滤失效）
   */
  buildBingImageUrl(sites, query, extra = '') {
    let sitePart;
    if (Array.isArray(sites)) {
      sitePart = '(' + sites.map((s) => 'site:' + String(s || '').trim()).join(' OR ') + ')';
    } else {
      sitePart = 'site:' + String(sites || '').trim();
    }
    const parts = [sitePart, String(query || '').trim(), String(extra || '').trim()]
      .filter((s) => s.length > 0);
    const q = parts.join(' ');
    return BING_IMAGE_SEARCH
      + '?q=' + encodeURIComponent(q)
      + '&form=' + BING_FORM
      + '&first=1'
      + '&qft=' + BING_SIZE_FILTER;
  }

  /**
   * 经 Bing 图片搜索取候选原图直链（替代 discoverViaDuckDuckGo）。
   * 根本区别：不再需要 extract 回调、不再抓详情页，一次请求出直链。
   * @param {string|string[]} sites 站点域名
   * @param {string} query 查询词
   * @param {{emit?: Function, extra?: string, source?: string, query?: string, relevance?: boolean, limit?: number}} [opts]
   * @returns {Promise<string[]>} 直链候选；任何失败一律返回 []（绝不抛）
   *
   * 流程：节流(600ms) → 熔断检查(≤12 次/run) → netFetch(直连优先)
   *     → 非 2xx/拦截页 且可重试 → sleep(退避) 重试 1 次
   *     → parseBingImageResults → filterBingCandidates(hosts=[...sites])
   */
  async discoverViaBing(sites, query, opts = {}) {
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    const source = opts.source || (Array.isArray(sites) ? 'bing-multi' : sites);
    const queryTokens = normalizeTokens(opts.query == null ? query : opts.query);

    // 节流：相邻两次 Bing 搜索间隔 ≥ bingThrottleMs
    await this._throttleBing();
    // 熔断：单 run 请求数超限后所有 Bing 来源直接返回空
    if (this._bingRequests >= BING_MAX_REQUESTS_PER_RUN) {
      emit('log', STEP_SEARCH,
        '[cover] Bing 请求已达熔断上限（' + BING_MAX_REQUESTS_PER_RUN + '），跳过 ' + source,
        null, { level: 'warn', source });
      return [];
    }
    this._bingRequests += 1;

    const url = this.buildBingImageUrl(sites, query, opts.extra);
    emit('cover_search', STEP_SEARCH, 'Bing 图片搜索 ' + source + '…', null, { source, url, query: opts.query || query });

    const doFetch = async () => {
      const resp = await this.netFetch(url, { timeout: this.timeout });
      if (!resp.ok) return { resp, html: '' };
      const html = await resp.text();
      if (looksLikeBingBlockPage(html)) {
        // 拦截页映射成 429，触发一次重试
        return { resp: { ok: false, status: 429, error: 'bing-block-page' }, html: '' };
      }
      return { resp, html };
    };

    let result = await doFetch();
    if (!result.resp.ok && this._bingRetryable(result.resp)) {
      await this._sleep(this.bingRetryDelayMs);
      result = await doFetch();
    }
    if (!result.resp.ok) {
      emit('log', STEP_SEARCH, '[cover] ' + source + ' Bing 检索失败：' + (result.resp.error || ('HTTP ' + (result.resp.status || '?'))),
        null, { level: 'info', source });
      return [];
    }

    const items = parseBingImageResults(result.html);
    const hosts = Array.isArray(sites) ? sites.slice() : [sites];
    const urls = filterBingCandidates(items, queryTokens, { hosts, limit: opts.limit });
    if (!urls.length) {
      emit('log', STEP_SEARCH, '[cover] ' + source + ' 未检索到相关直链', null, { level: 'info', source });
      return [];
    }
    emit('cover_search', STEP_SEARCH, source + ' 命中 ' + urls.length + ' 张候选', null, { source, count: urls.length });
    return urls;
  }

  /**
   * 构造 wallhaven 搜索 API 地址（免 key 公开接口）。
   *
   * categories=100 → 只要 general 类（游戏原画 / Key Art / 截图都在 general，**不在 anime**）；
   * purity=100 → 只要 SFW；atleast 直接在服务端过滤分辨率；sorting 默认按相关度。
   * 四个参数都提成模块级常量并允许 opts 覆盖，不再硬编码在 URL 拼接串里。
   * @param {string} gameName 游戏名
   * @param {{atleast?: string, sorting?: string, categories?: string, purity?: string}} [opts]
   * @returns {string} 完整 API 地址
   */
  buildWallhavenApiUrl(gameName, opts = {}) {
    const atleast = opts.atleast || this.wallhaven.atleast;
    const sorting = opts.sorting || this.wallhaven.sorting;
    const categories = opts.categories || this.wallhaven.categories;
    const purity = opts.purity || this.wallhaven.purity;
    return WALLHAVEN_API
      + '?q=' + encodeURIComponent(String(gameName == null ? '' : gameName).trim())
      + '&atleast=' + encodeURIComponent(atleast)
      + '&categories=' + encodeURIComponent(categories)
      + '&purity=' + encodeURIComponent(purity)
      + '&sorting=' + encodeURIComponent(sorting);
  }

  /**
   * 解析 wallhaven API 响应，取满足分辨率下限的直链。
   * @param {object} json API 响应体
   * @param {{minWidth?: number, minHeight?: number}} [opts] 分辨率下限
   * @returns {string[]} 直链列表（服务端相关度序）
   */
  parseWallhavenResults(json, opts = {}) {
    const minW = Number.isFinite(opts.minWidth) ? opts.minWidth : MIN_WIDTH;
    const minH = Number.isFinite(opts.minHeight) ? opts.minHeight : MIN_HEIGHT;
    if (!json || !Array.isArray(json.data)) return [];
    const out = [];
    for (const it of json.data) {
      if (!it || typeof it.path !== 'string' || !it.path) continue;
      const w = Number(it.dimension_x);
      const h = Number(it.dimension_y);
      // 维度字段缺失时不武断丢弃：下载后仍会做本地校验，这里只挡掉明确不达标的
      if (Number.isFinite(w) && Number.isFinite(h) && (w < minW || h < minH)) continue;
      const url = normalizeUrl(it.path);
      if (url) out.push(url);
    }
    return out;
  }

  /**
   * YouTube maxres 缩略图直链（规范第 6 级）。
   * @param {string} videoId 视频 id
   * @returns {string} 直链
   */
  youtubeThumbUrl(videoId) {
    return YT_THUMB_CDN + '/' + String(videoId == null ? '' : videoId) + '/maxresdefault.jpg';
  }

  // ─────────────────────── 带 IO 的底层方法 ───────────────────────

  /**
   * 统一的超时 signal（Node 18+ 有 AbortSignal.timeout；缺失时降级为不设超时）。
   * @returns {AbortSignal|undefined}
   */
  timeoutSignal() {
    try {
      return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(this.timeout)
        : undefined;
    } catch (e) {
      return undefined;
    }
  }

  /**
   * 直连优先的取文本/取图请求（Bing + Steam CDN 专用）。
   *
   * 三态机（实例级 `directFirstOk` 跨来源共享）：
   *   null = 未探测 → 本次用 `proxy:null` 直连，超时用 DIRECT_PROBE_TIMEOUT(8s)
   *   true = 直连可用 → 后续全部 `proxy:null` 直连，超时用 this.timeout
   *   false = 直连不可用 → 后续不再试直连，直接走 resolveProxy 默认路径
   *
   * 只有「传输层异常/超时」才把 `directFirstOk` 置 false；HTTP 4xx/5xx 属于目标站的回答，
   * 不算直连不可用（Steam CDN 缺资源时天然 404，绝不能因此判定直连挂了）。
   * `MATERIAL_DIRECT_FIRST` = auto(默认)/always/never 可现场逃生，从 this.env 读取。
   *
   * @param {string} url
   * @param {{headers?: object, timeout?: number, accept?: string}} [opts]
   * @returns {Promise<object>} proxyFetch 形态的响应对象
   */
  async netFetch(url, opts = {}) {
    const headers = Object.assign({}, this.bingHeaders, opts.headers || {});
    const timeout = opts.timeout || this.timeout;
    const mode = String((this.env && this.env[DIRECT_FIRST_ENV_KEY]) || 'auto').toLowerCase();
    const allowDirect = mode !== 'never';
    const forceDirect = mode === 'always';

    let useDirect;
    if (this.directFirstOk === true) useDirect = true;
    else if (this.directFirstOk === false) useDirect = false;
    else useDirect = allowDirect;
    if (forceDirect) useDirect = true;

    const call = (proxy) => this.fetch(url, {
      headers,
      timeout: (proxy === null && this.directFirstOk !== true) ? DIRECT_PROBE_TIMEOUT : timeout,
      env: this.env,
      proxy, // null = 强制直连；undefined = 走 resolveProxy 默认
      signal: this.timeoutSignal(),
    });

    const failed = (e, status) => ({
      ok: false, status, error: (e && e.message) ? e.message : String(e),
      async text() { return ''; }, async json() { throw new Error('no json'); },
      async arrayBuffer() { return new ArrayBuffer(0); },
    });

    let resp;
    let directUsed = useDirect;
    try {
      resp = await call(useDirect ? null : undefined);
    } catch (e) {
      if (useDirect && this.directFirstOk !== true) {
        // 直连探测失败 → 降级代理，并标记直连不可用
        this.directFirstOk = false;
        directUsed = false;
        try {
          resp = await call(undefined);
        } catch (e2) {
          return failed(e2, 0);
        }
      } else {
        return failed(e, 0);
      }
    }
    // 直连探测成功 → 标记直连可用
    if (directUsed && this.directFirstOk !== false) this.directFirstOk = true;
    return resp;
  }

  /** Bing 请求节流：保证相邻两次 Bing 搜索间隔 ≥ bingThrottleMs。 */
  async _throttleBing() {
    const now = Date.now();
    const wait = this._lastBingAt
      ? Math.max(0, this.bingThrottleMs - (now - this._lastBingAt))
      : 0;
    if (wait > 0) await this._sleep(wait);
    this._lastBingAt = Date.now();
  }

  /** 判定 Bing 响应是否值得重试（传输层异常 / 429 / 5xx / 拦截页映射的 429）。 */
  _bingRetryable(resp) {
    if (!resp || resp.ok) return false;
    const s = resp.status || 0;
    return s === 0 || s === 429 || s >= 500;
  }

  /** 睡眠辅助（单测可注入 bingRetryDelayMs=0 跳过）。 */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * GET 一个页面并返回文本（任何异常都收敛为 {ok:false}，不向上抛）。
   * @param {string} url 目标地址
   * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
   */
  async httpText(url, opts = {}) {
    try {
      const resp = await this.fetch(url, {
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
        },
        redirect: 'follow',
        // timeout 供 lib/http.js 的 proxyFetch 使用；signal 供注入的原生 fetch 使用，两者并存
        timeout: this.timeout,
        env: this.env,
        signal: this.timeoutSignal(),
      });
      if (!resp || !resp.ok) return { ok: false, error: 'HTTP ' + ((resp && resp.status) || '?') };
      const text = await resp.text();
      return { ok: true, text: String(text == null ? '' : text) };
    } catch (e) {
      return { ok: false, error: '请求失败：' + (e && e.message ? e.message : String(e)) };
    }
  }

  /**
   * GET 一个 JSON 接口（任何异常都收敛为 {ok:false}）。
   * @param {string} url 目标地址
   * @param {{timeout?: number, headers?: object}} [opts]
   * @returns {Promise<{ok: boolean, json?: object, error?: string}>}
   */
  async httpJson(url, opts = {}) {
    try {
      const resp = await this.fetch(url, {
        headers: Object.assign({ 'User-Agent': this.userAgent, Accept: 'application/json' }, opts.headers || {}),
        redirect: 'follow',
        timeout: opts.timeout || this.timeout,
        env: this.env,
        signal: this.timeoutSignal(),
      });
      if (!resp || !resp.ok) return { ok: false, error: 'HTTP ' + ((resp && resp.status) || '?') };
      const json = await resp.json();
      return { ok: true, json };
    } catch (e) {
      return { ok: false, error: '请求失败：' + (e && e.message ? e.message : String(e)) };
    }
  }

  /**
   * 下载一张图并解析真实尺寸（不写盘）。
   * @param {string} url 图片直链
   * @param {{timeout?: number, headers?: object}} [opts]
   * @returns {Promise<{ok: boolean, buf?: Buffer, size?: object, error?: string}>}
   */
  async fetchImage(url, opts = {}) {
    let resp = null;
    try {
      resp = await this.fetch(url, {
        headers: Object.assign(
          { 'User-Agent': this.userAgent, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
          opts.headers || {},
        ),
        redirect: 'follow',
        timeout: opts.timeout || this.timeout,
        env: this.env,
        signal: this.timeoutSignal(),
      });
    } catch (e) {
      return { ok: false, error: '请求失败：' + (e && e.message ? e.message : String(e)) };
    }
    if (!resp || !resp.ok) return { ok: false, error: 'HTTP ' + ((resp && resp.status) || '?') };
    let buf = null;
    try {
      buf = Buffer.from(await resp.arrayBuffer());
    } catch (e) {
      return { ok: false, error: '读取响应体失败：' + (e && e.message ? e.message : String(e)) };
    }
    const size = readImageSize(buf);
    if (!size) return { ok: false, error: '无法识别图片格式（可能是 HTML 错误页）' };
    return { ok: true, buf, size };
  }

  /**
   * 把图片字节写成规范要求的 `封面.jpg`。
   *
   * 关键点：wallhaven / alphacoders 的直链**经常是 PNG**（实测 Just Cause 4 第一条就是 image/png），
   * 而规范要求封面必须是 JPG。这里绝不把 png 字节直接改名成 .jpg（那会产出一个扩展名撒谎的坏文件），
   * 而是先按真实格式落盘 `封面.png`，再用 ffmpeg 转码出 `封面.jpg` 并删掉原图。
   * ffmpeg 完全不可用时才保留原格式（有总比没有强），并用 converted=false 如实上报。
   * @param {Buffer} buf 图片字节
   * @param {{format: string}} size readImageSize 的结果
   * @param {string} outDir 目标目录
   * @returns {Promise<{ok: boolean, file?: string, path?: string, converted?: boolean, error?: string}>}
   */
  async saveCover(buf, size, outDir) {
    const ext = extForImageFormat(size && size.format);
    const rawName = COVER_BASE + ext;
    const rawPath = path.join(outDir, rawName);
    try {
      this.fs.writeFileSync(rawPath, buf);
    } catch (e) {
      return { ok: false, error: '写盘失败：' + (e && e.message ? e.message : String(e)) };
    }
    if (ext === '.jpg') return { ok: true, file: COVER_FILE, path: rawPath, converted: false };

    // 规范明确「格式：JPG（保存为 封面.jpg）」→ 有 ffmpeg 就转，没有就保留原格式并说明
    const probe = this.resolveProbe();
    if (probe && typeof probe.convertToJpg === 'function') {
      const jpgPath = path.join(outDir, COVER_FILE);
      let conv = { ok: false };
      try {
        conv = await probe.convertToJpg(rawPath, jpgPath);
      } catch (e) {
        conv = { ok: false, error: e && e.message ? e.message : String(e) };
      }
      if (conv && conv.ok) {
        try { this.fs.unlinkSync(rawPath); } catch (e) { /* 原图删不掉不影响结果 */ }
        return { ok: true, file: COVER_FILE, path: jpgPath, converted: true };
      }
    }
    return { ok: true, file: rawName, path: rawPath, converted: false };
  }

  /**
   * 依次尝试一批候选直链：下载 → 校验真实分辨率 → 达标即写盘返回。
   * @param {string[]} urls 候选直链
   * @param {string} outDir 目标目录
   * @param {{
   *   emit?: Function, source?: string, requireMin?: boolean,
   *   minSize?: {width?: number, height?: number}, limit?: number
   * }} [opts] requireMin=false 时跳过尺寸校验（仅 YouTube 降级档使用）
   * @returns {Promise<{ok: boolean, file?: string, path?: string, width?: number, height?: number, url?: string, error?: string}>}
   */
  async tryCandidates(urls, outDir, opts = {}) {
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    const source = opts.source || 'unknown';
    const requireMin = opts.requireMin !== false;
    const minSize = opts.minSize || { width: MIN_WIDTH, height: MIN_HEIGHT };
    const limit = Number.isFinite(opts.limit) ? opts.limit : MAX_CANDIDATES_PER_SOURCE;
    const list = (Array.isArray(urls) ? urls : []).slice(0, Math.max(0, limit));
    if (!list.length) return { ok: false, error: '无候选直链' };

    let lastError = '无候选直链';
    for (const url of list) {
      emit('cover_download', STEP_DOWNLOAD, 'GET ' + (SOURCE_LABEL[source] || source) + ' 候选图…', null, { url, source });
      const got = await this.fetchImage(url, opts.fetchOpts || {});
      if (!got.ok) {
        lastError = got.error || '下载失败';
        emit('log', STEP_DOWNLOAD, '[cover] ' + source + ' 候选不可用：' + lastError, null, { level: 'info' });
        continue;
      }
      // 硬校验：不信 URL 里的分辨率字样，只认实际字节头解析出来的尺寸
      if (requireMin && !meetsMinSize(got.size, minSize)) {
        lastError = '尺寸不达标 ' + got.size.width + '×' + got.size.height;
        emit('log', STEP_DOWNLOAD, '[cover] ' + source + ' 候选 ' + lastError + '，继续下一个', null, { level: 'info' });
        continue;
      }
      const saved = await this.saveCover(got.buf, got.size, outDir);
      if (!saved.ok) {
        lastError = saved.error || '写盘失败';
        continue;
      }
      return {
        ok: true,
        file: saved.file,
        path: saved.path,
        width: got.size.width,
        height: got.size.height,
        format: got.size.format,
        converted: saved.converted === true,
        bytes: got.buf.length,
        url,
        source,
      };
    }
    return { ok: false, error: lastError, source };
  }

  // ─────────────────────── Steam 官方 CDN 图（双档：严格 / 低分辨率降级） ───────────────────────

  /**
   * 拼 Steam CDN 图片地址（官方主视觉，免 key 直连）。
   * @param {string|number} appId 应用 id
   * @param {string} file 文件名（如 library_hero_2x.jpg）
   * @returns {string} 完整直链
   */
  buildSteamCdnUrl(appId, file) {
    return STEAM_CDN_BASE + '/' + String(appId == null ? '' : appId).trim() + '/' + String(file || '');
  }

  /**
   * 按档位列出某 app 的 Steam CDN 候选图直链。
   * @param {string|number} appId 应用 id
   * @param {'strict'|'lowres'} tier strict=官方高清主视觉（hero_2x / page_bg）；lowres=hero 单倍（降级用）
   * @returns {string[]} 直链（appId 非纯数字时返回空数组）
   */
  buildSteamCdnCandidates(appId, tier) {
    const id = String(appId == null ? '' : appId).trim();
    if (!/^\d+$/.test(id)) return [];
    const files = tier === 'hero' ? STEAM_CDN_HERO : (tier === 'lowres' ? STEAM_CDN_LOWRES : STEAM_CDN_STRICT);
    return files.map((f) => this.buildSteamCdnUrl(id, f));
  }

  /**
   * 反查 Steam appid：优先入参 → 命中缓存 → Steam storesearch（再经 pickRelevantSteamAppId 取相关项）。
   * @param {string} query 查询词（已是决策后的英文名或原名）
   * @param {{steamAppId?: string, emit?: Function, lookup?: boolean}} [opts]
   * @returns {Promise<string>} appid 字符串（未找到返回 ''）
   */
  async resolveSteamAppId(query, opts = {}) {
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    const direct = String(opts.steamAppId == null ? '' : opts.steamAppId).trim();
    if (direct) {
      this.steamAppIdCache.set(query, direct);
      return direct;
    }
    if (this.steamAppIdCache.has(query)) return this.steamAppIdCache.get(query);
    if (opts.lookup === false) return '';

    const url = this.buildSteamSearchUrl(query);
    emit('cover_search', STEP_SEARCH, 'Steam storesearch 反查 appid（' + query + '）…', null, { source: 'steam-cdn', url });
    try {
      const res = await this.httpJson(url, { timeout: SEARCH_TIMEOUT });
      if (!res.ok) {
        emit('log', STEP_SEARCH, '[cover] Steam storesearch 失败：' + res.error, null, { level: 'info' });
        return '';
      }
      const tokens = normalizeTokens(query);
      const appId = pickRelevantSteamAppId(res.json, tokens);
      if (appId) this.steamAppIdCache.set(query, appId);
      return appId;
    } catch (e) {
      emit('log', STEP_SEARCH, '[cover] Steam storesearch 异常：' + (e && e.message ? e.message : String(e)), null, { level: 'info' });
      return '';
    }
  }

  /**
   * 取 Steam 官方 CDN 图（第 1 级严格档 / 第 9 级低分辨率降级档）。
   * strict 档强制尺寸门槛（不达标即失败，交后续档）；lowres 档跳过门槛但如实标 degraded。
   * @param {string|number} appId 应用 id
   * @param {string} outDir 目标目录
   * @param {{emit?: Function, tier?: 'strict'|'lowres'}} [opts]
   * @returns {Promise<object>} tryCandidates 结果（附 degraded）
   */
  async fromSteamCdn(appId, outDir, opts = {}) {
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    const tier = opts.tier === 'hero' ? 'hero' : (opts.tier === 'lowres' ? 'lowres' : 'strict');
    const source = tier === 'lowres' ? 'steam-cdn-lowres' : (tier === 'hero' ? 'steam-cdn-hero' : 'steam-cdn');
    const id = String(appId == null ? '' : appId).trim();
    if (!id) return { ok: false, error: '无可用 Steam appid', source };
    const urls = this.buildSteamCdnCandidates(id, tier);
    // 官方图一律优先采纳（capsule 最大 1232×706 不满足 1920×1080 门槛），尺寸不达标标 degraded，
    // 由 collect.js 对「非官方来源」才用抽帧覆盖。
    const requireMin = false;
    const r = await this.tryCandidates(urls, outDir, { emit, source, requireMin });
    if (!r.ok) return r;
    // 实测尺寸未达门槛则标记 degraded
    const degraded = !meetsMinSize({ width: r.width, height: r.height }, { width: MIN_WIDTH, height: MIN_HEIGHT });
    return Object.assign({}, r, { degraded, source });
  }

  // ─────────────────────── 各级来源 ───────────────────────

  /**
   * 取本次来源实际使用的查询词：`opts.query` 优先（fetchCover 的双轮策略产物），
   * 缺省退回传入的原名，保证这些方法被单独调用时行为不变。
   * @param {string} gameName 原名
   * @param {{query?: string}} [opts]
   * @returns {string} 查询词
   */
  pickQuery(gameName, opts = {}) {
    const q = String(opts.query == null ? '' : opts.query).trim();
    if (q) return q;
    return String(gameName == null ? '' : gameName).trim();
  }

  /**
   * 第 5 级：4kwallpapers.com，改经 Bing 图片搜索取原图直链（不再抓站内详情页）。
   * @param {string} gameName 游戏名
   * @param {string} outDir 目标目录
   * @param {{emit?: Function, query?: string}} [opts] query 为本轮实际查询词（英文名优先）
   * @returns {Promise<object>} tryCandidates 结果（附 queryUsed）
   */
  async from4kWallpapers(gameName, outDir, opts = {}) {
    const query = this.pickQuery(gameName, opts);
    const urls = await this.discoverViaBing('4kwallpapers.com', query, {
      emit: opts.emit, extra: 'key art', source: '4kwallpapers', query,
    });
    const r = await this.tryCandidates(urls, outDir, { emit: opts.emit, source: '4kwallpapers' });
    return Object.assign({}, r, { queryUsed: query });
  }

  /**
   * 第 6 级：alphacoders.com，改经 Bing 图片搜索取原图直链。
   * @param {string} gameName 游戏名
   * @param {string} outDir 目标目录
   * @param {{emit?: Function, query?: string}} [opts]
   * @returns {Promise<object>} tryCandidates 结果（附 queryUsed）
   */
  async fromAlphacoders(gameName, outDir, opts = {}) {
    const query = this.pickQuery(gameName, opts);
    const urls = await this.discoverViaBing('alphacoders.com', query, {
      emit: opts.emit, extra: 'wallpaper', source: 'alphacoders', query,
    });
    const r = await this.tryCandidates(urls, outDir, { emit: opts.emit, source: 'alphacoders' });
    return Object.assign({}, r, { queryUsed: query });
  }

  /**
   * 第 3 级：wallhaven.cc 公开 JSON API（无需 key，本链路最可靠的可编程源）。
   *
   * 这一级不做本地相关性校验：wallhaven 是真正的关键词检索接口，查不中就返回 0 条
   * （不像 DuckDuckGo 会给一个「泛结果页」），且其直链是 `wallhaven-z8lo95.jpg` 这种
   * 无语义哈希名，slug 上根本没有可校验的信息。防错图靠「喂对英文查询词」。
   * @param {string} gameName 游戏名
   * @param {string} outDir 目标目录
   * @param {{emit?: Function, query?: string}} [opts]
   * @returns {Promise<object>} tryCandidates 结果（附 queryUsed）
   */
  async fromWallhaven(gameName, outDir, opts = {}) {
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    const query = this.pickQuery(gameName, opts);
    const api = this.buildWallhavenApiUrl(query);
    emit('cover_search', STEP_SEARCH, '检索 wallhaven.cc API（q=' + query + '）…', null, {
      source: 'wallhaven', url: api, query,
    });
    const r = await this.httpJson(api);
    if (!r.ok) {
      emit('log', STEP_SEARCH, '[cover] wallhaven 检索失败：' + r.error, null, { level: 'info' });
      return { ok: false, error: r.error, source: 'wallhaven', queryUsed: query };
    }
    const urls = this.parseWallhavenResults(r.json);
    if (!urls.length) {
      emit('log', STEP_SEARCH, '[cover] wallhaven 无满足 ≥1920×1080 的结果（q=' + query + '）', null, { level: 'info' });
      return { ok: false, error: 'wallhaven 无命中', source: 'wallhaven', queryUsed: query };
    }
    emit('cover_search', STEP_SEARCH, 'wallhaven 命中 ' + urls.length + ' 张候选', null, {
      source: 'wallhaven',
      count: urls.length,
      query,
    });
    const got = await this.tryCandidates(urls, outDir, { emit: opts.emit, source: 'wallhaven' });
    return Object.assign({}, got, { queryUsed: query });
  }

  /**
   * 第 4 级：用户指定 URL。
   * @param {string} url 用户提供的图片直链
   * @param {string} outDir 目标目录
   * @param {{emit?: Function}} [opts]
   * @returns {Promise<object>} tryCandidates 结果
   */
  async fromUserUrl(url, outDir, opts = {}) {
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    const clean = normalizeUrl(url);
    if (!clean) return { ok: false, error: '未提供合法的用户封面 URL', source: 'user' };
    emit('cover_search', STEP_SEARCH, '使用用户指定 URL', null, { source: 'user', url: clean });
    return this.tryCandidates([clean], outDir, { emit: opts.emit, source: 'user', limit: 1 });
  }

  /**
   * 第 7 级：游戏媒体站（Bing site: 跨多站 OR 搜索 OG 图）。
   * 覆盖 Nintendo/PlayStation/Xbox/IGN/GameSpot/PCGamer 等，一次 Bing 请求出直链，
   * 不再逐站抓详情页。host 校验只认 purl 域名（图挂 CDN 上，校验 murl 会误杀）。
   */
  async fromGameSites(gameName, outDir, opts = {}) {
    const query = this.pickQuery(gameName, opts);
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    const urls = await this.discoverViaBing(GAME_MEDIA_SITES, query, {
      emit, extra: 'wallpaper', source: 'game-sites', query,
    });
    if (!urls.length) {
      return { ok: false, error: '游戏媒体站未找到封面', source: 'game-sites', queryUsed: query };
    }
    const r = await this.tryCandidates(urls, outDir, { emit, source: 'game-sites' });
    return Object.assign({}, r, { queryUsed: query });
  }

  /**
   * 第 8 级：中文游戏站（游民星空 / 3DM / 游侠 / 网易 / 腾讯），用原名（中文）搜索。
   * ⚠ 水印风险：这些站经常在图上打 logo，结果仅作保底。
   */
  async fromChineseSites(gameName, outDir, opts = {}) {
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    // 优先用原始中文名（collect.js 传来的 originalName），回退到 gameName
    const cname = String(opts.originalName || gameName || '').trim();
    if (!cname) return { ok: false, error: '无可用中文名', source: 'chinese-sites' };
    const urls = await this.discoverViaBing(CHINESE_WALLPAPER_SITES, cname, {
      emit, extra: '壁纸', source: 'chinese-sites', query: cname,
    });
    if (!urls.length) {
      return { ok: false, error: '中文游戏站未找到封面', source: 'chinese-sites', queryUsed: cname };
    }
    const r = await this.tryCandidates(urls, outDir, { emit, source: 'chinese-sites' });
    return Object.assign({}, r, { queryUsed: cname, watermarkRisk: true });
  }

  /**
   * 第 3 级：Reddit 壁纸社区（r/gamewallpaper + r/wallpapers）。
   * Reddit 公开 JSON API 无需认证，只需带 User-Agent；按相关性搜索取直链图片。
   * 新增相关性闸门：贴标题须与查询词相关，挡掉「热门但与本游戏无关」的图。
   */
  async fromReddit(gameName, outDir, opts = {}) {
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    const query = String(opts.query || gameName || '').trim();
    if (!query) return { ok: false, error: '无可用查询词', source: 'reddit' };
    const queryTokens = normalizeTokens(query);
    const subreddits = ['gamewallpaper', 'wallpapers'];
    for (const sub of subreddits) {
      try {
        const url = 'https://www.reddit.com/r/' + sub + '/search.json?q='
          + encodeURIComponent(query) + '&sort=relevance&limit=10&restrict_sr=on';
        emit('cover_search', STEP_SEARCH, '检索 Reddit r/' + sub + '…', null, { source: 'reddit', url });
        const res = await this.httpJson(url, { timeout: SEARCH_TIMEOUT });
        if (!res.ok) continue;
        const data = res.json;
        const posts = (data.data && data.data.children) || [];
        const urls = [];
        for (const p of posts) {
          const postUrl = (p.data && p.data.url) || '';
          if (!/\.(jpg|jpeg|png|webp)(\?|$)/i.test(postUrl)) continue;
          // 相关性闸门：贴标题须与查询词相关（i.redd.it 类无语义 slug，只能靠标题判）
          if (!isRelevantCandidate(p.data.title || '', queryTokens)
            && !isRelevantCandidate(extractSlugFromUrl(postUrl), queryTokens)) {
            continue;
          }
          urls.push(postUrl);
        }
        if (!urls.length) continue;
        const r = await this.tryCandidates(urls, outDir, { emit, source: 'reddit' });
        if (r.ok) return Object.assign({}, r, { queryUsed: query, subreddit: sub });
      } catch (e) {
        // 静默降级
      }
    }
    return { ok: false, error: 'Reddit 社区未找到封面', source: 'reddit', queryUsed: query };
  }

  /**
   * 第 6 级：YouTube 官方宣传片缩略图。
   *
   * 规范一边把它列为第 6 级来源，一边在《封面要求》里写死「分辨率：至少 1920×1080」，
   * 并同时注明本级「通常只有 1280×720」——两条规则冲突。裁定依据：第 7 级（主视频抽帧）
   * 排在它后面且必然产出 1920×1080，说明规范并不打算用 720p 顶替硬指标。
   * 故本级按「降级候选」处理：
   *   · 实测达标（少数频道 maxres 更大）→ 正常采纳，degraded=false；
   *   · 实测不达标 → 仍然落盘保底，但标记 degraded=true，
   *     由 collect.js 优先用第 7 级抽帧覆盖；抽帧也失败时才保留它，保证「有总比没有强」。
   * @param {string} videoId YouTube 视频 id
   * @param {string} outDir 目标目录
   * @param {{emit?: Function}} [opts]
   * @returns {Promise<object>} 结果对象，附 degraded 标记
   */
  async fromYouTube(videoId, outDir, opts = {}) {
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    const id = String(videoId == null ? '' : videoId).trim();
    if (!id) return { ok: false, error: '无可用的宣传片视频 id', source: 'youtube' };
    const url = this.youtubeThumbUrl(id);
    emit('cover_search', STEP_SEARCH, '回退：YouTube maxresdefault 缩略图', null, { source: 'youtube', url });

    const got = await this.fetchImage(url);
    if (!got.ok) return { ok: false, error: got.error, source: 'youtube' };
    const meets = meetsMinSize(got.size, { width: MIN_WIDTH, height: MIN_HEIGHT });
    const saved = await this.saveCover(got.buf, got.size, outDir);
    if (!saved.ok) return { ok: false, error: saved.error, source: 'youtube' };
    return {
      ok: true,
      degraded: !meets,
      file: saved.file,
      path: saved.path,
      width: got.size.width,
      height: got.size.height,
      format: got.size.format,
      converted: saved.converted === true,
      bytes: got.buf.length,
      url,
      videoId: id,
      source: 'youtube',
    };
  }

  // ─────────────────────── 主入口 ───────────────────────

  /**
   * 按规范优先级依次尝试 1~6 级封面来源。
   *
   * 降级语义：任何一级「网络失败 / 解析不出 / 尺寸不达标」都只记录日志并继续下一级，
   * 全过程不抛异常；调用方只需看返回值。主视频抽帧（最终兜底）不在此实现（需要已下载的主视频），
   * 由 collect.js 在本方法返回 ok=false 或 degraded=true 时接手。
   *
   * 查询词（缺陷 3）：进入循环前先 resolveEnglishTitle + buildQueryPlan 定好查询词计划，
   * 对 ENGLISH_QUERY_SOURCES 里的英文站执行「英文名查一轮 → 无果再用原名查一轮」，
   * 并把决策结果（queryPlan / queryUsed / englishTitle / englishTitleSource）原样带回返回值，
   * 前端与日志都能看到「到底用哪个词去搜的」。
   *
   * @param {string} gameName 游戏名
   * @param {string} outDir 目标目录
   * @param {{
   *   emit?: Function,
   *   coverUrl?: string,
   *   videoId?: string,
   *   englishTitle?: string,
   *   steamAppId?: string,
   *   resolveEnglish?: boolean,
   *   resolveSteam?: boolean,
   *   userUrlFirst?: boolean,
   *   sources?: string[]
   * }} [opts]
   *   coverUrl 用户指定 URL；videoId 已检索到的宣传片 id（供 youtube 降级档用）；
   *   englishTitle 调用方已知的英文名（最高优先级）；steamAppId 调用方已知的 Steam appid（省一次反查）；
   *   resolveEnglish=false 关闭英文名网络反查；resolveSteam=false 关闭 Steam appid 网络反查；
   *   userUrlFirst=true 时把用户 URL 提到最前（默认 false，严格按规范的第 4 位）
   * @returns {Promise<{
   *   ok: boolean, degraded?: boolean, source?: string, file?: string, path?: string,
   *   width?: number, height?: number, url?: string, error?: string, reason?: string,
   *   tried?: string[], queryUsed?: string, queryPlan?: string[],
   *   englishTitle?: string, englishTitleSource?: string, steamAppId?: string
   * }>}
   */
  async fetchCover(gameName, outDir, opts = {}) {
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    const name = String(gameName == null ? '' : gameName).trim();
    const tried = [];
    const failures = [];

    // ── 缺陷 3：先把查询词定下来（英文名优先，原名兜底）──
    const english = await this.resolveEnglishTitle(name, {
      englishTitle: opts.englishTitle,
      emit,
      lookup: opts.resolveEnglish !== false,
      ytDlpPath: opts.ytDlpPath,
    });
    const queryPlan = buildQueryPlan(name, english.title);
    if (!queryPlan.length) queryPlan.push(name);
    // ── Steam appid 反查（供 steam-cdn 双档使用，优先级最高）──
    const steamAppId = await this.resolveSteamAppId(queryPlan[0] || name, {
      steamAppId: opts.steamAppId,
      emit,
      lookup: opts.resolveSteam !== false,
    });
    const meta = {
      queryPlan: queryPlan.slice(),
      englishTitle: english.title || '',
      englishTitleSource: english.source || 'none',
      steamAppId,
    };
    emit('log', STEP_SEARCH,
      '[cover] 查询词计划：' + queryPlan.join(' → ') + '（英文名来源：' + meta.englishTitleSource
      + '；Steam appid：' + (steamAppId || '无') + '）',
      null, Object.assign({ level: 'info' }, meta));

    // 规范《封面来源优先级》表格顺序；userUrlFirst 仅在调用方显式要求时改变位次
  // youtube（官方宣传片缩略图）提级到壁纸站之前：无 Steam 页的游戏（PS5 独占等）也优先用发行商官方图
  let order = ['steam-cdn', 'youtube', 'steam-cdn-hero', 'wallhaven', 'reddit', 'user', '4kwallpapers', 'alphacoders', 'game-sites', 'chinese-sites', 'steam-cdn-lowres'];
    if (opts.userUrlFirst === true) order = ['user'].concat(order.filter((s) => s !== 'user'));
    if (Array.isArray(opts.sources) && opts.sources.length) {
      order = order.filter((s) => opts.sources.indexOf(s) >= 0);
    }

    for (const source of order) {
      // 缺少必需入参的来源直接跳过，不计入失败
      if (source === 'user' && !normalizeUrl(opts.coverUrl)) continue;
      if (source === 'youtube' && !String(opts.videoId || '').trim()) continue;
      if ((source === 'steam-cdn' || source === 'steam-cdn-hero' || source === 'steam-cdn-lowres') && !steamAppId) continue;

      tried.push(source);
      // 只有「靠关键词检索」的英文站才需要多轮查询词；user/youtube 是直链，跑一轮即可
      const usesQuery = ENGLISH_QUERY_SOURCES.indexOf(source) >= 0;
      const plan = usesQuery ? queryPlan : [name];

      let r = { ok: false, error: '未执行' };
      let usedQuery = '';
      for (let round = 0; round < plan.length; round += 1) {
        const query = plan[round];
        usedQuery = usesQuery ? query : '';
        if (round > 0) {
          emit('log', STEP_SEARCH,
            '[cover] ' + (SOURCE_LABEL[source] || source) + ' 用「' + plan[round - 1]
            + '」无果，改用「' + query + '」再查一轮', null, { level: 'info', source, query });
        }
        try {
          if (source === 'steam-cdn') r = await this.fromSteamCdn(steamAppId, outDir, { emit, tier: 'strict' });
          else if (source === 'steam-cdn-hero') r = await this.fromSteamCdn(steamAppId, outDir, { emit, tier: 'hero' });
          else if (source === 'steam-cdn-lowres') r = await this.fromSteamCdn(steamAppId, outDir, { emit, tier: 'lowres' });
          else if (source === 'wallhaven') r = await this.fromWallhaven(name, outDir, { emit, query });
          else if (source === 'reddit') r = await this.fromReddit(name, outDir, { emit, query: name });
          else if (source === 'user') r = await this.fromUserUrl(opts.coverUrl, outDir, { emit });
          else if (source === '4kwallpapers') r = await this.from4kWallpapers(name, outDir, { emit, query });
          else if (source === 'alphacoders') r = await this.fromAlphacoders(name, outDir, { emit, query });
          else if (source === 'game-sites') r = await this.fromGameSites(name, outDir, { emit, query });
          else if (source === 'chinese-sites') r = await this.fromChineseSites(name, outDir, { emit, originalName: opts.originalName });
          else if (source === 'youtube') r = await this.fromYouTube(opts.videoId, outDir, { emit });
        } catch (e) {
          r = { ok: false, error: '来源异常：' + (e && e.message ? e.message : String(e)) };
        }
        if (r && r.ok) break;
      }

      if (r && r.ok) {
        const label = SOURCE_LABEL[source] || source;
        const dim = (r.width || '?') + '×' + (r.height || '?');
        const queryUsed = r.queryUsed || usedQuery;
        if (r.degraded) {
          emit('cover_download', STEP_DOWNLOAD, label + ' ' + dim + '（未达 1920×1080，待抽帧覆盖）', null, {
            source, file: r.file, width: r.width, height: r.height, degraded: true, queryUsed,
          });
        } else {
          emit('cover_download', STEP_DOWNLOAD, r.file + '（' + dim + ' · ' + label + '）', true, {
            source, file: r.file, path: r.path, width: r.width, height: r.height, degraded: false, queryUsed,
          });
        }
        return Object.assign({ tried }, meta, r, { source, queryUsed: r.queryUsed || usedQuery || '' });
      }
      failures.push(source + '：' + ((r && r.error) || '未知原因'));
    }

    return Object.assign({
      ok: false,
      reason: 'cover-all-sources-failed',
      error: '规范 10 级封面来源均未取到达标图（' + (failures.join('；') || '无可用来源') + '）',
      tried,
      queryUsed: queryPlan[0] || name,
    }, meta);
  }
}

module.exports = {
  CoverFetcher,
  normalizeUrl,
  hostOf,
  // 缺陷 3：英文查询词链路（纯函数）
  hasCjk,
  isLatinTitle,
  cleanEnglishTitle,
  buildQueryPlan,
  parseSteamSearchAppId,
  parseSteamAppName,
  // 缺陷 4：相关性校验（纯函数）
  normalizeTokens,
  isRelevantCandidate,
  extractSlugFromUrl,
  extractTitleFromHtml,
  hasWordToken,
  decodeEntities,
  STOP_TOKENS,
  ROMAN_MAP,
  RELEVANCE_MIN_HIT_RATIO,
  ENGLISH_QUERY_SOURCES,
  STEAM_SEARCH_API,
  STEAM_DETAILS_API,
  SOURCE_LABEL,
  WALLHAVEN_API,
  WALLHAVEN_CATEGORIES,
  WALLHAVEN_PURITY,
  WALLHAVEN_ATLEAST,
  WALLHAVEN_SORTING,
  YT_THUMB_CDN,
  USER_AGENT,
  COVER_BASE,
  COVER_FILE,
  FETCH_TIMEOUT,
  MAX_CANDIDATES_PER_SOURCE,
  STEP_SEARCH,
  STEP_DOWNLOAD,
  MIN_WIDTH,
  MIN_HEIGHT,
  // Bing 图片搜索 + Steam CDN（供测试与下游复用）
  parseBingImageResults,
  filterBingCandidates,
  isBingItemRelevant,
  isYouTubeTitleRelevant,
  looksLikeBingBlockPage,
  pickRelevantSteamAppId,
  STEAM_CDN_BASE,
  STEAM_CDN_STRICT,
  STEAM_CDN_HERO,
  STEAM_CDN_LOWRES,
  GAME_MEDIA_SITES,
  CHINESE_WALLPAPER_SITES,
  BING_IMAGE_SEARCH,
  BING_SIZE_FILTER,
};
