# tools-hub 交接说明（接管指南）

> 给另一台电脑 / 另一个 agent 的接管说明。自包含，无需读本项目其他记忆即可接手。

## 0. 一句话目标
把 `tools-hub`（Electron 桌面壳 + 网盘转存 / 金山文档录入两个子工具）的「子工具页面」视觉对齐到「入口页面（renderer）」那套玻璃风格，且在**亮色主题下真实可用**。当前亮色下输入框/按钮文字与背景重合，用户判定不可用。v0.1.36 已提交但没解决，需要继续。

## 1. 项目身份与路径
- 仓库：`likuan250-hash/tools-hub`（GitHub）
- 本机工作目录：`E:\work\tools-hub`（**纯英文路径**，规避中文路径在沙箱 Git 下 "not a git repository" 的坑）
- 另一台电脑接管：请 `git clone` 到**纯英文路径**（如 `D:\work\tools-hub`），不要放中文目录。
- 当前版本：`v0.1.36`（commit `5850bdf`，已打 tag `v0.1.36` 并 push，CI 正在/已构建发布）。

## 2. 技术栈与架构
- Electron + electron-builder（NSIS 安装包）。主进程 `main.js` fork 两个 Express 子进程（kdocs-tool :3599 / netdisk-hub :3000），用 `webview` 嵌在单窗口多 Tab 里。
- 子工具经 `extraResources` 独立部署（**不在 app.asar 内**），运行时由 Express 子服务通过 HTTP 提供页面与 `/tokens.css`、`/macos-motion.css`、`/macos.css`。
- 版本唯一真源在壳：`main.js` 注入 `TOOLSHUB_VERSION`，子工具 `/api/version` 只读返回 `{version, source:"tools-hub", updatable:false}`。
- 主题联动：壳 `wv.send('sync-theme', t)` → `webview-preload.js` 接收并 `applyTheme`（设子工具页 `data-theme` + 存 `localStorage['theme']` + 隐藏子工具自身 `themeBtn`）。**壳是唯一主题控制源**。独立运行（不走壳）时 preload 不加载，子工具自身 themeBtn 仍可独立切。

## 3. 样式单一真源与构建机制（改色只动这里）
- **唯一真源**：`shared/tokens.css`，定义暗 `:root` + 亮 `[data-theme="light"]` 两套变量（见下）。三套前端共用。
  ```css
  :root { /* 暗 */
    --bg-1:#0f1226; --bg-2:#222a52; --bg-3:#2b1a4a;
    --text:#eef1ff; --text-dim:#c8cff0;
    --glass-bg:rgba(255,255,255,0.22); --glass-border:rgba(255,255,255,0.30);
    --accent:#7c5cff; --accent-2:#21d4fd; --accent-3:#c4b5ff;
    --shadow-card:0 10px 34px rgba(0,0,0,0.35);
  }
  [data-theme="light"] {
    --bg-1:#eaf0ff; --bg-2:#f6f8ff; --bg-3:#efe6ff;
    --text:#1b1f3b; --text-dim:#5b6189;
    --glass-bg:rgba(255,255,255,0.55); --glass-border:rgba(120,120,180,0.18);
    --accent:#7c5cff; --accent-2:#21d4fd; --accent-3:#5b3df0;
    --shadow-card:0 8px 24px rgba(20,30,80,0.1);
  }
  ```
