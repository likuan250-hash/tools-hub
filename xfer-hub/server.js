// xfer-hub HTTP 服务（工具箱第 6 个子工具，端口 3900）
//
// 与其它子服务一致：由主进程 fork，注入 TOOLSHUB_VERSION / BOOT_TOKEN / PORT。
// /api/version 回显 bootToken 供主进程做端口防抢占校验。
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const log = require("./src/logger");
const creds = require("./src/creds");
const xfer = require("./src/xfer");
const qb = require("./src/quark-bridge");
const bd = require("./src/baidu-official");
const prefs = require("./src/prefs");
const clientBridge = require("./src/client-bridge");

const PORT = Number(process.env.XFER_PORT || process.env.PORT || 3900);
const VERSION = process.env.TOOLSHUB_VERSION || readVersion();
const BOOT_TOKEN = process.env.BOOT_TOKEN || "";
const PUBLIC = path.join(__dirname, "public");

function readVersion() {
  try {
    return fs.readFileSync(path.join(__dirname, "VERSION"), "utf8").trim();
  } catch (_) {
    return "0.0.0";
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

const json = (res, code, obj) => send(res, code, JSON.stringify(obj));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > 2 * 1024 * 1024) reject(new Error("请求体过大"));
    });
    req.on("end", () => {
      if (!s) return resolve({});
      try {
        resolve(JSON.parse(s));
      } catch (_) {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

// 把夸克 Skill 的报错转成用户可操作的提示：
// 命中「未登录/未授权」→ 引导登录；否则保留技术信息。
function quarkLoginHint(msg) {
  const m = String(msg || "");
  if (/未登录|未授权|授权|login|token|认证/i.test(m)) {
    return "夸克未登录或授权已过期，请点「去登录」完成授权";
  }
  return "夸克接口调用失败：" + m;
}

// ── 路由 ──
const routes = {
  "GET /api/version": (req, res) => {
    json(res, 200, { ok: true, name: "xfer-hub", version: VERSION, bootToken: BOOT_TOKEN });
  },

  "GET /api/status": async (req, res) => {
    try {
      const st = creds.status();
      // 百度顺带取一次用户信息，让前端能显示账号
      if (st.baidu.ok) {
        try {
          const u = await bd.uinfo();
          st.baidu.name = u.netdisk_name || u.baidu_name;
          st.baidu.vip = u.vip_type || 0;
          st.baidu.uk = u.uk;
        } catch (e) {
          st.baidu.ok = false;
          st.baidu.reason = "开放平台接口不可用：" + e.message;
        }
      }
      if (st.quark.ok) {
        try {
          const r = await qb.userInfo();
          const d = (r && r.data) || r || {};
          const du = d.userInfo || {};
          st.quark.name = du.nickname || d.nickname || d.nickName || d.memberName || "";
        } catch (e) {
          st.quark.ok = false;
          // 区分「未登录/授权失效」与其它技术性错误：前者给可操作的登录引导
          st.quark.reason = quarkLoginHint(e.message);
        }
      }
      st.tmpDir = xfer.transferRoot();
      json(res, 200, st);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  },

  // 发起夸克登录：启动浏览器 OAuth（阻塞长），fire-and-forget 返回，
  // 由前端轮询 /api/status 检测登录态是否就绪。
  "POST /api/quark/login": async (req, res) => {
    // 若已登录则直接回成功，不重复弹浏览器
    try {
      await qb.userInfo();
      json(res, 200, { ok: true, already: true });
      return;
    } catch (_) {
      // 未登录，走下面的发起流程
    }
    try {
      json(res, 200, { ok: true, started: true });
      qb.login()
        .then((r) => log.info("夸克登录完成:", JSON.stringify(r).slice(0, 200)))
        .catch((e) => log.warn("夸克登录失败:", e.message));
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  },

  // 列出来源网盘/目标网盘的目录，供用户选目标目录
  "GET /api/dirs": async (req, res) => {
    const u = new URL(req.url, "http://x");
    const provider = u.searchParams.get("provider") || "baidu";
    try {
      if (provider === "baidu") {
        const items = await bd.listDir(u.searchParams.get("dir") || "/");
        json(res, 200, {
          items: items
            .filter((f) => f.isdir === 1)
            .map((f) => ({
              name: f.server_filename,
              size: 0,
              id: f.fs_id,
            })),
        });
      } else {
        const fid = u.searchParams.get("fid") || "0";
        const items = await qb.browse(fid, {});
        json(res, 200, {
          items: items
            .filter((f) => f.file_type === "0")
            .map((f) => ({
              name: f.filename,
              size: 0,
              id: f.fid,
            })),
        });
      }
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  },

  // 当前目标目录设置（两家一起给，含 userSet 标记）
  "GET /api/target-dir": (req, res) => {
    try {
      json(res, 200, { ok: true, dirs: prefs.allTargetDirs(), defaults: prefs.DEFAULTS });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  },

  // 保存目标目录（全局记住，与 netdisk-hub 的「选择目录」语义一致）
  "POST /api/target-dir": async (req, res) => {
    try {
      const body = await readBody(req);
      const provider = body.provider === "baidu" ? "baidu" : "quark";
      const cur = prefs.setTargetDir(provider, {
        path: body.path,
        name: body.name,
        id: body.id,
      });
      json(res, 200, { ok: true, dir: cur, dirs: prefs.allTargetDirs() });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  },

  // 当前中转目录（本地落盘路径，全局唯一）
  "GET /api/tmp-dir": (req, res) => {
    try {
      json(res, 200, { ok: true, tmpDir: prefs.getTmpDir() });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  },

  // 保存中转目录（用户可在界面用原生目录选择器指定，全局记住）
  "POST /api/tmp-dir": async (req, res) => {
    try {
      const body = await readBody(req);
      const cur = prefs.setTmpDir(body.path);
      json(res, 200, { ok: true, tmpDir: cur });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  },

  // 解析链接（不下载，只预览会转存什么）
  "POST /api/parse": async (req, res) => {
    try {
      const body = await readBody(req);
      const share = require("./src/share");
      const provider = share.detectProvider(body.link);
      if (!provider) return json(res, 400, { error: "无法识别的链接" });
      if (provider === "xunlei") return json(res, 400, { error: "迅雷暂不支持" });
      json(res, 200, {
        provider,
        pwd: share.extractPwd(body.link),
        url: share.extractUrl(body.link),
      });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  },

  // 启动转存任务
  "POST /api/xfer": async (req, res) => {
    try {
      const body = await readBody(req);
      if (!body.link || !String(body.link).trim()) {
        return json(res, 400, { error: "请填写分享链接" });
      }
      const t = xfer.start({
        link: body.link,
        // 下载方式：内建并发（默认）/ 官方客户端接力；前端没传就取用户上次选择
        downloadMode: body.downloadMode || prefs.getDownloadMode(),
        dstProvider: body.dstProvider || "quark",
        // 前端没显式传就取用户保存过的（再没有才用内置默认）
        dstPath: body.dstPath || prefs.getTargetDir(body.dstProvider || "quark").path,
        keepLocal: !!body.keepLocal,
      });
      json(res, 200, t);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  },

  // 下载方式（内建并发 / 官方客户端接力）+ 客户端探测结果
  "GET /api/download-mode": (req, res) => {
    let clients = { baidu: "", quark: "" };
    try {
      clients = clientBridge.detectAllClients();
    } catch (e) { /* 探测失败不阻断 */ }
    json(res, 200, { mode: prefs.getDownloadMode(), clients });
  },

  "POST /api/download-mode": async (req, res) => {
    try {
      const body = await readBody(req);
      json(res, 200, { mode: prefs.setDownloadMode(body && body.mode) });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  },

  "GET /api/xfer": (req, res) => {
    const u = new URL(req.url, "http://x");
    const id = u.searchParams.get("id");
    if (id) {
      const t = xfer.get(id);
      return t ? json(res, 200, t) : json(res, 404, { error: "任务不存在" });
    }
    json(res, 200, { tasks: xfer.all() });
  },

  "GET /api/logs": (req, res) => {
    const u = new URL(req.url, "http://x");
    json(res, 200, { logs: log.recent(Number(u.searchParams.get("n")) || 120) });
  },

  // 检查夸克 Skill 是否可用（安装/授权状态）
  "GET /api/quark/check": async (req, res) => {
    try {
      const dir = creds.quarkSkillDir();
      if (!dir) return json(res, 200, { ok: false, reason: "未找到夸克 Skill 目录" });
      const r = await qb.run(["get-user-info"]);
      const d = (r.result && r.result.data) || {};
      json(res, 200, {
        ok: !!(r.result && r.result.code === 0),
        dir,
        name: d.nickname || "",
        raw: r.result,
      });
    } catch (e) {
      json(res, 200, { ok: false, reason: e.message });
    }
  },
};

// ── 静态文件 ──
function serveStatic(req, res, pathname) {
  const p = pathname === "/" ? "/index.html" : pathname;
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) return send(res, 403, "forbidden", "text/plain");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "not found", "text/plain; charset=utf-8");
    send(res, 200, data, MIME[path.extname(file)] || "application/octet-stream");
  });
}

// ── 共享样式：从仓库 shared/ 提供 tokens.css 与 macos-motion.css ──
// 与 kdocs-tool / netdisk-hub 同一套做法：皮肤 CSS 只在渲染层定义，
// 子页面必须自己 <link> 进来；这里把仓库 shared/ 暴露成 /tokens.css。
// 打包后 shared/ 在 resources/app.asar 里（package.json 的 files 含 "shared/**/*"）。
function serveShared(req, res, pathname) {
  const name = path.basename(pathname); // 只取文件名，杜绝 ../ 穿越
  if (name !== "tokens.css" && name !== "macos-motion.css") {
    return send(res, 404, "not found", "text/plain; charset=utf-8");
  }
  const file = path.join(__dirname, "..", "shared", name);
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "not found", "text/plain; charset=utf-8");
    send(res, 200, data, "text/css; charset=utf-8");
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const key = `${req.method} ${u.pathname}`;

  if (routes[key]) {
    try {
      await routes[key](req, res);
    } catch (e) {
      log.error(`处理 ${key} 出错:`, e.message);
      json(res, 500, { error: e.message });
    }
    return;
  }

  if (req.method === "GET") {
    // 共享样式（tokens.css / macos-motion.css）优先于静态目录解析
    if (u.pathname === "/tokens.css" || u.pathname === "/macos-motion.css") {
      return serveShared(req, res, u.pathname);
    }
    return serveStatic(req, res, u.pathname);
  }
  send(res, 405, "method not allowed", "text/plain");
});

server.listen(PORT, "127.0.0.1", () => {
  log.info(`xfer-hub v${VERSION} 已启动 http://127.0.0.1:${PORT}`);
  log.info("中转目录:", xfer.transferRoot());
});

process.on("uncaughtException", (e) => log.error("未捕获异常:", e.message));
process.on("unhandledRejection", (e) => log.error("未处理的 Promise 拒绝:", String(e)));
