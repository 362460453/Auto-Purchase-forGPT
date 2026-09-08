# Windows 启动脚本：检查 Git / Node，没有项目就克隆，每次启动同步远程最新代码。
# 不自动打开浏览器，与 start-local.sh 一致。

$ErrorActionPreference = 'Stop'
$RepoUrl = 'https://github.com/362460453/Auto-Purchase-forGPT.git'
$RemoteBranch = 'main'
$DefaultProjectDir = Join-Path $env:USERPROFILE 'Auto-Purchase-forGPT'
$Port = if ($env:PORT) { $env:PORT } else { '4173' }

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Test-CommandName {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-NodeMajorVersion {
  $raw = (& node -v 2>$null)
  if (-not $raw) { return 0 }
  if ($raw -match 'v?(\d+)') { return [int]$Matches[1] }
  return 0
}

function Install-WingetPackage {
  param(
    [string]$Id,
    [string]$DisplayName
  )
  if (-not (Test-CommandName 'winget')) {
    throw "未找到 winget，无法自动安装 $DisplayName。请先安装 $DisplayName 后再运行本脚本。"
  }
  Write-Host "正在安装 $DisplayName…"
  & winget install --id $Id -e --source winget --accept-package-agreements --accept-source-agreements
  Refresh-Path
}

function Ensure-Git {
  Refresh-Path
  if (Test-CommandName 'git') {
    Write-Host '已检测到 Git，跳过安装。'
    return
  }
  Install-WingetPackage -Id 'Git.Git' -DisplayName 'Git'
  Refresh-Path
  if (-not (Test-CommandName 'git')) {
    $gitCmd = Join-Path $env:ProgramFiles 'Git\cmd'
    if (Test-Path $gitCmd) { $env:Path = "$gitCmd;$env:Path" }
  }
  if (-not (Test-CommandName 'git')) {
    throw 'Git 安装后仍不可用，请关闭窗口后重新打开再运行。'
  }
}

function Ensure-Node {
  Refresh-Path
  if (Test-CommandName 'node') {
    $major = Get-NodeMajorVersion
    if ($major -ge 18) {
      Write-Host "已检测到 Node.js $major，跳过安装。"
      return
    }
    Write-Host "当前 Node.js 版本低于 18，准备安装 LTS。"
  }
  Install-WingetPackage -Id 'OpenJS.NodeJS.LTS' -DisplayName 'Node.js LTS'
  Refresh-Path
  if (-not (Test-CommandName 'node')) {
    $nodeDir = Join-Path $env:ProgramFiles 'nodejs'
    if (Test-Path $nodeDir) { $env:Path = "$nodeDir;$env:Path" }
  }
  if (-not (Test-CommandName 'node')) {
    throw 'Node.js 安装后仍不可用，请关闭窗口后重新打开再运行。'
  }
  $major = Get-NodeMajorVersion
  if ($major -lt 18) {
    throw "需要 Node.js 18+，当前是 $(node -v)。"
  }
}

function Resolve-ProjectDirectory {
  $scriptDir = $PSScriptRoot
  if ($scriptDir -and (Test-Path (Join-Path $scriptDir 'server.mjs'))) {
    return $scriptDir
  }
  if (Test-Path (Join-Path (Get-Location) 'server.mjs')) {
    return (Get-Location).Path
  }
  if (Test-Path (Join-Path $DefaultProjectDir 'server.mjs')) {
    return $DefaultProjectDir
  }
  return $null
}

function Ensure-Project {
  $projectDir = Resolve-ProjectDirectory
  if ($projectDir) {
    Write-Host "已检测到项目目录：$projectDir"
    return $projectDir
  }
  Write-Host "未找到项目，正在克隆到 $DefaultProjectDir"
  New-Item -ItemType Directory -Force -Path (Split-Path $DefaultProjectDir) | Out-Null
  & git clone $RepoUrl $DefaultProjectDir
  if (-not (Test-Path (Join-Path $DefaultProjectDir 'server.mjs'))) {
    throw '克隆完成但未找到 server.mjs，请检查仓库地址。'
  }
  return $DefaultProjectDir
}

function Update-Project {
  param([string]$ProjectDir)
  Push-Location $ProjectDir
  try {
    Write-Host '正在拉取远程最新代码…'
    & git fetch origin
    & git checkout $RemoteBranch
    # 运维机每次启动对齐远程；本地未提交修改会被覆盖。
    & git reset --hard "origin/$RemoteBranch"
    Write-Host '已同步到远程最新代码。'
  } catch {
    Write-Warning "拉取最新代码失败，将使用当前本地代码启动：$($_.Exception.Message)"
  } finally {
    Pop-Location
  }
}

Ensure-Git
Ensure-Node
$projectDir = Ensure-Project
Update-Project -ProjectDir $projectDir
Set-Location $projectDir

Write-Host "启动本地 GPT 充值模板：http://127.0.0.1:$Port"
Write-Host '服务已启动后，请手动在浏览器访问上述地址。按 Ctrl+C 停止服务。'
& node dev.mjs

