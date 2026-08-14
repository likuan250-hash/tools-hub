// DaVinci Resolve 自动化路径配置：全部支持环境变量覆盖（便于其他机器/CI 使用）。
module.exports = {
  // Resolve 可执行文件（步骤 0 自动启动用）
  resolveExe: process.env.RESOLVE_EXE || 'D:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\Resolve.exe',
  // 脚本 API 模块目录（安装时位于 Support/Developer/Scripting）
  scriptApi: process.env.RESOLVE_SCRIPT_API
    || 'C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting',
  // fusionscript.dll 完整路径
  scriptLib: process.env.RESOLVE_SCRIPT_LIB
    || 'D:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fusionscript.dll',
  // 可加载 fusionscript.dll 的 64 位 Python（注意：Resolve 内置 Python 3.12 会静默崩溃，勿用）
  python: process.env.RESOLVE_PYTHON || 'python',
  // 时间线模板（标准流程文档指定的 DRT）
  templateDrt: process.env.RESOLVE_TEMPLATE_DRT || 'E:\\素材\\时间线\\Timeline 1.drt',
  // 导出预设名（Deliver 页自定义预设）
  renderPreset: process.env.RESOLVE_RENDER_PRESET || '导出预设',
  // 素材根目录（render 未指定 --target 时默认输出到 E:\素材\<项目名>\）
  materialRoot: process.env.RESOLVE_MATERIAL_ROOT || 'E:\\素材',
  // ffmpeg：当前流程已改为 AppendToTimeline 静帧直接入轨，不再使用（保留仅为 CLI/环境变量兼容）
  ffmpeg: process.env.RESOLVE_FFMPEG
    || 'E:\\Codex\\tools-hub\\material-hub\\node_modules\\@ffmpeg-installer\\win32-x64\\ffmpeg.exe',
  ffprobe: process.env.RESOLVE_FFPROBE
    || 'E:\\Codex\\tools-hub\\material-hub\\node_modules\\@ffprobe-installer\\win32-x64\\ffprobe.exe',
  // 临时工作目录（当前流程不再写入，仅保留历史清理）
  workDir: process.env.RESOLVE_WORK_DIR || 'E:\\素材\\_resolve-work',
};
