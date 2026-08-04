# 金山文档多维表智能录入工具（kdocs-tool）

把游戏信息（名称 + 标签 + 百度/夸克/迅雷链接）自动解析、从 Steam 官方抓取介绍与封面、下载封面，写入**金山文档多维表**的本地 Node 服务。带 Tkinter 控制面板（无黑窗启动/停止/重启/打开网页）。

> 本工具是「游戏上新」工作流的上游：录入金山文档多维表，下游再由网盘转存中转台分发。

---

## 一、环境要求（另一台电脑请先确认）

| 依赖 | 用途 | 是否自带 | 说明 |
|---|---|---|---|
| **Node.js 18+**（推荐 22） | 运行服务 | ❌ 需安装 | 建议用 WorkBuddy 托管版或官网安装 |
| **金山文档 kdocs-cli** | 读写多维表 | ✅ 自带 `kdocs-cli-bin/kdocs-cli.exe` | 但**账号鉴权是机器绑定**，新电脑需重新登录（见下） |
| **Python 3.10+（带 tkinter）** | 控制面板 UI | ❌ 可选 | 不用面板可跳过；用面板则需 `pythonw`/`python` + `tkinter`。WorkBuddy 托管 Python 已含 tkinter |

---

## 二、快速开始（新电脑）

```bash
# 1. 克隆（仓库地址以实际为准）
git clone git@github.com:likuan250-hash/kdocs-tool.git
cd kdocs-tool

# 2. 安装 Node 依赖（package-lock.json 已锁定版本）
npm install

# 3. 金山文档鉴权（机器绑定，每台电脑都要做一次）
#    直接用项目自带的 CLI：
kdocs-cli-bin/kdocs-cli.exe auth login
#    或若已全局安装 kdocs-cli： kdocs-cli auth login
#    按提示用浏览器扫码/授权，登录成功后工具才能读写多维表。

# 4. 启动
#    方式 A（推荐，带控制面板无黑窗）：双击 `启动面板.bat`
#    方式 B（纯命令行）： npm start
#    浏览器打开 http://localhost:3599
```

---

## 三、控制面板用法

双击 `启动面板.bat`（或先运行 `create-shortcut.vbs` 生成桌面快捷方式）打开面板：

- **启动**：拉起 node 服务（带全部最新代码）
- **停止 / 退出**：正确 `taskkill` 掉 node，不会再出现「关不掉服务」的情况
- **重启**：改了代码后点它让改动生效
- **打开网页**：自动打开 http://localhost:3599
- 面板含看门狗（node 崩溃自动拉起）、单实例锁、运行日志区

端口冲突时改环境变量：`set KDOCS_PORT=3600` 后再启动。

---

## 四、网页端录入

1. 在文本框粘贴游戏信息（格式示例）：
   ```
   尼尔：机械纪元 年度版 完美汉化+全DLC 免安装硬盘版 30.7G
   链接: https://pan.baidu.com/s/xxxx?pwd=8888
   链接：https://pan.quark.cn/s/yyyy
   ```
2. 可手填 **🖼️ 封面链接**（非 Steam 游戏填封面链接才能出图）。
3. 点「解析预览」确认名称/标签/链接/封面无误。
4. 点「一键录入」：自动搜 Steam AppID → 取 Steam 官方介绍与大小 + 下载封面 → 上传金山文档 → 建多维表记录。**执行进度以流式实时展示**，每一步「进行中 → 成功/跳过/失败」都会即时刷新，可清楚看到当前进行到哪一步。
5. 右上角 🌗 可切换浅色/深色主题（与网盘转存中转台风格统一）。

字段对照（金山文档多维表）：游戏名称 / 游戏介绍 / 游戏信息（标签数组）/ 百度网盘 / 夸克网盘 / 迅雷网盘 / 作品展示（封面图）/ 更新日期 / 游戏大小 / 查询数据编号。

---

## 五、配置项

