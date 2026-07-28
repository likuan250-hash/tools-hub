// ── 独立运行入口 ──
// node index.js        → 启动独立服务
// 如果被其他项目 require，则导出 router 供挂载

const express = require("express");
const router = require("./router");

// 被其他项目 require 时，直接导出 router
// 在 netdisk-hub 中：app.use("/kdocs", require("E:\\kdocs-tool"));
module.exports = router;

// 独立运行
if (require.main === module) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
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
