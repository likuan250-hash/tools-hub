// netdisk-hub: API 路由(账号/转存/任务/目录/版本/更新/健康)
// 从 server.js 提取，由 server.js require 并调用。
"use strict";

const progress = require("./progress");

// 注册所有 API 路由到 app
// ctx: { store, logger, baidu, quark, xunlei,
//        doTransfer, mapLimit, extractSurl, isValidShareLink,
//        refreshPings, pingCache, getServerState, PORT,
//        getVersion,
//        process, path, fs, __dirname }
module.exports = function registerApiRoutes(app, ctx) {
  const {
    store,
    logger,
    baidu,
    quark,
    xunlei,
    doTransfer,
    mapLimit,
    extractSurl,
    isValidShareLink,
    refreshPings,
    pingCache,
    getServerState,
    PORT,
    getVersion,
    process,
    path,
    fs,
    __dirname: projectDir,
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

    const bDetail = baiduAcc
      ? baidu.getLastCheckError
        ? baidu.getLastCheckError()
        : ""
      : "no_cookie_saved";
    const bDir = store.getDir("baidu");
    const qDir = store.getDir("quark");
    const xDir = store.getDir("xunlei");
    const bDefault = baidu.getConfig().appDir;
    const qDefault = quark.FOLDER_NAME;

    refreshPings();

    res.json({
      baidu: {
        connected: hasBaiduCookie,
        pingOK: pingCache.baidu,
        hasToken: !!(baiduAcc && baiduAcc.accessToken),
        hasCookie: hasBaiduCookie,
        detail: bDetail,
        expiresAt: bExp && bExp.ts,
        expiresAtEstimated: bExp ? bExp.estimated : false,
        dir: {
          effective: (bDir && bDir.id) || bDefault,
          userSet: !!bDir,
          name: (bDir && bDir.name) || bDefault,
        },
      },
      quark: {
        connected: hasQuarkCred,
        pingOK: pingCache.quark,
        expiresAt: qExp && qExp.ts,
        expiresAtEstimated: qExp ? qExp.estimated : false,
        dir: {
          effective: qDir && qDir.id === "0" ? "/" : "/" + ((qDir && qDir.name) || qDefault),
          userSet: !!qDir,
          name: (qDir && qDir.name) || qDefault,
        },
      },
      xunlei: {
        connected: hasXunleiCred,
        pingOK: pingCache.xunlei,
        expiresAt: xExp && xExp.ts,
        expiresAtEstimated: xExp ? xExp.estimated : false,
        dir: {
          effective: xDir && !xDir.id ? "/" : "/" + ((xDir && xDir.name) || "游戏"),
          userSet: !!xDir,
          name: (xDir && xDir.name) || "游戏",
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
    const fallback =
      p === "baidu" ? baidu.getConfig().appDir : p === "quark" ? quark.FOLDER_NAME : "游戏";
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

  // ── 聚合搜索:并行搜三盘「各自转存目录」第一层,按关键词过滤 ──
  // 夸克默认目录 fid 缓存(10 分钟),避免每次搜索都解析、遇偶发接口抖动搜空
  let quarkSearchFid = null;
  let quarkSearchFidTs = 0;
  async function resolveQuarkFid(cookie) {
    if (quarkSearchFid && Date.now() - quarkSearchFidTs < 10 * 60 * 1000) return quarkSearchFid;
    let f = null;
    for (let i = 0; i < 2 && !f; i++) {
      try {
        f = await quark.findFolderByName(cookie, quark.FOLDER_NAME);
      } catch (e) {
        f = null;
      }
      if (!f) await new Promise((r) => setTimeout(r, 500));
    }
    if (f && f.fid) {
      quarkSearchFid = f.fid;
      quarkSearchFidTs = Date.now();
      return f.fid;
    }
    return quarkSearchFid || null; // 解析失败时沿用上次成功值,实在没有则报错
  }
  app.get("/api/search", async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "缺少搜索关键词" });
    const dir = (p) => store.getDir(p);
    const jobs = [
      [
        "baidu",
        (async () => {
          if (!baidu.getCookie()) throw new Error("百度未授权,请先授权");
          const d = dir("baidu");
          // 未在网页保存过目录时,用生效默认转存目录(env BAIDU_APP_DIR)
          return baidu.searchFiles((d && d.id) || baidu.getConfig().appDir || "/", q);
        })(),
      ],
      [
        "quark",
        (async () => {
          const cookie = quark.getValidCookie();
          if (!cookie) throw new Error("夸克未授权,请先授权");
          const d = dir("quark");
          // 未保存目录时,解析默认转存文件夹(QUARK_FOLDER)的 fid
          let fid = (d && d.id) || null;
          if (!fid) {
            fid = await resolveQuarkFid(cookie);
            if (!fid)
              throw new Error(
                "夸克默认转存目录(" +
                  quark.FOLDER_NAME +
                  ")解析失败,请确认文件夹存在或在网页选择转存目录",
              );
          }
          return quark.searchFiles(cookie, fid, q);
        })(),
      ],
      [
        "xunlei",
        (async () => {
          if (!xunlei.isConnected()) throw new Error("迅雷未授权,请先授权");
          const d = dir("xunlei");
          // 未保存目录时,解析默认「游戏」文件夹,找不到才回退根目录
          let id = (d && d.id) || null;
          if (!id) {
            const f = await xunlei.findFolder("游戏", "");
            if (f && f.id) id = f.id;
          }
          return xunlei.searchFiles(id || "", q);
        })(),
      ],
    ];
    const providers = {};
    await Promise.all(
      jobs.map(async ([p, pr]) => {
        try {
          providers[p] = { ok: true, items: await pr };
        } catch (e) {
          providers[p] = { ok: false, error: e.message };
        }
      }),
    );
    res.json({ providers });
  });

  // ── 聚合搜索删除:软删进各盘回收站(可恢复) ──
  app.post("/api/trash", async (req, res) => {
    const { provider, fileIds } = req.body || {};
    const map = { baidu: 1, quark: 1, xunlei: 1 };
    if (!map[provider]) return res.status(400).json({ error: "未知网盘" });
    if (!Array.isArray(fileIds) || !fileIds.length)
      return res.status(400).json({ error: "缺少 fileIds" });
    try {
      let result;
      if (provider === "baidu") {
        if (!baidu.getCookie()) return res.status(401).json({ error: "百度未授权,请先授权" });
        result = await baidu.trashFiles(fileIds);
      } else if (provider === "quark") {
        const cookie = quark.getValidCookie();
        if (!cookie) return res.status(401).json({ error: "夸克未授权,请先授权" });
        result = await quark.trashFiles(cookie, fileIds);
      } else {
        if (!xunlei.isConnected()) return res.status(401).json({ error: "迅雷未授权,请先授权" });
        result = await xunlei.trashFiles(fileIds);
      }
      logger.info("移入回收站:", { provider, count: fileIds.length });
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 单条转存 ─────────────────────────────────────────
  app.post("/api/transfer", async (req, res) => {
    const { client } = req.body;
    const push = (ev) => {
      if (client) progress.emit(client, ev);
    };
    const provName =
      { baidu: "百度网盘", xunlei: "迅雷网盘", quark: "夸克网盘" }[req.body.provider || "baidu"] ||
      req.body.provider ||
      "网盘";
    const batchTitle = (req.body.title || "").trim() || "未命名";
    push({
      type: "step",
      step: { index: 0, name: "转存到" + provName + "（" + batchTitle + "）", status: "进行中" },
    });
    if (req.body.makeShare)
      push({
        type: "step",
        step: { index: 1, name: "生成分享（" + batchTitle + "）", status: "进行中" },
      });
    push({ type: "log", level: "info", message: "开始重试转存到" + provName + "…" });
    try {
      const r = await doTransfer(req.body);
      if (!r.ok) {
        push({
          type: "step",
          step: {
            index: 0,
            name: "转存到" + provName + "（" + batchTitle + "）",
            status: "失败",
            reason: r.error || "",
          },
        });
        push({ type: "log", level: "err", message: "转存失败：" + (r.error || "") });
        if (req.body.makeShare)
          push({
            type: "step",
            step: {
              index: 1,
              name: "生成分享（" + batchTitle + "）",
              status: "跳过",
              reason: "转存失败",
            },
          });
        push({ type: "done", okCount: 0, total: 1, results: [r] });
        const code = /未授权/.test(r.error) ? 401 : 400;
        return res.status(code).json({ ok: false, error: r.error });
      }
      const files = (r.files || []).length;
      push({
        type: "step",
        step: {
          index: 0,
          name: "转存到" + provName + "（" + batchTitle + "）",
          status: "成功",
          files,
          fromCache: r.fromCache || undefined,
        },
      });
      push({
        type: "log",
        level: "ok",
        message: "转存成功" + (r.fromCache ? "（来自历史缓存）" : "，共 " + files + " 个文件"),
      });
      if (req.body.makeShare) {
        if (r.share && r.share.link) {
          push({
            type: "step",
            step: {
              index: 1,
              name: "生成分享（" + batchTitle + "）",
              status: "成功",
              link: r.share.link,
              pwd: r.share.password || "",
            },
          });
          push({ type: "log", level: "ok", message: "分享已生成：" + r.share.link });
        } else {
          const warn = !!r.needShare;
          push({
            type: "step",
            step: {
              index: 1,
              name: "生成分享（" + batchTitle + "）",
              status: warn ? "警告" : "跳过",
              reason: warn ? "历史转存未生成分享，需勾选「强制重转」补生成" : "未生成分享链接",
            },
          });
          push({
            type: "log",
            level: warn ? "warn" : "info",
            message: warn ? "历史无分享链接，需强制重转补生成" : "未生成分享链接",
          });
        }
      }
      push({ type: "done", okCount: 1, total: 1, results: [r] });
      res.json({ ok: true, ...r });
    } catch (e) {
      push({
        type: "step",
        step: {
          index: 0,
          name: "转存到" + provName + "（" + batchTitle + "）",
          status: "失败",
          reason: e.message,
        },
      });
      push({ type: "log", level: "err", message: "转存异常：" + e.message });
      if (req.body.makeShare)
        push({
          type: "step",
          step: {
            index: 1,
            name: "生成分享（" + batchTitle + "）",
            status: "跳过",
            reason: "转存异常",
          },
        });
      push({ type: "done", okCount: 0, total: 1, results: [{ ok: false, error: e.message }] });
      logger.error("单条转存异常:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── 批量转存 ─────────────────────────────────────────
  // SSE 进度订阅：前端先 EventSource 打开本接口（?client=xxx），再带同一 client 提交批量转存，
  // 转存过程中逐条推送 step/log，结束推 done。与 kdocs 一键执行同款实时进度模式。
  app.get("/api/transfer/events", (req, res) => {
    const clientId = String(req.query.client || "");
    if (!clientId) return res.status(400).end();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const ch = progress.create(clientId);
    const onEvent = (ev) => res.write("data: " + JSON.stringify(ev) + "\n\n");
    ch.on("event", onEvent);
    const heartbeat = setInterval(() => res.write(": hb\n\n"), 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      ch.removeListener("event", onEvent);
      progress.remove(clientId);
    });
  });

  app.post("/api/transfer/batch", async (req, res) => {
    try {
      const { jobs, makeShare, sharePassword, force, client } = req.body;
      if (!Array.isArray(jobs) || !jobs.length)
        return res.status(400).json({ ok: false, error: "缺少任务" });
      logger.info(
        "收到批量转存请求: " +
          jobs.length +
          " 个任务, makeShare=" +
          !!makeShare +
          ", force=" +
          !!force,
      );
      const PROV_NAME = { baidu: "百度网盘", xunlei: "迅雷网盘", quark: "夸克网盘" };
      const push = (ev) => {
        if (client) progress.emit(client, ev);
      };
      const batchTitle = (req.body.title || "").trim() || "未命名";
      push({ type: "log", level: "info", message: "开始批量转存：" + jobs.length + " 条链接" });
      const results = await mapLimit(jobs, 3, async (job, idx) => {
        const provName = PROV_NAME[job.provider] || job.provider;
        const stepBase = idx * 2;
        push({
          type: "step",
          step: {
            index: stepBase,
            name: "转存到" + provName + "（" + batchTitle + "）",
            status: "进行中",
          },
        });
        if (makeShare)
          push({
            type: "step",
            step: { index: stepBase + 1, name: "生成分享（" + batchTitle + "）", status: "进行中" },
          });
        push({
          type: "log",
          level: "info",
          message: "[" + (idx + 1) + "/" + jobs.length + "] 转存到" + provName + "…",
        });
        try {
          for (let attempt = 0; attempt <= 1; attempt++) {
            const r = await doTransfer({
              ...job,
              makeShare,
              sharePeriod: 0,
              sharePassword,
              force,
              title: (req.body.title || "").trim(),
            });
            if (r.ok || attempt > 0) {
              if (r.ok) {
                const files = (r.files || []).length;
                const fromCache = !!r.fromCache;
                push({
                  type: "step",
                  step: {
                    index: stepBase,
                    name: "转存到" + provName + "（" + batchTitle + "）",
                    status: "成功",
                    files,
                    fromCache: fromCache || undefined,
                  },
                });
                push({
                  type: "log",
                  level: "ok",
                  message:
                    "[" +
                    (idx + 1) +
                    "] 转存成功" +
                    (fromCache ? "（来自历史缓存）" : "，共 " + files + " 个文件"),
                });
                if (makeShare) {
                  if (r.share && r.share.link) {
                    push({
                      type: "step",
                      step: {
                        index: stepBase + 1,
                        name: "生成分享（" + batchTitle + "）",
                        status: "成功",
                        link: r.share.link,
                        pwd: r.share.password || "",
                      },
                    });
                    push({
                      type: "log",
                      level: "ok",
                      message: "[" + (idx + 1) + "] 分享已生成：" + r.share.link,
                    });
                  } else {
                    const warn = !!r.needShare;
                    push({
                      type: "step",
                      step: {
                        index: stepBase + 1,
                        name: "生成分享（" + batchTitle + "）",
                        status: warn ? "警告" : "跳过",
                        reason: warn
                          ? "历史转存未生成分享，需勾选「强制重转」补生成"
                          : "未生成分享链接",
                      },
                    });
                    push({
                      type: "log",
                      level: warn ? "warn" : "info",
                      message:
                        "[" +
                        (idx + 1) +
                        "] " +
                        (warn ? "历史无分享链接，需强制重转补生成" : "未生成分享链接"),
                    });
                  }
                }
              } else {
                push({
                  type: "step",
                  step: {
                    index: stepBase,
                    name: "转存到" + provName + "（" + batchTitle + "）",
                    status: "失败",
                    reason: r.error || "",
                  },
                });
                push({
                  type: "log",
                  level: "err",
                  message: "[" + (idx + 1) + "] 转存失败：" + (r.error || ""),
                });
                if (makeShare)
                  push({
                    type: "step",
                    step: {
                      index: stepBase + 1,
                      name: "生成分享（" + batchTitle + "）",
                      status: "跳过",
                      reason: "转存失败",
                    },
                  });
              }
              return r;
            }
            push({
              type: "log",
              level: "warn",
              message: "[" + (idx + 1) + "] 转存失败，1s 后重试：" + (r.error || ""),
            });
            logger.warn("[batch] transfer failed, retrying:", {
              provider: job.provider,
              error: r.error,
            });
            await new Promise((rs) => setTimeout(rs, 1000));
          }
        } catch (e) {
          push({
            type: "step",
            step: {
              index: stepBase,
              name: "转存到" + provName + "（" + batchTitle + "）",
              status: "失败",
              reason: e.message,
            },
          });
          push({
            type: "log",
            level: "err",
            message: "[" + (idx + 1) + "] 转存异常：" + e.message,
          });
          if (makeShare)
            push({
              type: "step",
              step: {
                index: stepBase + 1,
                name: "生成分享（" + batchTitle + "）",
                status: "跳过",
                reason: "转存异常",
              },
            });
          return { ok: false, error: e.message };
        }
      });
      const okCount = results.filter((r) => r && r.ok).length;
      logger.info("批量转存完成: 成功 " + okCount + "/" + results.length);
      push({
        type: "log",
        level: okCount === results.length ? "ok" : "info",
        message: "批量转存完成：成功 " + okCount + "/" + results.length,
      });
      push({ type: "done", okCount, total: results.length, results });
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
      ok: true,
      healthy: state.healthy,
      degraded: !state.healthy,
      fatalCount: state.fatalCount,
      ts: Date.now(),
      uptime: process.uptime(),
      port: PORT,
      bind: "127.0.0.1",
      accounts: {
        baidu: {
          configured: hasBaidu,
          sessionValid: pingCache.baidu === undefined ? null : pingCache.baidu,
        },
        quark: {
          configured: hasQuark,
          sessionValid: pingCache.quark === undefined ? null : pingCache.quark,
        },
        xunlei: {
          configured: hasXunlei,
          sessionValid: pingCache.xunlei === undefined ? null : pingCache.xunlei,
        },
      },
    };
    const hasAnyConfigured =
      body.accounts.baidu.configured ||
      body.accounts.quark.configured ||
      body.accounts.xunlei.configured;
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

  // failed retry: reuse record's own link/pwd/title, force transfer + share,
  // then update the SAME record to success (no success/failed duplicates, no title mismatch).
  app.post("/api/tasks/:id/retry", async (req, res) => {
    const t = store.getTasks().find((x) => x.id === req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: "record not found" });
    if (t.status !== "failed")
      return res.status(400).json({ ok: false, error: "only failed records can retry" });
    if (!t.sourceLink)
      return res.status(400).json({ ok: false, error: "record has no source link" });
    try {
      const r = await doTransfer({
        provider: t.provider,
        link: t.sourceLink,
        pwd: t.sourcePwd || "",
        title: t.title || "",
        force: true,
        makeShare: true,
      });
      if (!r.ok) return res.status(400).json({ ok: false, error: r.error || "retry failed" });
      store.updateTask(t.id, {
        status: "success",
        error: null,
        files: (r.files || []).map((f) => ({
          name: f.server_filename || f.path || f.name,
          size: f.size,
        })),
        fileCount: (r.files || []).length,
        destPath: r.destPath || t.destPath,
        shareLink: r.share && r.share.link ? r.share.link : null,
        sharePwd: r.share && r.share.password ? r.share.password : null,
      });
      res.json({ ok: true, task: store.getTasks().find((x) => x.id === t.id) });
    } catch (e) {
      logger.error("retry error:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });
};
