# 三模块「历史 / 面板」收敛到卡片右上角 · 厚玻璃弹窗 —— 架构设计评审

> 评审人：高见远（架构师）　|　范围：仅设计评审，不写代码、不改文件
> 涉及模块：`biliup-hub` / `kdocs-tool` / `netdisk-hub`（均位于 `public/`，原生 HTML + CSS + JS，无框架、无共享组件库、样式完全内联、零外部依赖）
> 配套图：`docs/glass-review-sequence.mermaid`（弹窗开关调用流）、`docs/glass-review-class.mermaid`（组件/结构关系）

---

## 0. 结论摘要（给主理人 / 用户速读）

- **统一玻璃弹窗方案已定**：在现有 `.modal-mask > .modal` 体系上加一层「厚玻璃变体」——遮罩 `.modal-mask.glass-mask`（深色半透明 + 轻 blur）包住 `.modal.glass`（`backdrop-filter: blur(40px) saturate(2.0)`）。**这是全站唯一新增的玻璃组件**，历史 / 高级参数 / 格式化三类弹窗全部复用它。
- **三个模块各写一份、但参数统一**：因架构是「三套样式完全内联、零外部依赖」，不引入跨模块共享 CSS 文件；改为**抽一份「唯一真源」玻璃片段（见 §3.3），三模块逐字节复制进各自 `<style>`**。JS 开关约定 `openModal()/closeModal()` + `.show` 类**三模块已天然一致**，直接复用。
- **6 项需求落点清晰**（详见 §4），其中 4 项只是「移动触发按钮位置」，2 项（netdisk 的 历史 / 格式化面板）是「整块面板 → 弹窗」，需把现有 DOM 内容搬进玻璃 modal。
- **主理人 5 个关注点全部给出结论**（§6），核心：历史语义用「弹窗标题保持全局措辞 + tooltip 显式标注『全部』」消解；遮罩用「深色半透明 overlay + 轻 blur」凸显厚玻璃；可读性用「中性半透明玻璃底色 + 高对比文字/分隔线 + 标题 text-shadow」约定保障。
- **任务分解 5 个、有序、含依赖**（§7）：T01 统一规范（基础）→ T02~T04 三模块落地（并行，依赖 T01）→ T05 联调回归。

---

## 1. 现状调研（代码事实，非推测）

### 1.1 三个「历史」按钮——当前位置、触发、内容范围

| 模块 | 当前位置（DOM） | 触发逻辑（app.js） | 弹窗内容范围（语义） |
|---|---|---|---|
| **biliup-hub** | `<header>` → `.header-actions` 内的 `<button id="historyBtn" class="theme-btn">📜 历史</button>`（全局顶栏右侧） | `historyBtn.addEventListener('click', openBiliupHistory)` → `renderBiliupHistory()` 读 `localStorage["toolshub:history:biliup"]` → `openModal(#historyMask)` | **全局投稿历史**（所有投稿成功/失败 + 标题 + 时间，最多 50 条）。弹窗标题已写「📜 投稿历史」 |
| **kdocs-tool** | `<header>` → `.header-actions` 内的 `<button id="historyBtn" class="theme-btn">📜 历史</button>` | `historyOpenBtn.onclick = () => { render...; openModal(#historyMask) }` | **全局录入历史**（所有游戏信息录入成功/失败 + 标题）。弹窗标题已写「📜 录入历史」 |
| **netdisk-hub** | **不在顶栏**。是底部独立整块 `<div class="panel">`（`#historyToggle` + `#historyBody`，默认 `display:none` 可折叠） | `historyToggle.addEventListener('click', ...)` 切换 `#historyBody` 显隐（非 modal） | **转存任务历史**（本就绑定「转存中心」：全部/成功/异常 tab + 任务列表 + 复制本组）。语义天然局部，无歧义 |

> 关键事实：biliup / kdocs 的「历史」目前是**全局顶栏入口**，但其弹窗标题已经是「投稿历史 / 录入历史」这种**全局措辞**——说明数据本就是全局的，只是入口在顶栏。netdisk 的历史本就在转存中心语境内。

