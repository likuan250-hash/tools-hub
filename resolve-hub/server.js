// resolve-hub —— 达芬奇剪辑工具（包装 scripts/resolve-auto/resolve.py）
// 流程：选素材目录 → 开始做视频(setup 0-4) → 用户手动 5-7 → 确认好了(render 8-9)
// 零 npm 依赖；日志以 chunked 文本流实时回传前端。
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = process.env.PORT || "3800";
const PUBLIC = path.join(__dirname, "public");
const PY = path.join(__dirname, "..", "scripts", "resolve-auto", "resolve.py");
const PYTHON = process.env.RESOLVE_PYTHON || "python";
const MATERIAL_ROOT = (process.env.RESOLVE_MATERIAL_ROOT || "E:\\素材").replace(/[\\/]+$/, "");

const VIDEO_EXTS = [".mp4", ".mkv", ".webm", ".mov"];
const COVER_EXTS = [".jpg", ".jpeg", ".png", ".webp"];

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch (e) { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

function folderInfo(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (e) { return { ok: false, error: "目录不可读" }; }
  const cover = entries.find((n) => n.startsWith("封面") && COVER_EXTS.some((e) => n.toLowerCase().endsWith(e))) || null;
  const trailer = entries.find((n) => {
    const lower = n.toLowerCase();
    if (!VIDEO_EXTS.some((e) => lower.endsWith(e))) return false;
    if (n.startsWith(".")) return false;
    if (/\.f\d+(\.\w+)?$/i.test(n)) return false;
    return true;
  }) || null;
  return { ok: true, cover, trailer, coverOk: !!cover, trailerOk: !!trailer };
}

function runPython(cmd, args, res) {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Transfer-Encoding": "chunked" });
  const child = spawn(PYTHON, [PY, cmd, ...args], {
    shell: false, // 铁律：数组传参，绝不用 shell 字符串拼接
    env: Object.assign({}, process.env, { PYTHONUTF8: "1" }),
  });
  const push = (b) => { try { res.write(b.toString("utf8")); } catch (e) {} };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("error", (e) => { push(Buffer.from("[错误] 无法启动 Python：" + e.message + "\n")); res.end(); });
  child.on("close", () => res.end());
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost:" + PORT);
  const p = u.pathname;
  try {
    if (req.method === "GET" && p === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(path.join(PUBLIC, "index.html")));
    } else if (req.method === "GET" && p === "/api/version") {
      // 主进程统一探活基线：所有子服务都必须实现 /api/version（200 + bootToken 回显）
      sendJson(res, 200, {
        version: require("./package.json").version,
        source: "resolve-hub",
        updatable: false,
        bootToken: process.env.BOOT_TOKEN || null,
      });
    } else if (req.method === "GET" && p === "/app.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(fs.readFileSync(path.join(PUBLIC, "app.js")));
    } else if (req.method === "GET" && p === "/api/folders") {
      let dirs = [];
      try { dirs = fs.readdirSync(MATERIAL_ROOT, { withFileTypes: true }); } catch (e) { /* ignore */ }
      const list = dirs.filter((d) => d.isDirectory() && /^【游戏\d+】/.test(d.name))
        .map((d) => ({ name: d.name, path: path.join(MATERIAL_ROOT, d.name) }))
        .sort((a, b) => parseInt((a.name.match(/\d+/) || [0])[0], 10) - parseInt((b.name.match(/\d+/) || [0])[0], 10));
      sendJson(res, 200, { root: MATERIAL_ROOT, folders: list });
    } else if (req.method === "GET" && p === "/api/folder-info") {
      const dir = u.searchParams.get("dir") || "";
      sendJson(res, 200, Object.assign({ dir }, folderInfo(dir)));
    } else if (req.method === "POST" && p === "/api/start") {
      const body = await readBody(req);
      const dir = String(body.dir || "").trim();
      if (!dir || !fs.existsSync(dir)) { sendJson(res, 400, { error: "素材目录不存在" }); return; }
      runPython("setup", ["--dir", dir], res);
    } else if (req.method === "POST" && p === "/api/render") {
      const body = await readBody(req);
      const project = String(body.project || "").trim();
      if (!project) { sendJson(res, 400, { error: "缺少项目名" }); return; }
      const args = ["--project", project];
      if (body.out) args.push("--out", String(body.out));
      if (body.target) args.push("--target", String(body.target));
      runPython("render", args, res);
    } else {
      sendJson(res, 404, { error: "not found" });
    }
  } catch (e) {
    try { sendJson(res, 500, { error: String((e && e.message) || e) }); } catch (e2) { /* ignore */ }
  }
});

server.listen(parseInt(PORT, 10), "127.0.0.1", () => console.log("resolve-hub listening on " + PORT));