- `shared/macos-motion.css`：弹簧缓动 / 液态玻璃光标高光 / 状态呼吸等动效，三套共用。
- 构建：`scripts/prepare-build.js` 把 `shared/tokens.css` + `shared/macos-motion.css` **内联**进 `renderer/style.inline.css`（renderer 用 `@import`）；**子工具不内联**，运行时经 HTTP `<link href="/tokens.css">` 引用。
- 质量门禁：`scripts/verify-build-assets.js`（已接入 build/dist 与 CI），断言产物含 `shared/tokens.css`、`renderer/style.inline.css`（内联且含 `--bg-1`/`[data-theme="light"]`、无残留 `@import`）、`index.inline.html` 引用之。**改动涉及 shared/ 或 renderer 样式后必须本地 `npm run verify:build` 全绿**（CI 也会拦）。
- ⚠️ **致命构建坑（已发生过）**：`package.json` 的 `build.files` 曾漏打包 `shared/**/*` → asar 内 `@import` 失败 → token 全失效 → 界面全黑。任何改动涉及 shared/ 或 renderer 样式，**必须重 build 才生效；发版前务必本地 `npm run build` 并解包 asar 确认 `style.inline.css` 含 `--bg-1`/`[data-theme="light"]`**。

## 4. 当前进度 / 状态
- v0.1.36（commit `5850bdf`）已做：子工具页引入 `--field-bg`/`--solid-bg` 实色变量（暗=`var(--bg-2)`，亮=`#ffffff`/`#f1f4ff`），把输入框/数据区背景从 `var(--glass-bg)` 改为 `var(--field-bg)`（实色），外层玻璃卡片补 `inset 0 1px 0 rgba(255,255,255,0.10)` 高光边，删除亮色透明白覆盖。
- **确认：v0.1.36 的代码改动确实进了仓库且当前文件里就能看到**（kdocs-tool/public/index.html 第 94-95、98、111、133、157 行；netdisk-hub 同理）。所以**不是"代码没生效"**。
- **问题：用户视觉上仍认为"啥也没改变"、亮色下不可用。** 根因见第 6 节——改动把"亮色半透明白"换成了"亮色实色白"，但页面本身就是近白色环境，等于白上白，没解决可读性。

## 5. 未决问题（核心任务）：子工具页对齐入口页玻璃风格 + 亮色可用
### 5.1 入口页玻璃语言（对齐目标，renderer/style.css .card 162-206）
```css
.card {
  background: var(--glass-bg);                       /* 暗 0.22 / 亮 0.55 透明玻璃 */
  border: 1px solid var(--glass-border);
  border-radius: 22px;
  backdrop-filter: blur(22px) saturate(160%);
  box-shadow: var(--shadow-card), inset 0 1px 0 rgba(255,255,255,0.10); /* 顶部 inset 高光=玻璃反光分离线 */
}
/* 内部元素全部实色：渐变 icon、实色标题(--text)、渐变按钮 —— 无 glass 套 glass */
```
入口页能好看的关键：卡片大、间距大、渐变强调色（紫/青）抢眼、文字是实色 `--text`（暗 `#eef1ff` / 亮 `#1b1f3b`）+ 标题带 `text-shadow`。

### 5.2 子工具页现状
- 外层容器（`.chip`/`.panel`/`.modal`/`.card`）已用 `var(--glass-bg)` + inset 高光边 + backdrop-filter，结构已对齐入口页。
- 内部控件（input/textarea/.log-area/.clear-corner/.btn.ghost）已改用 `var(--field-bg)` 实色。
- 但**亮色主题下**：`--bg-1:#eaf0ff`/`--bg-2:#f6f8ff`/`--bg-3:#efe6ff` 全是近白；`--glass-bg` 亮= `rgba(255,255,255,0.55)`；`--glass-border` 亮= `rgba(120,120,180,0.18)`（极淡）；inset 高光 `rgba(255,255,255,0.10)` 在白色上完全不可见。
- 结果：亮色下玻璃面板≈看不见、输入框=白底白环境、边框=几乎无 → 用户看到的就是"糊成一团/啥也没变"。

