// biliup-hub/server.js —— Express 子服务（监听 127.0.0.1:3600）
// 同源校验 + 静态资源 + /api/version(回显 bootToken) + 健康检查 + 配置/凭据路由
// + 账号信息(#7) + 扫码登录(#7) + /api/upload SSE。
require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/store');
const cookies = require('./lib/cookies');
const task = require('./lib/task');
const account = require('./lib/account');
const auth = require('./lib/auth');
const logger = require('./lib/logger');

// 头像代理用的 UA（绕过 B站防盗链）；同源校验复用下方 origin 中间件。
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) biliup-hub/0.1';
// 优先用 undici 的 fetch（与 account.js 同构），便于单测注入 app.locals.avatarFetch。
function getProxyFetch() {
  try { return require('undici').fetch; } catch { return (globalThis.fetch || global.fetch); }
}
// 合集列表代理用的 fetch（与 avatar/account 同构）；便于单测注入 app.locals.seasonsFetch。
function getSeasonsFetch() {
  try { return require('undici').fetch; } catch { return (globalThis.fetch || global.fetch); }
}

// 合集分集补拉代理用的 fetch（需求①：上游 seasons 列表不返回分集时单独补拉）；
// 便于单测注入 app.locals.seasonSectionFetch。
function getSeasonSectionFetch() {
  try { return require('undici').fetch; } catch { return (globalThis.fetch || global.fetch); }
}

// 合集分集补拉：部分账号的 seasons 列表接口不返回 sections（分集下拉空），
// 需单独调 season/section 详情接口补齐（需求①：保证「选合集即生效」在分集缺失时也能补齐）。
// 上游返回结构不稳定，做多层兼容：data.sections / data.meta.sections。
// @param {Object} cf cookies 扁平对象
// @param {Function} [fetchFnOverride] 注入的 fetch（单测用）
// @returns {Promise<Array<{id:string, title:string}>>}
async function fetchSeasonSections(seasonId, cf, fetchFnOverride) {
  const fetchFn = fetchFnOverride || getSeasonSectionFetch();
  const url = 'https://member.bilibili.com/x2/creative/web/season/section?season_id='
    + encodeURIComponent(String(seasonId));
  const resp = await fetchFn(url, {
    headers: {
      'Cookie': cookies.toHeader(cf),
      'Referer': 'https://www.bilibili.com/',
      'User-Agent': USER_AGENT,
    },
  });
  if (!resp.ok) return [];
  const json = await resp.json();
  if (!json || json.code !== 0) return [];
  const data = json.data || {};
  const list = Array.isArray(data.sections)
    ? data.sections
    : (data.meta && Array.isArray(data.meta.sections) ? data.meta.sections : []);
  if (!Array.isArray(list)) return [];
  return list
    .filter((sec) => sec && sec.id != null)
    .map((sec) => ({
      id: String(sec.id),
      title: (sec.title != null ? sec.title : sec.name) || '',
    }));
}

// ── 标签推荐（需求② 修订）：游戏名 + 本地类型规则，不依赖 B站官方 tag/recommend 接口 ──
// 实测（2026-08-05）：官方 tag/recommend 对非热门游戏（如「正当防卫4」）只返回通用标签
// （演示/教程攻略/下载教程/足球游戏/游戏试玩…）——游戏名永远不会出现，且混入无关标签；
// 对热门游戏（赛博朋克2077/光环）偶尔能命中但不可靠；B站搜索接口需 wbi 签名、视频标签接口已下线。
// 故推荐改为：标题提取游戏名（必有）+ 本地规则表命中「游戏类型」标签，由前端与固定默认标签合并。
// 版本/描述词 = 游戏分享场景非内容关键词（与前端 genTags STOP_WORDS 同源口径）。
const GAME_NAME_STRIP_WORDS = [
  // 长度降序：先剥长短语避免残词（如先剥「免费学习版下载」再剥「学习版」）。
  '免费学习版下载', '官方中文版', '免安装硬盘版', '学习版下载', '官方中文',
  '免安装', '免费学习版', '学习版', '破解版', '硬盘版', '中文版', '完整版',
  '绿色版', '安装版', '便携版', '全DLC', '高级版', '豪华版', '年度版',
  '终极版', '黄金版', '下载', '免费',
];
const GAME_NAME_SENSITIVE = ['学习版', '破解版', '盗版'];

