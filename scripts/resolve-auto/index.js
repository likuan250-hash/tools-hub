#!/usr/bin/env node
// DaVinci Resolve 游戏剪辑标准流程自动化 CLI（步骤 0-4 / 8-9）
// 用法：node scripts/resolve-auto/index.js setup --dir "E:\素材\【游戏282】…"
//       node scripts/resolve-auto/index.js render --project "…" --out "…"
const { spawn } = require('child_process');
const path = require('path');
const cfg = require('./config');

const cmd = process.argv[2];
const args = process.argv.slice(3);

function usage() {
  console.log(`DaVinci Resolve 自动化（标准流程步骤 0-4 / 8-9）

用法：
  node scripts/resolve-auto/index.js setup --dir <素材目录> [--project <项目名>] [--template <drt>]
      步骤 0-4：启动 Resolve → 新建项目(60fps) → 导入封面+预告片 → 导入 DRT 模板 → 追加到 V1/A1

  node scripts/resolve-auto/index.js render --project <项目名> --out <输出名> [--target <目录>] [--preset <预设>]
      步骤 8-9：加载导出预设 → 渲染 → 验证输出

手动步骤 5-7（拉伸文本对齐 / V1 平滑剪接 / 改开场文本）由用户完成后，再执行 render。

配置（环境变量，均可覆盖）：RESOLVE_EXE / RESOLVE_SCRIPT_API / RESOLVE_SCRIPT_LIB /
RESOLVE_PYTHON / RESOLVE_TEMPLATE_DRT / RESOLVE_RENDER_PRESET / RESOLVE_MATERIAL_ROOT`);
}

if (!['setup', 'render'].includes(cmd)) {
  usage();
  process.exit(cmd === 'help' ? 0 : 1);
}

const py = spawn(cfg.python, [path.join(__dirname, 'resolve.py'), cmd, ...args], {
  stdio: 'inherit',
  shell: false, // 铁律：数组传参，绝不用 shell 字符串拼接
  env: {
    ...process.env,
    PYTHONUTF8: '1',
    RESOLVE_SCRIPT_API: cfg.scriptApi,
    RESOLVE_SCRIPT_LIB: cfg.scriptLib,
    RESOLVE_EXE: cfg.resolveExe,
    RESOLVE_TEMPLATE_DRT: cfg.templateDrt,
    RESOLVE_RENDER_PRESET: cfg.renderPreset,
    RESOLVE_MATERIAL_ROOT: cfg.materialRoot,
    RESOLVE_FFMPEG: cfg.ffmpeg,
    RESOLVE_FFPROBE: cfg.ffprobe,
    RESOLVE_WORK_DIR: cfg.workDir,
  },
});
py.on('error', (e) => {
  console.error('[错误] 无法启动 Python：' + e.message + '（可用 RESOLVE_PYTHON 指定）');
  process.exit(1);
});
py.on('exit', (code) => process.exit(code == null ? 1 : code));
