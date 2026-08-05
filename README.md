# 工具箱 ToolsHub

工具统一桌面应用：把 **金山文档多维表录入工具（kdocs-tool）**、**网盘转存中转台（netdisk-hub）**、**B站自动投稿（biliup-hub）** 与 **素材搜集（material-hub）** 集成进同一个桌面壳程序，单启动器、单安装包、内嵌标签页，不再各自开浏览器 / 弹窗。

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
- **主题联动**：工具箱切换 🌗 主题后，内嵌的四个工具页同步切换（隐藏内嵌页自身主题按钮，工具箱为唯一主题控制源）。

---

## 二、架构说明

```
┌─────────────────────────────────────────────────────┐
│  Electron 主进程 (main.js)                            │
│  ├─ 单实例锁 / 看门狗 / 端口防抢占                     │
│  ├─ fork 子进程：kdocs-tool    (127.0.0.1:3599)       │
│  ├─ fork 子进程：netdisk-hub   (127.0.0.1:3000)       │
│  ├─ fork 子进程：biliup-hub    (127.0.0.1:3600)       │
│  ├─ fork 子进程：material-hub  (127.0.0.1:3700)       │
│  ├─ 状态推送 / 原生文件对话框 / 自动更新 / 数据包刷新   │
│  │                                                     │
│  └─ 渲染进程 (renderer/)  —— 单窗口多标签壳体           │
│       顶栏：🏠入口 | 金山文档录入 | 网盘转存 | B站投稿 | 素材搜集
│       内容区：<webview> 内嵌工具页面                    │
└─────────────────────────────────────────────────────┘
```

| 组成部分 | 说明 |
|---|---|
| `main.js` | Electron 主进程：进程管理、IPC、自动更新、数据目录注入 |
| `preload.js` | 渲染进程 ↔ 主进程桥接（状态、更新、选目录） |
| `webview-preload.js` | 注入内嵌工具页，提供 `pickFolder` 等有限原生能力 + 主题同步 |
| `renderer/` | 入口页 + 标签栏 + webview 容器（HTML/CSS/JS） |
| `shared/` | 样式单一真源：`tokens.css`（颜色变量）+ `macos-motion.css`（动效） |
| `kdocs-tool/` | 金山文档多维表录入工具（子项目，:3599） |
| `netdisk-hub/` | 网盘转存中转台（子项目，:3000） |
| `biliup-hub/` | B站自动投稿（子项目，:3600） |
| `material-hub/` | 素材搜集（子项目，:3700） |
| `lib/` `test/` | 壳层纯函数与单元测试 |
| `scripts/` | 构建前准备脚本 + 产物断言 |
| `resources/` | 构建期生成的运行时资源（node.exe 等，**不进 git**） |

四个子服务统一约定（改任何一个都要保持一致）：

- 只绑 `127.0.0.1`，端口经环境变量注入（`KDOCS_PORT` / `PORT` / `BILIUP_PORT` / `MATERIAL_PORT`）；
- 同源 CSRF 校验（`Origin` hostname 白名单，防跨站写请求）；
- `/api/version` 回显主进程注入的 `bootToken`（主进程据此判断端口归属），健康探活也走 `/api/version`；
- 版本单一真源：各子服务 `getVersion()` 读**自己的 package.json**；壳注入 `TOOLSHUB_VERSION` 覆盖展示。`VERSION` 文件仅展示用。

> 四个子项目本身仍是独立可运行的服务，但**源码已统一维护在 tools-hub 内**（见第十三节），本应用只是把它们"包进桌面壳"统一启动与呈现。

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
├── shared/                 # tokens.css / macos-motion.css / status-luxe
├── kdocs-tool/             # 子项目（金山文档录入）
├── netdisk-hub/            # 子项目（网盘转存）
│   └── .env.example        # 百度/夸克/迅雷 配置模板（真实 .env 不进 git）
├── biliup-hub/             # 子项目（B站投稿）
├── material-hub/           # 子项目（素材搜集）
├── lib/                    # 主进程纯函数（供单测）
├── test/                   # 壳层单元测试
├── scripts/                # 构建前准备脚本
│   ├── prepare-build.js        # node.exe / 内联样式 / 串联外部二进制
│   ├── prepare-material-bins.js# 下载 yt-dlp.exe（固定版本 + SHA256）
│   ├── prepare-biliup-bin.js   # 下载 biliup.exe（固定版本 + SHA256）
│   └── verify-build-assets.js  # 打包产物断言
├── build/                  # 图标等打包资源
├── .github/workflows/      # CI：打 v* tag 自动出包并发布 Release
└── resources/              # 构建期生成的运行时资源（.gitignore 忽略）
```

---

## 四、环境要求（开发）

- Node.js ≥ 18（CI 使用 Node 22）
- npm
- Windows（应用目标平台为 Windows x64；CI 在 `windows-latest` 出包）
- 网络可访问 GitHub（自动更新通道；大陆直连受限时配置代理，见第八节）

---

## 五、开发运行

```bash
# 1. 安装依赖（根 + 四个子项目）
npm install
cd kdocs-tool && npm install && cd ..
cd netdisk-hub && npm install && cd ..
cd biliup-hub && npm install && cd ..
cd material-hub && npm install && cd ..

