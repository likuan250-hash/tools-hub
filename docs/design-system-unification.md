# tools-hub 设计系统统一规范（Apple HIG 风格）

> 作者：Bob（架构师） · 范围：`biliup-hub` / `kdocs-tool` / `netdisk-hub` 三个渲染模块 + 共享 `status-luxe.css`
> 目标：把三套前端的设计语言统一为 **Apple Human Interface Guidelines** 风格——视觉、文案、动画、表单控件（重点修复「输入框/选择框跟背景太突兀」）全部统一。
> 约束：**本次只产出规范，不改任何代码**。后续落地请严格按第 D 节的任务分解执行，且不得破坏「保持不变清单」（见 B.0）。

---

## 0. 审计结论速览（给主理人）

### 0.1 审计方式
亲手 `Read` 了三模块的 `public/index.html` 与 `public/app.js`（含内联 `<style>` 块）、共享 `status-luxe.css` 与 `docs/` 既有设计文档。逐字节比对了 `:root` token、组件样式、文案与动画。

### 0.2 现有基础（好消息）
- 三模块的 **`shared/tokens.css`（内联）与 `shared/macos-motion.css`、`public/macos.css` 已近乎逐字节一致**，token 结构统一。
- **T01 块（`.icon-btn` / `.btn-exec` / `.app-ico` / 厚玻璃 `.modal.glass`）三模块逐字节一致**，是已确认成果。
- `.panel` / `.btn` / `.auth-btn` / `.empty-state` / `:focus-visible` / 入场 `pop-in` 三模块一致。
- 主操作 loading 词「执行中…」三模块一致。

### 0.3 最严重的 3 个设计不一致 / 突兀问题
| # | 问题 | 现状（证据） | 影响 |
|---|------|------|------|
| **①（最严重）** | **表单控件「太突兀」** | 字段背景 `--field-bg: var(--bg-2)` = 暗色 `#222a52`／亮色 `#e9edfb`（饱和实色），配高亮边框 `--glass-border: rgba(255,255,255,.42)`；圆角 12px（generic）/10px（`.field`/macos 覆盖）自相矛盾；`padding` 12/14 与 9/12 并存；`select` 箭头只在 biliup 的 `.field` 作用域内有，kdocs/netdisk 无自定义箭头。 | 饱和实色块 + 亮边框直接「砸」在磨砂玻璃面板上，与 Apple 半透明微妙表面严重冲突。这正是用户指出的痛点。 |
| **②** | **普通弹窗样式三模块分裂** | 普通 `.modal`：biliup/netdisk 用 **实色** `background: var(--bg-2)`（不透明中蓝块），kdocs 用 **磨砂玻璃** `var(--glass-bg)`+`blur(24px)`；netdisk 的目录/复制弹窗、kdocs 的重复确认弹窗是实色，biliup 的确认/登录弹窗也是实色。 | 同一类「普通弹窗」在 2 个模块像实色块、1 个模块像玻璃，观感割裂。厚玻璃（`.modal.glass`）反而三模块一致——说明普通弹窗才是短板。 |
| **③** | **Toast 三种实现、netdisk 完全缺失** | biliup：`.toast-host` 玻璃容器 + 动态子节点 + 图标 + `pop-in`；kdocs：单元素 `#toast`，**实色文字、无玻璃、无图标**；netdisk：**没有任何 toast**（用 `.banner` 代替）。 | 轻提示体验三模块天差地别，netdisk 根本不弹 toast。需统一为一套。 |

> 次级问题（见各节）：动效双源（硬编码 `0.2s` vs token `--dur:0.28s`）、switch 尺寸/模式不一（biliup macos 38px 半透明 vs netdisk 本地 40px 实色）、`.dir-btn` 仅 netdisk 为强调色、文案「浏览/选择/选择目录」「v—/v?」「检测中/检查中」「投稿历史/录入历史/转存任务历史」不统一。

---

## A. 设计 Token（CSS 变量，`:root`，亮/暗双套）

### A.1 命名映射与别名策略
**策略**：以 Apple 命名为**单一真源**，旧名作为**别名保留**（`旧名: var(--新名)`），保证三模块 `:root` 完全统一且旧引用不破。

| Apple 新名 | 旧名（保留为别名） | 说明 |
|------|------|------|
| `--bg` | `--bg-1` | 页面基底（渐变起点） |
| `--surface` | `--glass-bg` | 磨砂面板/卡片表面（明亮半透明） |
| `--surface-2` | `--field-bg`、`--solid-bg` | **新增**：字段/次级表面（微妙半透明，修复突兀的关键） |
| `--fg` | `--text` | 主文字 |
| `--fg-2` | `--text-dim` | 次要文字 |
| `--muted` | （新增） | 元信息灰 `#86868b`/`#98989d` |
| `--border` | （新增 `--field-border` 引用它） | 发丝边框（仅字段用，不动 `--glass-border`） |
| `--border-soft` | （新增） | 更弱分隔线 |
| `--accent` | `--accent` | **强调色（见决策点#1，建议统一 Apple 蓝）** |
| `--accent-rgb` | `--accent-rgb` | RGB 三元组 |
| `--accent-2` / `--accent-3` | 同名 | 保留为**分模块品牌渐变色**（仅用于 logo/装饰） |
| `--shadow-card` | 同名 | 卡片阴影（归入 `--elev-raised`） |
| `--ok` / `--warn` / `--err` | 同名 | 语义色（建议对齐 Apple，见决策点#4） |
| `--modal-mask` | 同名 | 遮罩底色 |
| `--glass-modal-bg` 等 | 同名 | 厚玻璃弹窗专用（保持不变） |

