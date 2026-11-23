#!/bin/bash
# 可单独分发：首次克隆，后续快进更新；在开发仓库内运行时保留本地修改。
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_URL="${GPT_UPGRADE_REPO_URL:-https://github.com/362460453/Auto-Purchase-forGPT.git}"
PROJECT_DIR="${GPT_UPGRADE_PROJECT_DIR:-}"
APP_PORT="${PORT:-4173}"
NODE_BIN=""
SERVER_PID=""
CLONE_TEMP=""
RUNTIME_TEMP=""

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$SERVER_PID" ]]; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  [[ -z "$CLONE_TEMP" ]] || rm -rf "$CLONE_TEMP"
  [[ -z "$RUNTIME_TEMP" ]] || rm -rf "$RUNTIME_TEMP"
  if [[ $status -ne 0 && -t 0 ]]; then
    echo "启动未完成，请查看上方原因。按回车关闭窗口。"
    read -r _ || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

node_compatible() {
  [[ -x "$1" ]] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 && typeof WebSocket === "function" ? 0 : 1)' >/dev/null 2>&1
}

ensure_node() {
  local candidate runtime_root arch manifest filename checksum actual distribution
  candidate="$(command -v node || true)"
  if [[ -n "$candidate" ]] && node_compatible "$candidate"; then
    NODE_BIN="$candidate"
    return
  fi
  runtime_root="${GPT_UPGRADE_RUNTIME_DIR:-$HOME/Library/Application Support/Auto-Purchase-for-GPT/runtime}"
  candidate="$runtime_root/current/bin/node"
  if node_compatible "$candidate"; then NODE_BIN="$candidate"; return; fi
  case "$(uname -m)" in
    arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) echo "不支持当前 Mac 处理器。" >&2; return 1 ;;
  esac
  echo "未找到可用的 Node.js 22+，正在下载官方 Node.js 22 LTS（${arch}）…"
  mkdir -p "$runtime_root"
  RUNTIME_TEMP="$(mktemp -d "$runtime_root/.download.XXXXXX")"
  manifest="$RUNTIME_TEMP/SHASUMS256.txt"
  curl --fail --location --retry 2 --connect-timeout 15 --max-time 120 \
    'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' -o "$manifest"
  filename="$(awk -v arch="$arch" '$2 ~ ("^node-v22\\.[0-9]+\\.[0-9]+-darwin-" arch "\\.tar\\.gz$") {print $2}' "$manifest")"
  if [[ ! "$filename" =~ ^node-v22\.[0-9]+\.[0-9]+-darwin-(arm64|x64)\.tar\.gz$ ]]; then
    echo "官方 Node.js 下载清单不完整，未安装。" >&2; return 1
  fi
  checksum="$(awk -v name="$filename" '$2 == name {print $1}' "$manifest")"
  curl --fail --location --retry 2 --connect-timeout 15 --max-time 600 \
    "https://nodejs.org/dist/latest-v22.x/$filename" -o "$RUNTIME_TEMP/$filename"
  actual="$(shasum -a 256 "$RUNTIME_TEMP/$filename" | awk '{print $1}')"
  if [[ "$checksum" != "$actual" ]]; then echo "Node.js 下载校验失败，未安装。" >&2; return 1; fi
  tar -xzf "$RUNTIME_TEMP/$filename" -C "$RUNTIME_TEMP"
  distribution="${filename%.tar.gz}"
  node_compatible "$RUNTIME_TEMP/$distribution/bin/node" || { echo "下载的 Node.js 无法在此 Mac 运行。" >&2; return 1; }
  # 只安装到本工具自己的缓存，不修改系统 Node 或要求安装 Homebrew。
  if [[ ! -e "$runtime_root/$distribution" ]]; then mv "$RUNTIME_TEMP/$distribution" "$runtime_root/$distribution"; fi
  ln -sfn "$distribution" "$runtime_root/current"
  NODE_BIN="$runtime_root/current/bin/node"
  node_compatible "$NODE_BIN"
}

ensure_git() {
  if command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1; then return; fi
  echo "未找到 Git，请在系统弹窗中安装 Command Line Tools；安装完成后本窗口会继续。"
  xcode-select --install 2>/dev/null || true
  # 首次安装依赖由系统完成；最多等待 30 分钟，避免取消安装后永久挂起。
  local attempt
  for ((attempt=0; attempt<360; attempt++)); do
    if xcode-select -p >/dev/null 2>&1 && git --version >/dev/null 2>&1; then return; fi
    sleep 5
  done
  echo "尚未完成 Git / Command Line Tools 安装，安装完成后重新双击本文件。" >&2
  return 1
}

