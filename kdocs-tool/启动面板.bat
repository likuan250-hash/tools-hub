@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
set "PANEL=%~dp0control_panel_tk.py"
set "LOG=%~dp0panel.log"
set "CHOSEN="

REM 1) PATH pythonw (no console window)
call :try "pythonw"
if defined CHOSEN goto :launch
REM 2) PATH python (console window, but functional)
call :try "python"
if defined CHOSEN goto :launch
REM 3) User-installed Python (common locations)
call :trypath "C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python313\pythonw.exe"
if defined CHOSEN goto :launch
call :trypath "C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python313\python.exe"
if defined CHOSEN goto :launch
call :trypath "C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python312\pythonw.exe"
if defined CHOSEN goto :launch
call :trypath "C:\Users\%USERNAME%\AppData\Local\Programs\Python\Python312\python.exe"
if defined CHOSEN goto :launch
REM 4) WorkBuddy managed pythonw (any version, last resort)
for /d %%d in ("C:\Users\%USERNAME%\.workbuddy\binaries\python\versions\*") do (
  if not defined CHOSEN call :trypath "%%d\pythonw.exe"
)
if defined CHOSEN goto :launch

echo Python/tkinter not found or cannot create a window. > "%LOG%"
start "" cmd /c "echo Python not found or cannot create Tk window. Install Python with tcl/tk + Add to PATH.&& pause"
exit /b 1

:launch
echo [%DATE% %TIME%] launcher chose: %CHOSEN% >> "%LOG%"
set "KDOCS_NO_RELAUNCH=1"
start "" "%CHOSEN%" "%PANEL%"
exit /b 0

:try
set "P="
for /f "delims=" %%i in ('where %1 2^>nul') do (
  if not defined P set "P=%%i"
)
if defined P call :trypath "%P%"
goto :eof

:trypath
if not exist "%~1" goto :eof
"%~1" -c "import tkinter; r=tkinter.Tk(); r.withdraw(); r.destroy()" >nul 2>nul
if not errorlevel 1 set "CHOSEN=%~1"
goto :eof
