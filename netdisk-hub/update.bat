@echo off
cd /d "%~dp0"

echo ============================================
echo   网盘转存中转台 - 拉取更新
echo ============================================
echo.

echo [1/2] 从 GitHub 拉取最新代码...
git pull
if errorlevel 1 (
  echo [错误] 拉取失败：可能本地有未提交的修改导致冲突
  echo         请先保存你的改动，或运行 git status 查看冲突文件
  pause
  exit /b 1
)

echo.
echo [2/2] 同步依赖（如 package.json 有变动）...
call npm install
if errorlevel 1 (
  echo [警告] npm install 失败，请检查网络后手动重试
)

echo.
echo ============================================
echo   更新完成！如依赖有变动已自动同步
echo   重启服务即可生效（双击 启动面板.bat）
echo ============================================
echo.
pause