> **关键决策**：`--glass-border`（亮白 0.42 / 0.35）**继续用于面板、卡片、按钮、普通弹窗**，因为它定义了现有玻璃质感（用户喜欢）。**只为表单控件新增 `--border` 发丝边**，做外科手术式修复，不波及全局。

### A.2 完整 `:root` 定义（落地时整体替换三模块内联 tokens 块，保持别名）

```css
/* ===== 暗色（默认） ===== */
:root {
  /* 页面基底（渐变三段） */
  --bg: #1d1d1f;            /* Apple 暗底 */
  --bg-1: var(--bg);
  --bg-2: #2c2c2e;         /* Apple surface 暗 */
  --bg-3: #3a3a3c;
  --grad-a: #0a0a0c; --grad-b: #1d1d1f; --grad-c: #2a2a2e; /* 渐变点缀，可沿用旧蓝或改中性灰 */

  /* 文字 */
  --fg: #f5f5f7;           /* Apple 暗文字 */
  --fg-2: #c7c7cc;         /* Apple 次级 */
  --muted: #98989d;        /* 元信息 */

  /* 表面 */
  --surface: rgba(255,255,255,0.10);            /* 玻璃面板（比旧 0.32 更克制，暗底上更干净） */
  --surface-2: rgba(255,255,255,0.08);          /* 字段表面（微妙，修复突兀） */
  --field-bg: var(--surface-2);                 /* 别名 */
  --solid-bg: var(--surface-2);                 /* 别名 */

  /* 边框 */
  --border: #3a3a3c;                              /* 发丝边（字段用） */
  --border-soft: rgba(255,255,255,0.12);
  --glass-border: rgba(255,255,255,0.18);        /* 面板/按钮玻璃边（比旧 0.42 更柔，可选微调） */
  --field-border: var(--border);

  /* 强调色（决策点#1：统一 Apple 蓝；分模块品牌色仅留作 logo 渐变） */
  --accent: #0a84ff;                             /* Apple 暗蓝 */
  --accent-rgb: 10,132,255;
  --accent-hover: #409cff;
  --accent-active: #0a76e0;
  --accent-on: #ffffff;
  --accent-2: #5e5ce6;                           /* 分模块品牌渐变（biliup 用粉/青，其余用紫/青，见 D 任务①备注） */
  --accent-3: #bf5af2;

  /* 语义色（决策点#4：对齐 Apple） */
  --ok: #32d74b;   --ok-rgb: 50,215,75;
  --warn: #ffd60a; --warn-rgb: 255,214,10;
  --err: #ff453a;  --err-rgb: 255,69,58;

  /* 阴影 / 层级 */
  --elev-flat: none;
  --elev-ring: 0 0 0 1px var(--border);
  --elev-raised: 0 12px 32px rgba(0,0,0,.45);
  --shadow-card: 0 10px 34px rgba(0,0,0,.40);
  --shadow-modal: 0 30px 80px rgba(0,0,0,.60);

  /* 遮罩 / 厚玻璃（保持不变） */
  --modal-mask: rgba(8,10,24,0.60);
  --glass-modal-bg: rgba(28,28,30,0.62);
  --glass-modal-border: rgba(255,255,255,0.22);
  --glass-modal-divider: rgba(255,255,255,0.20);
  --glass-mask-bg: rgba(6,8,20,0.62);

  /* 开关 */
  --switch-off: #3a3a3c;
  --switch-thumb: #ffffff;

  /* 字体 */
  --mac-font: -apple-system, "SF Pro Display","SF Pro Text","Helvetica Neue",Helvetica,Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --mono-font: "SF Mono", Menlo, "Cascadia Code", "JetBrains Mono", Consolas, "PingFang SC", monospace;

  /* 间距 */
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:20px; --sp-6:24px; --sp-7:32px; --sp-8:48px;

  /* 圆角 */
  --r-sm:8px; --r-md:12px; --r-lg:18px; --r-pill:999px;

  /* 动效（决策点#3：统一，去除过冲 spring 在 hover/transform 上的滥用） */
  --motion-fast: 150ms;
  --motion-base: 220ms;
  --ease-standard: cubic-bezier(0.28, 0.22, 1);
  --ease-emphasized: cubic-bezier(0.32, 0.72, 0, 1);   /* 仅用于入场 pop-in 等强调动画 */
  --dur: var(--motion-base); --dur-fast: var(--motion-fast);
  --ease-out: var(--ease-standard); --ease-spring: var(--ease-emphasized);

  /* 焦点环 */
  --focus-ring: 0 0 0 4px color-mix(in oklab, var(--accent) 35%, transparent);

  /* 字段专用 */
  --field-radius: var(--r-md);
  --field-pad-y: 9px; --field-pad-x: 12px;
  --field-inset: inset 0 1px 2px rgba(0,0,0,.10);
  --field-focus-ring: 0 0 0 4px color-mix(in oklab, var(--accent) 35%, transparent);
}

/* ===== 亮色 ===== */
[data-theme="light"] {
  --bg: #ffffff;
  --bg-1: var(--bg);
  --bg-2: #f5f5f7;
  --bg-3: #ececef;
  --grad-a: #f5f5f7; --grad-b: #ffffff; --grad-c: #ebebf0;

  --fg: #1d1d1f;
  --fg-2: #424245;
  --muted: #6e6e73;

  --surface: rgba(255,255,255,0.62);
  --surface-2: rgba(0,0,0,0.04);          /* 字段表面（Apple 亮色微妙灰） */
  --field-bg: var(--surface-2);
  --solid-bg: var(--surface-2);

  --border: #d2d2d7;
  --border-soft: rgba(0,0,0,0.08);
  --glass-border: rgba(0,0,0,0.12);
  --field-border: var(--border);

  --accent: #0071e3;                       /* Apple 亮蓝 */
  --accent-rgb: 0,113,227;
  --accent-hover: #0077ed;
  --accent-active: #0066cc;
  --accent-on: #ffffff;
  --accent-2: #5e5ce6;
  --accent-3: #bf5af2;

  --ok: #34c759;   --ok-rgb: 52,199,89;
  --warn: #ff9f0a; --warn-rgb: 255,159,10;
  --err: #ff3b30;  --err-rgb: 255,59,48;

  --elev-raised: 0 12px 32px rgba(0,0,0,.08);
  --shadow-card: 0 8px 24px rgba(20,30,80,.10);
  --shadow-modal: 0 30px 80px rgba(20,30,80,.25);

  --modal-mask: rgba(20,24,55,0.40);
  --glass-modal-bg: rgba(255,255,255,0.62);
  --glass-modal-border: rgba(90,95,150,0.35);
  --glass-modal-divider: rgba(90,95,150,0.28);
  --glass-mask-bg: rgba(20,24,55,0.40);

  --switch-off: #c7c9d8;
  --switch-thumb: #ffffff;

  --field-inset: inset 0 1px 2px rgba(0,0,0,.06);
}
```

