// ── 兼容入口（老版 server.js 指向新结构）──
// 保留此文件使启动工具.bat 仍能 node server.js 正常工作
// 实际逻辑已迁移到 index.js + lib/ + router.js

const router = require("./index");
const express = require("express");
const path = require("path");
const app = express();
app.use(express.json({ limit: "1mb" }));
// 共享样式：从仓库 shared/ 提供 tokens.css 与 macos-motion.css（三套前端共用单一真源）
app.get(['/tokens.css', '/macos-motion.css'], (req, res) => {
  const file = path.join(__dirname, '..', 'shared', req.path.slice(1));
  res.type('css').sendFile(file, (err) => { if (err) res.status(404).end(); });
});
app.use("/", router);

  const PORT = process.env.KDOCS_PORT || 3599;
  const server = app.listen(PORT, "127.0.0.1", async () => {
    const { checkKdocsReady } = require("./lib/kdocs");
    const { checkBlAvailable } = require("./lib/ai");
    console.log("✅ 多维表智能录入工具已启动");
    console.log("   http://localhost:" + PORT);
    console.log("   kdocs: " + ((await checkKdocsReady()) ? "✅ 已配置" : "⚠️ 未配置"));
    console.log("   AI:    " + ((await checkBlAvailable()) ? "✅ 可用" : "⚠️ 不可用"));
  });
