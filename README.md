# 工具箱 ToolsHub

工具统一桌面应用：把 **金山文档多维表录入工具（kdocs-tool）** 与 **网盘转存中转台（netdisk-hub）** 集成进同一个桌面壳程序，单启动器、单安装包、内嵌标签页，不再各自开浏览器 / 弹窗。

> 仓库：`github.com/likuan250-hash/tools-hub`
> 当前版本：`2.7.26`

---

## 一、功能特性

- **统一入口**：顶部标签栏从启动就常驻一个 `🏠 入口` 标签（不可关闭），点击进入工具卡片页；工具标签可自由增删、来回切换，互不干扰。
- **单窗口多标签**：四个工具以 `<webview>` 内嵌在同一窗口内，切换标签只是显隐，后台任务不中断（如 biliup 正在上传不会断）。
- **一键启动**：应用启动时自动拉起 kdocs（`:3599`）、netdisk（`:3000`）、biliup（`:3600`）、material（`:3700`）四个本地服务，退出时自动回收。
- **服务状态灯**：入口页实时显示四个服务在线 / 离线状态。
- **内置 Node 运行时**：打包后自带 `node.exe`，子服务开箱即用。
- **自动更新**：点「检测更新」即可下载新版本并重启安装，无需重新下载安装包。
- **自定义标题栏（无系统边框）**：去掉系统标题栏，改用应用内自绘的标题栏——右上角为 macOS 风格红绿灯圆点（红=关闭 / 黄=最小化 / 绿=最大化，悬停整组才显示内部 × − ＋ 符号），标题「工具箱 ToolsHub」水平居中；顶部标题区可拖动窗口，双击标题区最大化 / 还原。
- **关闭前确认（自定义弹窗）**：点击关闭时弹出应用内玻璃拟态确认框（与工具箱主题一致，非系统原生对话框），默认「取消」，避免误关导致后台服务中断。
- **主题联动**：工具箱切换 🌗 主题后，内嵌的金山文档录入 / 网盘转存中转同步切换（隐藏内嵌页自身主题按钮，工具箱为唯一主题控制源）。

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

> 子项目 `kdocs-tool`、`netdisk-hub` 本身仍是独立可运行的服务，但**源码已统一维护在 tools-hub 内**（见第十三节），本应用只是把它们"包进桌面壳"统一启动与呈现。

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
├── biliup-hub/             # 子项目（B站自动投稿）
├── material-hub/           # 子项目（素材搜集）
├── lib/                    # 主进程纯函数（供单测）
├── test/                   # 壳层单元测试
├── scripts/                # 构建前准备脚本
│   ├── prepare-build.js    # 准备 node.exe / 内联样式 / 串联外部二进制
│   ├── prepare-material-bins.js # 下载 yt-dlp.exe
│   ├── prepare-biliup-bin.js    # 下载 biliup.exe
│   └── verify-build-assets.js   # 打包产物断言
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
| 百度网盘连接异常 / 升级后登录态丢失 | v0.1.7 起 `.env` 与 `data/` 已重定向到 `userData`（应用数据目录），升级自动保留，无需重新放置；若异常可检查 `userData/netdisk-hub/.env` |
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

---

## 十三、统一维护（源码唯一来源）

两个子项目的**唯一源码位置就是本仓库内的 `kdocs-tool/` 与 `netdisk-hub/` 目录**。不再有各自独立的开发副本，所有改动直接在此提交、打包。

### 为什么这样

早期 `E:\kdocs-tool`、`E:\工作空间\netdisk-hub` 是独立 git 仓库，与 tools-hub 内嵌目录形成双份维护、容易分叉。现已统一：tools-hub 既当"桌面壳"也当"源码仓库"，改一处即可。

### 目录约定

| 路径 | 性质 | 说明 |
|---|---|---|
| `tools-hub/kdocs-tool/` | **源码（唯一）** | 直接在此编辑、提交 |
| `tools-hub/netdisk-hub/` | **源码（唯一）** | 直接在此编辑、提交 |
| `E:\kdocs-tool.gitbak` / `E:\工作空间\netdisk-hub.gitbak` | 备份(归档) | 统一前独立仓库原件（含各自 git 历史、node_modules、登录态），仅作归档保留，与本项目无活动关联 |

> ⚠️ `tools-hub` 是这两个子工具的唯一源码与运行位置，项目自包含、不依赖任何外部仓库或目录联接。早期位于 `E:\kdocs-tool`、`E:\工作空间\netdisk-hub` 的 NTFS 目录联接（指向本仓库子目录）已移除，旧独立仓库仅以 `.gitbak` 归档保留。
> `node_modules/` 与运行时 `data/`、`.env` 均为本地依赖 / 隐私数据，已被 `.gitignore` 忽略，不会进仓库；仓库内的 `node_modules` 为本地开发 / 独立运行准备，重新克隆后需各自 `npm install`。

### 版本号与更新

- **唯一版本来源 = 桌面壳 `tools-hub/package.json` 的 `version`**。用户装了什么、该升级到哪一版，只看 tools-hub。
- 子项目 `kdocs-tool/package.json`、`netdisk-hub/package.json` 的 `version` 现在**仅作功能代号展示**（运行在工具箱内时徽章显示的是 tools-hub 版本），不再驱动任何更新，无需单独打 tag。
- **自更新已移除**：两个子项目原有的 `/api/check-update`、`/api/update`、`/api/restart` 接口与对应前端按钮均已删除（自 v0.1.13 起）。更新只走工具箱的检测更新 / 自动升级，不会出现"子项目各自 git pull"再次分叉的情况。
- 工具箱启动子进程时会注入 `TOOLSHUB_VERSION` 环境变量，子项目据此在徽章上显示"工具箱 vX.Y.Z"或"独立运行"。