> 注：渐变 `--grad-a/b/c` 保留旧蓝或改为中性灰属美学微调（决策点，建议改中性灰更 Apple）。`--glass-border` 从 0.42 调柔到 0.18（暗）是可选优化，若担心动全局玻璃质感可维持原值，本规范不强求。

### A.3 字体阶梯
- 字号：`--fs-caption 12px` / `--fs-foot 13px` / `--fs-body 14px` / `--fs-title 17px` / `--fs-h3 20px` / `--fs-h2 22px` / `--fs-h1 28px` / `--fs-display 34px`
- 字重：`regular 400` / `medium 500` / `semibold 600` / `bold 700`
- 行高：标题 1.25、正文 1.5、密集列表 1.4
- 字体栈：见 A.2 `--mac-font`（Apple 优先，含中文回退 PingFang SC）

### A.4 间距阶梯
`--sp-1…--sp-8` = 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 px。组件内外边距一律引用，不再出现裸 `12px/14px/18px`。

### A.5 圆角阶梯
`--r-sm 8px`（badge/小控件）/ `--r-md 12px`（输入框/按钮/卡片内元素）/ `--r-lg 18px`（面板/卡片/弹窗）/ `--r-pill 999px`（胶囊按钮/状态标签/开关）。

### A.6 阴影 / 层级
`--elev-flat` / `--elev-ring`（1px 发丝）/ `--elev-raised`。现有 `--shadow-card` 归入 `--elev-raised` 体系；厚玻璃弹窗用 `--shadow-modal` + 顶部高光（保持不变）。

### A.7 焦点环
`--focus-ring: 0 0 0 4px color-mix(in oklab, var(--accent) 35%, transparent)`。表单控件 focus 用 `box-shadow` 叠加此环；全局 `:focus-visible` 维持 `outline: 2px solid var(--accent); outline-offset: 2px`（键盘可达性，与 Apple 一致）。**两处风格统一为 accent 色、4px 量级**。

### A.8 动效（统一时长 + 缓动）
- `--motion-fast 150ms`、`--motion-base 220ms`
- `--ease-standard: cubic-bezier(0.28,0.22,1)`（标准，无过冲，Apple 风格）
- `--ease-emphasized` 仅用于入场 `pop-in`
- **替换规则**：全局散落的 `transition: ... 0.2s ease` 一律改为引用 `--motion-base` + `--ease-standard`；spin/pop 等动画时长收敛到 150/220/500ms 档。

