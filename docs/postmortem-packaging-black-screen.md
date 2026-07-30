# 复盘：装包全黑 + 无法切换主题（2026-07-30）

> 级别：高（连续 3 个版本流向用户，且多台机器一致）
> 状态：已修复并加门禁（v0.1.32 + `scripts/verify-build-assets.js`）

## 一、现象
用户安装 `v0.1.29`→`v0.1.31` 后反馈：
- 入口页**几乎全黑，文字看不清**；
- 点右上角 🌗 **切不到明亮主题**，界面纹丝不动；
- 开发机 `npm start` 一切正常，只有"装包安装后"才复现；多台电脑一致。

## 二、根因
1. `renderer/style.css` 用 `@import "../shared/tokens.css"` 引入**全部颜色变量 + 亮/暗两套主题规则**。
2. `package.json` 的 `build.files` 当时只打包了 `renderer/**/*`，**漏了 `shared/**/*`**。
3. 安装包 asar 内没有 `shared/` 目录 → 那条 `@import` 在运行时不加载 → `tokens.css` 整份未生效。
4. 连锁后果：
   - 所有 `var(--bg-1)`、`var(--text)` 失效 → 界面回退到窗口深黑底（`#0f1115`）+ 浏览器默认**黑字** → 全黑看不清；
   - 点 🌗 设了 `data-theme="light"`，但 `[data-theme="light"]` 这条规则**正好在未加载的 tokens 里** → 设了也白设，切不了主题。

## 三、为什么"我机器上是好的"
`npm start` 是开发模式，项目目录本来就存在 `shared/`，`@import` 能找到文件，所以显示正常。
**装包后**目录结构变成 asar，且 `shared/` 没被打进去 → `@import` 失败。
这是典型的 **dev/prod 环境不一致**：本地能跑 ≠ 装包能跑。

## 四、修复（双保险，已落地 v0.1.32）
1. `build.files` 增加 `shared/**/*` —— 子工具 `/tokens.css` 路由也能读到，子工具页面一并修好。
2. `scripts/prepare-build.js` 在构建期把 `tokens.css` + `macos-motion.css` **内联进 `renderer/style.inline.css`**，`main.js` 改用 `index.inline.html` —— renderer 运行时**彻底不依赖 `@import`**（asar 内跨目录 `@import` 最脆弱的环节被消除）。
3. 新增 `scripts/verify-build-assets.js`：构建后断言产物含 `shared/tokens.css`、`style.inline.css`（已内联、含 `--bg-1` 与 `[data-theme="light"]`、无残留 `@import`）；接入 `build`/`dist` 脚本与 CI，失败即拦截。

## 五、团队可复用的教训
1. **装包实测是发布硬门槛**。任何涉及 UI/构建的改动，不能只靠 `npm start` 验证，必须装包跑一遍。写进了 `docs/RELEASE_CHECKLIST.md`。
2. **跨目录 `@import` 在打包环境很脆弱**，优先在构建期内联，或改为打包期可解析的引用。
3. **自动化门禁优于人肉**。这类"装包才暴露"的问题，靠评审肉眼几乎发现不了，必须用 `verify:build` 在构建期拦。
4. **把坑沉淀成文档和断言**，而不是只存在某个人脑子里。本复盘 + `verify-build-assets.js` 就是例子。

## 六、给评审者的提醒
见 `docs/CODE_REVIEW_CHECKLIST.md` 第 1 条：新增静态资源目录必须进 `build.files`；新增资源引用必须确认装包后仍可达。

---
### 附：构建链路评审发现（C 动手带练）
评审对象：`prepare-build.js`、`main.js`（loadFile）、`package.json` 的 `build.files`。

- ✅ `prepare-build.js` 内联逻辑正确，产物已验证含主题变量与亮色规则、无 `@import`。
- ✅ `main.js` 已加载 `index.inline.html`（引用 `style.inline.css`），方向正确。
- ⚠️ 建议（非阻塞）：`prepare-build.js` 若将来 `shared/tokens.css` 路径变动或读取失败，目前是静默生成空内联文件，靠 `verify:build` 兜底。可考虑在 prepare 阶段对"读取到的 token 内容为空"显式 `throw`，让失败更早、信息更清晰。
- ⚠️ 建议（非阻塞）：CI 的 `build.yml` 已有 `kdocs-tool` 的 `npm test` 门禁；本次新增的 `verify:build` 已通过 `npm run dist` 自动触发，无需额外步骤，但建议在发版前本地也跑一次 `npm run verify:build` 作为双保险。
