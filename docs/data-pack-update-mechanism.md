# 离线数据包增量更新机制（data-pack）

> 版本：v2.7.16 起生效
> 状态：✅ 已上线（2026-08-05）
> 适用范围：kdocs-tool 离线游戏映射数据（中文名→英文名 override + 英文名→Steam AppID）

## 1. 背景与目标

### 1.1 问题

kdocs-tool 的离线数据此前全部打包进安装包（`extraResources`）：

| 数据 | 文件 | 大小 | 来源 |
|---|---|---|---|
| 大库 | `game-name-map.json` | ~713KB / 2.5 万条 | 上游开源项目 Karasukaigan/pc-game-name-translations |
| 手工精选 | `game-name-override.json` | ~KB | 维护者手工维护 |
| 离线 AppID | `game-appid-override.json` | ~KB | 维护者手工维护（web 核验后入库） |

由于安装包按 App 版本号分发（electron-updater），**更新数据 = 整包升级**：为加几条映射就要出一个几十 MB 的安装包，重且慢，用户体验差。

### 1.2 目标

- 让**小数据增量**（KB 级手工映射）可以不随整包升级独立更新；
- 用户**零打扰**：自动生效、失败静默回退，绝不因数据更新引入风险；
- 维护者操作简单：改数据 → bump 版本 → 发版上传资产即可。

### 1.3 方案选型（2026-08-05 与用户拍板）

- ✅ **方案 A（已选）：启动静默拉取** —— App 启动时后台拉取 GitHub Release 附加资产 `data-pack.json`，版本更高则写本地缓存覆盖内置。
- ❌ 方案 B：手动点按钮拉取（弃：不够自动）
- ❌ 方案 C：随整包升级（弃：重）
- ❌ 方案 D：手动导入文件（弃：最不自动）

## 2. 机制总览

```
┌─────────────────────────── 发布侧（维护者） ───────────────────────────┐
│  1. 编辑 kdocs-tool/lib/data-pack.json（新增/修正映射，version +1）      │
│  2. release.sh 发版 → gh release upload data-pack.json（Release 资产）   │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ https://github.com/likuan250-hash/tools-hub
                                   │ /releases/latest/download/data-pack.json
                                   ▼
┌─────────────────────────── 运行侧（用户 App） ─────────────────────────┐
│  App 启动（main.js refreshDataPack，后台 fire-and-forget）               │
│  Electron net.fetch 拉取 → JSON 合法且 version ≥ 1？                      │
│      ├─ 是 → 写 {userData}/kdocs-tool/data/data-pack.json（缓存）         │
│      └─ 否/网络失败/超时 → 静默忽略（用内置）                              │
│                                                                         │
│  用户录入游戏时（kdocs-tool 子进程查询）：                                │
│  getActiveDataPack()：缓存 version > 内置 version ? 缓存 : 内置          │
│      → gamemap.lookupEnglishNameOffline / gameappid.lookupAppIdOffline   │
└─────────────────────────────────────────────────────────────────────────┘
```

## 3. 数据包结构（data-pack.json）

```jsonc
{
  "version": 1,            // 递增正整数，数据更新时 +1（择优依据）
  "updatedAt": "2026-08-05",
  "gameNames": {           // 中文名(原始写法) → 英文名（归一化键在加载时构建）
    "巫师3": "The Witcher 3: Wild Hunt",
    "最后生还者2重制版": "The Last of Us Part II Remastered"
  },
  "appIds": {              // 英文名(原始写法) → Steam AppID（字符串）
    "The Last of Us Part II Remastered": "2531310"
  }
}
```

- `gameNames` 键：中文名，加载时经 `normZh` 归一化（小写、全角→半角、去空白/标点/「的」、重置版/复刻版→重制版）。
- `appIds` 键：英文名，加载时经 `normEn` 归一化（小写、去所有非字母数字）。
- **只收录确实上架 Steam 的游戏**：塞尔达（任天堂独占）、《最后生还者重制版》(PS4) 等无 Steam AppID 的不收录，避免误标封面/简介。

## 4. 择优规则（getActiveDataPack）

```
best = 内置包（随安装包，永远存在）
cache = 本地缓存 {KDOCS_DATA_DIR}/data-pack.json
若 cache 存在且 cache.version > best.version → best = cache
返回 best（最差返回空包 {version:0, gameNames:{}, appIds:{}}，绝不抛错）
```

