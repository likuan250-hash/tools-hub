require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const baidu = require('./src/baidu');
const baiduAuth = require('./src/baidu.auth');
const quark = require('./src/quark');
const quarkAuth = require('./src/quark.auth');
const xunlei = require('./src/xunlei');
const xunleiAuth = require('./src/xunlei.auth');
const store = require('./src/store');
const crypto = require('crypto');
const logger = require('./src/logger');

// ── 出站代理(解决「浏览器能登录但 Node 连不上网盘」)──
// 浏览器走系统代理/直连能登录;Node 的 fetch 默认不读系统代理。
// 仅认显式配置的 NETDISK_PROXY(.env 或环境变量),不自动读 HTTP_PROXY/HTTPS_PROXY,
// 避免误用本机其他用途的代理(如 git 代理)改掉原有行为。留空则直连(普通家庭网络)。
// 示例: http://127.0.0.1:7890  或带账号  http://user:pass@host:port
{
  const proxyUrl = process.env.NETDISK_PROXY;
  if (proxyUrl && /^https?:\/\//i.test(proxyUrl)) {
    try {
      const { ProxyAgent, setGlobalDispatcher } = require('undici');
      setGlobalDispatcher(new ProxyAgent(proxyUrl));
      // 日志脱敏：代理地址可能带账号密码（http://user:pass@host:port），
      // 不能把密码明文写进 app-*.log（保留 14 天）。
      logger.info('[proxy] 已启用出站代理:', String(proxyUrl).replace(/\/\/[^@/]+@/, '//***@'));
    } catch (e) {
      logger.warn('[proxy] 代理初始化失败,回退直连:', e.message);
    }
  }
}

const registerAuthRoutes = require('./src/routes-auth');
const app = express();
const APP_JS_HASH = (function() {
  try {
    const p = path.join(__dirname, 'public', 'app.js');
    return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex').slice(0, 8);
  } catch (e) { return ''; }
})();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── 同源校验：阻断恶意网页对 127.0.0.1 的跨站 CSRF 写请求 ──
// 合法调用来自本工具内嵌 webview（同源，Origin=http://127.0.0.1:PORT）；
// 跨站网页发来的请求会带攻击者 Origin → 拒绝。
// 外网 OAuth 回调为顶级导航(无 Origin) → 放行；同源 fetch/XHR 带 localhost Origin → 放行。
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

registerAuthRoutes(app, { store, logger, baidu, baiduAuth, quark, quarkAuth, xunlei, xunleiAuth });

// ── 共享样式：从仓库 shared/ 提供 tokens.css 与 macos-motion.css（三套前端共用单一真源）──
app.get(['/tokens.css', '/macos-motion.css'], (req, res) => {
  const file = path.join(__dirname, '..', 'shared', req.path.slice(1));
  res.type('css').sendFile(file, (err) => { if (err) res.status(404).end(); });
});

// 静态资源防缓存: 每次都重新验证, 避免浏览器长期使用旧 app.js(曾导致「改了代码仍看到旧行为」)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(js|css|html|htm)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
const registerApiRoutes = require('./src/routes-api');


// 主页
app.get('/app.' + APP_JS_HASH + '.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.js'), {
    maxAge: '1y',
    immutable: true,
  });
});