// 游戏名关键词 → 类型标签（需求②修订）：按标题/游戏名子串匹配，可多规则命中、跨规则去重。
// 新游戏补类型 = 在数组加一行（match 命中关键词，tags 为要补的类型标签），命中规则表外游戏
// 只有游戏名 + 固定默认标签（不混入无关标签）。
const GAME_GENRE_RULES = [
  // 体育
  { match: ['足球', 'fifa', '实况', 'pes', 'ea sports fc'], tags: ['体育游戏', '足球游戏'] },
  { match: ['nba', '篮球'], tags: ['体育游戏', '篮球游戏'] },
  // 竞速
  { match: ['赛车', '极限竞速', 'forza', '极品飞车', 'nfs', 'gt赛车'], tags: ['竞速游戏', '赛车游戏'] },
  // 射击
  { match: ['使命召唤', '战地', '荣誉勋章', '狙击', '光环', 'halo', '毁灭战士', 'doom', '无主之地', '守望先锋', '反恐精英', 'apex', '泰坦陨落'], tags: ['射击游戏'] },
  // 动作 / 开放世界
  { match: ['正当防卫', 'gta', '侠盗猎车', '黑道圣徒', '看门狗', '荒野大镖客', '刺客信条', '赛博朋克', 'cyberpunk'], tags: ['动作游戏', '开放世界'] },
  { match: ['战神', '鬼泣', '猎天使', '只狼', '仁王', '黑神话', '双人成行', '双影奇境', '古墓丽影', '地狱之刃'], tags: ['动作游戏'] },
  { match: ['双人成行', '双影奇境', '分手厨房'], tags: ['合作游戏'] },
  // 角色扮演
  { match: ['巫师', '上古卷轴', '博德之门', '辐射', 'fallout', '艾尔登法环', 'elden ring', '质量效应', '最终幻想', '勇者斗恶龙', '宝可梦', '暗黑破坏神', '神界', '龙腾世纪'], tags: ['角色扮演', 'RPG'] },
  // 策略
  { match: ['文明', '帝国时代', '全面战争', '全战', '群星', '星际争霸', '英雄无敌', 'xcom'], tags: ['策略游戏'] },
  // 生存 / 恐怖
  { match: ['森林之子', '森林', '我的世界', 'rust', '方舟', 'raft', '英灵神殿', '饥荒'], tags: ['生存游戏'] },
  { match: ['生化危机', '寂静岭', '逃生', '死亡空间', 'outlast', '森林之子'], tags: ['恐怖游戏'] },
  // 解谜
  { match: ['传送门', '见证者', '纪念碑谷', '锈湖'], tags: ['解谜游戏'] },
];

// 按标题/游戏名匹配类型规则，返回去重后的类型标签（最多 6 个）。
function matchGenreTags(raw) {
  const key = String(raw == null ? '' : raw).toLowerCase();
  const seen = new Set();
  const out = [];
  for (const rule of GAME_GENRE_RULES) {
    if (!rule.match.some((m) => key.includes(m))) continue;
    for (const t of rule.tags) {
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
      if (out.length >= 6) break;
    }
  }
  return out;
}

// 从标题/文件名提取「游戏名」标签：保留原文分隔符与数字（如「EA SPORTS FC 26」「光环：战役进化」）。
function extractGameName(raw) {
  const text = String(raw == null ? '' : raw)
    .replace(/\.[a-z0-9]+$/i, '') // 去扩展名
    .replace(/^【[^】]*】/, ''); // 剥【游戏NNN】/【NNN】序号前缀
  let s = text;
  for (const w of GAME_NAME_STRIP_WORDS) {
    s = s.split(w).join(' ');
  }
  // 折叠连续分隔符为单个空格（保留中文冒号/书名号等名称内分隔）。
  s = s.replace(/[\s\-_·,，、.|/\\+()（）【】]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/\s*第\d+[期集话章弹]?\s*$/g, '').trim(); // 剥尾部「第N期/集」
  if (!s || s.length < 2) return '';
  if (/^\d+$/.test(s)) return ''; // 纯数字
  if (/^第\d+[期集话章弹]?$/.test(s)) return ''; // 序号
  const key = s.toLowerCase();
  if (GAME_NAME_SENSITIVE.some((x) => key.includes(x))) return '';
  return s;
}

