# resolve-auto：达芬奇游戏剪辑标准流程自动化

对应《达芬奇游戏剪辑项目标准流程.md》中可脚本化的步骤：

- `setup`：步骤 0-4 —— 自动启动 Resolve、新建项目（60fps）、导入封面+预告片到媒体池、导入 DRT 时间线模板、把封面(3s)+预告片追加到 V1/A1。
- `render`：步骤 8-9 —— 加载「导出预设」、设 MP4/H.264、渲染并验证输出。

步骤 5-7（手动）：拉伸 V2[3]/V3[3] 尾部文本对齐视频、V1 封面与视频间加平滑剪接（60f/1s）、修改 V2[1] 开场文本为游戏名。这三步是 Resolve 20 脚本 API 的硬边界（无拉伸时长/加转场/改 Rich 文本的接口），保持手动。

## 用法

```bash
# 步骤 0-4（项目名默认取素材目录名）
node scripts/resolve-auto/index.js setup --dir "E:\素材\【游戏282】装机模拟器2（PC Building Simulator 2）"

# 用户手动完成 5-7 后（按标准流程命名规则，--out/--target 可省略）：
node scripts/resolve-auto/index.js render --project "【游戏282】装机模拟器2（PC Building Simulator 2）"
```

`render` 默认输出文件名 = `项目名 + " 官方中文+全DLC+免安装硬盘版 免费学习版下载"`，输出到 `E:\素材\<项目名>\`；
`--out` / `--target` 可覆盖（版本行因作而异时请显式给 `--out`）。`--mark-in/--mark-out`（帧号）可只渲染区间做验证。

## 配置（环境变量覆盖）

| 变量 | 默认值 |
|---|---|
| `RESOLVE_EXE` | `D:\Program Files\Blackmagic Design\DaVinci Resolve\Resolve.exe` |
| `RESOLVE_SCRIPT_API` | `C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting` |
| `RESOLVE_SCRIPT_LIB` | `D:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll` |
| `RESOLVE_PYTHON` | `python`（须为可加载 fusionscript.dll 的 64 位 Python；勿用 Resolve 内置 3.12） |
| `RESOLVE_TEMPLATE_DRT` | `E:\素材\时间线\Timeline 1.drt` |
| `RESOLVE_RENDER_PRESET` | `导出预设` |
| `RESOLVE_MATERIAL_ROOT` | `E:\素材` |
| `RESOLVE_FFMPEG` | tools-hub 内置 ffmpeg |
| `RESOLVE_FFPROBE` | tools-hub 内置 ffprobe |
| `RESOLVE_WORK_DIR` | `E:\素材\_resolve-work`（封面 3s 视频等中间产物） |
| `RESOLVE_WORK_KEEP_DAYS` | `30`（中间文件保留天数，超出自动清理） |

## 说明

- 幂等：`setup` 重复执行时，若时间线已有该预告片则跳过导入/追加；`render` 在项目不存在时报错而非新建。
- 素材目录约定与 tools-hub 素材收集一致：`封面.*` + 预告片视频（自动排除 `.fXXX` 半成品）。
- 输出文件名请按实际版本信息给 `--out`，不要照搬文档里的「全DLC」固定后缀。
- 封面以 3 秒 60fps 视频形式进时间线：Resolve 静帧时长由项目默认值决定且 API 不可改，
  `make_cover_video` 用 ffmpeg 生成 `_resolve-work\cover_3s.mp4`（可复用、不入素材目录）。
- 预告片若非 H.264（如 VP9/AV1），先转码为 H.264/AAC 再进时间线——实测 Resolve 渲染 VP9 源会失败。
- `render` 前会做非阻塞自检：V1 封面/预告片/平滑剪接、V2[3]/V3[3] 尾部文本时长是否对齐视频。
- 连接策略：Resolve 启动后脚本服务约 60-90 秒才就绪，过早探测会打断它；脚本先暖机 75 秒再温和轮询。
- Resolve.exe 本机被设为「始终以管理员身份运行」，脚本启动它会弹 UAC；渲染输出目录会自动创建。