app.get('/', (req, res) => {
  try {
    var html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    html = html.replace('/app.js?v=', '/app.' + APP_JS_HASH + '.js?v=');
    res.type('html').send(html);
  } catch (e) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// ── 百度授权入口 ──────────────────────────────────────
// OAuth 二维码授权(开放平台权限,保留);功能完整还需 Playwright 登录拿 BDUSS
// ── 账号状态 ─────────────────────────────────────────
// 登录态实时校验缓存:失败态缓存 60s 防频控(避免每次页面加载都打网盘);
// 成功态不缓存,每次实时(登录后立即可见,不等缓存过期)。
const verifyCache = new Map();
const VERIFY_TTL = 60 * 1000;

async function verifyProvider(key) {
  const cached = verifyCache.get(key);
  if (cached && !cached.connected && Date.now() - cached.ts < VERIFY_TTL) return false; // 失效态短期复用
  let connected = false;
  try {
    if (key === 'baidu') connected = await baidu.checkSession();
    else if (key === 'quark') connected = await quark.checkSession();
    else if (key === 'xunlei') connected = await xunlei.pingSession();
  } catch (e) { connected = false; }
  if (!connected) verifyCache.set(key, { ts: Date.now(), connected: false }); // 仅缓存失败态
  return connected;
}

// 实时探测结果缓存:避免每次页面加载/转存都被迅雷 token 冷启动(≥3s,见 loadTokensFromProfile 的 waitForTimeout)
// 阻塞。探测改为后台异步执行并缓存,账户接口立即返回;前端 2.8s 后再次拉取以显示最新探测结果。
const pingCache = { baidu: undefined, quark: undefined, xunlei: undefined };
let pingRefreshing = false;
let pingTs = 0;
async function refreshPings() {
  if (pingRefreshing) return;
  const now = Date.now();
  // 5 分钟内不重复探测(迅雷探测会拉起浏览器预热 token,代价高)
  if (pingCache.baidu !== undefined && now - pingTs < 5 * 60 * 1000) return;
  pingRefreshing = true;
  try {
    await Promise.all(['baidu', 'quark', 'xunlei'].map(async (k) => {
      try { pingCache[k] = await verifyProvider(k); }
      catch (e) { pingCache[k] = false; }
    }));
    pingTs = Date.now();
  } catch (e) {
    // 忽略,下次请求再试
  } finally {
    pingRefreshing = false;
  }
}


// 从分享链接提取归一化短码(去重主键),覆盖百度/夸克/迅雷标准形态
function extractSurl(link) {
  if (!link) return '';
  const m = String(link).match(/\/s\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  const m2 = String(link).match(/[?&]surl=([A-Za-z0-9_-]+)/); // 百度 ?surl= 形态
  return m2 ? m2[1] : '';
}

// 校验分享链接是否包含对应网盘域名和有效短码,防止网盘接口返回 https:// 或只有路径前缀的脏数据。
const SHARE_LINK_PATTERNS = {
  baidu: /^(https?:\/\/)?pan\.baidu\.com\/s\/[A-Za-z0-9_-]{5,}$/,
  quark: /^(https?:\/\/)?pan\.quark\.cn\/s\/[A-Za-z0-9_-]{5,}$/,
  xunlei: /^(https?:\/\/)?pan\.xunlei\.com\/s\/[A-Za-z0-9_-]{5,}$/,
};
function isValidShareLink(link, provider) {
  if (!link || typeof link !== 'string') return false;
  const bare = link.split('?')[0].split('#')[0];
  const re = SHARE_LINK_PATTERNS[provider];
  return re ? re.test(bare) : false;
}

// 并发限制器:最多同时 running 个任务,避免批量同盘瞬间全并发触发网盘限流/封禁
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (e) {
        results[idx] = { ok: false, error: e.message };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ── 单条转存编排(三网盘共用,供 /api/transfer 与 /api/transfer/batch 复用) ──
// 并发去重:同一 provider + 同分享短码正在转存时,复用其 Promise,
registerApiRoutes(app, {
  store, logger, baidu, quark, xunlei,
  doTransfer, mapLimit, extractSurl, isValidShareLink,
  refreshPings, pingCache, PORT,
  getServerState: () => ({ healthy: serverHealthy, fatalCount }),
  getVersion,
  process, path, fs, __dirname,
});

// 避免批量同链接并发导致重复转存、重复写历史(store 单进程内 read-modify-write 虽同步安全,
// 但去重可省去重复的网络请求与潜在的双重落盘)。
const inflight = new Map();

async function doTransfer(body) {
  const { link, pwd, makeShare, sharePassword, provider } = body;
  const p = provider || 'baidu';
  const wantShare = !!makeShare;
  const sourceSurl = extractSurl(link);
  logger.info('转存开始:', { provider: p, surl: sourceSurl, force: !!body.force, makeShare: wantShare });

  // ① 命中历史缓存,直接返回(force 时跳过)。兼容旧记录(仅 sourceLink 无 sourceSurl)。
  if (sourceSurl && !body.force) {
    const hit = store.getTasks().find(
      (t) => t.provider === p &&
        (t.sourceSurl === sourceSurl || extractSurl(t.sourceLink) === sourceSurl) &&
        t.status === 'success'
    );
    if (hit) {
      const files = (hit.files || []).map((f) => ({ server_filename: f.name, size: f.size, path: f.name }));
      // 要分享时,历史 shareLink 必须有效;若无效则按「无分享链接」处理,不返回脏数据。
      const hasValidShare = wantShare && isValidShareLink(hit.shareLink, p);
      // 不要分享,或要分享且历史已生成有效分享链接 → 直接返回旧链接(跳过转存)
      if (!wantShare || hasValidShare) {
        logger.info('命中历史缓存,跳过转存:', { provider: p, surl: sourceSurl, makeShare: wantShare });
        return {
          provider: p, ok: true, fromCache: true,
          share: hasValidShare ? { link: hit.shareLink, password: hit.sharePwd || '' } : null,
          files, taskId: hit.id,
        };
      }
      // 要分享但历史无有效分享链接: 不再整次重转(避免重复落盘), 提示用户勾「强制重转」补分享。
      // 自动补分享需调逆向接口且沙箱无法验证, 做错有分享错文件风险, 故交由用户显式触发。
      logger.info('命中历史但无分享链接,提示强制重转补分享:', { provider: p, surl: sourceSurl });
      return {
        provider: p, ok: true, fromCache: true, needShare: true, share: null,
        files, taskId: hit.id,
        message: '该链接历史转存未生成分享链接,请勾选「强制重转」以补生成分享',
      };
    }
  }

  // ② 并发去重:正在转存同一链接的请求复用进行中的结果,避免重复转存/重复写历史
  // key 含 makeShare 维度: 同一链接「要分享 / 不要分享」视作不同任务,互不覆盖
  if (sourceSurl) {
    const key = `${p}|${sourceSurl}|${wantShare ? 1 : 0}`;
    const existing = inflight.get(key);
    if (existing) {
      logger.info('并发复用进行中的转存:', { provider: p, surl: sourceSurl });
      return existing;
    }
    const promise = runTransfer(body, p).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  return runTransfer(body, p);
}

// 实际执行转存(去重/缓存判断已在 doTransfer 完成)
async function runTransfer(body, p) {
  const { link, pwd, makeShare, sharePassword } = body;
  const sourceSurl = extractSurl(link);
  const mkTask = (extra) => store.addTask(Object.assign({
    provider: p,
    sourceLink: link,
    sourcePwd: pwd || '',
    sourceSurl,
    title: (body.title || '').trim(),
  }, extra));

  if (p === 'quark') {
    const cookie = quark.getValidCookie();
    if (!cookie) return { provider: 'quark', ok: false, error: '夸克未授权,请先点击页面上的「授权夸克网盘」完成本机登录' };
    try {
      const { pwdId, passcode } = quark.parseLink(link);
      if (!pwdId) return { provider: 'quark', ok: false, error: '无法从链接中解析出夸克分享标识(pwd_id)' };
      const qDir = store.getDir('quark');
      const r = await quark.transfer({ cookie, pwdId, passcode, makeShare: !!makeShare, sharePeriod: 0, sharePassword: (sharePassword || '').trim(), toPdirFid: qDir && qDir.id, folderName: qDir && qDir.name });
      const record = mkTask({
        destPath: r.destPath,
        fileCount: (r.file_list || []).length,
        files: (r.file_list || []).map((f) => ({ name: f.server_filename || f.path, size: f.size })),
        shareLink: r.share ? r.share.link : null,
        sharePwd: r.share ? r.share.password : null,
        status: 'success',
      });
      return { provider: 'quark', ok: true, files: r.file_list, share: r.share, taskId: record.id };
    } catch (e) {
      logger.warn('夸克转存失败:', e.message);
      mkTask({ status: 'failed', error: e.message });
      return { provider: 'quark', ok: false, error: e.message };
    }
  }

  if (p === 'xunlei') {
    const connected = xunlei.isConnected();
    if (!connected) return { provider: 'xunlei', ok: false, error: '迅雷未授权,请先点击页面上的「授权迅雷网盘」完成本机登录' };
    try {
      const xDir = store.getDir('xunlei');
      const r = await xunlei.transfer({ link, pwd, makeShare, sharePeriod: 0, sharePassword, destFolderId: xDir && xDir.id, destFolderName: xDir && xDir.name });
      const record = mkTask({
        destPath: r.destPath,
        fileCount: (r.file_list || []).length,
        files: (r.file_list || []).map((f) => ({ name: f.server_filename || f.path, size: f.size })),
        shareLink: r.share && r.share.link ? r.share.link : null,
        sharePwd: r.share && r.share.password ? r.share.password : null,
        status: 'success',
      });
      return { provider: 'xunlei', ok: true, files: r.file_list, share: r.share && r.share.link ? r.share : null, taskId: record.id };
    } catch (e) {
      logger.warn('迅雷转存失败:', e.message);
      mkTask({ status: 'failed', error: e.message });
      return { provider: 'xunlei', ok: false, error: e.message };
    }
  }

  // 默认 / 百度
  const baiduCookie = baidu.getCookie();
  if (!baiduCookie) return { provider: 'baidu', ok: false, error: '百度未授权,请先点击页面上的「授权百度网盘」完成本机登录' };
  try {
    const surl = baidu.parseSurl(link);
    if (!surl) return { provider: 'baidu', ok: false, error: '无法从链接中解析出分享标识(surl)' };
    const listData = await baidu.getShareList(surl, pwd);
    const fsidList = listData.list.map((f) => f.fs_id);
    // 优先用网页上选定的目录,否则回退 .env 默认
    const bDir = store.getDir('baidu');
    const destPath = (bDir && bDir.id) || baidu.getConfig().appDir;
    await baidu.ensureDir(destPath); // 幂等:目录不存在则自动创建
    const transferData = await baidu.transfer(listData.shareid, listData.uk, fsidList, destPath);
    const transferredPaths = (transferData.file_list || []).map((f) => f.path);
    let share = null;
    if (makeShare) {
      // 解析我盘内的真实 fs_id(百度 /share/set 必须用目标盘 fs_id,非分享源 fs_id)
      let fsIds = (transferData.file_list || []).map((f) => f.fs_id).filter(Boolean);
      if (!fsIds.length) {
        // 兜底:LIST 目标目录,按文件名匹配转存后的文件
        const names = (listData.list || []).map((f) => f.server_filename).filter(Boolean);
        const dirList = await baidu.listDir(destPath);
        fsIds = dirList.filter((f) => names.includes(f.server_filename)).map((f) => f.fs_id);
      }
      if (fsIds.length) {
        // 百度分享提取码统一为 8888(baidu.createShare 内部也会回退到该默认值);period 固定 0=永久
        share = await baidu.createShare(fsIds, 0, sharePassword || '8888');
      }
    }
    const record = mkTask({
      provider: 'baidu',
      destPath,
      fileCount: fsidList.length,
      files: (transferData.file_list || []).map((f) => ({ name: f.server_filename || f.path, size: f.size })),
      shareLink: share ? share.link : null,
      sharePwd: share ? share.password : null,
      status: 'success',
    });
    return { provider: 'baidu', ok: true, transfer: transferData, share, files: transferData.file_list, taskId: record.id };
  } catch (e) {
    logger.warn('百度转存失败:', e.message);
    mkTask({ status: 'failed', error: e.message });
    return { provider: 'baidu', ok: false, error: e.message };
  }
}

// ── 版本与更新 ───────────────────────────────────────
// 版本号统一读 package.json（与 tools-hub 各子项目同步 bump），
// VERSION 文件仅为历史/外部工具展示保留，不再作为 /api/version 的版本来源。
function getVersion() {
  try { return require('./package.json').version; }
  catch { return 'unknown'; }
}
// (自更新机制已移除:gitShort/findConnect/run 等 git 相关函数随 /api/update 一并删除,
//  更新统一由工具箱 tools-hub 负责)

let fatalCount = 0;
let lastFatalTs = 0;
// 服务健康标志：必须显式声明并初始化为 true（全新进程即为健康态）。
// 修复：此前只在 onFatal 里隐式赋值，导致 /api/ready、/api/health 在首次异常前
// 读取未声明变量抛 ReferenceError → HTTP 500，独立控制面板看门狗误判服务死亡反复重启。
let serverHealthy = true;


// 百度登录页(弹窗,与夸克同构)

// 夸克登录页(弹窗)

// ── 启动自检:打印各网盘授权状态与关键配置,缺失则告警(不触发任何网盘网络请求) ──
function checkConfig() {
  const issues = [];
  try {
    const appDir = baidu.getConfig().appDir;
    if (!appDir) issues.push('百度转存目录未配置(.env BAIDU_APP_DIR),百度转存将失败');
  } catch (e) {
    issues.push('读取百度配置失败: ' + e.message);
  }
  const baiduAcc = store.getAccount('baidu');
  const quarkAcc = store.getAccount('quark');
  const xunleiAcc = store.getAccount('xunlei');
  logger.info('启动配置检查:', {
    baidu: baiduAcc && baiduAcc.cookie ? '已授权' : '未授权',
    quark: quarkAcc && quarkAcc.connected && quarkAcc.cookie ? '已授权' : '未授权',
    xunlei: xunleiAcc && xunleiAcc.connected ? '已授权' : '未授权',
  });
  if (issues.length) issues.forEach((s) => logger.warn('配置警告:', s));
  else logger.info('配置检查通过');
}

// 启动自检:打印各网盘授权状态与关键配置,缺失则告警(不触发任何网盘网络请求)
checkConfig();

// 仅绑定本机回环地址,避免局域网内其他设备用你的登录态调用转存接口(服务持有真实网盘 cookie)
// 端口冲突时自动重试(用于 /api/restart 拉起的新进程在旧进程退出前抢绑 3000)
function startServer(attempt = 0) {
  const srv = app.listen(PORT, '127.0.0.1', () => {
    logger.info(`netdisk-hub 运行中 → http://localhost:${PORT} (仅本机绑定)`);
  });
  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 30) {
      setTimeout(() => startServer(attempt + 1), 300);
    } else {
      logger.error('监听失败:', err);
      process.exit(1);
    }
  });
  return srv;
}
const server = startServer();

// 启动即后台预热各盘实时探测(尤其是迅雷 token 冷启动≥3s),
// 让首次打开网页/首次转存都不必再等浏览器启动 → 消除首屏黑框。
refreshPings();

// ── 韧性:崩溃防护 + 优雅关闭 ──
// 未捕获异常/未处理 Promise 拒绝:记录日志后退出(避免进程静默死且不留痕)。
// 本地工具场景下,崩溃后退出比无限循环重启更安全;HTA 会检测端口变化并提示用户重启。
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn(`收到 ${signal}, 正在优雅关闭…`);
  server.close(() => {
    logger.info('服务已关闭');
    process.exit(0);
  });
  // 兜底:若 5 秒内仍有未结束的连接,强制退出
  setTimeout(() => {
    logger.error('优雅关闭超时,强制退出');
    process.exit(1);
  }, 5000).unref();
}

// 未捕获异常/未处理拒绝:记录日志并标记服务不健康,交由健康检查/面板暴露。
// 不再直接 process.exit —— 本地工具场景下,进程静默死亡比「带病运行但可观测」更糟;
// 控制面板看门狗只负责真正的进程崩溃重启,而带病存活的进程仍能服务 UI 并暴露问题。
function onFatal(label, err) {
  if (shuttingDown) return; // 关闭流程中产生的异常忽略,避免干扰优雅退出
  fatalCount += 1;
  lastFatalTs = Date.now();
  logger.error(label + ' (已标记服务不健康,进程保持运行以便排查):', err);
  serverHealthy = false;
}
// auto health recovery: check every 60s
const MAX_FATAL_BEFORE_STOP = 10;
setInterval(function() {
  if (!serverHealthy && fatalCount <= MAX_FATAL_BEFORE_STOP) {
    if (Date.now() - lastFatalTs > 60000) {
      serverHealthy = true;
      logger.info("[health] server auto-recovered");
    }
  }
  if (fatalCount > 1) {
    var elapsed = (Date.now() - lastFatalTs) / 1800000;
    if (elapsed > 1) {
      fatalCount = Math.max(1, Math.round(fatalCount * Math.pow(0.5, Math.floor(elapsed))));
    }
  }
}, 60000).unref();

process.on('uncaughtException', (e) => onFatal('未捕获异常', e));
process.on('unhandledRejection', (r) => onFatal('未处理的 Promise 拒绝', r));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
