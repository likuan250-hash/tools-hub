// integration.test.js — 真实外部依赖端到端验证（默认全部 skip，不污染数据）
// 运行方式：
//   RUN_INTEGRATION=1 node --test test/integration.test.js
//   RUN_KDOCS_WRITE=1 node --test test/integration.test.js   # 仅真实 kdocs 只读连通
// 默认不跑：bl / Steam CDN / 金山文档 都是外部依赖，放进 CI 会不稳定或污染真实多维表。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const RUN_INTEGRATION = !!process.env.RUN_INTEGRATION;
const RUN_KDOCS = !!process.env.RUN_KDOCS_WRITE;

test("集成[真实bl]：介绍不编造、大小非空、封面为合法URL", { skip: !RUN_INTEGRATION }, async () => {
  const { aiDescribe } = require("../lib/ai");
  const r = await aiDescribe("双影奇境", "双影奇境（Split Fiction）", { englishName: "Split Fiction" });
  assert.ok(r.intro && r.intro.length >= 10, "介绍应非空");
  assert.ok(!/疑似虚构|无法确认|经核实无真实|请勿轻信|非官方渠道/.test(r.intro), "介绍不应含免责声明（符合需求）");
  assert.ok(r.size && !/^(无|未知|未抓取到)?$/i.test(r.size.trim()), "大小应非空（符合需求）");
  assert.ok(/^https?:\/\/.+\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(r.coverUrl), "封面应为合法图片URL（符合需求）");
});

test("集成[真实Steam]：cloudflare 源能下载到封面文件", { skip: !RUN_INTEGRATION }, async () => {
  const { downloadCover } = require("../lib/steam");
  const fp = await downloadCover("Counter-Strike 2", "730", os.tmpdir());
  assert.ok(fs.existsSync(fp), "封面文件应存在");
  assert.ok(fs.statSync(fp).size > 0, "封面文件应非空");
});

test("集成[真实kdocs只读]：连通且能列出记录（不写入，避免污染）", { skip: !RUN_KDOCS }, async () => {
  const kdocs = require("../lib/kdocs");
  assert.strictEqual(await kdocs.checkKdocsReady(), true, "kdocs 应已配置就绪");
  const r = await kdocs.callMcporter("dbsheet.list_records", { sheet_id: 1 });
  assert.ok(r, "应能列出已有记录（只读操作）");
});
