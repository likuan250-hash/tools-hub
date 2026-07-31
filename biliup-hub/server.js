// biliup-hub/server.js —— Express 子服务（监听 127.0.0.1:3600）
// 同源校验 + 静态资源 + /api/version(回显 bootToken) + 健康检查 + 配置/凭据路由
// + 账号信息(#7) + 扫码登录(#7) + /api/upload SSE。
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
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
  try { return fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim(); }
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
    const mapped = seasons
      .filter((s) => s && s.season && s.season.state === 0)
      .map((s) => ({
        id: String(s.season.id),
        title: s.season.title,
        sections: Array.isArray(s.season.sections)
          ? s.season.sections.map((sec) => ({ id: String(sec.id), title: sec.title }))
          : [],
      }));
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
        account.invalidate(); // 立即使 /api/account 缓存失效，反映新登录态
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
