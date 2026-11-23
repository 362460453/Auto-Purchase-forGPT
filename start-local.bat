@echo off
rem Legacy entry for an existing checkout. Distribute start-windows.bat + start-windows.ps1.
call "%~dp0start-windows.bat" %*
exit /b %ERRORLEVEL%
