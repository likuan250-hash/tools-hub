; NSIS 自定义脚本：安装/升级前强制关闭旧版 tools-hub 主进程
; 主应用窗口有自定义关闭确认框，安装器发送的 WM_CLOSE 会被拦截，导致无法覆盖安装。
; 此处用 KillProcDLL 插件（electron-builder 默认 NSIS 自带）结束旧进程。

!include "KillProcDLL.nsh"

!macro customInit
  ; 结束旧版主进程（产品名即 exe 文件名）。KillProcDLL 在进程不存在时也不会报错。
  DetailPrint "正在关闭旧版 工具箱 ToolsHub..."
  KillProcDLL::KillProc "工具箱 ToolsHub.exe"
  ; 等待进程真正退出，避免后续文件覆盖仍被占用
  Sleep 2000
!macroend
