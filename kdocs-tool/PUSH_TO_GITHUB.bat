@echo off
chcp 65001 >nul
echo ============================================
echo   kdocs-tool - 推送到 GitHub
echo ============================================
echo.
echo [1/2] 检查远程仓库 kdocs-tool 是否已存在...
git ls-remote origin >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo [错误] 远程仓库尚不存在，无法推送。
  echo.
  echo 请先手动在 GitHub 网页新建私有仓库：
  echo   1. 打开 https://github.com/new
  echo   2. Repository name 填：kdocs-tool
  echo   3. 保持空仓库（不要勾选 Add README/.gitignore/LICENSE）
  echo   4. 点 Create repository
  echo.
  echo 建好之后，重新运行本脚本即可一键推送。
  echo.
  pause
  exit /b 1
)
echo [OK] 远程仓库存在，开始推送...
echo.
echo [2/2] git push -u origin main
git push -u origin main
if %errorlevel% neq 0 (
  echo.
  echo [失败] 推送未完成，请检查网络 / SSH key / 仓库权限。
  pause
  exit /b 1
)
echo.
echo [成功] 已推送到 GitHub，另一台电脑 clone 即可使用。
echo   git clone git@github.com:likuan250-hash/kdocs-tool.git
echo.
pause
