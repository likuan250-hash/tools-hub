# v018 — kdocs 掉线重连 + 清空对齐 + 任务历史 + 统一弹窗（P05/P07/P08/P09）

> 范围：kdocs-tool 前端（public/app.js、public/index.html、router.js）+ biliup-hub 前端补 P08 历史（public/app.js、public/index.html）。
> 未修改 `biliup-hub/lib/biliup.js` / `command.js` / `task.js`（P03 已提交 2c4a0f2）。
> 未修改 `biliup-hub/lib/store.js`（另一工程师已修）。
> 未修改任何 `package.json` version（主理人统一 bump）。未引入新 npm 依赖。未自行 commit/tag/push。

## 一、任务分解与根因

### A. P05 ｜ 金山文档 AI 掉线重连（稳定性 Bug）
- **现象**：kdocs AI（bl CLI）时不时掉线，需重开关页面恢复。
- **根因**：AI 在线状态由 `lib/ai.js` 的 `checkBlAvailable()` 每次 fresh `spawn("bl","--version")` 检测（stateless）。"掉线"=bl 进程瞬时不可用（登录态过期/网络抖动/CLI 卡死），但前端只在 `initCheck()` 首屏检测一次，之后无感知，用户只能靠重开页面重新触发 `/api/check`。
- **修复**：
  1. 前端心跳：每 30s 轮询 `/api/check`，只在状态**跳变**（ok↔off）时打扰用户（toast + 横幅），避免每次轮询刷屏。
  2. 明显提示：状态掉线时顶部弹出红色 `ai-banner` 横幅（含"🔄 重新连接"按钮），同时状态胶囊变红、"AI ⚠️ 不可用"。
  3. 自动重连：`/api/ai/reconnect` 后端端点重跑 `checkBlAvailable()`（bl fresh spawn 即"重连"），前端点击按钮或掉线提示触发；恢复后横幅自动消隐、胶囊转绿、toast "✅ AI 已恢复在线"。
  4. 恢复自愈：心跳持续运行，AI 自行恢复时无需任何人工操作即消隐提示——**彻底免去人工重开页面**。

### B. P07 ｜ 清空按钮位置对齐网盘（UX 对齐）
- **改动**：kdocs 录入框清空按钮由"框内右上角（`textarea` 内 `.clear-corner` 绝对定位）"改为与 netdisk 一致的"**框外右上方**"——`field-head`（label 左侧 + `.clear-input` 清空按钮右侧）置于文本框上方。
- **对齐点**：DOM `id="clearBtn"` 保持，JS 逻辑零改动；视觉/位置与网盘转存完全一致。

### C. P08 ｜ 轻量任务历史（结果+标题+时间）
- **存储**：localStorage，统一 key `toolshub:history:biliup` / `toolshub:history:kdocs`，各自数组（最新在前，封顶 50 条），每项 `{ts, ok, title, status}`。无新依赖、跨会话持久。
- **kdocs 部分**：在 `runAuto` 的 SSE `done` 回调（成功/失败/跳过/更新/封面缺失均映射为 ok+status）与 `catch`（请求异常）处写一条历史；新增历史弹窗（接入 P09 机制）展示，可"清空历史"。
- **biliup 部分（补）**：在 `handleEvent` 的 `done`（按 `d.success` 判定 ok）/ `error` 回调与 `submit` 的 `catch` 处写一条历史；复用既有 `openModal` 弹窗做历史展示（不破坏 engineer1 已写逻辑，仅新增写入+展示）。
  - **关键约束遵守**：`biliup-hub/lib/store.js` 与 `public/app.js` 既有 toast/openModal/submit 逻辑**未删改**，仅在回调末尾追加 `pushHistory(...)` 与一段历史展示 UI 绑定。

### D. P09 ｜ kdocs 侧弹窗来去一致（基座）
- kdocs（独立前端）内联一份 `openModal(el)` / `closeModal()`，与 biliup 同约定：显示浮层并记录 `activeModal`、关闭即隐藏浮层回到下层原页（不切路由、不重置表单）。
- 把 kdocs 现有**重复确认弹窗**（`dupMask`）与本次新增的**历史弹窗**（`historyMask`）都接入该机制；约定未来新增弹窗复用。
- 入场复用内联 `pop-in`（来自 `macos-motion.css`），不修改共享 keyframes；`.modal-mask` 由 `display:grid` 改为 `display:none`+`.show{display:flex}` 以匹配 `openModal` 的 `.show` 约定；`prefers-reduced-motion: reduce` 下由全局媒体查询自动降级。

## 二、P09 统一弹窗约定（kdocs 侧必须遵守）
- `openModal(el)` 显示浮层并记录当前浮层；`closeModal()` 隐藏返回原页。
- 关闭逻辑：仅隐藏 modal，回到下层原页，保证「从哪里来回哪里去」。
- DOM `id` 保持原样；复用现有 `var(--bg-2)`/`var(--glass-bg)` 等主题 token；明暗自动适配。

