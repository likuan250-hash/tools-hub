#!/usr/bin/env node
/**
 * verify-build-assets.js — 打包产物资产校验（发布质量门禁）
 *
 * 根因背景（2026-07-30）：renderer/style.css 用 @import "../shared/tokens.css" 引入
 * 全部颜色变量与亮/暗主题规则，但 package.json 的 build.files 漏打包 shared/，
 * 装包后 @import 加载失败 -> 整窗全黑、且点主题按钮设了 data-theme=light 也无规则生效
 * （切不了主题）。dev 模式因项目目录有 shared/ 正常，装包才黑，多台机器一致。
 *
 * 本脚本在构建后运行，断言产物(app.asar)里确实包含关键资产，避免同类回归流入发布。
 * 做法：用官方 @electron/asar CLI 把 asar 解包到临时目录，再用 fs 读文件做断言。
 * 失败时以非零退出码中断构建/CI。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = __dirname.replace(/[\\/]scripts$/, "");
const failures = [];
const ok = [];

function fail(msg) {
  failures.push(msg);
}
function pass(msg) {
  ok.push(msg);
}

/* 定位 @electron/asar CLI 入口（优先 require.resolve，回退固定路径） */
function findAsarBin() {
  try {
    return require.resolve("@electron/asar/bin/asar.js");
  } catch (_) {
    const p = path.join(ROOT, "node_modules", "@electron", "asar", "bin", "asar.js");
    if (fs.existsSync(p)) return p;
    const alt = path.join(ROOT, "node_modules", ".bin", "asar");
    if (fs.existsSync(alt)) return alt;
    throw new Error("找不到 @electron/asar，请先 npm install");
  }
}

/* ---------- 1) 源码级防护：build.files 必须包含 shared 目录 ---------- */
function checkPackageFiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const files = (pkg.build && pkg.build.files) || [];
  if (!files.some((f) => f === "shared/**/*" || f === "shared")) {
    fail(
      "package.json build.files 未包含 shared/**/* —— 子工具 /tokens.css 路由与 @import 源将缺失",
    );
  } else {
    pass("build.files 含 shared/**/*");
  }
}

/* ---------- 2) 产物级校验：解包 app.asar 后读文件 ---------- */
function checkAsar(asarPath) {
  if (!fs.existsSync(asarPath)) {
    fail(`未找到构建产物: ${asarPath}（请先执行 build/dist）`);
    return;
  }
  const asarBin = findAsarBin();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "toolshub-verify-"));
  try {
    execFileSync(process.execPath, [asarBin, "extract", asarPath, tmp], {
      stdio: "pipe",
    });
  } catch (e) {
    fail(`解包 asar 失败: ${(e.stderr || e.message || "").toString().split("\n")[0]}`);
    return;
  }

  const must = [
    ["shared/tokens.css", "shared 样式源（子工具 /tokens.css 路由依赖）"],
    ["renderer/style.inline.css", "内联后的入口样式"],
    ["renderer/index.inline.html", "实际加载的入口页"],
  ];
  for (const [rel, desc] of must) {
    const p = path.join(tmp, rel);
    if (fs.existsSync(p)) pass(`产物含 ${rel}（${desc}）`);
    else fail(`产物缺失 ${rel}（${desc}）`);
  }

  const cssPath = path.join(tmp, "renderer", "style.inline.css");
  if (fs.existsSync(cssPath)) {
    const css = fs.readFileSync(cssPath, "utf8");
    if (css.includes("--bg-1")) pass("style.inline.css 含主题变量 --bg-1");
    else fail("style.inline.css 未内联主题变量 --bg-1（@import 可能未展开）");

    if (css.includes('data-theme="light"'))
      pass('style.inline.css 含亮色主题规则 [data-theme="light"]');
    else fail('style.inline.css 缺失亮色主题规则 [data-theme="light"]（切不了主题）');

    // 仅匹配真实 @import at-rule（@import url(...) 或 @import "..."），忽略注释里的字眼
    if (/@import\s*(url\(|["'])/.test(css))
      fail("style.inline.css 仍含 @import（运行时依赖跨目录加载，脆弱）");
    else pass("style.inline.css 无 @import（已构建期内联，运行时零依赖）");
  }

  const htmlPath = path.join(tmp, "renderer", "index.inline.html");
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, "utf8");
    if (html.includes("style.inline.css")) pass("index.inline.html 引用 style.inline.css");
    else fail("index.inline.html 未引用 style.inline.css（仍可能加载旧 style.css）");
  }
}

/* ---------- 入口 ---------- */
function main() {
  checkPackageFiles();

  const asarPath = process.env.ASAR_PATH
    ? path.resolve(process.env.ASAR_PATH)
    : path.join(ROOT, "dist", "win-unpacked", "resources", "app.asar");
  checkAsar(asarPath);

  console.log("\n=== 打包产物校验 ===");
  ok.forEach((m) => console.log("  ✓ " + m));
  if (failures.length) {
    console.log("\n✗ 校验失败：");
    failures.forEach((m) => console.log("  ✗ " + m));
    console.log(
      "\n构建被拦截。请确认 scripts/prepare-build.js 已生成 renderer/style.inline.css，" +
        "且 package.json build.files 含 shared/**/*。\n",
    );
    process.exit(1);
  }
  console.log(`\n✓ 全部通过（${ok.length} 项），产物可发布。\n`);
}

main();
