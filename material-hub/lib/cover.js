// lib/cover.js —— 封面获取：严格按《素材搜集规则》「封面来源优先级」实现多级降级
//
// 替代并删除了旧的 lib/steam.js。废弃原因（Bug B 根因之二）：
//   旧实现只取 Steam library_hero.jpg（官方最大 1920×620）+ YouTube maxresdefault.jpg（1280×720），
//   两者物理上都达不到规范硬性要求的 ≥1920×1080 → 封面必然「不达标」→ 旧 collect.js 的
//   `result.success = result.coverOk` 让整条流程 100% 判失败，即用户实测的「点击运行一直不成功」。
//
// 规范《封面来源优先级》七级（本文件实现 1~6，第 7 级抽帧由 collect.js 编排层调用 probe.extractFrame）：
//   1 4kwallpapers.com   DuckDuckGo 站内搜 → 详情页 → 提取 …-1920x1080-<id>.jpg 直链
//   2 alphacoders.com    同上 → 提取 images.alphacoders.com/<id前三位>/<id>.(jpg|png)
//   3 wallhaven.cc       免费公开 JSON API（无需 key），最可靠的可编程源
//   4 用户指定 URL       opts.coverUrl
//   5 游戏媒体站（英文）   Nintendo/PlayStation/Xbox/IGN/GameSpot/PCGamer
//   5.5 中文游戏站         游民星空/3DM/游侠（可能带水印）
//   6 YouTube 缩略图     maxresdefault.jpg，通常仅 1280×720 → 按「降级候选」处理，不占用达标名额
//
// 硬约束：
//   · 每个候选「下载后」必须用 imagesize.readImageSize + meetsMinSize 校验真实分辨率再采纳，
//     绝不相信 URL 里的 1920x1080 字样（4kwallpapers 存在改名/占位图）；
//   · 任何一级失败（网络异常 / 解析不出 / 尺寸不达标）都必须干净降级到下一级，绝不抛异常中断链路；
//   · 所有网络请求带 15s 超时 + try/catch；DuckDuckGo 必须带 User-Agent，否则直接被拒（返回 403/空页）。
//   · 默认走 lib/http.js 的 proxyFetch —— Node 内置 http/https 不认 HTTP_PROXY 环境变量，
//     用 globalThis.fetch 在需要代理才能出网的机器上会 100% 超时（缺陷 2）。
//
// 缺陷 3（英文查询词链路）：4kwallpapers / alphacoders / wallhaven 都是**纯英文素材站**，
//   没有任何中文索引。此前 fetchCover 把「艾尔登法环」「仁王2」这种中文名原样喂进去，
//   必然 0 结果（实测：`Elden Ring` 24 条 vs `艾尔登法环` 0 条）。现在统一走：
//   resolveEnglishTitle() → buildQueryPlan() → 「英文名查一轮，无果再用原名查一轮」。
//   英文名来源优先级：opts.englishTitle > 原名本身就是拉丁文 > Steam 反查 > 退回原名。
//
// 缺陷 4（结果相关性校验）：DuckDuckGo 搜不到精确匹配时会返回站点首页 / 分类页 / 泛结果页，
//   旧代码从页面上抓「第一张分辨率达标的图」就当成功，于是「正当防卫4」实测拿到过
//   `persona-4-revival-…`（女神异闻录）和 `kagurabachi-key-art-…`（动漫）。
//   这比失败更糟：用户拿到一个看起来成功、实际张冠李戴的封面且毫无提示。
//   现在详情页与候选图都必须通过 isRelevantCandidate() 的 token 匹配才会被采纳，
//   整页不过就干净降级到下一个来源 —— 宁可失败（还有第 7 级 ffmpeg 抽帧兜底），也绝不给错图。
const fsDefault = require('fs');
const path = require('path');
const { readImageSize, meetsMinSize, extForImageFormat, MIN_WIDTH, MIN_HEIGHT } = require('./imagesize');
const { proxyFetch } = require('./http');

