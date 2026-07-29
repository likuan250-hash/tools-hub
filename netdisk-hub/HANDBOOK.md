# netdisk-hub 完全接手文档

> 交给 AI 助手（Codex/Claude 等）时，**先让它读这个文件**再开始动手。
> 当前版本：1.3.30（主分支 main；以 `git log -1` 为准确认最新 commit）

---

## 1. 这是做什么的

**网盘转存中转台**—— 把你复制到的别人分享链接，转存到自己的网盘，再一键生成你自己的分享链接。

- 纯**本地**服务（127.0.0.1:3000��，没有云服务器
- 三��已全部接入：百度 / 夸克 / 迅雷
- 没有数据库，用本地 JSON 文件 `data/store.json` 存账号和任务历史
- GitHub 私有仓库：`github.com/likuan250-hash/netdisk-hub`（多机同步用）

---

## 2. 一句话告诉我如何运行

```bash
cd netdisk-hub
npm install
npx playwright install chromium   # 仅首次
cp .env.example .env               # 然后编辑 .env 填百度凭证
node server.js                     # 打开 http://localhost:3000
```

运行后点网页右上角版权按钮扫网盘授权，授权后粘贴分享链接即可转存。

---

## 3. 文件职责速查

| 文件 | 职责 | 关键导出/路由 |
|------|------|--------------|
| **server.js** | Express 主入口（~990行）��所有路由、转存编排、更新/重启/健康接口。 | `/api/transfer`, `/api/accounts`, `doTransfer()`, `/api/version`(只读) |
| **src/baidu.js** | 百度网盘接口封装。BDUSS cookie 鉴权，转存与分享。 | `getShareList`, `transfer`, `createShare`, `checkSession` |
| **src/quark.js** | 夸克网盘逆向接口封装。Cookie 鉴权。 | `transfer`, `listSubfolders`, `checkSession` |
| **src/xunlei.js** | 迅雷网盘逆向接口封装。Bearer token + captcha 鉴权。 | `transfer`, `pingSession`, `listSubfolders` |
| **src/baidu.auth.js** | ���度 Playwright 本机登录（弹浏览器扫码，抓 BDUSS） | `startLogin`, `getState` |
| **src/quark.auth.js** | 夸克 Playwright 本机登录（弹浏览器扫码，抓 Cookie） | `startLogin`, `getState` |
| **src/xunlei.auth.js** | 迅雷 Playwright 本机登录（弹浏览器登录，拦截 API token） | `startLogin`, `getState` |
| **src/store.js** | JSON 文件存储。全量读写 + 原子写入（tmp + rename）。 | `getAccount`, `saveAccount`, `addTask`, `getDir`/`setDir` |
| **src/logger.js** | 日志。输出到控制台 + logs/app-YYYY-MM-DD.log。保留 14 天自动清理。 | `info`, `warn`, `error`, `debug` |
| **public/app.js** | 前端全部逻辑（~887行）。账号卡片、转存中心、历史分组、格式化工具。 | 事件绑定，解析，渲染 |
| **public/index.html** | 主页 UI（~450行）。玻璃拟态，明暗主题，模态框。 | — |
| **control_panel_tk.py** | tkinter 控制面板（~453行）。看门狗自动拉起、重启/停止/日志。 | 独立进程运行 |
| **create-shortcut.vbs** | 双击生成带图标的 `启动面板.lnk`（GBK 编码）。 | — |
| **assets/app.ico** | 快捷方式图标（用户提供的 favicon.ico，单帧 256×256 32 位）。 | — |
| **.env** | 配置（gitignored）。百度凭证、转存目录默认值、代理。 | `BAIDU_CLIENT_ID`, `BAIDU_APP_DIR`, `QUARK_FOLDER` 等 |

---

## 4. 核心数据流

### 4.1 授权流程（以百度为例，三盘结构相同）

```
用户点"授权百度网盘"
    → openAuth('baidu') 开弹窗到 /auth/baidu/cookie
        → server.js 返回 baiduLoginPage()（含js轮询）
            → 前端调 POST /api/baidu/login/start （server.js 调 baiduAuth.startLogin()）
                → Playwright 起浏览器打开 pan.baidu.com
                    → 用户扫码登录 → playwright 检测到 cookie（__bid_n / BAIDUID）
                        → 存到 store.saveAccount('baidu', {cookie, connected:true})
                            → 轮询返回 {status:'done'}
                                → js → window.opener.postMessage({provider:'baidu', authorized:true})
                                    → app.js 监听 message → loadAccounts() 刷新卡片
```

