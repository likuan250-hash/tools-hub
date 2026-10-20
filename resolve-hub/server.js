// resolve-hub —— 达芬奇剪辑工具（包装 scripts/resolve-auto/resolve.py）
// 流程：选素材目录 → 开始做视频(setup 0-4) → 用户手动 5-7 → 确认好了(render 8-9)
// 零 npm 依赖；日志以 chunked 文本流实时回传前端。
//
// 2026-10 自检修复：
//  - 同源 Origin 校验（与 netdisk/material 一致），防跨站触发
//  - 单任务锁（并发 409）、取消接口、客户端断开自动杀子进程
//  - 子进程退出码以 __RESOLVE_EXIT__ 标记回传，前端不再靠"失败"关键字判成败
//  - 输出文件名/项目名服务端消毒；渲染输出按所选目录（--target）
//  - /api/preflight 预检 Python / DRT 模板 / Resolve.exe
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const util = require("./lib/util");

const PUBLIC = path.join(__dirname, "public");
const PY = path.join(__dirname, "..", "scripts", "resolve-auto", "resolve.py");
const VIDEO_EXTS = [".mp4", ".mkv", ".webm", ".mov"];
const COVER_EXTS = [".jpg", ".jpeg", ".png", ".webp"];

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (e) {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function folderInfo(dir, fsImpl = fs) {
  let entries = [];
  try {
    entries = fsImpl.readdirSync(dir);
  } catch (e) {
    return { ok: false, error: "目录不可读" };
  }
  const cover =
    entries.find(
      (n) => n.startsWith("封面") && COVER_EXTS.some((e) => n.toLowerCase().endsWith(e)),
    ) || null;
  const trailer =
    entries.find((n) => {
      const lower = n.toLowerCase();
      if (!VIDEO_EXTS.some((e) => lower.endsWith(e))) return false;
      if (n.startsWith(".")) return false;
      if (/\.(part|ytdl|temp)$/.test(lower)) return false;
      if (/\.f\d+(\.\w+)?$/i.test(n)) return false;
      if (n.includes("免费学习版下载") || n.startsWith("【游戏")) return false;
      return true;
    }) || null;
  const projectName =
    util.sanitizeProjectName(path.basename(String(dir).replace(/[\\/]+$/, ""))) || "未命名项目";
  return {
    ok: true,
    cover,
    trailer,
    coverOk: !!cover,
    trailerOk: !!trailer,
    projectName,
    defaultOut: util.defaultOutName(projectName),
  };
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
  } catch (e) {
    /* 忽略 */
  }
}