is_project() {
  [[ -f "$1/server.mjs" && -f "$1/dev.mjs" && -f "$1/package.json" ]] && \
    "$NODE_BIN" -e 'try { process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name === "auto-purchase-for-gpt" ? 0 : 1); } catch { process.exit(1); }' "$1/package.json"
}

ensure_project() {
  if [[ -z "$PROJECT_DIR" ]]; then
    if is_project "$SCRIPT_DIR"; then PROJECT_DIR="$SCRIPT_DIR";
    else PROJECT_DIR="$HOME/Auto-Purchase-forGPT"; fi
  fi
  if [[ -e "$PROJECT_DIR" ]]; then
    is_project "$PROJECT_DIR" || { echo "目录已存在但不是本项目，未覆盖：$PROJECT_DIR" >&2; return 1; }
  else
    local parent
    parent="$(dirname "$PROJECT_DIR")"
    mkdir -p "$parent"
    CLONE_TEMP="$(mktemp -d "$parent/.gpt-download.XXXXXX")"
    echo "首次下载项目到：$PROJECT_DIR"
    git clone --depth 1 --branch main -- "$REPO_URL" "$CLONE_TEMP/project"
    is_project "$CLONE_TEMP/project" || { echo "下载的项目不完整，未安装。" >&2; return 1; }
    # 下载完整后才放入目标目录；中断不会留下一个下次无法启动的半成品。
    mv "$CLONE_TEMP/project" "$PROJECT_DIR"
  fi
  PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
}

update_project() {
  local branch changes remote
  if [[ ! -e "$PROJECT_DIR/.git" ]]; then
    echo "当前是无 Git 的本地项目，保留当前代码运行；无法自动更新。"; return
  fi
  remote="$(git -C "$PROJECT_DIR" remote get-url origin)"
  if [[ "$remote" != "$REPO_URL" && "$remote" != 'git@github.com:362460453/Auto-Purchase-forGPT.git' ]]; then
    echo "项目 origin 与下载地址不同，保留当前代码运行，不修改远程。"; return
  fi
  changes="$(git -C "$PROJECT_DIR" status --porcelain)"
  branch="$(git -C "$PROJECT_DIR" symbolic-ref --quiet --short HEAD || true)"
  if [[ -n "$changes" || "$branch" != main ]]; then
    echo "检测到本地修改或非 main 分支，保留当前代码运行；提交修改并回到 main 后会自动更新。"; return
  fi
  echo "正在同步 GitHub main 最新代码…"
  # 只允许快进；开发机的本地提交、数据和设置不能被 reset --hard 覆盖。
  if git -C "$PROJECT_DIR" fetch origin main && git -C "$PROJECT_DIR" merge --ff-only origin/main; then
    echo "代码已更新。"
  else
    echo "更新失败（网络、权限或分支分歧），使用当前本地代码运行。" >&2
  fi
}

main() {
  [[ "$(uname -s)" == Darwin ]] || { echo "请在 Mac 上运行此文件；Windows 请用 start-windows.bat。" >&2; return 1; }
  # Finder 的 PATH 可能没有 Homebrew / 官方安装器目录；不依赖用户 shell 配置。
  export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
  ensure_node
  echo "Node.js：$("$NODE_BIN" -v)"
  # 更新前检查端口，避免重复双击时拉代码触发正在执行任务的热重启。
  "$NODE_BIN" -e 'const p=Number(process.argv[1]); if(!Number.isInteger(p)||p<1||p>65535){console.error("PORT 必须是 1–65535");process.exit(1);}const s=require("net").createServer();s.once("error",()=>{console.error(`端口 ${p} 已被占用。已有服务请使用原页面；停止旧服务后再运行脚本更新。`);process.exit(1);});s.listen(p,"127.0.0.1",()=>s.close());' "$APP_PORT"
  ensure_git
  ensure_project
  update_project
  cd "$PROJECT_DIR"
  echo "项目目录：$PROJECT_DIR"
  echo "正在启动，请在浏览器访问：http://127.0.0.1:$APP_PORT"
  echo "请保持此窗口打开；按 Ctrl+C 停止服务。"
  "$NODE_BIN" dev.mjs &
  SERVER_PID=$!
  local result=0
  wait "$SERVER_PID" || result=$?
  SERVER_PID=""
  return "$result"
}

# main 返回后直接退出，避免更新自身文件后 Bash 继续从旧偏移读取脚本。
main "$@"; exit $?