### 1.2 待收敛面板的当前 DOM 结构与触发

| 需求 | 当前结构 | 当前触发 | 内容 |
|---|---|---|---|
| biliup 高级参数（#2） | 投稿设置 panel 内 `.adv-toggle`（**整行宽按钮**，`width:100%`），点击打开已有 `#advMask` modal | `advToggle` click → `openModal(#advMask)` | 分区/合集/线路/UID/版权/简介等（**已在 modal 里**） |
| biliup 清空选择（#3） | 选择视频 panel 内 `.row` 中的 `<button id="clearBtn">🗑️ 清空选择</button>`，初始 `display:none`，选了视频才显示 | `clearBtn` click → 清空 selectedVideo/标题/提示 | 仅清掉选择状态 |
| netdisk 转存任务历史（#5） | 底部独立 `<div class="panel">`（`#historyToggle`+`#historyBody`） | toggle 显隐 | tab + 任务列表（见 1.1） |
| netdisk 格式化分享文本（#6） | 转存中心**上方**独立 `<div class="panel">`（`#fmtToggle`+`#fmtBody`，默认 `display:none`） | `fmtToggle` click → toggle `#fmtBody` | 原帖文本 / 格式化结果 textarea + 复制/填入按钮 |

### 1.3 现有玻璃 / backdrop-filter 样式盘点（可复用项）

三模块视觉体系高度同源（CSS 注释明确「与网盘转存逐行一致」），已存在：

- **遮罩层**：`.modal-mask` = `position:fixed; inset:0; background:var(--modal-mask); backdrop-filter:blur(6px)`。其中 `--modal-mask` 暗色 `rgba(8,10,24,0.6)`、亮色 `rgba(20,24,55,0.4)`。**已有深色半透明遮罩**，可直接作为厚玻璃的 overlay 基底。
- **弹窗本体**：`.modal` = `background:var(--bg-2)`（**实色不透明**）、`border-radius:20px`、`box-shadow:0 30px 80px rgba(0,0,0,.5)`。**当前弹窗不是玻璃**，是实色卡片——所以「厚玻璃」是对 `.modal` 的一次玻璃化升级。
- **其它玻璃元素参考值**：`.panel` `blur(24px) saturate(160%)`、`.toast` `blur(18px) saturate(160%)`、`.theme-btn` `blur(16px)`、`.adv-toggle` `blur(16px)`。→ 全站玻璃强度梯度清晰，新弹窗 `blur(40px) saturate(2.0)` 是最强一档，符合「模态框」定位。
- **无障碍护栏已就位**：`@supports not (backdrop-filter: blur(1px))` 把 `.modal` 退化成实色；`@media (prefers-reduced-transparency: reduce)` 关闭 `.modal` 的 backdrop-filter。新增 `.modal.glass` 需补进这两处。
- **统一弹窗 JS 约定已存在**：三模块都有 `openModal(modalEl)`（加 `.show`、重放 `pop-in` 入场）+ `closeModal()`（点遮罩空白处 / 关闭按钮关闭，回原页不重置表单）。**开关注定复用，无需新写**。

### 1.4 卡片 header 结构能否容纳右上角按钮

- **netdisk-hub**：已有 `.panel-head { display:flex; align-items:center; justify-content:space-between; cursor:pointer }` 与 `.icon-btn` 类——**天然支持「标题 + 右上角按钮」**，且 `📜 转存任务历史`、`📋 格式化分享文本` 现在就用 `.panel-head` 包着。改造最小。
- **biliup-hub / kdocs-tool**：卡片标题是裸 `<h2>📂 选择视频</h2>`（block 级，无右侧槽位）。需**新增 `.panel-head` flex 容器**包住 `<h2>` + 一个 `.panel-acts` 按钮组。两模块各自补一段 CSS 即可（与 netdisk 的 `.panel-head` 逐字节对齐）。

---

## 2. 实现方案总览

