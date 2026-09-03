#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-4173}"
URL="http://127.0.0.1:${PORT}"

cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 18+。" >&2
  exit 1
fi

echo "启动本地 GPT 充值模板：${URL}"
# 使用轮询式热更新，避免 macOS 文件监听句柄达到上限时出现 EMFILE。
node dev.mjs &
SERVER_PID=$!

cleanup() {
  echo
  echo "停止本地服务。"
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for attempt in {1..30}; do
  if curl --silent --fail "$URL" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "本地服务启动失败。" >&2
    exit 1
  fi
  sleep 0.2
done

if ! curl --silent --fail "$URL" >/dev/null 2>&1; then
  echo "等待本地服务超时：${URL}" >&2
  exit 1
fi

echo "服务已启动，请手动在浏览器访问：${URL}"
echo "按 Ctrl+C 停止服务。"
wait "$SERVER_PID"
