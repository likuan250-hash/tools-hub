# tools-hub 接管说明（HANDOFF）

> 给另一台电脑 / 另一个 Codex agent 的接管文档。先读这一份 + `README.md`，再进代码。
> 本文件从 v2.7.26 起重写，内容与当前代码一致；旧版（v0.1.36 时代）内容已清理。

## 0. 一句话

「工具箱 ToolsHub」= Electron 桌面壳 + 四个本地 Express 子服务：

| 子服务 | 端口 | 职责 |
|---|---|---|
| kdocs-tool | 3599 | 金山文档多维表自动录入（Steam 官方介绍/封面） |
| netdisk-hub | 3000 | 百度/夸克/迅雷网盘转存中转 |
| biliup-hub | 3600 | B站自动投稿（扫码登录/上传/合集/置顶评论） |
| material-hub | 3700 | 素材搜集（官方封面 + 宣传片落盘） |

单安装包、单窗口多标签：`main.js` fork 四个子进程，渲染进程用 `<webview>` 内嵌各服务页面。

## 1. 仓库与路径

- 仓库：`https://github.com/likuan250-hash/tools-hub.git`
- **必须克隆到纯英文路径**（历史教训：中文路径在沙箱 git 下会出现 "not a git repository"）。
- 当前基线：`main` @ `34ac8ed`，版本 **v2.7.26**（tag 已推，CI 构建发布中）。
- 本次交接的工作克隆：`E:\New project\tools-hub`（干净工作区）。

## 2. 架构速览

- `main.js`：Electron 主进程——单实例锁、fork/看门狗/端口防抢占、自动更新、数据目录注入。
- `renderer/`：入口页 + 标签栏 + webview 容器；`preload.js` / `webview-preload.js` 提供有限原生能力（选目录/选文件/开外链）。
- 四个子服务统一约定（改任何一个都要保持一致）：
  - 只绑 `127.0.0.1`；
  - 同源 CSRF 校验（`Origin` hostname 白名单，防跨站写请求）；
  - `/api/version` 回显 `bootToken`（主进程据此判断端口归属）；
  - 健康探活用 `/api/version`（不要用 `/api/health` 做看门狗探活）。
- 版本单一真源：各子服务 `getVersion()` 读**自己的 package.json**；壳注入 `TOOLSHUB_VERSION` 覆盖。`VERSION` 文件仅展示用。

## 3. 发版流程（唯一正确姿势）

1. bump 版本：根 + 4 个子 `package.json` 的 `version`（同步 3 个 `VERSION` 文件与各 lockfile 版本字段）。
2. `git commit`。
3. `git tag vX.Y.Z` 并 push `main` + tag。
4. GitHub Actions `build.yml`：校验 package.json 版本 == tag → 四模块测试 → 下载固定版本 biliup/yt-dlp（SHA256 校验）→ `electron-builder` 出 NSIS 安装包 → 发布 GitHub Release（`latest.yml` + Setup.exe）→ 校验 Release 已发布。
5. **发布后把 `kdocs-tool/lib/data-pack.json` 上传为该 Release 的资产**（`release.sh` 的最后一环；漏了 App 会静默回退内置数据包，游戏名映射不更新）。

⚠️ **不要在本地跑 electron-builder**：本机沙箱会被 safe-delete 守卫和 winCodeSign 符号链接问题卡死（历史反复踩坑）。以 CI 出包为准；本地只跑测试与 `npm run verify:build`。

## 4. 安全红线（改动前必读）

- `.env` / `.masterkey` / `proxy-default` 之类**绝不进 git**；`package.json` extraResources filter 里的 `!**/.env` 排除**不可移除**——否则公开 Release 会把本机代理/凭证发给所有下载者。
- 凭证落盘必须加密（AES-256-GCM）：netdisk 见 `src/store.js`，biliup 见 `lib/crypto.js`。禁止新增明文凭证文件；旧明文文件读取兼容，写入即升级。
- 命令执行一律 `spawn` 数组传参（`shell:false`），禁止把用户输入拼进 shell 字符串（biliup/kdocs 已有先例）。
- 日志不得输出代理 URL 中的账号密码（netdisk `server.js`、material `lib/http.js` 已脱敏，保持即可）。
- 外部二进制已固定版本 + SHA256：biliup-rs **v0.2.4**、yt-dlp **2026.07.04**（`scripts/prepare-biliup-bin.js` / `scripts/prepare-material-bins.js`）。升级必须同步改版本常量并重算哈希。`kdocs-cli-bin/kdocs-cli.exe` 是历史入库二进制（7.6MB，来源不可审计），**改动它之前先问用户**。
- Electron 渲染进程已开 `contextIsolation + sandbox`，不要降级。