### A.9 语义色（决策点#4）
建议对齐 Apple：`--ok #34c759/#32d74b`、`--warn #ff9f0a/#ffd60a`、`--err #ff3b30/#ff453a`。`status-luxe.css` 的 `--st-*` 是独立命名空间，本次可暂不强制对齐（见 D 任务备注），但建议后续统一到同一语义色。

---

## B. 组件规范（每个：用途 + 结构 + 关键 CSS + 三模块必须一致）

### B.0 共享 / 保持不变清单（❗ 落地时严禁破坏，三模块已逐字节一致）
- `.icon-btn`（卡片 header 图标按钮槽）—— 保持
- `.btn-exec`（主操作胶囊，含 `.bx-ico/.bx-label/.bx-spin` 与 `is-loading`）—— 保持
- `.app-ico` / `.app-ico-lg` / `.logo .app-ico` —— 保持
- `.modal.glass`（厚玻璃 `backdrop-filter: blur(40px) saturate(2.0)` + 深色遮罩 + `.glass-mask`）—— 保持（用户指定「零回归」）
- 图标系统 `window.ICONS` / `ico()` / `hydrateIcons()`（1.75 描边线性风格）—— 保持
- `shared/macos-motion.css` 的 `pop-in` / `statusBreath` / `:focus-visible` / reduced-motion 护栏 —— 保持（仅把 `--dur/--ease-*` 指向新 token）

### B.1 按钮
| 类型 | 类 | 规范 |
|------|----|------|
| 主操作（全宽渐变胶囊） | `.btn` | 保持现状（渐变 + 阴影 + hover 抬升），**但** `transition` 改 `--motion-base`/`--ease-standard`；圆角统一 `--r-lg`。 |
| 主操作（内联胶囊，推荐用于新代码） | `.btn-exec` | **保持**（已是规范）。 |
| 次操作 | `.btn.ghost` | 保持玻璃质感；圆角 `--r-md`。 |
| 图标按钮 | `.icon-btn` | **保持**。 |
| 文字按钮 | `.text-btn` | **新增**：无边框无底，仅 accent 文字 + hover 下划线/变色，`padding: 6px 8px`，用于「仅重传封面」「清空」等低强调动作（替代部分 `.clear-input` 滥用）。 |

> 统一：所有按钮 `:active` 用 `transform: scale(.97)`（已有）；loading 文案统一「执行中…」（已有）。

### B.2 表单控件（**重点：修复「太突兀」**）
#### 现状问题（逐条，对应 0.3 #①）
1. **背景饱和实色**：`--field-bg: var(--bg-2)` → 暗 `#222a52`／亮 `#e9edfb`，是不透明的饱和色，与半透明磨砂面板冲突 → 像实色块。
2. **边框过亮**：`border: 1px solid var(--glass-border)`，`--glass-border` 暗 `rgba(255,255,255,.42)` → 高亮白边，强对比，割裂。
3. **圆角矛盾**：generic `12px`（biliup L83 / netdisk L87）vs `.field` 作用域 `10px`（biliup L546）vs `macos.css` 覆盖 `10px`（L437/503）。三处不一致。
4. **padding 矛盾**：`12px 14px`（generic）vs `9px 12px`（`.field`）。
5. **select 箭头缺失**：仅 biliup 的 `.field select` 有 `appearance:none`+SVG 箭头；kdocs（无 select）、netdisk 的 `.field` 无此覆盖 → netdisk 复制弹窗的 `textarea`/潜在 select 用 generic 突兀样式。
6. **内阴影缺失**：仅 biliup `.field` 有 `inset 0 1px 2px`；generic 无。
7. **focus 环量级不一**：generic/`.field` 用 `0 0 0 3px rgba(accent,.25)`；全局 `:focus-visible` 用 `outline 2px`。