function createServer(options = {}) {
  const PORT = String(options.port || process.env.PORT || "3800");
  const MATERIAL_ROOT = (
    options.materialRoot ||
    process.env.RESOLVE_MATERIAL_ROOT ||
    "E:\\素材"
  ).replace(/[\\/]+$/, "");
  const TEMPLATE_DRT =
    options.templateDrt || process.env.RESOLVE_TEMPLATE_DRT || "E:\\素材\\时间线\\Timeline 1.drt";
  const RESOLVE_EXE =
    options.resolveExe ||
    process.env.RESOLVE_EXE ||
    "D:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\Resolve.exe";

  const state = { run: null, python: undefined };

  function probePython(cmd, args) {
    try {
      const r = spawnSync(cmd, [...args, "--version"], {
        timeout: 5000,
        encoding: "utf8",
        windowsHide: true,
      });
      const out = String((r.stdout || "") + (r.stderr || ""));
      return r.status === 0 && /python\s*3/i.test(out);
    } catch (e) {
      return false;
    }
  }

  /** 解析可用的 Python：RESOLVE_PYTHON > python > py -3（结果缓存） */
  function pythonCmd() {
    if (state.python !== undefined) return state.python;
    const envCmd = String(options.python || process.env.RESOLVE_PYTHON || "").trim();
    const candidates = [];
    if (envCmd) candidates.push({ cmd: envCmd, args: [] });
    candidates.push({ cmd: "python", args: [] }, { cmd: "py", args: ["-3"] });
    for (const c of candidates) {
      if (probePython(c.cmd, c.args)) {
        state.python = c;
        return c;
      }
    }
    state.python = null;
    return null;
  }

  function preflight() {
    const py = pythonCmd();
    return {
      python: { ok: !!py, cmd: py ? [py.cmd, ...py.args].join(" ") : "" },
      template: { ok: fs.existsSync(TEMPLATE_DRT), path: TEMPLATE_DRT },
      resolveExe: { ok: fs.existsSync(RESOLVE_EXE), path: RESOLVE_EXE },
      materialRoot: MATERIAL_ROOT,
      busy: !!state.run,
    };
  }

  function runPython(cmd, args, req, res, kind) {
    if (state.run) {
      sendJson(res, 409, { error: "已有任务在执行（" + state.run.kind + "），请等待完成或先停止" });
      return;
    }
    const py = pythonCmd();
    if (!py) {
      sendJson(res, 400, {
        error: "未找到可用的 Python 3（可设置环境变量 RESOLVE_PYTHON 指定路径）",
      });
      return;
    }
    if (!fs.existsSync(PY)) {
      sendJson(res, 400, {
        error: "缺少自动化脚本：scripts/resolve-auto/resolve.py（请重新运行安装包修复）",
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "Transfer-Encoding": "chunked",
    });
    const child = spawn(py.cmd, [PY, cmd, ...args], {
      shell: false, // 铁律：数组传参，绝不用 shell 字符串拼接
      env: Object.assign({}, process.env, { PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" }),
      windowsHide: true,
    });
    state.run = { kind, child, startedAt: Date.now() };
    let finished = false;

    const push = (b) => {
      try {
        if (!res.writableEnded) res.write(b.toString("utf8"));
      } catch (e) {
        /* 客户端已断开 */
      }
    };
    const finish = (code, errMsg) => {
      if (finished) return;
      finished = true;
      if (errMsg) push("\n[错误] " + errMsg + "\n");
      push("\n" + util.EXIT_MARKER + "=" + (Number.isFinite(code) ? code : 1) + "\n");
      try {
        if (!res.writableEnded) res.end();
      } catch (e) {
        /* 忽略 */
      }
      if (state.run && state.run.child === child) state.run = null;
    };

    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("error", (e) => finish(127, "无法启动 Python（" + py.cmd + "）：" + e.message));
    child.on("close", (code) => finish(code == null ? 1 : code));
    // 客户端断开（关标签/关页面）→ 杀掉整棵子进程树，别让渲染在后台偷偷跑
    res.on("close", () => {
      if (!finished) killTree(child);
    });
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost:" + PORT);
    const p = u.pathname;

    // 同源校验：带 Origin 的请求只允许本机回环（webview/curl 无 Origin 放行）
    const origin = req.headers.origin;
    if (origin && !util.isAllowedOrigin(origin)) {
      sendJson(res, 403, { error: "forbidden: cross-origin request blocked" });
      return;
    }

    try {
      if (req.method === "GET" && p === "/") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(fs.readFileSync(path.join(PUBLIC, "index.html")));
      } else if (req.method === "GET" && p === "/api/version") {
        sendJson(res, 200, {
          version: require("./package.json").version,
          source: "resolve-hub",
          updatable: false,
          bootToken: process.env.BOOT_TOKEN || null,
        });
      } else if (req.method === "GET" && p === "/api/preflight") {
        sendJson(res, 200, preflight());
      } else if (req.method === "GET" && p === "/api/status") {
        sendJson(res, 200, {
          busy: !!state.run,
          kind: state.run ? state.run.kind : null,
          startedAt: state.run ? state.run.startedAt : null,
          elapsedSec: state.run ? Math.round((Date.now() - state.run.startedAt) / 1000) : 0,
        });
      } else if (req.method === "GET" && p === "/app.js") {
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(fs.readFileSync(path.join(PUBLIC, "app.js")));
      } else if (req.method === "GET" && /^\/[A-Za-z0-9._-]+$/.test(p)) {
        const file = path.join(PUBLIC, p.replace(/^\/+/, ""));
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          const ext = path.extname(file).toLowerCase();
          const mime =
            {
              ".css": "text/css; charset=utf-8",
              ".js": "application/javascript; charset=utf-8",
              ".json": "application/json; charset=utf-8",
              ".woff2": "font/woff2",
              ".txt": "text/plain; charset=utf-8",
              ".png": "image/png",
              ".jpg": "image/jpeg",
              ".svg": "image/svg+xml",
            }[ext] || "application/octet-stream";
          res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
          res.end(fs.readFileSync(file));
        } else {
          sendJson(res, 404, { error: "not found" });
        }
      } else if (req.method === "GET" && p === "/api/folder-info") {
        const dir = u.searchParams.get("dir") || "";
        sendJson(res, 200, Object.assign({ dir }, folderInfo(dir)));
      } else if (req.method === "POST" && p === "/api/start") {
        const body = await readBody(req);
        const dir = String(body.dir || "").trim();
        if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
          sendJson(res, 400, { error: "素材目录不存在或不是文件夹" });
          return;
        }
        if (!fs.existsSync(TEMPLATE_DRT)) {
          sendJson(res, 400, {
            error: "时间线模板缺失：" + TEMPLATE_DRT + "（请检查素材/时间线目录）",
          });
          return;
        }
        // 项目名用前端展示的（已消毒）名字，保证 setup 建的项目名与 render 用的完全一致
        const project = util.sanitizeProjectName(body.project || path.basename(dir));
        const startArgs = ["--dir", dir];
        if (project) startArgs.push("--project", project);
        runPython("setup", startArgs, req, res, "setup");
      } else if (req.method === "POST" && p === "/api/render") {
        const body = await readBody(req);
        const project = util.sanitizeProjectName(body.project);
        if (!project) {
          sendJson(res, 400, { error: "缺少项目名" });
          return;
        }
        const args = ["--project", project];
        const out = util.sanitizeOutName(body.out, project);
        args.push("--out", out);
        if (body.force) args.push("--force");
        if (body.target) {
          const target = String(body.target).trim();
          if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
            sendJson(res, 400, { error: "输出目录不存在：" + target });
            return;
          }
          args.push("--target", target);
          args.push("--dir", target);
        }
        runPython("render", args, req, res, "render");
      } else if (req.method === "POST" && p === "/api/cancel") {
        if (!state.run) {
          sendJson(res, 200, { ok: false, error: "当前没有正在执行的任务" });
          return;
        }
        killTree(state.run.child);
        sendJson(res, 200, { ok: true, cancelled: true });
      } else {
        sendJson(res, 404, { error: "not found" });
      }
    } catch (e) {
      try {
        sendJson(res, 500, { error: String((e && e.message) || e) });
      } catch (e2) {
        /* 忽略 */
      }
    }
  });

  return { server, state, config: { PORT, MATERIAL_ROOT, TEMPLATE_DRT, RESOLVE_EXE } };
}

module.exports = { createServer, folderInfo };

if (require.main === module) {
  const { server, config } = createServer();
  server.listen(parseInt(config.PORT, 10), "127.0.0.1", () =>
    console.log("resolve-hub listening on " + config.PORT),
  );
}
