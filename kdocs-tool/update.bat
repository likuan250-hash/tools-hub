@echo off
cd /d "%~dp0"

echo ============================================
echo   Kdocs Tool - Pull Update
echo ============================================
echo.

echo [1/2] Pulling latest code from GitHub...
git pull
if errorlevel 1 (
  echo [ERROR] Pull failed: maybe local uncommitted changes caused a conflict.
  echo          Save your changes or run "git status" to inspect.
  pause
  exit /b 1
)

echo.
echo [2/2] Syncing dependencies (if package.json changed)...
call npm install
if errorlevel 1 (
  echo [WARN] npm install failed. Check network and retry manually.
)

echo.
echo ============================================
echo   Update complete! Restart the service to apply.
echo ============================================
echo.
pause
