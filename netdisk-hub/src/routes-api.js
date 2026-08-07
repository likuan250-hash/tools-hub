// netdisk-hub: API 路由(账号/转存/任务/目录/版本/更新/健康)
// 从 server.js 提取，由 server.js require 并调用。
"use strict";

// 注册所有 API 路由到 app
// ctx: { store, logger, baidu, quark, xunlei,
//        doTransfer, mapLimit, extractSurl, isValidShareLink,
//        refreshPings, pingCache, getServerState, PORT,
//        getVersion,
//        process, path, fs, __dirname }
module.exports = function registerApiRoutes(app, ctx) {
  const {
    store, logger, baidu, quark, xunlei,
    doTransfer, mapLimit, extractSurl, isValidShareLink,
    refreshPings, pingCache, getServerState, PORT,
    getVersion,
    process, path, fs, __dirname: projectDir,
  } = ctx;

  // ── 账号状态 ─────────────────────────────────────────
  app.get("/api/accounts", (req, res) => {
    const baiduAcc = store.getAccount("baidu");
    const quarkAcc = store.getAccount("quark");
    const xunleiAcc = store.getAccount("xunlei");

    // 登录态剩余天数：优先用授权时抓取的 cookie 真实过期时间；百度/夸克登录 Cookie 是会话级
    // （服务端不返回过期时间，与迅雷一致）→ 无 expiresAt 时按 loginAt+90 天兜底估算
    // （与 xunlei.auth.js 的兜底一致），并标记 estimated 供前端显示「约」。
    function effectiveExpiresAt(acc) {
      if (!acc) return null;
      if (acc.expiresAt) return { ts: acc.expiresAt, estimated: false };
      if (acc.loginAt) {
        const t = new Date(acc.loginAt).getTime();
        if (Number.isFinite(t)) return { ts: t + 90 * 24 * 3600 * 1000, estimated: true };
      }
      return null;
    }
    const bExp = effectiveExpiresAt(baiduAcc);
    const qExp = effectiveExpiresAt(quarkAcc);
    const xExp = effectiveExpiresAt(xunleiAcc);

    const hasBaiduCookie = !!(baiduAcc && baiduAcc.cookie);
    const hasQuarkCred = !!(quarkAcc && quarkAcc.connected && quarkAcc.cookie);
    const hasXunleiCred = !!(xunleiAcc && xunleiAcc.connected);

    const bDetail = baiduAcc ? (baidu.getLastCheckError ? baidu.getLastCheckError() : "") : "no_cookie_saved";
    const bDir = store.getDir("baidu");
    const qDir = store.getDir("quark");
    const xDir = store.getDir("xunlei");
    const bDefault = baidu.getConfig().appDir;
    const qDefault = quark.FOLDER_NAME;

    refreshPings();

    res.json({
      baidu: {
        connected: hasBaiduCookie, pingOK: pingCache.baidu,
        hasToken: !!(baiduAcc && baiduAcc.accessToken),
        hasCookie: hasBaiduCookie, detail: bDetail,
        expiresAt: bExp && bExp.ts,
        expiresAtEstimated: bExp ? bExp.estimated : false,
        dir: { effective: (bDir && bDir.id) || bDefault, userSet: !!bDir, name: (bDir && bDir.name) || bDefault },
      },
      quark: {
        connected: hasQuarkCred, pingOK: pingCache.quark,
        expiresAt: qExp && qExp.ts,
        expiresAtEstimated: qExp ? qExp.estimated : false,
        dir: {
          effective: (qDir && qDir.id === "0") ? "/" : "/" + ((qDir && qDir.name) || qDefault),
          userSet: !!qDir, name: (qDir && qDir.name) || qDefault,
        },
      },
      xunlei: {
        connected: hasXunleiCred, pingOK: pingCache.xunlei,
        expiresAt: xExp && xExp.ts,
        expiresAtEstimated: xExp ? xExp.estimated : false,
        dir: {
          effective: (xDir && !xDir.id) ? "/" : "/" + ((xDir && xDir.name) || "游戏"),
          userSet: !!xDir, name: (xDir && xDir.name) || "游戏",
        },
      },
    });
  });

  // ── 各网盘「转存目录」选择:读取/浏览/保存 ────────────────
  app.get("/api/dirs/:provider", (req, res) => {
    const p = req.params.provider;
    const map = { baidu: "baidu", quark: "quark", xunlei: "xunlei" };
    if (!map[p]) return res.status(400).json({ error: "未知网盘" });
    const d = store.getDir(p);
    const fallback = p === "baidu" ? baidu.getConfig().appDir : p === "quark" ? quark.FOLDER_NAME : "游戏";
    res.json({ selected: d, fallback, fallbackName: fallback });
  });

  app.get("/api/dirs/:provider/browse", async (req, res) => {
    const p = req.params.provider;
    const parent = req.query.parent;
    try {
      let folders = [];
      if (p === "baidu") {
        const cookie = baidu.getCookie();
        if (!cookie) return res.status(401).json({ error: "百度未授权,请先授权" });
        folders = await baidu.listSubfolders(parent || "/");
      } else if (p === "quark") {
        const cookie = quark.getValidCookie();
        if (!cookie) return res.status(401).json({ error: "夸克未授权,请先授权" });
        folders = await quark.listSubfolders(cookie, parent || "0");
      } else if (p === "xunlei") {
        if (!xunlei.isConnected()) return res.status(401).json({ error: "迅雷未授权,请先授权" });
        folders = await xunlei.listSubfolders(parent || "");
      } else {
        return res.status(400).json({ error: "未知网盘" });
      }
      res.json({ folders });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/dirs/:provider", (req, res) => {
    const p = req.params.provider;
    const map = { baidu: "baidu", quark: "quark", xunlei: "xunlei" };
    if (!map[p]) return res.status(400).json({ error: "未知网盘" });
    const { id, name } = req.body || {};
    if (!id || !name) return res.status(400).json({ error: "缺少 id 或 name" });
    const saved = store.setDir(p, { id: String(id), name: String(name) });
    logger.info("保存转存目录:", { provider: p, id: saved.id, name: saved.name });
    res.json({ ok: true, dir: saved });
  });

  // ── 单条转存 ─────────────────────────────────────────
  app.post("/api/transfer", async (req, res) => {
    try {
      const r = await doTransfer(req.body);
      if (!r.ok) {
        const code = /未授权/.test(r.error) ? 401 : 400;
        return res.status(code).json({ ok: false, error: r.error });
      }
      res.json({ ok: true, ...r });
    } catch (e) {
      logger.error("单条转存异常:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── 批量转存 ─────────────────────────────────────────
  app.post("/api/transfer/batch", async (req, res) => {
    try {
      const { jobs, makeShare, sharePassword, force } = req.body;
      if (!Array.isArray(jobs) || !jobs.length) return res.status(400).json({ ok: false, error: "缺少任务" });
      logger.info("收到批量转存请求: " + jobs.length + " 个任务, makeShare=" + !!makeShare + ", force=" + !!force);
      const results = await mapLimit(jobs, 3, async (job) => {
        for (let attempt = 0; attempt <= 1; attempt++) {
          const r = await doTransfer({ ...job, makeShare, sharePeriod: 0, sharePassword, force, title: (req.body.title || "").trim() });
          if (r.ok || attempt > 0) return r;
          logger.warn("[batch] transfer failed, retrying:", { provider: job.provider, error: r.error });
          await new Promise(rs => setTimeout(rs, 1000));
        }
      });
      const okCount = results.filter((r) => r && r.ok).length;
      logger.info("批量转存完成: 成功 " + okCount + "/" + results.length);
      res.json({ ok: true, results });
    } catch (e) {
      logger.error("批量转存异常:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── 任务历史 ─────────────────────────────────────────
  app.get("/api/tasks", (req, res) => {
    res.json(store.getTasks());
  });

  // ── 版本（只读；更新由工具箱 tools-hub 统一管理）──
  app.get("/api/version", (req, res) => {
    const hubVer = process.env.TOOLSHUB_VERSION;
    const version = hubVer || getVersion();
    const source = hubVer ? "tools-hub" : "standalone";
    // bootToken：工具箱注入的随机令牌，供主进程校验"占用本端口的确实是我们的服务"(端口防抢占检测)
    res.json({ version, source, updatable: false, bootToken: process.env.BOOT_TOKEN || null });
  });

  // ── 健康检查 ─────────────────────────────────────────
  app.get("/api/live", (req, res) => {
    res.json({ ok: true, ts: Date.now(), uptime: process.uptime() });
  });

  function readiness(req, res) {
    const baiduAcc = store.getAccount("baidu");
    const quarkAcc = store.getAccount("quark");
    const xunleiAcc = store.getAccount("xunlei");
    const hasBaidu = !!(baiduAcc && baiduAcc.cookie);
    const hasQuark = !!(quarkAcc && quarkAcc.connected && quarkAcc.cookie);
    const hasXunlei = !!(xunleiAcc && xunleiAcc.connected);
    refreshPings();
    const state = getServerState();
    const body = {
      ok: true, healthy: state.healthy, degraded: !state.healthy,
      fatalCount: state.fatalCount, ts: Date.now(), uptime: process.uptime(),
      port: PORT, bind: "127.0.0.1",
      accounts: {
        baidu: { configured: hasBaidu, sessionValid: pingCache.baidu === undefined ? null : pingCache.baidu },
        quark: { configured: hasQuark, sessionValid: pingCache.quark === undefined ? null : pingCache.quark },
        xunlei: { configured: hasXunlei, sessionValid: pingCache.xunlei === undefined ? null : pingCache.xunlei },
      },
    };
    const hasAnyConfigured = body.accounts.baidu.configured || body.accounts.quark.configured || body.accounts.xunlei.configured;
    const trulyHealthy = state.healthy && (hasAnyConfigured || state.fatalCount === 0);
    res.status(trulyHealthy ? 200 : 503).json(body);
  }

  app.get("/api/health", readiness);
  app.get("/api/ready", readiness);

  // ── 清空失败记录 ─────────────────────────────────────
  app.delete("/api/tasks/failed", (req, res) => {
    try {
      const { removed } = store.backupAndRemoveFailed();
      logger.info("清空失败记录: 删除 " + removed + " 条(已备份到 data/store-trash-*.json)");
      res.json({ ok: true, removed });
    } catch (e) {
      logger.error("清空失败记录出错:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });
};
