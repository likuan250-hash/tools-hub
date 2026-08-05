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

// 标签推荐代理用的 fetch（需求②：调 B站 x/tag/suggest）；便于单测注入 app.locals.tagSuggestFetch。
function getTagSuggestFetch() {
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

// ── 标签推荐（需求②）：从 B站 x/tag/suggest 响应中提取 tag_name，做多层结构容错 ──
// 兼容 data.tag[].tag_name / data.tags[].tag_name / data[].tag_name（数组在 data 内任意层级）。
const TAG_SUGGEST_BLACKLIST = new Set([
  '广告', '推广', '官方', 'bilibili', 'b站', 'b站官方', '番剧', '直播', 'av', 'av号',
  // 游戏分享场景敏感/版本描述词（防 suggest 接口推荐回来时漏网，与前端 genTags 保持一致）
  '学习版', '免费学习版', '免费学习版下载', '学习版下载', '破解版', '官方中文',
  '硬盘版', '免安装', '免安装硬盘版', '中文版', '官方中文版', '完整版', '绿色版',
  '安装版', '便携版',
]);
// 绝对敏感词：tag 只要包含即整体丢弃（与前端 genTags 的 ABS_SENSITIVE 保持一致）。
const TAG_SUGGEST_SENSITIVE = ['学习版', '破解版', '盗版'];
const TAG_SUGGEST_MAX = 5;

// 递归收集所有 tag_name（任意嵌套层级），去重保留首次出现顺序。
function collectTagNames(node, out, depth) {
  if (out.length >= 100) return; // 安全阀：响应体很小，避免极端结构无限膨胀
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectTagNames(item, out, depth + 1);
    return;
  }
  if (typeof node.tag_name === 'string' && node.tag_name.trim()) {
    out.push(node.tag_name.trim());
  }
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (val && typeof val === 'object') collectTagNames(val, out, depth + 1);
  }
}

// 过滤无意义/广告标签 + 去重 + 限长，返回干净的字符串数组（前 N 个）。
function filterSuggestedTags(names) {
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    const t = String(raw).trim();
    if (!t) continue;
    if (t.length > 20) continue; // 过长视为异常/无意义
    const key = t.toLowerCase();
    if (TAG_SUGGEST_BLACKLIST.has(t) || TAG_SUGGEST_BLACKLIST.has(key)) continue;
    if (TAG_SUGGEST_SENSITIVE.some((s) => key.includes(s))) continue; // 敏感词子串过滤
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= TAG_SUGGEST_MAX) break;
  }
  return out;
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
app.get('/api/config', (req, res) => {
  const config = store.getConfig();
  const ck = cookies.checkFile(config.cookiesPath);
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
app.get('/api/account', async (req, res) => {
  try {
    const info = await account.getAccount();
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
      // no_section：B站声明该合集「无分集」（合集本身不含分集结构，是正常现象，非接口故障）；
      // 前端据以区分「真·无分集」与「分集列表未返回 / 补拉失败」，给出不同提示。
      const noSection = Number(s.season.no_section) === 1;
      let sections = Array.isArray(s.season.sections)
        ? s.season.sections.map((sec) => ({ id: String(sec.id), title: sec.title }))
        : [];
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

// ── 标签推荐（需求②：调 B站 x/tag/suggest，同源代理避免 CORS；离线/失败降级 {tags:[]}）──
// 仅做关键词透传 + 响应提取，不抛 500、不阻断前端；前端拿到空数组时走 genTags fallback。
app.get('/api/tags/suggest', async (req, res) => {
  const kw = (req.query && req.query.keyword) || '';
  if (typeof kw !== 'string' || !kw.trim()) {
    return res.json({ tags: [] });
  }
  try {
    const fetchFn = (app.locals && app.locals.tagSuggestFetch) || getTagSuggestFetch();
    const url = 'https://api.bilibili.com/x/tag/suggest?keyword=' + encodeURIComponent(kw.trim());
    const upstream = await fetchFn(url, {
      headers: {
        'Referer': 'https://www.bilibili.com/',
        'User-Agent': USER_AGENT,
      },
    });
    if (!upstream.ok) {
      return res.json({ tags: [] });
    }
    const json = await upstream.json().catch(() => null);
    const names = [];
    collectTagNames(json, names, 0);
    const tags = filterSuggestedTags(names);
    res.json({ tags });
  } catch (e) {
    logger.warn('[tags/suggest] 标签推荐失败（降级空数组）: ' + e.message);
    res.json({ tags: [] });
  }
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
module.exports = app;
