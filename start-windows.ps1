# 可独立分发，配合 start-windows.bat；兼容 Windows PowerShell 5.1。
$ErrorActionPreference = 'Stop'
$RepoUrl = if ($env:GPT_UPGRADE_REPO_URL) { $env:GPT_UPGRADE_REPO_URL } else { 'https://github.com/362460453/Auto-Purchase-forGPT.git' }
$ProjectDir = $env:GPT_UPGRADE_PROJECT_DIR
$AppPort = if ($env:PORT) { $env:PORT } else { '4173' }
$CloneTemp = $null

function Refresh-Path {
  if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user;$env:Path"
  }
}
function Test-CommandName([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }
function Test-Node {
  if (-not (Test-CommandName 'node')) { return $false }
  & node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 && typeof WebSocket === 'function' ? 0 : 1)" 2>$null
  return $LASTEXITCODE -eq 0
}
function Install-Package([string]$Id, [string]$DisplayName) {
  if (-not (Test-CommandName 'winget')) { throw "没有 winget，无法自动安装 $DisplayName。请安装 Windows 的 App Installer 后重新双击 BAT。" }
  Write-Host "正在安装 $DisplayName，请完成系统安装提示…"
  & winget install --id $Id -e --source winget --accept-package-agreements --accept-source-agreements | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "$DisplayName 安装未完成（退出码 $LASTEXITCODE）。" }
  Refresh-Path
}
function Ensure-Node {
  Refresh-Path
  if (Test-Node) { return }
  Install-Package 'OpenJS.NodeJS.LTS' 'Node.js LTS（需要 22+）'
  $nodeDir = Join-Path $env:ProgramFiles 'nodejs'
  if (Test-Path -LiteralPath $nodeDir) { $env:Path = "$nodeDir;$env:Path" }
  if (-not (Test-Node)) { throw 'Node.js 22+ 安装后仍不可用，请关闭窗口后重新双击 BAT。' }
}
function Ensure-Git {
  if (Test-CommandName 'git') {
    & git --version | Out-Host
    if ($LASTEXITCODE -eq 0) { return }
  }
  Install-Package 'Git.Git' 'Git'
  $gitDir = Join-Path $env:ProgramFiles 'Git\cmd'
  if (Test-Path -LiteralPath $gitDir) { $env:Path = "$gitDir;$env:Path" }
  if (-not (Test-CommandName 'git')) { throw 'Git 安装后仍不可用，请关闭窗口后重新双击 BAT。' }
  & git --version | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Git 无法运行。' }
}
function Test-Project([string]$Directory) {
  foreach ($name in @('server.mjs', 'dev.mjs', 'package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Directory $name) -PathType Leaf)) { return $false }
  }
  try { return (Get-Content -Raw -LiteralPath (Join-Path $Directory 'package.json') | ConvertFrom-Json).name -eq 'auto-purchase-for-gpt' }
  catch { return $false }
}
function Ensure-Project {
  if (-not $script:ProjectDir) {
    if (Test-Project $PSScriptRoot) { $script:ProjectDir = $PSScriptRoot }
    else { $script:ProjectDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Auto-Purchase-forGPT' }
  }
  $script:ProjectDir = [IO.Path]::GetFullPath($script:ProjectDir)
  if (Test-Path -LiteralPath $script:ProjectDir) {
    if (-not (Test-Project $script:ProjectDir)) { throw "目录已存在但不是本项目，未覆盖：$script:ProjectDir" }
    return
  }
  $parent = Split-Path -Parent $script:ProjectDir
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $script:CloneTemp = Join-Path $parent ('.gpt-download-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $script:CloneTemp | Out-Null
  $download = Join-Path $script:CloneTemp 'project'
  Write-Host "首次下载项目到：$script:ProjectDir"
  & git clone --depth 1 --branch main -- $RepoUrl $download | Out-Host
  # Windows PowerShell 的 Stop 不处理外部程序非零退出码，必须显式判断。
  if ($LASTEXITCODE -ne 0) { throw '项目下载失败，请检查网络及仓库访问权限。' }
  if (-not (Test-Project $download)) { throw '下载的项目不完整，未安装。' }
  Move-Item -LiteralPath $download -Destination $script:ProjectDir
}
function Update-Project {
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir '.git'))) {
    Write-Warning '当前是无 Git 的本地项目，保留当前代码运行；无法自动更新。'; return
  }
  $remote = & git -C $ProjectDir remote get-url origin
  if ($LASTEXITCODE -ne 0) { throw '无法读取项目 origin，未修改代码。' }
  if ($remote -ne $RepoUrl -and $remote -ne 'git@github.com:362460453/Auto-Purchase-forGPT.git') {
    Write-Warning '项目 origin 与下载地址不同，保留当前代码运行，不修改远程。'; return
  }
  $changes = & git -C $ProjectDir status --porcelain
  if ($LASTEXITCODE -ne 0) { throw '无法读取项目状态，未修改代码。' }
  $branch = & git -C $ProjectDir symbolic-ref --quiet --short HEAD
  if ($changes -or $LASTEXITCODE -ne 0 -or $branch -ne 'main') {
    Write-Warning '检测到本地修改或非 main 分支，保留当前代码运行；提交修改并回到 main 后会自动更新。'; return
  }
  Write-Host '正在同步 GitHub main 最新代码…'
  & git -C $ProjectDir fetch origin main | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Warning '更新失败（网络或权限），使用当前本地代码运行。'; return }
  # 仅快进更新，不强制切分支，也不 reset --hard，避免覆盖开发机改动和历史提交。
  & git -C $ProjectDir merge --ff-only origin/main | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Warning '更新失败（分支分歧），使用当前本地代码运行。'; return }
  Write-Host '代码已更新。'
}

$result = 0
try {
  Ensure-Node
  Write-Host "Node.js：$(& node -v)"
  # 更新前检查监听端口，避免拉代码让正在执行任务的服务热重启。
  & node -e "const p=Number(process.argv[1]);if(!Number.isInteger(p)||p<1||p>65535){console.error('PORT must be 1-65535');process.exit(1);}const s=require('net').createServer();s.once('error',()=>{console.error('Port is in use. Stop the existing service before updating.');process.exit(1);});s.listen(p,'127.0.0.1',()=>s.close());" $AppPort
  if ($LASTEXITCODE -ne 0) { throw "端口 $AppPort 无效或已被占用；已有服务请使用原页面，停止旧服务后再运行脚本更新。" }
  Ensure-Git
  Ensure-Project
  Update-Project
  Push-Location -LiteralPath $ProjectDir
  try {
    Write-Host "项目目录：$ProjectDir"
    Write-Host "正在启动，请在浏览器访问：http://127.0.0.1:$AppPort"
    Write-Host '请保持此窗口打开；按 Ctrl+C 停止服务。'
    & node dev.mjs
    $result = $LASTEXITCODE
  } finally { Pop-Location }
} catch {
  Write-Host "启动失败：$($_.Exception.Message)" -ForegroundColor Red
  $result = 1
} finally {
  if ($CloneTemp -and (Test-Path -LiteralPath $CloneTemp)) { Remove-Item -LiteralPath $CloneTemp -Recurse -Force }
}
exit $result
