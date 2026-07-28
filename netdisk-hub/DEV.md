# DEV.md · 开发者交接文档（Quark / Xunlei 接力指南）

> 给接手「夸克网盘」「迅雷网盘」开发的同事/协作者看。百度网盘这条链路已经完整跑通，是**样板**，照它的结构和函数名再写两份即可。

## 1. 项目定位
本地运行的「多网盘转存中转台」：把**别人的分享链接**转存到**我的网盘**，再生成**我的分享链接**。
纯本地、无中心服务器；多机独立运行、数据不互通。

当前进度：
- ✅ **百度网盘**：全链路已跑通（官方 OAuth + 转存 + 生成分享）
- ✅ **夸克网盘**：已接入（Playwright 本机登录拿 Cookie + 网页端逆向接口）
- ✅ **迅雷网盘**：已接入（Playwright 本机登录 + 逆向接口；与夸克同模式,弹浏览器登录后拦截 token + captchaToken + deviceId。接口属非公开,部分字段待 live 验证,详见 README「迅雷待 live 验证项」）

## 2. 技术栈
Node.js 22 + Express（零框架、零数据库）。前端原生 HTML/JS + 玻璃拟态 CSS。

## 3. 目录结构
```
netdisk-hub/
├─ server.js          Express 入口：路由 + API
├─ src/
│  ├─ store.js        JSON 文件存储（accounts / tasks），无数据库
│  ├─ baidu.js        ★百度参考实现：OAuth + 转存 + 分享（Quark/Xunlei 照此镜像）
│  ├─ quark.js        夸克网页端逆向接口封装 + Playwright 登录
│  ├─ xunlei.js       迅雷网页端逆向接口封装(转存 / 分享 / 文件列表)
│  ├─ xunlei.auth.js  迅雷 Playwright 本机登录(拦截 token + captchaToken 存库)
│  └─ store.js        JSON 文件存储（accounts / tasks），无数据库
├─ public/
│  ├─ index.html      主页 UI
│  └─ app.js          前端逻辑（账号卡片 / 弹窗授权 / 转存）
├─ data/store.json    本地数据（gitignored，运行后自动生成）
├─ .env.example       配置模板（.env 才是真配置，gitignored）
├─ README.md          用户文档
└─ DEV.md             本文件
```

## 4. 接手第一步（本地运行）
```bash
git clone <仓库地址>
cd netdisk-hub
npm install
cp .env.example .env      # 填入自己的凭证（见第 6 节）
node server.js            # 打开 http://localhost:3000
```
⚠️ `.env` 和 `data/` 已被 `.gitignore` 排除，**绝不提交**。每台机器用自己的凭证 / 自己的登录态。

## 5. 百度参考实现（Quark/Xunlei 必须镜像它）
百度这条链路是「样板」。接 Quark/迅雷 = 照它的结构再写一份 `src/quark.js` / `src/xunlei.js`，把「官方 API 调用」换成「Playwright 登录 + 逆向接口调用」。

### 5.1 `src/baidu.js` 导出的函数（你的 quark.js / xunlei.js 要同名导出）
- `authorizeUrl(state)` → 返回授权页 URL（百度用 `display=tv&qrcode=1` 直接出二维码）
- `exchangeCode(code)` → 用 code 换 token
- `getValidToken()` → 取有效 access_token（过期前自动 refresh）
- `parseSurl(link)` → 从分享链接解析出 surl
- `getShareList(token, surl, pwd)` → 拿分享文件列表（shareid/uk/fs_id）
- `transfer(token, shareid, uk, fsidList, destPath)` → 转存到我的目录
- `createShare(token, paths, password)` → 生成我的分享（link+password，永久有效）

### 5.2 路由（`server.js`）
- `GET /auth/baidu` → 跳授权页
- `GET /auth/baidu/callback` → 换 token 存库，**成功页用 `postMessage` 通知父窗口并自动关弹窗**
- `POST /api/transfer` → getValidToken → parseSurl → getShareList → transfer → (可选)createShare → 写任务历史
- `GET /api/accounts` / `GET /api/tasks`

> Quark/Xunlei：把 `server.js` 里 `/auth/quark`、`/auth/xunlei` 现在的「阶段开发中」占位页（`comingSoonPage`）换成真实回调逻辑即可。前端 `openAuth('quark')` / `openAuth('xunlei')` 已通用，**无需改**。