**一句话方案**：在既有「遮罩 + 实色 modal」体系上，新增一个**厚玻璃变体**（overlay 加深 + modal 玻璃化），把 6 项里所有「历史 / 面板」类入口统一收敛为「卡片 header 右上角的紧凑图标按钮」，点击弹出该厚玻璃卡片；其余功能弹窗（登录二维码、目录选择、二次确认等）保持现状不玻璃化，规避风险。

分层：

1. **基础层（T01，全站唯一真源）**：定义 `.modal-mask.glass-mask` + `.modal.glass` + 一组 `--glass-*` token + 文字/分隔线高对比约定 + a11y 护栏补全。三模块复制同一份。
2. **卡片层**：为每个相关卡片引入「`.panel-head`（flex，标题 + 右侧 `.panel-acts` 图标按钮组）」结构。
3. **入口层**：把 6 个触发点从「顶栏 / 卡片内整行 / 底部整块」搬到对应卡片 `.panel-acts`，按钮统一用 `.icon-btn`（biliup/kdocs 需补该类，netdisk 已有）。
4. **弹窗层**：历史 / 高级参数 / 格式化三类弹窗的 `modal-mask`/`modal` 加 `.glass-mask`/`.glass` 类；netdisk 两个面板的内容整体搬进新建的玻璃 modal。
5. **联调层（T05）**：开关、遮罩、可读性、顶栏、历史语义提示逐模块回归。

---

## 3. 玻璃弹窗组件设计

### 3.1 DOM 结构（overlay + modal）

完全复用既有 `.modal-mask > .modal` 嵌套，仅追加修饰类。以「投稿历史」为例：

```html
<!-- 遮罩层（overlay）：深色半透明 + 轻 blur，凸显厚玻璃 -->
<div class="modal-mask glass-mask" id="historyMask">
  <!-- 厚玻璃卡片：blur(40px) saturate(2.0) -->
  <div class="modal glass" role="dialog" aria-modal="true">
    <div class="modal-head">
      <span>📜 投稿历史</span>            <!-- 标题保持全局措辞，消解语义误读 -->
      <button class="modal-close" id="historyClose" type="button">✕</button>
    </div>
    <div class="modal-body">
      <div class="history-list" id="historyList"></div>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" id="historyClear" type="button">清空历史</button>
    </div>
  </div>
</div>
```

- 开关：点 `.modal-close` / 点遮罩空白处（`e.target === mask`）→ `closeModal()`；点卡片右上角图标按钮 → `openModal(#historyMask)`。**零新 JS 机制**。
- netdisk 的「转存任务历史」「格式化分享文本」沿用同一结构，只是把现有 `#historyBody` / `#fmtBody` 的内部 DOM 整体搬进 `.modal-body`（JS 渲染逻辑不变，仅触发由 toggle 改为 `openModal`）。

### 3.2 CSS 规格（blur / saturate / overlay / 圆角 / 阴影 / 文字对比约定）

**遮罩策略（回应关注点 #3）**：玻璃卡片本身已 `blur(40px)`，若 overlay 也用重 blur 会糊成一团且拖慢性能。故 overlay 用「**深色半透明 + 轻 blur(4px)**」——既压暗背景让厚玻璃浮起，又保留底层轮廓暗示。这是「凸显厚玻璃」的标准做法。

**唯一真源片段（建议放 `docs/` 并复制进三模块 `<style>`，逐字节一致）**：

