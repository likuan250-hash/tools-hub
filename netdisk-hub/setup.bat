@echo off
cd /d "%~dp0"

echo ============================================
echo   网盘转存中转台 - 一键安装启动
echo ============================================
echo.

set "WB_NODE=C:\Users\%USERNAME%\.workbuddy\binaries\node\versions\22.22.2\node.exe"
if exist "%WB_NODE%" (
  echo [OK] 找到 WorkBuddy 内置 Node
) else (
  where node >nul 2>nul
  if %errorlevel%==0 (
    echo [OK] 找到系统 Node
  ) else (
    echo [错误] 未找到 Node.js，请先安装 Node.js LTS 并勾选 Add to PATH
    pause
    exit /b 1
  )
)

echo.
echo [1/3] 安装 npm 依赖...
call npm install
if errorlevel 1 (
  echo [错误] npm install 失败，请检查网络后重试
  pause
  exit /b 1
)

echo.
echo [2/3] 安装 Playwright Chromium 内核（夸克/迅雷授权页需要）...
call npx playwright install chromium
if errorlevel 1 (
  echo [警告] Chromium 安装失败（可能网络受限），夸克/迅雷授权页将无法弹出
  echo         可手动重试： npx playwright install chromium
)

echo.
if not exist ".env" (
  if exist ".env.example" (
    copy ".env.example" ".env" >nul
    echo [OK] 已生成 .env，请用记事本打开填入百度 BAIDU_CLIENT_ID / BAIDU_CLIENT_SECRET
  ) else (
    echo [警告] 未找到 .env.example，请手动创建 .env
  )
) else (
  echo [OK] .env 已存在，跳过
)

echo.
echo [3/3] 启动服务（新窗口后台运行）...
start "网盘转存中转台" /min "%~dp0start-server.bat"

echo.
echo ============================================
echo   完成！浏览器打开 http://localhost:3000
echo   首次使用请先登录 百度 / 夸克 / 迅雷
echo   关闭服务窗口即停止；也可用 启动面板.bat 管理
echo ============================================
echo.
pause