## 三、关键设计决策
1. **P05 心跳"跳变才提示"**：`_aiPrev` 记录上次状态，仅 `ok→off`/`off→ok` 跳变时弹 toast+横幅，避免每 30s 打扰；首次探活（`_aiPrev===null`）静默建基线。
2. **P05 重连端点轻量且安全**：`POST /api/ai/reconnect` 仅重跑 `checkBlAvailable()` 返回 `{ok, blAvailable}`，additive 不触碰 biliup 禁改文件；bl 为 fresh spawn，"重检"即"重连"。
3. **P07 复用 netdisk 的 `.field-head`+`.clear-input`** 结构，kdocs 补 `.field-head`/`.clear-input` 基础样式（`.clear-input` 已存在于 kdocs 主题覆写块），按钮 `id` 不变 → JS 零改动。
4. **P08 历史 `title` 取值**：kdocs 优先 `d.gameName` → 解析出的游戏名 → `currentParsed.gameName` → "（未命名）"；biliup 取 `$("titleInput").value` → "（未命名）"。
5. **P08 ok 判定**：kdocs `ok = d.success !== false`（封面缺失/跳过/更新均视为成功）；biliup 同判 `d.success !== false`。
6. **P09 dupModal 迁移**：移除 `dupMask` 内联 `style="display:none"`（否则 `.modal-mask.show` 被内联样式压制无法显示），改用 CSS `.modal-mask{display:none}`+`.show{display:flex}`；`showDupModal`→`openModal(dupMask)`，`dupCancel/dupContinue`→`closeModal()`。

## 四、改动文件清单
| 文件 | 改动 |
|---|---|
| `kdocs-tool/router.js` | 新增 `POST /api/ai/reconnect`（重跑 `checkBlAvailable`，返回 `{ok, blAvailable}`） |
| `kdocs-tool/public/index.html` | ① `.field-head`/`.clear-input` 基础样式（P07）；② `.ai-banner` 横幅样式（P05）；③ `.modal-mask` 改 `.show` 模式 + `.modal-head`/`.modal-close`/`.history-list` 等（P08/P09）+ `@keyframes pop`；④ 录入框改 `field-head`+`clear-input`（P07）；⑤ header 加 `#historyBtn`（P08）；⑥ status-row 下加 `#aiBanner` 横幅（P05）；⑦ `dupMask` 移除内联 `display:none`（P09）；⑧ 新增 `#historyMask` 历史弹窗（P08） |
| `kdocs-tool/public/app.js` | ① `setAiChip`+心跳 `checkAiStatus`/`reconnectAi`/横幅显隐 + `setInterval 30s`（P05）；② `openModal`/`closeModal` 统一机制（P09）；③ `dupMask` 接入 `openModal`/`closeModal`（P09）；④ 历史 helper `loadHistory/pushHistory/writeKdocsHistory`（P08）；⑤ `runAuto` 的 `done`/`catch` 写历史（P08）；⑥ 历史弹窗渲染/打开/清空绑定（P08） |
| `biliup-hub/public/index.html` | ① `.history-list`/`.history-item`/等历史样式（P08）；② header 加 `#historyBtn`（P08）；③ 新增 `#historyMask` 历史弹窗（P08） |
| `biliup-hub/public/app.js` | ① 历史 helper `loadHistoryBiliup/pushHistory/escapeHtmlBiliup`（P08）；② `handleEvent` 的 `done`/`error` 写历史、`submit` 的 `catch` 写历史（P08）；③ 历史弹窗渲染/打开/清空绑定，复用既有 `openModal`/`closeModal`（P08/P09） |

未改动：`biliup-hub/lib/biliup.js` / `command.js` / `task.js` / `store.js` / 任何 `package.json` / kdocs `lib/ai.js` 等核心逻辑（仅 router 加端点）。

## 五、全局一致性审查
- **DOM id 对应**：kdocs `#aiBanner/#aiBannerMsg/#aiReconnectBtn/#historyBtn/#historyMask/#historyList/#historyClose/#historyClear/#dupMask` 与 app.js `$()` 引用一一对应且唯一；biliup `#historyBtn/#historyMask/#historyList/#historyClose/#historyClear` 同理。
- **P09 机制一致**：kdocs 与 biliup 的 `openModal`/`closeModal` 单例 `activeModal` 管理；`dupMask`(kdocs) / `confirmMask`/`loginMask`/`advMask`/`historyMask`(biliup) 均通过 `.show` 显隐、`pop-in` 重放、`closeModal` 回原页。
- **P05 无 TDZ**：`initCheck()` 调用位于 `let _aiPrev` 声明之后，`_aiPrev` 赋值在调用点前已完成，无暂时性死区。
- **P07 兼容**：`clearBtn` id 不变，`clearBtn.onclick` 逻辑未动；`.clear-input` 在 kdocs 主题覆写块已定义。
- **P08 存储隔离**：两个 key 互不干扰；`JSON.parse` 失败时回退 `[]`；`localStorage.setItem` 失败（隐私模式）被 try/catch 吞掉不影响主流程。
- `node --check` 通过：`kdocs-tool/public/app.js`、`biliup-hub/public/app.js`、`kdocs-tool/router.js` 均无语法错误。

## 六、IS_PASS
**IS_PASS: YES**

## 七、遗留项
- P05 "重连"本质是 `checkBlAvailable` 重跑（bl 为 fresh spawn，无会话态可恢复）；若 bl 掉线是因其底层登录态过期，仅重检不足以恢复，需用户在 bl 侧重新登录——此时横幅会提示"重连失败"，不自动静默成功（避免误判）。
- P05 心跳间隔固定 30s（兼顾及时性与后端压力），如需更灵敏可下调；当前 AI 检测为本地 `bl --version`，开销极小。
- P08 历史为前端 localStorage，多端/多用户不共享；如未来需要跨端，可改后端存储（不在本次范围）。
- kdocs 历史弹窗与 biliup 历史弹窗各自独立实现（因二者前端独立），但遵循同一 P09 约定与同一视觉 token，风格一致。