```css
/* ===== 厚玻璃弹窗（单一真源，三模块逐字节一致）===== */
/* —— token：暗色用深色半透明玻璃保证亮字可读；亮色用浅半透明玻璃保证暗字可读 —— */
:root {
  --glass-modal-bg:     rgba(20, 24, 55, 0.55);   /* 暗色：中性深半透明 */
  --glass-modal-border: rgba(255, 255, 255, 0.45);
  --glass-modal-divider: rgba(255, 255, 255, 0.42);
  --glass-mask-bg:      rgba(6, 8, 20, 0.62);     /* overlay 深色基底 */
}
[data-theme="light"] {
  --glass-modal-bg:     rgba(255, 255, 255, 0.62);
  --glass-modal-border: rgba(90, 95, 150, 0.45);
  --glass-modal-divider: rgba(90, 95, 150, 0.42);
  --glass-mask-bg:      rgba(20, 24, 55, 0.40);
}

/* —— overlay（遮罩层） —— */
.modal-mask.glass-mask {
  background: var(--glass-mask-bg);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

/* —— 厚玻璃卡片本体（用户指定规格） —— */
.modal.glass {
  background: var(--glass-modal-bg);
  -webkit-backdrop-filter: blur(40px) saturate(2.0);
  backdrop-filter: blur(40px) saturate(2.0);
  border: 1px solid var(--glass-modal-border);
  box-shadow: var(--shadow-modal), inset 0 1px 0 rgba(255, 255, 255, 0.28); /* 顶部高光勾边，强化玻璃感 */
  color: var(--text);
}

/* —— 文字 / 分隔线高对比约定（回应关注点 #5） —— */
.modal.glass .modal-head,
.modal.glass .modal-title,
.modal.glass h2, .modal.glass h3 {
  color: var(--text);
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.28);   /* 标题加投影，强饱和下仍立得住 */
}
.modal.glass .history-title { color: var(--text); font-weight: 600; }
.modal.glass .history-meta  { color: var(--text-dim); }
.modal.glass .history-item  { border-bottom: 1px solid var(--glass-modal-divider); } /* 比 --glass-border 更亮，分隔更清晰 */
.modal.glass .hint          { color: var(--text-dim); }
.modal.glass .modal-close   { color: var(--text-dim); }
.modal.glass .modal-close:hover { color: var(--text); }

/* —— a11y 护栏：并入既有 @supports / reduced-transparency（必补） —— */
@supports not (backdrop-filter: blur(1px)) {
  .modal.glass { -webkit-backdrop-filter: none; backdrop-filter: none;
                 background: var(--bg-2); }            /* 暗色回退实色 */
  [data-theme="light"] .modal.glass { background: #e7ecf8; }
}
@media (prefers-reduced-transparency: reduce) {
  .modal.glass { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
}
```

**可读性关键约定（关注点 #5 落地）**：`saturate(2.0)` 主要强化「透出的模糊背景」饱和度，而我们用**中性半透明底色**（暗色深蓝半透 / 亮色白半透）而非纯白，使文字始终落在「暗底亮字 / 亮底暗字」的高对比区间；长列表分隔线用**更亮的 `--glass-modal-divider`**；标题加 `text-shadow`。三者叠加，确保强饱和+模糊下文字对比度不塌陷。

### 3.3 三模块共享方案（回应关注点 #4）

- **不做**跨模块运行时共享（违背「零外部依赖、样式完全内联」架构）。
- **做**「单一真源 + 逐字节复制」：上面的片段作为**唯一真源**（建议存为 `docs/glass-modal.css` 供人工 diff 比对），biliup / kdocs / netdisk 各自**整段复制进 `public/index.html` 的 `<style>`**，类名（`glass-mask` / `glass` / `panel-head` / `icon-btn` / `panel-acts`）与 token 名（`--glass-*`）全站统一。
- **JS 无需共享**：`openModal/closeModal` + `.show` 约定三模块已一致，直接复用。
- 好处：参数 100% 统一、未来调参只改一处真源再同步三份；代价仅是三份副本，符合现有工程现实。

---

## 4. 各需求点具体落点（6 项逐一）

