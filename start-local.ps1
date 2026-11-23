# 仓库内的旧入口兼容；单独分发请使用 start-windows.bat + start-windows.ps1。
& (Join-Path $PSScriptRoot 'start-windows.ps1') @args
exit $LASTEXITCODE