### 4.2 转存流程

```
用户粘贴分享链接 → parseBatch 解析出 {title, jobs, order}
→ 勾选网盘 → 点「转存」
    → POST /api/transfer/batch {jobs, makeShare, force, title}
        → server.js.mapLimit(jobs, 3, doTransfer)
            → doTransfer():
                ① 历史去重（provider + sourceSurl 匹配 cached = 直接返回旧链接）
                ② 并发去重（同一 provider+surl 正在转存中的复用 Promise）
                ③ runTransfer() ��� provider 调对应盘的接口
                    → 解析链接 → 拿分享文件列表 → 转存到目标目录 → （可选）生成分享链接
                    → store.addTask() 落盘
                → 返回 {ok, files, share, taskId}
            → 前端 renderResults() 展示结果
```

### 4.3 目录选择

```
用户点"选择目录"
→ openDirPicker() → GET /api/dirs/{provider}/browse?parent=
    → 对应盘的 listSubfolders()
        → 前端渲染子文件夹列表（可层层进入）
            → 确定后 POST /api/dirs/{provider} {id, name}
                → store.setDir() 持久化到 store.json.dirs
```

---

## 5. 关键设计决策（改动前必读）

### 5.1 store 是同步全量读写

JSON 文件完整 read → modify → write（atomic tmp+rename）。性能足够（历史 ≤1000 条）。不要改成异步或引入数据库。

### 5.2 百���实际不走 OAuth

`.env` 里 `BAIDU_CLIENT_ID` / `BAIDU_CLIENT_SECRET` 是兼容遗留字段。转存鉴权完全靠 **Playwright 抓取的 BDUSS cookie**。OAuth 的 `/auth/baidu` 路由保留但已不被前端直接调用，前端走 `/auth/baidu/cookie`（Playwright 登录）。

### 5.3 出站代理

在 `server.js` 头部的 `ProxyAgent` block。只用 `.env` 的 `NETDISK_PROXY`，不自动读 `HTTP_PROXY`（避免 git 代理干扰）。修改代理逻辑时注意只改这里。

### 5.4 三盘接口来源

- **百度**：`hxz393/BaiduPanFilesTransfers`（GitHub 活跃方案）。逆向网页端。
- **夸克**：纯 HTTP 逆向。`drive-pc.quark.cn` API。
- **迅雷**：纯 HTTP API + localStorage token 读取。`api-pan.xunlei.com`。网盘改版时 `src/xunlei.js` 里的字段名可能变动（特别是 share/save 接口）。

### 5.5 暗黑窗口（黑框）问题已解决

迅雷 `loadTokensFromProfile` 会拉起 Playwright headless 读 localStorage。之前所有黑框 bug 都此来源：
- 已修复：后台异步预热 + 5min 探测缓存 + 窗口外置参数（`--window-position=-10000,-10000`）隐藏
- 不要改回同步/阻塞方式

### 5.6 更新统一由工具箱负责

- netdisk-hub 已**移除** `/api/check-update`、`/api/version`(只读)、`/api/restart` 三个自更新接口（自 tools-hub v0.1.13 起）。
- 所有更新（含本服务）统一由桌面壳 tools-hub 的检测更新 / 自动升级完成，用户无需在本服务内手动 `git pull`。
- 独立运行（脱离工具箱）时，`/api/version` 返回 `source: "standalone"`、`updatable: false`，仅作展示。

### 5.7 onFatal 不再自杀

- 未捕获异常 / Promise 拒绝只记日志 + 标不健康（`serverHealthy=false` + `fatalCount++`）
- 不再 `process.exit(1)`（控制面板看门狗对真正进程崩溃生效，带病存活靠 health 暴露）
- 只有 `shuttingDown` 状态下忽略异常（优雅关闭中）

---