| # | 模块 | 从哪搬走 | 搬到哪（卡片 / 元素 / 常驻·并排规则） | 弹窗类型 | 备注 |
|---|---|---|---|---|---|
| 1 | biliup | 顶栏 `.header-actions` 的 `#historyBtn` | **🚀 投稿** 卡片 header 右上角，图标按钮 `📜`（常驻） | 厚玻璃 `#historyMask` | 推荐落点见 §5；标题保持「投稿历史」 |
| 2 | biliup | 投稿设置 panel 内整行 `.adv-toggle` | **📝 投稿设置** 卡片 header 右上角，图标按钮 `⚙️`（常驻） | 厚玻璃 `#advMask` | modal 内容已存在，仅触发按钮搬家 + 加 `.glass` |
| 3 | biliup | 选择视频 panel 内 `.row` 的 `#clearBtn` | **📂 选择视频** 卡片 header 右上角，图标按钮 `🗑️`（**常驻显示，去掉原 `display:none`**） | 无（即时动作） | click 处理器需对「未选视频」安全（空操作/轻提示） |
| 4 | kdocs | 顶栏 `.header-actions` 的 `#historyBtn` | **📝 游戏信息** 卡片 header 右上角，图标按钮 `📜`（常驻） | 厚玻璃 `#historyMask` | 标题保持「录入历史」 |
| 5 | netdisk | 底部整块 `#historyToggle`+`#historyBody` 面板（删除该 panel） | **🚀 转存中心** 卡片 header 右上角，图标按钮 `📜`（常驻） | 厚玻璃 `#historyMask`（内容=原 `#historyBody`） | JS 由 toggle 改 `openModal` |
| 6 | netdisk | 转存中心上方整块 `#fmtToggle`+`#fmtBody` 面板（删除该 panel） | **🚀 转存中心** 卡片 header 右上角，与历史按钮**并排**，图标按钮 `📋`（常驻） | 厚玻璃 `#fmtMask`（内容=原 `#fmtBody`） | JS 由 toggle 改 `openModal` |

> 卡片 header 结构统一为：
> ```html
> <div class="panel-head">
>   <h2>📝 投稿设置</h2>
>   <div class="panel-acts">
>     <button class="icon-btn" id="advTrigger" title="高级参数 ⚙️">⚙️</button>
>   </div>
> </div>
> ```
> netdisk 的转存中心 `.panel-head` 内放**两个** `.icon-btn`（📋 + 📜）并排；biliup/kdocs 需新增 `.panel-head` 与 `.icon-btn` 样式（netdisk 已有，直接对齐复制）。

---

## 5. 历史语义处理建议（逐模块，回应关注点 #1）

**问题本质**：biliup / kdocs 的「历史」数据本就是**全局**的（localStorage 全量），但入口要从「全局顶栏」搬进「单个卡片」。用户可能误以为「只管这张卡片」。

**结论**：

- **biliup（投稿历史）**：入口放 **🚀 投稿** 卡片右上角（最贴近「投稿」动作语义）；**弹窗标题保持「📜 投稿历史」（全局措辞）+ tooltip 显式写「查看全部投稿历史」**。不额外加全局入口。理由：标题已用全局词，配合 tooltip 足以消解误读；若用户坚持要强调全局，可退而在标题后加极小「全部」标签（见待明确 #2）。
- **kdocs（录入历史）**：同理，入口放 **📝 游戏信息** 卡片右上角；弹窗标题保持「📜 录入历史」+ tooltip「查看全部录入历史」。
- **netdisk（转存任务历史）**：**无歧义，不改语义**。该历史本就绑定「转存中心」（全部/成功/异常皆围绕转存任务），搬进转存中心右上角反而更自洽；标题保持「📜 转存任务历史」。

> 不建议为此在顶栏保留第二个「全局历史」入口——那会否定本次收敛的初衷，且与「6 项需求已全部把历史收进卡片」的既定方向冲突。

---

## 6. 对主理人 5 个关注点的逐条回应

1. **「历史」语义范围（误读风险）**
   → 见 §5。结论：biliup/kdocs 用「弹窗标题保持全局措辞 + tooltip 标注『全部』」消解；netdisk 本就局部无歧义。无需在顶栏保留第二入口。

