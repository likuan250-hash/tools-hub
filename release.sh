#!/usr/bin/env bash
# tools-hub 一键发版脚本
# 前置：package.json version 已 bump 到目标版本（如 0.1.76），代码已 commit（未 push）
# 用法：bash release.sh
# 作用：打 tag → push → 后台等 CI → 自动验证 Release 资产齐全
set -euo pipefail

REPO="likuan250-hash/tools-hub"
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# —— 取 GitHub PAT（从本机 git 凭据，避免硬编码；PAT 需有 repo 权限）——
GH_TOKEN="$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | awk -F= '/^password=/{print $2}')"
if [ -z "$GH_TOKEN" ]; then
  echo "❌ 无法从 git 凭据获取 GitHub PAT，请检查凭据配置（git config credential.helper）"
  exit 1
fi
export GH_TOKEN

# gh CLI 路径（Windows，内联避免引号陷阱）
GH="C:/Program Files/GitHub CLI/gh.exe"

# —— 读版本 + 提示（CI 门禁会在构建时校验版本==tag）——
PKG_VERSION="$(node -p "require('./package.json').version")"
TAG="v$PKG_VERSION"
echo "📦 准备发版：$TAG (package.json version: $PKG_VERSION)"

# —— 打 tag（覆盖本地可能存在的旧 tag）——
git tag -d "$TAG" 2>/dev/null || true
git tag -a "$TAG" -m "$TAG"

# —— 推送 main + tag 触发 CI ——
echo "🚀 推送 main + $TAG ..."
git push origin main "$TAG"

# —— 等 CI 构建完成（约 4-5 分钟，含版本一致性门禁 + 三模块测试）——
# 关键：按本次推送的 commit SHA 精确匹配 CI 运行，避免抢到上一次构建的陈旧 run 导致误判发版失败
echo "⏳ 等待 CI 构建（约 4-5 分钟）..."
SHA="$(git rev-parse HEAD)"
RUN_ID=""
i=0
while [ $i -lt 30 ]; do
  RUN_ID="$("$GH" run list --repo "$REPO" --commit "$SHA" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null)"
  [ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ] && break
  sleep 2
  i=$((i+1))
done
if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
  echo "❌ 未检测到本次推送($SHA)对应的 CI 运行，请检查 Actions 页面"
  exit 1
fi
"$GH" run watch "$RUN_ID" --repo "$REPO" --exit-status

# —— 验证 Release 资产齐全（latest.yml + Setup exe + blockmap）——
# 构建完成后 electron-builder 发布资产可能略有延迟，重试若干次避免误判
echo "🔍 验证 Release 资产..."
ASSETS=""
i=0
while [ $i -lt 15 ]; do
  ASSETS="$("$GH" release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name' 2>/dev/null)"
  if echo "$ASSETS" | grep -q "latest.yml" && echo "$ASSETS" | grep -q "Setup"; then
    break
  fi
  sleep 5
  i=$((i+1))
done
echo "$ASSETS"
if echo "$ASSETS" | grep -q "latest.yml" && echo "$ASSETS" | grep -q "Setup"; then
  echo "✅ 发版成功：$TAG"
  echo "   https://github.com/$REPO/releases/tag/$TAG"
else
  echo "❌ 资产不完整（缺 latest.yml 或 Setup exe），请检查 CI 日志"
  exit 1
fi
