// ── Express 路由（可被 netdisk-hub 等项目挂载）──
// 用法（在 netdisk-hub/server.js 中）：
//   const kdocsRouter = require("E:\\kdocs-tool\\router");
//   app.use("/kdocs", kdocsRouter);
// 然后前端请求 http://localhost:3000/kdocs/api/auto 等

const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const os = require("os");

const { parseInput } = require("./lib/parser");
const { searchSteamAppId } = require("./lib/steam");
const { checkBlAvailable, aiDescribe } = require("./lib/ai");
const { checkKdocsReady } = require("./lib/kdocs");
const { autoExecute, findExistingRecord } = require("./lib/executor");

// 提供静态文件（当独立运行时也保持兼容）
router.use(express.static(path.join(__dirname, "public")));

router.get("/api/check", async (req, res) => {
  res.json({ kdocsReady: await checkKdocsReady(), blAvailable: await checkBlAvailable() });
});

// 健康检查端点：控制面板(is_ready)仅靠 HTTP 200 判断服务存活
router.get("/api/ready", (req, res) => {
  res.json({ ok: true, ts: Date.now(), port: 3599, bind: "127.0.0.1" });
});

// ── 版本（只读；更新由工具箱 tools-hub 统一管理，不再自更新）──
function getVersion() {
  try { return require("./package.json").version; } catch (e) { return "?"; }
}

router.get("/api/version", (req, res) => {
  const hubVer = process.env.TOOLSHUB_VERSION;
  const version = hubVer || getVersion();
  const source = hubVer ? "tools-hub" : "standalone";
  res.json({ version, source, updatable: false });
});

router.post("/api/parse", (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "请输入游戏信息" });
  const parsed = parseInput(text);
  if (!parsed) return res.status(400).json({ error: "无法解析输入" });
  res.json(parsed);
});

router.get("/api/search-steam", async (req, res) => {
  const { q } = req.query;
  res.json({ appid: q ? await searchSteamAppId(q) : null });
});

// ── 封面目录选择：由 Tkinter 控制面板弹原生文件夹选择器 ──
// 根因：Node 服务端进程（被 CREATE_NO_WINDOW 拉起、无可见窗口）直接 spawn 的 GUI 对话框会被
// Windows 窗口站/桌面隔离，导致对话框不显示（1.0.19/1.0.21 均因此失败）；而 powershell 可见控制台
// 能弹（1.0.20）但带黑框+中文乱码。正确做法：对话框必须由运行在交互式桌面、自身有窗口的进程弹出——
// 即本项目的 Tkinter 控制面板。Node 仅通过 data/browse_req.json / browse_res.json 与面板做中转。
router.post("/api/browse-dir", async (req, res) => {
  const initial = (req.body && req.body.initial) || "";
  const dataDir = process.env.KDOCS_DATA_DIR
    ? path.resolve(process.env.KDOCS_DATA_DIR)
    : path.join(__dirname, "data");
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
  const reqPath = path.join(dataDir, "browse_req.json");
  const resPath = path.join(dataDir, "browse_res.json");
  try { if (fs.existsSync(resPath)) fs.unlinkSync(resPath); } catch {}

  try {
    fs.writeFileSync(reqPath, JSON.stringify({ initial }), "utf8");
  } catch (e) {
    return res.status(500).json({ error: "无法写入文件夹选择请求：" + e.message });
  }

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (fs.existsSync(resPath)) {
      try {
        const out = JSON.parse(fs.readFileSync(resPath, "utf8"));
        try { fs.unlinkSync(resPath); } catch {}
        try { if (fs.existsSync(reqPath)) fs.unlinkSync(reqPath); } catch {}
        if (out.error) return res.status(500).json({ error: "文件夹选择器异常：" + out.error });
        const dir = (out.dir || "").trim();
        if (dir) return res.json({ dir });
        return res.json({ dir: "", cancelled: true }); // 用户取消
      } catch (e) {
        try { fs.unlinkSync(resPath); } catch {}
        return res.status(500).json({ error: "读取选择结果失败：" + e.message });
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  try { if (fs.existsSync(reqPath)) fs.unlinkSync(reqPath); } catch {}
  return res.status(500).json({ error: "文件夹选择器超时：请确认「控制面板程序本身」已关闭并重新打开（仅重启后端服务不会加载新面板代码），且未选择「仅关闭面板(服务后台继续)」。" });
});

router.post("/api/check-exists", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "请输入游戏信息" });
  const parsed = parseInput(text);
  if (!parsed) return res.status(400).json({ error: "无法解析输入" });
  try {
    const r = await findExistingRecord(parsed);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message, exists: false, recordId: null, existingLinks: null });
  }
});

router.post("/api/auto", async (req, res) => {
  const { text, coverDir, manualCoverUrl, forceAdd, updateLinks } = req.body;
  if (!text) return res.status(400).json({ error: "请输入游戏信息" });
  const parsed = parseInput(text);
  if (!parsed) return res.status(400).json({ error: "无法解析输入" });

  // SSE 流式进度：逐条推送 step / done / error 事件，让前端实时看到执行到哪一步
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (obj) => {
    try {
      res.write("data: " + JSON.stringify(obj) + "\n\n");
      if (typeof res.flush === "function") res.flush();
    } catch { /* 客户端已断开 */ }
  };
  // 每 3 秒发一次 SSE 心跳注释，让代理/浏览器保持连接
  const heartbeat = setInterval(() => { try { res.write(": hb\n\n"); if (typeof res.flush === "function") res.flush(); } catch { /* ignore */ } }, 3000);

  try {
    await autoExecute(parsed, null, coverDir, {
      manualCoverUrl,
      forceAdd: !!forceAdd,
      updateLinks: !!updateLinks,
      onStep: (ev) => send(ev),
    });
  } catch (e) {
    send({ type: "error", error: e.message });
  } finally {
    clearInterval(heartbeat);
    try { res.end(); } catch { /* 已结束 */ }
  }
});

module.exports = router;