2. **顶栏移空后是否需补全局元素**
   → biliup / kdocs 移走「历史」后，右侧仍剩：`账号区(头像/昵称)` + `状态胶囊(statusCapsule)` + `版本徽章(verBadge，工具箱 vX)`（主题按钮 `#themeBtn` 本就 `display:none` 由工具箱统管）。这些**都是全局状态，留着合理**；「历史」只是内容快捷入口，搬进卡片后顶栏无需补任何元素。netdisk 顶栏未动，不受影响。

3. **遮罩层策略（关键）**
   → 采用「**深色半透明 overlay（`.glass-mask`）+ 轻 blur(4px)**」包住厚玻璃卡片（§3.2）。overlay 压暗背景、保留轮廓暗示，使 `blur(40px) saturate(2.0)` 的玻璃浮起感最强；避免 overlay 也用重 blur 导致糊团与性能浪费。遮罩点击空白关闭的逻辑沿用既有 `closeModal()`。

4. **三份重复实现**
   → 抽「**唯一真源玻璃片段**」（§3.3），三模块**逐字节复制进各自内联 `<style>`**；类名/token 全站统一；JS 开关约定本就一致直接复用。不引入跨模块共享文件（尊重零外部依赖架构）。参数 100% 统一，未来调参改一处同步三份。

5. **saturate(2.0) 可读性**
   → 「中性半透明玻璃底色（暗深蓝半透 / 亮白半透）+ 高对比文字（`--text`）/ 更亮分隔线（`--glass-modal-divider`）/ 标题 `text-shadow`」三约定（§3.2）。核心思路：不让文字压在高饱和透出区——底色中性化，文字始终落在高对比区间。长列表（历史/任务）特别适用此约定。

---

## 7. 任务分解（有序 · 含依赖 · 按实现顺序）

> 规则：≤5 个任务、每任务 ≥3 个文件、首任务为「基础/共享规范」、后续按模块分组、并行可、T05 收尾联调。文件指各模块 `public/` 下的 `index.html` 与 `app.js`（及内联 `<style>`）。

- **T01 · 统一厚玻璃弹窗规范（基础，全站唯一真源）**
  - 文件：`biliup-hub/public/index.html`、`kdocs-tool/public/index.html`、`netdisk-hub/public/index.html`（三处各加同一段 `<style>`：`.glass-mask`/`.modal.glass`/`--glass-*` token/文字对比约定/a11y 护栏；并为 biliup/kdocs 补 `.panel-head`+`.icon-btn`+`.panel-acts`）
  - 依赖：无（基石）
  - 优先级：P0

- **T02 · biliup-hub 落地**（#1 历史→投稿卡片右上角 / #2 高级参数→投稿设置右上角 / #3 清空选择→选择视频右上角常驻）
  - 文件：`biliup-hub/public/index.html`（删顶栏 `#historyBtn`、改三卡片 header 为 `.panel-head`+`.panel-acts`、给 `#historyMask`/`#advMask` 加 `.glass`、删整行 `.adv-toggle`、清空选择改常驻）、`biliup-hub/public/app.js`（触发绑定迁移：新图标按钮→`openModal`；`clearBtn` 处理器对空选择安全）
  - 依赖：T01
  - 优先级：P0

- **T03 · kdocs-tool 落地**（#4 历史→游戏信息卡片右上角）
  - 文件：`kdocs-tool/public/index.html`（删顶栏 `#historyBtn`、游戏信息卡片 header 改 `.panel-head`+`.panel-acts`、给 `#historyMask` 加 `.glass`）、`kdocs-tool/public/app.js`（历史触发绑定到新图标按钮）
  - 依赖：T01
  - 优先级：P0

- **T04 · netdisk-hub 落地**（#5 历史→转存中心右上角 / #6 格式化→转存中心右上角并排）
  - 文件：`netdisk-hub/public/index.html`（删底部历史 panel 与上方格式化 panel，转存中心 `.panel-head` 加两个 `.icon-btn`；新建玻璃 `#historyMask`/`#fmtMask` 承载原 `#historyBody`/`#fmtBody` 内容并加 `.glass`）、`netdisk-hub/public/app.js`（`historyToggle`/`fmtToggle` 由 toggle 改为 `openModal`）
  - 依赖：T01
  - 优先级：P0