/** 单次网络请求超时（规范无明文，取 15s：够慢站点响应，又不会把 SSE 拖死）。 */
const FETCH_TIMEOUT = 15 * 1000;
/** DuckDuckGo HTML 端点（无 API key 的站内搜索通道）。 */
const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';
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
/** DuckDuckGo 结果里最多取几个详情页去抓直链。 */
const MAX_DETAIL_PAGES = 3;
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
const ENGLISH_QUERY_SOURCES = ['4kwallpapers', 'alphacoders', 'wallhaven', 'game-sites'];
/** 第 5 级「游戏媒体站」：覆盖主要平台与游戏新闻站，不限任天堂一家。 */
const GAME_MEDIA_SITES = ['nintendo.com', 'playstation.com', 'xbox.com', 'ign.com', 'gamespot.com', 'pcgamer.com'];
/** 第 5.5 级「中文游戏站」：游民星空/3DM/游侠（⚠ 可能带水印，谨慎采纳）。 */
const CHINESE_WALLPAPER_SITES = ['gamersky.com', '3dmgame.com', 'ali213.net'];

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
 * 从 DuckDuckGo HTML 搜索结果里提取可能的英文游戏名。
 *
 * DDG 返回的每个结果大致是：
 *   <a class="result__a" rel="nofollow" href="...">Elden Ring - Wikipedia</a>
 *   <a class="result__snippet">Elden Ring is a 2022 action RPG...</a>
 *
 * 只取 result__a 标题（比 snippet 干净），滤掉纯中文和非游戏类标题。
 * @param {string} html DuckDuckGo HTML 页面
 * @returns {string[]} 候选英文名字符串列表
 */
function extractWebEnglishCandidates(html) {
  const text = String(html == null ? '' : html);
  const candidates = [];
  // 匹配 <a class="result__a" ...>标题</a>
  const re = /<a\s[^>]*\bclass\s*=\s*["']\w*result__a\w*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = decodeEntities(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    if (!raw) continue;
    // 跳过纯非拉丁标题（中文/日文/韩文）
    if (!/[a-zA-Z]{4}/.test(raw)) continue;
    // 跳过太长的（大概率不是游戏名）
    if (raw.length > 100) continue;
    // 去掉末尾的来源标注 " - Wikipedia" / " | Steam" 等
    const cleaned = raw.replace(/\s*[-–—|]\s*(Wikipedia|Steam|IGN|GameSpot|Fandom|百度百科|维基百科).*$/i, '').trim();
    if (cleaned && /[a-zA-Z]{4}/.test(cleaned)) {
      candidates.push(cleaned);
    }
  }
  return candidates;
}

/**
 * 从 DuckDuckGo 搜索结果里挑最可能是游戏英文名的候选。
 * 规则：优先取与原名无关、且长度合理（3~60字符）的纯拉丁标题。
 * @param {string[]} candidates extractWebEnglishCandidates 的输出
 * @param {string} gameName 原始中文名（用于排除信息框里的中文标题）
 * @returns {string|null} 最佳英文名，无合适则 null
 */