## 6. API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/accounts` | 三盘连接状态 + 目录 + 实时探测缓存 |
| GET | `/api/health` | 健康检查（含 verifyCache/pingCache） |
| GET | `/api/live` | 存活检查（进程仍能处理 HTTP 请求） |
| GET | `/api/ready` | 就绪检查（发生未捕获异常后返回 503，供控制面板看门狗使用） |
| GET | `/api/version` | 版本号 + commit |
| GET | `/api/check-update` | 检测更新（git fetch + diff） |
| POST | `/api/version`(只读) | 执行 git pull（安全，不自动装依赖） |
| POST | `/api/restart` | 重启（spawn 新进程 → 旧进程退出） |
| POST | `/api/transfer` | 单条转存 |
| POST | `/api/transfer/batch` | 批量转存（mapLimit=3） |
| GET | `/api/tasks` | 任务历史 |
| DELETE | `/api/tasks/failed` | 清空失败记录（先备份） |
| GET | `/api/dirs/:provider` | 读取已选转存目录 |
| GET | `/api/dirs/:provider/browse` | 浏览子文件夹 |
| POST | `/api/dirs/:provider` | 保存选定目录 |
| GET | `/auth/baidu/cookie` | 百度登录页（Playwright） |
| POST | `/api/baidu/login/start` | 启动百度浏览器登录 |
| GET | `/api/baidu/login/status` | 轮询百度登录状态 |
| POST | `/api/baidu/logout` | 清除百度 Cookie |
| （夸克/迅雷同上结构，仅路径不同） |

---

## 7. 数据存储

`data/store.json` 结构：

```json
{
  "accounts": {
    "baidu": { "cookie": "...", "connected": true, "updatedAt": "..." },
    "quark": { "cookie": "...", "connected": true },
    "xunlei": { "connected": true, "accessToken": "...", "captchaToken": "...", "deviceId": "..." }
  },
  "dirs": {
    "baidu": { "type": "baidu", "name": "/游戏", "id": "/游戏" },
    "quark": { "type": "quark", "name": "游戏分享", "id": "210e881832..." },
    "xunlei": { "type": "xunlei", "name": "游戏", "id": "..." }
  },
  "tasks": [
    { "id": "...", "title": "游戏名", "provider": "baidu", "sourceLink": "...", "sourceSurl": "...", "shareLink": "...", "status": "success", "createdAt": "..." }
  ]
}
```

重要约束：
- 历史硬上限 1000 条（`MAX_TASKS`）
- `dirs` 字段的 `id` 语义各盘不同：百度=路径字符串，夸克=fid，迅雷=文件夹 id
- 跨机时 `data/` 不随 git 走（`.gitignore`��，换机需重授权+重选目录

---

## 8. 部署相关

### 启动方式
- **推荐**：双击 `启动面板.bat` ��� tkinter 控制面板（带看门狗自动拉起）
- 或双击 `setup.bat`（自动装依赖+启动）
- 或 `node server.js`（无看门狗）
- 或网页点版本徽章→更新并重启

### 更新方式
- 网页右键版本徽章→「检查更新」→ 有更新时点「更新」
- 或双击 `update.bat`（git pull + npm install）
- 或 `git pull && git pull` 手动（配合控制面板重启）

### 快捷方式图标
- 第一次使用：`git pull` 后双击 `create-shortcut.vbs` 生成 `启动面板.lnk`
- Windows 会缓存图标，重新生成 `.lnk` 前建议先删旧的
- `.lnk` 被 `.gitignore` 排除了

### 跨机注意事项
- `.env`（百度凭证）不进 git → 装完直接复制整份 `.env`（包含百度三行 + 目录项）
- 目录选择在网页做，持久化到本机 `data/store.json`
- 迅雷 profile 在 `data/xunlei_profile`（Playwright 持久上下文目录）
- 换机必须重新授权三个网盘（扫码）

---

## 9. 知道这些就够了——几个背景说明

- **用户是甲方 IT 人员**，有金蝶云星空运维背景。语言直接务实，不要绕。
- **项目无任何自动化测试**（`package.json` 里 `test` 是空的）。改动后必须 `node --check` 语法校验 + 启动实例冒烟。
- **没有 CI/CD**。发版靠 commit + push + 另一台机器 pull。
- **代码无类型检查**（纯 JS）。改 `src/baidu.js`、`src/xunlei.js` 等逆向接口文件，要特别留意响应字段名——网盘改版会无声静默，字段名变了你改了就行，不用动其它文件。
- **发布前检查清单**：`node --check server.js && node --check src/*.js && node --check public/app.js && python -m py_compile control_panel_tk.py`（若系统未安装 Python，须先安装后再校验控制面板）
- **commit 时注意**：`.env`、`data/`、`node_modules/`、`logs/`、`*.lnk` 都被 `.gitignore` 排除，不要手动 add 进去。
- 版本号在 `VERSION` 文件（纯文本，只有版本号）。`index.html` 里 `app.js?v=` 和 `VERSION` 要同步推进，否则浏览缓存旧 JS。