| 项 | 位置 | 默认值 |
|---|---|---|
| 服务端口 | 环境变量 `KDOCS_PORT` 或 `lib/config.js` | 3599 |
| 多维表 `file_id` | `lib/config.js` 的 `FILE_ID` | `h9aREMoyL1MMMeDCHLWa1xsikoTpExj2o` |
| 多维表 `sheet_id` | `lib/config.js` 的 `SHEET_ID` | 1 |
| 封面下载目录 | `lib/steam.js` 的 `DEFAULT_COVER_DIR` | `E:\游戏网站建设` |
| 单实例锁端口（控制面板） | `control_panel_tk.py` 的 `LOCK_PORT` | 39112（避开 netdisk-hub 的 39111） |

---

## 六、目录结构

```
kdocs-tool/
├─ server.js / index.js / router.js   # Express 服务 + 路由
├─ lib/
│  ├─ parser.js      # 解析输入文本（名称/标签/链接/大小/封面链接）
│  ├─ steam.js       # Steam AppID 搜索 + 多源封面下载（cloudflare 优先）
│  ├─ ai.js          # （已废弃）原 bl 封装：生成介绍 + 抓大小 + 搜封面直链。现已移除 bl 依赖，留空壳待本地清理
│  ├─ kdocs.js       # kdocs-cli 调用封装（优先用自带 CLI）
│  ├─ executor.js    # 编排：查重→介绍→封面→上传→建记录
│  ├─ prompt.js      # 生成「给智能体的标准指令」模板
│  └─ config.js      # 端口/多维表/file_id 等配置
├─ public/           # 前端（玻璃拟态 + 主题切换）
├─ kdocs-cli-bin/    # 自带的金山文档 CLI（v2.5.22）
├─ kdocs-skill/      # WorkBuddy 技能参考文档
├─ assets/           # 面板图标
├─ control_panel_tk.py  # Tkinter 控制面板
├─ 启动面板.bat / create-shortcut.vbs / setup.bat / start-server.bat
└─ package.json / package-lock.json
```

---

## 七、已知限制 / 注意事项

- **金山文档鉴权是机器绑定**：换电脑必须重新 `kdocs-cli auth login`，克隆代码不会带登录态。
- **介绍与大小来自 Steam 官方**：无 Steam 官方描述时，游戏介绍占位为「介绍待补充」并标记需人工校对；游戏大小无来源时留空 + 待核。均不阻断流程。
- **非 Steam 游戏封面**：可在网页「封面链接」手动粘贴封面直链；未填且无 Steam 封面时跳过封面（不报错）。
- **游戏大小**：优先级 `Steam 官方大小 > 文本识别(如 30.7G)`；前端不再展示，有则写入多维表、无则留空。
- **数据写入是真实多维表**：录入前请确认 `lib/config.js` 的 `FILE_ID` 指向正确表格。
- **逻辑独立**：本工具仅参考 netdisk-hub 的风格，代码完全位于本仓库 `kdocs-tool/`，不依赖外部项目目录。

---

## 八、推送到 GitHub（远程仓库尚未创建时）

本仓库已 `git init` 并完成首次提交（本地 `main` 分支），`.gitignore` 已排除 `node_modules`/`logs`/`*.zip`/`*.lnk` 等。远程 `origin` 已指向 `git@github.com:likuan250-hash/kdocs-tool.git`，但**远程仓库需在 GitHub 网页先行创建**（本机无 GitHub PAT，无法自动建仓）：

1. 打开 https://github.com/new ，仓库名填 `kdocs-tool`，**不要**勾选初始化 README / .gitignore（保持空仓库）。
2. 双击仓库内的 `PUSH_TO_GITHUB.bat`（脚本会先检测仓库是否存在，存在才推送）。
3. 本机 SSH key 已配置，可直接推送，无需再输密码。

> 若希望由 AI 直接完成「建仓 + 推送」，请提供 GitHub Personal Access Token（勾选 `repo` 权限），或在本机终端执行一次 `gh auth login` 后告知即可。

克隆到另一台电脑：

```bash
git clone git@github.com:likuan250-hash/kdocs-tool.git
cd kdocs-tool && npm install
```
