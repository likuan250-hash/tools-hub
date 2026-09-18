# xfer-hub — 网盘跨盘转存

贴一个网盘分享链接 → 自动下载到本地 → 自动上传到目标网盘。

工具箱 ToolsHub 的第 6 个子工具，端口 **3900**。

## 为什么必须落地

三家网盘（百度 / 夸克 / 迅雷）的「转存」接口都只认自己签发的令牌：

- 百度 `/share/transfer` 认 `shareid` + `share_uk` + `bdstoken`
- 夸克 `/share/sharepage/save` 认 `stoken` + `share_fid_token` + `fid_list`
- 实测把百度分享链接喂给夸克的接口 → `HTTP 404 {"code":41006,"message":"分享不存在"}`

**跨盘在接口层没有入口**，与会员、限速、权限都无关。所以「下载到本地再上传」是唯一的通用路径。

## 支持的组合

| 来源 \ 目标 | 夸克 | 百度 | 迅雷 |
|---|---|---|---|
| **百度** | ✅ 已实测 | — | ❌ |
| **夸克** | — | ✅ 已实测 | ❌ |
| **迅雷** | ❌ | ❌ | — |

迅雷**没有开放平台**（实测 `/drive/v1/offline`、`/url`、`/add`、`/cloud`、`/download` 全部 404），本版本不做。
同盘转存请用「网盘转存中转」（netdisk-hub），不需要落地。

## 架构

```
renderer/index.html          单文件前端（贴链接 → 勾目标 → 看进度）
server.js                    HTTP 服务，端口 3900
src/creds.js                 凭证复用层：只读 netdisk-hub 的 store.json
src/baidu-official.js        百度开放平台 API（xpan）
src/quark-bridge.js          夸克官方 Skill 调用桥（spawn quark-drive.cjs）
src/share.js                 分享链接 → 收进自己网盘
src/xfer.js                  转存编排器（7 阶段状态机）
src/logger.js                内存环形日志
```

### 凭证怎么来的（复用，不重登）

只读 `netdisk-hub` 已保存的登录态，**不写**、不启它的进程、不碰它的端口：

- 百度：`store.json` 的 `accessToken`（OAuth，`scope = basic netdisk`）
- 夸克：官方 Skill 自己管凭证，这里只做存在性检查

`creds.js` 的关键点：**先设 `NETDISK_DATA_DIR` 再 `require` store.js** ——
store.js 在模块加载时就把 `DATA_DIR` 解析成常量，之后再改环境变量无效。

### 7 阶段流程

