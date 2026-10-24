// 前端关键行为回归（静态断言，防止自检修复被改回去）
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const PUBLIC = path.join(__dirname, "..", "public");
const app = fs.readFileSync(path.join(PUBLIC, "app.js"), "utf8");
const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");

test("成败按退出码判定，不再用「失败」关键字判整轮", () => {
  assert.match(app, /EXIT_MARKER/);
  assert.match(app, /exitCode === 0/);
  assert.ok(!/\[错误\]\|Traceback\|失败/.test(app), "不应再保留旧的关键字判定");
});

test("渲染失败后恢复 setup_done，导出按钮可重试", () => {
  assert.match(
    app,
    /state\.phase = "setup_done";[\s\S]{0,200}doneEl\.textContent = cancelRequested/,
  );
  assert.match(app, /finishBtn\.disabled = running \|\| state\.phase !== "setup_done"/);
});

test("状态持久化 + 切目录重置 + 输出名消毒 + 取消 + 打开输出目录", () => {
  assert.match(app, /localStorage\.(getItem|setItem)\(STATE_KEY/);
  assert.match(app, /resetRunState\(\)/);
  assert.match(app, /sanitizeOutName\(outInput\.value, current\.name\)/);
  assert.match(app, /\/api\/cancel/);
  assert.match(app, /revealInFolder/);
});

test("进入页面只恢复 idle/setup_done，done 状态自动清空", () => {
  assert.match(app, /phase === "idle" \|\| phase === "setup_done"/);
  assert.match(app, /clearSavedState\(\);[\s\S]{0,250}resetRunState\(\)/);
  assert.doesNotMatch(app, /savedPhase !== "done"/);
});

test("页面包含停止按钮、输出路径与打开文件夹按钮，且不再保留无用 select 样式", () => {
  assert.match(html, /id="cancelBtn"/);
  assert.match(html, /id="outPathRow"/);
  assert.match(html, /id="openFolderBtn"/);
  assert.ok(!/^\s*select\s*\{/m.test(html), "select 样式应已移除");
});

test("渲染前自检有问题必须停下来问：exitCode 3 + 返回修改/仍然渲染", () => {
  assert.match(app, /__SELFCHECK__/);
  assert.match(app, /exitCode === 3/);
  assert.match(app, /force: !!force/);
  assert.match(html, /id="selfcheckMask"/);
  assert.match(html, /id="scBack"/);
  assert.match(html, /id="scContinue"/);
});

test("VERSION 与 package.json 版本一致", () => {
  const pkg = require("../package.json");
  const ver = fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8").trim();
  assert.strictEqual(ver, pkg.version);
});