### 5.3 根因诊断（基于代码 + 权威资料，非猜测）
1. **亮色环境太"白"**：玻璃拟态的前提是"背景要有足够色彩/对比，玻璃的模糊折射才读得出来"。权威资料明确指出："纯白或纯灰背景下玻璃折射效果微乎其微""No glassmorphism works on a plain white background"。本项目亮色 `--bg-*` 全是近白淡彩，玻璃根本浮不出来。
2. **控件实色仍是白**：把 input 从 `var(--glass-bg)`(0.55 白) 改成 `--field-bg`(`#ffffff`) 只是把"半透明白"换成"实色白"，在近白页面上等于白上白，没改善。
3. **亮色边框太淡 + inset 高光在白底不可见**：唯一分离线（border 0.18 alpha、白色 inset 高光）在亮色下几乎消失。
4. **没做合成后对比度校验**：玻璃是半透明的，必须测"渲染后合成色"对比度，不能只看 hex。当前亮色下文字 `--text:#1b1f3b` 在白底上对比度其实够，但被"面板看不见 + 控件无边界"的整体观感掩盖。

### 5.4 权威玻璃/配色原则（网上查证，供对齐）
- NNGroup / Apple HIG：**一屏一个主玻璃层；玻璃内嵌套的按钮/控件用实色填充，禁止 glass 套 glass**；文字与图形须达 4.5:1（正文）/3:1（大文字、UI 组件）。
- Apple Liquid Glass 实践指引：**Frost 20-25、depth ≤ 15**；"Cards/modals: 单张 20-25 frost；Buttons: 玻璃上用实色填充"；提供 Reduce Transparency 的实色回退。
- Launchpad / neelnetworks 2026 趋势：**玻璃只用于少数关键元素（导航/模态/卡片），不整屏用**；背景必须是"受控的渐变/图像"而非纯色；blur 上限 16-20px；**必须有 `@supports(backdrop-filter)` 回退**。
- uxpilot：**半透明 overlay 放文字后面**保证一致可读性；浅色玻璃配深色文字、深色玻璃配浅色文字（相反色调放大清晰度）；可加 1px text-shadow 把文字从玻璃面抬起。
- 中文实战（ysdaima）："背景是纯白或纯灰，玻璃模糊折射微乎其微"；边框用 `rgba(255,255,255,0.3)` 勾边；亮色玻璃用深色文字（如 `#1D1D1F`）。

### 5.5 建议改动清单（可操作，按优先级）
**A. 让亮色玻璃"浮出来"（改 `shared/tokens.css` 亮色段 `[data-theme="light"]`）**
- 提高亮色环境背景的彩度/对比：把 `--bg-1/2/3` 从近白淡彩调成更有存在感的浅色（如带明显紫/蓝倾向的浅色，或加一层更饱和的 ambient 径向渐变），让玻璃后面有"内容"可折射。暗色段保持现状（用户满意）。
- 亮色边框加可见度：`--glass-border` 亮色从 `rgba(120,120,180,0.18)` 提到约 `rgba(90,95,150,0.35)` 或实色 `#d4d9ee`，让玻璃面板在亮色下有清晰描边。
- 亮色 inset 高光不可见 → 在亮色下改用更明显的边框承担分离（白底上 `rgba(255,255,255,0.10)` 顶部高光无意义），或加 `inset 0 -1px 0 rgba(20,30,80,0.06)` 之类底部暗线。

**B. 让亮色控件"边界清晰"（子工具 index.html）**
- 亮色下 `--field-bg` 不要纯 `#ffffff` 孤悬浮，用略带填充感的实色（如 `#ffffff` 配更明显 border，或 `#eef1fb`）且 border 在亮色下加可见度（复用上面提亮后的 `--glass-border`，或单独给控件更深的亮色边框）。
- 给关键文字（label/标题/按钮）在亮色下确保 `--text:#1b1f3b` 对比度足够（已够，主要是面板/控件边界问题）；必要时补 `text-shadow: 0 1px 2px rgba(255,255,255,0.6)`。

**C. 工程保障**
- 加 `@supports not (backdrop-filter: blur(1px))` 的实色回退（亮色用实色卡片 + 正常边框），防老设备 / 某些 webview 下玻璃失效变不可读。
- 任何改动后：`npm run verify:build` 全绿；并把**入口页 vs 子工具页在亮色/暗色下并排截图**对比，目视确认一致且可读（用户要的是"和入口页一样"的观感）。