- 缓存目录：`KDOCS_DATA_DIR`（打包时 = `{userData}/kdocs-tool/data`）；开发模式回退 `kdocs-tool/cache/`。
- **每次查询实时重读缓存**（KB 级，开销可忽略），保证主进程更新缓存后子进程立即生效，无需进程间通知。
- 低版本缓存（≤ 内置）被忽略 → **天然防旧包回滚**。
- 损坏缓存（JSON 解析失败 / version 非数字）→ 静默回退内置。

## 5. 运行侧实现（文件职责）

| 文件 | 职责 |
|---|---|
| `kdocs-tool/lib/data-pack.json` | 数据本体（内置，随安装包分发） |
| `kdocs-tool/lib/datapack.js` | 数据包管理：归一化、内置加载、缓存加载、`getActiveDataPack()` 择优 |
| `kdocs-tool/lib/gamemap.js` | 中文名→英文名查询，优先查 `getActiveDataPack().gameNames`，再查大库 |
| `kdocs-tool/lib/gameappid.js` | 英文名→AppID 查询，查 `getActiveDataPack().appIds` |
| `main.js` `refreshDataPack()` | 启动后台静默拉取 GitHub Release 资产 → 写缓存（10s 超时，失败静默） |
| `release.sh` | 发版时 `gh release upload data-pack.json --clobber` 上传资产 |

### 5.1 主进程拉取要点

- 用 **Electron `net.fetch`**：自动认系统代理 + 系统证书库（比子进程代理感知层更通用）。
- `AbortController` + 10s 超时；响应非 2xx / JSON 非法 / version 非法 → 静默。
- 在 `app.whenReady` 中调用 `refreshDataPack().catch(()=>{})`，**不阻塞启动**。

## 6. 维护者操作手册（如何更新数据）

### 6.1 小数据增量（推荐，用户无需装新包）

```bash
# 1. 编辑 data-pack.json：新增/修正映射，version +1（如 1 → 2）
# 2. 更新 updatedAt
# 3. 跑单测（datapack.test.js 有内置结构断言；gamemap/gameappid 回归）
cd /e/d/work/tools-hub/kdocs-tool && node --test
# 4. 发版（release.sh 会自动把 data-pack.json 上传为 Release 资产）
cd /e/d/work/tools-hub && bash release.sh
# 5. 用户重启 App → 日志出现「data-pack 更新成功 vN」→ 新映射生效
```

> 注：发版仍需 bump App 版本（electron-updater 按版本判断），但**数据更新与 App 功能解耦**——
> 之后可以只 bump 数据包版本并发资产；若要用户完全不装包，则数据更新走「单独 release」流程（待扩展）。

### 6.2 大库同步（game-name-map.json）

- 数据来自上游开源项目，**仍随整包升级**（更新频率低，713KB 单独走数据通道收益有限）。
- 操作：拉取上游最新数据 → 归一化重建 → bump App 版本 → 正常发版。

## 7. 回退与容错矩阵

| 场景 | 行为 |
|---|---|
| 网络不可达 / 超时 / GitHub 被墙 | 静默，用内置 |
| 远端数据包版本 ≤ 本地 | 不覆盖缓存，用较高者 |
| 缓存文件损坏（半包/乱码） | 解析失败回退内置 |
| 内置包缺失（异常安装） | 返回空包，查询走网络兜底 |
| 用户配了系统代理 | `net.fetch` 认代理 → 拉取更大概率成功 |

## 8. 测试

- `kdocs-tool/test/datapack.test.js`（6 例）：内置结构/关键映射、缓存高版本生效、缓存低版本回退、损坏缓存回退、归一化。
- 回归：`kdocs-tool` 全量 155（150 pass + 5 网络 skip）。

## 9. 已知边界 / 待办

- [ ] 数据更新目前仍伴随 App 发版流程（release.sh 每次 bump App 版本）；纯数据热更新通道（不 bump App）可后续单独立项。
- [ ] 大库 `game-name-map.json` 未纳入数据包（体积/频率权衡，维持现状）。
- [ ] GitHub 在大陆需代理：未配代理时启动拉取会静默失败（不影响功能，仅数据不增量）。

## 10. 相关文档

- 英文名在线源连通架构：见《工具数据源架构》（v2.7.12 起，含 Bangumi 国内源、代理感知层）
- 版本号约定：根 README / 发布清单 `docs/RELEASE_CHECKLIST.md`