#### 目标值（统一为单一全局规则，覆盖 generic + `.field` 旧写法）
```css
/* —— 统一表单控件：半透明微妙表面 + 发丝边 + 12px 圆角 + 内阴影 + 4px 焦点环 —— */
input[type="text"], input[type="password"], input[type="number"],
input[type="datetime-local"], select, textarea {
  width: 100%;
  padding: var(--field-pad-y) var(--field-pad-x);   /* 9px 12px */
  border-radius: var(--field-radius);               /* 12px */
  border: 1px solid var(--field-border);            /* 发丝边 #3a3a3c / #d2d2d7 */
  background: var(--field-bg);                       /* 微妙半透明 surface-2 */
  color: var(--fg);
  font-size: 14px; line-height: 1.5;
  outline: none;
  box-shadow: var(--field-inset);
  transition:
    border-color var(--motion-base) var(--ease-standard),
    box-shadow   var(--motion-base) var(--ease-standard),
    background    var(--motion-base) var(--ease-standard);
}
input:focus, select:focus, textarea:focus {
  border-color: var(--accent);
  box-shadow: var(--field-inset), var(--field-focus-ring);  /* 4px 半透明 accent 环 */
}
textarea { resize: vertical; min-height: 84px; font-family: var(--mono-font); font-size: 13px; }
textarea::placeholder, input::placeholder { color: var(--muted); opacity: .8; }

/* select 统一去原生箭头 + 灰色 chevron（三模块一致） */
select {
  appearance: none; -webkit-appearance: none;
  padding-right: 34px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%2398989d' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
}
/* checkbox/radio 统一 accent 着色（已有 .modal-check / .provider-check 沿用） */
input[type="checkbox"], input[type="radio"] { accent-color: var(--accent); }
```
**删除**各模块旧的 `:root{--field-bg:var(--bg-2)}`、generic `input/select/textarea` 块、`.field input/select/textarea` 块、`macos.css` 里的 `input/select/textarea{border-radius:10px}` 覆盖（统一由上述规则管理）。效果：字段变为面板上的微妙凹陷，与 Apple 一致，突兀问题根除。

### B.3 卡片 / 面板
- `.panel`（biliup/kdocs/netdisk）：**已一致**（圆角 22px、玻璃、内顶高光）。统一圆角到 `--r-lg`(18px)，边距 `--sp-6`(24px)，标题 `::before` 强调条保留。`box-shadow` 归 `--shadow-card` + 顶部 inset 高光。
- `.card`（netdisk 账号卡）：圆角 `--r-lg`，玻璃，`--shadow-card`。与 `.panel` 同语言。
- 三模块 `.panel h2` 字体/间距已一致，仅圆角 22→18 微调。

### B.4 弹窗
- **厚玻璃 `.modal.glass`**：**保持**（blur 40px saturate 2.0，零回归）。用于：biliup 高级参数/投稿历史、kdocs 录入历史、netdisk 转存历史/格式化。
- **普通弹窗 `.modal`**（统一修复 0.3 #②）：三模块均改为**轻玻璃** `background: var(--surface)` + `backdrop-filter: blur(20px) saturate(160%)` + `--shadow-modal` + 圆角 `--r-lg`(18px)。**废除** biliup/netdisk 的 `background: var(--bg-2)` 实色写法、kdocs 的 `blur(24px)` 写法，统一到 `blur(20px)`。遮罩 `.modal-mask` 统一 `background: var(--modal-mask)` + `blur(6px)`（biliup/netdisk 已用 `--modal-mask`；kdocs 的 `rgba(0,0,0,.55)` 改为 `--modal-mask`）。
- `.modal-head` / `.modal-close` / `.modal-actions` / `.modal-body` 三模块结构已近似，统一类命名字形（见 D 任务⑤）。

### B.5 Toast（统一修复 0.3 #③）
**采用 biliup 的 `.toast-host` 玻璃方案为唯一标准**，kdocs 重写、netdisk 新增：
```html
<div class="toast-host" id="toastHost"></div>
```
```css
.toast-host { position: fixed; left:50%; bottom: var(--sp-7); transform: translateX(-50%);
  display:flex; flex-direction:column; gap: var(--sp-3); align-items:center; z-index:100; pointer-events:none; }
.toast { pointer-events:auto; max-width:80vw; padding: 10px 18px; border-radius: var(--r-md);
  font-size:14px; font-weight:600; color: var(--fg);
  border:1px solid var(--glass-border); background: var(--surface);
  backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%);
  box-shadow: var(--shadow-card), inset 0 1px 0 rgba(255,255,255,.10);
  display:flex; align-items:center; gap:8px; }
.toast .toast-ico { width:16px; height:16px; flex:none; }
.toast.toast-out { opacity:0; transform: translateY(8px);
  transition: opacity var(--motion-base) var(--ease-standard), transform var(--motion-base) var(--ease-standard); }
```
JS：统一 `toast(msg, type)` 工厂（参考 biliup `app.js` L71-95），3s 自动消失、复用 `pop-in`。netdisk 删除 `.banner` 的「成功/失败」提示改用 toast（或保留 banner 仅作授权回调横幅，业务结果走 toast——见决策点）。

### B.6 Empty-state（已一致，保持）
`.empty-state, .empty, .history-empty` 三模块规则一致（居中、`.es-ico` 28px、`.es-ico` 用 `ico()` 注入 SVG）。保持，仅统一 `padding: var(--sp-7) var(--sp-3)`。