## 5. 数据目录与配置（打包后）

- 主进程把 userData 下目录经环境变量注入子进程：`NETDISK_DATA_DIR` / `KDOCS_DATA_DIR` / `BILIUP_DATA_DIR`（升级不丢数据）。
- material 落盘根目录：`MATERIAL_OUTPUT_DIR`（默认 `E:\素材\`，可用环境变量 `TOOLSHUB_MATERIAL_DIR` 覆盖）。
- `.env` 不进安装包；用户自定义 .env 放 `userData/netdisk-hub/.env`，主进程启动时同步到 resources 供子进程读取。

## 6. 测试与构建门禁

- 四个子项目各自 `npm test`（node:test）。
- 根目录：`node --test test/*.test.js`（`extra-resources-filter.test.js` 需要 root `node_modules` 里的 electron-builder，本地没装就跳过，CI 会跑）。
- 渲染层回归：`node --test renderer/test/regression-stuck-initializing.test.js`。
- 改 `shared/` 或 renderer 样式后必须 `npm run verify:build`（内联 CSS 断言）。
- CI 测试全绿才出包；改代码必须让对应测试全绿，不要跳过。

## 7. 已知技术债 / 待办（不要自作主张大改）

- `kdocs-cli-bin/kdocs-cli.exe`（7.6MB）与 `kdocs-skill/` 全量文档入库，二进制来源不可审计 → 建议后续改为「下载 + pinned hash」（需用户拍板）。
- 安装包未签名，SmartScreen 会提示「未知发布者」（已知，暂接受）。
- biliup 上传期间 `login_info` 会在 `%TEMP%` 短暂明文（biliup.exe CLI 只认明文 `-u`，用完即删）——这是工具链硬限制，不是 bug。
- 各子服务 `VERSION` 文件为展示用，与 package.json 同步即可，别再改回读取逻辑。

## 8. 给新 Codex 的启动提示词（可直接粘贴）

```
你接手维护 GitHub 仓库 likuan250-hash/tools-hub（工具箱 ToolsHub：Electron 壳 + kdocs/netdisk/biliup/material 四个本地子服务，当前 v2.7.26）。
第一步：把仓库克隆到纯英文路径（禁中文目录），完整读 HANDOFF.md、README.md、docs/ 和四个子项目结构，建立认知后再动手。
硬性约束：
1) 版本单一真源是各 package.json；发版 = bump 版本 + 打 vX.Y.Z tag + push，CI 自动构建发布；不要在本地跑 electron-builder。
2) .env/.masterkey/代理配置绝不进 git；extraResources 的 !**/.env 排除不可移除；凭证落盘必须用现有 AES-256-GCM（netdisk src/store.js、biliup lib/crypto.js），不许改回明文。
3) 命令执行一律 spawn 数组传参（shell:false），禁止 shell 字符串拼接用户输入。
4) biliup/yt-dlp 已固定版本+SHA256（scripts/prepare-*.js），升级必须同步改常量并重算哈希；kdocs-cli.exe 是历史入库二进制，动它之前先问。
5) 改代码前先跑对应子项目 npm test，改完必须全绿；只做用户明确要求的改动，不顺手重构无关代码。
6) 遇到不确定的取舍（删文件、改发布流程、改凭证方案、改 CI），先列方案和影响让用户拍板。
```

---

## 附：常见操作速查

- 本地起壳调试：`npm start`（需先 `npm install` 根与四个子项目依赖，并 `node scripts/prepare-build.js` 准备运行时资源）。
- 独立起某个子服务：`cd <子项目> && npm start`。
- 打 release：`bash release.sh`（需要 gh CLI 已登录 + git 凭据；等价于上面第 3 节的手动流程）。
- 数据包更新：改 `kdocs-tool/lib/data-pack.json`（bump `version`）→ 发版时上传为 Release 资产。
