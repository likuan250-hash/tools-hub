## 改动说明
<!-- 一句话讲清楚这次 PR 做了什么、为什么 -->

## 关联
<!-- 关联的 issue / 需求 / 复盘文档，如 docs/postmortem-xxx.md -->

## 改动类型
- [ ] 功能
- [ ] Bug 修复
- [ ] 构建/打包/CI
- [ ] 样式/主题
- [ ] 重构
- [ ] 文档/流程

## 自测清单（作者勾选）
- [ ] 核心路径已手测
- [ ] 改动涉及构建/打包：本地 `npm run build` 成功，且 `npm run verify:build` 全绿
- [ ] 改动涉及子工具前端（kdocs/netdisk）：装包后打开对应卡片页面确认样式正常
- [ ] 改动涉及样式/主题：装包实测入口页文字清晰、🌗 可切换明暗
- [ ] 无 `.masterkey` / `.env` / 凭证进 git，无明文 secret
- [ ] ESLint 无 error（pre-commit 的 lint-staged 已自动跑）

## 给评审者的提示
<!-- 哪些文件是重点、有没有需要特别关注的风险点 -->

## 评审要点（参考 docs/CODE_REVIEW_CHECKLIST.md）
- [ ] 构建/产物：新增静态资源目录是否进了 `build.files`？新增 `@import`/资源引用装包后是否可达？
- [ ] 错误处理：异步/子进程失败是否被处理，不会静默吞错？
- [ ] dev/prod 一致性：是否提醒"装包实测"，而非只本地 `npm start`？