### B.7 Toggle 开关（统一修复）
现状：biliup 用 `macos.css` 的 `.switch input`（38×22，半透明 accent 0.30 底）；netdisk 用本地 `.switch`（40×22，实色 `--switch-off`）；kdocs 无 switch。
**统一**到一套（写入共享，删 netdisk 本地 `.switch`）：
```css
.switch { display:flex; align-items:center; gap: var(--sp-3); }
.switch input { appearance:none; width:40px; height:24px; border-radius: var(--r-pill);
  background: var(--switch-off); position:relative; cursor:pointer;
  transition: background var(--motion-base) var(--ease-standard); }
.switch input:checked { background: var(--accent); }
.switch input::after { content:""; position:absolute; width:20px; height:20px; border-radius:50%;
  background: var(--switch-thumb); top:2px; left:2px; transition: left var(--motion-base) var(--ease-standard);
  box-shadow: 0 1px 3px rgba(0,0,0,.3); }
.switch input:checked::after { left:18px; }
```

### B.8 Tab（仅 netdisk 用，规范化为共享）
`.tab` / `.tab.active` 已定义良好。提取为共享规则：圆角 `--r-md`、未选 `--muted`、选中 `background: color-mix(in oklab,var(--accent) 18%, transparent)` + `border-color: var(--accent)` + `color: var(--fg)`。biliup/kdocs 若后续引入 tab 直接复用。

### B.9 Tooltip
新增 `.tooltip`：纯 CSS（`:hover` + `::after` 或 `data-tip`），`background: var(--surface)`、`--r-sm`、小字 12px、`box-shadow: var(--shadow-card)`、`backdrop-filter: blur(12px)`。替代散落的 `title=` 与手写 hint。

### B.10 进度条 / Spinner
- `.spinner`（kdocs `0.8s` / biliup `.bx-spin 0.7s`）：统一 `--motion-base` 不适用，spinner 用 `0.7s linear infinite`（保留），但**时长收敛为单一值**，去 `0.8s`。
- 进度条 `.progress`：新增线性进度条 `height:4px; border-radius:var(--r-pill); background:var(--border-soft); > .bar{background:var(--accent)}`，用于长任务（如 netdisk 批量转存）。

### B.11 Badge / 状态胶囊
- `.badge`（netdisk 已有 ok/fail）：统一 `font-size:11px; padding:2px 8px; border-radius:var(--r-sm)`；颜色用语义色半透明底（同 status-luxe 思路）。
- 状态胶囊 `.st-luxe`（status-luxe.css，三模块副本一致）：**保持**。决策点#4：可选将 `--st-*` 对齐 Apple 语义色（本次不强制）。

---

## C. 文案一致性审计

| 位置 | 当前文案（模块） | 建议统一文案 | 理由 |
|------|------|------|------|
| 文件/目录选择按钮 | 「浏览」(biliup 选视频) / 「选择」(kdocs 封面目录) / 「选择目录」(netdisk) | **统一为「选择」**（或「选取」）。文件=「选择文件」，目录=「选择文件夹」 | 同义动作三词并存，Apple 用「选择/选取」 |
| 版本徽章占位 | 「v—」(biliup/netdisk) / 「v?」(kdocs) | **统一「v—」**（或「v?」二选一，建议「v—」） | 同一组件两种占位 |
| 探活中提示 | 「检测中…」(biliup/kdocs) / 「检查中…」(netdisk 卡片) | **统一「检测中…」** | 同义 |
| 历史弹窗标题 | 「投稿历史」(biliup) / 「录入历史」(kdocs) / 「转存任务历史」(netdisk) | **统一为「[动作]历史」**：biliup=投稿历史、kdocs=录入历史、netdisk=**转存历史**（去「任务」） | 保持分领域前缀，但 netdisk 多出的「任务」破坏 `[动作]+历史` 模式 |
| 空状态（历史） | 「还没有投稿记录」/「还没有录入记录」/「还没有转存记录」 | **保持**（已一致模式） | 良好，保留 |
| 空状态（筛选） | netdisk：「暂无成功的转存」/「暂无异常的转存」 | 统一「暂无成功的转存」/「暂无异常的转存」/「还没有转存记录」 | 已较一致 |
| 主操作 loading | 「执行中…」(三模块一致) | **保持** | 已统一，良好 |
| 清空按钮 | 「清空」(三模块) | **保持** | 已统一 |
| 取消按钮 | 「取消」(三模块) | **保持** | 已统一 |
| 确认主按钮 | 「确认投稿」(biliup) /「继续」(kdocs 重复确认) /「选择此目录」「确认复制」(netdisk) | **保持语义化**（按上下文不同合理） | 不应强行统一，保留动作准确性 |
| 授权/登录 | 「登录B站」(biliup) /「授权XX网盘」(netdisk) | **保持** | 领域术语正确 |
| app.js 内文案（toast/日志） | 「参数已保存」「保存失败」「转存选中并生成分享」「一键执行」等 | **保持**（已是各模块业务语言）；仅将散落的「浏览/选择」类按钮文案按上表修正 | — |

> 文案统一原则：**动作动词（选择/清空/取消/执行中）与占位符（v—/检测中）强制统一**；**业务名词（投稿/录入/转存、登录/授权）保留领域语义**，仅修正破坏统一模式的冗余词（如 netdisk「任务历史」→「历史」）。

---

## D. 任务分解（有序落地，含文件 / 依赖 / 验收）