function pickBestWebCandidate(candidates, gameName) {
  if (!candidates || !candidates.length) return null;
  const origLower = String(gameName || '').toLowerCase();
  for (const c of candidates) {
    const lower = c.toLowerCase();
    // 必须主要是拉丁字母
    if (!/^[a-zA-Z0-9\s:.'\-!&()]+$/.test(c)) continue;
    // 排除与原名大量重叠的（一般是中文搜索结果里的副标题）
    const cTokens = lower.split(/\s+/);
    if (cTokens.length <= 1) continue;
    // 长度合理
    if (c.length < 3 || c.length > 60) continue;
    return c;
  }
  return null;
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
  '4kwallpapers': '4kwallpapers.com',
  alphacoders: 'alphacoders.com',
  wallhaven: 'wallhaven.cc',
  user: '用户指定 URL',
  nintendo: 'Nintendo 官网',
  'game-sites': '游戏媒体站（英文）',
  'chinese-sites': '中文游戏站（可能带水印）',
  youtube: 'YouTube 缩略图',
  'ffmpeg-frame': '主视频抽帧',
};

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
  }

  // ─────────────────────── 缺陷 3：英文名解析 ───────────────────────

  /**
   * 构造 Steam 商店搜索地址（中文名 → appid）。
   * `l=schinese&cc=CN` 不可改成 english：实测中文 term 配 `l=english` 返回 total=0。
   * @param {string} gameName 游戏名（通常是中文名）
   * @returns {string} 完整 API 地址
   */
  buildSteamSearchUrl(gameName) {
    return STEAM_SEARCH_API
      + '?term=' + encodeURIComponent(String(gameName == null ? '' : gameName).trim())
      + '&l=schinese&cc=CN';
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
      const srRes = await this.fetch(srUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: this.timeoutSignal(),
      });
      if (!srRes.ok) {
        return { title: '', source: 'none', error: 'Wikipedia 返回 ' + srRes.status };
      }
      const srData = await srRes.json();
      const page = (srData.query && srData.query.search || [])[0];
      if (!page) {
        emit('log', STEP_SEARCH, '[cover] 维基百科未收录「' + name + '」', null, { level: 'info' });
        return { title: '', source: 'none' };
      }

      // 第二步：取英文跨语言链接
      const llUrl = 'https://zh.wikipedia.org/w/api.php?action=query&prop=langlinks'
        + '&lllang=en&pageids=' + page.pageid + '&format=json&lllimit=1';
      const llRes = await this.fetch(llUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: this.timeoutSignal(),
      });
      if (!llRes.ok) {
        return { title: '', source: 'none', error: 'Wikipedia langlinks 返回 ' + llRes.status };
      }
      const llData = await llRes.json();
      const pages = llData.query && llData.query.pages || {};
      const pg = Object.values(pages)[0];
      const ll = (pg && pg.langlinks || [])[0];
      if (!ll || !ll['*']) {
        emit('log', STEP_SEARCH, '[cover] 维基百科无英文跨语言链接', null, { level: 'info' });
        return { title: '', source: 'none' };
      }
      const title = String(ll['*']).trim();
      if (title && isLatinTitle(title) && title.length >= 3) {
        emit('cover_search', STEP_SEARCH, '维基百科英文名：' + title, null, {
          source: 'wiki', englishTitle: title, zhPage: page.title,
        });
        return { title, source: 'wiki', zhPage: page.title };
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
  buildDuckDuckGoUrl(site, gameName, extra = 'key art') {
    const q = ['site:' + String(site || '').trim(), String(gameName == null ? '' : gameName).trim(), String(extra || '').trim()]
      .filter((s) => s.length > 0)
      .join(' ');
    return DDG_HTML_URL + '?q=' + encodeURIComponent(q);
  }

  /**
   * 从 DuckDuckGo HTML 结果页提取指定站点的详情页链接。
   * DDG 的结果链接通常是跳转形式 `//duckduckgo.com/l/?uddg=<urlencoded>&rut=…`，
   * 也存在直链形式，两种都要覆盖；结果去重并保持原始排序（相关度序）。
   * @param {string} html 结果页 HTML
   * @param {string} host 目标站点域名，如 '4kwallpapers.com'
   * @returns {string[]} 命中的详情页 URL 列表
   */
  parseDuckDuckGoLinks(html, host) {
    const text = String(html == null ? '' : html);
    const target = String(host || '').toLowerCase();
    const out = [];
    const seen = new Set();
    const push = (u) => {
      const url = normalizeUrl(u);
      if (!url) return;
      const h = hostOf(url);
      if (!h || (h !== target && !h.endsWith('.' + target))) return;
      if (seen.has(url)) return;
      seen.add(url);
      out.push(url);
    };

    // ① 跳转链接：uddg=<urlencoded target>
    const redirectRe = /[?&]uddg=([^&"'\s>]+)/gi;
    let m = redirectRe.exec(text);
    while (m) {
      try {
        push(decodeURIComponent(m[1]));
      } catch (e) { /* 非法转义，跳过该条 */ }
      m = redirectRe.exec(text);
    }

    // ② 直链：href="https://<host>/…"
    const directRe = /href\s*=\s*["']((?:https?:)?\/\/[^"'\s>]+)["']/gi;
    m = directRe.exec(text);
    while (m) {
      push(m[1]);
      m = directRe.exec(text);
    }
    return out;
  }

  /**
   * 从 4kwallpapers 详情页 HTML 提取图片直链。
   * 站点直链形如 `https://4kwallpapers.com/images/wallpapers/<slug>-1920x1080-<id>.jpg`，
   * 同一页会列出多种分辨率；这里按「面积从大到小」排序并只保留 ≥1920×1080 的档位。
   * @param {string} html 详情页 HTML
   * @returns {string[]} 候选直链（已排序去重）
   */
  parse4kWallpapersDirect(html) {
    const text = String(html == null ? '' : html);
    // 同时兼容绝对 / 协议相对 / 根相对三种写法
    const re = /(?:(?:https?:)?\/\/(?:www\.)?4kwallpapers\.com)?\/images\/wallpapers\/([A-Za-z0-9._%()-]+?)-(\d{3,5})x(\d{3,5})-(\d+)\.(jpg|jpeg|png)/gi;
    const hits = [];
    const seen = new Set();
    let m = re.exec(text);
    while (m) {
      const width = Number.parseInt(m[2], 10);
      const height = Number.parseInt(m[3], 10);
      const url = 'https://4kwallpapers.com/images/wallpapers/'
        + m[1] + '-' + m[2] + 'x' + m[3] + '-' + m[4] + '.' + m[5].toLowerCase();
      if (!seen.has(url) && width >= MIN_WIDTH && height >= MIN_HEIGHT) {
        seen.add(url);
        hits.push({ url, area: width * height });
      }
      m = re.exec(text);
    }
    hits.sort((a, b) => b.area - a.area);
    return hits.map((h) => h.url);
  }

  /**
   * 从 alphacoders 详情页 URL 里解析壁纸 id（如 `…/big.php?i=1360000` → '1360000'）。
   * @param {string} url 详情页地址
   * @returns {string|null} 数字 id 字符串；解析不出返回 null
   */
  alphacodersIdFromUrl(url) {
    const s = String(url == null ? '' : url);
    const byQuery = /[?&]i=(\d+)/.exec(s);
    if (byQuery) return byQuery[1];
    const byPath = /\/(\d{4,})(?:\.html)?(?:[?#]|$)/.exec(s);
    return byPath ? byPath[1] : null;
  }

  /**
   * 按规范给出的 URL 推断规则构造 alphacoders 直链候选。
   * 规范原文：`https://images.alphacoders.com/{id前三位}/{id}.{jpg|png}`。
   * 注意 id 不足 3 位时无「前三位」可用，直接返回空数组（该源本就 404 率高，交给下一级）。
   * @param {string} id 壁纸数字 id
   * @returns {string[]} 直链候选（jpg 优先于 png）
   */
  buildAlphacodersCandidates(id) {
    const s = String(id == null ? '' : id).trim();
    if (!/^\d{3,}$/.test(s)) return [];
    const prefix = s.slice(0, 3);
    return [
      'https://images.alphacoders.com/' + prefix + '/' + s + '.jpg',
      'https://images.alphacoders.com/' + prefix + '/' + s + '.png',
    ];
  }

  /**
   * 从 alphacoders 详情页 HTML 直接提取图片直链（比 URL 推断更准，优先用）。
   * @param {string} html 详情页 HTML
   * @returns {string[]} 候选直链（去重，保持出现顺序）
   */
  parseAlphacodersDirect(html) {
    const text = String(html == null ? '' : html);
    const re = /(?:https?:)?\/\/images\.alphacoders\.com\/\d{1,5}\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png)/gi;
    const out = [];
    const seen = new Set();
    let m = re.exec(text);
    while (m) {
      const url = normalizeUrl(m[0]);
      // thumb-<id> / <id>-thumb 之类缩略图直接排除，避免下载后才发现尺寸不达标
      if (url && !seen.has(url) && !/thumb/i.test(url)) {
        seen.add(url);
        out.push(url);
      }
      m = re.exec(text);
    }
    return out;
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

  /**
   * 从 HTML 提取 og:image（Nintendo 等官网页面的主视觉通常挂在这里）。
   * @param {string} html 页面 HTML
   * @returns {string[]} 候选图片 URL
   */
  parseOgImage(html) {
    const text = String(html == null ? '' : html);
    const out = [];
    const seen = new Set();
    const re = /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image|twitter:image)(?::secure_url)?["'][^>]*>/gi;
    let m = re.exec(text);
    while (m) {
      const c = /content\s*=\s*["']([^"']+)["']/i.exec(m[0]);
      if (c) {
        const url = normalizeUrl(c[1]);
        if (url && !seen.has(url)) { seen.add(url); out.push(url); }
      }
      m = re.exec(text);
    }
    return out;
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
   * GET 一个页面并返回文本（任何异常都收敛为 {ok:false}，不向上抛）。
   * @param {string} url 目标地址
   * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
   */
  async httpText(url) {
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
   * @returns {Promise<{ok: boolean, json?: object, error?: string}>}
   */
  async httpJson(url) {
    try {
      const resp = await this.fetch(url, {
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        redirect: 'follow',
        timeout: this.timeout,
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
   * @returns {Promise<{ok: boolean, buf?: Buffer, size?: object, error?: string}>}
   */
  async fetchImage(url) {
    let resp = null;
    try {
      resp = await this.fetch(url, {
        headers: { 'User-Agent': this.userAgent, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
        redirect: 'follow',
        timeout: this.timeout,
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
      const got = await this.fetchImage(url);
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

  /**
   * 经 DuckDuckGo 找到站内详情页，再从详情页 HTML 抽出图片直链。
   *
   * 缺陷 4 修复点：新增两道相关性闸门（由 `opts.relevance` 控制）
   *   · 详情页级：详情页 URL slug 或页面标题，二者有一个能通过 isRelevantCandidate 才继续
   *     —— 挡掉 DDG 在无精确匹配时返回的站点首页 / 分类页 / 泛结果页；
   *   · 候选图级：候选直链 slug 含实义词时必须自证相关
   *     —— 挡掉「从泛结果页上抓到的第一张达标图」（persona-4-revival / kagurabachi-key-art）。
   *   alphacoders 直链是 `136/1360000.jpg` 这种纯数字 slug，无从判定，只靠详情页级闸门。
   *
   * @param {string} site 站点域名
   * @param {string} gameName 查询词（已由调用方决策为英文名或原名）
   * @param {(html: string, pageUrl: string) => string[]} extract 详情页直链提取器
   * @param {{
   *   emit?: Function, extra?: string, source?: string,
   *   relevance?: 'off'|'page'|'page+candidate', query?: string
   * }} [opts] relevance 默认 'off'（保持底层方法的通用性，由各来源方法显式开启）
   * @returns {Promise<string[]>} 直链候选（失败一律返回空数组）
   */
  async discoverViaDuckDuckGo(site, gameName, extract, opts = {}) {
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    const source = opts.source || site;
    const searchUrl = this.buildDuckDuckGoUrl(site, gameName, opts.extra);
    emit('cover_search', STEP_SEARCH, '检索 ' + (SOURCE_LABEL[source] || site) + '…', null, { source, url: searchUrl });

    const page = await this.httpText(searchUrl);
    if (!page.ok) {
      emit('log', STEP_SEARCH, '[cover] ' + site + ' 检索失败：' + page.error, null, { level: 'info' });
      return [];
    }
    const detailUrls = this.parseDuckDuckGoLinks(page.text, site).slice(0, MAX_DETAIL_PAGES);
    if (!detailUrls.length) {
      emit('log', STEP_SEARCH, '[cover] ' + site + ' 未检索到详情页', null, { level: 'info' });
      return [];
    }

    const relevance = opts.relevance || 'off';
    const queryTokens = normalizeTokens(opts.query == null ? gameName : opts.query);
    const checkPage = relevance === 'page' || relevance === 'page+candidate';
    const checkCandidate = relevance === 'page+candidate';

    const out = [];
    for (const detailUrl of detailUrls) {
      const detail = await this.httpText(detailUrl);
      if (!detail.ok) continue;

      if (checkPage) {
        const urlSlug = extractSlugFromUrl(detailUrl);
        let pageOk = isRelevantCandidate(urlSlug, queryTokens);
        let title = '';
        if (!pageOk) {
          // URL 是纯 id（alphacoders 的 big.php?i=…）时，标题是唯一可判定的依据
          title = extractTitleFromHtml(detail.text);
          pageOk = isRelevantCandidate(title, queryTokens);
        }
        if (!pageOk) {
          emit('log', STEP_SEARCH,
            '[cover] ' + source + ' 跳过不相关详情页：' + (title || urlSlug || detailUrl), null, {
              level: 'info', relevance: 'page-mismatch', url: detailUrl, query: queryTokens.join(' '),
            });
          continue;
        }
      }

      let found = [];
      try {
        found = extract(detail.text, detailUrl) || [];
      } catch (e) {
        found = [];
      }
      for (const u of found) {
        if (!u || out.indexOf(u) >= 0) continue;
        if (checkCandidate) {
          const slug = extractSlugFromUrl(u);
          if (hasWordToken(slug) && !isRelevantCandidate(slug, queryTokens)) {
            emit('log', STEP_SEARCH, '[cover] ' + source + ' 跳过不相关候选图：' + slug, null, {
              level: 'info', relevance: 'candidate-mismatch', url: u, query: queryTokens.join(' '),
            });
            continue;
          }
        }
        out.push(u);
      }
      if (out.length >= MAX_CANDIDATES_PER_SOURCE) break;
    }
    return out;
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
   * 第 1 级：4kwallpapers.com。
   * 相关性校验开到 `page+candidate`：该站的图片直链带完整 slug
   * （`persona-4-revival-3840x2160-26747.jpg`），是缺陷 4 里错图的直接来源，必须逐张核对。
   * @param {string} gameName 游戏名
   * @param {string} outDir 目标目录
   * @param {{emit?: Function, query?: string}} [opts] query 为本轮实际查询词（英文名优先）
   * @returns {Promise<object>} tryCandidates 结果（附 queryUsed）
   */
  async from4kWallpapers(gameName, outDir, opts = {}) {
    const query = this.pickQuery(gameName, opts);
    const urls = await this.discoverViaDuckDuckGo(
      '4kwallpapers.com',
      query,
      (html) => this.parse4kWallpapersDirect(html),
      { emit: opts.emit, extra: 'key art', source: '4kwallpapers', relevance: 'page+candidate', query },
    );
    const r = await this.tryCandidates(urls, outDir, { emit: opts.emit, source: '4kwallpapers' });
    return Object.assign({}, r, { queryUsed: query });
  }

  /**
   * 第 2 级：alphacoders.com。
   * 详情页直链优先；抽不出时退回规范给出的 `{id前三位}/{id}.{jpg|png}` URL 推断。
   * @param {string} gameName 游戏名
   * @param {string} outDir 目标目录
   * @param {{emit?: Function, query?: string}} [opts]
   * @returns {Promise<object>} tryCandidates 结果（附 queryUsed）
   */
  async fromAlphacoders(gameName, outDir, opts = {}) {
    const query = this.pickQuery(gameName, opts);
    const urls = await this.discoverViaDuckDuckGo(
      'alphacoders.com',
      query,
      (html, pageUrl) => {
        const direct = this.parseAlphacodersDirect(html);
        if (direct.length) return direct;
        const id = this.alphacodersIdFromUrl(pageUrl);
        return id ? this.buildAlphacodersCandidates(id) : [];
      },
      { emit: opts.emit, extra: 'wallpaper', source: 'alphacoders', relevance: 'page+candidate', query },
    );
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
   * 第 5 级：Nintendo 官网 / 厂商壁纸页。
   *
   * 说明（务必保留）：任天堂没有任何开放的壁纸检索 API，官方 media 页面的结构逐游戏而异
   * （规范原文也只说「部分游戏（如塞尔达）在官方 media 页面提供壁纸下载」），
   * 因此本级**不可能做成通用可编程源**。这里只做「轻量尝试」：
   *   DuckDuckGo 站内搜 → 取详情页的 og:image/twitter:image 主视觉 → 照常做尺寸硬校验。
   * 抓不到就静默降级到第 6 级，不视为异常。
   * 相关性校验只开 `page` 级：og:image 的文件名常是哈希/编号，候选级校验没有可用信息。
   * @param {string} gameName 游戏名
   * @param {string} outDir 目标目录
   * @param {{emit?: Function, query?: string}} [opts]
   * @returns {Promise<object>} tryCandidates 结果（附 queryUsed）
  /**
   * 第 5 级：游戏媒体站（DDG site: 跨多站搜索 OG 图）。
   * 覆盖 Nintendo/PlayStation/Xbox/IGN/GameSpot/PCGamer，
   * 不再是只搜任天堂一家。
   */
  async fromGameSites(gameName, outDir, opts = {}) {
    const query = this.pickQuery(gameName, opts);
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    for (const site of GAME_MEDIA_SITES) {
      const urls = await this.discoverViaDuckDuckGo(
        site, query,
        (html) => this.parseOgImage(html),
        { emit, extra: 'wallpaper', source: 'game-sites', relevance: 'page', query, siteLabel: site },
      );
      if (!urls.length) continue;
      const r = await this.tryCandidates(urls, outDir, { emit, source: 'game-sites' });
      if (r.ok) return Object.assign({}, r, { queryUsed: query, site });
    }
    return { ok: false, error: '所有游戏媒体站均未找到封面', source: 'game-sites', queryUsed: query };
  }

  /**
   * 第 5.5 级：中文游戏站（游民星空 / 3DM / 游侠）。
   * 用原名（中文）搜索；站内通常有壁纸专区。⚠ 水印风险：这些站经常在图上打 logo。
   */
  async fromChineseSites(gameName, outDir, opts = {}) {
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    // 优先用原始中文名（collect.js 传来的 originalName），回退到 gameName
    const cname = String(opts.originalName || gameName || '').trim();
    if (!cname) return { ok: false, error: '无可用中文名', source: 'chinese-sites' };
    for (const site of CHINESE_WALLPAPER_SITES) {
      const urls = await this.discoverViaDuckDuckGo(
        site, cname,
        (html) => this.parseOgImage(html),
        { emit, extra: '壁纸', source: 'chinese-sites', relevance: 'page', query: cname, siteLabel: site },
      );
      if (!urls.length) continue;
      const r = await this.tryCandidates(urls, outDir, { emit, source: 'chinese-sites' });
      if (r.ok) return Object.assign({}, r, { queryUsed: cname, site, watermarkRisk: true });
    }
    return { ok: false, error: '中文游戏站未找到封面', source: 'chinese-sites', queryUsed: cname };
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
   * 全过程不抛异常；调用方只需看返回值。第 7 级抽帧不在此实现（需要已下载的主视频），
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
   *   resolveEnglish?: boolean,
   *   userUrlFirst?: boolean,
   *   sources?: string[]
   * }} [opts]
   *   coverUrl 用户指定 URL；videoId 已检索到的宣传片 id（供第 6 级用）；
   *   englishTitle 调用方已知的英文名（最高优先级）；resolveEnglish=false 关闭 Steam 网络反查；
   *   userUrlFirst=true 时把用户 URL 提到最前（默认 false，严格按规范的第 4 位）
   * @returns {Promise<{
   *   ok: boolean, degraded?: boolean, source?: string, file?: string, path?: string,
   *   width?: number, height?: number, url?: string, error?: string, reason?: string,
   *   tried?: string[], queryUsed?: string, queryPlan?: string[],
   *   englishTitle?: string, englishTitleSource?: string
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
    const meta = {
      queryPlan: queryPlan.slice(),
      englishTitle: english.title || '',
      englishTitleSource: english.source || 'none',
    };
    emit('log', STEP_SEARCH,
      '[cover] 查询词计划：' + queryPlan.join(' → ') + '（英文名来源：' + meta.englishTitleSource + '）',
      null, Object.assign({ level: 'info' }, meta));

    // 规范《封面来源优先级》表格顺序；userUrlFirst 仅在调用方显式要求时改变位次
    let order = ['4kwallpapers', 'alphacoders', 'wallhaven', 'user', 'game-sites', 'chinese-sites', 'youtube'];
    if (opts.userUrlFirst === true) order = ['user'].concat(order.filter((s) => s !== 'user'));
    if (Array.isArray(opts.sources) && opts.sources.length) {
      order = order.filter((s) => opts.sources.indexOf(s) >= 0);
    }

    for (const source of order) {
      // 缺少必需入参的来源直接跳过，不计入失败
      if (source === 'user' && !normalizeUrl(opts.coverUrl)) continue;
      if (source === 'youtube' && !String(opts.videoId || '').trim()) continue;

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
          if (source === '4kwallpapers') r = await this.from4kWallpapers(name, outDir, { emit, query });
          else if (source === 'alphacoders') r = await this.fromAlphacoders(name, outDir, { emit, query });
          else if (source === 'wallhaven') r = await this.fromWallhaven(name, outDir, { emit, query });
          else if (source === 'game-sites') r = await this.fromGameSites(name, outDir, { emit, query });
          else if (source === 'chinese-sites') r = await this.fromChineseSites(name, outDir, { emit, originalName: opts.originalName });
          else if (source === 'user') r = await this.fromUserUrl(opts.coverUrl, outDir, { emit });
          else if (source === 'youtube') r = await this.fromYouTube(opts.videoId, outDir, { emit });
        } catch (e) {
          // 兜底：任何一级的意外异常都不允许中断整条降级链
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
      error: '规范前 6 级封面来源均未取到达标图（' + (failures.join('；') || '无可用来源') + '）',
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
  DDG_HTML_URL,
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
  MAX_DETAIL_PAGES,
  STEP_SEARCH,
  STEP_DOWNLOAD,
  MIN_WIDTH,
  MIN_HEIGHT,
};
