; NSIS 自定义脚本：安装/升级前强制关闭旧版 tools-hub 主进程
; 主应用窗口有自定义关闭确认框，安装器发送的 WM_CLOSE 会被拦截，导致无法覆盖安装。
; KillProcDLL 是 electron-builder 自带 NSIS 的插件（DLL 形式，无需 !include 头文件），
; 直接调用 KillProcDLL::KillProc 结束旧进程即可。

!macro customInit
  DetailPrint "正在关闭旧版 工具箱 ToolsHub..."
  KillProcDLL::KillProc "工具箱 ToolsHub.exe"
  ; 等待进程真正退出，避免后续文件覆盖仍被占用
  Sleep 2000
!macroend