const app = express();
const PORT = process.env.BILIUP_PORT || 3600;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── 同源校验：阻断跨站 CSRF（与 netdisk/kdocs 同构）──
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const host = new URL(origin).hostname;
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
        return res.status(403).json({ error: 'forbidden: cross-origin request blocked' });
      }
    } catch {
      return res.status(403).json({ error: 'forbidden: invalid origin' });
    }
  }
  next();
});

// 静态资源防缓存（避免浏览器长期使用旧 app.js）
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(js|css|html|htm)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// 主页
app.get('/', (req, res) => {
  try {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } catch (e) {
    res.status(500).end();
  }
});

// ── 版本（回显 bootToken 供主进程 verifyChildBoot 校验端口归属）──
function getVersion() {
  try { return require('./package.json').version; }
  catch { return 'unknown'; }
}
app.get('/api/version', (req, res) => {
  const hubVer = process.env.TOOLSHUB_VERSION;
  const version = hubVer || getVersion();
  const source = hubVer ? 'tools-hub' : 'standalone';
  res.json({ version, source, updatable: false, bootToken: process.env.BOOT_TOKEN || null });
});

// ── 健康检查 ──
app.get(['/api/health', '/api/live'], (req, res) => {
  res.json({ ok: true, ts: Date.now(), port: Number(PORT), bind: '127.0.0.1' });
});

// ── 配置读取（含 cookies 状态）──
app.get('/api/config', async (req, res) => {
  const config = store.getConfig();
  const ck = cookies.checkFile(config.cookiesPath);
  if (ck.ok) {
    // 文件字段齐全 ≠ 登录态有效：真实调 B 站 nav 接口验证 SESSDATA，
    // 过期/失效时 UI 直接提示重新扫码，不再出现「显示正常但投稿报登录态失效」的误导。
    const web = cookies.load(config.cookiesPath) || {};
    const v = await Promise.race([
      auth.verifyCookies(web, {}),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: -1, message: '网络异常（校验超时）' }), 5000)),
    ]);
    ck.verified = true;
    ck.ok = v.ok;
    ck.uname = v.uname;
    ck.message = v.message;
  } else {
    ck.verified = false;
    ck.message = ck.error || '缺少 SESSDATA/bili_jct';
  }
  res.json(Object.assign({}, config, { cookiesOk: ck.ok, cookiesDetail: ck }));
});

