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
          st.quark.name = d.nickname || d.nickName || d.memberName || "";
        } catch (e) {
          st.quark.ok = false;
          st.quark.reason = "夸克 Skill 调用失败：" + e.message;
        }
      }
      st.tmpDir = xfer.transferRoot();
      json(res, 200, st);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  },

  // 列来源网盘/目标网盘的目录，供用户选目标目录
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
        dstProvider: body.dstProvider || "quark",
        dstPath: body.dstPath,
        keepLocal: !!body.keepLocal,
      });
      json(res, 200, t);
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

  if (req.method === "GET") return serveStatic(req, res, u.pathname);
  send(res, 405, "method not allowed", "text/plain");
});

server.listen(PORT, "127.0.0.1", () => {
  log.info(`xfer-hub v${VERSION} 已启动 http://127.0.0.1:${PORT}`);
  log.info("中转目录:", xfer.transferRoot());
});

process.on("uncaughtException", (e) => log.error("未捕获异常:", e.message));
process.on("unhandledRejection", (e) => log.error("未处理的 Promise 拒绝:", String(e)));
