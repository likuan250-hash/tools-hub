# 工具箱 ToolsHub

工具统一桌面应用：把 **金山文档多维表录入工具（kdocs-tool）** 与 **网盘转存中转台（netdisk-hub）** 集成进同一个桌面壳程序，单启动器、单安装包、内嵌标签页，不再各自开浏览器 / 弹窗。

> 仓库：`github.com/likuan250-hash/tools-hub`
> 当前版本：`0.1.5`

---

## 一、功能特性

- **统一入口**：顶部标签栏从启动就常驻一个 `🏠 入口` 标签（不可关闭），点击进入工具卡片页；工具标签可自由增删、来回切换，互不干扰。
- **单窗口多标签**：两个工具以 `<webview>` 内嵌在同一窗口内，切换标签只是显隐，后台任务不中断（如 kdocs 正在上传不会断）。
- **一键启动**：应用启动时自动拉起 kdocs（`:3599`）与 netdisk（`:3000`）两个本地服务，退出时自动回收。
- **服务状态灯**：入口页实时显示两个服务在线 / 离线状态。
- **内置 Node 运行时与 bl CLI**：打包后自带 `node.exe` 与 `bailian-cli`，kdocs 的 AI 功能开箱即用。
- **自动更新**：点「检测更新」即可下载新版本并重启安装，无需重新下载安装包。

---

## 二、架构说明

```
┌─────────────────────────────────────────────┐
│  Electron 主进程 (main.js)                     │
│  ├─ 单实例锁 / 看门狗                          │
│  ├─ fork 子进程：kdocs-tool  (localhost:3599)  │
│  ├─ fork 子进程：netdisk-hub (localhost:3000)  │
│  ├─ 状态推送 / 原生文件对话框 / 自动更新         │
│  │                                             │
│  └─ 渲染进程 (renderer/)  —— 单窗口多标签壳体    │
│       顶栏：🏠入口 | 金山文档录入 | 网盘转存中转  │
│       内容区：<webview> 内嵌工具页面            │
└─────────────────────────────────────────────┘
```

| 组成部分 | 说明 |
|---|---|
| `main.js` | Electron 主进程：进程管理、IPC、自动更新 |
| `preload.js` | 渲染进程 ↔ 主进程桥接（状态、更新、选目录） |
| `webview-preload.js` | 注入内嵌工具页，提供 `pickFolder` 等有限原生能力 |
| `renderer/` | 入口页 + 标签栏 + webview 容器（HTML/CSS/JS） |
| `kdocs-tool/` | 金山文档多维表录入工具（子项目） |
| `netdisk-hub/` | 网盘转存中转台（子项目） |
| `resources/node/` | 打包内置的 Node 运行时（不进 git） |
| `resources/bin/` | 打包内置的 bl CLI / bailian 依赖（不进 git） |

> 子项目 `kdocs-tool`、`netdisk-hub` 本身是独立可运行的服务，本应用只是把它们"包进桌面壳"统一启动与呈现。

---

## 三、目录结构

```
tools-hub/
├── main.js                 # 主进程
├── preload.js              # 渲染进程桥接
├── webview-preload.js      # 内嵌页注入
├── package.json            # 版本 / 构建配置
├── renderer/               # 入口页 + 标签壳体
│   ├── index.html
│   ├── app.js
│   └── style.css
├── kdocs-tool/             # 子项目（金山文档录入）
├── netdisk-hub/            # 子项目（网盘转存）
│   └── .env.example        # 百度/夸克/迅雷 配置模板（真实 .env 不进 git）
├── scripts/                # 构建前准备脚本
│   ├── prepare-build.js    # 复制 node.exe / bl / .env
│   └── prune-bailian.js    # 复制或安装 bailian-cli
├── build/                  # 图标等打包资源
├── .github/workflows/      # CI：打 v* tag 自动出包并发布 Release
└── resources/              # 构建期生成的运行时资源（.gitignore 忽略）
```

---

## 四、环境要求（开发）

- Node.js ≥ 18（推荐使用仓库内置 / CI 一致的版本）
- npm
- Windows（应用目标平台为 Windows x64；CI 在 `windows-latest` 出包）
- 网络可访问 GitHub（自动更新通道）

---

## 五、开发运行

```bash
# 1. 安装依赖
npm install

# 2. 准备运行时资源（复制 node.exe / bl / .env 到 resources/）
#    Windows 下双击 scripts 同目录的 setup 或手动执行：
node scripts/prepare-build.js

# 3. 启动应用（需先有两个子项目的依赖）
cd kdocs-tool && npm install && cd ..
cd netdisk-hub && npm install && cd ..

npm start
```

