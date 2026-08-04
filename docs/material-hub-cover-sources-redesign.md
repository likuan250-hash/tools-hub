# material-hub 封面/视频来源改造方案

> 状态：规划中（架构师细化进行中）
> 日期：2026-08-04
> 背景：用户反馈"封面经常全超时、只能抽帧兜底"。GitHub 调研确认现有 DuckDuckGo scraping 链路本质不稳，需系统性改造。

## 一、问题根因（已确认）

当前封面 8 级降级链中，**4 级依赖 DuckDuckGo HTML scraping**（`cover.js` 的 `discoverViaDuckDuckGo`）：

| 级 | 来源 | 搜索引擎 | 稳定性 |
|---|---|---|---|
| 1 | 4kwallpapers.com | DuckDuckGo | ❌ 不稳 |
| 2 | alphacoders.com | DuckDuckGo | ❌ 不稳 |
| 5 | 游戏媒体站（Nintendo/PS/Xbox/IGN 等） | DuckDuckGo | ❌ 不稳 |
| 6 | 中文游戏站（游民星空/3DM/游侠/163/qq） | DuckDuckGo | ❌ 不稳 |

**DuckDuckGo 的问题**：
- bot 检测严格，中文查询经常返回网关页
- 走代理时频繁超时（15s/30s）
- 一挂全挂 → 实测日志 6-8 个来源全部 ETIMEDOUT，最后只能 ffmpeg 抽帧兜底

**稳定来源（保留不动）**：wallhaven API、Reddit JSON API、用户指定 URL、YouTube 缩略图、ffmpeg 抽帧。

## 二、GitHub 调研结论（2026-08-04）

### 方案 A：Bing 图片搜索替代 DuckDuckGo（核心改造）

多个开源项目验证可行（GameCoverScraper、bing_images、Bing-Image-Scraper）：

- **URL**：`https://cn.bing.com/images/search?q={query}&form=HDRSC2`
- **中文支持**：cn.bing.com 国内可直连，中文查询天然支持（不需要代理）
- **尺寸过滤**：`&qft=+filterui:imagesize-custom_1280_720` 或 `+filterui:imagesize-large`
- **HTML 结构**：`<a class="iusc">` 标签的 `m` 属性是 JSON，其中 `m.murl` 是原图直链
- **反爬**：需要带浏览器 User-Agent，避免默认 UA 被拦

**设计意图**：Bing 成为所有"站内搜索"的统一搜索引擎。把 `discoverViaDuckDuckGo` 替换为 `discoverViaBing`，4kwallpapers/alphacoders/游戏媒体站/中文站 4 级统一换引擎。

### 方案 B：Steam CDN 直连（白捡来源）

已通过维基百科→Wikidata→P1733 拿到 `steamAppId`（实测 Just Cause 4→517630）。Steam CDN 免 key：

```
https://cdn.akamai.steamstatic.com/steam/apps/{appid}/library_hero.jpg    （1920×620 横版）
https://cdn.akamai.steamstatic.com/steam/apps/{appid}/header.jpg           （460×215 太小）
https://cdn.akamai.steamstatic.com/steam/apps/{appid}/capsule_616x353.jpg  （616×353 太小）
https://cdn.akamai.steamstatic.com/steam/apps/{appid}/library_600x900_2x.jpg（竖版封面）
```

注意：`library_hero.jpg` 是 1920×620，高度不满足当前 1280×720 的最小要求。处理策略（架构师裁定）：
- 尺寸不达标则跳过（不占用达标名额），或
- 参照 YouTube 缩略图"降级候选"模式：官方图允许降级标记

### 方案 C：保留现有稳定来源

wallhaven API、Reddit、用户 URL、YouTube 缩略图、抽帧兜底——全部保留，不动。

## 三、改造范围（待架构师细化）

| 文件 | 改动 |
|---|---|
| `material-hub/lib/cover.js` | `discoverViaDuckDuckGo` → `discoverViaBing`；新增 `parseBingImageResults` 纯函数；新增 `fromSteamCdn`；各来源函数换引擎 |
| `material-hub/lib/collect.js` | 确认 steamAppId 已传给 cover（若未传则补） |
| `material-hub/public/app.js` | `COVER_SOURCE_LABEL` 加新来源标签 |
| `material-hub/test/cover.test.js` | 新增 `parseBingImageResults` / URL 拼接 / 相关性校验单测 |

## 四、新封面来源优先级链（草稿）

```
1. Steam CDN 直连      ← 新增（有 appid 时优先，官方图无水印）
2. wallhaven API       ← 保留（稳定，英文搜索）
3. Reddit              ← 保留（稳定，英文搜索）
4. Bing 搜索：4kwallpapers / alphacoders（英文站）
5. Bing 搜索：游戏媒体站（Nintendo/PS/Xbox/IGN/GameSpot/PCGamer）
6. Bing 搜索：中文游戏站（游民星空/3DM/游侠/163/qq，⚠可能带水印）
7. 用户指定 URL
8. YouTube 缩略图（降级候选）
9. ffmpeg 抽帧兜底（必然成功）
```

（最终顺序以架构师方案为准）

## 五、实施计划（顺序）

1. 架构师输出细化方案（进行中）
2. 工程师实现（Bing 引擎替换 + Steam CDN + 前端标签 + 单测）
3. QA 验证（纯函数单测 + 真机 Bing 搜索验证）
4. 主理人复核 → 发版

## 六、风险与待确认

- [ ] Bing 是否需要代理？（cn.bing.com 国内可直连，但走了代理是否更稳？）
- [ ] Bing 反爬缓解措施（UA、请求间隔、失败重试）
- [ ] Steam library_hero 尺寸不达标的处理策略
- [ ] `discoverViaDuckDuckGo` 是否彻底删除（还是保留为备用降级）