# 2. 准备运行时资源（内联样式 / node.exe / 外部二进制，需联网；已就位则跳过）
node scripts/prepare-build.js

# 3. 启动应用
npm start
```

> 开发模式下 webview 需主进程开启 `webviewTag: true`（已在 `createMainWindow` 中启用）。

---

## 六、构建与打包

```bash
# 本地构建（不生成安装包，仅打包目录 + 产物断言）
npm run build

# 生成 Windows 安装包（NSIS）+ 产物断言
npm run dist

# 仅跑产物断言（不打包）
npm run verify:build
```

产物位于 `dist/ToolsHub-Setup-<version>.exe`。

`scripts/prepare-build.js` 会在打包前自动：

1. 复制 `node.exe` 到 `resources/node/`；
2. 把 `shared/tokens.css` + `shared/macos-motion.css` 内联进 `renderer/style.inline.css`（打包后不依赖 `@import`）；
3. 下载固定版本的外部二进制：`yt-dlp.exe`（material-hub）、`biliup.exe`（biliup-hub），并做 SHA256 校验。

> ⚠️ **不要在本地沙箱死磕 electron-builder**（safe-delete 守卫 + winCodeSign 符号链接限制会让打包卡死，历史反复踩坑）。正确姿势：本地只跑测试与 `npm run verify:build`，发版走「bump 版本 → 打 `vX.Y.Z` tag → push」让 GitHub Actions CI 出包发布（见第十节）。

---

## 七、安装部署（用户侧）

1. 到 GitHub Releases 下载最新 `ToolsHub-Setup-<version>.exe`；
2. 双击安装（可选择安装目录，默认当前用户目录）；
3. 启动后自动拉起四个本地服务，入口页即出现。

**升级**：应用内点「检测更新」→ 发现新版本后自动下载 → 「立即安装」重启生效。

**数据保留**：各子服务的登录态 / 配置落在 `userData` 下（主进程经 `NETDISK_DATA_DIR` / `KDOCS_DATA_DIR` / `BILIUP_DATA_DIR` 注入），升级不会丢。material 素材落盘在 `MATERIAL_OUTPUT_DIR`（默认 `E:\素材\`，可用环境变量 `TOOLSHUB_MATERIAL_DIR` 覆盖）。

---

## 八、代理与各子服务配置

### 代理（可选）

需要出网请求的场景（kdocs 数据源、material 封面/宣传片、netdisk 网盘接口）默认读环境变量 `HTTP_PROXY` / `HTTPS_PROXY`；也可以在某子项目根目录放 `.proxy`（或按模板 `proxy-default.example` 创建 `proxy-default`），内容首行为代理地址，例如：

```text
http://127.0.0.1:7890
```

> ⚠️ `.proxy` / `proxy-default` 含本机代理配置，已被 `.gitignore` 排除，**绝不进 git**，也不会被打进安装包。

### netdisk（百度网盘等）

百度网盘连接参数与转存目标目录来自 `netdisk-hub/.env`（从 `.env.example` 复制）。当前百度走「网页登录（BDUSS cookie）」模式，`BAIDU_CLIENT_ID` / `BAIDU_CLIENT_SECRET` 为兼容保留；夸克 / 迅雷走「本机 Playwright 登录 + 逆向接口」，首次使用需 `npx playwright install chromium`。安装包用户可在 `userData/netdisk-hub/.env` 放置自定义配置（主进程启动时自动同步）。

### 其余子服务

- `kdocs-tool/.env.example`、`biliup-hub/.env.example` 为可选配置模板；
- material 无 `.env` 需求（输出目录走环境变量注入）。

---

## 九、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 启动后出现黑框 | 已修复（`fork` 加 `windowsHide:true`） |
| 工具页只显示顶部一小块 | webview 用 `visibility` + `resize()` 切换，切换异常时重开标签即可 |
| 点「检测更新」卡在"正在下载" | 检查网络代理；更新走 GitHub Release 通道 |
| 百度网盘连接异常 / 升级后登录态丢失 | 登录态在 `userData`，升级不丢；异常可检查 `userData/netdisk-hub/.env` |
| B站显示「登录成功但投稿 -412」 | v2.7.26 起扫码登录后自动调 B站 nav 校验 cookie 有效性，失败会明确提示重新登录 |
| 投稿提示 biliup.exe 缺失 | 安装包应内置（CI 固定版本下载 + SHA256 校验）；开发模式需 `node scripts/prepare-biliup-bin.js` |
| 素材封面/宣传片失败 | 封面走 Steam CDN / wallhaven / Reddit / Bing 站内搜 / 抽帧兜底；宣传片依赖内置 yt-dlp + ffmpeg |
| kdocs 显示「AI 不可用」 | 内置 bl CLI 为可选资源（CI 默认不含，本地需自行准备），缺失时 kdocs 自动降级 |

---

## 十、版本与更新约定

- **版本单一真源 = 各 package.json**：发版时根 + 四个子项目 `package.json` 统一 bump（同步三个 `VERSION` 展示文件与 lockfile 版本字段）。
- **每次修复 bump 小版本号并打 `vX.Y.Z` tag**，GitHub Actions 自动出包并发布 Release；已安装的用户点「检测更新」即可升级。
- 自动更新基于 `electron-updater`，比对 GitHub Release 的 `latest.yml`。
- **数据包资产**：`kdocs-tool/lib/data-pack.json` 是 kdocs 离线游戏映射的增量数据包，发版时作为 Release 资产上传（`release.sh` 自动完成）；漏传则 App 静默回退内置数据包。

### 发版流程（唯一正确姿势）

1. bump 版本：根 + 四个子 `package.json`（+ 三个 `VERSION` 文件 + lockfile）；
2. `git commit`；
3. `git tag vX.Y.Z` 并 push `main` + tag；
4. GitHub Actions `build.yml`：校验 package.json 版本 == tag → 四模块测试 → 固定版本二进制（SHA256 校验）→ `electron-builder` 出 NSIS 安装包 → 发布 GitHub Release（`latest.yml` + Setup.exe）→ 校验 Release 已发布；
5. 发布后确认 `data-pack.json` 已作为 Release 资产（`release.sh` 最后一环）。

也可直接 `bash release.sh`（需 gh CLI 已登录 + git 凭据）。

---

## 十一、构建脚本说明

| 脚本 | 作用 |
|---|---|
| `npm start` | 开发模式启动 Electron |
| `npm run build` | 仅构建应用目录（`electron-builder --dir`）+ 产物断言 |
| `npm run dist` | 构建并生成 NSIS 安装包（`electron-builder --win nsis`）+ 产物断言 |
| `npm run verify:build` | 纯产物断言（内联样式 / 关键资产 / extraResources 过滤），不打包 |
| `node scripts/prepare-build.js` | 打包前准备运行时资源（node.exe / 内联样式 / 外部二进制） |
| `node scripts/prepare-material-bins.js` | 下载固定版本 yt-dlp.exe（SHA256 校验） |
| `node scripts/prepare-biliup-bin.js` | 下载固定版本 biliup.exe（SHA256 校验） |
| `node scripts/sync-status-luxe.js` | 同步三处 status-luxe 副本（有对应 verify 脚本断言逐字节一致） |

---

## 十二、安全说明（红线，改动前必读）

- `.env` / `.masterkey` / `.proxy` / `proxy-default` 含本机凭证或代理配置，**绝不进 git**；`package.json` `build.extraResources` 各子项目 filter 里的 `!**/.env` 排除**不可移除**——否则公开 Release 会把本机代理 / 凭证发给所有下载者。
- **凭证落盘必须加密（AES-256-GCM）**：netdisk 见 `src/store.js`，biliup 见 `lib/crypto.js`。禁止新增明文凭证文件；旧明文文件读取兼容，写入即升级。
- **命令执行一律 `spawn` 数组传参（`shell:false`）**，禁止把用户输入拼进 shell 字符串。
- **外部二进制固定版本 + SHA256**：biliup-rs `v0.2.4`、yt-dlp `2026.07.04`（`scripts/prepare-biliup-bin.js` / `scripts/prepare-material-bins.js`）。升级必须同步改版本常量并重算哈希。`kdocs-cli-bin/kdocs-cli.exe` 是历史入库二进制，改动前先与维护者确认。
- Electron 渲染进程已开 `contextIsolation + sandbox`，不要降级。

---

## 十三、统一维护（源码唯一来源）

四个子项目的**唯一源码位置就是本仓库内的 `kdocs-tool/` / `netdisk-hub/` / `biliup-hub/` / `material-hub/` 目录**，不再有各自独立的开发副本，所有改动直接在此提交、打包。各子项目目录内另有各自的 `README.md` / 设计文档，子服务内部约定以仓库 `docs/` 与 `HANDOFF.md` 为准。

### 版本号与更新

- **唯一版本来源 = 各 `package.json`**（根 + 四个子项目统一 bump）。用户装了什么、该升级到哪一版，只看 tools-hub。
- 子项目 `VERSION` 文件**仅作展示用**，与 package.json 同步即可，不再驱动任何更新，无需单独打 tag。
- **自更新已移除**：子项目不再有各自 `/api/check-update`、`/api/update`、`/api/restart` 接口；更新只走工具箱的检测更新 / 自动升级，不会出现"子项目各自 git pull"再次分叉的情况。
- 工具箱启动子进程时会注入 `TOOLSHUB_VERSION` 环境变量，子项目据此在徽章上显示"工具箱 vX.Y.Z"或"独立运行"。