// ── 配置保存（路径/默认参数；AIGC 字段已移除 #3）──
app.post('/api/config', (req, res) => {
  try {
    const incoming = (req.body && typeof req.body === 'object') ? req.body : {};
    // 不允许通过 UI 覆盖 biliup.exe 路径（#6 改为自动解析），强制使用解析值。
    delete incoming.biliupExePath;
    store.saveConfig(incoming);
    logger.info('[config] 已保存配置');
    res.json({ ok: true });
  } catch (e) {
    logger.error('[config] 保存失败:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── cookies 校验 ──
app.get('/api/cookies/check', (req, res) => {
  const config = store.getConfig();
  res.json(cookies.checkFile(config.cookiesPath));
});

// ── 账号信息（B站头像/昵称，#7；带 5 分钟缓存）──
// 登录态剩余天数：从 login_info 的 token_info 推算（token_created_at + expires_in - now）。
// 无 TV token（cookie 兜底模式）→ days:null/status:cookie，前端显示「登录态正常」。
function computeLoginTtl() {
  try {
    const li = auth.loadLoginInfo(store.getLoginInfoPath());
    const ti = li && li.token_info;
    if (!ti || !ti.access_token) {
      return { days: null, status: 'cookie' };
    }
    if (ti.expires_in > 0 && ti.token_created_at > 0) {
      const remaining = ti.token_created_at + ti.expires_in - Math.floor(Date.now() / 1000);
      const days = Math.max(0, Math.ceil(remaining / 86400));
      return { days, status: days <= 7 ? 'warn' : 'ok' };
    }
    return { days: null, status: 'ok', longLived: true };
  } catch (e) {
    return null;
  }
}

app.get('/api/account', async (req, res) => {
  try {
    const info = await account.getAccount();
    if (info && info.isLogin) info.loginTtl = computeLoginTtl();
    res.json(info);
  } catch (e) {
    logger.error('[account] 查询失败:', e.message);
    res.json({ isLogin: false });
  }
});

// ── 合集列表（#H：登录态下拉级联；未登录/失败降级空数组，前端静默降级）──
// 同源校验由上方 origin 中间件统一处理；此处仅做 cookies 校验 + 代理转发。
app.get('/api/seasons', async (req, res) => {
  try {
    const config = store.getConfig();
    const cf = cookies.load(config.cookiesPath);
    if (!cookies.validate(cf)) {
      return res.json({ seasons: [] });
    }
    const fetchFn = (app.locals && app.locals.seasonsFetch) || getSeasonsFetch();
    const url = 'https://member.bilibili.com/x2/creative/web/seasons?pn=1&ps=30';
    const upstream = await fetchFn(url, {
      headers: {
        'Cookie': cookies.toHeader(cf),
        'Referer': 'https://www.bilibili.com/',
        'User-Agent': USER_AGENT,
      },
    });
    if (!upstream.ok) {
      return res.json({ seasons: [] });
    }
    const json = await upstream.json();
    const seasons = Array.isArray(json && json.data && json.data.seasons) ? json.data.seasons : [];
    // 仅保留 state===0 的合集，映射为前端级联所需的 [{id,title,sections:[{id,title}]}]。
    // 若上游 seasons 列表未返回 sections（分集下拉空），单独补拉 season/section 详情补齐，
    // 使前端「选合集即生效」。补拉失败/无网络降级空数组，不影响其它合集。
    const mapped = [];
    for (const s of seasons) {
      if (!s || !s.season || s.season.state !== 0) continue;
      // no_section：B站声明的「无分集」标志并不可靠——实测 no_section=1 的合集
      // 仍可能在顶层 sections.sections（嵌套）返回默认「正片」分集（如「绵绵不绝」）。
      // 因此分集一律优先从嵌套路径 s.sections.sections 读取，回退 s.season.sections；
      // no_section 仅用于「两处均为空」时的提示文案区分（不阻断其它合集）。
      const noSection = Number(s.season.no_section) === 1;
      const nestedSections = s.sections && Array.isArray(s.sections.sections) ? s.sections.sections : [];
      const seasonSections = Array.isArray(s.season.sections) ? s.season.sections : [];
      let sections = (nestedSections.length > 0 ? nestedSections : seasonSections)
        .map((sec) => ({ id: String(sec.id), title: sec.title }));
      // 仅当 no_section 为假且上游未返回分集时，才补拉 season/section 详情补齐（需求①「选合集即生效」）；
      // 真·无分集无需补拉（避免一次必然为空的请求）。补拉失败降级空数组，不阻断其它合集。
      if (!noSection && sections.length === 0) {
        try {
          sections = await fetchSeasonSections(
            s.season.id,
            cf,
            app.locals && app.locals.seasonSectionFetch
          );
        } catch (e) {
          logger.warn('[seasons] 补拉分集失败 seasonId=' + s.season.id + ':', e.message);
          sections = [];
        }
      }
      mapped.push({
        id: String(s.season.id),
        title: s.season.title,
        sections,
        no_section: noSection,
      });
    }
    res.json({ seasons: mapped });
  } catch (e) {
    logger.error('[seasons] 查询失败:', e.message);
    res.json({ seasons: [] });
  }
});

// ── 头像代理（#A：绕过 B站防盗链/Referer 校验，避免前端 <img> 裂图）──
// 同源校验由上方 origin 中间件统一处理；此处仅做入参校验 + 代理转发。
app.get('/api/avatar', async (req, res) => {
  const face = (req.query && req.query.face) || '';
  if (typeof face !== 'string' || !/^https?:\/\//i.test(face)) {
    return res.status(400).json({ error: 'invalid face url' });
  }
  try {
    const fetchFn = (app.locals && app.locals.avatarFetch) || getProxyFetch();
    const upstream = await fetchFn(face, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': 'https://www.bilibili.com/',
        'Accept': 'image/*',
      },
    });
    if (!upstream.ok) {
      return res.status(502).json({ error: 'upstream avatar error', status: upstream.status });
    }
    const ct = (upstream.headers && upstream.headers.get('content-type')) || 'image/jpeg';
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=300');
    res.end(buf);
  } catch (e) {
    logger.error('[avatar] 代理失败:', e.message);
    res.status(500).json({ error: 'avatar proxy failed' });
  }
});

// ── 标签推荐（需求②：调 B站投稿官方推荐接口 member.bilibili.com/x/vupre/web/tag/recommend）──
// 需登录 Cookie（SESSDATA/bili_jct），参数 title（清洗后的关键词）+ typeid（分区，取配置）
// + copyright（原创/转载，取配置）。旧接口 api.bilibili.com/x/tag/suggest 已下线（404），
// 此接口为投稿中心现行方案。未登录/失败/离线一律降级 {tags:[]}，不抛 500、不阻断前端；
// 前端拿到空数组时走 genTags fallback。
// 需求②修订：不再调 B站官方 tag/recommend（实测对非热门游戏只回泛标签、不含游戏名），
// 推荐 = 标题提取的游戏名 + 本地规则表命中的类型标签；前端合并固定默认标签（无需登录、离线可用）。
app.get('/api/tags/suggest', async (req, res) => {
  const kw = (req.query && req.query.keyword) || '';
  if (typeof kw !== 'string' || !kw.trim()) {
    return res.json({ tags: [] });
  }
  const name = extractGameName(kw);
  if (!name) return res.json({ tags: [] });
  const genres = matchGenreTags(kw + ' ' + name);
  // 单标签上限 20 字（B 站硬限，超长直接 21005 拒稿）：
  // 超长游戏名（如「零 ～红蝶～ 重制版 FATAL FRAME II Crimson Butterfly REMAKE」）丢弃，
  // 前端收到空推荐后自动走 genTags 分词兜底，绝不整串进标签。
  const tags = [];
  if (name.length <= 20) tags.push(name);
  for (const g of genres) if (g.length <= 20) tags.push(g);
  res.json({ tags });
});

// ── 扫码登录：生成二维码（#7）──
app.post('/api/login/qrcode', async (req, res) => {
  try {
    const r = await auth.generateQrcode();
    res.json(r); // { qrcodeKey, qrDataUrl }
  } catch (e) {
    logger.error('[login] 二维码生成失败:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 扫码登录：轮询状态（#7）──
app.get('/api/login/poll', async (req, res) => {
  const key = req.query && req.query.key;
  if (!key) return res.status(400).json({ error: '缺少 key' });
  try {
    const r = await auth.pollQrcode(key);
    if (r.status === 'success' && r.cookies) {
      try {
        auth.saveCookies(r.cookies);
        // 扫码一次到位：同步生成 biliup 的 LoginInfo（web cookie + token 换取，本地兜底）。
        auth.ensureLoginInfo(r.cookies).catch((e) => {
          logger.warn('[login] 生成 biliup LoginInfo 失败（上传前会重试）:', e.message);
        });
        account.invalidate(); // 立即使 /api/account 缓存失效，反映新登录态
        // 自动验证 cookie 有效性（防「显示登录成功但投稿 -412」）：调 B站 nav 确认登录态
        try {
          const v = await auth.verifyCookies(r.cookies);
          r.verified = v;
          if (v.ok) logger.info('[login] cookie 验证通过:', v.uname || '(未知昵称)');
          else logger.warn('[login] cookie 验证未通过:', v.message, 'code=' + v.code);
        } catch (ve) {
          r.verified = { ok: false, code: -1, message: '验证异常: ' + ve.message };
          logger.warn('[login] cookie 验证异常:', ve.message);
        }
      } catch (e) {
        logger.error('[login] 写 cookie 失败:', e.message);
      }
    }
    res.json(r); // { status, cookies? }
  } catch (e) {
    logger.error('[login] 轮询失败:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 退出登录 / 清除登录态（Catch 修复：解决登录态过期后用户卡死、无法自助刷新）──
// best-effort 删除 cookies.json + login_info.json（仅删凭证，不动 config.json）。
// 成功后立即使 /api/account 缓存失效，前端重新拉取即显示「未登录/请扫码」并恢复二维码登录入口。
app.post('/api/logout', (req, res) => {
  try {
    const r = auth.clearSession();
    account.invalidate(); // 立即使 /api/account 5 分钟缓存失效，反映未登录态
    logger.info('[logout] 已清除登录态，删除文件:', r.cleared);
    res.json({ ok: true, cleared: r.cleared });
  } catch (e) {
    logger.error('[logout] 失败:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 上传（SSE 全流程投稿，核心）──
app.post('/api/upload', (req, res) => {
  const body = req.body || {};
  const videoPath = body.videoPath;
  if (!videoPath) {
    return res.status(400).json({ error: '缺少 videoPath' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => {
    try {
      res.write('data: ' + JSON.stringify(obj) + '\n\n');
      if (typeof res.flush === 'function') res.flush();
    } catch { /* 客户端已断开 */ }
  };
  const heartbeat = setInterval(() => {
    try { res.write(': hb\n\n'); if (typeof res.flush === 'function') res.flush(); } catch { /* ignore */ }
  }, 3000);

  const finish = () => {
    clearInterval(heartbeat);
    try { res.end(); } catch { /* 已结束 */ }
  };

  const config = store.getConfig();
  let cookiesFile = null;
  try { cookiesFile = cookies.load(config.cookiesPath); } catch (e) { /* 下面校验 */ }
  if (!cookiesFile || !cookies.validate(cookiesFile)) {
    send({ type: 'error', stage: 'pending', message: 'cookies 无效：缺少 SESSDATA 或 bili_jct（请检查 ' + config.cookiesPath + '）' });
    finish();
    return;
  }

  task.run(body, { config, cookiesFile, onEvent: send, deps: {} })
    .catch((e) => { send({ type: 'error', stage: 'error', message: e.message }); })
    .finally(finish);
});

// ── 合集补加：检测最新发布 + 批量加入 ──
// 定时发布的稿件发布前被 B 站锁定无法加合集；用户发布完成后点「检测补合集」，
// 拉最近发布的稿件，找出还没加入所选合集的，前端勾选确认后批量补加。
const SEASON_DETECT_ARCHIVE_URL = 'https://member.bilibili.com/x2/creative/web/archives/sp';
const SEASON_VIEW_URL = 'https://api.bilibili.com/x/web-interface/view';

// 拉最近发布的稿件（创作中心接口），只保留已发布（state=0）且带 bvid/aid 的。
// 归属判断统一以公开接口 ugc_season.id 为准（season_add_state 语义不可靠，不做预筛）。
async function fetchRecentArchives(cf, limit, fetchFnOverride) {
  const fetchFn = fetchFnOverride || (app.locals && app.locals.seasonDetectFetch) || getSeasonsFetch();
  const url = SEASON_DETECT_ARCHIVE_URL + '?pn=1&ps=' + Math.max(1, Math.min(50, Number(limit) || 20));
  const resp = await fetchFn(url, {
    headers: {
      'Cookie': cookies.toHeader(cf),
      'Referer': 'https://member.bilibili.com/',
      'User-Agent': USER_AGENT,
    },
  });
  if (!resp.ok) return [];
  const json = await resp.json();
  if (!json || json.code !== 0) return [];
  const audits = Array.isArray(json.data && json.data.arc_audits) ? json.data.arc_audits : [];
  const out = [];
  for (const a of audits) {
    const ar = a && a.Archive;
    if (!ar) continue;
    if (Number(ar.state) !== 0) continue; // 只检测已发布（定时未发布 state 非 0）
    const aid = Number(ar.aid);
    const bvid = ar.bvid ? String(ar.bvid) : '';
    if (!aid && !bvid) continue;
    out.push({ aid, bvid, title: String(ar.title || ''), pubdate: Number(ar.pubdate) || 0 });
  }
  return out;
}

// 取所选合集的创建时间（ctime，秒），用于过滤「合集创建前」的旧稿件。
async function fetchSeasonCtime(seasonId, cf, fetchFnOverride) {
  const fetchFn = fetchFnOverride || getSeasonsFetch();
  const url = 'https://member.bilibili.com/x2/creative/web/seasons?pn=1&ps=50&t=' + Math.floor(Date.now() / 1000);
  try {
    const resp = await fetchFn(url, {
      headers: {
        'Cookie': cookies.toHeader(cf),
        'Referer': 'https://member.bilibili.com/',
        'User-Agent': USER_AGENT,
      },
    });
    if (!resp.ok) return 0;
    const json = await resp.json();
    if (!json || json.code !== 0) return 0;
    const seasons = Array.isArray(json.data && json.data.seasons) ? json.data.seasons : [];
    const s = seasons.find((x) => x && x.season && String(x.season.id) === String(seasonId));
    return s && s.season && Number(s.season.ctime) ? Number(s.season.ctime) : 0;
  } catch (e) {
    logger.warn('[season-detect] 查询合集创建时间失败:', e.message);
    return 0;
  }
}

// 查公开接口确认稿件所属合集（ugc_season.id）与 cid；62003=待发布、-404=未索引，均返回 null。
async function fetchVideoSeason(item, fetchFnOverride) {
  const fetchFn = fetchFnOverride || getSeasonsFetch();
  const url = SEASON_VIEW_URL + (item.bvid
    ? '?bvid=' + encodeURIComponent(item.bvid)
    : '?aid=' + encodeURIComponent(item.aid));
  try {
    const resp = await fetchFn(url, {
      headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://www.bilibili.com/' },
    });
    const json = await resp.json();
    if (json && json.code === 0 && json.data) {
      const us = json.data.ugc_season;
      const cid = Number((json.data.pages && json.data.pages[0] && json.data.pages[0].cid) || json.data.cid);
      return {
        seasonId: us && us.id != null ? Number(us.id) : null,
        cid: cid || null,
        pubdate: Number(json.data.pubdate) || 0,
      };
    }
  } catch (e) {
    logger.warn('[season-detect] 查询稿件合集失败:', e.message);
  }
  return null;
}

// 检测：返回最近已发布但【不在所选合集】的稿件列表。
app.get('/api/season/detect', async (req, res) => {
  try {
    const config = store.getConfig();
    const cf = cookies.load(config.cookiesPath);
    if (!cookies.validate(cf)) {
      return res.status(400).json({ ok: false, error: 'cookies 无效：缺少 SESSDATA 或 bili_jct' });
    }
    if (!config.seasonId) {
      return res.status(400).json({ ok: false, error: '尚未选择合集，请先在设置中选择要补加的合集' });
    }
    const limit = Number(req.query && req.query.limit) || 20;
    const archives = await fetchRecentArchives(cf, limit, app.locals && app.locals.seasonDetectFetch);
    const seasonCtime = await fetchSeasonCtime(config.seasonId, cf, app.locals && app.locals.seasonDetectFetch);
    const candidates = [];
    for (const item of archives) {
      const info = await fetchVideoSeason(item, app.locals && app.locals.seasonDetectFetch);
      // 公开接口查不到（未发布/未索引）→ 跳过本轮；已属于所选合集 → 跳过
      if (!info) continue;
      if (info.seasonId != null && info.seasonId === Number(config.seasonId)) continue;
      // 合集创建前的旧稿件不提示（避免把历史未入合集视频全翻出来）
      if (seasonCtime && info.pubdate && info.pubdate < seasonCtime) continue;
      candidates.push(Object.assign({}, item, {
        cid: info.cid,
        pubdate: info.pubdate || item.pubdate,
      }));
    }
    res.json({
      ok: true,
      seasonId: config.seasonId,
      seasonCtime,
      candidates,
      checked: candidates.length,
    });
  } catch (e) {
    logger.error('[season-detect] 检测失败:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 补加：把勾选的稿件加入所选合集（逐条走 season.add，含 -404 重试）。
app.post('/api/season/add-many', async (req, res) => {
  try {
    const config = store.getConfig();
    const cf = cookies.load(config.cookiesPath);
    if (!cookies.validate(cf)) {
      return res.status(400).json({ ok: false, error: 'cookies 无效：缺少 SESSDATA 或 bili_jct' });
    }
    if (!config.seasonId) {
      return res.status(400).json({ ok: false, error: '尚未选择合集，请先在设置中选择要补加的合集' });
    }
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ ok: false, error: '未选择任何稿件' });
    }
    const season = require('./lib/season');
    let sectionId = config.sectionId;
    if (!sectionId) {
      const resolved = await season.resolveFirstSectionId(config.seasonId, cookies.toHeader(cf), { deps: {} });
      if (resolved) sectionId = resolved;
    }
    if (!sectionId) {
      return res.status(400).json({ ok: false, error: '所选合集无法解析分集，无法补加' });
    }
    const csrf = cookies.getCsrf(cf);
    const cookieHeader = cookies.toHeader(cf);
    const results = [];
    let okCount = 0;
    for (const it of items) {
      const aid = Number(it.aid);
      const cid = Number(it.cid);
      if (!aid || !cid) {
        results.push({ aid, ok: false, error: '缺少 aid/cid（需先检测获取 cid）' });
        continue;
      }
      try {
        await season.add(sectionId, aid, cid, String(it.title || ''), csrf, cookieHeader, {
          onLog: (m) => logger.info('[season-detect] ' + m),
          deps: {},
        });
        okCount += 1;
        results.push({ aid, ok: true });
      } catch (e) {
        results.push({ aid, ok: false, error: e.message });
      }
    }
    res.json({ ok: true, okCount, total: items.length, results });
  } catch (e) {
    logger.error('[season-detect] 补加失败:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 兜底错误中间件（#5 根因止血：避免未捕获异常冒泡导致进程退出）──
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('[express] 未处理错误:', err && err.message);
  if (!res.headersSent) res.status(500).json({ error: 'internal error' });
});

// ── 启动（EADDRINUSE 自动重试 30 次/300ms，与 netdisk 同构）──
let server = null;
function startServer(attempt = 0) {
  const srv = app.listen(PORT, '127.0.0.1', () => {
    logger.info(`biliup-hub 运行中 → http://localhost:${PORT} (仅本机绑定)`);
  });
  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 30) {
      setTimeout(() => startServer(attempt + 1), 300);
    } else {
      // 启动失败（多为端口被占用 EADDRINUSE 且重试耗尽）：明确记录，便于主进程看门狗给出友好提示。
      logger.error('监听失败 (code=' + (err.code || '?') + '):', err.message);
      process.exit(1);
    }
  });
  return srv;
}
// 仅作为入口（node server.js）启动时监听；被 require 时（如单测）不占用端口，避免测试进程空转。
if (require.main === module) {
  server = startServer();
}

// ── 优雅关闭 ──
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn(`收到 ${signal}, 正在优雅关闭…`);
  if (!server) { process.exit(0); return; }
  server.close(() => { logger.info('服务已关闭'); process.exit(0); });
  setTimeout(() => { logger.error('优雅关闭超时,强制退出'); process.exit(1); }, 5000).unref();
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
// #5 根因止血：未捕获异常 / Promise 拒绝只记录不退出，避免子进程中途崩溃导致卡片永久离线。
process.on('uncaughtException', (e) => logger.error('未捕获异常:', e));
process.on('unhandledRejection', (r) => logger.error('未处理的 Promise 拒绝:', r));

// 便于单测 require（实际启动走上面的 startServer）
app.extractGameName = extractGameName; // 导出纯函数供单测直接验证
app.matchGenreTags = matchGenreTags; // 导出纯函数供单测直接验证
module.exports = app;
