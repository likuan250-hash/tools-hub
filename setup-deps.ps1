# tools-hub 依赖安装脚本（开发 / CI 通用）
# 两个子工具是独立 Node 项目，源码内联在 kdocs-tool/ 与 netdisk-hub/，
# 各自需要安装 node_modules 才能被 Electron 主进程 fork 运行。
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$node = "C:/Users/123/.workbuddy/binaries/node/versions/22.22.2/node.exe"
$npmCli = "C:/Users/123/.workbuddy/binaries/node/versions/22.22.2/node_modules/npm/bin/npm-cli.js"

function Install-In($dir) {
  $p = Join-Path $root $dir
  if (-not (Test-Path $p)) { Write-Host "跳过(不存在): $dir"; return }
  Write-Host "==> npm install in $dir"
  & $node $npmCli install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install 失败: $dir" }
}

Install-In "kdocs-tool"
Install-In "netdisk-hub"
Write-Host "依赖安装完成。"
