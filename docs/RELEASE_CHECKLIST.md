# 发布清单（Definition of Done）

每次打 tag 发版前，**逐项确认**。任一项不通过不得发版。目标：杜绝"我机器上是好的、装包就出问题"类回归。

## 1. 代码与自测
- [ ] 核心路径已手测通过（不是只编译过）。
- [ ] 改动涉及**构建/打包配置**（`package.json` 的 `build.files`、资源目录、`prepare-build.js`）：
  - [ ] 本地 `npm run build` 成功；
  - [ ] `npm run verify:build` 全绿（产物含 `shared/`、样式已内联、主题变量 `--bg-1` 与 `[data-theme="light"]` 存在、无残留 `@import`）。
- [ ] 改动涉及**子工具前端**（kdocs-tool / netdisk-hub）：装包后打开对应卡片页面，确认样式正常、不再发黑。
- [ ] 改动涉及**样式/主题**：装包实测确认入口页文字清晰可见，右上角 🌗 能切换明亮/暗色。

## 2. 质量门禁
- [ ] 提交前 `npx lint-staged` 已自动运行（pre-commit 钩子），ESLint **无 error**（warning 允许，但建议顺手修）。
- [ ] 若改了 `scripts/verify-build-assets.js` 的断言范围，确认仍能拦住一次故意构造的缺失产物（负向验证）。

## 3. 秘钥与敏感文件
- [ ] 无 `.masterkey`、`.env`、凭证文件进 git（已在 `.gitignore`）。
- [ ] 无明文 secret 写进代码或文档。

## 4. 发版动作
- [ ] 版本号已 bump（patch，如 `0.1.32` → `0.1.33`）。
- [ ] 已打 tag `vX.Y.Z` 并推送，CI 自动出安装包。
- [ ] 在**干净环境 / 另一台机器**装包实测一次，确认无"我机器上是好的"类问题。
- [ ] 工具内「🔄 检测更新」能收到新版本。

## 血泪教训（详见 docs/postmortem-packaging-black-screen.md）
> v0.1.29→0.1.31 连续三版"装包全黑、切不了主题"，根因是 `shared/` 没打进包、`@import` 装包后加载失败。
> 此问题 dev 模式完全正常，**只有装包才复现**——所以必须有"装包实测 + verify:build"两道防线，而不能只靠本地 `npm start`。