- **T05 · 跨模块联调与回归**
  - 文件：三模块 `index.html` + `app.js`（统一自查：弹窗开关/`Esc`/点遮罩关闭、遮罩深色凸显、玻璃内文字对比、顶栏无遗留历史入口、历史语义 tooltip/标题、亮暗双主题、reduced-motion/无 backdrop-filter 回退）
  - 依赖：T02、T03、T04
  - 优先级：P1

任务依赖图见 `docs/glass-review-sequence.mermaid` 之外的依赖关系（文字版）：`T01 → {T02, T03, T04} → T05`。

---

## 8. 待明确事项（需用户 / 主理人拍板）

1. **biliup「历史」具体落哪个卡片**：推荐 **🚀 投稿** 卡片（最贴投稿动作）；备选 **📝 投稿设置** 卡片（与高级参数同 header）。请确认，或确认「两按钮同放投稿设置 header」亦可。
2. **是否要在历史弹窗标题后加「全部」微标签**：默认不加（靠标题全局措辞 + tooltip 即可）；若用户担心误读，可加极小「全部」标签，请定。
3. **netdisk 两个玻璃弹窗的触发内容**：确认把现有 `#historyBody`（含 tab/任务列表/复制本组）与 `#fmtBody`（含原帖/结果 textarea/复制/填入）**整体搬进**玻璃 modal，逻辑不变——是否认可「整块面板变弹窗」这一形态（而非保留面板折叠）。
4. **其余功能弹窗是否一并玻璃化**：默认**仅**历史/高级参数/格式化三类用厚玻璃；登录二维码、目录选择、二次确认、重复确认等保持现状（规避二维码扫描清晰度风险）。如需全量玻璃化请明示。
5. **「清空选择」常驻后的空状态行为**：默认常驻显示、点击空选择时为安全空操作（或轻 toast 提示）。请确认是否接受「无视频时按钮仍可见」。

---

## 9. 共享知识（跨文件约定，供 Engineer 落地）

- **CSS 类名（全站统一）**：`glass-mask`（遮罩修饰）、`glass`（modal 玻璃修饰）、`panel-head`（卡片头 flex 容器：标题 + 右侧槽）、`panel-acts`（右上角图标按钮组）、`icon-btn`（紧凑图标按钮）。biliup/kdocs 需补 `.panel-head`/`.icon-btn`/`.panel-acts`，netdisk 已有可对齐。
- **CSS 变量（全站统一）**：`--glass-modal-bg`、`--glass-modal-border`、`--glass-modal-divider`、`--glass-mask-bg`（均分 `:root` 暗色与 `[data-theme="light"]` 亮色两套）。
- **弹窗开关 JS 约定（三模块已一致，直接复用）**：`openModal(modalEl)`（加 `.show`、重放 `pop-in`）/ `closeModal()`（关闭按钮或点遮罩空白处 `e.target === mask` 触发）。**不要新写开关逻辑**；新弹窗只需把触发按钮的 click 绑到 `openModal(#xxxMask)`。
- **玻璃弹窗适用边界**：仅历史 / 高级参数 / 格式化三类；登录/目录/确认类弹窗保持原 `.modal`（实色）。
- **无障碍护栏**：新增 `.modal.glass` 必须并入既有 `@supports not (backdrop-filter)` 与 `@media (prefers-reduced-transparency: reduce)` 两处回退（见 §3.2）。
- **内联约束**：所有样式继续写在各 `index.html` 的 `<style>` 内，**不引入外部 CSS 文件**（维持零外部依赖）。
- **历史语义**：弹窗标题保持全局措辞（投稿历史 / 录入历史 / 转存任务历史），触发按钮 `title` 写「查看全部…历史」。

---

## 10. 附：关键图示

- 弹窗开关调用流：`docs/glass-review-sequence.mermaid`
- 组件 / DOM 结构关系：`docs/glass-review-class.mermaid`
