@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM ── 定位 pythonw(无控制台黑窗) ──
set "MPYW="
REM 1) 优先用 WorkBuddy 自带 managed pythonw
if exist "C:\Users\%USERNAME%\.workbuddy\binaries\python\versions\3.13.12\pythonw.exe" (
  set "MPYW=C:\Users\%USERNAME%\.workbuddy\binaries\python\versions\3.13.12\pythonw.exe"
)
REM 2) 否则在 PATH 里找 pythonw(标准 Python 安装自带, 双击 .py 也不会黑窗)
if not defined MPYW (
  where pythonw >nul 2>nul && set "MPYW=pythonw"
)
REM 3) 兜底: 用 python(会带一个控制台黑窗, 但功能正常)
if not defined MPYW set "MPYW=python"

REM 用 pythonw 启动 tkinter 主程序, 无黑窗; start 异步, bat 自动关闭
start "" "%MPYW%" "%~dp0control_panel_tk.py"