| 阶段 | 做什么 | 用谁的接口 |
|---|---|---|
| resolve | 识别链接来源、抽提取码 | — |
| save | 把分享收进自己网盘的中转文件夹 | netdisk-hub 的逆向实现 |
| probe | 列条目、展开目录、拿真实 size | 百度 xpan / 夸克 Skill |
| download | 下载到 `E:\网盘中转\<任务id>\` | 百度 dlink / 夸克 Skill |
| upload | 上传到目标网盘 | 百度 precreate+superfile2+create / 夸克 Skill |
| verify | 回读远端比对大小 | 同上 |
| cleanup | 删本地临时文件（可保留） | — |

## 已实测通过的接口

**百度开放平台**（全部 2026-09-18 实测）：

| 接口 | 用途 | 结果 |
|---|---|---|
| `xpan/nas?method=uinfo` | 用户信息 | ✅ `LK-转折点` / vip_type=2 |
| `xpan/file?method=list` | 列目录 | ✅ 14 个目录 |
| `xpan/multimedia?method=filemetas` | 取下载直链 | ✅ 返回 `dlink` |
| `dlink` + `User-Agent: pan.baidu.com` | 下载 | ✅ 162690B 字节一致 |
| `xpan/file?method=precreate` | 预创建 | ✅ |
| `pcs/superfile2?method=upload` | 分片上传（4MB/片） | ✅ 3 片全 200 |
| `xpan/file?method=create` | 合并落盘 | ✅ 回读字节一致 |

**夸克官方 Skill 1.0.20**：

| 命令 | 结果 |
|---|---|
| `browse --parent-fid <fid>` | ✅ |
| `download --fid <fid> --output-dir <dir>` | ✅ 29260416B 字节一致，含分片下载 |
| `upload <path> --parent-fid <fid>` | ✅ |
| `create-folder --dir-path <name>` | ✅ |
| `get-user-info` | ✅ SVIP / 72.6TB |

## 踩过的坑（改代码前必读）

### 1. 百度 `precreate.return_type` 语义容易搞反

```
return_type = 1  →  有新分片要传（uploadid 有效，继续传）
return_type = 2  →  全部分片秒传命中，无需上传
```

写反会导致「跳过上传但报成功」，回读时文件不存在。

### 2. 百度转存 `errno=2` 是成功

`netdisk-hub/src/baidu.js` 的 `transfer()` 只放行了 `0 / 4 / 12`。实测还有 **`errno=2`「文件已存在」**
——当你把文件分享给自己、目标目录里本来就有同名文件时命中。`share.js` 里已包一层兜底。

### 3. 夸克 `browse --all` 在根目录返回空

```
browse                      → 20 条  ✅
browse --all                → 0 条   ❌（Skill 自身的 bug）
```

`quark-bridge.js` 一律不用 `--all`，改用 `--page-size 100`。

### 4. 夸克有两套 fid，互不通用

| 来源 | 格式 | 用在哪 |
|---|---|---|
| 官方 Skill `browse` | `~1i0i4idhq...\|u5NzdrBtEwA`（长，含竖线） | Skill 的 download/upload |
| netdisk-hub `listFolder` | `42924899aa8e44ee88b757f853cf4559`（短，32位hex） | 转存/分享接口 |

用错格式报「文件不存在」。`xfer.js` 在 probe 阶段做转换。

### 5. 夸克禁止转存自己的分享

报「用户禁止转存自己的分享」。`share.js` 降级为「直接在自己网盘按文件名定位」——
跨盘场景下文件本来就在自己网盘里，这样反而更对。

### 6. `netdisk-hub/src/baidu.js` 的 `syncJar()` 陷阱

`syncJar()` 只在 `getShareList` / `transfer` 等业务函数内部被调用，**`reqHeaders()` 自己不调用**。
直接调 `getBdstoken()` / `createShare()` 会因 `cookieJar` 为空而误报
「BDUSS=无 登录态失效 errno=-6」。绕法：先调一次会触发 `syncJar()` 的函数热身。

### 7. `quark-drive.cjs` 的输出噪音

- 混有「拒绝访问。」（内部调 `reg.exe` 生成设备指纹被拦）—— **不影响功能**，但要逐行过滤
- `--verbose` 会打大量 `[DEBUG][TraceManager]`（阿里 ARMS 埋点）
- `create-folder` 的参数是 `--dir-path`，**不是** `--name`

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `XFER_PORT` | 3900 | 服务端口 |
| `XFER_TMP_DIR` | `E:\网盘中转` | 本地中转目录 |
| `NETDISK_DIR` | 自动探测 | netdisk-hub 安装目录 |
| `NETDISK_DATA_DIR` | 自动探测 | netdisk-hub 数据目录（凭证） |
| `QUARK_SKILL_DIR` | 自动探测 | 夸克 Skill 目录 |

## 打包

`resources/quarkclouddrive/` 由 `scripts/prepare-build.js` 从
`~/.workbuddy/skills/quarkclouddrive` 复制而来（该目录**不进 git**）。

**安全红线**：复制时必须排除 `scripts/.quarkclouddrive/`（夸克登录凭证落盘位置），
否则安装包会带上本机夸克账号。`verify-build-assets.js` 里有对应的反例断言做门禁。