### 5.3 存储 `src/store.js`（直接用，不用改）
- `getAccount(provider)` / `saveAccount(provider, info)` —— provider 用 `'baidu' | 'quark' | 'xunlei'`
- 账号对象建议字段：`{ accessToken, refreshToken, expiresAt, scope, cookie? }`
  - 百度用 `accessToken/refreshToken`；Quark/Xunlei 用 **Playwright 拿到的 cookie/session**，存 `cookie` 字段
- `addTask(record)` / `getTasks()` —— 任务历史

### 5.4 前端 `public/app.js`
- 账号卡片是**数据驱动**的：`defs` 数组每项 `{ key:'baidu'|'quark'|'xunlei', name, a }`，未连接时自动渲染「🔗 授权XX」弹窗按钮（调 `openAuth(provider)`）
- 百度授权成功后，回调页 `postMessage({provider:'baidu',authorized:true})`，前端监听后刷新卡片为「已连接」
- **Quark/Xunlei 复用这套弹窗+自动刷新机制**：回调成功页同样 `postMessage({provider:'quark'|'xunlei',authorized:true})` 即可，前端不用改。

## 6. 凭证与安全（重要）
- `.env` 字段：`BAIDU_CLIENT_ID` / `BAIDU_CLIENT_SECRET` / `BAIDU_REDIRECT_URI` / `BAIDU_APP_DIR` / `PORT`
- Quark/Xunlei **没有「官方应用凭证」概念**：登录态靠 **Playwright 在本机自动登录后保存 cookie**（存 `data/store.json` 的账号 `cookie` 字段，gitignored）
- 任何 secret / cookie / token **绝不写进代码或提交**

## 7. Quark（第二阶段）实施要点
1. 新建 `src/quark.js`，导出与 `baidu.js` **同名**的函数
2. 登录：用 Playwright 打开 Quark 网页 → 自动登录（扫码/账密，按你们定的方案）→ 拿到 cookie/session，`saveAccount('quark', {cookie, expiresAt})`
3. 转存：逆向 Quark 的转存/分享 Web 接口（抓包得到），带 cookie 调用，实现 `getShareList`/`transfer`/`createShare` 等价逻辑
4. `server.js`：把 `/auth/quark` 占位页换成真实流程（登录成功 → saveAccount → 成功页 postMessage）
5. 联调：让前端「目标网盘」下拉里 Quark 可选（改 `index.html` 里对应 `<option>` 的 `disabled`），测 `POST /api/transfer`

## 8. Xunlei（第三阶段）实施要点
迅雷网盘**已接入**。与夸克同模式:Playwright 弹浏览器登录 pan.xunlei.com,从 API 请求头中拦截 `Authorization: Bearer` + `x-captcha-token` + `x-device-id` 存库,后续转存/分享 API 调用带上这些头。

实现已落在 `src/xunlei.js`(接口封装) + `src/xunlei.auth.js`(Playwright 登录),导出:`getValidToken / parseSurl / getShareList / saveShare / listFiles / createShare / transfer`。

`server.js` 路由:
- `GET /auth/xunlei` → 渲染 Playwright 登录页(与夸克同构)
- `POST /api/xunlei/login/start` → 启动 Playwright 登录会话(异步)
- `GET /api/xunlei/login/status` → 轮询登录状态(waiting/done/error)
- `POST /api/xunlei/logout` → 清除 token
- `POST /api/transfer` 的 `provider === 'xunlei'` 分支 → 调 `xunlei.transfer()`

**待 live 验证项**(代码中已用 `⚠️` 标注):
- `getShareList` 的响应字段名(fileInfo / list / id / name)
- `saveShare` 的路径 `/share/save` 与请求体字段(fileId / parentFolderId / space)
- `createShare` 的路径 `/share` 与请求体字段(fileId / expireAt / password)及响应字段(shareUrl / passcode)
- `listFiles` 的查询参数与响应字段

验证方法:用你账号登录 pan.xunlei.com,F12 → Network 里找上述请求,对照 `src/xunlei.js` 里对应的字段名。若迅雷改了字段,只改 `xunlei.js` 对应函数即可,无需动其他文件。

## 9. 联调与测试
- 启动后先点自己网盘的「授权」走通登录
- 用真实分享链接测 `POST /api/transfer`，检查文件是否进自己网盘、分享链接是否生成
- 任务历史在「转存任务历史」面板可见（数据在 `data/store.json`）

## 10. 提交规范
- 日常在 feature 分支开发，PR 合入 `main`
- 提交前 `git status` 确认 `.env` / `data/` / `node_modules` **不出现**在待提交列表
- 两个开发者各改各的文件（quark.js / xunlei.js / 各自路由），避免互相冲突