## 6. 关键流程约束（必读，避免重蹈覆辙）
- **本地沙箱构建不可行**：本机（WorkBuddy 沙箱）`electron-builder` 打包会被两件事卡死 —— (1) 安全 `safe-delete` 守卫把一切 `rm/unlink` 改成"移回收站"，而沙箱回收站不可达 → fail-closed 拦截 locale 裁剪等删除；(2) `winCodeSign` 在 Windows 无符号链接特权，7z 解压 darwin 的 `.dylib` 符号链接失败，且 GitHub 缓存 URL 带过期签名导致目录哈希每次变、修旧目录无效。**结论：不要在本机死磕本地构建。**
- **正确做法**：改完代码 → 本地只跑 `npm run verify:build`（纯断言，不打包，可过）→ `git add -A` → `git commit` → `git tag v0.1.x`（bump 小版本，让检测更新生效）→ `git push origin main && git push origin v0.1.x` → **让 GitHub Actions CI 构建并发布**（CI 环境无 shim、有符号链接特权，能正常出包）。
- **发布规范**：看 `docs/RELEASE_CHECKLIST.md`（含"装包实测"硬门槛）、`docs/CODE_REVIEW_CHECKLIST.md`、`docs/postmortem-packaging-black-screen.md`。每次修复 bump 小版本打 tag。
- **git rm 大坑**：在 junction 父目录仓库里对子目录路径执行 `git rm` 会物理删整棵子树（含 ignored 的 node_modules）。删单文件一律 `rm -f` + `git add -A`。

## 7. 历史遗留待拍板项（非阻塞，用户未拍板）
- **P0-1**：封面全失败仍判 success（kdocs-tool）。待拍板改为"封面失败则整体失败"。
- **P0-3**：附件上传失败静默丢封面。待拍板处理。

## 8. 给接管 agent 的第一步行动清单
1. `git clone` 到纯英文路径，`npm install`（装 pre-commit 钩子）。
2. 先 `git log --oneline -5` 确认在 `5850bdf` / `v0.1.36`。
3. 读 `shared/tokens.css`、`renderer/style.css`(.card 162-206)、`kdocs-tool/public/index.html`、`netdisk-hub/public/index.html` 建立"目标 vs 现状"认知（第 5 节已给精确行号）。
4. 按 5.5 先动 `shared/tokens.css` 亮色段（A 类），再动子工具亮色控件边界（B 类），加 `@supports` 回退（C 类）。
5. 本地 `npm run verify:build` 必须全绿。
6. **必须实际渲染验证**：本机打包受限，最务实的验证是把子工具 `public/index.html` 直接在浏览器打开（或起子工具自身服务 / `npm run dev`）截图亮色+暗色，与入口页（renderer，可用 `npm start` 在 Electron 里看）并排对比，确认"和入口页一样"且亮色可读。CI 出包后也要装包实测一次。
7. 满意后 bump 版本、commit、tag、push，让 CI 发布。把"入口页 vs 子工具页 亮/暗 并排截图"作为交付证据贴回给用户。

---
附：本次网上查证的权威来源（供进一步对齐）
- NNGroup Glassmorphism: https://www.nngroup.com/articles/glassmorphism/
- Apple Liquid Glass 无障碍指引: https://designedforhumans.tech/blog/liquid-glass-smart-or-bad-for-accessibility
- 2026 玻璃拟态回归: https://launchpad-design.co.uk/tag/ui-design-trends-2026/
- 玻璃拟态实现清单: https://www.neelnetworks.com/blog/glassmorphism-web-design-guide-2026
- uxpilot 玻璃拟态最佳实践: https://uxpilot.ai/blogs/glassmorphism-ui
- 中文实战（背景近白玻璃失效）: https://www.ysdaima.com/blog/ui-glassmorphism/
