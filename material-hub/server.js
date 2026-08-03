// material-hub/server.js —— Express 子服务（监听 127.0.0.1:3700）
// 同源校验 + 静态资源防缓存 + /api/version(回显 bootToken) + /api/collect(SSE 素材搜集)。
// 契约逐段对齐 biliup-hub/server.js：主进程 verifyChildBoot 端口防抢占 + 看门狗探活均依赖 /api/version。
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const logger = require('./lib/logger');
const { CollectService, DEFAULT_OUTPUT_DIR } = require('./lib/collect');

const app = express();
const PORT = process.env.MATERIAL_PORT || 3700;

/** 素材落盘根目录：主进程注入 MATERIAL_OUTPUT_DIR，缺省 E:\素材\（不存在自动 mkdir -p）。 */
function getOutputDir() {
  const dir = process.env.MATERIAL_OUTPUT_DIR;
  return dir && dir.trim() ? dir : DEFAULT_OUTPUT_DIR;
}

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── 同源校验：阻断跨站 CSRF（与 kdocs/netdisk/biliup 同构，不可省略）──
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

// ── 共享样式：从仓库 shared/ 提供 tokens.css（三端共用单一真源，与 kdocs/netdisk 同构）──
// 同时接受 /tokens.css 与 /shared/tokens.css（前端按设计写 ../shared/tokens.css）。
// 打包场景 resources/shared 可能不存在 → 404，此时前端 style.css 内的同值 fallback 层兜底。
app.get(['/tokens.css', '/shared/tokens.css'], (req, res) => {
  const file = path.join(__dirname, '..', 'shared', 'tokens.css');
  res.type('css').sendFile(file, (err) => { if (err) res.status(404).end(); });
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

// ── 素材搜集（SSE 流式全流程，核心）──
app.post('/api/collect', (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const forceTrailer = body.forceTrailer === true;
  const forceCover = body.forceCover === true;
  if (!name) {
    return res.status(400).json({ error: '缺少 name（游戏名）' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
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

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    try { res.end(); } catch { /* 已结束 */ }
  };
  req.on('close', () => { clearInterval(heartbeat); });

  const service = (app.locals && app.locals.collectService) || new CollectService();
  logger.info('[collect] 开始：' + name + ' → ' + getOutputDir());
  service.run({ name, outDir: getOutputDir(), forceTrailer, forceCover }, { onEvent: send })
    .catch((e) => {
      logger.error('[collect] 流程异常:', e && e.message);
      send({
        type: 'error',
        step: '素材搜集',
        msg: '流程异常：' + (e && e.message ? e.message : String(e)),
        ok: false,
        detail: { reason: 'internal-error' },
      });
    })
    .finally(finish);
});

// ── 兜底错误中间件（避免未捕获异常冒泡导致进程退出被看门狗误判）──
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('[express] 未处理错误:', err && err.message);
  if (!res.headersSent) res.status(500).json({ error: 'internal error' });
});

// ── 启动（EADDRINUSE 自动重试 30 次/300ms，与 biliup/netdisk 同构）──
let server = null;
function startServer(attempt = 0) {
  const srv = app.listen(PORT, '127.0.0.1', () => {
    logger.info(`material-hub 运行中 → http://localhost:${PORT} (仅本机绑定)`);
    logger.info('素材落盘目录: ' + getOutputDir());
  });
  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 30) {
      setTimeout(() => startServer(attempt + 1), 300);
    } else {
      logger.error('监听失败 (code=' + (err.code || '?') + '):', err.message);
      process.exit(1);
    }
  });
  return srv;
}
// 仅作为入口（node server.js）启动时监听；被 require 时（如单测）不占用端口。
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
// 未捕获异常 / Promise 拒绝只记录不退出，避免子进程中途崩溃导致卡片永久离线。
process.on('uncaughtException', (e) => logger.error('未捕获异常:', e));
process.on('unhandledRejection', (r) => logger.error('未处理的 Promise 拒绝:', r));

// 便于单测 require（实际启动走上面的 startServer）
module.exports = app;
