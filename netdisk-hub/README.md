# netdisk-hub · 网盘转存中转台

本地运行的「多网盘转存中转台」:把**别人的分享链接**转存到**我的网盘**,再一键生成**我的分享链接**。

> 第一阶段已打通:**百度网盘**全链路(官方 API,稳定)。
> 第二阶段已接入:**夸克网盘**(本机 Playwright 登录拿 Cookie + 网页端逆向接口;接口属非公开,若夸克改版可能需微调,见下方"夸克网盘接入")。
> 第三阶段已接入:**迅雷网盘**(Playwright 本机登录 + 逆向接口;与夸克同模式,弹浏览器登录后拦截 token。接口属非公开,若迅雷改版可能需微调,见下方"迅雷网盘接入")。

## 功能
- 粘贴别人的百度分享链接(+提取码)→ 转存到我网盘的 `/apps/应用名` 目录
- 转存后一键生成**我自己的分享链接 + 提取码**(可选密码、永久有效)
- 转存任务历史记录(本地保存)
- 玻璃拟态 UI + 明暗主题切换
- 三个网盘账号状态卡片(百度/夸克可用,迅雷显示「待接入」)

## 快速开始
1. 安装 Node.js 22+ (https://nodejs.org)
2. 配置凭证:
   ```bash
   cp .env.example .env
   ```
   编辑 `.env`,填入你自己在百度开放平台申请的 `BAIDU_CLIENT_ID` / `BAIDU_CLIENT_SECRET`。
3. 启动（二选一）:
   - 新手：**双击 `setup.bat`**，自动装依赖 + Chromium 内核并启动（推荐）
   - 或手动：
   ```bash
   npm install
   node server.js
   ```
4. 浏览器打开 http://localhost:3000
5. 点击百度卡片上的「🔗 授权百度网盘」,弹窗会**直接显示百度登录二维码**;用百度网盘 App 扫码,手机上点「确认」即自动连上(无需复制 token)
6. 粘贴别人分享链接 + 提取码,点「开始转存」(可选同时生成我的分享)

## 申请百度应用(必须,需你本人操作)
1. 打开 https://developer.baidu.com (或 https://pan.baidu.com/union) ,用你的百度账号注册「个人开发者」
2. 控制台 → 创建应用 → 应用类型选「桌面应用」(或「软件」)
3. 勾选权限 `basic`、`netdisk`(注意是小写英文逗号)
4. 安全配置 → 授权回调地址填:`http://localhost:3000/auth/baidu/callback`
   - 若你在**多台电脑**上用且主机/端口不同,把每台机器的回调地址都加进这个列表(百度允许配多个)
5. 创建后拿到 `API Key`(=client_id)和 `Secret Key`(=client_secret),填入 `.env`
6. 申请时填的「产品名称」决定转存目录:产品名 `netdisk_hub` → `.env` 里 `BAIDU_APP_DIR=/apps/netdisk_hub`(两者保持一致)
7. 授权体验:本项目的授权页用了百度官方 `display=tv&qrcode=1` 参数,**弹窗直接出二维码**,扫码即在手机点「确认」即连上,无需手动复制 token

## 夸克网盘接入(第二阶段)
夸克**没有官方开放平台应用**,走的是"本机 Playwright 登录拿 Cookie + 网页端逆向接口"的路线。

### 1. 安装浏览器内核
本项目依赖 `playwright`。首次 `npm install` 后,还需下载 Chromium 内核(仅一次):
```bash
npx playwright install chromium
```

### 2. 在页面登录夸克
1. 浏览器打开 http://localhost:3000
2. 点「夸克网盘」卡片上的 **🔗 授权夸克网盘**
3. 会弹出本机浏览器窗口进入 pan.quark.cn,用**手机夸克 App 扫码**或账号密码登录
4. 登录成功后,弹窗自动关闭、首页夸克卡片变「已连接」,即可开始转存

> Cookie 存于本机 `data/store.json`,会过期(通常几天~几周)。失效后重新点「授权夸克网盘」登录即可。

### 3. 转存逻辑
粘贴别人的夸克分享链接(`https://pan.quark.cn/s/xxxx`,可带 `?pwd=提取码`)→
后端自动:取 stoken → 读分享文件列表 → 转存到你夸克根目录下的 `netdisk_hub` 文件夹 →(可选)生成你自己的分享链接。

> ⚠️ 逆向接口说明:夸克网页端 API 属非公开契约,下方字段(`expired_type` 档位映射、部分返回 key)以当前实测为准;若日后夸克改版导致转存/分享报错,多半只需微调 `src/quark.js` 里对应请求体,无需动其它模块。

## 在多台电脑上使用
本应用是**纯本地、无中心服务器**,每台电脑独立运行、数据不互通:
1. 把整个 `netdisk-hub` 目录拷到另一台电脑(或 git clone)
2. **双击 `setup.bat`**:自动检测 Node、装依赖、装 Chromium 内核、生成 `.env`、启动服务
3. 各自在自己的 `.env` 填**自己的**百度凭证(申请方法见上方「申请百度应用」)
4. 浏览器打开 http://localhost:3000,各自扫码授权各自的账号
5. 数据(账号 token、转存历史)存在本机 `data/store.json`,各机完全独立

> 进阶(可选):后续可用 `pkg` 打包成单个 `.exe`,那台电脑连 Node 都不用装,双击即用。

## 推送到 GitHub 私有仓库(代码备份 / 多机同步)
本项目是带 Node 后端的**动态应用,不能用 GitHub Pages 静态托管**。代码可传 GitHub **私有仓库**做备份和跨机同步:

```bash
# 1. 在 GitHub 新建 Private 仓库(不要勾 Add README),复制仓库 URL
# 2. 本地关联并推送(已在项目里 git init,且 .gitignore 已排除密钥)
git branch -M main
git remote add origin https://github.com/你的用户名/netdisk-hub.git
git push -u origin main
```
> ⚠️ 安全:`.env`(百度 client_secret)和 `data/`(access_token)已被 `.gitignore` 排除,**不会进仓库**。务必保持仓库为 Private,切勿提交凭证。

另一台电脑拉取使用:
```bash
git clone https://github.com/你的用户名/netdisk-hub.git
cd netdisk-hub
npm install
cp .env.example .env   # 各自填自己的百度凭证
node server.js
```

## 目录结构
```
netdisk-hub/
├─ server.js            Express 入口(路由 + API)
├─ src/
│  ├─ store.js          JSON 文件存储(账号 / 任务)
│  ├─ baidu.js          百度 OAuth + 转存 + 生成分享
│  ├─ quark.js          夸克网页端逆向接口封装(转存 / 分享 / 文件夹)
│  ├─ quark.auth.js     夸克 Playwright 本机登录(拿 Cookie 存库)
│  ├─ xunlei.js         迅雷网页端逆向接口封装(转存 / 分享 / 文件列表)
│  ├─ xunlei.auth.js    迅雷 Playwright 本机登录(拦截 token + captchaToken 存库)
│  └─ store.js          JSON 文件存储(账号 / 任务)
├─ public/
│  ├─ index.html        主页(玻璃拟态 UI)
│  └─ app.js            前端逻辑
├─ data/store.json      本地数据(运行后自动生成)
├─ .env.example         配置模板
├─ setup.bat            一键安装启动(检测 Node → npm install → playwright install → 启动)
├─ start-server.bat     后台启动服务(被 setup.bat / 启动面板.bat 调用)
├─ 启动面板.bat         双击启动 tkinter 控制面板(无黑框)
├─ control_panel_tk.py  控制面板(tkinter 原生 GUI)
├─ DEPLOY.md            部署指南(给朋友版)
└─ README.md
```

## 接口
- `GET  /auth/baidu`          跳转百度授权(TV 扫码模式,弹窗直接出二维码)
- `GET  /auth/baidu/callback` 授权回调,换 token 存库
- `GET  /auth/quark`          夸克登录页(启动本机浏览器登录,成功后回写 Cookie)
- `POST /api/quark/login/start` 启动一次夸克登录会话(异步)
- `GET  /api/quark/login/status` 轮询登录状态(waiting/done/error)
- `POST /api/quark/logout`   清除夸克 Cookie
- `GET  /auth/xunlei`         迅雷登录页(启动本机浏览器登录,成功后拦截 token)
- `POST /api/xunlei/login/start` 启动一次迅雷登录会话(异步)
- `GET  /api/xunlei/login/status` 轮询登录状态(waiting/done/error)
- `POST /api/xunlei/logout`   清除迅雷 token
- `POST /api/transfer`        {provider, link, pwd, makeShare, sharePassword} → 转存(+生成分享, 分享永久有效)
- `GET  /api/accounts`        三网盘连接状态
- `POST /api/transfer`        {provider, link, pwd, makeShare, sharePeriod, sharePassword} → 按 provider 转存(+生成分享)
- `GET  /api/tasks`           转存历史

## 迅雷网盘接入(第三阶段)
迅雷没有官方开放平台应用,走 **Playwright 本机登录 + 逆向接口**(与夸克同模式)。
登录时从浏览器 API 请求头中拦截 `Authorization: Bearer` + `x-captcha-token` + `x-device-id` 存库,后续转存/分享 API 调用带上这些头。

### 使用方式
1. 首次使用需安装 Playwright 浏览器内核:`npx playwright install chromium`(仅需一次)
2. `.env` 里的迅雷参数通常**保持默认即可**(无额外凭证需要申请)
3. 启动后点页面「🔗 授权迅雷网盘」,弹窗会弹出本机浏览器打开 pan.xunlei.com
4. 在弹出的浏览器窗口中用迅雷 App 扫码或账号密码登录,登录成功后弹窗自动关闭,卡片变成「已连接」
5. 粘贴迅雷分享链接 `https://pan.xunlei.com/s/xxxx`(+提取码),选「迅雷网盘」,点「开始转存」

### 迅雷待 live 验证项
迅雷的网页接口属非公开,部分接口的请求体/响应字段可能因迅雷改版而变化。代码中已用 `⚠️ 待 live 验证` 注释标注了以下需用你账号实际验证的部分:
- `getShareList`:/share 接口的响应字段名(fileInfo / list / id / name)
- `saveShare`:/share/save 的路径与请求体字段(fileId / parentFolderId / space)
- `createShare`:/share 的请求体字段(fileId / expireAt / password)与响应字段(shareUrl / passcode)
- `listFiles`:/files 的查询参数与响应字段

验证方法:登录 pan.xunlei.com,F12 → Network 里找上述请求,对照代码里的字段名。若迅雷改了字段,改 `src/xunlei.js` 对应函数即可,无需动其他文件。

> ⚠️ 迅雷官方对频繁调用接口行为可能进行风控限制,请适度使用。
