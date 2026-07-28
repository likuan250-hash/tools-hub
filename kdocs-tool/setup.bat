@echo off
cd /d "%~dp0"

echo ============================================
echo   Kdocs Tool - Install and Launch
echo ============================================
echo.

set "WB_NODE=C:\Users\%USERNAME%\.workbuddy\binaries\node\versions\22.22.2\node.exe"
if exist "%WB_NODE%" (
  echo [OK] Found WorkBuddy built-in Node
) else (
  where node >nul 2>nul
  if %errorlevel%==0 (
    echo [OK] Found system Node
  ) else (
    echo [ERROR] Node.js not found. Install Node.js LTS and check "Add to PATH".
    pause
    exit /b 1
  )
)

echo.
echo [1/2] Installing npm dependencies (express)...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed. Check your network and retry.
  pause
  exit /b 1
)

echo.
echo [2/2] Launching control panel (background)...
start "" "%~dp0启动面板.bat"

echo.
echo ============================================
echo   Done! Control panel launched.
echo   Open http://localhost:3599 in your browser.
echo   To stop: click "Stop" or "Exit" in the panel.
echo ============================================
echo.
pause
