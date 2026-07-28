// ── 兼容入口（老版 server.js 指向新结构）──
// 保留此文件使启动工具.bat 仍能 node server.js 正常工作
// 实际逻辑已迁移到 index.js + lib/ + router.js

const router = require("./index");
const express = require("express");
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
