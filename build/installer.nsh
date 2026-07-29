; NSIS 自定义脚本：安装/升级前强制关闭旧版 tools-hub 主进程
; 主应用窗口有自定义关闭确认框，安装器发送的 WM_CLOSE 会被拦截，导致无法覆盖安装。
; 此处用 nsExec 插件调用 taskkill 在安装初始化阶段结束旧进程（nsProcess 插件在 CI 自带 NSIS 中不可用）。

!include "nsExec.nsh"

!macro customInit
  ; 静默结束旧版主进程（产品名即 exe 文件名）。taskkill 在进程不存在时返回错误码，
  ; 但安装应继续，因此用 nsExec::Exec 隐藏控制台窗口并忽略退出码。
  DetailPrint "正在关闭旧版 工具箱 ToolsHub..."
  nsExec::Exec 'taskkill /F /IM "工具箱 ToolsHub.exe"'
  Pop $R0
  ; 等待进程真正退出，避免后续文件覆盖仍被占用
  Sleep 2000
!macroend
