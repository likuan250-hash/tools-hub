// ── 独立运行入口 ──
// node index.js        → 启动独立服务
// 如果被其他项目 require，则导出 router 供挂载

const express = require("express");
const path = require("path");
const router = require("./router");

// 被其他项目 require 时，直接导出 router
// 在 netdisk-hub 中：app.use("/kdocs", require("E:\\kdocs-tool"));
module.exports = router;

// 独立运行
if (require.main === module) {
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
}
