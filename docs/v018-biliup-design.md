# v018 — biliup-hub 投稿设置增强 + 统一弹窗机制

> 范围：仅 biliup-hub 侧。未触碰 `lib/biliup.js` / `command.js` / `task.js`（P03 已提交 2c4a0f2）。
> 未修改任何 `package.json` version（主理人统一 bump）。未引入新 npm 依赖。未自行 commit/tag/push。

## 一、任务分解

### A. P04 ｜ B站投稿设置
| 编号 | 类型 | 问题 / 需求 | 根因 | 修复 |
|---|---|---|---|---|
| A1 | Bug | 设置不持久化：关掉重开要重选 | `store.js` 的 `mergeDefaults` 用 `Number(x) || def` 把合法 `0` 值（如 `noReprint=0`）误改写；且 `saveConfig` 走异步 `scheduleWrite`，快速关闭存在丢写风险 | 见 A3 根因修复 + `saveConfig` 改为同步原子刷盘 |
| A2 | 新需求 | 保存设置时弹轻量 Toast 提示 | 无 | 新增 `toast(msg)`：明暗自动适配、`pop-in` 入场、3s 自动淡出 |
| A3 | Bug | 转载保存回弹：选「禁止转载/自定义」保存后变回「允许转载」 | v0.1.65 仅修了前端 `coerceInt`/`selectPreserve`，但**服务端 `store.mergeDefaults` 的 `Number(out.noReprint) || def.noReprint` 仍把 `0` 改写成 `1`**——这是遗留盲区 | `store.js` 新增安全 `toInt()` 保留 `0`；前端 `coerceInt` 已正确，回填 `selectPreserve(cfgNoReprint, 0)` 正确 |
| A4 | 新需求 | 高级参数改为「点击小按钮弹出独立弹窗页」，关闭后回到投稿设置页 | 原为内联折叠 `advBody` | 高级参数整块移入 `openModal` 弹窗 `#advMask`；`advToggle` 改为打开弹窗；`#advClose`/遮罩点击关闭回到原页 |

### B. P06 ｜ 视频选择「清空选择」按钮
- 浏览选视频后显示「🗑️ 清空选择」按钮；点击清空已选文件状态（`selectedVideo`/`videoName`/`titleInput`/`submitHint`）并隐藏按钮，回到初始态。

### C. P09 ｜ biliup 侧弹窗来去一致（基座）
- 封装 `openModal(modalEl)` / `closeModal()`：打开记录当前浮层、关闭即隐藏浮层回到下层原页（不切路由、不重置表单）。
- A4 高级设置弹窗、二次确认弹窗、扫码登录弹窗全部接入该统一机制。
- 入场复用内联 `pop-in`（来自 `macos-motion.css`），不修改共享 keyframes；`prefers-reduced-motion: reduce` 下由全局媒体查询自动降级关闭。

## 二、P09 统一弹窗约定（biliup 侧必须遵守）
- 函数签名：`openModal(el)` 显示浮层、`closeModal()` 隐藏并返回原页。
- 关闭逻辑：隐藏 modal 即可回到下层原页（不切换路由、不重置表单），保证「从哪里来回哪里去」。
- 入场复用内联 `pop-in`（来自 macos-motion.css），不修改共享 keyframes。
- DOM `id` 保持原样；复用现有 `var(--bg-2)` 等主题 token；明暗自动适配。
- 未来新增弹窗：直接 `openModal($("xxxMask"))` + 一个关闭按钮/`closeModal()` + 遮罩点击关闭即可复用。

## 三、关键设计决策
1. **store 安全整数解析 `toInt()`**：`空串/null/非有限数 → 默认值`，否则原样返回（含 `0`）。修复 `noReprint=0` 被 `||` 陷阱改写。
2. **同步原子刷盘**：`saveConfig` 直接调用 `flushWrite()`（tmp 写 + rename），保存即落盘，消除「关掉重开 settings 丢失」。移除无用的异步 `scheduleWrite`/`writeQueue`/`writeScheduled`。
3. **Toast 自适应图标**：`toast(msg)` 以消息是否以 `❌` 开头切换图标（✅/❌），保持单一 `msg` 入参；`textContent` 赋值避免 XSS。
4. **高级参数弹窗内容**：完整保留原高级块（分区/合集/分集/线路/UID/版权/转载/固定简介/置顶评论/cookiesKPI/保存按钮），仅从内联折叠迁移为独立浮层；`saveCfgBtn` 的 `id` 不变，既有事件绑定继续生效。
5. **统一机制复用**：`confirmMask`/`loginMask`/`advMask` 共用 `openModal/closeModal`；`loginMask` 关闭仍由 `stopLogin` 清理轮询定时器后调用 `closeModal`。

## 四、改动文件清单
| 文件 | 改动 |
|---|---|
| `biliup-hub/lib/store.js` | 新增 `toInt()`；`mergeDefaults` 4 处 `Number(x)\|\|def` → `toInt`；`saveConfig` 改同步 `flushWrite`；删除死代码 `scheduleWrite`/`writeQueue`/`writeScheduled` |
| `biliup-hub/public/index.html` | 新增 toast CSS + 本地 `@keyframes pop` + `.modal-body` 滚动样式；选择视频卡加 `clearBtn`；`advBody` 内联块移除，新增 `#advMask` 高级弹窗 + `#toastHost` |
| `biliup-hub/public/app.js` | 新增 `toast()`、`openModal()`/`closeModal()`；`pickBtn` 显示 `clearBtn`；新增 `clearBtn` 清空逻辑；`saveCfgBtn` 保存后 `toast()`；`advToggle`→`openModal(advMask)` + `advClose`/遮罩关闭；`openConfirm`/`openLogin` 改用 `openModal`，`stopLogin`/`closeConfirm` 改用 `closeModal` |

未改动：`lib/biliup.js` / `command.js` / `task.js` / `select-preserve.js` / `coerce-int.js` / 任何 `package.json`。

## 五、全局一致性审查
- `index.html` 与 `app.js` 的 DOM `id` 一一对应：`advMask`/`advClose`/`cfgTid`/`cfgSeason`/`cfgSection`/`cfgLine`/`cfgUid`/`cfgCopyright`/`cfgNoReprint`/`cfgDesc`/`cfgComment`/`cookiesKpi`/`saveCfgBtn`/`toastHost`/`clearBtn` 均存在且唯一。
- `loadConfig` 回填 `selectPreserve($("cfgNoReprint"), cfg.noReprint)` 与保存 `coerceInt($("cfgNoReprint").value, 1)` 值映射一致（0=禁止转载，1=允许转载）。
- `openModal/closeModal` 单例 `activeModal` 管理，确认/登录/高级三类弹窗均正确开关且不丢上下文。
- `node --check` 通过；`store` 保存→重载 `noReprint=0` 往返测试 PASS。

## 六、IS_PASS
**IS_PASS: YES**

## 七、遗留项
- 投稿标题 `titleInput` 与标签 `tagsInput` 仍按既有设计（每次投稿由文件名/自动生成）**不写入 config**，关闭重开不还原——属 P04 原始设计范畴，非本次 Bug 范围；如需要可后续单独评估持久化。
- `toast` 仅单条堆叠（3s 各自独立淡出），未做队列去重；当前使用频率低，足够。
