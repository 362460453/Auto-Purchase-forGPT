@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Auto-Purchase-for-GPT - Windows
set "SCRIPT=%~dp0start-windows.ps1"
if not exist "%SCRIPT%" (
  echo Please put start-windows.bat and start-windows.ps1 in the same folder.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
  echo.
  echo Startup failed. See the message above.
  pause
)
exit /b %RESULT%
