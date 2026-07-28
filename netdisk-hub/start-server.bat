@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "WB_NODE=C:\Users\%USERNAME%\.workbuddy\binaries\node\versions\22.22.2\node.exe"
if exist "%WB_NODE%" (
  "%WB_NODE%" server.js
) else (
  node server.js
)
