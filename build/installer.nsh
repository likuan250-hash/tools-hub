; 升级/覆盖安装前强制结束旧版主进程及其子进程，避免“无法关闭”弹窗。
; 注意：electron-builder 默认 NSIS(3.0.4.1) 不含 nsProcess / KillProcDLL 等插件，
; 故不使用任何插件，直接用 NSIS 内置 ExecWait 调用系统 taskkill.exe 强杀旧进程。
; 进程镜像名 = executableName(缺省=package.name) = "tools-hub.exe"（productName 中文只是显示名，非进程名）。
; 必须加 /T 结束进程树，否则 fork 出的 node.exe 子服务（kdocs-tool/netdisk-hub）会残留并占用文件。

!macro customInit
  DetailPrint "正在关闭旧版 工具箱 ToolsHub..."
  ExecWait 'taskkill /F /T /IM tools-hub.exe'
  Sleep 2000
!macroend
