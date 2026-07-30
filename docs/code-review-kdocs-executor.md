# 代码评审 + 重构演练：kdocs-tool 录入链路

> 日期：2026-07-30 ｜ 评审人：资深开发（带练）｜ 对象：`kdocs-tool/lib/executor.js`、`ai.js`、`parser.js`
> 关联：`docs/RELEASE_CHECKLIST.md`、`docs/CODE_REVIEW_CHECKLIST.md`、`docs/postmortem-packaging-black-screen.md`

## 一、背景

`autoExecute` 是从"粘贴文本 → 解析 → bl 生成介绍/封面 → 写入金山文档多维表"的编排主链路，历史迭代多、分支多（查重/强制新增/更新链接/正常创建），是团队最常改、也最容易埋坑的模块。本次以它做一轮真实评审 + 小规模重构演练，目标是**把"资深怎么看代码、怎么安全地改"示范给团队**。

## 二、评审发现（按严重级别）

| 级别 | 位置 | 问题 | 影响 |
|---|---|---|---|
| **P0** | `executor.js:271` | `success = steps.every(s => 成功\|\|跳过)`，封面下载失败记为`跳过`，三路封面全挂仍判 `success:true` | 用户以为录入成功，实际记录无封面 |
| **P0** | `executor.js:247` | 附件上传失败（`objectId=null`）时 `if(objectId && coverPath)` 直接跳过，封面不入字段但流程仍 success | 静默丢封面，与 P0 同类 |
| **P0** | `executor.js:122` | 更新网盘链接失败，`success:false` 却写 `action:"updated"` | 前端误判"已更新" |
| **P1** | `executor.js:24` 与 `ai.js:79` | `INTRO_BLACKLIST`/`isBadIntro` 定义两份；executor 又对 `aiRes.intro` 二次黑名单校验，但 `aiDescribe` 已把 bad 兜底成 `rawLine`，该层永远测不到 bad | 重复且误导，改一处易漏另一处 |
| **P1** | `executor.js:235-252` | `buildRecordFields` 内联在主流程，不可单测 | 核心字段组装无测试保护 |
| **P2** | `executor.js:33` | `findExistingRecord` 的 `while(true)` 仅靠 `detail.offset` 终止，API 异常持续返回 offset 则无限翻页 | 进程卡死风险 |
| **P2** | `executor.js` | 主流程混用注入的 `deps.fs.statSync` 与全局 `path` | 破坏依赖注入一致性 |

## 三、本次落地的重构（已合并，全部有单测守护）

1. **抽单一真源 `lib/constants.js`**：导出 `INTRO_BLACKLIST / SIZE_EMPTY / isBadIntro / isBadSize`；`executor` 与 `ai` 共用，**删除 executor 中重复定义**，并删掉对 `aiRes.intro` 的无效二次黑名单校验（信任 `aiDescribe` 兜底，用 `isBadIntro` 统一口径）。
2. **抽纯函数 `buildRecordFields` / `resolveGameSize`**：fields 组装与游戏大小优先级从主流程抽出，成为不依赖外部 IO 的纯函数，可直接单测。
3. **修 `action` 语义 bug**：更新失败分支 `action: "updated"` → `"update_failed"`，与 `success:false` 一致，前端不再误判。
4. **`findExistingRecord` 加 `MAX_PAGES = 50` 上限**：防 API 异常导致无限翻页。

## 四、待拍板项（业务决策，未擅改）

> 资深的分寸：**涉及"失败是否整体失败"这类业务语义，交给甲方拍板，不替业务做未授权决策。**

- **P0-1（封面全失败是否整体失败）**：当前 `executor.test.js` 已有 `需求GAP` 测试明确记录该已知行为。推荐方案：**封面三路全失败时，将 `success` 置 false 并附 `coverMissing:true` 标志**，让前端/日志显式可知，而不是静默创建无封面记录。需你确认是否采用。
- **P0-3（附件上传失败是否阻断）**：推荐方案：上传失败时显式 `fail` 该步骤并提示用户"封面上传失败"，而非悄悄落无封面记录。

## 五、测试覆盖

`kdocs-tool/test/executor.test.js` 新增 5 例：
- `resolveGameSize` 优先级（夸克 > ai > parsed > 空）
- `buildRecordFields` 正常组装（网盘链接 + 封面对象）
- `buildRecordFields` 无 `objectId` 不带封面对象、无大小不写字段
- `findExistingRecord` 持续 offset 不超过 50 页（防死循环）
- 更新失败 → `success:false` 且 `action:update_failed`

结果：`npm test` → **50 passed / 0 failed / 3 skipped**（基线 45+3，新增 5 例全绿）。

## 六、给团队的原则（本次演练提炼）

1. **单一真源**：同一常量/规则只定义一处，谁要用就 import，杜绝"改 A 漏 B"。
2. **纯函数优先**：把"算字段、算优先级"这类逻辑抽成无 IO 的纯函数，可单测、可复用、易读。
3. **返回状态语义要诚实**：`success:false` 就不要标 `action:"updated"`；状态机里每个值都要有唯一、准确的含义。
4. **循环必须有上限**：任何 `while(依赖外部)` 都要有最大次数/超时保护。
5. **业务语义变更需拍板**：技术债能修就修，但"失败算不算失败"是产品决策，工程师应提出方案并标注，不越权改。
