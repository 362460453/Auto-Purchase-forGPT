@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Auto-Purchase-for-GPT
rem 只需把这一个 bat 拷到 Windows。不必同时带 ps1；第一次运行会自动克隆项目。

echo 只需运行这一个 bat，不必再拷 start-local.ps1。
echo.

set "REPO_URL=https://github.com/362460453/Auto-Purchase-forGPT.git"
set "PROJECT_DIR=%USERPROFILE%\Auto-Purchase-forGPT"
set "SCRIPT=%~dp0start-local.ps1"

if exist "%SCRIPT%" goto :run
if exist "%PROJECT_DIR%\start-local.ps1" (
  set "SCRIPT=%PROJECT_DIR%\start-local.ps1"
  goto :run
)

echo 当前目录没有项目脚本，准备克隆仓库。
where git >nul 2>&1
if errorlevel 1 (
  echo 未找到 Git，正在用 winget 安装。
  winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
)
git clone "%REPO_URL%" "%PROJECT_DIR%"
if errorlevel 1 (
  echo 克隆仓库失败。
  exit /b 1
)
set "SCRIPT=%PROJECT_DIR%\start-local.ps1"

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
if errorlevel 1 (
  echo.
  echo 启动失败。
  pause
  exit /b 1
)