> 约束：所有任务**保持 B.0 清单不变**（厚玻璃、`.icon-btn`、`.btn-exec`、`.app-ico`、图标系统、macos-motion 的 reduced-motion 护栏）。
> 涉及文件：`biliup-hub/public/{index.html,app.js}`、`kdocs-tool/public/{index.html,app.js}`、`netdisk-hub/public/{index.html,app.js}`（三模块同改）。

**T01 · 统一 `:root` Token（三模块）**
- 文件：三模块 `index.html` 内联 tokens 块（替换 `shared/tokens.css` 内联段）
- 依赖：无
- 内容：落地 A.2 完整 `:root` + 别名；强调色按决策点#1（统一 Apple 蓝，`--accent-2/3` 留品牌渐变）；语义色按 A.9；新增 `--surface-2/--border/--field-*/--r-*/--sp-*/--motion-*/--ease-*/--focus-ring`。
- 验收：三模块 `:root` 逐字节一致（忽略 `--accent-2/3` 品牌值）；旧名查询均解析；`npm run verify:build` 通过（若改动 shared/）。**保持**厚玻璃/图标 token 不变。

**T02 · 统一按钮体系**
- 文件：三模块 `index.html` 按钮样式块 + `app.js`（新增 `.text-btn` 用法）
- 依赖：T01
- 内容：`.btn`/`.btn.ghost`/`.auth-btn` 圆角→`--r-lg`/`--r-md`，transition→`--motion-base`/`--ease-standard`；新增 `.text-btn` 规范；`.btn-exec`/`.icon-btn` **保持**。
- 验收：三模块按钮类名/CSS 一致；`.btn-exec`/`.icon-btn` 字节不变。

**T03 · 统一表单控件（重点修突兀）** ⭐
- 文件：三模块 `index.html`（删旧 generic/`.field` input 块、`macos.css` 的 `input{border-radius:10px}` 覆盖、`--field-bg:var(--bg-2)`）；落地 B.2 统一规则
- 依赖：T01
- 内容：单一全局 `input/select/textarea` 规则（surface-2 底 + 发丝边 + 12px + 内阴影 + 4px 焦点环 + select 灰色 chevron）；删 netdisk 复制弹窗 textarea 的突兀样式、biliup `.field` 旧写法。
- 验收：**核心**：暗/亮下字段背景为微妙半透明（不再饱和实色 `#222a52`/`#e9edfb`）；边框为发丝色（不再亮白 0.42）；select 三模块均有灰色箭头；圆角/padding 三模块一致；focus 环 4px。

**T04 · 统一卡片 / 面板**
- 文件：三模块 `index.html` `.panel`/`.card` 块
- 依赖：T01
- 内容：圆角→`--r-lg`(18px)；box-shadow→`--shadow-card`+顶部 inset；边距→`--sp-6`；`.panel h2` 保持强调条。
- 验收：三模块面板视觉一致；无 22px/18px 混用。

**T05 · 统一弹窗 / Toast / Empty / Toggle / Tab**
- 文件：三模块 `index.html`（`.modal`/`.modal-mask`/`.toast*`/`.switch`/`.tab`）+ `app.js`（toast 工厂、netdisk 加 toastHost、kdocs 重写 toast）
- 依赖：T01、T02
- 内容：普通 `.modal` 统一轻玻璃 `blur(20px)`（废除 biliup/netdisk 实色 `bg-2`、kdocs `blur(24px)`）；`.modal-mask` 统一 `--modal-mask`+`blur(6px)`；Toast 统一 biliup `.toast-host` 方案（kdocs 重写、netdisk 新增）；`.switch` 统一（删 netdisk 本地）；`.empty-state` padding 统一；`.tab` 提取共享。
- 验收：三模块普通弹窗同为轻玻璃；Toast 三模块行为/外观一致；netdisk 能弹 toast；switch 尺寸/配色一致。

**T06 · 统一动画变量（替换散落时长/缓动）**
- 文件：三模块 `index.html` 内联 `<style>` + `macos-motion.css` 内联段
- 依赖：T01
- 内容：把硬编码 `0.2s ease`/`0.28s` 等替换为 `--motion-base`/`--motion-fast` + `--ease-standard`；spin 时长收敛为单一 `0.7s`；`--ease-spring` 仅在 `pop-in` 入场使用，`hover/transform` 改用 `--ease-standard`（去 Apple 不用的过冲，决策点#3）；reduced-motion 护栏**保持**。
- 验收：全局 transition 无裸 `0.2s`/`0.28s`；入场动画保留、hover 无突兀过冲。

**T07 · 文案统一（HTML + app.js）**
- 文件：三模块 `index.html` 文案 + `app.js` 字符串
- 依赖：无（可并行）
- 内容：按 C 表修正：选择按钮（浏览→选择/选择文件夹）、版本徽章（v?→v—）、探活（检查中→检测中）、netdisk 历史标题（转存任务历史→转存历史）。app.js 内对应字符串同步。
- 验收：三模块同义动作/占位词一致；业务名词保留领域语义。