> 开发模式下 webview 需主进程开启 `webviewTag: true`（已在 `createMainWindow` 中启用）。

---

## 六、构建与打包

```bash
# 本地构建（不生成安装包，仅打包目录）
npm run build

# 生成 Windows 安装包（NSIS）
npm run dist
```

产物位于 `dist/ToolsHub-Setup-<version>.exe`。

`scripts/prepare-build.js` 会在打包前自动：
1. 复制 `node.exe` 到 `resources/node/`；
2. 复制或 `npm install bailian-cli` 到 `resources/bin/`；
3. 从本地 `netdisk-hub/.env`（若已存在）复制到 `resources/bin/`。

---

## 七、安装部署（用户侧）

1. 到 GitHub Releases 下载最新 `ToolsHub-Setup-<version>.exe`；
2. 双击安装（可选择安装目录，默认当前用户目录）；
3. 启动后自动拉起两个本地服务，入口页即出现。

**升级**：应用内点「检测更新」→ 发现新版本后自动下载 → 「立即安装」重启生效。
升级会覆盖 `resources` 目录，若百度网盘异常，按下一节重新放置 `.env`。

---

## 八、百度网盘配置（重要）

netdisk 连接百度网盘需要 OAuth 参数与转存目标目录，来自 `netdisk-hub/.env`。

> ⚠️ **`.env` 含凭证，已被 `.gitignore` 忽略，绝不进 git 仓库。** 仅 `.env.example` 模板入库。

配置步骤：

```bash
# 在 netdisk-hub 目录下，从模板复制出真实 .env
cp netdisk-hub/.env.example netdisk-hub/.env
# Windows：copy netdisk-hub\.env.example netdisk-hub\.env
```

- 现在百度网盘走「网页登录（BDUSS cookie）」模式，`BAIDU_CLIENT_ID` / `BAIDU_CLIENT_SECRET` 为兼容保留，可用模板默认占位、不必填写真实值。
- 点应用内「授权百度网盘」会弹浏览器让你登录百度账号，登录后自动连上。
- 夸克 / 迅雷走「本机 Playwright 登录 + 逆向接口」，首次使用需 `npx playwright install chromium` 安装浏览器内核。
- 若本机网络需代理才能访问外网，在 `.env` 填 `NETDISK_PROXY=http://127.0.0.1:7890`。

**安装包用户**：把上面生成的 `.env` 复制到安装目录的 `resources/netdisk-hub/.env` 即可。

---

## 九、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 启动后出现黑框 | 已修复（`fork` 加 `windowsHide:true`，v0.1.0 之后无黑框） |
| 工具页只显示顶部一小块 | 早期版本 webview 用 `display` 切换导致尺寸异常；v0.1.5 起改用 `visibility` + `resize()` 根治 |
| 点「检测更新」卡在"正在下载" | v0.1.4 之前 `update-available` 未真正调用下载；升级到 v0.1.4+ 即可正常下载 |
| 百度网盘连接异常 | 检查安装目录 `resources/netdisk-hub/.env` 是否存在（升级会覆盖 resources，需重新放置） |
| kdocs 显示「AI 不可用」 | 内置 bl CLI 缺失；v0.1.1+ 安装包已内置，开发模式需 `npm install bailian-cli` |

---

## 十、版本与更新约定

- 版本号位于 `package.json` 的 `version` 字段。
- **每次修复都会 bump 小版本号并打 `vX.Y.Z` tag**，GitHub Actions 自动出包并发布 Release；已安装的用户点「检测更新」即可升级。
- 自动更新基于 `electron-updater`，比对 GitHub Release 的 `latest.yml`。

---

## 十一、构建脚本说明

| 脚本 | 作用 |
|---|---|
| `npm start` | 开发模式启动 Electron |
| `npm run build` | 仅构建应用目录（`electron-builder --dir`） |
| `npm run dist` | 构建并生成 NSIS 安装包（`electron-builder --win nsis`） |
| `scripts/prepare-build.js` | 打包前准备运行时资源（node.exe / bl / .env） |
| `scripts/prune-bailian.js` | 复制或安装 `bailian-cli` 到 `resources/bin/` |

---

## 十二、安全说明

- 含凭证的 `.env` 不入库（`.gitignore` 已忽略）。
- 自动更新走 GitHub Release 官方通道，安装包含完整运行时，分发他人前请确认其中不含你的私有凭证。
