@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-antigravity.ps1" -Action restore
set "EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %EXIT_CODE%