**T08 · 暗色模式 Token 校验（回归）**
- 文件：三模块 `index.html` `[data-theme="light"]` 段
- 依赖：T01–T07
- 内容：校验亮/暗双套 token 完整、别名解析、厚玻璃/焦点环/表单控件在亮色下可读（白字 on 暗玻璃、暗字 on 亮玻璃）；跑 `prefers-reduced-motion`/`prefers-reduced-transparency` 护栏。
- 验收：亮/暗切换无对比失效；B.0 清单字节不变；`npm run verify:build` 全绿。

> 依赖图：T01 → {T02,T03,T04,T05,T06}；T02→T05；T07 独立；T08 最后。T05 内部 Toast 依赖 T01/T02。

---

## E. 测试架构建议（给 QA）

结合 GitHub 最佳实践：Electron 用 **Playwright `_electron.launch()`** 做 E2E，纯逻辑用 **Vitest**。

### E.1 工程建议
- 测试目录：`test/e2e/`（Playwright）、`test/unit/`（Vitest）。
- `test/unit/`：`parseBatch`/`formatPost`/`parseInput` 等纯函数（netdisk/kdocs `app.js`）抽为可 import 模块（当前是 IIFE/全局，需轻量重构或挂 `window.__test`）。
- `test/e2e/`：用 `const { _electron: electron } = require('playwright'); const app = await electron.launch({ executablePath, args:['--remote-debugging-port=0'] }); const page = await app.firstWindow();`

### E.2 三模块核心 E2E 测试点
**通用（每模块）**
1. 窗口加载：页面 `domcontentloaded`，无 `pageerror`、无 console error（忽略 favicon）。
2. 关键元素存在：`.panel`×N、`.btn-exec`、`.icon-btn`、`.toast-host`。
3. 主题：注入 `data-theme="light"` 后断言表单控件背景为半透明（非 `#222a52`/`#e9edfb` 饱和实色）——**直接验证 T03 修复**。
4. 主要按钮可点：`.btn-exec` click 触发 loading（`is-loading` + 文案「执行中…」）。
5. 表单可填：输入框 `fill` 后断言 `value`；select `selectOption` 后箭头仍可见、无原生丑箭头。
6. 弹窗：点击历史图标 → `.modal.glass.show` 可见；遮罩 `blur(40px)` 生效（computed style 校验）。
7. 动画：断言无 console 报错；reduced-motion 下 transition/animation 时长≈0。

**biliup-hub**
- 选视频（mock `electronAPI.pickFile`）→ 标题回填；投稿二次确认弹窗 → 确认触发 SSE mock → 历史写入 localStorage（`toolshub:history:biliup`）。
- 扫码登录弹窗渲染、厚玻璃高级参数弹窗字段样式（surface-2）。

**kdocs-tool**
- 一键执行按钮 → 重复确认弹窗（dup）互斥勾选逻辑；Toast 重写后行为（3s 消失、玻璃外观）。
- AI 掉线 banner 显隐（mock `/api/check` 跳变）。

**netdisk-hub**
- 目录选择弹窗（mock `/api/dirs`）渲染 + 面包屑；复制本组弹窗；**Toast 新增后**能弹（替代 banner 业务提示）。
- 批量转存（mock `/api/transfer/batch`）→ 结果卡片 + 一键复制。

### E.3 视觉回归（建议）
- 用 Playwright `toHaveScreenshot` 对三模块亮/暗各截关键视图，CI 比对（阈值 0.2），防样式回归，尤其保护厚玻璃与表单控件修复。

### E.4 mock 策略
- Express 子服务接口用 `page.route('**/api/**', route => route.fulfill({json}))` 注入确定性响应；SSE 用 `route.fulfill({body: 'data: ...'})` 分片模拟。

---

## 决策点汇总（需主理人拍板或工程师按建议执行）
1. **强调色**：建议交互控件统一 Apple 蓝（`#0071e3`/`#0a84ff`），`--accent-2/3` 仅留作分模块 logo 渐变（biliup 粉/青，其余紫/青）。若坚持保留分模块品牌强调色，则仅 `--accent` 用于品牌、控件改用 Apple 蓝——二选一，建议前者。
2. **普通弹窗**：统一轻玻璃 `blur(20px)`（用户已指定）；厚玻璃仅重模态。
3. **动效**：去 hover/transform 的 spring 过冲，统一 `--ease-standard`（Apple 无过冲）；`pop-in` 入场可保留轻微强调缓动。
4. **语义色**：主 `--ok/--warn/--err` 对齐 Apple；`status-luxe` 的 `--st-*` 本次可选对齐。
5. **netdisk banner**：业务成功/失败提示迁到 Toast（保持 banner 仅作 OAuth 回调横幅），以统一轻提示体验。
6. **渐变底色**：旧蓝渐变改为中性灰更 Apple，属美学微调，不阻塞统一。
